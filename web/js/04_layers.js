/* =============================================================================
   04_layers.js — 분석 레이어
   각 레이어가 자기 그리기(draw)와 클릭 판정(hitTest)을 함께 가진다.
   공통 규칙
     - 등급별로 Path2D 하나에 모아 한 번에 stroke/fill (프레임당 호출 수 고정)
     - 축척에 따라 보여줄 양 조절(LOD): 전국 축척은 취약·매우 취약 위주, 확대할수록 전체
     - 클릭 판정은 마지막으로 그린 항목만 대상으로(안 보이는 항목이 잡히지 않음)
   ============================================================================= */
'use strict';

const Style = {
  colors: null, shapes: null, names: null,
  // 선 모양: 안정·주의는 실선, 취약은 파선, 매우 취약은 점선(색약 대비). 주의까지 파선으로 그리면
  // 도심(노선 수백 개)에서 픽셀 칠하기가 약 2배 느려져, 소수인 취약·매우 취약만 모양으로 구분한다.
  dash: [[], [], [10, 3, 2, 3], [2.5, 3]],
  gapColor: '#9aa4b1',
  seniorColor: '#7b3fe4',
  init(params) { this.colors = params.grades.colors; this.shapes = params.grades.shapes; this.names = params.grades.names; },
};

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function viewRect(v, marginPx = 24) {
  return [v.cx - (v.w / 2 + marginPx) / v.S, v.cy - (v.h / 2 + marginPx) / v.S, v.cx + (v.w / 2 + marginPx) / v.S, v.cy + (v.h / 2 + marginPx) / v.S];
}

// -----------------------------------------------------------------------------
class RegionLayer {
  constructor(ds) {
    this.ds = ds;
    this.submode = 'sigungu';                 // 'sigungu' | 'grid'
    this.gridByKey = new Map();
    const a = ds.a;
    for (let i = 0; i < ds.N_GRID; i++) this.gridByKey.set(a.gr_x[i] * 1000 + a.gr_y[i], i);
    this._hatch = null;
  }

  _hatchPattern(ctx) {
    if (this._hatch) return this._hatch;
    const c = document.createElement('canvas'); c.width = c.height = 8;
    const x = c.getContext('2d');
    x.strokeStyle = Style.gapColor; x.lineWidth = 1.4;
    x.beginPath(); x.moveTo(0, 8); x.lineTo(8, 0); x.stroke();
    this._hatch = ctx.createPattern(c, 'repeat');
    return this._hatch;
  }

  _ringPath(path, ring, v) { addRing(path, ring, v); }

  draw(ctx, v, st) {
    const ds = this.ds;
    let count = 0;
    if (this.submode === 'sigungu') {
      const fills = [0, 1, 2, 3].map(() => new Path2D());
      const outline = new Path2D();
      const [x0, y0, x1, y1] = viewRect(v);
      for (const row of ds.sigungu) {
        const shape = ds.regionShapes[row.region];
        if (!shape || !st.riskOn[row.grade]) continue;
        const b = shape.box;
        if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
        for (const ring of shape.rings) { this._ringPath(fills[row.grade], ring, v); this._ringPath(outline, ring, v); }
        count++;
      }
      ctx.save();
      // 매우 취약(검정)은 진하게 — 옅으면 '데이터 없음' 회색처럼 보인다
      for (let g = 0; g < 4; g++) { ctx.globalAlpha = g === 3 ? 0.86 : 0.55; ctx.fillStyle = Style.colors[g]; ctx.fill(fills[g], 'evenodd'); }
      ctx.globalAlpha = 0.9; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 0.8; ctx.stroke(outline);
      ctx.restore();
    } else {
      const a = ds.a, cell = ds.gridSpec.cell, [olon, olat] = ds.gridSpec.origin;
      const fills = [0, 1, 2, 3].map(() => new Path2D());
      const gaps = new Path2D();
      const [x0, y0, x1, y1] = viewRect(v);
      for (let i = 0; i < ds.N_GRID; i++) {
        const grade = a.gr_grade[i];
        if (grade < 4 && !st.riskOn[grade]) continue;
        if (grade === 4 && !st.showGaps) continue;
        const lon = olon + a.gr_x[i] * cell, lat = olat + a.gr_y[i] * cell;
        const wx0 = Mercator.x(lon), wx1 = Mercator.x(lon + cell), wy0 = Mercator.y(lat + cell), wy1 = Mercator.y(lat);
        if (wx1 < x0 || wx0 > x1 || wy1 < y0 || wy0 > y1) continue;
        const sx = (wx0 - v.cx) * v.S + v.w / 2, sy = (wy0 - v.cy) * v.S + v.h / 2;
        const w = (wx1 - wx0) * v.S, h = (wy1 - wy0) * v.S;
        (grade === 4 ? gaps : fills[grade]).rect(sx, sy, w + 0.6, h + 0.6);
        count++;
      }
      ctx.save();
      for (let g = 0; g < 4; g++) { ctx.globalAlpha = g === 3 ? 0.75 : 0.6; ctx.fillStyle = Style.colors[g]; ctx.fill(fills[g]); }
      ctx.globalAlpha = 0.9; ctx.fillStyle = this._hatchPattern(ctx); ctx.fill(gaps);
      ctx.restore();
    }
    return count;
  }

