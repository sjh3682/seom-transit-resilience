# 외부 데이터 넣기

파일을 이 폴더(`data/external/`)에 **아래 이름 그대로** 넣고 `sh pipeline/run_all.sh --legacy-html data/raw/legacy_v6.html`(또는 `--gtfs …`)을 다시 돌리면 자동으로 반영됩니다.
없으면 대체값을 쓰고, 웹 화면 오른쪽 "데이터 연결 상태"에 주황색으로 표시됩니다.

| 파일 이름 | 무엇 | 공공/민간 | 바뀌는 것 |
|---|---|---|---|
| `mois_population.csv` | 행정안전부 연령별 주민등록 인구(행정동 단위, 5세 또는 1세 구간) | 공공 | 영향 인구가 실제 인구로, 고령 비율이 행정동 단위로, "정류장 없는 동의 인구"가 서비스 공백으로 |
| `hira_hospitals.xlsx` | 건강보험심사평가원 병원정보서비스(좌표 포함) | 공공 | 60분 안에 갈 수 있는 **병원**이 접근 거점에 들어감 |
| `hira_pharmacies.xlsx` | 건강보험심사평가원 약국정보서비스(선택) | 공공 | 약국도 거점에 포함 |

## 1. 행정안전부 행정동 연령별 인구 → `mois_population.csv`
**가장 쉬운 곳: 공공데이터포털 「행정안전부_지역별(행정동) 성별 연령별 주민등록 인구수」** (data.go.kr/data/15097972/fileData.do)
- 전국 행정동이 **한 파일**, 로그인 없이 다운로드. 받은 CSV 이름을 `mois_population.csv` 로 바꿔 이 폴더에.
- 코드 열(10자리 행정기관코드)과 '0세남자'·'65세여자' 같은 열을 자동으로 찾아 65세 이상을 더합니다.

행정안전부 누리집(jumin.mois.go.kr → 연령별 인구현황)에서 받는 경우:
- ⚠️ "주민등록인구 및 세대현황"이 아니라 **"연령별 인구현황"**, 연령은 **5세 단위**
- 이 누리집은 "선택한 지역의 바로 아래 단계"만 보여줘서, 전국을 고르면 **시도 17줄**만 나옵니다. 읍면동을 받으려면 시군구마다 받아야 해요 → `mois_population_서울종로.csv` 처럼 `mois_population` 으로 시작하게 여러 개 넣으면 합쳐 읽습니다.
- 시도·시군구 파일만 있어도 **고령 비율**은 그 단위로 반영합니다(정류장별 인구는 행정동이 있어야 해요).

코드가 바뀐 행정동(2026 전남광주통합특별시 등)은 **시군구+동 이름**으로 2025년 경계(`admdong_2025.json`)와 맞춥니다.

## 2. 심평원 병원·약국 → `hira_hospitals.xlsx`, `hira_pharmacies.xlsx`
1. 공공데이터포털에서 **"건강보험심사평가원_전국 병의원 및 약국 현황"** 파일 데이터를 내려받기
2. 압축 안의 `1.병원정보서비스 ….xlsx` → `hira_hospitals.xlsx`, `2.약국정보서비스 ….xlsx` → `hira_pharmacies.xlsx`
- `좌표(X)`(경도)·`좌표(Y)`(위도) 열을 찾아 씁니다. 열 이름이 조금 달라도 찾아요.

## 3. (선택) 비용을 원 단위로 → `config/params.json` 의 `policy.cost`
- `drt_vehicle_year_krw`: 국토교통부 「수요응답형교통(DRT) 도입·운영 가이드라인」(2025.12) 의 **"차량 1대(11인승 승합차) 당 운송원가"** 표 값(연간)
- `bus_vehicle_year_krw`: 시내버스 1대당 연간 운송원가(지자체 버스 재정지원 산정 기준 등)
- 둘 다 넣으면 AI 정책 포트폴리오의 예산이 "버스 대·년" 대신 "억 원/년" 으로 바뀝니다.

## 4. (선택) 탄소 계산 기준값 확인 → `config/params.json` 의 `carbon`
- `gasoline_ncv_mj_per_l`(휘발유 순발열량): 에너지법 시행규칙 「에너지열량 환산기준」 표의 값으로 확인
- 연비·1인당 대중교통 통행수·승용차 전환율·통행거리는 가정이며 [낮음, 중간, 높음] 범위로 계산합니다. 국가교통DB 가구통행실태조사 값을 알면 바꿔 주세요.

---

### 자동으로 만들어지는 파일
- `sigungu_2026.json`, `sido_2026.json`: 행정동 인구 파일이 있으면 2단계가 만든다. 2025년 행정동 경계의 각 동을 2026년 행정구역(행정안전부 인구 파일의 이름·코드)으로 다시 묶는다 — 전남광주통합특별시, 인천 제물포구·영종구·서해구·검단구 등. 동 매칭은 코드 → 시군구+동 이름 → 시도+동 이름 → 나뉜 동(운서동 → 운서1·2동) 순이고, 맞춘 행이 없는 몇 곳은 같은 옛 시군구 동들이 가장 많이 옮겨간 새 시군구로 보낸다(`pipeline/boundaries.py`).

### 이미 들어 있는 파일
- `sigungu_2025.json`, `sido_2025.json`, `admdong_2025.json`: vuski/admdongkor 의 2025년 7월 행정동 경계를 mapshaper 로 시군구·시도 단위로 합치고(행정동은 그대로) 위상을 보존해 단순화한 파일입니다(군위군 대구 편입·청주 통합 등 최신 행정구역 반영).
  다시 만들 때: `mapshaper HangJeongDong_ver20250701.geojson -dissolve sgg copy-fields=sido,sidonm,sggnm -simplify interval=40 keep-shapes -clean …`
- 예전 방식의 `population_grid.csv`(`lon,lat,population`), `senior_sigungu.csv`(`sigungu_code,senior_pct`), `hospitals.csv`(`lon,lat`) 도 계속 읽습니다. `sigungu_code` 는 행정표준코드 5자리입니다.

## 표준노드링크(선택: 노선을 실제 도로 모양으로)
ITS 국가교통정보센터 → 표준노드링크 다운로드(전국 SHP). 압축을 풀어 `data/raw/nodelink/` 에 `MOCT_LINK.*`, `MOCT_NODE.*` 를 넣으면 `run_all.sh` 가 10단계(`p10_road_network.py`)를 실행한다. 좌표계는 중부원점(EPSG:5186).

## 탄소 계산 자료(포함됨)
- `car_registration_2025.xlsx`: KOSIS 1인당 자동차 등록대수(시도, 2025)
- `fuel_economy_labels.xlsx`: 한국에너지공단 자동차 표시연비 목록(공공데이터포털)
- KTDB BRIEF 2026.4 「2025년 전국 여객 기종점통행량 예비조사」 수치는 `config/params.json` 의 `carbon.od_survey` 에 출처와 함께 적었다.
