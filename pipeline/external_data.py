"""외부 데이터 읽기 — 파일을 data/external/ 에 넣으면 2단계(p02)가 자동으로 쓴다.

  mois_population.csv   행정안전부 「연령별 인구현황」(주민등록, 행정동 단위, 5세 또는 1세 구간) — 공공
  hira_hospitals.xlsx   건강보험심사평가원 「병원정보서비스」(좌표 포함, .csv 도 가능)       — 공공
  hira_pharmacies.xlsx  건강보험심사평가원 「약국정보서비스」(선택)                          — 공공

실제 배포 파일은 인코딩(CP949/UTF-8)·열 이름이 조금씩 달라, 열 이름을 패턴으로 찾는다.
"""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import pandas as pd

from common import EXTERNAL, log

MOIS_FILE = "mois_population.csv"
HIRA_FILES = ("hira_hospitals.xlsx", "hira_hospitals.csv")
HIRA_PHARMACY_FILES = ("hira_pharmacies.xlsx", "hira_pharmacies.csv")


def _read_csv_any(path: Path) -> pd.DataFrame:
    for enc in ("utf-8-sig", "cp949", "euc-kr"):
        try:
            return pd.read_csv(path, dtype=str, encoding=enc)
        except UnicodeDecodeError:
            continue
    raise ValueError(f"{path.name}: 인코딩을 알 수 없습니다(UTF-8/CP949 로 저장해 주세요)")


def _num(series: pd.Series) -> np.ndarray:
    return pd.to_numeric(series.astype(str).str.replace(",", "").str.strip(), errors="coerce").fillna(0).to_numpy()


# ---------------------------------------------------------------------------
# 행정안전부 연령별 인구
# ---------------------------------------------------------------------------
_AGE_COL = re.compile(r"_계_(\d+)(?:~(\d+))?세(?:\s*이상)?$")


def load_mois_population(path: Path | None = None) -> pd.DataFrame | None:
    """행정동별 총인구·65세 이상 인구.

    반환: DataFrame(code10, name, level['dong'|'sigungu'|'sido'], total, senior65, senior_pct)
    - 행정구역 칸 끝의 (10자리 행정기관코드) 로 행정동 경계와 잇는다.
    - 1세·5세 구간이면 65세 이상을 정확히 더하고, 10세 구간(60~69세)이면 그 구간의 절반을 넣고 경고한다.
    """
    if path is None:          # mois_population*.csv 여러 개(시도별로 나눠 받은 경우)도 합쳐 읽는다
        files = sorted(EXTERNAL.glob("mois_population*.csv"))
        if not files:
            return None
        frames = [load_mois_population(f) for f in files]
        out = pd.concat([f for f in frames if f is not None], ignore_index=True).drop_duplicates("code10")
        if len(files) > 1:
            log(f"행정안전부 인구 파일 {len(files)}개 합침: 행정동 {int((out.level == 'dong').sum()):,}개")
        return out
    path = Path(path)
    if not path.exists():
        return None
    df = _read_csv_any(path)
    region_col = next((c for c in df.columns if "행정구역" in c), df.columns[0])
    total_cols = [c for c in df.columns if re.search(r"_계_총인구수$", c)]
    if not total_cols and not any("세대수" in c for c in df.columns):
        wide = _parse_wide_format(df, path.name)          # 공공데이터포털 파일 형식
        if wide is not None:
            return wide
    if not total_cols:
        if any("세대수" in c for c in df.columns):
            raise ValueError(f"{path.name}: '주민등록인구 및 세대현황' 파일입니다(나이별 인구가 없음). "
                             "같은 누리집의 '연령별 인구현황'을 읍면동·5세 단위로 받아 주세요.")
        raise ValueError(f"{path.name}: '…_계_총인구수' 열이 없습니다. 행정안전부 연령별 인구현황 CSV 인지 확인해 주세요.")
    prefix = total_cols[0][: total_cols[0].index("_계_")]          # 첫 번째 기준월만 사용
    age_cols = []
    for c in df.columns:
        m = _AGE_COL.search(c)
        if m and c.startswith(prefix):
            lo = int(m.group(1)); hi = int(m.group(2)) if m.group(2) else None
            age_cols.append((c, lo, hi))
    if not age_cols:
        raise ValueError(f"{path.name}: 연령 구간 열(예: '_계_65~69세')이 없습니다. 연령을 5세 또는 1세 단위로 받아 주세요.")

    senior = np.zeros(len(df))
    coarse = False
    for c, lo, hi in age_cols:
        vals = _num(df[c])
        if lo >= 65:
            senior += vals
        elif hi is not None and lo < 65 <= hi:                    # 60~69세처럼 65세가 구간 가운데
            senior += vals * (hi + 1 - 65) / (hi + 1 - lo)
            coarse = True
    if coarse:
        log("경고: 10세 구간 자료라 65세 이상 인구를 구간 비례로 추정했습니다(5세·1세 구간 권장).")

    codes = df[region_col].astype(str).str.extract(r"\((\d{10})\)")[0]
    names = df[region_col].astype(str).str.replace(r"\s*\(\d{10}\)\s*$", "", regex=True).str.strip()
    out = pd.DataFrame({"code10": codes, "name": names, "total": _num(df[total_cols[0]]), "senior65": senior})
    out = out.dropna(subset=["code10"])
    emd = out["code10"].str[5:8]; sgg = out["code10"].str[2:5]
    out["level"] = np.where(emd != "000", "dong", np.where(sgg != "000", "sigungu", "sido"))
    out["senior_pct"] = np.where(out["total"] > 0, out["senior65"] / out["total"] * 100, np.nan)
    n_dong = int((out["level"] == "dong").sum())
    log(f"행정안전부 인구: {path.name} ({prefix}, 행정동 {n_dong:,}개, 총인구 {out.loc[out.level == 'dong', 'total'].sum():,.0f}명)")
    if n_dong == 0:
        log("경고: 행정동 행이 없습니다. 조회 단위를 '읍면동'으로 받아야 정류장별 인구를 붙일 수 있습니다.")
    return out


