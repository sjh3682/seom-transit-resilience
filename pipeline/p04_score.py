"""4단계: 제거 시뮬레이션 결과 → TVS 점수·등급·AI 분석 → data/interim/scores.json

TVS(노선) = 기획서의 5요소를 그대로 사용한다. 모든 요소는 '제거했을 때의 변화'다.
  이동시간 증가 · 접근 거점 감소 · 대체경로 부족 · 연결성 붕괴 · 영향 인구(규모)

AI
  (1) 설명 모델   : 정적 구조 특징 → 시뮬레이션 TVS 를 학습(교차검증)하고 SHAP 으로
                    항목마다 "왜 취약한가" 상위 요인 3개를 뽑는다.
  (2) 대리 모델   : 정류장 시간 기반 손실을 표본만 계산한 경우(--stop-access sample) 나머지를 추정.
  (3) 취약 유형   : 취약 이상 노선을 군집화해 섬·해상 항로형 / 농어촌 말단형 등 유형과 정책 처방을 붙인다.
검증
  가중치 민감도 분석(무작위 가중치 200회) · v6 정적 점수와의 순위 비교
"""
from __future__ import annotations

import math
from collections import Counter, defaultdict

import numpy as np
from scipy.stats import spearmanr

from common import INTERIM, load_params, log, pct_rank, read_json, write_json

MODE_LONG = {"2", "3", "4", "5", "6", "7"}

# (모델 입력 키, 화면 이름, 단위, 모델 값 → 사람이 읽는 값)
_ID = lambda x: x
_EXP = np.expm1
_PCT = lambda x: x * 100
LINE_FEATURES = [
    ("log_trips", "하루 운행횟수", "회", _EXP),
    ("n_stops", "정류장 수", "개", _ID),
    ("length_km", "노선 길이", "km", _ID),
    ("mean_nearest_m", "정류장 간 간격", "m", _EXP),
    ("mean_other_lines", "정류장당 다른 노선 수", "개", _ID),
    ("single_line_share", "단독 운행 정류장 비율", "%", _PCT),
    ("mean_walk_neighbors", "도보권(400m) 정류장 수", "개", _ID),
    ("mode_ferry", "해운 노선", "yn", _ID),
    ("mode_long", "장거리 노선", "yn", _ID),
    ("mode_rail", "도시철도", "yn", _ID),
]
STOP_FEATURES = [
    ("nearest_m", "가장 가까운 정류장까지 거리", "m", _EXP),
    ("walk_neighbors", "도보권(400m) 정류장 수", "개", _ID),
    ("n_lines", "서는 노선 수", "개", _ID),
    ("log_trips", "하루 운행횟수", "회", _EXP),
    ("n_modes", "교통수단 종류", "종", _ID),
    ("is_hub", "철도역·터미널", "yn", _ID),
    ("stops_in_group", "묶인 정류장 수", "개", _ID),
]


def display_values(X: np.ndarray, features) -> np.ndarray:
    return np.column_stack([f[3](X[:, i]) for i, f in enumerate(features)])


def with_values(top, D: np.ndarray):
    """SHAP 상위 요인 [특징, 기여점수] 에 그 항목의 실제 값을 붙인다 → [특징, 기여점수, 값]."""
    if top is None:
        return None
    vals = np.take_along_axis(D, top[:, :, 0].astype(int), axis=1)
    return np.concatenate([top, vals[..., None]], axis=-1)


def feature_meta(D: np.ndarray, features) -> dict:
    return {"names": [f[1] for f in features], "units": [f[2] for f in features],
            "medians": [round(float(np.median(D[:, i])), 2) for i in range(D.shape[1])]}


POLICY_BY_TYPE = {
    "섬·해상 항로형": "대체 선박·증편, 기상 결항 시 대체 항로 확보, 도서 내 DRT 연계",
    "장거리 단일축형": "평행 노선(시외·철도) 연계 시간표, 결행 시 대체 수송 협정",
    "농어촌 말단 고립형": "DRT(수요응답형) 구역 지정, 인접 노선 연장, 공공형 택시",
    "거점 접근 의존형": "환승 거점 연결 노선 신설, 거점행 증편",
    "도시 단일축형": "평행 노선 증편·우회 경로 지정, 구간 중복 노선 확보",
}