  hitTest(v, sx, sy) {
    const [wx, wy] = [v.cx + (sx - v.w / 2) / v.S, v.cy + (sy - v.h / 2) / v.S];
    if (this.submode === 'sigungu') {
      const r = this.ds.regionAt(wx, wy);
      return r >= 0 && this.ds.sigunguByRegion.has(r) ? [{ kind: 'region', id: r, d: 0 }] : [];
    }
    const cell = this.ds.gridSpec.cell, [olon, olat] = this.ds.gridSpec.origin;
    const gx = Math.floor((Mercator.lon(wx) - olon) / cell), gy = Math.floor((Mercator.lat(wy) - olat) / cell);
    const i = this.gridByKey.get(gx * 1000 + gy);
    return i == null ? [] : [{ kind: 'grid', id: i, d: 0 }];
  }

  /** 고령 비율이 기준(config display.senior_highlight_pct, 기본 40%) 이상인 시군구 윤곽선(모든 레이어 위에 겹쳐 그림) */
  drawSenior(ctx, v) {
    const path = new Path2D();
    const [x0, y0, x1, y1] = viewRect(v);
    for (const row of this.ds.sigungu) {
      if (!(row.senior >= this.ds.seniorHighlightPct)) continue;
      const shape = this.ds.regionShapes[row.region];
      if (!shape) continue;
      const b = shape.box;
      if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
      for (const ring of shape.rings) this._ringPath(path, ring, v);
    }
    ctx.save();
    ctx.strokeStyle = Style.seniorColor; ctx.lineWidth = 2; ctx.setLineDash([5, 3]); ctx.globalAlpha = 0.85;
    ctx.stroke(path);
    ctx.restore();
  }
}

// -----------------------------------------------------------------------------
class LineLayer {
  constructor(ds) { this.ds = ds; this.drawn = new Int32Array(ds.L); this.nDrawn = 0; this.minGrade = 0; }

  minGradeFor(v, st) { return !st.lod ? 0 : v.z < 8 ? 2 : v.z < 9.5 ? 1 : 0; }   // 전국: 취약 이상, 광역: 주의 이상

