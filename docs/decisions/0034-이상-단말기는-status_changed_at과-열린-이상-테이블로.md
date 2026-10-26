# 0034. 이상 단말기는 status_changed_at 컬럼과 열린 이상 테이블로 찾는다

- 날짜 / 관련 기능: 2026-10-26 / F4, F2
- 상황: 이상 단말기 규칙 대부분이 "어떤 상태로 N일 넘게"다(배송 완료 7일, 회수 14일, 출고 10일, 배정 3일). 핵심은 "그 상태가 된 시각"을 어떻게 구하느냐다. `terminal.updated_at`은 가맹점·version 등 다른 변경에도 바뀌어 쓸 수 없다(Day 4 준비 메모).
- 선택지:
  1. 이력에서 "지금 상태로 들어온 마지막 이력 시각"을 서브쿼리(또는 윈도 함수)로 — 스키마는 그대로. 대신 규칙에 걸린 상태의 단말기마다 이력을 훑는다(단말기 수 × 이력 수).
  2. **`terminal.status_changed_at`을 전이 서비스가 상태와 같은 UPDATE에서 갱신 + `(status, status_changed_at)` 복합 인덱스** — 규칙 하나가 인덱스 범위 하나. 컬럼 하나와 백필 마이그레이션이 필요하고, 전이 서비스를 거치지 않는 쓰기(테스트 헬퍼의 직접 INSERT·nativeUpdate)는 이 값을 직접 맞춰야 한다.
- 결정: 2. 상태 변경은 전이 서비스 한 곳(CLAUDE.md 원칙)이라 값이 어긋날 경로가 없다(`transition`·`transitionMany`가 상태와 함께 바꾸고, 등록 이력 `recordRegistration`은 엔티티 초기값을 이력 시각으로 쓴다). 이력 occurred_at에도 같은 시각을 쓴다(이력은 `datetime`(초)이라 1초 안에서 같다, 테스트로 확인). 실험 0011이 1과 결과가 같은지와 시간·실행계획을 잰다(Task 9가 숫자를 보탠다).
- 인덱스: `(status, status_changed_at)`을 만들고 `terminal_status_index`(status 단독)는 지운다 — 새 인덱스의 앞부분이 덮는다(decisions/0032와 같은 왼쪽 접두사 원칙, 컨트롤러 승인). 인덱스 수는 그대로다.
- 백필(마이그레이션 `Migration20261026034551`, 손으로 고침):
  - 생성된 `add status_changed_at datetime(3) not null`은 행이 있으면 `ERROR 1292 (22007): Incorrect datetime value: '0000-00-00 00:00:00'`(sql_mode의 STRICT_TRANS_TABLES·NO_ZERO_DATE). 테스트 DB의 임시 테이블로 재현했다.
  - null 허용 추가 → `coalesce(지금 상태로 들어온 마지막 이력의 occurred_at, updated_at)` → not null. "마지막"인 이유: 같은 상태에 다시 들어온 단말기(재고 → 배정 → 재고)는 마지막 진입 시각이 "그 상태가 된 시각"이다. 이력이 없으면(이력 전 시대의 행, 직접 넣은 행) updated_at이 그나마 가까운 값이다.
  - 확인: 테스트 DB 임시 테이블 4행(지금 상태 이력 있음 / 같은 상태 재진입 / 이력 없음 / 다른 상태 이력만)에 같은 UPDATE를 돌려 각각 마지막 이력, 재진입 시각(앞 진입이 아님), updated_at, updated_at. 개발 DB(단말기 10, 이력 52)는 적용 뒤 null 0, 기대식과 다른 행 0(모두 이력이 있어 updated_at 대체는 개발 DB에서는 쓰이지 않았다).
  - 순서: 새 복합 인덱스를 만든 뒤 status 단독 인덱스를 지운다. 생성된 순서(drop 먼저)는 중간에 실패하면 status 인덱스가 하나도 없는 채로 남는다.
