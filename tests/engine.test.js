/* 엔진 단위 테스트:  node --test tests/
   작은 가상 교통망으로 핵심 규칙(방향 준수·단절 판정·정류장 폐쇄 모델·정책 효과)을 확인한다. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { TransitNetwork, Simulator } = require('../engine/seom_engine.js');

const params = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'params.json'), 'utf8'));

/**
 * 그룹 0..n-1 을 경도 방향으로 1km 간격 배치. patterns: [{line, stops, mode}]
 * 모든 구간 3분, 대기 5분. walk: [[a,b,분]]
 */
function makeNet(n, patterns, walk = [], extra = {}) {
  const lon = extra.lon ? Float64Array.from(extra.lon) : Float64Array.from({ length: n }, (_, i) => 127 + i * 0.011);
  const lat = new Float64Array(n).fill(36);
  const adj = Array.from({ length: n }, () => []);
  for (const [a, b, m] of walk) { adj[a].push([b, m]); adj[b].push([a, m]); }
  const walkPtr = new Int32Array(n + 1), walkIdx = [], walkMin = [];
  adj.forEach((list, g) => { list.forEach(([b, m]) => { walkIdx.push(b); walkMin.push(m); }); walkPtr[g + 1] = walkIdx.length; });
  const patPtr = new Int32Array(patterns.length + 1);
  patterns.forEach((p, i) => { patPtr[i + 1] = patPtr[i] + p.stops.length; });
  const L = Math.max(...patterns.map((p) => p.line)) + 1;
  const lineMode = new Uint8Array(L);
  patterns.forEach((p) => { lineMode[p.line] = p.mode || 0; });
  const modes = new Int32Array(n);
  patterns.forEach((p) => p.stops.forEach((s) => { modes[s] |= 1 << (p.mode || 0); }));
  return new TransitNetwork({
    lon, lat, pop: new Float32Array(n).fill(1), dest: Float32Array.from(extra.dest || new Array(n).fill(0)), modes, nLines: new Int32Array(n),
    walkPtr, walkIdx: Int32Array.from(walkIdx), walkMin: Float32Array.from(walkMin),
    patLine: Int32Array.from(patterns.map((p) => p.line)), patWait: new Float32Array(patterns.length).fill(5),
    patTrips: new Float32Array(patterns.length).fill(20), patPtr,
    patStops: Int32Array.from(patterns.flatMap((p) => p.stops)),
    patCum: Float32Array.from(patterns.flatMap((p) => p.stops.map((_, k) => k * 3))),
    lineMode,
  }, params);
}

test('노선 하나뿐인 구간은 제거하면 단절되고, 모든 정류장이 대체 없음', () => {
  const net = makeNet(4, [{ line: 0, stops: [0, 1, 2, 3] }, { line: 0, stops: [3, 2, 1, 0] }]);
  const r = new Simulator(net).lineRemoval(0);
  assert.ok(r.details.disconnectedPairs > 0);
  assert.equal(r.components.no_alternative, 1);
  assert.equal(r.components.time_increase, 1);
});

test('왕복을 한 운행계통으로 묶으면 반대 방향이 "대체 노선"이 되지 않는다', () => {
  // v6 오류 재현: 가는 편(line 0)과 오는 편(line 1)을 다른 노선으로 두면 서로를 대체로 셈
  const split = makeNet(3, [{ line: 0, stops: [0, 1, 2] }, { line: 1, stops: [2, 1, 0] }]);
  const merged = makeNet(3, [{ line: 0, stops: [0, 1, 2] }, { line: 0, stops: [2, 1, 0] }]);
  assert.equal(new Simulator(split).lineRemoval(0).components.no_alternative, 0);   // 잘못된 모델
  assert.equal(new Simulator(merged).lineRemoval(0).components.no_alternative, 1);  // 올바른 모델
});

test('평행 노선이 있으면 제거 영향이 작다', () => {
  const net = makeNet(3, [
    { line: 0, stops: [0, 1, 2] }, { line: 0, stops: [2, 1, 0] },
    { line: 1, stops: [0, 1, 2] }, { line: 1, stops: [2, 1, 0] },
  ]);
  const r = new Simulator(net).lineRemoval(0);
  assert.equal(r.details.disconnectedPairs, 0);
  assert.equal(r.components.no_alternative, 0);
  assert.ok(r.components.time_increase < 0.05);
});

test('경로 탐색은 노선 방향을 지킨다(한 방향 패턴을 거꾸로 타지 않음)', () => {
  const net = makeNet(3, [{ line: 0, stops: [0, 1, 2] }]);
  const sim = new Simulator(net);
  assert.ok(sim.journey(0, 2));
  assert.equal(sim.journey(2, 0), null);
});

