# 0066. 어드민 확장은 있는 API를 그대로 쓰고, 새 API는 펌웨어 목록 하나

- 날짜 / 관련 기능: 2026-10-29 / 보강 5, F1·F8·F10, 어드민
- 상황: 통합 시연 시나리오를 어드민 화면만으로 끝까지 돌려야 한다. 화면이 없는 운영자·ADMIN 단계는 단말기 등록(한 대·엑셀), 펌웨어 등록, 단계 배포 만들기, 계정 관리다(스펙의 시나리오 점검표). 이 쓰기 API는 모두 이미 있다(`POST /terminals`, `POST /terminals/imports`, `POST /firmware`, `POST /firmware-rollouts`, `/admin/accounts`) — 검증·접근 표·e2e도 있다. 화면이 새로 필요로 하는 것은 "배포 만들기에서 고를 펌웨어 버전"뿐이다. 등록된 펌웨어를 읽는 API가 없다(배포 목록 `GET /firmware-rollouts`는 배포를 만든 버전만 보인다). 또 요청 본문 셋(`POST /terminals`·`/firmware`·`/firmware-rollouts`)과 엑셀 등록 응답은 contracts에 모양이 없어(보강 1 때 어드민이 부르지 않던 것) 화면이 타입 없이 보내게 된다.
- 선택지:
  1. 버전을 손으로 적는 칸 — API를 늘리지 않는다. 틀린 버전은 404(`펌웨어 … 등록되지 않았습니다`)로 늦게 안다. 시연 중 오타에 약하다
  2. **`GET /firmware?modelCode=&beforeId=&limit=`(사무실 역할) — 최근 등록부터 키셋(decisions/0039)** — 엔드포인트 하나·접근 표 한 줄. 화면은 모델을 고르면 그 모델 버전만 선택지로
  3. `GET /terminal-models/:code/firmware` — 모델 아래 경로가 읽기 좋지만, 목록 API 모양(`BeforeIdPage`, `?beforeId=`)을 다른 목록과 같게 두려면 결국 같은 쿼리 DTO가 필요하다. 모델 컨트롤러가 펌웨어 모듈을 알게 된다
- 결정: 2. 역할은 `GET /firmware-rollouts`와 같은 OFFICE(ADMIN·OPERATOR·MONITOR) — 배포 현황을 보는 사람이 그 버전 목록도 본다. 없는 모델 코드는 404가 아니라 빈 목록(거르기 조건). 모델 조건은 모델 행을 먼저 찾아 FK 열(`model_id`)로 거른다(조인 없이 — 실행계획은 재지 않았다. 펌웨어 표는 모델당 몇 행이라 작다). 함께, 화면이 보내는 요청 본문 셋에 contracts 타입(`RegisterTerminalRequest`·`RegisterFirmwareRequest`·`CreateRolloutRequest`)을 두고 DTO가 `implements`한다. 엑셀 등록 응답은 `TerminalImportView`(행 번호가 붙은 `RowResult`)로, 서비스 반환 타입에 건다(decisions/0048 방식 — 어긋나면 api tsc 실패).
- 결과·대가: 엔드포인트 71 → 72(접근 표 테스트가 센 값, decisions/0052 보탬). 펌웨어 목록은 화면에서 한 번에 100개까지만 본다(모델 하나의 버전 수로 충분하다고 본다 — 넘으면 "더 보기"를 붙인다). 계정·발주·단말기 등록 쪽에는 새 API가 없다 — 가맹점 목록(`GET /merchants`)도 이미 있다.
- 다시 볼 조건: 펌웨어 버전이 모델당 수백 개가 되거나, 펌웨어에 파일·변경 내역이 붙어 상세 화면이 필요해지면 `GET /firmware/:id`와 "더 보기"를 더한다.