# ---------------------------------------------------------------------------
def grade_by_quantiles(scores: np.ndarray, quantiles) -> tuple[np.ndarray, list]:
    thresholds = np.quantile(scores, quantiles)
    grade = np.searchsorted(thresholds, scores, side="right")
    return grade.astype(int), [round(float(t), 2) for t in thresholds]


def weighted_sum(components: dict, weights: dict) -> np.ndarray:
    total = sum(weights.values())
    return 100 * sum(components[k] * w for k, w in weights.items()) / total


def fit_explainer(X: np.ndarray, y: np.ndarray, names: list[str], seed: int):
    """교차검증 성능 + SHAP 상위 요인. 나무 기반 모델이라 비선형 관계도 잡는다."""
    from sklearn.ensemble import HistGradientBoostingRegressor
    from sklearn.model_selection import KFold, cross_val_predict

    model = HistGradientBoostingRegressor(max_iter=250, learning_rate=0.08, max_leaf_nodes=31, random_state=seed)
    pred = cross_val_predict(model, X, y, cv=KFold(5, shuffle=True, random_state=seed))
    ss_res = float(((y - pred) ** 2).sum()); ss_tot = float(((y - y.mean()) ** 2).sum())
    metrics = {"r2_cv": round(1 - ss_res / ss_tot, 3), "mae_cv": round(float(np.abs(y - pred).mean()), 2), "n": int(len(y))}
    model.fit(X, y)
    try:
        import shap
        explainer = shap.TreeExplainer(model)
        sv = np.asarray(explainer.shap_values(X, check_additivity=False))
        importance = np.abs(sv).mean(axis=0)
        method = "shap"
    except Exception as exc:          # SHAP 이 없으면 순열 중요도(전역)만 제공
        from sklearn.inspection import permutation_importance
        log(f"SHAP 사용 불가({exc}) → 순열 중요도로 대체")
        sv = None
        importance = permutation_importance(model, X, y, n_repeats=3, random_state=seed).importances_mean
        method = "permutation"
    order = np.argsort(-importance)
    metrics["method"] = method
    metrics["importance"] = [[names[i], round(float(importance[i]), 3)] for i in order]
    top = None
    if sv is not None:
        idx = np.argsort(-np.abs(sv), axis=1)[:, :3]
        top = np.stack([idx, np.take_along_axis(sv, idx, axis=1)], axis=-1)   # (n, 3, [feature, 기여 점수])
    return model, metrics, top


# ---------------------------------------------------------------------------
def line_features(graph, n_lines_at_group, walk_deg):
    g = graph["groups"]
    nearest = np.asarray(g["nearest_other_m"])
    rows = []
    for line in graph["lines"]:
        groups = np.asarray(line["groups"])
        others = n_lines_at_group[groups] - 1
        mode = line["mode"]
        rows.append([
            math.log1p(line["trips"]),
            len(groups),
            line["length_km"],
            float(np.log1p(nearest[groups]).mean()),
            float(others.mean()),
            float((others == 0).mean()),
            float(walk_deg[groups].mean()),
            1.0 if mode == "2" else 0.0,
            1.0 if mode in MODE_LONG else 0.0,
            1.0 if mode == "1" else 0.0,
        ])
    return np.asarray(rows)


def stop_features(graph, walk_deg, group_trips):
    g = graph["groups"]
    modes = np.asarray(g["modes"])
    n_modes = np.array([bin(int(m)).count("1") for m in modes])
    return np.c_[
        np.log1p(np.asarray(g["nearest_other_m"])),
        walk_deg,
        np.asarray(g["n_lines"]),
        np.log1p(group_trips),
        n_modes,
        (np.asarray(g["dest"]) > 0).astype(float),
        np.asarray(g["stops_in_group"]),
    ]


