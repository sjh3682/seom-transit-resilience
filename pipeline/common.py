"""파이프라인 공통 유틸리티: 경로, 설정, 거리 계산, 이름 정규화, Union-Find."""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "params.json"
DATA = ROOT / "data"
RAW = DATA / "raw"
EXTERNAL = DATA / "external"
INTERIM = DATA / "interim"
WEB_DATA = DATA / "web"

EARTH_M_PER_DEG = 111_320.0


def load_params() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def read_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path: Path, obj, compact: bool = True) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if compact:
        text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    else:
        text = json.dumps(obj, ensure_ascii=False, indent=2)
    path.write_text(text, encoding="utf-8")


def local_xy(lon, lat, lat0: float = 36.2) -> np.ndarray:
    """경위도를 국지 평면 좌표(미터)로 바꾼다. 한국 범위에서는 거리 오차가 1% 이내."""
    lon = np.asarray(lon, dtype=float)
    lat = np.asarray(lat, dtype=float)
    return np.c_[lon * EARTH_M_PER_DEG * math.cos(math.radians(lat0)), lat * EARTH_M_PER_DEG]


def haversine_m(lon1, lat1, lon2, lat2):
    lon1, lat1, lon2, lat2 = map(np.radians, (lon1, lat1, lon2, lat2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 2 * 6_371_000 * np.arcsin(np.sqrt(a))


_NAME_CLEAN = re.compile(r"[\s()\[\]·.\-_,/]")


def normalize_stop_name(name: str) -> str:
    """정류장 이름 비교용 정규화. '서울역(중앙)' 과 '서울역 중앙' 을 같게 본다."""
    return _NAME_CLEAN.sub("", str(name or "")).lower()


_ROUTE_SPLIT = re.compile(r"\s*(?:↔|<->|->|→|~|-|－|>|<)\s*")


def direction_free_name_key(name: str) -> str:
    """'인천항↔백령도' 와 '백령도↔인천항' 처럼 방향만 다른 노선명을 같은 키로 만든다."""
    text = re.sub(r"\s+", "", str(name or "")).lower()
    if text in ("", "nan", "none"):
        return ""
    parts = [p for p in _ROUTE_SPLIT.split(text) if p]
    return "|".join(sorted(parts)) if len(parts) > 1 else text


class UnionFind:
    def __init__(self, n: int):
        self.parent = np.arange(n)

    def find(self, a: int) -> int:
        parent = self.parent
        root = a
        while parent[root] != root:
            root = parent[root]
        while parent[a] != root:
            parent[a], a = root, parent[a]
        return root

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            if ra < rb:
                self.parent[rb] = ra
            else:
                self.parent[ra] = rb

    def labels(self) -> np.ndarray:
        """0..k-1 로 압축된 그룹 번호 배열."""
        roots = np.array([self.find(i) for i in range(len(self.parent))])
        _, compact = np.unique(roots, return_inverse=True)
        return compact


def pct_rank(values) -> np.ndarray:
    """0~1 백분위 순위(동점 평균)."""
    from scipy.stats import rankdata

    values = np.asarray(values, dtype=float)
    if len(values) == 0:
        return values
    return (rankdata(values, method="average") - 1) / max(1, len(values) - 1)


def log(msg: str) -> None:
    print(f"[seom] {msg}", flush=True)
