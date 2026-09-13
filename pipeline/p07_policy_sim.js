/* 7단계(보조): 정책 후보 정밀 계산 — p08_policy_ai.py 가 호출한다.

   입력  data/interim/<name>.candidates.json   [[line, kind, opt], ...] 또는 [[line, [{kind, opt}, ...]], ...]
   출력  data/interim/<name>.results.json       후보별 적용 후 지표·비용 계산용 정보

   웹의 '대안 비교'·'추천 정책' 버튼과 같은 엔진 함수(Simulator.evaluateLinePolicyCombo)를 쓴다.
   사용: node pipeline/p07_policy_sim.js <name>
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { Simulator } = require('../engine/seom_engine.js');
const { networkFromGraph } = require('./p03_simulate.js');

const ROOT = path.resolve(__dirname, '..');
const INTERIM = path.join(ROOT, 'data', 'interim');

function main() {
  const name = process.argv[2] || 'policy';
  const candidates = JSON.parse(fs.readFileSync(path.join(INTERIM, `${name}.candidates.json`), 'utf8'));
  const graph = JSON.parse(fs.readFileSync(path.join(INTERIM, 'graph.json'), 'utf8'));
  const net = networkFromGraph(graph);
  const sim = new Simulator(net);
  const round = (x, d = 4) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

  // 중간 저장·이어하기: 결과를 한 줄씩 진행 파일에 적고, 같은 후보·엔진·교통망이면 다시 시작할 때 건너뛴다
  const crypto = require('crypto');
  const graphStat = fs.statSync(path.join(INTERIM, 'graph.json'));
  const stamp = crypto.createHash('sha1')
    .update(fs.readFileSync(path.join(INTERIM, `${name}.candidates.json`)))
    .update(fs.readFileSync(path.join(ROOT, 'engine', 'seom_engine.js')))
    .update(`${graphStat.size}:${graphStat.mtimeMs}`).digest('hex');
  const progressPath = path.join(INTERIM, `${name}.progress.jsonl`);
  const out = new Array(candidates.length);
  let resumed = 0;
  if (fs.existsSync(progressPath)) {
    const lines = fs.readFileSync(progressPath, 'utf8').split('\n').filter(Boolean);
    if (lines.length && JSON.parse(lines[0]).stamp === stamp) {
      for (const ln of lines.slice(1)) { try { const [i, r] = JSON.parse(ln); out[i] = r; resumed++; } catch (e) { /* 마지막 줄이 잘렸으면 무시 */ } }
    } else fs.unlinkSync(progressPath);
  }
  if (!fs.existsSync(progressPath)) fs.writeFileSync(progressPath, JSON.stringify({ stamp }) + '\n');
  if (resumed) console.log(`[seom] 이어하기: ${resumed.toLocaleString()}개는 이미 계산됨`);
  const progress = fs.openSync(progressPath, 'a');
  const limit = Number(process.env.SEOM_P07_LIMIT || Infinity);      // 테스트용: 이만큼만 계산하고 멈춤
  let done = 0;
  const beforeCache = new Map();
  const t0 = Date.now();
  candidates.forEach((cand, i) => {
    if (out[i] || done >= limit) return;
    done++;
    const s = Date.now();
    const line = cand[0];
    // 형식: [line, kind, opt] (정책 하나) 또는 [line, [{kind, opt}, …]] (정책 조합)
    const parts = Array.isArray(cand[1]) ? cand[1] : [{ kind: cand[1], opt: cand[2] || {} }];
    if (!beforeCache.has(line)) beforeCache.set(line, sim.lineRemoval(line));
    const { policy, before, after } = sim.evaluateLinePolicyCombo(line, parts, beforeCache.get(line));
    const strandedPop = (list) => list.reduce((acc, g) => acc + net.pop[g], 0);
    out[i] = {
      feasible: policy.feasible,
      before: Object.values(before.components).map((v) => round(v)),
      after: after ? Object.values(after.components).map((v) => round(v)) : null,
      strandedBefore: before.details.stranded.length,
      strandedAfter: after ? after.details.stranded.length : before.details.stranded.length,
      strandedPopBefore: round(strandedPop(before.details.stranded), 1),
      strandedPopAfter: round(after ? strandedPop(after.details.stranded) : strandedPop(before.details.stranded), 1),
      discBefore: before.details.disconnectedPairs, discAfter: after ? after.details.disconnectedPairs : before.details.disconnectedPairs,
      nPairs: before.details.pairs.length,
      links: policy.links.length,
      linkKm: round(policy.links.reduce((a, k) => a + k.km, 0), 2),
      linkMaxMin: round(policy.links.reduce((a, k) => Math.max(a, k.minutes), 0), 1),
      extLines: [...new Set(policy.links.map((k) => k.viaLine))],
      touchedLines: policy.touchedLines || [],
      ms: Date.now() - s,
    };
    fs.writeSync(progress, JSON.stringify([i, out[i]]) + '\n');
    if (i % 500 === 0) console.log(`[seom] 정책 후보 ${i.toLocaleString()} / ${candidates.length.toLocaleString()}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  });
  fs.closeSync(progress);
  if (out.filter(Boolean).length < candidates.length) { console.log(`[seom] 중간 저장: ${out.filter(Boolean).length.toLocaleString()} / ${candidates.length.toLocaleString()}`); return; }
  fs.writeFileSync(path.join(INTERIM, `${name}.results.json`), JSON.stringify(out));
  fs.unlinkSync(progressPath);
  console.log(`[seom] 정책 후보 ${candidates.length.toLocaleString()}개 계산 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
