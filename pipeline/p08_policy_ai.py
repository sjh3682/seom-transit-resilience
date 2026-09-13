"""8단계: AI 정책 최적화(정책 조합) → data/interim/policy.json

  후보   = 취약 이상 노선 × 정책 변형 6가지(config policy.variants)
  정답   = 모든 후보를 엔진으로 정밀 계산(웹 '대안 비교' 버튼과 같은 함수)
  AI     = 대리모델이 후보의 15%만 보고 학습 → 나머지의 편익·비용을 예측 → 예산 안 조합 선택
           → 정답 최적 조합의 편익을 얼마나 찾았는지(포착률) 예산별로 보고한다.
           SHAP 으로 '어떤 조건에서 정책 효과가 큰가'를 뽑는다.
  결과   = 예산(버스 대·년 환산)별 전국 정책 포트폴리오: 고립 해소 인구, 이동시간 개선, CO2 감축(범위), 비용

실행 시간: 정밀 계산 약 7분(후보 2만여 개) + 학습 1분.
"""
from __future__ import annotations

import json
import subprocess
from collections import Counter

import numpy as np
from scipy.stats import spearmanr
from sklearn.ensemble import HistGradientBoostingRegressor

from common import EXTERNAL, INTERIM, ROOT, load_params, log, read_json, write_json

MODE_LONG = {"2", "3", "4", "5", "6", "7"}


# ---------------------------------------------------------------------------
def engine_fingerprint() -> str:
    """엔진 계산에 실제로 쓰이는 값(정류장 좌표·인구·거점, 패턴, 도보 연결, 설정)의 해시.
    고령 비율처럼 엔진이 쓰지 않는 값만 바뀌면 정책 정밀 계산을 다시 하지 않는다."""
    import hashlib
    g = read_json(INTERIM / "graph.json")
    parts = {"groups": {k: g["groups"][k] for k in ("lon", "lat", "pop", "dest", "modes")},
             "patterns": g["patterns"], "walk": g["walk"], "modes": [l["mode"] for l in g["lines"]],
             "params": {k: load_params()[k] for k in ("modes", "service", "walk", "simulation")},
             "engine": (ROOT / "engine" / "seom_engine.js").read_text(encoding="utf-8")}      # 엔진 코드가 바뀌어도 다시 계산
    return hashlib.md5(json.dumps(parts, sort_keys=True).encode()).hexdigest()


def run_engine(name: str, candidates: list) -> list:
    """정밀 계산. 후보 목록과 교통망(graph.json)이 모두 같을 때만 이전 결과를 재사용한다
    (병원·인구가 바뀌면 같은 후보라도 결과가 달라지므로)."""
    path = INTERIM / f"{name}.candidates.json"
    res_path = INTERIM / f"{name}.results.json"
    key_path = INTERIM / f"{name}.key.json"
    key = {"engine_inputs": engine_fingerprint(), "n": len(candidates)}
    if res_path.exists() and path.exists() and key_path.exists() and json.loads(key_path.read_text()) == key \
            and json.loads(path.read_text()) == candidates:
        log(f"정밀 계산 결과 재사용: {res_path.name}")
        return read_json(res_path)
    path.write_text(json.dumps(candidates))
    key_path.unlink(missing_ok=True)
    res_path.unlink(missing_ok=True)
    subprocess.run(["node", "--max-old-space-size=2600", str(ROOT / "pipeline" / "p07_policy_sim.js"), name], check=True)
    if not res_path.exists():
        raise SystemExit(f"{name}: 정밀 계산이 끝나지 않았습니다(중간 저장됨 — 다시 실행하면 이어서 계산)")
    key_path.write_text(json.dumps(key))                 # 성공한 뒤에만 기록(중간 실패 시 옛 결과 재사용 방지)
    return read_json(res_path)


def tvs(components: np.ndarray, affected_pct: np.ndarray, weights: dict, keys: list) -> np.ndarray:
    """p04 와 같은 공식. components 열 순서 = keys(엔진 4요소), 영향 규모는 저장된 백분위."""
    total = sum(weights.values())
    out = np.zeros(len(components))
    for i, k in enumerate(keys):
        out += weights[k] * components[:, i]
    out += weights["affected_population"] * affected_pct
    return 100 * out / total