def island_affected_population(graph, affected: np.ndarray):
    """해운 노선의 영향 인구 = 그 항로가 닿는 '섬'의 전체 인구(섬에 항로가 여럿이면 나눠 가짐).

    정류장 주변 인구만 세면, 섬 주민 전체가 기대는 항로가 항구 주변 몇백 명으로 과소평가된다.
    섬 = 해운을 뺀 교통망(노선 구간 + 도보 연결)에서 본토와 이어지지 않는 작은 덩어리(그룹 3,000개·인구 15만 미만).
    """
    from common import UnionFind
    G = len(graph["groups"]["lon"])
    modes = [l["mode"] for l in graph["lines"]]
    uf = UnionFind(G)
    for seq, line in zip(graph["patterns"]["stops"], graph["patterns"]["line"]):
        if modes[line] == "2":
            continue
        for a, b in zip(seq, seq[1:]):
            uf.union(a, b)
    ptr, idx = graph["walk"]["ptr"], graph["walk"]["idx"]
    for g in range(G):
        for k in range(ptr[g], ptr[g + 1]):
            uf.union(g, idx[k])
    comp = uf.labels()
    size = np.bincount(comp)
    pop = np.asarray(graph["groups"]["pop"], dtype=float)
    comp_pop = np.bincount(comp, weights=pop)
    island = (size < 3000) & (comp_pop < 150_000)      # 제주처럼 크고 항공이 있는 섬은 본토처럼 본다
    ferry_lines = [l for l, m in enumerate(modes) if m == "2"]
    served = {l: {int(c) for c in comp[graph["lines"][l]["groups"]] if island[c]} for l in ferry_lines}
    n_lines_per_comp = Counter(c for cs in served.values() for c in cs)
    out = affected.copy()
    changed = 0
    for l, comps in served.items():
        v = sum(comp_pop[c] / n_lines_per_comp[c] for c in comps)
        if v > out[l]:
            out[l] = v; changed += 1
    note = {"island_components": int(island.sum()), "ferry_lines_updated": changed,
            "island_population": float(comp_pop[island].sum())}
    log(f"항로 영향 인구: 섬 {note['island_components']:,}개(인구 {note['island_population']:,.0f}명), 해운 노선 {changed}개 보정")
    return out, note


def name_clusters(centroids: np.ndarray, profile_keys: list[str]) -> list[str]:
    """군집 중심값을 보고 규칙으로 이름을 붙인다(중복 없이)."""
    k = len(centroids)
    prof = {key: centroids[:, i] for i, key in enumerate(profile_keys)}
    names = [None] * k
    remaining = set(range(k))

    def take(name, score):
        cand = [i for i in remaining]
        if not cand:
            return
        best = max(cand, key=lambda i: score[i])
        names[best] = name
        remaining.discard(best)

    if prof["ferry"].max() > 0.4:
        take("섬·해상 항로형", prof["ferry"])
    if prof["long"].max() > 0.4:
        take("장거리 단일축형", prof["long"] - prof["ferry"])
    take("농어촌 말단 고립형", prof["no_alternative"] - 0.3 * prof["log_trips"] / 5)
    take("거점 접근 의존형", prof["access_loss"])
    take("도시 단일축형", prof["log_trips"] + prof["time_increase"])
    for i in sorted(remaining):
        names[i] = f"복합 의존형 {i + 1}"
    return names



def score_lines(graph, params, q, sim_lines):
    """노선 TVS: 엔진 4요소 + 영향 규모(백분위) 가중합, 전국 50·80·95% 분위로 등급"""
    rows = sim_lines["rows"]
    comp = np.array([r["c"] for r in rows])          # time_increase, access_loss, no_alternative, connectivity
    affected = np.array([r["pop"] for r in rows])
    affected, ferry_note = island_affected_population(graph, affected)
    line_comp = {
        "time_increase": comp[:, 0], "access_loss": comp[:, 1],
        "no_alternative": comp[:, 2], "connectivity": comp[:, 3],
        "affected_population": pct_rank(np.log1p(affected)),
    }
    line_score = weighted_sum(line_comp, params["tvs"]["route_weights"])
    line_grade, line_thr = grade_by_quantiles(line_score, q)
    line_pct = pct_rank(line_score)
    log(f"노선 TVS 기준선(50·80·95%): {line_thr}")
    return affected, comp, ferry_note, line_comp, line_grade, line_pct, line_score, line_thr, rows


