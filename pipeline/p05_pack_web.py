"""5단계: 웹용 데이터 묶기 → data/web/seom_data.bin.gz

v6 는 JSON(최대 27MB)을 메인 스레드에서 JSON.parse 해서 화면이 굳었다. v7 은
  [4바이트 헤더 길이][헤더 JSON][8바이트 정렬 이진 배열들] 을 gzip 한 파일 하나로 만든다.
웹 워커가 압축을 풀고 타입 배열로 바꿔 '전달(transfer)'하므로 메인 스레드 비용이 거의 없다.
좌표는 정류장 그룹 좌표 하나만 저장하고, 노선 선형은 패턴의 정차 순서로 재구성한다(중복 제거).
"""
from __future__ import annotations

import gzip
import json
import struct

import numpy as np

from boundaries import boundary_paths
from common import INTERIM, WEB_DATA, load_params, log, read_json


class Packer:
    def __init__(self):
        self.chunks: list[bytes] = []
        self.offset = 0
        self.index: dict[str, list] = {}

    def add(self, name: str, values, dtype: str, scale: float | None = None):
        arr = np.asarray(values, dtype=float if scale else None)
        if scale:
            arr = np.round(arr * scale)
        arr = np.ascontiguousarray(arr.astype(dtype))
        raw = arr.tobytes()
        pad = (-self.offset) % 8
        if pad:
            self.chunks.append(b"\0" * pad); self.offset += pad
        self.index[name] = [np.dtype(dtype).name, self.offset, int(arr.size), scale]
        self.chunks.append(raw); self.offset += len(raw)

    def ragged(self, name: str, lists, dtype: str = "int32"):
        ptr = np.zeros(len(lists) + 1, dtype=np.int64)
        ptr[1:] = np.cumsum([len(x) for x in lists])
        self.add(name + "_ptr", ptr, "int32")
        self.add(name + "_idx", np.concatenate([np.asarray(x) for x in lists]) if ptr[-1] else [], dtype)


def u8_components(comp: dict, keys: list[str]) -> np.ndarray:
    return np.stack([np.clip(np.asarray(comp[k], dtype=float), 0, 1) for k in keys], axis=1).ravel()


def simplify_geojson(path, digits=3):
    feats = read_json(path)["features"]
    out = []
    for f in feats:
        geom = f["geometry"]
        if geom["type"] == "GeometryCollection":            # 다각형만 쓴다
            polys = [c for g in geom["geometries"] if g["type"] in ("Polygon", "MultiPolygon")
                     for c in (g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]])]
        else:
            polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        rings = [[[round(x, digits), round(y, digits)] for x, y in ring[::1]] for poly in polys for ring in poly]
        out.append({"code": f["properties"]["code"], "rings": rings})
    return out


