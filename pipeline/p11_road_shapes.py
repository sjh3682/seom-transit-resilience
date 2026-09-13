"""11단계: 버스 정류장 쌍을 도로망을 따라 잇는다(노선을 실제 도로 모양으로 그리기 위한 선형).

입력: data/interim/road/network.npz, snap.npz, pairs.npy (10단계)
출력: data/interim/road/shapes.npz  쌍마다 도로 선형(중부원점 좌표, 5m 단순화)과 상태
중간 저장: data/interim/road/chunks/ 에 출발 정류장 2천 곳마다 저장 — 다시 실행하면 저장된 다음부터 이어서 계산한다.

- 정류장은 10단계에서 붙인 '도로 선 위 지점'을 가상 노드로 만들어 그 링크의 양 끝과 잇는다.
- 같은 링크 위의 두 정류장은 그 링크를 잘라 쓴다.
- 도로 경로가 직선거리의 3배(또는 +2km)보다 길면 잘못 이어진 것으로 보고 직선으로 둔다.
- 직선거리 25km 초과(시외버스 터미널 사이 등)는 탐색 범위가 너무 커서 직선으로 둔다.

    python pipeline/p11_road_shapes.py            # 전부
    python pipeline/p11_road_shapes.py --sample 300   # 속도 측정
"""
from __future__ import annotations

import argparse
import time

import numpy as np
import shapely
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

from common import INTERIM, log

ROAD = INTERIM / "road"
CHUNKS = ROAD / "chunks"
MAX_STRAIGHT_M = 25_000
DETOUR_RATIO, DETOUR_ADD_M = 3.0, 2_000
SIMPLIFY_M = 5.0
CHUNK = 2_000
BATCH = 12


class RoadGraph:
    def __init__(self):
        net = np.load(ROAD / "network.npz"); snap = np.load(ROAD / "snap.npz")
        self.node_xy = net["node_xy"]; self.f = net["f_node"]; self.t = net["t_node"]
        self.ptr = net["ptr"]; self.pts = net["pts"].astype(np.float64)
        self.N0 = len(self.node_xy)
        self.s_link, self.s_seg, self.s_t = snap["link"], snap["seg"], snap["t"]
        self.s_xy = np.column_stack([snap["x"], snap["y"]]).astype(np.float64); self.s_ok = snap["ok"]
        # 링크 선형 길이(선분 누적) — 정류장 지점까지의 거리와 같은 기준으로 쓰기 위해 선형에서 다시 잰다
        seg_len = np.hypot(*np.diff(self.pts, axis=0).T)
        seg_len[self.ptr[1:-1] - 1] = 0                       # 링크 경계를 넘는 선분은 0
        self.cum = np.concatenate([[0], np.cumsum(seg_len)])  # 점 단위 누적
        link_len = self.cum[self.ptr[1:] - 1] - self.cum[self.ptr[:-1]]
        self.link_len = np.maximum(link_len, 0.01)
        # 정류장 가상 노드
        G = len(self.s_ok)
        self.vnode = np.full(G, -1, dtype=np.int64)
        ok = np.where(self.s_ok)[0]
        self.vnode[ok] = self.N0 + np.arange(len(ok))
        self.group_of_v = np.empty(len(ok), dtype=np.int64); self.group_of_v[:] = ok
        e = self.s_link[ok]
        a0 = self.ptr[e]; j = a0 + self.s_seg[ok]
        seg = np.hypot(*(self.pts[j + 1] - self.pts[j]).T) if len(ok) else np.zeros(0)
        seg = np.where(j + 1 < self.ptr[e + 1], seg, 0)
        self.along = np.zeros(G); self.along[ok] = self.cum[j] - self.cum[a0] + self.s_t[ok] * seg
        # 간선: 링크 양방향 + 가상 노드 ↔ 링크 양 끝
        L = len(self.f)
        U = np.concatenate([self.f, self.t, self.vnode[ok], self.f[e], self.vnode[ok], self.t[e]]).astype(np.int64)
        V = np.concatenate([self.t, self.f, self.f[e], self.vnode[ok], self.t[e], self.vnode[ok]]).astype(np.int64)
        al = self.along[ok]; rest = np.maximum(self.link_len[e] - al, 0.01); al = np.maximum(al, 0.01)
        W = np.concatenate([self.link_len, self.link_len, al, al, rest, rest])
        LID = np.concatenate([np.arange(L), np.arange(L), np.full(4 * len(ok), -1)]).astype(np.int64)
        order = np.lexsort((W, V, U))                          # 같은 (U,V) 는 가장 짧은 링크만
        U, V, W, LID = U[order], V[order], W[order], LID[order]
        keep = np.ones(len(U), bool); keep[1:] = (U[1:] != U[:-1]) | (V[1:] != V[:-1])
        U, V, W, LID = U[keep], V[keep], W[keep], LID[keep]
        n = self.N0 + len(ok)
        indptr = np.zeros(n + 1, dtype=np.int64); np.add.at(indptr, U + 1, 1); indptr = np.cumsum(indptr)
        self.indptr, self.indices, self.lid = indptr, V, LID
        self.csr = csr_matrix((W, V, indptr), shape=(n, n))

    # ---------------------------------------------------------------- 선형 조각
    def _link_pts(self, e, forward=True):
        p = self.pts[self.ptr[e]:self.ptr[e + 1]]
        return p if forward else p[::-1]

    def _partial(self, g, toward_node):
        """정류장 g 의 도로 위 지점 → 링크 끝(toward_node) 까지의 선형."""
        e = self.s_link[g]; a0, a1 = self.ptr[e], self.ptr[e + 1]; j = a0 + self.s_seg[g]
        s = self.s_xy[g][None]
        if toward_node == self.f[e]:
            return np.vstack([s, self.pts[a0:j + 1][::-1]])
        return np.vstack([s, self.pts[j + 1:a1]])

    def _same_link(self, a, b):
        e = self.s_link[a]; a0 = self.ptr[e]
        ja, jb = a0 + self.s_seg[a], a0 + self.s_seg[b]
        if (ja, self.s_t[a]) <= (jb, self.s_t[b]):
            return np.vstack([self.s_xy[a][None], self.pts[ja + 1:jb + 1], self.s_xy[b][None]])
        return np.vstack([self.s_xy[a][None], self.pts[jb + 1:ja + 1][::-1], self.s_xy[b][None]])

    def _edge_lid(self, u, v):
        lo, hi = self.indptr[u], self.indptr[u + 1]
        k = lo + np.nonzero(self.indices[lo:hi] == v)[0][0]
        return self.lid[k]

    def path_geometry(self, pred, a, b):
        va, vb = self.vnode[a], self.vnode[b]
        nodes = [vb]
        while nodes[-1] != va:
            p = pred[nodes[-1]]
            if p < 0:
                return None
            nodes.append(p)
        nodes.reverse()
        parts = []
        for u, v in zip(nodes[:-1], nodes[1:]):
            if u >= self.N0:                                   # 정류장 지점 → 링크 끝
                parts.append(self._partial(self.group_of_v[u - self.N0], v))
            elif v >= self.N0:                                 # 링크 끝 → 정류장 지점
                parts.append(self._partial(self.group_of_v[v - self.N0], u)[::-1])
            else:
                e = self._edge_lid(u, v)
                parts.append(self._link_pts(e, self.f[e] == u))
        return np.vstack(parts)


