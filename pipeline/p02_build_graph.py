"""2단계: 분석용 교통 그래프 만들기 → data/interim/graph.json

이 단계가 v6 의 가장 큰 분석 오류(왕복 노선이 서로를 '대체 노선'으로 세던 문제)를 고친다.

1) 정류장 그룹  : 이름이 같고 100m 이내인 정류장(길 건너 양방향 정류장 등)을 하나로 묶는다.
2) 운행계통     : 방향·변형·중복 데이터소스로 갈라진 노선 패턴을 하나의 '운행계통'으로 묶는다.
                   - 방향 무관 노선명이 같고 구간이 절반 이상 겹치면 같은 계통
                   - 이름이 달라도 양 끝 정류장이 같고 구간이 95% 이상 같으면 같은 계통
3) 행정구역     : 시군구 경계로 정류장 위치 기준 지역명을 붙인다(노선 소속 지역이 아니라).
4) 도보 연결    : 400m 이내 정류장 그룹 사이 도보 환승 링크.
5) 목적지(거점) : 철도역·터미널·항만·공항 + (있으면) 병원 파일.
6) 인구·고령    : data/external 의 선택 입력 파일이 있으면 사용, 없으면 대체값과 그 사실을 기록.
"""
from __future__ import annotations

import csv
from collections import Counter, defaultdict

import numpy as np
from scipy.spatial import cKDTree

import pandas as pd

from boundaries import boundary_paths, build_2026_boundaries
from external_data import facility_stats as summarize_facilities, filter_kinds, load_hira_hospitals, load_mois_population, match_dongs
from common import (EXTERNAL, INTERIM, UnionFind, direction_free_name_key, haversine_m,
                    load_params, local_xy, log, normalize_stop_name, read_json, write_json)

# 행정구역 경계: vuski/admdongkor 2025-07 행정동 경계를 시군구·시도로 합치고(mapshaper, 위상 보존 40m 단순화)
# 코드는 행정표준코드(행정안전부 주민등록 통계와 같은 체계, 10자리 행정기관코드의 앞 5자리).
SIDO_SHORT = {
    "서울특별시": "서울", "부산광역시": "부산", "대구광역시": "대구", "인천광역시": "인천", "광주광역시": "광주",
    "대전광역시": "대전", "울산광역시": "울산", "세종특별자치시": "세종", "경기도": "경기", "강원특별자치도": "강원",
    "충청북도": "충북", "충청남도": "충남", "전북특별자치도": "전북", "전라남도": "전남", "경상북도": "경북",
    "경상남도": "경남", "제주특별자치도": "제주", "전남광주통합특별시": "전남광주",
}
LONG_DISTANCE_OR_STATION_MODES = {"1", "2", "3", "4", "5", "6", "7"}


# ---------------------------------------------------------------------------
# 1) 정류장 그룹
# ---------------------------------------------------------------------------
def build_stop_groups(stops: dict, radius_m: float):
    xy = local_xy(stops["lon"], stops["lat"])
    names = [normalize_stop_name(n) for n in stops["name"]]
    uf = UnionFind(len(names))
    tree = cKDTree(xy)
    for a, b in tree.query_pairs(radius_m, output_type="ndarray"):
        if names[a] and names[a] == names[b]:
            uf.union(int(a), int(b))
    group_of_stop = uf.labels()
    n_groups = int(group_of_stop.max()) + 1

    lon = np.bincount(group_of_stop, weights=stops["lon"], minlength=n_groups)
    lat = np.bincount(group_of_stop, weights=stops["lat"], minlength=n_groups)
    size = np.bincount(group_of_stop, minlength=n_groups)
    members = defaultdict(list)
    for stop_idx, g in enumerate(group_of_stop):
        members[g].append(stop_idx)
    group_names = [Counter(stops["name"][i] for i in members[g]).most_common(1)[0][0] for g in range(n_groups)]
    log(f"정류장 {len(names):,}개 → 정류장 그룹 {n_groups:,}개 (같은 이름·{radius_m:.0f}m 이내 통합)")
    return group_of_stop, lon / size, lat / size, size, group_names


