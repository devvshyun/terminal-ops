# Day 2 설계 — 택배사 연동, 택배 추적 자동 수집, 알림 Outbox

- 날짜: 2026-10-22
- 범위: 설계안 8장 Day 2(F12 택배사 어댑터, F3 택배 추적 자동 수집, F5 알림) + Day 1 이월 3건 + 가맹점·배정·출고 최소 구현 + 실험 3개
- 구현 계획: `docs/plans/2026-10-22-day2-carrier-sync.md`
- 등장하는 회사(번개택배, 느림보물류, 톡톡메신저)와 가맹점(강남김밥, 역삼카페, 판교분식)은 모두 가상이다.

## 1. 무엇을 왜

단말기를 가맹점에 보내면(SHIPPED) 지금은 운영자가 택배사 사이트를 보고 손으로 DELIVERED를 찍어야 한다. Day 2는 이 일을 시스템이 대신하게 한다.

1. 택배사 두 곳의 서로 다른 API(JSON, XML)를 같은 배송 이벤트로 바꾼다(F12).
2. 배송 중인 운송장을 주기적으로 조회해 새 이벤트만 저장하고, 배송 완료면 단말기를 자동으로 DELIVERED로 바꾼다(F3).
3. 상태가 바뀔 때마다 사내 메신저로 알린다. 상태는 바뀌었는데 알림이 빠지는 일이 없어야 한다(F5).

택배사는 같은 이벤트를 두 번 보내고(번개), 호출이 많으면 429를 주고(번개), 느리고 가끔 5xx를 주며 순서가 섞여 온다(느림보). 이 골칫거리를 가상 업체 서버가 재현하고, 실험으로 "중복 반영 0건", "429 비율별 완료율·시간", "워커 2개에서도 중복 없음"을 숫자로 남긴다.

## 2. 구성

```
apps/partners (node:http, 별도 프로세스, 메모리 상태, 시드 난수)
  ├─ /bungae/v1/...      번개택배 JSON: 운송장 발급, 추적(조회마다 한 단계 진행, 중복·429)
  ├─ /neurimbo/api/...   느림보물류 XML: 송장 발급, 추적(지연·503·순서 섞기)
  ├─ /toktok/hooks/:ch   톡톡메신저 웹훅(가끔 500, 받은 메시지 전부 저장)
  └─ /__admin/...        설정 부분 병합·초기화·통계·톡톡 수신 목록

apps/api (Nest)
  ├─ 기존: terminal(전이 서비스), inspection
  ├─ merchant           가맹점 시드, 배정 API
  ├─ carrier            어댑터(번개·느림보), 순수 파서
  ├─ shipment           출고 API, Shipment·CarrierEvent·SyncRun
  ├─ carrier-sync       sweep, track(이벤트 적재·배송 완료 반영)
  ├─ outbox             OutboxEvent, relay, notify, 톡톡 클라이언트
  ├─ queue              BullMQ 연결과 큐 4개 (전역 모듈)
  ├─ workers            큐 프로세서 모음 (RUN_WORKERS=1일 때만)
  └─ scheduler          주기 작업 등록 (RUN_SCHEDULERS=1일 때만)

진입점: src/main.ts (HTTP + 선택적으로 워커·스케줄러), src/worker.ts (HTTP 없는 워커 전용)
Redis: BullMQ 큐 저장소. 키 접두사로 개발(terminal-ops)과 테스트(test-<pid>-<시각>)를 나눈다.
```

큐는 4개다.

| 큐 | job | 넣는 곳 | 비고 |
|---|---|---|---|
| `carrier-sweep` | `sweep` | job scheduler(주기) | 배송 중 운송장마다 추적 job을 넣는다 |
| `track-bungae` | `track` | sweep | limiter 초당 `BUNGAE_RATE_PER_SEC`(기본 10) |
| `track-neurimbo` | `track` | sweep | limiter 초당 `NEURIMBO_RATE_PER_SEC`(기본 5) |
| `outbox` | `relay`, `notify` | relay는 job scheduler, notify는 relay | relay 간격 `RELAY_INTERVAL_MS` |

택배사마다 호출 한도가 달라 추적 큐를 나눴다. BullMQ limiter는 큐 단위로 Redis에 저장되므로 워커 프로세스가 여러 개여도 합산 속도가 한도를 넘지 않는다.

## 3. 데이터 모델