  draw(ctx, v, st) {
    const ds = this.ds, a = ds.a, gx = ds.gx, gy = ds.gy;
    const [x0, y0, x1, y1] = viewRect(v);
    const minGrade = this.minGrade = this.minGradeFor(v, st);
    const hw = v.w / 2, hh = v.h / 2, S = v.S;
    this.nDrawn = 0;
    // 노선마다 선을 긋지 않고, 같은 정류장 쌍 구간은 가장 높은 등급(동률이면 지역 노선)으로 한 번만 긋는다.
    // 수도권처럼 한 도로에 노선 수백 개가 겹치면 겹친 윤곽을 모두 칠하느라 전체화면에서 1초 넘게 걸렸다(→ 약 3분의 1).
    // 겹친 곳은 원래도 맨 위(가장 높은 등급) 색만 보이므로 모양은 같다.
    const best = new Map();
    for (let l = 0; l < ds.L; l++) {
      const grade = a.l_grade[l];
      if (!st.riskOn[grade] || !st.modeOn[a.l_mode[l]]) continue;
      const b = l * 4, box = ds.lineBox;
      if (box[b + 2] < x0 || box[b] > x1 || box[b + 3] < y0 || box[b + 1] > y1) continue;
      if ((box[b + 2] - box[b]) * S < 1.2 && (box[b + 3] - box[b + 1]) * S < 1.2) continue;   // 1px 미만은 생략
      if (grade < minGrade) continue;            // 축척별 간소화(전국·광역 축척은 높은 등급만)
      const cls = grade + (ds.longDistanceMode[a.l_mode[l]] ? 4 : 0);
      const p = ds.mainPattern[l];
      for (let k = a.p_ptr[p], end = a.p_ptr[p + 1] - 1; k < end; k++) {
        const g0 = a.p_stops[k], g1 = a.p_stops[k + 1];
        const key = g0 < g1 ? g0 * 262144 + g1 : g1 * 262144 + g0;
        const cur = best.get(key);
        if (cur === undefined || (cur & 3) < grade || ((cur & 3) === grade && cur > cls)) best.set(key, cls);
      }
      this.drawn[this.nDrawn++] = l;
    }
    const paths = [0, 1, 2, 3, 4, 5, 6, 7].map(() => new Path2D());   // 0~3 지역, 4~7 장거리
    // 1.5px 보다 짧은 구간은 2px 칸마다 등급별 점 하나로
    const CELL = 2, cw = Math.ceil(v.w / CELL) + 2, occ = new Uint8Array(cw * (Math.ceil(v.h / CELL) + 2));
    // 구간을 하나씩 긋지 않고, 노선을 따라가며 그 노선이 맡은(가장 높은 등급인) 구간이 이어지면 한 줄로 긋는다(선 조각 수 ↓)
    const tol = v.z < 11 ? 1 : 0.6;
    const road = ds.useRoad(v), M = road ? 150 : 20;          // 도로 모양은 직선 밖으로 휘므로 화면 밖 판정에 여유
    for (let i = 0; i < this.nDrawn; i++) {
      const l = this.drawn[i];
      const cls = a.l_grade[l] + (ds.longDistanceMode[a.l_mode[l]] ? 4 : 0);
      const path = paths[cls], p = ds.mainPattern[l];
      let open = false, px = 0, py = 0;
      for (let k = a.p_ptr[p], end = a.p_ptr[p + 1] - 1; k < end; k++) {
        const g0 = a.p_stops[k], g1 = a.p_stops[k + 1];
        const key = g0 < g1 ? g0 * 262144 + g1 : g1 * 262144 + g0;
        if (best.get(key) !== cls) { open = false; continue; }      // 다른 노선이 맡았거나 이미 그음
        best.set(key, -1);
        const ax = (gx[g0] - v.cx) * S + hw, ay = (gy[g0] - v.cy) * S + hh;
        const bx = (gx[g1] - v.cx) * S + hw, by = (gy[g1] - v.cy) * S + hh;
        if (Math.max(ax, bx) < -M || Math.min(ax, bx) > v.w + M || Math.max(ay, by) < -M || Math.min(ay, by) > v.h + M) { open = false; continue; }
        const dx = bx - ax, dy = by - ay;
        if (!open && dx * dx + dy * dy < 2.25) {
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          if (mx >= 0 && my >= 0 && mx < v.w && my < v.h) {
            const c = Math.floor(my / CELL) * cw + Math.floor(mx / CELL);
            if (occ[c] < (cls & 3) + 1) occ[c] = (cls & 3) + 1;
          }
          continue;
        }
        if (!open) { path.moveTo(ax, ay); px = ax; py = ay; open = true; }
        if (road && ds.roadShape(g0, g1) >= 0) {                  // 확대하면 도로를 따라
          // 도로 선형은 점이 많아 1.5px 안의 점은 건너뛴다(도심 줌 13 에서 그리기 시간 ↓, 화면 차이 없음)
          ds.edgePoints(g0, g1, v, (x, y) => { if (Math.abs(x - px) >= 1.5 || Math.abs(y - py) >= 1.5) { path.lineTo(x, y); px = x; py = y; } }, true);
          if (px !== bx || py !== by) { path.lineTo(bx, by); px = bx; py = by; }
        } else if (Math.abs(bx - px) >= tol || Math.abs(by - py) >= tol || k === end - 1) { path.lineTo(bx, by); px = bx; py = by; }
      }
    }
    const dots = [0, 1, 2, 3].map(() => new Path2D());
    for (let c = 0; c < occ.length; c++) {
      if (!occ[c]) continue;
      const g = occ[c] - 1, size = [1.2, 1.6, 2.3, 2.8][g];
      dots[g].rect((c % cw) * CELL + (CELL - size) / 2, Math.floor(c / cw) * CELL + (CELL - size) / 2, size, size);
    }
    ctx.save();
    const bump = v.z > 11 ? 0.8 : 0;
    for (let g = 0; g < 4; g++) {
      ctx.globalAlpha = [0.5, 0.72, 0.88, 0.95][g]; ctx.fillStyle = Style.colors[g];
      ctx.fill(dots[g]);
    }
    for (let g = 0; g < 4; g++) {
      // 이어 그은 선의 꺾임은 둥글게, 끝은 확대 시 둥글게. 점선·파선은 끝을 각지게(틈 유지)
      ctx.lineJoin = 'bevel';     // 선이 2~3px 라 둥근 이음과 구분되지 않고, 도로 모양은 꺾임이 많아 둥근 이음 계산이 무겁다
      ctx.lineCap = Style.dash[g].length || v.z < 11 ? 'butt' : 'round';
      for (const long of [1, 0]) {
        ctx.setLineDash(Style.dash[g]);
        ctx.strokeStyle = Style.colors[g];
        ctx.globalAlpha = long ? 0.5 : [0.5, 0.72, 0.88, 0.95][g];
        ctx.lineWidth = long ? 1.1 : [1.2, 1.6, 2.3, 2.8][g] + bump;
        ctx.stroke(paths[g + (long ? 4 : 0)]);
      }
    }
    ctx.restore();
    return this.nDrawn;
  }