_WIDE_AGE = re.compile(r"(\d+)\s*세")


def _parse_wide_format(df: pd.DataFrame, fname: str) -> pd.DataFrame | None:
    """공공데이터포털 「행정안전부_지역별(행정동) 성별 연령별 주민등록 인구수」 처럼
    코드 열이 따로 있고, 열 이름이 '0세남자', '65세여자', '100세이상남자' 인 형식."""
    code_col = None
    for c in df.columns:
        if "코드" in str(c):
            vals = df[c].astype(str).str.replace(r"\.0$", "", regex=True).str.strip()
            if vals.str.fullmatch(r"\d{10}").mean() > 0.8:
                code_col = c
                break
    ages = [(c, int(_WIDE_AGE.search(str(c)).group(1))) for c in df.columns if _WIDE_AGE.search(str(c))]
    if code_col is None or not ages:
        return None
    total_ages = [(c, a) for c, a in ages if "계" in str(c)]
    use = total_ages or ages                                  # '계' 열이 없으면 남+여를 모두 더한다
    senior = sum(_num(df[c]) for c, a in use if a >= 65)
    tot_col = next((c for c in df.columns if str(c).strip() in ("계", "총인구수", "총 인구수", "인구수")), None)
    total = _num(df[tot_col]) if tot_col is not None else sum(_num(df[c]) for c, _ in use)
    name_cols = [c for c in df.columns if re.search(r"시도명|시군구명|읍면동명|행정동명", str(c))]
    names = df[name_cols].fillna("").astype(str).agg(" ".join, axis=1).str.strip() if name_cols else ""
    out = pd.DataFrame({"code10": df[code_col].astype(str).str.replace(r"\.0$", "", regex=True).str.strip(),
                        "name": names, "total": total, "senior65": senior})
    emd = out["code10"].str[5:8]; sgg = out["code10"].str[2:5]
    out["level"] = np.where(emd != "000", "dong", np.where(sgg != "000", "sigungu", "sido"))
    out["senior_pct"] = np.where(out["total"] > 0, out["senior65"] / out["total"] * 100, np.nan)
    log(f"행정안전부 인구(공공데이터포털 형식): {fname} (행정동 {int((out.level == 'dong').sum()):,}개, "
        f"총인구 {out.loc[out.level == 'dong', 'total'].sum():,.0f}명)")
    return out


