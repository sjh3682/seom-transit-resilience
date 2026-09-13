/* =============================================================================
   05_panels.js — 오른쪽 분석 패널의 HTML 조립
   상태를 바꾸지 않는 순수 렌더링만 담당한다. 버튼은 data-act 속성으로 표시하고
   이벤트는 App 이 패널 전체에 한 번만 위임(delegation)해서 처리한다.
   ============================================================================= */
'use strict';

const TVS_HELP = '취약도(TVS, Transit Vulnerability Score): 이 대상이 멈추거나 끊겼을 때 사람들의 이동이 얼마나 무너지는지를 0~100점으로 나타낸 점수예요(높을수록 위험). 이동시간 증가·갈 수 있는 병원·역 감소·대체경로 부족·끊기는 이동·영향 인구 5가지를 합쳐 계산하고, 전국 순위로 안정(하위 50%)·주의·취약·매우 취약(상위 5%)을 나눠요.';

const SENIOR_LABEL = {
  mois_dong: '65세 이상 비율(행정동)', mois_sigungu: '65세 이상 비율(시군구)', mois_sido: '65세 이상 비율(시도)',
  sigungu: '65세 이상 비율(시군구)', sido_fallback: '65세 이상 비율(시도 임시값)',
};

const COMPONENT_LABELS = {
  line: {
    time_increase: ['이동시간 증가', '표본 구간을 제거 전·후로 비교한 최단 소요시간 증가율(+100%에서 상한, 단절 포함)'],
    access_loss: ['갈 수 있는 병원·역 감소', '60분 안에 닿는 병원·약국·철도역·터미널·항만·공항 수의 감소율'],
    no_alternative: ['대체경로 부족', '도보 400m 안에 다른 노선이 없어 이 노선에만 의존하는 정류장의 비중'],
    connectivity: ['끊기는 이동', '제거 시 끊기거나 2배 이상 돌아가야 하는 이동의 비중 + 이 노선이 운행 90% 이상을 맡는 구간 비중'],
    affected_population: ['영향 규모', '정류장별 이 노선 의존도(운행 비중) × 인구 가중치의 전국 백분위'],
  },
  stop: {
    walk_penalty: ['도보 부담', '대체 정류장(400m 환승권, 없으면 800m 이내)까지 더 걸어야 하는 시간 — 12분이면 최대, 800m 안에도 없으면 고립'],
    access_loss: ['갈 수 있는 병원·역 감소', '폐쇄 후 대체 정류장까지 걸어가서 출발할 때 60분 안에 닿는 병원·약국·역 감소율'],
    line_loss: ['노선 손실', '도보권 다른 정류장에서 탈 수 없게 되는 노선 비중'],
    transfer_break: ['환승 단절', '이 정류장에서만 만나는 노선 쌍의 비중(환승 거점에서만 의미)'],
    affected_population: ['영향 인구', '정류장 도보권 인구의 전국 백분위(인구 파일이 없으면 하루 운행횟수로 대신)'],
  },
  segment: {
    detour: ['우회 시간', '이 구간이 끊겼을 때 두 정류장 사이 추가 소요시간(30분이면 최대)'],
    affected_volume: ['영향 운행량', '이 구간을 지나는 하루 운행횟수의 전국 백분위'],
    affected_lines_risk: ['영향 노선 위험도', '이 구간을 지나는 노선 중 가장 높은 취약도'],
  },
};

const Html = {
  badge(grade, text) { return `<span class="grade-badge g${grade}">${Style.shapes[grade]} ${Util.esc(text ?? Style.names[grade])}</span>`; },
  bar(label, value, hint, cls = '') {
    const pct = Util.clamp(value ?? 0, 0, 1) * 100;
    return `<div class="bar-row ${cls}" title="${Util.esc(hint || '')}"><span class="bar-label">${Util.esc(label)}</span>
      <span class="bar-track"><i style="width:${pct.toFixed(1)}%"></i></span><span class="bar-value">${value == null ? '—' : pct.toFixed(0) + '%'}</span></div>`;
  },
  metric(value, label) { return `<div class="metric"><b>${value}</b><span>${Util.esc(label)}</span></div>`; },
  item(act, id, title, sub, grade, score) {
    return `<button class="list-item" data-act="${act}" data-id="${id}">
      <span class="dot g${grade}">${Style.shapes[grade]}</span>
      <span class="li-main"><b>${Util.esc(title)}</b><small>${Util.esc(sub)}</small></span>
      <span class="li-score">${score == null ? '' : Number(score).toFixed(1)}</span></button>`;
  },
  section(title, body, extra = '') { return `<section class="d-section ${extra}"><h3>${title}</h3>${body}</section>`; },
  note(text, cls = '') { return `<p class="note ${cls}">${text}</p>`; },
};

class DetailPanel {
  constructor(ds) { this.ds = ds; }