  /** 화면 좌표 근처 노선 후보(가까운 순) */
  hitTest(v, sx, sy, tol = 7) {
    const ds = this.ds, a = ds.a;
    const wx = v.cx + (sx - v.w / 2) / v.S, wy = v.cy + (sy - v.h / 2) / v.S, tw = tol / v.S;
    const out = [];
    for (let i = 0; i < this.nDrawn; i++) {
      const l = this.drawn[i], b = l * 4, box = ds.lineBox;
      if (wx < box[b] - tw || wx > box[b + 2] + tw || wy < box[b + 1] - tw || wy > box[b + 3] + tw) continue;
      const d = this.distance(v, l, sx, sy);
      if (d <= tol) out.push({ kind: 'line', id: l, d });
    }
    return out.sort((x, y) => x.d - y.d || a.l_score[y.id] - a.l_score[x.id]);
  }

  distance(v, l, sx, sy) {
    return this.ds.distanceToStops(this.ds.patternStops(this.ds.mainPattern[l]), v, sx, sy);
  }

  /** 오버레이 강조: 흰 테두리 + 원래 위험색 유지 */
  highlight(ctx, v, l, { width = 4.5, color = null, halo = true } = {}) {
    const ds = this.ds, a = ds.a;
    const path = new Path2D();
    ds.traceStops(path, ds.patternStops(ds.mainPattern[l]), v);
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([]);
    if (halo) { ctx.strokeStyle = '#fff'; ctx.lineWidth = width + 4; ctx.stroke(path); }
    ctx.strokeStyle = color || Style.colors[a.l_grade[l]]; ctx.lineWidth = width; ctx.stroke(path);
    ctx.restore();
  }
}

// -----------------------------------------------------------------------------
/**
 * 다각형 고리(행정경계)를 경로에 추가. 2025 경계는 섬이 많아 고리가 수천 개라 두 가지를 지킨다.
 *   - closePath 대신 시작점으로 lineTo (Skia 에서 closePath 가 쌓일수록 느려진다)
 *   - 화면에서 0.7px 보다 가까운 꼭짓점은 건너뜀 (전국 축척에서는 꼭짓점 대부분이 한 점에 겹친다)
 */
