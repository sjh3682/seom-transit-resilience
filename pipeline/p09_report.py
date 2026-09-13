"""9단계: README 의 결과 표 두 개를 결과 파일에서 다시 채운다(숫자가 결과와 어긋나지 않게).

README 의 <!-- RESULTS:START --> ~ <!-- RESULTS:END --> 와 <!-- NUMBERS:START --> ~ <!-- NUMBERS:END --> 사이만 바꾼다.
"""
from __future__ import annotations

import re

import numpy as np

from common import INTERIM, ROOT, load_params, log, read_json

MODES = {"0": "버스", "1": "도시철도", "2": "해운", "3": "시외", "4": "일반철도", "5": "공항버스", "6": "고속철도", "7": "항공"}


def results_table(g, s, pol, senior_pct):
    m, R, L = s["meta"], g["regions"], g["lines"]
    top = sorted(s["sigungu"], key=lambda r: -r["score"])[:6]
    top_txt = " · ".join(f"{R[r['region']]['sido']} {R[r['region']]['name']}({r['senior']:.1f}%)" for r in top)
    very = sum(1 for r in s["sigungu"] if r["grade"] == 3)
    old_weak = sum(1 for r in s["sigungu"] if r["senior"] >= senior_pct and r["grade"] >= 2)
    ps, fer = g["meta"]["population_stats"], m["ferry_affected"]
    find = lambda name: next(i for i, line in enumerate(L) if line["name"] == name)
    ferry, bus, l2 = find("백령도↔인천항_인천"), find("백령도"), find("서울2호선")
    sc, gr = s["line"]["score"], s["line"]["grade"]
    names = load_params()["grades"]["names"]
    rows = [
        ("교통이 \"매우 취약\"한 시군구", f"**{very}곳** (2026 행정구역 {len(s['sigungu'])}곳 중)"),
        ("가장 취약한 시군구(65세 이상 비율)", f"{top_txt} — 전국 평균 22.1%"),
        (f"고령 {senior_pct}%↑이면서 교통도 취약한 시군구", f"**{old_weak}곳**"),
        ("버스·철도로 본토와 이어지지 않는 섬 주민", f"{fer['island_population']:,.0f}명 (섬 {fer['island_components']}곳, 항로에 의존)"),
        ("정류장이 하나도 없는 동", f"{ps['dongs_without_stops']}곳 · {ps['population_without_stops']:,.0f}명"),
        ("인천↔백령도 항로 · 백령도 섬 내 버스", f"취약도 {sc[ferry]:.1f}({names[gr[ferry]]}) · {sc[bus]:.1f}({names[gr[bus]]}) — v6 에서는 항로 제거 영향이 0이었다"),
        ("서울 2호선", f"취약도 {sc[l2]:.1f}({names[gr[l2]]}) — 끊기면 지연되는 유형(도시철도)"),
    ]
    if pol:
        b100 = next(b for b in pol["budgets"] if b["budget"] == 100)
        b20 = next(b for b in pol["budgets"] if b["budget"] == 20)
        se, cap = pol["meta"]["search"], pol["meta"]["capture"]
        rows += [
            ("**AI 추천 정책(연 100억 원)**", f"노선 {b100['n']}곳(DRT {b100['kinds'].get('drt', 0)}, 연장 {b100['kinds'].get('extension', 0)}) → "
             f"**{b100['stranded_pop_saved']:,.0f}명**의 고립을 막음, CO₂ 연 {b100['co2_t_year'][1]:,.0f}톤 감축"
             f"(범위 {b100['co2_t_year'][0]:,.0f}~{b100['co2_t_year'][2]:,.0f})"),
            ("연 20억 원이면", f"노선 {b20['n']}곳 → {b20['stranded_pop_saved']:,.0f}명"),
            ("AI 정책 탐색", f"후보 {se['n_candidates']:,}개 전수 계산 약 {se['est_minutes_all']:.0f}분 → AI 방식 {se['ai_share'] * 100:.0f}%만 계산"
             f"(약 {se['est_minutes_ai']:.0f}분)으로 최적 효과의 {min(c['share'] for c in cap) * 100:.0f}~{max(c['share'] for c in cap) * 100:.0f}%"
             f" (같은 비율 무작위 {min(c['random_30'] for c in cap) * 100:.0f}~{max(c['random_30'] for c in cap) * 100:.0f}%)"),
        ]
    return "| 발견 | 값 |\n|---|---|\n" + "\n".join(f"| {a} | {b} |" for a, b in rows)