  header({ eyebrow, title, sub, score, grade, rank, total, unit = '취약도', nature = null }) {
    const tag = nature ? `<span class="nature ${nature.key}" title="${Util.esc(nature.hint)}">${nature.label}</span>` : '';
    const scoreHtml = score == null ? '' : `<div class="score-line"><strong>${Number(score).toFixed(1)}</strong><span class="unit" title="${Util.esc(TVS_HELP)}">/ 100 ${unit} <i class="help">?</i></span>
      ${Html.badge(grade)}${tag}</div><div class="rank-line">${rank ? `전국 ${Util.fmt(total)}개 중 ${Util.fmt(rank)}위 · <b>${Util.topPercent(rank, total)}</b>` : ''}</div>
      ${nature ? `<div class="nature-hint">${Util.esc(nature.hint)}</div>` : ''}`;
    return `<div class="d-head"><div class="eyebrow">${Util.esc(eyebrow)}</div><h2>${Util.esc(title)}</h2>
      <div class="d-sub">${Util.esc(sub || '')}</div>${scoreHtml}</div>`;
  }

  components(kind, values) {
    const keys = this.ds.meta.keys[kind];
    const popMissing = this.ds.meta.source.population_source === 'none';
    return keys.map((k, i) => {
      const [label, hint] = COMPONENT_LABELS[kind][k];
      if (values[i] === undefined) return '';
      let lbl = label;
      if (k === 'affected_population' && popMissing) lbl = kind === 'line' ? '영향 규모(정류장 기준)' : '영향 규모(운행횟수 기준)';
      return Html.bar(lbl, values[i], hint);
    }).join('');
  }

  drivers(kind, id) {
    const list = this.ds.drivers(kind, id);
    if (!list.length) return '';
    const fmt = (value, unit) => {
      if (value == null) return '';
      if (unit === 'yn') return value >= 0.5 ? '예' : '아니오';
      const digits = unit === 'km' || (unit === '개' && Math.abs(value % 1) > 0.05) ? 1 : 0;
      return `${Util.fmt(value, digits)}${unit}`;
    };
    const rows = list.map((d) => {
      const up = d.points >= 0;
      const detail = d.value == null ? '' : d.unit === 'yn' ? fmt(d.value, d.unit)
        : `${fmt(d.value, d.unit)} <small>· 전국 중앙값 ${fmt(d.median, d.unit)}</small>`;
      return `<div class="driver ${up ? 'up' : 'down'}">
        <div class="driver-top"><span>${Util.esc(d.name)}</span><b>위험 ${up ? '+' : '−'}${Math.abs(d.points).toFixed(1)}점</b></div>
        ${detail ? `<div class="driver-val">${detail}</div>` : ''}</div>`;
    }).join('');
    return Html.section('왜 이 점수인가 <small>AI 설명 모델(SHAP)</small>', rows +
      Html.note('이 항목의 실제 값이 전국 평균적인 경우보다 점수를 얼마나 올렸는지(+) 내렸는지(−)를 보여줍니다.'));
  }

  /** 예산(버스 대·년 환산)별 AI 추천 정책 조합 */
  portfolio(bi) {
    const ds = this.ds, P = ds.policy, m = P.meta, b = P.budgets[bi];
    const people = m.population_source === 'none' ? '정류장' : '명';
    const kindName = { drt: 'DRT', extension: '노선 연장', frequency: '증편만', combo: '그중 증편 병행' };
    const chips = P.budgets.map((x, k) => `<button class="chip-toggle" data-act="portfolio" data-id="${k}" aria-pressed="${k === bi}">${x.budget}</button>`).join('');
    const cap = m.capture[bi];
    const co2 = b.co2_t_year;
    // 주제(섬·농어촌)에 해당하는 항목을 따로 센다 — 비용 대비 효과로 고르면 인구 많은 도시 근교가 앞에 오기 쉬워서,
    // 정책이 섬·농어촌에도 실제로 배정되는지 함께 보여준다.
    const RURAL = ['섬·해상 항로형', '농어촌 말단 고립형'];
    const ruralK = new Set(RURAL.map((n) => ds.meta.clusters.findIndex((c) => c.name === n)).filter((i) => i >= 0));
    const isRural = (k) => ruralK.has(ds.a.l_cluster[P.items[k].line]);
    const ruralItems = b.items.filter(isRural);
    const ruralPop = ruralItems.reduce((t, k) => t + (P.items[k].stranded_pop_saved || 0), 0);
    const only = this.portfolioRuralOnly ? ruralItems : b.items;
    const items = only.slice(0, 8).map((k) => {
      const it = P.items[k];
      return `<button class="list-item" data-act="apply-policy" data-id="${k}">
        <span class="dot g${ds.a.l_grade[it.line]}">${Style.shapes[ds.a.l_grade[it.line]]}</span>
        <span class="li-main"><b>${Util.esc(ds.lineLabel(it.line))}</b><small>${Util.esc(it.label)} · 취약도 ${it.tvs_before} → ${it.tvs_after}</small></span>
        <span class="li-score">+${Util.fmt(it.benefit, 0)}</span></button>`;
    }).join('');
    return `<div class="chip-row"><span>예산(${Util.esc(m.unit)})</span>${chips}</div>
      <div class="metric-grid">
        ${Html.metric(`${b.n}개`, `노선 (${['drt', 'extension', 'frequency', 'combo'].filter((k) => b.kinds[k]).map((k) => `${kindName[k]} ${b.kinds[k]}`).join(' · ')})`)}
        ${Html.metric(`${Util.fmt(b.stranded_pop_saved)}${people}`, people === '명' ? '노선이 끊겨도 고립되지 않게 보호되는 인구' : '고립에서 보호되는 정류장')}
        ${Html.metric(`${Util.fmt(co2[1])}t`, `CO₂ 감축/년 (범위 ${Util.fmt(co2[0])}~${Util.fmt(co2[2])})`)}
        ${Html.metric(`${Math.round(cap.share * 100)}%`, `AI가 계산 ${Math.round(cap.exact_evals_share * 100)}%로 찾은 최적 효과 (무작위 선택 ${Math.round(cap.random_30 * 100)}%)`)}
      </div>
      ${Html.note(`이 가운데 <b>섬·농어촌 노선 ${Util.fmt(ruralItems.length)}곳</b>(${Math.round(ruralItems.length / Math.max(1, b.n) * 100)}%)에 정책이 배정돼 ${Util.fmt(ruralPop)}${people}의 고립을 막습니다.`)}
      <div class="chip-row"><span>목록</span>
        <button class="chip-toggle" data-act="pf-filter" data-id="0" aria-pressed="${!this.portfolioRuralOnly}">전체</button>
        <button class="chip-toggle" data-act="pf-filter" data-id="1" aria-pressed="${!!this.portfolioRuralOnly}">섬·농어촌만</button></div>
      <div class="list">${items}</div>
      ${Html.note(m.search
        ? `후보 ${Util.fmt(m.n_candidates)}개(취약 노선 ${Util.fmt(m.n_lines)}개 × 정책 조합 ${m.combos_per_line}가지)를 모두 계산하면 약 ${Math.round(m.search.est_minutes_all)}분(1코어) 걸립니다. AI 대리모델이 후보를 추려 ${Math.round(m.search.ai_share * 100)}%만 정밀 계산(약 ${Math.round(m.search.est_minutes_ai)}분)하고, 무작위로 뽑은 노선 ${m.search.validation_lines}개의 전수 계산 정답과 비교해 포착률을 잽니다(보류 R² ${m.surrogate.r2_holdout}). 비용은 시내버스 1대 78.8만 원/일, DRT 1대 55.8만 원/일(국토교통부 DRT 가이드라인 2025.12·광주 표준운송원가)을 운행시간에 비례해 적용합니다 — 연 ${b.budget}억 원은 <b>DRT 약 ${Util.fmt(Math.round(b.budget * 1e8 / 558380 / 365))}대</b>를 1년 운행하는 규모입니다.`
        : `후보 ${Util.fmt(m.n_candidates)}개를 엔진으로 계산한 정답과 비교해 AI 대리모델의 포착률을 잽니다(보류 R² ${m.surrogate.r2_holdout}).`)}`;
  }