| 엔티티 | 핵심 컬럼 | 제약·인덱스 | 메모 |
|---|---|---|---|
| `Merchant` | code, name, address | code unique | 시드 3곳 |
| `Terminal` (변경) | + merchant_id (nullable) | FK → merchant | 배정 때 상태와 한 UPDATE로 설정 |
| `TerminalStatusHistory` (변경) | source enum + `BATCH` | | 네이티브 enum이라 ALTER 마이그레이션 |
| `Shipment` | terminal_id, carrier(BUNGAE·NEURIMBO), tracking_no, status(IN_TRANSIT·DELIVERED), last_synced_at, delivered_at | tracking_no unique, status 인덱스 | 출고 1건 = 운송장 1장 |
| `CarrierEvent` | shipment_id, event_key, code, occurred_at, raw(json), received_at | **unique(shipment_id, event_key)** | 중복 방지의 마지막 안전망 |
| `SyncRun` | job, shipment_id?, attempt, worker, outcome, fetched, inserted, duplicated, detail, started_at, finished_at | | 추적 job 실행 1회 = 1행. 실험 집계용 |
| `OutboxEvent` | type, payload(json), status(PENDING·QUEUED·SENT·FAILED), attempts, last_error, created_at, sent_at | (status, id) 인덱스, **FK 없음** | 상태 변경과 같은 트랜잭션에 기록 |

공통 코드 `CarrierEventCode`: PICKED_UP, IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED. 번개 `code` 문자열은 그대로, 느림보 `statusCd` 10/20/30/40은 이 순서로 바꾼다. `eventKey`는 번개 `eventId`, 느림보 `seq`.

주의: `Date | null` 같은 유니온 타입 속성은 데코레이터 메타데이터가 `Object`로 나와 MikroORM이 `varchar(255)`를 만든다. nullable 날짜에는 `type: 'datetime'`을 적는다(사전 검증에서 확인).

## 4. 흐름

### 4.1 배정 `POST /terminals/:serialNo/allocations { merchantCode, expectedVersion }`

1. 가맹점 조회(없으면 404).
2. `TransitionService.transition({ to: ALLOCATED, mutate: t => t.merchant = merchant, expectedVersion })`
   - `SELECT terminal (+model, merchant)` → 낙관적 락 검사 → 규칙 검사 → status·merchant 변경 → **`UPDATE terminal SET status, merchant_id, version+1 WHERE id AND version`** 한 번 → `INSERT history` → (Day 2 Task 8부터) `INSERT outbox_event` → COMMIT.

### 4.2 출고 `POST /shipments { serialNo, carrier, expectedVersion }`

1. 트랜잭션 밖: 단말기 조회, version 확인(`em.lock(OPTIMISTIC)`), 상태 ALLOCATED·가맹점 있음 확인. 실패하면 택배사를 부르지 않는다(409·422).
2. 트랜잭션 밖: 어댑터 `createWaybill()` (HTTP). 택배사 오류는 502 `PARTNER_ERROR`.
3. 트랜잭션: `transition(ALLOCATED → SHIPPED)` 먼저(`UPDATE terminal` → `INSERT history` → `INSERT outbox`), 그다음 `INSERT shipment`. 단말기 UPDATE가 X 락을 먼저 잡으므로 shipment INSERT의 FK 검사(S 락)와 S→X 데드락이 생기지 않는다(troubleshooting/0004, decisions/0006).
4. 3이 실패하면(동시 출고로 409 등) 2의 운송장은 택배사 쪽에 고아로 남는다. **알려진 한계**(decisions/0012). 외부 HTTP를 DB 트랜잭션 안에서 기다리지 않는 쪽을 골랐다.

### 4.3 수집 sweep (주기 실행)

`SELECT shipment WHERE status = IN_TRANSIT` → 운송장마다 `queue.add('track', { shipmentId }, { jobId: 'track-<id>', attempts: 5, backoff: 'carrier', removeOnComplete, removeOnFail })`.

- 같은 jobId의 job이 대기·처리·재시도 대기 중이면 BullMQ가 새 add를 무시한다 → 같은 운송장을 동시에 두 번 조회하지 않는다(워커가 여러 개여도).
- 완료·최종 실패한 job을 지워야 다음 sweep에서 같은 jobId로 다시 넣을 수 있다(그래서 removeOnComplete/removeOnFail).
- BullMQ 커스텀 jobId에는 `:`를 쓸 수 없다(쓰면 add가 에러). 그래서 `track-<id>`, `outbox-<id>`.