def numbers_table(g, s):
    m, L = s["meta"], g["lines"]
    thr = m["thresholds"]
    sc = np.array(s["line"]["score"]); md = np.array([line["mode"] for line in L])
    mode_avg = " · ".join(f"{MODES[k]} {sc[md == k].mean():.1f}" for k in sorted(MODES, key=lambda k: -sc[md == k].mean()) if (md == k).any())
    lm, sm, sens, cmp = m["line_model"], m.get("stop_model", {}), m["sensitivity"], m.get("comparison_v6", {})
    grid = s["grid"]["rows"]
    rows = [
        ("분석 규모", f"정류장 215,409 · 운행 326,368회/일 · 도착·출발 시각 약 1,850만 행 → 정류장 {len(g['groups']['lon']):,}(양방향 묶음) · "
         f"노선 {len(L):,}(운행계통) · 도로 구간 {len(s['segment']['score']):,}"),
        ("등급 경계(취약도, 상위 50·20·5%)", f"노선 {' · '.join(f'{x:.1f}' for x in thr['line'])} · 정류장 {' · '.join(f'{x:.1f}' for x in thr['stop'])}"),
        ("교통수단별 평균 취약도", mode_avg),
        ("취약 유형(취약 이상 노선)", " · ".join(f"{c['name']} {c['size']:,}" for c in m["clusters"])),
        ("AI 설명 모델 교차검증", f"노선 R² {lm['r2_cv']} (MAE {lm['mae_cv']}점)" + (f" · 정류장 R² {sm['r2_cv']} (MAE {sm['mae_cv']}점)" if sm else "")),
        ("가중치 민감도(무작위 200회)", f"순위상관 중앙값 {sens['spearman_median']} · 상위 5% 유지율 {sens['top5_overlap_median'] * 100:.1f}%"),
        ("v6 정적 점수와 비교", f"순위상관 {cmp.get('line_spearman_v6')} · 상위 5% 겹침 {cmp.get('line_top5_overlap_v6', 0) * 100:.1f}%"),
        ("5km 격자", f"{len(grid):,}칸 중 정류장 없는 육지 {sum(1 for r in grid if r[3] == 0)}칸"),
    ]
    return "| 항목 | 값 |\n|---|---|\n" + "\n".join(f"| {a} | {b} |" for a, b in rows)


def replace_block(text, name, body):
    pat = re.compile(rf"(<!-- {name}:START -->\n).*?(\n<!-- {name}:END -->)", re.S)
    if not pat.search(text):
        raise SystemExit(f"README 에 <!-- {name}:START/END --> 표시가 없습니다")
    return pat.sub(lambda mm: mm.group(1) + body + mm.group(2), text)


def main() -> None:
    g = read_json(INTERIM / "graph.json"); s = read_json(INTERIM / "scores.json")
    pol = read_json(INTERIM / "policy.json") if (INTERIM / "policy.json").exists() else None
    pct = load_params().get("display", {}).get("senior_highlight_pct", 40)
    path = ROOT / "README.md"
    text = path.read_text(encoding="utf-8")
    text = replace_block(text, "RESULTS", results_table(g, s, pol, pct))
    text = replace_block(text, "NUMBERS", numbers_table(g, s))
    path.write_text(text, encoding="utf-8")
    log("README 결과 표 갱신")


if __name__ == "__main__":
    main()