  lineRecommendation(l) {
    const ds = this.ds, k = ds.policyByLine.get(l);
    if (k == null) return '';
    const it = ds.policy.items[k];
    const unit = ds.policy.meta.unit;
    return `<div class="rec-card"><b>AI 추천 정책</b><span>${Util.esc(it.label)} — 보호 인구 ${Util.fmt(it.stranded_pop_saved)}명, 취약도 ${it.tvs_before} → ${it.tvs_after}, CO₂ ${Util.fmt(it.co2_t_year[1], 1)}t/년 감축, 비용 ${Util.fmt(it.cost, 2)} ${Util.esc(unit)}</span>
      <button class="btn" data-act="apply-policy" data-id="${k}">추천 정책 시뮬레이션</button></div>`;
  }

  // ---------------------------------------------------------------- 홈
  home(app) {
    const ds = this.ds, m = ds.meta, st = m.stats, src = m.source;
    // 처음 화면은 '무엇을 발견했나'(결론 숫자). 데이터 규모는 아래 신뢰도 칸에 한 줄로.
    const pct = ds.seniorHighlightPct;
    const veryRegions = ds.sigungu.filter((r) => r.grade === 3).length;
    const oldAndWeak = ds.sigungu.filter((r) => r.senior >= pct && r.grade >= 2).length;
    let isolating = 0;
    for (let l = 0; l < ds.L; l++) if (ds.a.l_grade[l] >= 2 && ds.lineNature(l).key === 'isolate') isolating++;
    const ps = src.population_stats || {}, ferry = m.ferry_affected || {};
    const pol = ds.policy && (ds.policy.budgets.find((b) => b.budget === 100) || ds.policy.budgets[2]);
    const kpis = `<div class="metric-grid findings">
      ${Html.metric(`${veryRegions}곳`, '교통이 "매우 취약"한 시군구')}
      ${Html.metric(`${oldAndWeak}곳`, `고령 ${pct}%↑이면서 교통도 취약한 시군구`)}
      ${Html.metric(`${Util.fmt(isolating)}개`, '끊기면 주민이 고립되는 취약 노선')}
      ${ferry.island_population ? Html.metric(`${Util.fmt(ferry.island_population)}명`, '버스·철도로 본토와 이어지지 않는 섬 주민') : ''}
      ${ps.dongs_without_stops != null ? Html.metric(`${Util.fmt(ps.population_without_stops)}명`, `정류장이 하나도 없는 동 ${ps.dongs_without_stops}곳에 사는 인구`) : ''}
      ${pol ? Html.metric(`${Util.fmt(pol.stranded_pop_saved)}명`, `AI 추천 정책(연 ${pol.budget}${ds.policy.meta.unit.startsWith('억') ? '억 원' : ''})으로 고립을 막는 인구`) : ''}
      ${pol ? Html.metric(`${Util.fmt(pol.co2_t_year[1])}t`, '같은 정책의 CO₂ 감축/년 (승용차 전환을 막아서)') : ''}</div>`;
    const scale = Html.note(`분석 규모: 원자료 정류장 ${Util.fmt(st.stops)} · 노선 ${Util.fmt(st.routes)} · 하루 운행 ${Util.fmt(st.trips)}회 → 정류장 ${Util.fmt(st.groups)}(양방향 묶음) · 노선 ${Util.fmt(st.lines)}(왕복·중복 통합) · 도로 구간 ${Util.fmt(st.segments)}`);

    const ORDER = ['섬·해상 항로형', '농어촌 말단 고립형', '장거리 단일축형', '도시 단일축형', '거점 접근 의존형'];
    const rank = (c) => { const i = ORDER.indexOf(c.name); return i < 0 ? 99 : i; };
    const typeCases = m.clusters.map((c, k) => [c, k]).sort((x, y) => rank(x[0]) - rank(y[0])).map(([c, k]) => {
      let best = -1;
      for (let l = 0; l < ds.L; l++) if (ds.a.l_cluster[l] === k && (best < 0 || ds.a.l_score[l] > ds.a.l_score[best])) best = l;
      return best < 0 ? '' : Html.item('select-line', best, ds.lineTitle(best), `${c.name} · ${ds.lineSubtitle(best)}`, ds.a.l_grade[best], ds.a.l_score[best]);
    }).join('');
    const topRegions = [...ds.sigungu].sort((x, y) => y.score - x.score).slice(0, 5)
      .map((r) => Html.item('select-region', r.region, ds.regionLabel(r.region), `취약 정류장 ${(r.vuln_share * 100).toFixed(0)}% · 매우 취약 노선 ${r.very_lines}개`, r.grade, r.score)).join('');

    const lm = m.line_model, sens = m.sensitivity, cmp = m.comparison_v6 || {};
    const trust = `<div class="trust">
      <div><b>R² ${lm.r2_cv}</b><span>AI 설명 모델 교차검증(노선)</span></div>
      <div><b>${(sens.top5_overlap_median * 100).toFixed(0)}%</b><span>가중치를 무작위로 200번 바꿔도 상위 5% 유지율</span></div>
      ${cmp.line_spearman_v6 != null ? `<div><b>${cmp.line_spearman_v6}</b><span>v6 정적 점수와의 순위상관 (상위 5% 겹침 ${(cmp.line_top5_overlap_v6 * 100).toFixed(0)}%)</span></div>` : ''}
    </div>`;

    const fac = src.facility_stats || {};
    const facText = fac.count
      ? `역·터미널 + 병원 ${Util.fmt(fac.hospitals)}곳 · 약국 ${Util.fmt(fac.pharmacies)}곳(심평원, 치과·한의 제외)`
      : src.destination_source.includes('hospitals') ? '역·터미널·항만·공항 + 병원' : '역·터미널·항만·공항(병원 파일 미연결)';
    const popText = { mois_dong: '행정안전부 행정동 주민등록인구', population_grid: '격자 인구', none: '미연결 → 정류장 그룹 단위로 가중' }[src.population_source] || src.population_source;
    const senText = { mois_dong: '행정동 단위(행정안전부)', mois_sigungu: '시군구 단위(행정안전부)', mois_sido: '시도 단위(행정안전부 2026.8) — 행정동 파일 연결 시 행정동 단위', sigungu: '시군구 단위', sido_fallback: '시도 단위 임시값(20% 초과 9개 시도)' }[src.senior_source] || src.senior_source;
    const status = [
      ['소요시간', src.time_source === 'timetable' ? 'GTFS 시각표' : '거리·속도 추정(원본 GTFS 연결 시 시각표 사용)', src.time_source === 'timetable'],
      ['인구', popText, src.population_source !== 'none'],
      ['고령 비율', senText, !['sido_fallback', 'mois_sido'].includes(src.senior_source)],
      ['목적지(거점)', facText, src.destination_source.includes('hospitals')],
    ].map(([k, v, ok]) => `<li class="${ok ? 'ok' : 'warn'}"><b>${k}</b><span>${Util.esc(v)}</span></li>`).join('');

    return `${this.header({ eyebrow: 'NATIONWIDE RESILIENCE', title: '한 정류장이 멈추면, 지역은 섬이 된다', sub: '전국 대중교통에서 정류장·노선 하나가 멈추면 어디가 고립되는지 계산했어요. 지도에서 지역·노선·정류장·구간을 누르면 직접 끊어보고 대책을 비교할 수 있어요.' })}
      ${Html.section('한눈에 보는 결과', kpis)}
      ${Html.section('취약 유형별 대표 사례 <small>AI 군집</small>', `<div class="list">${typeCases}</div>`)}
      ${Html.section('가장 취약한 시군구', `<div class="list">${topRegions}</div>`)}
      ${ds.policy ? Html.section('AI 정책 포트폴리오 <small>예산 안에서 효과가 가장 큰 조합</small>', `<div id="portfolio">${this.portfolio(2)}</div>`) : ''}
      ${Html.section('분석 신뢰도', trust + scale)}
      <div class="action-row"><button class="btn" data-act="csv-national">전국 매우 취약 노선·정류장 목록 내려받기(CSV)</button></div>
      ${Html.section('데이터 연결 상태', `<ul class="status">${status}</ul>` + Html.note('주황 항목은 <code>data/external</code> 에 파일을 넣고 파이프라인을 다시 돌리면 자동으로 바뀝니다(README 참고).'))}`;
  }

