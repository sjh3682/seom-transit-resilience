"""2026 행정구역 경계 만들기 → data/external/sigungu_2026.json, sido_2026.json

2025년 7월 행정동 경계(admdong_2025.json)의 각 동이 2026년에 어느 시군구·시도에 속하는지를
행정안전부 인구 파일(2026년 행정구역 이름·코드)로 알아낸 뒤, 그 기준으로 동들을 다시 합친다.
  - 2026 전남광주통합특별시: 광주·전남 시군구가 한 시도로
  - 2026 인천 개편: 옛 중구·동구의 동이 제물포구·영종구로 실제로 나뉘어 그려진다
맞춘 행이 없는 동(합쳐지거나 이름이 바뀐 몇 곳)은 같은 옛 시군구에 있던 동들이 가장 많이 옮겨간 새 시군구로 보낸다.
"""
from __future__ import annotations

from collections import Counter, defaultdict

from common import EXTERNAL, log, read_json, write_json
from external_data import load_mois_population, match_dongs

SGG_2026 = EXTERNAL / "sigungu_2026.json"
SIDO_2026 = EXTERNAL / "sido_2026.json"


def boundary_paths():
    """쓸 수 있으면 2026 경계, 없으면 2025 경계."""
    if SGG_2026.exists() and SIDO_2026.exists():
        return SGG_2026, SIDO_2026
    return EXTERNAL / "sigungu_2025.json", EXTERNAL / "sido_2025.json"


def _split_name(full: str):
    parts = str(full).split()
    return parts[0], " ".join(parts[1:-1]) if len(parts) > 2 else (parts[1] if len(parts) > 1 else "")


def fix_polygonal_files():
    """이미 만든 2026 경계 파일에서 선·점이 섞인 도형을 다각형만 남긴다."""
    from shapely.geometry import MultiPolygon, mapping, shape
    for path in (SGG_2026, SIDO_2026):
        fc = read_json(path)
        changed = 0
        for f in fc["features"]:
            if f["geometry"]["type"] not in ("Polygon", "MultiPolygon"):
                g = shape(f["geometry"])
                parts = [p for x in g.geoms for p in (x.geoms if x.geom_type == "MultiPolygon" else [x]) if p.geom_type == "Polygon"]
                f["geometry"] = mapping(MultiPolygon(parts)); changed += 1
        if changed:
            write_json(path, fc)
            log(f"{path.name}: 섞인 도형 {changed}개를 다각형으로 정리")


def build_2026_boundaries(force: bool = False) -> bool:
    mois = load_mois_population()
    if mois is None or not (mois.level == "dong").any():
        return False
    src = EXTERNAL / "admdong_2025.json"
    mois_files = sorted(EXTERNAL.glob("mois_population*.csv"))
    newest = max(f.stat().st_mtime for f in mois_files + [src])
    if not force and SGG_2026.exists() and SGG_2026.stat().st_mtime > newest:
        return True

    from shapely import make_valid
    from shapely.geometry import mapping, shape
    from shapely.ops import unary_union

    feats = read_json(src)["features"]
    codes = [f["properties"]["code"] for f in feats]
    names = [f["properties"]["name"] for f in feats]
    _, _, stats, rows = match_dongs(codes, names, mois, return_rows=True)

    assign = [None] * len(feats)           # (sgg5, sido_name, sgg_name)
    for i, r in enumerate(rows):
        if r:
            code10, full = r[0]
            sido, sgg = _split_name(full)
            assign[i] = (code10[:5], sido, sgg)
    # 맞춘 행이 없는 동: 같은 옛 시군구 동들이 가장 많이 옮겨간 새 시군구로
    moved = defaultdict(Counter)
    for i, a in enumerate(assign):
        if a:
            moved[codes[i][:5]][a] += 1
    unmatched = 0
    for i, a in enumerate(assign):
        if a is None:
            unmatched += 1
            if moved[codes[i][:5]]:
                assign[i] = moved[codes[i][:5]].most_common(1)[0][0]
            else:
                sido, sgg = _split_name(names[i])
                assign[i] = (codes[i][:5], sido, sgg)

    def polygonal(geom):
        """모양 교정·합치기 뒤 섞여 나온 선·점은 버리고 다각형만 남긴다."""
        from shapely.geometry import MultiPolygon, Polygon
        if geom.geom_type in ("Polygon", "MultiPolygon"):
            return geom
        parts = []
        for g in getattr(geom, "geoms", []):
            if g.geom_type == "Polygon":
                parts.append(g)
            elif g.geom_type == "MultiPolygon":
                parts.extend(g.geoms)
        return MultiPolygon(parts) if parts else Polygon()

    groups = defaultdict(list)
    meta = {}
    for f, a in zip(feats, assign):
        groups[a[0]].append(make_valid(shape(f["geometry"])))
        meta[a[0]] = a
    sgg_features, sido_groups, sido_names = [], defaultdict(list), {}
    for code, polys in groups.items():
        geom = polygonal(unary_union(polys))
        _, sido, sgg = meta[code]
        sgg_features.append({"type": "Feature", "properties": {"code": code, "name": sgg.replace(" ", ""), "sido_name": sido},
                             "geometry": mapping(geom)})
        sido_groups[code[:2]].append(geom)
        sido_names[code[:2]] = sido
    sido_features = [{"type": "Feature", "properties": {"code": c, "name": sido_names[c]}, "geometry": mapping(polygonal(unary_union(g)))}
                     for c, g in sido_groups.items()]

    def rounded(fc):
        import json
        return json.loads(json.dumps(fc), parse_float=lambda x: round(float(x), 5))

    write_json(SGG_2026, rounded({"type": "FeatureCollection", "features": sgg_features}))
    write_json(SIDO_2026, rounded({"type": "FeatureCollection", "features": sido_features}))
    log(f"2026 행정구역 경계: 시군구 {len(sgg_features)}개, 시도 {len(sido_features)}개 "
        f"(동 매칭 {len(feats) - unmatched:,}/{len(feats):,}, 나머지 {unmatched}곳은 옛 시군구의 다수 이동처로)")
    return True


if __name__ == "__main__":
    build_2026_boundaries(force=True)
