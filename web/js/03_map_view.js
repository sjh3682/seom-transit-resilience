/* =============================================================================
   03_map_view.js — 지도 뷰
   렉의 핵심 해결:
     1) 무거운 데이터 레이어는 'base' 캔버스에 한 번 그려 두고, 드래그·휠·핀치 중에는
        CSS transform 으로 밀고 늘리기만 한다. 조작이 멈추고 120ms 뒤(길게 조작하면
        최대 450ms 마다) 한 번만 다시 그린다.
     2) 선택·마우스오버·시뮬레이션 결과는 가벼운 'overlay' 캔버스에만 그린다.
        그래서 선택해도 수만 개 노선을 다시 그리지 않는다.
     3) 배경 타일은 줌 단계별 컨테이너에 두고 새 단계 타일이 뜰 때까지 이전 단계를 남겨
        깜빡이지 않는다.
   ============================================================================= */
'use strict';

/**
 * 배경지도. 안 뜨면 fallback 순서로 자동 전환한다(브이월드 → CARTO → 행정경계).
 *   vworld : 국토교통부 공공 배경지도(한국어 지명). 주소가 /{z}/{y}/{x} 순서, 줌 6부터 제공.
 *            지도 이름은 Base·white·midnight·Hybrid·Satellite 만 유효(예전 자료의 'gray' 는 폐지됨)
 *            교차출처(CORS) 허용 여부를 확인할 수 없어 crossOrigin 없이 불러온다 → 지도 저장 PNG 에는
 *            배경지도 대신 행정경계를 그린다.
 *   fade   : 배경 불투명도. 브이월드 백지도는 고속도로가 굵고 진해 대중교통 노선처럼 보이므로 옅게 깐다.
 *   carto  : 2026년 8월 말부터 키 없는 요청에 'API KEY REQUIRED' 워터마크 → config 의 키를 붙인다.
 */
const vworldUrl = (layer) => (z, x, y) =>
  `https://api.vworld.kr/req/wmts/1.0.0/${encodeURIComponent(BASEMAPS.vworld.key)}/${layer}/${z}/${y}/${x}.png`;
const BASEMAPS = {
  // bounds: 브이월드는 한반도 밖 타일이 없다 → 범위 밖은 요청하지 않는다(실패로 세지 않도록)
  vworld: { label: '브이월드 백지도', key: '', url: vworldUrl('white'), attribution: '© 국토교통부 브이월드', minZoom: 6, maxZoom: 18, cors: false, fallback: 'carto', bounds: [124, 32.8, 132.2, 39], fade: 0.45 },
  vworldBase: { label: '브이월드 일반', keyOf: 'vworld', url: vworldUrl('Base'), attribution: '© 국토교통부 브이월드', minZoom: 6, maxZoom: 19, cors: false, fallback: 'carto', bounds: [124, 32.8, 132.2, 39], fade: 0.55 },
  carto: { label: 'CARTO 회색', key: '',
           url: (z, x, y) => `https://${'abcd'[(x + y) % 4]}.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png?key=${encodeURIComponent(BASEMAPS.carto.key)}`,
           attribution: '© OpenStreetMap contributors © CARTO', maxZoom: 19, fallback: 'none' },
  osm: { label: 'OSM 표준', url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
         attribution: '© OpenStreetMap contributors', maxZoom: 19, fallback: 'none' },
  none: { label: '배경 없음', url: null, attribution: '', maxZoom: 20 },
};
/** 키가 필요한 배경지도는 키가 있을 때만 쓸 수 있다 */
function basemapAvailable(key) {
  const bm = BASEMAPS[key];
  if (!bm) return false;
  if ('key' in bm) return !!bm.key;
  if (bm.keyOf) return !!BASEMAPS[bm.keyOf].key;
  return true;
}

const KOREA_VIEW = { lon: 127.7, lat: 36.1, zoom: 6.6 };