def sample_trip_km(graph, fractions) -> np.ndarray:
    """노선마다 엔진과 같은 표본 이동(대표 패턴의 0·25·50·75·100% 지점 사이 + 처음→중간, 중간→끝)의 평균 거리(km).
    승용차로 옮겨갈 때의 통행거리로 쓴다(가정값 대신 교통망에서 계산)."""
    from common import haversine_m
    lon, lat = np.array(graph["groups"]["lon"]), np.array(graph["groups"]["lat"])
    P = graph["patterns"]["stops"]
    out = np.zeros(len(graph["lines"]))
    for li, line in enumerate(graph["lines"]):
        st = P[max(line["patterns"], key=lambda p: len(P[p]))]
        if len(st) < 2:
            continue
        seg = haversine_m(lon[st[:-1]], lat[st[:-1]], lon[st[1:]], lat[st[1:]]) / 1000
        cum = np.concatenate([[0], np.cumsum(seg)])
        end = len(st) - 1
        for k in range(1, len(st)):          # 여러 바퀴 운행은 첫 바퀴만
            if st[k] == st[0]:
                end = k; break
        idx = sorted({round(end * f) for f in fractions})
        mid = idx[len(idx) // 2]
        pairs = list(zip(idx, idx[1:])) + [(idx[0], mid), (mid, idx[-1])]
        d = [cum[j] - cum[i] for i, j in pairs if j > i]
        out[li] = float(np.mean(d)) if d else float(cum[end])
    return out


def usage_adjustment(cfg) -> dict:
    """대중교통현황조사(2024) '1주간 평균 대중교통 이용횟수' 분포 → 시도별 이용 빈도(전국 평균 대비 배수)."""
    import pandas as pd
    f = EXTERNAL / cfg.get("usage_file", "")
    if not cfg.get("usage_file") or not f.exists():
        return {}
    x = pd.read_excel(f, header=None)
    head = x.index[x.iloc[:, 1].astype(str).str.contains("구분", na=False)]
    d = x.iloc[(head[0] if len(head) else 4) + 1:].dropna(how="all")
    mids = np.array([4.5, 8, 13, 18, 23])            # 4~5, 6~10, 11~15, 16~20, 21회 이상(보수적으로 23)
    out = {}
    for _, row in d.iterrows():
        share = pd.to_numeric(row.iloc[4:4 + len(mids)], errors="coerce").to_numpy(float)
        if np.isnan(share).any() or share.sum() <= 0:
            continue
        out[str(row.iloc[1]).strip()] = float((share * mids).sum() / share.sum())
    base = out.pop("전체", None)
    if not base:
        return {}
    merged = {k: v / base for k, v in out.items()}
    if "광주" in merged and "전남" in merged:          # 2026 통합 행정구역
        merged["전남광주"] = (merged["광주"] + merged["전남"]) / 2
    return merged


def carbon_inputs(lines, cfg) -> dict:
    """탄소 계산 입력을 공공자료에서 계산한다(노선별 배열).
    - 1인당 하루 대중교통 이용 = (통행률 ÷ 귀가 통행 비율) × 지역 유형별 대중교통 분담률   (KTDB 2025 O/D 예비조사)
      통행한 사람은 하루에 한 번 귀가한다 → 1인당 통행수 = 통행률 ÷ 귀가 비율
    - 승용차를 쓸 수 있는 비율 = 시도별 1인당 자동차 등록대수(2025)
    - 1km 당 CO2 = 국산 휘발유 승용(내연기관) 모델 표시 CO2 평균(한국에너지공단)"""
    import pandas as pd
    od = cfg["od_survey"]
    trips_pp = od["trip_rate"] / od["return_trip_share"]
    # 시도별 1인당 자동차 등록대수(전남광주는 전국 − 나머지)
    t = pd.read_excel(EXTERNAL / cfg["car_registration_file"], header=None).iloc[2:, :4]
    t.columns = ["name", "per", "cars", "pop"]
    t["cars"] = pd.to_numeric(t["cars"], errors="coerce"); t["pop"] = pd.to_numeric(t["pop"], errors="coerce")
    short = {"서울특별시": "서울", "부산광역시": "부산", "대구광역시": "대구", "인천광역시": "인천", "광주광역시": "광주",
             "대전광역시": "대전", "울산광역시": "울산", "세종특별자치시": "세종", "경기도": "경기", "강원특별자치도": "강원",
             "강원도": "강원", "충청북도": "충북", "충청남도": "충남", "전북특별자치도": "전북", "전라북도": "전북",
             "전라남도": "전남", "경상북도": "경북", "경상남도": "경남", "제주특별자치도": "제주", "전남광주통합특별시": "전남광주"}
    nat = t[t["name"] == "전국"].iloc[0]
    known = t[(t["name"] != "전국") & t["cars"].notna()]
    car_pp = {short[n]: c / p for n, c, p in zip(known["name"], known["cars"], known["pop"]) if n in short}
    if "전남광주" not in car_pp:
        car_pp["전남광주"] = (nat["cars"] - known["cars"].sum()) / (nat["pop"] - known["pop"].sum())
    national = nat["cars"] / nat["pop"]
    # 1km 당 CO2(표시값)
    f = pd.read_excel(EXTERNAL / cfg["fuel_label_file"])
    gas = f[(f["연료"] == "휘발유") & (f["자동차 종류"] == "승용차") & (f["차량형식"] == "내연기관")]
    dom = gas[gas["업체명"].astype(str).apply(lambda m: any(k in m for k in cfg["domestic_makers"]))]
    kg_km = float(dom["CO2배출량(g/km)"].mean()) / 1000
    kg_km_all = float(gas["CO2배출량(g/km)"].mean()) / 1000
    def region_type(sido):
        return "서울" if sido == "서울" else "광역시" if sido in od["metro_cities"] else "시군"
    # 시도별 보정: 대중교통현황조사(2024) 1주 이용횟수 분포로 시도별 이용 빈도 차이를 반영(전국 평균 = 1.0)
    adj = usage_adjustment(cfg)
    transit = np.array([trips_pp * od["transit_share"][region_type(line["sido"])] * adj.get(line["sido"], 1.0) for line in lines])
    cars = np.array([car_pp.get(line["sido"], national) for line in lines])
    return {"transit_pp": transit, "car_pp": cars, "kg_km": kg_km, "kg_km_all": kg_km_all,
            "summary": {"trips_per_person": round(trips_pp, 3),
                        "transit_trips_per_person": {k: round(trips_pp * v, 3) for k, v in od["transit_share"].items()},
                        "car_per_person": {k: round(v, 3) for k, v in sorted(car_pp.items())},
                        "co2_g_per_km_domestic": round(kg_km * 1000, 1), "co2_g_per_km_all_models": round(kg_km_all * 1000, 1),
                        "n_domestic_models": int(len(dom)), "n_all_models": int(len(gas))}}


def carbon_t_per_year(affected, iso, ti, trip_km, transit_pp, car_pp, ci, days) -> np.ndarray:
    """승용차 전환 CO2(톤/년), [낮음, 중간, 높음] × 후보. 모든 입력은 공공자료 계산값이다.
    승용차로 옮기는 통행 = 영향 인구 × 1인당 대중교통 이용 × 차를 쓸 수 있는 비율 × 이동이 무너지는 정도
    (고립이면 전부, 지연이면 이동시간 증가율(최대 1)만큼).
    낮음 = 고립된 통행만 옮김, 중간 = 고립 + 지연, 높음 = 중간에 수입차 포함 전체 모델 평균 CO2 적용."""
    base = affected * transit_pp * car_pp * np.maximum(0.5, trip_km) * days / 1000
    isolated = base * iso
    delayed = base * (1 - iso) * np.minimum(1, ti)
    return np.array([isolated * ci["kg_km"], (isolated + delayed) * ci["kg_km"], (isolated + delayed) * ci["kg_km_all"]])


def greedy_portfolio(line_of, benefit, cost, budget):
    """노선당 정책 하나, 편익/비용이 큰 순서로 예산이 찰 때까지(0-1 배낭 문제의 탐욕 근사)."""
    ok = np.where((benefit > 0) & (cost > 0))[0]
    order = ok[np.argsort(-(benefit[ok] / cost[ok]))]
    chosen, used, spent = [], set(), 0.0
    for i in order:
        if line_of[i] in used or spent + cost[i] > budget:
            continue
        chosen.append(int(i)); used.add(line_of[i]); spent += cost[i]
    return chosen, spent


def combo_space(pcfg):
    """노선당 정책 조합: (증편 없음·배수들) × (공간 대안 없음·DRT(반경×대기)·연장(거리)) − 아무것도 안 함."""
    c = pcfg["combo"]
    freqs = [None] + c["frequency"]
    spatial = [None] + [("drt", {"maxKm": r, "waitMin": w}) for r in c["drt"]["maxKm"] for w in c["drt"]["waitMin"]] \
        + [("extension", {"maxKm": r}) for r in c["extension"]["maxKm"]]
    combos = []
    for f in freqs:
        for sp in spatial:
            if f is None and sp is None:
                continue
            parts, label, code = [], [], {"freq": f or 0, "spatial": 0, "km": 0, "wait": 0}
            if sp:
                parts.append({"kind": sp[0], "opt": sp[1]})
                if sp[0] == "drt":
                    label.append(f"DRT 반경 {sp[1]['maxKm']}km·대기 {sp[1]['waitMin']}분"); code.update(spatial=1, km=sp[1]["maxKm"], wait=sp[1]["waitMin"])
                else:
                    label.append(f"인접 노선 {sp[1]['maxKm']}km 연장"); code.update(spatial=2, km=sp[1]["maxKm"])
            if f:
                parts.append({"kind": "frequency", "opt": {"freqMultiplier": f}})
                label.append(f"대체 노선 배차 {f:g}배")
            combos.append({"parts": parts, "label": " + ".join(label), "code": code})
    return combos


def run_stage(name, cand_list):
    return run_engine(name, cand_list) if cand_list else []



def train_surrogate(G, aff_all, combo_of, combos, keys, line_km_all, line_of, lines, metrics, scores, seed, train, vehicles):
    """AI 대리모델: 학습 후보(T)의 정밀 결과로 '비용 대비 편익'과 편익을 예측하는 부스팅 모델을 학습해 전 후보를 예측"""

    comp = np.array([scores["line"]["components"][k] for k in keys + ["affected_population"]]).T
    stranded = scores["line"]["stranded"]; near = np.array(G["nearest_other_m"])
    modes = np.array([l["mode"] for l in lines]); cluster = np.array(scores["line"]["cluster"])
    line_feat = np.c_[comp, [len(x) for x in stranded], [float(np.mean(near[x])) if x else 0 for x in stranded],
                      np.log1p([l["trips"] for l in lines]), [len(l["groups"]) for l in lines], line_km_all,
                      modes == "2", np.isin(modes, list(MODE_LONG)), cluster, np.log1p(vehicles), np.log1p(aff_all)]
    feat_names = ["이동시간 증가", "접근 거점 감소", "대체경로 부족", "연결성 붕괴", "영향 규모", "고립 정류장 수",
                  "고립 정류장의 최근접 정류장 거리", "하루 운행횟수(log)", "정류장 수", "노선 길이", "해운", "장거리",
                  "취약 유형", "운행 차량 수(log)", "영향 인구(log)"]
    combo_feat = np.array([[c["code"]["freq"], c["code"]["spatial"] == 1, c["code"]["spatial"] == 2, c["code"]["km"], c["code"]["wait"]] for c in combos], float)
    X = np.c_[line_feat[line_of], combo_feat[combo_of]]
    names = feat_names + ["정책:증편 배수", "정책:DRT", "정책:연장", "정책:반경·거리", "정책:DRT 대기"]

    t_idx = np.where(train)[0]
    mt = metrics(t_idx)
    yr_t = np.log((mt["benefit"] + 0.1) / (mt["cost"] + 0.01))
    model_r = HistGradientBoostingRegressor(max_iter=400, learning_rate=0.05, random_state=seed).fit(X[t_idx], yr_t)
    model_b = HistGradientBoostingRegressor(max_iter=300, learning_rate=0.06, random_state=seed).fit(X[t_idx], np.log1p(mt["benefit"]))
    pr = model_r.predict(X); pb = np.expm1(model_b.predict(X))
    return X, combo_feat, names, pb, pr, t_idx


def validate_against_exact(K, N, ai_set, budgets_cfg, line_of, metrics, pb, pcfg, pr, results, rng, train, v_lines, valid, vuln):
    """검증: 무작위 노선(V)의 전수 계산 정답 최적 조합과 AI 방식·같은 비율 무작위 선택의 포착률 비교"""
    v_idx = np.where(valid)[0]
    mv = metrics(v_idx)
    hold = v_idx[~train[v_idx]]
    mh = metrics(hold)
    r2 = lambda y, p: float(1 - ((y - p) ** 2).sum() / max(1e-9, ((y - y.mean()) ** 2).sum()))
    yb_h = np.log1p(mh["benefit"])
    surrogate = {
        "train_share": pcfg["surrogate_train_share"], "n_train": int(train.sum()), "n_candidates": int(N),
        "r2_holdout": round(r2(yb_h, np.log1p(pb[hold])), 3),
        "spearman_holdout": round(float(spearmanr(mh["benefit"], pb[hold]).statistic), 3),
        "spearman_ratio_holdout": round(float(spearmanr(np.log((mh["benefit"] + 0.1) / (mh["cost"] + 0.01)), pr[hold]).statistic), 3),
    }
    ai_share = float(ai_set.mean())
    rand = rng.random(N) < ai_share
    frac = len(v_lines) / len(vuln)
    capture = []
    for B in budgets_cfg:
        Bv = B * frac
        lv = line_of[v_idx]
        opt, _ = greedy_portfolio(lv, mv["benefit"], mv["cost"], Bv)
        ai_c, _ = greedy_portfolio(lv, np.where(ai_set[v_idx], mv["benefit"], 0), np.where(ai_set[v_idx], mv["cost"], 0), Bv)
        rd_c, _ = greedy_portfolio(lv, np.where(rand[v_idx], mv["benefit"], 0), np.where(rand[v_idx], mv["cost"], 0), Bv)
        ob = float(mv["benefit"][opt].sum())
        capture.append({"budget": B, "optimal": round(ob, 1), "ai": round(float(mv["benefit"][ai_c].sum()), 1),
                        "share": round(float(mv["benefit"][ai_c].sum()) / max(1e-9, ob), 3),
                        "random_30": round(float(mv["benefit"][rd_c].sum()) / max(1e-9, ob), 3),
                        "exact_evals_share": round(ai_share, 3)})
    all_known = np.array(sorted(results))
    ma = metrics(all_known)
    mean_ms = float(ma["ms"].mean())
    search = {"n_candidates": int(N), "combos_per_line": K, "n_lines": int(len(vuln)),
              "exact_evaluated": int(len(results)), "ai_share": round(ai_share, 3),
              "mean_ms": round(mean_ms, 1), "est_minutes_all": round(mean_ms * N / 60000, 1),
              "est_minutes_ai": round(mean_ms * ai_set.sum() / 60000, 1), "validation_lines": len(v_lines)}
    log(f"AI 대리모델: 학습 {surrogate['n_train']:,}개 · 보류 R² {surrogate['r2_holdout']} · 순위상관 {surrogate['spearman_holdout']}")
    log(f"탐색: 후보 {N:,}개 전수 계산 추정 {search['est_minutes_all']}분 vs AI 방식 {search['est_minutes_ai']}분(계산 {ai_share:.0%})")
    for c in capture:
        log(f"  예산 {c['budget']:>4}: AI 포착 {c['share']:.0%}  (같은 비율 무작위 {c['random_30']:.0%})")
    return all_known, capture, ma, search, surrogate


def policy_insights(X, all_known, combo_feat, combo_of, ma, names, rng, seed):
    """SHAP: DRT·연장의 효과를 키우는 노선 조건"""
    insights = []
    try:
        import shap
        kfull = HistGradientBoostingRegressor(max_iter=300, learning_rate=0.06, random_state=seed).fit(X[all_known], np.log1p(ma["benefit"]))
        for kind_code, kind in [(1, "drt"), (2, "extension")]:
            sel = all_known[(combo_feat[combo_of[all_known], 1 if kind_code == 1 else 2] == 1) & ma["feasible"]]
            if len(sel) < 30:
                continue
            sub = sel[rng.choice(len(sel), min(2000, len(sel)), replace=False)]
            sv = shap.TreeExplainer(kfull).shap_values(X[sub], check_additivity=False)
            imp = np.abs(sv).mean(axis=0)
            top = [int(i) for i in np.argsort(-imp) if not names[i].startswith("정책:")][:3]
            insights.append({"kind": kind, "drivers": [{"feature": names[f], "direction": "클수록 효과↑" if (np.corrcoef(X[sub, f], sv[:, f])[0, 1] if X[sub, f].std() > 0 else 0) > 0 else "작을수록 효과↑",
                                                         "importance": round(float(imp[f]), 3)} for f in top]})
    except Exception as exc:
        log(f"SHAP 설명 생략: {exc}")
    return insights,


def build_portfolio(K, N, all_known, budgets_cfg, capture, ccfg, ccost, combo_of, combos, exact_seconds, insights, line_of, ma, pcfg, pop_source, search, surrogate, unit, vuln):
    """예산별 최종 포트폴리오(정밀 계산한 후보 중 비용 대비 편익 순, 노선당 조합 하나)"""
    budgets = []
    lines_known = line_of[all_known]
    for B in budgets_cfg:
        chosen_local, spent = greedy_portfolio(lines_known, ma["benefit"], ma["cost"], B)
        kinds = Counter()
        for j in chosen_local:
            code = combos[combo_of[all_known[j]]]["code"]
            kinds["drt" if code["spatial"] == 1 else "extension" if code["spatial"] == 2 else "frequency"] += 1
            if code["freq"] and code["spatial"]:
                kinds["combo"] += 1
        budgets.append({"budget": B, "spent": round(spent, 2), "n": len(chosen_local), "kinds": dict(kinds),
                        "benefit": round(float(ma["benefit"][chosen_local].sum()), 1),
                        "stranded_pop_saved": round(float(ma["d_str"][chosen_local].sum()), 1),
                        "co2_t_year": [round(float(ma["co2"][s][chosen_local].sum()), 1) for s in range(3)],
                        "items": chosen_local})
    top_local = sorted({j for b in budgets for j in b["items"]}, key=lambda j: -ma["benefit"][j] / max(ma["cost"][j], 1e-9))
    pos = {j: k for k, j in enumerate(top_local)}
    items = []
    for j in top_local:
        i = int(all_known[j]); cb = combos[combo_of[i]]
        items.append({"line": int(line_of[i]), "parts": cb["parts"], "label": cb["label"],
                      "kind": "drt" if cb["code"]["spatial"] == 1 else "extension" if cb["code"]["spatial"] == 2 else "frequency",
                      "benefit": round(float(ma["benefit"][j]), 2), "stranded_pop_saved": round(float(ma["d_str"][j]), 2),
                      "tvs_before": round(float(ma["tvs_before"][j]), 1), "tvs_after": round(float(ma["tvs_after"][j]), 1),
                      "co2_t_year": [round(float(ma["co2"][s][j]), 2) for s in range(3)], "cost": round(float(ma["cost"][j]), 3)})
    for b in budgets:
        b["items"] = [pos[j] for j in b["items"]]

    out = {"meta": {"unit": unit, "population_source": pop_source, "n_candidates": int(N), "n_lines": int(len(vuln)),
                    "combos_per_line": K, "search": search, "surrogate": surrogate, "capture": capture, "insights": insights,
                    "carbon": dict(ccfg), "benefit_note": pcfg["_benefit_note"], "cost_note": ccost["_note"],
                    "cost_sources": {"bus": ccost.get("_bus_source"), "drt": ccost.get("_drt_source")},
                    "exact_seconds": round(exact_seconds, 1)},
           "budgets": budgets, "items": items}
    return b, budgets, out


def main() -> None:
    import time
    params = load_params()
    pcfg, ccfg = params["policy"], params["carbon"]
    seed = params["simulation"]["random_seed"]
    rng = np.random.default_rng(seed)
    graph = read_json(INTERIM / "graph.json")
    scores = read_json(INTERIM / "scores.json")
    lines = graph["lines"]; G = graph["groups"]
    service_min = params["service"]["hours_per_day"] * 60
    pop_source = graph["meta"]["population_source"]
    ccost = pcfg["cost"]
    krw = bool(ccost.get("bus_vehicle_year_krw") and ccost.get("drt_vehicle_year_krw"))
    unit = "억 원/년" if krw else "버스 대·년"
    budgets_cfg = pcfg["budgets_eok"] if krw else pcfg["budgets"]

    # ------------------------------------------------------------- 후보 공간
    grade = np.array(scores["line"]["grade"])
    vuln = np.where(grade >= 2)[0]
    combos = combo_space(pcfg)
    K = len(combos)
    line_of = np.repeat(vuln, K)
    combo_of = np.tile(np.arange(K), len(vuln))
    N = len(line_of)
    cand = lambda i: [int(line_of[i]), combos[combo_of[i]]["parts"]]
    log(f"정책 조합 후보 {N:,}개 (취약 이상 노선 {len(vuln):,} × 조합 {K})")

    # ------------------------------------------------------------- 단계 1: 학습(T) + 검증(V) 정밀 계산
    train = rng.random(N) < pcfg["surrogate_train_share"]
    v_lines = set(rng.choice(vuln, max(1, int(len(vuln) * pcfg["validation_line_share"])), replace=False).tolist())
    valid = np.isin(line_of, list(v_lines))
    stage1 = np.where(train | valid)[0]
    t0 = time.time()
    res1 = run_stage("policy_s1", [cand(i) for i in stage1])
    results = dict(zip(stage1.tolist(), res1))

    # ------------------------------------------------------------- 지표 계산(정밀 결과가 있는 후보만)
    keys = ["time_increase", "access_loss", "no_alternative", "connectivity"]
    weights = params["tvs"]["route_weights"]
    aff_all = np.array(scores["line"]["affected"]); aff_pct_all = np.array(scores["line"]["components"]["affected_population"])
    main_dur = []
    for line in lines:
        rep = max(line["patterns"], key=lambda p: len(graph["patterns"]["stops"][p]))
        main_dur.append(graph["patterns"]["minutes"][rep][-1])
    vehicles = np.array([l["trips"] for l in lines]) * np.array(main_dur) / service_min
    line_km_all = np.array([l["length_km"] for l in lines])
    trip_km_all = sample_trip_km(graph, params["simulation"]["od_sample_fractions"])
    ci = carbon_inputs(lines, ccfg)
    log(f"탄소 입력(계산값): 1인당 통행 {ci['summary']['trips_per_person']}회, 대중교통 {ci['summary']['transit_trips_per_person']}, "
        f"CO2 {ci['summary']['co2_g_per_km_domestic']} g/km(국산 {ci['summary']['n_domestic_models']}개 모델), 전남광주 차량 {ci['summary']['car_per_person'].get('전남광주')}대/인")

    def metrics(idx):
        idx = np.asarray(idx)
        rs = [results[int(i)] for i in idx]
        L = line_of[idx]
        before = np.array([r["before"] for r in rs], float)
        after = np.array([r["after"] if r["after"] else r["before"] for r in rs], float)
        feas = np.array([r["feasible"] and r["after"] is not None for r in rs])
        tb = tvs(before, aff_pct_all[L], weights, keys); ta = tvs(after, aff_pct_all[L], weights, keys)
        d_str = np.where(feas, [r["strandedPopBefore"] - r["strandedPopAfter"] for r in rs], 0)
        d_ti = np.where(feas, before[:, 0] - after[:, 0], 0)
        ben = np.maximum(0, d_str + pcfg["benefit_time_weight"] * d_ti * aff_all[L])
        pairs = np.array([max(1, r["nPairs"]) for r in rs])
        iso_b = np.maximum(before[:, 2], np.array([r["discBefore"] for r in rs]) / pairs)
        iso_a = np.maximum(after[:, 2], np.array([r["discAfter"] for r in rs]) / pairs)
        co2 = np.where(feas, carbon_t_per_year(aff_all[L], iso_b, before[:, 0], trip_km_all[L], ci["transit_pp"][L], ci["car_pp"][L], ci, ccfg["days_per_year"])
                       - carbon_t_per_year(aff_all[L], iso_a, after[:, 0], trip_km_all[L], ci["transit_pp"][L], ci["car_pp"][L], ci, ccfg["days_per_year"]), 0)
        cost = np.zeros(len(idx))
        for j, (i, r) in enumerate(zip(idx, rs)):
            if not feas[j]:
                continue
            bus_vy, drt_vy = 0.0, 0.0
            for part in combos[combo_of[i]]["parts"]:
                if part["kind"] == "frequency":
                    bus_vy += vehicles[r["touchedLines"]].sum() * (part["opt"]["freqMultiplier"] - 1)
                elif part["kind"] == "drt":
                    # 끊긴 노선이 하던 하루 운행(시각표)을 DRT 가 대신: 운행마다 거점(다른 노선 정류장)에서 가장 먼 고립
                    # 정류장까지 왕복 → 필요한 차량 = 운행횟수 × 왕복시간 ÷ 하루 운행시간 (대기시간은 빼고 주행시간만)
                    # 운행마다 모든 고립 정류장을 도는 경로: 연결 거리의 합 + 가장 먼 정류장에서 돌아오는 거리
                    # (정류장이 하나면 정확히 왕복). 가장 먼 거리는 엔진의 DRT 소요시간에서 대기를 빼 되돌린다.
                    d_max = max(0.0, r["linkMaxMin"] - part["opt"]["waitMin"]) / 60 * 25 / 1.3
                    run_min = (r["linkKm"] + d_max) * 1.3 / 25 * 60
                    # 비용은 운행시간 비례(연장·증편과 같은 기준). 차량 대수로 올림하면 조금만 다녀도 1대 값이 붙어 DRT 가 불리해진다.
                    drt_vy += lines[line_of[i]]["trips"] * run_min / service_min if r["links"] else 0
                else:
                    # 연장: 연장하는 노선의 운행마다 늘어나는 주행(연결 평균 거리 왕복, 시속 20km·굴곡 1.3 — 엔진과 같은 값)
                    # 연장 노선들이 고립 정류장을 나눠 맡아 들렀다 오는 경로: (연결 거리의 합 + 평균 거리) ÷ 연장 노선 수
                    n_ext = max(1, len(r["extLines"]))
                    tour_km = (r["linkKm"] + r["linkKm"] / max(1, r["links"])) / n_ext
                    extra_min = tour_km * 1.3 / 20 * 60
                    bus_vy += sum(lines[e]["trips"] for e in r["extLines"]) * extra_min / service_min
            cost[j] = (bus_vy * ccost["bus_vehicle_year_krw"] + drt_vy * ccost["drt_vehicle_year_krw"]) / 1e8 if krw \
                else bus_vy + drt_vy * ccost["drt_to_bus_cost_ratio"]
        cost = np.maximum(cost, 0.01 * feas)
        return dict(benefit=ben, cost=cost, feasible=feas, d_str=d_str, tvs_before=tb, tvs_after=ta, co2=co2,
                    ms=np.array([r["ms"] for r in rs], float))

    # ------------------------------------------------------------- AI 대리모델(학습 T)
    X, combo_feat, names, pb, pr, t_idx = train_surrogate(G, aff_all, combo_of, combos, keys, line_km_all, line_of, lines, metrics, scores, seed, train, vehicles)

    # ------------------------------------------------------------- 단계 2: AI 선별(S) 정밀 계산
    rest = np.where(~train & (pb > 0.05))[0]
    n_short = int(pcfg["shortlist_share"] * N)
    short = rest[np.argsort(-pr[rest])[:n_short]]
    need = [int(i) for i in short if int(i) not in results]
    res2 = run_stage("policy_s2", [cand(i) for i in need])
    results.update(dict(zip(need, res2)))
    exact_seconds = time.time() - t0
    ai_set = np.zeros(N, bool); ai_set[t_idx] = True; ai_set[short] = True

    # ------------------------------------------------------------- 검증(V): 정답 최적 vs AI vs 무작위
    all_known, capture, ma, search, surrogate = validate_against_exact(K, N, ai_set, budgets_cfg, line_of, metrics, pb, pcfg, pr, results, rng, train, v_lines, valid, vuln)

    # SHAP: 정책 효과를 키우는 조건
    insights, = policy_insights(X, all_known, combo_feat, combo_of, ma, names, rng, seed)

    # ------------------------------------------------------------- 최종 포트폴리오(정밀 계산한 후보 중에서)
    b, budgets, out = build_portfolio(K, N, all_known, budgets_cfg, capture, ccfg, ccost, combo_of, combos, exact_seconds, insights, line_of, ma, pcfg, pop_source, search, surrogate, unit, vuln)
    out["meta"]["carbon"]["computed"] = ci["summary"]          # 탄소 입력 계산값(출처·수치)
    write_json(INTERIM / "policy.json", out)
    b = budgets[2]
    log(f"포트폴리오(예산 {b['budget']} {unit}): 노선 {b['n']}개 {b['kinds']}, 보호 인구 {b['stranded_pop_saved']:,.0f}명, "
        f"CO2 {b['co2_t_year'][1]:,.0f}t/년 (범위 {b['co2_t_year'][0]:,.0f}~{b['co2_t_year'][2]:,.0f})")


if __name__ == "__main__":
    main()
