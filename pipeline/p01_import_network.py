"""1단계: 교통망 불러오기 → data/interim/network.json

두 가지 입력을 지원한다.
  --gtfs <폴더 또는 zip>   : 표준 GTFS(stops/routes/trips/stop_times[/calendar]) — 권장 경로
  --legacy-html <html>     : 이전 버전(v5·v6) HTML에 내장된 KTDB 그래프 데이터 — 원본 GTFS가 없을 때의 대체 경로

출력 형식(두 입력 모두 동일):
  stops    : {id, name, lon, lat}               (열 단위 배열)
  patterns : [{id, route_id, name, mode, region, trips_per_day, stops, minutes}]
             stops   = 정차 순서(stops 배열 인덱스), 방향이 있는 순서다.
             minutes = 출발 기준 누적 소요시간(분). GTFS에서는 실제 시각표로, legacy 에서는 null(다음 단계에서 추정).
"""
from __future__ import annotations

import argparse
import io
import zipfile
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

from common import INTERIM, log, write_json

# GTFS route_type(기본 + 확장) → 프로젝트 교통수단 코드(config/params.json 의 modes)
GTFS_ROUTE_TYPE_TO_MODE = {
    0: "1", 1: "1", 2: "4", 3: "0", 4: "2", 5: "1", 6: "1", 7: "1", 11: "0", 12: "1",
    101: "6", 102: "4", 103: "4", 106: "4", 109: "4",
    200: "3", 201: "3", 202: "3", 204: "3", 205: "5",
    400: "1", 401: "1", 402: "1", 405: "1",
    700: "0", 701: "0", 702: "0", 704: "0", 715: "0",
    1000: "2", 1200: "2", 1100: "7",
}


# ---------------------------------------------------------------------------
# GTFS
# ---------------------------------------------------------------------------
class GtfsSource:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._zip = zipfile.ZipFile(self.path) if self.path.suffix == ".zip" else None

    def has(self, name: str) -> bool:
        if self._zip:
            return any(n.endswith(name) for n in self._zip.namelist())
        return (self.path / name).exists()

    def open(self, name: str):
        if self._zip:
            member = next(n for n in self._zip.namelist() if n.endswith(name))
            return io.TextIOWrapper(self._zip.open(member), encoding="utf-8-sig")
        return open(self.path / name, encoding="utf-8-sig")


def _seconds(series: pd.Series) -> np.ndarray:
    parts = series.fillna("").astype(str).str.split(":", expand=True)
    if parts.shape[1] < 3:
        return np.full(len(series), np.nan)
    h, m, s = (pd.to_numeric(parts[i], errors="coerce") for i in range(3))
    return (h * 3600 + m * 60 + s).to_numpy(dtype=float)


def _service_days_per_week(src: GtfsSource) -> dict[str, float]:
    if not src.has("calendar.txt"):
        return {}
    cal = pd.read_csv(src.open("calendar.txt"), dtype=str)
    days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    cal[days] = cal[days].astype(int)
    return dict(zip(cal["service_id"], cal[days].sum(axis=1).astype(float)))


