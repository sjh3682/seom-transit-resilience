/* =============================================================================
   SeomEngine — 제거 시뮬레이션 엔진 (파이프라인과 웹이 같은 코드를 쓴다)
   -----------------------------------------------------------------------------
   v6 에서는 지도 색(Python 가중합)과 '스트레스 테스트' 버튼(JS 별도 공식)이
   서로 다른 계산이라 결과가 어긋났다. 이 파일 하나를
     - pipeline/p03_simulate.js (Node, 전국 전수 계산)
     - 웹 브라우저 (선택한 대상 재계산·정책 시뮬레이션·경로찾기)
   가 똑같이 불러 쓰므로, 지도 점수와 버튼 결과가 항상 일치한다.

   네트워크 모델
     노드  = 정류장 그룹(같은 이름·100m 이내 정류장 묶음)
     이동  = 패턴(방향이 있는 정차 순서) 탑승: 대기(배차/2, 상한) + 누적 소요시간
             도보 환승: 400m 이내 그룹 사이, 도보 속도·우회계수 반영
     탐색  = 시간 기반 다익스트라(탑승 지배 규칙으로 패턴 재스캔 최소화)
   ============================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SeomEngine = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const INF = Infinity;

  // ---------------------------------------------------------------------------
  // 네트워크: 타입 배열 묶음 + 파생 인덱스
  // ---------------------------------------------------------------------------
  class TransitNetwork {
    /**
     * @param {object} a  타입 배열 모음
     *   groups : lon, lat, pop, dest, modes, nLines
     *   walk   : walkPtr, walkIdx, walkMin
     *   pattern: patLine, patWait, patTrips, patPtr, patStops, patCum
     *   line   : lineMode
     * @param {object} params config/params.json
     */
    constructor(a, params) {
      Object.assign(this, a);
      this.params = params;
      this.G = a.lon.length;
      this.P = a.patLine.length;
      this.L = a.lineMode.length;
      // A* 휴리스틱용 국지 평면 좌표(미터)
      const kx = 111320 * Math.cos(36.2 * Math.PI / 180);
      this.xm = new Float64Array(this.G); this.ym = new Float64Array(this.G);
      for (let g = 0; g < this.G; g++) { this.xm[g] = a.lon[g] * kx; this.ym[g] = a.lat[g] * 111320; }
      this._buildIndexes();
    }

    _buildIndexes() {
      const { G, P, L, patPtr, patStops, patLine, patTrips } = this;

      // 그룹 → (패턴, 위치) 역인덱스
      const count = new Int32Array(G + 1);
      for (let k = 0; k < patStops.length; k++) count[patStops[k] + 1]++;
      for (let g = 0; g < G; g++) count[g + 1] += count[g];
      this.gpPtr = count.slice();
      const fill = count.slice(0, G);
      this.gpPat = new Int32Array(patStops.length);
      this.gpPos = new Int32Array(patStops.length);
      for (let p = 0; p < P; p++) {
        for (let k = patPtr[p]; k < patPtr[p + 1]; k++) {
          const g = patStops[k], slot = fill[g]++;
          this.gpPat[slot] = p;
          this.gpPos[slot] = k - patPtr[p];
        }
      }

      // 운행계통 → 패턴
      const lp = new Int32Array(L + 1);
      for (let p = 0; p < P; p++) lp[patLine[p] + 1]++;
      for (let l = 0; l < L; l++) lp[l + 1] += lp[l];
      this.linePatPtr = lp.slice();
      const lf = lp.slice(0, L);
      this.linePatIdx = new Int32Array(P);
      for (let p = 0; p < P; p++) this.linePatIdx[lf[patLine[p]]++] = p;

      // 운행계통 → 정류장 그룹(중복 제거), 그룹 → 운행계통 및 계통별 운행횟수
      const lineGroups = [];
      const groupLineTrips = new Map();       // g*L + l 대신 그룹별 Map 을 쓰면 메모리가 커져 키 연산 사용
      this._glKey = (g, l) => g * L + l;
      for (let l = 0; l < L; l++) {
        const set = new Set();
        for (let q = lp[l]; q < lp[l + 1]; q++) {
          const p = this.linePatIdx[q];
          for (let k = patPtr[p]; k < patPtr[p + 1]; k++) {
            const g = patStops[k];
            set.add(g);
            const key = g * L + l;
            groupLineTrips.set(key, (groupLineTrips.get(key) || 0) + patTrips[p]);
          }
        }
        lineGroups.push(Int32Array.from(set));
      }
      this.lineGroups = lineGroups;
      this.groupLineTrips = groupLineTrips;

      const glCount = new Int32Array(G + 1);
      for (let l = 0; l < L; l++) for (const g of lineGroups[l]) glCount[g + 1]++;
      for (let g = 0; g < G; g++) glCount[g + 1] += glCount[g];
      this.glPtr = glCount.slice();
      const glFill = glCount.slice(0, G);
      this.glLine = new Int32Array(glCount[G]);
      for (let l = 0; l < L; l++) for (const g of lineGroups[l]) this.glLine[glFill[g]++] = l;

      this.groupTrips = new Float32Array(G);
      for (const [key, t] of groupLineTrips) this.groupTrips[Math.floor(key / L)] += t;

      // 물리 구간(무방향) 운행횟수
      const edgeTrips = new Map();
      for (let p = 0; p < P; p++) {
        for (let k = patPtr[p] + 1; k < patPtr[p + 1]; k++) {
          const key = TransitNetwork.edgeKey(patStops[k - 1], patStops[k]);
          edgeTrips.set(key, (edgeTrips.get(key) || 0) + patTrips[p]);
        }
      }
      this.edgeTrips = edgeTrips;
    }

    /**
     * 반경 안의 다른 그룹과 도보 시간(분). 도보 환승 링크(400m)보다 넓은 범위를 봐야 할 때
     * (정류장 폐쇄 시 대체 정류장 탐색) 쓴다. 격자 인덱스는 처음 호출할 때 한 번 만든다.
     */
    groupsWithin(g, radiusM) {
      const CELL = 800;
      if (!this._grid) {
        this._grid = new Map();
        for (let h = 0; h < this.G; h++) {
          const key = Math.floor(this.xm[h] / CELL) * 8192 + Math.floor(this.ym[h] / CELL);
          const bucket = this._grid.get(key);
          if (bucket) bucket.push(h); else this._grid.set(key, [h]);
        }
      }
      const cx = Math.floor(this.xm[g] / CELL), cy = Math.floor(this.ym[g] / CELL);
      const reach = Math.ceil(radiusM / CELL);
      const out = [];
      for (let dx = -reach; dx <= reach; dx++) {
        for (let dy = -reach; dy <= reach; dy++) {
          const bucket = this._grid.get((cx + dx) * 8192 + cy + dy);
          if (!bucket) continue;
          for (const h of bucket) {
            if (h === g) continue;
            const d = Math.hypot(this.xm[h] - this.xm[g], this.ym[h] - this.ym[g]);
            if (d <= radiusM) out.push([h, this.walkMinutes(d)]);
          }
        }
      }
      return out;
    }

    static edgeKey(a, b) { return a < b ? a * 4194304 + b : b * 4194304 + a; }
    static edgeFromKey(key) { const a = Math.floor(key / 4194304); return [a, key - a * 4194304]; }

    linesAt(g) { return this.glLine.subarray(this.glPtr[g], this.glPtr[g + 1]); }
    walkNeighbors(g) { return [this.walkPtr[g], this.walkPtr[g + 1]]; }
    patternStops(p) { return this.patStops.subarray(this.patPtr[p], this.patPtr[p + 1]); }
    patternCum(p) { return this.patCum.subarray(this.patPtr[p], this.patPtr[p + 1]); }
    linePatterns(l) { return this.linePatIdx.subarray(this.linePatPtr[l], this.linePatPtr[l + 1]); }

    /** 대표 패턴(가장 긴 패턴) — 지도에 그릴 선형 */
    mainPattern(l) {
      let best = -1, bestLen = -1;
      for (const p of this.linePatterns(l)) {
        const len = this.patPtr[p + 1] - this.patPtr[p];
        if (len > bestLen) { bestLen = len; best = p; }
      }
      return best;
    }

    distanceM(a, b) {
      const R = 6371000, rad = Math.PI / 180;
      const dLat = (this.lat[b] - this.lat[a]) * rad, dLon = (this.lon[b] - this.lon[a]) * rad;
      const s = Math.sin(dLat / 2) ** 2 + Math.cos(this.lat[a] * rad) * Math.cos(this.lat[b] * rad) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(s));
    }

    walkMinutes(meters) {
      const w = this.params.walk;
      return meters * w.detour / (w.speed_kmh * 1000 / 60);
    }
  }

  // ---------------------------------------------------------------------------
  // 최소 힙 (시간, 그룹)
  // ---------------------------------------------------------------------------
  class MinHeap {
    constructor(capacity = 1 << 16) {
      this.keys = new Float64Array(capacity);
      this.vals = new Int32Array(capacity);
      this.size = 0;
    }
    clear() { this.size = 0; }
    push(key, val) {
      if (this.size === this.keys.length) {
        const k = new Float64Array(this.size * 2); k.set(this.keys); this.keys = k;
        const v = new Int32Array(this.size * 2); v.set(this.vals); this.vals = v;
      }
      let i = this.size++;
      const keys = this.keys, vals = this.vals;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (keys[parent] <= key) break;
        keys[i] = keys[parent]; vals[i] = vals[parent]; i = parent;
      }
      keys[i] = key; vals[i] = val;
    }
    pop() {  // 호출 전 size>0 확인. 결과는 this.topKey / 반환값(그룹)
      const keys = this.keys, vals = this.vals;
      const topVal = vals[0];
      this.topKey = keys[0];
      const lastKey = keys[--this.size], lastVal = vals[this.size];
      let i = 0;
      const n = this.size;
      while (true) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= lastKey) break;
        keys[i] = keys[c]; vals[i] = vals[c]; i = c;
      }
      keys[i] = lastKey; vals[i] = lastVal;
      return topVal;
    }
  }

  // ---------------------------------------------------------------------------
  // Router — 시간 기반 최단경로 (버퍼 재사용)
  // ---------------------------------------------------------------------------
  const PRED_NONE = 0, PRED_WALK = 1, PRED_RIDE = 2, PRED_LINK = 3;

  class Router {
    constructor(net) {
      this.net = net;
      this.time = new Float64Array(net.G).fill(INF);
      this.settled = new Uint8Array(net.G);
      this.touched = new Int32Array(net.G);
      this.nTouched = 0;
      this.patBestOffset = new Float64Array(net.P).fill(INF);
      this.patBestPos = new Int32Array(net.P);
      this.patTouched = new Int32Array(net.P);
      this.nPatTouched = 0;
      this.heap = new MinHeap();
      // 경로 복원용
      this.predType = new Uint8Array(net.G);
      this.predFrom = new Int32Array(net.G);
      this.predPat = new Int32Array(net.G);
      this.predPos = new Int32Array(net.G);
    }

    _reset() {
      for (let i = 0; i < this.nTouched; i++) {
        const g = this.touched[i];
        this.time[g] = INF; this.settled[g] = 0; this.predType[g] = PRED_NONE;
      }
      this.nTouched = 0;
      for (let i = 0; i < this.nPatTouched; i++) this.patBestOffset[this.patTouched[i]] = INF;
      this.nPatTouched = 0;
      this.heap.clear();
    }

    _relax(g, t, type, from, pat, pos) {
      if (t >= this.time[g]) return;
      if (this.time[g] === INF) this.touched[this.nTouched++] = g;
      this.time[g] = t;
      this.predType[g] = type; this.predFrom[g] = from; this.predPat[g] = pat; this.predPos[g] = pos;
      this.heap.push(this._h ? t + this._h(g) : t, g);
    }

    /**
     * @param {Array<[number, number]>} origins  [그룹, 출발시각(분)]
     * @param {object} o
     *   limit          탐색 시간 상한(분)
     *   target         도착하면 즉시 종료할 그룹(-1: 없음)
     *   disabledLines  Uint8Array(L) — 1 이면 해당 운행계통 운행 중단
     *   closedGroup    폐쇄 정류장 그룹(승하차 불가, 통과는 가능)
     *   blockedEdge    [a,b] 끊긴 물리 구간(양방향)
     *   waitScale      Float32Array(L) — 운행계통별 대기시간 배율(증편 정책)
     *   extraLinks     Map<g, Array<[h, minutes]>> — 정책으로 추가된 연결(DRT 등)
     *   allowedGroups  Uint8Array(G) — 1 인 그룹만 사용(장거리 노선용 축소망)
     *   noWalk         true 면 도보 환승 금지
     * @returns 정착한 그룹 수
     */
    run(origins, o = {}) {
      this._reset();
      const net = this.net;
      const limit = o.limit ?? INF;
      const target = o.target ?? -1;
      const disabled = o.disabledLines || null;
      const closed = o.closedGroup ?? -1;
      const allowed = o.allowedGroups || null;
      const waitScale = o.waitScale || null;
      const extra = o.extraLinks || null;
      const noWalk = !!o.noWalk;
      let blockA = -1, blockB = -1;
      if (o.blockedEdge) [blockA, blockB] = o.blockedEdge;
      const goal = o.goal ?? -1;
      const xm = net.xm, ym = net.ym;
      const gx = goal >= 0 ? xm[goal] : 0, gy = goal >= 0 ? ym[goal] : 0;
      const invSpeed = goal >= 0 ? 1 / (o.speed || 500) : 0;
      this._h = goal >= 0 ? (g) => Math.hypot(xm[g] - gx, ym[g] - gy) * invSpeed : null;

      const { gpPtr, gpPat, gpPos, patPtr, patStops, patCum, patWait, patLine, walkPtr, walkIdx, walkMin } = net;
      const time = this.time, settled = this.settled, heap = this.heap;
      const bestOff = this.patBestOffset, bestPos = this.patBestPos;

      for (const [g, t0] of origins) {
        if (g === closed || (allowed && !allowed[g])) continue;
        this._relax(g, t0, PRED_NONE, -1, -1, -1);
      }

      let nSettled = 0;
      const H = this._h;
      while (heap.size) {
        const g = heap.pop();
        const key = heap.topKey;
        if (settled[g]) continue;
        const t = time[g];
        if (key > (H ? t + H(g) : t) + 1e-9) continue;   // 오래된 힙 항목
        if (key > limit) break;                          // 남은 모든 후보가 상한 초과
        settled[g] = 1;
        nSettled++;
        if (g === target || g === goal) break;

        // 도보 환승
        if (!noWalk) {
          for (let k = walkPtr[g]; k < walkPtr[g + 1]; k++) {
            const h = walkIdx[k];
            if (h === closed || (allowed && !allowed[h])) continue;
            this._relax(h, t + walkMin[k], PRED_WALK, g, -1, -1);
          }
        }
        // 정책 추가 연결
        if (extra) {
          const links = extra.get(g);
          if (links) for (const [h, m] of links) this._relax(h, t + m, PRED_LINK, g, -1, -1);
        }
        // 탑승 (폐쇄 정류장에서는 승차 불가)
        if (g === closed) continue;
        for (let e = gpPtr[g]; e < gpPtr[g + 1]; e++) {
          const p = gpPat[e];
          const line = patLine[p];
          if (disabled && disabled[line]) continue;
          const pos = gpPos[e];
          const base = patPtr[p];
          const wait = patWait[p] * (waitScale ? waitScale[line] : 1);
          const offset = t + wait - patCum[base + pos];
          const prevOff = bestOff[p], prevPos = bestPos[p];
          if (offset >= prevOff && pos >= prevPos) continue;      // 이미 더 좋은 탑승이 있음
          if (prevOff === INF) this.patTouched[this.nPatTouched++] = p;
          if (offset < prevOff) { bestOff[p] = offset; bestPos[p] = pos; }
          const end = patPtr[p + 1];
          for (let k = base + pos + 1; k < end; k++) {
            if (prevOff !== INF && k - base >= prevPos && offset >= prevOff) break;
            const prevStop = patStops[k - 1], h = patStops[k];
            if (blockA >= 0 && ((prevStop === blockA && h === blockB) || (prevStop === blockB && h === blockA))) break;
            if (h === closed || (allowed && !allowed[h])) continue;   // 폐쇄 정류장은 통과만
            const arr = offset + patCum[k];
            if (arr > limit) break;
            this._relax(h, arr, PRED_RIDE, g, p, k - base);
          }
        }
      }
      this.nSettled = nSettled;
      this._h = null;
      return nSettled;
    }

    /** 정착한 그룹의 목적지 가중치 합 (limit 이내 도달 가능한 거점 수) */
    reachableDest(limit) {
      const { dest } = this.net;
      let sum = 0;
      for (let i = 0; i < this.nTouched; i++) {
        const g = this.touched[i];
        if (this.time[g] <= limit) sum += dest[g];
      }
      return sum;
    }

    /** 마지막 run 기준으로 target 까지의 구간(leg) 목록 */
    legsTo(target) {
      if (this.time[target] === INF) return null;
      const legs = [];
      let g = target;
      while (this.predType[g] !== PRED_NONE) {
        const type = this.predType[g], from = this.predFrom[g];
        if (type === PRED_RIDE) {
          const p = this.predPat[g];
          const toPos = this.predPos[g];
          // 같은 패턴 탑승은 from 그룹의 위치를 역으로 찾는다
          const stops = this.net.patternStops(p);
          let fromPos = toPos - 1;
          while (fromPos > 0 && stops[fromPos] !== from) fromPos--;
          legs.push({ kind: 'ride', pattern: p, line: this.net.patLine[p], fromPos, toPos, from, to: g });
        } else {
          legs.push({ kind: type === PRED_WALK ? 'walk' : 'link', from, to: g });
        }
        g = from;
      }
      legs.reverse();
      return legs;
    }
  }

  // ---------------------------------------------------------------------------
  // 시뮬레이션
  // ---------------------------------------------------------------------------
  class Simulator {
    constructor(net) {
      this.net = net;
      this.router = new Router(net);
      this.sim = net.params.simulation;
      // 장거리 교통수단(해운·시외·철도·항공 등)이 서는 그룹 = 장거리 노선용 축소망
      const ldBits = Object.entries(net.params.modes)
        .filter(([, m]) => m.long_distance).reduce((acc, [code]) => acc | (1 << Number(code)), 0);
      this.longDistanceBits = ldBits;
      this.longDistanceGroups = new Uint8Array(net.G);
      for (let g = 0; g < net.G; g++) if (net.modes[g] & ldBits) this.longDistanceGroups[g] = 1;
      // 지역 노선의 대안은 지역 교통수단으로 본다(시내버스가 끊겼을 때 KTX 로 우회하지 않음)
      this.localMask = new Uint8Array(net.L);
      for (let l = 0; l < net.L; l++) if (this.isLongDistanceLine(l)) this.localMask[l] = 1;
      // A* 하한 속도(m/분): 각 망에서 가장 빠른 수단의 직선 환산 속도
      const straight = (m) => m.speed_kmh / m.detour * 1000 / 60;
      const modes = Object.values(net.params.modes);
      this.localSpeed = Math.max(...modes.filter((m) => !m.long_distance).map(straight));
      this.fullSpeed = Math.max(...modes.map(straight));
    }

    /** 노선 종류에 맞는 탐색 조건(축소망·비활성 계통·A* 속도) */
    _scope(l) {
      return this.isLongDistanceLine(l)
        ? { allowedGroups: this.longDistanceGroups, disabledLines: new Uint8Array(this.net.L), speed: this.fullSpeed }
        : { allowedGroups: null, disabledLines: this.localMask, speed: this.localSpeed };
    }

    isLongDistanceLine(l) { return !!this.net.params.modes[String(this.net.lineMode[l])].long_distance; }

    /**
     * 표본 OD: 패턴(최대 2개, 방향 유지)마다 위치 비율 0·25·50·75·100% 정류장을 뽑아
     * 인접 표본 쌍 + (처음→중간) + (중간→끝) 을 비교한다. 섬 항로처럼 끝과 끝이
     * 끊기는 경우를 놓치지 않기 위해 장거리 쌍을 함께 넣는다.
     */
    _odPairs(l) {
      const net = this.net, fr = this.sim.od_sample_fractions;
      const pats = [...net.linePatterns(l)]
        .sort((a, b) => (net.patPtr[b + 1] - net.patPtr[b]) - (net.patPtr[a + 1] - net.patPtr[a]))
        .slice(0, 2);
      const pairs = [], seen = new Set();
      for (const p of pats) {
        const stops = net.patternStops(p), cum = net.patternCum(p);
        const idx = [...new Set(fr.map((f) => Math.round((stops.length - 1) * f)))];
        const mid = idx[Math.floor(idx.length / 2)];
        const cand = [];
        for (let i = 0; i + 1 < idx.length; i++) cand.push([idx[i], idx[i + 1]]);
        cand.push([idx[0], mid], [mid, idx[idx.length - 1]]);
        for (const [i, j] of cand) {
          const from = stops[i], to = stops[j];
          const key = from * 4194304 + to;
          if (i >= j || from === to || seen.has(key)) continue;
          seen.add(key);
          pairs.push({ from, to, ride: cum[j] - cum[i] + net.patWait[p] });
        }
      }
      // 여러 바퀴가 한 운행으로 기록된 순환선(예: 서울 2호선, 정차 517곳)은 0·25·50·75·100% 지점이 모두 같은 역에
      // 떨어져 표본이 0개가 된다 → 첫 바퀴(출발역으로 처음 돌아오기 직전까지)에서 다시 뽑는다.
      if (!pairs.length && pats.length) {
        const p = pats[0], stops = net.patternStops(p), cum = net.patternCum(p);
        let end = stops.length - 1;
        for (let k = 1; k < stops.length; k++) if (stops[k] === stops[0]) { end = k - 1; break; }
        const idx = [...new Set(fr.map((f) => Math.round(end * f)))];
        for (let a = 0; a + 1 < idx.length; a++) {
          const i = idx[a], j = idx[a + 1], from = stops[i], to = stops[j];
          if (i < j && from !== to) pairs.push({ from, to, ride: cum[j] - cum[i] + net.patWait[p] });
        }
        if (idx.length > 2 && stops[idx[0]] !== stops[idx[idx.length - 1]]) {
          const i = idx[0], j = idx[idx.length - 1];
          pairs.push({ from: stops[i], to: stops[j], ride: cum[j] - cum[i] + net.patWait[p] });
        }
      }
      return pairs;
    }

    /**
     * 운행계통 제거 시뮬레이션 — TVS(노선)의 원천 데이터
     * @param {number} l
     * @param {object} policy  { waitScale, extraLinks }  정책 적용 후 재계산할 때
     */
    lineRemoval(l, policy = null) {
      const net = this.net, sim = this.sim, router = this.router;
      const scope = this._scope(l);
      const disabled = scope.disabledLines;
      const wasDisabled = disabled[l];
      const longDist = this.isLongDistanceLine(l);
      const allowed = scope.allowedGroups;
      const cap = sim.time_increase_cap;
      const policyOpts = policy ? { waitScale: policy.waitScale, extraLinks: policy.extraLinks } : {};

      // (1) 이동시간 증가 — 표본 OD 의 제거 전/후 최단시간(A*). 증가율은 +100% 에서 상한이므로
      //     탐색도 원래 시간의 2배(+여유)까지만 한다. 그 안에 못 가면 '단절·2배 이상 우회'.
      const pairs = this._odPairs(l);
      let tiSum = 0, disconnected = 0;
      const odDetails = [];
      for (const pr of pairs) {
        const limit = pr.ride * sim.od_limit_factor + sim.od_limit_extra_min;
        router.run([[pr.from, 0]], { limit, goal: pr.to, speed: scope.speed, allowedGroups: allowed, disabledLines: disabled });
        const before = Math.min(router.time[pr.to], pr.ride);
        disabled[l] = 1;
        router.run([[pr.from, 0]], { limit, goal: pr.to, speed: scope.speed, allowedGroups: allowed, disabledLines: disabled, ...policyOpts });
        disabled[l] = wasDisabled;
        const after = router.time[pr.to];
        let inc;
        if (after === INF) { inc = sim.disconnect_penalty; disconnected++; }
        else inc = Math.min(cap, Math.max(0, (after - before) / Math.max(1, before)));
        tiSum += inc;
        odDetails.push({ from: pr.from, to: pr.to, before, after: after === INF ? null : after });
      }
      const nPairs = pairs.length;
      const timeIncrease = nPairs ? tiSum / nPairs : 0;

      // (2) 대체경로 부족 — 이 계통만 서는(도보 400m 안에도 다른 계통 없는) 그룹의 인구 비중
      const groups = net.lineGroups[l];
      let popTotal = 0, popStranded = 0, affected = 0;
      const stranded = [];
      for (const g of groups) {
        const pop = net.pop[g];
        popTotal += pop;
        const share = (net.groupLineTrips.get(g * net.L + l) || 0) / Math.max(1e-6, net.groupTrips[g]);
        affected += pop * share;                              // (4) 영향 인구: 이 계통 의존도만큼
        if (!this._hasOtherService(g, l, policy)) { popStranded += pop; stranded.push(g); }
      }
      const noAlternative = popTotal ? popStranded / popTotal : 0;

      // (3) 연결성 붕괴 — 이 계통이 운행의 90% 이상을 담당하는 구간 비중
      const ownTrips = new Map();
      for (const p of net.linePatterns(l)) {
        const stops = net.patternStops(p);
        for (let k = 1; k < stops.length; k++) {
          const key = TransitNetwork.edgeKey(stops[k - 1], stops[k]);
          ownTrips.set(key, (ownTrips.get(key) || 0) + net.patTrips[p]);
        }
      }
      let segTotal = 0, segDependent = 0;
      for (const [key, own] of ownTrips) {
        segTotal++;
        if (own / Math.max(1e-6, net.edgeTrips.get(key)) >= 0.9) segDependent++;
      }
      const segmentDependency = segTotal ? segDependent / segTotal : 0;
      const disconnectedShare = nPairs ? disconnected / nPairs : 0;
      const connectivity = 0.5 * disconnectedShare + 0.5 * segmentDependency;

      // (5) 접근 거점 감소 — 영향이 거의 없는 계통은 계산 생략(가지치기, 결과 0)
      let accessLoss = 0, accessBefore = null, accessAfter = null;
      const needAccess = timeIncrease >= sim.prune_access_if_time_increase_below || noAlternative > 0 || disconnected > 0;
      if (needAccess) {
        const accessOrigins = [...new Set(pairs.map((x) => x.from))].slice(0, 3);
        let lossSum = 0, bSum = 0, aSum = 0;
        for (const o of accessOrigins) {
          router.run([[o, 0]], { limit: sim.access_minutes, allowedGroups: allowed, disabledLines: disabled });
          const b = router.reachableDest(sim.access_minutes);
          disabled[l] = 1;
          router.run([[o, 0]], { limit: sim.access_minutes, allowedGroups: allowed, disabledLines: disabled, ...policyOpts });
          const a = router.reachableDest(sim.access_minutes);
          disabled[l] = wasDisabled;
          bSum += b; aSum += a;
          lossSum += b > 0 ? Math.max(0, 1 - a / b) : 0;
        }
        accessLoss = accessOrigins.length ? lossSum / accessOrigins.length : 0;
        accessBefore = bSum; accessAfter = aSum;
      }

      return {
        type: 'line', line: l, longDistance: longDist,
        components: { time_increase: timeIncrease, access_loss: accessLoss, no_alternative: noAlternative, connectivity },
        affectedPopulation: affected,
        details: { pairs: odDetails, disconnectedPairs: disconnected, stranded, accessBefore, accessAfter, segTotal, segDependent, segmentDependency, disconnectedShare },
      };
    }

    _hasOtherService(g, l, policy) {
      const net = this.net;
      if (policy && policy.extraLinks && policy.extraLinks.has(g)) return true;
      for (const other of net.linesAt(g)) if (other !== l) return true;
      for (let k = net.walkPtr[g]; k < net.walkPtr[g + 1]; k++) {
        for (const other of net.linesAt(net.walkIdx[k])) if (other !== l) return true;
      }
      return false;
    }

    /**
     * 정류장 폐쇄 시뮬레이션 — 버스는 통과하고, 주민이 다른 정류장까지 걸어가야 한다.
     * 연결 단절(환승 끊김)은 환승 거점에서만 의미가 있다.
     * @param {boolean} withAccess  시간 기반 접근성 손실(비싼 계산) 포함 여부
     * @param {object} policy  { tempStopM } 임시 정류장 거리(m)
     */
    stopClosure(g, withAccess = true, policy = null) {
      const net = this.net, sim = this.sim, router = this.router;
      const lines = net.linesAt(g);

      // 대체 정류장 후보: 도보 환승권(400m) 이웃, 없으면 고립 기준 반경(800m) 안의 그룹.
      // (v7.0 은 400m 밖을 모두 '완전 고립'으로 처리해 정류장 2.5만 개가 최고점에 몰렸다)
      let cands = [];
      for (let k = net.walkPtr[g]; k < net.walkPtr[g + 1]; k++) cands.push([net.walkIdx[k], net.walkMin[k]]);
      if (!cands.length) cands = net.groupsWithin(g, net.params.walk.stranded_radius_m);
      cands = cands.filter(([h]) => net.glPtr[h + 1] > net.glPtr[h]);     // 서비스가 있는 정류장만
      let alt = -1, altMin = INF;
      for (const [h, m] of cands) if (m < altMin) { altMin = m; alt = h; }
      const tempStop = policy && policy.tempStopM != null;
      const strandedMin = net.walkMinutes(net.params.walk.stranded_radius_m);
      const extraWalk = tempStop ? net.walkMinutes(policy.tempStopM) : (alt >= 0 ? altMin : strandedMin * 1.5);
      const walkPenalty = Math.min(1, extraWalk / sim.walk_penalty_full_min);

      // 노선 손실: 대체 정류장 후보들에서도 탈 수 없게 되는 계통 비중
      let lost = 0;
      const lostLines = [];
      for (const l of lines) {
        let ok = tempStop;
        for (let i = 0; i < cands.length && !ok; i++) {
          for (const other of net.linesAt(cands[i][0])) if (other === l) { ok = true; break; }
        }
        if (!ok) { lost++; lostLines.push(l); }
      }
      const lineLoss = lines.length ? lost / lines.length : 0;

      // 환승 단절: 이 그룹에서만 만나는 계통 쌍의 비중 (환승 거점에서만 의미)
      let pairs = 0, broken = 0;
      if (lines.length >= 2 && !tempStop) {
        const L = [...lines].slice(0, 30);
        for (let i = 0; i < L.length; i++) {
          for (let j = i + 1; j < L.length; j++) {
            pairs++;
            if (!this._linesMeetElsewhere(L[i], L[j], g)) broken++;
          }
        }
      }
      const transferBreak = pairs ? broken / pairs : 0;

      // 접근 거점 감소(시간 기반): 폐쇄 전 g 에서 출발 vs 폐쇄 후 대체 정류장까지 걸어가서 출발
      let accessLoss = null, accessBefore = null, accessAfter = null;
      if (withAccess) {
        const limit = sim.access_minutes;
        router.run([[g, 0]], { limit });
        accessBefore = router.reachableDest(limit);
        if (tempStop) {
          router.run([[g, extraWalk]], { limit });
        } else if (alt >= 0) {
          router.run([[alt, extraWalk]], { limit, closedGroup: g });
        } else {
          router.run([], { limit });
        }
        accessAfter = router.nTouched ? router.reachableDest(limit) : 0;
        accessLoss = accessBefore > 0 ? Math.max(0, 1 - accessAfter / accessBefore) : (alt < 0 ? 1 : 0);
      }

      return {
        type: 'stop', group: g,
        components: { walk_penalty: walkPenalty, access_loss: accessLoss, line_loss: lineLoss, transfer_break: transferBreak },
        affectedPopulation: net.pop[g],
        details: { alternative: alt, extraWalkMin: extraWalk, lostLines, transferPairs: pairs, brokenPairs: broken, accessBefore, accessAfter },
      };
    }

    _linesMeetElsewhere(l1, l2, except) {
      const net = this.net;
      const set2 = new Set(net.lineGroups[l2]);
      for (const h of net.lineGroups[l1]) {
        if (h === except) continue;
        if (set2.has(h)) return true;
        for (let k = net.walkPtr[h]; k < net.walkPtr[h + 1]; k++) {
          const w = net.walkIdx[k];
          if (w !== except && set2.has(w)) return true;
        }
      }
      return false;
    }

    /** 물리 구간(두 그룹 사이) 단절 — 도로 통제처럼 이 구간을 지나는 모든 운행이 멈춘다 */
    segmentRemoval(a, b) {
      const net = this.net, router = this.router;
      // 제거 전: 이 구간을 직접 타는 가장 빠른 시간(대기 포함)
      let direct = INF;
      for (let e = net.gpPtr[a]; e < net.gpPtr[a + 1]; e++) {
        const p = net.gpPat[e], pos = net.gpPos[e];
        const stops = net.patternStops(p), cum = net.patternCum(p);
        if (pos + 1 < stops.length && stops[pos + 1] === b) direct = Math.min(direct, cum[pos + 1] - cum[pos] + net.patWait[p]);
        if (pos > 0 && stops[pos - 1] === b) direct = Math.min(direct, net.patWait[p] + 1);
      }
      if (direct === INF) direct = 5;
      const limit = direct + 60;
      router.run([[a, 0]], { limit, target: b, blockedEdge: [a, b] });
      const after = router.time[b];
      const legs = after === INF ? null : router.legsTo(b);
      const extra = after === INF ? null : Math.max(0, after - direct);
      return {
        type: 'segment', a, b,
        components: { detour: extra == null ? 1 : Math.min(1, extra / 30) },
        details: { directMin: direct, detourMin: after === INF ? null : after, extraMin: extra, detourLegs: legs, trips: net.edgeTrips.get(TransitNetwork.edgeKey(a, b)) || 0 },
      };
    }

    // -------------------------------------------------------------------------
    // 정책 시뮬레이션 (노선 제거 결과에 대안 적용 후 같은 지표로 재계산)
    // -------------------------------------------------------------------------
    /** 정책 후보: 'frequency' 대체 계통 증편 / 'drt' 수요응답형 / 'extension' 인접 노선 연장 */
    /** 정책 하나를 평가: 대안 없음(제거) vs 대안 적용 후 제거. 웹 버튼과 AI 정책 최적화가 같은 함수를 쓴다. */
    evaluateLinePolicy(l, kind, opt = {}, before = null) {
      const b = before || this.lineRemoval(l);
      const policy = this.buildLinePolicy(l, kind, b, opt);
      const after = policy.feasible ? this.lineRemoval(l, policy) : null;
      return { policy, before: b, after };
    }

    /**
     * 정책 조합(예: DRT + 대체 노선 증편)을 한 번에 적용. 증편은 대기시간(waitScale), DRT·연장은 추가 연결(extraLinks)을
     * 바꾸므로 함께 적용할 수 있다(공간 대안은 한 가지만). 구성 정책이 하나라도 불가능하면 조합도 불가능.
     */
    evaluateLinePolicyCombo(l, parts, before = null) {
      const b = before || this.lineRemoval(l);
      const built = parts.map((p) => this.buildLinePolicy(l, p.kind, b, p.opt || {}));
      const merged = {
        kind: parts.map((p) => p.kind).join('+'), waitScale: null, extraLinks: null, links: [], touchedLines: [],
        feasible: built.every((x) => x.feasible), note: built.map((x) => x.note).join(' · '),
      };
      for (const x of built) {
        if (x.waitScale) merged.waitScale = x.waitScale;
        if (x.extraLinks) merged.extraLinks = x.extraLinks;
        merged.links.push(...(x.links || []));
        merged.touchedLines.push(...(x.touchedLines || []));
      }
      const after = merged.feasible ? this.lineRemoval(l, merged) : null;
      return { policy: merged, before: b, after };
    }

    /**
     * @param {object} opt  정책 강도(AI 정책 최적화의 후보 변형)
     *   frequency: { freqMultiplier }  대체 계통 배차 배수(2 = 대기시간 절반)
     *   drt      : { maxKm, waitMin }  연결 반경·평균 대기
     *   extension: { maxKm }           연장 허용 거리
     */
    buildLinePolicy(l, kind, removal, opt = {}) {
      const net = this.net;
      const cfg = { drtSpeedKmh: 25, drtWaitMin: opt.waitMin ?? 20, drtMaxKm: opt.maxKm ?? 8, extMaxKm: opt.maxKm ?? 4 };
      const freqMultiplier = opt.freqMultiplier ?? 2;
      if (kind === 'frequency') {
        const waitScale = new Float32Array(net.L).fill(1);
        const touchedLines = new Set();
        for (const g of net.lineGroups[l]) {
          for (const o of net.linesAt(g)) if (o !== l) touchedLines.add(o);
          for (let k = net.walkPtr[g]; k < net.walkPtr[g + 1]; k++) for (const o of net.linesAt(net.walkIdx[k])) if (o !== l) touchedLines.add(o);
        }
        for (const o of touchedLines) waitScale[o] = 1 / freqMultiplier;
        return { kind, waitScale, touchedLines: [...touchedLines], links: [], feasible: touchedLines.size > 0, freqMultiplier,
          note: touchedLines.size ? `주변 대체 계통 ${touchedLines.size}개 배차 ${freqMultiplier}배` : '주변에 증편할 대체 계통이 없습니다' };
      }

      // DRT/연장: 고립되는 그룹(또는 시간 증가가 큰 표본 출발점)을 가장 가까운 '다른 계통' 정류장과 연결
      const targets = removal.details.stranded.length ? removal.details.stranded
        : [...new Set(removal.details.pairs.filter((p) => p.after == null || p.after > p.before * 1.3).map((p) => p.from))];
      const maxKm = kind === 'drt' ? cfg.drtMaxKm : cfg.extMaxKm;
      const extraLinks = new Map();
      const links = [];
      const blockedByWater = this.isLongDistanceLine(l) && net.lineMode[l] === 2;
      if (!blockedByWater) {
        const candidates = this._servedGroupsNear(targets, l, maxKm * 1000);
        for (const g of targets) {
          const h = candidates.get(g);
          if (h == null) continue;
          const km = net.distanceM(g, h.group) / 1000;
          const minutes = kind === 'drt' ? km * 1.3 / cfg.drtSpeedKmh * 60 + cfg.drtWaitMin : km * 1.3 / 20 * 60 + h.wait;
          const add = (x, y) => { if (!extraLinks.has(x)) extraLinks.set(x, []); extraLinks.get(x).push([y, minutes]); };
          add(g, h.group); add(h.group, g);
          links.push({ from: g, to: h.group, km, minutes, viaLine: h.line });
        }
      }
      const label = kind === 'drt' ? 'DRT' : '인접 노선 연장';
      return {
        kind, extraLinks, links, feasible: links.length > 0,
        note: blockedByWater ? '해상 항로는 육상 대안(DRT·연장)이 불가능합니다 — 증편·대체 선박만 가능'
          : links.length ? `${label} 연결 ${links.length}곳 (최대 ${maxKm}km)` : `${maxKm}km 안에 연결할 다른 계통 정류장이 없습니다`,
      };
    }

    _servedGroupsNear(targets, excludeLine, maxM) {
      // 도로로 이어진 곳만: 제거 전 망에서 해운을 빼고 도달 가능한 그룹만 후보로 본다
      const net = this.net, router = this.router;
      const disabled = new Uint8Array(net.L);
      for (let l = 0; l < net.L; l++) if (net.lineMode[l] === 2) disabled[l] = 1;
      const out = new Map();
      for (const g of targets.slice(0, 30)) {
        router.run([[g, 0]], { limit: 120, disabledLines: disabled });
        let best = null, bestD = maxM;
        for (let i = 0; i < router.nTouched; i++) {
          const h = router.touched[i];
          if (h === g) continue;
          for (const o of net.linesAt(h)) {
            if (o === excludeLine) continue;
            const d = net.distanceM(g, h);
            if (d < bestD) { bestD = d; best = { group: h, line: o, wait: net.patWait[net.linePatterns(o)[0]] }; }
          }
        }
        if (best) out.set(g, best);
      }
      return out;
    }

    // -------------------------------------------------------------------------
    // 경로찾기 + 경로 회복력 (핵심 노선이 끊기면 대체 경로가 있는가)
    // -------------------------------------------------------------------------
    journey(start, end, opts = {}) {
      const net = this.net, router = this.router;
      const limit = opts.limit ?? 600;
      const origins = [[start, 0]];
      for (let k = net.walkPtr[start]; k < net.walkPtr[start + 1]; k++) origins.push([net.walkIdx[k], net.walkMin[k]]);
      const disabled = opts.disabledLines || null;
      router.run(origins, { limit, goal: end, speed: this.fullSpeed, disabledLines: disabled });
      if (router.time[end] === INF) return null;
      const legs = router.legsTo(end);
      const minutes = router.time[end];
      const usedLines = [...new Set(legs.filter((x) => x.kind === 'ride').map((x) => x.line))];
      return { minutes, legs, usedLines, transfers: Math.max(0, usedLines.length - 1) };
    }

    journeyResilience(start, end) {
      const best = this.journey(start, end);
      if (!best) return null;
      const perLine = [];
      const disabled = new Uint8Array(this.net.L);
      for (const l of best.usedLines) {
        disabled[l] = 1;
        const alt = this.journey(start, end, { disabledLines: disabled, limit: Math.max(240, best.minutes * 4) });
        disabled[l] = 0;
        perLine.push({ line: l, altMinutes: alt ? alt.minutes : null, increase: alt ? (alt.minutes - best.minutes) / Math.max(1, best.minutes) : null, alt });
      }
      const worst = perLine.reduce((acc, x) => (x.increase == null ? Infinity : Math.max(acc, x.increase)), 0);
      return { best, perLine, worstIncrease: worst };
    }
  }

  return { TransitNetwork, Router, Simulator, MinHeap, INF };
}));