class MapView {
  constructor(panel, handlers) {
    this.panel = panel;
    this.handlers = handlers;                  // onBase(ctx, view), onOverlay(ctx, view), onClick, onHover, onViewChange
    this.tileRoot = panel.querySelector('.tile-root');
    this.base = panel.querySelector('canvas.base');
    this.overlay = panel.querySelector('canvas.overlay');
    this.baseCtx = this.base.getContext('2d');
    this.overlayCtx = this.overlay.getContext('2d');
    this.cx = Mercator.x(KOREA_VIEW.lon);
    this.cy = Mercator.y(KOREA_VIEW.lat);
    this.z = KOREA_VIEW.zoom;
    this.minZoom = 5.5; this.maxZoom = 18;
    this.w = 1; this.h = 1; this.dpr = 1; this.baseDpr = 1;
    this.snap = null;
    this.basemap = ['vworld', 'carto', 'none'].find(basemapAvailable);   // 키가 있는 첫 배경지도
    this.tileRoot.style.opacity = String(BASEMAPS[this.basemap].fade ?? 1);
    this.tileLayer = null; this.oldTileLayer = null;
    this._baseTimer = null; this._basePending = false;
    this._overlayQueued = false;
    this._pointers = new Map();
    this._anim = null;

    new ResizeObserver(() => this.resize()).observe(panel);
    this._bindPointer();
  }

  // ------------------------------------------------------------------ 좌표
  get S() { return 256 * 2 ** this.z; }
  view() { return { cx: this.cx, cy: this.cy, z: this.z, S: this.S, w: this.w, h: this.h }; }
  toScreen(wx, wy) { const S = this.S; return [(wx - this.cx) * S + this.w / 2, (wy - this.cy) * S + this.h / 2]; }
  toWorld(sx, sy) { const S = this.S; return [this.cx + (sx - this.w / 2) / S, this.cy + (sy - this.h / 2) / S]; }

  resize() {
    const r = this.panel.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.w = r.width; this.h = r.height;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    // 데이터 레이어는 화면 배율 1.25 까지만: 150% 배율 노트북에서 칠할 픽셀이 2.25배가 되어 렉의 원인이 된다.
    // 선택 강조·툴팁이 그려지는 오버레이는 화면 배율 그대로(선명하게).
    // 게다가 칠하는 시간은 캔버스 픽셀 수에 비례해서, 전체화면처럼 지도 칸이 크면 약 120만 픽셀 예산 안으로 해상도를 낮춘다
    // (전체화면 수도권 노선: 1.25 → 1.0 에서 그리기 시간 약 절반).
    this.baseDpr = Math.max(1, Math.min(1.25, this.dpr, Math.sqrt(1.2e6 / (this.w * this.h))));
    for (const [c, k] of [[this.base, this.baseDpr], [this.overlay, this.dpr]]) {
      c.width = Math.round(this.w * k); c.height = Math.round(this.h * k);
      c.style.width = `${this.w}px`; c.style.height = `${this.h}px`;
    }
    this.renderBaseNow();
  }

  // ------------------------------------------------------------------ 뷰 변경
  setView(cx, cy, z) {
    this.z = Util.clamp(z, this.minZoom, this.maxZoom);
    this.cx = Util.clamp(cx, 0.83, 0.9); this.cy = Util.clamp(cy, 0.36, 0.43);
    this._changed();
  }

  zoomAround(sx, sy, z) {
    const [wx, wy] = this.toWorld(sx, sy);
    const nz = Util.clamp(z, this.minZoom, this.maxZoom);
    const S = 256 * 2 ** nz;
    this.setView(wx - (sx - this.w / 2) / S, wy - (sy - this.h / 2) / S, nz);
  }

