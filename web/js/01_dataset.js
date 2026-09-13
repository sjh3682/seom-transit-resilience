/* =============================================================================
   01_dataset.js — 유틸리티 + Dataset
   Dataset 은 워커가 넘겨준 타입 배열을 받아, 렌더링·클릭 판정·검색에 필요한
   파생 데이터(메르카토르 좌표, 공간 인덱스, 순위)를 "한 번만" 만든다.
   ============================================================================= */
'use strict';

const Util = {
  fmt(n, digits = 0) {
    if (n == null || Number.isNaN(n)) return '—';
    return Number(n).toLocaleString('ko-KR', { maximumFractionDigits: digits, minimumFractionDigits: digits });
  },
  esc(s) {
    return String(s ?? '').replace(/[&<>'"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[m]));
  },
  normalize(s) { return String(s ?? '').toLowerCase().replace(/[\s()[\]·.\-_,/]/g, ''); },
  clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); },
  debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  },
  /** 순위(1부터) → "상위 x%" */
  topPercent(rank, total) {
    const p = rank / total * 100;
    return p < 1 ? `상위 ${p.toFixed(2)}%` : `상위 ${p.toFixed(p < 10 ? 1 : 0)}%`;
  },
  minutes(m) {
    if (m == null || !Number.isFinite(m)) return '—';
    if (m < 60) return `${Math.round(m)}분`;
    return `${Math.floor(m / 60)}시간 ${Math.round(m % 60)}분`;
  },
};

/** 웹 메르카토르: 경위도 → [0,1] 세계 좌표 */
/** 이 확대 수준부터 버스 구간을 도로 모양으로 그린다 */
const ROAD_ZOOM = 11.5;

const Mercator = {
  x(lon) { return (lon + 180) / 360; },
  y(lat) {
    const s = Math.sin(lat * Math.PI / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  },
  lon(x) { return x * 360 - 180; },
  lat(y) { const n = Math.PI - 2 * Math.PI * y; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); },
};

const INDEX_CELL = 1 / 8192;           // 공간 인덱스 칸 크기(세계 좌표) ≈ 4km

class Dataset {
  constructor(header, arrays, params) {
    this.params = params;
    this.meta = header.meta;
    this.geo = header.geo;
    this.gridSpec = header.grid;
    this.a = arrays;
    this.groupName = header.strings.group_name;
    this.lineName = header.strings.line_name;
    this.lineIds = header.strings.line_ids;
    this.regions = header.strings.regions;
    this.sigungu = header.sigungu;
    this.policy = header.policy || null;              // AI 정책 포트폴리오(p08)
    this.policyByLine = new Map();
    if (this.policy) this.policy.items.forEach((it, k) => { if (!this.policyByLine.has(it.line)) this.policyByLine.set(it.line, k); });
    this.G = arrays.g_lon.length;
    this.L = arrays.l_mode.length;
    this.P = arrays.p_line.length;
    this.S = arrays.s_a.length;
    this.N_GRID = arrays.gr_x.length;
    this.K = { line: this.meta.keys.line.length, stop: this.meta.keys.stop.length, segment: this.meta.keys.segment.length };
    this.modes = params.modes;
    this.longDistanceMode = new Uint8Array(16);
    for (const [code, m] of Object.entries(params.modes)) if (m.long_distance) this.longDistanceMode[Number(code)] = 1;

    this._projectGroups();
    this._buildLineGeometry();
    this._buildStopIndex();
    this._buildSegmentIndex();
    this._buildRegions();
    this._buildRanks();
    this._searchCache = null;
    this._groupLines = null;
    this._lineGroups = new Map();
  }

  // ---------------------------------------------------------------- 좌표
  _projectGroups() {
    const { g_lon, g_lat } = this.a;
    this.gx = new Float64Array(this.G);
    this.gy = new Float64Array(this.G);
    for (let g = 0; g < this.G; g++) { this.gx[g] = Mercator.x(g_lon[g]); this.gy[g] = Mercator.y(g_lat[g]); }
  }