  // ---------------------------------------------------------------- 노선
  line(l, sim) {
    const ds = this.ds, a = ds.a;
    const cluster = a.l_cluster[l] >= 0 ? ds.meta.clusters[a.l_cluster[l]] : null;
    const shared = ds.sharedLines(l, 8);
    const facts = `<div class="metric-grid">
      ${Html.metric(`${Util.fmt(a.l_trips[l], 1)}회`, '하루 운행(양방향 합)')}${Html.metric(`${Util.fmt(ds.lineGroups(l).length)}곳`, '정류장')}
      ${Html.metric(`${Util.fmt(a.l_length[l], 1)}km`, '대표 경로 길이')}${Html.metric(`${a.l_disc[l]} / ${a.l_pairs[l]}`, '표본 구간 중 단절·2배 우회')}</div>`;
    const sharedHtml = shared.length
      ? `<div class="list">${shared.map(([o, n]) => Html.item('select-line', o, ds.lineTitle(o), `${ds.lineSubtitle(o)} · 공유 정류장 ${n}곳`, a.l_grade[o], a.l_score[o])).join('')}</div>`
      : Html.note('정류장을 함께 쓰는 다른 노선이 없습니다 — 끊기면 대체 수단이 없다는 뜻입니다.', 'warn');
    return `${this.header({ eyebrow: 'LINE · 노선', title: ds.lineLabel(l), sub: ds.lineSubtitle(l), score: a.l_score[l], grade: a.l_grade[l], rank: ds.lineRank.rank[l], total: ds.L, nature: ds.lineNature(l) })}
      ${this.lineRecommendation(l)}
      ${cluster ? `<div class="type-chip"><b>${Util.esc(cluster.name)}</b><span>처방: ${Util.esc(cluster.policy)}</span></div>` : ''}
      ${Html.section('취약도 구성 <small>노선이 없어졌을 때의 변화</small>', this.components('line', ds.comp('line', l)))}
      ${this.drivers('line', l)}
      ${Html.section('기본 정보', facts + (ds.isLongDistance(l) ? Html.note('장거리 노선은 정차역 사이를 직선으로 이어 그렸습니다(실제 경로 아님).') : ''))}
      <div class="action-row"><button class="btn primary" data-act="stress" data-id="${l}">제거 시뮬레이션 보기</button></div>
      <div id="simResult">${sim || ''}</div>
      ${Html.section('정류장을 함께 쓰는 노선 <small>대체 수단</small>', sharedHtml)}`;
  }