def import_gtfs(path: Path, route_type_scheme: str = "auto") -> dict:
    """route_type_scheme: 'ktdb' = KTDB 자체 코드(0 시내버스 … 7 항공, 설명서: 국제 표준과 다르게 구축),
    'gtfs' = 국제 표준, 'auto' = agency.txt 가 KTDB 면 ktdb."""
    src = GtfsSource(path)
    log(f"GTFS 읽는 중: {path}")
    stops = pd.read_csv(src.open("stops.txt"), dtype={"stop_id": str})
    routes = pd.read_csv(src.open("routes.txt"), dtype={"route_id": str})
    if route_type_scheme == "auto":
        agency = pd.read_csv(src.open("agency.txt"), dtype=str) if src.has("agency.txt") else pd.DataFrame()
        route_type_scheme = "ktdb" if len(agency) and agency.get("agency_name", pd.Series()).str.contains("KTDB").any() else "gtfs"
    log(f"route_type 해석: {route_type_scheme}")
    to_mode = (lambda t: str(int(t)) if 0 <= int(t) <= 7 else "0") if route_type_scheme == "ktdb" \
        else (lambda t: GTFS_ROUTE_TYPE_TO_MODE.get(int(t), "0"))
    trips = pd.read_csv(src.open("trips.txt"), dtype={"route_id": str, "trip_id": str, "service_id": str})

    stop_index = {sid: i for i, sid in enumerate(stops["stop_id"])}
    days_per_week = _service_days_per_week(src)
    # 운행일 정보가 있으면 "하루 평균 운행횟수", 없으면 파일 안 운행을 하루치로 간주
    trip_weight = trips["service_id"].map(lambda s: days_per_week.get(s, 7.0) / 7.0).to_numpy()
    trip_meta = {
        tid: (rid, w) for tid, rid, w in zip(trips["trip_id"], trips["route_id"], trip_weight)
    }

    # stop_times 는 수천만 행이 될 수 있어 조각 단위로 읽고, 운행(trip) 경계에서 이어 붙인다.
    pattern_acc: dict[tuple, dict] = {}
    carry = None
    usecols = ["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"]
    reader = pd.read_csv(src.open("stop_times.txt"), usecols=usecols,
                         dtype={"trip_id": str, "stop_id": str, "arrival_time": str, "departure_time": str},
                         chunksize=2_000_000)
    n_chunk = 0

    flushed = set()
    split_trips = 0

    def flush_trip(tid, stop_ids, secs):
        nonlocal split_trips
        if tid in flushed:
            split_trips += 1          # 운행 행이 파일 안에서 흩어져 있으면 조각으로 잘린다(경고)
        flushed.add(tid)
        if tid not in trip_meta or len(stop_ids) < 2:
            return
        rid, weight = trip_meta[tid]
        seq = tuple(stop_index[s] for s in stop_ids if s in stop_index)
        if len(seq) < 2:
            return
        key = (rid, seq)
        rel = secs - secs[0]
        acc = pattern_acc.get(key)
        if acc is None:
            pattern_acc[key] = {"trips": weight, "sum": np.nan_to_num(rel), "n": 1}
        else:
            acc["trips"] += weight
            acc["sum"] += np.nan_to_num(rel)
            acc["n"] += 1

    for chunk in reader:
        n_chunk += 1
        log(f"  stop_times {n_chunk * 2:,}백만 행째")
        chunk = chunk.sort_values(["trip_id", "stop_sequence"], kind="stable")
        if carry is not None:
            chunk = pd.concat([carry, chunk])
        last_tid = chunk["trip_id"].iloc[-1]
        carry = chunk[chunk["trip_id"] == last_tid]
        body = chunk[chunk["trip_id"] != last_tid]
        secs_all = _seconds(body["departure_time"].where(body["departure_time"].notna(), body["arrival_time"]))
        stop_all = np.asarray(body["stop_id"].astype(object))   # 조각마다 한 번만(운행마다 꺼내면 매우 느리다)
        for tid, idx in body.groupby("trip_id", sort=False).indices.items():
            flush_trip(tid, stop_all[idx], secs_all[idx])
    if carry is not None and len(carry):
        secs = _seconds(carry["departure_time"])
        flush_trip(carry["trip_id"].iloc[0], carry["stop_id"].to_numpy(), secs)

    if split_trips:
        log(f"경고: 흩어진 운행 {split_trips:,}건(stop_times 가 trip_id 순으로 정렬돼 있지 않음)")
    log(f"운행 {len(flushed):,}건 처리")
    route_rows = routes.set_index("route_id")
    patterns = []
    counter = defaultdict(int)
    for (rid, seq), acc in pattern_acc.items():
        row = route_rows.loc[rid] if rid in route_rows.index else None
        rtype = int(row["route_type"]) if row is not None else 3
        name = ""
        if row is not None:
            name = str(row.get("route_short_name") or "") or str(row.get("route_long_name") or "")
        counter[rid] += 1
        minutes = (acc["sum"] / acc["n"] / 60.0).round(2).tolist()
        patterns.append({
            "id": f"{rid}#{counter[rid]}",
            "route_id": rid,
            "name": name if name != "nan" else "",
            "mode": to_mode(rtype),
            "region": "",
            "trips_per_day": round(float(acc["trips"]), 2),
            "stops": list(seq),
            "minutes": minutes if minutes[-1] > 0 else None,
        })
    log(f"GTFS 패턴 {len(patterns):,}개, 정류장 {len(stops):,}개")
    return {
        "source": "gtfs",
        "stops": {
            "id": stops["stop_id"].tolist(),
            "name": stops["stop_name"].fillna("").astype(str).tolist(),
            "lon": stops["stop_lon"].astype(float).round(6).tolist(),
            "lat": stops["stop_lat"].astype(float).round(6).tolist(),
        },
        "patterns": patterns,
        "meta": {"stop_times_rows": None, "trips": int(len(flushed)), "route_type_scheme": route_type_scheme},
    }


# ---------------------------------------------------------------------------
# 이전 버전 HTML (원본 GTFS 가 없을 때)
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--gtfs", type=Path)
    group.add_argument("--legacy-html", type=Path)
    parser.add_argument("--route-type-scheme", choices=["auto", "ktdb", "gtfs"], default="auto")
    parser.add_argument("--out", type=Path, default=INTERIM / "network.json")
    args = parser.parse_args()

    if args.gtfs:
        network = import_gtfs(args.gtfs, args.route_type_scheme)
    else:
        from legacy_v6 import import_legacy_html      # 원본 GTFS 가 없을 때만(대체 경로)
        network = import_legacy_html(args.legacy_html)
    write_json(args.out, network)
    log(f"저장: {args.out}")


if __name__ == "__main__":
    main()