# ---------------------------------------------------------------------------
# 3) 행정구역
# ---------------------------------------------------------------------------
def assign_regions(lon: np.ndarray, lat: np.ndarray):
    from shapely import STRtree, points
    from shapely.geometry import shape

    sgg_path, _ = boundary_paths()
    log(f"행정구역 경계: {sgg_path.name}")
    features = read_json(sgg_path)["features"]
    polys, codes, labels = [], [], []
    for f in features:
        props = f["properties"]
        name = props["name"]
        # '고양시덕양구' → '고양시 덕양구'
        if "시" in name and name.endswith("구") and not name.endswith("시구") and name.index("시") < len(name) - 2:
            name = name.replace("시", "시 ", 1)
        polys.append(shape(f["geometry"]))
        codes.append(props["code"])
        labels.append((SIDO_SHORT.get(props["sido_name"], props["sido_name"][:2]), name.strip()))
    tree = STRtree(polys)
    pts = points(lon, lat)
    hit_pt, hit_poly = tree.query(pts, predicate="within")
    region_idx = np.full(len(lon), -1)
    region_idx[hit_pt] = hit_poly
    missing = np.where(region_idx < 0)[0]
    if len(missing):   # 단순화된 경계 밖(작은 섬·해안) 정류장은 가장 가까운 시군구로
        region_idx[missing] = tree.query_nearest(pts[missing], all_matches=False)[1]
    log(f"시군구 배정 완료 (경계 밖 {len(missing):,}개는 최근접 시군구)")
    return region_idx, codes, labels, polys


# ---------------------------------------------------------------------------
# 2) 운행계통
# ---------------------------------------------------------------------------
def group_sequence(seq, group_of_stop):
    out = []
    for s in seq:
        g = int(group_of_stop[s])
        if not out or out[-1] != g:
            out.append(g)
    return out


def estimate_minutes(gseq, lon, lat, mode_cfg):
    """시각표가 없을 때: 거리 × 우회계수 ÷ 속도 + 정차시간 으로 누적 분 추정."""
    a = np.array(gseq[:-1]); b = np.array(gseq[1:])
    dist = haversine_m(lon[a], lat[a], lon[b], lat[b])
    step = dist * mode_cfg["detour"] / (mode_cfg["speed_kmh"] * 1000 / 60) + mode_cfg["dwell_min"]
    return np.r_[0, np.cumsum(step)]


def undirected_edges(gseq):
    return {(a, b) if a < b else (b, a) for a, b in zip(gseq, gseq[1:]) if a != b}


def build_service_lines(patterns, merge_cfg):
    n = len(patterns)
    uf = UnionFind(n)
    edge_sets = [undirected_edges(p["gseq"]) for p in patterns]

    # (a) 방향 무관 이름이 같고 구간이 충분히 겹치면 같은 계통
    by_name = defaultdict(list)
    for i, p in enumerate(patterns):
        key = direction_free_name_key(p["name"])
        if key:
            by_name[(p["mode"], key)].append(i)
    for members in by_name.values():
        for x in range(len(members)):
            for y in range(x + 1, len(members)):
                i, j = members[x], members[y]
                ei, ej = edge_sets[i], edge_sets[j]
                if not ei or not ej:
                    continue
                containment = len(ei & ej) / min(len(ei), len(ej))
                if containment >= merge_cfg["same_name_min_containment"]:
                    uf.union(i, j)

    # (b) 이름이 달라도(데이터소스 중복) 양 끝이 같고 구간이 거의 같으면 같은 계통
    by_ends = defaultdict(list)
    for i, p in enumerate(patterns):
        g = p["gseq"]
        by_ends[(p["mode"], frozenset((g[0], g[-1])))].append(i)
    for members in by_ends.values():
        for x in range(len(members)):
            for y in range(x + 1, len(members)):
                i, j = members[x], members[y]
                ei, ej = edge_sets[i], edge_sets[j]
                if ei and ej and len(ei & ej) / len(ei | ej) >= merge_cfg["any_name_min_jaccard"]:
                    uf.union(i, j)

    # (c) 원본 GTFS 에서 같은 노선 ID 의 정차 순서 변형(구간 운행 등)은 같은 계통
    by_route = defaultdict(list)
    for i, p in enumerate(patterns):
        by_route[p.get("route_id", p["id"])].append(i)
    for members in by_route.values():
        for j in members[1:]:
            uf.union(members[0], j)

    labels = uf.labels()
    log(f"노선 패턴 {n:,}개 → 운행계통 {labels.max() + 1:,}개 (왕복·변형·중복 데이터 통합)")
    return labels