def route_all(rg, pairs, sources, chunk_id):
    """출발 정류장 목록(sources)에 대해 경로를 찾아 (쌍 번호, 선형, 상태) 목록을 돌려준다."""
    by_src = {}
    for k, (a, b) in enumerate(pairs):
        by_src.setdefault(a, []).append(k)
    results = []
    src_list = [s for s in sources if s in by_src]
    need = []
    for s in src_list:
        d = np.hypot(*(rg.s_xy[pairs[by_src[s], 1]] - rg.s_xy[s]).T)
        need.append(max(DETOUR_RATIO * d.max(), d.max() + DETOUR_ADD_M))
    order = np.argsort(need)
    src_list = [src_list[i] for i in order]; need = [need[i] for i in order]
    for i in range(0, len(src_list), BATCH):
        batch = src_list[i:i + BATCH]
        limit = need[min(i + BATCH, len(need)) - 1]
        dist, pred = dijkstra(rg.csr, directed=True, indices=rg.vnode[batch], return_predecessors=True, limit=limit)
        for r, a in enumerate(batch):
            for k in by_src[a]:
                b = pairs[k, 1]
                straight = float(np.hypot(*(rg.s_xy[b] - rg.s_xy[a])))
                if rg.s_link[a] == rg.s_link[b]:
                    geom = rg._same_link(a, b)
                else:
                    if not np.isfinite(dist[r, rg.vnode[b]]):
                        results.append((k, None, 2)); continue       # 범위 안에 길 없음
                    geom = rg.path_geometry(pred[r], a, b)
                    if geom is None:
                        results.append((k, None, 2)); continue
                L = float(np.hypot(*np.diff(geom, axis=0).T).sum())
                if L > max(DETOUR_RATIO * straight, straight + DETOUR_ADD_M):
                    results.append((k, None, 3)); continue           # 지나치게 돌아감
                results.append((k, geom, 1))
    return results