def score_stops(G, graph, meta_src, params, q, seed, sim_stops, walk_deg):
    """정류장 TVS: 폐쇄 시뮬레이션 4요소 + 영향 규모"""
    srows = np.array(sim_stops["rows"])               # walk_penalty, line_loss, transfer_break
    access = np.array([np.nan if a is None else a for a in sim_stops["access"]], dtype=float)
    group_trips = np.zeros(G)
    for line, trips in zip(graph["lines"], (l["trips"] for l in graph["lines"])):
        group_trips[np.asarray(line["groups"])] += trips
    Xs = stop_features(graph, walk_deg, group_trips)
    access_source = "exact"
    surrogate_metrics = None
    missing = np.isnan(access)
    if missing.any():   # 표본 모드: AI 대리모델로 나머지 추정
        from sklearn.ensemble import HistGradientBoostingRegressor
        X_all = np.c_[Xs, srows]
        _, surrogate_metrics, _ = fit_explainer(X_all[~missing], access[~missing],
                                                [f[1] for f in STOP_FEATURES] + ["도보부담", "노선손실", "환승단절"], seed)
        model = HistGradientBoostingRegressor(max_iter=250, random_state=seed).fit(X_all[~missing], access[~missing])
        access[missing] = np.clip(model.predict(X_all[missing]), 0, 1)
        access_source = "surrogate"
        log(f"정류장 접근성 손실: 표본 {int((~missing).sum()):,}개 정밀 + 대리모델 추정 {int(missing.sum()):,}개 "
            f"(교차검증 R² {surrogate_metrics['r2_cv']})")
    pop = np.asarray(graph["groups"]["pop"], dtype=float)
    # 영향 규모: 도보권 인구 × 그 정류장의 하루 운행횟수(서비스 수준). 인구만 쓰면 도시에서 변별력이 없다 —
    # 서울시 버스 교통카드 실제 승차(2026.8, 7,362곳)와 비교하니 인구만: 순위상관 0.10, 운행횟수를 곱하면 0.6 이상.
    # 인구는 제곱근으로 눌러 한쪽이 지나치게 지배하지 않게 한다(p12_validate_demand.py 가 이 선택을 검증).
    pop_missing = meta_src["population_source"] == "none"
    demand = group_trips if pop_missing else np.sqrt(np.maximum(pop, 0)) * group_trips
    stop_affected_basis = "trips" if pop_missing else "population_x_service"
    stop_comp = {
        "walk_penalty": srows[:, 0], "access_loss": access, "line_loss": srows[:, 1],
        "transfer_break": srows[:, 2],
        "affected_population": pct_rank(np.log1p(demand)),
    }
    stop_weights = dict(params["tvs"]["stop_weights"])
    stop_score = weighted_sum(stop_comp, stop_weights)
    stop_grade, stop_thr = grade_by_quantiles(stop_score, q)
    stop_pct = pct_rank(stop_score)
    log(f"정류장 TVS 기준선: {stop_thr}")
    return Xs, access_source, pop, stop_affected_basis, stop_comp, stop_grade, stop_pct, stop_score, stop_thr, stop_weights, surrogate_metrics