  lineStress(l, r) {
    const ds = this.ds;
    const c = r.components;
    const pairs = r.details.pairs.map((p) => {
      const inc = p.after == null ? null : (p.after - p.before) / Math.max(1, p.before);
      return `<tr class="${p.after == null ? 'cut' : inc > 0.3 ? 'warn' : ''}"><td class="od-pair"><span>${Util.esc(ds.groupName[p.from])}</span><span>→ ${Util.esc(ds.groupName[p.to])}</span></td>
        <td>${Util.minutes(p.before)}</td><td>${p.after == null ? '<b>단절</b>' : Util.minutes(p.after)}</td></tr>`;
    }).join('');
    const tvs = ds.lineTvs(c, r.affectedPopulation);
    const cut = r.details.pairs.filter((p) => p.after == null).length;
    const slow = r.details.pairs.filter((p) => p.after != null && (p.after - p.before) / Math.max(1, p.before) > 0.3).length;
    const island = r.details.stranded.length;
    const n = r.details.pairs.length;
    const moves = cut && slow ? `표본 이동 ${n}개 중 <b>${cut}개가 끊기고 ${slow}개는 30% 이상 늦어져요.</b>`
      : cut ? `표본 이동 ${n}개 중 <b>${cut}개가 끊겨요.</b>`
      : slow ? `표본 이동 ${n}개 중 끊기는 건 없지만 <b>${slow}개는 30% 이상 늦어져요.</b>`
      : `표본 이동 ${n}개 중 끊기거나 크게 늦어지는 이동은 없어요.`;
    const summary = moves + (island ? ` 정류장 <b>${island}곳이 섬이 됩니다</b>(도보 400m 안에 다른 노선 없음, 지도의 검은 네모).` : '');
    return `<div class="sim-card">
      <div class="sim-head"><b>이 노선이 없어지면</b><span>다시 계산한 취약도 ${tvs.toFixed(1)}점</span></div>
      ${Html.note(summary, cut || island ? 'warn' : '')}
      ${this.components('line', [c.time_increase, c.access_loss, c.no_alternative, c.connectivity])}
      <div class="policy-buttons"><span>이 노선이 끊기면? — 대책 비교</span>
        <button class="btn" data-act="policy" data-kind="frequency" data-id="${l}">주변 노선 증편</button>
        <button class="btn" data-act="policy" data-kind="drt" data-id="${l}">DRT 투입</button>
        <button class="btn" data-act="policy" data-kind="extension" data-id="${l}">인접 노선 연장</button></div>
      <div id="policyResult"></div>
      <details class="more"><summary>표본 이동 자세히 보기 (${r.details.pairs.length}개)</summary>
        <table class="od"><thead><tr><th>표본 이동</th><th>제거 전</th><th>제거 후</th></tr></thead><tbody>${pairs}</tbody></table>
        <div class="map-key"><span class="k red"></span>단절·2배 이상 우회 <span class="k orange"></span>30% 이상 지연 <span class="k island"></span>섬이 되는 정류장 <small>(영향 없는 이동은 지도에 표시하지 않음)</small></div>
      </details></div>`;
  }

