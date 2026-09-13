"""10단계: 국가 표준노드링크(도로 링크 155만 개)로 경로 탐색용 도로망을 만들고, 정류장을 가장 가까운 도로 위 지점에 붙인다.

입력: data/raw/nodelink/MOCT_LINK.shp·dbf, MOCT_NODE.shp·dbf (ITS 국가교통정보센터 표준노드링크)
출력: data/interim/road/network.npz   도로망(노드 좌표, 링크 양 끝·길이·도로 등급, 링크 선형 좌표)
      data/interim/road/snap.npz      정류장 그룹 → 도로 링크 위 지점(링크, 선형 내 위치, 떨어진 거리)
      data/interim/road/pairs.npy     도로로 이을 버스 정류장 쌍(방향 무시, 한 번씩)
좌표는 미터 단위 중부원점(EPSG:5186, 표준노드링크 원래 좌표계) 그대로 저장한다 — 위경도를 32비트로 저장하면 약 10m 오차가 생긴다.

    python pipeline/p10_road_network.py
"""
from __future__ import annotations

import time

import numpy as np
import shapefile
from pyproj import Transformer
from scipy.spatial import cKDTree

from common import DATA, INTERIM, log, read_json

SRC = DATA / "raw" / "nodelink"
OUT = INTERIM / "road"
ROAD_MODES = {"0", "3", "5"}           # 시내·농어촌·마을버스, 시외·고속버스, 공항버스 (도로를 달리는 수단)
SNAP_MAX_M = 300                        # 이보다 멀면 도로에 붙이지 않는다(섬·도로망에 없는 골목)


def read_nodes():
    r = shapefile.Reader(str(SRC / "MOCT_NODE"), encoding="cp949")
    n = len(r)
    xy = np.empty((n, 2), dtype=np.float64)
    ids = [None] * n
    for i, (shp, rec) in enumerate(zip(r.iterShapes(), r.iterRecords(fields=["NODE_ID"]))):
        xy[i] = shp.points[0]
        ids[i] = rec[0]
    return {nid: i for i, nid in enumerate(ids)}, xy


def read_links(node_index):
    r = shapefile.Reader(str(SRC / "MOCT_LINK"), encoding="cp949")
    n = len(r)
    f_node = np.empty(n, dtype=np.int32); t_node = np.empty(n, dtype=np.int32)
    length = np.empty(n, dtype=np.float32); rank = np.empty(n, dtype=np.int16)
    ptr = np.zeros(n + 1, dtype=np.int64)
    cap = 14_000_000
    pts = np.empty((cap, 2), dtype=np.float32)
    k = 0; missing = 0
    fields = ["F_NODE", "T_NODE", "LENGTH", "ROAD_RANK"]
    for i, (shp, rec) in enumerate(zip(r.iterShapes(), r.iterRecords(fields=fields))):
        a, b = node_index.get(rec[0], -1), node_index.get(rec[1], -1)
        if a < 0 or b < 0:
            missing += 1
        f_node[i], t_node[i] = a, b
        length[i] = rec[2]
        rank[i] = int(rec[3]) if str(rec[3]).isdigit() else 0
        p = shp.points
        if k + len(p) > cap:
            cap = int(cap * 1.3)
            grown = np.empty((cap, 2), dtype=np.float32); grown[:k] = pts[:k]; pts = grown
        pts[k:k + len(p)] = p
        k += len(p)
        ptr[i + 1] = k
        if i and i % 300_000 == 0:
            log(f"  링크 {i:,} / {n:,}")
    return f_node, t_node, length, rank, ptr, pts[:k].copy(), missing