function addRing(path, ring, v, minPx = 0.7) {
  const hw = v.w / 2, hh = v.h / 2, S = v.S;
  const x0 = (ring[0] - v.cx) * S + hw, y0 = (ring[1] - v.cy) * S + hh;
  path.moveTo(x0, y0);
  let px = x0, py = y0;
  for (let i = 2; i < ring.length; i += 2) {
    const x = (ring[i] - v.cx) * S + hw, y = (ring[i + 1] - v.cy) * S + hh;
    if (Math.abs(x - px) < minPx && Math.abs(y - py) < minPx) continue;
    path.lineTo(x, y); px = x; py = y;
  }
  path.lineTo(x0, y0);
}

/**
 * 등급별 모양(색약 대비: ● ◆ ▲ ■). 수만 개를 한 Path2D 에 담으므로 closePath 는 쓰지 않는다
 * — Skia 에서 도형이 쌓일수록 closePath 가 느려져 렌더가 250ms 까지 늘었다. fill 은 하위 경로를
 * 자동으로 닫고, 테두리용으로 시작점까지 lineTo 로 되돌아간다.
 */
function addShape(path, x, y, grade, r) {
  if (grade === 0) { path.moveTo(x + r, y); path.arc(x, y, r, 0, Math.PI * 2); }
  else if (grade === 1) { path.moveTo(x, y - r); path.lineTo(x + r, y); path.lineTo(x, y + r); path.lineTo(x - r, y); path.lineTo(x, y - r); }
  else if (grade === 2) { path.moveTo(x, y - r * 1.1); path.lineTo(x + r, y + r * 0.8); path.lineTo(x - r, y + r * 0.8); path.lineTo(x, y - r * 1.1); }
  else path.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
}

class StopLayer {
  constructor(ds) { this.ds = ds; this.drawn = new Int32Array(ds.G); this.nDrawn = 0; this.minGrade = 0; }

  /** 전국 축척은 매우 취약(상위 5%)만 색으로, 확대할수록 낮은 등급까지 — 숨긴 등급은 회색 바탕점 */
  minGradeFor(v, st) { return !st.lod ? 0 : v.z < 7.8 ? 3 : v.z < 9 ? 2 : v.z < 10.5 ? 1 : 0; }

