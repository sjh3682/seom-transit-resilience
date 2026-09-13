"""12단계: 정류장 '영향 규모' 지표를 민간 교통카드 데이터(서울시 버스 승하차)로 검증한다.

우리 분석은 전국을 다루므로 정류장별 실제 이용객을 알 수 없다. 대신 도보권 인구와 서비스 수준으로 추정하는데,
이 추정이 실제 이용과 맞는지는 확인해야 한다. 서울은 교통카드 기반 정류장별 승하차가 공개돼 있어 검증에 쓴다.

입력: data/external/seoul_bus_boarding_2026_08.csv
      (서울특별시 버스노선별 정류장별 시간대별 승하차 인원, 교통카드 사업자 수집 → 서울시 개방)
출력: data/interim/demand_validation.json  후보 지표별 순위상관, 선택한 지표

    python pipeline/p12_validate_demand.py
"""
from __future__ import annotations

import re

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from common import EXTERNAL, INTERIM, log, read_json, write_json

FILE = "seoul_bus_boarding_2026_08.csv"
DAYS = 31


def seoul_boardings() -> dict:
    """정류장 이름(뒤 괄호 번호 제외)별 한 달 승차 합계."""
    d = pd.read_csv(EXTERNAL / FILE, encoding="cp949", dtype=str, low_memory=False)
    ride = [c for c in d.columns if "승차총승객수" in c]
    for c in ride:
        d[c] = pd.to_numeric(d[c], errors="coerce").fillna(0)
    d["board"] = d[ride].sum(axis=1)
    d["base"] = d["역명"].str.replace(r"\(\d+\)$", "", regex=True).str.strip()
    return d.groupby("base")["board"].sum().to_dict()


def main() -> None:
    if not (EXTERNAL / FILE).exists():
        log(f"{FILE} 이 없어 검증을 건너뜁니다"); return
    graph = read_json(INTERIM / "graph.json")
    scores = read_json(INTERIM / "scores.json")
    board = seoul_boardings()
    reg = graph["regions"]
    seoul = {i for i, r in enumerate(reg) if r["sido"] == "서울"}
    G = graph["groups"]
    pop = np.asarray(G["pop"], float); nl = np.asarray(G["n_lines"], float)
    idx, actual = [], []
    for i, (name, r) in enumerate(zip(G["name"], G["region"])):
        if r not in seoul:
            continue
        key = re.sub(r"\(중\)$", "", name).strip()
        if board.get(key, 0) > 0:
            idx.append(i); actual.append(board[key])
    idx = np.array(idx); actual = np.array(actual, float) / DAYS
    if len(idx) < 100:
        log("이름이 맞는 정류장이 적어 검증을 건너뜁니다"); return
    cands = {
        "도보권 인구만": pop[idx],
        "서는 노선 수만": nl[idx],
        "인구 × 노선 수": pop[idx] * nl[idx],
        "√인구 × 노선 수 (채택)": np.sqrt(pop[idx]) * nl[idx],
    }
    rows = [{"proxy": k, "spearman": round(float(spearmanr(v, actual).statistic), 3)} for k, v in cands.items()]
    used = np.asarray(scores["stop"]["components"]["affected_population"], float)[idx]
    r_used = float(spearmanr(used, actual).statistic)
    for row in sorted(rows, key=lambda x: -x["spearman"]):
        log(f"  {row['proxy']:22s} 순위상관 {row['spearman']:+.3f}")
    log(f"실제 분석에 쓴 영향 규모 지표: 순위상관 {r_used:+.3f} (검증 정류장 {len(idx):,}곳, 하루 승차 중앙값 {np.median(actual):.0f}명)")
    write_json(INTERIM / "demand_validation.json", {
        "source": "서울특별시 버스노선별 정류장별 시간대별 승하차 인원(2026.8) — 교통카드 사업자 수집 자료를 서울시가 개방",
        "n_stops": int(len(idx)), "median_daily_boardings": float(np.median(actual)),
        "candidates": rows, "used_in_analysis": round(r_used, 3),
        "note": "전국 분석이라 정류장별 실제 이용객은 알 수 없다. 서울 실측으로 대리지표의 타당성을 확인한 것이다.",
    })


if __name__ == "__main__":
    main()
