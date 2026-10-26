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

## 갱신(2026-10-26, fix 커밋): 찾기 겹침 멱등, 오프라인 규칙 빈틈, 경계 테스트

- 찾기 겹침(리뷰): Redis 잠금(5분)이 만료된 뒤 두 찾기가 겹치면, 늦게 쓰는 쪽이 앞 찾기가 이미 연 (단말기, 규칙)을 다시 INSERT해 열린 이상 unique에 걸리고 500이 났다. 테스트 먼저 실패: 늦은 찾기가 열린 이상을 읽은 직후 다른 찾기(잠금 없이 내부 `scanLocked`)가 끝까지 돌게 하면 `UniqueConstraintViolationException: Duplicate entry '13-SHIPPED_TOO_LONG' for key 'anomaly.anomaly_open_unique'`.
  1. unique 위반을 잡아 409 `SCAN_IN_PROGRESS` — 늦은 찾기의 일(계속·풀림 갱신까지)이 통째로 롤백된다. 주기 job이면 그날 찾기가 빠진다.
  2. **INSERT … ON DUPLICATE KEY UPDATE `last_seen_at` = values(`last_seen_at`)** (QueryBuilder `insert().onConflict().merge(['lastSeenAt'])`) — 겹쳐도 끝까지 돌고 (단말기, 규칙)마다 열린 이상은 하나.
  - → 2. MySQL 8.4에서 함수 인덱스(부분 unique 흉내)도 ON DUPLICATE KEY의 대상이 되는지 테스트로 확인했다(열린 행 하나, detected_at은 앞 찾기 시각, last_seen_at은 늦은 찾기 시각). 생성되는 SQL: `insert into anomaly (…) values (…) on duplicate key update last_seen_at = values(last_seen_at)`(8.0.20부터 `values()`는 deprecated 경고 대상이지만 8.4에서 동작).
  - "새로 걸림" 수와 알림: ON DUPLICATE KEY는 몇 행이 실제로 들어갔는지 행 단위로 알려 주지 않는다(affectedRows가 1·2·0을 섞고, FOUND_ROWS 플래그면 바뀌지 않은 갱신도 1). 그래서 같은 트랜잭션에서 `resolved_at is null and detected_at = 이번 찾기 시각`인 열린 행을 다시 읽어 그 키만 "새로 걸림"으로 센다. 나머지는 "계속"으로 센다(겹침 경고 로그). 한계: 두 찾기의 시각이 밀리초까지 같으면 둘 다 새로 걸림으로 센다(알림 중복 정도).
  - PK `IN (…)` 갱신의 `resolved_at is null`은 뺄 수 없다: 겹친 찾기가 이미 닫은 행의 resolved_at을 늦은 시각으로 덮거나, 닫힌 행의 last_seen_at을 바꾼다. EXPLAIN UPDATE(테스트 DB, MySQL 8.4.13): 거의 빈 표에서는 `key: anomaly_resolved_at_rule_index, type: range, rows: 1` — 옵티마이저가 보조 인덱스 범위를 골랐다(그 범위의 next-key 락이 troubleshooting/0014와 같은 모양). 행이 20개쯤 있는 표에서는 같은 문장이 `key: PRIMARY`. 통계에 따라 바뀌므로 문장에 `force index (primary)`를 넣었다(`openRowsUpdateSql`, 원시 SQL). 테스트가 그 문장의 EXPLAIN이 `PRIMARY`·`range`인지 본다.
- 오프라인 규칙 빈틈(리뷰): 전에는 device_connectivity에서 출발해 `online = 0`만 봤다.
  - 하트비트가 한 번도 없는 운영 중 단말기(설치 뒤 켜지지 않음)는 행이 없어 영영 안 걸렸다.
  - 오프라인 판정 job이 밀리거나 멈추면 online=1로 남은 행은 마지막 하트비트가 며칠 전이어도 안 걸렸다.
  - 고침: 운영 중 단말기에서 출발해 LEFT JOIN — `c.last_seen_at < 기준`(online 값은 보지 않음) 또는 `c.terminal_id is null and t.status_changed_at < 기준`. 하트비트가 없으면 detail은 `{ lastSeenAt: null, since: 운영 시작, days }`. 스냅샷 job이 last_seen_at을 주기적으로 MySQL에 쓰므로(decisions/0029) 기준(3일)에 비해 늦음은 무시할 만하다. 테스트 먼저 실패(`expected [] to deeply equal [ …(2) ]`).
- 경계 테스트: 배송 완료 기준(7일)보다 1시간 전·1시간 뒤 두 대. 시간대가 9시간 어긋나면(troubleshooting/0016) 둘 다 뒤집힌다. 지금 코드에서 처음부터 통과(회귀 방지용).
- 이력 시각 정정: 위 "이력은 datetime(초)이라 1초 안에서 같다"는 버림이 아니라 반올림이다. MySQL은 소수 초를 기본으로 반올림해 저장한다(sql_mode에 TIME_TRUNCATE_FRACTIONAL이 없을 때). status_changed_at이 12:00:00.600이면 이력 occurred_at은 12:00:01 — 이력이 최대 0.5초 늦을 수 있고, 둘의 차이는 ±1초 안이다. 이력으로 "그 상태가 된 시각"을 비교할 때는 1초 여유를 둔다.

## 보탬(2026-10-26, Task 6): 알림

- 새로 걸린 이상만 알린다. 계속 걸린 것·풀린 것은 알리지 않는다(매일 같은 알림이 반복되지 않게, 열린 이상은 주간 리포트에 나온다).
- 새 이상이 `ANOMALY_BULK_EVENT_THRESHOLD`(20) 이하면 단말기마다 `anomaly.detected`(serialNo, rule, days(있을 때), detectedAt), 넘으면 `anomaly.detected_bulk` 1행(count, 규칙별 수, 앞 100대, truncated). 첫 찾기나 큰 장애 뒤에 수천 행이 relay 줄을 막지 않게(experiments/0010·decisions/0029와 같은 방식).
- 문구: `[단말온] 이상 단말기 A-0001: 배송 완료 후 미설치 (8일)`, `[단말온] 이상 단말기 30대 새로 발견 (회수 지연 5, 배송 지연 25, 판정 T)` — 규칙 순서, 0인 규칙은 뺀다. 규칙 이름은 `ANOMALY_RULE_LABEL`.
- 찾기와 같은 트랜잭션의 Outbox라 유실이 없다(decisions/0016).
- fix 커밋(겹침 멱등)과 합침: 알림은 계획의 `newMatches`가 아니라 "이 찾기가 실제로 넣은 행"(detected_at = 이번 시각)으로 만든다. 겹친 찾기가 먼저 연 이상은 그 찾기가 이미 알렸으므로 두 번 알리지 않는다.