  linePolicy(res) {
    const ds = this.ds;
    const label = res.policy.label || { frequency: '주변 노선 증편', drt: 'DRT 투입', extension: '인접 노선 연장' }[res.policy.kind] || res.policy.kind;
    if (!res.after) return `<div class="policy-card"><b>${label}</b>${Html.note(Util.esc(res.policy.note), 'warn')}</div>`;
    const b = res.before, af = res.after;
    const row = (name, x, y, pct = true) => {
      const better = y < x - 1e-6;
      const f = (v) => (pct ? `${(v * 100).toFixed(0)}%` : v.toFixed(1));
      return `<tr><td>${name}</td><td>${f(x)}</td><td class="${better ? 'better' : ''}">${f(y)}</td></tr>`;
    };
    const tb = ds.lineTvs(b.components, b.affectedPopulation), ta = ds.lineTvs(af.components, af.affectedPopulation);
    return `<div class="policy-card"><b>${label}</b><span class="policy-note">${Util.esc(res.policy.note)}</span>
      <table class="od"><thead><tr><th>지표(노선 제거 시)</th><th>대안 없음</th><th>대안 적용</th></tr></thead><tbody>
      ${row('이동시간 증가', b.components.time_increase, af.components.time_increase)}
      ${row('접근 거점 감소', b.components.access_loss, af.components.access_loss)}
      ${row('대체경로 부족', b.components.no_alternative, af.components.no_alternative)}
      ${row('연결성 붕괴', b.components.connectivity, af.components.connectivity)}
      ${row('취약도', tb, ta, false)}</tbody></table>
      ${Html.note(`취약도 ${tb.toFixed(1)} → <b>${ta.toFixed(1)}</b>점 (${(tb - ta).toFixed(1)}점 개선). 지도에 추가된 연결은 보라색 점선입니다.`)}</div>`;
  }

  // ---------------------------------------------------------------- 정류장
  stop(g, sim) {
    const ds = this.ds, a = ds.a;
    const lines = ds.linesAtGroup(g).sort((x, y) => a.l_score[y] - a.l_score[x]);
    const senior = a.g_senior[g];
    const facts = `<div class="metric-grid">
      ${Html.metric(`${lines.length}개`, '서는 노선')}${Html.metric(`${Util.fmt(a.g_nearest[g])}m`, '가장 가까운 다른 정류장')}
      ${ds.meta.source.destination_source.includes('hospitals') && a.g_hosp ? Html.metric(`${a.g_hosp[g]}곳`, '도보 500m 안 병원') : Html.metric(a.g_dest[g] > 0 ? '예' : '아니오', '철도역·터미널·항만')}${Html.metric(senior >= 0 ? `${senior.toFixed(1)}%` : '—', SENIOR_LABEL[ds.meta.source.senior_source] || '65세 이상 비율')}</div>`;
    return `${this.header({ eyebrow: 'STOP · 정류장', title: ds.groupName[g], sub: `${ds.regionLabel(a.g_region[g])} · 원자료 정류장 ${a.g_members[g]}개 통합`, score: a.g_score[g], grade: a.g_grade[g], rank: ds.stopRank.rank[g], total: ds.G })}
      ${Html.section('취약도 구성 <small>이 정류장이 멈추면</small>', this.components('stop', ds.comp('stop', g)))}
      ${this.drivers('stop', g)}
      ${Html.section('기본 정보', facts)}
      <div class="action-row"><button class="btn primary" data-act="stress-stop" data-id="${g}">폐쇄 시뮬레이션 보기</button></div>
      <div id="simResult">${sim || ''}</div>
      ${Html.section('이 정류장의 노선', `<div class="list">${lines.slice(0, 12).map((l) => Html.item('select-line', l, ds.lineTitle(l), ds.lineSubtitle(l), a.l_grade[l], a.l_score[l])).join('')}</div>`)}`;
  }

