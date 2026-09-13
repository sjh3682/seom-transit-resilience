/* 지도 점수 = 버튼 결과 확인 (tests/test_pipeline.py 가 호출)
   웹에 들어가는 압축 데이터(seom_data.bin.gz)를 브라우저와 똑같이 풀어서 엔진을 돌리고,
   파이프라인이 저장한 제거 시뮬레이션 결과(sim_lines.json)와 비교한다. */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { TransitNetwork, Simulator } = require('../engine/seom_engine.js');

const ROOT = path.resolve(__dirname, '..');
const params = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'params.json'), 'utf8'));
const buf = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'data', 'web', 'seom_data.bin.gz')));
const headLen = buf.readUInt32LE(0);
const header = JSON.parse(buf.subarray(4, 4 + headLen).toString('utf8'));
const CTORS = { float32: Float32Array, int32: Int32Array, uint32: Uint32Array, int16: Int16Array, uint16: Uint16Array, int8: Int8Array, uint8: Uint8Array };
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
const A = {};
for (const [name, [dtype, off, len, scale]] of Object.entries(header.arrays)) {
  const view = new CTORS[dtype](ab, 4 + headLen + off, len);
  A[name] = scale ? Float32Array.from(view, (v) => v / scale) : view;
}
const net = new TransitNetwork({
  lon: A.g_lon, lat: A.g_lat, pop: A.g_pop, dest: A.g_dest, modes: A.g_modes, nLines: A.g_nlines,
  walkPtr: A.w_ptr, walkIdx: A.w_idx, walkMin: A.w_min,
  patLine: A.p_line, patWait: A.p_wait, patTrips: A.p_trips, patPtr: A.p_ptr, patStops: A.p_stops, patCum: A.p_cum,
  lineMode: A.l_mode,
}, params);
const sim = new Simulator(net);
const stored = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'interim', 'sim_lines.json'), 'utf8')).rows;

let seed = 7, worst = 0, checked = 0;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
for (let i = 0; i < 30; i++) {
  const l = Math.floor(rand() * net.L);
  const c = Object.values(sim.lineRemoval(l).components);
  c.forEach((v, k) => { worst = Math.max(worst, Math.abs(v - stored[l].c[k])); });
  checked++;
}
console.log(`검사 ${checked}개 노선, 최대 차이 ${worst.toFixed(4)}`);
if (worst > 0.02) { console.error('지도 점수와 엔진 재계산이 어긋납니다'); process.exit(1); }