def score_segments(graph, line_score, params, q, sim_segs):
    """구간 TVS: 도로 한 토막이 막힐 때의 우회 시간·영향 운행량·지나는 노선 위험"""
    edge_lines = defaultdict(set)
    for p_idx, seq in enumerate(graph["patterns"]["stops"]):
        l = graph["patterns"]["line"][p_idx]
        for a, b in zip(seq, seq[1:]):
            edge_lines[(a, b) if a < b else (b, a)].add(l)
    seg = np.array(sim_segs["rows"], dtype=float)     # a, b, detour, extra_min, trips
    seg_a = seg[:, 0].astype(int); seg_b = seg[:, 1].astype(int)
    seg_line_risk = np.array([max(line_score[l] for l in edge_lines[(min(a, b), max(a, b))]) / 100
                              for a, b in zip(seg_a, seg_b)])
    seg_comp = {"detour": seg[:, 2], "affected_volume": pct_rank(np.log1p(seg[:, 4])), "affected_lines_risk": seg_line_risk}
    seg_score = weighted_sum(seg_comp, params["tvs"]["segment_weights"])
    seg_grade, seg_thr = grade_by_quantiles(seg_score, q)
    log(f"구간 TVS 기준선: {seg_thr} ({len(seg_score):,}개 구간)")
    return seg, seg_a, seg_b, seg_comp, seg_grade, seg_score, seg_thr


def explain_models(Xs, graph, line_score, n_lines_at_group, seed, stop_score, walk_deg):
    """AI (1) 설명 모델: 점수를 요인으로 설명하는 부스팅 모델 + SHAP"""
    Xl = line_features(graph, n_lines_at_group, walk_deg)
    _, line_model_metrics, line_top = fit_explainer(Xl, line_score, [f[1] for f in LINE_FEATURES], seed)
    Dl = display_values(Xl, LINE_FEATURES)
    line_top = with_values(line_top, Dl)
    log(f"노선 설명 모델: 교차검증 R² {line_model_metrics['r2_cv']}, MAE {line_model_metrics['mae_cv']}점")
    _, stop_model_metrics, stop_top = fit_explainer(Xs, stop_score, [f[1] for f in STOP_FEATURES], seed)
    Ds = display_values(Xs, STOP_FEATURES)
    stop_top = with_values(stop_top, Ds)
    log(f"정류장 설명 모델: 교차검증 R² {stop_model_metrics['r2_cv']}, MAE {stop_model_metrics['mae_cv']}점")
    return Dl, Ds, line_model_metrics, line_top, stop_model_metrics, stop_top


def vulnerability_types(L, comp, graph, line_grade, seed):
    """AI (2) 취약 유형 군집(매우·취약 노선을 요인 패턴으로 묶음)"""
    from sklearn.cluster import KMeans
    from sklearn.preprocessing import StandardScaler
    vuln = np.where(line_grade >= 2)[0]
    modes = np.array([l["mode"] for l in graph["lines"]])
    profile_keys = ["time_increase", "access_loss", "no_alternative", "connectivity", "ferry", "long", "log_trips"]
    P = np.c_[comp[vuln], (modes[vuln] == "2").astype(float), np.isin(modes[vuln], list(MODE_LONG)).astype(float),
              np.log1p([graph["lines"][i]["trips"] for i in vuln])]
    km = KMeans(n_clusters=5, n_init=10, random_state=seed).fit(StandardScaler().fit_transform(P))
    centroids = np.array([P[km.labels_ == k].mean(axis=0) for k in range(5)])
    cluster_names = name_clusters(centroids, profile_keys)
    line_cluster = np.full(L, -1)
    line_cluster[vuln] = km.labels_
    clusters = [{
        "name": cluster_names[k],
        "size": int((km.labels_ == k).sum()),
        "policy": POLICY_BY_TYPE.get(cluster_names[k], "노선별 개별 검토"),
        "profile": {key: round(float(centroids[k, i]), 3) for i, key in enumerate(profile_keys)},
    } for k in range(5)]
    log("취약 유형: " + ", ".join(f"{c['name']}({c['size']})" for c in clusters))
    return clusters, line_cluster, modes