  /** 운행계통마다 가장 긴 패턴을 지도용 선형으로 쓰고, 세계 좌표 bbox 를 만든다 */
  _buildLineGeometry() {
    const { p_line, p_ptr, p_stops } = this.a;
    this.mainPattern = new Int32Array(this.L).fill(-1);
    const bestLen = new Int32Array(this.L);
    for (let p = 0; p < this.P; p++) {
      const l = p_line[p], len = p_ptr[p + 1] - p_ptr[p];
      if (len > bestLen[l]) { bestLen[l] = len; this.mainPattern[l] = p; }
    }
    this.lineBox = new Float64Array(this.L * 4);
    for (let l = 0; l < this.L; l++) {
      const p = this.mainPattern[l];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = p_ptr[p]; k < p_ptr[p + 1]; k++) {
        const g = p_stops[k];
        const x = this.gx[g], y = this.gy[g];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      this.lineBox.set([x0, y0, x1, y1], l * 4);
    }
  }

  static _cellKey(x, y) { return Math.floor(x / INDEX_CELL) * 16384 + Math.floor(y / INDEX_CELL); }

  /** 정렬 기반 격자 인덱스: key → [시작, 끝) (정류장·구간 공통) */
  static _buildCellIndex(n, xAt, yAt) {
    const combined = new Float64Array(n);
    for (let i = 0; i < n; i++) combined[i] = Dataset._cellKey(xAt(i), yAt(i)) * 262144 + i;
    combined.sort();
    const order = new Int32Array(n);
    const ranges = new Map();
    let prevKey = -1, start = 0;
    for (let k = 0; k < n; k++) {
      const key = Math.floor(combined[k] / 262144);
      order[k] = combined[k] - key * 262144;
      if (key !== prevKey) {
        if (prevKey >= 0) ranges.set(prevKey, [start, k]);
        prevKey = key; start = k;
      }
    }
    if (prevKey >= 0) ranges.set(prevKey, [start, n]);
    return { order, ranges };
  }

  _buildStopIndex() {
    this.stopIndex = Dataset._buildCellIndex(this.G, (i) => this.gx[i], (i) => this.gy[i]);
  }

  _buildSegmentIndex() {
    const { s_a, s_b } = this.a;
    const mid = (i, arr) => (arr[s_a[i]] + arr[s_b[i]]) / 2;
    this.segIndex = Dataset._buildCellIndex(this.S, (i) => mid(i, this.gx), (i) => mid(i, this.gy));
    // 칸보다 긴 구간(해운·철도·항공)은 따로 모아 항상 검사
    const long = [];
    for (let i = 0; i < this.S; i++) {
      const dx = Math.abs(this.gx[s_a[i]] - this.gx[s_b[i]]), dy = Math.abs(this.gy[s_a[i]] - this.gy[s_b[i]]);
      if (dx > INDEX_CELL || dy > INDEX_CELL) long.push(i);
    }
    this.longSegments = Int32Array.from(long);
  }