  /**
   * 화면 3px 칸마다 가장 높은 등급 정류장 하나만 그린다. 전국·광역 축척에서 수만 개가
   * 겹쳐 그려지던 비용(v6 렉의 원인 중 하나)을 없애고, 겹친 점의 색도 가장 위험한 쪽을 보여준다.
   */
  draw(ctx, v, st) {
    const ds = this.ds, a = ds.a;
    const [x0, y0, x1, y1] = viewRect(v, 8);
    const minGrade = this.minGrade = this.minGradeFor(v, st);
    const CELL = v.z >= 12 ? 1 : v.z < 8 ? 5 : 3;      // 전국 축척은 칸을 넓혀 점 수를 줄인다
    const cw = Math.ceil((v.w + 16) / CELL) + 1, ch = Math.ceil((v.h + 16) / CELL) + 1;
    if (!this._occ || this._occ.length < cw * ch) this._occ = new Int32Array(cw * ch);
    const occ = this._occ;
    occ.fill(-1, 0, cw * ch);
    if (!this._ctxOcc || this._ctxOcc.length < cw * ch) this._ctxOcc = new Uint8Array(cw * ch);
    const ctxOcc = this._ctxOcc;       // 축척별 간소화로 숨긴 낮은 등급이 있는 칸(회색 바탕점)
    ctxOcc.fill(0, 0, cw * ch);
    ds.forEachInRect(ds.stopIndex, x0, y0, x1, y1, (g) => {
      const grade = a.g_grade[g];
      if (!st.riskOn[grade] || !(a.g_modes[g] & st.modeMask)) return;
      const x = (ds.gx[g] - v.cx) * v.S + v.w / 2, y = (ds.gy[g] - v.cy) * v.S + v.h / 2;
      const c = Math.floor((x + 8) / CELL) + Math.floor((y + 8) / CELL) * cw;
      if (c < 0 || c >= cw * ch) return;
      if (grade < minGrade) { ctxOcc[c] = 1; return; }
      const prev = occ[c];
      if (prev < 0 || a.g_grade[prev] < grade || (a.g_grade[prev] === grade && a.g_score[prev] < a.g_score[g])) occ[c] = g;
    });
    const paths = [0, 1, 2, 3].map(() => new Path2D());
    const context = new Path2D();
    if (minGrade > 0) {
      for (let c = 0; c < cw * ch; c++) {
        if (!ctxOcc[c] || occ[c] >= 0) continue;
        context.rect((c % cw) * CELL - 8, Math.floor(c / cw) * CELL - 8, 2, 2);
      }
    }
    const r0 = v.z >= 13 ? 1.2 : v.z < 8 ? -2.6 : v.z < 10.5 ? -0.7 : 0;   // 전국 축척: 작은 점으로(덩어리지지 않게)
    const radius = [2.8 + r0, 3.2 + r0, 3.8 + r0, 4.4 + r0];
    this.nDrawn = 0;
    for (let c = 0; c < cw * ch; c++) {
      const g = occ[c];
      if (g < 0) continue;
      const grade = a.g_grade[g];
      addShape(paths[grade], (ds.gx[g] - v.cx) * v.S + v.w / 2, (ds.gy[g] - v.cy) * v.S + v.h / 2, grade, radius[grade]);
      this.drawn[this.nDrawn++] = g;
    }
    ctx.save();
    if (minGrade > 0) { ctx.globalAlpha = 0.6; ctx.fillStyle = '#a3adbb'; ctx.fill(context); }
    for (let g = 0; g < 4; g++) {
      ctx.globalAlpha = 0.9; ctx.fillStyle = Style.colors[g]; ctx.fill(paths[g]);
      if (v.z >= 9) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.8; ctx.stroke(paths[g]); }
    }
    ctx.restore();
    return this.nDrawn;
  }

  hitTest(v, sx, sy, tol = 9) {
    const ds = this.ds, out = [];
    for (let i = 0; i < this.nDrawn; i++) {
      const g = this.drawn[i];
      const d = Math.hypot((ds.gx[g] - v.cx) * v.S + v.w / 2 - sx, (ds.gy[g] - v.cy) * v.S + v.h / 2 - sy);
      if (d <= tol) out.push({ kind: 'stop', id: g, d });
    }
    return out.sort((x, y) => x.d - y.d);
  }

  highlight(ctx, v, g, color = '#1747c8') {
    const ds = this.ds;
    const x = (ds.gx[g] - v.cx) * v.S + v.w / 2, y = (ds.gy[g] - v.cy) * v.S + v.h / 2;
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.lineWidth = 5; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.lineWidth = 2.5; ctx.strokeStyle = color; ctx.stroke();
    ctx.restore();
  }
}

// -----------------------------------------------------------------------------
class SegmentLayer {
  constructor(ds) { this.ds = ds; this.drawn = new Int32Array(ds.S); this.nDrawn = 0; this.minGrade = 0; }

  minGradeFor(v, st) { return !st.lod ? 0 : v.z < 8 ? 2 : v.z < 10 ? 1 : 0; }