def main() -> None:
    params = load_params()
    graph = read_json(INTERIM / "graph.json")
    scores = read_json(INTERIM / "scores.json")
    g, pt, lines = graph["groups"], graph["patterns"], graph["lines"]
    G, L = len(g["lon"]), len(lines)
    pk = Packer()

    # --- 정류장 그룹 (엔진 + 렌더링 + 정류장 레이어)
    pk.add("g_lon", g["lon"], "float32"); pk.add("g_lat", g["lat"], "float32")
    pk.add("g_pop", g["pop"], "float32"); pk.add("g_dest", g["dest"], "float32")
    pk.add("g_hosp", g.get("hosp_near", [0] * len(g["pop"])), "uint16")      # 도보 500m 안 병원 수(병원 데이터 연결 시)
    pk.add("g_modes", g["modes"], "uint16"); pk.add("g_nlines", g["n_lines"], "uint16")
    pk.add("g_region", g["region"], "uint16"); pk.add("g_members", g["stops_in_group"], "uint16")
    pk.add("g_senior", g["senior"], "int16", scale=10)
    pk.add("g_nearest", np.minimum(g["nearest_other_m"], 65000), "uint16")
    st = scores["stop"]
    stop_keys = list(params["tvs"]["stop_weights"])
    pk.add("g_score", st["score"], "uint16", scale=100)
    pk.add("g_grade", st["grade"], "uint8")
    pk.add("g_comp", u8_components(st["components"], stop_keys), "uint8", scale=250)
    if st["top"] is not None:
        top = np.asarray(st["top"])
        pk.add("g_top_f", top[:, :, 0].ravel(), "int8"); pk.add("g_top_v", top[:, :, 1].ravel(), "float32")
        pk.add("g_top_x", top[:, :, 2].ravel(), "float32")

    # --- 도보 링크
    pk.add("w_ptr", graph["walk"]["ptr"], "int32"); pk.add("w_idx", graph["walk"]["idx"], "int32")
    pk.add("w_min", graph["walk"]["min"], "float32")

    # --- 패턴
    pk.add("p_line", pt["line"], "int32"); pk.add("p_wait", pt["wait"], "float32"); pk.add("p_trips", pt["trips"], "float32")
    ptr = np.zeros(len(pt["stops"]) + 1, dtype=np.int64); ptr[1:] = np.cumsum([len(s) for s in pt["stops"]])
    pk.add("p_ptr", ptr, "int32")
    pk.add("p_stops", np.concatenate(pt["stops"]), "int32")
    pk.add("p_cum", np.concatenate(pt["minutes"]), "float32")

    # --- 운행계통
    ln = scores["line"]
    route_keys = list(params["tvs"]["route_weights"])
    region_of_group = np.asarray(g["region"])
    pk.add("l_mode", [int(l["mode"]) for l in lines], "uint8")
    pk.add("l_score", ln["score"], "uint16", scale=100); pk.add("l_grade", ln["grade"], "uint8")
    pk.add("l_comp", u8_components(ln["components"], route_keys), "uint8", scale=250)
    pk.add("l_affected", ln["affected"], "float32")
    pk.add("l_cluster", ln["cluster"], "int8")
    pk.add("l_trips", [l["trips"] for l in lines], "float32")
    pk.add("l_length", [l["length_km"] for l in lines], "float32")
    pk.add("l_region", [np.bincount(region_of_group[l["groups"]]).argmax() for l in lines], "uint16")
    pk.add("l_disc", ln["disconnected_pairs"], "uint8"); pk.add("l_pairs", ln["pairs"], "uint8")
    pk.ragged("l_stranded", ln["stranded"])
    if ln["top"] is not None:
        top = np.asarray(ln["top"])
        pk.add("l_top_f", top[:, :, 0].ravel(), "int8"); pk.add("l_top_v", top[:, :, 1].ravel(), "float32")
        pk.add("l_top_x", top[:, :, 2].ravel(), "float32")

    # --- 물리 구간
    sg = scores["segment"]
    pk.add("s_a", sg["a"], "int32"); pk.add("s_b", sg["b"], "int32")
    pk.add("s_score", sg["score"], "uint16", scale=100); pk.add("s_grade", sg["grade"], "uint8")
    pk.add("s_extra", [np.nan if v is None else v for v in sg["extra_min"]], "float32")
    pk.add("s_trips", sg["trips"], "float32")
    pk.add("s_comp", u8_components(sg["components"], list(params["tvs"]["segment_weights"])), "uint8", scale=250)

    # --- 격자
    grid = np.asarray(scores["grid"]["rows"], dtype=float)   # x, y, score, n, pop, unserved, grade
    pk.add("gr_x", grid[:, 0], "int16"); pk.add("gr_y", grid[:, 1], "int16")
    pk.add("gr_score", np.maximum(grid[:, 2], 0), "uint16", scale=100)
    pk.add("gr_n", grid[:, 3], "uint32"); pk.add("gr_pop", grid[:, 4], "float32")
    pk.add("gr_unserved", grid[:, 5], "float32"); pk.add("gr_grade", grid[:, 6], "uint8")

    # 도로 선형(11단계, 있으면): 정류장 쌍(a<b, a→b 방향)마다 도로를 따른 선. 백만분의 1도 정수로 바꾸고
    # 선마다 첫 점은 절댓값, 나머지는 앞 점과의 차이로 담는다(압축이 잘 됨).
    road_path = INTERIM / "road" / "shapes.npz"
    if road_path.exists():
        from pyproj import Transformer
        z = np.load(road_path)
        good = np.where(z["status"] == 1)[0]
        ptr, xy, pairs = z["ptr"], z["xy"].astype(np.float64), z["pairs"]
        lon, lat = Transformer.from_crs("EPSG:5186", "EPSG:4326", always_xy=True).transform(xy[:, 0], xy[:, 1])
        qx, qy = np.round(np.asarray(lon) * 1e6).astype(np.int64), np.round(np.asarray(lat) * 1e6).astype(np.int64)
        sel = np.concatenate([np.arange(ptr[k], ptr[k + 1]) for k in good])
        lens = (ptr[good + 1] - ptr[good])
        out_ptr = np.concatenate([[0], np.cumsum(lens)])
        dx, dy = np.diff(qx[sel], prepend=0), np.diff(qy[sel], prepend=0)
        dx[out_ptr[:-1]], dy[out_ptr[:-1]] = qx[sel][out_ptr[:-1]], qy[sel][out_ptr[:-1]]   # 선의 첫 점은 절댓값
        pk.add("rd_a", pairs[good, 0], "int32"); pk.add("rd_b", pairs[good, 1], "int32")
        pk.add("rd_ptr", out_ptr, "uint32"); pk.add("rd_x", dx, "int32"); pk.add("rd_y", dy, "int32")
        log(f"도로 선형 {len(good):,}개 · {len(sel):,}점")

    stats = read_json(INTERIM / "legacy_core.json")["stats"] if (INTERIM / "legacy_core.json").exists() else {}
    header = {
        "version": 7,
        "arrays": pk.index,
        "strings": {
            "group_name": g["name"],
            "line_name": [l["name"] for l in lines],
            "line_ids": [str(l["source_ids"][0]).split("#")[0] for l in lines],     # 원본 GTFS 패턴 ID 의 '#n' 은 뺀다(공유 링크 충돌)
            "regions": graph["regions"],
        },
        "geo": {
            "sido": simplify_geojson(boundary_paths()[1], 4),
            "sigungu": simplify_geojson(boundary_paths()[0], 4),
        },
        "sigungu": scores["sigungu"],
        "policy": read_json(INTERIM / "policy.json") if (INTERIM / "policy.json").exists() else None,
        "grid": {"cell": scores["grid"]["cell"], "origin": scores["grid"]["origin"]},
        "meta": {
            **scores["meta"],
            "source": graph["meta"],
            "stats": {**stats, "groups": G, "lines": L, "patterns": len(pt["line"]), "segments": len(sg["a"])},
            "keys": {"stop": stop_keys, "line": route_keys, "segment": list(params["tvs"]["segment_weights"])},
        },
    }
    head = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    head += b" " * ((-(len(head) + 4)) % 8)          # 이진 배열이 8바이트 경계에서 시작하도록
    blob = struct.pack("<I", len(head)) + head + b"".join(pk.chunks)
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    out = WEB_DATA / "seom_data.bin.gz"
    out.write_bytes(gzip.compress(blob, compresslevel=9))
    log(f"저장: {out} (원본 {len(blob) / 1e6:.1f}MB → 압축 {out.stat().st_size / 1e6:.1f}MB)")


if __name__ == "__main__":
    main()
