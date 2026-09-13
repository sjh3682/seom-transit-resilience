"""파이프라인 테스트:  python tests/test_pipeline.py   (pytest 로도 실행 가능)

1) GTFS 불러오기 — 작은 가상 GTFS 로 패턴·운행횟수·시각표 소요시간을 확인
2) 이름 정규화 — 방향만 다른 노선명이 같은 키가 되는지
3) 결과 검증 — 전국 결과가 상식적인 성질을 지키는지(파이프라인을 돌린 뒤에만)
   · 왕복 노선이 운행계통으로 통합됐는지
   · 섬 항로 제거 시 단절이 잡히는지, 섬 내 유일 버스가 매우 취약인지
   · '대체경로 부족'은 도시철도가 버스보다 낮은지(도시철도는 끊기면 느려지지만 고립되지는 않는다)
   · 가중치를 바꿔도 순위가 크게 흔들리지 않는지
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))

from common import INTERIM, direction_free_name_key  # noqa: E402


def write_fixture(folder: Path) -> None:
    (folder / "stops.txt").write_text(
        "stop_id,stop_name,stop_lat,stop_lon\nA,가,36.0,127.00\nB,나,36.0,127.01\nC,다,36.0,127.02\n", encoding="utf-8")
    (folder / "routes.txt").write_text("route_id,route_short_name,route_type\nR1,10,3\n", encoding="utf-8")
    (folder / "calendar.txt").write_text(
        "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
        "WK,1,1,1,1,1,0,0,20250101,20251231\n", encoding="utf-8")
    trips = ["route_id,service_id,trip_id,direction_id"]
    times = ["trip_id,arrival_time,departure_time,stop_id,stop_sequence"]
    for i in range(3):   # 평일 3회 왕복
        trips += [f"R1,WK,T{i}u,0", f"R1,WK,T{i}d,1"]
        h = 7 + i
        times += [f"T{i}u,{h:02d}:00:00,{h:02d}:00:00,A,1", f"T{i}u,{h:02d}:04:00,{h:02d}:04:00,B,2", f"T{i}u,{h:02d}:10:00,{h:02d}:10:00,C,3",
                  f"T{i}d,{h:02d}:30:00,{h:02d}:30:00,C,1", f"T{i}d,{h:02d}:36:00,{h:02d}:36:00,B,2", f"T{i}d,{h:02d}:40:00,{h:02d}:40:00,A,3"]
    (folder / "trips.txt").write_text("\n".join(trips) + "\n", encoding="utf-8")
    (folder / "stop_times.txt").write_text("\n".join(times) + "\n", encoding="utf-8")


def test_gtfs_import():
    from p01_import_network import import_gtfs
    with tempfile.TemporaryDirectory() as tmp:
        write_fixture(Path(tmp))
        net = import_gtfs(Path(tmp))
    assert len(net["patterns"]) == 2                          # 방향별 패턴 2개
    up = next(p for p in net["patterns"] if p["stops"][0] == 0)
    assert up["minutes"] == [0.0, 4.0, 10.0]                  # 실제 시각표 소요시간
    assert abs(up["trips_per_day"] - 3 * 5 / 7) < 0.01          # 평일 3회 → 하루 평균(소수 둘째 자리 반올림)
    assert up["mode"] == "0"


def test_direction_free_names():
    assert direction_free_name_key("인천항↔백령도") == direction_free_name_key("백령도↔인천항")
    assert direction_free_name_key("동대구-동서울") == direction_free_name_key("동서울-동대구")
    assert direction_free_name_key("122") == "122"


def _results():
    graph = json.loads((INTERIM / "graph.json").read_text(encoding="utf-8"))
    scores = json.loads((INTERIM / "scores.json").read_text(encoding="utf-8"))
    return graph, scores


def test_results_are_sane():
    if not (INTERIM / "scores.json").exists():
        print("  (결과 파일이 없어 결과 검증은 건너뜀)")
        return
    graph, scores = _results()
    lines = graph["lines"]
    modes = np.array([l["mode"] for l in lines])
    score = np.array(scores["line"]["score"])
    grade = np.array(scores["line"]["grade"])
    comp = scores["line"]["components"]

    # 왕복 통합: 같은 교통수단·방향무관 이름·같은 구간 집합인 계통이 둘 이상 남아 있으면 안 됨
    seen = set()
    for l, p_idx in ((l, l["patterns"]) for l in lines):
        edges = frozenset(frozenset(e) for p in p_idx for e in zip(graph["patterns"]["stops"][p], graph["patterns"]["stops"][p][1:]))
        key = (l["mode"], direction_free_name_key(l["name"]), edges)
        if l["name"]:
            assert key not in seen, f"통합되지 않은 중복 운행계통: {l['name']}"
            seen.add(key)

    by_name = {l["name"]: i for i, l in enumerate(lines)}
    ferry = by_name["백령도↔인천항_인천"]
    assert scores["line"]["disconnected_pairs"][ferry] > 0, "섬 항로 제거 시 단절이 잡혀야 함"
    assert grade[ferry] >= 2, "인천↔백령도 항로는 취약 이상이어야 함"
    assert grade[by_name["백령도"]] == 3, "섬 내 유일 버스는 매우 취약이어야 함"

    no_alt = np.array(comp["no_alternative"])
    assert no_alt[modes == "1"].mean() < no_alt[modes == "0"].mean(), "도시철도의 대체경로 부족이 버스보다 낮아야 함"

    top = np.argsort(-score)[:100]
    island_or_rural = {c["name"] for c in scores["meta"]["clusters"]} & {"섬·해상 항로형", "농어촌 말단 고립형"}
    names = [scores["meta"]["clusters"][c]["name"] if c >= 0 else "" for c in np.array(scores["line"]["cluster"])[top]]
    assert sum(n in island_or_rural for n in names) >= 50, "상위 100개 노선의 절반 이상은 섬·농어촌 유형이어야 함"

    assert scores["meta"]["sensitivity"]["spearman_median"] >= 0.9, "가중치 민감도: 순위가 너무 흔들림"

    # 등급은 전국 50·80·95% 분위: 동점이 한 등급에 몰리면(v7.0 정류장 400m 절벽) 비율이 크게 어긋난다
    target = np.diff([0, 0.5, 0.8, 0.95, 1.0])
    for layer in ("line", "stop", "segment"):
        g = np.array(scores[layer]["grade"])
        share = np.array([(g == k).mean() for k in range(4)])
        assert np.abs(share - target).max() < 0.03, f"{layer} 등급 비율이 50·30·15·5% 와 다름: {np.round(share * 100, 1)}"


def test_waits_use_line_frequency():
    """같은 노선의 변형 패턴 운행을 합쳐 대기시간을 계산해야 한다(서울 2호선이 패턴별 1~3회로 쪼개져 대기 30분이던 오류)."""
    import numpy as np
    g = json.loads((INTERIM / "graph.json").read_text(encoding="utf-8"))
    lines, P = g["lines"], g["patterns"]
    wait = np.array(P["wait"])
    metro = np.array([lines[l]["mode"] == "1" for l in P["line"]])
    assert np.median(wait[metro]) < 8, f"도시철도 대기 중앙값이 너무 김: {np.median(wait[metro]):.1f}분"
    l2 = next(i for i, l in enumerate(lines) if l["name"] == "서울2호선")
    assert max(wait[p] for p in lines[l2]["patterns"]) < 6, "서울 2호선 대기가 실제 배차보다 너무 김"


def test_policy_results_are_sane():
    """AI 정책 최적화 결과: 예산이 클수록 편익이 커지고, AI 포착률이 충분하며, DRT 는 고립을 줄여야 한다."""
    path = INTERIM / "policy.json"
    if not path.exists():
        print("  (policy.json 이 없어 건너뜀)")
        return
    pol = json.loads(path.read_text(encoding="utf-8"))
    benefits = [b["benefit"] for b in pol["budgets"]]
    assert all(x <= y + 1e-6 for x, y in zip(benefits, benefits[1:])), f"예산이 커졌는데 편익이 줄어듦: {benefits}"
    assert all(b["spent"] <= b["budget"] + 1e-6 for b in pol["budgets"]), "예산 초과"
    assert min(c["share"] for c in pol["meta"]["capture"]) >= 0.8, f"AI 포착률이 80% 미만: {pol['meta']['capture']}"
    drt = [it for it in pol["items"] if it["kind"] == "drt"]
    assert drt and all(it["stranded_pop_saved"] >= 0 for it in drt)
    assert all(it["tvs_after"] <= it["tvs_before"] + 1e-6 for it in pol["items"]), "정책 적용 후 TVS 가 오르면 안 됨"


def test_engine_matches_pipeline():
    """웹 버튼(엔진 재계산)과 지도 점수(파이프라인)가 같은지 — 무작위 30개 노선"""
    if not (INTERIM / "sim_lines.json").exists():
        return
    script = ROOT / "tests" / "consistency.js"
    out = subprocess.run(["node", "--max-old-space-size=2500", str(script)], capture_output=True, text=True, timeout=600)
    assert out.returncode == 0, out.stdout + out.stderr


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"통과: {name}")
