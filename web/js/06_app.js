/* =============================================================================
   06_app.js — App: 화면 상태와 사용자 조작을 연결하는 컨트롤러
   ============================================================================= */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const LAYER_INFO = {
  region: { name: '지역', chip: (n, st) => `${st.regionSub === 'grid' ? '5km 격자' : '시군구'} · 화면 안 ${Util.fmt(n)}곳` },
  line: { name: '노선', chip: (n) => `노선 · 화면 안 ${Util.fmt(n)}개` },
  stop: { name: '정류장', chip: (n) => `정류장 · 화면 안 ${Util.fmt(n)}곳` },
  segment: { name: '구간', chip: (n) => `도로 구간 · 화면 안 ${Util.fmt(n)}개` },
};

class App {
  constructor(params) {
    this.params = params;
    this.root = $('#app');
    this.state = {
      mode: 'region', regionSub: 'sigungu',
      riskOn: [true, true, true, true],
      modeOn: [1, 1, 1, 0, 0, 0, 0, 0],          // 장거리(직선 표시) 노선은 기본 숨김
      lod: true, dim: true, focusOnly: false, senior: false, showGaps: true,
    };
    this.selection = null;       // { kind, id }
    this.hover = null;
    this.sim = null;             // 지도에 그릴 시뮬레이션 결과
    this.journeyResult = null;
    this.history = [];
    this.tour = null;
  }

  // ------------------------------------------------------------------ 시작
  async start() {
    try {
      this.setLoading('데이터 불러오는 중', '전국 정류장·노선 그래프를 준비합니다.');
      const { header, arrays } = await DataLoader.load((msg) => this.setLoading(msg));
      Style.init(this.params);
      const ds = this.ds = new Dataset(header, arrays, this.params);
      this.layers = { region: new RegionLayer(ds), line: new LineLayer(ds), stop: new StopLayer(ds), segment: new SegmentLayer(ds) };
      this.panel = new DetailPanel(ds);
      const keys = this.params.basemap || {};
      BASEMAPS.vworld.key = keys.vworld_key || '';
      BASEMAPS.carto.key = keys.carto_key || '';
      this.map = new MapView($('#mapPanel'), {
        onBase: (ctx, v) => this.drawBase(ctx, v),
        onOverlay: (ctx, v) => this.drawOverlay(ctx, v),
        onClick: (x, y) => this.onMapClick(x, y),
        onHover: (p) => this.onMapHover(p),
        onViewChange: () => this.hideChooser(),
        onBasemapFallback: (from, to) => {
          this.renderLegend();
          this.toast(`${BASEMAPS[from].label} 지도를 불러올 수 없어 ${to === 'none' ? '행정경계 배경' : BASEMAPS[to].label}으로 바꿨습니다.`);
        },
        onLand: (ctx, v) => this.drawLand(ctx, v),
      });
      this.engine = new EngineClient(ds, this.params);
      this.engine.ready.catch((err) => this.toast(`시뮬레이션 엔진 오류: ${err.message}`));
      this.buildFilters();
      this.bindUI();
      this.renderLegend();
      this.showView({ kind: 'home' }, { push: false });
      this.updateFocusClass();
      this.map.resize();
      this.hideLoading();
      this.applyHash();
    } catch (err) {
      console.error(err);
      this.setLoading('불러오기 실패', String(err.message || err), true);
    }
  }

  setLoading(title, desc = '', error = false) {
    const el = $('#loading');
    el.classList.remove('hide');
    el.classList.toggle('error', error);
    $('#loadingTitle').textContent = title;
    if (desc) $('#loadingDesc').textContent = desc;
  }
  hideLoading() { $('#loading').classList.add('hide'); }

  toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2400);
  }

  renderState() {
    const st = this.state;
    return { ...st, modeMask: st.modeOn.reduce((m, on, i) => (on ? m | (1 << i) : m), 0) };
  }

  // ------------------------------------------------------------------ 필터 UI
  buildFilters() {
    const grades = $('#gradeFilters');
    grades.innerHTML = this.params.grades.names.map((name, i) => `
      <button class="toggle" data-grade="${i}" aria-pressed="true">
        <span class="check" aria-hidden="true"></span>
        <span class="toggle-text"><b>${name}</b><small>${this.params.grades.ranges[i]}</small></span>
        <span class="swatch g${i}"><i></i>${this.params.grades.shapes[i]}</span></button>`).join('');
    const modes = $('#modeFilters');
    modes.innerHTML = Object.entries(this.params.modes).map(([code, m]) => `
      <button class="chip-toggle" data-mode-code="${code}" aria-pressed="${!!this.state.modeOn[code]}">${m.short}${m.long_distance && code !== '2' ? '<small>직선</small>' : ''}</button>`).join('');
  }

  // ------------------------------------------------------------------ 이벤트 연결
  bindUI() {
    this.bindFilters();
    this.bindMapControls();
    this.bindPanels();
    this.bindTopAndKeys();
  }

  /** 왼쪽 패널: 레이어·위험 등급·교통수단·표시 설정 */
  bindFilters() {
    const st = this.state;

    $$('#layerTabs button').forEach((b) => b.addEventListener('click', () => this.setMode(b.dataset.layer)));
    $$('#regionSub button').forEach((b) => b.addEventListener('click', () => this.setRegionSub(b.dataset.sub)));

    $('#gradeFilters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-grade]'); if (!b) return;
      const i = Number(b.dataset.grade);
      st.riskOn[i] = !st.riskOn[i];
      b.setAttribute('aria-pressed', String(st.riskOn[i]));
      this.map.renderBaseNow();
    });
    $('#modeFilters').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode-code]'); if (!b) return;
      const i = Number(b.dataset.modeCode);
      st.modeOn[i] = st.modeOn[i] ? 0 : 1;
      b.setAttribute('aria-pressed', String(!!st.modeOn[i]));
      this.map.renderBaseNow();
    });

    this._toggles = {};
    const bindToggle = (id, key, after) => {
      this._toggles[key] = { id, after };
      const b = $(id);
      b.setAttribute('aria-pressed', String(st[key]));
      b.addEventListener('click', () => { st[key] = !st[key]; b.setAttribute('aria-pressed', String(st[key])); after(); });
    };
    bindToggle('#dimToggle', 'dim', () => this.updateFocusClass());
    bindToggle('#focusToggle', 'focusOnly', () => this.updateFocusClass());
    bindToggle('#lodToggle', 'lod', () => this.map.renderBaseNow());
    bindToggle('#seniorToggle', 'senior', () => { this.map.renderBaseNow(); this.renderLegend(); });
    bindToggle('#gapToggle', 'showGaps', () => this.map.renderBaseNow());
    // 배경 지도는 자동으로 고른다(브이월드 → CARTO → 행정경계). 선택 칸은 분석과 무관해 화면에서 뺐다.
    this.ds.seniorHighlightPct = (this.params.display && this.params.display.senior_highlight_pct) || 40;
    $('#seniorToggle .toggle-text b').textContent = `고령 ${this.ds.seniorHighlightPct}%↑ 지역 강조`;

  }

  /** 지도 위 버튼(확대·축소·처음 위치·패널 접기·범례) */
  bindMapControls() {
    $('#zoomIn').addEventListener('click', () => this.map.zoomAround(this.map.w / 2, this.map.h / 2, this.map.z + 0.8));
    $('#zoomOut').addEventListener('click', () => this.map.zoomAround(this.map.w / 2, this.map.h / 2, this.map.z - 0.8));
    $('#homeBtn').addEventListener('click', () => this.map.home());
    $('#toggleLeft').addEventListener('click', () => this.togglePanel('left'));
    $('#toggleRight').addEventListener('click', () => this.togglePanel('right'));
    $('#legendToggle').addEventListener('click', () => $('#legend').classList.toggle('collapsed'));

  }

  /** 오른쪽 패널(뒤로·닫기·버튼), 검색, 경로 회복력 */
  bindPanels() {
    // 오른쪽 패널: 뒤로·닫기·버튼 위임
    $('#backBtn').addEventListener('click', () => this.back());
    $('#closeBtn').addEventListener('click', () => this.clearSelection());
    $('#detail').addEventListener('click', (e) => this.onDetailAction(e));

    // 검색
    this.bindSearch($('#searchInput'), $('#searchResults'), { kinds: ['stop', 'line', 'region'] }, (hit) => this.selectHit(hit));
    // 경로
    this.journeyPick = { start: null, end: null };
    this.bindSearch($('#startInput'), $('#startResults'), { kinds: ['stop'] }, (hit) => { this.journeyPick.start = hit.id; $('#startInput').value = this.ds.groupName[hit.id]; });
    this.bindSearch($('#endInput'), $('#endResults'), { kinds: ['stop'] }, (hit) => { this.journeyPick.end = hit.id; $('#endInput').value = this.ds.groupName[hit.id]; });
    $('#startInput').addEventListener('input', () => { this.journeyPick.start = null; });
    $('#endInput').addEventListener('input', () => { this.journeyPick.end = null; });
    $('#swapBtn').addEventListener('click', () => {
      [this.journeyPick.start, this.journeyPick.end] = [this.journeyPick.end, this.journeyPick.start];
      [$('#startInput').value, $('#endInput').value] = [$('#endInput').value, $('#startInput').value];
    });
    $('#journeyBtn').addEventListener('click', () => this.runJourney());

  }

  /** 상단 버튼, 휴대폰 하단 탭, 단축키, 주소(#) 공유, 화면 크기 */
  bindTopAndKeys() {
    // 상단
    $('#methodBtn').addEventListener('click', () => $('#methodDialog').showModal());
    $('#methodClose').addEventListener('click', () => $('#methodDialog').close());
    $('#exportBtn').addEventListener('click', () => this.exportMap());
    $('#tourBtn').addEventListener('click', () => this.startTour());
    $$('#mobileNav button').forEach((b) => b.addEventListener('click', () => this.setSheet(b.dataset.sheet)));

    window.addEventListener('keydown', (e) => {
      if (e.target.closest('input,textarea,select') || $('#methodDialog').open) return;
      if (e.key === '[') this.togglePanel('left');
      else if (e.key === ']') this.togglePanel('right');
      else if (e.key === '/') { e.preventDefault(); $('#searchInput').focus(); }
      else if (e.key === 'Escape') {
        if ($('#chooser').classList.contains('show')) this.hideChooser();
        else if (this.selection || this.journeyResult) this.clearSelection();
      }
    });
    window.addEventListener('hashchange', () => this.applyHash());
    window.addEventListener('resize', Util.debounce(() => this.syncResponsive(), 120));
    this.syncResponsive();
  }

  // ------------------------------------------------------------------ 레이아웃
  isRightOverlay() { return window.innerWidth < 1180 && window.innerWidth >= 760; }
  isMobile() { return window.innerWidth < 760; }

  /**
   * 폭 1180px 미만에서는 오른쪽 패널이 지도를 덮는 서랍이 된다. 이 구간에 들어오면 선택이 없을 때
   * 서랍을 닫아 지도를 보이게 하고, 넓어지면 다시 옆에 붙인다.
   */
  syncResponsive() {
    if (this.isMobile()) return;
    const overlay = this.isRightOverlay();
    this.placeRightHandle();
    if (overlay === this._wasOverlay) return;
    this._wasOverlay = overlay;
    this.setRightOpen(overlay ? !!(this.selection || this.journeyResult) : true);
  }

  setRightOpen(open) {
    this.root.dataset.right = open ? 'open' : 'closed';
    $('#toggleRight').setAttribute('aria-expanded', String(open));
    this.placeRightHandle();
  }

  /** 좁은 화면(오른쪽 패널이 지도 위에 뜨는 서랍)에서 패널이 열리면 접기 손잡이를 패널 왼쪽 가장자리에 붙인다.
   *  지도 오른쪽 끝에 두면 열린 패널에 가려져, 처음 화면처럼 ✕ 가 없을 때 패널을 닫을 방법이 없었다. */
  placeRightHandle() {
    const h = $('#toggleRight');
    if (this.isMobile() || !this.isRightOverlay() || this.root.dataset.right !== 'open') {
      h.style.right = ''; h.style.zIndex = '';
      return;
    }
    const panel = $('#rightPanel'), map = $('#mapPanel');
    const shift = new DOMMatrixReadOnly(getComputedStyle(panel).transform).m41;   // 여는 중이면 이동량을 빼서 최종 위치로
    const left = panel.getBoundingClientRect().left - shift;
    h.style.right = `${Math.max(0, map.getBoundingClientRect().right - left - 1)}px`;
    h.style.zIndex = '31';
  }

  togglePanel(side) {
    if (this.isMobile()) { this.setSheet(side === 'left' ? 'filters' : 'analysis'); return; }
    const key = side === 'left' ? 'left' : 'right';
    this.root.dataset[key] = this.root.dataset[key] === 'closed' ? 'open' : 'closed';
    $(`#toggle${side === 'left' ? 'Left' : 'Right'}`).setAttribute('aria-expanded', String(this.root.dataset[key] !== 'closed'));
    this.placeRightHandle();
  }

  openRight() {
    if (this.isMobile()) { this.setSheet('analysis'); return; }
    if (this.root.dataset.right === 'closed') this.togglePanel('right');
    // 좁은 화면(태블릿)에서는 서랍과 왼쪽 패널이 함께 열리면 지도가 거의 안 보인다 → 왼쪽을 잠시 접는다
    if (this.isRightOverlay() && window.innerWidth < 1000 && this.root.dataset.left !== 'closed') {
      this.togglePanel('left');
      this._leftAutoClosed = true;
    }
  }

  setSheet(which) {
    this.root.dataset.sheet = this.root.dataset.sheet === which ? '' : which;
    $$('#mobileNav button').forEach((b) => b.classList.toggle('active', b.dataset.sheet === this.root.dataset.sheet));
  }

  /** 지도 맞춤 시 가려지는 영역(떠 있는 오른쪽 패널) 만큼 여백 */
  fitPadding() {
    const pad = { top: 70, right: 50, bottom: 70, left: 50 };
    if (this.isRightOverlay() && this.root.dataset.right !== 'closed') pad.right = $('#rightPanel').offsetWidth + 30;
    if (this.isMobile() && this.root.dataset.sheet) {
      // 아래 시트(bottom 70px, 최대 62vh)가 덮는 높이를 실제 내용 높이로 계산해 그 위에 맞춘다
      const sheet = this.root.dataset.sheet === 'filters' ? $('#leftPanel') : $('#rightPanel');
      const covered = 70 + Math.min(sheet.scrollHeight, window.innerHeight * 0.62);
      const mapBottom = $('#mapPanel').getBoundingClientRect().bottom;
      pad.top = 56; pad.left = pad.right = 24;
      pad.bottom = Math.max(70, mapBottom - (window.innerHeight - covered) + 12);
    }
    return pad;
  }

  updateFocusClass() {
    const panel = $('#mapPanel');
    const focused = !!(this.selection || this.journeyResult);
    panel.classList.toggle('focus-dim', focused && this.state.dim && !this.state.focusOnly);
    panel.classList.toggle('focus-only', focused && this.state.focusOnly);
    $('#focusToggle').classList.toggle('muted', !focused);
    this.map.requestOverlay();
  }

  /**
   * 레이어 전환. 다른 레이어의 대상이 선택돼 있으면 선택을 풀어서, 탭과 지도와 오른쪽 패널이
   * 항상 같은 대상을 가리키게 한다(경로 결과는 레이어와 무관하므로 유지).
   */
  setMode(mode, { keepSelection = false } = {}) {
    if (!keepSelection && this.selection && App.modeOf(this.selection.kind) !== mode) this.clearSelection();
    this.state.mode = mode;
    $$('#layerTabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.layer === mode)));
    $('#regionSub').hidden = mode !== 'region';
    this.hover = null;
    this.renderLegend();
    this.map.renderBaseNow();
  }

  setRegionSub(sub, { keepSelection = false } = {}) {
    const kind = sub === 'grid' ? 'grid' : 'region';
    if (!keepSelection && this.selection && ['grid', 'region'].includes(this.selection.kind) && this.selection.kind !== kind) this.clearSelection();
    this.state.regionSub = sub;
    this.layers.region.submode = sub;
    $$('#regionSub button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.sub === sub)));
    this.renderLegend();
    this.map.renderBaseNow();
  }

  /** 선택 대상 종류 → 그 대상이 보이는 레이어 */
  static modeOf(kind) {
    return { region: 'region', grid: 'region', line: 'line', stop: 'stop', segment: 'segment' }[kind] || null;
  }

  // ------------------------------------------------------------------ 그리기
  drawBase(ctx, v) {
    const st = this.renderState();
    if (this.map.basemap === 'none') this.drawLand(ctx, v);
    const layer = this.layers[st.mode];
    const n = layer.draw(ctx, v, st);
    if (st.senior) this.layers.region.drawSenior(ctx, v);
    let chip = LAYER_INFO[st.mode].chip(n, st);
    if (layer.minGrade >= 1) {
      const low = this.params.grades.names.slice(0, layer.minGrade).join('·');
      chip += st.mode === 'stop' ? ` · ${low}는 회색(확대하면 색으로)` : ` · 확대하면 ${low}도 표시`;
    }
    $('#layerChip').textContent = chip;
  }

  drawLand(ctx, v) {
    const path = new Path2D();
    for (const rings of this.ds.sidoShapes) for (const ring of rings) addRing(path, ring, v);
    ctx.save(); ctx.fillStyle = '#f7f9fb'; ctx.fill(path, 'evenodd'); ctx.strokeStyle = '#b9c3cf'; ctx.lineWidth = 0.8; ctx.stroke(path); ctx.restore();
  }

  toScreen(v, g) { return [(this.ds.gx[g] - v.cx) * v.S + v.w / 2, (this.ds.gy[g] - v.cy) * v.S + v.h / 2]; }

  drawOverlay(ctx, v) {
    const L = this.layers;
    // 1) 시뮬레이션 결과
    if (this.sim) this.drawSim(ctx, v);
    // 2) 경로
    if (this.journeyResult) this.drawJourney(ctx, v);
    // 3) 선택 강조
    const sel = this.selection;
    if (sel) {
      if (sel.kind === 'line') L.line.highlight(ctx, v, sel.id);
      else if (sel.kind === 'stop') L.stop.highlight(ctx, v, sel.id);
      else if (sel.kind === 'segment') L.segment.highlight(ctx, v, sel.id);
      else if (sel.kind === 'region') this.outlineRegion(ctx, v, sel.id, '#1747c8', 3);
      else if (sel.kind === 'grid') this.outlineGrid(ctx, v, sel.id);
    }
    // 4) 마우스오버
    const h = this.hover;
    if (h && !(sel && sel.kind === h.kind && sel.id === h.id)) {
      if (h.kind === 'line') L.line.highlight(ctx, v, h.id, { width: 3 });
      else if (h.kind === 'stop') L.stop.highlight(ctx, v, h.id, '#5b6475');
      else if (h.kind === 'segment') L.segment.highlight(ctx, v, h.id);
      else if (h.kind === 'region') this.outlineRegion(ctx, v, h.id, '#39424f', 1.6);
      else if (h.kind === 'grid') this.outlineGrid(ctx, v, h.id);
    }
  }

  outlineRegion(ctx, v, r, color, width) {
    const shape = this.ds.regionShapes[r];
    if (!shape) return;
    const path = new Path2D();
    for (const ring of shape.rings) this.layers.region._ringPath(path, ring, v);
    ctx.save(); ctx.lineWidth = width + 3; ctx.strokeStyle = '#fff'; ctx.stroke(path);
    ctx.lineWidth = width; ctx.strokeStyle = color; ctx.stroke(path); ctx.restore();
  }

  outlineGrid(ctx, v, i) {
    const a = this.ds.a, cell = this.ds.gridSpec.cell, [olon, olat] = this.ds.gridSpec.origin;
    const lon = olon + a.gr_x[i] * cell, lat = olat + a.gr_y[i] * cell;
    const [x0, y0] = [(Mercator.x(lon) - v.cx) * v.S + v.w / 2, (Mercator.y(lat + cell) - v.cy) * v.S + v.h / 2];
    const [x1, y1] = [(Mercator.x(lon + cell) - v.cx) * v.S + v.w / 2, (Mercator.y(lat) - v.cy) * v.S + v.h / 2];
    ctx.save(); ctx.lineWidth = 3; ctx.strokeStyle = '#1747c8'; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.restore();
  }

  /** 표본 이동(출발→도착)마다 그 노선 위에서 실제로 지나는 정류장 순서를 찾아 둔다(지도에 구간으로 표시) */
  pairPaths(l, pairs) {
    const a = this.ds.a, pats = [];
    for (let p = 0; p < a.p_line.length; p++) if (a.p_line[p] === l) pats.push(this.ds.patternStops(p));
    return pairs.map((pr) => {
      for (const stops of pats) {
        const i = stops.indexOf(pr.from);
        const j = i < 0 ? -1 : stops.indexOf(pr.to, i + 1);
        if (j > i) return { ...pr, path: Array.from(stops.subarray(i, j + 1)) };
      }
      return { ...pr, path: [pr.from, pr.to] };
    });
  }

  drawSim(ctx, v) {
    const s = this.sim;
    ctx.save();
    ctx.lineCap = 'round';
    if (s.pairs) {
      // 영향 받은 표본 이동만, 노선을 따라 굵은 반투명 띠로: 단절(또는 2배 이상 우회)=빨강, 30%↑ 지연=주황
      const hit = s.pairs.map((p) => ({ p, inc: p.after == null ? Infinity : (p.after - p.before) / Math.max(1, p.before) }))
        .filter((x) => x.inc > 0.3).sort((x, y) => x.inc - y.inc);
      for (const { p, inc } of hit) {
        ctx.beginPath();
        this.ds.traceStops(ctx, p.path || [p.from, p.to], v);
        ctx.setLineDash([]); ctx.lineJoin = 'round';
        ctx.globalAlpha = 0.5; ctx.lineWidth = 12; ctx.strokeStyle = inc === Infinity ? '#dc3b3b' : '#f0a020'; ctx.stroke();
        ctx.globalAlpha = 1;
        for (const g of [p.from, p.to]) {
          const [x, y] = this.toScreen(v, g);
          ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
          ctx.lineWidth = 2.5; ctx.strokeStyle = inc === Infinity ? '#dc3b3b' : '#d58a00'; ctx.stroke();
        }
      }
    }
    if (s.stranded) {                                    // 섬이 되는 정류장: 검은 네모
      ctx.setLineDash([]);
      for (const g of s.stranded) {
        const [x, y] = this.toScreen(v, g);
        ctx.fillStyle = '#161b26'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        ctx.fillRect(x - 5, y - 5, 10, 10); ctx.strokeRect(x - 5, y - 5, 10, 10);
      }
    }
    if (s.links) {                                       // 정책으로 추가된 연결: 보라 점선
      for (const k of s.links) {
        const [ax, ay] = this.toScreen(v, k.from), [bx, by] = this.toScreen(v, k.to);
        ctx.setLineDash([7, 4]); ctx.strokeStyle = '#7b3fe4'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.setLineDash([]); ctx.fillStyle = '#7b3fe4';
        for (const [x, y] of [[ax, ay], [bx, by]]) { ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); }
      }
    }
    if (s.alternative != null && s.alternative >= 0) {   // 정류장 폐쇄: 대체 정류장까지 걷는 길
      const [ax, ay] = this.toScreen(v, s.group), [bx, by] = this.toScreen(v, s.alternative);
      ctx.setLineDash([3, 4]); ctx.strokeStyle = '#1747c8'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      ctx.setLineDash([]); ctx.beginPath(); ctx.arc(bx, by, 7, 0, 7); ctx.fillStyle = '#1747c8'; ctx.fill();
    }
    if (s.legs) this.drawLegs(ctx, v, s.legs, '#1747c8', true);
    ctx.restore();
  }

  drawLegs(ctx, v, legs, color = null, dashed = false) {
    const a = this.ds.a;
    for (const leg of legs) {
      const path = new Path2D();
      if (leg.kind === 'ride') {
        this.ds.traceStops(path, this.ds.patternStops(leg.pattern).subarray(leg.fromPos, leg.toPos + 1), v);   // 버스 구간은 도로를 따라
      } else {
        const [ax, ay] = this.toScreen(v, leg.from), [bx, by] = this.toScreen(v, leg.to);
        path.moveTo(ax, ay); path.lineTo(bx, by);
      }
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      if (leg.kind === 'ride') {
        ctx.setLineDash(dashed ? [8, 5] : []);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 9; ctx.stroke(path);
        ctx.strokeStyle = color || Style.colors[a.l_grade[leg.line]]; ctx.lineWidth = 5; ctx.stroke(path);
      } else {
        ctx.setLineDash([2, 5]); ctx.strokeStyle = '#5b6475'; ctx.lineWidth = 3; ctx.stroke(path);
      }
      ctx.restore();
    }
  }

  drawJourney(ctx, v) {
    const j = this.journeyResult;
    this.drawLegs(ctx, v, j.best.legs);
    for (const [g, label, fill] of [[j.start, 'A', '#1747c8'], [j.end, 'B', '#161b26']]) {
      const [x, y] = this.toScreen(v, g);
      ctx.save(); ctx.beginPath(); ctx.arc(x, y, 11, 0, 7); ctx.fillStyle = fill; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '800 12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(label, x, y + 0.5); ctx.restore();
    }
  }

  // ------------------------------------------------------------------ 지도 조작
  hitTest(x, y) {
    const v = this.map.view();
    return this.layers[this.state.mode].hitTest(v, x, y);
  }

  onMapHover(p) {
    const tip = $('#tooltip');
    if (!p) { this.hover = null; tip.classList.remove('show'); this.map.requestOverlay(); return; }
    const hit = this.hitTest(p[0], p[1])[0] || null;
    const changed = (hit && (!this.hover || this.hover.kind !== hit.kind || this.hover.id !== hit.id)) || (!hit && this.hover);
    this.hover = hit;
    $('#mapPanel').classList.toggle('pointing', !!hit);
    if (!hit) { tip.classList.remove('show'); if (changed) this.map.requestOverlay(); return; }
    const info = this.describe(hit);
    const isSel = this.selection && this.selection.kind === hit.kind && this.selection.id === hit.id;
    tip.innerHTML = `<b>${Util.esc(info.title)}</b><small>${Util.esc(info.sub)}</small>${info.grade != null ? `<span>${Html.badge(info.grade)} ${info.score != null ? Number(info.score).toFixed(1) : ''}</span>` : ''}${isSel ? '<em class="tip-hint">다시 누르면 선택 해제</em>' : ''}`;
    const left = Math.min(p[0] + 14, this.map.w - 240), top = Math.min(p[1] + 14, this.map.h - 80);
    tip.style.transform = `translate(${left}px, ${top}px)`;
    tip.classList.add('show');
    if (changed) this.map.requestOverlay();
  }

  describe(hit) {
    const ds = this.ds, a = ds.a;
    switch (hit.kind) {
      case 'line': return { title: ds.lineTitle(hit.id), sub: `${ds.lineSubtitle(hit.id)} · ${ds.lineNature(hit.id).label}`, grade: a.l_grade[hit.id], score: a.l_score[hit.id] };
      case 'stop': return { title: ds.groupName[hit.id], sub: `${ds.regionLabel(a.g_region[hit.id])} · 노선 ${a.g_nlines[hit.id]}개`, grade: a.g_grade[hit.id], score: a.g_score[hit.id] };
      case 'segment': return { title: `${ds.groupName[a.s_a[hit.id]]} ↔ ${ds.groupName[a.s_b[hit.id]]}`, sub: '도로 구간', grade: a.s_grade[hit.id], score: a.s_score[hit.id] };
      case 'region': { const row = ds.sigunguByRegion.get(hit.id); return { title: ds.regionLabel(hit.id), sub: '시군구', grade: row.grade, score: row.score }; }
      case 'grid': return a.gr_grade[hit.id] === 4 ? { title: '정류장 없는 격자', sub: '서비스 공백', grade: null } : { title: '5km 격자', sub: `정류장 ${a.gr_n[hit.id]}곳`, grade: a.gr_grade[hit.id], score: a.gr_score[hit.id] };
      default: return { title: '', sub: '' };
    }
  }

  onMapClick(x, y) {
    this.hideChooser();
    const hits = this.hitTest(x, y);
    if (!hits.length) { if (this.selection || this.journeyResult) this.clearSelection(); return; }
    const close = hits.filter((h) => h.d <= hits[0].d + 3);
    // 이미 선택한 것을 다시 누르면 선택 해제(겹친 곳이어도 후보 목록 없이)
    const sel = this.selection;
    if (sel && close.some((h) => h.kind === sel.kind && h.id === sel.id)) { this.clearSelection(); return; }
    if (close.length > 1 && (hits[0].kind === 'line' || hits[0].kind === 'segment' || hits[0].kind === 'stop')) {
      this.showChooser(x, y, hits.slice(0, 8));
      return;
    }
    this.select(hits[0].kind, hits[0].id);
  }

  /** 겹친 곳을 누르면 후보 목록을 보여준다 */
  showChooser(x, y, hits) {
    const el = $('#chooser');
    el.innerHTML = `<div class="chooser-head">이 지점의 ${LAYER_INFO[this.state.mode].name} ${hits.length}개</div>` +
      hits.map((h, i) => { const d = this.describe(h); return `<button data-i="${i}"><span class="dot g${d.grade}">${Style.shapes[d.grade]}</span><span><b>${Util.esc(d.title)}</b><small>${Util.esc(d.sub)}</small></span></button>`; }).join('');
    el.style.transform = `translate(${Math.min(x + 8, this.map.w - 270)}px, ${Math.min(y + 8, this.map.h - 60 - hits.length * 46)}px)`;
    el.classList.add('show');
    el.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; const h = hits[Number(b.dataset.i)]; this.hideChooser(); this.select(h.kind, h.id); };
    el.onmousemove = (e) => { const b = e.target.closest('button'); if (b) { this.hover = hits[Number(b.dataset.i)]; this.map.requestOverlay(); } };
  }
  hideChooser() { $('#chooser').classList.remove('show'); }

  // ------------------------------------------------------------------ 선택·패널
  selectHit(hit) { this.select(hit.kind, hit.id); }

  select(kind, id, { fit = true, push = true } = {}) {
    // 목록에서 다른 종류를 골라도 지도가 그 레이어로 바뀌어야 대상이 보인다
    const mode = App.modeOf(kind);
    if (mode && mode !== this.state.mode) this.setMode(mode, { keepSelection: true });
    if (kind === 'grid' && this.state.regionSub !== 'grid') this.setRegionSub('grid', { keepSelection: true });
    if (kind === 'region' && this.state.regionSub !== 'sigungu') this.setRegionSub('sigungu', { keepSelection: true });
    this.selection = { kind, id };
    this.sim = null;
    this.journeyResult = null;
    this.showView({ kind, id }, { push });
    this.updateFocusClass();
    this.openRight();                       // 패널을 먼저 열어야 맞춤 여백에 패널 폭이 반영된다
    if (fit) requestAnimationFrame(() => this.fitTo(kind, id));
    this.setHash(kind, id);
  }

  clearSelection() {
    this.selection = null;
    this.sim = null;
    this.journeyResult = null;
    this.hover = null;
    this.updateFocusClass();
    this.showView({ kind: 'home' });
    if (this.isRightOverlay()) this.setRightOpen(false);      // 서랍이 지도를 계속 덮지 않게
    if (this._leftAutoClosed && this.root.dataset.left === 'closed') this.togglePanel('left');
    this._leftAutoClosed = false;
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  }

  back() {
    if (this.history.length < 2) { this.clearSelection(); return; }
    this.history.pop();
    const prev = this.history[this.history.length - 1];
    if (prev.kind === 'home') { this.selection = null; this.sim = null; this.journeyResult = null; this.updateFocusClass(); this.showView(prev, { push: false }); return; }
    if (prev.kind === 'journey') { this.showView(prev, { push: false }); return; }
    this.select(prev.kind, prev.id, { push: false });   // 레이어 전환·맞춤까지 선택과 같은 경로로
  }

  showView(view, { push = true } = {}) {
    if (push) {
      const last = this.history[this.history.length - 1];
      if (!last || last.kind !== view.kind || last.id !== view.id) this.history.push(view);
      if (this.history.length > 30) this.history.shift();
    }
    if (view.kind === 'home') this.history = [view];
    const P = this.panel;
    const html = {
      home: () => P.home(this), line: () => P.line(view.id), stop: () => P.stop(view.id), segment: () => P.segment(view.id),
      region: () => P.region(view.id), grid: () => P.grid(view.id), journey: () => view.html,
    }[view.kind]();
    $('#detail').innerHTML = html;
    $('#detail').scrollTop = 0;
    $('#backBtn').hidden = this.history.length < 2;
    $('#closeBtn').hidden = view.kind === 'home';
    this.map.requestOverlay();
  }

  fitTo(kind, id) {
    const ds = this.ds, a = ds.a, pad = this.fitPadding();
    if (kind === 'line') { const b = ds.lineBox; this.map.fitBox(b[id * 4], b[id * 4 + 1], b[id * 4 + 2], b[id * 4 + 3], pad); }
    else if (kind === 'stop') { const d = 0.8 / 256 / 2 ** 7; this.map.fitBox(ds.gx[id] - d, ds.gy[id] - d, ds.gx[id] + d, ds.gy[id] + d, pad); }
    else if (kind === 'segment') {
      const ga = a.s_a[id], gb = a.s_b[id], d = 0.4 / 256 / 2 ** 7;
      this.map.fitBox(Math.min(ds.gx[ga], ds.gx[gb]) - d, Math.min(ds.gy[ga], ds.gy[gb]) - d, Math.max(ds.gx[ga], ds.gx[gb]) + d, Math.max(ds.gy[ga], ds.gy[gb]) + d, pad);
    } else if (kind === 'region') { const b = ds.regionShapes[id].box; this.map.fitBox(b[0], b[1], b[2], b[3], pad); }
    else if (kind === 'grid') { const b = ds.gridBox(id); this.map.fitBox(b[0], b[1], b[2], b[3], pad); }
  }

  setHash(kind, id) {
    const ds = this.ds;
    const value = kind === 'line' ? `line=${encodeURIComponent(ds.lineIds[id])}` : kind === 'region' ? `region=${ds.regions[id].code}`
      : kind === 'stop' ? `stop=${id}` : kind === 'segment' ? `segment=${id}` : '';
    if (value) history.replaceState(null, '', `#${value}`);
  }

  applyHash() {
    const m = location.hash.match(/^#(line|stop|region|segment)=(.+)$/);
    if (!m) return;
    const [, kind, raw] = m;
    const value = decodeURIComponent(raw);
    let id = -1;
    if (kind === 'line') id = this.ds.lineIds.indexOf(value);
    else if (kind === 'region') id = this.ds.regions.findIndex((r) => r.code === value);
    else id = Number(value);
    if (id >= 0 && (kind !== 'region' || this.ds.sigunguByRegion.has(id))) this.select(kind, id, { push: true });
  }

  // ------------------------------------------------------------------ 패널 버튼
  async onDetailAction(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act, id = Number(b.dataset.id);
    const selectMap = { 'select-line': 'line', 'select-stop': 'stop', 'select-region': 'region', 'select-segment': 'segment' };
    if (selectMap[act]) { this.select(selectMap[act], id); return; }
    if (act === 'clear-journey') { this.clearSelection(); return; }
    if (act === 'portfolio') { $('#portfolio').innerHTML = this.panel.portfolio(id); return; }
    if (act === 'apply-policy') { await this.applyRecommendedPolicy(id); return; }
    if (act === 'pf-filter') {                       // 목록만 바꿔 다시 그린다(선택한 예산 유지)
      this.panel.portfolioRuralOnly = id === 1;
      const bi = Number(document.querySelector('[data-act=portfolio][aria-pressed=true]')?.dataset.id || 2);
      $('#portfolio').innerHTML = this.panel.portfolio(bi);
      return;
    }
    if (act === 'csv-national') { this.exportCsv('national'); return; }
    if (act === 'csv-region') { this.exportCsv('region', id); return; }
    const run = async (label, fn) => {
      const old = b.textContent;
      b.disabled = true; b.textContent = label;
      try { await this.engine.ready; await fn(); } catch (err) { console.error(err); this.toast(`계산 오류: ${err.message}`); }
      finally { b.disabled = false; b.textContent = old; }
    };
    if (act === 'stress') await run('제거 후 전국 그래프 재계산 중…', () => this.runLineStress(id));
    else if (act === 'policy') await run('계산 중…', () => this.runLinePolicy(id, b.dataset.kind));
    else if (act === 'stress-stop') await run('계산 중…', () => this.runStopStress(id));
    else if (act === 'policy-stop') await run('계산 중…', () => this.runStopPolicy(id));
    else if (act === 'stress-seg') await run('계산 중…', () => this.runSegmentStress(id));
  }

  /** 시뮬레이션 결과가 패널 아래쪽에 생기므로 결과 카드로 스크롤 */
  revealResult() {
    const el = $('#simResult');
    if (el && el.firstElementChild) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** 목록 CSV(엑셀용): 전국 매우 취약 노선·정류장, 또는 시군구 하나의 모든 노선·정류장 */
  exportCsv(scope, region = null) {
    const ds = this.ds, a = ds.a, names = this.params.grades.names;
    const rows = [['종류', '이름', '설명', '시도', '시군구', '취약도', '등급', '전국 순위', '비고']];
    const reg = (r) => ds.regions[r] || { sido: '', name: '' };
    const lineRow = (l) => ['노선', ds.lineLabel(l), ds.lineSubtitle(l), reg(a.l_region[l]).sido, reg(a.l_region[l]).name,
      a.l_score[l].toFixed(1), names[a.l_grade[l]], ds.lineRank.rank[l], a.l_grade[l] >= 2 ? ds.lineNature(l).label : ''];
    const stopRow = (g) => ['정류장', ds.groupName[g], `노선 ${a.g_nlines[g]}개`, reg(a.g_region[g]).sido, reg(a.g_region[g]).name,
      a.g_score[g].toFixed(1), names[a.g_grade[g]], ds.stopRank.rank[g], a.g_nearest[g] > 800 ? '800m 안에 다른 정류장 없음' : ''];
    const pick = (n, gradeArr, regionArr) => [...Array(n).keys()].filter((i) => (scope === 'national' ? gradeArr[i] === 3 : regionArr[i] === region));
    pick(ds.L, a.l_grade, a.l_region).sort((x, y) => a.l_score[y] - a.l_score[x]).forEach((l) => rows.push(lineRow(l)));
    pick(ds.G, a.g_grade, a.g_region).sort((x, y) => a.g_score[y] - a.g_score[x]).forEach((g) => rows.push(stopRow(g)));
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = '\ufeff' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    link.download = scope === 'national' ? '섬이되는길_전국_매우취약_목록.csv' : `섬이되는길_${ds.regionLabel(region).replace(/\s+/g, '_')}_목록.csv`;
    link.click();
    this.toast(`${Util.fmt(rows.length - 1)}줄을 내려받았어요(엑셀에서 열 수 있어요).`);
  }

  /** AI 포트폴리오 항목: 그 노선으로 가서 제거 시뮬레이션 → 추천 정책(같은 강도)을 차례로 계산 */
  async applyRecommendedPolicy(k) {
    const it = this.ds.policy.items[k];
    if (!this.isSelected('line', it.line)) this.select('line', it.line);
    await this.engine.ready;
    await this.runLineStress(it.line);
    await this.runLinePolicy(it.line, it.kind, it.opt || {}, it.parts || null, `AI 추천: ${it.label}`);
    const target = $('#policyResult');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /** 노선 영향 인구는 파이프라인 값(항로는 섬 전체 인구로 보정)을 써서 지도 점수와 같은 공식으로 맞춘다 */
  withStoredLineAffected(l, result) {
    if (result && this.ds.a.l_affected) result.affectedPopulation = this.ds.a.l_affected[l];
    return result;
  }

  async runLineStress(l) {
    const r = this.withStoredLineAffected(l, await this.engine.call('line', { line: l }));
    if (!this.isSelected('line', l)) return;
    this.sim = { pairs: this.pairPaths(l, r.details.pairs), stranded: r.details.stranded };
    $('#simResult').innerHTML = this.panel.lineStress(l, r);
    this.revealResult();
    this.map.requestOverlay();
  }

  /** parts: 정책 조합(예: [{kind:'drt',opt}, {kind:'frequency',opt}]). label: 결과 카드 제목 */
  async runLinePolicy(l, kind, opt = {}, parts = null, label = null) {
    const r = parts ? await this.engine.call('linePolicyCombo', { line: l, parts })
      : await this.engine.call('linePolicy', { line: l, kind, opt });
    if (label) r.policy.label = label;
    this.withStoredLineAffected(l, r.before); this.withStoredLineAffected(l, r.after);
    if (!this.isSelected('line', l)) return;
    const res = r.after || r.before;      // 정책 적용 후 남는 영향(지연·단절)을 같은 방식으로 표시
    this.sim = { pairs: this.pairPaths(l, res.details.pairs), stranded: res.details.stranded, links: r.policy.links };
    $('#policyResult').innerHTML = this.panel.linePolicy(r);
    this.map.requestOverlay();
  }

  /** 엔진은 '영향 규모'를 계산하지 않으므로(인구·운행 규모는 폐쇄해도 그대로) 저장값을 붙여 지도 점수와 같은 공식으로 맞춘다 */
  withStoredAffected(g, result) {
    const k = this.ds.meta.keys.stop.indexOf('affected_population');
    if (k >= 0 && result) result.components.affected_population = this.ds.comp('stop', g)[k];
    return result;
  }

  async runStopStress(g) {
    const r = this.withStoredAffected(g, await this.engine.call('stop', { group: g }));
    if (!this.isSelected('stop', g)) return;
    this.sim = { group: g, alternative: r.details.alternative };
    $('#simResult').innerHTML = this.panel.stopStress(g, r, null);
    this.revealResult();
    this.map.requestOverlay();
  }

  async runStopPolicy(g) {
    const r = await this.engine.call('stopPolicy', { group: g, meters: 100 });
    this.withStoredAffected(g, r.before); this.withStoredAffected(g, r.after);
    if (!this.isSelected('stop', g)) return;
    $('#simResult').innerHTML = this.panel.stopStress(g, r.before, r);
    this.revealResult();
  }

  async runSegmentStress(s) {
    const a = this.ds.a;
    const r = await this.engine.call('segment', { a: a.s_a[s], b: a.s_b[s] });
    if (!this.isSelected('segment', s)) return;
    this.sim = { legs: r.details.detourLegs || [] };
    $('#simResult').innerHTML = this.panel.segmentStress(r);
    this.revealResult();
    this.map.requestOverlay();
  }

  isSelected(kind, id) { return this.selection && this.selection.kind === kind && this.selection.id === id; }

  // ------------------------------------------------------------------ 검색
  bindSearch(input, box, opts, onPick) {
    let items = [], active = -1;
    const render = () => {
      if (!items.length) {
        const q = input.value.trim();
        if (!q) { box.classList.remove('show'); return; }
        const what = opts.kinds.length === 1 ? '정류장·역' : '정류장·노선·시군구';
        box.innerHTML = `<div class="search-empty">‘${Util.esc(q)}’ 검색 결과가 없습니다. ${what} 이름의 일부만 띄어쓰기 없이 입력해 보세요.</div>`;
        box.classList.add('show');
        return;
      }
      const ds = this.ds, a = ds.a;
      box.innerHTML = items.map((h, i) => {
        const d = h.kind === 'region' ? { title: ds.regionLabel(h.id), sub: '시군구', grade: ds.sigunguByRegion.get(h.id)?.grade ?? 0 }
          : h.kind === 'line' ? { title: ds.lineTitle(h.id), sub: ds.lineSubtitle(h.id), grade: a.l_grade[h.id] }
          : { title: ds.groupName[h.id], sub: `${ds.regionLabel(a.g_region[h.id])} · 노선 ${a.g_nlines[h.id]}개`, grade: a.g_grade[h.id] };
        const tag = { stop: '정류장', line: '노선', region: '지역' }[h.kind];
        return `<button class="${i === active ? 'active' : ''}" data-i="${i}"><em>${tag}</em><span><b>${Util.esc(d.title)}</b><small>${Util.esc(d.sub)}</small></span><span class="dot g${d.grade}">${Style.shapes[d.grade]}</span></button>`;
      }).join('');
      box.classList.add('show');
    };
    const update = Util.debounce(() => { items = this.ds ? this.ds.search(input.value, opts) : []; active = -1; render(); }, 110);
    const pick = (i) => { const h = items[i]; if (!h) return; box.classList.remove('show'); onPick(h); };
    input.addEventListener('input', update);
    input.addEventListener('focus', () => { if (input.value) update(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = Util.clamp(active + (e.key === 'ArrowDown' ? 1 : -1), 0, items.length - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(active >= 0 ? active : 0); }
      else if (e.key === 'Escape') box.classList.remove('show');
    });
    box.addEventListener('mousedown', (e) => { const b = e.target.closest('button'); if (b) { e.preventDefault(); pick(Number(b.dataset.i)); } });
    input.addEventListener('blur', () => setTimeout(() => box.classList.remove('show'), 150));
  }

  // ------------------------------------------------------------------ 경로 회복력
  async runJourney() {
    const start = this.journeyPick.start, end = this.journeyPick.end;
    if (start == null || end == null) { this.toast('출발·도착 정류장을 목록에서 골라 주세요'); return; }
    if (start === end) { this.toast('출발과 도착이 같습니다'); return; }
    const btn = $('#journeyBtn');
    btn.disabled = true; btn.textContent = '경로와 대체 경로 계산 중…';
    try {
      await this.engine.ready;
      const res = await this.engine.call('journey', { start, end });
      this.selection = null; this.sim = null;
      this.journeyResult = res ? { ...res, start, end } : null;
      const html = this.panel.journey(res, this.ds.groupName[start], this.ds.groupName[end]) +
        '<div class="action-row"><button class="btn" data-act="clear-journey">경로 지우기</button></div>';
      this.showView({ kind: 'journey', id: `${start}-${end}`, html });
      this.updateFocusClass();
      this.openRight();
      if (res) {
        const ds = this.ds;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const leg of res.best.legs) for (const g of [leg.from, leg.to]) { x0 = Math.min(x0, ds.gx[g]); x1 = Math.max(x1, ds.gx[g]); y0 = Math.min(y0, ds.gy[g]); y1 = Math.max(y1, ds.gy[g]); }
        this.map.fitBox(x0, y0, x1, y1, this.fitPadding());
      }
    } catch (err) { this.toast(`경로 계산 오류: ${err.message}`); }
    finally { btn.disabled = false; btn.textContent = '경로 회복력 분석'; }
  }

  // ------------------------------------------------------------------ 범례
  renderLegend() {
    const mode = this.state.mode, th = this.ds.meta.thresholds;
    const key = { region: this.state.regionSub === 'grid' ? 'grid' : 'sigungu', line: 'line', stop: 'stop', segment: 'segment' }[mode];
    const t = th[key];
    const rows = this.params.grades.names.map((n, i) => `<div class="lg-row"><span class="swatch g${i}"><i></i>${Style.shapes[i]}</span>${n}</div>`).join('');
    const extra = [];
    if (mode === 'region' && this.state.regionSub === 'grid') extra.push('<div class="lg-row"><span class="swatch gap"></span>정류장 없음</div>');
    if (this.state.senior) extra.push(`<div class="lg-row"><span class="swatch senior"></span>고령 ${this.ds.seniorHighlightPct}%↑ 시군구</div>`);
    if (mode === 'region' && this.state.regionSub === 'sigungu') extra.push('<div class="lg-row lg-empty"><span class="swatch none"></span>색 없는 곳: 호수·간척지 등 통계 경계 밖(거주 인구 없음)</div>');
    if (mode === 'line') extra.push('<div class="lg-note">노선을 누르면 위험 성격(고립·지연) 표시</div>');
    $('#legendBody').innerHTML = `${rows}${extra.join('')}<div class="lg-note">등급 경계: 취약도 ${t.map((x) => x.toFixed(1)).join(' · ')}점<br>(전국 상위 50·20·5%)</div>`;
    const tileCredit = BASEMAPS[this.map ? this.map.basemap : 'carto'].attribution;
    $('#attribution').textContent = tileCredit ? `KTDB GTFS · ${tileCredit}` : 'KTDB GTFS · 행정구역 2026(2025.7 행정동 경계 재구성)';
  }

  // ------------------------------------------------------------------ 이미지 저장
  async exportMap() {
    const layerName = { region: this.state.regionSub === 'grid' ? '지역(격자)' : '지역(시군구)', line: '노선', stop: '정류장', segment: '구간' }[this.state.mode];
    const title = this.selection ? this.describe(this.selection).title : `전국 ${layerName} 취약도`;
    const url = await this.map.exportPNG((ctx, w, h, attribution) => {
      ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fillRect(16, 16, Math.min(w - 32, 420), 58);
      ctx.fillStyle = '#131a26'; ctx.font = '800 18px system-ui, sans-serif'; ctx.fillText(title, 28, 42);
      ctx.fillStyle = '#5b6475'; ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(`섬이 되는 길 · 취약도(TVS) · ${layerName} · 전국 순위 등급(상위 50·20·5%)`, 28, 62);
      const lx = 16, ly = h - 16 - 4 * 22 - 20;
      ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.fillRect(lx, ly, 150, 4 * 22 + 20);
      this.params.grades.names.forEach((n, i) => {
        ctx.fillStyle = Style.colors[i]; ctx.fillRect(lx + 12, ly + 14 + i * 22, 22, 10);
        ctx.fillStyle = '#131a26'; ctx.font = '12px system-ui, sans-serif'; ctx.fillText(`${Style.shapes[i]} ${n}`, lx + 42, ly + 23 + i * 22);
      });
      ctx.fillStyle = '#5b6475'; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(`KTDB GTFS ${attribution}`, w - 12, h - 10); ctx.textAlign = 'left';
    });
    const link = document.createElement('a');
    link.href = url; link.download = `섬이되는길_${layerName}.png`;
    link.click();
    this.toast('지도 이미지를 저장했습니다');
  }

  /** 표시 설정 스위치를 코드에서 켜고 끈다(발표 모드 등) — 화면 표시도 함께 맞춘다 */
  setToggle(key, on) {
    const t = this._toggles?.[key];
    if (!t || this.state[key] === on) return;
    this.state[key] = on;
    $(t.id).setAttribute('aria-pressed', String(on));
    t.after();
  }

  // ------------------------------------------------------------------ 발표 모드
  startTour() {
    const ds = this.ds, a = ds.a;
    const topOfCluster = (name) => {
      const k = ds.meta.clusters.findIndex((c) => c.name === name);
      let best = -1;
      for (let l = 0; l < ds.L; l++) if (a.l_cluster[l] === k && (best < 0 || a.l_score[l] > a.l_score[best])) best = l;
      return best;
    };
    const ferry = topOfCluster('섬·해상 항로형'), rural = topOfCluster('농어촌 말단 고립형');
    const region = [...ds.sigungu].sort((x, y) => y.score - x.score)[0].region;
    this.tour = { i: 0, steps: [
      { title: '1. 전국 어디가 취약한가', text: '초록(안정)에서 검정(매우 취약)까지, 정류장·노선이 끊겼을 때 이동이 무너지는 정도입니다. 고령 비율이 높은 지역을 함께 봅니다.',
        run: async () => { this.setMode('region'); this.setRegionSub('sigungu'); this.clearSelection(); this.setToggle('senior', true); this.map.home(); } },
      { title: '2. 가장 취약한 시군구', text: `${ds.regionLabel(region)} — 취약 정류장 비율과 고령 비율이 모두 높은 곳입니다.`,
        run: async () => { this.setMode('region'); this.select('region', region); } },
      { title: '3. 농어촌 말단 노선이 끊기면', text: `${ds.lineLabel(rural)} — 이 노선 하나가 멈추면 주변 정류장이 섬이 됩니다.`,
        run: async () => { this.setMode('line'); this.select('line', rural); await this.engine.ready; await this.runLineStress(rural); } },
      { title: '4. DRT 를 넣으면 얼마나 회복되나', text: '수요응답형 교통(DRT)을 투입했을 때 취약도와 이동시간이 어떻게 달라지는지 비교합니다.',
        run: async () => { await this.engine.ready; await this.runLinePolicy(rural, 'drt'); } },
      { title: '5. 섬으로만 남는 항로', text: `${ds.lineTitle(ferry)} — 버스·철도로는 본토와 이어지지 않아, 이 항로가 끊기면 대체 수단이 없습니다.`,
        run: async () => { this.setMode('line'); this.select('line', ferry); await this.engine.ready; await this.runLineStress(ferry); } },
      { title: '6. 예산 안에서 어디부터', text: 'AI 가 정책 조합 12만여 개 중에서 예산 대비 고립을 가장 많이 막는 조합을 고릅니다.',
        run: async () => { this.clearSelection(); this.showView({ kind: 'home' }); setTimeout(() => document.querySelector('[data-act=portfolio]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 400); } },
    ] };
    this.renderTour();
  }

  renderTour() {
    const card = $('#tourCard');
    if (!this.tour) { card.classList.remove('show'); return; }
    const { i, steps } = this.tour, s = steps[i];
    card.innerHTML = `<div class="tour-steps">${steps.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
      <b>${Util.esc(s.title)}</b><p>${Util.esc(s.text)}</p>
      <div class="tour-actions"><button class="btn" data-t="prev" ${i === 0 ? 'disabled' : ''}>이전</button>
      <button class="btn primary" data-t="next">${i === steps.length - 1 ? '끝내기' : '다음'}</button><button class="btn ghost" data-t="close">닫기</button></div>`;
    card.classList.add('show');
    card.onclick = (e) => {
      const t = e.target.closest('[data-t]')?.dataset.t;
      if (t === 'close' || (t === 'next' && i === steps.length - 1)) { this.tour = null; this.renderTour(); return; }
      if (t === 'prev') this.tour.i--; else if (t === 'next') this.tour.i++; else return;
      this.renderTour();
    };
    s.run().catch((err) => this.toast(err.message));
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const params = JSON.parse(document.getElementById('seomParams').textContent);
  window.seomApp = new App(params);
  window.seomApp.start();
});
