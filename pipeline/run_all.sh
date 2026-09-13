#!/bin/sh
# 전체 파이프라인 한 번에 실행
#   sh pipeline/run_all.sh --gtfs data/raw/ktdb_gtfs_2025.zip     (권장: KTDB 대중교통 GTFS 2025.3, 약 1시간)
#   sh pipeline/run_all.sh --legacy-html data/raw/legacy_v6.html  (원본이 없을 때)
set -e
cd "$(dirname "$0")"
python3 p01_import_network.py "$@"
python3 p02_build_graph.py
node --max-old-space-size=2600 p03_simulate.js
python3 p04_score.py
python3 p08_policy_ai.py          # AI 정책 최적화(정책 조합 12만여 개 중 AI 선별 약 20% 정밀 계산, 약 20분)
if [ -f ../data/raw/nodelink/MOCT_LINK.shp ]; then   # 표준노드링크가 있으면 노선을 실제 도로 모양으로
  python3 p10_road_network.py    # 도로망·정류장 붙이기(약 1분)
  python3 p11_road_shapes.py     # 버스 정류장 쌍을 도로로 잇기(약 7분, 중간 저장·이어하기)
fi
python3 p05_pack_web.py
python3 p06_build_html.py
python3 p12_validate_demand.py   # 민간 교통카드(서울)로 영향 규모 지표 검증
python3 p09_report.py            # README 결과 표 갱신
echo "완료: dist/index.html"
