"""외부 데이터 읽기 테스트:  python3 tests/test_external_data.py

실제 배포 파일 형식을 흉내 낸 작은 가짜 파일로 확인한다.
  - 행정안전부 연령별 인구현황 CSV (CP949, 쉼표 숫자, 5세·10세 구간, '행정구역(10자리 코드)')
  - 심평원 병원정보서비스 엑셀(좌표(X)/좌표(Y))
  - 의료기관 종류 필터(치과·한의 제외)와 요약
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))

from external_data import facility_stats, filter_kinds, load_hira_hospitals, load_mois_population, match_dongs  # noqa: E402

AGES5 = [f"{a}~{a + 4}세" for a in range(0, 100, 5)] + ["100세 이상"]


def mois_csv(folder: Path, bins=AGES5) -> Path:
    month = "2025년08월"
    cols = ["행정구역", f"{month}_계_총인구수", f"{month}_계_연령구간인구수"] + [f"{month}_계_{b}" for b in bins]
    cols += [f"{month}_남_총인구수"]
    rows = []
    for name, code, per_bin in [("서울특별시  ", "1100000000", 1000), ("서울특별시 종로구 ", "1111000000", 100),
                                ("서울특별시 종로구 사직동", "1111053000", 10), ("인천광역시 옹진군 백령면", "2872033000", 5)]:
        vals = [per_bin] * len(bins)
        rows.append([f"{name}({code})", f"{sum(vals):,}", f"{sum(vals):,}"] + [f"{v:,}" for v in vals] + ["0"])
    path = folder / "mois_population.csv"
    pd.DataFrame(rows, columns=cols).to_csv(path, index=False, encoding="cp949")
    return path


def test_mois_5year():
    with tempfile.TemporaryDirectory() as tmp:
        df = load_mois_population(mois_csv(Path(tmp)))
    dong = df[df.level == "dong"].set_index("code10")
    assert set(dong.index) == {"1111053000", "2872033000"}
    # 5세 구간 21개 중 65세 이상은 65~69 … 95~99, 100세 이상 = 8개
    assert dong.loc["1111053000", "total"] == 210 and dong.loc["1111053000", "senior65"] == 80
    assert abs(dong.loc["2872033000", "senior_pct"] - 8 / 21 * 100) < 1e-6
    assert set(df.level) == {"dong", "sigungu", "sido"}


def test_mois_10year_is_proportional():
    bins10 = [f"{a}~{a + 9}세" for a in range(0, 100, 10)] + ["100세 이상"]
    with tempfile.TemporaryDirectory() as tmp:
        df = load_mois_population(mois_csv(Path(tmp), bins10))
    row = df[df.code10 == "1111053000"].iloc[0]
    assert row.senior65 == 10 * 0.5 + 10 * 3 + 10      # 60~69의 절반 + 70·80·90대 + 100세 이상


def test_hira_hospitals_and_pharmacies():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        pd.DataFrame({"요양기관명": ["가병원", "나의원", "다의원"], "종별코드명": ["병원", "치과의원", "의원"],
                      "좌표(X)": ["126.9780", "126.9900", "0"], "좌표(Y)": ["37.5665", "37.5700", "0"]}
                     ).to_excel(tmp / "h.xlsx", index=False)
        pd.DataFrame({"요양기관명": ["라약국"], "좌표(X)": ["127.01"], "좌표(Y)": ["37.58"]}).to_excel(tmp / "p.xlsx", index=False)
        df = load_hira_hospitals(tmp / "h.xlsx", tmp / "p.xlsx")
    assert len(df) == 3                       # 좌표 0 인 행 제외
    kept = filter_kinds(df, "치과|한의|한방")
    assert list(kept.name) == ["가병원", "라약국"]
    assert facility_stats(kept) == {"sources": ["hira"], "count": 2, "hospitals": 1, "pharmacies": 1}


def test_match_dongs_by_code_then_name():
    """코드가 바뀐 행정동(예: 시도 통합)은 '시군구+동' 이름으로, 띄어쓰기 차이(수원시 장안구)도 맞춘다."""
    mois = pd.DataFrame({
        "code10": ["1111053000", "1211051000", "4111151000"],
        "name": ["서울특별시 종로구 사직동", "전남광주통합특별시 순천시 향동", "경기도 수원시 장안구 파장동"],
        "level": ["dong"] * 3, "total": [100.0, 200.0, 300.0], "senior_pct": [10.0, 20.0, 30.0]})
    codes = ["1111053000", "4615051000", "4111152000", "9999999999"]
    names = ["서울특별시 종로구 사직동", "전라남도 순천시 향동", "경기도 수원시장안구 파장동", "어딘가 없는동"]
    total, senior, stats = match_dongs(codes, names, mois)
    assert list(total[:3]) == [100, 200, 300] and np.isnan(total[3])
    assert {k: stats[k] for k in ("by_code", "by_name", "unmatched_boundaries", "mois_dongs")} == \
        {"by_code": 1, "by_name": 2, "unmatched_boundaries": 1, "mois_dongs": 3}


def test_match_dongs_when_sigungu_renamed():
    """시군구 이름까지 바뀐 경우(2026 인천 중구 → 새 구): '시도+동' 이름이 유일하면 맞춘다."""
    mois = pd.DataFrame({"code10": ["2811055000"], "name": ["인천광역시 제물포구 신포동"], "level": ["dong"],
                         "total": [5000.0], "senior_pct": [30.0]})
    total, _, stats = match_dongs(["2811061000"], ["인천광역시 중구 신포동"], mois)
    assert total[0] == 5000 and stats["by_sido_dong"] == 1 and stats["population_matched_share"] == 1.0


def test_mois_wide_format_from_data_go_kr():
    """공공데이터포털 형식: 코드 열 따로, '0세남자'…'100세이상여자' 열(남녀 합산)."""
    cols = {"기준연월": ["202606", "202606"], "시도명": ["서울특별시", "인천광역시"], "시군구명": ["종로구", "옹진군"],
            "읍면동명": ["사직동", "백령면"], "행정기관코드": ["1111053000", "2872033000"]}
    for a in list(range(0, 100)) + [100]:
        label = f"{a}세이상" if a == 100 else f"{a}세"
        cols[f"{label}남자"] = ["1", "2"]; cols[f"{label}여자"] = ["1", "2"]
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "mois_population.csv"
        pd.DataFrame(cols).to_csv(path, index=False, encoding="cp949")
        df = load_mois_population(path)
    row = df.set_index("code10").loc["2872033000"]
    assert row.level == "dong" and row.total == 101 * 4 and row.senior65 == 36 * 4 and row["name"] == "인천광역시 옹진군 백령면"



def test_carbon_inputs_from_public_data():
    """탄소 입력이 공공자료에서 계산되는지(가정값 없음): 전남광주 차감 계산, 국산 휘발유 승용 CO2, 지역 유형별 대중교통 이용."""
    import sys
    sys.path.insert(0, str(ROOT / "pipeline"))
    from p08_policy_ai import carbon_inputs
    from common import load_params
    cfg = load_params()["carbon"]
    lines = [{"sido": "서울"}, {"sido": "대구"}, {"sido": "전남광주"}, {"sido": "강원"}]
    ci = carbon_inputs(lines, cfg)
    assert abs(ci["car_pp"][2] - 0.645) < 0.005, ci["car_pp"]          # 전국 − 나머지 시도
    assert 0.15 < ci["kg_km"] < 0.19, ci["kg_km"]                      # 국산 휘발유 승용 표시 CO2
    assert ci["transit_pp"][0] > ci["transit_pp"][1] > ci["transit_pp"][3] > 0   # 서울 > 광역시 > 시군

if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"통과: {name}")