  draw(ctx, v, st) {
    const ds = this.ds, a = ds.a;
    const [x0, y0, x1, y1] = viewRect(v);
    const minGrade = this.minGrade = this.minGradeFor(v, st);
    const paths = [0, 1, 2, 3].map(() => new Path2D());
    this.nDrawn = 0;
    // 1.5px 보다 짧은 구간(전국 축척에서 83%)은 선을 긋지 않고 2px 칸마다 등급별 점 하나로 — 모양은 같고 그리는 양은 수십 분의 1
    const CELL = 2, cw = Math.ceil(v.w / CELL) + 2, occ = new Uint8Array(cw * (Math.ceil(v.h / CELL) + 2));
    const road = ds.useRoad(v), M = road ? 150 : 20;
    const visit = (i) => {
      const grade = a.s_grade[i];
      if (grade < minGrade || !st.riskOn[grade]) return;
      const ga = a.s_a[i], gb = a.s_b[i];
      if (!(a.g_modes[ga] & a.g_modes[gb] & st.modeMask)) return;
      const ax = (ds.gx[ga] - v.cx) * v.S + v.w / 2, ay = (ds.gy[ga] - v.cy) * v.S + v.h / 2;
      const bx = (ds.gx[gb] - v.cx) * v.S + v.w / 2, by = (ds.gy[gb] - v.cy) * v.S + v.h / 2;
      if (Math.max(ax, bx) < -M || Math.min(ax, bx) > v.w + M || Math.max(ay, by) < -M || Math.min(ay, by) > v.h + M) return;
      this.drawn[this.nDrawn++] = i;
      const dx = bx - ax, dy = by - ay;
      if (dx * dx + dy * dy < 2.25) {
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        if (mx < 0 || my < 0 || mx >= v.w || my >= v.h) return;
        const c = Math.floor(my / CELL) * cw + Math.floor(mx / CELL);
        if (occ[c] < grade + 1) occ[c] = grade + 1;          // 한 칸에는 가장 높은 등급만
        return;
      }
      const path = paths[grade];
      path.moveTo(ax, ay);
      if (road) {
        let qx = ax, qy = ay;
        ds.edgePoints(ga, gb, v, (x, y) => { if (Math.abs(x - qx) >= 1.5 || Math.abs(y - qy) >= 1.5) { path.lineTo(x, y); qx = x; qy = y; } }, true);
        if (qx !== bx || qy !== by) path.lineTo(bx, by);
      } else path.lineTo(bx, by);
    };
    ds.forEachInRect(ds.segIndex, x0, y0, x1, y1, visit);
    for (const i of ds.longSegments) {
      const ga = a.s_a[i], gb = a.s_b[i];
      const mx = (ds.gx[ga] + ds.gx[gb]) / 2, my = (ds.gy[ga] + ds.gy[gb]) / 2;
      if (Math.floor(mx / INDEX_CELL) >= Math.floor(x0 / INDEX_CELL) && Math.floor(mx / INDEX_CELL) <= Math.floor(x1 / INDEX_CELL)
        && Math.floor(my / INDEX_CELL) >= Math.floor(y0 / INDEX_CELL) && Math.floor(my / INDEX_CELL) <= Math.floor(y1 / INDEX_CELL)) continue; // 이미 방문
      visit(i);
    }
    const dots = [0, 1, 2, 3].map(() => new Path2D());
    for (let c = 0; c < occ.length; c++) {
      if (!occ[c]) continue;
      const g = occ[c] - 1, size = [1.2, 1.7, 2.4, 3][g];
      dots[g].rect((c % cw) * CELL + (CELL - size) / 2, Math.floor(c / cw) * CELL + (CELL - size) / 2, size, size);
    }
    ctx.save();
    ctx.lineCap = 'round';
    for (let g = 0; g < 4; g++) {
      ctx.globalAlpha = [0.5, 0.7, 0.88, 0.95][g]; ctx.fillStyle = Style.colors[g];
      ctx.fill(dots[g]);
    }
    for (let g = 0; g < 4; g++) {
      ctx.setLineDash(Style.dash[g]); ctx.strokeStyle = Style.colors[g];
      ctx.globalAlpha = [0.5, 0.7, 0.88, 0.95][g]; ctx.lineWidth = [1.2, 1.7, 2.4, 3][g] + (v.z > 11 ? 0.8 : 0);
      ctx.stroke(paths[g]);
    }
    ctx.restore();
    return this.nDrawn;
  }

  hitTest(v, sx, sy, tol = 7) {
    const ds = this.ds, a = ds.a, out = [];
    for (let i = 0; i < this.nDrawn; i++) {
      const s = this.drawn[i];
      const d = ds.distanceToStops([a.s_a[s], a.s_b[s]], v, sx, sy);
      if (d <= tol) out.push({ kind: 'segment', id: s, d });
    }
    return out.sort((x, y) => x.d - y.d);
  }

  highlight(ctx, v, s) {
    const ds = this.ds, a = ds.a, ga = a.s_a[s], gb = a.s_b[s];
    ctx.save();
    ctx.lineCap = 'round';
    ctx.beginPath();
    ds.traceStops(ctx, [ga, gb], v);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 9; ctx.stroke();
    ctx.strokeStyle = Style.colors[a.s_grade[s]]; ctx.lineWidth = 5; ctx.stroke();
    ctx.restore();
  }
}