### 4.4 추적 track (워커, 운송장 1건)

워커에는 요청 컨텍스트(RequestContext)가 없다. 작업마다 `em.fork()`를 쓴다.

1. `SELECT shipment` — 없거나 IN_TRANSIT가 아니면 SKIPPED.
2. 어댑터 `track()` (HTTP, 트랜잭션 밖).
3. 이벤트 적재(트랜잭션 없이, 문장마다 자동 커밋):
   - 응답 안의 같은 eventKey를 하나로 줄인다(번개 중복).
   - `SELECT carrier_event WHERE shipment_id = ? AND event_key IN (...)`로 이미 있는 키를 한 번에 조회해 뺀다.
   - 남은 것만 `em.insert()`(단건 INSERT, Unit of Work 밖). unique 위반이면 "다른 워커가 먼저 넣음"으로 보고 중복으로 센다.
4. DELIVERED 이벤트가 있으면 배송 완료 반영(4.5), 없으면 `UPDATE shipment SET last_synced_at`.
5. `INSERT sync_run`(별도 fork, 실패해도 수집 결과는 그대로).

### 4.5 배송 완료 반영 (한 트랜잭션)

`SELECT shipment JOIN terminal` →
- 운송장이 이미 DELIVERED면 NOOP.
- 단말기가 SHIPPED면 `transition(SHIPPED → DELIVERED, source BATCH, actor system:carrier-sync)` 먼저: `UPDATE terminal` → `INSERT history` → `INSERT outbox`.
- 단말기가 SHIPPED가 아니면(운영자가 먼저 수동으로 DELIVERED로 바꿨거나 그 이후 상태) 단말기는 건드리지 않는다(NOOP, 이유를 SyncRun.detail에).
- 마지막에 `UPDATE shipment SET status=DELIVERED, delivered_at, last_synced_at` → COMMIT.

carrier_event INSERT는 이 트랜잭션 전에 자동 커밋으로 끝났으므로 shipment 행에 남은 S 락이 없다. outbox_event에는 FK가 없어 단말기 행에 S 락을 걸지 않는다.

### 4.6 Outbox

- 기록: `TransitionService.transition()`과 `recordRegistration()`이 이력과 같은 트랜잭션에서 `OutboxEvent(PENDING)`을 만든다. 전이가 롤백되면 알림도 사라지고, 커밋되면 반드시 남는다.
- relay(주기): 트랜잭션에서 `SELECT ... WHERE status=PENDING ORDER BY id LIMIT N FOR UPDATE SKIP LOCKED` → 행마다 `queue.add('notify', { outboxId }, { jobId: 'outbox-<id>', attempts 5, exponential 200ms })` → `UPDATE status=QUEUED` → COMMIT. relay가 여러 개 돌아도 같은 행을 잡지 않는다.
- notify(워커): 행이 SENT·FAILED면 건너뜀 → `attempts+1` → 톡톡 `POST { idempotencyKey: 'outbox-<id>', text }` → 성공이면 SENT, 실패면 last_error 기록 후 재시도(마지막 시도면 FAILED, 4xx면 바로 FAILED).
- 보장 수준: **최소 한 번(at-least-once) + 멱등키**. 톡톡이 받은 뒤 SENT를 쓰기 전에 워커가 죽으면 다시 보낸다. 정확히 한 번은 수신 쪽이 멱등키로 걸러야 성립한다(decisions/0016).

## 5. 실패 처리

| 상황 | 분류 | 처리 |
|---|---|---|
| 택배사 429 | `PartnerRateLimitedError(retryAfterMs)` | 재시도. 백오프 = Retry-After(최소 500ms) |
| 택배사 5xx, 타임아웃, 연결 실패 | `PartnerTransientError` | 재시도. 500ms·1s·2s·4s 지수 백오프, 최대 5회 |
| 택배사 4xx(429 외), 응답 형식 오류, 모르는 상태 코드 | `PartnerPermanentError` | `UnrecoverableError`로 바꿔 재시도 안 함. SyncRun ERROR |
| 낙관적 락 충돌, 데드락(1213) | ORM 오류 | 재시도(다음 시도에서 NOOP이 되거나 성공) |
| 규칙 위반(InvalidTransition), 단말기 없음 | 도메인 오류 | 재시도 안 함 |
| 출고 API에서 택배사 오류 | `PartnerError` | HTTP 502 `PARTNER_ERROR`, `reason`에 분류 |
| 톡톡 500 | `PartnerTransientError` | notify 재시도, 마지막 시도면 FAILED |