def snap_groups(graph, ptr, pts, to_tm):
    """정류장 그룹마다 가장 가까운 링크 선형 위의 지점(가장 가까운 꼭짓점의 앞뒤 선분에 수선의 발)."""
    lon, lat = np.array(graph["groups"]["lon"]), np.array(graph["groups"]["lat"])
    gx, gy = to_tm.transform(lon, lat)
    tree = cKDTree(pts)
    _, vi = tree.query(np.column_stack([gx, gy]), k=1)
    link_of_pt = np.repeat(np.arange(len(ptr) - 1, dtype=np.int32), np.diff(ptr))
    G = len(lon)
    s_link = np.full(G, -1, dtype=np.int32); s_seg = np.zeros(G, dtype=np.int32)
    s_t = np.zeros(G, dtype=np.float32); s_d = np.full(G, np.inf, dtype=np.float32)
    sx = np.zeros(G, dtype=np.float32); sy = np.zeros(G, dtype=np.float32)
    for g in range(G):
        v = vi[g]; e = link_of_pt[v]; a0, a1 = ptr[e], ptr[e + 1]
        best = (np.inf, 0, 0.0, 0.0, 0.0)
        for j in (v - 1, v):                     # 꼭짓점 앞뒤 선분
            if j < a0 or j + 1 >= a1:
                continue
            p, q = pts[j].astype(np.float64), pts[j + 1].astype(np.float64)
            d = q - p; L2 = d @ d
            t = 0.0 if L2 == 0 else min(1.0, max(0.0, ((gx[g] - p[0]) * d[0] + (gy[g] - p[1]) * d[1]) / L2))
            fx, fy = p[0] + t * d[0], p[1] + t * d[1]
            dist = np.hypot(gx[g] - fx, gy[g] - fy)
            if dist < best[0]:
                best = (dist, j - a0, t, fx, fy)
        if best[0] == np.inf:                    # 점 하나짜리 링크
            best = (np.hypot(gx[g] - pts[v][0], gy[g] - pts[v][1]), 0, 0.0, pts[v][0], pts[v][1])
        s_d[g], s_seg[g], s_t[g], sx[g], sy[g] = best
        s_link[g] = e
    return s_link, s_seg, s_t, s_d, sx, sy


def bus_pairs(graph):
    """버스·시외·공항버스 노선의 인접 정류장 쌍(방향 무시, 한 번씩)."""
    P = graph["patterns"]["stops"]; lines = graph["lines"]
    pairs = set()
    for line in lines:
        if line["mode"] not in ROAD_MODES:
            continue
        for p in line["patterns"]:
            st = P[p]
            for a, b in zip(st[:-1], st[1:]):
                if a != b:
                    pairs.add((a, b) if a < b else (b, a))
    return np.array(sorted(pairs), dtype=np.int32)


def main() -> None:
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    log("표준노드링크 노드 읽기")
    node_index, node_xy = read_nodes()
    log(f"  노드 {len(node_index):,}개 ({time.time() - t0:.0f}s)")
    log("표준노드링크 링크 읽기")
    f_node, t_node, length, rank, ptr, pts, missing = read_links(node_index)
    log(f"  링크 {len(f_node):,}개, 선형 좌표 {len(pts):,}점, 양 끝 노드 없는 링크 {missing} ({time.time() - t0:.0f}s)")
    np.savez(OUT / "network.npz", node_xy=node_xy.astype(np.float64), f_node=f_node, t_node=t_node,
             length=length, rank=rank, ptr=ptr, pts=pts)
    del node_index

    graph = read_json(INTERIM / "graph.json")
    to_tm = Transformer.from_crs("EPSG:4326", "EPSG:5186", always_xy=True)
    log("정류장 그룹을 도로에 붙이기")
    s_link, s_seg, s_t, s_d, sx, sy = snap_groups(graph, ptr, pts, to_tm)
    ok = s_d <= SNAP_MAX_M
    np.savez(OUT / "snap.npz", link=s_link, seg=s_seg, t=s_t, dist=s_d, x=sx, y=sy, ok=ok)
    log(f"  {ok.sum():,} / {len(ok):,}곳이 {SNAP_MAX_M}m 안 도로에 붙음 ({ok.mean() * 100:.1f}%), "
        f"거리 중앙값 {np.median(s_d):.0f}m ({time.time() - t0:.0f}s)")

    pairs = bus_pairs(graph)
    both = ok[pairs[:, 0]] & ok[pairs[:, 1]]
    np.save(OUT / "pairs.npy", pairs)
    log(f"도로로 이을 버스 정류장 쌍 {len(pairs):,}개 (양쪽 모두 도로에 붙은 쌍 {both.sum():,}개, {both.mean() * 100:.1f}%)")
    log(f"완료 {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