  stopStress(g, r, policy) {
    const ds = this.ds, d = r.details, c = r.components;
    const alt = d.alternative >= 0 ? `${Util.esc(ds.groupName[d.alternative])} (도보 ${Util.minutes(d.extraWalkMin)})` : '도보권 대체 정류장 없음';
    let pol = '';
    if (policy) {
      const tb = ds.stopTvs(policy.before.components), ta = ds.stopTvs(policy.after.components);
      pol = `<div class="policy-card"><b>임시 정류장(100m 이내) 설치</b>${Html.note(`취약도 ${tb.toFixed(1)} → <b>${ta.toFixed(1)}</b>점. 도보 부담·노선 손실·환승 단절이 줄어듭니다.`)}</div>`;
    }
    const summary = d.alternative >= 0
      ? `가장 가까운 대체 정류장까지 <b>${Util.minutes(d.extraWalkMin)}</b> 더 걸어야 하고, 탈 수 없게 되는 노선이 <b>${d.lostLines.length}개</b>예요.`
      : `<b>걸어서 갈 대체 정류장이 없어</b> 이 정류장 주민은 섬이 됩니다. 탈 수 없게 되는 노선 <b>${d.lostLines.length}개</b>.`;
    return `<div class="sim-card"><div class="sim-head"><b>이 정류장이 멈추면</b><span>다시 계산한 취약도 ${ds.stopTvs(c).toFixed(1)}점</span></div>
      ${Html.note(summary, d.alternative >= 0 ? '' : 'warn')}
      ${this.components('stop', ds.meta.keys.stop.map((k) => c[k] ?? null))}
      <div class="kv"><span>대체 정류장</span><b>${alt}</b></div>
      <div class="kv"><span>탈 수 없게 되는 노선</span><b>${d.lostLines.length}개</b></div>
      <div class="kv"><span>60분 안에 갈 수 있는 병원·역</span><b>${Util.fmt(d.accessBefore)} → ${Util.fmt(d.accessAfter)}</b></div>
      ${d.transferPairs ? `<div class="kv"><span>끊기는 환승 조합</span><b>${d.brokenPairs} / ${d.transferPairs}</b></div>` : ''}
      <div class="policy-buttons"><span>이 정류장이 멈추면? — 대책 비교</span><button class="btn" data-act="policy-stop" data-id="${g}">임시 정류장 설치</button></div>
      <div id="policyResult">${pol}</div></div>`;
  }

  // ---------------------------------------------------------------- 구간
  segment(s, sim) {
    const ds = this.ds, a = ds.a, ga = a.s_a[s], gb = a.s_b[s];
    const lines = ds.linesAtGroup(ga).filter((l) => ds.linesAtGroup(gb).includes(l)).sort((x, y) => a.l_score[y] - a.l_score[x]);
    const extra = a.s_extra[s];
    return `${this.header({ eyebrow: 'SEGMENT · 도로 구간', title: `${ds.groupName[ga]} ↔ ${ds.groupName[gb]}`, sub: ds.regionLabel(a.g_region[ga]), score: a.s_score[s], grade: a.s_grade[s], rank: ds.segRank.rank[s], total: ds.S })}
      ${Html.section('취약도 구성 <small>이 구간이 끊기면(도로 통제 등)</small>', this.components('segment', ds.comp('segment', s)))}
      <div class="metric-grid">${Html.metric(Number.isFinite(extra) ? `+${Util.minutes(extra)}` : '단절', '우회 추가 시간')}${Html.metric(`${Util.fmt(a.s_trips[s], 1)}회`, '하루 통과 운행')}</div>
      <div class="action-row"><button class="btn primary" data-act="stress-seg" data-id="${s}">우회 경로 보기</button></div>
      <div id="simResult">${sim || ''}</div>
      ${Html.section('이 구간을 지나는 노선', `<div class="list">${lines.slice(0, 12).map((l) => Html.item('select-line', l, ds.lineTitle(l), ds.lineSubtitle(l), a.l_grade[l], a.l_score[l])).join('')}</div>`)}`;
  }

  segmentStress(r) {
    const d = r.details;
    return `<div class="sim-card"><div class="sim-head"><b>단절 시뮬레이션</b></div>
      <div class="kv"><span>직접 이동</span><b>${Util.minutes(d.directMin)}</b></div>
      <div class="kv"><span>우회 이동</span><b>${d.detourMin == null ? '60분 안에 우회 불가' : Util.minutes(d.detourMin)}</b></div>
      ${Html.note(d.detourMin == null ? '두 정류장을 잇는 다른 경로가 없습니다.' : '지도의 파란 점선이 우회 경로입니다.')}</div>`;
  }

  // ---------------------------------------------------------------- 지역
  region(r) {
    const ds = this.ds, a = ds.a, row = ds.sigunguByRegion.get(r);
    const inRegion = (arrRegion, n) => { const out = []; for (let i = 0; i < n; i++) if (arrRegion[i] === r) out.push(i); return out; };
    const lines = inRegion(a.l_region, ds.L).sort((x, y) => a.l_score[y] - a.l_score[x]).slice(0, 6);
    const stops = inRegion(a.g_region, ds.G).sort((x, y) => a.g_score[y] - a.g_score[x]).slice(0, 6);
    const senior = row.senior >= 0 ? `${row.senior.toFixed(1)}%` : '—';
    const seniorLabel = SENIOR_LABEL[ds.meta.source.senior_source] || '65세 이상 비율';
    return `${this.header({ eyebrow: 'REGION · 시군구', title: ds.regionLabel(r), sub: '지역 안 정류장들의 취약도를 사는 사람 수로 평균 내고, 특히 취약한 곳이 묻히지 않게 상위 20% 값을 함께 반영했어요.', score: row.score, grade: row.grade, rank: ds.sigunguRank.get(r), total: ds.sigungu.length })}
      <div class="metric-grid">${Html.metric(Util.fmt(row.groups), '정류장')}${Html.metric(`${(row.vuln_share * 100).toFixed(0)}%`, '취약 이상 정류장')}
      ${Html.metric(`${row.very_lines}개`, '매우 취약 노선')}${Html.metric(senior, seniorLabel)}</div>
      ${Html.section('이 지역의 취약 노선', `<div class="list">${lines.map((l) => Html.item('select-line', l, ds.lineTitle(l), ds.lineSubtitle(l), a.l_grade[l], a.l_score[l])).join('')}</div>`)}
      ${Html.section('이 지역의 취약 정류장', `<div class="list">${stops.map((g) => Html.item('select-stop', g, ds.groupName[g], `노선 ${a.g_nlines[g]}개`, a.g_grade[g], a.g_score[g])).join('')}</div>`)}
      <div class="action-row"><button class="btn" data-act="csv-region" data-id="${r}">이 지역 노선·정류장 목록 내려받기(CSV)</button></div>`;
  }

