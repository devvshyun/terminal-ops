# Day 5 — VAN 등록 대조, 이상 단말기 찾기, 주간 운영 리포트, 실행계획 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **기록 규칙 필수**: 이 저장소의 `CLAUDE.md`를 먼저 읽는다. 모든 Task는 마지막에 `docs/devlog/2026-10-26.md`(컨트롤러가 `# 2026-10-26 (Day 5)` 머리와 Day 4 요약 링크를 만들어 두었다. 작업 중 날짜가 바뀌면 그날 날짜로 새 파일 `docs/devlog/YYYY-MM-DD.md`를 시작하고 첫 줄에 이전 파일을 링크한다)에 항목을 덧붙이고(Day 4 항목과 같은 형식: 제목 시각 = 커밋 시각, `이전 커밋:`, 한 일·확인·막힌 것·결정·다음), Task에 적힌 결정·트러블슈팅·실험 기록을 쓴 뒤 **코드와 같은 커밋**에 넣는다. 예상과 다른 에러를 만나면 고치기 전에 `docs/troubleshooting/`에 기록을 시작한다(이 계획이 0022를 Task 5에 예약했으므로 새로 생기면 0023부터).

**Goal:** 가상 브릿지VAN의 등록 목록(커서 페이지)을 모두 받아 우리 DB와 SQL로 대조하고 재검증으로 확정하며(F9), 상태 경과 규칙 6개로 이상 단말기를 찾아 열린 이상으로 관리하고(F4), 매주 월요일 지난주 운영 수치를 xlsx로 만들어 톡톡메신저에 첨부로 보낸다(F11). 단말기 10만·이력 약 100만에서 실행계획을, 등록 5만에서 대조 소요·거짓 양성을 실험으로 남긴다. Day 4 리뷰 이월(숫자 env 검증, 중복 인덱스)을 먼저 정리한다.

**Architecture:** 세 기능 모두 "큰 집합을 SQL로 비교·집계하고 결과를 한 번 알린다"는 모양이다. 무거운 일은 새 `report` 큐(concurrency 1)에서 돌려 device 큐(짧은 job)를 막지 않는다. VAN 대조는 페이지마다 MySQL 스테이징(`van_registration_snapshot`, PK (run_id, serial_no))에 넣고 두 문장의 LEFT JOIN으로 어긋남 후보를 거른 뒤, 후보마다 VAN 단건과 우리 쪽을 다시 읽어(재검증) 스캔 도중 변경을 걸러 한 트랜잭션에서 확정한다. 이상 찾기는 `terminal.status_changed_at`(전이 서비스가 상태와 같은 UPDATE에서 갱신)과 `(status, status_changed_at)` 인덱스로 규칙마다 범위 하나를 읽고, 열린 이상(부분 unique)과 비교해 PK로 갱신한다. 주간 리포트는 KST 주 경계를 UTC 시각으로 넘겨 DB에서 집계하고, exceljs로 쓴 파일을 `weekly_report` 행(mediumblob)에 저장해 같은 주를 두 번 보내지 않는다. 주기 작업은 BullMQ job scheduler의 cron `pattern` + `tz: 'Asia/Seoul'`. 설계 스펙: `docs/specs/2026-10-26-day5-reports.md`.

**Tech Stack:** Node 24, TypeScript 6.0, Nest.js 12.2 (ESM), MikroORM 7.2.5, MySQL 8.4, Redis 7.4 + ioredis 5.11.1, BullMQ 6.4.0, exceljs 4.4.0, Vitest 5 + unplugin-swc, supertest. partners·device-sim은 의존성 없는 node:http.

---

## 프로세스·데이터 안전 규칙 (모든 Task에 적용)

- **프로세스는 PID로만 끈다.** 직접 띄운 프로세스의 PID(`$!`, `child.pid`)로 `kill <PID>`. `taskkill /IM node.exe`, `pkill node`처럼 이름으로 끄지 않는다(다른 세션·IDE의 node가 함께 죽는다).
- **Redis를 통째로 지우지 않는다.** `FLUSHALL`·`FLUSHDB` 금지. 테스트 키는 접두사 `test-`(globalSetup이 `test-*`만 지운다, 파일 안에서는 `test/helpers/redis-keys.ts`의 `deleteTestKeys`), 개발 서버는 `terminal-ops`. 주기 작업을 지울 때는 `npm run scheduler:clear`.
- **테스트는 테스트 DB(`terminal_ops_test`)에서만.** `resetDatabase`는 테스트 DB가 아니면 거절한다. 테스트 DB는 지우고 다시 만들어도 된다(아래 명령). 개발 DB(`terminal_ops`)에는 마이그레이션 적용(`npm run db:migrate`)·시드·`db:migration:create`, 읽기만 하는 확인 쿼리, Task 11의 실서버 확인만 한다. 개발 DB를 지우거나 `schema refresh`하지 않는다.
  ```bash
  MSYS_NO_PATHCONV=1 docker exec terminal-ops-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "drop database terminal_ops_test; create database terminal_ops_test character set utf8mb4 collate utf8mb4_0900_ai_ci; grant all privileges on terminal_ops_test.* to '"'"'terminal_ops'"'"'@'"'"'%'"'"';"'
  ```
- **테스트를 두 개 동시에 돌리지 않는다.** api 테스트의 globalSetup이 partners를 테스트 포트 4011에 띄운다. 다른 vitest가 돌고 있으면 두 번째 실행이 `Startup Error … code.charCodeAt is not a function`(troubleshooting/0006, 실제 원인은 포트 사용 중)으로 끝난다. 실험(EXPERIMENTS=1)도 마찬가지다.
- 데드락 수(`information_schema.innodb_metrics`의 `lock_deadlocks`)는 앱 계정이 PROCESS 권한이 없어 읽지 못한다. 필요하면 root로 테스트 밖에서 전후를 읽는다(읽기만).
- 실서버 확인 뒤에는 포트(3000·4010·4020, 테스트 4011·4021)에 리스너가 남지 않았는지 `netstat -ano | grep -E ':(3000|4010|4020|4011|4021) .*LISTENING'`으로 확인한다.

## 사전 검증으로 확인된 사실 (2026-10-26, 임시 폴더 스파이크)

계획 작성 전에 저장소(브랜치 `day5-reports`, master 339f697)를 임시 폴더에 복제해 이 계획의 코드를 Task 순서대로 적용하고, Task마다 `tsc --noEmit`과 vitest(api, partners, device-sim)를 돌려 통과를 확인했다(테스트 DB `terminal_ops_test`, Redis는 테스트 접두사만). 실험 0011·0012는 한 번씩 끝까지 돌렸고(숫자는 여기 적지 않는다), 빈 테스트 DB에 마이그레이션 19개를 `up`한 뒤 `check`가 `최신 상태`인 것, Task 5 마이그레이션의 백필이 행이 있는 DB에서 맞게 채우는 것, 테스트 DB·다른 포트(3100·4110·4120)로 Task 11의 실서버 스크립트를 끝까지 돌린 것을 확인했다. 검증이 끝난 뒤 테스트 DB는 지우고 빈 DB로 다시 만들어 두었다.

- 테스트 수(누적, api 기본 실행): Day 4 끝 40개 파일 268 → Task 1 41/277 → Task 3 43/287 → Task 4 45/303 → Task 5 47/310 → Task 6 48/314 → Task 7 50/318 → Task 8 51/324(Task 2·9·10·11은 api 기본 실행 수가 그대로). partners: 5/40 → Task 2 6/47 → Task 8 6/50. device-sim: 4/40 그대로.
- **MySQL은 FK가 쓰는 인덱스를 덮는 인덱스가 있을 때만 지우게 한다**: 테스트 DB에서 `alter table firmware_rollout_target drop index firmware_rollout_target_rollout_id_index`(unique (rollout_id, terminal_id)가 있음)와 `terminal_status_history_terminal_id_index`((terminal_id, occurred_at)가 있음)는 성공했고, 덮는 인덱스가 없는 `alter table terminal drop index terminal_model_id_index`는 `ERROR 1553 (HY000): Cannot drop index 'terminal_model_id_index': needed in a foreign key constraint`. `information_schema.statistics`로 찾은 "FK 열 단독 인덱스이면서 같은 열로 시작하는 다른 인덱스가 있는 것"은 브리프의 3개 외에 `carrier_event_shipment_id_index`(unique(shipment_id, event_key)), `firmware_model_id_index`(unique(model_id, version)), `service_ticket_terminal_id_index`((terminal_id, status))까지 6개였다.
- **MikroORM 7.2.5의 FK 인덱스**: `MetadataDiscovery.initIndexes`가 ManyToOne에 `prop.index ??= true`를 한다. 그래서 `@ManyToOne(() => X, { index: false })`면 FK 인덱스를 만들지 않고, `db:migration:create`가 `drop index` 6줄을 만든다(down은 `add index`).
- **부분 unique(열린 이상은 하나)**: MikroORM 7은 `@Unique({ properties, where })`를 MySQL에서 `unique ((case when <조건> then <열> end), …)` 함수 인덱스로 흉내 낸다(`SchemaHelper.emulatePartialIndexColumns`). `where: { resolvedAt: null }`이면 `(case when \`resolved_at\` is null then …)`이 되고, 열린 행 두 개는 unique 위반, 닫힌 행은 몇 개든 들어갔다. 스키마 비교도 안정적이다(update 뒤 다시 비교하면 빈 SQL, 마이그레이션 체인 뒤 `check` 최신 상태).
  - 그러나 **글자 상수가 든 조건**(`where: { status: 'RUNNING' }`)은 MySQL이 식을 `(case when (\`status\` = _utf8mb4\'RUNNING\') then \`status\` end)`로 바꿔 저장해(information_schema.statistics.EXPRESSION 확인) 마이그레이션 체인 뒤 `check`가 `엔티티와 마이그레이션이 다릅니다`(drop index + add unique)를 냈다. 그래서 "진행 중 VAN 실행은 하나"는 **생성 열** `running_key tinyint generated always as (case when \`status\` = 'RUNNING' then 1 end) virtual` + unique로 했다(이것은 비교가 안정적). `persist: false`를 붙이면 MikroORM이 열을 아예 만들지 않는다(스파이크에서 확인) — 붙이지 않는다. 생성 열은 MikroORM이 INSERT·UPDATE에 넣지 않는다.
- **`type: 'date'`는 글자 'YYYY-MM-DD'로 돈다**(MikroORM DateType, 시간대 변환 없음). `type: 'blob', columnType: 'mediumblob', lazy: true`는 Buffer로 저장·복원되고(100,000바이트로 확인), lazy라 populate 전에는 undefined다. `type: 'blob'`만이면 MySQL `blob`(64KB 상한)이 된다.
- **BullMQ 6.4.0 cron job scheduler**: `upsertJobScheduler('weekly-report', { pattern: '0 9 * * 1', tz: 'Asia/Seoul' }, …)`를 월요일 10:22 KST에 등록하자 `getJobScheduler().next`가 다음 주 월요일 `00:00:00.000Z`(= 09:00 KST), 큐에는 `delayed: 1, waiting: 0` — `every`와 달리 등록하자마자 돌지 않는다. `'0 3 * * *'` + tz는 다음 `18:00Z`. **tz를 빼면 서버 프로세스의 시간대로 해석한다**(이 PC는 KST라 같은 값이 나왔다 — UTC 서버면 9시간 달라진다). `removeJobScheduler`는 delayed job도 지운다. 테스트는 기다리지 않고 `next`를 보고, job은 큐에 직접 넣거나 서비스를 부른다.
- **NaN 주기**: `upsertJobScheduler(id, { every: NaN })`는 `Either .pattern or .every options must be defined for this repeatable job`으로 실패한다(엉뚱한 메시지로 서버 시작이 실패). NaN이 판정 기준(`HEARTBEAT_OFFLINE_AFTER_MS`)에 들어가면 비교가 늘 거짓이라 조용히 오프라인 판정을 안 한다. → intFromEnv.
- **행이 있는 테이블에 NOT NULL datetime 열 추가**: `alter table … add c datetime(3) not null`은 `ERROR 1292 (22007): Incorrect datetime value: '0000-00-00 00:00:00' for column 'c' at row 1`(sql_mode에 STRICT_TRANS_TABLES·NO_ZERO_DATE). 생성된 마이그레이션을 손으로 null 허용 추가 → 백필 → not null로 나눈다. 백필 확인: 마이그레이션 17개를 적용한 DB에 단말기 3대(DELIVERED·IN_STOCK·RECEIVED)와 이력을 넣고 나머지를 적용하니 status_changed_at이 각각 "지금 상태로 들어온 마지막 이력 시각", "같은 상태로 두 번 들어왔으면 나중 것", "이력이 없으면 updated_at"이었다.
- **`em.insertMany`는 엔티티 기본값을 쓰지 않는다**: 새 NOT NULL 열(status_changed_at)을 넣은 뒤 테스트 헬퍼의 `insertMany(Terminal, …)`가 `NotNullConstraintViolationException: Field 'status_changed_at' doesn't have a default value`로 실패했다(Task 5에서 계획한 재현, troubleshooting/0022). 그래서 기존 헬퍼 4곳에 값을 넣는다.
- **이력 occurred_at은 `datetime`(초)라 밀리초가 반올림된다**: `12:59:59.999`를 넣으면 `13:00:00`이 된다. 주 경계 테스트는 초 단위로 둔다. status_changed_at은 `datetime(3)`이라 이력과 1초 안에서만 같다.
- **ORDER BY enum 열은 enum 선언 순서**: `order by source`가 `SHIPMENT`를 `SCAN` 앞에 둔다(글자 순서 아님).
- **`em.execute`의 DELETE·UPDATE는 세 번째 인자 `'run'`이어야 `affectedRows`가 온다**(기본 `'all'`은 행 배열). 실험 0011 첫 실행에서 `'all'`로 지우기 반복문이 끝나지 않아 시간 초과가 났다(계획에 반영함). 타입은 `em.execute<QueryResult>(sql, params, 'run')`.
- **EXPLAIN ANALYZE**: `em.execute('explain analyze …')`는 `[{ EXPLAIN: '-> …' }]` 한 행(트리 글자)을 준다. 날짜 파라미터는 `TIMESTAMP'2026-10-19 00:00:00'`처럼 UTC 값으로 들어간다.
- **SQL로 10만·100만 행 넣기**: 숫자 표(10행 파생 테이블 다섯 개의 교차 조인, 0~99,999)로 `insert … select`를 쓰면 단말기 10만·이력 약 100만(1만 대씩 10문장)·검수 결과 8만이 수 초 안에 들어갔다(잰 값은 실험 0011 기록에 적는다). `cte_max_recursion_depth`(기본 1000)를 바꾸지 않아도 된다.
- **exceljs 4.4.0 쓰기**: `wb.xlsx.writeBuffer()`의 타입은 exceljs 자체 `Buffer`(ArrayBuffer 계열)라 `Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer)`로 감쌌다. default import(`import ExcelJS from 'exceljs'`)만 된다(decisions/0022). 시트 이름 `상태·모델`은 된다(`: \ / ? * [ ]`만 안 됨).
- **톡톡 첨부는 base64 JSON**: partners는 의존성 없는 node:http라 multipart를 직접 풀어야 한다. 기존 `readJson`에 base64 문자열로 받으면 7바이트·12KB 파일이 그대로 돌아왔다.
- **Nest `StreamableFile`**: `new StreamableFile(buffer, { type, length, disposition })`가 Content-Type·Content-Length·Content-Disposition을 그대로 보낸다. 한글 파일 이름은 `filename*=UTF-8''<encodeURIComponent>`.
- **같은 vitest 파일 안에서 `env` 값 바꾸기**: `env`는 고정되지 않은 객체라 테스트가 `env.bridgevanPageSize = 5`로 바꾸고 끝에 되돌릴 수 있다(페이지가 여러 개인 상황을 작은 데이터로 만든다).
- Git Bash `curl -w`의 한글은 깨진다(Day 2와 같음) — 실서버 스크립트의 `-w` 형식은 영어로 쓴다.
- 빈 테스트 DB에 `up`을 하면 `.snapshot-terminal_ops_test.json`이 또 생긴다(troubleshooting/0015). 커밋하지 않고 치운다.

## 범위 조정 (브리프와 다르게 한 것과 이유)

- **중복 인덱스는 6개를 지운다**(브리프 후보 3개 + 같은 조건으로 찾은 3개). 실험 0011의 "삭제 전후 INSERT 비용"은 마이그레이션 뒤에 실험이 테스트 DB에서 인덱스를 잠깐 다시 만들어 잰다(대표로 가장 많이 쓰는 `terminal_status_history`만). 결정은 Task 1에서 기록하고 Task 9에서 숫자를 보탠다.
- **`terminal_status_index`(status 단독)도 지운다**: Task 5의 `(status, status_changed_at)`이 앞부분으로 덮는다. 같은 "중복 인덱스" 원칙(decisions/0034).
- **F4 "그 상태가 된 시각"은 (b) 컬럼 + 복합 인덱스로 먼저 구현하고, 실험 0011이 (a)와 비교해 숫자를 남긴다**: 계획은 코드를 미리 정해야 해서 Task 5에서 (b)로 정하고(이유: 규칙 하나가 범위 하나, 이력 서브쿼리는 단말기마다 이력을 훑는다), 0011이 결과가 같은지와 차이를 잰다. 숫자가 예상과 반대면 decisions/0034에 그대로 적고 다시 볼 조건을 쓴다(코드는 바꾸지 않는다).
- **재검증은 `GET /bridgevan/v1/terminals?serialNo=`로 한다**: 브리프의 단건 `GET …/terminals/:tid`도 만들지만, NOT_REGISTERED 후보는 VAN에 tid가 없어(우리 시리얼만 있다) tid로 다시 물을 수 없다. 대조 키가 시리얼이므로 재검증도 시리얼로.
- **스캔 도중 변경(`mutateDuringScan`)은 "이미 지나간 자리"의 등록을 바꾼다**: 아직 안 읽은 자리가 바뀌면 스냅샷이 새 값을 읽어 거짓 양성이 생기지 않는다. 지나간 자리를 바꿔야 "낡은 스냅샷"이 생긴다. healTo가 있으면 그 값으로(풀림 = 거짓 양성), 없으면 ACTIVE↔SUSPENDED를 뒤집는다(지나간 자리에서 새로 생긴 어긋남 = 이번 실행이 놓침, 다음 실행이 찾음). 실험 0012가 둘 다 센다.
- **어긋남 종류는 SQL이 거르고 TS가 정한다**: 집합 비교 SQL은 네 문장이 아니라 두 문장(우리 운영 중 기준 LEFT JOIN, VAN ACTIVE 기준 LEFT JOIN)으로 어긋난 행만 거르고, 종류는 재검증과 같은 `classify` 함수로 정한다. 같은 규칙을 SQL과 TS 두 곳에 쓰지 않으려고.
- **재검증에서 풀린 후보도 결과 행으로 남긴다**(verified=false, 비교 때의 값): 거짓 양성을 나중에 볼 수 있게. 확정 수(confirmed)와 알림·리포트는 verified=true만.
- **VAN 대조 실행은 BullMQ 재시도를 하지 않는다**(attempts 1): 수백 페이지 중 하나가 실패했다고 처음부터 다시 하지 않도록 재시도는 호출마다(`withPartnerRetry`) 하고, 그래도 실패하면 실행 행을 FAILED(이유)로 남긴다. 멈춘 job을 BullMQ가 다시 돌리면 스테이징을 지우고 처음부터 한다. 워커가 죽어 RUNNING으로 남은 실행은 다음 시작이 `VAN_RUN_STALE_MS`(1시간) 넘은 것을 FAILED로 바꾼다(브리프에 없던 규칙).
- **결과 목록은 afterId 키셋 페이지**(이상 목록도): VAN 목록에서 offset을 버린 이유와 같다(기존 단말기 목록 API는 그대로 offset).
- **ALLOCATED_NO_SHIPMENT는 "ALLOCATED가 3일 넘음"**: 배정 → 출고는 출고 API(SHIPMENT 출처)만 하고 출고하면 SHIPPED가 되므로, ALLOCATED 상태 자체가 "출고 없음"이다. 운송장 테이블을 조인하지 않는다.
- **OFFLINE_TOO_LONG은 device_connectivity의 `online = 0`이고 `last_seen_at`이 3일 넘게 전**(changed_at이 아니라): 스냅샷이 처음 쓴 행의 changed_at은 판정 시각이라 "언제부터 오프라인"을 말하지 않는다.
- **이상 알림은 새로 걸린 것만**(계속·풀림은 알리지 않음): 매일 같은 알림이 반복되지 않게. 열린 이상은 주간 리포트에 나온다. 기준(20)을 넘으면 묶음 1행.
- **수동 이상 찾기 `POST /anomaly-scans`는 동기(200)**, VAN 대조 `POST /van-reconciliations`는 비동기(202): 이상 찾기는 쿼리 몇 개라 1초 안팎(0011이 잰다), VAN 대조는 외부 호출 수백 번이다.
- **주간 리포트의 톡톡 호출은 서비스 안에서 3번까지 다시 한다**(job 재시도가 아니라): 주기 job이 실패하면 다음 주까지 안 돈다. 실패하면 행에 `last_error`가 남고, 수동 `POST /reports/weekly`가 저장한 같은 파일로 이어서 보낸다. 상태는 FAILED 없이 PENDING → GENERATED → SENT.
- **주간 리포트 cron·이상 찾기 cron·VAN cron은 env로 바꿀 수 있다**(`WEEKLY_REPORT_CRON` 등). 잘못된 식은 따로 검사하지 않고 스케줄러 등록(서버 시작)이 BullMQ 오류로 실패하게 둔다(decisions/0035).
- **`withPartnerRetry`·`partnerBackoffMs`를 새로 두고 택배 추적의 `carrierBackoff`가 이것을 부르게 바꾼다**: 같은 규칙(429 Retry-After, 그 밖 500ms·1s·2s…)을 한 곳에.
- **Task 3의 테스트 VAN 등록은 해지(CANCELLED)로 심는다**: 우리 DB에 없는 시리얼을 ACTIVE로 심으면 Task 4의 비교·재검증이 모두 후보로 잡아 단건 조회를 천 번 넘게 해, 수집만 보는 테스트의 호출 수·시간이 흔들렸다(사전 검증에서 시간 초과).
- 하지 않는 것(스펙 8장): VAN에 등록·해지 요청 보내기, 같은 실행에서 놓친 어긋남 잡기, 규칙을 화면에서 바꾸기, 이상 해소 알림, 리포트 서식, 운영 DB 크기의 실행계획, Day 3·4 남은 문제.

## 파일 구조

```
terminal-ops/
├─ .env.example                              새 env(Task 3·4·5·6·8)
├─ apps/partners/
│  ├─ src/bridgevan.ts (새)                  목록(커서)·시리얼 조회·tid 단건·심기·스캔 도중 변경
│  ├─ src/toktok.ts                          파일 올리기, 웹훅 attachments, 관리 API 파일 내려받기
│  ├─ src/state.ts, src/server.ts            bridgevan 설정·저장소, toktok 파일, 경로
│  └─ test/bridgevan.spec.ts (새), test/toktok.spec.ts
└─ apps/api/
   ├─ src/
   │  ├─ config/env-number.ts (새), env.ts    intFromEnv와 새 설정
   │  ├─ common/partner-retry.ts (새)         partnerBackoffMs, withPartnerRetry
   │  ├─ carrier-sync/retry-policy.ts         carrierBackoff가 partnerBackoffMs를 부름
   │  ├─ van/ (새)                            van.entities, bridgevan.client, van-compare, van-reconciliation.service·controller, van.module, dto/
   │  ├─ anomaly/ (새)                        anomaly.entity, anomaly-rules, anomaly.service·controller, anomaly.module, dto/
   │  ├─ report/ (새)                         report.processor, kst-week, weekly-report.queries·xlsx·entity·service·controller, report.module, dto/
   │  ├─ terminal/terminal.entity.ts, transition.service.ts   statusChangedAt
   │  ├─ (중복 인덱스) shipment.entities, firmware.entities, inspection-item.entity, terminal-status-history.entity, service-ticket.entity
   │  ├─ outbox/                              type 3개·문구, ToktokClient.uploadFile·attachments, OutboxModule이 ToktokClient도 내보냄
   │  ├─ queue/queue-names.ts                 report 큐
   │  ├─ scheduler/                           every 또는 cron(pattern + tz), report 큐 주입
   │  ├─ workers/workers.module.ts, app.module.ts, entities.ts
   │  └─ migrations/                          5개
   └─ test/
      ├─ helpers/terminals.ts (새), partners.ts(seedVan·toktokFile), device-fleet.ts
      ├─ unit/env-number, partner-retry, van-compare, kst-week (새), outbox-text, scheduler-guard
      ├─ van-collect, van-reconciliation, anomaly, status-changed-at, report-jobs, weekly-report-data, weekly-report .e2e.spec.ts (새)
      ├─ scheduler.e2e.spec.ts, connectivity.e2e.spec.ts, experiments/device-jobs-timing.spec.ts (변경)
      └─ experiments/query-plans.spec.ts, van-reconciliation.spec.ts (새, EXPERIMENTS=1)
```

명령은 별도 표시가 없으면 `terminal-ops/apps/api`에서 실행한다. partners 명령은 `terminal-ops/apps/partners`에서. Docker 명령이 PATH에 없으면 `"/c/Program Files/Docker/Docker/resources/bin/docker.exe"`를 쓴다. MySQL·Redis 컨테이너가 떠 있어야 한다(`docker compose ps`).

기록 번호: decisions 0032(Task 1)·0033(Task 3, Task 4가 보탬)·0034(Task 5, Task 6·9가 보탬)·0035(Task 6, Task 7·8이 보탬), troubleshooting 0022(Task 5 계획한 재현), experiments 0011·0012. devlog는 `docs/devlog/2026-10-26.md`에 이어 쓴다.

코드 블록에 "전체"라고 적힌 파일은 그 내용으로 파일 전체를 바꾼다(기존 내용에 이번 변경을 반영한 결과다). `diff` 블록은 그 Task 직전 파일에 대한 바뀐 부분이다(`-` 줄을 지우고 `+` 줄을 넣는다, 앞뒤 세 줄은 위치 확인용). 모두 사전 검증 저장소의 Task별 상태에서 그대로 가져왔다.

마이그레이션은 `npm run db:migration:create`가 개발 DB의 스냅샷(`src/migrations/.snapshot-terminal_ops.json`)과 엔티티를 비교해 만든다. 파일 이름의 시각은 실행할 때마다 다르다(`Migration<시각>`). 계획에 적은 up() 내용과 같아야 하고, Task 5만 손으로 고친다.

devlog의 `이전 커밋:`은 그 Task를 시작할 때의 `git log -1 --format=%h`다.

---

### Task 1: Day 4 이월 — 숫자 env 검증(intFromEnv), FK 열 단독 중복 인덱스 6개 정리

**Files:**
- Create: `apps/api/src/config/env-number.ts`, `apps/api/src/migrations/Migration<시각>.ts`(생성)
- Modify: `apps/api/src/config/env.ts`, `apps/api/src/shipment/shipment.entities.ts`, `apps/api/src/firmware/firmware.entities.ts`, `apps/api/src/inspection/inspection-item.entity.ts`, `apps/api/src/terminal/terminal-status-history.entity.ts`, `apps/api/src/service/service-ticket.entity.ts`, `apps/api/src/migrations/.snapshot-terminal_ops.json`(생성이 갱신)
- Test: `apps/api/test/unit/env-number.spec.ts`(새)
- Record: `docs/devlog/2026-10-26.md`, `docs/decisions/0032-숫자-env-검증과-FK-중복-인덱스-정리.md`, `docs/study/backlog.md`

바꾸는 것 요약:
- `intFromEnv(name, fallback, { min, max })`: 비었으면 기본값, `/^-?\d+$/`가 아니거나 안전 정수가 아니면(`abc`, `10s`, `1.5`, `1e3`, `0x10`) 이름·값을 담아 던진다, 범위 밖도 던진다. `env.ts`의 숫자 값 16개(포트 3개, 주기·제한 시간 10개, 개수·속도 3개)가 모두 이것을 쓴다. env 모듈은 불러올 때 계산되므로 잘못된 값이면 서버·워커·스크립트가 시작하지 않는다.
- FK 열 단독 인덱스 6개를 `@ManyToOne(..., { index: false })`로 MikroORM이 만들지 않게 하고 마이그레이션으로 지운다. 각각 같은 열로 시작하는 unique·복합 인덱스가 FK 검사와 조회를 대신한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/unit/env-number.spec.ts`(새):
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, intFromEnv } from '../../src/config/env-number.js';

const MS = { min: 1, max: DAY_MS };

describe('intFromEnv — 숫자 환경변수 검증 (Day 4 리뷰 Minor, decisions/0032)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('없거나 빈 글자(공백)면 기본값, 정수 글자면 그 값(앞뒤 공백은 무시)', () => {
    expect(intFromEnv('X', 2000, MS, {})).toBe(2000);
    expect(intFromEnv('X', 2000, MS, { X: '' })).toBe(2000);
    expect(intFromEnv('X', 2000, MS, { X: '  ' })).toBe(2000);
    expect(intFromEnv('X', 2000, MS, { X: ' 1500 ' })).toBe(1500);
  });

  it.each(['abc', '10s', '1.5', '1e3', '0x10', '99999999999999999999'])('정수 글자가 아닌 %s는 이름과 값을 담아 던진다', (raw) => {
    expect(() => intFromEnv('RELAY_INTERVAL_MS', 2000, MS, { RELAY_INTERVAL_MS: raw })).toThrow(/환경변수 RELAY_INTERVAL_MS=.*정수가 아닙니다/);
  });

  it('범위 밖이면 던진다(0ms 주기, 하루보다 긴 주기, 음수 포트)', () => {
    expect(() => intFromEnv('X', 1, MS, { X: '0' })).toThrow(/범위 1~86400000 밖/);
    expect(() => intFromEnv('X', 1, MS, { X: String(DAY_MS + 1) })).toThrow(/범위/);
    expect(() => intFromEnv('P', 1, { min: 0, max: 65_535 }, { P: '-1' })).toThrow(/범위 0~65535 밖/);
  });

  it('env 모듈은 숫자가 아닌 주기 값이 있으면 불러올 때 던진다(서버·워커가 뜨지 않는다)', async () => {
    vi.stubEnv('RELAY_INTERVAL_MS', 'abc');
    vi.resetModules();
    await expect(import('../../src/config/env.js')).rejects.toThrow(/RELAY_INTERVAL_MS/);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit/env-number.spec.ts`
Expected: `FAIL … Error: Cannot find module '../../src/config/env-number.js'`, `Test Files 1 failed (1)`, `Tests no tests`.

- [ ] **Step 3: 구현**

`apps/api/src/config/env-number.ts`(새):
```ts
export interface IntRange {
  /** 허용하는 가장 작은 값(포함) */
  min: number;
  /** 허용하는 가장 큰 값(포함) */
  max: number;
}

/** 하루(ms). 주기·TTL 상한으로 쓴다 */
export const DAY_MS = 86_400_000;

/**
 * 정수 환경변수를 읽는다. 없거나 빈 글자면 기본값, 정수 글자가 아니거나 범위를 벗어나면 던진다(서버·워커가 뜨지 않게).
 * `Number(process.env.X ?? 기본값)`은 'abc'·'10s'를 NaN으로, '1.5'를 1.5로 그대로 넘겼다(Day 4 리뷰 Minor "새 env 주기값 NaN 검사 없음").
 * NaN·소수 주기가 BullMQ job scheduler·setTimeout에 들어가면 조용히 이상하게 돈다. 시작할 때 이름과 값을 담아 실패하게 한다(decisions/0032).
 * @param source 테스트에서 process.env 대신 넘긴다
 */
export function intFromEnv(name: string, fallback: number, range: IntRange, source: NodeJS.ProcessEnv = process.env): number {
  const text = (source[name] ?? '').trim();
  if (text === '') return fallback;
  // '1e3', '0x10', '1.5', '10s'를 거절한다(Number()는 앞의 둘을 숫자로 읽는다)
  if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error(`환경변수 ${name}=${JSON.stringify(source[name])}는 정수가 아닙니다. 저장소 루트 .env를 확인하세요.`);
  }
  const value = Number(text);
  if (value < range.min || value > range.max) {
    throw new Error(`환경변수 ${name}=${value}가 범위 ${range.min}~${range.max} 밖입니다. 저장소 루트 .env를 확인하세요.`);
  }
  return value;
}
```

`apps/api/src/config/env.ts`:
```diff
--- a/apps/api/src/config/env.ts
+++ b/apps/api/src/config/env.ts
@@ -1,5 +1,6 @@
 import { existsSync } from 'node:fs';
 import { resolve } from 'node:path';
+import { DAY_MS, intFromEnv } from './env-number.js';
 import { resolveHeartbeatWriteMode } from './heartbeat-write-mode.js';
 
 // 스크립트·테스트는 apps/api에서 실행한다. 저장소 루트의 .env를 읽는다(이미 있는 환경변수는 덮어쓰지 않는다).
@@ -19,11 +20,18 @@ function flag(name: string, fallback: boolean): boolean {
 
 const isTest = process.env.NODE_ENV === 'test';
 
+/** 포트(0은 테스트·도구용 임의 포트) */
+const PORT = { min: 0, max: 65_535 };
+/** 주기·제한 시간(ms): 1ms ~ 하루 */
+const MS = { min: 1, max: DAY_MS };
+/** 초당 횟수·개수 */
+const COUNT = { min: 1, max: 100_000 };
+
 export const env = {
-  port: Number(process.env.API_PORT ?? 3000),
+  port: intFromEnv('API_PORT', 3000, PORT),
   mysql: {
     host: process.env.MYSQL_HOST ?? '127.0.0.1',
-    port: Number(process.env.MYSQL_PORT ?? 3306),
+    port: intFromEnv('MYSQL_PORT', 3306, PORT),
     user: required('MYSQL_USER'),
     password: required('MYSQL_PASSWORD'),
     dbName: isTest ? required('MYSQL_TEST_DATABASE') : required('MYSQL_DATABASE'),
@@ -31,10 +39,10 @@ export const env = {
   /** 가상 업체 서버(apps/partners) 주소 */
   partnersUrl: process.env.PARTNERS_URL ?? 'http://127.0.0.1:4010',
   /** 택배사·메신저 호출 타임아웃 */
-  partnerTimeoutMs: Number(process.env.PARTNER_TIMEOUT_MS ?? 3000),
+  partnerTimeoutMs: intFromEnv('PARTNER_TIMEOUT_MS', 3000, MS),
   redis: {
     host: process.env.REDIS_HOST ?? '127.0.0.1',
-    port: Number(process.env.REDIS_PORT ?? 6379),
+    port: intFromEnv('REDIS_PORT', 6379, PORT),
   },
   /**
    * BullMQ 키 접두사. 테스트는 파일마다 다른 접두사를 써서 다른 파일의 job을 보지 않는다
@@ -45,34 +53,34 @@ export const env = {
   runWorkers: flag('RUN_WORKERS', true),
   /** 이 프로세스가 주기 작업(수집 sweep, outbox relay)을 등록할지 */
   runSchedulers: flag('RUN_SCHEDULERS', !isTest),
-  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? 30_000),
-  relayIntervalMs: Number(process.env.RELAY_INTERVAL_MS ?? 2_000),
+  sweepIntervalMs: intFromEnv('SWEEP_INTERVAL_MS', 30_000, MS),
+  relayIntervalMs: intFromEnv('RELAY_INTERVAL_MS', 2_000, MS),
   /** 운영 중 단말기 목록(Redis active)을 MySQL에서 통째로 다시 만드는 주기(decisions/0028) */
-  activeRebuildIntervalMs: Number(process.env.ACTIVE_REBUILD_INTERVAL_MS ?? 60_000),
+  activeRebuildIntervalMs: intFromEnv('ACTIVE_REBUILD_INTERVAL_MS', 60_000, MS),
   /** 하트비트 쓰기 경로. 'mysql'은 실험 0008 비교용(decisions/0027), 운영은 'redis'. NODE_ENV=production에서 'mysql'이면 시작할 때 던진다 */
   heartbeatWriteMode: resolveHeartbeatWriteMode(process.env.HEARTBEAT_WRITE_MODE, process.env.NODE_ENV),
   /** 마지막 하트비트가 이보다 오래되면 오프라인으로 본다(단말기 하트비트 주기 30초의 3배, decisions/0029) */
-  hbOfflineAfterMs: Number(process.env.HEARTBEAT_OFFLINE_AFTER_MS ?? 90_000),
+  hbOfflineAfterMs: intFromEnv('HEARTBEAT_OFFLINE_AFTER_MS', 90_000, MS),
   /** 오프라인 판정 주기 */
-  offlineDetectIntervalMs: Number(process.env.OFFLINE_DETECT_INTERVAL_MS ?? 10_000),
+  offlineDetectIntervalMs: intFromEnv('OFFLINE_DETECT_INTERVAL_MS', 10_000, MS),
   /** 접속 상태 스냅샷(Redis → MySQL) 주기 */
-  connectivitySnapshotIntervalMs: Number(process.env.CONNECTIVITY_SNAPSHOT_INTERVAL_MS ?? 60_000),
+  connectivitySnapshotIntervalMs: intFromEnv('CONNECTIVITY_SNAPSHOT_INTERVAL_MS', 60_000, MS),
   /** 펌웨어 배포 판단(단계 넘기기·자동 중단·시간 초과)과 제안 맞추기 주기(decisions/0031) */
-  rolloutControlIntervalMs: Number(process.env.ROLLOUT_CONTROL_INTERVAL_MS ?? 5_000),
+  rolloutControlIntervalMs: intFromEnv('ROLLOUT_CONTROL_INTERVAL_MS', 5_000, MS),
   /**
    * 한 번 판정에서 오프라인(또는 온라인)으로 바뀐 단말기가 이보다 많으면 단말기별 알림 대신 묶음 알림 한 건
    * (device.offline_bulk/online_bulk)을 남긴다. 5,000건이 relay 줄(2초에 100건)을 100초 막지 않게(decisions/0029, 실험 0010)
    */
-  connectivityBulkEventThreshold: Number(process.env.CONNECTIVITY_BULK_EVENT_THRESHOLD ?? 50),
+  connectivityBulkEventThreshold: intFromEnv('CONNECTIVITY_BULK_EVENT_THRESHOLD', 50, COUNT),
   /** 우리 쪽 호출 속도 제한(초당). 택배사 한도보다 낮게 둔다. */
-  bungaeRatePerSec: Number(process.env.BUNGAE_RATE_PER_SEC ?? 10),
-  neurimboRatePerSec: Number(process.env.NEURIMBO_RATE_PER_SEC ?? 5),
+  bungaeRatePerSec: intFromEnv('BUNGAE_RATE_PER_SEC', 10, COUNT),
+  neurimboRatePerSec: intFromEnv('NEURIMBO_RATE_PER_SEC', 5, COUNT),
   /** 알림을 보낼 톡톡메신저 채널 */
   toktokChannel: process.env.TOKTOK_CHANNEL ?? 'ops',
   /** 박스 스캔 처리 중 잠금(Redis) 유지 시간. 처리가 이보다 길면 잠금이 풀린다(decisions/0020) */
-  scanLockTtlMs: Number(process.env.SCAN_LOCK_TTL_MS ?? 30_000),
+  scanLockTtlMs: intFromEnv('SCAN_LOCK_TTL_MS', 30_000, MS),
   /** A/S 교체 단말기 예약(Redis) 유지 시간. 운송장 발급 + 교체 트랜잭션이 이보다 길면 예약이 풀린다(decisions/0026) */
-  replacementLockTtlMs: Number(process.env.REPLACEMENT_LOCK_TTL_MS ?? 30_000),
+  replacementLockTtlMs: intFromEnv('REPLACEMENT_LOCK_TTL_MS', 30_000, MS),
   /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
   workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
 };
```

FK 열 단독 인덱스를 만들지 않게(엔티티 5개 파일, 6곳):
```diff
--- a/apps/api/src/shipment/shipment.entities.ts
+++ b/apps/api/src/shipment/shipment.entities.ts
@@ -55,7 +55,8 @@ export class CarrierEvent {
   @PrimaryKey()
   id!: number;
 
-  @ManyToOne(() => Shipment)
+  // FK 열 단독 인덱스를 만들지 않는다: unique(shipment_id, event_key)이 이 열로 시작해 FK 검사·조회를 대신한다(decisions/0032)
+  @ManyToOne(() => Shipment, { index: false })
   shipment!: Rel<Shipment>;
 
   @Property({ length: 50 })
```
```diff
--- a/apps/api/src/firmware/firmware.entities.ts
+++ b/apps/api/src/firmware/firmware.entities.ts
@@ -12,7 +12,8 @@ export class Firmware {
   @PrimaryKey()
   id!: number;
 
-  @ManyToOne(() => TerminalModel)
+  // FK 열 단독 인덱스를 만들지 않는다: unique(model_id, version)이 이 열로 시작해 FK 검사·조회를 대신한다(decisions/0032)
+  @ManyToOne(() => TerminalModel, { index: false })
   model!: Rel<TerminalModel>;
 
   @Property({ length: 20 })
@@ -106,7 +107,8 @@ export class FirmwareRolloutTarget {
   @PrimaryKey()
   id!: number;
 
-  @ManyToOne(() => FirmwareRollout)
+  // FK 열 단독 인덱스를 만들지 않는다: unique(rollout_id, terminal_id)이 이 열로 시작해 FK 검사·조회를 대신한다(decisions/0032)
+  @ManyToOne(() => FirmwareRollout, { index: false })
   rollout!: Rel<FirmwareRollout>;
 
   @ManyToOne(() => Terminal)
```
```diff
--- a/apps/api/src/inspection/inspection-item.entity.ts
+++ b/apps/api/src/inspection/inspection-item.entity.ts
@@ -11,7 +11,8 @@ export class InspectionItem {
   @PrimaryKey()
   id!: number;
 
-  @ManyToOne(() => TerminalModel)
+  // FK 열 단독 인덱스를 만들지 않는다: unique(model_id, code)이 이 열로 시작해 FK 검사·조회를 대신한다(decisions/0032)
+  @ManyToOne(() => TerminalModel, { index: false })
   model!: Rel<TerminalModel>;
 
   @Property({ length: 30 })
```
```diff
--- a/apps/api/src/terminal/terminal-status-history.entity.ts
+++ b/apps/api/src/terminal/terminal-status-history.entity.ts
@@ -12,7 +12,8 @@ export class TerminalStatusHistory {
   @PrimaryKey()
   id!: number;
 
-  @ManyToOne(() => Terminal)
+  // FK 열 단독 인덱스를 만들지 않는다: (terminal_id, occurred_at) 인덱스이 이 열로 시작해 FK 검사·조회를 대신한다(decisions/0032)
+  @ManyToOne(() => Terminal, { index: false })
   terminal!: Rel<Terminal>;
 
   /** 등록 이력은 이전 상태가 없어 null */
```
```diff
--- a/apps/api/src/service/service-ticket.entity.ts
+++ b/apps/api/src/service/service-ticket.entity.ts
@@ -24,7 +24,8 @@ export class ServiceTicket {
   id!: number;
 
   /** 고장 접수된 단말기 */
-  @ManyToOne(() => Terminal)
+  // FK 열 단독 인덱스를 만들지 않는다: (terminal_id, status) 인덱스이 이 열로 시작해 FK 검사·조회를 대신한다(decisions/0032)
+  @ManyToOne(() => Terminal, { index: false })
   terminal!: Rel<Terminal>;
 
   @ManyToOne(() => Merchant)
```

- [ ] **Step 4: 통과 확인**

Run:
```bash
npx vitest run test/unit/env-number.spec.ts
npm run typecheck
```
Expected: `Tests  9 passed (9)`, typecheck exit 0.

- [ ] **Step 5: MySQL이 덮는 인덱스 없이는 FK 인덱스 삭제를 거절하는지 직접 본다(기록용, 테스트 DB의 임시 테이블)**

테스트 DB(빈 DB여도 된다)에 임시 테이블 세 개를 만들어 보고 지운다(root):
```bash
MSYS_NO_PATHCONV=1 docker exec terminal-ops-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" terminal_ops_test -e "create table z_parent (id int primary key); create table z_child (id int primary key, parent_id int not null, key z_child_parent_id_index (parent_id), key z_child_parent_id_id_index (parent_id, id), constraint z_child_fk foreign key (parent_id) references z_parent (id)); create table z_alone (id int primary key, parent_id int not null, key z_alone_parent_id_index (parent_id), constraint z_alone_fk foreign key (parent_id) references z_parent (id)); alter table z_child drop index z_child_parent_id_index; select index_name from information_schema.statistics where table_schema=database() and table_name=\"z_child\"; alter table z_alone drop index z_alone_parent_id_index;"; mysql -uroot -p"$MYSQL_ROOT_PASSWORD" terminal_ops_test -e "drop table z_child, z_alone, z_parent;"'
```
Expected: 덮는 복합 인덱스가 있는 z_child는 단독 인덱스가 지워지고 `PRIMARY`, `z_child_parent_id_id_index`(두 줄)만 남는다. 덮는 인덱스가 없는 z_alone은 `ERROR 1553 (HY000) at line 1: Cannot drop index 'z_alone_parent_id_index': needed in a foreign key constraint`. 마지막 drop table로 임시 테이블은 남지 않는다. 출력을 decisions/0032에 붙인다.

- [ ] **Step 6: 마이그레이션**

Run: `npm run db:migration:create`
Expected: `생성: Migration<시각>.ts`, 내용(down은 같은 6개를 `add index`):
```ts
import { Migration } from '@mikro-orm/migrations';

export class Migration20261026011846 extends Migration {

  override name = 'Migration20261026011846';

  override up(): void | Promise<void> {
    this.addSql(`alter table \`carrier_event\` drop index \`carrier_event_shipment_id_index\`;`);

    this.addSql(`alter table \`service_ticket\` drop index \`service_ticket_terminal_id_index\`;`);

    this.addSql(`alter table \`inspection_item\` drop index \`inspection_item_model_id_index\`;`);

    this.addSql(`alter table \`firmware\` drop index \`firmware_model_id_index\`;`);

    this.addSql(`alter table \`firmware_rollout_target\` drop index \`firmware_rollout_target_rollout_id_index\`;`);

    this.addSql(`alter table \`terminal_status_history\` drop index \`terminal_status_history_terminal_id_index\`;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table \`carrier_event\` add index \`carrier_event_shipment_id_index\` (\`shipment_id\`);`);

    this.addSql(`alter table \`firmware\` add index \`firmware_model_id_index\` (\`model_id\`);`);

    this.addSql(`alter table \`firmware_rollout_target\` add index \`firmware_rollout_target_rollout_id_index\` (\`rollout_id\`);`);

    this.addSql(`alter table \`inspection_item\` add index \`inspection_item_model_id_index\` (\`model_id\`);`);

    this.addSql(`alter table \`service_ticket\` add index \`service_ticket_terminal_id_index\` (\`terminal_id\`);`);

    this.addSql(`alter table \`terminal_status_history\` add index \`terminal_status_history_terminal_id_index\` (\`terminal_id\`);`);
  }

}
```

그리고:
```bash
npm run db:migrate
npm run db:migration:check
npx vitest run && npm run typecheck
```
Expected: `적용: Migration<시각>`, `최신 상태`, `Test Files  41 passed (41)`, `Tests  277 passed (277)`, typecheck exit 0.

- [ ] **Step 7: 기록과 커밋**

`docs/devlog/2026-10-26.md` 맨 아래에 덧붙인다:
```markdown

## HH:MM Task 1 Day 4 이월: 숫자 env 검증, FK 열 단독 중복 인덱스 6개 정리
이전 커밋: (git log -1 --format=%h)
- 한 일: intFromEnv(정수·범위, 실패하면 시작 실패)와 env.ts 숫자 값 16개 적용. `@ManyToOne({ index: false })` 6곳, 마이그레이션 `Migration<시각>`(drop index 6개)
- 확인: 테스트 먼저 실패(모듈 없음) → 9 passed, 전체 41개 파일 277 passed, typecheck exit 0, migration check 최신 상태. ERROR 1553 재현(Step 5 출력)
- 막힌 것: …
- 결정: decisions/0032
- 다음: Task 2 브릿지VAN
```

`docs/decisions/0032-숫자-env-검증과-FK-중복-인덱스-정리.md`:
- 날짜 / 관련 기능: 2026-10-26 / 공통(Day 4 리뷰 Minor "새 env 주기값 NaN 검사 없음", "firmware_rollout_target_rollout_id_index 중복 인덱스")
- 상황(env): `Number(process.env.X ?? 기본값)`은 `abc`·`10s`를 NaN, `1.5`를 1.5로 그대로 넘긴다. NaN 주기는 BullMQ가 `Either .pattern or .every options must be defined`라는 엉뚱한 메시지로 시작을 막고, 판정 기준(HEARTBEAT_OFFLINE_AFTER_MS)이 NaN이면 비교가 늘 거짓이라 조용히 오프라인 판정을 안 한다(사전 검증).
- 선택지(env): 1) 그대로 2) 쓰는 곳마다 검사 3) **env를 읽는 한 곳에서 정수·범위 검사하고 실패하면 시작하지 않음** 4) 스키마 라이브러리(zod 등) — 의존성 추가, 숫자 몇 개에는 과함.
- 결정: 3. `intFromEnv(name, fallback, { min, max })`. 범위: 포트 0~65535, 주기·제한 시간 1ms~하루, 개수·속도 1~100,000(이후 Task에서 기준일 1~365). `Number()`가 받아 주는 `1e3`·`0x10`도 거절한다(글자 그대로 정수만).
- 상황(인덱스): MikroORM은 ManyToOne마다 FK 열 인덱스를 만든다(`initIndexes`의 `prop.index ??= true`). 같은 열로 시작하는 unique·복합 인덱스가 이미 있으면 단독 인덱스는 쓰기(INSERT·UPDATE마다 B-tree 하나 더)와 공간만 늘린다. `information_schema.statistics`로 찾은 6개: (표: 테이블, 지운 인덱스, 대신하는 인덱스).
- 선택지(인덱스): 1) 그대로 2) **`index: false` + drop index 마이그레이션** 3) 복합 인덱스 쪽을 지우기 — unique가 업무 규칙이라 지울 수 없다.
- MySQL 확인: FK에는 그 열로 시작하는 인덱스가 꼭 있어야 한다. 덮는 인덱스가 없으면 `ERROR 1553`(Step 5 출력), 있으면 지워진다. 새로 만드는 테이블에서도 MikroORM이 unique·복합 인덱스를 FK보다 먼저 만들어 MySQL이 따로 인덱스를 만들지 않는다(빈 DB 체인으로 확인 — Task 11).
- 결정: 2. 쓰기 비용 숫자는 실험 0011(Task 9)에서 terminal_status_history로 잰다.
- 결과·대가: FK 열 단독 조회(`where terminal_id = ?`)는 복합 인덱스의 앞부분을 쓴다(실행계획 같은 인덱스). 복합 인덱스의 키가 길어 단독 인덱스보다 조금 더 읽는다.
- 다시 볼 조건: 복합 인덱스를 지우거나 열 순서를 바꿀 때(FK가 기댈 인덱스가 없어지면 MySQL이 거절한다), 새 엔티티를 만들 때 같은 중복이 생기는지(`index: false`를 잊으면 생긴다).

`docs/study/backlog.md`에 추가:
```
- [ ] 왼쪽 접두사(leftmost prefix) 규칙과 중복 인덱스 찾기 — 같은 열로 시작하는 인덱스, InnoDB 보조 인덱스에 PK가 붙는 것 (decisions/0032)
- [ ] MySQL FK가 인덱스를 요구하는 이유와 ERROR 1553 (decisions/0032)
```

커밋:
```bash
git add apps/api docs
git commit -m "fix: 숫자 env 검증(intFromEnv)과 FK 열 단독 중복 인덱스 6개 정리" -m "Refs: docs/decisions/0032-숫자-env-검증과-FK-중복-인덱스-정리.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 가상 브릿지VAN — 커서 페이지 목록, 시리얼 조회, 단건, 심기, 스캔 도중 변경 (F9, F12)

**Files:**
- Create: `apps/partners/src/bridgevan.ts`
- Modify: `apps/partners/src/state.ts`, `apps/partners/src/server.ts`
- Test: `apps/partners/test/bridgevan.spec.ts`(새)
- Record: `docs/devlog/2026-10-26.md`, `docs/decisions/0009-…`(갱신 한 줄)

바꾸는 것 요약(명령은 `apps/partners`):
- 등록 저장: `van`(tid → 등록), `vanTids`(tid 오름차순, 심을 때 한 번 정렬), `vanBySerial`. 등록은 `{ tid, serialNo, merchantCode, status: ACTIVE|SUSPENDED|CANCELLED, registeredAt, updatedAt }`.
- `GET /bridgevan/v1/terminals?cursor=&limit=`: 커서 = 앞 페이지 마지막 tid의 base64url(불투명). 이진 탐색으로 그 tid 다음부터 limit건. 더 없으면 `nextCursor: null`(딱 나누어떨어져도 빈 페이지를 한 번 더 부르지 않게). `limit` 1~maxLimit(기본 100, 상한 1000), 깨진 커서 400 `INVALID_CURSOR`.
- `?serialNo=`(재검증용, 0~1건), `GET /bridgevan/v1/terminals/:tid`(없으면 404).
- 골칫거리: `force429Rate`(Retry-After `retryAfterSec`), `error5xxRate`(503), `delayMs`, `mutateDuringScan`(커서를 받은 요청마다 이미 지나간 자리의 서로 다른 등록 n건을 바꿈: healTo가 있으면 그 값으로, 없으면 ACTIVE↔SUSPENDED). 시드 난수(같은 시드면 같은 등록이 같은 값으로).
- `POST /__admin/bridgevan/registrations { registrations, replace? }`: 새 맵에 다 넣어 보고 겹침(tid·시리얼)이 없을 때만 바꾼다(400이면 기존 등록 그대로).
- stats에 `vanMutated`, `vanHealed`. 호출 수는 `calls['bridgevan.list']`, `calls['bridgevan.get']`.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/partners/test/bridgevan.spec.ts`(새):
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPartners, type Partners } from './helpers.js';

interface Item {
  tid: string;
  serialNo: string;
  merchantCode: string;
  status: string;
  registeredAt: string;
  updatedAt: string;
}

/** tid VT-0001…, 시리얼 SN-0001… */
function regs(n: number, extra: (i: number) => Record<string, unknown> = () => ({})) {
  return Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    const pad = String(i).padStart(4, '0');
    return { tid: `VT-${pad}`, serialNo: `SN-${pad}`, merchantCode: 'GANGNAM-KIMBAP', status: 'ACTIVE', ...extra(i) };
  });
}

describe('브릿지VAN — 등록 단말기 목록(커서 페이지)·단건·스캔 도중 변경', () => {
  let p: Partners;
  const seed = (registrations: unknown[], replace?: boolean) =>
    fetch(`${p.base}/__admin/bridgevan/registrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registrations, ...(replace === undefined ? {} : { replace }) }),
    });
  const list = (q: string) => fetch(`${p.base}/bridgevan/v1/terminals${q}`);
  const page = async (q: string) => (await (await list(q)).json()) as { items: Item[]; nextCursor: string | null };

  /** 처음부터 끝까지 커서로 넘긴다 */
  async function scanAll(limit: number) {
    const seen: Item[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body = await page(`?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...body.items);
      cursor = body.nextCursor;
      pages++;
    } while (cursor);
    return { seen, pages };
  }

  beforeAll(async () => {
    p = await startPartners();
  });
  beforeEach(async () => {
    await p.reset();
  });
  afterAll(() => p.close());

  it('커서로 끝까지 넘기면 tid 순서로 모든 등록을 한 번씩 받고, 마지막 페이지의 nextCursor는 null', async () => {
    expect(await (await seed(regs(25))).json()).toEqual({ count: 25 });
    const { seen, pages } = await scanAll(10);
    expect(pages).toBe(3);
    expect(seen.map((r) => r.tid)).toEqual(regs(25).map((r) => r.tid));
    expect(seen[0]).toMatchObject({ tid: 'VT-0001', serialNo: 'SN-0001', merchantCode: 'GANGNAM-KIMBAP', status: 'ACTIVE' });
    expect(seen[0].registeredAt).toEqual(expect.any(String));
    // 딱 나누어떨어지면 마지막 페이지가 꽉 차도 nextCursor는 null(빈 페이지를 한 번 더 부르지 않는다)
    await seed(regs(20));
    expect((await scanAll(10)).pages).toBe(2);
  });

  it('페이지를 넘기는 사이 앞쪽에 등록이 생기거나 지워져도 다음 페이지는 중복·누락 없이 커서 뒤부터(offset이 아님)', async () => {
    await seed(regs(20));
    const first = await page('?limit=10');
    // 지나간 자리(VT-0005 앞)에 새 등록, 아직 안 지나간 자리(VT-0015 뒤)에 새 등록
    await seed([{ tid: 'VT-0004A', serialNo: 'SN-NEW-1', merchantCode: 'YEOKSAM-CAFE', status: 'ACTIVE' }], false);
    await seed([{ tid: 'VT-0015A', serialNo: 'SN-NEW-2', merchantCode: 'YEOKSAM-CAFE', status: 'ACTIVE' }], false);
    const second = await page(`?limit=10&cursor=${first.nextCursor}`);
    const tids = [...first.items, ...second.items].map((r) => r.tid);
    expect(new Set(tids).size).toBe(tids.length); // 중복 없음
    expect(second.items[0].tid).toBe('VT-0011'); // 앞에 하나 생겨도 밀리지 않는다(offset 10이면 VT-0010이 다시 나온다)
    expect(tids).toContain('VT-0015A');
    expect(tids).not.toContain('VT-0004A'); // 이미 지나간 자리에 생긴 것은 이번 스캔에 없다(다음 스캔에서 본다)
  });

  it('시리얼 조회(재검증용)와 tid 단건, 없으면 빈 목록·404', async () => {
    await seed(regs(3));
    expect(await page('?serialNo=SN-0002')).toMatchObject({ items: [{ tid: 'VT-0002', serialNo: 'SN-0002' }], nextCursor: null });
    expect(await page('?serialNo=SN-9999')).toEqual({ items: [], nextCursor: null });
    const one = await fetch(`${p.base}/bridgevan/v1/terminals/VT-0003`);
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ tid: 'VT-0003', serialNo: 'SN-0003', status: 'ACTIVE' });
    expect((await fetch(`${p.base}/bridgevan/v1/terminals/VT-9999`)).status).toBe(404);
    expect((await p.stats()).calls).toMatchObject({ 'bridgevan.list': 2, 'bridgevan.get': 2 });
  });

  it('limit이 범위 밖이거나 커서가 깨졌으면 400', async () => {
    await seed(regs(3));
    expect((await list('?limit=0')).status).toBe(400);
    expect((await list('?limit=1001')).status).toBe(400);
    expect((await list('?limit=abc')).status).toBe(400);
    const bad = await list('?cursor=%%%');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'INVALID_CURSOR' });
  });

  it('스캔 도중 변경: 둘째 페이지부터 요청마다 이미 지나간 등록 n건이 바뀐다(healTo가 있으면 그 값으로, 없으면 ACTIVE↔SUSPENDED). 시드가 같으면 같다', async () => {
    // 홀수 번호는 SUSPENDED로 심고 healTo ACTIVE(곧 풀릴 어긋남)
    const registeredAt = '2026-01-01T00:00:00.000Z';
    const seeded = regs(20, (i) => ({ registeredAt, ...(i % 2 === 1 ? { status: 'SUSPENDED', healTo: { status: 'ACTIVE' } } : {}) }));
    const run = async () => {
      await p.reset();
      await p.configure({ seed: 7, bridgevan: { mutateDuringScan: 3 } });
      await seed(seeded);
      const first = await page('?limit=10');
      await page(`?limit=10&cursor=${first.nextCursor}`);
      // 바뀐 등록만 골라 본다(updatedAt이 registeredAt과 다름)
      const after = (await scanAllNoMutate()).filter((r) => r.updatedAt !== r.registeredAt);
      return { first, after, stats: await p.stats() };
    };
    const scanAllNoMutate = async () => {
      const out: Item[] = [];
      for (const r of seeded) out.push(...(await page(`?serialNo=${r.serialNo}`)).items);
      return out;
    };
    const a = await run();
    expect(a.stats.vanMutated).toBe(3);
    expect(a.after.length).toBeGreaterThan(0);
    // 바뀐 것은 모두 첫 페이지(이미 지나간 자리)에 있던 등록이다
    const firstTids = new Set(a.first.items.map((r) => r.tid));
    for (const r of a.after) expect(firstTids.has(r.tid)).toBe(true);
    // healTo가 있던(홀수) 등록은 ACTIVE로 고쳐졌다
    for (const r of a.after.filter((r) => Number(r.tid.slice(3)) % 2 === 1)) expect(r.status).toBe('ACTIVE');
    expect(a.stats.vanHealed).toBe(a.after.filter((r) => Number(r.tid.slice(3)) % 2 === 1).length);
    // 같은 시드면 같은 등록이 같은 값으로 바뀐다
    const b = await run();
    expect(b.after.map((r) => [r.tid, r.status])).toEqual(a.after.map((r) => [r.tid, r.status]));
  });

  it('429(Retry-After)·503 골칫거리', async () => {
    await seed(regs(3));
    await p.configure({ bridgevan: { force429Rate: 1, retryAfterSec: 2 } });
    const limited = await list('?limit=10');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('2');
    await p.configure({ bridgevan: { force429Rate: 0, error5xxRate: 1 } });
    expect((await list('?limit=10')).status).toBe(503);
    expect((await fetch(`${p.base}/bridgevan/v1/terminals/VT-0001`)).status).toBe(503);
  });

  it('심기: 필드가 틀렸거나 tid·시리얼이 겹치면 400이고 기존 등록은 그대로', async () => {
    await seed(regs(2));
    expect((await seed([{ tid: 'X', serialNo: 'Y', merchantCode: 'Z', status: 'WRONG' }])).status).toBe(400);
    const dup = await seed([...regs(1), { tid: 'VT-0009', serialNo: 'SN-0001', merchantCode: 'Z', status: 'ACTIVE' }]);
    expect(dup.status).toBe(400);
    expect((await dup.json()).error).toBe('DUPLICATE');
    expect((await scanAll(10)).seen.map((r) => r.tid)).toEqual(['VT-0001', 'VT-0002']);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/bridgevan.spec.ts`
Expected: `Tests  7 failed (7)` — 경로가 없어 `expected { error: 'NO_ROUTE', …(2) } to deeply equal { count: 25 }`, `expected 404 to be 400`, `first.items is not iterable` 등.

- [ ] **Step 3: 구현**

`apps/partners/src/state.ts`:
```diff
--- a/apps/partners/src/state.ts
+++ b/apps/partners/src/state.ts
@@ -38,12 +38,31 @@ export interface SeumConfig {
   error5xxRate: number;
 }
 
+export interface BridgevanConfig {
+  /** 목록 한 페이지에 줄 수 있는 최대 건수(limit 상한) */
+  maxLimit: number;
+  /** 목록·단건 응답 지연(ms) */
+  delayMs: number;
+  /** 503을 낼 확률(0~1) */
+  error5xxRate: number;
+  /** 429를 낼 확률(0~1) */
+  force429Rate: number;
+  /** 429 응답의 Retry-After(초) */
+  retryAfterSec: number;
+  /**
+   * 스캔 도중 변경: 커서를 받은 목록 요청(둘째 페이지부터)마다, 이미 지나간(커서 앞) 등록 n건을 바꾼다.
+   * healTo가 있는 등록은 그 값으로 고쳐지고(어긋남이 풀림), 없으면 ACTIVE↔SUSPENDED가 뒤집힌다.
+   */
+  mutateDuringScan: number;
+}
+
 export interface PartnersConfig {
   seed: number;
   bungae: BungaeConfig;
   neurimbo: NeurimboConfig;
   toktok: ToktokConfig;
   seum: SeumConfig;
+  bridgevan: BridgevanConfig;
 }
 
 export interface ConfigPatch {
@@ -52,6 +71,7 @@ export interface ConfigPatch {
   neurimbo?: Partial<NeurimboConfig>;
   toktok?: Partial<ToktokConfig>;
   seum?: Partial<SeumConfig>;
+  bridgevan?: Partial<BridgevanConfig>;
 }
 
 export function defaultConfig(): PartnersConfig {
@@ -61,6 +81,7 @@ export function defaultConfig(): PartnersConfig {
     neurimbo: { advancePerPoll: 1, delayMs: 0, error5xxRate: 0, shuffle: false },
     toktok: { failRate: 0 },
     seum: { shortfall: 0, foreignSerials: 0, error5xxRate: 0 },
+    bridgevan: { maxLimit: 1000, delayMs: 0, error5xxRate: 0, force429Rate: 0, retryAfterSec: 1, mutateDuringScan: 0 },
   };
 }
 
@@ -79,6 +100,21 @@ export interface SeumPurchaseOrder {
   serials: string[];
 }
 
+export const VAN_STATUSES = ['ACTIVE', 'SUSPENDED', 'CANCELLED'] as const;
+export type VanStatus = (typeof VAN_STATUSES)[number];
+
+/** 브릿지VAN에 등록된 단말기 한 대(가상). tid는 VAN이 붙인 단말기 번호 */
+export interface VanRegistration {
+  tid: string;
+  serialNo: string;
+  merchantCode: string;
+  status: VanStatus;
+  registeredAt: string;
+  updatedAt: string;
+  /** 스캔 도중 변경(mutateDuringScan)이 이 등록을 고를 때 바꿀 값. 테스트·실험이 "곧 풀릴 어긋남"을 심을 때 쓴다 */
+  healTo?: { status?: VanStatus; merchantCode?: string };
+}
+
 export interface ToktokMessage {
   channel: string;
   idempotencyKey: string;
@@ -106,10 +142,14 @@ export interface Stats {
   inFlightTotal: number;
   /** 운송장 구분 없이 동시에 처리한 번개 추적 조회 수의 최댓값. 1보다 크면 실제로 겹쳐 돌았다는 뜻 */
   maxInFlightTotal: number;
+  /** 스캔 도중 변경으로 바뀐 브릿지VAN 등록 수(healed 포함) */
+  vanMutated: number;
+  /** 그중 healTo로 고쳐진 수 */
+  vanHealed: number;
 }
 
 function emptyStats(): Stats {
-  return { calls: {}, perTracking: {}, status429: 0, status429Limit: 0, status429Forced: 0, status5xx: 0, overlaps: 0, maxInFlight: 0, inFlightTotal: 0, maxInFlightTotal: 0 };
+  return { calls: {}, perTracking: {}, status429: 0, status429Limit: 0, status429Forced: 0, status5xx: 0, overlaps: 0, maxInFlight: 0, inFlightTotal: 0, maxInFlightTotal: 0, vanMutated: 0, vanHealed: 0 };
 }
 
 /** 가상 업체 서버의 메모리 상태. 재시작하거나 reset하면 모두 사라진다. */
@@ -125,6 +165,10 @@ export class PartnersState {
   /** 번개 추적 조회가 받아들여진 시각(최근 1초) */
   bungaeWindow: number[] = [];
   messages: ToktokMessage[] = [];
+  /** 브릿지VAN 등록(tid → 등록), tid 오름차순 목록(커서 페이지용), 시리얼 → tid */
+  van = new Map<string, VanRegistration>();
+  vanTids: string[] = [];
+  vanBySerial = new Map<string, string>();
   stats: Stats = emptyStats();
   private inFlight = new Map<string, number>();
 
@@ -138,6 +182,9 @@ export class PartnersState {
     this.seum.clear();
     this.bungaeWindow = [];
     this.messages = [];
+    this.van.clear();
+    this.vanTids = [];
+    this.vanBySerial.clear();
     this.stats = emptyStats();
     this.inFlight.clear();
   }
@@ -150,6 +197,7 @@ export class PartnersState {
       neurimbo: { ...this.config.neurimbo, ...patch.neurimbo },
       toktok: { ...this.config.toktok, ...patch.toktok },
       seum: { ...this.config.seum, ...patch.seum },
+      bridgevan: { ...this.config.bridgevan, ...patch.bridgevan },
     };
     if (patch.seed !== undefined) this.rng = createRng(patch.seed);
     return this.config;
```

`apps/partners/src/bridgevan.ts`(새):
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendJson, sleep } from './http.js';
import { VAN_STATUSES, type PartnersState, type VanRegistration, type VanStatus } from './state.js';

/** 목록 기본 페이지 크기 */
export const BRIDGEVAN_DEFAULT_LIMIT = 100;

const isStatus = (v: unknown): v is VanStatus => typeof v === 'string' && (VAN_STATUSES as readonly string[]).includes(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** 커서는 "마지막으로 준 tid"를 base64url로 감싼 것. 클라이언트는 내용을 몰라도 된다(불투명) */
export function encodeCursor(tid: string): string {
  return Buffer.from(tid, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string | null {
  const tid = Buffer.from(cursor, 'base64url').toString('utf8');
  return tid.length > 0 && encodeCursor(tid) === cursor ? tid : null;
}

/** 정렬된 tid 목록에서 tid보다 큰 첫 위치(이진 탐색) */
function upperBound(tids: string[], tid: string): number {
  let lo = 0;
  let hi = tids.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (tids[mid] <= tid) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function view(r: VanRegistration) {
  return { tid: r.tid, serialNo: r.serialNo, merchantCode: r.merchantCode, status: r.status, registeredAt: r.registeredAt, updatedAt: r.updatedAt };
}

/** 429·503·지연(목록·단건 공통 골칫거리). 응답을 보냈으면 true */
async function trouble(state: PartnersState, res: ServerResponse): Promise<boolean> {
  const cfg = state.config.bridgevan;
  if (state.chance(cfg.force429Rate)) {
    state.stats.status429 += 1;
    state.stats.status429Forced += 1;
    sendJson(res, 429, { error: 'RATE_LIMITED' }, { 'Retry-After': String(cfg.retryAfterSec) });
    return true;
  }
  if (state.chance(cfg.error5xxRate)) {
    state.stats.status5xx += 1;
    sendJson(res, 503, { error: 'TEMPORARY_UNAVAILABLE' });
    return true;
  }
  if (cfg.delayMs > 0) await sleep(cfg.delayMs);
  return false;
}

/**
 * 스캔 도중 변경: 이미 지나간 등록(tids[0..passed)) 중 서로 다른 n건을 시드 난수로 골라 바꾼다.
 * healTo가 있으면 그 값으로(어긋남이 풀림, 한 번만), 없으면 ACTIVE↔SUSPENDED를 뒤집는다(CANCELLED는 그대로).
 */
function mutatePassed(state: PartnersState, passed: number): void {
  const n = state.config.bridgevan.mutateDuringScan;
  if (n <= 0 || passed <= 0) return;
  const now = new Date().toISOString();
  // 한 요청 안에서는 서로 다른 등록을 고른다(같은 등록을 두 번 고르면 고친 값을 다시 뒤집는다)
  const picked = new Set<number>();
  while (picked.size < Math.min(n, passed)) picked.add(Math.floor(state.rng() * passed));
  for (const index of picked) {
    const r = state.van.get(state.vanTids[index])!;
    if (r.healTo) {
      if (r.healTo.status) r.status = r.healTo.status;
      if (r.healTo.merchantCode) r.merchantCode = r.healTo.merchantCode;
      delete r.healTo;
      state.stats.vanHealed += 1;
    } else if (r.status === 'ACTIVE' || r.status === 'SUSPENDED') {
      r.status = r.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
    } else {
      continue;
    }
    r.updatedAt = now;
    state.stats.vanMutated += 1;
  }
}

/**
 * GET /bridgevan/v1/terminals?cursor=&limit=  → { items, nextCursor }
 * 커서(키셋) 페이지: tid 오름차순, 커서 = 앞 페이지 마지막 tid. offset이 아니므로 페이지를 넘기는 사이 앞쪽에 등록이 생기거나
 * 지워져도 다음 페이지가 밀리거나 당겨지지 않는다(중복·누락 없음, decisions/0033). 마지막 페이지면 nextCursor null.
 * GET /bridgevan/v1/terminals?serialNo=  → { items: [0~1건], nextCursor: null } (재검증용 시리얼 조회, 스캔 도중 변경 없음)
 */
export async function bridgevanList(state: PartnersState, url: URL, res: ServerResponse): Promise<void> {
  state.count('bridgevan.list');
  const serialNo = url.searchParams.get('serialNo');
  const cursor = url.searchParams.get('cursor');
  const limitText = url.searchParams.get('limit');
  const limit = limitText === null ? BRIDGEVAN_DEFAULT_LIMIT : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > state.config.bridgevan.maxLimit) {
    return sendJson(res, 400, { error: 'BAD_REQUEST', message: `limit은 1~${state.config.bridgevan.maxLimit}입니다.` });
  }
  const after = cursor ? decodeCursor(cursor) : null;
  if (cursor && after === null) return sendJson(res, 400, { error: 'INVALID_CURSOR' });
  if (await trouble(state, res)) return;

  if (serialNo !== null) {
    const tid = state.vanBySerial.get(serialNo);
    return sendJson(res, 200, { items: tid ? [view(state.van.get(tid)!)] : [], nextCursor: null });
  }
  const start = after === null ? 0 : upperBound(state.vanTids, after);
  // 골칫거리: 둘째 페이지부터, 이미 지나간 등록이 바뀐다(첫 페이지에서 본 값이 낡는다)
  if (after !== null) mutatePassed(state, start);
  const page = state.vanTids.slice(start, start + limit).map((tid) => view(state.van.get(tid)!));
  const more = start + limit < state.vanTids.length;
  sendJson(res, 200, { items: page, nextCursor: more && page.length > 0 ? encodeCursor(page.at(-1)!.tid) : null });
}

/** GET /bridgevan/v1/terminals/:tid → 등록 한 건, 없으면 404 */
export async function bridgevanGet(state: PartnersState, tid: string, res: ServerResponse): Promise<void> {
  state.count('bridgevan.get');
  if (await trouble(state, res)) return;
  const r = state.van.get(tid);
  if (!r) return sendJson(res, 404, { error: 'NOT_FOUND' });
  sendJson(res, 200, view(r));
}

/**
 * POST /__admin/bridgevan/registrations  { registrations: [{ tid, serialNo, merchantCode, status, registeredAt?, healTo? }], replace? }
 * 테스트·실험이 VAN 쪽 등록을 심는다. replace(기본 true)면 기존 등록을 모두 지우고 넣는다. tid·serialNo는 각각 겹치면 안 된다.
 */
export async function bridgevanSeed(state: PartnersState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const list = body?.registrations;
  if (!Array.isArray(list)) return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'registrations 배열이 필요합니다.' });
  const now = new Date().toISOString();
  const incoming: VanRegistration[] = [];
  for (const [i, raw] of list.entries()) {
    const r = raw as Record<string, unknown>;
    const heal = r.healTo as Record<string, unknown> | undefined;
    if (
      !nonEmpty(r.tid) ||
      !nonEmpty(r.serialNo) ||
      !nonEmpty(r.merchantCode) ||
      !isStatus(r.status) ||
      (heal !== undefined && (typeof heal !== 'object' || (heal.status !== undefined && !isStatus(heal.status))))
    ) {
      return sendJson(res, 400, { error: 'BAD_REQUEST', message: `registrations[${i}]: tid, serialNo, merchantCode, status(${VAN_STATUSES.join('|')})가 필요합니다.` });
    }
    const registeredAt = typeof r.registeredAt === 'string' ? r.registeredAt : now;
    incoming.push({
      tid: r.tid,
      serialNo: r.serialNo,
      merchantCode: r.merchantCode,
      status: r.status,
      registeredAt,
      updatedAt: registeredAt,
      ...(heal ? { healTo: { status: heal.status as VanStatus | undefined, merchantCode: heal.merchantCode as string | undefined } } : {}),
    });
  }
  // 새 맵에 다 넣어 보고 겹침이 없을 때만 바꾼다(400이면 기존 등록 그대로)
  const keep = body?.replace === false;
  const van = new Map(keep ? state.van : []);
  const bySerial = new Map(keep ? state.vanBySerial : []);
  for (const r of incoming) {
    const other = bySerial.get(r.serialNo);
    if ((other !== undefined && other !== r.tid) || (van.has(r.tid) && van.get(r.tid)!.serialNo !== r.serialNo)) {
      return sendJson(res, 400, { error: 'DUPLICATE', message: `tid ${r.tid} / serialNo ${r.serialNo}가 다른 등록과 겹칩니다.` });
    }
    van.set(r.tid, r);
    bySerial.set(r.serialNo, r.tid);
  }
  state.van = van;
  state.vanBySerial = bySerial;
  state.vanTids = [...state.van.keys()].sort();
  sendJson(res, 200, { count: state.van.size });
}
```

`apps/partners/src/server.ts`:
```diff
--- a/apps/partners/src/server.ts
+++ b/apps/partners/src/server.ts
@@ -1,4 +1,5 @@
 import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
+import { bridgevanGet, bridgevanList, bridgevanSeed } from './bridgevan.js';
 import { bungaeCreateWaybill, bungaeTrack } from './bungae.js';
 import { BadJsonError, readJson, sendJson } from './http.js';
 import { neurimboCreateInvoice, neurimboTrack } from './neurimbo.js';
@@ -24,6 +25,7 @@ async function route(state: PartnersState, req: IncomingMessage, res: ServerResp
   }
   if (method === 'GET' && path === '/__admin/stats') return sendJson(res, 200, state.stats);
   if (method === 'GET' && path === '/__admin/toktok/messages') return sendJson(res, 200, toktokSummary(state));
+  if (method === 'POST' && path === '/__admin/bridgevan/registrations') return bridgevanSeed(state, req, res);
 
   // 번개택배(JSON)
   if (method === 'POST' && path === '/bungae/v1/waybills') return bungaeCreateWaybill(state, req, res);
@@ -41,6 +43,12 @@ async function route(state: PartnersState, req: IncomingMessage, res: ServerResp
     return seumDeliveryNote(state, decodeURIComponent(m[1]), res);
   }
 
+  // 브릿지VAN: 등록 단말기 목록(커서 페이지)·단건
+  if (method === 'GET' && path === '/bridgevan/v1/terminals') return bridgevanList(state, url, res);
+  if (method === 'GET' && (m = path.match(/^\/bridgevan\/v1\/terminals\/([^/]+)$/))) {
+    return bridgevanGet(state, decodeURIComponent(m[1]), res);
+  }
+
   // 톡톡메신저 웹훅
   if (method === 'POST' && (m = path.match(/^\/toktok\/hooks\/([^/]+)$/))) {
     return toktokHook(state, decodeURIComponent(m[1]), req, res);
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: `Test Files  6 passed (6)`, `Tests  47 passed (47)`, typecheck·build exit 0. api 쪽은 바뀐 것이 없다(41/277 그대로).

- [ ] **Step 5: 기록과 커밋**

devlog에 `## HH:MM Task 2 가상 브릿지VAN — 커서 페이지·시리얼 조회·스캔 도중 변경 (F9, F12)` 항목(실패 확인 7 failed → 47 passed).

`docs/decisions/0009-가상-업체-서버는-node-http-별도-프로세스.md` 끝에 한 줄:
```
- 갱신(2026-10-26 Day 5): 브릿지VAN을 같은 방식으로 더했다. 목록은 커서(키셋, 마지막 tid의 base64url) 페이지라 페이지 사이 앞쪽 삽입·삭제에 밀리지 않는다(offset이면 중복·누락, decisions/0033). 재검증용 시리얼 조회, 관리 API 심기(healTo), 스캔 도중 변경(mutateDuringScan: 이미 지나간 자리의 등록을 시드 난수로 바꿈). Task 8에서 톡톡메신저 파일 올리기(base64 JSON)를 더한다.
```

커밋:
```bash
git add apps/partners docs
git commit -m "feat(F9): 가상 브릿지VAN — 커서 페이지 목록, 시리얼 조회, 스캔 도중 변경" -m "Refs: docs/decisions/0009-가상-업체-서버는-node-http-별도-프로세스.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: VAN 대조 실행과 수집 — 실행 행(진행 중 하나), 커서 수집·스테이징, 한 job 안의 재시도, report 큐 (F9)

**Files:**
- Create: `apps/api/src/common/partner-retry.ts`, `apps/api/src/van/van.entities.ts`, `apps/api/src/van/bridgevan.client.ts`, `apps/api/src/van/van-reconciliation.service.ts`, `apps/api/src/van/van-reconciliation.controller.ts`, `apps/api/src/van/van.module.ts`, `apps/api/src/report/report.processor.ts`, `apps/api/src/migrations/Migration<시각>.ts`(생성)
- Modify: `apps/api/src/carrier-sync/retry-policy.ts`, `apps/api/src/config/env.ts`, `apps/api/src/queue/queue-names.ts`, `apps/api/src/workers/workers.module.ts`, `apps/api/src/app.module.ts`, `apps/api/src/entities.ts`, `.env.example`
- Test: `apps/api/test/helpers/partners.ts`, `apps/api/test/unit/partner-retry.spec.ts`(새), `apps/api/test/van-collect.e2e.spec.ts`(새)
- Record: `docs/devlog/2026-10-26.md`, `docs/decisions/0033-VAN-등록-대조는-커서-수집-스테이징-SQL-비교-재검증.md`(이 Task에서 시작, Task 4가 보탬), `docs/decisions/0014-…`·`0013-…`(갱신 한 줄씩), `docs/study/backlog.md`

바꾸는 것 요약:
- `partnerBackoffMs(attempt, error)`: 429면 Retry-After(최소 500ms), 그 밖 500ms·1s·2s… — 택배 추적의 `carrierBackoff`가 이것을 부른다(규칙 한 곳). `withPartnerRetry(fn, { attempts, sleep?, onRetry? })`: 429·5xx·타임아웃만 다시, 영구 오류·그 밖은 바로 던짐.
- `VanReconciliationRun`: 실행 행. 진행 중 하나 = 생성 열 `running_key`(RUNNING이면 1, 아니면 NULL) + unique. `start`가 unique 위반을 409 `VAN_RECONCILIATION_RUNNING`으로. 시작할 때 `VAN_RUN_STALE_MS`(1시간) 넘게 RUNNING인 실행을 FAILED로(잠그지 않고 읽은 뒤 PK 갱신).
- `VanRegistrationSnapshot`: PK (run_id, serial_no), FK 없음. `collect`가 먼저 그 실행의 스테이징을 지우고(멈춘 job 재시도 대비), 커서로 끝까지 받으며 페이지마다 `insert … on duplicate key update` 한 문장(자동 커밋). 지우기는 `delete … where run_id = ? limit 5000`을 `'run'`으로 되풀이(affectedRows).
- `execute(runId)`: 이 Task에서는 수집만 하고 COMPLETED(pages, fetched, retries, phaseMs.collect). 실패하면 FAILED(이유)로 남기고 던지지 않는다(job은 끝남). Task 4가 비교·재검증·확정을 넣는다.
- `POST /van-reconciliations`(X-Operator) → 실행 행 + report 큐 `van-reconcile` job(jobId `van-run-<id>`, attempts 1) → 202. 큐에 못 넣으면 그 실행을 FAILED로. `GET /van-reconciliations/:id`.
- report 큐(새, concurrency 1)와 `ReportProcessor`: `van-reconcile`(runId), `van-reconcile-scheduled`(주기용, Task 6이 등록), 모르는 job은 UnrecoverableError.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/helpers/partners.ts`(브릿지VAN 심기·stats 필드):
```diff
--- a/apps/api/test/helpers/partners.ts
+++ b/apps/api/test/helpers/partners.ts
@@ -24,6 +24,20 @@ export interface PartnersStats {
   inFlightTotal: number;
   /** 운송장 구분 없이 동시에 처리한 번개 추적 조회 수의 최댓값 */
   maxInFlightTotal: number;
+  /** 스캔 도중 변경으로 바뀐 브릿지VAN 등록 수, 그중 healTo로 고쳐진 수 */
+  vanMutated: number;
+  vanHealed: number;
+}
+
+/** 브릿지VAN에 심는 등록(apps/partners/src/state.ts의 VanRegistration) */
+export interface VanSeed {
+  tid: string;
+  serialNo: string;
+  merchantCode: string;
+  status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED';
+  registeredAt?: string;
+  /** 스캔 도중 변경(mutateDuringScan)이 고를 때 바꿀 값 */
+  healTo?: { status?: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED'; merchantCode?: string };
 }
 
 export interface ToktokSummary {
@@ -38,6 +52,9 @@ export const partners = {
   stats: () => call<PartnersStats>('GET', '/__admin/stats'),
   toktok: () => call<ToktokSummary>('GET', '/__admin/toktok/messages'),
   /** 세움전자 납품 명세(테스트가 "공장이 보낸 박스"를 만들 때 쓴다). 호출 수(seum.deliveryNote)에 더해진다. */
+  /** 브릿지VAN 등록을 심는다(replace 기본 true: 기존 등록을 지우고) */
+  seedVan: (registrations: VanSeed[], replace = true) =>
+    call<{ count: number }>('POST', '/__admin/bridgevan/registrations', { registrations, replace }),
   deliveryNote: (poNo: string) =>
     call<{ poNo: string; serials: string[] }>('GET', `/seum/v1/purchase-orders/${encodeURIComponent(poNo)}/delivery-note`),
 };
```

`apps/api/test/unit/partner-retry.spec.ts`(새):
```ts
import { describe, expect, it } from 'vitest';
import { carrierBackoff } from '../../src/carrier-sync/retry-policy.js';
import { PartnerPermanentError, PartnerRateLimitedError, PartnerTransientError } from '../../src/common/partner-errors.js';
import { partnerBackoffMs, withPartnerRetry } from '../../src/common/partner-retry.js';

describe('withPartnerRetry — 한 job 안의 외부 호출 재시도 (decisions/0033)', () => {
  it('429는 Retry-After(최소 500ms), 5xx는 500ms·1s·2s… 기다린 뒤 다시 하고, 성공하면 값을 돌려준다', async () => {
    const waits: number[] = [];
    const errors = [new PartnerRateLimitedError('429', 2000), new PartnerTransientError('503'), new PartnerTransientError('503'), new PartnerRateLimitedError('429', 0)];
    let calls = 0;
    const value = await withPartnerRetry(
      async () => {
        calls++;
        const e = errors.shift();
        if (e) throw e;
        return 'ok';
      },
      { attempts: 5, sleep: async (ms) => void waits.push(ms) },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(5);
    expect(waits).toEqual([2000, 1000, 2000, 500]);
  });

  it('영구 오류와 모르는 오류는 바로 던지고, 다시 할 수 있는 오류도 attempts를 다 쓰면 던진다', async () => {
    let calls = 0;
    const sleep = async () => undefined;
    await expect(withPartnerRetry(async () => (calls++, Promise.reject(new PartnerPermanentError('400'))), { attempts: 5, sleep })).rejects.toBeInstanceOf(PartnerPermanentError);
    expect(calls).toBe(1);
    await expect(withPartnerRetry(async () => Promise.reject(new TypeError('x')), { attempts: 5, sleep })).rejects.toBeInstanceOf(TypeError);
    calls = 0;
    const retried: number[] = [];
    await expect(
      withPartnerRetry(async () => (calls++, Promise.reject(new PartnerTransientError('503'))), { attempts: 3, sleep, onRetry: (_e, attempt) => retried.push(attempt) }),
    ).rejects.toBeInstanceOf(PartnerTransientError);
    expect(calls).toBe(3);
    expect(retried).toEqual([1, 2]);
  });

  it('택배 추적 job의 carrier 백오프와 같은 규칙이다', () => {
    const limited = new PartnerRateLimitedError('429', 3000);
    expect(carrierBackoff(1, 'carrier', limited)).toBe(partnerBackoffMs(1, limited));
    expect([1, 2, 3].map((n) => carrierBackoff(n, 'carrier', new PartnerTransientError('x')))).toEqual([500, 1000, 2000]);
  });
});
```

`apps/api/test/van-collect.e2e.spec.ts`(새):
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BusinessError } from '../src/common/domain-errors.js';
import { VanReconciliationRun, VanRegistrationSnapshot, VanRunStatus, VanRunTrigger, VanStatus } from '../src/van/van.entities.js';
import { VanReconciliationService } from '../src/van/van-reconciliation.service.js';
import { partners, type VanSeed } from './helpers/partners.js';
import { resetQueues, waitFor } from './helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'kim' };

/**
 * VAN 등록 n건(tid VT-…, 시리얼 VC-00001…). 우리 DB에는 이 단말기들이 없으므로 해지(CANCELLED)로 심는다 —
 * 그래야 어긋남이 아니라서 다음 Task의 비교·재검증(후보마다 VAN 단건 조회)이 이 파일의 호출 수·시간에 끼어들지 않는다.
 */
function vanRows(n: number): VanSeed[] {
  return Array.from({ length: n }, (_, i) => {
    const no = String(i + 1).padStart(5, '0');
    return { tid: `VT-${no}`, serialNo: `VC-${no}`, merchantCode: i % 2 ? 'YEOKSAM-CAFE' : 'GANGNAM-KIMBAP', status: 'CANCELLED' };
  });
}

describe('VAN 등록 대조 — 실행·커서 수집·스테이징 (F9)', () => {
  let t: TestApp;
  let svc: VanReconciliationService;
  const em = () => t.orm.em.fork();
  const snapshotCount = (runId: number) => em().count(VanRegistrationSnapshot, { runId });

  beforeAll(async () => {
    // 워커를 띄운다: POST가 넣은 job을 report 큐 프로세서가 처리하는지까지 본다. 다른 테스트는 서비스를 직접 부른다.
    t = await createTestApp({ workers: true });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    svc = t.app.get(VanReconciliationService);
  });
  beforeEach(async () => {
    await partners.reset();
    // 이전 테스트가 남긴 RUNNING을 정리(한 번에 하나 규칙 때문에)
    await em().nativeUpdate(VanReconciliationRun, { status: VanRunStatus.RUNNING }, { status: VanRunStatus.FAILED });
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it('커서로 모든 페이지를 받아 페이지마다 스테이징에 넣고, 실행 행에 페이지·건수·걸린 시간을 남긴다', async () => {
    await partners.seedVan(vanRows(1234));
    const run = await svc.start(VanRunTrigger.MANUAL, 'kim');
    expect(run.status).toBe(VanRunStatus.RUNNING);
    const done = await svc.execute(run.id);
    expect(done).toMatchObject({ status: VanRunStatus.COMPLETED, pages: 3, fetched: 1234, retries: 0, error: null });
    expect(done.phaseMs?.collect).toEqual(expect.any(Number));
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect(await snapshotCount(run.id)).toBe(1234);
    const one = await em().findOneOrFail(VanRegistrationSnapshot, { runId: run.id, serialNo: 'VC-00002' });
    expect(one).toMatchObject({ tid: 'VT-00002', merchantCode: 'YEOKSAM-CAFE', status: 'CANCELLED' });
    expect(one.vanUpdatedAt).toBeInstanceOf(Date);
    expect((await partners.stats()).calls['bridgevan.list']).toBe(3); // 페이지 500 × 3(마지막 234)
  });

  it('429는 그 페이지만 Retry-After 뒤에 다시 부르고 끝까지 모은다(실행 행 retries = 429 수)', async () => {
    await partners.seedVan(vanRows(1100));
    // 시드 3이면 첫 페이지·둘째 페이지에서 한 번씩 429(시드 난수, 재현 가능). Retry-After 0초 → 기본 간격 500ms
    await partners.configure({ seed: 3, bridgevan: { force429Rate: 0.4, retryAfterSec: 0 } });
    const run = await svc.start(VanRunTrigger.MANUAL, 'kim');
    const done = await svc.execute(run.id);
    const stats = await partners.stats();
    console.log(`[VAN 429] pages=${done.pages} retries=${done.retries} 429=${stats.status429} calls=${stats.calls['bridgevan.list']}`);
    expect(done).toMatchObject({ status: VanRunStatus.COMPLETED, pages: 3, fetched: 1100 });
    expect(done.retries).toBe(2);
    expect(stats.status429).toBe(2);
    expect(stats.calls['bridgevan.list']).toBe(5);
    expect(await snapshotCount(run.id)).toBe(1100);
  });

  it('5xx가 계속되면 페이지마다 5번까지만 부르고 실행을 FAILED(이유)로 남긴다(던지지 않는다)', async () => {
    await partners.seedVan(vanRows(10));
    await partners.configure({ bridgevan: { error5xxRate: 1 } });
    const run = await svc.start(VanRunTrigger.MANUAL, 'kim');
    const failed = await svc.execute(run.id);
    expect(failed.status).toBe(VanRunStatus.FAILED);
    expect(failed.error).toMatch(/PartnerTransientError: 브릿지VAN 목록 응답 503/);
    expect((await partners.stats()).calls['bridgevan.list']).toBe(5);
  }, 20_000);

  it('같은 실행을 다시 돌리면(멈춘 job 재시도) 스테이징을 지우고 처음부터 모은다', async () => {
    await partners.seedVan(vanRows(30));
    const run = await svc.start(VanRunTrigger.MANUAL, 'kim');
    await svc.execute(run.id);
    await em().insert(VanRegistrationSnapshot, { runId: run.id, serialNo: 'LEFTOVER', tid: 'X', merchantCode: 'X', status: VanStatus.CANCELLED, vanUpdatedAt: new Date() });
    expect(await snapshotCount(run.id)).toBe(31);
    expect(await svc.collect(run.id)).toEqual({ pages: 1, fetched: 30, retries: 0 });
    expect(await snapshotCount(run.id)).toBe(30);
    expect(await svc.deleteSnapshot(run.id)).toBe(30);
  });

  it('진행 중인 실행은 하나만: 두 번째 시작은 409 VAN_RECONCILIATION_RUNNING, 끝나면 다시 시작할 수 있다', async () => {
    const first = await svc.start(VanRunTrigger.MANUAL, 'kim');
    await expect(svc.start(VanRunTrigger.SCHEDULED, 'system:van-reconcile')).rejects.toMatchObject({ status: 409, code: 'VAN_RECONCILIATION_RUNNING' });
    await expect(svc.start(VanRunTrigger.MANUAL, 'kim')).rejects.toBeInstanceOf(BusinessError);
    await partners.seedVan(vanRows(3));
    await svc.execute(first.id);
    const second = await svc.start(VanRunTrigger.MANUAL, 'kim');
    expect(second.id).toBeGreaterThan(first.id);
    await svc.execute(second.id);
  });

  it('너무 오래 RUNNING인 실행(프로세스가 죽음)은 다음 시작이 FAILED로 바꾸고 새로 시작한다', async () => {
    const old = await svc.start(VanRunTrigger.MANUAL, 'kim', new Date(Date.now() - 2 * 3_600_000));
    const fresh = await svc.start(VanRunTrigger.MANUAL, 'kim');
    const stale = await em().findOneOrFail(VanReconciliationRun, old.id);
    expect(stale.status).toBe(VanRunStatus.FAILED);
    expect(stale.error).toMatch(/멈춘 실행/);
    expect(fresh.status).toBe(VanRunStatus.RUNNING);
    await partners.seedVan(vanRows(1));
    await svc.execute(fresh.id);
  });

  it('POST /van-reconciliations는 202로 실행 행을 주고 report 큐 워커가 끝낸다. 진행 중에 다시 POST하면 409', async () => {
    await partners.seedVan(vanRows(1200));
    await partners.configure({ bridgevan: { delayMs: 300 } }); // 페이지 3개 × 0.3초: 두 번째 POST가 진행 중에 들어간다
    const res = await t.http().post('/van-reconciliations').set(OP);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'RUNNING', trigger: 'MANUAL', requestedBy: 'kim', pages: 0 });
    const again = await t.http().post('/van-reconciliations').set(OP);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('VAN_RECONCILIATION_RUNNING');
    const done = await waitFor(async () => {
      const r = await t.http().get(`/van-reconciliations/${res.body.id}`);
      return r.body.status === 'COMPLETED' ? r.body : null;
    });
    expect(done).toMatchObject({ pages: 3, fetched: 1200, error: null });
    expect((await t.http().get('/van-reconciliations/999999')).status).toBe(404);
    expect((await t.http().post('/van-reconciliations')).status).toBe(400); // 작업자 헤더 없음
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit/partner-retry.spec.ts test/van-collect.e2e.spec.ts`
Expected: 두 파일 모두 로드 실패 — `Error: Cannot find module '../../src/common/partner-retry.js'`, `Error: Cannot find module '../src/van/van.entities.js'`, `Test Files 2 failed (2)`.

- [ ] **Step 3: 구현**

`apps/api/src/common/partner-retry.ts`(새):
```ts
import { PartnerRateLimitedError, PartnerTransientError, type PartnerError } from './partner-errors.js';

/** 재시도 기본 간격(ms). 택배 추적 job의 'carrier' 백오프와 같은 값이다(decisions/0014) */
export const PARTNER_RETRY_BASE_MS = 500;

/**
 * 다음 시도까지 기다릴 시간. 429면 업체가 알려 준 Retry-After(기본 간격보다 짧으면 기본 간격),
 * 그 밖에는 기본 간격 × 2^(시도-1) (500ms·1s·2s·4s…). 택배 추적 job(BullMQ backoffStrategy)과 한 job 안의 재시도가 같은 규칙을 쓴다.
 * @param attempt 방금 실패한 시도 번호(1부터)
 */
export function partnerBackoffMs(attempt: number, error?: Error, baseMs = PARTNER_RETRY_BASE_MS): number {
  if (error instanceof PartnerRateLimitedError) return Math.max(error.retryAfterMs, baseMs);
  return baseMs * 2 ** (attempt - 1);
}

export interface PartnerRetryOptions {
  /** 최대 시도 횟수(첫 시도 포함) */
  attempts: number;
  baseMs?: number;
  /** 테스트에서 기다리지 않게 바꾼다 */
  sleep?: (ms: number) => Promise<void>;
  /** 다시 하기 직전에 부른다(재시도 수 세기·로그) */
  onRetry?: (error: PartnerError, attempt: number, delayMs: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 외부 업체 호출을 한 job 안에서 다시 한다. 429·5xx·타임아웃(PartnerRateLimitedError·PartnerTransientError)만 다시 하고,
 * 영구 오류(4xx·형식 오류)와 그 밖의 오류는 바로 던진다. VAN 목록처럼 수백 페이지를 이어 받는 작업은 페이지 하나가 실패했다고
 * job 전체를 처음부터 다시 하면 안 되므로 BullMQ 재시도 대신 이것을 쓴다(decisions/0033).
 */
export async function withPartnerRetry<T>(fn: () => Promise<T>, opts: PartnerRetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const retryable = error instanceof PartnerRateLimitedError || error instanceof PartnerTransientError;
      if (!retryable || attempt >= opts.attempts) throw error;
      const delayMs = partnerBackoffMs(attempt, error, opts.baseMs);
      opts.onRetry?.(error, attempt, delayMs);
      await (opts.sleep ?? defaultSleep)(delayMs);
    }
  }
}
```

`apps/api/src/carrier-sync/retry-policy.ts`:
```diff
--- a/apps/api/src/carrier-sync/retry-policy.ts
+++ b/apps/api/src/carrier-sync/retry-policy.ts
@@ -2,7 +2,8 @@ import { NotFoundException } from '@nestjs/common';
 import { NotFoundError } from '@mikro-orm/core';
 import { UnrecoverableError, type JobsOptions } from 'bullmq';
 import { InvalidTransitionError } from '../common/domain-errors.js';
-import { PartnerPermanentError, PartnerRateLimitedError } from '../common/partner-errors.js';
+import { PartnerPermanentError } from '../common/partner-errors.js';
+import { partnerBackoffMs } from '../common/partner-retry.js';
 
 /** 추적 job 기본 옵션. 완료·최종 실패한 job을 지워야 다음 sweep이 같은 jobId로 다시 넣을 수 있다(decisions/0013). */
 export const TRACK_JOB_OPTIONS: JobsOptions = {
@@ -12,15 +13,12 @@ export const TRACK_JOB_OPTIONS: JobsOptions = {
   removeOnFail: true,
 };
 
-const BASE_DELAY_MS = 500;
-
 /**
  * 'carrier' 백오프: 429면 택배사가 알려 준 Retry-After만큼, 그 밖에는 500ms·1s·2s·4s… 지수 백오프(decisions/0014).
- * Worker 옵션 settings.backoffStrategy로 등록한다.
+ * Worker 옵션 settings.backoffStrategy로 등록한다. 규칙은 한 job 안의 재시도(withPartnerRetry)와 같다(partnerBackoffMs).
  */
 export function carrierBackoff(attemptsMade: number, _type?: string, err?: Error): number {
-  if (err instanceof PartnerRateLimitedError) return Math.max(err.retryAfterMs, BASE_DELAY_MS);
-  return BASE_DELAY_MS * 2 ** (attemptsMade - 1);
+  return partnerBackoffMs(attemptsMade, err);
 }
 
 /**
```

`apps/api/src/config/env.ts`:
```diff
--- a/apps/api/src/config/env.ts
+++ b/apps/api/src/config/env.ts
@@ -81,6 +81,10 @@ export const env = {
   scanLockTtlMs: intFromEnv('SCAN_LOCK_TTL_MS', 30_000, MS),
   /** A/S 교체 단말기 예약(Redis) 유지 시간. 운송장 발급 + 교체 트랜잭션이 이보다 길면 예약이 풀린다(decisions/0026) */
   replacementLockTtlMs: intFromEnv('REPLACEMENT_LOCK_TTL_MS', 30_000, MS),
+  /** 브릿지VAN 등록 목록 한 페이지 크기(F9, decisions/0033) */
+  bridgevanPageSize: intFromEnv('BRIDGEVAN_PAGE_SIZE', 500, { min: 1, max: 1000 }),
+  /** 이보다 오래 RUNNING인 VAN 대조 실행은 멈춘 것(프로세스가 죽음)으로 보고, 새 실행을 시작할 때 FAILED로 바꾼다 */
+  vanRunStaleMs: intFromEnv('VAN_RUN_STALE_MS', 3_600_000, MS),
   /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
   workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
 };
```

`apps/api/src/queue/queue-names.ts`:
```diff
--- a/apps/api/src/queue/queue-names.ts
+++ b/apps/api/src/queue/queue-names.ts
@@ -6,6 +6,8 @@ export const QUEUE = {
   OUTBOX: 'outbox',
   /** 접속 상태·펌웨어 배포의 주기 작업과 active 갱신(decisions/0028) */
   DEVICE: 'device',
+  /** VAN 대조·이상 단말기 찾기·주간 리포트처럼 오래 걸리는 집계(device 큐와 나눔, experiments/0010, decisions/0033) */
+  REPORT: 'report',
 } as const;
 
 export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];
```

`apps/api/src/van/van.entities.ts`(새):
```ts
import { OptionalProps, PrimaryKeyProp } from '@mikro-orm/core';
import { Entity, Enum, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** 브릿지VAN(가상) 등록 상태 */
export enum VanStatus {
  ACTIVE = 'ACTIVE', // 결제 가능
  SUSPENDED = 'SUSPENDED', // VAN이 일시 정지
  CANCELLED = 'CANCELLED', // 해지
}

export enum VanRunStatus {
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum VanRunTrigger {
  MANUAL = 'MANUAL', // POST /van-reconciliations
  SCHEDULED = 'SCHEDULED', // 주기 작업(일 1회)
}

/** 단계별 걸린 시간(ms) */
export interface VanPhaseMs {
  collect?: number;
  compare?: number;
  reverify?: number;
}

/**
 * VAN 등록 대조 실행 한 번(F9). 진행 중(RUNNING)인 실행은 하나만 있을 수 있다 — MySQL에는 부분 unique가 없어
 * 생성 열 running_key(진행 중이면 1, 아니면 NULL)에 unique를 건다(decisions/0033).
 */
@Entity({ tableName: 'van_reconciliation_run' })
export class VanReconciliationRun {
  [OptionalProps]?: 'status' | 'finishedAt' | 'pages' | 'fetched' | 'retries' | 'candidates' | 'confirmed' | 'resolved' | 'counts' | 'phaseMs' | 'error';

  @PrimaryKey()
  id!: number;

  @Enum({ items: () => VanRunStatus })
  status: VanRunStatus = VanRunStatus.RUNNING;

  /**
   * 진행 중이면 1, 아니면 NULL인 생성 열 + unique: RUNNING 행은 하나만(NULL은 unique에서 서로 다르다, decisions/0033).
   * MikroORM의 부분 unique(where)는 이 열에서는 쓰지 않는다 — `status = 'RUNNING'` 같은 글자 상수가 든 함수 인덱스는 MySQL이
   * `(case when (`status` = _utf8mb4'RUNNING') …)`로 바꿔 저장해 db:migration:check가 늘 다르다고 했다(사전 검증). 앱은 이 열을 읽기만 한다(MikroORM은 생성 열을 INSERT·UPDATE에 넣지 않는다).
   */
  @Property({
    type: 'tinyint',
    nullable: true,
    generated: "(case when `status` = 'RUNNING' then 1 end) virtual",
    unique: 'van_reconciliation_run_running_unique',
  })
  runningKey?: number | null;

  @Enum({ items: () => VanRunTrigger })
  trigger!: VanRunTrigger;

  /** 작업자(수동) 또는 `system:van-reconcile`(주기) */
  @Property({ length: 50 })
  requestedBy!: string;

  @Property({ type: 'datetime', length: 3 })
  startedAt!: Date;

  @Property({ type: 'datetime', length: 3, nullable: true })
  finishedAt: Date | null = null;

  /** 받은 페이지 수와 등록 수 */
  @Property()
  pages: number = 0;

  @Property()
  fetched: number = 0;

  /** 429·5xx로 다시 부른 횟수(목록·재검증 합) */
  @Property()
  retries: number = 0;

  /** 집합 비교가 찾은 후보 수, 재검증 뒤에도 어긋난 수, 재검증에서 풀린 수 */
  @Property()
  candidates: number = 0;

  @Property()
  confirmed: number = 0;

  @Property()
  resolved: number = 0;

  /** 확정된 어긋남의 종류별 수 */
  @Property({ type: 'json', nullable: true })
  counts: Record<string, number> | null = null;

  @Property({ type: 'json', nullable: true })
  phaseMs: VanPhaseMs | null = null;

  @Property({ type: 'varchar', length: 500, nullable: true })
  error: string | null = null;
}

/**
 * VAN에서 받은 등록 목록의 스테이징(실행마다 한 벌). 우리 테이블과 SQL 집합 비교를 하려고 MySQL에 둔다(decisions/0033).
 * PK가 (run_id, serial_no)라 한 실행의 행이 클러스터 인덱스에 모여 있고, 정리는 `where run_id = ? limit n`(PK 범위)으로 한다.
 * 외래키를 두지 않는다 — 수만 행 INSERT가 실행 행에 FK 검사 S 락을 걸지 않게(Outbox·device_connectivity와 같은 이유).
 */
@Entity({ tableName: 'van_registration_snapshot' })
export class VanRegistrationSnapshot {
  [PrimaryKeyProp]?: ['runId', 'serialNo'];

  @PrimaryKey({ autoincrement: false })
  runId!: number;

  @PrimaryKey({ length: 32 })
  serialNo!: string;

  /** VAN 단말기 번호(참고값, 대조 키가 아님) */
  @Property({ length: 32 })
  tid!: string;

  @Property({ length: 40 })
  merchantCode!: string;

  @Enum({ items: () => VanStatus })
  status!: VanStatus;

  @Property({ type: 'datetime', length: 3 })
  vanUpdatedAt!: Date;
}
```

`apps/api/src/van/bridgevan.client.ts`(새):
```ts
import { PartnerPermanentError } from '../common/partner-errors.js';
import { partnerFetch } from '../common/partner-http.js';
import { VanStatus } from './van.entities.js';

export interface BridgevanOptions {
  baseUrl: string;
  timeoutMs: number;
}

/** 브릿지VAN이 주는 등록 한 건 */
export interface VanRegistrationDto {
  tid: string;
  serialNo: string;
  merchantCode: string;
  status: VanStatus;
  updatedAt: Date;
}

export interface VanPage {
  items: VanRegistrationDto[];
  nextCursor: string | null;
}

const STATUSES = new Set<string>(Object.values(VanStatus));

function parseItem(raw: unknown): VanRegistrationDto {
  const r = raw as Record<string, unknown> | null;
  const updatedAt = typeof r?.updatedAt === 'string' ? new Date(r.updatedAt) : null;
  if (
    !r ||
    typeof r.tid !== 'string' ||
    typeof r.serialNo !== 'string' ||
    typeof r.merchantCode !== 'string' ||
    typeof r.status !== 'string' ||
    !STATUSES.has(r.status) ||
    !updatedAt ||
    Number.isNaN(updatedAt.getTime())
  ) {
    throw new PartnerPermanentError(`브릿지VAN 등록 형식이 아닙니다: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  return { tid: r.tid, serialNo: r.serialNo, merchantCode: r.merchantCode, status: r.status as VanStatus, updatedAt };
}

function parsePage(text: string): VanPage {
  let body: { items?: unknown; nextCursor?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    throw new PartnerPermanentError('브릿지VAN 응답이 JSON이 아닙니다.');
  }
  if (!Array.isArray(body.items) || (body.nextCursor !== null && typeof body.nextCursor !== 'string')) {
    throw new PartnerPermanentError('브릿지VAN 목록 응답 형식이 아닙니다(items, nextCursor).');
  }
  return { items: body.items.map(parseItem), nextCursor: body.nextCursor };
}

/**
 * 브릿지VAN(가상) 등록 단말기 API. 목록은 커서 페이지(offset이 아님, decisions/0033).
 * 실패는 partnerFetch가 429·5xx·4xx로 나눠 던진다(재시도는 부르는 쪽이 withPartnerRetry로).
 */
export class BridgevanClient {
  constructor(private readonly opts: BridgevanOptions) {}

  /** 한 페이지. cursor가 null이면 처음부터 */
  async list(cursor: string | null, limit: number): Promise<VanPage> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set('cursor', cursor);
    return parsePage(await partnerFetch('브릿지VAN 목록', `${this.opts.baseUrl}/bridgevan/v1/terminals?${q}`, { method: 'GET' }, this.opts.timeoutMs));
  }

  /** 시리얼로 등록 한 건(재검증용). 없으면 null */
  async findBySerial(serialNo: string): Promise<VanRegistrationDto | null> {
    const q = new URLSearchParams({ serialNo });
    const page = parsePage(await partnerFetch('브릿지VAN 시리얼 조회', `${this.opts.baseUrl}/bridgevan/v1/terminals?${q}`, { method: 'GET' }, this.opts.timeoutMs));
    return page.items[0] ?? null;
  }
}
```

`apps/api/src/van/van-reconciliation.service.ts`(새):
```ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { EntityManager, UniqueConstraintViolationException, type QueryResult } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { withPartnerRetry } from '../common/partner-retry.js';
import { env } from '../config/env.js';
import { QUEUE } from '../queue/queue-names.js';
import { BridgevanClient } from './bridgevan.client.js';
import { VanReconciliationRun, VanRegistrationSnapshot, VanRunStatus, VanRunTrigger, type VanPhaseMs } from './van.entities.js';

/** 주기 실행의 작업자 이름(decisions/0001) */
export const VAN_SYSTEM_ACTOR = 'system:van-reconcile';

/** 페이지 하나·시리얼 하나를 다시 부르는 최대 횟수(첫 시도 포함) */
export const VAN_CALL_ATTEMPTS = 5;

/** 스냅샷 정리 DELETE 한 번의 행 수(한 문장이 오래 잠그지 않게) */
const SNAPSHOT_DELETE_BATCH = 5000;

/** 실행 job 옵션: 실패해도 BullMQ가 다시 돌리지 않는다(실행 행에 FAILED와 이유를 남기고, 다음 실행이 처음부터 한다) */
const RUN_JOB_OPTIONS = { attempts: 1, removeOnComplete: true, removeOnFail: 100 };

export interface VanRunJobData {
  runId: number;
}

const elapsed = (start: number) => Math.round(performance.now() - start);

/**
 * 브릿지VAN 등록 대조(F9, decisions/0033).
 * 1. start: 실행 행(RUNNING)을 만든다. 진행 중인 실행이 있으면 409(실행 행의 부분 unique).
 * 2. collect: 커서로 모든 페이지를 받아 페이지마다 스테이징(van_registration_snapshot)에 한 문장으로 넣는다.
 *    429·5xx는 그 페이지만 다시 부른다(Retry-After, withPartnerRetry). 외부 호출은 트랜잭션 밖이다.
 * 실행은 report 큐 job 하나가 처음부터 끝까지 한다(device 큐에 무거운 일을 넣지 않는다, experiments/0010).
 */
@Injectable()
export class VanReconciliationService {
  private readonly logger = new Logger(VanReconciliationService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly van: BridgevanClient,
    @InjectQueue(QUEUE.REPORT) private readonly queue: Queue,
  ) {}

  /** 실행 행을 만든다. 진행 중인 실행이 있으면 409 VAN_RECONCILIATION_RUNNING */
  async start(trigger: VanRunTrigger, actor: string, now = new Date()): Promise<VanReconciliationRun> {
    await this.failStale(now);
    const em = this.em.fork();
    const run = em.create(VanReconciliationRun, { trigger, requestedBy: actor, startedAt: now });
    try {
      await em.flush();
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new BusinessError(409, 'VAN_RECONCILIATION_RUNNING', '진행 중인 VAN 대조가 있습니다. 끝난 뒤 다시 요청하세요.');
      }
      throw error;
    }
    return run;
  }

  /** 수동 실행: 실행 행을 만들고 report 큐에 넣는다. 큐에 못 넣으면 그 실행을 FAILED로 남기고 던진다 */
  async request(actor: string): Promise<VanReconciliationRun> {
    const run = await this.start(VanRunTrigger.MANUAL, actor);
    try {
      await this.queue.add('van-reconcile', { runId: run.id } satisfies VanRunJobData, { ...RUN_JOB_OPTIONS, jobId: `van-run-${run.id}` });
    } catch (error) {
      await this.fail(run.id, error);
      throw error;
    }
    return run;
  }

  /** 주기 실행(job scheduler). 진행 중인 실행이 있으면 건너뛴다 */
  async runScheduled(): Promise<{ runId: number | null; skipped?: boolean }> {
    let run: VanReconciliationRun;
    try {
      run = await this.start(VanRunTrigger.SCHEDULED, VAN_SYSTEM_ACTOR);
    } catch (error) {
      if (error instanceof BusinessError && error.code === 'VAN_RECONCILIATION_RUNNING') return { runId: null, skipped: true };
      throw error;
    }
    await this.execute(run.id);
    return { runId: run.id };
  }

  /**
   * 실행 한 번을 끝까지 한다. 어디서 실패하든 실행 행을 FAILED(이유)로 남기고 행을 돌려준다(던지지 않는다 — job은 끝난다).
   * 같은 runId로 다시 불리면(멈춘 job을 BullMQ가 다시 돌림) 스테이징을 지우고 처음부터 한다.
   */
  async execute(runId: number): Promise<VanReconciliationRun> {
    const phaseMs: VanPhaseMs = {};
    try {
      let t = performance.now();
      const collected = await this.collect(runId);
      phaseMs.collect = elapsed(t);
      t = performance.now();
      await this.em.fork().nativeUpdate(
        VanReconciliationRun,
        { id: runId, status: VanRunStatus.RUNNING },
        { status: VanRunStatus.COMPLETED, finishedAt: new Date(), ...collected, phaseMs },
      );
    } catch (error) {
      this.logger.error(`VAN 대조 ${runId} 실패: ${error instanceof Error ? error.message : String(error)}`);
      await this.fail(runId, error);
    }
    return this.get(runId);
  }

  /**
   * 커서로 모든 페이지를 받아 스테이징에 넣는다. 페이지마다 INSERT 한 문장(자동 커밋) — 수집 전체를 한 트랜잭션으로 묶지 않는다
   * (외부 호출을 기다리는 동안 잠금을 쥐지 않게). 같은 시리얼이 두 번 오면 나중 값으로 덮는다.
   */
  async collect(runId: number): Promise<{ pages: number; fetched: number; retries: number }> {
    await this.deleteSnapshot(runId);
    const em = this.em.fork();
    let cursor: string | null = null;
    let pages = 0;
    let fetched = 0;
    let retries = 0;
    do {
      const page = await withPartnerRetry(() => this.van.list(cursor, env.bridgevanPageSize), {
        attempts: VAN_CALL_ATTEMPTS,
        onRetry: () => retries++,
      });
      if (page.items.length > 0) {
        await em
          .createQueryBuilder(VanRegistrationSnapshot)
          .insert(
            page.items.map((r) => ({ runId, serialNo: r.serialNo, tid: r.tid, merchantCode: r.merchantCode, status: r.status, vanUpdatedAt: r.updatedAt })),
          )
          .onConflict(['runId', 'serialNo'])
          .merge(['tid', 'merchantCode', 'status', 'vanUpdatedAt'])
          .execute();
      }
      pages++;
      fetched += page.items.length;
      cursor = page.nextCursor;
    } while (cursor);
    return { pages, fetched, retries };
  }

  /** 한 실행의 스테이징을 PK 범위(run_id)로 조금씩 지운다(자동 커밋 DELETE를 되풀이). @returns 지운 행 수 */
  async deleteSnapshot(runId: number): Promise<number> {
    const em = this.em.fork();
    let deleted = 0;
    for (;;) {
      const res = await em.execute<QueryResult>('delete from van_registration_snapshot where run_id = ? limit ?', [runId, SNAPSHOT_DELETE_BATCH], 'run');
      deleted += res.affectedRows;
      if (res.affectedRows < SNAPSHOT_DELETE_BATCH) return deleted;
    }
  }

  async get(id: number): Promise<VanReconciliationRun> {
    const run = await this.em.fork().findOne(VanReconciliationRun, id);
    if (!run) throw new NotFoundException(`VAN 대조 ${id}이(가) 없습니다.`);
    return run;
  }

  /** 실행 행을 FAILED로(아직 RUNNING일 때만) */
  private async fail(runId: number, error: unknown): Promise<void> {
    const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
    await this.em
      .fork()
      .nativeUpdate(VanReconciliationRun, { id: runId, status: VanRunStatus.RUNNING }, { status: VanRunStatus.FAILED, finishedAt: new Date(), error: message });
  }

  /** 너무 오래 RUNNING인 실행(프로세스가 죽어 끝나지 못함)을 FAILED로. 잠그지 않고 읽은 뒤 PK로 갱신한다(troubleshooting/0014) */
  private async failStale(now: Date): Promise<void> {
    const em = this.em.fork();
    const stale = await em.find(
      VanReconciliationRun,
      { status: VanRunStatus.RUNNING, startedAt: { $lt: new Date(now.getTime() - env.vanRunStaleMs) } },
      { fields: ['id'] },
    );
    if (stale.length === 0) return;
    await em.nativeUpdate(
      VanReconciliationRun,
      { id: { $in: stale.map((r) => r.id) }, status: VanRunStatus.RUNNING },
      { status: VanRunStatus.FAILED, finishedAt: now, error: `멈춘 실행: ${env.vanRunStaleMs}ms 넘게 끝나지 않음` },
    );
    this.logger.warn(`멈춘 VAN 대조 실행을 FAILED로: ${stale.map((r) => r.id).join(', ')}`);
  }
}

export function toVanRunView(run: VanReconciliationRun) {
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    requestedBy: run.requestedBy,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    pages: run.pages,
    fetched: run.fetched,
    retries: run.retries,
    candidates: run.candidates,
    confirmed: run.confirmed,
    resolved: run.resolved,
    counts: run.counts ?? {},
    phaseMs: run.phaseMs ?? {},
    error: run.error,
  };
}
```

`apps/api/src/van/van-reconciliation.controller.ts`(새):
```ts
import { Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { toVanRunView, VanReconciliationService } from './van-reconciliation.service.js';

/** VAN 등록 대조(F9). 실행은 report 큐에서 비동기로 돈다 — 요청은 실행 행만 만들고 202로 끝난다. */
@Controller('van-reconciliations')
export class VanReconciliationController {
  constructor(private readonly runs: VanReconciliationService) {}

  /** 수동 실행. 진행 중인 실행이 있으면 409 VAN_RECONCILIATION_RUNNING */
  @Post()
  @HttpCode(202)
  async start(@Operator() actor: string) {
    return toVanRunView(await this.runs.request(actor));
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    return toVanRunView(await this.runs.get(id));
  }
}
```

`apps/api/src/van/van.module.ts`(새):
```ts
import { Module } from '@nestjs/common';
import { env } from '../config/env.js';
import { BridgevanClient } from './bridgevan.client.js';
import { VanReconciliationController } from './van-reconciliation.controller.js';
import { VanReconciliationService } from './van-reconciliation.service.js';

/** VAN 등록 대조(F9): 브릿지VAN 클라이언트, 실행·스테이징·비교 */
@Module({
  controllers: [VanReconciliationController],
  providers: [
    VanReconciliationService,
    { provide: BridgevanClient, useFactory: () => new BridgevanClient({ baseUrl: env.partnersUrl, timeoutMs: env.partnerTimeoutMs }) },
  ],
  exports: [VanReconciliationService],
})
export class VanModule {}
```

`apps/api/src/report/report.processor.ts`(새):
```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { QUEUE } from '../queue/queue-names.js';
import { toVanRunView, VanReconciliationService, type VanRunJobData } from '../van/van-reconciliation.service.js';

/**
 * report 큐: 오래 걸리는 집계 job(VAN 대조, 다음 Task의 이상 단말기 찾기·주간 리포트). device 큐(concurrency 1, 짧은 job)와 나눠
 * 무거운 일이 active 갱신·오프라인 판정을 막지 않게 한다(experiments/0010). 이 큐도 concurrency 1 — 집계끼리는 겹치지 않는다.
 */
@Processor(QUEUE.REPORT, { concurrency: 1 })
export class ReportProcessor extends WorkerHost {
  constructor(private readonly van: VanReconciliationService) {
    super();
  }

  async process(job: Job) {
    switch (job.name) {
      case 'van-reconcile': {
        const runId = (job.data as Partial<VanRunJobData>).runId;
        if (typeof runId !== 'number') throw new UnrecoverableError(`van-reconcile: runId가 없습니다: ${JSON.stringify(job.data)}`);
        const run = toVanRunView(await this.van.execute(runId));
        return { runId, status: run.status, confirmed: run.confirmed };
      }
      case 'van-reconcile-scheduled':
        return this.van.runScheduled();
      default:
        throw new UnrecoverableError(`모르는 report job: ${job.name}`);
    }
  }
}
```

`apps/api/src/workers/workers.module.ts`, `apps/api/src/app.module.ts`, `apps/api/src/entities.ts`:
```diff
--- a/apps/api/src/workers/workers.module.ts
+++ b/apps/api/src/workers/workers.module.ts
@@ -10,10 +10,12 @@ import { DeviceProcessor } from '../device/device.processor.js';
 import { FirmwareModule } from '../firmware/firmware.module.js';
 import { OutboxModule } from '../outbox/outbox.module.js';
 import { OutboxProcessor } from '../outbox/outbox.processor.js';
+import { ReportProcessor } from '../report/report.processor.js';
+import { VanModule } from '../van/van.module.js';
 
 /** 큐 job을 처리하는 프로세서들. RUN_WORKERS=1인 프로세스에만 넣는다(decisions/0015). */
 @Module({
-  imports: [CarrierSyncModule, OutboxModule, DeviceModule, FirmwareModule],
-  providers: [BungaeTrackProcessor, NeurimboTrackProcessor, CarrierSweepProcessor, OutboxProcessor, DeviceProcessor],
+  imports: [CarrierSyncModule, OutboxModule, DeviceModule, FirmwareModule, VanModule],
+  providers: [BungaeTrackProcessor, NeurimboTrackProcessor, CarrierSweepProcessor, OutboxProcessor, DeviceProcessor, ReportProcessor],
 })
 export class WorkersModule {}
```
```diff
--- a/apps/api/src/app.module.ts
+++ b/apps/api/src/app.module.ts
@@ -17,6 +17,7 @@ import { ScanModule } from './scan/scan.module.js';
 import { ServiceModule } from './service/service.module.js';
 import { DeviceModule } from './device/device.module.js';
 import { FirmwareModule } from './firmware/firmware.module.js';
+import { VanModule } from './van/van.module.js';
 import { WorkersModule } from './workers/workers.module.js';
 import { SchedulerModule } from './scheduler/scheduler.module.js';
 
@@ -44,6 +45,7 @@ export interface AppOptions {
     ServiceModule,
     DeviceModule,
     FirmwareModule,
+    VanModule,
   ],
   controllers: [HealthController],
   providers: [
```
```diff
--- a/apps/api/src/entities.ts
+++ b/apps/api/src/entities.ts
@@ -11,6 +11,7 @@ import { ScanBatch } from './scan/scan-batch.entity.js';
 import { ServiceTicket } from './service/service-ticket.entity.js';
 import { DeviceConnectivity } from './device/device-connectivity.entity.js';
 import { Firmware, FirmwareRollout, FirmwareRolloutTarget } from './firmware/firmware.entities.js';
+import { VanReconciliationRun, VanRegistrationSnapshot } from './van/van.entities.js';
 
 /** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
-export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch, ServiceTicket, DeviceConnectivity, Firmware, FirmwareRollout, FirmwareRolloutTarget];
+export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch, ServiceTicket, DeviceConnectivity, Firmware, FirmwareRollout, FirmwareRolloutTarget, VanReconciliationRun, VanRegistrationSnapshot];
```

`.env.example` 끝에 덧붙인다:
```
# Day 5: 브릿지VAN 등록 대조(F9) — decisions/0033
BRIDGEVAN_PAGE_SIZE=500
VAN_RUN_STALE_MS=3600000
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/unit/partner-retry.spec.ts test/unit/retry-policy.spec.ts test/van-collect.e2e.spec.ts --silent=false 2>&1 | grep -E "VAN 429|Tests "`
Expected: `[VAN 429] pages=3 retries=2 429=2 calls=5`(시드 3이 첫 페이지·둘째 페이지에서 한 번씩 429), `Tests  12 passed (12)`. 5xx 테스트는 500ms·1s·2s·4s를 실제로 기다려 약 7.5초 걸린다. 로그에 `ERROR [VanReconciliationService] VAN 대조 n 실패: 브릿지VAN 목록 응답 503`이 한 번 찍히는 것은 그 테스트의 예상 동작이다.

- [ ] **Step 5: 마이그레이션**

Run: `npm run db:migration:create`
Expected: `생성: Migration<시각>.ts`, up()은 다음과 같다(down은 두 테이블 drop). `running_key` 생성 열이 create table 안에 들어가고 unique가 그 열에 걸린다:
```ts
import { Migration } from '@mikro-orm/migrations';

export class Migration20261026012815 extends Migration {

  override name = 'Migration20261026012815';

  override up(): void | Promise<void> {
    this.addSql(`create table \`van_reconciliation_run\` (\`id\` int unsigned not null auto_increment primary key, \`status\` enum('RUNNING','COMPLETED','FAILED') not null default 'RUNNING', \`running_key\` tinyint generated always as (case when \`status\` = 'RUNNING' then 1 end) virtual null, \`trigger\` enum('MANUAL','SCHEDULED') not null, \`requested_by\` varchar(50) not null, \`started_at\` datetime(3) not null, \`finished_at\` datetime(3) null, \`pages\` int not null default 0, \`fetched\` int not null default 0, \`retries\` int not null default 0, \`candidates\` int not null default 0, \`confirmed\` int not null default 0, \`resolved\` int not null default 0, \`counts\` json null, \`phase_ms\` json null, \`error\` varchar(500) null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`van_reconciliation_run\` add unique \`van_reconciliation_run_running_unique\` (\`running_key\`);`);

    this.addSql(`create table \`van_registration_snapshot\` (\`run_id\` int unsigned not null, \`serial_no\` varchar(32) not null, \`tid\` varchar(32) not null, \`merchant_code\` varchar(40) not null, \`status\` enum('ACTIVE','SUSPENDED','CANCELLED') not null, \`van_updated_at\` datetime(3) not null, primary key (\`run_id\`, \`serial_no\`)) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`van_reconciliation_run\`;`);
    this.addSql(`drop table if exists \`van_registration_snapshot\`;`);
  }

}
```

그리고:
```bash
npm run db:migrate
npm run db:migration:check
npx vitest run && npm run typecheck
```
Expected: `적용: Migration<시각>`, `최신 상태`, `Test Files  43 passed (43)`, `Tests  287 passed (287)`, typecheck exit 0.

- [ ] **Step 6: 기록과 커밋**

devlog에 `## HH:MM Task 3 VAN 대조 실행과 수집 — 커서 수집·스테이징·한 job 안의 재시도·report 큐 (F9)` 항목(429 로그 줄, 마이그레이션 이름).

`docs/decisions/0033-VAN-등록-대조는-커서-수집-스테이징-SQL-비교-재검증.md`(이 Task 몫):
- 날짜 / 관련 기능: 2026-10-26 / F9
- 상황: 브릿지VAN이 들고 있는 등록 목록(수만 건)을 우리 DB와 맞춰 봐야 한다. 목록은 페이지 API로만 받을 수 있고, 받는 동안에도 VAN 쪽이 바뀐다.
- 페이지 방식: 1) offset/limit — 페이지 사이 앞쪽에 등록이 생기면 다음 페이지가 밀려 같은 등록을 두 번 받고, 지워지면 하나를 건너뛴다. 2) **커서(키셋, 마지막 tid 다음부터)** — 앞쪽 변경에 밀리지 않는다(partners 테스트 "앞에 하나 생겨도 VT-0011부터"). 지나간 자리에 생긴 등록은 이번 스캔에 없고 다음 스캔이 본다. → 2. 커서는 불투명 글자로 받아 그대로 돌려준다.
- 어디서 비교하나: 1) 메모리(앱이 목록과 우리 단말기를 다 들고 비교) — 5만 행 두 벌을 앱에 올린다. 2) JSON_TABLE(F10처럼 JSON 한 덩어리를 SQL로 펼침) — 수만 건 한 문장 파라미터가 커지고 페이지마다 나눠 넣을 수 없다. 3) **MySQL 스테이징 테이블 + SQL 집합 비교** — 페이지마다 한 문장씩 쌓고, 비교는 인덱스(PK (run_id, serial_no), terminal.serial_no unique)를 탄다. 실행계획은 0011, 시간은 0012. → 3.
- 스테이징 설계: PK (run_id, serial_no)(한 실행의 행이 클러스터 인덱스에 모임), FK 없음(수만 행 INSERT가 실행 행에 S 락을 걸지 않게), 정리는 `where run_id = ? limit 5000` 반복(PK 앞부분 범위라 보조 인덱스 gap 락 걱정이 없음, troubleshooting/0014), 한 실행 안에서 같은 시리얼이 두 번 오면 나중 값.
- 재시도: 1) BullMQ job 재시도 — 수백 페이지 중 하나가 실패하면 처음부터. 2) **호출마다 `withPartnerRetry`(5번, 429 Retry-After, 그 밖 지수 백오프)** — 그 페이지만. 다 써도 실패면 실행 FAILED(이유)로 남기고 job은 끝낸다(attempts 1). 규칙은 택배 추적과 같은 `partnerBackoffMs`(decisions/0014).
- 진행 중 실행은 하나: 1) Redis 잠금 — 실행이 수 분이라 TTL을 정하기 어렵고, 잠금이 사라져도 DB에는 RUNNING이 남는다. 2) **실행 행의 unique(생성 열 running_key)** — 상태가 DB 한 곳에 있다. MikroORM 부분 unique(`where: { status: 'RUNNING' }`)는 MySQL이 식에 `_utf8mb4` 글자 집합을 붙여 저장해 `db:migration:check`가 늘 다르다고 해서(사전 검증) 생성 열로 했다. 3) 멈춘 실행: 워커가 죽으면 RUNNING이 남는다 → 다음 시작이 VAN_RUN_STALE_MS(1시간) 넘은 것을 FAILED로.
- 큐: report 큐를 새로 만든다(concurrency 1). device 큐(짧은 job, active 갱신·판정)에 수 초~수 분짜리 일을 넣지 않는다(experiments/0010의 줄서기).
- 결과·대가: 실행 하나가 끝날 때까지 다음 실행(수동·주기)은 409·건너뜀. 수집은 자동 커밋이라 수집 도중의 스테이징은 반쪽일 수 있다(같은 실행을 다시 하면 지우고 처음부터).
- 다시 볼 조건: 등록이 수십만 건이 되어 수집이 길어질 때(페이지 크기·동시 페이지), VAN이 스냅샷 커서(일관된 시점)를 줄 때.

`docs/decisions/0014-배송-완료-반영-규칙과-재시도.md` 끝에 한 줄:
```
- 갱신(2026-10-26 Day 5): 재시도 간격 규칙(429 Retry-After 최소 500ms, 그 밖 500ms·1s·2s…)을 `common/partner-retry.ts`의 `partnerBackoffMs`로 옮겼다. 택배 추적 job의 `carrierBackoff`와 한 job 안의 재시도(`withPartnerRetry`, VAN 목록·톡톡 첨부)가 같은 함수를 쓴다.
```

`docs/decisions/0013-BullMQ-큐-구성과-Redis를-쓰는-이유.md` 끝에 한 줄:
```
- 갱신(2026-10-26 Day 5): report 큐를 더했다(VAN 대조, Task 6의 이상 찾기, Task 8의 주간 리포트). concurrency 1, 실행 job은 attempts 1(재시도는 호출마다). device 큐에 무거운 집계를 넣지 않으려고 나눴다(experiments/0010).
```

`docs/study/backlog.md`에 추가:
```
- [ ] 커서(키셋) 페이지네이션과 offset의 중복·누락, 안정적인 정렬 키 (decisions/0033, apps/partners/src/bridgevan.ts)
- [ ] MySQL 생성 열(virtual·stored)과 함수 인덱스, NULL이 unique에서 서로 다른 것 — 부분 unique 흉내 (decisions/0033)
```

커밋:
```bash
git add apps/api docs .env.example
git commit -m "feat(F9): VAN 대조 실행과 커서 수집·스테이징, 한 job 안의 재시도, report 큐" -m "Refs: docs/decisions/0033-VAN-등록-대조는-커서-수집-스테이징-SQL-비교-재검증.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: VAN 대조 비교·재검증·결과 — SQL 집합 비교, classify, 재검증, 결과 행, 요약 알림, 스테이징 정리, 결과 API (F9, F5)

**Files:**
- Create: `apps/api/src/van/van-compare.ts`, `apps/api/src/van/dto/van-items.query.ts`, `apps/api/src/migrations/Migration<시각>.ts`(생성)
- Modify: `apps/api/src/van/van.entities.ts`, `apps/api/src/van/van-reconciliation.service.ts`, `apps/api/src/van/van-reconciliation.controller.ts`, `apps/api/src/outbox/outbox-event.entity.ts`, `apps/api/src/outbox/outbox.service.ts`, `apps/api/src/config/env.ts`, `apps/api/src/entities.ts`, `.env.example`
- Test: `apps/api/test/helpers/terminals.ts`(새), `apps/api/test/unit/van-compare.spec.ts`(새), `apps/api/test/van-reconciliation.e2e.spec.ts`(새), `apps/api/test/unit/outbox-text.spec.ts`
- Record: `docs/devlog/2026-10-26.md`, `docs/decisions/0033-…`(보탬), `docs/decisions/0016-…`(갱신 한 줄)

바꾸는 것 요약:
- `classify(our, van)`: 어긋남 종류(스펙 4.1 표). 비교와 재검증이 같은 함수를 쓴다.
- `compare(runId)`: 한 RR 읽기 전용 트랜잭션에서 두 문장(우리 운영 중 기준 LEFT JOIN 스테이징, VAN ACTIVE 기준 LEFT JOIN terminal)으로 어긋난 행만 거르고 classify로 종류를 정한다. 시리얼 순.
- `reverify(candidates)`: 100개씩 — VAN 시리얼 조회(동시 `VAN_REVERIFY_CONCURRENCY`=8, withPartnerRetry) + 우리 쪽 한 문장. 여전히 어긋나면 verified=true(지금 값), 풀렸으면 verified=false(비교 때 값).
- `finish`: 한 트랜잭션 — 실행 행 UPDATE(RUNNING → COMPLETED, 요약; 0행이면 던짐) → 결과 INSERT(500행씩) → Outbox `van.reconciliation_completed` 1행(어긋남 수와 상관없이). 그 뒤 `cleanupSnapshots`가 이번보다 앞선 실행의 스테이징을 지운다.
- `GET /van-reconciliations/:id?kind=&verified=&afterId=&limit=`: 요약 + 결과 한 페이지(키셋), `nextAfterId`.
- 알림 문구: `[단말온] VAN 등록 대조 #7: 어긋남 1000건(미등록 400, 운영 아님 0, 가맹점 다름 600, 정지 0), 재검증으로 풀림 3건, VAN 등록 50000건`.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/helpers/terminals.ts`(새):
```ts
import { Merchant } from '../../src/merchant/merchant.entity.js';
import { TerminalModel } from '../../src/terminal/terminal-model.entity.js';
import { Terminal } from '../../src/terminal/terminal.entity.js';
import type { TerminalStatus } from '../../src/terminal/terminal-status.js';
import type { TestApp } from './test-app.js';

export interface TerminalSeed {
  serialNo: string;
  status: TerminalStatus;
  /** 없으면 가맹점 없음(null) */
  merchantCode?: string | null;
  /** 기본 SN-100 */
  modelCode?: string;
}

/**
 * 테스트 준비용: 상태·가맹점을 정한 단말기를 API를 거치지 않고 INSERT로 넣는다(전이 서비스·이력·Outbox 없음).
 * 대조·이상 단말기 테스트는 "이미 이런 상태인 단말기"가 필요할 뿐이다. 운영 코드에서는 쓰지 않는다.
 * @returns 시리얼 → terminal.id
 */
export async function insertTerminals(t: TestApp, rows: TerminalSeed[]): Promise<Map<string, number>> {
  const em = t.orm.em.fork();
  const models = new Map((await em.find(TerminalModel, {})).map((m) => [m.code, m.id]));
  const merchants = new Map((await em.find(Merchant, {})).map((m) => [m.code, m.id]));
  const now = new Date();
  for (let i = 0; i < rows.length; i += 1000) {
    await em.insertMany(
      Terminal,
      rows.slice(i, i + 1000).map((r) => ({
        serialNo: r.serialNo,
        model: models.get(r.modelCode ?? 'SN-100')!,
        merchant: r.merchantCode ? merchants.get(r.merchantCode)! : null,
        status: r.status,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }
  const saved = await em.find(Terminal, { serialNo: { $in: rows.map((r) => r.serialNo) } }, { fields: ['id', 'serialNo'] });
  return new Map(saved.map((s) => [s.serialNo, s.id]));
}
```

`apps/api/test/unit/van-compare.spec.ts`(새):
```ts
import { describe, expect, it } from 'vitest';
import { TerminalStatus } from '../../src/terminal/terminal-status.js';
import { classify, ourValueOf, vanValueOf } from '../../src/van/van-compare.js';
import { VanMismatchKind as K, VanStatus } from '../../src/van/van.entities.js';

const our = (status: TerminalStatus, merchantCode: string | null = 'GANGNAM-KIMBAP') => ({ status, merchantCode });
const van = (status: VanStatus, merchantCode = 'GANGNAM-KIMBAP') => ({ status, merchantCode });

describe('VAN 대조 종류 정하기(classify, decisions/0033)', () => {
  it.each([
    ['운영 중 + VAN 없음', our(TerminalStatus.IN_SERVICE), null, K.NOT_REGISTERED],
    ['운영 중 + VAN 해지', our(TerminalStatus.IN_SERVICE), van(VanStatus.CANCELLED), K.NOT_REGISTERED],
    ['운영 중 + VAN 정지', our(TerminalStatus.IN_SERVICE), van(VanStatus.SUSPENDED), K.SUSPENDED_WHILE_IN_SERVICE],
    ['운영 중 + VAN 활성, 가맹점 다름', our(TerminalStatus.IN_SERVICE), van(VanStatus.ACTIVE, 'YEOKSAM-CAFE'), K.MERCHANT_MISMATCH],
    ['운영 중인데 우리 가맹점 없음 + VAN 활성', our(TerminalStatus.IN_SERVICE, null), van(VanStatus.ACTIVE), K.MERCHANT_MISMATCH],
    ['운영 중 + VAN 활성, 가맹점 같음', our(TerminalStatus.IN_SERVICE), van(VanStatus.ACTIVE), null],
    ['회수됨 + VAN 활성', our(TerminalStatus.RETURNED), van(VanStatus.ACTIVE), K.REGISTERED_BUT_NOT_IN_SERVICE],
    ['우리 DB에 없음 + VAN 활성', null, van(VanStatus.ACTIVE), K.REGISTERED_BUT_NOT_IN_SERVICE],
    ['폐기 + VAN 해지', our(TerminalStatus.DISPOSED), van(VanStatus.CANCELLED), null],
    ['회수됨 + VAN 정지', our(TerminalStatus.RETURNED), van(VanStatus.SUSPENDED), null],
    ['재고 + VAN 없음', our(TerminalStatus.IN_STOCK), null, null],
  ])('%s → %s', (_name, o, v, expected) => {
    expect(classify(o, v)).toBe(expected);
  });

  it('값 표시: 상태 / 가맹점, 없으면 그렇다고 적는다', () => {
    expect(ourValueOf(our(TerminalStatus.IN_SERVICE, null))).toBe('IN_SERVICE / 가맹점 없음');
    expect(ourValueOf(null)).toBe('우리 DB에 없음');
    expect(vanValueOf(van(VanStatus.SUSPENDED))).toBe('SUSPENDED / GANGNAM-KIMBAP');
    expect(vanValueOf(null)).toBe('VAN에 없음');
  });
});
```

`apps/api/test/unit/outbox-text.spec.ts`(describe 끝에 테스트 하나):
```diff
--- a/apps/api/test/unit/outbox-text.spec.ts
+++ b/apps/api/test/unit/outbox-text.spec.ts
@@ -38,4 +38,11 @@ describe('알림 문구(textOf)', () => {
       '[단말온] 펌웨어 배포 #3 2.0.0: 중단 (운영자 중단: han)',
     );
   });
+
+  it('VAN 대조 요약은 실행 번호, 종류별 어긋남(없는 종류는 0), 재검증으로 풀린 수, VAN 등록 수 (decisions/0033)', () => {
+    const payload = { runId: 7, fetched: 50000, candidates: 1003, confirmed: 1000, resolved: 3, counts: { NOT_REGISTERED: 400, MERCHANT_MISMATCH: 600 } };
+    expect(textOf({ type: 'van.reconciliation_completed', payload })).toBe(
+      '[단말온] VAN 등록 대조 #7: 어긋남 1000건(미등록 400, 운영 아님 0, 가맹점 다름 600, 정지 0), 재검증으로 풀림 3건, VAN 등록 50000건',
+    );
+  });
 });
```

`apps/api/test/van-reconciliation.e2e.spec.ts`(새):
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { OutboxEvent } from '../src/outbox/outbox-event.entity.js';
import { TerminalStatus as S } from '../src/terminal/terminal-status.js';
import { VanReconciliationItem, VanRegistrationSnapshot, VanRunStatus, VanRunTrigger } from '../src/van/van.entities.js';
import { VanReconciliationService } from '../src/van/van-reconciliation.service.js';
import { partners, type VanSeed } from './helpers/partners.js';
import { insertTerminals } from './helpers/terminals.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const G = 'GANGNAM-KIMBAP';
const Y = 'YEOKSAM-CAFE';
const reg = (tid: string, serialNo: string, status: VanSeed['status'], merchantCode = G, healTo?: VanSeed['healTo']): VanSeed => ({
  tid,
  serialNo,
  merchantCode,
  status,
  ...(healTo ? { healTo } : {}),
});

describe('VAN 등록 대조 — 집합 비교·재검증·결과·알림·스테이징 정리 (F9)', () => {
  let t: TestApp;
  let svc: VanReconciliationService;
  const em = () => t.orm.em.fork();
  const pageSize = env.bridgevanPageSize;
  const run = async () => svc.execute((await svc.start(VanRunTrigger.MANUAL, 'kim')).id);
  const items = (runId: number) => em().find(VanReconciliationItem, { run: runId }, { orderBy: { id: 'asc' } });

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    svc = t.app.get(VanReconciliationService);
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    env.bridgevanPageSize = pageSize;
    await t.app.close();
  });

  it('네 종류의 어긋남을 찾고 어긋나지 않은 것은 남기지 않는다. 결과는 시리얼 순, 요약 알림은 1행', async () => {
    await insertTerminals(t, [
      ...Array.from({ length: 10 }, (_, i) => ({ serialNo: `VR-${String(i + 1).padStart(3, '0')}`, status: S.IN_SERVICE, merchantCode: G })),
      { serialNo: 'VR-011', status: S.IN_SERVICE, merchantCode: G }, // VAN 없음
      { serialNo: 'VR-012', status: S.IN_SERVICE, merchantCode: G }, // VAN 해지
      { serialNo: 'VR-013', status: S.RETURNED }, // VAN 활성
      { serialNo: 'VR-014', status: S.IN_SERVICE, merchantCode: G }, // VAN 가맹점 다름
      { serialNo: 'VR-015', status: S.IN_SERVICE, merchantCode: null }, // 우리 가맹점 없음
      { serialNo: 'VR-016', status: S.IN_SERVICE, merchantCode: G }, // VAN 정지
      { serialNo: 'VR-017', status: S.DISPOSED }, // VAN 해지 — 어긋남 아님
      { serialNo: 'VR-018', status: S.RETURNED }, // VAN 정지 — 어긋남 아님
    ]);
    await partners.seedVan([
      ...Array.from({ length: 10 }, (_, i) => reg(`T-VR-${i + 1}`, `VR-${String(i + 1).padStart(3, '0')}`, 'ACTIVE')),
      reg('T-VR-12', 'VR-012', 'CANCELLED'),
      reg('T-VR-13', 'VR-013', 'ACTIVE'),
      reg('T-VR-14', 'VR-014', 'ACTIVE', Y),
      reg('T-VR-15', 'VR-015', 'ACTIVE'),
      reg('T-VR-16', 'VR-016', 'SUSPENDED'),
      reg('T-VR-17', 'VR-017', 'CANCELLED'),
      reg('T-VR-18', 'VR-018', 'SUSPENDED'),
      reg('T-VR-99', 'VR-099', 'ACTIVE'), // 우리 DB에 없음
    ]);

    const done = await run();
    expect(done).toMatchObject({ status: VanRunStatus.COMPLETED, fetched: 18, candidates: 7, confirmed: 7, resolved: 0, error: null });
    expect(done.counts).toEqual({ NOT_REGISTERED: 2, REGISTERED_BUT_NOT_IN_SERVICE: 2, MERCHANT_MISMATCH: 2, SUSPENDED_WHILE_IN_SERVICE: 1 });
    expect(Object.keys(done.phaseMs ?? {})).toEqual(['collect', 'compare', 'reverify']);
    expect((await items(done.id)).map((it) => [it.serialNo, it.kind, it.ourValue, it.vanValue, it.verified])).toEqual([
      ['VR-011', 'NOT_REGISTERED', `IN_SERVICE / ${G}`, 'VAN에 없음', true],
      ['VR-012', 'NOT_REGISTERED', `IN_SERVICE / ${G}`, `CANCELLED / ${G}`, true],
      ['VR-013', 'REGISTERED_BUT_NOT_IN_SERVICE', 'RETURNED / 가맹점 없음', `ACTIVE / ${G}`, true],
      ['VR-014', 'MERCHANT_MISMATCH', `IN_SERVICE / ${G}`, `ACTIVE / ${Y}`, true],
      ['VR-015', 'MERCHANT_MISMATCH', 'IN_SERVICE / 가맹점 없음', `ACTIVE / ${G}`, true],
      ['VR-016', 'SUSPENDED_WHILE_IN_SERVICE', `IN_SERVICE / ${G}`, `SUSPENDED / ${G}`, true],
      ['VR-099', 'REGISTERED_BUT_NOT_IN_SERVICE', '우리 DB에 없음', `ACTIVE / ${G}`, true],
    ]);
    // 재검증은 후보마다 VAN 시리얼 조회 1번(목록 1페이지 + 7)
    expect((await partners.stats()).calls['bridgevan.list']).toBe(1 + 7);
    const events = await em().find(OutboxEvent, { type: 'van.reconciliation_completed' });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ runId: done.id, fetched: 18, candidates: 7, confirmed: 7, resolved: 0 });
  });

  it('스캔 도중 VAN이 바뀌면: 이미 풀린 후보는 재검증이 거르고(verified=false), 지나간 자리에 새로 생긴 어긋남은 다음 실행이 잡는다', async () => {
    await resetDatabase(t.orm); // 앞 테스트의 단말기가 이번 VAN 목록에 없어 후보로 섞이지 않게
    await insertTerminals(t, Array.from({ length: 10 }, (_, i) => ({ serialNo: `VM-${String(i + 1).padStart(2, '0')}`, status: S.IN_SERVICE, merchantCode: G })));
    // 페이지 5건: 첫 페이지(T01~T05)는 둘째 페이지를 부를 때 모두 바뀐다(mutateDuringScan 5)
    await partners.seedVan([
      reg('T01', 'VM-01', 'SUSPENDED', G, { status: 'ACTIVE' }), // 스냅샷에는 정지, 곧 풀림
      reg('T02', 'VM-02', 'SUSPENDED', G, { status: 'ACTIVE' }),
      reg('T03', 'VM-03', 'SUSPENDED', G, { status: 'ACTIVE' }),
      reg('T04', 'VM-04', 'ACTIVE', Y, { merchantCode: G }), // 스냅샷에는 가맹점 다름, 곧 풀림
      reg('T05', 'VM-05', 'ACTIVE'), // 맞던 등록이 지나간 뒤 정지로 바뀜(이번 스냅샷은 모른다)
      reg('T06', 'VM-06', 'ACTIVE'),
      reg('T07', 'VM-07', 'ACTIVE'),
      reg('T08', 'VM-08', 'SUSPENDED'), // 진짜 어긋남(풀리지 않음)
      reg('T09', 'VM-09', 'ACTIVE'),
      reg('T10', 'VM-10', 'ACTIVE'),
    ]);
    await partners.configure({ seed: 5, bridgevan: { mutateDuringScan: 5 } });
    env.bridgevanPageSize = 5;

    const first = await run();
    expect(await partners.stats()).toMatchObject({ vanMutated: 5, vanHealed: 4 });
    expect(first).toMatchObject({ status: VanRunStatus.COMPLETED, pages: 2, fetched: 10, candidates: 5, confirmed: 1, resolved: 4 });
    const firstItems = await items(first.id);
    expect(firstItems.filter((it) => it.verified).map((it) => [it.serialNo, it.kind])).toEqual([['VM-08', 'SUSPENDED_WHILE_IN_SERVICE']]);
    expect(firstItems.filter((it) => !it.verified).map((it) => [it.serialNo, it.kind, it.vanValue])).toEqual([
      ['VM-01', 'SUSPENDED_WHILE_IN_SERVICE', `SUSPENDED / ${G}`],
      ['VM-02', 'SUSPENDED_WHILE_IN_SERVICE', `SUSPENDED / ${G}`],
      ['VM-03', 'SUSPENDED_WHILE_IN_SERVICE', `SUSPENDED / ${G}`],
      ['VM-04', 'MERCHANT_MISMATCH', `ACTIVE / ${Y}`],
    ]);
    expect(firstItems.map((it) => it.serialNo)).not.toContain('VM-05');

    // 다음 실행(변경 없음): 지나간 자리에서 정지로 바뀐 VM-05를 잡고, 풀린 것들은 후보에도 없다
    await partners.configure({ bridgevan: { mutateDuringScan: 0 } });
    const second = await run();
    expect(second).toMatchObject({ candidates: 2, confirmed: 2, resolved: 0 });
    expect((await items(second.id)).map((it) => it.serialNo)).toEqual(['VM-05', 'VM-08']);
    // 스테이징은 이번 실행 것만 남는다(앞 실행 것은 run_id로 지움)
    expect(await em().count(VanRegistrationSnapshot, { runId: first.id })).toBe(0);
    expect(await em().count(VanRegistrationSnapshot, { runId: second.id })).toBe(10);
    env.bridgevanPageSize = pageSize;
  });

  it('GET /van-reconciliations/:id 는 요약과 결과 한 페이지(afterId 키셋, 종류·재검증 조건)', async () => {
    const latest = (await em().find(VanReconciliationItem, { verified: false }, { populate: ['run'], limit: 1 }))[0].run.id;
    const all = await t.http().get(`/van-reconciliations/${latest}`);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ id: latest, status: 'COMPLETED', confirmed: 1, resolved: 4, nextAfterId: null });
    expect(all.body.items).toHaveLength(5);

    const p1 = await t.http().get(`/van-reconciliations/${latest}?limit=2`);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextAfterId).toBe(p1.body.items[1].id);
    const p2 = await t.http().get(`/van-reconciliations/${latest}?limit=2&afterId=${p1.body.nextAfterId}`);
    expect(p2.body.items[0].id).toBeGreaterThan(p1.body.nextAfterId);

    const resolved = await t.http().get(`/van-reconciliations/${latest}?verified=false&kind=MERCHANT_MISMATCH`);
    expect(resolved.body.items.map((it: { serialNo: string }) => it.serialNo)).toEqual(['VM-04']);
    expect((await t.http().get(`/van-reconciliations/${latest}?kind=WRONG`)).status).toBe(400);
    expect((await t.http().get(`/van-reconciliations/${latest}?limit=501`)).status).toBe(400);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit/van-compare.spec.ts test/unit/outbox-text.spec.ts test/van-reconciliation.e2e.spec.ts`
Expected: `Test Files 3 failed (3)` — van-compare는 `Cannot find module '../../src/van/van-compare.js'`, outbox-text는 새 테스트 1개가 `expected '[단말온] undefined: 신규 → undefined (unde…' to be '[단말온] VAN 등록 대조 #7: …'`(나머지 4개 통과), van-reconciliation은 `VanReconciliationItem`이 없어 describe 전체가 실패.

- [ ] **Step 3: 구현**

`apps/api/src/van/van.entities.ts` 전체(어긋남 종류와 결과 행 엔티티를 더함):
```ts
import { OptionalProps, PrimaryKeyProp, type Rel } from '@mikro-orm/core';
import { Entity, Enum, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** 브릿지VAN(가상) 등록 상태 */
export enum VanStatus {
  ACTIVE = 'ACTIVE', // 결제 가능
  SUSPENDED = 'SUSPENDED', // VAN이 일시 정지
  CANCELLED = 'CANCELLED', // 해지
}

/** 어긋남 종류(decisions/0033) */
export enum VanMismatchKind {
  /** 우리는 운영 중(IN_SERVICE)인데 VAN에 없거나 해지(CANCELLED) — 결제가 안 된다 */
  NOT_REGISTERED = 'NOT_REGISTERED',
  /** VAN은 ACTIVE인데 우리는 운영 중이 아님(회수·폐기 등) — 해지 요청이 빠졌다 */
  REGISTERED_BUT_NOT_IN_SERVICE = 'REGISTERED_BUT_NOT_IN_SERVICE',
  /** 둘 다 활성인데 가맹점이 다르다(우리 가맹점이 없는 경우 포함) — 정산이 엉뚱한 가맹점으로 간다 */
  MERCHANT_MISMATCH = 'MERCHANT_MISMATCH',
  /** VAN이 정지(SUSPENDED)했는데 우리는 운영 중 */
  SUSPENDED_WHILE_IN_SERVICE = 'SUSPENDED_WHILE_IN_SERVICE',
}

export enum VanRunStatus {
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum VanRunTrigger {
  MANUAL = 'MANUAL', // POST /van-reconciliations
  SCHEDULED = 'SCHEDULED', // 주기 작업(일 1회)
}

/** 단계별 걸린 시간(ms) */
export interface VanPhaseMs {
  collect?: number;
  compare?: number;
  reverify?: number;
}

/**
 * VAN 등록 대조 실행 한 번(F9). 진행 중(RUNNING)인 실행은 하나만 있을 수 있다 — MySQL에는 부분 unique가 없어
 * 생성 열 running_key(진행 중이면 1, 아니면 NULL)에 unique를 건다(decisions/0033).
 */
@Entity({ tableName: 'van_reconciliation_run' })
export class VanReconciliationRun {
  [OptionalProps]?: 'status' | 'finishedAt' | 'pages' | 'fetched' | 'retries' | 'candidates' | 'confirmed' | 'resolved' | 'counts' | 'phaseMs' | 'error';

  @PrimaryKey()
  id!: number;

  @Enum({ items: () => VanRunStatus })
  status: VanRunStatus = VanRunStatus.RUNNING;

  /**
   * 진행 중이면 1, 아니면 NULL인 생성 열 + unique: RUNNING 행은 하나만(NULL은 unique에서 서로 다르다, decisions/0033).
   * MikroORM의 부분 unique(where)는 이 열에서는 쓰지 않는다 — `status = 'RUNNING'` 같은 글자 상수가 든 함수 인덱스는 MySQL이
   * `(case when (`status` = _utf8mb4'RUNNING') …)`로 바꿔 저장해 db:migration:check가 늘 다르다고 했다(사전 검증). 앱은 이 열을 읽기만 한다(MikroORM은 생성 열을 INSERT·UPDATE에 넣지 않는다).
   */
  @Property({
    type: 'tinyint',
    nullable: true,
    generated: "(case when `status` = 'RUNNING' then 1 end) virtual",
    unique: 'van_reconciliation_run_running_unique',
  })
  runningKey?: number | null;

  @Enum({ items: () => VanRunTrigger })
  trigger!: VanRunTrigger;

  /** 작업자(수동) 또는 `system:van-reconcile`(주기) */
  @Property({ length: 50 })
  requestedBy!: string;

  @Property({ type: 'datetime', length: 3 })
  startedAt!: Date;

  @Property({ type: 'datetime', length: 3, nullable: true })
  finishedAt: Date | null = null;

  /** 받은 페이지 수와 등록 수 */
  @Property()
  pages: number = 0;

  @Property()
  fetched: number = 0;

  /** 429·5xx로 다시 부른 횟수(목록·재검증 합) */
  @Property()
  retries: number = 0;

  /** 집합 비교가 찾은 후보 수, 재검증 뒤에도 어긋난 수, 재검증에서 풀린 수 */
  @Property()
  candidates: number = 0;

  @Property()
  confirmed: number = 0;

  @Property()
  resolved: number = 0;

  /** 확정된 어긋남의 종류별 수 */
  @Property({ type: 'json', nullable: true })
  counts: Record<string, number> | null = null;

  @Property({ type: 'json', nullable: true })
  phaseMs: VanPhaseMs | null = null;

  @Property({ type: 'varchar', length: 500, nullable: true })
  error: string | null = null;
}

/**
 * VAN에서 받은 등록 목록의 스테이징(실행마다 한 벌). 우리 테이블과 SQL 집합 비교를 하려고 MySQL에 둔다(decisions/0033).
 * PK가 (run_id, serial_no)라 한 실행의 행이 클러스터 인덱스에 모여 있고, 정리는 `where run_id = ? limit n`(PK 범위)으로 한다.
 * 외래키를 두지 않는다 — 수만 행 INSERT가 실행 행에 FK 검사 S 락을 걸지 않게(Outbox·device_connectivity와 같은 이유).
 */
@Entity({ tableName: 'van_registration_snapshot' })
export class VanRegistrationSnapshot {
  [PrimaryKeyProp]?: ['runId', 'serialNo'];

  @PrimaryKey({ autoincrement: false })
  runId!: number;

  @PrimaryKey({ length: 32 })
  serialNo!: string;

  /** VAN 단말기 번호(참고값, 대조 키가 아님) */
  @Property({ length: 32 })
  tid!: string;

  @Property({ length: 40 })
  merchantCode!: string;

  @Enum({ items: () => VanStatus })
  status!: VanStatus;

  @Property({ type: 'datetime', length: 3 })
  vanUpdatedAt!: Date;
}

/**
 * 대조 결과 한 줄. 집합 비교가 찾은 후보마다 하나 — 재검증 뒤에도 어긋나면 verified=true(그때의 종류·값),
 * 재검증에서 풀렸으면 verified=false(비교 때의 종류·값, 스캔 도중 변경 등으로 생긴 거짓 양성).
 * 목록은 (run_id, id) 순서로 넘긴다 — run_id 인덱스의 항목에 PK(id)가 붙어 있어 따로 복합 인덱스가 필요 없다.
 */
@Entity({ tableName: 'van_reconciliation_item' })
export class VanReconciliationItem {
  @PrimaryKey()
  id!: number;

  @ManyToOne(() => VanReconciliationRun)
  run!: Rel<VanReconciliationRun>;

  @Property({ length: 32 })
  serialNo!: string;

  @Enum({ items: () => VanMismatchKind })
  kind!: VanMismatchKind;

  /** 우리 쪽 값(예: `IN_SERVICE / GANGNAM-KIMBAP`) */
  @Property({ length: 100 })
  ourValue!: string;

  /** VAN 쪽 값(예: `SUSPENDED / GANGNAM-KIMBAP`, `VAN에 없음`) */
  @Property({ length: 100 })
  vanValue!: string;

  @Property()
  verified!: boolean;
}
```

`apps/api/src/van/van-compare.ts`(새):
```ts
import { TerminalStatus } from '../terminal/terminal-status.js';
import { VanMismatchKind, VanStatus } from './van.entities.js';

/** 우리 쪽: 단말기 상태와 배정 가맹점 코드(없으면 null) */
export interface OurSide {
  status: TerminalStatus;
  merchantCode: string | null;
}

/** VAN 쪽: 등록 상태와 가맹점 코드 */
export interface VanSide {
  status: VanStatus;
  merchantCode: string;
}

/**
 * 한 시리얼의 어긋남 종류. 어긋나지 않으면 null. 집합 비교 SQL(후보 거르기)과 재검증이 같은 함수로 종류를 정한다(decisions/0033).
 * 대조 키는 시리얼, 가맹점은 merchant.code로 비교한다(VAN tid는 참고값).
 * 우선순위: 우리가 운영 중이면 VAN 없음·해지 → NOT_REGISTERED, 정지 → SUSPENDED_WHILE_IN_SERVICE, 활성인데 가맹점 다름 → MERCHANT_MISMATCH.
 * 우리가 운영 중이 아니면(또는 단말기가 없으면) VAN 활성 → REGISTERED_BUT_NOT_IN_SERVICE. 둘 다 비활성이면 어긋남이 아니다.
 */
export function classify(our: OurSide | null, van: VanSide | null): VanMismatchKind | null {
  const inService = our?.status === TerminalStatus.IN_SERVICE;
  if (inService) {
    if (!van || van.status === VanStatus.CANCELLED) return VanMismatchKind.NOT_REGISTERED;
    if (van.status === VanStatus.SUSPENDED) return VanMismatchKind.SUSPENDED_WHILE_IN_SERVICE;
    return our!.merchantCode === van.merchantCode ? null : VanMismatchKind.MERCHANT_MISMATCH;
  }
  return van?.status === VanStatus.ACTIVE ? VanMismatchKind.REGISTERED_BUT_NOT_IN_SERVICE : null;
}

export function ourValueOf(our: OurSide | null): string {
  return our ? `${our.status} / ${our.merchantCode ?? '가맹점 없음'}` : '우리 DB에 없음';
}

export function vanValueOf(van: VanSide | null): string {
  return van ? `${van.status} / ${van.merchantCode}` : 'VAN에 없음';
}

/** 알림·리포트에 쓰는 짧은 이름 */
export const KIND_LABEL: Record<VanMismatchKind, string> = {
  [VanMismatchKind.NOT_REGISTERED]: '미등록',
  [VanMismatchKind.REGISTERED_BUT_NOT_IN_SERVICE]: '운영 아님',
  [VanMismatchKind.MERCHANT_MISMATCH]: '가맹점 다름',
  [VanMismatchKind.SUSPENDED_WHILE_IN_SERVICE]: '정지',
};
```

`apps/api/src/van/van-reconciliation.service.ts` 전체:
```ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { EntityManager, IsolationLevel, UniqueConstraintViolationException, type QueryResult } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { withPartnerRetry } from '../common/partner-retry.js';
import { env } from '../config/env.js';
import { OUTBOX_TYPE, OutboxEvent } from '../outbox/outbox-event.entity.js';
import { QUEUE } from '../queue/queue-names.js';
import type { TerminalStatus } from '../terminal/terminal-status.js';
import { BridgevanClient } from './bridgevan.client.js';
import { classify, ourValueOf, vanValueOf, type OurSide, type VanSide } from './van-compare.js';
import {
  VanMismatchKind,
  VanReconciliationItem,
  VanReconciliationRun,
  VanRegistrationSnapshot,
  VanRunStatus,
  VanRunTrigger,
  type VanPhaseMs,
  type VanStatus,
} from './van.entities.js';

/** 주기 실행의 작업자 이름(decisions/0001) */
export const VAN_SYSTEM_ACTOR = 'system:van-reconcile';

/** 페이지 하나·시리얼 하나를 다시 부르는 최대 횟수(첫 시도 포함) */
export const VAN_CALL_ATTEMPTS = 5;

/** 스냅샷 정리 DELETE 한 번의 행 수(한 문장이 오래 잠그지 않게) */
const SNAPSHOT_DELETE_BATCH = 5000;

/** 재검증 때 우리 쪽을 한 번에 다시 읽는 시리얼 수 */
const REVERIFY_BLOCK = 100;

/** 결과 INSERT 한 문장의 행 수 */
const ITEM_INSERT_CHUNK = 500;

/** 실행 job 옵션: 실패해도 BullMQ가 다시 돌리지 않는다(실행 행에 FAILED와 이유를 남기고, 다음 실행이 처음부터 한다) */
const RUN_JOB_OPTIONS = { attempts: 1, removeOnComplete: true, removeOnFail: 100 };

export interface VanRunJobData {
  runId: number;
}

/** 집합 비교가 찾은 후보 */
export interface VanCandidate {
  serialNo: string;
  kind: VanMismatchKind;
  our: OurSide | null;
  van: VanSide | null;
}

type ItemRow = Pick<VanReconciliationItem, 'serialNo' | 'kind' | 'ourValue' | 'vanValue' | 'verified'>;

interface CompareRow {
  serial_no: string;
  status: TerminalStatus | null;
  our_merchant: string | null;
  van_status: VanStatus | null;
  van_merchant: string | null;
}

const elapsed = (start: number) => Math.round(performance.now() - start);

function sidesOf(row: CompareRow): { our: OurSide | null; van: VanSide | null } {
  return {
    our: row.status ? { status: row.status, merchantCode: row.our_merchant } : null,
    van: row.van_status ? { status: row.van_status, merchantCode: row.van_merchant ?? '' } : null,
  };
}

/**
 * 브릿지VAN 등록 대조(F9, decisions/0033).
 * 1. start: 실행 행(RUNNING)을 만든다. 진행 중인 실행이 있으면 409(실행 행의 부분 unique).
 * 2. collect: 커서로 모든 페이지를 받아 페이지마다 스테이징(van_registration_snapshot)에 한 문장으로 넣는다.
 *    429·5xx는 그 페이지만 다시 부른다(Retry-After, withPartnerRetry). 외부 호출은 트랜잭션 밖이다.
 * 3. compare: 스테이징 ⟷ terminal·merchant를 SQL 두 문장으로 비교해 어긋남 후보를 거른다(한 스냅숏, 읽기 전용 트랜잭션).
 * 4. reverify: 후보마다 VAN 단건(시리얼)과 우리 쪽을 지금 값으로 다시 읽어, 여전히 어긋난 것만 확정한다(스캔 도중 변경의 거짓 양성 제거).
 * 5. finish: 한 트랜잭션에서 결과 행 INSERT + 실행 행 완료 + Outbox 요약 알림 1행. 그 뒤 이전 실행의 스테이징을 지운다.
 * 실행은 report 큐 job 하나가 처음부터 끝까지 한다(device 큐에 무거운 일을 넣지 않는다, experiments/0010).
 */
@Injectable()
export class VanReconciliationService {
  private readonly logger = new Logger(VanReconciliationService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly van: BridgevanClient,
    @InjectQueue(QUEUE.REPORT) private readonly queue: Queue,
  ) {}

  /** 실행 행을 만든다. 진행 중인 실행이 있으면 409 VAN_RECONCILIATION_RUNNING */
  async start(trigger: VanRunTrigger, actor: string, now = new Date()): Promise<VanReconciliationRun> {
    await this.failStale(now);
    const em = this.em.fork();
    const run = em.create(VanReconciliationRun, { trigger, requestedBy: actor, startedAt: now });
    try {
      await em.flush();
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new BusinessError(409, 'VAN_RECONCILIATION_RUNNING', '진행 중인 VAN 대조가 있습니다. 끝난 뒤 다시 요청하세요.');
      }
      throw error;
    }
    return run;
  }

  /** 수동 실행: 실행 행을 만들고 report 큐에 넣는다. 큐에 못 넣으면 그 실행을 FAILED로 남기고 던진다 */
  async request(actor: string): Promise<VanReconciliationRun> {
    const run = await this.start(VanRunTrigger.MANUAL, actor);
    try {
      await this.queue.add('van-reconcile', { runId: run.id } satisfies VanRunJobData, { ...RUN_JOB_OPTIONS, jobId: `van-run-${run.id}` });
    } catch (error) {
      await this.fail(run.id, error);
      throw error;
    }
    return run;
  }

  /** 주기 실행(job scheduler). 진행 중인 실행이 있으면 건너뛴다 */
  async runScheduled(): Promise<{ runId: number | null; skipped?: boolean }> {
    let run: VanReconciliationRun;
    try {
      run = await this.start(VanRunTrigger.SCHEDULED, VAN_SYSTEM_ACTOR);
    } catch (error) {
      if (error instanceof BusinessError && error.code === 'VAN_RECONCILIATION_RUNNING') return { runId: null, skipped: true };
      throw error;
    }
    await this.execute(run.id);
    return { runId: run.id };
  }

  /**
   * 실행 한 번을 끝까지 한다. 어디서 실패하든 실행 행을 FAILED(이유)로 남기고 행을 돌려준다(던지지 않는다 — job은 끝난다).
   * 같은 runId로 다시 불리면(멈춘 job을 BullMQ가 다시 돌림) 스테이징을 지우고 처음부터 한다.
   */
  async execute(runId: number): Promise<VanReconciliationRun> {
    const phaseMs: VanPhaseMs = {};
    try {
      let t = performance.now();
      const collected = await this.collect(runId);
      phaseMs.collect = elapsed(t);
      t = performance.now();
      const candidates = await this.compare(runId);
      phaseMs.compare = elapsed(t);
      t = performance.now();
      const checked = await this.reverify(candidates);
      phaseMs.reverify = elapsed(t);
      await this.finish(runId, { ...collected, retries: collected.retries + checked.retries }, candidates.length, checked.items, phaseMs);
      await this.cleanupSnapshots(runId);
    } catch (error) {
      this.logger.error(`VAN 대조 ${runId} 실패: ${error instanceof Error ? error.message : String(error)}`);
      await this.fail(runId, error);
    }
    return this.get(runId);
  }

  /**
   * 커서로 모든 페이지를 받아 스테이징에 넣는다. 페이지마다 INSERT 한 문장(자동 커밋) — 수집 전체를 한 트랜잭션으로 묶지 않는다
   * (외부 호출을 기다리는 동안 잠금을 쥐지 않게). 같은 시리얼이 두 번 오면 나중 값으로 덮는다.
   */
  async collect(runId: number): Promise<{ pages: number; fetched: number; retries: number }> {
    await this.deleteSnapshot(runId);
    const em = this.em.fork();
    let cursor: string | null = null;
    let pages = 0;
    let fetched = 0;
    let retries = 0;
    do {
      const page = await withPartnerRetry(() => this.van.list(cursor, env.bridgevanPageSize), {
        attempts: VAN_CALL_ATTEMPTS,
        onRetry: () => retries++,
      });
      if (page.items.length > 0) {
        await em
          .createQueryBuilder(VanRegistrationSnapshot)
          .insert(
            page.items.map((r) => ({ runId, serialNo: r.serialNo, tid: r.tid, merchantCode: r.merchantCode, status: r.status, vanUpdatedAt: r.updatedAt })),
          )
          .onConflict(['runId', 'serialNo'])
          .merge(['tid', 'merchantCode', 'status', 'vanUpdatedAt'])
          .execute();
      }
      pages++;
      fetched += page.items.length;
      cursor = page.nextCursor;
    } while (cursor);
    return { pages, fetched, retries };
  }

  /**
   * 스테이징 ⟷ terminal·merchant 집합 비교. 두 문장을 한 REPEATABLE READ 읽기 전용 트랜잭션에서 돌려 같은 시점을 본다(F10 대조와 같은 방식).
   * ① 우리 쪽 운영 중 단말기 기준(LEFT JOIN 스테이징): VAN 없음·해지·정지·가맹점 다름
   * ② VAN 쪽 ACTIVE 등록 기준(LEFT JOIN terminal): 우리가 운영 중이 아니거나 단말기가 없음
   * SQL은 어긋난 행만 거르고, 종류는 classify(재검증과 같은 함수)로 정한다. 시리얼 오름차순.
   */
  async compare(runId: number): Promise<VanCandidate[]> {
    const [inService, vanActive] = await this.em.fork().transactional(
      async (tx) => [
        await tx.execute<CompareRow[]>(
          `select t.serial_no, t.status, m.code as our_merchant, s.status as van_status, s.merchant_code as van_merchant
             from terminal t
             left join merchant m on m.id = t.merchant_id
             left join van_registration_snapshot s on s.run_id = ? and s.serial_no = t.serial_no
            where t.status = 'IN_SERVICE'
              and (s.serial_no is null or s.status <> 'ACTIVE' or m.code is null or m.code <> s.merchant_code)`,
          [runId],
        ),
        await tx.execute<CompareRow[]>(
          `select s.serial_no, t.status, m.code as our_merchant, s.status as van_status, s.merchant_code as van_merchant
             from van_registration_snapshot s
             left join terminal t on t.serial_no = s.serial_no
             left join merchant m on m.id = t.merchant_id
            where s.run_id = ? and s.status = 'ACTIVE' and (t.id is null or t.status <> 'IN_SERVICE')`,
          [runId],
        ),
      ],
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
    const out: VanCandidate[] = [];
    for (const row of [...inService, ...vanActive]) {
      const { our, van } = sidesOf(row);
      const kind = classify(our, van);
      if (kind) out.push({ serialNo: row.serial_no, kind, our, van });
    }
    return out.sort((a, b) => (a.serialNo < b.serialNo ? -1 : a.serialNo > b.serialNo ? 1 : 0));
  }

  /**
   * 후보마다 지금 값으로 다시 본다: VAN은 시리얼 단건 조회(동시 env.vanReverifyConcurrency개), 우리 쪽은 블록마다 한 문장.
   * 여전히 어긋나면 verified=true(지금의 종류·값), 풀렸으면 verified=false(비교 때의 종류·값).
   */
  async reverify(candidates: VanCandidate[]): Promise<{ items: ItemRow[]; retries: number }> {
    const items: ItemRow[] = [];
    let retries = 0;
    for (let i = 0; i < candidates.length; i += REVERIFY_BLOCK) {
      const block = candidates.slice(i, i + REVERIFY_BLOCK);
      const vans = new Map<string, VanSide | null>();
      for (let j = 0; j < block.length; j += env.vanReverifyConcurrency) {
        const group = block.slice(j, j + env.vanReverifyConcurrency);
        const found = await Promise.all(
          group.map((c) => withPartnerRetry(() => this.van.findBySerial(c.serialNo), { attempts: VAN_CALL_ATTEMPTS, onRetry: () => retries++ })),
        );
        group.forEach((c, k) => vans.set(c.serialNo, found[k] ? { status: found[k].status, merchantCode: found[k].merchantCode } : null));
      }
      const ours = await this.ourSides(block.map((c) => c.serialNo));
      for (const c of block) {
        const our = ours.get(c.serialNo) ?? null;
        const van = vans.get(c.serialNo) ?? null;
        const kind = classify(our, van);
        items.push(
          kind
            ? { serialNo: c.serialNo, kind, ourValue: ourValueOf(our), vanValue: vanValueOf(van), verified: true }
            : { serialNo: c.serialNo, kind: c.kind, ourValue: ourValueOf(c.our), vanValue: vanValueOf(c.van), verified: false },
        );
      }
    }
    return { items, retries };
  }

  /** 결과 INSERT + 실행 행 완료 + Outbox 요약 1행을 한 트랜잭션으로(실행 행 → 결과 행 순서) */
  private async finish(
    runId: number,
    collected: { pages: number; fetched: number; retries: number },
    candidates: number,
    items: ItemRow[],
    phaseMs: VanPhaseMs,
  ): Promise<void> {
    const confirmed = items.filter((it) => it.verified);
    const counts = Object.fromEntries(Object.values(VanMismatchKind).map((k) => [k, confirmed.filter((it) => it.kind === k).length]));
    const summary = { ...collected, candidates, confirmed: confirmed.length, resolved: items.length - confirmed.length, counts, phaseMs };
    await this.em.fork().transactional(async (tx) => {
      const updated = await tx.nativeUpdate(
        VanReconciliationRun,
        { id: runId, status: VanRunStatus.RUNNING },
        { status: VanRunStatus.COMPLETED, finishedAt: new Date(), ...summary },
      );
      if (updated === 0) throw new Error(`VAN 대조 ${runId}이(가) 끝내는 중에 RUNNING이 아니게 됨`);
      for (let i = 0; i < items.length; i += ITEM_INSERT_CHUNK) {
        await tx.insertMany(
          VanReconciliationItem,
          items.slice(i, i + ITEM_INSERT_CHUNK).map((it) => ({ ...it, run: runId })),
        );
      }
      // 묶음 원칙: 어긋남이 몇 건이든 알림은 요약 1행(experiments/0010, decisions/0029)
      tx.create(OutboxEvent, {
        type: OUTBOX_TYPE.VAN_RECONCILIATION_COMPLETED,
        payload: { runId, fetched: collected.fetched, candidates, confirmed: summary.confirmed, resolved: summary.resolved, counts },
      });
    });
  }

  /** 이번 실행보다 앞선 실행들의 스테이징을 지운다(이번 실행 것만 남긴다) */
  async cleanupSnapshots(currentRunId: number): Promise<number> {
    const old = await this.em
      .fork()
      .execute<{ run_id: number }[]>('select distinct run_id from van_registration_snapshot where run_id < ? order by run_id', [currentRunId]);
    let deleted = 0;
    for (const r of old) deleted += await this.deleteSnapshot(r.run_id);
    return deleted;
  }

  /** 한 실행의 스테이징을 PK 범위(run_id)로 조금씩 지운다(자동 커밋 DELETE를 되풀이). @returns 지운 행 수 */
  async deleteSnapshot(runId: number): Promise<number> {
    const em = this.em.fork();
    let deleted = 0;
    for (;;) {
      const res = await em.execute<QueryResult>('delete from van_registration_snapshot where run_id = ? limit ?', [runId, SNAPSHOT_DELETE_BATCH], 'run');
      deleted += res.affectedRows;
      if (res.affectedRows < SNAPSHOT_DELETE_BATCH) return deleted;
    }
  }

  async get(id: number): Promise<VanReconciliationRun> {
    const run = await this.em.fork().findOne(VanReconciliationRun, id);
    if (!run) throw new NotFoundException(`VAN 대조 ${id}이(가) 없습니다.`);
    return run;
  }

  /** 결과 행 한 페이지(id 순, afterId 뒤부터). 다음 페이지가 있으면 nextAfterId */
  async items(runId: number, q: { kind?: VanMismatchKind; verified?: boolean; afterId?: number; limit: number }) {
    const rows = await this.em.fork().find(
      VanReconciliationItem,
      {
        run: runId,
        id: { $gt: q.afterId ?? 0 },
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.verified === undefined ? {} : { verified: q.verified }),
      },
      { orderBy: { id: 'asc' }, limit: q.limit + 1 },
    );
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((it) => ({ id: it.id, serialNo: it.serialNo, kind: it.kind, ourValue: it.ourValue, vanValue: it.vanValue, verified: it.verified })),
      nextAfterId: rows.length > q.limit ? page.at(-1)!.id : null,
    };
  }

  /** 시리얼들의 지금 상태·가맹점(재검증용, 한 문장) */
  private async ourSides(serials: string[]): Promise<Map<string, OurSide>> {
    const rows = await this.em.fork().execute<{ serial_no: string; status: TerminalStatus; merchant_code: string | null }[]>(
      `select t.serial_no, t.status, m.code as merchant_code
         from terminal t left join merchant m on m.id = t.merchant_id
        where t.serial_no in (${serials.map(() => '?').join(', ')})`,
      serials,
    );
    return new Map(rows.map((r) => [r.serial_no, { status: r.status, merchantCode: r.merchant_code }]));
  }

  /** 실행 행을 FAILED로(아직 RUNNING일 때만) */
  private async fail(runId: number, error: unknown): Promise<void> {
    const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
    await this.em
      .fork()
      .nativeUpdate(VanReconciliationRun, { id: runId, status: VanRunStatus.RUNNING }, { status: VanRunStatus.FAILED, finishedAt: new Date(), error: message });
  }

  /** 너무 오래 RUNNING인 실행(프로세스가 죽어 끝나지 못함)을 FAILED로. 잠그지 않고 읽은 뒤 PK로 갱신한다(troubleshooting/0014) */
  private async failStale(now: Date): Promise<void> {
    const em = this.em.fork();
    const stale = await em.find(
      VanReconciliationRun,
      { status: VanRunStatus.RUNNING, startedAt: { $lt: new Date(now.getTime() - env.vanRunStaleMs) } },
      { fields: ['id'] },
    );
    if (stale.length === 0) return;
    await em.nativeUpdate(
      VanReconciliationRun,
      { id: { $in: stale.map((r) => r.id) }, status: VanRunStatus.RUNNING },
      { status: VanRunStatus.FAILED, finishedAt: now, error: `멈춘 실행: ${env.vanRunStaleMs}ms 넘게 끝나지 않음` },
    );
    this.logger.warn(`멈춘 VAN 대조 실행을 FAILED로: ${stale.map((r) => r.id).join(', ')}`);
  }
}

export function toVanRunView(run: VanReconciliationRun) {
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    requestedBy: run.requestedBy,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    pages: run.pages,
    fetched: run.fetched,
    retries: run.retries,
    candidates: run.candidates,
    confirmed: run.confirmed,
    resolved: run.resolved,
    counts: run.counts ?? {},
    phaseMs: run.phaseMs ?? {},
    error: run.error,
  };
}
```

`apps/api/src/van/dto/van-items.query.ts`(새):
```ts
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { VanMismatchKind } from '../van.entities.js';

/** GET /van-reconciliations/:id 의 결과 목록 조건. 페이지는 afterId(키셋) — offset이 아니다(decisions/0033) */
export class VanItemsQuery {
  @IsOptional()
  @IsEnum(VanMismatchKind)
  kind?: VanMismatchKind;

  /** true: 재검증 뒤에도 어긋난 것, false: 재검증에서 풀린 것, 없으면 둘 다 */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  verified?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;
}
```

`apps/api/src/van/van-reconciliation.controller.ts` 전체:
```ts
import { Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { VanItemsQuery } from './dto/van-items.query.js';
import { toVanRunView, VanReconciliationService } from './van-reconciliation.service.js';

/** VAN 등록 대조(F9). 실행은 report 큐에서 비동기로 돈다 — 요청은 실행 행만 만들고 202로 끝난다. */
@Controller('van-reconciliations')
export class VanReconciliationController {
  constructor(private readonly runs: VanReconciliationService) {}

  /** 수동 실행. 진행 중인 실행이 있으면 409 VAN_RECONCILIATION_RUNNING */
  @Post()
  @HttpCode(202)
  async start(@Operator() actor: string) {
    return toVanRunView(await this.runs.request(actor));
  }

  /** 실행 요약 + 결과 한 페이지(?kind=&verified=&afterId=&limit=) */
  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number, @Query() query: VanItemsQuery) {
    const run = toVanRunView(await this.runs.get(id));
    return { ...run, ...(await this.runs.items(id, query)) };
  }
}
```

`apps/api/src/outbox/outbox-event.entity.ts`, `apps/api/src/outbox/outbox.service.ts`:
```diff
--- a/apps/api/src/outbox/outbox-event.entity.ts
+++ b/apps/api/src/outbox/outbox-event.entity.ts
@@ -20,6 +20,8 @@ export const OUTBOX_TYPE = {
   FIRMWARE_STAGE_ADVANCED: 'firmware.stage_advanced',
   FIRMWARE_ROLLOUT_COMPLETED: 'firmware.rollout_completed',
   FIRMWARE_ROLLOUT_ABORTED: 'firmware.rollout_aborted',
+  /** VAN 등록 대조 한 번의 요약(F9, 어긋남 수와 상관없이 1행, decisions/0033) */
+  VAN_RECONCILIATION_COMPLETED: 'van.reconciliation_completed',
 } as const;
 
 /**
```
```diff
--- a/apps/api/src/outbox/outbox.service.ts
+++ b/apps/api/src/outbox/outbox.service.ts
@@ -4,6 +4,8 @@ import { UnrecoverableError, type JobsOptions, type Queue } from 'bullmq';
 import { EntityManager, IsolationLevel, LockMode } from '@mikro-orm/mysql';
 import { PartnerPermanentError } from '../common/partner-errors.js';
 import { QUEUE } from '../queue/queue-names.js';
+import { KIND_LABEL } from '../van/van-compare.js';
+import type { VanMismatchKind } from '../van/van.entities.js';
 import { OUTBOX_TYPE, OutboxEvent, OutboxStatus } from './outbox-event.entity.js';
 import { ToktokClient } from './toktok.client.js';
 
@@ -61,7 +63,18 @@ export function textOf(event: Pick<OutboxEvent, 'type' | 'payload'>): string {
     version?: string;
     stage?: number;
     percent?: number;
+    runId?: number;
+    fetched?: number;
+    confirmed?: number;
+    resolved?: number;
+    counts?: Partial<Record<VanMismatchKind, number>>;
   };
+  if (event.type === OUTBOX_TYPE.VAN_RECONCILIATION_COMPLETED) {
+    const byKind = Object.entries(KIND_LABEL)
+      .map(([kind, label]) => `${label} ${p.counts?.[kind as VanMismatchKind] ?? 0}`)
+      .join(', ');
+    return `[단말온] VAN 등록 대조 #${p.runId}: 어긋남 ${p.confirmed}건(${byKind}), 재검증으로 풀림 ${p.resolved}건, VAN 등록 ${p.fetched}건`;
+  }
   if (event.type === OUTBOX_TYPE.DEVICE_OFFLINE_BULK || event.type === OUTBOX_TYPE.DEVICE_ONLINE_BULK) {
     const what = event.type === OUTBOX_TYPE.DEVICE_OFFLINE_BULK ? '오프라인' : '온라인 복귀';
     const shown = (p.serials ?? []).slice(0, BULK_TEXT_SERIALS);
```

`apps/api/src/config/env.ts`, `apps/api/src/entities.ts`:
```diff
--- a/apps/api/src/config/env.ts
+++ b/apps/api/src/config/env.ts
@@ -85,6 +85,8 @@ export const env = {
   bridgevanPageSize: intFromEnv('BRIDGEVAN_PAGE_SIZE', 500, { min: 1, max: 1000 }),
   /** 이보다 오래 RUNNING인 VAN 대조 실행은 멈춘 것(프로세스가 죽음)으로 보고, 새 실행을 시작할 때 FAILED로 바꾼다 */
   vanRunStaleMs: intFromEnv('VAN_RUN_STALE_MS', 3_600_000, MS),
+  /** 재검증 때 브릿지VAN 단건 조회를 동시에 몇 개까지 보내나 */
+  vanReverifyConcurrency: intFromEnv('VAN_REVERIFY_CONCURRENCY', 8, { min: 1, max: 64 }),
   /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
   workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
 };
```
```diff
--- a/apps/api/src/entities.ts
+++ b/apps/api/src/entities.ts
@@ -11,7 +11,7 @@ import { ScanBatch } from './scan/scan-batch.entity.js';
 import { ServiceTicket } from './service/service-ticket.entity.js';
 import { DeviceConnectivity } from './device/device-connectivity.entity.js';
 import { Firmware, FirmwareRollout, FirmwareRolloutTarget } from './firmware/firmware.entities.js';
-import { VanReconciliationRun, VanRegistrationSnapshot } from './van/van.entities.js';
+import { VanReconciliationItem, VanReconciliationRun, VanRegistrationSnapshot } from './van/van.entities.js';
 
 /** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
-export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch, ServiceTicket, DeviceConnectivity, Firmware, FirmwareRollout, FirmwareRolloutTarget, VanReconciliationRun, VanRegistrationSnapshot];
+export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch, ServiceTicket, DeviceConnectivity, Firmware, FirmwareRollout, FirmwareRolloutTarget, VanReconciliationRun, VanRegistrationSnapshot, VanReconciliationItem];
```

`.env.example`의 VAN 줄 뒤에:
```
VAN_REVERIFY_CONCURRENCY=8
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/unit/van-compare.spec.ts test/unit/outbox-text.spec.ts test/van-reconciliation.e2e.spec.ts test/van-collect.e2e.spec.ts`
Expected: `Tests  27 passed (27)`(van-compare 12, outbox-text 5, van-reconciliation 3, van-collect 7 — 수집 테스트는 해지 등록만 심어 후보가 없으므로 그대로 통과).

- [ ] **Step 5: 마이그레이션**

Run: `npm run db:migration:create`
Expected: `생성: Migration<시각>.ts`, up():
```ts
import { Migration } from '@mikro-orm/migrations';

export class Migration20261026013510 extends Migration {

  override name = 'Migration20261026013510';

  override up(): void | Promise<void> {
    this.addSql(`create table \`van_reconciliation_item\` (\`id\` int unsigned not null auto_increment primary key, \`run_id\` int unsigned not null, \`serial_no\` varchar(32) not null, \`kind\` enum('NOT_REGISTERED','REGISTERED_BUT_NOT_IN_SERVICE','MERCHANT_MISMATCH','SUSPENDED_WHILE_IN_SERVICE') not null, \`our_value\` varchar(100) not null, \`van_value\` varchar(100) not null, \`verified\` tinyint(1) not null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`van_reconciliation_item\` add index \`van_reconciliation_item_run_id_index\` (\`run_id\`);`);

    this.addSql(`alter table \`van_reconciliation_item\` add constraint \`van_reconciliation_item_run_id_foreign\` foreign key (\`run_id\`) references \`van_reconciliation_run\` (\`id\`);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`van_reconciliation_item\`;`);
  }

}
```

그리고:
```bash
npm run db:migrate
npm run db:migration:check
npx vitest run && npm run typecheck
```
Expected: `적용: Migration<시각>`, `최신 상태`, `Test Files  45 passed (45)`, `Tests  303 passed (303)`, typecheck exit 0.

- [ ] **Step 6: 기록과 커밋**

devlog에 `## HH:MM Task 4 VAN 대조 비교·재검증·결과·요약 알림·스테이징 정리 (F9, F5)` 항목.

`docs/decisions/0033-…`에 보탠다:
- 대조 키: 시리얼(`serial_no`). VAN tid는 참고값으로 스테이징에만(우리 테이블에 VAN 필드를 두지 않음). 가맹점은 `merchant.code`로 비교(VAN도 우리가 등록할 때 준 가맹점 코드를 들고 있다는 가정).
- 종류 4개와 우선순위(스펙 4.1 표). SQL은 두 문장으로 "어긋난 행"만 거르고 종류는 TS `classify`가 정한다 — 같은 규칙을 SQL CASE와 TS에 두 번 쓰지 않으려고. 두 문장은 한 RR 읽기 전용 트랜잭션(F10 대조와 같은 이유: 같은 시점).
- 재검증: 스캔에 수 초~수 분이 걸리고 VAN이 그 사이 바뀐다(가상 VAN의 mutateDuringScan). 후보마다 VAN 단건(시리얼)과 우리 쪽을 지금 값으로 다시 읽어 classify를 다시 한다. 1) 재검증 없음 — 거짓 양성이 그대로 알림·리포트에 간다. 2) **후보만 재검증** — 후보 수만큼 단건 호출(어긋남 2%면 5만 건에 천 번, 0012가 잰다). 3) 전체 두 번 스캔 — 호출이 두 배. → 2. 재검증은 "후보 중 풀린 것"만 거른다. 지나간 자리에서 새로 생긴 어긋남(이번 스캔이 놓침)은 찾지 못하고 다음 실행이 찾는다(0012의 C).
- 결과: 후보마다 한 행, verified=false는 비교 때의 값(무엇이 거짓 양성이었는지 남김). 목록은 afterId 키셋(offset을 버린 이유와 같다). run_id 인덱스 항목에는 PK가 붙어 있어 `(run_id, id)` 복합 인덱스가 필요 없다(decisions/0032의 반대 경우).
- 확정 순서: 실행 행 UPDATE(조건 status=RUNNING) → 결과 INSERT → Outbox 1행. 실행 행이 그사이 FAILED(멈춘 실행 정리)가 됐으면 0행 → 던져서 결과도 롤백.
- 알림 묶음: 어긋남이 천 건이어도 Outbox 1행(요약). 목록은 GET과 주간 리포트로 본다(experiments/0010의 relay 줄 교훈).
- 스테이징 정리: 이번 실행이 끝나면 앞선 실행의 스테이징을 지운다(이번 것만 남겨 다음 비교·조사에 쓴다).

`docs/decisions/0016-Outbox-최소-한-번과-멱등키.md` 끝에 한 줄:
```
- 갱신(2026-10-26 Day 5): type `van.reconciliation_completed`(대조 한 번에 요약 1행). Task 6에서 `anomaly.detected`·`anomaly.detected_bulk`를 더한다.
```

커밋:
```bash
git add apps/api docs .env.example
git commit -m "feat(F9): VAN 대조 SQL 집합 비교·재검증·결과 행·요약 알림·스테이징 정리" -m "Refs: docs/decisions/0033-VAN-등록-대조는-커서-수집-스테이징-SQL-비교-재검증.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 이상 단말기 찾기 — status_changed_at(전이 서비스·백필·복합 인덱스), 열린 이상(부분 unique), 규칙 6개, 찾기·조회 API (F4, F2)

**Files:**
- Create: `apps/api/src/anomaly/anomaly.entity.ts`, `apps/api/src/anomaly/anomaly-rules.ts`, `apps/api/src/anomaly/anomaly.service.ts`, `apps/api/src/anomaly/anomaly.controller.ts`, `apps/api/src/anomaly/dto/list-anomalies.query.ts`, `apps/api/src/anomaly/anomaly.module.ts`, `apps/api/src/migrations/Migration<시각>.ts`(생성 후 손으로 고침)
- Modify: `apps/api/src/terminal/terminal.entity.ts`, `apps/api/src/terminal/transition.service.ts`, `apps/api/src/config/env.ts`, `apps/api/src/app.module.ts`, `apps/api/src/entities.ts`, `.env.example`
- Test: `apps/api/test/anomaly.e2e.spec.ts`(새), `apps/api/test/status-changed-at.e2e.spec.ts`(새), `apps/api/test/helpers/terminals.ts`, `apps/api/test/helpers/device-fleet.ts`, `apps/api/test/connectivity.e2e.spec.ts`, `apps/api/test/experiments/device-jobs-timing.spec.ts`
- Record: `docs/devlog/2026-10-26.md`, `docs/decisions/0034-이상-단말기는-status_changed_at과-열린-이상-테이블로.md`, `docs/troubleshooting/0022-insertMany는-엔티티-기본값을-쓰지-않아-새-NOT-NULL-열에서-실패.md`, `docs/study/backlog.md`

바꾸는 것 요약:
- `Terminal.statusChangedAt`(datetime(3), 기본 지금): 전이 서비스(`transition`, `transitionMany`)가 상태를 바꿀 때 같은 UPDATE에서 바꾸고, 그 시각을 이력 `occurredAt`에도 쓴다. 등록 이력(`recordRegistration`)도 같은 값. `@Index(['status'])` → `@Index(['status', 'statusChangedAt'])`(status 단독 인덱스는 앞부분으로 덮여 지운다).
- `Anomaly`: 열린 이상은 (단말기, 규칙)마다 하나 — `@Unique({ properties: ['terminalId', 'rule'], where: { resolvedAt: null } })`(MikroORM이 MySQL 함수 인덱스로 흉내). (resolved_at, rule) 인덱스. terminal FK 없음.
- `findAnomalies(em, now, thresholds)`: 규칙마다 SQL 한 문장(스펙 4.2), 기준 시각은 앱이 계산해 파라미터로, 원시 datetime은 `fromDbDatetime`. detail은 `{ status, since, days }` 또는 `{ lastSeenAt, days }`.
- `AnomalyService.scan(now)`: Redis 잠금(`<p>:job-lock:anomaly-scan`, 5분) — 없으면 409 `ANOMALY_SCAN_RUNNING`. 열린 이상과 비교해 한 트랜잭션에서 INSERT·`last_seen_at`·`resolved_at`(PK `IN (…)` 500개씩 + `resolved_at is null` 조건). 알림은 Task 6.
- `GET /anomalies?rule=&open=&afterId=&limit=`(단말기 시리얼·지금 상태를 붙임), `POST /anomaly-scans`(X-Operator, 동기 200, 새로 걸린 시리얼 앞 100개).
- 기준일 env: `ANOMALY_DELIVERED_DAYS`(7), `ANOMALY_RETURN_STALLED_DAYS`(14), `ANOMALY_SHIPPED_DAYS`(10), `ANOMALY_ALLOCATED_DAYS`(3), `ANOMALY_OFFLINE_DAYS`(3), 범위 1~365.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/helpers/terminals.ts`(statusChangedAt 인자):
```diff
--- a/apps/api/test/helpers/terminals.ts
+++ b/apps/api/test/helpers/terminals.ts
@@ -11,6 +11,8 @@ export interface TerminalSeed {
   merchantCode?: string | null;
   /** 기본 SN-100 */
   modelCode?: string;
+  /** 지금 상태가 된 시각(기본 지금). insertMany는 엔티티 기본값을 쓰지 않아 꼭 넣는다(troubleshooting/0022) */
+  statusChangedAt?: Date;
 }
 
 /**
@@ -31,6 +33,7 @@ export async function insertTerminals(t: TestApp, rows: TerminalSeed[]): Promise
         model: models.get(r.modelCode ?? 'SN-100')!,
         merchant: r.merchantCode ? merchants.get(r.merchantCode)! : null,
         status: r.status,
+        statusChangedAt: r.statusChangedAt ?? now,
         version: 1,
         createdAt: now,
         updatedAt: now,
```

`apps/api/test/status-changed-at.e2e.spec.ts`(새):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { registerInStock, SCENARIO_OP } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('terminal.status_changed_at — 지금 상태가 된 시각 (F4, decisions/0034)', () => {
  let t: TestApp;
  const em = () => t.orm.em.fork();
  const terminal = (serialNo: string) => em().findOneOrFail(Terminal, { serialNo });
  const lastHistory = async (serialNo: string) =>
    (await em().find(TerminalStatusHistory, { terminal: { serialNo } }, { orderBy: { id: 'desc' }, limit: 1 }))[0];

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('등록·전이마다 상태와 같은 UPDATE에서 바뀌고, 그 이력의 occurred_at과 같은 시각이다(이력은 초 단위라 1초 안)', async () => {
    const before = Date.now();
    await registerInStock(t, 'SC-0001'); // 등록 → 검수 합격 → 재고(전이 3번)
    const t1 = await terminal('SC-0001');
    expect(t1.status).toBe('IN_STOCK');
    expect(t1.statusChangedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(Math.abs(t1.statusChangedAt.getTime() - (await lastHistory('SC-0001')).occurredAt.getTime())).toBeLessThan(1000);

    await new Promise((r) => setTimeout(r, 1100));
    const res = await t.http().post('/terminals/SC-0001/allocations').set(SCENARIO_OP).send({ merchantCode: 'GANGNAM-KIMBAP', expectedVersion: t1.version });
    expect(res.status).toBe(201);
    const t2 = await terminal('SC-0001');
    expect(t2.statusChangedAt.getTime()).toBeGreaterThan(t1.statusChangedAt.getTime() + 1000);
    expect(Math.abs(t2.statusChangedAt.getTime() - (await lastHistory('SC-0001')).occurredAt.getTime())).toBeLessThan(1000);
  });

  it('거절된 전이(422)는 시각을 바꾸지 않는다', async () => {
    const before = await terminal('SC-0001');
    const res = await t.http().post('/terminals/SC-0001/transitions').set(SCENARIO_OP).send({ to: 'DISPOSED', reason: 'x', expectedVersion: before.version });
    expect(res.status).toBe(422);
    expect((await terminal('SC-0001')).statusChangedAt.getTime()).toBe(before.statusChangedAt.getTime());
  });
});
```

`apps/api/test/anomaly.e2e.spec.ts`(새):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { UniqueConstraintViolationException } from '@mikro-orm/mysql';
import { Anomaly, AnomalyRule as R } from '../src/anomaly/anomaly.entity.js';
import { AnomalyService } from '../src/anomaly/anomaly.service.js';
import { DAY_MS } from '../src/config/env-number.js';
import { DeviceConnectivity } from '../src/device/device-connectivity.entity.js';
import { RedisLock } from '../src/redis/redis-lock.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus as S } from '../src/terminal/terminal-status.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { insertTerminals } from './helpers/terminals.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'lee' };
/** 기준 시각(고정). 규칙의 경과일은 이 시각에서 센다 */
const NOW = new Date('2026-10-26T00:00:00.000Z');
const daysAgo = (d: number, from = NOW) => new Date(from.getTime() - d * DAY_MS);

describe('이상 단말기 찾기 (F4, decisions/0034)', () => {
  let t: TestApp;
  let svc: AnomalyService;
  let ids: Map<string, number>;
  const em = () => t.orm.em.fork();
  const openRows = () => em().find(Anomaly, { resolvedAt: null }, { orderBy: { terminalId: 'asc', rule: 'asc' } });
  const serialOf = (terminalId: number) => [...ids].find(([, id]) => id === terminalId)![0];

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    svc = t.app.get(AnomalyService);
    ids = await insertTerminals(t, [
      { serialNo: 'AN-01', status: S.DELIVERED, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(8) }, // 배송 완료 8일
      { serialNo: 'AN-02', status: S.DELIVERED, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(6) }, // 6일 — 아님
      { serialNo: 'AN-03', status: S.RETURN_REQUESTED, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(15) },
      { serialNo: 'AN-04', status: S.RETURNING, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(15) },
      { serialNo: 'AN-05', status: S.RETURNING, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(13) }, // 13일 — 아님
      { serialNo: 'AN-06', status: S.SHIPPED, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(11) },
      { serialNo: 'AN-07', status: S.ALLOCATED, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(4) },
      { serialNo: 'AN-08', status: S.IN_SERVICE, merchantCode: null, statusChangedAt: daysAgo(1) }, // 가맹점 없음
      { serialNo: 'AN-09', status: S.IN_SERVICE, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(30) }, // 오프라인 4일
      { serialNo: 'AN-10', status: S.IN_SERVICE, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(30) }, // 오프라인 2일 — 아님
      { serialNo: 'AN-11', status: S.RETURNED, merchantCode: null, statusChangedAt: daysAgo(1) }, // 오프라인 10일이지만 운영 중 아님
      { serialNo: 'AN-12', status: S.IN_STOCK, statusChangedAt: daysAgo(100) }, // 재고는 규칙 없음
    ]);
    const conn = (serialNo: string, online: boolean, lastSeenDays: number) => ({
      terminalId: ids.get(serialNo)!,
      online,
      lastSeenAt: daysAgo(lastSeenDays),
      firmwareVersion: '1.0.0',
      changedAt: daysAgo(lastSeenDays),
    });
    await em().insertMany(DeviceConnectivity, [conn('AN-09', false, 4), conn('AN-10', false, 2), conn('AN-11', false, 10)]);
  });
  afterAll(async () => {
    await deleteTestKeys(t.app.get<Redis>(REDIS));
    await t.app.close();
  });

  it('여섯 규칙에 걸린 단말기를 찾아 열린 이상으로 남긴다(기준일 미만·운영 중 아님·재고는 아님)', async () => {
    const r = await svc.scan(NOW);
    expect(r).toMatchObject({ detected: 7, continuing: 0, resolved: 0 });
    expect(r.open).toEqual({
      [R.DELIVERED_NOT_INSTALLED]: 1,
      [R.RETURN_STALLED]: 2,
      [R.SHIPPED_TOO_LONG]: 1,
      [R.ALLOCATED_NO_SHIPMENT]: 1,
      [R.IN_SERVICE_NO_MERCHANT]: 1,
      [R.OFFLINE_TOO_LONG]: 1,
    });
    const rows = await openRows();
    expect(rows.map((a) => [serialOf(a.terminalId), a.rule])).toEqual([
      ['AN-01', R.DELIVERED_NOT_INSTALLED],
      ['AN-03', R.RETURN_STALLED],
      ['AN-04', R.RETURN_STALLED],
      ['AN-06', R.SHIPPED_TOO_LONG],
      ['AN-07', R.ALLOCATED_NO_SHIPMENT],
      ['AN-08', R.IN_SERVICE_NO_MERCHANT],
      ['AN-09', R.OFFLINE_TOO_LONG],
    ]);
    const an01 = rows[0];
    expect(an01.detectedAt.getTime()).toBe(NOW.getTime());
    expect(an01.lastSeenAt.getTime()).toBe(NOW.getTime());
    // 원시 SQL datetime을 UTC로 읽었는지(troubleshooting/0016): since가 정확히 8일 전
    expect(an01.detail).toEqual({ status: 'DELIVERED', since: daysAgo(8).toISOString(), days: 8 });
    expect(rows.at(-1)!.detail).toEqual({ lastSeenAt: daysAgo(4).toISOString(), days: 4 });
  });

  it('다시 찾으면 계속 걸린 것은 last_seen_at만, 풀린 것은 resolved_at, 다시 걸리면 새 행(닫힌 행과 겹쳐도 됨)', async () => {
    const later = new Date(NOW.getTime() + 3_600_000);
    expect(await svc.scan(later)).toMatchObject({ detected: 0, continuing: 7, resolved: 0 });
    expect((await openRows())[0].lastSeenAt.getTime()).toBe(later.getTime());

    // AN-01 설치됨 → 풀림
    await em().nativeUpdate(Terminal, { serialNo: 'AN-01' }, { status: S.IN_SERVICE, statusChangedAt: later });
    const evenLater = new Date(later.getTime() + 3_600_000);
    expect(await svc.scan(evenLater)).toMatchObject({ detected: 0, continuing: 6, resolved: 1 });
    const closed = await em().findOneOrFail(Anomaly, { terminalId: ids.get('AN-01')!, rule: R.DELIVERED_NOT_INSTALLED });
    expect(closed.resolvedAt?.getTime()).toBe(evenLater.getTime());

    // 다시 배송 완료 상태로 오래 → 같은 (단말기, 규칙)의 새 열린 행
    await em().nativeUpdate(Terminal, { serialNo: 'AN-01' }, { status: S.DELIVERED, statusChangedAt: daysAgo(9) });
    expect(await svc.scan(evenLater)).toMatchObject({ detected: 1, resolved: 0 });
    expect(await em().count(Anomaly, { terminalId: ids.get('AN-01')!, rule: R.DELIVERED_NOT_INSTALLED })).toBe(2);
  });

  it('열린 이상은 (단말기, 규칙)마다 하나뿐이다(부분 unique 함수 인덱스)', async () => {
    const row = { terminalId: ids.get('AN-03')!, rule: R.RETURN_STALLED, detectedAt: NOW, lastSeenAt: NOW, resolvedAt: null, detail: {} };
    await expect(em().insert(Anomaly, row)).rejects.toBeInstanceOf(UniqueConstraintViolationException);
    // 닫힌 행은 몇 개든 된다
    await em().insert(Anomaly, { ...row, resolvedAt: NOW });
    await em().insert(Anomaly, { ...row, resolvedAt: NOW });
  });

  it('GET /anomalies: 규칙·열림 조건과 afterId 페이지, 단말기 시리얼·지금 상태를 붙인다', async () => {
    const stalled = await t.http().get('/anomalies?rule=RETURN_STALLED&open=true');
    expect(stalled.status).toBe(200);
    expect(stalled.body.items.map((a: { serialNo: string; status: string }) => [a.serialNo, a.status])).toEqual([
      ['AN-03', 'RETURN_REQUESTED'],
      ['AN-04', 'RETURNING'],
    ]);
    expect(stalled.body.nextAfterId).toBeNull();
    const p1 = await t.http().get('/anomalies?open=true&limit=3');
    expect(p1.body.items).toHaveLength(3);
    const p2 = await t.http().get(`/anomalies?open=true&limit=3&afterId=${p1.body.nextAfterId}`);
    expect(p2.body.items[0].id).toBeGreaterThan(p1.body.nextAfterId);
    const closed = await t.http().get('/anomalies?open=false&rule=DELIVERED_NOT_INSTALLED');
    expect(closed.body.items[0]).toMatchObject({ serialNo: 'AN-01', resolvedAt: expect.any(String) });
    expect((await t.http().get('/anomalies?rule=NOPE')).status).toBe(400);
  });

  it('POST /anomaly-scans: 수동 찾기(지금 시각), 다른 찾기가 돌고 있으면 409 ANOMALY_SCAN_RUNNING', async () => {
    const res = await t.http().post('/anomaly-scans').set(OP);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ detected: expect.any(Number), continuing: expect.any(Number), resolved: expect.any(Number) });
    const lock = t.app.get(RedisLock);
    const key = lock.keyOf('job-lock', 'anomaly-scan');
    const token = await lock.acquire(key, 10_000);
    try {
      const busy = await t.http().post('/anomaly-scans').set(OP);
      expect(busy.status).toBe(409);
      expect(busy.body.code).toBe('ANOMALY_SCAN_RUNNING');
    } finally {
      await lock.release(key, token!);
    }
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/status-changed-at.e2e.spec.ts test/anomaly.e2e.spec.ts`
Expected: anomaly는 `Cannot find module '../src/anomaly/anomaly.entity.js'`로 로드 실패, status-changed-at은 2개 모두 `TypeError: Cannot read properties of undefined (reading 'getTime')`(statusChangedAt이 없다). `Test Files 2 failed (2)`.

- [ ] **Step 3: 구현 — status_changed_at**

`apps/api/src/terminal/terminal.entity.ts`:
```diff
--- a/apps/api/src/terminal/terminal.entity.ts
+++ b/apps/api/src/terminal/terminal.entity.ts
@@ -5,10 +5,14 @@ import { PurchaseOrder } from '../purchase-order/purchase-order.entity.js';
 import { TerminalModel } from './terminal-model.entity.js';
 import { TerminalStatus } from './terminal-status.js';
 
+/**
+ * (status, status_changed_at) 복합 인덱스: "어떤 상태로 N일 넘게 있는 단말기"(이상 단말기 찾기, F4)를 범위 하나로 찾는다.
+ * status 하나만으로 찾는 쿼리(운영 중 단말기 목록 등)도 이 인덱스의 앞부분을 쓴다 — 그래서 status 단독 인덱스는 없앴다(decisions/0034).
+ */
 @Entity({ tableName: 'terminal' })
-@Index({ properties: ['status'] })
+@Index({ properties: ['status', 'statusChangedAt'] })
 export class Terminal {
-  [OptionalProps]?: 'status' | 'version' | 'createdAt' | 'updatedAt';
+  [OptionalProps]?: 'status' | 'statusChangedAt' | 'version' | 'createdAt' | 'updatedAt';
 
   @PrimaryKey()
   id!: number;
@@ -31,6 +35,13 @@ export class Terminal {
   @Enum({ items: () => TerminalStatus })
   status: TerminalStatus = TerminalStatus.RECEIVED;
 
+  /**
+   * 지금 상태가 된 시각. 전이 서비스가 상태와 같은 UPDATE에서 바꾸고, 같은 값을 이력 occurred_at에 쓴다(decisions/0034).
+   * updatedAt은 가맹점·version 등 다른 변경에도 바뀌어 "그 상태가 된 시각"으로 쓸 수 없다.
+   */
+  @Property({ type: 'datetime', length: 3 })
+  statusChangedAt: Date = new Date();
+
   /** 낙관적 락. flush할 때 WHERE version = ? 로 확인하고 1 올린다. */
   @Property({ version: true })
   version!: number;
```

`apps/api/src/terminal/transition.service.ts`:
```diff
--- a/apps/api/src/terminal/transition.service.ts
+++ b/apps/api/src/terminal/transition.service.ts
@@ -54,7 +54,10 @@ export class TransitionService {
       if (!check.ok) throw new InvalidTransitionError(check.reason);
 
       const from = terminal.status;
+      const now = new Date();
       terminal.status = cmd.to;
+      // 상태가 된 시각은 상태와 같은 UPDATE로(이상 단말기 찾기의 기준, decisions/0034). 이력에도 같은 시각을 쓴다.
+      terminal.statusChangedAt = now;
       cmd.mutate?.(terminal);
       // version 검사 UPDATE를 이력 INSERT보다 먼저 보낸다. INSERT가 먼저면 FK 검사의 공유 락끼리 엉켜 데드락이 난다(troubleshooting/0004).
       await tx.flush();
@@ -65,6 +68,7 @@ export class TransitionService {
         source: cmd.source,
         actor: cmd.actor,
         reason: cmd.reason,
+        occurredAt: now,
       });
       this.recordOutbox(tx, terminal, from, cmd);
       return terminal;
@@ -87,8 +91,11 @@ export class TransitionService {
       checkTransition(it.terminal.status, it.to, ctx.source, { requiresReinspection: it.terminal.model.requiresReinspection }),
     );
     const from = items.map((it) => it.terminal.status);
+    const now = new Date();
     items.forEach((it, i) => {
-      if (checks[i].ok) it.terminal.status = it.to;
+      if (!checks[i].ok) return;
+      it.terminal.status = it.to;
+      it.terminal.statusChangedAt = now;
     });
     // UPDATE를 이력 INSERT보다 먼저 보낸다(troubleshooting/0004).
     await tx.flush();
@@ -101,6 +108,7 @@ export class TransitionService {
         source: ctx.source,
         actor: ctx.actor,
         reason: it.reason,
+        occurredAt: now,
       });
       this.recordOutbox(tx, it.terminal, from[i], { to: it.to, source: ctx.source, actor: ctx.actor, reason: it.reason });
     });
@@ -125,6 +133,7 @@ export class TransitionService {
       source,
       actor,
       reason,
+      occurredAt: terminal.statusChangedAt,
     });
     this.recordOutbox(em, terminal, null, { to: terminal.status, source, actor, reason });
     return history;
```

- [ ] **Step 4: insertMany 헬퍼 실패 재현 (troubleshooting/0022, 계획한 재현)**

Run: `npx vitest run test/connectivity.e2e.spec.ts 2>&1 | grep -E "Exception|Tests "`
Expected: `NotNullConstraintViolationException: Field 'status_changed_at' doesn't have a default value`, `Tests  10 passed | 2 skipped (12)`(묶음 이벤트 describe의 beforeAll이 `em.insertMany(Terminal, …)`로 단말기 120대를 넣다 실패). 고치기 전에 `docs/troubleshooting/0022-insertMany는-엔티티-기본값을-쓰지-않아-새-NOT-NULL-열에서-실패.md`를 시작한다(증상 그대로, 가설: ① 마이그레이션이 아직 안 돼서 ② insertMany가 엔티티 필드 초기값(`statusChangedAt = new Date()`)을 쓰지 않아서 — 테스트는 `resetDatabase`가 엔티티로 스키마를 만들므로 ①이 아니다. 같은 테스트의 다른 단말기(`em.create` + flush)는 들어갔다 → ②).

그다음 직접 INSERT하는 곳 네 곳에 값을 넣는다(`test/helpers/terminals.ts`는 Step 1에서 이미 넣음):
```diff
--- a/apps/api/test/helpers/device-fleet.ts
+++ b/apps/api/test/helpers/device-fleet.ts
@@ -29,6 +29,7 @@ export async function seedInService(t: TestApp, prefix: string, count: number, m
         model,
         merchant,
         status: TerminalStatus.IN_SERVICE,
+        statusChangedAt: now,
         version: 1,
         createdAt: now,
         updatedAt: now,
```
```diff
--- a/apps/api/test/connectivity.e2e.spec.ts
+++ b/apps/api/test/connectivity.e2e.spec.ts
@@ -228,7 +228,7 @@ describe('접속 상태 — 오프라인 판정·스냅샷·조회 (F8, decision
       const model = await e.findOneOrFail(TerminalModel, { code: 'SN-100' });
       await e.insertMany(
         Terminal,
-        many.map((serialNo) => ({ serialNo, model: model.id, status: TerminalStatus.IN_SERVICE, version: 1, createdAt: new Date(), updatedAt: new Date() })),
+        many.map((serialNo) => ({ serialNo, model: model.id, status: TerminalStatus.IN_SERVICE, statusChangedAt: new Date(), version: 1, createdAt: new Date(), updatedAt: new Date() })),
       );
       await t.app.get(ActiveSetService).rebuild();
     });
```
```diff
--- a/apps/api/test/experiments/device-jobs-timing.spec.ts
+++ b/apps/api/test/experiments/device-jobs-timing.spec.ts
@@ -50,7 +50,7 @@ describe(`실험 0010 — device 큐 job 시간 (단말기 ${N}대)`, () => {
     for (let i = 0; i < N; i += 1000) {
       await em.insertMany(
         Terminal,
-        serials.slice(i, i + 1000).map((serialNo) => ({ serialNo, model: model.id, status: TerminalStatus.IN_SERVICE, version: 1, createdAt: new Date(), updatedAt: new Date() })),
+        serials.slice(i, i + 1000).map((serialNo) => ({ serialNo, model: model.id, status: TerminalStatus.IN_SERVICE, statusChangedAt: new Date(), version: 1, createdAt: new Date(), updatedAt: new Date() })),
       );
     }
     await t.app.get(ActiveSetService).rebuild();
```

Run: `npx vitest run test/connectivity.e2e.spec.ts test/status-changed-at.e2e.spec.ts`
Expected: `Tests  14 passed (14)`.

- [ ] **Step 5: 구현 — 이상 단말기**

`apps/api/src/anomaly/anomaly.entity.ts`(새):
```ts
import { OptionalProps } from '@mikro-orm/core';
import { Entity, Enum, Index, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';

/** 이상 단말기 규칙(F4). 기준일은 env(ANOMALY_*_DAYS)로 바꾼다 */
export enum AnomalyRule {
  /** 배송 완료(DELIVERED)가 된 지 N일(기본 7) 넘게 설치(IN_SERVICE)되지 않음 */
  DELIVERED_NOT_INSTALLED = 'DELIVERED_NOT_INSTALLED',
  /** 회수 요청·회수 중(RETURN_REQUESTED·RETURNING)이 N일(기본 14) 넘음 */
  RETURN_STALLED = 'RETURN_STALLED',
  /** 출고(SHIPPED)가 N일(기본 10) 넘음 — 배송 완료가 반영되지 않음 */
  SHIPPED_TOO_LONG = 'SHIPPED_TOO_LONG',
  /** 배정(ALLOCATED)이 N일(기본 3) 넘었는데 출고 없음 */
  ALLOCATED_NO_SHIPMENT = 'ALLOCATED_NO_SHIPMENT',
  /** 운영 중인데 가맹점 없음 */
  IN_SERVICE_NO_MERCHANT = 'IN_SERVICE_NO_MERCHANT',
  /** 운영 중인데 마지막 하트비트가 N일(기본 3) 넘게 전(device_connectivity가 오프라인) */
  OFFLINE_TOO_LONG = 'OFFLINE_TOO_LONG',
}

/**
 * 이상 단말기 한 건(F4). 규칙에 걸린 동안 열려 있고(resolved_at null), 조건이 풀리면 닫힌다.
 * 열린 이상은 (단말기, 규칙)마다 하나 — MySQL에는 부분 unique가 없어 MikroORM이
 * `unique((case when resolved_at is null then terminal_id end), (case when resolved_at is null then rule end))` 함수 인덱스로 흉내 낸다
 * (닫힌 행은 두 값이 NULL이라 서로 겹쳐도 된다, decisions/0034). 같은 단말기가 다시 걸리면 새 행이 생긴다(이력).
 * terminal_id에 외래키를 두지 않는다 — 찾기 job이 수천 행을 한 번에 넣을 때 단말기 행마다 FK 검사 S 락을 걸지 않게(device_connectivity와 같은 이유).
 */
@Entity({ tableName: 'anomaly' })
@Unique({ name: 'anomaly_open_unique', properties: ['terminalId', 'rule'], where: { resolvedAt: null } })
@Index({ properties: ['resolvedAt', 'rule'] })
export class Anomaly {
  [OptionalProps]?: 'resolvedAt';

  @PrimaryKey()
  id!: number;

  /** terminal.id */
  @Property({ unsigned: true })
  terminalId!: number;

  @Enum({ items: () => AnomalyRule })
  rule!: AnomalyRule;

  /** 처음 걸린 찾기 시각 */
  @Property({ type: 'datetime', length: 3 })
  detectedAt!: Date;

  /** 마지막으로 걸린 찾기 시각(계속 걸려 있으면 매 실행 갱신) */
  @Property({ type: 'datetime', length: 3 })
  lastSeenAt!: Date;

  /** 조건이 풀린 찾기 시각. null이면 열린 이상 */
  @Property({ type: 'datetime', length: 3, nullable: true })
  resolvedAt: Date | null = null;

  /** 걸렸을 때의 값(상태, 그 상태가 된 시각, 마지막 하트비트 등) */
  @Property({ type: 'json' })
  detail!: Record<string, unknown>;
}
```

`apps/api/src/anomaly/anomaly-rules.ts`(새):
```ts
import type { EntityManager } from '@mikro-orm/mysql';
import { fromDbDatetime } from '../common/db-datetime.js';
import { env } from '../config/env.js';
import { DAY_MS } from '../config/env-number.js';
import { TerminalStatus as S } from '../terminal/terminal-status.js';
import { AnomalyRule } from './anomaly.entity.js';

/** 규칙별 기준일 */
export type AnomalyThresholds = typeof env.anomalyDays;

/** 규칙에 걸린 단말기 한 대 */
export interface AnomalyMatch {
  terminalId: number;
  serialNo: string;
  rule: AnomalyRule;
  detail: Record<string, unknown>;
}

/** "어떤 상태로 N일 넘게 있음" 규칙: 규칙 → (상태들, 기준일) */
function ageRules(d: AnomalyThresholds): { rule: AnomalyRule; statuses: S[]; days: number }[] {
  return [
    { rule: AnomalyRule.DELIVERED_NOT_INSTALLED, statuses: [S.DELIVERED], days: d.deliveredNotInstalled },
    { rule: AnomalyRule.RETURN_STALLED, statuses: [S.RETURN_REQUESTED, S.RETURNING], days: d.returnStalled },
    { rule: AnomalyRule.SHIPPED_TOO_LONG, statuses: [S.SHIPPED], days: d.shippedTooLong },
    // 배정 → 출고는 출고 API만 하고(SHIPMENT 출처), 출고하면 SHIPPED가 된다. 그래서 ALLOCATED로 N일 = "배정 뒤 출고 없음"
    { rule: AnomalyRule.ALLOCATED_NO_SHIPMENT, statuses: [S.ALLOCATED], days: d.allocatedNoShipment },
  ];
}

/**
 * 지금 규칙에 걸린 단말기를 모두 찾는다(F4, decisions/0034). 규칙마다 SQL 한 문장, 기준 시각은 앱에서 계산해 넘긴다
 * (SQL의 NOW()는 세션 시간대(SYSTEM=KST)라 UTC로 저장한 값과 비교하면 9시간 어긋난다, troubleshooting/0016).
 * - 상태 경과 규칙: `terminal (status, status_changed_at)` 인덱스 범위 하나(상태가 여럿이면 범위 여럿)
 * - 가맹점 없음: 같은 인덱스의 status 앞부분 + merchant_id 확인
 * - 오프라인: device_connectivity(offline이고 마지막 하트비트가 기준보다 전) ⟶ terminal PK, 운영 중만
 * 결과는 (terminalId, rule) 순서.
 */
export async function findAnomalies(em: EntityManager, now: Date, d: AnomalyThresholds = env.anomalyDays): Promise<AnomalyMatch[]> {
  const out: AnomalyMatch[] = [];
  const days = (since: Date) => Math.floor((now.getTime() - since.getTime()) / DAY_MS);
  for (const r of ageRules(d)) {
    const cutoff = new Date(now.getTime() - r.days * DAY_MS);
    const rows = await em.execute<{ id: number; serial_no: string; status: S; status_changed_at: string }[]>(
      `select id, serial_no, status, status_changed_at from terminal
        where status in (${r.statuses.map(() => '?').join(', ')}) and status_changed_at < ?`,
      [...r.statuses, cutoff],
    );
    for (const row of rows) {
      const since = fromDbDatetime(row.status_changed_at);
      out.push({ terminalId: row.id, serialNo: row.serial_no, rule: r.rule, detail: { status: row.status, since: since.toISOString(), days: days(since) } });
    }
  }
  const noMerchant = await em.execute<{ id: number; serial_no: string; status_changed_at: string }[]>(
    `select id, serial_no, status_changed_at from terminal where status = 'IN_SERVICE' and merchant_id is null`,
  );
  for (const row of noMerchant) {
    out.push({
      terminalId: row.id,
      serialNo: row.serial_no,
      rule: AnomalyRule.IN_SERVICE_NO_MERCHANT,
      detail: { status: S.IN_SERVICE, since: fromDbDatetime(row.status_changed_at).toISOString() },
    });
  }
  const offline = await em.execute<{ id: number; serial_no: string; last_seen_at: string }[]>(
    `select t.id, t.serial_no, c.last_seen_at
       from device_connectivity c join terminal t on t.id = c.terminal_id
      where c.online = 0 and c.last_seen_at < ? and t.status = 'IN_SERVICE'`,
    [new Date(now.getTime() - d.offlineTooLong * DAY_MS)],
  );
  for (const row of offline) {
    const lastSeen = fromDbDatetime(row.last_seen_at);
    out.push({ terminalId: row.id, serialNo: row.serial_no, rule: AnomalyRule.OFFLINE_TOO_LONG, detail: { lastSeenAt: lastSeen.toISOString(), days: days(lastSeen) } });
  }
  return out.sort((a, b) => a.terminalId - b.terminalId || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}
```

`apps/api/src/anomaly/anomaly.service.ts`(새):
```ts
import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { RedisLock } from '../redis/redis-lock.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { Anomaly, AnomalyRule } from './anomaly.entity.js';
import { findAnomalies, type AnomalyMatch, type AnomalyThresholds } from './anomaly-rules.js';

/** 찾기 잠금 유지 시간. 찾기 한 번이 이보다 길면 다른 찾기가 겹칠 수 있다(겹쳐도 열린 이상 unique가 막는다) */
const SCAN_LOCK_TTL_MS = 5 * 60_000;

/** PK IN (…) 갱신·INSERT 한 문장의 행 수 */
const CHUNK = 500;

export interface ScanResult {
  /** 새로 걸린 이상 */
  detected: number;
  /** 계속 걸려 있는 이상(last_seen_at 갱신) */
  continuing: number;
  /** 조건이 풀려 닫은 이상 */
  resolved: number;
  /** 찾기가 끝난 뒤 열린 이상 수(규칙별) */
  open: Partial<Record<AnomalyRule, number>>;
  /** 새로 걸린 이상(알림용) */
  newMatches: AnomalyMatch[];
}

const keyOf = (m: { terminalId: number; rule: AnomalyRule }) => `${m.terminalId}:${m.rule}`;

/**
 * 이상 단말기 찾기(F4, decisions/0034). 규칙 SQL로 지금 걸린 단말기를 모두 구하고 열린 이상과 비교해
 * ① 새로 걸린 것 INSERT ② 계속 걸린 것 last_seen_at ③ 풀린 것 resolved_at — 셋 다 한 트랜잭션, 갱신은 PK `IN (…)`
 * (보조 인덱스 범위 UPDATE의 gap 락을 피함, troubleshooting/0014). Redis 잠금으로 한 번에 하나만 돈다.
 */
@Injectable()
export class AnomalyService {
  private readonly logger = new Logger(AnomalyService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly lock: RedisLock,
  ) {}

  /** 찾기 한 번. 다른 찾기가 돌고 있으면 409 ANOMALY_SCAN_RUNNING */
  async scan(now = new Date(), thresholds?: AnomalyThresholds): Promise<ScanResult> {
    const key = this.lock.keyOf('job-lock', 'anomaly-scan');
    const token = await this.lock.acquire(key, SCAN_LOCK_TTL_MS);
    if (!token) throw new BusinessError(409, 'ANOMALY_SCAN_RUNNING', '이상 단말기 찾기가 이미 돌고 있습니다.');
    try {
      return await this.scanLocked(now, thresholds);
    } finally {
      await this.lock.release(key, token).catch((error: unknown) => this.logger.warn(`잠금 해제 실패 anomaly-scan: ${String(error)}`));
    }
  }

  private async scanLocked(now: Date, thresholds?: AnomalyThresholds): Promise<ScanResult> {
    const em = this.em.fork();
    const matches = await findAnomalies(em, now, thresholds);
    const open = await em.find(Anomaly, { resolvedAt: null }, { fields: ['id', 'terminalId', 'rule'], orderBy: { id: 'asc' } });
    const openByKey = new Map(open.map((a) => [keyOf(a), a.id]));
    const matchKeys = new Set(matches.map(keyOf));
    const newMatches = matches.filter((m) => !openByKey.has(keyOf(m)));
    const continuing = open.filter((a) => matchKeys.has(keyOf(a))).map((a) => a.id);
    const resolved = open.filter((a) => !matchKeys.has(keyOf(a))).map((a) => a.id);

    await em.transactional(async (tx) => {
      for (let i = 0; i < newMatches.length; i += CHUNK) {
        await tx.insertMany(
          Anomaly,
          newMatches.slice(i, i + CHUNK).map((m) => ({ terminalId: m.terminalId, rule: m.rule, detectedAt: now, lastSeenAt: now, resolvedAt: null, detail: m.detail })),
        );
      }
      for (let i = 0; i < continuing.length; i += CHUNK) {
        await tx.nativeUpdate(Anomaly, { id: { $in: continuing.slice(i, i + CHUNK) }, resolvedAt: null }, { lastSeenAt: now });
      }
      for (let i = 0; i < resolved.length; i += CHUNK) {
        await tx.nativeUpdate(Anomaly, { id: { $in: resolved.slice(i, i + CHUNK) }, resolvedAt: null }, { resolvedAt: now });
      }
    });

    const openNow: Partial<Record<AnomalyRule, number>> = {};
    for (const m of matches) openNow[m.rule] = (openNow[m.rule] ?? 0) + 1;
    if (newMatches.length + resolved.length > 0) {
      this.logger.log(`이상 단말기 찾기: 새로 ${newMatches.length}, 계속 ${continuing.length}, 풀림 ${resolved.length}`);
    }
    return { detected: newMatches.length, continuing: continuing.length, resolved: resolved.length, open: openNow, newMatches };
  }

  /** 이상 목록 한 페이지(id 순, afterId 뒤부터). 단말기 시리얼·지금 상태를 붙인다 */
  async list(q: { rule?: AnomalyRule; open?: boolean; afterId?: number; limit: number }) {
    const em = this.em.fork();
    const rows = await em.find(
      Anomaly,
      {
        id: { $gt: q.afterId ?? 0 },
        ...(q.rule ? { rule: q.rule } : {}),
        ...(q.open === undefined ? {} : q.open ? { resolvedAt: null } : { resolvedAt: { $ne: null } }),
      },
      { orderBy: { id: 'asc' }, limit: q.limit + 1 },
    );
    const page = rows.slice(0, q.limit);
    const terminals = new Map(
      (await em.find(Terminal, { id: { $in: [...new Set(page.map((a) => a.terminalId))] } }, { fields: ['id', 'serialNo', 'status'] })).map((t) => [t.id, t]),
    );
    return {
      items: page.map((a) => ({
        id: a.id,
        serialNo: terminals.get(a.terminalId)?.serialNo ?? null,
        status: terminals.get(a.terminalId)?.status ?? null,
        rule: a.rule,
        detectedAt: a.detectedAt.toISOString(),
        lastSeenAt: a.lastSeenAt.toISOString(),
        resolvedAt: a.resolvedAt?.toISOString() ?? null,
        detail: a.detail,
      })),
      nextAfterId: rows.length > q.limit ? page.at(-1)!.id : null,
    };
  }
}
```

`apps/api/src/anomaly/dto/list-anomalies.query.ts`(새):
```ts
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AnomalyRule } from '../anomaly.entity.js';

/** GET /anomalies 조건. 페이지는 afterId(키셋, decisions/0033과 같은 이유) */
export class ListAnomaliesQuery {
  @IsOptional()
  @IsEnum(AnomalyRule)
  rule?: AnomalyRule;

  /** true: 열린 이상만, false: 닫힌 이상만, 없으면 둘 다 */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  open?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;
}
```

`apps/api/src/anomaly/anomaly.controller.ts`(새):
```ts
import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { ListAnomaliesQuery } from './dto/list-anomalies.query.js';
import { AnomalyService } from './anomaly.service.js';

/** 이상 단말기(F4). 찾기는 주기 작업(일 1회)이 하고, 운영자가 바로 돌릴 수도 있다. */
@Controller()
export class AnomalyController {
  constructor(private readonly anomalies: AnomalyService) {}

  @Get('anomalies')
  async list(@Query() query: ListAnomaliesQuery) {
    return this.anomalies.list(query);
  }

  /** 수동 찾기(동기). 다른 찾기가 돌고 있으면 409 ANOMALY_SCAN_RUNNING */
  @Post('anomaly-scans')
  @HttpCode(200)
  async scan(@Operator() _actor: string) {
    const { newMatches, ...summary } = await this.anomalies.scan();
    return { ...summary, newSerials: newMatches.slice(0, 100).map((m) => m.serialNo) };
  }
}
```

`apps/api/src/anomaly/anomaly.module.ts`(새):
```ts
import { Module } from '@nestjs/common';
import { AnomalyController } from './anomaly.controller.js';
import { AnomalyService } from './anomaly.service.js';

/** 이상 단말기 찾기(F4). 잠금은 전역 RedisModule의 RedisLock */
@Module({
  controllers: [AnomalyController],
  providers: [AnomalyService],
  exports: [AnomalyService],
})
export class AnomalyModule {}
```

`apps/api/src/config/env.ts`, `apps/api/src/app.module.ts`, `apps/api/src/entities.ts`:
```diff
--- a/apps/api/src/config/env.ts
+++ b/apps/api/src/config/env.ts
@@ -26,6 +26,8 @@ const PORT = { min: 0, max: 65_535 };
 const MS = { min: 1, max: DAY_MS };
 /** 초당 횟수·개수 */
 const COUNT = { min: 1, max: 100_000 };
+/** 기준일 */
+const DAYS = { min: 1, max: 365 };
 
 export const env = {
   port: intFromEnv('API_PORT', 3000, PORT),
@@ -87,6 +89,14 @@ export const env = {
   vanRunStaleMs: intFromEnv('VAN_RUN_STALE_MS', 3_600_000, MS),
   /** 재검증 때 브릿지VAN 단건 조회를 동시에 몇 개까지 보내나 */
   vanReverifyConcurrency: intFromEnv('VAN_REVERIFY_CONCURRENCY', 8, { min: 1, max: 64 }),
+  /** 이상 단말기 찾기(F4) 규칙의 기준일(decisions/0034) */
+  anomalyDays: {
+    deliveredNotInstalled: intFromEnv('ANOMALY_DELIVERED_DAYS', 7, DAYS),
+    returnStalled: intFromEnv('ANOMALY_RETURN_STALLED_DAYS', 14, DAYS),
+    shippedTooLong: intFromEnv('ANOMALY_SHIPPED_DAYS', 10, DAYS),
+    allocatedNoShipment: intFromEnv('ANOMALY_ALLOCATED_DAYS', 3, DAYS),
+    offlineTooLong: intFromEnv('ANOMALY_OFFLINE_DAYS', 3, DAYS),
+  },
   /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
   workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
 };
```
```diff
--- a/apps/api/src/app.module.ts
+++ b/apps/api/src/app.module.ts
@@ -18,6 +18,7 @@ import { ServiceModule } from './service/service.module.js';
 import { DeviceModule } from './device/device.module.js';
 import { FirmwareModule } from './firmware/firmware.module.js';
 import { VanModule } from './van/van.module.js';
+import { AnomalyModule } from './anomaly/anomaly.module.js';
 import { WorkersModule } from './workers/workers.module.js';
 import { SchedulerModule } from './scheduler/scheduler.module.js';
 
@@ -46,6 +47,7 @@ export interface AppOptions {
     DeviceModule,
     FirmwareModule,
     VanModule,
+    AnomalyModule,
   ],
   controllers: [HealthController],
   providers: [
```
```diff
--- a/apps/api/src/entities.ts
+++ b/apps/api/src/entities.ts
@@ -12,6 +12,7 @@ import { ServiceTicket } from './service/service-ticket.entity.js';
 import { DeviceConnectivity } from './device/device-connectivity.entity.js';
 import { Firmware, FirmwareRollout, FirmwareRolloutTarget } from './firmware/firmware.entities.js';
 import { VanReconciliationItem, VanReconciliationRun, VanRegistrationSnapshot } from './van/van.entities.js';
+import { Anomaly } from './anomaly/anomaly.entity.js';
 
 /** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
-export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch, ServiceTicket, DeviceConnectivity, Firmware, FirmwareRollout, FirmwareRolloutTarget, VanReconciliationRun, VanRegistrationSnapshot, VanReconciliationItem];
+export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch, ServiceTicket, DeviceConnectivity, Firmware, FirmwareRollout, FirmwareRolloutTarget, VanReconciliationRun, VanRegistrationSnapshot, VanReconciliationItem, Anomaly];
```

`.env.example` 끝에:
```
# 이상 단말기 찾기(F4) 기준일 — decisions/0034
ANOMALY_DELIVERED_DAYS=7
ANOMALY_RETURN_STALLED_DAYS=14
ANOMALY_SHIPPED_DAYS=10
ANOMALY_ALLOCATED_DAYS=3
ANOMALY_OFFLINE_DAYS=3
```

- [ ] **Step 6: 통과 확인**

Run: `npx vitest run test/anomaly.e2e.spec.ts test/status-changed-at.e2e.spec.ts`
Expected: `Tests  7 passed (7)`. 첫 테스트의 `detail.since`가 정확히 8일 전 ISO 글자인 것이 원시 datetime을 UTC로 읽었다는 확인이다(troubleshooting/0016).

- [ ] **Step 7: 마이그레이션(손으로 고침)**

Run: `npm run db:migration:create`
생성된 파일의 terminal 부분은 `drop index terminal_status_index` → `add status_changed_at datetime(3) not null` → `add index …` 순서다. 그대로 적용하면 행이 있는 개발 DB에서 `ERROR 1292 (22007): Incorrect datetime value: '0000-00-00 00:00:00' for column 'status_changed_at' at row 1`(사전 검증). up()을 아래와 같이 고친다(anomaly 세 줄은 생성된 그대로, down()도 생성된 그대로):
```ts
import { Migration } from '@mikro-orm/migrations';

export class Migration20261026014106 extends Migration {

  override name = 'Migration20261026014106';

  override up(): void | Promise<void> {
    this.addSql(`create table \`anomaly\` (\`id\` int unsigned not null auto_increment primary key, \`terminal_id\` int unsigned not null, \`rule\` enum('DELIVERED_NOT_INSTALLED','RETURN_STALLED','SHIPPED_TOO_LONG','ALLOCATED_NO_SHIPMENT','IN_SERVICE_NO_MERCHANT','OFFLINE_TOO_LONG') not null, \`detected_at\` datetime(3) not null, \`last_seen_at\` datetime(3) not null, \`resolved_at\` datetime(3) null, \`detail\` json not null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`anomaly\` add index \`anomaly_resolved_at_rule_index\` (\`resolved_at\`, \`rule\`);`);
    this.addSql(`alter table \`anomaly\` add unique \`anomaly_open_unique\` ((case when \`resolved_at\` is null then \`terminal_id\` end), (case when \`resolved_at\` is null then \`rule\` end));`);

    // 생성된 그대로(`add status_changed_at datetime(3) not null`)면 행이 있는 개발 DB에서
    // ERROR 1292 Incorrect datetime value: '0000-00-00 00:00:00'(strict 모드 NO_ZERO_DATE). 손으로 세 단계로 나눴다:
    // ① null 허용으로 추가 ② 백필: 지금 상태로 들어온 마지막 이력 시각, 이력이 없으면 updated_at ③ not null로 바꾼다(decisions/0034).
    this.addSql(`alter table \`terminal\` add \`status_changed_at\` datetime(3) null;`);
    this.addSql(`update \`terminal\` t set t.\`status_changed_at\` = coalesce((select max(h.\`occurred_at\`) from \`terminal_status_history\` h where h.\`terminal_id\` = t.\`id\` and h.\`to_status\` = t.\`status\`), t.\`updated_at\`);`);
    this.addSql(`alter table \`terminal\` modify \`status_changed_at\` datetime(3) not null;`);
    // 새 복합 인덱스를 먼저 만들고 status 단독 인덱스를 지운다(그 사이에도 status로 찾는 쿼리가 쓸 인덱스가 있게)
    this.addSql(`alter table \`terminal\` add index \`terminal_status_status_changed_at_index\` (\`status\`, \`status_changed_at\`);`);
    this.addSql(`alter table \`terminal\` drop index \`terminal_status_index\`;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`anomaly\`;`);

    this.addSql(`alter table \`terminal\` drop index \`terminal_status_status_changed_at_index\`;`);
    this.addSql(`alter table \`terminal\` drop column \`status_changed_at\`;`);
    this.addSql(`alter table \`terminal\` add index \`terminal_status_index\` (\`status\`);`);
  }

}
```

그리고(개발 DB 백필은 읽기만 하는 쿼리로 확인):
```bash
npm run db:migrate
npm run db:migration:check
MSYS_NO_PATHCONV=1 docker exec terminal-ops-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" terminal_ops -e "select count(*) as terminals, sum(status_changed_at is null) as nulls from terminal; select t.serial_no, t.status, t.status_changed_at, (select max(h.occurred_at) from terminal_status_history h where h.terminal_id = t.id and h.to_status = t.status) as last_history, t.updated_at from terminal t order by t.id desc limit 5;"'
npx vitest run && npm run typecheck
```
Expected: `적용: Migration<시각>`, `최신 상태`. 개발 DB: `nulls` 0, 마지막 5대 모두 `status_changed_at` = `last_history`(이력이 있으면, `.000`만 다름) 또는 `updated_at`(이력이 없으면). 전체 `Test Files  47 passed (47)`, `Tests  310 passed (310)`, typecheck exit 0.

- [ ] **Step 8: 기록과 커밋**

devlog에 `## HH:MM Task 5 이상 단말기 찾기 — status_changed_at·열린 이상·규칙 6개 (F4, F2)` 항목(insertMany 재현, 마이그레이션 손 수정, 개발 DB 백필 확인 출력).

`docs/troubleshooting/0022-insertMany는-엔티티-기본값을-쓰지-않아-새-NOT-NULL-열에서-실패.md`: 증상(Step 4 출력), 가설 ①②, 확인(같은 테스트의 em.create 경로는 성공, MikroORM `insertMany`는 POJO를 그대로 QueryBuilder insert로 보내 필드 초기값·`onCreate`가 없다 — 그래서 기존 헬퍼도 `version: 1, createdAt, updatedAt`을 직접 넣고 있었다), 원인, 해결(헬퍼 4곳에 statusChangedAt, `insertTerminals`에 인자), 배운 것(DB 기본값으로 풀지 않은 이유: `current_timestamp(3)`은 세션 시간대(SYSTEM=KST) 값이라 UTC로 저장하는 앱 값과 9시간 다르다, troubleshooting/0016).

`docs/decisions/0034-이상-단말기는-status_changed_at과-열린-이상-테이블로.md`:
- 날짜 / 관련 기능: 2026-10-26 / F4, F2
- 상황: 규칙 대부분이 "어떤 상태로 N일 넘게"다. 핵심은 "그 상태가 된 시각"을 어떻게 구하느냐. `terminal.updated_at`은 가맹점·version 등 다른 변경에도 바뀌어 쓸 수 없다(Day 4 준비 메모).
- 선택지: (a) 이력에서 "지금 상태로 들어온 마지막 이력 시각"을 서브쿼리(또는 윈도 함수)로 — 단말기마다 이력을 훑는다(규칙에 걸린 상태의 단말기 수 × 이력 수). 스키마는 그대로. (b) **`terminal.status_changed_at`을 전이 서비스가 상태와 같은 UPDATE에서 갱신 + `(status, status_changed_at)` 복합 인덱스** — 규칙 하나가 인덱스 범위 하나. 컬럼 하나와 백필 마이그레이션이 필요하고, 전이 서비스를 거치지 않는 쓰기(테스트 헬퍼의 직접 INSERT·nativeUpdate)는 이 값을 직접 맞춰야 한다.
- 결정: (b). 상태 변경은 전이 서비스 한 곳(CLAUDE.md 원칙)이라 값이 어긋날 경로가 없다. 이력 occurred_at에도 같은 시각을 쓴다(이력은 datetime(0)이라 초 단위로 같다). 실험 0011이 (a)와 같은 결과인지와 시간·실행계획을 잰다(Task 9가 숫자를 보탠다).
- 백필: 생성된 `add … not null`은 행이 있으면 ERROR 1292(strict 모드). null 허용 추가 → `coalesce(지금 상태로 들어온 마지막 이력, updated_at)` → not null. 새 인덱스를 만든 뒤 status 단독 인덱스를 지운다(그 사이에도 status 조회가 쓸 인덱스가 있게).
- 열린 이상은 (단말기, 규칙)마다 하나: MySQL에는 부분 unique가 없다. 1) 앱이 채우는 `open_key` 열(열 때 값, 닫을 때 NULL) + unique — 앱이 잊으면 깨진다. 2) 생성 열 `open_key`(resolved_at이 NULL이면 `terminal_id:rule`) + unique — 사전 검증에서 동작·스키마 비교 안정. 3) **MikroORM 7 `@Unique({ where: { resolvedAt: null } })`** — MikroORM이 `unique((case when resolved_at is null then terminal_id end), (case … rule end))` 함수 인덱스로 만들고, 엔티티에 열이 늘지 않는다. 열린 행 둘은 위반, 닫힌 행은 NULL이라 몇 개든 된다(테스트로 확인). → 3. (같은 방법을 VAN 실행의 `status = 'RUNNING'`에 쓰면 글자 상수 때문에 스키마 비교가 늘 달라 2를 썼다, decisions/0033.)
- 찾기: 규칙 SQL로 지금 걸린 것을 다 구하고 열린 이상과 (단말기, 규칙) 키로 비교 → 새로 INSERT, 계속 `last_seen_at`, 풀림 `resolved_at`. 갱신은 PK `IN (…)` + `resolved_at is null`(보조 인덱스 범위 UPDATE의 gap 락을 피함, troubleshooting/0014). 한 번에 하나(Redis 잠금, 수동은 409, 주기는 건너뜀), unique가 마지막 안전망. FK 없음(찾기가 수천 행을 넣을 때 단말기 행마다 S 락을 걸지 않게).
- 규칙 정의: 스펙 4.2 표. ALLOCATED_NO_SHIPMENT는 ALLOCATED 자체가 출고 없음. OFFLINE_TOO_LONG은 `last_seen_at` 기준(스냅샷이 처음 쓴 행의 changed_at은 판정 시각이라). 기준일은 env(1~365).
- 결과·대가: 전이 UPDATE에 열 하나가 늘고 인덱스 (status, status_changed_at)가 상태가 바뀔 때마다 갱신된다(status 단독 인덱스를 지워 인덱스 수는 같다). 이력과 status_changed_at이 어긋날 수 있는 경로: 전이 서비스를 거치지 않는 쓰기(테스트 헬퍼, 운영자가 DB를 직접 고침).
- 다시 볼 조건: 규칙이 "상태가 된 뒤 다른 사건이 없음"(예: 배정 뒤 운송장 발급 실패)처럼 이력 내용을 봐야 할 때, 0011에서 (a)가 충분히 빠르면.

`docs/study/backlog.md`에 추가:
```
- [ ] 비정규화 컬럼(status_changed_at)과 이력 테이블의 일관성 — 한 곳에서만 쓰기, 백필, 상관 서브쿼리 대 컬럼 (decisions/0034)
- [ ] MySQL strict 모드(STRICT_TRANS_TABLES, NO_ZERO_DATE)와 ALTER TABLE ADD COLUMN NOT NULL의 암묵 기본값 (decisions/0034)
- [ ] ORM의 대량 INSERT(insertMany)가 엔티티 기본값·훅을 건너뛰는 이유 (troubleshooting/0022)
```

커밋:
```bash
git add apps/api docs .env.example
git commit -m "feat(F4): 이상 단말기 찾기 — status_changed_at·열린 이상 부분 unique·규칙 6개·찾기·조회 API" -m "Refs: docs/decisions/0034-이상-단말기는-status_changed_at과-열린-이상-테이블로.md, docs/troubleshooting/0022-insertMany는-엔티티-기본값을-쓰지-않아-새-NOT-NULL-열에서-실패.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 이상 단말기 알림과 cron 주기 작업 — Outbox(묶음), job scheduler pattern + tz, report 큐 등록 (F4, F5, F9)

**Files:**
- Modify: `apps/api/src/anomaly/anomaly.service.ts`, `apps/api/src/anomaly/anomaly-rules.ts`, `apps/api/src/outbox/outbox-event.entity.ts`, `apps/api/src/outbox/outbox.service.ts`, `apps/api/src/scheduler/job-schedulers.ts`, `apps/api/src/scheduler/scheduler.service.ts`, `apps/api/src/report/report.processor.ts`, `apps/api/src/workers/workers.module.ts`, `apps/api/src/config/env.ts`, `.env.example`
- Test: `apps/api/test/report-jobs.e2e.spec.ts`(새), `apps/api/test/scheduler.e2e.spec.ts`, `apps/api/test/unit/scheduler-guard.spec.ts`, `apps/api/test/unit/outbox-text.spec.ts`
- Record: `docs/devlog/2026-10-26.md`, `docs/decisions/0035-주간-리포트와-cron-주기-작업.md`(이 Task에서 시작: cron·tz 부분), `docs/decisions/0034-…`(알림 보탬), `docs/decisions/0015-…`(갱신 한 줄)

바꾸는 것 요약:
- 찾기 트랜잭션 안에서 새로 걸린 이상의 Outbox: 기준(`ANOMALY_BULK_EVENT_THRESHOLD`=20) 이하면 `anomaly.detected`(serialNo, rule, days?, detectedAt) 단말기마다, 넘으면 `anomaly.detected_bulk`(count, byRule, 앞 100대, truncated) 1행. 계속·풀림은 알리지 않는다.
- 문구: `[단말온] 이상 단말기 A-0001: 배송 완료 후 미설치 (8일)`, `[단말온] 이상 단말기 30대 새로 발견 (회수 지연 5, 배송 지연 25, 판정 T)`(규칙 순서, 0인 규칙은 뺌). 규칙 이름은 `ANOMALY_RULE_LABEL`.
- `JOB_SCHEDULERS[].schedule()`이 `{ every }` 또는 `{ pattern, tz: 'Asia/Seoul' }`. report 큐에 `anomaly-scan-daily`(`ANOMALY_SCAN_CRON`, 기본 `0 2 * * *`), `van-reconcile-daily`(`VAN_RECONCILE_CRON`, 기본 `0 3 * * *`). 등록 로그는 `… anomaly-scan-daily cron "0 2 * * *" Asia/Seoul …`. `SchedulerService`가 report 큐도 주입받는다. `scheduler:clear`는 목록 전체를 지우므로 그대로.
- `ReportProcessor`의 `anomaly-scan`: 수동 찾기가 돌고 있으면(409) `{ skipped: true }`.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/unit/outbox-text.spec.ts`(테스트 하나 더):
```diff
--- a/apps/api/test/unit/outbox-text.spec.ts
+++ b/apps/api/test/unit/outbox-text.spec.ts
@@ -45,4 +45,16 @@ describe('알림 문구(textOf)', () => {
       '[단말온] VAN 등록 대조 #7: 어긋남 1000건(미등록 400, 운영 아님 0, 가맹점 다름 600, 정지 0), 재검증으로 풀림 3건, VAN 등록 50000건',
     );
   });
+
+  it('이상 단말기는 시리얼·규칙 이름·경과일, 묶음은 대수와 규칙별 수(0인 규칙은 뺌) (decisions/0034)', () => {
+    expect(textOf({ type: 'anomaly.detected', payload: { serialNo: 'A-0001', rule: 'DELIVERED_NOT_INSTALLED', days: 8 } })).toBe(
+      '[단말온] 이상 단말기 A-0001: 배송 완료 후 미설치 (8일)',
+    );
+    expect(textOf({ type: 'anomaly.detected', payload: { serialNo: 'A-0002', rule: 'IN_SERVICE_NO_MERCHANT' } })).toBe(
+      '[단말온] 이상 단말기 A-0002: 운영 중 가맹점 없음',
+    );
+    expect(
+      textOf({ type: 'anomaly.detected_bulk', payload: { count: 30, byRule: { SHIPPED_TOO_LONG: 25, RETURN_STALLED: 5 }, detectedAt: 'T' } }),
+    ).toBe('[단말온] 이상 단말기 30대 새로 발견 (회수 지연 5, 배송 지연 25, 판정 T)');
+  });
 });
```

`apps/api/test/unit/scheduler-guard.spec.ts`, `apps/api/test/scheduler.e2e.spec.ts`:
```diff
--- a/apps/api/test/unit/scheduler-guard.spec.ts
+++ b/apps/api/test/unit/scheduler-guard.spec.ts
@@ -5,7 +5,7 @@ import { SchedulerService } from '../../src/scheduler/scheduler.service.js';
 describe('SchedulerService — 주입하지 않은 큐', () => {
   it('JOB_SCHEDULERS가 가리키는 큐가 주입되지 않았으면 큐 이름을 담은 오류를 던진다(undefined 접근 TypeError가 아니라)', async () => {
     const fake = { upsertJobScheduler: vi.fn(async () => undefined) } as unknown as Queue;
-    const service = new SchedulerService(fake, fake, undefined as unknown as Queue);
-    await expect(service.onApplicationBootstrap()).rejects.toThrow(/주입되지 않은 큐: device/);
+    const service = new SchedulerService(fake, fake, fake, undefined as unknown as Queue);
+    await expect(service.onApplicationBootstrap()).rejects.toThrow(/주입되지 않은 큐: report/);
   });
 });
```
```diff
--- a/apps/api/test/scheduler.e2e.spec.ts
+++ b/apps/api/test/scheduler.e2e.spec.ts
@@ -24,11 +24,20 @@ describe('주기 작업 삭제 (scheduler:clear, decisions/0015)', () => {
 
   it('등록된 주기 작업을 지우면 다음 주기 job이 더 생기지 않는다. 다시 지우면 지울 것이 없다', async () => {
     // 테스트 앱에는 스케줄러가 없으므로(schedulers: false) 직접 등록한다. 접두사가 test-라 개발 Redis 키는 건드리지 않는다.
-    await new SchedulerService(queueOf(QUEUE.CARRIER_SWEEP), queueOf(QUEUE.OUTBOX), queueOf(QUEUE.DEVICE)).onApplicationBootstrap();
+    await new SchedulerService(queueOf(QUEUE.CARRIER_SWEEP), queueOf(QUEUE.OUTBOX), queueOf(QUEUE.DEVICE), queueOf(QUEUE.REPORT)).onApplicationBootstrap();
     const queues = [...new Set(JOB_SCHEDULERS.map((s) => s.queue))];
     for (const name of queues) {
       expect(await queueOf(name).getJobSchedulersCount()).toBe(JOB_SCHEDULERS.filter((s) => s.queue === name).length);
     }
+    // cron 작업(report 큐)은 시간대와 함께 저장되고, 등록할 때 바로 돌지 않는다(다음 시각의 delayed job 하나씩, decisions/0035)
+    const anomaly = await queueOf(QUEUE.REPORT).getJobScheduler('anomaly-scan-daily');
+    expect(anomaly).toMatchObject({ pattern: '0 2 * * *', tz: 'Asia/Seoul' });
+    const next = new Date(anomaly!.next!);
+    expect(next.getTime()).toBeGreaterThan(Date.now());
+    expect([next.getUTCHours(), next.getUTCMinutes()]).toEqual([17, 0]); // 02:00 KST = 전날 17:00 UTC
+    const van = await queueOf(QUEUE.REPORT).getJobScheduler('van-reconcile-daily');
+    expect(new Date(van!.next!).getUTCHours()).toBe(18);
+    expect(await queueOf(QUEUE.REPORT).getJobCounts('waiting', 'delayed')).toEqual({ waiting: 0, delayed: 2 });
 
     expect(await clearJobSchedulers(queueOf)).toEqual(JOB_SCHEDULERS.map((s) => s.id));
     for (const name of queues) {
```

`apps/api/test/report-jobs.e2e.spec.ts`(새):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { Anomaly, AnomalyRule } from '../src/anomaly/anomaly.entity.js';
import { AnomalyService } from '../src/anomaly/anomaly.service.js';
import { DAY_MS } from '../src/config/env-number.js';
import { OutboxEvent } from '../src/outbox/outbox-event.entity.js';
import { QUEUE } from '../src/queue/queue-names.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { TerminalStatus as S } from '../src/terminal/terminal-status.js';
import { VanReconciliationRun, VanRunStatus, VanRunTrigger } from '../src/van/van.entities.js';
import { partners } from './helpers/partners.js';
import { resetQueues, waitFor } from './helpers/queues.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { insertTerminals } from './helpers/terminals.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const daysAgo = (d: number) => new Date(Date.now() - d * DAY_MS);

describe('이상 단말기 알림과 report 큐 job (F4·F9, decisions/0034·0035)', () => {
  let t: TestApp;
  let svc: AnomalyService;
  let reportQueue: Queue;
  const em = () => t.orm.em.fork();
  const events = (type: string) => em().find(OutboxEvent, { type }, { orderBy: { id: 'asc' } });

  beforeAll(async () => {
    t = await createTestApp({ workers: true });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    svc = t.app.get(AnomalyService);
    reportQueue = t.app.get<Queue>(getQueueToken(QUEUE.REPORT));
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await deleteTestKeys(t.app.get<Redis>(REDIS));
    await t.app.close();
  });

  it('새 이상이 기준(20) 이하면 단말기마다 anomaly.detected, 계속 걸린 이상은 다시 알리지 않는다', async () => {
    await insertTerminals(t, [
      { serialNo: 'NT-01', status: S.DELIVERED, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(9) },
      { serialNo: 'NT-02', status: S.IN_SERVICE, merchantCode: null },
    ]);
    expect((await svc.scan()).detected).toBe(2);
    const rows = await events('anomaly.detected');
    expect(rows.map((e) => e.payload)).toEqual([
      { serialNo: 'NT-01', rule: 'DELIVERED_NOT_INSTALLED', days: 9, detectedAt: expect.any(String) },
      { serialNo: 'NT-02', rule: 'IN_SERVICE_NO_MERCHANT', detectedAt: expect.any(String) },
    ]);
    expect((await svc.scan()).continuing).toBe(2);
    expect(await events('anomaly.detected')).toHaveLength(2);
  });

  it('새 이상이 기준보다 많으면 묶음 한 행(anomaly.detected_bulk: 대수, 규칙별 수, 앞 100대)', async () => {
    await insertTerminals(
      t,
      Array.from({ length: 25 }, (_, i) => ({ serialNo: `NB-${String(i + 1).padStart(2, '0')}`, status: S.SHIPPED, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(12) })),
    );
    expect((await svc.scan()).detected).toBe(25);
    const bulk = await events('anomaly.detected_bulk');
    expect(bulk).toHaveLength(1);
    expect(bulk[0].payload).toMatchObject({ count: 25, byRule: { SHIPPED_TOO_LONG: 25 }, truncated: false });
    expect((bulk[0].payload.serials as string[]).slice(0, 2)).toEqual(['NB-01', 'NB-02']);
    expect(await events('anomaly.detected')).toHaveLength(2); // 단말기별 행은 늘지 않았다
  });

  it('report 큐 워커가 anomaly-scan·van-reconcile-scheduled job을 처리하고, 모르는 job은 재시도 없이 실패', async () => {
    await insertTerminals(t, [{ serialNo: 'NQ-01', status: S.ALLOCATED, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(5) }]);
    await reportQueue.add('anomaly-scan', {});
    await waitFor(async () => (await em().count(Anomaly, { rule: AnomalyRule.ALLOCATED_NO_SHIPMENT, resolvedAt: null })) === 1, { message: 'anomaly-scan job' });

    await partners.reset();
    await partners.seedVan([]);
    await reportQueue.add('van-reconcile-scheduled', {});
    const run = await waitFor(
      async () => em().findOne(VanReconciliationRun, { trigger: VanRunTrigger.SCHEDULED, status: VanRunStatus.COMPLETED }),
      { message: '주기 VAN 대조' },
    );
    expect(run.requestedBy).toBe('system:van-reconcile');

    const bad = await reportQueue.add('nope', {}, { attempts: 3 });
    await waitFor(async () => (await bad.getState()) === 'failed', { message: '모르는 job 실패' });
    expect((await reportQueue.getJob(bad.id!))?.attemptsMade).toBe(1);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit/outbox-text.spec.ts test/unit/scheduler-guard.spec.ts test/scheduler.e2e.spec.ts test/report-jobs.e2e.spec.ts`
Expected: `Test Files 4 failed (4)`, `Tests 6 failed | 5 passed (11)` — 알림 행이 없어 `expected [] to deeply equal [ { serialNo: 'NT-01', …(3) }, …(1) ]`·`expected [] to have a length of 1`, 워커가 job을 모름 `anomaly-scan job을(를) 15000ms 안에 만족하지 못했습니다`, `expected undefined to match object { pattern: '0 2 * * *', …(1) }`, 문구 `expected '[단말온] A-0001: 신규 → undefined …'`, guard `promise resolved "undefined" instead of rejecting`(생성자 인자 넷째가 아직 없다 — 타입 검사는 Step 4에서).

- [ ] **Step 3: 구현**

`apps/api/src/outbox/outbox-event.entity.ts`, `apps/api/src/anomaly/anomaly-rules.ts`, `apps/api/src/outbox/outbox.service.ts`:
```diff
--- a/apps/api/src/outbox/outbox-event.entity.ts
+++ b/apps/api/src/outbox/outbox-event.entity.ts
@@ -22,6 +22,9 @@ export const OUTBOX_TYPE = {
   FIRMWARE_ROLLOUT_ABORTED: 'firmware.rollout_aborted',
   /** VAN 등록 대조 한 번의 요약(F9, 어긋남 수와 상관없이 1행, decisions/0033) */
   VAN_RECONCILIATION_COMPLETED: 'van.reconciliation_completed',
+  /** 이상 단말기가 새로 걸림(F4). 한 번 찾기에서 기준보다 많으면 묶음 한 건(decisions/0034) */
+  ANOMALY_DETECTED: 'anomaly.detected',
+  ANOMALY_DETECTED_BULK: 'anomaly.detected_bulk',
 } as const;
 
 /**
```
```diff
--- a/apps/api/src/anomaly/anomaly-rules.ts
+++ b/apps/api/src/anomaly/anomaly-rules.ts
@@ -5,6 +5,16 @@ import { DAY_MS } from '../config/env-number.js';
 import { TerminalStatus as S } from '../terminal/terminal-status.js';
 import { AnomalyRule } from './anomaly.entity.js';
 
+/** 알림·리포트에 쓰는 규칙 이름(규칙 순서) */
+export const ANOMALY_RULE_LABEL: Record<AnomalyRule, string> = {
+  [AnomalyRule.DELIVERED_NOT_INSTALLED]: '배송 완료 후 미설치',
+  [AnomalyRule.RETURN_STALLED]: '회수 지연',
+  [AnomalyRule.SHIPPED_TOO_LONG]: '배송 지연',
+  [AnomalyRule.ALLOCATED_NO_SHIPMENT]: '배정 후 미출고',
+  [AnomalyRule.IN_SERVICE_NO_MERCHANT]: '운영 중 가맹점 없음',
+  [AnomalyRule.OFFLINE_TOO_LONG]: '장기 오프라인',
+};
+
 /** 규칙별 기준일 */
 export type AnomalyThresholds = typeof env.anomalyDays;
 
```
```diff
--- a/apps/api/src/outbox/outbox.service.ts
+++ b/apps/api/src/outbox/outbox.service.ts
@@ -4,6 +4,8 @@ import { UnrecoverableError, type JobsOptions, type Queue } from 'bullmq';
 import { EntityManager, IsolationLevel, LockMode } from '@mikro-orm/mysql';
 import { PartnerPermanentError } from '../common/partner-errors.js';
 import { QUEUE } from '../queue/queue-names.js';
+import { ANOMALY_RULE_LABEL } from '../anomaly/anomaly-rules.js';
+import type { AnomalyRule } from '../anomaly/anomaly.entity.js';
 import { KIND_LABEL } from '../van/van-compare.js';
 import type { VanMismatchKind } from '../van/van.entities.js';
 import { OUTBOX_TYPE, OutboxEvent, OutboxStatus } from './outbox-event.entity.js';
@@ -68,7 +70,20 @@ export function textOf(event: Pick<OutboxEvent, 'type' | 'payload'>): string {
     confirmed?: number;
     resolved?: number;
     counts?: Partial<Record<VanMismatchKind, number>>;
+    rule?: AnomalyRule;
+    days?: number;
+    byRule?: Partial<Record<AnomalyRule, number>>;
   };
+  if (event.type === OUTBOX_TYPE.ANOMALY_DETECTED) {
+    return `[단말온] 이상 단말기 ${p.serialNo}: ${ANOMALY_RULE_LABEL[p.rule!] ?? p.rule}${p.days === undefined ? '' : ` (${p.days}일)`}`;
+  }
+  if (event.type === OUTBOX_TYPE.ANOMALY_DETECTED_BULK) {
+    const byRule = Object.entries(ANOMALY_RULE_LABEL)
+      .filter(([rule]) => (p.byRule?.[rule as AnomalyRule] ?? 0) > 0)
+      .map(([rule, label]) => `${label} ${p.byRule![rule as AnomalyRule]}`)
+      .join(', ');
+    return `[단말온] 이상 단말기 ${p.count}대 새로 발견 (${byRule}, 판정 ${p.detectedAt})`;
+  }
   if (event.type === OUTBOX_TYPE.VAN_RECONCILIATION_COMPLETED) {
     const byKind = Object.entries(KIND_LABEL)
       .map(([kind, label]) => `${label} ${p.counts?.[kind as VanMismatchKind] ?? 0}`)
```

`apps/api/src/anomaly/anomaly.service.ts`:
```diff
--- a/apps/api/src/anomaly/anomaly.service.ts
+++ b/apps/api/src/anomaly/anomaly.service.ts
@@ -1,6 +1,8 @@
 import { Injectable, Logger } from '@nestjs/common';
 import { EntityManager } from '@mikro-orm/mysql';
 import { BusinessError } from '../common/domain-errors.js';
+import { env } from '../config/env.js';
+import { OUTBOX_TYPE, OutboxEvent } from '../outbox/outbox-event.entity.js';
 import { RedisLock } from '../redis/redis-lock.js';
 import { Terminal } from '../terminal/terminal.entity.js';
 import { Anomaly, AnomalyRule } from './anomaly.entity.js';
@@ -12,6 +14,9 @@ const SCAN_LOCK_TTL_MS = 5 * 60_000;
 /** PK IN (…) 갱신·INSERT 한 문장의 행 수 */
 const CHUNK = 500;
 
+/** 묶음 알림 payload에 담는 시리얼 수. 나머지는 count와 truncated로만 */
+const BULK_EVENT_SERIALS = 100;
+
 export interface ScanResult {
   /** 새로 걸린 이상 */
   detected: number;
@@ -76,6 +81,7 @@ export class AnomalyService {
       for (let i = 0; i < resolved.length; i += CHUNK) {
         await tx.nativeUpdate(Anomaly, { id: { $in: resolved.slice(i, i + CHUNK) }, resolvedAt: null }, { resolvedAt: now });
       }
+      this.recordNotifications(tx, newMatches, now);
     });
 
     const openNow: Partial<Record<AnomalyRule, number>> = {};
@@ -86,6 +92,36 @@ export class AnomalyService {
     return { detected: newMatches.length, continuing: continuing.length, resolved: resolved.length, open: openNow, newMatches };
   }
 
+  /**
+   * 새로 걸린 이상의 알림을 같은 트랜잭션의 Outbox에 남긴다(유실 없음, decisions/0016). 기준(ANOMALY_BULK_EVENT_THRESHOLD)보다 많으면
+   * 규칙별 수를 담은 묶음 한 행 — 첫 찾기나 큰 장애 뒤에 수천 행이 relay 줄을 막지 않게(experiments/0010, Day 4 방식).
+   * 계속 걸린 이상과 풀린 이상은 알리지 않는다(매일 같은 알림이 반복되지 않게. 열린 이상은 주간 리포트에 나온다).
+   */
+  private recordNotifications(tx: EntityManager, newMatches: AnomalyMatch[], now: Date): void {
+    if (newMatches.length === 0) return;
+    if (newMatches.length > env.anomalyBulkEventThreshold) {
+      const byRule: Partial<Record<AnomalyRule, number>> = {};
+      for (const m of newMatches) byRule[m.rule] = (byRule[m.rule] ?? 0) + 1;
+      tx.create(OutboxEvent, {
+        type: OUTBOX_TYPE.ANOMALY_DETECTED_BULK,
+        payload: {
+          count: newMatches.length,
+          byRule,
+          serials: newMatches.slice(0, BULK_EVENT_SERIALS).map((m) => m.serialNo),
+          truncated: newMatches.length > BULK_EVENT_SERIALS,
+          detectedAt: now.toISOString(),
+        },
+      });
+      return;
+    }
+    for (const m of newMatches) {
+      tx.create(OutboxEvent, {
+        type: OUTBOX_TYPE.ANOMALY_DETECTED,
+        payload: { serialNo: m.serialNo, rule: m.rule, ...(typeof m.detail.days === 'number' ? { days: m.detail.days } : {}), detectedAt: now.toISOString() },
+      });
+    }
+  }
+
   /** 이상 목록 한 페이지(id 순, afterId 뒤부터). 단말기 시리얼·지금 상태를 붙인다 */
   async list(q: { rule?: AnomalyRule; open?: boolean; afterId?: number; limit: number }) {
     const em = this.em.fork();
```

`apps/api/src/scheduler/job-schedulers.ts` 전체:
```ts
import type { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { QUEUE, type QueueName } from '../queue/queue-names.js';

/** cron 주기 작업의 시간대. 서버 시간대와 상관없이 한국 시간으로 돈다(decisions/0035) */
export const SCHEDULE_TZ = 'Asia/Seoul';

/** 주기: 간격(ms) 또는 cron 식 + 시간대. BullMQ upsertJobScheduler의 repeat 옵션에 그대로 넘긴다 */
export type JobSchedule = { every: number } | { pattern: string; tz: string };

/** 주기 작업 목록. 등록(SchedulerService)과 삭제(scheduler:clear)가 같은 id를 쓴다. schedule은 등록할 때 읽는다. */
export const JOB_SCHEDULERS = [
  { queue: QUEUE.CARRIER_SWEEP, id: 'carrier-sweep', jobName: 'sweep', schedule: () => ({ every: env.sweepIntervalMs }) },
  { queue: QUEUE.OUTBOX, id: 'outbox-relay', jobName: 'relay', schedule: () => ({ every: env.relayIntervalMs }) },
  { queue: QUEUE.DEVICE, id: 'active-rebuild', jobName: 'rebuild-active', schedule: () => ({ every: env.activeRebuildIntervalMs }) },
  { queue: QUEUE.DEVICE, id: 'offline-detect', jobName: 'detect-offline', schedule: () => ({ every: env.offlineDetectIntervalMs }) },
  { queue: QUEUE.DEVICE, id: 'connectivity-snapshot', jobName: 'snapshot', schedule: () => ({ every: env.connectivitySnapshotIntervalMs }) },
  { queue: QUEUE.DEVICE, id: 'rollout-control', jobName: 'rollout-control', schedule: () => ({ every: env.rolloutControlIntervalMs }) },
  // 매일 밤(KST): 이상 단말기 찾기(F4), VAN 등록 대조(F9). report 큐(concurrency 1)라 둘이 겹치지 않는다
  { queue: QUEUE.REPORT, id: 'anomaly-scan-daily', jobName: 'anomaly-scan', schedule: () => ({ pattern: env.anomalyScanCron, tz: SCHEDULE_TZ }) },
  { queue: QUEUE.REPORT, id: 'van-reconcile-daily', jobName: 'van-reconcile-scheduled', schedule: () => ({ pattern: env.vanReconcileCron, tz: SCHEDULE_TZ }) },
] as const satisfies readonly { queue: QueueName; id: string; jobName: string; schedule: () => JobSchedule }[];

/** 로그용: `1000ms` 또는 `cron "0 2 * * *" Asia/Seoul` */
export function describeSchedule(s: JobSchedule): string {
  return 'every' in s ? `${s.every}ms` : `cron "${s.pattern}" ${s.tz}`;
}

/**
 * 주기 작업을 Redis에서 지운다. job scheduler는 등록한 프로세스가 끝나도 Redis에 남아 계속 job을 만든다
 * (Day 2 리뷰 Minor 2, decisions/0015). 다음 주기 job(delayed)도 함께 지워진다.
 * @returns 지운 scheduler id 목록(없던 것은 빠진다)
 */
export async function clearJobSchedulers(queueOf: (name: QueueName) => Queue): Promise<string[]> {
  const removed: string[] = [];
  for (const s of JOB_SCHEDULERS) {
    if (await queueOf(s.queue).removeJobScheduler(s.id)) removed.push(s.id);
  }
  return removed;
}
```

`apps/api/src/scheduler/scheduler.service.ts` 전체:
```ts
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUE, type QueueName } from '../queue/queue-names.js';
import { describeSchedule, JOB_SCHEDULERS } from './job-schedulers.js';

/**
 * 주기 작업 등록. BullMQ job scheduler는 Redis에 한 개만 저장되므로(같은 id면 덮어씀)
 * 이 서비스가 여러 프로세스에서 떠도 주기 작업은 하나다. 지우려면 npm run scheduler:clear (decisions/0015).
 * cron 작업은 시간대(Asia/Seoul)를 함께 넘긴다 — 빼면 서버 프로세스의 시간대로 해석된다(decisions/0035).
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly queues: Partial<Record<QueueName, Queue>>;

  constructor(
    @InjectQueue(QUEUE.CARRIER_SWEEP) sweepQueue: Queue,
    @InjectQueue(QUEUE.OUTBOX) outboxQueue: Queue,
    @InjectQueue(QUEUE.DEVICE) deviceQueue: Queue,
    @InjectQueue(QUEUE.REPORT) reportQueue: Queue,
  ) {
    this.queues = { [QUEUE.CARRIER_SWEEP]: sweepQueue, [QUEUE.OUTBOX]: outboxQueue, [QUEUE.DEVICE]: deviceQueue, [QUEUE.REPORT]: reportQueue };
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const s of JOB_SCHEDULERS) {
      const queue = this.queues[s.queue];
      // 목록에 큐를 더하고 생성자 주입을 빠뜨리면 undefined 접근 TypeError 대신 무엇이 빠졌는지 알려 준다
      if (!queue) throw new Error(`주기 작업 ${s.id}: 주입되지 않은 큐: ${s.queue} (SchedulerService 생성자에 @InjectQueue를 더하세요)`);
      await queue.upsertJobScheduler(s.id, s.schedule(), { name: s.jobName, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } });
    }
    this.logger.log(`주기 작업 등록: ${JOB_SCHEDULERS.map((s) => `${s.id} ${describeSchedule(s.schedule())}`).join(', ')}`);
  }
}
```

`apps/api/src/report/report.processor.ts` 전체:
```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { AnomalyService } from '../anomaly/anomaly.service.js';
import { BusinessError } from '../common/domain-errors.js';
import { QUEUE } from '../queue/queue-names.js';
import { toVanRunView, VanReconciliationService, type VanRunJobData } from '../van/van-reconciliation.service.js';

/**
 * report 큐: 오래 걸리는 집계 job(VAN 대조, 이상 단말기 찾기, 다음 Task의 주간 리포트). device 큐(concurrency 1, 짧은 job)와 나눠
 * 무거운 일이 active 갱신·오프라인 판정을 막지 않게 한다(experiments/0010). 이 큐도 concurrency 1 — 집계끼리는 겹치지 않는다.
 */
@Processor(QUEUE.REPORT, { concurrency: 1 })
export class ReportProcessor extends WorkerHost {
  constructor(
    private readonly van: VanReconciliationService,
    private readonly anomalies: AnomalyService,
  ) {
    super();
  }

  async process(job: Job) {
    switch (job.name) {
      case 'van-reconcile': {
        const runId = (job.data as Partial<VanRunJobData>).runId;
        if (typeof runId !== 'number') throw new UnrecoverableError(`van-reconcile: runId가 없습니다: ${JSON.stringify(job.data)}`);
        const run = toVanRunView(await this.van.execute(runId));
        return { runId, status: run.status, confirmed: run.confirmed };
      }
      case 'van-reconcile-scheduled':
        return this.van.runScheduled();
      case 'anomaly-scan':
        try {
          const { newMatches: _new, ...summary } = await this.anomalies.scan();
          return summary;
        } catch (error) {
          // 수동 찾기가 돌고 있으면 이번 주기는 건너뛴다(그 찾기가 같은 일을 한다)
          if (error instanceof BusinessError && error.code === 'ANOMALY_SCAN_RUNNING') return { skipped: true };
          throw error;
        }
      default:
        throw new UnrecoverableError(`모르는 report job: ${job.name}`);
    }
  }
}
```

`apps/api/src/workers/workers.module.ts`, `apps/api/src/config/env.ts`:
```diff
--- a/apps/api/src/workers/workers.module.ts
+++ b/apps/api/src/workers/workers.module.ts
@@ -10,12 +10,13 @@ import { DeviceProcessor } from '../device/device.processor.js';
 import { FirmwareModule } from '../firmware/firmware.module.js';
 import { OutboxModule } from '../outbox/outbox.module.js';
 import { OutboxProcessor } from '../outbox/outbox.processor.js';
+import { AnomalyModule } from '../anomaly/anomaly.module.js';
 import { ReportProcessor } from '../report/report.processor.js';
 import { VanModule } from '../van/van.module.js';
 
 /** 큐 job을 처리하는 프로세서들. RUN_WORKERS=1인 프로세스에만 넣는다(decisions/0015). */
 @Module({
-  imports: [CarrierSyncModule, OutboxModule, DeviceModule, FirmwareModule, VanModule],
+  imports: [CarrierSyncModule, OutboxModule, DeviceModule, FirmwareModule, VanModule, AnomalyModule],
   providers: [BungaeTrackProcessor, NeurimboTrackProcessor, CarrierSweepProcessor, OutboxProcessor, DeviceProcessor, ReportProcessor],
 })
 export class WorkersModule {}
```
```diff
--- a/apps/api/src/config/env.ts
+++ b/apps/api/src/config/env.ts
@@ -97,6 +97,11 @@ export const env = {
     allocatedNoShipment: intFromEnv('ANOMALY_ALLOCATED_DAYS', 3, DAYS),
     offlineTooLong: intFromEnv('ANOMALY_OFFLINE_DAYS', 3, DAYS),
   },
+  /** 한 번 찾기에서 새 이상이 이보다 많으면 단말기별 알림 대신 묶음 한 건(anomaly.detected_bulk, decisions/0034) */
+  anomalyBulkEventThreshold: intFromEnv('ANOMALY_BULK_EVENT_THRESHOLD', 20, COUNT),
+  /** 주기 작업 cron(시간대 Asia/Seoul). 잘못된 식이면 스케줄러 등록(서버 시작)이 실패한다 */
+  anomalyScanCron: process.env.ANOMALY_SCAN_CRON ?? '0 2 * * *',
+  vanReconcileCron: process.env.VAN_RECONCILE_CRON ?? '0 3 * * *',
   /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
   workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
 };
```

`.env.example` 끝에(cron 값은 따옴표 — Node `loadEnvFile`은 따옴표 없이도 공백을 읽지만 읽는 사람을 위해):
```
ANOMALY_BULK_EVENT_THRESHOLD=20
# 주기 작업 cron(시간대 Asia/Seoul) — decisions/0035
ANOMALY_SCAN_CRON="0 2 * * *"
VAN_RECONCILE_CRON="0 3 * * *"
```

- [ ] **Step 4: 통과 확인**

Run:
```bash
npx vitest run test/unit/outbox-text.spec.ts test/unit/scheduler-guard.spec.ts test/scheduler.e2e.spec.ts test/report-jobs.e2e.spec.ts test/anomaly.e2e.spec.ts
npx vitest run && npm run typecheck
```
Expected: 앞은 `Tests  16 passed (16)`. 주기 작업 테스트는 `anomaly-scan-daily`의 `next`가 미래의 `17:00 UTC`(02:00 KST), `van-reconcile-daily`가 `18:00 UTC`, report 큐 `{ waiting: 0, delayed: 2 }`를 확인한다. 전체 `Test Files  48 passed (48)`, `Tests  314 passed (314)`, typecheck exit 0. 마이그레이션 없음(`npm run db:migration:check` → `최신 상태`).

- [ ] **Step 5: 기록과 커밋**

devlog에 `## HH:MM Task 6 이상 단말기 알림과 cron 주기 작업 (F4, F5, F9)` 항목.

`docs/decisions/0035-주간-리포트와-cron-주기-작업.md`(이 Task 몫 — 주기 부분. Task 7·8이 리포트 부분을 보탠다):
- 날짜 / 관련 기능: 2026-10-26 / F4, F9, F11
- 상황: Day 4까지 주기 작업은 모두 "N초마다"(`every`)였다. 이상 찾기·VAN 대조는 매일 밤, 주간 리포트는 월요일 09:00(KST)이라 달력 시각이 필요하다.
- 선택지: 1) every 하루 + 시작 시각 맞추기 — 서버를 다시 띄우면 시각이 밀린다. 2) **BullMQ job scheduler의 cron `pattern` + `tz`** — Redis에 한 개만 저장(같은 id면 덮음), 등록한 프로세스가 끝나도 남는다(decisions/0015와 같은 성질). 3) OS cron·별도 스케줄러 — 배포 단위가 늘어난다. → 2.
- 확인한 동작(사전 검증): 등록하자마자 돌지 않는다(`delayed` 1, `waiting` 0, `every`와 다름). `next`는 다음 시각(월 09:00 KST = 월 00:00 UTC). **tz를 빼면 서버 프로세스의 시간대로 해석한다** — 이 PC는 KST라 같았지만 UTC 서버면 9시간 밀린다. 그래서 늘 `tz: 'Asia/Seoul'`을 넘긴다. `removeJobScheduler`는 delayed job도 지운다. 테스트는 기다리지 않고 `getJobScheduler().next`를 보고, job은 큐에 직접 넣는다.
- cron 식 검증: 숫자 env처럼 미리 검사하지 않고(cron 파서를 따로 들이지 않으려고) 잘못된 식이면 스케줄러 등록 때 BullMQ가 던져 서버가 뜨지 않게 둔다.
- 다시 볼 조건: 여러 시간대 운영, 정확히 한 번 실행이 필요할 때(지금은 job이 실패하면 다음 주기까지 안 돈다 — 수동 API로 다시 한다).

`docs/decisions/0034-…`에 보탠다(알림): 새로 걸린 이상만 알린다(계속·풀림은 알리지 않음 — 매일 반복 방지, 열린 이상은 주간 리포트). 기준 20 이하면 단말기별, 넘으면 묶음 1행(첫 찾기나 큰 장애 뒤에 수천 행이 relay 줄을 막지 않게, experiments/0010·decisions/0029와 같은 방식). 찾기와 같은 트랜잭션의 Outbox라 유실 없음.

`docs/decisions/0015-실행-모드-워커와-스케줄러.md` 끝에 한 줄:
```
- 갱신(2026-10-26 Day 5): 주기 작업 목록이 `schedule()`로 `{ every }` 또는 `{ pattern, tz }`를 돌려준다. report 큐에 cron 작업 3개(Task 6의 anomaly-scan-daily·van-reconcile-daily, Task 8의 weekly-report). scheduler:clear는 목록 전체를 지운다.
```

`docs/study/backlog.md`에 추가:
```
- [ ] cron 식과 시간대(tz), 일광 절약 시간의 건너뜀·겹침, 분산 스케줄러의 정확히 한 번 (decisions/0035)
```

커밋:
```bash
git add apps/api docs .env.example
git commit -m "feat(F4): 이상 단말기 알림(묶음)과 cron 주기 작업(pattern + tz, report 큐)" -m "Refs: docs/decisions/0035-주간-리포트와-cron-주기-작업.md, docs/decisions/0034-이상-단말기는-status_changed_at과-열린-이상-테이블로.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 주간 리포트 데이터 — KST 주 경계와 DB 집계 쿼리 일곱 개 (F11)

**Files:**
- Create: `apps/api/src/report/kst-week.ts`, `apps/api/src/report/weekly-report.queries.ts`, `apps/api/src/report/report.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/unit/kst-week.spec.ts`(새), `apps/api/test/weekly-report-data.e2e.spec.ts`(새)
- Record: `docs/devlog/2026-10-26.md`, `docs/decisions/0035-…`(보탬), `docs/study/backlog.md`

바꾸는 것 요약:
- `kstWeekOf(instant)`: KST 월요일 00:00(= 일요일 15:00 UTC)부터 7일, `{ weekStart: 'YYYY-MM-DD', from, to }`(from·to는 UTC 시각). `previousKstWeek(now)`(월 09:00 KST에 돌면 지난주), `parseKstWeekStart('YYYY-MM-DD')`(KST 월요일이 아니거나 없는 날짜면 null), `kstDate(instant)`. getUTC*만 쓴다(서버 시간대 무관).
- `WeeklyReportQueries.collect(week, now)`: 한 RR 읽기 전용 트랜잭션에서 일곱 쿼리 — 모델·상태별 단말기 수, 그 주 전이 수(출처·도착 상태), 그 주 입고(신규 등록)·출고·회수 입고(모델별, `sum(조건)`), 열린 이상(규칙별 수 + 최대 1,000행), 운영 중 단말기의 접속 상태(마지막 하트비트가 기준보다 오래면 오프라인으로 셈), 그 주에 진행 중이었거나 끝난 펌웨어 배포(단계 대상 결과 합), 가장 최근 완료 VAN 대조. 주 경계는 `[from, to)`를 파라미터로(NOW() 없음).

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/unit/kst-week.spec.ts`(새):
```ts
import { describe, expect, it } from 'vitest';
import { kstDate, kstWeekOf, parseKstWeekStart, previousKstWeek } from '../../src/report/kst-week.js';

const at = (iso: string) => new Date(iso);

describe('KST 주 경계 (decisions/0035, troubleshooting/0016 교훈)', () => {
  it('KST 월요일 00:00(= 일요일 15:00 UTC)부터 다음 월요일 00:00 전까지가 한 주', () => {
    // 2026-10-19는 월요일
    expect(kstWeekOf(at('2026-10-18T15:00:00.000Z'))).toEqual({
      weekStart: '2026-10-19',
      from: at('2026-10-18T15:00:00.000Z'),
      to: at('2026-10-25T15:00:00.000Z'),
    });
    // 그 1ms 전(KST 일요일 23:59:59.999)은 앞 주
    expect(kstWeekOf(at('2026-10-18T14:59:59.999Z')).weekStart).toBe('2026-10-12');
    // KST 일요일 23:59(UTC로는 같은 날 14:59)는 아직 그 주
    expect(kstWeekOf(at('2026-10-25T14:59:00.000Z')).weekStart).toBe('2026-10-19');
    // UTC 날짜로는 일요일이지만 KST로는 월요일 00:30
    expect(kstWeekOf(at('2026-10-25T15:30:00.000Z')).weekStart).toBe('2026-10-26');
  });

  it('월요일 09:00 KST(= 00:00 UTC)에 돌면 지난주를 고른다. 해·달이 바뀌는 주도 맞다', () => {
    expect(previousKstWeek(at('2026-10-26T00:00:00.000Z'))).toEqual({
      weekStart: '2026-10-19',
      from: at('2026-10-18T15:00:00.000Z'),
      to: at('2026-10-25T15:00:00.000Z'),
    });
    // 2027-01-04(월) 09:00 KST → 2026-12-28(월) 주
    expect(previousKstWeek(at('2027-01-04T00:00:00.000Z')).weekStart).toBe('2026-12-28');
    expect(kstDate(at('2026-12-31T15:00:00.000Z'))).toBe('2027-01-01');
  });

  it("'YYYY-MM-DD' 월요일만 받는다", () => {
    expect(parseKstWeekStart('2026-10-19')).toEqual(kstWeekOf(at('2026-10-20T03:00:00.000Z')));
    expect(parseKstWeekStart('2026-10-20')).toBeNull(); // 화요일
    expect(parseKstWeekStart('2026-02-30')).toBeNull();
    expect(parseKstWeekStart('2026-10-19T00:00')).toBeNull();
    expect(parseKstWeekStart('19-10-2026')).toBeNull();
  });
});
```

`apps/api/test/weekly-report-data.e2e.spec.ts`(새):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Anomaly, AnomalyRule } from '../src/anomaly/anomaly.entity.js';
import { DeviceConnectivity } from '../src/device/device-connectivity.entity.js';
import { Firmware, FirmwareRollout, FirmwareRolloutTarget, RolloutStatus, TargetStatus } from '../src/firmware/firmware.entities.js';
import { parseKstWeekStart } from '../src/report/kst-week.js';
import { WeeklyReportQueries } from '../src/report/weekly-report.queries.js';
import { TerminalModel } from '../src/terminal/terminal-model.entity.js';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus as S, TransitionSource as T } from '../src/terminal/terminal-status.js';
import { VanReconciliationRun, VanRunStatus, VanRunTrigger } from '../src/van/van.entities.js';
import { insertTerminals } from './helpers/terminals.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

/** 2026-10-19(월) 주: [2026-10-18 15:00 UTC, 2026-10-25 15:00 UTC) */
const WEEK = parseKstWeekStart('2026-10-19')!;
const NOW = new Date('2026-10-26T00:00:00.000Z'); // 월요일 09:00 KST
const sec = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

describe('주간 리포트 데이터 — DB 집계와 KST 주 경계 (F11, decisions/0035)', () => {
  let t: TestApp;
  const em = () => t.orm.em.fork();

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    const ids = await insertTerminals(t, [
      { serialNo: 'WR-01', status: S.IN_SERVICE, merchantCode: 'GANGNAM-KIMBAP' },
      { serialNo: 'WR-02', status: S.IN_SERVICE, merchantCode: 'GANGNAM-KIMBAP' },
      { serialNo: 'WR-03', status: S.RETURNED, modelCode: 'SN-200' },
      { serialNo: 'WR-04', status: S.IN_STOCK, modelCode: 'SN-300' },
      { serialNo: 'WR-05', status: S.IN_SERVICE, merchantCode: 'GANGNAM-KIMBAP' },
    ]);
    const id = (s: string) => ids.get(s)!;
    // 이력 occurred_at은 datetime(초)이라 밀리초가 반올림된다 — 경계는 초 단위로 둔다
    const h = (serialNo: string, from: S | null, to: S, source: T, at: Date) => ({
      terminal: id(serialNo),
      fromStatus: from,
      toStatus: to,
      source,
      actor: 'test',
      reason: 'test',
      occurredAt: at,
    });
    await em().insertMany(TerminalStatusHistory, [
      h('WR-01', null, S.RECEIVED, T.IMPORT, sec(WEEK.from, -1)), // 주 시작 1초 전 — 빠짐
      h('WR-01', S.ALLOCATED, S.SHIPPED, T.SHIPMENT, WEEK.from), // 주 시작 — 들어감
      h('WR-02', null, S.RECEIVED, T.SCAN, sec(WEEK.to, -1)), // 주 끝 1초 전 — 들어감
      h('WR-03', S.RETURNING, S.RETURNED, T.SCAN, sec(WEEK.to, -60)),
      h('WR-04', S.ALLOCATED, S.SHIPPED, T.SHIPMENT, WEEK.to), // 다음 주 시작 — 빠짐
    ]);
    const a = (serialNo: string, rule: AnomalyRule, resolvedAt: Date | null) => ({
      terminalId: id(serialNo),
      rule,
      detectedAt: sec(NOW, -3600),
      lastSeenAt: NOW,
      resolvedAt,
      detail: {},
    });
    await em().insertMany(Anomaly, [
      a('WR-03', AnomalyRule.RETURN_STALLED, null),
      a('WR-05', AnomalyRule.OFFLINE_TOO_LONG, null),
      a('WR-01', AnomalyRule.IN_SERVICE_NO_MERCHANT, NOW), // 닫힘 — 빠짐
    ]);
    await em().insertMany(DeviceConnectivity, [
      { terminalId: id('WR-01'), online: true, lastSeenAt: sec(NOW, -30), firmwareVersion: '1.0.0', changedAt: NOW },
      { terminalId: id('WR-05'), online: true, lastSeenAt: sec(NOW, -86_400), firmwareVersion: '1.0.0', changedAt: NOW }, // 하루 전: 오프라인으로 센다
    ]);
    const model = await em().findOneOrFail(TerminalModel, { code: 'SN-100' });
    const e = em();
    const fw = e.create(Firmware, { model, version: '9.9.9', createdBy: 'test' });
    const r = (createdAt: Date, finishedAt: Date | null, status: RolloutStatus) =>
      e.create(FirmwareRollout, { firmware: fw, stages: [100], failureThreshold: 0.2, minSamples: 1, stageTimeoutMs: 1000, createdBy: 'test', createdAt, finishedAt, status });
    const inWeek = r(sec(WEEK.from, -86_400), sec(WEEK.from, 3600), RolloutStatus.COMPLETED); // 주 전에 시작해 주 안에 끝남 — 들어감
    r(sec(WEEK.from, -2 * 86_400), sec(WEEK.from, -86_400), RolloutStatus.ABORTED); // 주 전에 끝남 — 빠짐
    r(WEEK.to, null, RolloutStatus.RUNNING); // 다음 주 시작 — 빠짐
    const running = r(sec(WEEK.from, 7200), null, RolloutStatus.RUNNING); // 주 안에 시작해 아직 진행 — 들어감
    await e.flush();
    await em().insertMany(FirmwareRolloutTarget, [
      { rollout: inWeek.id, terminal: id('WR-01'), stage: 0, status: TargetStatus.SUCCEEDED, offeredAt: NOW },
      { rollout: inWeek.id, terminal: id('WR-02'), stage: 0, status: TargetStatus.SUCCEEDED, offeredAt: NOW },
      { rollout: inWeek.id, terminal: id('WR-05'), stage: 0, status: TargetStatus.FAILED, offeredAt: NOW },
    ]);
    expect(running.id).toBeGreaterThan(inWeek.id);
    const run = (status: VanRunStatus, confirmed: number) =>
      em().insert(VanReconciliationRun, {
        trigger: VanRunTrigger.SCHEDULED,
        requestedBy: 'system:van-reconcile',
        startedAt: NOW,
        finishedAt: NOW,
        status,
        fetched: 10,
        candidates: confirmed,
        confirmed,
        resolved: 0,
        counts: { NOT_REGISTERED: confirmed },
      });
    await run(VanRunStatus.COMPLETED, 1);
    await run(VanRunStatus.COMPLETED, 2); // 가장 최근 완료
    await run(VanRunStatus.FAILED, 9); // 실패한 실행은 빼고 본다
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('일곱 가지를 DB에서 집계하고 주 경계는 [KST 월 00:00, 다음 월 00:00)', async () => {
    const data = await t.app.get(WeeklyReportQueries).collect(WEEK, NOW);
    expect(data.week).toEqual({ weekStart: '2026-10-19', from: '2026-10-18T15:00:00.000Z', to: '2026-10-25T15:00:00.000Z' });
    expect(data.generatedAt).toBe(NOW.toISOString());
    expect(data.statusByModel).toEqual([
      { modelCode: 'SN-100', status: 'IN_SERVICE', count: 3 },
      { modelCode: 'SN-200', status: 'RETURNED', count: 1 },
      { modelCode: 'SN-300', status: 'IN_STOCK', count: 1 },
    ]);
    // ORDER BY enum 열은 글자 순서가 아니라 enum 선언 순서다(source: … SHIPMENT, SCAN …, rule: RETURN_STALLED가 OFFLINE_TOO_LONG보다 앞)
    expect(data.transitions).toEqual([
      { source: 'SHIPMENT', toStatus: 'SHIPPED', count: 1 },
      { source: 'SCAN', toStatus: 'RECEIVED', count: 1 },
      { source: 'SCAN', toStatus: 'RETURNED', count: 1 },
    ]);
    expect(data.flows).toEqual([
      { modelCode: 'SN-100', received: 1, shipped: 1, returned: 0 },
      { modelCode: 'SN-200', received: 0, shipped: 0, returned: 1 },
    ]);
    expect(data.anomalies.total).toBe(2);
    expect(data.anomalies.byRule).toEqual([
      { rule: 'RETURN_STALLED', open: 1 },
      { rule: 'OFFLINE_TOO_LONG', open: 1 },
    ]);
    expect(data.anomalies.items.map((i) => [i.serialNo, i.status, i.rule])).toEqual([
      ['WR-03', 'RETURNED', 'RETURN_STALLED'],
      ['WR-05', 'IN_SERVICE', 'OFFLINE_TOO_LONG'],
    ]);
    expect(data.connectivity).toEqual({ inService: 3, online: 1, offline: 1, noRecord: 1 });
    expect(data.rollouts.map((r) => [r.version, r.status, r.targets, r.succeeded, r.failed, r.timedOut])).toEqual([
      ['9.9.9', 'COMPLETED', 3, 2, 1, 0],
      ['9.9.9', 'RUNNING', 0, 0, 0, 0],
    ]);
    expect(data.van).toMatchObject({ confirmed: 2, fetched: 10, counts: { NOT_REGISTERED: 2 } });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit/kst-week.spec.ts test/weekly-report-data.e2e.spec.ts`
Expected: 두 파일 모두 `Error: Cannot find module '…/src/report/kst-week.js'`, `Test Files 2 failed (2)`.

- [ ] **Step 3: 구현**

`apps/api/src/report/kst-week.ts`(새):
```ts
/** 한국 시간(KST)은 UTC+9, 일광 절약 시간 없음 */
const KST_OFFSET_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;

/** 한 주: KST 월요일 00:00부터 다음 월요일 00:00 전까지. from·to는 그 순간의 UTC 시각(DB 비교용, [from, to)) */
export interface KstWeek {
  /** 그 주 월요일의 KST 날짜 'YYYY-MM-DD' */
  weekStart: string;
  from: Date;
  to: Date;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** KST로 바꾼 시각의 날짜 'YYYY-MM-DD' */
export function kstDate(instant: Date): string {
  const k = new Date(instant.getTime() + KST_OFFSET_MS);
  return `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())}`;
}

/**
 * instant가 속한 KST 주. DB는 UTC로 저장하므로(MikroORM forceUtcTimezone) 경계는 "KST 월요일 00:00 = 전날 15:00 UTC"다.
 * 서버 시간대(process TZ)에 기대지 않으려고 getUTC*만 쓴다(troubleshooting/0016과 같은 교훈, decisions/0035).
 */
export function kstWeekOf(instant: Date): KstWeek {
  const k = new Date(instant.getTime() + KST_OFFSET_MS); // KST 벽시계를 UTC 필드로 읽는다
  const sinceMonday = (k.getUTCDay() + 6) % 7; // 월 0 … 일 6
  const mondayKstAsUtc = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() - sinceMonday);
  const from = new Date(mondayKstAsUtc - KST_OFFSET_MS);
  return { weekStart: kstDate(from), from, to: new Date(from.getTime() + 7 * DAY_MS) };
}

/** instant 바로 앞 주(주간 리포트는 월요일 09:00 KST에 지난주를 낸다) */
export function previousKstWeek(instant: Date): KstWeek {
  return kstWeekOf(new Date(kstWeekOf(instant).from.getTime() - 1));
}

/** 'YYYY-MM-DD'(KST 월요일) → 그 주. 날짜가 아니거나 월요일이 아니면 null */
export function parseKstWeekStart(text: string): KstWeek | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const asUtc = new Date(Date.UTC(y, mo - 1, d));
  if (asUtc.getUTCFullYear() !== y || asUtc.getUTCMonth() !== mo - 1 || asUtc.getUTCDate() !== d) return null; // 2026-02-30 등
  const week = kstWeekOf(new Date(asUtc.getTime() - KST_OFFSET_MS));
  return week.weekStart === text ? week : null;
}
```

`apps/api/src/report/weekly-report.queries.ts`(새):
```ts
import { Injectable } from '@nestjs/common';
import { EntityManager, IsolationLevel } from '@mikro-orm/mysql';
import { fromDbDatetime } from '../common/db-datetime.js';
import { env } from '../config/env.js';
import type { KstWeek } from './kst-week.js';

/** 이상 단말기 시트에 담는 최대 행 수(나머지는 total로만) */
export const ANOMALY_SHEET_LIMIT = 1000;

export interface WeeklyReportData {
  week: { weekStart: string; from: string; to: string };
  generatedAt: string;
  /** 모델·상태별 단말기 수(만든 시각 기준) */
  statusByModel: { modelCode: string; status: string; count: number }[];
  /** 그 주의 전이 수(출처·도착 상태별) */
  transitions: { source: string; toStatus: string; count: number }[];
  /** 그 주의 입고(신규 등록)·출고·회수 입고 수(모델별) */
  flows: { modelCode: string; received: number; shipped: number; returned: number }[];
  /** 열린 이상 단말기(만든 시각 기준) */
  anomalies: {
    total: number;
    byRule: { rule: string; open: number }[];
    items: { serialNo: string; status: string; rule: string; detectedAt: string; lastSeenAt: string }[];
  };
  /** 운영 중 단말기의 접속 상태(MySQL 스냅샷 기준) */
  connectivity: { inService: number; online: number; offline: number; noRecord: number };
  /** 그 주에 진행 중이었거나 끝난 펌웨어 배포 */
  rollouts: {
    id: number;
    modelCode: string;
    version: string;
    status: string;
    createdAt: string;
    finishedAt: string | null;
    endReason: string | null;
    targets: number;
    succeeded: number;
    failed: number;
    timedOut: number;
  }[];
  /** 가장 최근에 끝난 VAN 대조 */
  van: { runId: number; finishedAt: string; fetched: number; candidates: number; confirmed: number; resolved: number; counts: Record<string, number> } | null;
}

const n = (v: unknown) => Number(v ?? 0);
const iso = (v: string | Date) => fromDbDatetime(v).toISOString();

/**
 * 주간 운영 리포트 데이터(F11). 모든 집계는 DB에서 한다(행을 앱으로 가져와 세지 않는다). 이상 단말기 목록만 최대 1,000행을 가져온다.
 * 일곱 쿼리를 한 REPEATABLE READ 읽기 전용 트랜잭션에서 돌려 같은 시점을 본다(F10 대조와 같은 방식).
 * 주 경계는 UTC 시각 [from, to)로 넘긴다 — SQL의 NOW()·세션 시간대를 쓰지 않는다(troubleshooting/0016).
 */
@Injectable()
export class WeeklyReportQueries {
  constructor(private readonly em: EntityManager) {}

  async collect(week: KstWeek, now = new Date()): Promise<WeeklyReportData> {
    return this.em.fork().transactional(
      async (tx) => {
        const range = [week.from, week.to];
        const statusByModel = await tx.execute<{ model_code: string; status: string; c: unknown }[]>(
          `select m.code as model_code, t.status, count(*) as c
             from terminal t join terminal_model m on m.id = t.model_id
            group by m.code, t.status order by m.code, t.status`,
        );
        const transitions = await tx.execute<{ source: string; to_status: string; c: unknown }[]>(
          `select source, to_status, count(*) as c from terminal_status_history
            where occurred_at >= ? and occurred_at < ?
            group by source, to_status order by source, to_status`,
          range,
        );
        const flows = await tx.execute<{ model_code: string; received: unknown; shipped: unknown; returned: unknown }[]>(
          `select m.code as model_code,
                  sum(h.to_status = 'RECEIVED' and h.from_status is null) as received,
                  sum(h.to_status = 'SHIPPED') as shipped,
                  sum(h.to_status = 'RETURNED') as returned
             from terminal_status_history h
             join terminal t on t.id = h.terminal_id
             join terminal_model m on m.id = t.model_id
            where h.occurred_at >= ? and h.occurred_at < ? and h.to_status in ('RECEIVED', 'SHIPPED', 'RETURNED')
            group by m.code order by m.code`,
          range,
        );
        const byRule = await tx.execute<{ rule: string; c: unknown }[]>(
          'select rule, count(*) as c from anomaly where resolved_at is null group by rule order by rule',
        );
        const anomalyItems = await tx.execute<{ serial_no: string; status: string; rule: string; detected_at: string; last_seen_at: string }[]>(
          `select t.serial_no, t.status, a.rule, a.detected_at, a.last_seen_at
             from anomaly a join terminal t on t.id = a.terminal_id
            where a.resolved_at is null
            order by a.rule, a.detected_at, a.id limit ${ANOMALY_SHEET_LIMIT}`,
        );
        // 판정 job이 아직 online을 못 내렸어도 마지막 하트비트가 기준보다 오래면 오프라인으로 센다(조회 API와 같은 규칙)
        const [conn] = await tx.execute<{ in_service: unknown; online: unknown; no_record: unknown }[]>(
          `select count(*) as in_service,
                  sum(c.online = 1 and c.last_seen_at >= ?) as online,
                  sum(c.terminal_id is null) as no_record
             from terminal t left join device_connectivity c on c.terminal_id = t.id
            where t.status = 'IN_SERVICE'`,
          [new Date(now.getTime() - env.hbOfflineAfterMs)],
        );
        const rollouts = await tx.execute<
          {
            id: number;
            model_code: string;
            version: string;
            status: string;
            created_at: string;
            finished_at: string | null;
            end_reason: string | null;
            targets: unknown;
            succeeded: unknown;
            failed: unknown;
            timed_out: unknown;
          }[]
        >(
          `select r.id, m.code as model_code, f.version, r.status, r.created_at, r.finished_at, r.end_reason,
                  count(x.id) as targets,
                  sum(x.status = 'SUCCEEDED') as succeeded, sum(x.status = 'FAILED') as failed, sum(x.status = 'TIMED_OUT') as timed_out
             from firmware_rollout r
             join firmware f on f.id = r.firmware_id
             join terminal_model m on m.id = f.model_id
             left join firmware_rollout_target x on x.rollout_id = r.id
            where r.created_at < ? and (r.finished_at is null or r.finished_at >= ?)
            group by r.id, m.code, f.version, r.status, r.created_at, r.finished_at, r.end_reason
            order by r.id`,
          [week.to, week.from],
        );
        const [van] = await tx.execute<
          { id: number; finished_at: string; fetched: number; candidates: number; confirmed: number; resolved: number; counts: Record<string, number> | string | null }[]
        >(`select id, finished_at, fetched, candidates, confirmed, resolved, counts from van_reconciliation_run where status = 'COMPLETED' order by id desc limit 1`);

        const inService = n(conn.in_service);
        const online = n(conn.online);
        const noRecord = n(conn.no_record);
        return {
          week: { weekStart: week.weekStart, from: week.from.toISOString(), to: week.to.toISOString() },
          generatedAt: now.toISOString(),
          statusByModel: statusByModel.map((r) => ({ modelCode: r.model_code, status: r.status, count: n(r.c) })),
          transitions: transitions.map((r) => ({ source: r.source, toStatus: r.to_status, count: n(r.c) })),
          flows: flows.map((r) => ({ modelCode: r.model_code, received: n(r.received), shipped: n(r.shipped), returned: n(r.returned) })),
          anomalies: {
            total: byRule.reduce((sum, r) => sum + n(r.c), 0),
            byRule: byRule.map((r) => ({ rule: r.rule, open: n(r.c) })),
            items: anomalyItems.map((r) => ({ serialNo: r.serial_no, status: r.status, rule: r.rule, detectedAt: iso(r.detected_at), lastSeenAt: iso(r.last_seen_at) })),
          },
          connectivity: { inService, online, offline: inService - online - noRecord, noRecord },
          rollouts: rollouts.map((r) => ({
            id: r.id,
            modelCode: r.model_code,
            version: r.version,
            status: r.status,
            createdAt: iso(r.created_at),
            finishedAt: r.finished_at ? iso(r.finished_at) : null,
            endReason: r.end_reason,
            targets: n(r.targets),
            succeeded: n(r.succeeded),
            failed: n(r.failed),
            timedOut: n(r.timed_out),
          })),
          van: van
            ? {
                runId: van.id,
                finishedAt: iso(van.finished_at),
                fetched: van.fetched,
                candidates: van.candidates,
                confirmed: van.confirmed,
                resolved: van.resolved,
                counts: typeof van.counts === 'string' ? JSON.parse(van.counts) : (van.counts ?? {}),
              }
            : null,
        };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
  }
}
```

`apps/api/src/report/report.module.ts`(새, Task 8이 바꾼다):
```ts
import { Module } from '@nestjs/common';
import { WeeklyReportQueries } from './weekly-report.queries.js';

/** 주간 운영 리포트(F11): 집계 쿼리 */
@Module({
  providers: [WeeklyReportQueries],
  exports: [WeeklyReportQueries],
})
export class ReportModule {}
```

`apps/api/src/app.module.ts`:
```diff
--- a/apps/api/src/app.module.ts
+++ b/apps/api/src/app.module.ts
@@ -19,6 +19,7 @@ import { DeviceModule } from './device/device.module.js';
 import { FirmwareModule } from './firmware/firmware.module.js';
 import { VanModule } from './van/van.module.js';
 import { AnomalyModule } from './anomaly/anomaly.module.js';
+import { ReportModule } from './report/report.module.js';
 import { WorkersModule } from './workers/workers.module.js';
 import { SchedulerModule } from './scheduler/scheduler.module.js';
 
@@ -48,6 +49,7 @@ export interface AppOptions {
     FirmwareModule,
     VanModule,
     AnomalyModule,
+    ReportModule,
   ],
   controllers: [HealthController],
   providers: [
```

- [ ] **Step 4: 통과 확인**

Run:
```bash
npx vitest run test/unit/kst-week.spec.ts test/weekly-report-data.e2e.spec.ts
npx vitest run && npm run typecheck
```
Expected: `Tests  4 passed (4)`. 데이터 테스트는 이력 경계(주 시작 1초 전 빠짐, 주 시작·끝 1초 전 들어감, 다음 주 시작 빠짐), enum 정렬 순서(`SHIPMENT`가 `SCAN` 앞), 하루 전 하트비트의 online 행을 오프라인으로 세는지, 닫힌 이상·주 밖 배포·실패한 VAN 실행이 빠지는지를 본다. 전체 `Test Files  50 passed (50)`, `Tests  318 passed (318)`, typecheck exit 0.

- [ ] **Step 5: 기록과 커밋**

devlog에 `## HH:MM Task 7 주간 리포트 데이터 — KST 주 경계와 DB 집계 (F11)` 항목.

`docs/decisions/0035-…`에 보탠다(집계):
- 주 경계: 주는 KST 월요일 00:00부터. DB는 UTC로 저장하므로(MikroORM forceUtcTimezone) 경계를 UTC 시각 `[일요일 15:00, 다음 일요일 15:00)`으로 넘긴다. 1) SQL에서 `convert_tz`·NOW() — 세션 시간대(SYSTEM=KST)와 저장값(UTC)이 섞인다(troubleshooting/0016). 2) **앱에서 계산해 파라미터로** — getUTC*만 써서 서버 시간대와도 무관. → 2. 경계 테스트(일요일 23:59 KST, UTC로는 일요일인 월요일 00:30 KST, 해가 바뀌는 주).
- 집계는 DB에서: 행을 앱으로 가져와 세지 않는다(이상 목록만 최대 1,000행). 일곱 쿼리를 한 RR 읽기 전용 트랜잭션에서(같은 시점).
- 이력 occurred_at은 datetime(초)라 밀리초가 반올림된다 — 경계에서 0.5초 안의 일은 다음 초로 셈. 주간 리포트에는 문제 없다고 보고 그대로 둔다.
- 이력 기간 집계(`occurred_at` 범위)는 인덱스가 없어 이력 전체를 훑는다. 주 1회라 두고 실험 0011이 시간·실행계획을 잰다(Task 9).

`docs/study/backlog.md`에 추가:
```
- [ ] 시간대 경계 — 저장은 UTC, 업무 날짜는 KST, 반열린 구간 [from, to) (src/report/kst-week.ts, decisions/0035)
```

커밋:
```bash
git add apps/api docs
git commit -m "feat(F11): 주간 리포트 데이터 — KST 주 경계와 DB 집계 쿼리" -m "Refs: docs/decisions/0035-주간-리포트와-cron-주기-작업.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 주간 리포트 보내기 — xlsx, 톡톡 첨부(base64), 멱등(week_start), 내려받기, 월요일 09:00 주기 (F11, F5, F12)

**Files:**
- Create: `apps/api/src/report/weekly-report.entity.ts`, `apps/api/src/report/weekly-report.xlsx.ts`, `apps/api/src/report/weekly-report.service.ts`, `apps/api/src/report/weekly-report.controller.ts`, `apps/api/src/report/dto/send-weekly-report.dto.ts`, `apps/api/src/migrations/Migration<시각>.ts`(생성)
- Modify: `apps/partners/src/state.ts`, `apps/partners/src/toktok.ts`, `apps/partners/src/server.ts`, `apps/api/src/outbox/toktok.client.ts`, `apps/api/src/outbox/outbox.module.ts`, `apps/api/src/report/report.module.ts`, `apps/api/src/report/report.processor.ts`, `apps/api/src/scheduler/job-schedulers.ts`, `apps/api/src/workers/workers.module.ts`, `apps/api/src/config/env.ts`, `apps/api/src/entities.ts`, `.env.example`
- Test: `apps/partners/test/toktok.spec.ts`, `apps/api/test/helpers/partners.ts`, `apps/api/test/weekly-report.e2e.spec.ts`(새), `apps/api/test/scheduler.e2e.spec.ts`
- Record: `docs/devlog/2026-10-26.md`, `docs/decisions/0035-…`(보탬), `docs/decisions/0009-…`(갱신 한 줄), `docs/study/backlog.md`

바꾸는 것 요약:
- partners 톡톡: `POST /toktok/files { fileName, contentType, contentBase64 }` → 201 `{ fileId: 'TF…', fileName, size }`(푼 크기, 5MB 넘으면 413 FILE_TOO_LARGE, base64 아니면 400, failRate면 500·저장 안 함). 웹훅 `attachments: [fileId]`(모르는 id면 400 UNKNOWN_FILE), 수신 기록에 `attachments: [{ fileId, fileName, size }]`(없으면 빈 배열), 요약에 `files` 수. `GET /__admin/toktok/files/:fileId`(내용 그대로).
- `ToktokClient.uploadFile(file)`·`send({ …, attachments })`. OutboxModule이 ToktokClient를 내보낸다.
- `WeeklyReport`(week_start date unique, PENDING·GENERATED·SENT, file mediumblob lazy, file_size, generated_at, sent_at, toktok_file_id, attempts, last_error).
- `buildWeeklyReportXlsx(data)`: 시트 8장(요약, 상태·모델, 전이, 입출고, 이상 단말기, 접속 상태, 펌웨어 배포, VAN 대조), 머리글 굵게, 열 너비, 시각은 KST `YYYY-MM-DD HH:mm`. 파일 이름 `단말온-주간리포트-<주>.xlsx`.
- `WeeklyReportService.send(week)`: Redis 잠금 `<p>:report-lock:weekly-<주>`(2분, 없으면 409 WEEKLY_REPORT_IN_PROGRESS) → 행 확보(동시 생성은 unique 위반 → 다시 읽기) → SENT면 `alreadySent` → 파일이 없으면 집계·xlsx·저장(GENERATED), 있으면 같은 파일 → attempts+1 → 올리기·메시지(멱등키 `weekly-report-<주>`, 각각 `withPartnerRetry` 3번) → SENT. 톡톡 실패면 last_error를 남기고 던짐(HTTP 502 PARTNER_ERROR). `sendScheduled(now)` = 지난주.
- API: `POST /reports/weekly { weekStart? }`(X-Operator, 기본 지난주, KST 월요일이 아니면 400 INVALID_WEEK_START), `GET /reports/weekly/:weekStart`, `GET /reports/weekly/:weekStart/file`(xlsx, `filename*=UTF-8''…`, 없으면 404).
- 주기: report 큐 `weekly-report`(`WEEKLY_REPORT_CRON`, 기본 `0 9 * * 1`, Asia/Seoul) → `ReportProcessor`가 `sendScheduled()`.

- [ ] **Step 1: 실패하는 테스트 작성 (partners)**

`apps/partners/test/toktok.spec.ts`(describe 하나 추가):
```diff
--- a/apps/partners/test/toktok.spec.ts
+++ b/apps/partners/test/toktok.spec.ts
@@ -34,4 +34,47 @@ describe('톡톡메신저 웹훅', () => {
     expect((await send({ idempotencyKey: 'k1', text: 'x' })).status).toBe(500);
     expect((await messages()).total).toBe(0);
   });
+
+  describe('파일 올리기와 메시지 첨부 (decisions/0035)', () => {
+    const upload = (body: unknown) =>
+      fetch(`${p.base}/toktok/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
+    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10]);
+    const file = { fileName: '단말온-주간리포트-2026-10-19.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', contentBase64: bytes.toString('base64') };
+
+    it('base64 JSON으로 올리면 fileId와 푼 크기를 주고, 메시지에 첨부하면 수신 기록에 이름·크기가 남는다. 관리 API로 내용을 그대로 받는다', async () => {
+      const res = await upload(file);
+      expect(res.status).toBe(201);
+      const up = await res.json();
+      expect(up).toEqual({ fileId: expect.stringMatching(/^TF\d+$/), fileName: file.fileName, size: 7 });
+      expect((await send({ idempotencyKey: 'weekly-report-2026-10-19', text: '주간 리포트', attachments: [up.fileId] })).status).toBe(200);
+      const m = await messages();
+      expect(m.files).toBe(1);
+      expect(m.messages[0].attachments).toEqual([{ fileId: up.fileId, fileName: file.fileName, size: 7 }]);
+      const back = await fetch(`${p.base}/__admin/toktok/files/${up.fileId}`);
+      expect(back.headers.get('content-type')).toBe(file.contentType);
+      expect(Buffer.from(await back.arrayBuffer())).toEqual(bytes);
+      expect((await p.stats()).calls).toMatchObject({ 'toktok.file': 1, 'toktok.hook': 1 });
+    });
+
+    it('첨부 없는 메시지는 attachments가 빈 배열, 올리지 않은 fileId를 첨부하면 400 UNKNOWN_FILE(저장 안 함)', async () => {
+      await send({ idempotencyKey: 'k1', text: '그냥 알림' });
+      expect((await messages()).messages[0].attachments).toEqual([]);
+      const bad = await send({ idempotencyKey: 'k2', text: 'x', attachments: ['TF-NOPE'] });
+      expect(bad.status).toBe(400);
+      expect((await bad.json()).error).toBe('UNKNOWN_FILE');
+      expect((await messages()).total).toBe(1);
+    });
+
+    it('base64가 아니거나 필드가 빠지면 400, 너무 크면 413, failRate=1이면 500이고 저장하지 않는다', async () => {
+      expect((await upload({ ...file, contentBase64: '***' })).status).toBe(400);
+      expect((await upload({ fileName: 'a.xlsx' })).status).toBe(400);
+      await p.configure({ toktok: { maxFileBytes: 4 } });
+      const big = await upload(file);
+      expect(big.status).toBe(413);
+      expect((await big.json()).error).toBe('FILE_TOO_LARGE');
+      await p.configure({ toktok: { maxFileBytes: 1024, failRate: 1 } });
+      expect((await upload(file)).status).toBe(500);
+      expect((await messages()).files).toBe(0);
+    });
+  });
 });
```

Run(`apps/partners`): `npx vitest run test/toktok.spec.ts`
Expected: `Tests  3 failed | 3 passed (6)` — `expected 404 to be 201`(경로 없음), `expected undefined to deeply equal []`(attachments 없음), `expected 404 to be 400`.

- [ ] **Step 2: 구현 (partners)**

`apps/partners/src/state.ts`:
```diff
--- a/apps/partners/src/state.ts
+++ b/apps/partners/src/state.ts
@@ -25,8 +25,10 @@ export interface NeurimboConfig {
 }
 
 export interface ToktokConfig {
-  /** 500을 낼 확률(0~1). 실패한 요청은 저장하지 않는다. */
+  /** 500을 낼 확률(0~1). 실패한 요청은 저장하지 않는다(웹훅·파일 올리기 모두). */
   failRate: number;
+  /** 올릴 수 있는 파일 크기 상한(바이트, base64를 푼 크기) */
+  maxFileBytes: number;
 }
 
 export interface SeumConfig {
@@ -79,7 +81,7 @@ export function defaultConfig(): PartnersConfig {
     seed: 42,
     bungae: { advancePerPoll: 1, duplicateRate: 0, rateLimitPerSec: 20, force429Rate: 0, retryAfterSec: 1, delayMs: 0 },
     neurimbo: { advancePerPoll: 1, delayMs: 0, error5xxRate: 0, shuffle: false },
-    toktok: { failRate: 0 },
+    toktok: { failRate: 0, maxFileBytes: 5 * 1024 * 1024 },
     seum: { shortfall: 0, foreignSerials: 0, error5xxRate: 0 },
     bridgevan: { maxLimit: 1000, delayMs: 0, error5xxRate: 0, force429Rate: 0, retryAfterSec: 1, mutateDuringScan: 0 },
   };
@@ -115,11 +117,23 @@ export interface VanRegistration {
   healTo?: { status?: VanStatus; merchantCode?: string };
 }
 
+/** 톡톡메신저에 올린 파일(메시지 첨부용) */
+export interface ToktokFile {
+  fileId: string;
+  fileName: string;
+  contentType: string;
+  size: number;
+  content: Buffer;
+  uploadedAt: string;
+}
+
 export interface ToktokMessage {
   channel: string;
   idempotencyKey: string;
   text: string;
   receivedAt: string;
+  /** 첨부 파일(올린 파일의 id·이름·크기) */
+  attachments: { fileId: string; fileName: string; size: number }[];
 }
 
 export interface Stats {
@@ -165,6 +179,8 @@ export class PartnersState {
   /** 번개 추적 조회가 받아들여진 시각(최근 1초) */
   bungaeWindow: number[] = [];
   messages: ToktokMessage[] = [];
+  /** 톡톡메신저에 올린 파일(fileId → 파일) */
+  files = new Map<string, ToktokFile>();
   /** 브릿지VAN 등록(tid → 등록), tid 오름차순 목록(커서 페이지용), 시리얼 → tid */
   van = new Map<string, VanRegistration>();
   vanTids: string[] = [];
@@ -182,6 +198,7 @@ export class PartnersState {
     this.seum.clear();
     this.bungaeWindow = [];
     this.messages = [];
+    this.files.clear();
     this.van.clear();
     this.vanTids = [];
     this.vanBySerial.clear();
```

`apps/partners/src/toktok.ts` 전체:
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendJson } from './http.js';
import type { PartnersState } from './state.js';

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** 골칫거리: 가끔 실패한다. 실패한 요청은 저장하지 않는다(받지 못한 것으로 본다). 응답을 보냈으면 true */
function failed(state: PartnersState, res: ServerResponse): boolean {
  if (!state.chance(state.config.toktok.failRate)) return false;
  state.stats.status5xx += 1;
  sendJson(res, 500, { error: 'TEMPORARY' });
  return true;
}

/**
 * POST /toktok/hooks/:channel  { idempotencyKey, text, attachments?: [fileId] } → 200. 받은 메시지는 중복이어도 모두 저장한다.
 * attachments는 먼저 POST /toktok/files로 올린 파일의 id. 모르는 id가 있으면 400 UNKNOWN_FILE(메시지를 저장하지 않는다).
 */
export async function toktokHook(state: PartnersState, channel: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  state.count('toktok.hook');
  const body = await readJson(req);
  const attachments = body?.attachments ?? [];
  if (!body || typeof body.idempotencyKey !== 'string' || typeof body.text !== 'string' || !Array.isArray(attachments) || attachments.some((a) => typeof a !== 'string')) {
    return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'idempotencyKey, text가 필요합니다(attachments는 파일 id 배열).' });
  }
  const unknown = (attachments as string[]).filter((id) => !state.files.has(id));
  if (unknown.length > 0) return sendJson(res, 400, { error: 'UNKNOWN_FILE', message: `올리지 않은 파일: ${unknown.join(', ')}` });
  if (failed(state, res)) return;
  state.messages.push({
    channel,
    idempotencyKey: body.idempotencyKey,
    text: body.text,
    receivedAt: new Date().toISOString(),
    attachments: (attachments as string[]).map((id) => {
      const f = state.files.get(id)!;
      return { fileId: f.fileId, fileName: f.fileName, size: f.size };
    }),
  });
  sendJson(res, 200, { ok: true });
}

/**
 * POST /toktok/files  { fileName, contentType, contentBase64 } → 201 { fileId, fileName, size }
 * 파일은 JSON 안의 base64로 받는다(multipart가 아니다 — 의존성 없는 node:http 서버에서 multipart를 직접 풀지 않으려고, decisions/0035).
 * 푼 크기가 maxFileBytes를 넘으면 413, base64가 아니면 400.
 */
export async function toktokUpload(state: PartnersState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  state.count('toktok.file');
  const body = await readJson(req);
  const { fileName, contentType, contentBase64 } = (body ?? {}) as Record<string, unknown>;
  if (typeof fileName !== 'string' || !fileName || typeof contentType !== 'string' || typeof contentBase64 !== 'string' || contentBase64.length % 4 !== 0 || !BASE64.test(contentBase64)) {
    return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'fileName, contentType, contentBase64(base64)가 필요합니다.' });
  }
  const content = Buffer.from(contentBase64, 'base64');
  if (content.length > state.config.toktok.maxFileBytes) {
    return sendJson(res, 413, { error: 'FILE_TOO_LARGE', message: `파일은 ${state.config.toktok.maxFileBytes}바이트까지 받습니다.` });
  }
  if (failed(state, res)) return;
  const fileId = `TF${state.nextNumber()}`;
  state.files.set(fileId, { fileId, fileName, contentType, size: content.length, content, uploadedAt: new Date().toISOString() });
  sendJson(res, 201, { fileId, fileName, size: content.length });
}

/** GET /__admin/toktok/files/:fileId → 올린 파일 그대로(테스트가 첨부 내용을 확인한다) */
export function toktokFile(state: PartnersState, fileId: string, res: ServerResponse): void {
  const f = state.files.get(fileId);
  if (!f) return sendJson(res, 404, { error: 'NOT_FOUND' });
  res.writeHead(200, { 'Content-Type': f.contentType, 'Content-Length': String(f.size) });
  res.end(f.content);
}

/** 멱등키별 수신 횟수. 2 이상이면 같은 알림을 두 번 이상 받은 것이다. */
export function toktokSummary(state: PartnersState) {
  const byKey: Record<string, number> = {};
  for (const m of state.messages) byKey[m.idempotencyKey] = (byKey[m.idempotencyKey] ?? 0) + 1;
  return { total: state.messages.length, byKey, messages: state.messages, files: state.files.size };
}
```

`apps/partners/src/server.ts`:
```diff
--- a/apps/partners/src/server.ts
+++ b/apps/partners/src/server.ts
@@ -5,7 +5,7 @@ import { BadJsonError, readJson, sendJson } from './http.js';
 import { neurimboCreateInvoice, neurimboTrack } from './neurimbo.js';
 import { seumCreatePurchaseOrder, seumDeliveryNote } from './seum.js';
 import { PartnersState, type ConfigPatch } from './state.js';
-import { toktokHook, toktokSummary } from './toktok.js';
+import { toktokFile, toktokHook, toktokSummary, toktokUpload } from './toktok.js';
 
 async function route(state: PartnersState, req: IncomingMessage, res: ServerResponse): Promise<void> {
   const url = new URL(req.url ?? '/', 'http://partners');
@@ -25,6 +25,7 @@ async function route(state: PartnersState, req: IncomingMessage, res: ServerResp
   }
   if (method === 'GET' && path === '/__admin/stats') return sendJson(res, 200, state.stats);
   if (method === 'GET' && path === '/__admin/toktok/messages') return sendJson(res, 200, toktokSummary(state));
+  if (method === 'GET' && (m = path.match(/^\/__admin\/toktok\/files\/([^/]+)$/))) return toktokFile(state, decodeURIComponent(m[1]), res);
   if (method === 'POST' && path === '/__admin/bridgevan/registrations') return bridgevanSeed(state, req, res);
 
   // 번개택배(JSON)
@@ -49,7 +50,8 @@ async function route(state: PartnersState, req: IncomingMessage, res: ServerResp
     return bridgevanGet(state, decodeURIComponent(m[1]), res);
   }
 
-  // 톡톡메신저 웹훅
+  // 톡톡메신저 웹훅·파일 올리기(메시지 첨부)
+  if (method === 'POST' && path === '/toktok/files') return toktokUpload(state, req, res);
   if (method === 'POST' && (m = path.match(/^\/toktok\/hooks\/([^/]+)$/))) {
     return toktokHook(state, decodeURIComponent(m[1]), req, res);
   }
```

Run(`apps/partners`): `npx vitest run && npm run typecheck && npm run build`
Expected: `Test Files  6 passed (6)`, `Tests  50 passed (50)`, typecheck·build exit 0.

- [ ] **Step 3: 실패하는 테스트 작성 (api)**

`apps/api/test/helpers/partners.ts`:
```diff
--- a/apps/api/test/helpers/partners.ts
+++ b/apps/api/test/helpers/partners.ts
@@ -43,7 +43,15 @@ export interface VanSeed {
 export interface ToktokSummary {
   total: number;
   byKey: Record<string, number>;
-  messages: { channel: string; idempotencyKey: string; text: string; receivedAt: string }[];
+  messages: {
+    channel: string;
+    idempotencyKey: string;
+    text: string;
+    receivedAt: string;
+    attachments: { fileId: string; fileName: string; size: number }[];
+  }[];
+  /** 올린 파일 수 */
+  files: number;
 }
 
 export const partners = {
@@ -51,6 +59,12 @@ export const partners = {
   configure: (patch: Record<string, unknown>) => call<unknown>('POST', '/__admin/config', patch),
   stats: () => call<PartnersStats>('GET', '/__admin/stats'),
   toktok: () => call<ToktokSummary>('GET', '/__admin/toktok/messages'),
+  /** 톡톡메신저에 올라간 첨부 파일 내용 */
+  toktokFile: async (fileId: string) => {
+    const res = await fetch(`${env.partnersUrl}/__admin/toktok/files/${encodeURIComponent(fileId)}`);
+    if (!res.ok) throw new Error(`partners toktok file ${fileId} → ${res.status}`);
+    return Buffer.from(await res.arrayBuffer());
+  },
   /** 세움전자 납품 명세(테스트가 "공장이 보낸 박스"를 만들 때 쓴다). 호출 수(seum.deliveryNote)에 더해진다. */
   /** 브릿지VAN 등록을 심는다(replace 기본 true: 기존 등록을 지우고) */
   seedVan: (registrations: VanSeed[], replace = true) =>
```

`apps/api/test/scheduler.e2e.spec.ts`:
```diff
--- a/apps/api/test/scheduler.e2e.spec.ts
+++ b/apps/api/test/scheduler.e2e.spec.ts
@@ -37,7 +37,10 @@ describe('주기 작업 삭제 (scheduler:clear, decisions/0015)', () => {
     expect([next.getUTCHours(), next.getUTCMinutes()]).toEqual([17, 0]); // 02:00 KST = 전날 17:00 UTC
     const van = await queueOf(QUEUE.REPORT).getJobScheduler('van-reconcile-daily');
     expect(new Date(van!.next!).getUTCHours()).toBe(18);
-    expect(await queueOf(QUEUE.REPORT).getJobCounts('waiting', 'delayed')).toEqual({ waiting: 0, delayed: 2 });
+    // 월요일 09:00 KST = 월요일 00:00 UTC
+    const weekly = new Date((await queueOf(QUEUE.REPORT).getJobScheduler('weekly-report'))!.next!);
+    expect([weekly.getUTCDay(), weekly.getUTCHours(), weekly.getUTCMinutes()]).toEqual([1, 0, 0]);
+    expect(await queueOf(QUEUE.REPORT).getJobCounts('waiting', 'delayed')).toEqual({ waiting: 0, delayed: 3 });
 
     expect(await clearJobSchedulers(queueOf)).toEqual(JOB_SCHEDULERS.map((s) => s.id));
     for (const name of queues) {
```

`apps/api/test/weekly-report.e2e.spec.ts`(새):
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { Redis } from 'ioredis';
import { RedisLock } from '../src/redis/redis-lock.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { WeeklyReport, WeeklyReportStatus } from '../src/report/weekly-report.entity.js';
import { WeeklyReportService } from '../src/report/weekly-report.service.js';
import { SHEET_NAMES } from '../src/report/weekly-report.xlsx.js';
import { TerminalStatus as S } from '../src/terminal/terminal-status.js';
import { partners } from './helpers/partners.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { insertTerminals } from './helpers/terminals.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'park' };

async function readXlsx(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

describe('주간 운영 리포트 — xlsx, 톡톡 첨부, 멱등, 내려받기 (F11, decisions/0035)', () => {
  let t: TestApp;
  const em = () => t.orm.em.fork();
  const row = (weekStart: string) => em().findOneOrFail(WeeklyReport, { weekStart });
  const send = (weekStart?: string) => t.http().post('/reports/weekly').set(OP).send(weekStart ? { weekStart } : {});

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await insertTerminals(t, [
      { serialNo: 'WK-01', status: S.IN_SERVICE, merchantCode: 'GANGNAM-KIMBAP' },
      { serialNo: 'WK-02', status: S.IN_STOCK, modelCode: 'SN-200' },
    ]);
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await deleteTestKeys(t.app.get<Redis>(REDIS));
    await t.app.close();
  });

  it('보내면 xlsx를 만들어 저장하고, 톡톡에 파일을 올려 메시지에 첨부한다(이름·크기가 같다)', async () => {
    const res = await send('2026-10-19');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      weekStart: '2026-10-19',
      status: 'SENT',
      fileName: '단말온-주간리포트-2026-10-19.xlsx',
      attempts: 1,
      lastError: null,
      alreadySent: false,
    });
    expect(res.body.fileSize).toBeGreaterThan(1000);
    const toktok = await partners.toktok();
    expect(toktok.total).toBe(1);
    expect(toktok.messages[0]).toMatchObject({ idempotencyKey: 'weekly-report-2026-10-19' });
    expect(toktok.messages[0].attachments).toEqual([{ fileId: expect.any(String), fileName: res.body.fileName, size: res.body.fileSize }]);
    expect((await row('2026-10-19')).toktokFileId).toBe(toktok.messages[0].attachments[0].fileId);

    // 메신저가 받은 첨부를 그대로 열어 본다
    const wb = await readXlsx(await partners.toktokFile(toktok.messages[0].attachments[0].fileId));
    expect(wb.worksheets.map((w) => w.name)).toEqual([...SHEET_NAMES]);
    const summary = wb.getWorksheet('요약')!;
    expect(summary.getRow(2).values).toEqual([undefined, '주', '2026-10-19 ~ 2026-10-25 (KST)']);
    expect(summary.getRow(4).values).toEqual([undefined, '단말기 총수', 2]);
    const status = wb.getWorksheet('상태·모델')!;
    expect(status.getRow(1).values).toEqual([undefined, '모델', '상태', '대수']);
    expect(status.getRow(2).values).toEqual([undefined, 'SN-100', 'IN_SERVICE', 1]);
  });

  it('같은 주를 다시 보내면 아무것도 하지 않는다(alreadySent, 올리기·메시지 0번)', async () => {
    const res = await send('2026-10-19');
    expect(res.body).toMatchObject({ status: 'SENT', alreadySent: true, attempts: 1 });
    expect(await partners.toktok()).toMatchObject({ total: 0, files: 0 });
  });

  it('톡톡이 계속 실패하면 502이고 행은 GENERATED(파일 저장, lastError). 다시 보내면 같은 파일로 보낸다', async () => {
    await partners.configure({ toktok: { failRate: 1 } });
    const failed = await send('2026-10-12');
    expect(failed.status).toBe(502);
    expect(failed.body.code).toBe('PARTNER_ERROR');
    const r1 = await row('2026-10-12');
    expect(r1).toMatchObject({ status: WeeklyReportStatus.GENERATED, attempts: 1 });
    expect(r1.lastError).toMatch(/톡톡메신저 파일 응답 500/);
    expect((await partners.stats()).calls['toktok.file']).toBe(3); // 3번까지 다시 불렀다

    await partners.configure({ toktok: { failRate: 0 } });
    const ok = await send('2026-10-12');
    expect(ok.body).toMatchObject({ status: 'SENT', attempts: 2, lastError: null, fileSize: r1.fileSize });
    expect(ok.body.generatedAt).toBe(r1.generatedAt!.toISOString()); // 다시 만들지 않았다
  }, 20_000);

  it('GET 상태와 xlsx 내려받기(한글 파일 이름은 filename*), 주 형식이 틀리면 400, 없으면 404', async () => {
    const meta = await t.http().get('/reports/weekly/2026-10-19');
    expect(meta.body).toMatchObject({ weekStart: '2026-10-19', status: 'SENT' });
    const file = await t.http().get('/reports/weekly/2026-10-19/file').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(file.headers['content-disposition']).toBe(
      `attachment; filename="weekly-report-2026-10-19.xlsx"; filename*=UTF-8''${encodeURIComponent('단말온-주간리포트-2026-10-19.xlsx')}`,
    );
    expect((file.body as Buffer).length).toBe(meta.body.fileSize);
    expect((await readXlsx(file.body as Buffer)).worksheets).toHaveLength(SHEET_NAMES.length);

    expect((await t.http().get('/reports/weekly/2026-10-20')).body.code).toBe('INVALID_WEEK_START'); // 화요일
    expect((await send('2026-10-20')).status).toBe(400);
    expect((await t.http().get('/reports/weekly/2026-09-07')).status).toBe(404);
    expect((await t.http().get('/reports/weekly/2026-09-07/file')).status).toBe(404);
  });

  it('같은 주를 다른 요청이 보내는 중이면 409 WEEKLY_REPORT_IN_PROGRESS', async () => {
    const lock = t.app.get(RedisLock);
    const key = lock.keyOf('report-lock', 'weekly-2026-10-05');
    const token = await lock.acquire(key, 10_000);
    try {
      const busy = await send('2026-10-05');
      expect(busy.status).toBe(409);
      expect(busy.body.code).toBe('WEEKLY_REPORT_IN_PROGRESS');
    } finally {
      await lock.release(key, token!);
    }
  });

  it('주기 job은 지난주를 보낸다(월요일 09:00 KST에 돌면 그 앞 주)', async () => {
    const { report, alreadySent } = await t.app.get(WeeklyReportService).sendScheduled(new Date('2026-11-02T00:00:00.000Z'));
    expect([report.weekStart, report.status, alreadySent]).toEqual(['2026-10-26', WeeklyReportStatus.SENT, false]);
  });
});
```

Run: `npx vitest run test/weekly-report.e2e.spec.ts test/scheduler.e2e.spec.ts`
Expected: `Test Files 2 failed (2)` — `Cannot find module '../src/report/weekly-report.entity.js'`, 주기 작업 테스트 `TypeError: Cannot read properties of undefined (reading 'next')`(weekly-report 스케줄러 없음).

- [ ] **Step 4: 구현 (api)**

`apps/api/src/outbox/toktok.client.ts` 전체:
```ts
import { PartnerPermanentError } from '../common/partner-errors.js';
import { partnerFetch } from '../common/partner-http.js';

export interface ToktokOptions {
  baseUrl: string;
  channel: string;
  timeoutMs: number;
}

/** 톡톡메신저 웹훅. 같은 idempotencyKey를 다시 보내도 메신저가 한 번으로 보이게 하는 것이 약속이다(가상). */
export class ToktokClient {
  constructor(private readonly opts: ToktokOptions) {}

  /** 메시지. attachments는 uploadFile이 준 fileId들 */
  async send(message: { idempotencyKey: string; text: string; attachments?: string[] }): Promise<void> {
    await partnerFetch(
      '톡톡메신저',
      `${this.opts.baseUrl}/toktok/hooks/${encodeURIComponent(this.opts.channel)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) },
      this.opts.timeoutMs,
    );
  }

  /** 첨부할 파일을 올린다(JSON 안의 base64, decisions/0035). @returns 메시지에 붙일 fileId와 메신저가 받은 크기 */
  async uploadFile(file: { fileName: string; contentType: string; content: Buffer }): Promise<{ fileId: string; size: number }> {
    const text = await partnerFetch(
      '톡톡메신저 파일',
      `${this.opts.baseUrl}/toktok/files`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.fileName, contentType: file.contentType, contentBase64: file.content.toString('base64') }),
      },
      this.opts.timeoutMs,
    );
    let body: { fileId?: unknown; size?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      throw new PartnerPermanentError('톡톡메신저 파일 응답이 JSON이 아닙니다.');
    }
    if (typeof body.fileId !== 'string' || typeof body.size !== 'number') throw new PartnerPermanentError('톡톡메신저 파일 응답 형식이 아닙니다(fileId, size).');
    return { fileId: body.fileId, size: body.size };
  }
}
```

`apps/api/src/outbox/outbox.module.ts`:
```diff
--- a/apps/api/src/outbox/outbox.module.ts
+++ b/apps/api/src/outbox/outbox.module.ts
@@ -11,6 +11,6 @@ import { ToktokClient } from './toktok.client.js';
       useFactory: () => new ToktokClient({ baseUrl: env.partnersUrl, channel: env.toktokChannel, timeoutMs: env.partnerTimeoutMs }),
     },
   ],
-  exports: [OutboxService],
+  exports: [OutboxService, ToktokClient],
 })
 export class OutboxModule {}
```

`apps/api/src/report/weekly-report.entity.ts`(새):
```ts
import { OptionalProps } from '@mikro-orm/core';
import { Entity, Enum, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

export enum WeeklyReportStatus {
  PENDING = 'PENDING', // 행만 있음(파일 아직 없음)
  GENERATED = 'GENERATED', // 파일을 만들어 저장함, 아직 못 보냄
  SENT = 'SENT', // 톡톡메신저로 보냄. 같은 주는 다시 보내지 않는다
}

/**
 * 주간 운영 리포트 한 주(F11). week_start unique라 같은 주는 한 행 — 다시 시도하면 같은 행을 갱신하고, SENT면 보내지 않는다(멱등, decisions/0035).
 * 파일(xlsx)은 이 행의 mediumblob에 둔다(작고, 어느 프로세스든 같은 파일을 내려줄 수 있게). lazy라 목록·상태 조회는 파일을 읽지 않는다.
 */
@Entity({ tableName: 'weekly_report' })
export class WeeklyReport {
  [OptionalProps]?: 'status' | 'fileName' | 'file' | 'fileSize' | 'generatedAt' | 'sentAt' | 'toktokFileId' | 'attempts' | 'lastError' | 'createdAt';

  @PrimaryKey()
  id!: number;

  /** 그 주 월요일(KST) 날짜 */
  @Property({ type: 'date', unique: true })
  weekStart!: string;

  @Enum({ items: () => WeeklyReportStatus })
  status: WeeklyReportStatus = WeeklyReportStatus.PENDING;

  @Property({ type: 'varchar', length: 100, nullable: true })
  fileName: string | null = null;

  @Property({ type: 'blob', columnType: 'mediumblob', nullable: true, lazy: true })
  file: Buffer | null = null;

  @Property({ type: 'integer', nullable: true })
  fileSize: number | null = null;

  @Property({ type: 'datetime', length: 3, nullable: true })
  generatedAt: Date | null = null;

  @Property({ type: 'datetime', length: 3, nullable: true })
  sentAt: Date | null = null;

  /** 마지막으로 올린 첨부의 톡톡 fileId */
  @Property({ type: 'varchar', length: 64, nullable: true })
  toktokFileId: string | null = null;

  /** 보내기 시도 횟수 */
  @Property()
  attempts: number = 0;

  @Property({ type: 'varchar', length: 500, nullable: true })
  lastError: string | null = null;

  @Property({ type: 'datetime', length: 3 })
  createdAt: Date = new Date();
}
```

`apps/api/src/report/weekly-report.xlsx.ts`(새):
```ts
import ExcelJS from 'exceljs';
import { ANOMALY_RULE_LABEL } from '../anomaly/anomaly-rules.js';
import type { AnomalyRule } from '../anomaly/anomaly.entity.js';
import { KIND_LABEL } from '../van/van-compare.js';
import type { VanMismatchKind } from '../van/van.entities.js';
import { kstDate } from './kst-week.js';
import type { WeeklyReportData } from './weekly-report.queries.js';

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 시트 이름(순서대로). 엑셀 시트 이름에는 : \ / ? * [ ]를 쓸 수 없고 31자까지다 */
export const SHEET_NAMES = ['요약', '상태·모델', '전이', '입출고', '이상 단말기', '접속 상태', '펌웨어 배포', 'VAN 대조'] as const;

export function weeklyReportFileName(weekStart: string): string {
  return `단말온-주간리포트-${weekStart}.xlsx`;
}

/** ISO 시각 → 'YYYY-MM-DD HH:mm' (KST) */
function kst(isoText: string | null): string {
  if (!isoText) return '';
  const k = new Date(new Date(isoText).getTime() + 9 * 3_600_000);
  return k.toISOString().slice(0, 16).replace('T', ' ');
}

/** 머리글(굵게)과 행을 넣고 열 너비를 글자 수에 맞춘다 */
function table(sheet: ExcelJS.Worksheet, header: string[], rows: (string | number)[][]): void {
  sheet.addRow(header).font = { bold: true };
  for (const r of rows) sheet.addRow(r);
  header.forEach((h, i) => {
    const longest = Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length));
    sheet.getColumn(i + 1).width = Math.min(60, Math.max(10, longest + 4));
  });
}

/**
 * 주간 리포트 xlsx(F11). 데이터는 WeeklyReportQueries가 DB에서 집계한 것이고, 여기서는 시트로 옮기기만 한다.
 * exceljs writeBuffer는 자체 Buffer 타입(ArrayBuffer 계열)을 돌려준다 — Node Buffer로 감싸 돌려준다(decisions/0022와 같은 타입 문제).
 */
export async function buildWeeklyReportXlsx(data: WeeklyReportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '단말온 terminal-ops';
  wb.created = new Date(data.generatedAt);
  const [summary, statusSheet, transitionSheet, flowSheet, anomalySheet, connSheet, rolloutSheet, vanSheet] = SHEET_NAMES.map((name) => wb.addWorksheet(name));

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const flowTotal = (k: 'received' | 'shipped' | 'returned') => sum(data.flows.map((f) => f[k]));
  table(summary, ['항목', '값'], [
    ['주', `${data.week.weekStart} ~ ${kstDate(new Date(new Date(data.week.to).getTime() - 1))} (KST)`],
    ['만든 시각', kst(data.generatedAt)],
    ['단말기 총수', sum(data.statusByModel.map((r) => r.count))],
    ['운영 중', sum(data.statusByModel.filter((r) => r.status === 'IN_SERVICE').map((r) => r.count))],
    ['지난주 상태 전이', sum(data.transitions.map((r) => r.count))],
    ['지난주 입고', flowTotal('received')],
    ['지난주 출고', flowTotal('shipped')],
    ['지난주 회수 입고', flowTotal('returned')],
    ['열린 이상 단말기', data.anomalies.total],
    ...data.anomalies.byRule.map((r): [string, number] => [`  ${ANOMALY_RULE_LABEL[r.rule as AnomalyRule] ?? r.rule}`, r.open]),
    ['온라인 / 오프라인', `${data.connectivity.online} / ${data.connectivity.offline}`],
    ['펌웨어 배포', data.rollouts.length],
    ['VAN 대조 어긋남', data.van ? `${data.van.confirmed} (#${data.van.runId})` : '실행 없음'],
  ]);
  table(statusSheet, ['모델', '상태', '대수'], data.statusByModel.map((r) => [r.modelCode, r.status, r.count]));
  table(transitionSheet, ['출처', '도착 상태', '건수'], data.transitions.map((r) => [r.source, r.toStatus, r.count]));
  table(flowSheet, ['모델', '입고(신규 등록)', '출고', '회수 입고'], data.flows.map((r) => [r.modelCode, r.received, r.shipped, r.returned]));
  table(
    anomalySheet,
    ['시리얼', '지금 상태', '규칙', '처음 발견(KST)', '마지막 확인(KST)'],
    data.anomalies.items.map((r) => [r.serialNo, r.status, ANOMALY_RULE_LABEL[r.rule as AnomalyRule] ?? r.rule, kst(r.detectedAt), kst(r.lastSeenAt)]),
  );
  if (data.anomalies.total > data.anomalies.items.length) anomalySheet.addRow([`… 외 ${data.anomalies.total - data.anomalies.items.length}건(GET /anomalies?open=true)`]);
  table(connSheet, ['운영 중', '온라인', '오프라인', '기록 없음'], [[data.connectivity.inService, data.connectivity.online, data.connectivity.offline, data.connectivity.noRecord]]);
  table(
    rolloutSheet,
    ['배포', '모델', '버전', '상태', '시작(KST)', '끝(KST)', '대상', '성공', '실패', '시간 초과', '끝난 이유'],
    data.rollouts.map((r) => [r.id, r.modelCode, r.version, r.status, kst(r.createdAt), kst(r.finishedAt), r.targets, r.succeeded, r.failed, r.timedOut, r.endReason ?? '']),
  );
  table(
    vanSheet,
    ['항목', '값'],
    data.van
      ? [
          ['실행', `#${data.van.runId}`],
          ['끝난 시각(KST)', kst(data.van.finishedAt)],
          ['VAN 등록', data.van.fetched],
          ['후보', data.van.candidates],
          ['어긋남(재검증 뒤)', data.van.confirmed],
          ['재검증으로 풀림', data.van.resolved],
          ...Object.entries(KIND_LABEL).map(([kind, label]): [string, number] => [`  ${label}`, data.van!.counts[kind as VanMismatchKind] ?? 0]),
        ]
      : [['실행', '끝난 VAN 대조가 없습니다']],
  );
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
```

`apps/api/src/report/weekly-report.service.ts`(새):
```ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { withPartnerRetry } from '../common/partner-retry.js';
import { ToktokClient } from '../outbox/toktok.client.js';
import { RedisLock } from '../redis/redis-lock.js';
import { previousKstWeek, type KstWeek } from './kst-week.js';
import { WeeklyReport, WeeklyReportStatus } from './weekly-report.entity.js';
import { WeeklyReportQueries } from './weekly-report.queries.js';
import { buildWeeklyReportXlsx, weeklyReportFileName, XLSX_CONTENT_TYPE } from './weekly-report.xlsx.js';

/** 같은 주를 보내는 동안 잡는 Redis 잠금 유지 시간 */
const SEND_LOCK_TTL_MS = 2 * 60_000;

/** 톡톡 파일 올리기·메시지를 다시 부르는 최대 횟수(첫 시도 포함, 500ms·1s 간격) */
const TOKTOK_ATTEMPTS = 3;

export interface SendResult {
  report: WeeklyReport;
  /** 이미 보낸 주라서 아무것도 하지 않았다 */
  alreadySent: boolean;
}

/** 메신저가 같은 리포트를 한 번으로 볼 수 있게 주마다 하나 */
export const weeklyReportIdempotencyKey = (weekStart: string) => `weekly-report-${weekStart}`;

/**
 * 주간 운영 리포트 보내기(F11, decisions/0035). 주(week_start)마다 한 행이 상태를 들고 간다.
 * 1. 같은 주는 Redis 잠금으로 한 번에 하나(수동 요청과 주기 job이 겹쳐도). 행이 SENT면 아무것도 하지 않는다(멱등).
 * 2. 파일이 아직 없으면 DB에서 집계해 xlsx를 만들어 그 행에 저장한다(GENERATED). 이미 있으면 같은 파일을 다시 쓴다.
 * 3. 톡톡메신저에 파일을 올리고(fileId) 그 파일을 첨부한 메시지를 보낸다(멱등키 weekly-report-<주>). 외부 호출은 트랜잭션 밖.
 * 4. SENT로 바꾼다. 3과 4 사이에 죽으면 다시 보낸다 — 최소 한 번 + 멱등키(Outbox와 같은 보장, decisions/0016).
 */
@Injectable()
export class WeeklyReportService {
  private readonly logger = new Logger(WeeklyReportService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly queries: WeeklyReportQueries,
    private readonly toktok: ToktokClient,
    private readonly lock: RedisLock,
  ) {}

  /** 주기 job: now 기준 지난주 */
  async sendScheduled(now = new Date()): Promise<SendResult> {
    return this.send(previousKstWeek(now), now);
  }

  async send(week: KstWeek, now = new Date()): Promise<SendResult> {
    const key = this.lock.keyOf('report-lock', `weekly-${week.weekStart}`);
    const token = await this.lock.acquire(key, SEND_LOCK_TTL_MS);
    if (!token) throw new BusinessError(409, 'WEEKLY_REPORT_IN_PROGRESS', `${week.weekStart} 주간 리포트를 다른 요청이 보내는 중입니다.`);
    try {
      return await this.sendLocked(week, now);
    } finally {
      await this.lock.release(key, token).catch((error: unknown) => this.logger.warn(`잠금 해제 실패 weekly-${week.weekStart}: ${String(error)}`));
    }
  }

  private async sendLocked(week: KstWeek, now: Date): Promise<SendResult> {
    const row = await this.ensureRow(week.weekStart);
    if (row.status === WeeklyReportStatus.SENT) return { report: row, alreadySent: true };

    let file = row.status === WeeklyReportStatus.GENERATED ? await this.file(row.id) : null;
    if (!file) {
      file = await buildWeeklyReportXlsx(await this.queries.collect(week, now));
      await this.em
        .fork()
        .nativeUpdate(
          WeeklyReport,
          { id: row.id },
          { status: WeeklyReportStatus.GENERATED, file, fileName: weeklyReportFileName(week.weekStart), fileSize: file.length, generatedAt: now },
        );
    }
    await this.em.fork().nativeUpdate(WeeklyReport, { id: row.id }, { attempts: row.attempts + 1 });

    let fileId: string;
    try {
      const retry = { attempts: TOKTOK_ATTEMPTS };
      ({ fileId } = await withPartnerRetry(
        () => this.toktok.uploadFile({ fileName: weeklyReportFileName(week.weekStart), contentType: XLSX_CONTENT_TYPE, content: file }),
        retry,
      ));
      await withPartnerRetry(
        () =>
          this.toktok.send({
            idempotencyKey: weeklyReportIdempotencyKey(week.weekStart),
            text: `[단말온] 주간 운영 리포트 ${week.weekStart} 주(KST) — 첨부 ${weeklyReportFileName(week.weekStart)} (${file.length}바이트)`,
            attachments: [fileId],
          }),
        retry,
      );
    } catch (error) {
      const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
      await this.em.fork().nativeUpdate(WeeklyReport, { id: row.id }, { lastError: message });
      throw error;
    }
    await this.em
      .fork()
      .nativeUpdate(
        WeeklyReport,
        { id: row.id, status: { $ne: WeeklyReportStatus.SENT } },
        { status: WeeklyReportStatus.SENT, sentAt: new Date(), toktokFileId: fileId, lastError: null },
      );
    return { report: await this.get(week.weekStart), alreadySent: false };
  }

  /** 그 주의 행. 없으면 만든다(동시에 만들면 unique 위반 → 다시 읽는다) */
  private async ensureRow(weekStart: string): Promise<WeeklyReport> {
    const found = await this.em.fork().findOne(WeeklyReport, { weekStart });
    if (found) return found;
    const em = this.em.fork();
    em.create(WeeklyReport, { weekStart });
    try {
      await em.flush();
    } catch (error) {
      if (!(error instanceof UniqueConstraintViolationException)) throw error;
    }
    return this.get(weekStart);
  }

  async get(weekStart: string): Promise<WeeklyReport> {
    const row = await this.em.fork().findOne(WeeklyReport, { weekStart });
    if (!row) throw new NotFoundException(`${weekStart} 주간 리포트가 없습니다.`);
    return row;
  }

  /** 저장된 파일. 아직 없으면 null */
  async file(id: number): Promise<Buffer | null> {
    const row = await this.em.fork().findOne(WeeklyReport, id, { populate: ['file'] });
    return row?.file ?? null;
  }
}

export function toWeeklyReportView(r: WeeklyReport, alreadySent = false) {
  return {
    weekStart: r.weekStart,
    status: r.status,
    fileName: r.fileName,
    fileSize: r.fileSize,
    generatedAt: r.generatedAt?.toISOString() ?? null,
    sentAt: r.sentAt?.toISOString() ?? null,
    attempts: r.attempts,
    lastError: r.lastError,
    alreadySent,
  };
}
```

`apps/api/src/report/dto/send-weekly-report.dto.ts`(새):
```ts
import { IsOptional, Matches } from 'class-validator';

export class SendWeeklyReportDto {
  /** 그 주 월요일(KST) 'YYYY-MM-DD'. 없으면 지난주 */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'weekStart는 YYYY-MM-DD(KST 월요일)입니다.' })
  weekStart?: string;
}
```

`apps/api/src/report/weekly-report.controller.ts`(새):
```ts
import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Post, StreamableFile } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { SendWeeklyReportDto } from './dto/send-weekly-report.dto.js';
import { parseKstWeekStart, previousKstWeek, type KstWeek } from './kst-week.js';
import { toWeeklyReportView, WeeklyReportService } from './weekly-report.service.js';
import { XLSX_CONTENT_TYPE } from './weekly-report.xlsx.js';

function weekOf(weekStart: string): KstWeek {
  const week = parseKstWeekStart(weekStart);
  if (!week) throw new BadRequestException({ statusCode: 400, code: 'INVALID_WEEK_START', message: 'weekStart는 KST 월요일 날짜(YYYY-MM-DD)입니다.' });
  return week;
}

/** 주간 운영 리포트(F11). 주기 작업이 매주 월요일 09:00 KST에 지난주를 보내고, 운영자가 바로 보낼 수도 있다. */
@Controller('reports/weekly')
export class WeeklyReportController {
  constructor(private readonly reports: WeeklyReportService) {}

  /** 보내기(동기). 이미 보낸 주면 보내지 않고 alreadySent: true. 같은 주를 다른 요청이 보내는 중이면 409 */
  @Post()
  @HttpCode(200)
  async send(@Body() dto: SendWeeklyReportDto, @Operator() _actor: string) {
    const week = dto.weekStart ? weekOf(dto.weekStart) : previousKstWeek(new Date());
    const { report, alreadySent } = await this.reports.send(week);
    return toWeeklyReportView(report, alreadySent);
  }

  @Get(':weekStart')
  async get(@Param('weekStart') weekStart: string) {
    return toWeeklyReportView(await this.reports.get(weekOf(weekStart).weekStart));
  }

  /** 저장된 xlsx 내려받기. 파일 이름이 한글이라 filename*(RFC 5987)로 보낸다 */
  @Get(':weekStart/file')
  async file(@Param('weekStart') weekStart: string) {
    const report = await this.reports.get(weekOf(weekStart).weekStart);
    const file = await this.reports.file(report.id);
    if (!file || !report.fileName) throw new NotFoundException(`${weekStart} 주간 리포트 파일이 아직 없습니다.`);
    return new StreamableFile(file, {
      type: XLSX_CONTENT_TYPE,
      length: file.length,
      disposition: `attachment; filename="weekly-report-${report.weekStart}.xlsx"; filename*=UTF-8''${encodeURIComponent(report.fileName)}`,
    });
  }
}
```

`apps/api/src/report/report.module.ts` 전체:
```ts
import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module.js';
import { WeeklyReportController } from './weekly-report.controller.js';
import { WeeklyReportQueries } from './weekly-report.queries.js';
import { WeeklyReportService } from './weekly-report.service.js';

/** 주간 운영 리포트(F11): 집계 쿼리, xlsx, 톡톡메신저 첨부 보내기(ToktokClient는 OutboxModule의 것) */
@Module({
  imports: [OutboxModule],
  controllers: [WeeklyReportController],
  providers: [WeeklyReportQueries, WeeklyReportService],
  exports: [WeeklyReportQueries, WeeklyReportService],
})
export class ReportModule {}
```

`apps/api/src/report/report.processor.ts`, `apps/api/src/scheduler/job-schedulers.ts`, `apps/api/src/workers/workers.module.ts`, `apps/api/src/config/env.ts`, `apps/api/src/entities.ts`:
```diff
--- a/apps/api/src/report/report.processor.ts
+++ b/apps/api/src/report/report.processor.ts
@@ -4,9 +4,10 @@ import { AnomalyService } from '../anomaly/anomaly.service.js';
 import { BusinessError } from '../common/domain-errors.js';
 import { QUEUE } from '../queue/queue-names.js';
 import { toVanRunView, VanReconciliationService, type VanRunJobData } from '../van/van-reconciliation.service.js';
+import { WeeklyReportService } from './weekly-report.service.js';
 
 /**
- * report 큐: 오래 걸리는 집계 job(VAN 대조, 이상 단말기 찾기, 다음 Task의 주간 리포트). device 큐(concurrency 1, 짧은 job)와 나눠
+ * report 큐: 오래 걸리는 집계 job(VAN 대조, 이상 단말기 찾기, 주간 리포트). device 큐(concurrency 1, 짧은 job)와 나눠
  * 무거운 일이 active 갱신·오프라인 판정을 막지 않게 한다(experiments/0010). 이 큐도 concurrency 1 — 집계끼리는 겹치지 않는다.
  */
 @Processor(QUEUE.REPORT, { concurrency: 1 })
@@ -14,6 +15,7 @@ export class ReportProcessor extends WorkerHost {
   constructor(
     private readonly van: VanReconciliationService,
     private readonly anomalies: AnomalyService,
+    private readonly reports: WeeklyReportService,
   ) {
     super();
   }
@@ -37,6 +39,11 @@ export class ReportProcessor extends WorkerHost {
           if (error instanceof BusinessError && error.code === 'ANOMALY_SCAN_RUNNING') return { skipped: true };
           throw error;
         }
+      case 'weekly-report': {
+        // 실패(톡톡 오류 등)는 던진다 — 행에 lastError가 남고, 같은 주를 다시 보내면(수동 POST·다음 job) 같은 파일로 이어서 보낸다
+        const { report, alreadySent } = await this.reports.sendScheduled();
+        return { weekStart: report.weekStart, status: report.status, alreadySent };
+      }
       default:
         throw new UnrecoverableError(`모르는 report job: ${job.name}`);
     }
```
```diff
--- a/apps/api/src/scheduler/job-schedulers.ts
+++ b/apps/api/src/scheduler/job-schedulers.ts
@@ -19,6 +19,8 @@ export const JOB_SCHEDULERS = [
   // 매일 밤(KST): 이상 단말기 찾기(F4), VAN 등록 대조(F9). report 큐(concurrency 1)라 둘이 겹치지 않는다
   { queue: QUEUE.REPORT, id: 'anomaly-scan-daily', jobName: 'anomaly-scan', schedule: () => ({ pattern: env.anomalyScanCron, tz: SCHEDULE_TZ }) },
   { queue: QUEUE.REPORT, id: 'van-reconcile-daily', jobName: 'van-reconcile-scheduled', schedule: () => ({ pattern: env.vanReconcileCron, tz: SCHEDULE_TZ }) },
+  // 매주 월요일 09:00 KST: 지난주 운영 리포트(F11)
+  { queue: QUEUE.REPORT, id: 'weekly-report', jobName: 'weekly-report', schedule: () => ({ pattern: env.weeklyReportCron, tz: SCHEDULE_TZ }) },
 ] as const satisfies readonly { queue: QueueName; id: string; jobName: string; schedule: () => JobSchedule }[];
 
 /** 로그용: `1000ms` 또는 `cron "0 2 * * *" Asia/Seoul` */
```
```diff
--- a/apps/api/src/workers/workers.module.ts
+++ b/apps/api/src/workers/workers.module.ts
@@ -11,12 +11,13 @@ import { FirmwareModule } from '../firmware/firmware.module.js';
 import { OutboxModule } from '../outbox/outbox.module.js';
 import { OutboxProcessor } from '../outbox/outbox.processor.js';
 import { AnomalyModule } from '../anomaly/anomaly.module.js';
+import { ReportModule } from '../report/report.module.js';
 import { ReportProcessor } from '../report/report.processor.js';
 import { VanModule } from '../van/van.module.js';
 
 /** 큐 job을 처리하는 프로세서들. RUN_WORKERS=1인 프로세스에만 넣는다(decisions/0015). */
 @Module({
-  imports: [CarrierSyncModule, OutboxModule, DeviceModule, FirmwareModule, VanModule, AnomalyModule],
+  imports: [CarrierSyncModule, OutboxModule, DeviceModule, FirmwareModule, VanModule, AnomalyModule, ReportModule],
   providers: [BungaeTrackProcessor, NeurimboTrackProcessor, CarrierSweepProcessor, OutboxProcessor, DeviceProcessor, ReportProcessor],
 })
 export class WorkersModule {}
```
```diff
--- a/apps/api/src/config/env.ts
+++ b/apps/api/src/config/env.ts
@@ -102,6 +102,7 @@ export const env = {
   /** 주기 작업 cron(시간대 Asia/Seoul). 잘못된 식이면 스케줄러 등록(서버 시작)이 실패한다 */
   anomalyScanCron: process.env.ANOMALY_SCAN_CRON ?? '0 2 * * *',
   vanReconcileCron: process.env.VAN_RECONCILE_CRON ?? '0 3 * * *',
+  weeklyReportCron: process.env.WEEKLY_REPORT_CRON ?? '0 9 * * 1',
   /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
   workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
 };
```
```diff
--- a/apps/api/src/entities.ts
+++ b/apps/api/src/entities.ts
@@ -13,6 +13,7 @@ import { DeviceConnectivity } from './device/device-connectivity.entity.js';
 import { Firmware, FirmwareRollout, FirmwareRolloutTarget } from './firmware/firmware.entities.js';
 import { VanReconciliationItem, VanReconciliationRun, VanRegistrationSnapshot } from './van/van.entities.js';
 import { Anomaly } from './anomaly/anomaly.entity.js';
+import { WeeklyReport } from './report/weekly-report.entity.js';
 
 /** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
-export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch, ServiceTicket, DeviceConnectivity, Firmware, FirmwareRollout, FirmwareRolloutTarget, VanReconciliationRun, VanRegistrationSnapshot, VanReconciliationItem, Anomaly];
+export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch, ServiceTicket, DeviceConnectivity, Firmware, FirmwareRollout, FirmwareRolloutTarget, VanReconciliationRun, VanRegistrationSnapshot, VanReconciliationItem, Anomaly, WeeklyReport];
```

`.env.example`의 cron 줄 뒤에:
```
WEEKLY_REPORT_CRON="0 9 * * 1"
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run test/weekly-report.e2e.spec.ts test/scheduler.e2e.spec.ts`
Expected: `Tests  7 passed (7)`. 톡톡 실패 테스트는 `toktok.file` 3번(500ms·1s 대기) 뒤 502, 다시 보내면 `attempts: 2`·같은 `fileSize`·같은 `generatedAt`(다시 만들지 않음). 첫 테스트는 메신저가 받은 첨부를 exceljs로 열어 시트 이름 8개와 `요약` 2행(`2026-10-19 ~ 2026-10-25 (KST)`)을 본다.

- [ ] **Step 6: 마이그레이션**

Run: `npm run db:migration:create`
Expected: `생성: Migration<시각>.ts`, up():
```ts
import { Migration } from '@mikro-orm/migrations';

export class Migration20261026015725 extends Migration {

  override name = 'Migration20261026015725';

  override up(): void | Promise<void> {
    this.addSql(`create table \`weekly_report\` (\`id\` int unsigned not null auto_increment primary key, \`week_start\` date not null, \`status\` enum('PENDING','GENERATED','SENT') not null default 'PENDING', \`file_name\` varchar(100) null, \`file\` mediumblob null, \`file_size\` int null, \`generated_at\` datetime(3) null, \`sent_at\` datetime(3) null, \`toktok_file_id\` varchar(64) null, \`attempts\` int not null default 0, \`last_error\` varchar(500) null, \`created_at\` datetime(3) not null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`weekly_report\` add unique \`weekly_report_week_start_unique\` (\`week_start\`);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`weekly_report\`;`);
  }

}
```

그리고:
```bash
npm run db:migrate
npm run db:migration:check
npx vitest run && npm run typecheck && npm run build
```
Expected: `적용: Migration<시각>`, `최신 상태`, `Test Files  51 passed (51)`, `Tests  324 passed (324)`, typecheck·build exit 0.

- [ ] **Step 7: 기록과 커밋**

devlog에 `## HH:MM Task 8 주간 리포트 보내기 — xlsx·톡톡 첨부·멱등·내려받기·월요일 주기 (F11, F5, F12)` 항목.

`docs/decisions/0035-…`에 보탠다(리포트):
- 파일 만들기: exceljs 4.4.0 쓰기(Day 3은 읽기만, decisions/0022). `writeBuffer()`의 타입이 exceljs 자체 Buffer라 Node Buffer로 감싼다. 시트 8장, 서식은 머리글 굵게·열 너비만(차트·조건부 서식은 하지 않음).
- 첨부 방식(가상 톡톡 API를 정함): 1) multipart/form-data — 실제 메신저들이 흔히 쓰지만 의존성 없는 node:http인 partners가 경계 문자열을 직접 풀어야 한다. 2) **JSON 안의 base64(`POST /toktok/files` → fileId → 메시지 attachments)** — 기존 `readJson` 그대로, 크기 33% 늘지만 리포트는 수십 KB. 3) 메시지에 파일을 바로 넣기 — 재시도마다 파일을 다시 보내고 메시지와 파일 실패를 나눌 수 없다. → 2. 상한 5MB.
- 파일 저장: 1) 디스크 — 워커와 API가 다른 프로세스·호스트면 같은 경로를 공유해야 하고 지우기가 따로 필요. 2) **weekly_report 행의 mediumblob(lazy)** — 상태와 같은 행이라 어느 프로세스든 내려줄 수 있다. 크기 작음(사전 검증 12KB). `blob`은 64KB 상한이라 mediumblob. → 2.
- 멱등: week_start unique 행 하나가 상태를 들고 간다. SENT면 아무것도 하지 않는다. 파일을 먼저 저장(GENERATED)하고 다시 시도하면 같은 파일을 쓴다(다시 집계하면 그사이 데이터가 바뀌어 다른 파일이 된다). 올리기·메시지 뒤 SENT를 쓰기 전에 죽으면 다시 보낸다 — 멱등키 `weekly-report-<주>`(Outbox와 같은 "최소 한 번 + 멱등키", decisions/0016). 같은 주 동시 요청은 Redis 잠금(2분)으로 409.
- 재시도: 톡톡 호출마다 3번(withPartnerRetry). 주기 job이 실패하면 다음 주까지 다시 돌지 않으므로 행에 last_error를 남기고 수동 POST로 이어서 보낸다.
- 다시 볼 조건: 리포트가 수 MB가 되면(스트리밍 쓰기, 객체 저장소), 받는 채널이 여럿이면, 메신저가 실제로 multipart만 받으면.

`docs/decisions/0009-…` 끝에 한 줄:
```
- 갱신(2026-10-26 Day 5 Task 8): 톡톡메신저에 파일 올리기(`POST /toktok/files`, base64 JSON → fileId)와 웹훅 attachments, 관리 API 파일 내려받기를 더했다(decisions/0035).
```

`docs/study/backlog.md`에 추가:
```
- [ ] base64(33% 늘어남)와 multipart/form-data, 파일 업로드 API 설계 (decisions/0035)
- [ ] Content-Disposition의 filename*(RFC 5987/6266)과 한글 파일 이름 (src/report/weekly-report.controller.ts)
- [ ] 큰 값(BLOB)을 DB에 둘 때의 대가 — 행 크기, 버퍼 풀, 백업, lazy 로딩 (decisions/0035)
```

커밋:
```bash
git add apps/api apps/partners docs .env.example
git commit -m "feat(F11): 주간 리포트 xlsx·톡톡 첨부·주 단위 멱등·내려받기·월요일 09:00 주기" -m "Refs: docs/decisions/0035-주간-리포트와-cron-주기-작업.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 실험 0011 — 실행계획(단말기 10만·이력 약 100만): F4 (a) 대 (b), 중복 인덱스 쓰기 비용, 대조·집계 쿼리 (F4, F9, F11, F13)

**Files:**
- Create: `apps/api/test/experiments/query-plans.spec.ts`
- Record: `docs/experiments/0011-실행계획-단말기-10만-이력-100만.md`, `docs/decisions/0034-…`·`0032-…`·`0035-…`(숫자 보탬), `docs/devlog/2026-10-26.md`, `docs/study/backlog.md`

실험 설계(스펙 6장):
- 준비(SQL `insert … select`, 숫자 표 교차 조인): 단말기 n(1~100,000), 상태 = 19단계 경로의 `1 + n % 19`번째, status_changed_at = 기준 시각 − (1 + n % 23)일, 가맹점은 배정~회수 중 상태만(97대에 1대 없음). 이력은 단말기마다 거친 단계 수만큼 하루 간격, 마지막 이력 = status_changed_at(그래서 (a)와 (b)가 같은 답을 내야 한다 — 실험이 확인). 검수 2만·결과 8만, 운영 중 단말기의 접속 상태(7대에 1대 오프라인), VAN 스테이징(운영 중 전부 + 회수된 단말기 10대에 1대가 ACTIVE로 남음). `analyze table`.
- ① 규칙 2개(DELIVERED 7일, RETURN_REQUESTED·RETURNING 14일) × (a) 이력 상관 서브쿼리 / (b) `(status, status_changed_at)` 범위 / (b)를 IGNORE INDEX로: 5번 중앙값·최소~최대, EXPLAIN ANALYZE, 결과가 같은지. 찾기 전체(`AnomalyService.scan`) 첫 실행·두 번째.
- ② `terminal_status_history`에 10만 행 `insert … select` × 단독 인덱스 있음/없음 × 3회(번갈아), INSERT 직후 `show table status`의 Index_length. 넣은 행은 PK 범위로 지운다. 끝나면 인덱스 없음(엔티티대로)을 확인.
- ③ EXPLAIN ANALYZE와 시간: Day 1 검수 통계(`failureStats`), VAN 비교 두 문장, 주간 리포트 전이 집계(occurred_at 범위), 열린 이상 목록.

- [ ] **Step 1: 실험 스펙**

`apps/api/test/experiments/query-plans.spec.ts`(새):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import type { QueryResult } from '@mikro-orm/mysql';
import { AnomalyService } from '../../src/anomaly/anomaly.service.js';
import { InspectionService } from '../../src/inspection/inspection.service.js';
import { Merchant } from '../../src/merchant/merchant.entity.js';
import { REDIS } from '../../src/redis/redis.provider.js';
import { TerminalModel } from '../../src/terminal/terminal-model.entity.js';
import { VanReconciliationRun, VanRunTrigger } from '../../src/van/van.entities.js';
import { deleteTestKeys } from '../helpers/redis-keys.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

/**
 * 실험 0011: 데이터를 늘렸을 때의 실행계획(단말기 10만·이력 약 100만).
 * ① F4 "그 상태가 된 시각": (a) 이력 서브쿼리 vs (b) terminal.status_changed_at + (status, status_changed_at) 인덱스(decisions/0034)
 * ② 중복 인덱스(terminal_status_history.terminal_id 단독)가 있을 때와 없을 때의 INSERT 비용·인덱스 크기(decisions/0032)
 * ③ 대조·집계 쿼리의 실행계획: Day 1 검수 통계, VAN 집합 비교 두 문장, 주간 리포트 이력 집계, 열린 이상 목록
 * 재현: EXPERIMENTS=1 npx vitest run test/experiments/query-plans.spec.ts --silent=false
 * 규모 바꾸기: EXP_TERMINALS=100000(기본), 이력은 단말기마다 1~19행(평균 약 10)
 */
const N = Number(process.env.EXP_TERMINALS ?? 100_000);
const RUNS = Number(process.env.EXP_RUNS ?? 5);
const INSERT_ROWS = Number(process.env.EXP_INSERT_ROWS ?? 100_000);
/** 고정 기준 시각(초 단위로 맞춘다 — 이력 occurred_at은 datetime(0)이라 밀리초가 반올림된다) */
const BASE = new Date('2026-10-26T00:00:00.000Z');
const DAY = 86_400_000;

/** 단말기 한 대가 거치는 상태(19단계). 단말기 n은 앞에서부터 1 + n % 19단계까지 거쳤고, 마지막 단계가 지금 상태다 */
const PATH = [
  'RECEIVED', 'INSPECTED', 'IN_STOCK', 'ALLOCATED', 'SHIPPED', 'DELIVERED', 'IN_SERVICE', 'RETURN_REQUESTED', 'RETURNING', 'RETURNED',
  'INSPECTED', 'IN_STOCK', 'ALLOCATED', 'SHIPPED', 'DELIVERED', 'IN_SERVICE', 'RETURN_REQUESTED', 'RETURNING', 'RETURNED',
];
const PATH_SQL = PATH.map((s) => `'${s}'`).join(', ');
/** 0~99999 숫자 표(10의 다섯 거듭제곱 교차 조인) */
const DIGITS = '(select 0 d union all select 1 union all select 2 union all select 3 union all select 4 union all select 5 union all select 6 union all select 7 union all select 8 union all select 9)';
const NUMBERS = `(select a.d + b.d * 10 + c.d * 100 + e.d * 1000 + f.d * 10000 as n from ${DIGITS} a cross join ${DIGITS} b cross join ${DIGITS} c cross join ${DIGITS} e cross join ${DIGITS} f)`;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x: number) => Math.round(x * 10) / 10;

describe(`실험 0011 — 실행계획 (단말기 ${N}대)`, () => {
  let t: TestApp;
  /** VAN 스테이징을 넣은 실행 id */
  let runId: number;
  const em = () => t.orm.em.fork();
  const exec = <T extends QueryResult | Record<string, unknown>[] = Record<string, unknown>[]>(sql: string, params: unknown[] = []) => em().execute<T>(sql, params);
  /** INSERT·UPDATE·DELETE: 'run'이어야 affectedRows가 온다(기본 'all'은 행 배열) */
  const run = (sql: string, params: unknown[] = []) => em().execute<QueryResult>(sql, params, 'run');

  async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; res: T }> {
    const start = performance.now();
    const res = await fn();
    return { ms: round(performance.now() - start), res };
  }

  /** EXPLAIN ANALYZE의 트리(앞 1,500자) */
  async function explain(label: string, sql: string, params: unknown[] = []) {
    const [row] = await exec<{ EXPLAIN: string }[]>(`explain analyze ${sql}`, params);
    console.log(`\n[실험 0011 EXPLAIN] ${label}\n${row.EXPLAIN.slice(0, 1500)}`);
  }

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    const models = (await em().find(TerminalModel, {}, { orderBy: { id: 'asc' } })).map((m) => m.id);
    const merchants = (await em().find(Merchant, {}, { orderBy: { id: 'asc' } })).map((m) => m.id);

    const seed = await timed(async () => {
      // 단말기: 상태 = PATH[n % 19], 그 상태가 된 시각 = BASE - (1 + n % 23)일, 가맹점은 배정~회수 중 상태에만(97대에 1대는 없음)
      await exec(
        `insert into terminal (serial_no, model_id, merchant_id, status, status_changed_at, version, created_at, updated_at)
         select concat('QP-', lpad(n, 6, '0')), elt(1 + n % 3, ?, ?, ?),
                if(st in ('ALLOCATED', 'SHIPPED', 'DELIVERED', 'IN_SERVICE', 'RETURN_REQUESTED', 'RETURNING') and n % 97 <> 0, elt(1 + n % 3, ?, ?, ?), null),
                st, date_sub(?, interval (1 + n % 23) day), 1, ?, ?
           from (select n, elt(1 + n % 19, ${PATH_SQL}) as st from (select n + 1 as n from ${NUMBERS} z) x where n <= ?) y`,
        [...models, ...merchants, BASE, BASE, BASE, N],
      );
      // 이력: 단말기마다 거친 단계 수(1 + n % 19)만큼, 하루 간격으로 마지막 단계가 status_changed_at. 1만 대씩 나눠 넣는다
      for (let from = 1; from <= N; from += 10_000) {
        await exec(
          `insert into terminal_status_history (terminal_id, from_status, to_status, source, actor, reason, occurred_at)
           select t.id, if(s.i = 0, null, elt(s.i, ${PATH_SQL})), elt(s.i + 1, ${PATH_SQL}), 'MANUAL', 'exp11', 'seed',
                  date_sub(t.status_changed_at, interval (t.k - 1 - s.i) day)
             from (select id, status_changed_at, 1 + cast(substring(serial_no, 4) as unsigned) % 19 as k from terminal
                    where id between ? and ?) t
             join (select a.d + b.d * 10 as i from ${DIGITS} a cross join ${DIGITS} b) s on s.i < t.k`,
          [from, from + 9_999],
        );
      }
      // 검수(Day 1 통계용): 5대에 1대, 항목 4개 중 7번째마다 불합격
      await exec(`insert into inspection (terminal_id, passed, actor, inspected_at) select id, 1, 'exp11', ? from terminal where id % 5 = 0`, [BASE]);
      await exec(
        `insert into inspection_result (inspection_id, item_code, passed, note)
         select i.id, elt(k.d + 1, 'POWER', 'NETWORK', 'CARD_READER', 'PRINTER'), (i.id + k.d) % 7 <> 0, null
           from inspection i cross join (select 0 d union all select 1 union all select 2 union all select 3) k`,
      );
      // 접속 상태: 운영 중 단말기, 7대에 1대 오프라인, 마지막 하트비트 0~4일 전
      await exec(
        `insert into device_connectivity (terminal_id, online, last_seen_at, firmware_version, changed_at)
         select id, id % 7 <> 0, date_sub(?, interval id % 5 day), '1.0.0', ? from terminal where status = 'IN_SERVICE'`,
        [BASE, BASE],
      );
    });
    // VAN 스테이징 한 벌: 운영 중 단말기 전부(50대에 1대는 정지) + 회수된 단말기 10대에 1대(해지가 빠져 ACTIVE로 남음)
    const e = em();
    const vanRun = e.create(VanReconciliationRun, { trigger: VanRunTrigger.MANUAL, requestedBy: 'exp11', startedAt: BASE });
    await e.flush();
    runId = vanRun.id;
    await exec(
      `insert into van_registration_snapshot (run_id, serial_no, tid, merchant_code, status, van_updated_at)
       select ?, t.serial_no, concat('VT', t.id), coalesce(m.code, 'NONE'), if(t.id % 50 = 0, 'SUSPENDED', 'ACTIVE'), ?
         from terminal t left join merchant m on m.id = t.merchant_id where t.status = 'IN_SERVICE' or (t.status = 'RETURNED' and t.id % 10 = 0)`,
      [runId, BASE],
    );
    await exec('analyze table terminal, terminal_status_history, inspection, inspection_result, device_connectivity, van_registration_snapshot, anomaly');
    const [counts] = await exec<{ terminals: number; history: number; results: number; van: number }[]>(
      `select (select count(*) from terminal) as terminals, (select count(*) from terminal_status_history) as history,
              (select count(*) from inspection_result) as results, (select count(*) from van_registration_snapshot) as van`,
    );
    console.log(`[실험 0011] 시드 ${seed.ms}ms: 단말기 ${counts.terminals}, 이력 ${counts.history}, 검수 결과 ${counts.results}, VAN 스테이징 ${counts.van} (run ${runId})`);
  }, 600_000);
  afterAll(async () => {
    await deleteTestKeys(t.app.get<Redis>(REDIS));
    await t.app.close();
  });

  it('① F4 그 상태가 된 시각: (a) 이력 서브쿼리 vs (b) status_changed_at 인덱스 — 결과가 같고 시간·실행계획 비교', async () => {
    const rules = [
      { name: 'DELIVERED_NOT_INSTALLED(7일)', statuses: ['DELIVERED'], days: 7 },
      { name: 'RETURN_STALLED(14일)', statuses: ['RETURN_REQUESTED', 'RETURNING'], days: 14 },
    ];
    console.log('\n[실험 0011] ① F4 규칙 쿼리 (ms, 5번 중앙값 / 최소~최대)');
    console.log('| 규칙 | 방식 | 행 | 중앙값 | 최소~최대 |');
    console.log('|---|---|---|---|---|');
    for (const r of rules) {
      const cutoff = new Date(BASE.getTime() - r.days * DAY);
      const inList = r.statuses.map(() => '?').join(', ');
      const variants = [
        {
          name: '(a) 이력 서브쿼리',
          sql: `select id, serial_no, since from (select t.id, t.serial_no, (select max(h.occurred_at) from terminal_status_history h where h.terminal_id = t.id and h.to_status = t.status) as since
                  from terminal t where t.status in (${inList})) x where since < ? order by id`,
        },
        // (b)는 findAnomalies와 같은 열을 읽는다(serial_no 때문에 커버링 인덱스가 아니다)
        { name: '(b) status_changed_at 인덱스', sql: `select id, serial_no, status_changed_at from terminal where status in (${inList}) and status_changed_at < ? order by id` },
        {
          name: '(b) 인덱스 없이(IGNORE INDEX)',
          sql: `select id, serial_no, status_changed_at from terminal ignore index (terminal_status_status_changed_at_index) where status in (${inList}) and status_changed_at < ? order by id`,
        },
      ];
      const results: number[][] = [];
      for (const v of variants) {
        const params = [...r.statuses, cutoff];
        const times: number[] = [];
        let ids: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const { ms, res } = await timed(() => exec<{ id: number }[]>(v.sql, params));
          times.push(ms);
          ids = res.map((x) => x.id);
        }
        results.push(ids);
        console.log(`| ${r.name} | ${v.name} | ${ids.length} | ${median(times)} | ${Math.min(...times)}~${Math.max(...times)} |`);
        await explain(`${r.name} ${v.name}`, v.sql, params);
      }
      expect(results[0]).toEqual(results[1]); // (a)와 (b)가 같은 단말기를 찾는다(시드가 이력과 status_changed_at을 맞춰 두었다)
      expect(results[2]).toEqual(results[1]);
      expect(results[1].length).toBeGreaterThan(0);
    }

    // 찾기 전체(규칙 6개 + 열린 이상 비교 + INSERT): 첫 실행(전부 새로)과 두 번째(전부 계속)
    const svc = t.app.get(AnomalyService);
    const first = await timed(() => svc.scan(BASE));
    const second = await timed(() => svc.scan(new Date(BASE.getTime() + 60_000)));
    console.log(`[실험 0011] 찾기 전체: 첫 실행 ${first.ms}ms (새로 ${first.res.detected}), 두 번째 ${second.ms}ms (계속 ${second.res.continuing}, 새로 ${second.res.detected})`);
    console.log(`[실험 0011] 열린 이상 규칙별: ${JSON.stringify(second.res.open)}`);
  }, 600_000);

  it('② 중복 인덱스(terminal_status_history.terminal_id 단독) 있을 때 vs 없을 때: INSERT 시간과 인덱스 크기', async () => {
    const [{ maxId }] = await exec<{ maxId: number }[]>('select max(id) as maxId from terminal_status_history');
    const insertOnce = () =>
      run(
        `insert into terminal_status_history (terminal_id, from_status, to_status, source, actor, reason, occurred_at)
         select terminal_id, from_status, to_status, source, 'exp11-ins', reason, occurred_at from terminal_status_history where id <= ?`,
        [INSERT_ROWS],
      );
    const cleanup = async () => {
      // 넣은 행만 PK 범위로 지운다(보조 인덱스 범위 DELETE를 쓰지 않는다)
      for (;;) {
        const r = await run('delete from terminal_status_history where id > ? limit 50000', [maxId]);
        if (r.affectedRows === 0) break;
      }
    };
    const indexLength = async () => {
      await exec('analyze table terminal_status_history');
      const [s] = await exec<{ Index_length: number }[]>("show table status like 'terminal_status_history'");
      return Math.round(Number(s.Index_length) / 1024 / 1024);
    };
    const rows: string[] = [];
    for (let round = 1; round <= 3; round++) {
      for (const withDup of [true, false]) {
        if (withDup) await exec('alter table terminal_status_history add index terminal_status_history_terminal_id_index (terminal_id)');
        const { ms } = await timed(insertOnce);
        const mb = await indexLength();
        rows.push(`| ${round} | ${withDup ? '있음' : '없음'} | ${INSERT_ROWS} | ${ms} | ${mb} |`);
        await cleanup();
        if (withDup) await exec('alter table terminal_status_history drop index terminal_status_history_terminal_id_index');
      }
    }
    console.log('\n[실험 0011] ② terminal_status_history INSERT…SELECT (중복 인덱스 terminal_id 단독)');
    console.log('| 회차 | 중복 인덱스 | 넣은 행 | ms | 보조 인덱스 합(MB, INSERT 직후) |');
    console.log('|---|---|---|---|---|');
    for (const r of rows) console.log(r);
    const [{ c }] = await exec<{ c: number }[]>("select count(*) as c from information_schema.statistics where table_schema = database() and index_name = 'terminal_status_history_terminal_id_index'");
    expect(Number(c)).toBe(0); // 끝나면 엔티티대로(중복 인덱스 없음)
  }, 600_000);

  it('③ 대조·집계 쿼리의 실행계획(Day 1 검수 통계, VAN 집합 비교, 주간 리포트 이력 집계, 열린 이상)', async () => {
    const stats = await timed(() => t.app.get(InspectionService).failureStats());
    console.log(`\n[실험 0011] ③ Day 1 검수 통계 ${stats.ms}ms (${stats.res.length}행)`);
    await explain(
      'Day 1 검수 통계(failureStats)',
      `select m.code as model_code, r.item_code, count(*) as total, sum(case when r.passed then 0 else 1 end) as failed
         from inspection_result r join inspection i on i.id = r.inspection_id join terminal t on t.id = i.terminal_id join terminal_model m on m.id = t.model_id
        group by m.code, r.item_code order by failed desc, m.code, r.item_code`,
    );
    const vanQ1 = `select t.serial_no, t.status, m.code as our_merchant, s.status as van_status, s.merchant_code as van_merchant
         from terminal t left join merchant m on m.id = t.merchant_id
         left join van_registration_snapshot s on s.run_id = ? and s.serial_no = t.serial_no
        where t.status = 'IN_SERVICE' and (s.serial_no is null or s.status <> 'ACTIVE' or m.code is null or m.code <> s.merchant_code)`;
    const vanQ2 = `select s.serial_no, t.status, m.code as our_merchant, s.status as van_status, s.merchant_code as van_merchant
         from van_registration_snapshot s left join terminal t on t.serial_no = s.serial_no left join merchant m on m.id = t.merchant_id
        where s.run_id = ? and s.status = 'ACTIVE' and (t.id is null or t.status <> 'IN_SERVICE')`;
    for (const [label, sql] of [['VAN 비교 ① 운영 중 기준', vanQ1], ['VAN 비교 ② VAN ACTIVE 기준', vanQ2]] as const) {
      const r = await timed(() => exec(sql, [runId]));
      console.log(`[실험 0011] ${label}: ${r.ms}ms, ${r.res.length}행`);
      await explain(label, sql, [runId]);
    }
    const week = [new Date(BASE.getTime() - 7 * DAY), BASE];
    const transitions = `select source, to_status, count(*) as c from terminal_status_history where occurred_at >= ? and occurred_at < ? group by source, to_status`;
    const r1 = await timed(() => exec(transitions, week));
    console.log(`[실험 0011] 주간 리포트 전이 집계: ${r1.ms}ms`);
    await explain('주간 리포트 전이 집계(occurred_at 범위)', transitions, week);
    const open = `select t.serial_no, t.status, a.rule, a.detected_at, a.last_seen_at from anomaly a join terminal t on t.id = a.terminal_id
                   where a.resolved_at is null order by a.rule, a.detected_at, a.id limit 1000`;
    const r2 = await timed(() => exec(open));
    console.log(`[실험 0011] 열린 이상 목록(1,000행): ${r2.ms}ms`);
    await explain('열린 이상 목록', open);
  }, 600_000);
});
```

Run: `npm run typecheck`
Expected: exit 0. 기본 실행(`npx vitest run`)은 실험 파일을 고르지 않으므로 51/324 그대로.

- [ ] **Step 2: 실험 실행**

Run(Git Bash, `apps/api`, 다른 vitest가 돌고 있지 않을 때):
```bash
EXPERIMENTS=1 npx vitest run test/experiments/query-plans.spec.ts --silent=false > exp11.log 2>&1
grep -E "실험 0011\]|^\| |Tests " exp11.log
```
Expected: `Tests  3 passed (3)`. 시드 줄 `단말기 100000, 이력 99만~100만 사이, 검수 결과 80000, VAN 스테이징 …`. ① 표 6줄(규칙 2 × 방식 3)과 행 수가 세 방식에서 같다(`expect`가 확인). ② 표 6줄. ③ 시간 다섯 줄과 `[실험 0011 EXPLAIN] …` 트리 11개(① 6 + ③ 5). 사전 검증에서 몇 분 안에 끝났다(시드는 수 초). (a)의 EXPLAIN에는 `Select #3 (subquery in projection; dependent)`와 `Index lookup on h using terminal_status_history_terminal_id_occurred_at_index (terminal_id=t.id) … loops=<걸린 상태의 단말기 수>`, (b)는 `Index range scan on terminal using terminal_status_status_changed_at_index over (status = 'DELIVERED' AND status_changed_at < …)`, 주간 리포트 전이 집계는 `Table scan on terminal_status_history`(인덱스 없음)가 나온다. 로그 파일은 기록에 옮긴 뒤 지운다(`rm exp11.log`).

- [ ] **Step 3: 기록과 커밋**

`docs/experiments/0011-실행계획-단말기-10만-이력-100만.md`:
```markdown
# 0011. 실행계획 — 단말기 10만·이력 약 100만

- 날짜 / 관련 기능: 2026-10-26 / F4, F9, F11, F13 (decisions/0032·0034·0035)
- 질문: ① "그 상태가 된 시각"을 이력 서브쿼리로 구하는 것(a)과 status_changed_at + 복합 인덱스(b)는 같은 답을 내고 얼마나 다른가 ② FK 열 단독 중복 인덱스는 INSERT를 얼마나 느리게·크게 하나 ③ 대조·집계 쿼리는 어떤 실행계획으로 도나
- 설정: (위 "실험 설계"를 그대로, 로컬 한 PC·Docker MySQL 8.4·테스트 DB, RUNS=5, INSERT 10만 행)
- 재현: (Step 2 명령)
- 결과 ① (표 원문) + EXPLAIN ANALYZE 트리 6개(규칙 2 × 방식 3, 원문)
- 결과 ② (표 원문)
- 결과 ③ (시간 줄 원문) + EXPLAIN ANALYZE 트리(원문)
- 결론: (잰 숫자로) (a)와 (b)의 배수, (b)에서 인덱스를 빼면 얼마나 느려지나(행 수가 10만이라 전체 훑기도 빠르다는 점까지), 찾기 전체 시간. 중복 인덱스가 INSERT 시간·보조 인덱스 크기에 더한 몫. 검수 통계·VAN 비교·리포트 전이 집계(전체 훑기 — 주 1회라 인덱스를 더하지 않은 결정이 맞나)·열린 이상 목록.
- 한계: 합성 데이터(상태·날짜가 규칙적으로 분포), 버퍼 풀이 데워진 상태(같은 쿼리 5번), 로컬 한 PC, 동시 부하 없음, F10 발주 대조(JSON_TABLE)는 재지 않음, INSERT…SELECT는 한 문장 대량 입력이라 운영의 한 건씩 INSERT와 비용 구성이 다르다(추정).
```
숫자는 출력에서 그대로 옮기고, 추정은 "추정"이라고 적는다.

`docs/decisions/0034-…`에 한 줄: `- 실험 0011(2026-10-26): (a) … ms 대 (b) … ms(중앙값, 규칙 2개), 결과 같음. (잰 값으로 결정이 맞는지 한 줄)`. `docs/decisions/0032-…`에 한 줄: `- 실험 0011: terminal_status_history 10만 행 INSERT … ms(있음) 대 … ms(없음), 보조 인덱스 합 … MB 대 … MB`. `docs/decisions/0035-…`에 한 줄: `- 실험 0011: 주간 리포트 전이 집계(이력 100만, 전체 훑기) … ms — 주 1회라 occurred_at 인덱스를 두지 않는다(다시 볼 조건: 리포트를 자주 만들거나 이력이 수천만 행)`.

devlog에 `## HH:MM Task 9 실험 0011 실행계획 (F4, F9, F11, F13)` 항목(결론 세 줄).

`docs/study/backlog.md`에 추가:
```
- [ ] EXPLAIN ANALYZE 읽기 — actual time·rows·loops, dependent subquery, covering index, Materialize (experiments/0011)
- [ ] InnoDB 통계(ANALYZE TABLE, innodb_stats_persistent)와 옵티마이저의 행 수 추정 (experiments/0011)
```

커밋:
```bash
git add apps/api docs
git commit -m "exp(F4): 0011 실행계획 — status_changed_at 대 이력 서브쿼리, 중복 인덱스 쓰기 비용, 대조·집계 쿼리" -m "Refs: docs/experiments/0011-실행계획-단말기-10만-이력-100만.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 실험 0012 — VAN 대조(등록 5만·어긋남 2%): 소요·쿼리 수, 스캔 도중 변경의 거짓 양성과 놓침 (F9)

**Files:**
- Create: `apps/api/test/experiments/van-reconciliation.spec.ts`
- Record: `docs/experiments/0012-VAN-대조-5만-건.md`, `docs/decisions/0033-…`(숫자 보탬), `docs/devlog/2026-10-26.md`

실험 설계:
- 운영 중 단말기 5만(`insertTerminals`, 가맹점 세 곳을 돌아가며). VAN 등록은 우리 목록에서 만들고 50대마다 어긋남 하나(4종류를 돌아가며: 미등록 = 등록 없음, 가맹점 다름, 정지, 운영 아님 = 우리 DB에 없는 시리얼 ACTIVE). 짝수 번째 어긋남에는 healTo(스캔 도중 변경이 고르면 풀림). 심은 어긋남 1,000.
- A 기본(변경 없음), B 스캔 도중 변경(페이지마다 지나간 등록 `EXP_MUTATE`=10건, 시드 12), C B 바로 뒤 변경 없이 한 번 더. 실행마다: 전체 ms·단계별 ms(collect·compare·reverify), 페이지, VAN 호출(목록 + 시리얼 조회)·시리얼 조회 수, 후보·확정·풀림, 앱이 보낸 쿼리 수(종류별, `captureQueries`), 바뀐·고쳐진 등록 수, 종류별 확정 수.
- 확인: A는 후보 = 확정 = 심은 수, 풀림 0. B는 후보 = 확정 + 풀림. C는 풀림 0.

- [ ] **Step 1: 실험 스펙**

`apps/api/test/experiments/van-reconciliation.spec.ts`(새):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { TerminalStatus } from '../../src/terminal/terminal-status.js';
import { VanRunStatus, VanRunTrigger } from '../../src/van/van.entities.js';
import { VanReconciliationService } from '../../src/van/van-reconciliation.service.js';
import { partners, type VanSeed } from '../helpers/partners.js';
import { captureQueries } from '../helpers/query-log.js';
import { insertTerminals } from '../helpers/terminals.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

/**
 * 실험 0012: VAN 등록 대조 — 등록 5만 건, 어긋남 2%.
 * A. 기본: 수집·비교·재검증 시간, 쿼리 수, 업체 호출 수, 심은 어긋남을 모두 찾는가
 * B. 스캔 도중 변경(페이지마다 지나간 등록 EXP_MUTATE건이 바뀜): 비교 후보 중 재검증이 걸러 낸 거짓 양성 수
 * C. B 바로 뒤 변경 없이 한 번 더: B가 놓친(지나간 자리에서 새로 생긴) 어긋남을 찾는가
 * 재현: EXPERIMENTS=1 npx vitest run test/experiments/van-reconciliation.spec.ts --silent=false
 */
const N = Number(process.env.EXP_VAN ?? 50_000);
const EVERY = Math.round(1 / Number(process.env.EXP_MISMATCH ?? 0.02)); // 50대에 1대 어긋남
const MUTATE = Number(process.env.EXP_MUTATE ?? 10);
const MERCHANTS = ['GANGNAM-KIMBAP', 'YEOKSAM-CAFE', 'PANGYO-BUNSIK'];
const serial = (i: number) => `VZ-${String(i).padStart(6, '0')}`;

/**
 * 우리 DB 목록에서 VAN 등록을 만든다. EVERY대마다 하나씩 네 종류의 어긋남을 돌아가며 심는다.
 * 미등록(등록 없음)·가맹점 다름·정지는 우리 단말기에, 운영 아님은 우리 DB에 없는 시리얼(VZ-X…)로. 짝수 번째 어긋남에는 healTo(스캔 도중 변경이 고르면 풀림).
 */
function buildVan(): { regs: VanSeed[]; planted: number } {
  const regs: VanSeed[] = [];
  let planted = 0;
  for (let i = 1; i <= N; i++) {
    const merchantCode = MERCHANTS[i % 3];
    const base: VanSeed = { tid: `T${String(i).padStart(7, '0')}`, serialNo: serial(i), merchantCode, status: 'ACTIVE' };
    if (i % EVERY !== 0) {
      regs.push(base);
      continue;
    }
    const k = planted++;
    const heal = k % 2 === 0;
    switch (k % 4) {
      case 0: // 미등록: VAN에 없음(heal 없음 — 없는 등록은 바뀔 수 없다)
        break;
      case 1: // 가맹점 다름
        regs.push({ ...base, merchantCode: MERCHANTS[(i + 1) % 3], ...(heal ? { healTo: { merchantCode } } : {}) });
        break;
      case 2: // 정지
        regs.push({ ...base, status: 'SUSPENDED', ...(heal ? { healTo: { status: 'ACTIVE' } } : {}) });
        break;
      case 3: // 운영 아님: 우리 DB에 없는 시리얼이 VAN에 ACTIVE
        regs.push(base);
        regs.push({ tid: `TX${String(i).padStart(7, '0')}`, serialNo: `VZ-X${String(i).padStart(6, '0')}`, merchantCode, status: 'ACTIVE', ...(heal ? { healTo: { status: 'CANCELLED' } } : {}) });
        break;
    }
  }
  return { regs, planted };
}

describe(`실험 0012 — VAN 대조 (등록 ${N}건, ${EVERY}대에 1대 어긋남, 변경 ${MUTATE}건/페이지)`, () => {
  let t: TestApp;
  let svc: VanReconciliationService;
  let van: ReturnType<typeof buildVan>;

  async function runOnce(label: string) {
    const before = await partners.stats();
    const cap = captureQueries(t.orm);
    const started = performance.now();
    let run;
    try {
      run = await svc.execute((await svc.start(VanRunTrigger.MANUAL, 'exp12')).id);
    } finally {
      cap.stop();
    }
    const ms = Math.round(performance.now() - started);
    const after = await partners.stats();
    const calls = (after.calls['bridgevan.list'] ?? 0) - (before.calls['bridgevan.list'] ?? 0);
    const kinds = (re: RegExp) => cap.queries.filter((q) => re.test(q)).length;
    const row = {
      label,
      status: run.status,
      ms,
      ...run.phaseMs,
      pages: run.pages,
      fetched: run.fetched,
      vanCalls: calls,
      lookups: calls - run.pages - run.retries,
      candidates: run.candidates,
      confirmed: run.confirmed,
      resolved: run.resolved,
      queries: cap.queries.length,
      select: kinds(/^select /i),
      insert: kinds(/^insert /i),
      update: kinds(/^update /i),
      delete: kinds(/^delete /i),
      mutated: after.vanMutated - before.vanMutated,
      healed: after.vanHealed - before.vanHealed,
      counts: JSON.stringify(run.counts),
    };
    return row;
  }

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    svc = t.app.get(VanReconciliationService);
    const started = performance.now();
    await insertTerminals(
      t,
      Array.from({ length: N }, (_, k) => ({ serialNo: serial(k + 1), status: TerminalStatus.IN_SERVICE, merchantCode: MERCHANTS[(k + 1) % 3] })),
    );
    van = buildVan();
    console.log(`[실험 0012] 준비 ${Math.round(performance.now() - started)}ms: 단말기 ${N}, VAN 등록 ${van.regs.length}, 심은 어긋남 ${van.planted}, 페이지 ${env.bridgevanPageSize}건, 재검증 동시 ${env.vanReverifyConcurrency}`);
  }, 300_000);
  afterAll(async () => {
    await t.app.close();
  });

  it('A 기본 → B 스캔 도중 변경 → C 다음 실행', async () => {
    const rows = [];
    await partners.reset();
    await partners.seedVan(van.regs);
    rows.push(await runOnce('A 기본'));

    await partners.reset();
    await partners.configure({ seed: 12, bridgevan: { mutateDuringScan: MUTATE } });
    await partners.seedVan(van.regs);
    rows.push(await runOnce(`B 변경 ${MUTATE}건/페이지`));

    await partners.configure({ bridgevan: { mutateDuringScan: 0 } });
    rows.push(await runOnce('C 다음 실행(변경 없음)'));

    const cols = Object.keys(rows[0]);
    console.log(`\n[실험 0012] 결과\n| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|`);
    for (const r of rows) console.log(`| ${cols.map((c) => String((r as Record<string, unknown>)[c] ?? '')).join(' | ')} |`);

    const [a, b, c] = rows;
    expect(rows.every((r) => r.status === VanRunStatus.COMPLETED)).toBe(true);
    expect(a).toMatchObject({ candidates: van.planted, confirmed: van.planted, resolved: 0 }); // 심은 어긋남을 다 찾고 더 찾지 않는다
    expect(b.candidates).toBe(b.confirmed + b.resolved);
    expect(c.resolved).toBe(0);
  }, 900_000);
});
```

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 2: 실험 실행**

Run(Git Bash, `apps/api`):
```bash
EXPERIMENTS=1 npx vitest run test/experiments/van-reconciliation.spec.ts --silent=false > exp12.log 2>&1
grep -E "실험 0012\]|^\| |Tests " exp12.log
```
Expected: `Tests  1 passed (1)`, 준비 줄(`단말기 50000, VAN 등록 50000, 심은 어긋남 1000, 페이지 500건, 재검증 동시 8`), 결과 표 3줄(A·B·C). A의 페이지 100, 시리얼 조회 1000, 후보·확정 1000, 풀림 0, insert 문장이 페이지 수(100) + 결과 INSERT 묶음(500행씩) + 실행 행·Outbox 1개씩. B는 풀림이 몇 건 생기고 `healed`와 같거나 가깝다(같은 등록을 두 번 고르는 경우, 정지로 심은 등록이 뒤집혀 풀리는 경우가 있어 정확히 같지는 않다). C는 B가 놓친 어긋남(지나간 자리에서 ACTIVE → SUSPENDED로 뒤집힌 등록)이 더해져 확정이 B보다 많고 풀림 0. 로그는 기록에 옮긴 뒤 지운다.

- [ ] **Step 3: 기록과 커밋**

`docs/experiments/0012-VAN-대조-5만-건.md`:
```markdown
# 0012. VAN 등록 대조 — 등록 5만, 어긋남 2%, 스캔 도중 변경

- 날짜 / 관련 기능: 2026-10-26 / F9 (decisions/0033)
- 질문: 5만 건 대조가 얼마나 걸리고 어디에 시간이 드나, 쿼리를 몇 개 쓰나. 스캔 도중 변경이 있을 때 재검증이 거짓 양성을 몇 개 거르나, 무엇을 놓치나.
- 설정: (위 "실험 설계" 그대로, BRIDGEVAN_PAGE_SIZE 500, VAN_REVERIFY_CONCURRENCY 8, partners 지연 0, 로컬 한 PC)
- 재현: (Step 2 명령)
- 결과: (표 원문 3줄)
- 결론: 단계별 시간 비중(수집이 대부분인지 — 페이지 100번 × 왕복·JSON·INSERT), 쿼리 수가 등록 수가 아니라 페이지 수·후보 블록 수에 비례하는지, 재검증 호출 수 = 후보 수. B의 거짓 양성(풀림) 수와 그것이 재검증 없이 알림·리포트에 갔을 수. B가 놓친 수(C 확정 − B 확정)와 그 이유(지나간 자리의 새 어긋남은 재검증 대상이 아님 — 다음 실행이 찾음). 변경 10건/페이지가 현실보다 많은지 적은지는 모른다(가정).
- 한계: 가상 VAN이 같은 PC(네트워크 지연 0), 변경 모델이 단순(지나간 자리만, 균등 선택), 한 번 실행, 429·5xx 없음.
```

`docs/decisions/0033-…`에 한 줄: `- 실험 0012(2026-10-26): 5만 건 … ms(수집 …·비교 …·재검증 …), 쿼리 …개, 변경 10건/페이지에서 거짓 양성 …건을 재검증이 걸렀고 …건을 놓쳐 다음 실행이 찾았다.`

devlog에 `## HH:MM Task 10 실험 0012 VAN 대조 5만 건 (F9)` 항목(결론 두 줄).

커밋:
```bash
git add apps/api docs
git commit -m "exp(F9): 0012 VAN 대조 5만 건 — 단계별 시간·쿼리 수, 스캔 도중 변경의 거짓 양성과 놓침" -m "Refs: docs/experiments/0012-VAN-대조-5만-건.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 5일차 마감 — 전체 검증, 마이그레이션 체인, 실서버 확인(partners + device-sim + API·워커·스케줄러), 주기 작업 정리, 기록 정리

**Files:**
- Record: `docs/devlog/2026-10-26.md`(5일차 요약), `docs/study/backlog.md`
- Modify: `../01_B_단말기생애주기_설계안.md`(저장소 밖, 커밋 대상 아님)

- [ ] **Step 1: 전체 검증**

Run (`apps/partners`): `npx vitest run && npm run typecheck && npm run build`
Run (`apps/device-sim`): `npx vitest run && npm run typecheck && npm run build`
Run (`apps/api`):
```bash
npx vitest run
npm run typecheck
npm run build
npm run db:migration:check
```
Expected: partners 6개 파일 `50 passed`, device-sim 4개 파일 `40 passed`, api 51개 파일 `324 passed`(개수를 기록, 리뷰 수정이 있었으면 더 많다), 모두 typecheck·build exit 0, `최신 상태`. api 전체 실행 로그에 `Connection is closed`가 있는지 `grep -c`로 세어 적는다.

- [ ] **Step 2: 빈 테스트 DB에 마이그레이션 체인 전체 적용**

테스트 DB를 지우고 다시 만든 뒤(맨 위 "프로세스·데이터 안전 규칙"의 명령) 마이그레이션만으로 스키마를 만든다.
```bash
npm run build
MYSQL_DATABASE=terminal_ops_test node dist/db/migrate.js up
mv src/migrations/.snapshot-terminal_ops_test.json "$TEMP/"   # troubleshooting/0015: 커밋하지 않는다
MYSQL_DATABASE=terminal_ops_test node dist/db/migrate.js check
git status --short
```
Expected: `Migration20261022035842`부터 Day 5의 다섯 마이그레이션까지 19개가 차례로 `Applied`, `check` → `최신 상태`, `git status`에 스냅샷 파일 없음. 테이블 24개(마이그레이션 기록 테이블 포함). 생성 열(`van_reconciliation_run.running_key`)과 이상 부분 unique(함수 인덱스)가 있어도 `최신 상태`여야 한다 — 다르다고 나오면 `getUpdateSchemaSQL`로 무엇이 다른지 보고 troubleshooting을 시작한다. 그다음 `npx vitest run`을 한 번 더 돌려 `51 passed / 324 passed`.

- [ ] **Step 3: 실서버 확인 (partners + device-sim + API·워커·스케줄러 한 프로세스, 개발 DB)**

개발 DB에는 Day 5 마이그레이션 다섯 개가 적용돼 있어야 한다(`npm run db:migrate && npm run db:seed`). 세 앱을 빌드해 둔다(`apps/partners`·`apps/device-sim`·`apps/api`에서 `npm run build`).

아래 스크립트를 스크래치패드(또는 `apps/api`, 커밋하지 않음)에 `smoke-day5.sh`로 두고 `apps/api`에서 Git Bash로 `bash <경로>/smoke-day5.sh`. VAN 페이지는 2건(`BRIDGEVAN_PAGE_SIZE=2`, 페이지 넘김을 보려고), 하트비트·relay·판정은 짧게 띄운다. cron 작업 세 개는 등록만 확인하고(돌지 않는다) 기능은 수동 API로 부른다.
```bash
# Day 5 실서버 확인. apps/api에서 Git Bash로 실행: bash smoke-day5.sh
# 포트는 AP(API)·PP(partners)·SP(device-sim)로 바꿀 수 있다(기본 3000·4010·4020).
AP=${AP:-3000}; PP=${PP:-4010}; SP=${SP:-4020}
B=localhost:$AP; H='Content-Type: application/json'; O='X-Operator: manual'; S=$(date +%H%M%S)
P=127.0.0.1:$PP; SIM=127.0.0.1:$SP

PARTNERS_PORT=$PP node ../partners/dist/main.js > smoke-partners.log 2>&1 & P1=$!
DEVICE_SIM_PORT=$SP node ../device-sim/dist/main.js > smoke-sim.log 2>&1 & P2=$!
API_PORT=$AP PARTNERS_URL=http://$P RELAY_INTERVAL_MS=1000 OFFLINE_DETECT_INTERVAL_MS=1000 CONNECTIVITY_SNAPSHOT_INTERVAL_MS=2000 \
  ACTIVE_REBUILD_INTERVAL_MS=5000 BRIDGEVAN_PAGE_SIZE=2 \
  node dist/main.js > smoke-api.log 2>&1 & P3=$!
echo "PIDS partners=$P1 sim=$P2 api=$P3"
until curl -s -o /dev/null $B/health; do sleep 0.5; done
until curl -s -o /dev/null $SIM/__admin/health; do sleep 0.5; done
echo "S=$S"

echo '--- 1. 운영 중(IN_SERVICE) SN-300 단말기 3대 + device-sim 하트비트(1초) → 접속 상태 스냅샷'
SN300='{"results":[{"itemCode":"POWER","passed":true},{"itemCode":"NETWORK","passed":true},{"itemCode":"TOUCHSCREEN","passed":true}]}'
for X in 1 2 3; do
  N=D5-$S-$X
  curl -s -X POST $B/terminals -H "$H" -H "$O" -d "{\"serialNo\":\"$N\",\"modelCode\":\"SN-300\"}" -o /dev/null
  curl -s -X POST $B/terminals/$N/inspections -H "$H" -H "$O" -d "$SN300" -o /dev/null
  curl -s -X POST $B/terminals/$N/transitions -H "$H" -H "$O" -d '{"to":"IN_STOCK","reason":"stock-in","expectedVersion":2}' -o /dev/null
  curl -s -X POST $B/terminals/$N/allocations -H "$H" -H "$O" -d '{"merchantCode":"YEOKSAM-CAFE","expectedVersion":3}' -o /dev/null
  curl -s -X POST $B/shipments -H "$H" -H "$O" -d "{\"serialNo\":\"$N\",\"carrier\":\"BUNGAE\",\"expectedVersion\":4}" -o /dev/null
  curl -s -X POST $B/terminals/$N/transitions -H "$H" -H "$O" -d '{"to":"DELIVERED","reason":"delivered","expectedVersion":5}' -o /dev/null
  curl -s -X POST $B/terminals/$N/transitions -H "$H" -H "$O" -d '{"to":"IN_SERVICE","reason":"installed","expectedVersion":6}' -o /dev/null
done
curl -s $B/terminals/D5-$S-3; echo
sleep 6   # relay(1초) → project job → active, 재구성 5초
curl -s -X POST $SIM/__admin/config -H "$H" -d "{\"targetUrl\":\"http://127.0.0.1:$AP\",\"serials\":[\"D5-$S-1\",\"D5-$S-2\",\"D5-$S-3\"],\"intervalMs\":1000,\"batchSize\":3}" -o /dev/null
curl -s -X POST $SIM/__admin/start; echo
sleep 4
curl -s $B/terminals/D5-$S-1/connectivity; echo
curl -s -X POST $SIM/__admin/stop -o /dev/null

echo '--- 2. 브릿지VAN에 우리 운영 중 단말기를 심고(D5-2는 정지, 없는 시리얼 하나 ACTIVE) VAN 대조(페이지 2건씩)'
curl -s "$B/terminals?status=IN_SERVICE&size=100" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const items=JSON.parse(s).items;
  const regs=items.map((t,i)=>({tid:'VT-'+t.serialNo,serialNo:t.serialNo,merchantCode:t.merchantCode??'NONE',
    status:t.serialNo==='D5-$S-2'?'SUSPENDED':'ACTIVE'}));
  regs.push({tid:'VT-D5-$S-X',serialNo:'D5-$S-X',merchantCode:'YEOKSAM-CAFE',status:'ACTIVE'});
  process.stdout.write(JSON.stringify({registrations:regs}));});" > smoke-van.json
curl -s -X POST $P/__admin/bridgevan/registrations -H "$H" --data-binary @smoke-van.json; echo
curl -s -X POST $P/__admin/config -H "$H" -d '{"bridgevan":{"delayMs":500}}' -o /dev/null   # 진행 중에 다시 요청하려고 페이지마다 0.5초
RUN=$(curl -s -X POST $B/van-reconciliations -H "$O")
echo $RUN
RID=$(echo $RUN | sed 's/^{"id":\([0-9]*\).*/\1/')
curl -s -X POST $B/van-reconciliations -H "$O"; echo
until curl -s $B/van-reconciliations/$RID | grep -qE '"status":"(COMPLETED|FAILED)"'; do sleep 0.5; done
curl -s "$B/van-reconciliations/$RID?verified=true"; echo
curl -s -X POST $P/__admin/config -H "$H" -d '{"bridgevan":{"delayMs":0}}' -o /dev/null

echo '--- 3. 이상 단말기 찾기(수동) → 열린 이상'
curl -s -X POST $B/anomaly-scans -H "$O"; echo
curl -s "$B/anomalies?open=true&limit=3"; echo

echo '--- 4. 주간 리포트(지난주) → 톡톡 첨부, 다시 보내면 alreadySent, 내려받기'
WR=$(curl -s -X POST $B/reports/weekly -H "$H" -H "$O" -d '{}')
echo $WR
WS=$(echo $WR | sed 's/^{"weekStart":"\([0-9-]*\)".*/\1/')
curl -s -X POST $B/reports/weekly -H "$H" -H "$O" -d "{\"weekStart\":\"$WS\"}"; echo
curl -s -o smoke-report.xlsx -w "download: %{http_code} %{size_download} bytes %{content_type}\n" $B/reports/weekly/$WS/file

echo '--- 5. 알림(톡톡메신저)'
sleep 3
curl -s $P/__admin/toktok/messages | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s).messages;
console.log(m.filter(x=>/VAN 등록 대조|이상 단말기|주간 운영 리포트/.test(x.text)).map(x=>x.text+(x.attachments.length?' 첨부='+JSON.stringify(x.attachments.map(a=>[a.fileName,a.size])):'')).join('\n'));});"

kill $P3 $P2 $P1
echo "--- 종료: kill $P3 $P2 $P1"
```

Expected(사전 검증에서 테스트 DB·포트 3100/4110/4120으로 같은 흐름을 확인했다):
- 1: `D5-<S>-3`이 `IN_SERVICE`, version 7. device-sim `{"running":true}`, 접속 상태 `source: redis`, `online: true`
- 2: 심기 `{"count":<운영 중 단말기 수 + 1>}`(개발 DB의 이전 실서버 확인이 남긴 운영 중 단말기도 들어간다 — 그래서 미등록·가맹점 다름이 0이다). 실행 응답 `status: RUNNING`, 바로 다시 요청은 `{"statusCode":409,"code":"VAN_RECONCILIATION_RUNNING",…}`(페이지마다 0.5초 지연을 걸어 둠). 끝난 실행 `status: COMPLETED`, `pages`(= ceil(등록 수 / 2)), `confirmed: 2`, `counts`의 `SUSPENDED_WHILE_IN_SERVICE: 1`·`REGISTERED_BUT_NOT_IN_SERVICE: 1`, items 두 줄(`D5-<S>-2` 정지, `D5-<S>-X` 우리 DB에 없음)
- 3: 찾기 응답 `{ detected, continuing, resolved, open, newSerials }`. 개발 DB의 이전 단말기(3~4일 전에 만든 ALLOCATED·SHIPPED 등)가 규칙에 걸리면 `detected`가 0보다 클 수 있다(값을 기록). 열린 이상 목록
- 4: 주간 리포트 `weekStart`가 지난주 월요일(실행일이 2026-10-26이면 `2026-10-19`), `status: SENT`, `fileName: 단말온-주간리포트-<주>.xlsx`, `fileSize`(수 KB~수십 KB), 다시 보내면 같은 값에 `alreadySent: true`, `download: 200 <fileSize> bytes application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- 5: 톡톡 메시지에 `[단말온] 주간 운영 리포트 <주> 주(KST) — 첨부 … 첨부=[["단말온-주간리포트-<주>.xlsx",<fileSize>]]`, `[단말온] VAN 등록 대조 #<id>: 어긋남 2건(미등록 0, 운영 아님 1, 가맹점 다름 0, 정지 1), 재검증으로 풀림 0건, VAN 등록 <n>건`. 새 이상이 있었다면 `[단말온] 이상 단말기 …`도
- `smoke-api.log`에 `주기 작업 등록: carrier-sweep 30000ms, outbox-relay 1000ms, active-rebuild 5000ms, offline-detect 1000ms, connectivity-snapshot 2000ms, rollout-control 5000ms, anomaly-scan-daily cron "0 2 * * *" Asia/Seoul, van-reconcile-daily cron "0 3 * * *" Asia/Seoul, weekly-report cron "0 9 * * 1" Asia/Seoul`, `terminal-ops api listening on http://localhost:3000 (workers=true, schedulers=true, queuePrefix=terminal-ops)`. 세 로그에 error·exception·warn 0줄(`grep -icE "error|exception|warn" smoke-*.log`)

출력을 devlog에 붙인다. 내려받은 `smoke-report.xlsx`를 엑셀(또는 exceljs)로 열어 시트 8장과 요약 시트를 눈으로 확인하고 devlog에 적는다. 끝나면 스크립트가 띄운 세 프로세스가 PID로 꺼졌는지 확인한다: `netstat -ano | grep -E ':(3000|4010|4020) .*LISTENING'` 결과 없음. 파일을 지운다(`rm smoke-api.log smoke-partners.log smoke-sim.log smoke-van.json smoke-report.xlsx`).

- [ ] **Step 4: 개발 Redis의 주기 작업 정리**

Run: `npm run scheduler:clear`
Expected: `주기 작업 삭제(접두사 terminal-ops): carrier-sweep, outbox-relay, active-rebuild, offline-detect, connectivity-snapshot, rollout-control, anomaly-scan-daily, van-reconcile-daily, weekly-report`. 하트비트 키는 남겨 둔다(다음 실행의 재구성·판정이 맞춘다). 지우고 싶으면 `redis-cli --scan --pattern 'terminal-ops:hb:*'`로 본 뒤 UNLINK로만 지운다(FLUSH 금지).

- [ ] **Step 5: 하루 요약과 공부거리 정리**

devlog 맨 아래에 `## 5일차 요약`을 쓴다(4일차 요약과 같은 항목).
- 만든 API·주기 작업: partners 브릿지VAN(목록·시리얼·단건·심기·스캔 도중 변경)·톡톡 파일, `POST/GET /van-reconciliations`, `GET /anomalies`, `POST /anomaly-scans`, `POST /reports/weekly`, `GET /reports/weekly/:weekStart(/file)`, report 큐와 cron 주기 작업 3개, 이월(intFromEnv, 중복 인덱스 6개)
- 테스트 수: api, partners, device-sim(실제 값)
- 커밋 목록(`git log --oneline master..`)
- 실험 0011·0012 결론 한 줄씩(잰 숫자로)
- 쿼리·인덱스·실행계획 관련 발견: status_changed_at 대 이력 서브쿼리, 중복 인덱스와 ERROR 1553, 부분 unique 두 방식(함수 인덱스·생성 열)과 `_utf8mb4` 비교 문제, 스테이징 + SQL 집합 비교, 키셋 페이지, NOT NULL 열 추가와 strict 모드, insertMany 기본값(troubleshooting/0022), ORDER BY enum 순서, 이력 datetime(0) 반올림, em.execute `'run'`
- 계획과 달라진 점, 남은 문제(스펙 8장 + 새로 생긴 것), 내일(Day 6 React 어드민) 시작 전에 필요한 것(설계안 8장 Day 6 행)

`docs/study/backlog.md`의 중복 항목을 합친다. 설계안 `../01_B_단말기생애주기_설계안.md` 8장 Day 5 행 끝에 `✅ 완료(커밋 범위)`를 표시한다(저장소 밖이라 커밋하지 않는다).

- [ ] **Step 6: 커밋**

```bash
git add docs
git commit -m "docs: 5일차 마감 기록" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-Review 결과

- 브리프 0(이월):
  - env 숫자 검증(정수·범위, NaN이면 부팅 실패, 주기 값에 적용) → Task 1(`intFromEnv`, env.ts 숫자 16개 전부, 이후 Task의 새 값도 같은 함수). 모듈을 불러올 때 던지는 것까지 테스트
  - 중복 인덱스 후보 3개 + 같은 조건으로 찾은 3개, MySQL 허용 여부(ERROR 1553 재현) → Task 1 / decisions/0032, 쓰기 비용 → Task 9(0011 ②)에서 숫자를 보탬. `terminal_status_index`도 Task 5에서 같은 원칙으로 지움
  - devlog 파일은 컨트롤러가 만듦 → 모든 Task가 그 파일에 덧붙임
- 브리프 1(브릿지VAN): 시드 관리 API(`POST /__admin/bridgevan/registrations`, 우리 DB 목록 + 어긋남 비율로 만드는 쪽은 api 테스트·실험이 함) → Task 2·4·10. 커서 목록(offset 아님, 결정 기록) → Task 2 / 0033. 단건 `:tid` → Task 2(재검증은 `?serialNo=` — 범위 조정). 429·5xx·지연·스캔 도중 변경(시드 재현) → Task 2
- 브리프 2(VAN 대조): 대조 키 시리얼·가맹점 코드(결정) → Task 4 / 0033. report 큐 분리 → Task 3. 실행 행 RUNNING → Task 3. 커서 수집·페이지마다 일괄 INSERT·429 재시도·Retry-After → Task 3. SQL 집합 비교 4종류 → Task 4(두 문장 + classify, 범위 조정). 재검증(단건·우리 쪽 다시 읽기, 풀린 수 기록) → Task 4. 결과·실행 요약·Outbox 1행 → Task 4. `POST`(진행 중 409)·`GET`(요약 + 항목 페이지)·일 1회 주기 → Task 3·4·6. 스테이징 정리(PK·run_id, 배치 크기) → Task 3·4
- 브리프 3(이상 단말기): 규칙 6개(설정 가능한 기준일) → Task 5. "그 상태가 된 시각" (a)/(b) 설계·실험·결정·백필 → Task 5(b 구현, 백필 마이그레이션) + Task 9(0011 ①) / 0034. 결과 테이블·열린 이상 하나(부분 unique 검증 후 결정)·새로·계속·풀림(PK 갱신) → Task 5. 알림(많으면 묶음 1행) → Task 6. `GET /anomalies`·`POST /anomaly-scans`·일 1회 주기(report 큐) → Task 5·6
- 브리프 4(주간 리포트): cron `pattern` + `tz` 사전 검증·테스트는 수동 트리거 → Task 6(검증 사실, scheduler.e2e가 `next`를 봄)·Task 8. 시트별 내용 7가지(DB 집계) → Task 7·8. exceljs → 톡톡 첨부(base64 결정)·수신 기록에 크기·이름 → Task 8. 멱등(`weekly_report` week_start unique, 재시도는 같은 행)·다운로드(DB blob 결정) → Task 8. KST 주 경계 변환 함수와 테스트 → Task 7
- 브리프 5(실험): 0011(10만·100만, (a)/(b) EXPLAIN ANALYZE·시간, 중복 인덱스 INSERT 비용, 대조 쿼리·Day 1 검수 통계 실행계획) → Task 9. 0012(5만, 2%, 총 소요(수집·비교·재검증), 쿼리 수, 스캔 도중 변경의 재검증 전후 거짓 양성) → Task 10. 둘 다 `EXPERIMENTS=1`, `--silent=false`
- 진행·안전: 번호 decisions 0032~0035, troubleshooting 0022(Task 5 계획한 재현), experiments 0011·0012. 안전 규칙(PID로만, FLUSH 금지, 테스트 DB만, 개발 DB는 migrate·seed·create·읽기 확인·실서버 확인, 테스트 동시 실행 금지) → 맨 위 절. 교훈: 외부 호출은 트랜잭션 밖(수집·재검증·톡톡), 부모 먼저·PK 갱신(실행 행 → 결과, 이상 PK `IN`), relay·묶음 이벤트(VAN 요약 1행, 이상 묶음), `fromDbDatetime`·NOW() 안 씀(규칙·리포트), 연결 collation(스테이징 serial_no가 같은 collation), 대량 처리 정렬(결과는 시리얼 순), 커밋 뒤 사본 없음(Redis는 잠금만), 실험 기록은 원본 출력·추정 표시 → 각 Task
- 브리프와 다르게 한 것: "범위 조정" 절에 이유와 함께(중복 인덱스 6개 + status 단독, (b) 먼저 구현, 재검증은 시리얼 조회, 지나간 자리 변경, SQL 두 문장 + classify, 풀린 후보도 행으로, 실행 job 재시도 없음·멈춘 실행 정리, 키셋 결과 목록, ALLOCATED 규칙, OFFLINE 기준 열, 새 이상만 알림, 동기/비동기, 리포트 톡톡 재시도 위치, cron env, partnerBackoffMs 공유, Task 3 테스트 등록 해지 상태). VAN 실행의 "진행 중 하나"는 브리프의 부분 unique 아이디어를 생성 열로 구현(MikroORM where는 글자 상수 때문에 check가 불안정 — 사전 검증).
- 플레이스홀더 점검: 모든 코드 단계에 전체 파일이나 정확한 diff가 있다(사전 검증 저장소의 Task별 커밋에서 생성기로 그대로 옮김). 마이그레이션 파일 이름(`Migration<시각>`), 커밋 해시, 기록 파일의 잰 숫자, devlog 시각만 실행해서 채운다(숫자는 잰 값만 쓰는 규칙). 기록 문서는 내용 항목을 적고 숫자 자리는 "(잰 값)"으로 남겼다.
- 타입·이름 일관성:
  - `intFromEnv(name, fallback, range, source?)`, `DAY_MS`, env: `bridgevanPageSize`, `vanRunStaleMs`, `vanReverifyConcurrency`, `anomalyDays.{deliveredNotInstalled, returnStalled, shippedTooLong, allocatedNoShipment, offlineTooLong}`, `anomalyBulkEventThreshold`, `anomalyScanCron`, `vanReconcileCron`, `weeklyReportCron`
  - `partnerBackoffMs(attempt, error?, baseMs?)`, `withPartnerRetry(fn, { attempts, baseMs?, sleep?, onRetry? })`, `PARTNER_RETRY_BASE_MS`, `carrierBackoff`(그대로 이름)
  - `VanStatus`, `VanMismatchKind`, `VanRunStatus`, `VanRunTrigger`, `VanPhaseMs`, `VanReconciliationRun.runningKey`, `VanRegistrationSnapshot`, `VanReconciliationItem`, `BridgevanClient.list(cursor, limit)/findBySerial(serialNo)`, `VanRegistrationDto`, `VanPage`
  - `VanReconciliationService.start(trigger, actor, now?)/request(actor)/runScheduled()/execute(runId)/collect(runId)/compare(runId)/reverify(candidates)/cleanupSnapshots(runId)/deleteSnapshot(runId)/get(id)/items(runId, q)`, `toVanRunView`, `VAN_SYSTEM_ACTOR`, `VAN_CALL_ATTEMPTS`, `VanRunJobData`, `VanCandidate`, `classify(our, van)`, `ourValueOf`, `vanValueOf`, `KIND_LABEL`, `VanItemsQuery`
  - `Terminal.statusChangedAt`, `Anomaly`, `AnomalyRule`, `findAnomalies(em, now, thresholds?)`, `AnomalyMatch`, `AnomalyThresholds`, `ANOMALY_RULE_LABEL`, `AnomalyService.scan(now?, thresholds?)/list(q)`, `ScanResult`, `ListAnomaliesQuery`
  - `JOB_SCHEDULERS[].schedule()`, `JobSchedule`, `SCHEDULE_TZ`, `describeSchedule`, `SchedulerService(sweep, outbox, device, report)`, report job 이름 `van-reconcile`, `van-reconcile-scheduled`, `anomaly-scan`, `weekly-report`, 스케줄러 id `anomaly-scan-daily`, `van-reconcile-daily`, `weekly-report`
  - `KstWeek`, `kstWeekOf`, `previousKstWeek`, `parseKstWeekStart`, `kstDate`, `WeeklyReportQueries.collect(week, now?)`, `WeeklyReportData`, `ANOMALY_SHEET_LIMIT`, `buildWeeklyReportXlsx(data)`, `SHEET_NAMES`, `weeklyReportFileName`, `XLSX_CONTENT_TYPE`, `WeeklyReport`, `WeeklyReportStatus`, `WeeklyReportService.send(week, now?)/sendScheduled(now?)/get(weekStart)/file(id)`, `weeklyReportIdempotencyKey`, `toWeeklyReportView`, `SendWeeklyReportDto`
  - `OUTBOX_TYPE.{VAN_RECONCILIATION_COMPLETED, ANOMALY_DETECTED, ANOMALY_DETECTED_BULK}`, `ToktokClient.send({ idempotencyKey, text, attachments? })/uploadFile({ fileName, contentType, content })`
  - BusinessError 코드: VAN_RECONCILIATION_RUNNING(409), ANOMALY_SCAN_RUNNING(409), WEEKLY_REPORT_IN_PROGRESS(409), 400 INVALID_WEEK_START
  - partners: `BridgevanConfig`, `VanRegistration`(healTo), `VAN_STATUSES`, `encodeCursor/decodeCursor`, `bridgevanList/bridgevanGet/bridgevanSeed`, stats `vanMutated/vanHealed`, `ToktokConfig.maxFileBytes`, `ToktokFile`, `toktokUpload/toktokFile`, 메시지 `attachments`, 요약 `files`
  - 테스트 헬퍼: `insertTerminals(t, rows)`(`TerminalSeed.statusChangedAt?`), `partners.seedVan(registrations, replace?)`, `partners.toktokFile(fileId)`, `VanSeed`
- 사전 검증: Task 1~10을 이 순서로 적용해 Task마다 typecheck·테스트 통과를 확인했다(api 268 → 277 → 287 → 303 → 310 → 314 → 318 → 324, partners 40 → 47 → 50, device-sim 40). Task별 "실패 확인"의 실패 내용은 그 Task 직전 코드에 그 Task의 테스트를 넣어 돌려 본 것이다. 실험 0011·0012를 끝까지 한 번씩(0011은 지우기 반복문 `'run'` 문제를 고친 뒤 다시 한 번), 빈 테스트 DB 마이그레이션 체인 19개와 백필, 실서버 흐름(테스트 DB·포트 3100/4110/4120)을 확인했다(숫자는 적지 않는다). 사전 검증 중 VAN 실행의 부분 unique를 함수 인덱스에서 생성 열로 바꿨고(체인 뒤 check가 다르다고 함), 계획에는 바꾼 뒤의 코드와 마이그레이션을 적었다.
