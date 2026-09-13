/* 3단계: 전국 제거 시뮬레이션 (Node) → data/interim/sim_*.json

   웹과 똑같은 engine/seom_engine.js 로 계산한다.
     - 운행계통 17,000여 개: 전수 제거 시뮬레이션
     - 물리 구간: 전수 단절 시뮬레이션(우회 시간)
     - 정류장 그룹: 전수 폐쇄 시뮬레이션(기본). 계산량이 큰 입력(실제 시각표·병원·인구)을 넣을 때는
                    --stop-access sample 로 표본만 정밀 계산 → 4단계 AI 대리모델이 나머지를 추정

   사용: node pipeline/p03_simulate.js [--only lines|stops|segments] [--limit N] [--stop-access all|sample]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { TransitNetwork, Simulator } = require('../engine/seom_engine.js');

const ROOT = path.resolve(__dirname, '..');
const INTERIM = path.join(ROOT, 'data', 'interim');
const params = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'params.json'), 'utf8'));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** graph.json(열 단위 JSON) → 엔진용 타입 배열 */
function networkFromGraph(graph) {
  const g = graph.groups, pt = graph.patterns;
  const patPtr = new Int32Array(pt.stops.length + 1);
  pt.stops.forEach((s, i) => { patPtr[i + 1] = patPtr[i] + s.length; });
  const patStops = new Int32Array(patPtr[patPtr.length - 1]);
  const patCum = new Float32Array(patStops.length);
  pt.stops.forEach((s, i) => { patStops.set(s, patPtr[i]); patCum.set(pt.minutes[i], patPtr[i]); });
  return new TransitNetwork({
    lon: Float64Array.from(g.lon), lat: Float64Array.from(g.lat),
    pop: Float32Array.from(g.pop), dest: Float32Array.from(g.dest),
    modes: Int32Array.from(g.modes), nLines: Int32Array.from(g.n_lines),
    walkPtr: Int32Array.from(graph.walk.ptr), walkIdx: Int32Array.from(graph.walk.idx), walkMin: Float32Array.from(graph.walk.min),
    patLine: Int32Array.from(pt.line), patWait: Float32Array.from(pt.wait), patTrips: Float32Array.from(pt.trips),
    patPtr, patStops, patCum,
    lineMode: Uint8Array.from(graph.lines.map((l) => Number(l.mode))),
  }, params);
}

function progress(label, i, n, t0) {
  const el = (Date.now() - t0) / 1000;
  const eta = i ? el / i * (n - i) : 0;
  console.log(`[seom] ${label} ${i.toLocaleString()} / ${n.toLocaleString()}  경과 ${el.toFixed(0)}s  남은 ${eta.toFixed(0)}s`);
}

function round(x, d = 4) { return x == null ? null : Math.round(x * 10 ** d) / 10 ** d; }

function simulateLines(sim, limit) {
  const net = sim.net;
  const n = Math.min(net.L, limit || net.L);
  const rows = new Array(n);
  const t0 = Date.now();
  for (let l = 0; l < n; l++) {
    const r = sim.lineRemoval(l);
    const d = r.details;
    rows[l] = {
      c: Object.values(r.components).map((v) => round(v)),
      pop: round(r.affectedPopulation, 2),
      nPairs: d.pairs.length,
      disc: d.disconnectedPairs,
      segDep: round(d.segmentDependency),
      stranded: d.stranded,
    };
    if (l % 2000 === 0) progress('운행계통 제거', l, n, t0);
  }
  progress('운행계통 제거', n, n, t0);
  return { keys: ['time_increase', 'access_loss', 'no_alternative', 'connectivity'], rows };
}

/**
 * 정류장 폐쇄. 기본은 전수 정밀 계산(--stop-access all).
 * 실제 시각표·병원·인구를 넣어 계산량이 커지면 --stop-access sample 로 표본만 정밀 계산하고
 * 4단계 AI 대리모델이 나머지를 추정한다.
 */
function simulateStops(sim, accessMode) {
  const net = sim.net, G = net.G;
  const rows = new Array(G);
  const access = new Array(G).fill(null);
  let sample = null;
  if (accessMode === 'sample') {
    const nSample = Math.min(G, params.simulation.stop_training_sample);
    let seed = params.simulation.random_seed;
    const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const strata = new Map();
    for (let g = 0; g < G; g++) {
      const key = `${Math.min(4, net.nLines[g])}|${net.dest[g] > 0 ? 1 : 0}`;
      if (!strata.has(key)) strata.set(key, []);
      strata.get(key).push(g);
    }
    sample = new Set();
    for (const members of strata.values()) {
      const k = Math.max(20, Math.round(nSample * members.length / G));
      for (let i = members.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [members[i], members[j]] = [members[j], members[i]]; }
      members.slice(0, k).forEach((g) => sample.add(g));
    }
  }
  const t0 = Date.now();
  for (let g = 0; g < G; g++) {
    const exact = !sample || sample.has(g);
    const r = sim.stopClosure(g, exact);
    const c = r.components;
    rows[g] = [round(c.walk_penalty), round(c.line_loss), round(c.transfer_break)];
    if (exact) access[g] = round(c.access_loss);
    if (g % 20000 === 0) progress('정류장 폐쇄', g, G, t0);
  }
  progress('정류장 폐쇄', G, G, t0);
  return { keys: ['walk_penalty', 'line_loss', 'transfer_break'], rows, access, accessMode };
}

function simulateSegments(sim) {
  const net = sim.net;
  const keys = [...net.edgeTrips.keys()];
  const rows = new Array(keys.length);
  const t0 = Date.now();
  keys.forEach((key, i) => {
    const [a, b] = TransitNetwork.edgeFromKey(key);
    const r = sim.segmentRemoval(a, b);
    rows[i] = [a, b, round(r.components.detour), round(r.details.extraMin, 1), round(r.details.trips, 1)];
    if (i % 40000 === 0) progress('구간 단절', i, keys.length, t0);
  });
  progress('구간 단절', keys.length, keys.length, t0);
  return { keys: ['a', 'b', 'detour', 'extra_min', 'trips'], rows };
}

function main() {
  const only = arg('only');
  const limit = Number(arg('limit', 0));
  console.log('[seom] graph.json 로딩');
  const graph = JSON.parse(fs.readFileSync(path.join(INTERIM, 'graph.json'), 'utf8'));
  const t0 = Date.now();
  const net = networkFromGraph(graph);
  console.log(`[seom] 네트워크 인덱스 ${((Date.now() - t0) / 1000).toFixed(1)}s (그룹 ${net.G}, 패턴 ${net.P}, 계통 ${net.L})`);
  const sim = new Simulator(net);

  if (!only || only === 'lines') fs.writeFileSync(path.join(INTERIM, 'sim_lines.json'), JSON.stringify(simulateLines(sim, limit)));
  if (!only || only === 'segments') fs.writeFileSync(path.join(INTERIM, 'sim_segments.json'), JSON.stringify(simulateSegments(sim)));
  if (!only || only === 'stops') fs.writeFileSync(path.join(INTERIM, 'sim_stops.json'), JSON.stringify(simulateStops(sim, arg('stop-access', 'all'))));
  console.log('[seom] 시뮬레이션 저장 완료');
}

if (require.main === module) main();
module.exports = { networkFromGraph };
