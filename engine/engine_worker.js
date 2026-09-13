/* =============================================================================
   engine_worker.js — 브라우저에서 SeomEngine 을 워커로 돌리는 얇은 어댑터
   (빌드 시 seom_engine.js 뒤에 이어 붙여 하나의 워커 소스가 된다)
   ============================================================================= */
/* global SeomEngine */
'use strict';

let initArgs = null;
let simulator = null;

function ensureSimulator() {
  if (!simulator) {
    const net = new SeomEngine.TransitNetwork(initArgs.arrays, initArgs.params);
    simulator = new SeomEngine.Simulator(net);
  }
  return simulator;
}

/** 타입 배열·Map 을 postMessage 로 보낼 수 있는 일반 객체로 */
function toPlain(value) {
  return JSON.parse(JSON.stringify(value, (key, v) => {
    if (v instanceof Map) return undefined;
    if (ArrayBuffer.isView(v)) return Array.from(v);
    if (v === Infinity) return null;
    return v;
  }));
}

function publicPolicy(p) {
  return { kind: p.kind, note: p.note, feasible: p.feasible, links: p.links, touchedLines: p.touchedLines || [] };
}

const OPS = {
  init(args) { initArgs = args; return true; },
  warm() { ensureSimulator(); return true; },
  line({ line }) { return ensureSimulator().lineRemoval(line); },
  linePolicyCombo({ line, parts }) {
    const { policy, before, after } = ensureSimulator().evaluateLinePolicyCombo(line, parts);
    return { policy: publicPolicy(policy), before, after };
  },
  linePolicy({ line, kind, opt = {} }) {
    const { policy, before, after } = ensureSimulator().evaluateLinePolicy(line, kind, opt);
    return { policy: publicPolicy(policy), before, after };
  },
  stop({ group }) { return ensureSimulator().stopClosure(group, true); },
  stopPolicy({ group, meters = 100 }) {
    const sim = ensureSimulator();
    return { before: sim.stopClosure(group, true), after: sim.stopClosure(group, true, { tempStopM: meters }) };
  },
  segment({ a, b }) { return ensureSimulator().segmentRemoval(a, b); },
  journey({ start, end }) { return ensureSimulator().journeyResilience(start, end); },
};

self.onmessage = (event) => {
  const { id, op, args } = event.data;
  try {
    if (!OPS[op]) throw new Error(`알 수 없는 작업: ${op}`);
    self.postMessage({ id, ok: true, result: toPlain(OPS[op](args)) });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