- 열린 이상은 (단말기, 규칙)마다 하나 — MySQL에는 부분 unique가 없다:
  1. 앱이 채우는 `open_key` 열(열 때 값, 닫을 때 NULL) + unique — 앱이 잊으면 깨진다.
  2. 생성 열 `open_key`(resolved_at이 NULL이면 `terminal_id:rule`) + unique — 동작·스키마 비교 모두 안정.
  3. **MikroORM 7 `@Unique({ where: { resolvedAt: null } })`** — MikroORM이 `unique((case when resolved_at is null then terminal_id end), (case … rule end))` 함수 인덱스로 만들고, 엔티티에 열이 늘지 않는다. 열린 행 둘은 위반, 닫힌 행은 NULL이라 몇 개든 된다(테스트로 확인).
  - → 3. 조건에 글자 상수가 없어 `db:migration:check`가 안정적이다(적용 뒤 "최신 상태"). 같은 방법을 VAN 실행의 `status = 'RUNNING'`에 쓰면 글자 상수 때문에 스키마 비교가 늘 달라 2를 썼다(decisions/0033).
- 찾기: 규칙 SQL로 지금 걸린 것을 다 구하고 열린 이상과 (단말기, 규칙) 키로 비교 → 새로 INSERT, 계속 `last_seen_at`, 풀림 `resolved_at`. 셋 다 한 트랜잭션, 갱신은 PK `IN (…)` 500개씩 + `resolved_at is null`(보조 인덱스 범위 UPDATE의 gap 락을 피함, troubleshooting/0014). 기준 시각은 앱이 계산해 파라미터로 넘긴다(SQL `NOW()`는 세션 시간대 KST, troubleshooting/0016). 원시 datetime은 `fromDbDatetime`.
  - 한 번에 하나: Redis 잠금 `<p>:job-lock:anomaly-scan`(5분). 수동은 409 `ANOMALY_SCAN_RUNNING`, 주기는 건너뜀(Task 6). unique가 마지막 안전망. Redis를 쓰는 이유: VAN 실행처럼 "실행 행"이 없는 짧은 작업(쿼리 몇 개)이라 상태를 남길 테이블을 따로 둘 이유가 없고, 기존 `RedisLock`(decisions/0020·0026)을 그대로 쓴다.
  - FK 없음: 찾기가 수천 행을 넣을 때 단말기 행마다 FK 검사 S 락을 걸지 않게(device_connectivity와 같은 이유).
- 규칙 정의(스펙 4.2 표): ALLOCATED_NO_SHIPMENT는 "ALLOCATED가 3일 넘음"(배정 → 출고는 출고 API만 하고 출고하면 SHIPPED라 ALLOCATED 자체가 출고 없음). OFFLINE_TOO_LONG은 device_connectivity의 `online = 0`이고 `last_seen_at`이 기준보다 전, 운영 중만(changed_at은 스냅샷이 처음 쓴 판정 시각이라 쓰지 않음). IN_SERVICE_NO_MERCHANT는 기준일 없음. 기준일은 env `ANOMALY_*_DAYS`(1~365).
- API: `GET /anomalies?rule=&open=&afterId=&limit=`(afterId 키셋, 단말기 시리얼·지금 상태를 붙임), `POST /anomaly-scans`(X-Operator, 동기 200, 새로 걸린 시리얼 앞 100개). 알림은 Task 6.
- 결과·대가: 전이 UPDATE에 열 하나가 늘고 (status, status_changed_at) 인덱스가 상태가 바뀔 때마다 갱신된다(status 단독 인덱스를 지워 인덱스 수는 같다). 이력과 status_changed_at이 어긋날 수 있는 경로: 전이 서비스를 거치지 않는 쓰기(테스트 헬퍼, 운영자가 DB를 직접 고침). `insertMany`는 엔티티 기본값을 쓰지 않아 직접 넣는 곳은 값을 꼭 넣어야 한다(troubleshooting/0022).
- 다시 볼 조건: 규칙이 "상태가 된 뒤 다른 사건이 없음"(예: 배정 뒤 운송장 발급 실패)처럼 이력 내용을 봐야 할 때, 실험 0011에서 1이 충분히 빠르면.