## 6. 실행 모드

`AppModule.forRoot({ workers, schedulers })`.

| 진입점 | workers | schedulers |
|---|---|---|
| `node dist/main.js` | `RUN_WORKERS` (기본 1) | `RUN_SCHEDULERS` (기본 1) |
| `node dist/worker.js` | 항상 | `RUN_SCHEDULERS` |
| 테스트 `createTestApp({ workers })` | 인자(기본 false) | 항상 false — 테스트가 `sweep()`·`relay()`를 직접 부른다 |

job scheduler는 id가 같으면 Redis에 하나만 남으므로 스케줄러를 켠 프로세스가 여러 개여도 주기 작업은 하나다.

## 7. 테스트 격리

- partners: vitest `globalSetup`이 `apps/partners`를 tsc로 빌드하고 `node dist/main.js`를 포트 4011로 띄운다(개발용 4010과 분리). 끝나면 종료. 테스트 파일은 `beforeEach`에서 `/__admin/reset`.
- Redis: 테스트 파일마다 큐 접두사가 다르다(`test-<pid>-<시각>`, vitest가 파일마다 모듈을 새로 읽음). 워커를 쓰는 파일은 시작·끝에 `obliterate`. globalSetup이 시작·끝에 `test-*` 키를 지운다.
- DB: 기존과 같이 `resetDatabase`(테스트 DB 가드) + `fileParallelism: false`.

## 8. 실험

| 번호 | 질문 | 설정 | 기준 |
|---|---|---|---|
| 0003 | 번개 중복 이벤트가 두 번 반영되는가 | duplicateRate 0.3, 운송장 30, seed 3 | carrier_event = 120, DELIVERED 이력 = 30, 단말기당 최대 1 |
| 0004 | 429 비율별 완료율·시간 | force429Rate 0.1/0.3/0.5, 운송장 30, sweep 500ms | 완료 수, 소요, 조회·429·재시도·소진 수 (숫자는 실제 잰 값만) |
| 0005 | 워커 프로세스 2개가 나눠 처리해도 중복이 없는가 | `dist/worker.js` 2개, 번개 delayMs 100, 운송장 30 | 같은 운송장 겹침 0, DELIVERED 단말기당 최대 1, 톡톡 중복 수신 수(측정) |

실험 스펙은 `test/experiments/`에 두고 `EXPERIMENTS=1`일 때만 돈다.

## 9. 기록할 결정

- 0007 전이 출처 BATCH 추가, `only` 없는 규칙의 기본 허용 출처를 MANUAL로 좁힘
- 0008 등록 이력도 TransitionService가 남긴다
- 0009 가상 업체 서버는 node:http 별도 프로세스, 메모리 상태, 시드 난수
- 0010 택배사 어댑터: 순수 파서 + 오류 3분류, 테스트는 globalSetup으로 실제 서버
- 0011 배정은 `TransitionCommand.mutate`로 상태와 한 UPDATE에
- 0012 운송장 발급은 트랜잭션 밖, 고아 운송장은 알려진 한계
- 0013 BullMQ 큐 구성과 Redis를 쓰는 이유(택배사별 큐·limiter, jobId 규칙, 접두사 격리)
- 0014 배송 완료 반영 규칙(no-op, 재시도 분류, Retry-After 존중)
- 0015 실행 모드(`AppModule.forRoot`, `worker.ts`)
- 0016 Outbox: 같은 트랜잭션 기록, SKIP LOCKED relay, 최소 한 번 + 멱등키

## 10. 이번에 하지 않는 것

- 일반 전이 API(`POST /terminals/:serialNo/transitions`)로도 ALLOCATED·SHIPPED를 가맹점·운송장 없이 만들 수 있다. 배정 취소(ALLOCATED → IN_STOCK) 때 가맹점을 비우지 않는다. 전용 출처(예: SHIPMENT)로 막는 것은 Day 3 F7(교체 출고)과 함께 검토한다.
- 고아 운송장 취소(택배사 취소 API), QUEUED로 멈춘 outbox 재전송(복구 sweep): 워커 강제 종료 실험(설계안 7장, Day 7)과 함께.
- 데드락(1213) HTTP 매핑: 워커 경로는 재시도로 처리한다. HTTP 경로는 Day 1과 같다(순서로 예방).
- Day 1 리뷰 Minor 2·4·5·6·7: 그대로 둔다(backlog).