  grid(i) {
    const ds = this.ds, a = ds.a;
    const [x0, y0, x1, y1] = ds.gridBox(i), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const r = ds.regionAt(cx, cy);
    const gap = a.gr_grade[i] === 4;
    const popMissing = ds.meta.source.population_source === 'none';
    const title = r >= 0 ? `${ds.regionLabel(r)} 일대` : '5km 격자 (해안·경계 밖)';
    let body;
    if (gap) {
      const near = ds.nearestGroup(cx, cy);
      body = Html.note(popMissing
        ? '<b>정류장이 하나도 없는 육지 격자</b>입니다. 산간처럼 사람이 거의 없는 곳일 수도 있어, 인구 격자 파일을 연결하면 “사람은 사는데 정류장이 없는 곳”만 골라 표시합니다.'
        : `정류장이 없는 격자입니다. 도보권 밖 인구 ${Util.fmt(a.gr_unserved[i])}명.`, 'warn')
        + (near.group >= 0 ? `<div class="metric-grid">${Html.metric(`${near.km.toFixed(1)}km`, '격자 중심에서 가장 가까운 정류장')}${Html.metric(Util.esc(ds.groupName[near.group]), ds.regionLabel(a.g_region[near.group]))}</div>` : '');
    } else {
      const groups = ds.groupsInGrid(i).sort((p, q) => a.g_score[q] - a.g_score[p]);
      const vuln = groups.filter((g) => a.g_grade[g] >= 2).length;
      body = `<div class="metric-grid">${Html.metric(Util.fmt(groups.length), '정류장')}${Html.metric(groups.length ? `${Math.round(vuln / groups.length * 100)}%` : '—', '취약 이상 정류장')}</div>`
        + (groups.length <= 2 ? Html.note('정류장이 1~2곳뿐인 격자는 그 정류장 점수가 곧 격자 점수라서 변동이 큽니다. 시군구 지도와 함께 보세요.') : '')
        + Html.section('이 격자의 정류장 <small>취약한 순</small>', `<div class="list">${groups.slice(0, 8).map((g) =>
          Html.item('select-stop', g, ds.groupName[g], `노선 ${a.g_nlines[g]}개`, a.g_grade[g], a.g_score[g])).join('')}</div>`);
    }
    return `${this.header({ eyebrow: 'GRID · 5km 격자', title, sub: '격자 점수 = 격자 안 정류장 취약도의 평균과 상위 20% 값의 평균', score: gap ? null : a.gr_score[i], grade: a.gr_grade[i] })}
      ${body}
      ${r >= 0 ? `<div class="action-row"><button class="btn" data-act="select-region" data-id="${r}">${Util.esc(ds.regionLabel(r))} 전체 보기</button></div>` : ''}`;
  }

  // ---------------------------------------------------------------- 경로
  journey(res, startName, endName) {
    const ds = this.ds, a = ds.a;
    if (!res) return `${this.header({ eyebrow: 'JOURNEY', title: `${startName} → ${endName}` })}${Html.note('10시간 안에 도착하는 대중교통 경로가 없습니다.', 'warn')}`;
    const worst = res.worstIncrease;
    const grade = worst == null || !Number.isFinite(worst) ? 3 : worst > 0.7 ? 3 : worst > 0.3 ? 2 : worst > 0.1 ? 1 : 0;
    const legs = res.best.legs.filter((x) => x.kind === 'ride').map((leg) => {
      const pl = res.perLine.find((p) => p.line === leg.line);
      const alt = !pl ? '' : pl.altMinutes == null ? '<b class="cut">끊기면 대체 경로 없음</b>' : `끊기면 +${Util.minutes(pl.altMinutes - res.best.minutes)}`;
      return `<div class="leg"><i class="g${a.l_grade[leg.line]}"></i><div><b>${Util.esc(ds.lineTitle(leg.line))}</b>
        <small>${Util.esc(ds.groupName[leg.from])} → ${Util.esc(ds.groupName[leg.to])} · 취약도 ${a.l_score[leg.line].toFixed(1)}</small><small>${alt}</small></div></div>`;
    }).join('');
    return `${this.header({ eyebrow: 'JOURNEY · 경로 회복력', title: `${startName} → ${endName}`, sub: `추정 ${Util.minutes(res.best.minutes)} · 환승 ${res.best.transfers}회` })}
      <div class="score-line">${Html.badge(grade, worst == null || !Number.isFinite(worst) ? '대체 불가' : `최악 +${(worst * 100).toFixed(0)}%`)}</div>
      ${Html.note('경로 회복력 = 이 경로가 쓰는 노선 하나가 끊겼을 때 다시 찾은 경로가 얼마나 늦어지는가. 10% 이하 안정 · 30% 주의 · 70% 취약 · 그 이상/대체 불가 매우 취약.')}
      ${Html.section('이용 노선', legs)}`;
  }
}