test('정류장 폐쇄: 버스는 통과하고, 주민은 대체 정류장까지 걷는다', () => {
  // 1 을 폐쇄해도 0→2 운행은 계속된다. 1 옆 4 번 그룹(도보 2분)이 같은 노선의 대체 정류장
  const net = makeNet(5, [{ line: 0, stops: [0, 1, 2] }, { line: 0, stops: [2, 1, 0] }, { line: 1, stops: [4, 3] }],
    [[1, 4, 2]], { dest: [0, 0, 1, 0, 0] });
  const sim = new Simulator(net);
  const r = sim.stopClosure(1, true);
  assert.equal(r.details.alternative, 4);
  assert.ok(r.components.walk_penalty > 0 && r.components.walk_penalty < 1);
  sim.router.run([[0, 0]], { closedGroup: 1, limit: 100 });
  assert.ok(Number.isFinite(sim.router.time[2]), '폐쇄 정류장을 통과해 2 에 도착해야 함');
});

test('DRT 정책은 고립 정류장을 다시 연결해 대체경로 부족을 줄인다', () => {
  // line 0: 0-1-2 (제거 대상), line 1: 3-4 (2km 옆 다른 노선)
  const net = makeNet(5, [{ line: 0, stops: [0, 1, 2] }, { line: 0, stops: [2, 1, 0] }, { line: 1, stops: [3, 4] }, { line: 1, stops: [4, 3] }],
    [[2, 3, 30]]);
  const sim = new Simulator(net);
  const before = sim.lineRemoval(0);
  const policy = sim.buildLinePolicy(0, 'drt', before);
  assert.ok(policy.feasible);
  const after = sim.lineRemoval(0, policy);
  assert.ok(after.components.no_alternative < before.components.no_alternative);
});

test('정책 조합(DRT + 증편)은 각각 따로 쓸 때보다 나빠지지 않는다', () => {
  const net = makeNet(5, [{ line: 0, stops: [0, 1, 2] }, { line: 0, stops: [2, 1, 0] }, { line: 1, stops: [3, 4] }, { line: 1, stops: [4, 3] }],
    [[2, 3, 30]]);
  const sim = new Simulator(net);
  const drt = sim.evaluateLinePolicyCombo(0, [{ kind: 'drt', opt: { maxKm: 8, waitMin: 20 } }]);
  const freq = sim.evaluateLinePolicyCombo(0, [{ kind: 'frequency', opt: { freqMultiplier: 2 } }]);
  const both = sim.evaluateLinePolicyCombo(0, [{ kind: 'drt', opt: { maxKm: 8, waitMin: 20 } }, { kind: 'frequency', opt: { freqMultiplier: 2 } }]);
  assert.ok(both.policy.feasible && both.policy.waitScale && both.policy.extraLinks);
  const c = (r) => (r.after || r.before).components;
  assert.ok(c(both).no_alternative <= c(drt).no_alternative + 1e-9);
  assert.ok(c(both).time_increase <= Math.min(c(drt).time_increase, c(freq).time_increase) + 1e-9);
  // 한 가지 정책만 넘기면 기존 함수와 결과가 같다
  const single = sim.evaluateLinePolicy(0, 'drt', { maxKm: 8, waitMin: 20 });
  assert.deepStrictEqual(c(drt), single.after.components);
});

test('여러 바퀴가 한 운행으로 기록된 순환선도 표본 이동이 생긴다(서울 2호선 사례)', () => {
  // 0→1→2→3→0→1→2→3→0 (두 바퀴): 기존 방식이면 0·25·50·75·100% 지점이 모두 역 0 이라 표본이 0개였다
  const loop = [0, 1, 2, 3, 0, 1, 2, 3, 0];
  const net = makeNet(4, [{ line: 0, stops: loop }]);
  const r = new Simulator(net).lineRemoval(0);
  assert.ok(r.details.pairs.length > 0);
  assert.ok(r.components.time_increase > 0);      // 대체가 없으니 끊기면 이동시간 증가(단절)가 잡혀야 한다
});

test('정류장 폐쇄: 400m 밖이라도 800m 안에 다른 정류장이 있으면 "완전 고립"이 아니다', () => {
  // 그룹 0 과 1 은 약 600m, 그룹 3 은 다른 모든 그룹과 2km 이상 떨어져 있다(도보 링크 없음)
  const net = makeNet(4, [
    { line: 0, stops: [0, 2] }, { line: 1, stops: [1, 2] }, { line: 2, stops: [3, 2] },
  ], [], { lon: [127.0, 127.00665, 127.03, 127.06] });
  const sim = new Simulator(net);
  const near = sim.stopClosure(0, true);
  assert.equal(near.details.alternative, 1, '600m 떨어진 정류장을 대체 정류장으로 찾아야 함');
  assert.ok(near.components.walk_penalty > 0.5 && near.components.walk_penalty < 1, `도보 부담은 부분 점수: ${near.components.walk_penalty}`);
  assert.ok(Math.abs(near.details.extraWalkMin - 600 * 1.25 / 75) < 1, '도보 시간은 실제 거리 기준');
  const far = sim.stopClosure(3, true);
  assert.equal(far.details.alternative, -1, '800m 안에 아무것도 없으면 고립');
  assert.equal(far.components.walk_penalty, 1);
});