def weight_sensitivity(L, line_comp, line_score, params, seed):
    """가중치 민감도: 가중치를 무작위로 바꿔도 순위·상위 5% 가 유지되는지"""
    rng = np.random.default_rng(seed)
    base_w = params["tvs"]["route_weights"]
    keys = list(base_w)
    top_base = set(np.argsort(-line_score)[: max(1, L // 20)])
    rhos, overlaps = [], []
    for _ in range(200):
        w = rng.dirichlet(np.array([base_w[k] for k in keys]) * 40)
        s = weighted_sum(line_comp, dict(zip(keys, w)))
        rhos.append(spearmanr(line_score, s).statistic)
        top = set(np.argsort(-s)[: len(top_base)])
        overlaps.append(len(top & top_base) / len(top_base))
    sensitivity = {
        "draws": 200, "spearman_median": round(float(np.median(rhos)), 3), "spearman_p5": round(float(np.percentile(rhos, 5)), 3),
        "top5_overlap_median": round(float(np.median(overlaps)), 3), "top5_overlap_p5": round(float(np.percentile(overlaps, 5)), 3),
    }
    log(f"가중치 민감도: 순위상관 중앙값 {sensitivity['spearman_median']}, 상위5% 유지율 중앙값 {sensitivity['top5_overlap_median']}")
    return sensitivity, top_base


def compare_with_v6(graph, line_score, modes, top_base):
    """v6 정적 점수와의 순위 비교"""
    comparison = {}
    legacy_path = INTERIM / "legacy_scores.json"
    if legacy_path.exists():
        legacy = read_json(legacy_path)
        def legacy_route(i):                   # 원본 GTFS 패턴 ID('노선ID#1')는 '#' 앞이 v6 노선 ID
            return legacy["route"].get(str(i).split("#")[0], np.nan)
        old_line = np.array([np.nanmean([legacy_route(i) for i in l["source_ids"]]) if any(
            np.isfinite(legacy_route(i)) for i in l["source_ids"]) else np.nan for l in graph["lines"]])
        ok = ~np.isnan(old_line)
        comparison["line_spearman_v6"] = round(float(spearmanr(old_line[ok], line_score[ok]).statistic), 3)
        v6_top = set(np.where(ok)[0][np.argsort(-old_line[ok])[: len(top_base)]])
        comparison["line_top5_overlap_v6"] = round(len(v6_top & top_base) / len(top_base), 3)
        ferry = modes == "2"
        comparison["ferry_top5_share_new"] = round(float(np.isin(np.where(ferry)[0], list(top_base)).mean()), 3)
        log(f"v6 정적 점수와 순위상관 {comparison['line_spearman_v6']}, 상위5% 겹침 {comparison['line_top5_overlap_v6']}")
    return comparison,


def score_regions(graph, line_grade, params, pop, q, stop_grade, stop_score):
    """지역 점수: 시군구(인구가중 평균과 80백분위 혼합)와 5km 격자(정류장 없는 칸 = 서비스 공백)"""
    regions = graph["regions"]
    region_of_group = np.asarray(graph["groups"]["region"])
    senior = np.asarray(graph["groups"]["senior"], dtype=float)

    def aggregate(idx):
        w = pop[idx]
        s = stop_score[idx]
        # 인구가 모두 0 인 곳(행정동이 연결되지 않은 정류장만 있는 격자 등)은 단순 평균
        mean = float((s * w).sum() / w.sum()) if w.sum() > 0 else float(s.mean())
        p80 = float(np.percentile(s, 80))
        return 0.5 * mean + 0.5 * p80, float((stop_grade[idx] >= 2).mean())

    sgg_rows = []
    for r in range(len(regions)):
        idx = np.where(region_of_group == r)[0]
        if len(idx) == 0:
            continue
        score, vuln_share = aggregate(idx)
        sen = senior[idx]; sen = sen[sen >= 0]
        sgg_rows.append({"region": r, "score": score, "vuln_share": vuln_share, "groups": int(len(idx)),
                         "pop": float(pop[idx].sum()), "senior": float(sen.mean()) if len(sen) else -1.0,
                         "very_lines": 0})
    for l, line in enumerate(graph["lines"]):
        if line_grade[l] == 3:
            r = Counter(int(region_of_group[g]) for g in line["groups"]).most_common(1)[0][0]
            for row in sgg_rows:
                if row["region"] == r:
                    row["very_lines"] += 1
    sgg_scores = np.array([r["score"] for r in sgg_rows])
    sgg_grade, sgg_thr = grade_by_quantiles(sgg_scores, q)
    for row, gr, pc in zip(sgg_rows, sgg_grade, pct_rank(sgg_scores)):
        row["grade"] = int(gr); row["pct"] = float(pc)

    # 격자: 육지 격자 전체(정류장 없는 칸 = 서비스 공백)
    from shapely import contains_xy
    from shapely.geometry import shape
    from shapely.ops import unary_union
    from boundaries import boundary_paths
    land = unary_union([shape(f["geometry"]) for f in read_json(boundary_paths()[1])["features"]])
    cell = params["region"]["grid_cell_deg"]
    lon = np.asarray(graph["groups"]["lon"]); lat = np.asarray(graph["groups"]["lat"])
    gx = np.floor((lon - 124) / cell).astype(int); gy = np.floor((lat - 33) / cell).astype(int)
    cells = defaultdict(list)
    for g, key in enumerate(zip(gx, gy)):
        cells[key].append(g)
    xs, ys = np.meshgrid(np.arange(int(8.5 / cell)), np.arange(int(6 / cell)))
    cx = 124 + (xs.ravel() + 0.5) * cell; cy = 33 + (ys.ravel() + 0.5) * cell
    on_land = contains_xy(land, cx, cy)
    grid_rows = []
    land_keys = set(zip(xs.ravel()[on_land], ys.ravel()[on_land]))
    unserved = defaultdict(float)
    for x, y, v in graph.get("unserved_population", []):
        unserved[(int((x - 124) // cell), int((y - 33) // cell))] += v
    for key in sorted(land_keys | set(cells)):
        idx = np.asarray(cells.get(key, []), dtype=int)
        if len(idx):
            score, vuln_share = aggregate(idx)
            grid_rows.append([int(key[0]), int(key[1]), round(score, 2), int(len(idx)), round(float(pop[idx].sum()), 1),
                              round(float(unserved.get(key, 0.0)), 1)])
        else:
            grid_rows.append([int(key[0]), int(key[1]), -1.0, 0, 0.0, round(float(unserved.get(key, 0.0)), 1)])
    served = np.array([r[2] for r in grid_rows if r[2] >= 0])
    grid_thr = [round(float(t), 2) for t in np.quantile(served, q)]
    for r in grid_rows:
        r.append(int(np.searchsorted(grid_thr, r[2], side="right")) if r[2] >= 0 else 4)   # 4 = 서비스 공백
    log(f"격자 {len(grid_rows):,}칸 (정류장 없는 육지 {sum(1 for r in grid_rows if r[3] == 0):,}칸)")
    return cell, grid_rows, grid_thr, sgg_rows, sgg_thr


def main() -> None:
    params = load_params()
    seed = params["simulation"]["random_seed"]
    q = params["tvs"]["grade_quantiles"]
    graph = read_json(INTERIM / "graph.json")
    sim_lines = read_json(INTERIM / "sim_lines.json")
    sim_stops = read_json(INTERIM / "sim_stops.json")
    sim_segs = read_json(INTERIM / "sim_segments.json")
    meta_src = graph["meta"]

    G = len(graph["groups"]["lon"]); L = len(graph["lines"])
    walk_ptr = np.asarray(graph["walk"]["ptr"])
    walk_deg = np.diff(walk_ptr).astype(float)
    n_lines_at_group = np.asarray(graph["groups"]["n_lines"])

    # ------------------------------------------------------------- 노선 TVS
    affected, comp, ferry_note, line_comp, line_grade, line_pct, line_score, line_thr, rows = score_lines(graph, params, q, sim_lines)

    # ------------------------------------------------------------- 정류장 TVS
    Xs, access_source, pop, stop_affected_basis, stop_comp, stop_grade, stop_pct, stop_score, stop_thr, stop_weights, surrogate_metrics = score_stops(G, graph, meta_src, params, q, seed, sim_stops, walk_deg)

    # ------------------------------------------------------------- 구간 TVS
    seg, seg_a, seg_b, seg_comp, seg_grade, seg_score, seg_thr = score_segments(graph, line_score, params, q, sim_segs)

    # ------------------------------------------------------------- AI (1) 설명 모델 + SHAP
    Dl, Ds, line_model_metrics, line_top, stop_model_metrics, stop_top = explain_models(Xs, graph, line_score, n_lines_at_group, seed, stop_score, walk_deg)

    # ------------------------------------------------------------- AI (3) 취약 유형 군집
    clusters, line_cluster, modes = vulnerability_types(L, comp, graph, line_grade, seed)

    # ------------------------------------------------------------- 가중치 민감도
    sensitivity, top_base = weight_sensitivity(L, line_comp, line_score, params, seed)

    # ------------------------------------------------------------- v6 정적 점수와 비교
    comparison, = compare_with_v6(graph, line_score, modes, top_base)

    # ------------------------------------------------------------- 지역(시군구·격자)
    cell, grid_rows, grid_thr, sgg_rows, sgg_thr = score_regions(graph, line_grade, params, pop, q, stop_grade, stop_score)

    # 영향 인구 백분위 환산표(웹에서 정책 시뮬레이션 후 점수 재계산용)
    pop_quantiles = np.quantile(np.log1p(affected), np.linspace(0, 1, 101)).round(4).tolist()

    out = {
        "line": {
            "score": line_score.round(2).tolist(), "grade": line_grade.tolist(), "pct": line_pct.round(4).tolist(),
            "components": {k: np.round(v, 4).tolist() for k, v in line_comp.items()},
            "affected": affected.round(2).tolist(),
            "disconnected_pairs": [r["disc"] for r in rows], "pairs": [r["nPairs"] for r in rows],
            "stranded": [r["stranded"] for r in rows],
            "cluster": line_cluster.tolist(),
            "top": line_top.round(3).tolist() if line_top is not None else None,
        },
        "stop": {
            "score": stop_score.round(2).tolist(), "grade": stop_grade.tolist(), "pct": stop_pct.round(4).tolist(),
            "components": {k: np.round(v, 4).tolist() for k, v in stop_comp.items()},
            "top": stop_top.round(3).tolist() if stop_top is not None else None,
        },
        "segment": {
            "a": seg_a.tolist(), "b": seg_b.tolist(), "score": seg_score.round(2).tolist(), "grade": seg_grade.tolist(),
            "extra_min": [None if math.isnan(v) else v for v in seg[:, 3].tolist()],
            "trips": seg[:, 4].tolist(),
            "components": {k: np.round(v, 4).tolist() for k, v in seg_comp.items()},
        },
        "sigungu": sgg_rows,
        "grid": {"cell": cell, "origin": [124, 33], "rows": grid_rows},
        "meta": {
            "thresholds": {"line": line_thr, "stop": stop_thr, "segment": seg_thr, "sigungu": sgg_thr, "grid": grid_thr},
            "stop_weights_effective": stop_weights,
            "stop_affected_basis": stop_affected_basis,
            "access_source": access_source,
            "surrogate": surrogate_metrics,
            "line_model": line_model_metrics, "stop_model": stop_model_metrics,
            "line_features": feature_meta(Dl, LINE_FEATURES), "stop_features": feature_meta(Ds, STOP_FEATURES),
            "clusters": clusters, "sensitivity": sensitivity, "comparison_v6": comparison,
            "affected_log_quantiles": pop_quantiles,
            "ferry_affected": ferry_note,
        },
    }
    write_json(INTERIM / "scores.json", out)
    log("저장: scores.json")


if __name__ == "__main__":
    main()