def save_chunk(path, results):
    ks = np.array([k for k, _, _ in results], dtype=np.int64)
    st = np.array([s for _, _, s in results], dtype=np.int8)
    geoms = [g for _, g, s in results if s == 1]
    if geoms:                                   # 길이가 제각각인 선: 좌표를 이어 붙이고 선 번호를 함께 넘긴다
        idx = np.repeat(np.arange(len(geoms)), [len(g) for g in geoms])
        lines = shapely.simplify(shapely.linestrings(np.vstack(geoms), indices=idx), SIMPLIFY_M)
    else:
        lines = []
    coords = [np.asarray(shapely.get_coordinates(ln), dtype=np.float32) for ln in lines]
    ptr = np.zeros(len(results) + 1, dtype=np.int64); c = iter(coords); out = []
    for i, s in enumerate(st):
        n = 0
        if s == 1:
            arr = next(c); out.append(arr); n = len(arr)
        ptr[i + 1] = ptr[i] + n
    np.savez(path, k=ks, status=st, ptr=ptr, xy=np.vstack(out) if out else np.zeros((0, 2), np.float32))


def merge(pairs, todo, n_chunks):
    """조각을 전체 쌍 순서로 합친다 — 도로망 없이, 조각 파일은 한 번씩만 읽는다."""
    status = np.zeros(len(pairs), dtype=np.int8)              # 0 = 직선(도로에 못 붙음·25km 초과)
    lengths = np.zeros(len(pairs), dtype=np.int64)
    pieces = []
    for c in range(n_chunks):
        z = np.load(CHUNKS / f"chunk_{c:04d}.npz")
        k, st, ptr, xy = z["k"], z["status"], z["ptr"], z["xy"]
        kk = todo[k]
        status[kk] = st
        lengths[kk] = np.diff(ptr)
        pieces.append((kk, ptr, xy))
    out_ptr = np.concatenate([[0], np.cumsum(lengths)])
    out_xy = np.zeros((out_ptr[-1], 2), dtype=np.float32)
    for kk, ptr, xy in pieces:
        for i, dst in enumerate(kk):
            n = ptr[i + 1] - ptr[i]
            if n:
                out_xy[out_ptr[dst]:out_ptr[dst] + n] = xy[ptr[i]:ptr[i + 1]]
    return status, out_ptr, out_xy


def main() -> None:
    ap = argparse.ArgumentParser(); ap.add_argument("--sample", type=int, default=0)
    args = ap.parse_args()
    t0 = time.time()
    pairs = np.load(ROAD / "pairs.npy")
    snap = np.load(ROAD / "snap.npz")
    s_ok, s_xy = snap["ok"], np.column_stack([snap["x"], snap["y"]]).astype(np.float64)
    ok = s_ok[pairs[:, 0]] & s_ok[pairs[:, 1]]
    straight = np.hypot(*(s_xy[pairs[:, 1]] - s_xy[pairs[:, 0]]).T)
    todo = np.where(ok & (straight <= MAX_STRAIGHT_M))[0]
    log(f"이을 쌍 {len(todo):,} (도로에 못 붙음 {int((~ok).sum()):,}, 25km 초과 {int((ok & (straight > MAX_STRAIGHT_M)).sum()):,})")
    sub = pairs[todo]
    sources = np.unique(sub[:, 0])
    n_chunks = (len(sources) + CHUNK - 1) // CHUNK
    missing = [c for c in range(n_chunks) if not (CHUNKS / f"chunk_{c:04d}.npz").exists()]
    if args.sample or missing:
        rg = RoadGraph()                                       # 계산할 게 있을 때만 도로망을 올린다(수백 MB)
        log(f"도로망 {rg.N0:,}노드 + 정류장 {int(rg.s_ok.sum()):,}곳 ({time.time() - t0:.0f}s)")
        if args.sample:
            rng = np.random.default_rng(0)
            pick = rng.choice(sources, min(args.sample, len(sources)), replace=False)
            s = time.time(); res = route_all(rg, sub, set(pick.tolist()), 0)
            el = time.time() - s; okn = sum(1 for r in res if r[2] == 1)
            log(f"표본 출발 {len(pick)}곳 · 쌍 {len(res)}개: {el:.1f}s → 전체 추정 {el / len(pick) * len(sources) / 60:.0f}분, 성공 {okn / max(1, len(res)) * 100:.1f}%")
            return
        CHUNKS.mkdir(parents=True, exist_ok=True)
        for c in missing:
            s = time.time()
            res = route_all(rg, sub, set(sources[c * CHUNK:(c + 1) * CHUNK].tolist()), c)
            save_chunk(CHUNKS / f"chunk_{c:04d}.npz", res)
            log(f"  조각 {c + 1}/{n_chunks} 저장 ({time.time() - s:.0f}s, 누적 {time.time() - t0:.0f}s)")
        del rg
    else:
        log(f"조각 {n_chunks}개가 모두 저장돼 있어 합치기만 한다")
    status, ptr, xy = merge(pairs, todo, n_chunks)
    np.savez(ROAD / "shapes.npz", pairs=pairs, status=status, ptr=ptr, xy=xy)
    names = {0: "직선(도로 밖·25km 초과)", 1: "도로", 2: "길 없음", 3: "지나친 우회"}
    log("결과: " + ", ".join(f"{names[s]} {int((status == s).sum()):,}" for s in range(4)) + f" · 좌표 {len(xy):,}점")
    log(f"완료 {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