  /** 부드럽게 이동 (중간 프레임은 CSS 변환만, 끝에서 한 번 렌더) */
  flyTo(cx, cy, z, ms = 380) {
    const from = { cx: this.cx, cy: this.cy, z: this.z };
    const t0 = performance.now();
    cancelAnimationFrame(this._anim);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms), e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      this.setView(from.cx + (cx - from.cx) * e, from.cy + (cy - from.cy) * e, from.z + (z - from.z) * e);
      if (t < 1) this._anim = requestAnimationFrame(step);
    };
    this._anim = requestAnimationFrame(step);
  }

  /** 세계 좌표 상자를 화면(가려진 패널 여백 제외)에 맞춘다 */
  fitBox(x0, y0, x1, y1, pad = {}) {
    const p = { top: 60, right: 40, bottom: 60, left: 40, ...pad };
    const aw = Math.max(80, this.w - p.left - p.right), ah = Math.max(80, this.h - p.top - p.bottom);
    const dx = Math.max(1e-7, x1 - x0), dy = Math.max(1e-7, y1 - y0);
    const z = Util.clamp(Math.log2(Math.min(aw / dx, ah / dy) / 256), this.minZoom, 15.5);
    const S = 256 * 2 ** z;
    const cx = (x0 + x1) / 2 - (p.left - p.right) / 2 / S;
    const cy = (y0 + y1) / 2 - (p.top - p.bottom) / 2 / S;
    this.flyTo(cx, cy, z);
  }

  home() { this.flyTo(Mercator.x(KOREA_VIEW.lon), Mercator.y(KOREA_VIEW.lat), KOREA_VIEW.zoom); }

  _changed() {
    this._applyTransforms();
    this.requestOverlay();
    this._scheduleBase();
    this.handlers.onViewChange && this.handlers.onViewChange(this.view());
  }

  /**
   * 데이터 레이어 다시 그리기 예약. 드래그·핀치 중에는 그리지 않고(이미 그린 그림을 CSS 로 옮기기만),
   * 손을 뗀 뒤나 휠·이동 애니메이션이 멈춘 뒤 한 번만 그린다. 다시 그리기는 픽셀 칠하기까지 포함하면
   * 느린 노트북에서 수백 ms 가 걸려, 조작 중에 그리면 화면이 뚝뚝 끊긴다.
   */
  _scheduleBase() {
    clearTimeout(this._baseTimer);
    if (this._pointers.size) { this._basePending = true; return; }
    this._baseTimer = setTimeout(() => this.renderBaseNow(), 150);
  }

  /** 데이터 레이어를 현재 뷰로 다시 그린다 (필터·모드가 바뀌었을 때도 호출) */
  renderBaseNow() {
    clearTimeout(this._baseTimer);
    this._basePending = false;
    const ctx = this.baseCtx;
    ctx.setTransform(this.baseDpr, 0, 0, this.baseDpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const v = this.view();
    this.handlers.onBase && this.handlers.onBase(ctx, v);
    this.snap = v;
    this.base.style.transform = '';
    this._refreshTiles();
    this.requestOverlay();
  }

  requestOverlay() {
    if (this._overlayQueued) return;
    this._overlayQueued = true;
    requestAnimationFrame(() => {
      this._overlayQueued = false;
      const ctx = this.overlayCtx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
      this.handlers.onOverlay && this.handlers.onOverlay(ctx, this.view());
    });
  }

  _applyTransforms() {
    const S = this.S;
    if (this.snap) {
      const k = 2 ** (this.z - this.snap.z);
      const tx = (this.snap.cx - this.cx) * S - (this.w / 2) * k + this.w / 2;
      const ty = (this.snap.cy - this.cy) * S - (this.h / 2) * k + this.h / 2;
      this.base.style.transform = `translate(${tx}px,${ty}px) scale(${k})`;
    }
    for (const layer of [this.oldTileLayer, this.tileLayer]) {
      if (!layer) continue;
      const k = S / (256 * 2 ** layer.tz);
      layer.el.style.transform = `translate(${(layer.ox - this.cx) * S + this.w / 2}px,${(layer.oy - this.cy) * S + this.h / 2}px) scale(${k})`;
    }
  }

  // ------------------------------------------------------------------ 배경 타일
  setBasemap(key) {
    this.basemap = key;
    this.tileRoot.style.opacity = String(BASEMAPS[key].fade ?? 1);
    this._tileOk = 0; this._tileFail = 0;
    this._bmGen = (this._bmGen || 0) + 1;     // 이전 배경지도 타일의 늦은 성공·실패는 무시
    for (const layer of [this.oldTileLayer, this.tileLayer]) if (layer) layer.el.remove();
    this.tileLayer = this.oldTileLayer = null;
    this.renderBaseNow();
  }

  /**
   * 요청한 타일이 모두 도착했는데 하나도 성공하지 못했을 때만(오프라인·차단·키 오류) 다음 배경지도로 전환.
   * 실패 응답은 성공보다 빨리 오므로 '실패 N개가 먼저 쌓이면' 식으로 판단하면 멀쩡한 지도도 버린다.
   */
  _checkTileBatch(layer, gen) {
    if (gen !== (this._bmGen || 0) || layer.pending > 0 || this._tileOk || this._tileFail < 4 || this.basemap === 'none') return;
    const from = this.basemap;
    let next = BASEMAPS[from].fallback || 'none';
    while (next !== 'none' && !basemapAvailable(next)) next = BASEMAPS[next].fallback || 'none';
    this.setBasemap(next);
    this.handlers.onBasemapFallback && this.handlers.onBasemapFallback(from, next);
  }

  _refreshTiles() {
    const bm = BASEMAPS[this.basemap];
    if (!bm.url) return;
    const tz = Util.clamp(Math.round(this.z), bm.minZoom || 3, bm.maxZoom);
    if (!this.tileLayer || this.tileLayer.tz !== tz) {
      if (this.oldTileLayer) this.oldTileLayer.el.remove();
      this.oldTileLayer = this.tileLayer;
      const el = document.createElement('div');
      el.className = 'tile-layer';
      this.tileRoot.appendChild(el);
      const [ox, oy] = this.toWorld(0, 0);
      this.tileLayer = { tz, ox, oy, el, tiles: new Map(), pending: 0 };
    }
    const layer = this.tileLayer, n = 2 ** tz, S0 = 256 * n;
    const [x0, y0] = this.toWorld(-64, -64), [x1, y1] = this.toWorld(this.w + 64, this.h + 64);
    const tx0 = Math.floor(x0 * n), tx1 = Math.floor(x1 * n), ty0 = Math.max(0, Math.floor(y0 * n)), ty1 = Math.min(n - 1, Math.floor(y1 * n));
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const key = `${tx},${ty}`;
        if (layer.tiles.has(key)) continue;
        if (bm.bounds) {       // 타일 경위도 범위가 제공 범위와 겹치지 않으면 건너뜀
          const [w, sB, e, nB] = bm.bounds;
          if (Mercator.lon((tx + 1) / n) < w || Mercator.lon(tx / n) > e || Mercator.lat(ty / n) < sB || Mercator.lat((ty + 1) / n) > nB) continue;
        }
        const img = new Image();
        if (bm.cors !== false) img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.style.left = `${(tx / n - layer.ox) * S0}px`;
        img.style.top = `${(ty / n - layer.oy) * S0}px`;
        layer.pending++;
        const gen = this._bmGen || 0;
        const done = () => {
          layer.pending--;
          if (layer.pending <= 0 && this.oldTileLayer && layer === this.tileLayer) { this.oldTileLayer.el.remove(); this.oldTileLayer = null; }
          this._checkTileBatch(layer, gen);
        };
        img.onload = () => { if (gen === (this._bmGen || 0)) this._tileOk = (this._tileOk || 0) + 1; done(); };
        img.onerror = () => { img.remove(); if (gen === (this._bmGen || 0)) this._tileFail = (this._tileFail || 0) + 1; done(); };
        img.src = bm.url(tz, ((tx % n) + n) % n, ty);
        layer.tiles.set(key, img);
        layer.el.appendChild(img);
      }
    }
    if (layer.tiles.size > 260) {           // 화면에서 먼 타일 정리
      for (const [key, img] of layer.tiles) {
        const [tx, ty] = key.split(',').map(Number);
        if (tx < tx0 - 2 || tx > tx1 + 2 || ty < ty0 - 2 || ty > ty1 + 2) { img.remove(); layer.tiles.delete(key); }
      }
    }
    setTimeout(() => { if (this.oldTileLayer && this.oldTileLayer !== this.tileLayer) { this.oldTileLayer.el.remove(); this.oldTileLayer = null; } }, 1800);
    this._applyTransforms();
  }

  // ------------------------------------------------------------------ 입력 (마우스·터치·펜 공통)
  _bindPointer() {
    const el = this.overlay;
    let drag = null, pinch = null, hoverQueued = false, lastHover = null;

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      cancelAnimationFrame(this._anim);
      if (this._pointers.size === 1) {
        drag = { x: e.offsetX, y: e.offsetY, cx: this.cx, cy: this.cy, moved: false, t: performance.now() };
      } else if (this._pointers.size === 2) {
        const [a, b] = [...this._pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: this.z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        drag = null;
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (this._pointers.has(e.pointerId)) {
        this._pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
        if (pinch && this._pointers.size === 2) {
          const [a, b] = [...this._pointers.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          this.zoomAround((a.x + b.x) / 2, (a.y + b.y) / 2, pinch.z + Math.log2(d / Math.max(1, pinch.d)));
        } else if (drag) {
          const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
          if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; this.panel.classList.add('dragging'); this.handlers.onHover && this.handlers.onHover(null); }
          if (drag.moved) this.setView(drag.cx - dx / this.S, drag.cy - dy / this.S, this.z);
        }
        return;
      }
      if (e.pointerType !== 'mouse') return;
      lastHover = [e.offsetX, e.offsetY];
      if (!hoverQueued) {
        hoverQueued = true;
        requestAnimationFrame(() => { hoverQueued = false; this.handlers.onHover && this.handlers.onHover(lastHover); });
      }
    });

    const end = (e) => {
      if (!this._pointers.has(e.pointerId)) return;
      this._pointers.delete(e.pointerId);
      this.panel.classList.remove('dragging');
      if (drag && !drag.moved && !pinch && this._pointers.size === 0 && performance.now() - drag.t < 600) {
        this.handlers.onClick && this.handlers.onClick(e.offsetX, e.offsetY, e);
      }
      if (this._pointers.size === 0) {
        drag = null; pinch = null;
        if (this._basePending) { this._basePending = false; this._scheduleBase(); }
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', () => { if (!this._pointers.size) this.handlers.onHover && this.handlers.onHover(null); });

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dz = Util.clamp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022), -0.6, 0.6);
      this.zoomAround(e.offsetX, e.offsetY, this.z + dz);
    }, { passive: false });
    el.addEventListener('dblclick', (e) => { e.preventDefault(); this.zoomAround(e.offsetX, e.offsetY, this.z + 1); });

    this.panel.addEventListener('keydown', (e) => {
      if (e.target.closest('input,textarea')) return;
      const step = 90 / this.S;
      const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (map[e.key]) { e.preventDefault(); this.setView(this.cx + map[e.key][0], this.cy + map[e.key][1], this.z); }
      if (e.key === '+' || e.key === '=') this.zoomAround(this.w / 2, this.h / 2, this.z + 0.6);
      if (e.key === '-') this.zoomAround(this.w / 2, this.h / 2, this.z - 0.6);
    });
  }

  // ------------------------------------------------------------------ 이미지 저장
  /** 배경 타일(가능하면) + 데이터 + 오버레이 + 제목·범례를 한 장의 PNG 로 */
  /** 데이터 레이어 캔버스 해상도 변경(지도 저장 때만 잠깐 고해상도로) */
  _setBaseDpr(k) {
    this.baseDpr = k;
    this.base.width = Math.round(this.w * k); this.base.height = Math.round(this.h * k);
  }

  async exportPNG(drawExtras) {
    const screenDpr = this.baseDpr;
    this._setBaseDpr(2);                      // 기획서용 그림은 선명하게(한 번만 그리므로 느려도 괜찮다)
    this.renderBaseNow();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try { return this._composeExport(drawExtras); } finally { this._setBaseDpr(screenDpr); this.renderBaseNow(); }
  }

  _composeExport(drawExtras) {
    const scale = 2;
    const compose = (withTiles) => {
      const c = document.createElement('canvas');
      c.width = this.w * scale; c.height = this.h * scale;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#eef2f6'; ctx.fillRect(0, 0, c.width, c.height);
      if (withTiles && this.tileLayer) {
        const layer = this.tileLayer, k = this.S / (256 * 2 ** layer.tz);
        const ox = (layer.ox - this.cx) * this.S + this.w / 2, oy = (layer.oy - this.cy) * this.S + this.h / 2;
        ctx.globalAlpha = BASEMAPS[this.basemap].fade ?? 1;
        for (const img of layer.tiles.values()) {
          if (!img.complete || !img.naturalWidth) continue;
          ctx.drawImage(img, (ox + parseFloat(img.style.left) * k) * scale, (oy + parseFloat(img.style.top) * k) * scale, 256 * k * scale + 1, 256 * k * scale + 1);
        }
      }
      ctx.globalAlpha = 1;
      if (!withTiles && this.handlers.onLand) {       // 배경지도를 넣을 수 없으면 행정경계라도
        ctx.setTransform(scale, 0, 0, scale, 0, 0); this.handlers.onLand(ctx, this.view()); ctx.setTransform(1, 0, 0, 1, 0, 0);
      }
      ctx.drawImage(this.base, 0, 0, c.width, c.height);
      ctx.drawImage(this.overlay, 0, 0, c.width, c.height);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      drawExtras && drawExtras(ctx, this.w, this.h, withTiles ? BASEMAPS[this.basemap].attribution : '');
      return c.toDataURL('image/png');
    };
    if (BASEMAPS[this.basemap].cors === false) return compose(false);     // 교차출처 미확인 배경은 넣지 않음
    try { return compose(true); } catch (err) { return compose(false); }   // 타일이 교차출처로 막히면 배경 없이
  }
}