  /** 세계 좌표 사각형 안에 걸치는 인덱스 칸들의 항목을 콜백으로 순회 */
  forEachInRect(index, x0, y0, x1, y1, fn) {
    const cx0 = Math.floor(x0 / INDEX_CELL), cx1 = Math.floor(x1 / INDEX_CELL);
    const cy0 = Math.floor(y0 / INDEX_CELL), cy1 = Math.floor(y1 / INDEX_CELL);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 60000) {           // 전국 축척: 모든 칸 순회가 더 싸다
      for (const [key, [s, e]] of index.ranges) {
        const cx = Math.floor(key / 16384), cy = key - cx * 16384;
        if (cx < cx0 || cx > cx1 || cy < cy0 || cy > cy1) continue;
        for (let k = s; k < e; k++) fn(index.order[k]);
      }
      return;
    }
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const r = index.ranges.get(cx * 16384 + cy);
        if (r) for (let k = r[0]; k < r[1]; k++) fn(index.order[k]);
      }
    }
  }

  // ---------------------------------------------------------------- 행정구역
  _buildRegions() {
    const byCode = new Map(this.regions.map((r, i) => [r.code, i]));
    this.regionShapes = new Array(this.regions.length).fill(null);
    for (const f of this.geo.sigungu) {
      const r = byCode.get(f.code);
      if (r == null) continue;
      const rings = f.rings.map((ring) => {
        const out = new Float64Array(ring.length * 2);
        ring.forEach(([lon, lat], i) => { out[2 * i] = Mercator.x(lon); out[2 * i + 1] = Mercator.y(lat); });
        return out;
      });
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const ring of rings) for (let i = 0; i < ring.length; i += 2) {
        x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); y0 = Math.min(y0, ring[i + 1]); y1 = Math.max(y1, ring[i + 1]);
      }
      this.regionShapes[r] = { rings, box: [x0, y0, x1, y1] };
    }
    this.sidoShapes = this.geo.sido.map((f) => f.rings.map((ring) => {
      const out = new Float64Array(ring.length * 2);
      ring.forEach(([lon, lat], i) => { out[2 * i] = Mercator.x(lon); out[2 * i + 1] = Mercator.y(lat); });
      return out;
    }));
    this.sigunguByRegion = new Map(this.sigungu.map((row) => [row.region, row]));
  }

  /** 5km 격자 칸의 세계 좌표 상자 [x0, y0, x1, y1] */
  gridBox(i) {
    const cell = this.gridSpec.cell, [olon, olat] = this.gridSpec.origin;
    const lon = olon + this.a.gr_x[i] * cell, lat = olat + this.a.gr_y[i] * cell;
    return [Mercator.x(lon), Mercator.y(lat + cell), Mercator.x(lon + cell), Mercator.y(lat)];
  }

  /** 격자 칸 안의 정류장 그룹 */
  groupsInGrid(i) {
    const [x0, y0, x1, y1] = this.gridBox(i), out = [];
    this.forEachInRect(this.stopIndex, x0, y0, x1, y1, (g) => {
      if (this.gx[g] >= x0 && this.gx[g] < x1 && this.gy[g] >= y0 && this.gy[g] < y1) out.push(g);
    });
    return out;
  }

  /** 세계 좌표에서 가장 가까운 정류장 그룹과 거리(km) */
  nearestGroup(wx, wy) {
    let best = -1, bestD = Infinity;
    for (let g = 0; g < this.G; g++) {
      const d = (this.gx[g] - wx) ** 2 + (this.gy[g] - wy) ** 2;
      if (d < bestD) { bestD = d; best = g; }
    }
    const lat = Mercator.lat ? Mercator.lat(wy) : 36;
    const km = Math.sqrt(bestD) * 40075 * Math.cos(lat * Math.PI / 180);
    return { group: best, km };
  }

  regionAt(wx, wy) {
    for (let r = 0; r < this.regionShapes.length; r++) {
      const s = this.regionShapes[r];
      if (!s || wx < s.box[0] || wx > s.box[2] || wy < s.box[1] || wy > s.box[3]) continue;
      let inside = false;
      for (const ring of s.rings) {
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
          const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
          if ((yi > wy) !== (yj > wy) && wx < (xj - xi) * (wy - yi) / (yj - yi) + xi) inside = !inside;
        }
      }
      if (inside) return r;
    }
    return -1;
  }

  // ---------------------------------------------------------------- 순위
  static _rankOf(scores) {
    const n = scores.length, order = new Int32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => scores[b] - scores[a]);
    const rank = new Int32Array(n);
    for (let k = 0; k < n; k++) rank[order[k]] = k + 1;
    return { order, rank };
  }

  _buildRanks() {
    this.initRoad();
    this.lineRank = Dataset._rankOf(this.a.l_score);
    this.stopRank = Dataset._rankOf(this.a.g_score);
    this.segRank = Dataset._rankOf(this.a.s_score);
    const sggSorted = [...this.sigungu].sort((x, y) => y.score - x.score);
    this.sigunguRank = new Map(sggSorted.map((row, i) => [row.region, i + 1]));
  }

  // ---------------------------------------------------------------- 관계(지연 생성)
  linesAtGroup(g) {
    if (!this._groupLines) {
      const { p_line, p_ptr, p_stops } = this.a;
      const sets = new Map();
      for (let p = 0; p < this.P; p++) {
        const l = p_line[p];
        for (let k = p_ptr[p]; k < p_ptr[p + 1]; k++) {
          const s = p_stops[k];
          let set = sets.get(s);
          if (!set) sets.set(s, set = new Set());
          set.add(l);
        }
      }
      this._groupLines = sets;
    }
    return [...(this._groupLines.get(g) || [])];
  }

  lineGroups(l) {
    if (!this._lineGroups.has(l)) {
      const { p_line, p_ptr, p_stops } = this.a;
      const set = new Set();
      for (let p = 0; p < this.P; p++) {
        if (p_line[p] !== l) continue;
        for (let k = p_ptr[p]; k < p_ptr[p + 1]; k++) set.add(p_stops[k]);
      }
      this._lineGroups.set(l, [...set]);
    }
    return this._lineGroups.get(l);
  }

  /** 이 계통과 정류장을 공유하는 다른 계통(공유 정류장 수 순) — "대체 수단이 있는가" */
  sharedLines(l, limit = 8) {
    const counts = new Map();
    for (const g of this.lineGroups(l)) for (const o of this.linesAtGroup(g)) if (o !== l) counts.set(o, (counts.get(o) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  patternStops(p) { return this.a.p_stops.subarray(this.a.p_ptr[p], this.a.p_ptr[p + 1]); }

  // ---------------------------------------------------------------- 표기
  regionLabel(r) { const x = this.regions[r]; return x ? `${x.sido} ${x.name}` : ''; }
  modeName(m) { return (this.modes[String(m)] || {}).name || '대중교통'; }
  isLongDistance(l) { return !!this.longDistanceMode[this.a.l_mode[l]]; }

  lineTitle(l) {
    const name = this.lineName[l];
    return name || `${this.modeName(this.a.l_mode[l])} 노선`;
  }

  /**
   * 노선이 지나는 지역. 한 시도 안이면 주된 시군구, 여러 시도를 지나면 지나는 순서대로 시도를 잇는다
   * (예: 서울1호선 → "서울·경기·충남"; 대부분 역이 있는 곳 하나만 쓰면 "충남 천안시" 로 잘못 읽힌다).
   */
  lineArea(l) {
    if (!this._lineAreaCache) this._lineAreaCache = new Map();
    if (this._lineAreaCache.has(l)) return this._lineAreaCache.get(l);
    const order = [];
    for (const g of this.patternStops(this.mainPattern[l])) {
      const sido = (this.regions[this.a.g_region[g]] || {}).sido;
      if (sido && !order.includes(sido)) order.push(sido);
    }
    let area;
    if (this.isLongDistance(l)) area = order.length > 1 ? `${order[0]} ↔ ${order[order.length - 1]}` : this.regionLabel(this.a.l_region[l]);
    else if (order.length > 1) area = order.length > 3 ? `${order.slice(0, 3).join('·')} 외` : order.join('·');
    else area = this.regionLabel(this.a.l_region[l]);
    this._lineAreaCache.set(l, area);
    return area;
  }

  lineSubtitle(l) { return `${this.modeName(this.a.l_mode[l])} · ${this.lineArea(l)}`; }

  /** 제목에 지역을 붙인 한 줄 표기 (예: "122 · 인천 옹진군", "서울1호선 · 서울·경기·충남") */
  lineLabel(l) { return `${this.lineTitle(l)} · ${this.isLongDistance(l) ? this.modeName(this.a.l_mode[l]) : this.lineArea(l)}`; }

  /**
   * 위험 성격: 같은 '매우 취약'이라도 섬 항로(끊기면 고립)와 도시철도(끊기면 지연)는 다르다.
   * 고립 = 표본 이동 중 단절 비중 또는 대체경로 부족이 30% 이상, 지연 = 이동시간 증가 20% 이상.
   */
  // ------------------------------------------------------------ 도로 선형(표준노드링크로 이은 버스 구간)
  initRoad() {
    const a = this.a;
    this.hasRoad = !!(a.rd_ptr && a.rd_ptr.length > 1);
    if (!this.hasRoad) return;
    const n = a.rd_a.length, ptr = a.rd_ptr, dx = a.rd_x, dy = a.rd_y;
    this.rx = new Float64Array(ptr[n]); this.ry = new Float64Array(ptr[n]);
    for (let i = 0; i < n; i++) {
      let x = 0, y = 0;
      for (let k = ptr[i]; k < ptr[i + 1]; k++) {
        if (k === ptr[i]) { x = dx[k]; y = dy[k]; } else { x += dx[k]; y += dy[k]; }
        this.rx[k] = Mercator.x(x / 1e6); this.ry[k] = Mercator.y(y / 1e6);
      }
    }
    this.roadIndex = new Map();
    for (let i = 0; i < n; i++) this.roadIndex.set(a.rd_a[i] * 262144 + a.rd_b[i], i);
  }

  /** 확대했을 때만 도로 모양으로 그린다(전국·광역 축척은 직선 — 차이가 안 보이고 가볍다) */
  useRoad(v) { return this.hasRoad && v.z >= Dataset.ROAD_Z; }

  roadShape(g0, g1) {
    if (!this.hasRoad) return -1;
    const i = this.roadIndex.get(g0 < g1 ? g0 * 262144 + g1 : g1 * 262144 + g0);
    return i === undefined ? -1 : i;
  }

  /** 정류장 g0 → g1 사이 선의 화면 좌표를 cb(x, y) 로 넘긴다(g0 제외, g1 포함). 도로 모양이 있으면 도로를 따라. */
  edgePoints(g0, g1, v, cb, road = this.useRoad(v)) {
    const hw = v.w / 2, hh = v.h / 2, S = v.S;
    if (road) {
      const i = this.roadShape(g0, g1);
      if (i >= 0) {
        const p0 = this.a.rd_ptr[i], p1 = this.a.rd_ptr[i + 1], rx = this.rx, ry = this.ry;
        if (g0 < g1) for (let k = p0; k < p1; k++) cb((rx[k] - v.cx) * S + hw, (ry[k] - v.cy) * S + hh);
        else for (let k = p1 - 1; k >= p0; k--) cb((rx[k] - v.cx) * S + hw, (ry[k] - v.cy) * S + hh);
      }
    }
    cb((this.gx[g1] - v.cx) * S + hw, (this.gy[g1] - v.cy) * S + hh);
  }

  /** 정류장 목록을 따라 경로(ctx 또는 Path2D)에 선을 넣는다 */
  traceStops(path, stops, v) {
    if (!stops.length) return;
    const g = stops[0], road = this.useRoad(v);
    path.moveTo((this.gx[g] - v.cx) * v.S + v.w / 2, (this.gy[g] - v.cy) * v.S + v.h / 2);
    for (let k = 1; k < stops.length; k++) this.edgePoints(stops[k - 1], stops[k], v, (x, y) => path.lineTo(x, y), road);
  }

  /** 화면 점 (sx, sy) 에서 정류장 목록을 따라 그린 선까지의 최소 거리(클릭 판정용) */
  distanceToStops(stops, v, sx, sy) {
    if (stops.length < 1) return Infinity;
    let best = Infinity, px = (this.gx[stops[0]] - v.cx) * v.S + v.w / 2, py = (this.gy[stops[0]] - v.cy) * v.S + v.h / 2;
    const road = this.useRoad(v);
    for (let k = 1; k < stops.length; k++) {
      this.edgePoints(stops[k - 1], stops[k], v, (x, y) => { best = Math.min(best, segDist(sx, sy, px, py, x, y)); px = x; py = y; }, road);
    }
    return best;
  }

  lineNature(l) {
    const c = this.comp('line', l), keys = this.meta.keys.line;
    const get = (k) => c[keys.indexOf(k)] || 0;
    const disc = this.a.l_pairs[l] ? this.a.l_disc[l] / this.a.l_pairs[l] : 0;
    if (disc >= 0.3 || get('no_alternative') >= 0.3) return { key: 'isolate', label: '끊기면 고립', hint: '대체 경로가 없어 이동 자체가 끊기는 정류장·구간이 있습니다' };
    if (get('time_increase') >= 0.2) return { key: 'delay', label: '끊기면 지연', hint: '돌아갈 길은 있지만 이동시간이 크게 늘어납니다' };
    return { key: 'spread', label: '영향 분산', hint: '대체 수단이 있어 영향이 작습니다' };
  }

  comp(kind, i) {
    const arr = kind === 'line' ? this.a.l_comp : kind === 'stop' ? this.a.g_comp : this.a.s_comp;
    const K = this.K[kind];
    return Array.from(arr.subarray(i * K, i * K + K));
  }

  /** SHAP 상위 요인 3개: [{ name, points, value, unit, median }] */
  drivers(kind, i) {
    const pre = kind === 'line' ? 'l_top_' : 'g_top_';
    const f = this.a[pre + 'f'], v = this.a[pre + 'v'], x = this.a[pre + 'x'];
    if (!f) return [];
    const fm = kind === 'line' ? this.meta.line_features : this.meta.stop_features;
    const out = [];
    for (let k = 0; k < 3; k++) {
      const idx = f[i * 3 + k];
      out.push({ name: fm.names[idx], points: v[i * 3 + k], value: x ? x[i * 3 + k] : null, unit: fm.units[idx], median: fm.medians[idx] });
    }
    return out;
  }

  /** 정책 시뮬레이션 후 점수를 다시 매길 때 쓰는 노선 TVS 계산(파이프라인과 같은 공식) */
  lineTvs(components, affected) {
    const q = this.meta.affected_log_quantiles;
    const v = Math.log1p(affected);
    let lo = 0;
    while (lo < q.length - 1 && q[lo + 1] <= v) lo++;
    const pct = lo >= q.length - 1 ? 1 : lo / (q.length - 1) + (v - q[lo]) / Math.max(1e-9, q[lo + 1] - q[lo]) / (q.length - 1);
    const w = this.params.tvs.route_weights;
    const c = { ...components, affected_population: Util.clamp(pct, 0, 1) };
    const total = Object.values(w).reduce((x, y) => x + y, 0);
    return 100 * Object.entries(w).reduce((acc, [k, wk]) => acc + (c[k] || 0) * wk, 0) / total;
  }

  stopTvs(components) {
    const w = this.meta.stop_weights_effective;
    const total = Object.values(w).reduce((x, y) => x + y, 0);
    return 100 * Object.entries(w).reduce((acc, [k, wk]) => acc + (components[k] || 0) * wk, 0) / total;
  }


  // ---------------------------------------------------------------- 검색
  _ensureSearch() {
    if (this._searchCache) return this._searchCache;
    this._searchCache = {
      group: this.groupName.map(Util.normalize),
      line: this.lineName.map((n, l) => Util.normalize(`${n} ${this.lineIds[l]}`)),
      region: this.regions.map((r) => Util.normalize(`${r.sido}${r.name}`)),
    };
    return this._searchCache;
  }

  /**
   * 정류장·노선·시군구 통합 검색. 정확 일치 > 앞부분 일치 > 부분 일치 순,
   * 같은 순위 안에서는 노선 수(정류장)·운행횟수(노선)가 큰 것을 먼저 보여준다.
   */
  search(query, { kinds = ['stop', 'line', 'region'], limit = 12 } = {}) {
    const q = Util.normalize(query);
    if (!q) return [];
    const cache = this._ensureSearch();
    const out = [];
    const rankText = (text) => (text === q ? 0 : text.startsWith(q) ? 1 : text.includes(q) ? 2 : -1);
    if (kinds.includes('region')) {
      cache.region.forEach((t, r) => {
        const k = rankText(t);
        if (k >= 0 || Util.normalize(this.regions[r].name).startsWith(q)) out.push({ kind: 'region', id: r, rank: Math.max(0, k), weight: 1e6 });
      });
    }
    if (kinds.includes('stop')) {
      const nl = this.a.g_nlines;
      for (let g = 0; g < this.G; g++) {
        const k = rankText(cache.group[g]);
        if (k >= 0) out.push({ kind: 'stop', id: g, rank: k, weight: nl[g] + (this.a.g_dest[g] > 0 ? 50 : 0) });
      }
    }
    if (kinds.includes('line')) {
      for (let l = 0; l < this.L; l++) {
        const k = rankText(cache.line[l]);
        if (k >= 0) out.push({ kind: 'line', id: l, rank: k, weight: this.a.l_trips[l] });
      }
    }
    out.sort((x, y) => x.rank - y.rank || y.weight - x.weight);
    return out.slice(0, limit);
  }
}
Dataset.ROAD_Z = ROAD_ZOOM;