# ---------------------------------------------------------------------------
# 건강보험심사평가원 병원정보서비스
# ---------------------------------------------------------------------------
def _find_col(columns, *patterns):
    for pat in patterns:
        for c in columns:
            if re.search(pat, str(c), flags=re.I):
                return c
    return None


def load_hira_hospitals(path: Path | None = None, pharmacy_path: Path | None = None) -> pd.DataFrame | None:
    """병원(+선택: 약국) 목록. 반환: DataFrame(lon, lat, name, kind, source='hira'); 약국은 kind='약국'."""
    if path is None and pharmacy_path is None:          # 경로를 주지 않으면 data/external 에서 둘 다 찾는다
        path = next((EXTERNAL / f for f in HIRA_FILES if (EXTERNAL / f).exists()), None)
        pharmacy_path = next((EXTERNAL / f for f in HIRA_PHARMACY_FILES if (EXTERNAL / f).exists()), None)
    frames = [f for f in (_read_hira(path, None), _read_hira(pharmacy_path, "약국")) if f is not None]
    return pd.concat(frames, ignore_index=True) if frames else None


def _read_hira(path, force_kind):
    if path is None or not Path(path).exists():
        return None
    path = Path(path)
    df = pd.read_excel(path, dtype=str) if path.suffix.lower() in (".xlsx", ".xls") else _read_csv_any(path)
    xc = _find_col(df.columns, r"좌표\s*\(?\s*x", r"^xpos$", r"경도", r"^x$")
    yc = _find_col(df.columns, r"좌표\s*\(?\s*y", r"^ypos$", r"위도", r"^y$")
    nc = _find_col(df.columns, r"요양기관명", r"기관명", r"yadmnm", r"name")
    kc = _find_col(df.columns, r"종별코드명", r"종별", r"clcdnm")
    if xc is None or yc is None:
        raise ValueError(f"{path.name}: 좌표 열(좌표(X)/좌표(Y))을 찾지 못했습니다. 열 이름: {list(df.columns)[:20]}")
    out = pd.DataFrame({
        "lon": pd.to_numeric(df[xc], errors="coerce"), "lat": pd.to_numeric(df[yc], errors="coerce"),
        "name": df[nc] if nc else "", "kind": df[kc] if kc else "",
    })
    out = out[out.lon.between(124, 132.5) & out.lat.between(32.5, 39.5)].copy()
    if force_kind:
        out["kind"] = force_kind
    out["source"] = "hira"
    log(f"심평원 {'약국' if force_kind else '병원'}정보: {path.name} ({len(out):,}곳, 좌표 있는 행)")
    return out


def filter_kinds(df: pd.DataFrame | None, exclude_regex: str | None) -> pd.DataFrame | None:
    """종류 이름이 정규식에 걸리는 기관(예: 치과·한의원)을 뺀다."""
    if df is None or not exclude_regex:
        return df
    keep = ~df["kind"].astype(str).str.contains(exclude_regex, regex=True)
    log(f"  종류 제외({exclude_regex}): {int((~keep).sum()):,}곳 제외 → {int(keep.sum()):,}곳")
    return df[keep].reset_index(drop=True)


def facility_stats(df: pd.DataFrame | None) -> dict:
    if df is None:
        return {}
    is_pharm = df["kind"].astype(str).str.contains("약국")
    return {"sources": ["hira"], "count": int(len(df)), "hospitals": int((~is_pharm).sum()), "pharmacies": int(is_pharm.sum())}


def _dong_key(name: str) -> str:
    """시도 이름을 뺀 '시군구+동' 이름(공백 제거). '경기도 수원시 장안구 파장동' 과 '경기도 수원시장안구 파장동' 이 같아진다.
    시도가 바뀐 경우(예: 2026 전남광주통합특별시)에도 시군구·동 이름이 같으면 맞출 수 있다."""
    parts = str(name).split()
    return "".join(parts[1:]) if len(parts) > 1 else str(name)