def line_display_name(member_patterns):
    names = [p["name"] for p in member_patterns if p["name"]]
    if not names:
        return ""
    # 'A↔B' 형태면 사전순으로 앞선 표기를 대표로(방향 중립)
    return sorted(Counter(names).most_common(), key=lambda kv: (-kv[1], kv[0]))[0][0]


# ---------------------------------------------------------------------------
# 5) 목적지 · 6) 인구/고령 (선택 입력)
# ---------------------------------------------------------------------------
def load_optional_points(filename: str, value_field: str | None):
    path = EXTERNAL / filename
    if not path.exists():
        return None
    lon, lat, val = [], [], []
    with open(path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            try:
                lon.append(float(row["lon"])); lat.append(float(row["lat"]))
                val.append(float(row[value_field]) if value_field else 1.0)
            except (KeyError, ValueError):
                continue
    log(f"선택 입력 사용: {filename} ({len(lon):,}행)")
    return np.array(lon), np.array(lat), np.array(val)


def load_senior_by_sigungu():
    """senior_sigungu.csv: (sigungu_code, senior_pct) 또는 (sido, sigungu, senior_pct).
    sigungu_code 는 행정표준코드 5자리(행정안전부 10자리 행정기관코드의 앞 5자리). 이름으로도 맞춘다."""
    path = EXTERNAL / "senior_sigungu.csv"
    if not path.exists():
        return None
    out = {}
    with open(path, encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            value = float(row["senior_pct"])
            if row.get("sigungu_code"):
                out[row["sigungu_code"].strip()[:5]] = value
            if row.get("sigungu"):
                out[f"{row.get('sido', '').strip()[:2]}|{normalize_stop_name(row['sigungu'])}"] = value
    log(f"선택 입력 사용: senior_sigungu.csv ({len(out)}개 키)")
    return out


def coarse_senior_by_region(mois, region_codes, region_labels):
    """시군구 행이 있으면 시군구, 없으면 시도 행으로 시군구별 고령 비율(%). 2026 전남광주통합특별시는 광주·전남 모두에 쓴다."""
    sgg = mois[mois.level == "sigungu"]
    if len(sgg):
        by_code = dict(zip(sgg.code10.str[:5], sgg.senior_pct))
        by_name = {normalize_stop_name("".join(n.split()[1:])): v for n, v in zip(sgg.name, sgg.senior_pct)}
        values = {r: by_code.get(c, by_name.get(normalize_stop_name(region_labels[r][1]), -1.0)) for r, c in enumerate(region_codes)}
        log(f"  고령 비율: 행정안전부 시군구 단위({sum(v >= 0 for v in values.values())}/{len(values)}개 시군구)")
        return values, "sigungu"
    sido = mois[mois.level == "sido"]
    short = {}
    for name, v in zip(sido.name, sido.senior_pct):
        name = name.strip()
        if "전남광주" in name:
            short["광주"] = short["전남"] = short["전남광주"] = v
        elif name in SIDO_SHORT:
            short[SIDO_SHORT[name]] = v
    if not short:
        return None
    values = {r: short.get(region_labels[r][0], -1.0) for r in range(len(region_codes))}
    log(f"  고령 비율: 행정안전부 시도 단위({len(short)}개 시도) — 행정동 파일을 넣으면 행정동 단위로 바뀝니다")
    return values, "sido"


def assign_population(g_lon, g_lat, tree, walk_cfg, region_idx, region_codes, region_labels):
    """정류장 그룹별 인구·고령 비율.

    행정안전부 행정동 인구가 있으면: 그룹이 속한 행정동(2025 경계)의 인구를 동 안 그룹 수로 나눠 붙이고,
    정류장이 하나도 없는 행정동의 인구는 '서비스 공백 인구'로 모은다. 고령 비율도 행정동 값을 쓴다.
    """
    n = len(g_lon)
    stats = {}
    mois = load_mois_population()
    if mois is not None and (mois.level == "dong").any():
        from shapely import STRtree, points
        from shapely.geometry import shape

        feats = read_json(EXTERNAL / "admdong_2025.json")["features"]
        polys = [shape(f["geometry"]) for f in feats]
        codes = [f["properties"]["code"] for f in feats]
        dtree = STRtree(polys)
        pts = points(g_lon, g_lat)
        hit_pt, hit_poly = dtree.query(pts, predicate="within")
        dong_of = np.full(n, -1)
        dong_of[hit_pt] = hit_poly
        miss = np.where(dong_of < 0)[0]
        if len(miss):
            dong_of[miss] = dtree.query_nearest(pts[miss], all_matches=False)[1]
        names = [f["properties"]["name"] for f in feats]
        total, sen, match_stats = match_dongs(codes, names, mois)
        log(f"  행정동 매칭: 코드 {match_stats['by_code']:,} · 시군구+동 이름 {match_stats['by_name']:,} · "
            f"시도+동 이름 {match_stats['by_sido_dong']:,} · 미매칭 경계 {match_stats['unmatched_boundaries']:,} "
            f"(인구 {match_stats['population_matched_share'] * 100:.1f}% 연결)")
        groups_in = np.bincount(dong_of, minlength=len(codes))
        pop = np.where(np.isnan(total[dong_of]), 0.0, total[dong_of]) / np.maximum(1, groups_in[dong_of])
        senior = np.where(np.isnan(sen[dong_of]), -1.0, sen[dong_of])
        unserved = []
        for k in np.where((groups_in == 0) & (np.nan_to_num(total) > 0))[0]:
            rp = polys[k].representative_point()
            unserved.append([round(rp.x, 5), round(rp.y, 5), float(total[k])])
        stats = {
            "dongs": len(codes), "dongs_matched": int(np.isfinite(total).sum()), "match": match_stats,
            "population_total": float(np.nansum(total)), "population_on_served_dongs": float(pop.sum()),
            "dongs_without_stops": int(len(unserved)), "population_without_stops": float(sum(u[2] for u in unserved)),
        }
        log(f"행정동 인구 연결: {stats['dongs_matched']:,}/{stats['dongs']:,}개 동 일치, "
            f"정류장 없는 동 {stats['dongs_without_stops']}개 ({stats['population_without_stops']:,.0f}명)")
        return pop, senior, "mois_dong", "mois_dong", unserved, stats

    # 행정동이 없는 행정안전부 파일(시군구·시도 단위)은 고령 비율에만 쓴다(인구를 정류장에 나누기엔 너무 거칠다)
    coarse_senior = None
    if mois is not None and len(mois):
        coarse_senior = coarse_senior_by_region(mois, region_codes, region_labels)

    population = load_optional_points("population_grid.csv", "population")
    unserved = []
    if population is not None:
        d, idx = tree.query(local_xy(population[0], population[1]), distance_upper_bound=walk_cfg["stranded_radius_m"])
        ok = np.isfinite(d)
        pop = np.bincount(idx[ok], weights=population[2][ok], minlength=n)
        unserved = [[round(float(x), 5), round(float(y), 5), float(v)]
                    for x, y, v in zip(population[0][~ok], population[1][~ok], population[2][~ok]) if v > 0]
        pop_source = "population_grid"
    else:
        pop = np.ones(n)          # 인구 데이터가 없으면 '정류장 그룹 1곳 = 1' 로 센다
        pop_source = "none"

    senior_sgg = load_senior_by_sigungu()
    if coarse_senior is not None:
        values, level = coarse_senior
        senior = np.array([values.get(r, -1.0) for r in region_idx])
        senior_source = f"mois_{level}"
    elif senior_sgg:
        def senior_of(r):
            sido, name = region_labels[r]
            return senior_sgg.get(region_codes[r], senior_sgg.get(f"{sido}|{normalize_stop_name(name)}", -1.0))
        senior = np.array([senior_of(r) for r in region_idx])
        senior_source = "sigungu"
    else:
        sido_values = read_json(INTERIM / "legacy_core.json")["senior_regions"] if (INTERIM / "legacy_core.json").exists() else {}
        senior = np.array([sido_values.get(region_labels[r][0], -1.0) for r in region_idx])
        senior_source = "sido_fallback"
    return pop, senior, pop_source, senior_source, unserved, stats



def patterns_on_groups(g_lat, g_lon, group_of_stop, net, params):
    """노선 패턴을 정류장 그룹 순서로 바꾸고 소요시간을 붙인다(시각표가 있으면 시각표, 없으면 거리·속도 추정)"""
    patterns = []
    for p in net["patterns"]:
        gseq = group_sequence(p["stops"], group_of_stop)
        if len(gseq) < 2:
            continue
        mode_cfg = params["modes"][p["mode"]]
        if p["minutes"] is not None and len(p["minutes"]) == len(p["stops"]):
            # 그룹 변환으로 연속 중복이 빠진 만큼 시간도 맞춰 줄인다
            keep, prev = [], None
            for k, s in enumerate(p["stops"]):
                g = int(group_of_stop[s])
                if g != prev:
                    keep.append(k); prev = g
            minutes = np.asarray(p["minutes"])[keep]
            time_source = "timetable"
        else:
            minutes = estimate_minutes(gseq, g_lon, g_lat, mode_cfg)
            time_source = "estimated"
        patterns.append({**p, "gseq": gseq, "minutes": minutes, "time_source": time_source})
    return patterns


def assemble_lines(g_lat, g_lon, n_groups, params, patterns, region_idx, region_labels):
    """운행계통(왕복·변형·중복 통합), 패턴별 대기시간, 그룹별 서비스 계통 수·교통수단"""
    line_of_pattern = build_service_lines(patterns, params["line_merge"])
    n_lines = int(line_of_pattern.max()) + 1
    members = defaultdict(list)
    for i, l in enumerate(line_of_pattern):
        members[int(l)].append(i)

    service = params["service"]
    lines = []
    for l in range(n_lines):
        mp = [patterns[i] for i in members[l]]
        groups = sorted({g for p in mp for g in p["gseq"]})
        rep = max(mp, key=lambda p: len(p["gseq"]))
        seq = np.asarray(rep["gseq"])
        length_km = float(haversine_m(g_lon[seq[:-1]], g_lat[seq[:-1]], g_lon[seq[1:]], g_lat[seq[1:]]).sum() / 1000)
        region_counts = Counter(int(region_idx[g]) for g in groups)
        main_region = region_labels[region_counts.most_common(1)[0][0]]
        regions_spanned = len({region_labels[r][0] for r in region_counts})
        lines.append({
            "name": line_display_name(mp),
            "mode": mp[0]["mode"],
            "sido": main_region[0],
            "sigungu": main_region[1],
            "spans_sido": regions_spanned,
            "trips": round(sum(p["trips_per_day"] for p in mp), 2),
            "patterns": members[l],
            "groups": groups,
            "length_km": round(length_km, 2),
            "source_ids": [p["id"] for p in mp],
        })

    # 패턴별 대기시간: 같은 노선에서 같은 방향 구간(A→B)을 지나는 운행을 모두 합친 빈도로 계산한다.
    # 원본 GTFS 는 한 노선이 시작역·구간 운행·여러 바퀴 운행으로 수십 개 패턴으로 쪼개져(서울 2호선 49개, 패턴마다 하루 1~3회)
    # 패턴 하나의 운행횟수로 배차를 계산하면 대기가 상한(30분)까지 부풀어, 경로 탐색이 그 노선을 거의 타지 않았다.
    # 여러 바퀴 운행은 구간을 지나는 횟수만큼 센다. 상행·하행만 있는 보통 노선은 구간 방향이 달라 그대로다.
    hours = service["hours_per_day"]
    by_line = defaultdict(list)
    for i, p in enumerate(patterns):
        by_line[line_of_pattern[i]].append(p)
    for pats in by_line.values():
        edges = [Counter(zip(p["gseq"][:-1], p["gseq"][1:])) for p in pats]
        freq = Counter()
        for p, e in zip(pats, edges):
            for key, visits in e.items():
                freq[key] += p["trips_per_day"] * visits
        for p, e in zip(pats, edges):
            eff = float(np.median([freq[key] for key in e])) if e else p["trips_per_day"]
            p["eff_trips_per_day"] = max(eff, p["trips_per_day"])
            headway = hours * 60 / max(p["eff_trips_per_day"], 0.25)
            p["wait"] = float(min(service["wait_cap_min"], headway / 2))

    # 그룹별 서비스 계통 수 / 교통수단
    lines_at_group = [set() for _ in range(n_groups)]
    modes_at_group = np.zeros(n_groups, dtype=np.int32)
    for l, line in enumerate(lines):
        bit = 1 << int(line["mode"])
        for g in line["groups"]:
            lines_at_group[g].add(l)
            modes_at_group[g] |= bit
    return line_of_pattern, lines, lines_at_group, modes_at_group, n_lines


def walk_links(g_lat, g_lon, n_groups, params):
    """도보 환승 연결(400m)과 가장 가까운 '다른' 정류장 그룹까지의 거리"""
    walk_cfg = params["walk"]
    xy = local_xy(g_lon, g_lat)
    tree = cKDTree(xy)
    pairs = tree.query_pairs(walk_cfg["transfer_radius_m"], output_type="ndarray")
    dist = np.linalg.norm(xy[pairs[:, 0]] - xy[pairs[:, 1]], axis=1)
    walk_min = dist * walk_cfg["detour"] / (walk_cfg["speed_kmh"] * 1000 / 60)
    adj = defaultdict(list)
    for (a, b), m in zip(pairs, walk_min):
        adj[int(a)].append((int(b), float(m))); adj[int(b)].append((int(a), float(m)))
    walk_ptr = [0]; walk_idx = []; walk_minutes = []
    for g in range(n_groups):
        for b, m in sorted(adj.get(g, [])):
            walk_idx.append(b); walk_minutes.append(round(m, 2))
        walk_ptr.append(len(walk_idx))
    log(f"도보 환승 링크 {len(pairs):,}쌍 ({walk_cfg['transfer_radius_m']}m 이내)")

    # 가장 가까운 '다른' 정류장 그룹 거리 (고립도·정류장 폐쇄 시 도보 부담)
    nearest_d, _ = tree.query(xy, k=2)
    nearest_other_m = nearest_d[:, 1]
    return nearest_other_m, tree, walk_cfg, walk_idx, walk_minutes, walk_ptr


def destinations(modes_at_group, n_groups, params, tree):
    """접근 거점: 철도역·터미널·항만·공항 = 1, 병원·약국(심평원)은 도보 500m 안 정류장 그룹에 가산"""
    station_bits = sum(1 << int(m) for m in LONG_DISTANCE_OR_STATION_MODES)
    dest = ((modes_at_group & station_bits) > 0).astype(float)
    hosp_near = np.zeros(n_groups)
    excl = params.get("destinations", {}).get("exclude_kinds")
    facilities = filter_kinds(load_hira_hospitals(), excl)
    facility_stats = summarize_facilities(facilities)
    if facilities is None:
        legacy = load_optional_points("hospitals.csv", None)
        if legacy is not None:
            facilities = pd.DataFrame({"lon": legacy[0], "lat": legacy[1]})
            facility_stats = {"sources": ["hospitals.csv"], "count": int(len(facilities))}
    dest_source = "stations_terminals"
    if facilities is not None:
        d, idx = tree.query(local_xy(facilities.lon, facilities.lat), distance_upper_bound=500)
        ok = np.isfinite(d)
        np.add.at(dest, idx[ok], 1.0)
        np.add.at(hosp_near, idx[ok], 1.0)
        dest_source = "stations_terminals+hospitals(" + "+".join(facility_stats.get("sources", [])) + ")"
    return dest, dest_source, facility_stats, hosp_near


def main() -> None:
    params = load_params()
    net = read_json(INTERIM / "network.json")
    stops = {k: np.asarray(v) if k in ("lon", "lat") else v for k, v in net["stops"].items()}

    # 0) 행정안전부 행정동 인구가 있으면 2026 행정구역 경계를 만든다(없으면 2025 경계)
    build_2026_boundaries()

    # 1) 정류장 그룹
    group_of_stop, g_lon, g_lat, g_size, g_name = build_stop_groups(stops, params["walk"]["stop_group_radius_m"])
    n_groups = len(g_lon)

    # 3) 행정구역
    region_idx, region_codes, region_labels, _ = assign_regions(g_lon, g_lat)

    # 패턴을 정류장 그룹 순서로 변환 + 소요시간
    patterns = patterns_on_groups(g_lat, g_lon, group_of_stop, net, params)

    # 2) 운행계통
    line_of_pattern, lines, lines_at_group, modes_at_group, n_lines = assemble_lines(g_lat, g_lon, n_groups, params, patterns, region_idx, region_labels)

    # 4) 도보 연결
    nearest_other_m, tree, walk_cfg, walk_idx, walk_minutes, walk_ptr = walk_links(g_lat, g_lon, n_groups, params)

    # 5) 목적지(거점): 철도역·터미널·항만·공항 = 1, 병원·약국(심평원)은 가까운 정류장 그룹에 가산
    dest, dest_source, facility_stats, hosp_near = destinations(modes_at_group, n_groups, params, tree)

    # 6) 인구·고령: 행정안전부 행정동 인구 → 격자 인구 파일 → 없음
    pop, senior, pop_source, senior_source, unserved_pop, pop_stats = assign_population(
        g_lon, g_lat, tree, walk_cfg, region_idx, region_codes, region_labels)

    graph = {
        "meta": {
            "source": net["source"],
            "time_source": Counter(p["time_source"] for p in patterns).most_common(1)[0][0],
            "population_source": pop_source,
            "senior_source": senior_source,
            "destination_source": dest_source,
            "facility_stats": facility_stats,
            "population_stats": pop_stats,
            "raw_stops": len(stops["lon"]),
            "raw_patterns": len(net["patterns"]),
            "stop_times_rows": net["meta"].get("stop_times_rows"),
            "trips": net["meta"].get("trips"),
        },
        "regions": [{"code": c, "sido": s, "name": n} for c, (s, n) in zip(region_codes, region_labels)],
        "groups": {
            "lon": np.round(g_lon, 6).tolist(),
            "lat": np.round(g_lat, 6).tolist(),
            "name": g_name,
            "region": region_idx.tolist(),
            "stops_in_group": g_size.tolist(),
            "n_lines": [len(s) for s in lines_at_group],
            "modes": modes_at_group.tolist(),
            "nearest_other_m": np.round(nearest_other_m, 1).tolist(),
            "dest": dest.tolist(),
            "pop": np.round(pop, 2).tolist(),
            "hosp_near": hosp_near.astype(int).tolist(),
            "senior": np.round(senior, 1).tolist(),
        },
        "patterns": {
            "line": [int(line_of_pattern[i]) for i in range(len(patterns))],
            "trips": [p["trips_per_day"] for p in patterns],
            "wait": [round(p["wait"], 2) for p in patterns],
            "stops": [p["gseq"] for p in patterns],
            "minutes": [np.round(p["minutes"], 2).tolist() for p in patterns],
        },
        "lines": lines,
        "walk": {"ptr": walk_ptr, "idx": walk_idx, "min": walk_minutes},
        "stop_to_group": {"id": list(stops["id"]), "group": group_of_stop.tolist()},
        "unserved_population": unserved_pop,
    }
    write_json(INTERIM / "graph.json", graph)
    log(f"저장: graph.json (그룹 {n_groups:,}, 운행계통 {n_lines:,}, 패턴 {len(patterns):,})")


if __name__ == "__main__":
    main()
