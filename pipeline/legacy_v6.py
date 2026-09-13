"""이전 v6 HTML(섬이_되는_길_v6_수정판.html)에서 교통망·v6 점수를 꺼낸다 — 원본 GTFS 가 없을 때만 쓰는 대체 경로.

원본 GTFS 를 쓰는 지금은 필요 없지만, v6 정적 점수(legacy_scores.json)는 새 결과와 비교하는 데 쓴다.
    python pipeline/p01_import_network.py --legacy-html data/raw/legacy_v6.html
"""
from __future__ import annotations

import base64
import gzip
import re
from pathlib import Path


from common import INTERIM, log, write_json


def _html_tag(html: str, tag_id: str) -> str:
    match = re.search(r'<script id="' + tag_id + r'"[^>]*>(.*?)</script>', html, re.S)
    if not match:
        raise KeyError(f"{tag_id} 태그가 없습니다")
    return match.group(1).strip()


def _html_packed(html: str, tag_id: str):
    import json
    return json.loads(gzip.decompress(base64.b64decode(_html_tag(html, tag_id))))


def import_legacy_html(path: Path) -> dict:
    import json
    log(f"이전 버전 HTML 에서 KTDB 그래프 데이터 추출: {path}")
    html = Path(path).read_text(encoding="utf-8")
    core = json.loads(_html_tag(html, "corePlain"))
    journey = _html_packed(html, "journeyData")
    route_rows = _html_packed(html, "routeHighData") + _html_packed(html, "routeLowData")
    trips_by_id = {r[0]: float(r[6]) for r in route_rows}

    stop_rows = journey["s"]      # [id, name, lon, lat, route_count, city, region, senior]
    patterns = []
    for r in journey["r"]:        # [id, name, type, region, score, grade, sequence, ...]
        seq = [int(s) for s in r[6]]
        if len(seq) < 2:
            continue
        name = "" if str(r[1]) in ("nan", "None") else str(r[1])
        patterns.append({
            "id": r[0],
            "route_id": r[0],
            "name": name,
            "mode": str(r[2]),
            "region": str(r[3] or ""),
            "trips_per_day": trips_by_id.get(r[0], 1.0),
            "stops": seq,
            "minutes": None,
        })
    log(f"패턴 {len(patterns):,}개, 정류장 {len(stop_rows):,}개")
    stop_rows_scored = _html_packed(html, "stopHighData") + _html_packed(html, "stopLowData")
    write_json(INTERIM / "legacy_scores.json", {   # v6 정적 점수: 새 시뮬레이션 결과와 비교용
        "route": {r[0]: r[4] for r in route_rows},
        "stop": {s[5]: s[2] for s in stop_rows_scored},
    })
    write_json(INTERIM / "legacy_core.json", {
        "boundary": core["boundary"],
        "senior_regions": core["stats"]["senior_regions"],
        "stats": {k: core["stats"][k] for k in ("stops", "routes", "trips", "stop_times")},
    })
    return {
        "source": "legacy_html",
        "stops": {
            "id": [s[0] for s in stop_rows],
            "name": [str(s[1]) for s in stop_rows],
            "lon": [float(s[2]) for s in stop_rows],
            "lat": [float(s[3]) for s in stop_rows],
        },
        "patterns": patterns,
        "meta": {"stop_times_rows": core["stats"]["stop_times"], "trips": core["stats"]["trips"]},
    }