def match_dongs(boundary_codes: list[str], boundary_names: list[str], mois: pd.DataFrame, return_rows: bool = False):
    """행정동 경계 ↔ 행정안전부 인구: ① 10자리 행정기관코드 ② '시군구+동' 이름 ③ '시도+동' 이름
    ④ 나뉜 동(운서동 → 운서1동·운서2동): 같은 시도에서 이름 앞부분이 같은 동들을 합친다.
    반환: total(경계 순서), senior_pct(경계 순서), stats [, 경계별로 맞춘 행정안전부 행(목록)]"""
    dong = mois[mois.level == "dong"]
    by_code = dong.set_index("code10")
    total = np.full(len(boundary_codes), np.nan); senior = np.full(len(boundary_codes), np.nan)
    rows_of = [[] for _ in boundary_codes]
    used = set()
    for i, c in enumerate(boundary_codes):
        if c in by_code.index:
            row = by_code.loc[c]
            total[i], senior[i] = row.total, row.senior_pct
            rows_of[i] = [(c, row["name"])]
            used.add(c)
    rest = dong[~dong.code10.isin(used)]
    keys = rest["name"].map(_dong_key)
    unique = keys[~keys.duplicated(keep=False)]
    lookup = {k: rest.loc[idx] for idx, k in unique.items()}
    by_name = 0
    for i, name in enumerate(boundary_names):
        if np.isnan(total[i]):
            row = lookup.get(_dong_key(name))
            if row is not None:
                total[i], senior[i] = row.total, row.senior_pct
                rows_of[i] = [(row.code10, row["name"])]
                by_name += 1
    # ③ 시군구 이름까지 바뀐 경우(예: 2026 인천 중구·동구 개편): '시도+동' 이름이 유일하면 맞춘다
    rest2 = rest[~rest["name"].map(_dong_key).isin([_dong_key(n) for i, n in enumerate(boundary_names) if not np.isnan(total[i])])]
    k3 = rest2["name"].map(_sido_dong_key)
    uniq3 = k3[~k3.duplicated(keep=False)]
    lookup3 = {k: rest2.loc[idx] for idx, k in uniq3.items()}
    b_keys = [_sido_dong_key(n) for n in boundary_names]
    b_dup = pd.Series(b_keys).duplicated(keep=False).to_numpy()
    by_sido_dong = 0
    for i, key in enumerate(b_keys):
        if np.isnan(total[i]) and not b_dup[i]:
            row = lookup3.get(key)
            if row is not None:
                total[i], senior[i] = row.total, row.senior_pct
                rows_of[i] = [(row.code10, row["name"])]
                by_sido_dong += 1
    # ④ 나뉜 동: 경계 '운서동' ↔ 인구 '운서1동'·'운서2동' (같은 시도, 아직 안 쓴 행)
    taken_codes = {c for rs in rows_of for c, _ in rs}
    left = dong[~dong.code10.isin(taken_codes)]
    by_split = 0
    for i, name in enumerate(boundary_names):
        if not np.isnan(total[i]):
            continue
        parts = str(name).split()
        base = re.sub(r"[\d·.]+|동$|제\d+동$", "", parts[-1]).rstrip("동") if parts else ""
        if len(base) < 2:
            continue
        cand = left[left["name"].str.split().str[0].str[:2] == parts[0][:2]]
        cand = cand[cand["name"].str.split().str[-1].str.startswith(base)]
        if len(cand):
            total[i] = float(cand.total.sum())
            senior[i] = float((cand.senior65.sum() / max(1.0, cand.total.sum())) * 100) if "senior65" in cand else float(cand.senior_pct.mean())
            rows_of[i] = list(zip(cand.code10, cand["name"]))
            left = left[~left.code10.isin(cand.code10)]
            by_split += 1
    matched_pop = float(np.nansum(total))
    stats = {"by_code": int(len(used)), "by_name": by_name, "by_sido_dong": by_sido_dong, "by_split": by_split,
             "unmatched_boundaries": int(np.isnan(total).sum()), "mois_dongs": int(len(dong)),
             "population_matched_share": round(matched_pop / max(1.0, float(dong.total.sum())), 4)}
    if return_rows:
        return total, senior, stats, rows_of
    return total, senior, stats


def _sido_dong_key(name: str) -> str:
    parts = str(name).split()
    return f"{parts[0][:2]}|{parts[-1]}" if len(parts) > 1 else str(name)
