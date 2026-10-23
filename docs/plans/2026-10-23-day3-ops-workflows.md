# Day 3 — 발주·박스 일괄 입고·엑셀 등록·대조, A/S 교체 출고 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **기록 규칙 필수**: 이 저장소의 `CLAUDE.md`를 먼저 읽는다. 모든 Task는 마지막에 `docs/devlog/2026-10-23.md`에 항목을 덧붙이고(Day 2 항목과 같은 형식: 제목 시각 = 커밋 시각, `이전 Task 커밋:`, 한 일·확인·막힌 것·결정·다음), Task에 적힌 결정·트러블슈팅·실험 기록을 쓴 뒤 **코드와 같은 커밋**에 넣는다. 예상과 다른 에러를 만나면 고치기 전에 `docs/troubleshooting/`에 기록을 시작한다(이 계획이 0008을 Task 7에 예약했으므로 새로 생기면 0009부터).

**Goal:** 가상 공장 세움전자에 발주하고(F10), 박스 단위 스캔과 엑셀로 단말기를 한 번에 입고·등록하며(F6, F1 이월), 발주 대비 입고를 대조하고(F10), A/S 교체 출고를 두 단말기·운송장·접수를 묶은 한 트랜잭션으로 처리한다(F7). 대량 처리의 쿼리 수(N+1 대 일괄)와 교체 단말기 경합을 실험으로 남긴다.

**Architecture:** 상태 변경은 계속 `TransitionService` 한 곳에서만 한다. 출처(TransitionSource)를 늘려 배정·출고는 전용 API로만 가능하게 좁히고, 여러 대를 한 번에 바꾸는 `transitionMany`와 일괄 등록 엔진(`BulkRegistrationService`)을 더한다. 박스 스캔은 Redis 처리 중 잠금 + MySQL `ScanBatch`로 멱등을 보장한다. 외부 호출(공장·택배사)은 트랜잭션 밖, 부모 행 X 락은 자식 INSERT보다 먼저, 여러 행은 정해진 순서로 잠근다. 설계 스펙: `docs/specs/2026-10-23-day3-ops-workflows.md`.

**Tech Stack:** Node 24, TypeScript 6.0, Nest.js 12.2 (ESM, platform-express 내장 multer 2.4.0), MikroORM 7.2.5, MySQL 8.4(JSON_TABLE), BullMQ 6.4.0 + ioredis 5.11.1, exceljs 4.4.0, Vitest 5 + unplugin-swc, supertest

---

## 프로세스·데이터 안전 규칙 (모든 Task에 적용)

- **프로세스는 PID로만 끈다.** 직접 띄운 프로세스의 PID(`$!`, `child.pid`)로 `kill <PID>`. `taskkill /IM node.exe`, `pkill node`처럼 이름으로 끄지 않는다(다른 세션·IDE의 node가 함께 죽는다).
- **Redis를 통째로 지우지 않는다.** `FLUSHALL`·`FLUSHDB` 금지. 테스트 키는 접두사 `test-`(globalSetup이 `test-*`만 지운다), 개발 서버는 `terminal-ops`. 주기 작업을 지울 때는 `npm run scheduler:clear`(Task 1)를 쓴다.
- **테스트는 테스트 DB(`terminal_ops_test`)에서만.** `resetDatabase`는 테스트 DB가 아니면 거절한다. 테스트 DB는 지우고 다시 만들어도 된다(아래 명령). 개발 DB(`terminal_ops`)에는 마이그레이션 적용(`npm run db:migrate`)과 시드, Task 12의 실서버 확인만 한다. 개발 DB를 지우거나 `schema refresh`하지 않는다.
  ```bash
  MSYS_NO_PATHCONV=1 docker exec terminal-ops-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "drop database terminal_ops_test; create database terminal_ops_test character set utf8mb4 collate utf8mb4_0900_ai_ci; grant all privileges on terminal_ops_test.* to '"'"'terminal_ops'"'"'@'"'"'%'"'"';"'
  ```
- 실서버 확인은 끝나면 포트(3000·4010)에 리스너가 남지 않았는지 `netstat -ano | grep -E ':(3000|4010) .*LISTENING'`으로 확인한다.

## 사전 검증으로 확인된 사실 (2026-10-23, 임시 폴더 스파이크)

계획 작성 전에 임시 폴더에 저장소(master 90c3501)를 복제해 이 계획의 코드를 Task 순서대로 적용하고, Task마다 `tsc --noEmit`과 vitest를 돌려 통과를 확인했다(테스트 DB `terminal_ops_test`, Redis는 테스트 접두사만). 실험 2개는 한 번씩 끝까지 돌렸고(숫자는 여기 적지 않는다), 빈 테스트 DB에 마이그레이션 전체를 `up`한 뒤 `check`가 `최신 상태`인 것과 새 enum 마이그레이션의 down → up 왕복도 확인했다. 실서버(partners + API + 워커·스케줄러)로 발주 → 스캔 → 대조 → 마감, 엑셀 업로드, A/S 교체 → 자동 배송 완료 → 설치 확인 흐름도 한 번 돌렸다.

- 테스트 수(누적, api 기본 실행): Day 2 끝 16개 파일 114 → Task 1 17/127 → Task 3 18/132 → Task 4 20/141 → Task 5 21/148 → Task 6 22/154 → Task 7 23/159 → Task 8 24/165 → Task 9 25/169 → Task 10 25/170. partners: 4개 파일 32 → Task 2 5/39.
- **MikroORM 7 flush 묶음**: 한 트랜잭션에서 단말기 500대 + 등록 이력 + Outbox를 만들고 flush하면 쿼리는 `begin`, 모델 조회, INSERT 6번(테이블마다 batchSize 300씩), `select id, version`(version 컬럼이 있는 엔티티는 INSERT 뒤 version을 다시 읽는다) 2번, `commit`이다. Outbox(외래키 없음)가 단말기보다 먼저 INSERT된다.
- **version 있는 엔티티 여러 개를 바꾸고 flush**하면 `select id … where (id=? and version=?) or …`로 먼저 확인하고, `update terminal set status = case when id=? then ? … end, version = version + 1 where (id, version) in ((?,?), …)` **UPDATE 한 번**으로 보낸다. 하나라도 version이 다르면 `OptimisticLockError`.
- **FlushMode AUTO**: 트랜잭션 안에서 `create` 해 둔 단말기가 있는 채로 `findOne(Terminal, …)`을 하면 그 전에 flush가 일어난다. 행마다 `findOne` → `create`를 반복하면 SELECT뿐 아니라 INSERT도 행마다 따로 나간다(실험 0006 A의 N+1 쪽).
- `nativeUpdate`는 값이 같아 실제로 바뀌지 않아도 찾은 행 수(1)를 돌려준다(mysql2가 FOUND_ROWS 플래그를 쓴다).
- `em.find(…, { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'asc' } })` → `… order by id asc for update`. 트랜잭션 안에서만 된다.
- `em.transactional`을 이미 열린 트랜잭션 em에서 다시 부르면 savepoint(중첩 트랜잭션)가 된다(MikroORM 7 기본). `TransitionService.transition(cmd, tx)`가 그렇게 합류한다.
- **JSON_TABLE**(MySQL 8.4)은 동작한다. 단, JSON_TABLE 열의 collation은 **연결의 collation**(mysql2 기본 `utf8mb4_unicode_ci`)이고 테이블 열은 `utf8mb4_0900_ai_ci`라, 둘을 `=`로 비교하면 `ERROR 1267 Illegal mix of collations`가 난다. 열 정의에 `collate utf8mb4_0900_ai_ci`를 적으면 해결되고 `terminal_serial_no_unique` 인덱스를 eq_ref로 쓴다(EXPLAIN 확인). Task 7에서 직접 재현하고 troubleshooting/0008로 남긴다.
- **BullMQ `addBulk`도 jobId 중복을 무시한다**: 이미 있는 `outbox-1`을 다시 addBulk하면 반환 목록에는 나오지만 waiting 수는 늘지 않는다.
- `queue.removeJobScheduler(id)`는 scheduler와 다음 주기 job(delayed)을 지운다. 등록 때 바로 넣어진 첫 job(waiting)은 남아 한 번 실행되고, 그 뒤 새 job은 생기지 않는다.
- **exceljs 4.4.0**은 CommonJS다. `import ExcelJS from 'exceljs'` → `new ExcelJS.Workbook()`이 node ESM·tsc(nodenext)·vitest(swc)에서 모두 동작한다. `import { Workbook } from 'exceljs'`는 실행하면 `undefined`다. `workbook.xlsx.load(buffer)`의 타입은 exceljs 자체 `Buffer extends ArrayBuffer`라서 Node `Buffer`를 넘기면 `TS2345 … '"Uint8Array"' is not assignable to type '"ArrayBuffer"'`가 난다 → `buffer as unknown as ArrayBuffer`로 타입만 맞춘다(실행은 Node Buffer를 그대로 읽는다). zip이 아니면 `Can't find end of central directory`. 숫자 셀은 `cell.text`로 보이는 글자를 얻는다. `eachRow({ includeEmpty: false })`는 빈 행을 건너뛴다. `npm audit`: exceljs가 쓰는 uuid의 moderate 2건(Task 6 결정에 적는다).
- **Nest 12 `FileInterceptor`**: `@nestjs/platform-express`가 multer 2.4.0을 가지고 있다. `dest`·`storage`를 주지 않으면 메모리 저장소(`file.buffer`). `limits.fileSize`를 넘으면 `PayloadTooLargeException`(413). `@types/multer`가 없어 `Express.Multer.File` 대신 필요한 필드만 담은 타입을 직접 만든다. **multer 기본 `defParamCharset`은 latin1이라 한글 파일 이름이 `10ì ìê³ .xlsx`처럼 깨진다** → `defParamCharset: 'utf8'`.
- `@Res({ passthrough: true }) res`로 같은 핸들러에서 201(새로 처리)과 200(저장된 결과)을 고른다.
- ioredis `redis.set(key, token, 'PX', ms, 'NX')`는 잡으면 `'OK'`, 이미 있으면 `null`.
- supertest 요청은 `then`(또는 `await`)을 불러야 실제로 보내진다. 기다리지 않고 먼저 보내 두려면 `t.http().post(…).send(…).then((r) => r)`처럼 쓴다(사전 검증에서 `.then` 없이 변수에만 담았다가 요청이 안 나가 30초 타임아웃).
- 잠금 읽기(FOR UPDATE)로 기다렸다가 받은 행은 **최신 커밋 값**이다. 교체 출고 경합에서 진 쪽은 교체 단말기의 SHIPPED를 보고 `INVALID_TRANSITION`(422)으로 끝났다(version 충돌 409가 아니라).
- `db:migration:create`로 enum을 바꾸면 down()이 또 소문자로 생성된다(troubleshooting/0005와 같다). Task 1에서 손으로 고친다.
- `string | null` 유니온 속성도 데코레이터 메타데이터가 `Object`라 `@Property({ type: 'varchar', length, nullable: true })`처럼 type을 적는다(`Date | null`에 `type: 'datetime'`을 적는 것과 같은 이유).
- vitest `globalSetup`이 이번에도 partners를 4011에 띄운다. 새 세움전자 엔드포인트도 같은 서버에 있다.

## 범위 조정 (브리프와 다르게 한 것과 이유)

- **교체 단말기의 출처**: 브리프의 "SERVICE? ALLOCATION 또는 전용 출처" 중 기존 `ALLOCATION`(IN_STOCK → ALLOCATED), `SHIPMENT`(ALLOCATED → SHIPPED)을 그대로 쓴다. 교체도 배정·출고이고, 전용 출처를 만들면 같은 전이의 허용 출처가 늘어 규칙 표가 흐려진다. `SERVICE`는 고장 단말기 회수 요청(IN_SERVICE → RETURN_REQUESTED)과 설치 확인(DELIVERED → IN_SERVICE)에 쓴다. 그래서 **DELIVERED → IN_SERVICE도 `[MANUAL, SERVICE]`로** 정한다(브리프 표에 없던 줄).
- **입고와 발주의 연결**: 대조의 "스캔 입고 수"를 DB에서 세려고 `terminal.purchase_order_id`(nullable FK)를 둔다. 같은 트랜잭션에서 발주 행을 먼저 `FOR UPDATE`로 잠가 FK 검사 S 락과 엇갈리지 않게 한다(decisions/0021).
- **`ScanBatch.requestHash`와 422 `SCAN_ID_REUSED`**: 같은 scanId로 다른 내용을 보내면 저장된 (다른) 결과를 돌려주는 대신 거절한다(멱등 키의 일반적인 약속).
- **업무 오류 코드**: `BusinessError(status, code, message)` 하나를 더해 409·422와 code(SCAN_IN_PROGRESS, PO_CLOSED 등)를 응답에 싣는다.
- **세움전자 `error5xxRate`와 수량 상한 5000**: 공장 오류 → 502를 테스트하려고 더했다. 발주 API도 같은 상한.
- **마감한 사람(`closed_by`)**: 브리프 모델에 없지만 작업자 헤더를 받는 쓰기 API라 Task 7에서 컬럼을 더한다(마이그레이션 1개).
- **일괄 등록의 동시성**: 다른 요청과 시리얼이 겹쳐 unique 위반이 나면 트랜잭션 전체를 1회 다시 하고(그때는 ALREADY_EXISTS), INSERT는 시리얼 순서로 만든다(decisions/0019).
- **RETURN_IN 낙관적 락 충돌**: 행별이 아니라 박스 전체 409(브리프가 결정을 요구한 항목, decisions/0019).
- **엑셀 제한**: 2MB, 데이터 5000행, `.xlsx`만, 머리글은 이름으로 찾는다(decisions/0022).
- **addBulk**: Task 10에서 relay를 addBulk로 바꾸고, 비교용으로 `relay(limit, { enqueue: 'each' })`를 남긴다. 실험 0006의 숫자로 결정을 적는다(decisions/0024). 숫자가 예상과 반대면 기본값을 `each`로 되돌리고 그대로 기록한다.
- **실험 0007 잠금 순서 변형은 `faulty-first` 하나**: 공유 행이 교체 단말기 하나뿐이면 순서를 바꿔도 순환이 생기지 않는다는 예상이 있다. 사전 검증에서도 두 변형 모두 데드락 0이었다. 그 이유를 기록하는 것이 이 실험의 결론이다(재현되지 않으면 정직하게). `ReplacementService.replace(..., { lockOrder })` 옵션은 실험용이고 HTTP로는 열지 않는다.
- **Task 12 실서버 확인**에 partners(세움)와 워커·스케줄러를 함께 띄운다(브리프 요구).
- 하지 않는 것(스펙 9장): 교체 출고 경합의 고아 운송장 예약 단계, 명세에 섞인 다른 발주 시리얼 걸러내기, 공장 발주 멱등·고아 정리, 일괄 처리 비동기화, A/S 목록 API, 1213 HTTP 매핑, QUEUED 복구 sweep, Day 1 리뷰 Minor 2·4·5·6·7, MaxListenersExceededWarning(Day 2 Minor 6).

## 파일 구조

```
terminal-ops/
├─ apps/partners/
│  ├─ src/seum.ts                       (새) 세움전자 발주·납품 명세
│  ├─ src/state.ts, src/server.ts       seum 설정·상태·라우트
│  └─ test/seum.spec.ts                 (새)
└─ apps/api/
   ├─ package.json                      exceljs, scheduler:clear
   ├─ src/
   │  ├─ terminal/                      출처 5개, 규칙, transitionMany, bulk-rows(형식·결과 코드),
   │  │                                 bulk-registration.service(엔진), terminal-import.service(엑셀), POST /terminals/imports
   │  ├─ merchant/                      배정 출처 ALLOCATION, 배정 취소 API
   │  ├─ shipment/                      SUPERSEDED, recordShipment, 출처 SHIPMENT, ShipmentService export
   │  ├─ carrier-sync/                  IN_TRANSIT 운송장만 반영
   │  ├─ common/                        Retry-After 상한, BusinessError, retry-on-unique
   │  ├─ scheduler/                     job-schedulers(목록·삭제), clear-schedulers(스크립트)
   │  ├─ purchase-order/                (새) PurchaseOrder, SeumClient, 발주·대조·마감
   │  ├─ scan/                          (새) ScanBatch, ScanLock(Redis), 박스 스캔 API
   │  ├─ service/                       (새) ServiceTicket, 접수·원격 점검, 교체 출고·설치 확인
   │  ├─ outbox/outbox.service.ts       relay addBulk
   │  └─ migrations/                    enum ALTER, purchase_order, scan_batch + terminal FK, closed_by, service_ticket
   └─ test/
      ├─ helpers/query-log.ts           (새) SQL 세기
      ├─ helpers/scenario.ts, partners.ts  orderPurchase, transitionTo, prepareInService, deliveryNote
      ├─ unit/bulk-rows.spec.ts         (새)
      ├─ scheduler, purchase-order, bulk-registration, scan, terminal-import,
      │  reconciliation, service-ticket, replacement .e2e.spec.ts (새)
      └─ experiments/bulk-ops.spec.ts, replacement-race.spec.ts (새, EXPERIMENTS=1)
```

명령은 별도 표시가 없으면 `terminal-ops/apps/api`에서 실행한다. partners 명령은 `terminal-ops/apps/partners`에서. Docker 명령이 PATH에 없으면 `"/c/Program Files/Docker/Docker/resources/bin/docker.exe"`를 쓴다. MySQL·Redis 컨테이너가 떠 있어야 한다(`docker compose ps`).

기록 번호: decisions 0017~0024, troubleshooting 0008(Task 7 예약), experiments 0006·0007. devlog는 새 파일 `docs/devlog/2026-10-23.md`.

코드 블록에 "전체"라고 적힌 파일은 그 내용으로 파일 전체를 바꾼다(기존 내용에 이번 변경을 반영한 결과다).

---

### Task 1: Day 2 이월 — 전용 출처, 배정 취소, SUPERSEDED 운송장, 작은 이월 4건 (F2, F3)

**Files:**
- Modify: `apps/api/src/terminal/terminal-status.ts`, `apps/api/src/terminal/transition-rules.ts`
- Modify: `apps/api/src/merchant/merchant.service.ts`, `apps/api/src/merchant/merchant.controller.ts`
- Create: `apps/api/src/merchant/dto/cancel-allocation.dto.ts`
- Modify: `apps/api/src/shipment/shipment.entities.ts`, `apps/api/src/shipment/shipment.service.ts`, `apps/api/src/carrier-sync/carrier-sync.service.ts`
- Modify: `apps/api/src/common/partner-http.ts`
- Create: `apps/api/src/scheduler/job-schedulers.ts`, `apps/api/src/scheduler/clear-schedulers.ts`; Modify: `apps/api/src/scheduler/scheduler.service.ts`, `apps/api/package.json`
- Modify: `apps/api/src/migrations/Migration20261022053251.ts`(주석), Create: `apps/api/src/migrations/Migration<시각>.ts`(생성 명령)
- Test: `apps/api/test/unit/transition-rules.spec.ts`, `apps/api/test/unit/partner-http.spec.ts`, `apps/api/test/transition.e2e.spec.ts`, `apps/api/test/terminal-concurrency.e2e.spec.ts`, `apps/api/test/merchant.e2e.spec.ts`, `apps/api/test/shipment.e2e.spec.ts`, `apps/api/test/carrier-sync.e2e.spec.ts`, `apps/api/test/scheduler.e2e.spec.ts`(새), `apps/api/test/experiments/two-workers.spec.ts`
- Record: `docs/devlog/2026-10-23.md`(새), `docs/decisions/0017-전이-출처-확장과-배정-출고-전용-출처.md`, `docs/decisions/0018-재출고-시-이전-운송장-SUPERSEDED.md`, `docs/decisions/0014-…`·`0015-…`(갱신 한 줄씩), `docs/study/backlog.md`

바꾸는 것 요약:
- 출처 `ALLOCATION`, `SHIPMENT`, `SCAN`, `IMPORT`, `SERVICE` 추가. IN_STOCK ↔ ALLOCATED는 `ALLOCATION`만, ALLOCATED → SHIPPED는 `SHIPMENT`만, DELIVERED → IN_SERVICE와 IN_SERVICE → RETURN_REQUESTED는 `MANUAL, SERVICE`, RETURNING → RETURNED는 `MANUAL, SCAN`. 배정 API는 `ALLOCATION`, 출고 API는 `SHIPMENT` 출처로 부른다. 일반 전이 API(MANUAL)로는 배정·배정 취소·출고가 422가 된다.
- 배정 취소 `POST /terminals/:serialNo/allocation-cancellations { reason, expectedVersion }` → ALLOCATED → IN_STOCK + 가맹점 비우기를 `mutate`로 UPDATE 한 번.
- 같은 단말기를 다시 출고하면 이전 `IN_TRANSIT` 운송장을 `SUPERSEDED`로. 배송 완료 반영은 운송장이 `IN_TRANSIT`일 때만(Day 2 리뷰 Minor 1).
- 작은 이월: Retry-After 60초 상한(Minor 4), `npm run scheduler:clear`(Minor 2), two-workers "worker ready" 누적 검사(Minor 5), `Migration20261022053251.down()` 주의 주석(Minor 7).
- 기존 테스트 중 일반 API로 ALLOCATED를 만들던 곳(`terminal-concurrency` A·B)을 배정 API·ALLOCATION 출처로 바꾼다. `transition.e2e`의 `to: 'ALLOCATED'` 요청들은 그대로 둔다(version 409·400·404가 규칙 검사보다 먼저라 결과가 같다).

- [ ] **Step 1: 실패하는 테스트 작성 (단위 + e2e)**

`apps/api/test/unit/transition-rules.spec.ts` 전체:
```ts
import { describe, expect, it } from 'vitest';
import { checkTransition } from '../../src/terminal/transition-rules.js';
import { TerminalStatus as S, TransitionSource as Src } from '../../src/terminal/terminal-status.js';

const normal = { requiresReinspection: false };
const strict = { requiresReinspection: true };

describe('checkTransition', () => {
  it.each([
    [S.INSPECTED, S.IN_STOCK],
    [S.SHIPPED, S.DELIVERED],
    [S.DELIVERED, S.IN_SERVICE],
    [S.IN_SERVICE, S.RETURN_REQUESTED],
    [S.RETURN_REQUESTED, S.RETURNING],
    [S.RETURNING, S.RETURNED],
    [S.RETURNED, S.IN_STOCK],
    [S.DEFECTIVE, S.DISPOSED],
  ])('수동 전이 %s → %s 허용', (from, to) => {
    expect(checkTransition(from, to, Src.MANUAL, normal)).toEqual({ ok: true });
  });

  it('정의되지 않은 전이는 거절하고 이유를 준다', () => {
    const r = checkTransition(S.RECEIVED, S.SHIPPED, Src.MANUAL, normal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('RECEIVED → SHIPPED');
  });

  it('같은 상태로의 전이는 거절', () => {
    expect(checkTransition(S.IN_STOCK, S.IN_STOCK, Src.MANUAL, normal).ok).toBe(false);
  });

  it.each([
    [S.RECEIVED, S.INSPECTED],
    [S.RECEIVED, S.DEFECTIVE],
    [S.RETURNED, S.INSPECTED],
    [S.RETURNED, S.DEFECTIVE],
  ])('%s → %s 는 검수로만 가능', (from, to) => {
    expect(checkTransition(from, to, Src.MANUAL, normal).ok).toBe(false);
    expect(checkTransition(from, to, Src.INSPECTION, normal)).toEqual({ ok: true });
  });

  it('검수는 검수 전용 전이 외에는 쓸 수 없다', () => {
    expect(checkTransition(S.INSPECTED, S.IN_STOCK, Src.INSPECTION, normal).ok).toBe(false);
  });

  it('재검수 필수 모델은 회수 후 바로 재고로 못 간다', () => {
    const r = checkTransition(S.RETURNED, S.IN_STOCK, Src.MANUAL, strict);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('재검수');
  });

  // 전용 출처 표(decisions/0007, 0017): 표에 적은 출처만 허용하고 나머지 출처는 모두 거절한다.
  it.each([
    [S.IN_STOCK, S.ALLOCATED, [Src.ALLOCATION]],
    [S.ALLOCATED, S.IN_STOCK, [Src.ALLOCATION]],
    [S.ALLOCATED, S.SHIPPED, [Src.SHIPMENT]],
    [S.SHIPPED, S.DELIVERED, [Src.MANUAL, Src.BATCH]],
    [S.DELIVERED, S.IN_SERVICE, [Src.MANUAL, Src.SERVICE]],
    [S.IN_SERVICE, S.RETURN_REQUESTED, [Src.MANUAL, Src.SERVICE]],
    [S.RETURNING, S.RETURNED, [Src.MANUAL, Src.SCAN]],
  ])('%s → %s 는 %j 출처만 허용', (from, to, allowed) => {
    for (const source of Object.values(Src)) {
      expect(checkTransition(from, to, source, normal).ok, source).toBe(allowed.includes(source));
    }
  });

  it('일반 전이 API(MANUAL)로는 배정·배정 취소·출고를 할 수 없다', () => {
    for (const [from, to] of [
      [S.IN_STOCK, S.ALLOCATED],
      [S.ALLOCATED, S.IN_STOCK],
      [S.ALLOCATED, S.SHIPPED],
    ] as const) {
      const r = checkTransition(from, to, Src.MANUAL, normal);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('경로로만');
    }
  });

  it.each([Src.BATCH, Src.SCAN, Src.IMPORT, Src.SERVICE, Src.ALLOCATION, Src.SHIPMENT])(
    '%s 는 only가 없는 일반 전이를 할 수 없다(기본 허용은 MANUAL)',
    (source) => {
      for (const [from, to] of [
        [S.INSPECTED, S.IN_STOCK],
        [S.RETURN_REQUESTED, S.RETURNING],
        [S.RETURNED, S.IN_STOCK],
        [S.DEFECTIVE, S.DISPOSED],
      ] as const) {
        const r = checkTransition(from, to, source, normal);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain('MANUAL 경로로만');
      }
    },
  );

  it('검수 전용 전이는 배치로도 안 된다', () => {
    expect(checkTransition(S.RECEIVED, S.INSPECTED, Src.BATCH, normal).ok).toBe(false);
  });

  it('폐기는 끝 상태다', () => {
    for (const to of Object.values(S)) {
      expect(checkTransition(S.DISPOSED, to, Src.MANUAL, normal).ok).toBe(false);
    }
  });
});
```

`apps/api/test/unit/partner-http.spec.ts` 전체(`parseRetryAfter` describe 추가):
```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PartnerTransientError } from '../../src/common/partner-errors.js';
import { MAX_RETRY_AFTER_MS, parseRetryAfter, partnerFetch } from '../../src/common/partner-http.js';

describe('partnerFetch 본문 읽기', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    // 헤더(200)만 보내고 본문은 보내지 않은 채 멈추는 서버
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.flushHeaders();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it('헤더 뒤 본문이 멈춰 타임아웃이 나면 일시 오류', async () => {
    const error = await partnerFetch('테스트업체', url, {}, 200).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartnerTransientError);
    expect((error as Error).message).toContain('TimeoutError');
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-23T00:00:00Z');

  it('초 단위와 HTTP 날짜를 ms로 바꾼다', () => {
    expect(parseRetryAfter('2', now)).toBe(2000);
    expect(parseRetryAfter('Fri, 23 Oct 2026 00:00:05 GMT', now)).toBe(5000);
  });

  it('없거나 못 읽으면 1초, 음수는 0', () => {
    expect(parseRetryAfter(null, now)).toBe(1000);
    expect(parseRetryAfter('soon', now)).toBe(1000);
    expect(parseRetryAfter('-3', now)).toBe(0);
  });

  it('60초를 넘으면 60초로 자른다', () => {
    expect(parseRetryAfter('3600', now)).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter('Sat, 24 Oct 2026 00:00:00 GMT', now)).toBe(60_000);
  });
});
```

`apps/api/test/transition.e2e.spec.ts` 전체('일반 전이 API로는 배정·출고를 할 수 없다' 추가):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'lee' };

describe('상태 전이 API (F2)', () => {
  let t: TestApp;

  /** 테스트 준비용: 검수 기능 없이 상태를 직접 맞춘다. */
  async function forceStatus(serialNo: string, status: TerminalStatus) {
    const em = t.orm.em.fork();
    const terminal = await em.findOneOrFail(Terminal, { serialNo });
    terminal.status = status;
    await em.flush();
    return terminal.version;
  }

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await t.http().post('/terminals').set(OP).send({ serialNo: 'TR-0001', modelCode: 'SN-100' });
    await t.http().post('/terminals').set(OP).send({ serialNo: 'TR-0002', modelCode: 'SN-200' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('허용된 전이는 200, version이 오르고 이력이 남는다', async () => {
    const version = await forceStatus('TR-0001', TerminalStatus.INSPECTED);
    const res = await t
      .http()
      .post('/terminals/TR-0001/transitions')
      .set(OP)
      .send({ to: 'IN_STOCK', reason: '검수 완료분 재고 편입', expectedVersion: version });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'IN_STOCK', version: version + 1 });

    const history = await t.http().get('/terminals/TR-0001/history');
    expect(history.body.at(-1)).toMatchObject({
      fromStatus: 'INSPECTED',
      toStatus: 'IN_STOCK',
      source: 'MANUAL',
      actor: 'lee',
      reason: '검수 완료분 재고 편입',
    });
  });

  it('expectedVersion이 현재와 다르면 409 VERSION_CONFLICT, 상태는 그대로', async () => {
    const res = await t
      .http()
      .post('/terminals/TR-0001/transitions')
      .set(OP)
      .send({ to: 'ALLOCATED', reason: '배정', expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('VERSION_CONFLICT');
    expect((await t.http().get('/terminals/TR-0001')).body.status).toBe('IN_STOCK');
  });

  it('일반 전이 API로는 배정·출고를 할 수 없다(배정·출고 API 전용 출처, decisions/0017)', async () => {
    const current = (await t.http().get('/terminals/TR-0001')).body.version;
    const allocate = await t
      .http()
      .post('/terminals/TR-0001/transitions')
      .set(OP)
      .send({ to: 'ALLOCATED', reason: '가맹점 없이 배정', expectedVersion: current });
    expect(allocate.status).toBe(422);
    expect(allocate.body.message).toContain('ALLOCATION 경로로만');

    const version = await forceStatus('TR-0001', TerminalStatus.ALLOCATED);
    const ship = await t
      .http()
      .post('/terminals/TR-0001/transitions')
      .set(OP)
      .send({ to: 'SHIPPED', reason: '운송장 없이 출고', expectedVersion: version });
    expect(ship.status).toBe(422);
    expect(ship.body.message).toContain('SHIPMENT 경로로만');
    await forceStatus('TR-0001', TerminalStatus.IN_STOCK);
  });

  it('허용되지 않은 전이는 422 INVALID_TRANSITION, 이력이 늘지 않는다', async () => {
    const before = (await t.http().get('/terminals/TR-0001/history')).body.length;
    const current = (await t.http().get('/terminals/TR-0001')).body.version;
    const res = await t
      .http()
      .post('/terminals/TR-0001/transitions')
      .set(OP)
      .send({ to: 'DISPOSED', reason: '폐기', expectedVersion: current });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_TRANSITION');
    expect((await t.http().get('/terminals/TR-0001/history')).body.length).toBe(before);
  });

  it('검수 전용 전이를 수동으로 하면 422', async () => {
    const current = (await t.http().get('/terminals/TR-0002')).body.version;
    const res = await t
      .http()
      .post('/terminals/TR-0002/transitions')
      .set(OP)
      .send({ to: 'INSPECTED', reason: '수동 합격', expectedVersion: current });
    expect(res.status).toBe(422);
  });

  it('재검수 필수 모델(SN-200)은 회수 후 바로 재고로 못 간다', async () => {
    const version = await forceStatus('TR-0002', TerminalStatus.RETURNED);
    const res = await t
      .http()
      .post('/terminals/TR-0002/transitions')
      .set(OP)
      .send({ to: 'IN_STOCK', reason: '재고 복귀', expectedVersion: version });
    expect(res.status).toBe(422);
    expect(res.body.message).toContain('재검수');
  });

  it('expectedVersion·reason이 없으면 400', async () => {
    const res = await t.http().post('/terminals/TR-0001/transitions').set(OP).send({ to: 'ALLOCATED' });
    expect(res.status).toBe(400);
  });

  it('reason이 공백뿐이면 400', async () => {
    const current = (await t.http().get('/terminals/TR-0001')).body.version;
    const res = await t
      .http()
      .post('/terminals/TR-0001/transitions')
      .set(OP)
      .send({ to: 'ALLOCATED', reason: '   ', expectedVersion: current });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.message)).toContain('공백');
  });

  it('없는 단말기는 404', async () => {
    const res = await t
      .http()
      .post('/terminals/NOPE-1/transitions')
      .set(OP)
      .send({ to: 'ALLOCATED', reason: 'x', expectedVersion: 1 });
    expect(res.status).toBe(404);
  });
});
```

`apps/api/test/terminal-concurrency.e2e.spec.ts` 전체(A는 배정 API로, B는 ALLOCATION 출처로):
```ts
import { OptimisticLockError } from '@mikro-orm/mysql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../src/common/domain-errors.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus, TransitionSource } from '../src/terminal/terminal-status.js';
import { TransitionService } from '../src/terminal/transition.service.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const N = 20;
const OP = { 'X-Operator': 'park' };

describe(`동시 수정 실험: 같은 단말기에 전이 ${N}건 동시 요청`, () => {
  let t: TestApp;

  async function setStatus(serialNo: string, status: TerminalStatus) {
    const em = t.orm.em.fork();
    const terminal = await em.findOneOrFail(Terminal, { serialNo });
    terminal.status = status;
    await em.flush();
    return terminal.version;
  }

  async function countHistory(serialNo: string, to: TerminalStatus) {
    return t.orm.em.fork().count(TerminalStatusHistory, { terminal: { serialNo }, toStatus: to });
  }

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await t.http().post('/terminals').set(OP).send({ serialNo: 'CC-0001', modelCode: 'SN-100' });
    await t.http().post('/terminals').set(OP).send({ serialNo: 'CC-0002', modelCode: 'SN-100' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('A. 배정 API + 같은 expectedVersion: 1건만 201, 나머지는 409', async () => {
    const version = await setStatus('CC-0001', TerminalStatus.IN_STOCK);
    const started = performance.now();
    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        t
          .http()
          .post('/terminals/CC-0001/allocations')
          .set(OP)
          .send({ merchantCode: i % 2 ? 'YEOKSAM-CAFE' : 'GANGNAM-KIMBAP', expectedVersion: version }),
      ),
    );
    const elapsed = Math.round(performance.now() - started);
    const byStatus = responses.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
    console.log(`[실험 A] N=${N} 결과=${JSON.stringify(byStatus)} 소요=${elapsed}ms`);

    expect(byStatus[201]).toBe(1);
    expect(byStatus[409]).toBe(N - 1);
    expect(await countHistory('CC-0001', TerminalStatus.ALLOCATED)).toBe(1);
  });

  it('B. 시스템 작업(expectedVersion 없음): 1건만 성공, 나머지는 충돌 또는 규칙 위반', async () => {
    await setStatus('CC-0002', TerminalStatus.ALLOCATED);
    const service = t.app.get(TransitionService);
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        service.transition(
          {
            serialNo: 'CC-0002',
            to: TerminalStatus.IN_STOCK,
            reason: `배정 취소 ${i}`,
            actor: 'system:experiment',
            source: TransitionSource.ALLOCATION,
          },
          t.orm.em.fork(),
        ),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const reasons = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason instanceof OptimisticLockError ? 'OptimisticLock' : r.reason instanceof InvalidTransitionError ? 'InvalidTransition' : String(r.reason)));
    const tally = reasons.reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {});
    console.log(`[실험 B] N=${N} 성공=${ok} 실패=${JSON.stringify(tally)}`);

    expect(ok).toBe(1);
    expect(Object.keys(tally).every((k) => k === 'OptimisticLock' || k === 'InvalidTransition')).toBe(true);
    expect(await countHistory('CC-0002', TerminalStatus.IN_STOCK)).toBe(1);
  });
});
```

`apps/api/test/merchant.e2e.spec.ts` 전체(배정 이력 출처, 배정 취소 2건):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { registerInStock, SCENARIO_OP } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'han' };

describe('가맹점 배정 (F2)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await registerInStock(t, 'AL-0001');
    await registerInStock(t, 'AL-0002');
    await t.http().post('/terminals').set(SCENARIO_OP).send({ serialNo: 'AL-0003', modelCode: 'SN-100' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('가맹점 3곳이 시드돼 있다', async () => {
    const res = await t.http().get('/merchants');
    expect(res.body.map((m: { name: string }) => m.name)).toEqual(['강남김밥', '판교분식', '역삼카페']);
  });

  it('배정하면 ALLOCATED + 가맹점이 한 번의 UPDATE로 바뀐다(version +1)', async () => {
    const before = (await t.http().get('/terminals/AL-0001')).body;
    expect(before.merchantCode).toBeNull();
    const res = await t
      .http()
      .post('/terminals/AL-0001/allocations')
      .set(OP)
      .send({ merchantCode: 'YEOKSAM-CAFE', expectedVersion: before.version });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'ALLOCATED', merchantCode: 'YEOKSAM-CAFE', version: before.version + 1 });

    const saved = await t.orm.em.fork().findOneOrFail(Terminal, { serialNo: 'AL-0001' }, { populate: ['merchant'] });
    expect(saved.merchant?.name).toBe('역삼카페');
    const history = await t.http().get('/terminals/AL-0001/history');
    expect(history.body.at(-1)).toMatchObject({
      toStatus: 'ALLOCATED',
      source: 'ALLOCATION',
      actor: 'han',
      reason: '가맹점 배정: 역삼카페(YEOKSAM-CAFE)',
    });
  });

  it('배정 취소: IN_STOCK으로 돌아가고 가맹점이 비워진다(UPDATE 한 번, version +1)', async () => {
    const before = (await t.http().get('/terminals/AL-0001')).body;
    expect(before.merchantCode).toBe('YEOKSAM-CAFE');
    const res = await t
      .http()
      .post('/terminals/AL-0001/allocation-cancellations')
      .set(OP)
      .send({ reason: '가맹점 개업 연기', expectedVersion: before.version });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'IN_STOCK', merchantCode: null, version: before.version + 1 });

    const saved = await t.orm.em.fork().findOneOrFail(Terminal, { serialNo: 'AL-0001' });
    expect(saved.merchant).toBeNull();
    const history = await t.http().get('/terminals/AL-0001/history');
    expect(history.body.at(-1)).toMatchObject({
      fromStatus: 'ALLOCATED',
      toStatus: 'IN_STOCK',
      source: 'ALLOCATION',
      actor: 'han',
      reason: '배정 취소: 가맹점 개업 연기',
    });
  });

  it('배정 취소는 ALLOCATED가 아니면 422, version이 다르면 409, reason이 없으면 400', async () => {
    const version = (await t.http().get('/terminals/AL-0002')).body.version;
    const notAllocated = await t.http().post('/terminals/AL-0002/allocation-cancellations').set(OP).send({ reason: '취소', expectedVersion: version });
    expect(notAllocated.status).toBe(422);
    const stale = await t.http().post('/terminals/AL-0002/allocation-cancellations').set(OP).send({ reason: '취소', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    const noReason = await t.http().post('/terminals/AL-0002/allocation-cancellations').set(OP).send({ expectedVersion: version });
    expect(noReason.status).toBe(400);
  });

  it('없는 가맹점이면 404, 상태 그대로', async () => {
    const version = (await t.http().get('/terminals/AL-0002')).body.version;
    const res = await t.http().post('/terminals/AL-0002/allocations').set(OP).send({ merchantCode: 'NOPE', expectedVersion: version });
    expect(res.status).toBe(404);
    expect((await t.http().get('/terminals/AL-0002')).body).toMatchObject({ status: 'IN_STOCK', merchantCode: null });
  });

  it('version이 다르면 409, 가맹점도 안 바뀐다', async () => {
    const res = await t.http().post('/terminals/AL-0002/allocations').set(OP).send({ merchantCode: 'YEOKSAM-CAFE', expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect((await t.http().get('/terminals/AL-0002')).body.merchantCode).toBeNull();
  });

  it('재고가 아닌 단말기는 422, 가맹점도 안 바뀐다', async () => {
    const version = (await t.http().get('/terminals/AL-0003')).body.version;
    const res = await t.http().post('/terminals/AL-0003/allocations').set(OP).send({ merchantCode: 'YEOKSAM-CAFE', expectedVersion: version });
    expect(res.status).toBe(422);
    expect((await t.http().get('/terminals/AL-0003')).body.merchantCode).toBeNull();
  });

  it('merchantCode·expectedVersion이 없으면 400', async () => {
    expect((await t.http().post('/terminals/AL-0002/allocations').set(OP).send({})).status).toBe(400);
  });
});
```

`apps/api/test/shipment.e2e.spec.ts` 전체(출고 이력 출처 SHIPMENT, 재출고 SUPERSEDED):
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Shipment, ShipmentStatus } from '../src/shipment/shipment.entities.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { partners } from './helpers/partners.js';
import { allocateTo, registerInStock } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'yoon' };

describe('출고 (F3)', () => {
  let t: TestApp;

  async function versionOf(serialNo: string): Promise<number> {
    return (await t.http().get(`/terminals/${serialNo}`)).body.version;
  }
  async function waybillCalls(): Promise<number> {
    const stats = await partners.stats();
    return (stats.calls['bungae.waybill'] ?? 0) + (stats.calls['neurimbo.invoice'] ?? 0);
  }

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    for (const serialNo of ['SH-0001', 'SH-0002', 'SH-0004', 'SH-0005']) {
      await registerInStock(t, serialNo);
      await allocateTo(t, serialNo);
    }
    await registerInStock(t, 'SH-0003'); // 배정하지 않은 재고
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('번개택배로 출고하면 운송장이 생기고 단말기는 SHIPPED', async () => {
    // 버전 조회를 요청 체인 안에서 await하면 supertest가 같은 서버를 두 번 listen/close해서 깨진다. 먼저 구한다.
    const version = await versionOf('SH-0001');
    const res = await t.http().post('/shipments').set(OP).send({ serialNo: 'SH-0001', carrier: 'BUNGAE', expectedVersion: version });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ serialNo: 'SH-0001', carrier: 'BUNGAE', status: 'IN_TRANSIT', terminal: { status: 'SHIPPED' } });
    expect(res.body.trackingNo).toMatch(/^BG\d+$/);

    const history = await t.http().get('/terminals/SH-0001/history');
    expect(history.body.at(-1)).toMatchObject({
      toStatus: 'SHIPPED',
      source: 'SHIPMENT',
      actor: 'yoon',
      reason: `출고: BUNGAE ${res.body.trackingNo}`,
    });
    expect(await waybillCalls()).toBe(1);

    const detail = await t.http().get(`/shipments/${res.body.id}`);
    expect(detail.body).toMatchObject({ id: res.body.id, trackingNo: res.body.trackingNo, status: 'IN_TRANSIT', events: [] });
  });

  it('느림보물류로 출고하면 NR 송장', async () => {
    // 버전 조회를 요청 체인 안에서 await하면 supertest가 같은 서버를 두 번 listen/close해서 깨진다. 먼저 구한다.
    const version = await versionOf('SH-0002');
    const res = await t.http().post('/shipments').set(OP).send({ serialNo: 'SH-0002', carrier: 'NEURIMBO', expectedVersion: version });
    expect(res.status).toBe(201);
    expect(res.body.trackingNo).toMatch(/^NR\d+$/);
  });

  it('배정되지 않은 단말기는 422이고 택배사를 부르지 않는다', async () => {
    // 버전 조회를 요청 체인 안에서 await하면 supertest가 같은 서버를 두 번 listen/close해서 깨진다. 먼저 구한다.
    const version = await versionOf('SH-0003');
    const res = await t.http().post('/shipments').set(OP).send({ serialNo: 'SH-0003', carrier: 'BUNGAE', expectedVersion: version });
    expect(res.status).toBe(422);
    expect(await waybillCalls()).toBe(0);
  });

  it('version이 다르면 409이고 택배사를 부르지 않는다', async () => {
    const res = await t.http().post('/shipments').set(OP).send({ serialNo: 'SH-0004', carrier: 'BUNGAE', expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect(await waybillCalls()).toBe(0);
  });

  it('택배사가 503이면 502 PARTNER_ERROR, 단말기는 ALLOCATED 그대로', async () => {
    await partners.configure({ neurimbo: { error5xxRate: 1 } });
    // 버전 조회를 요청 체인 안에서 await하면 supertest가 같은 서버를 두 번 listen/close해서 깨진다. 먼저 구한다.
    const version = await versionOf('SH-0004');
    const res = await t.http().post('/shipments').set(OP).send({ serialNo: 'SH-0004', carrier: 'NEURIMBO', expectedVersion: version });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'PARTNER_ERROR', reason: 'PartnerTransientError' });
    expect((await t.http().get('/terminals/SH-0004')).body.status).toBe('ALLOCATED');
  });

  it('같은 단말기 동시 출고 2건: 1건만 성공, 운송장 저장 1건(남는 운송장은 고아로 센다)', async () => {
    const version = await versionOf('SH-0005');
    const responses = await Promise.all(
      [0, 1].map(() => t.http().post('/shipments').set(OP).send({ serialNo: 'SH-0005', carrier: 'BUNGAE', expectedVersion: version })),
    );
    const statuses = responses.map((r) => r.status).sort();
    const em = t.orm.em.fork();
    const saved = await em.count(Shipment, { terminal: { serialNo: 'SH-0005' } });
    const shippedHistory = await em.count(TerminalStatusHistory, { terminal: { serialNo: 'SH-0005' }, toStatus: TerminalStatus.SHIPPED });
    const calls = await waybillCalls();
    console.log(`[동시 출고] 응답=${JSON.stringify(statuses)} 운송장발급=${calls} 저장=${saved} 고아=${calls - saved}`);

    expect(statuses).toEqual([201, 409]);
    expect(saved).toBe(1);
    expect(shippedHistory).toBe(1);
    const shipment = await em.findOneOrFail(Shipment, { terminal: { serialNo: 'SH-0005' } });
    expect(shipment.status).toBe(ShipmentStatus.IN_TRANSIT);
  });

  it('같은 단말기를 다시 출고하면 이전 배송 중 운송장은 SUPERSEDED (decisions/0018)', async () => {
    // SH-0001은 첫 테스트에서 번개로 출고됐다(운송장 IN_TRANSIT). 회수·재입고를 거쳐 다시 배정된 상황을 직접 만든다.
    const em = t.orm.em.fork();
    const terminal = await em.findOneOrFail(Terminal, { serialNo: 'SH-0001' });
    terminal.status = TerminalStatus.IN_STOCK;
    terminal.merchant = null;
    await em.flush();
    await allocateTo(t, 'SH-0001', 'PANGYO-BUNSIK');
    const old = await em.fork().findOneOrFail(Shipment, { terminal: { serialNo: 'SH-0001' } });
    expect(old.status).toBe(ShipmentStatus.IN_TRANSIT);

    const version = await versionOf('SH-0001');
    const res = await t.http().post('/shipments').set(OP).send({ serialNo: 'SH-0001', carrier: 'NEURIMBO', expectedVersion: version });
    expect(res.status).toBe(201);
    const all = await em.fork().find(Shipment, { terminal: { serialNo: 'SH-0001' } }, { orderBy: { id: 'asc' } });
    expect(all.map((s) => [s.id, s.status])).toEqual([
      [old.id, ShipmentStatus.SUPERSEDED],
      [res.body.id, ShipmentStatus.IN_TRANSIT],
    ]);
  });

  it('없는 출고 id는 404, 숫자가 아니면 400', async () => {
    expect((await t.http().get('/shipments/9999')).status).toBe(404);
    expect((await t.http().get('/shipments/abc')).status).toBe(400);
  });
});
```

`apps/api/test/carrier-sync.e2e.spec.ts` 전체(마지막 테스트 추가: 반영 직전에 SUPERSEDED가 되면 NOOP):
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CarrierSyncService, SYNC_ACTOR } from '../src/carrier-sync/carrier-sync.service.js';
import { CarrierAdapters } from '../src/carrier/carrier.adapters.js';
import { Carrier } from '../src/carrier/carrier.types.js';
import { CarrierEvent, Shipment, ShipmentStatus, SyncRun } from '../src/shipment/shipment.entities.js';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { partners } from './helpers/partners.js';
import { resetQueues, waitFor, waitForQueuesIdle } from './helpers/queues.js';
import { prepareShipped } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('택배 추적 자동 수집 (F3)', () => {
  let t: TestApp;
  let sync: CarrierSyncService;

  const em = () => t.orm.em.fork();
  const shipment = (id: number) => em().findOneOrFail(Shipment, id, { populate: ['terminal'] });
  const runs = (id: number) => em().find(SyncRun, { shipment: id }, { orderBy: { id: 'asc' } });
  const deliveredHistory = (serialNo: string) =>
    em().find(TerminalStatusHistory, { terminal: { serialNo }, toStatus: TerminalStatus.DELIVERED });

  /** sweep 한 번 → 큐가 빌 때까지 대기 */
  async function sweepOnce() {
    await sync.sweep();
    await waitForQueuesIdle(t.app);
  }

  beforeAll(async () => {
    t = await createTestApp({ workers: true });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    sync = t.app.get(CarrierSyncService);
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it('번개: sweep 네 번에 이벤트 4개, 단말기는 배치 경로로 DELIVERED', async () => {
    const { shipmentId } = await prepareShipped(t, 'CS-0001', 'BUNGAE');
    for (let i = 0; i < 3; i++) await sweepOnce();
    expect((await shipment(shipmentId)).status).toBe(ShipmentStatus.IN_TRANSIT);
    expect(await em().count(CarrierEvent, { shipment: shipmentId })).toBe(3);

    await sweepOnce();
    const s = await shipment(shipmentId);
    expect(s.status).toBe(ShipmentStatus.DELIVERED);
    expect(s.deliveredAt).toBeInstanceOf(Date);
    expect(s.terminal.status).toBe(TerminalStatus.DELIVERED);
    expect(await em().count(CarrierEvent, { shipment: shipmentId })).toBe(4);

    const history = await deliveredHistory('CS-0001');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: 'SHIPPED', source: 'BATCH', actor: SYNC_ACTOR });

    const r = await runs(shipmentId);
    expect(r.map((x) => x.outcome)).toEqual(['OK', 'OK', 'OK', 'DELIVERED']);
    expect(r.map((x) => x.inserted)).toEqual([1, 1, 1, 1]);
    expect(r.map((x) => x.duplicated)).toEqual([0, 1, 2, 3]); // 이미 저장한 이벤트는 다시 넣지 않는다
  });

  it('완료된 운송장은 sweep 대상이 아니다', async () => {
    const before = (await partners.stats()).calls['bungae.track'] ?? 0;
    await sweepOnce();
    expect((await partners.stats()).calls['bungae.track'] ?? 0).toBe(before);
  });

  it('번개 중복 이벤트(duplicateRate=1): 저장은 한 번, 중복으로 센다', async () => {
    await partners.configure({ bungae: { duplicateRate: 1, advancePerPoll: 4 } });
    const { shipmentId } = await prepareShipped(t, 'CS-0002', 'BUNGAE');
    await sweepOnce();
    expect(await em().count(CarrierEvent, { shipment: shipmentId })).toBe(4);
    const [run] = await runs(shipmentId);
    expect(run).toMatchObject({ outcome: 'DELIVERED', fetched: 8, inserted: 4, duplicated: 4 });
    expect(await deliveredHistory('CS-0002')).toHaveLength(1);
  });

  it('느림보: 순서가 섞인 XML도 공통 코드로 저장하고 DELIVERED', async () => {
    await partners.configure({ neurimbo: { shuffle: true, advancePerPoll: 4 } });
    const { shipmentId } = await prepareShipped(t, 'CS-0003', 'NEURIMBO');
    await sweepOnce();
    const events = await em().find(CarrierEvent, { shipment: shipmentId }, { orderBy: { occurredAt: 'asc' } });
    expect(events.map((e) => e.code)).toEqual(['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED']);
    expect((await shipment(shipmentId)).terminal.status).toBe(TerminalStatus.DELIVERED);
  });

  it('운영자가 먼저 수동으로 DELIVERED로 바꿨으면 단말기는 그대로 두고 운송장만 완료(no-op)', async () => {
    await partners.configure({ bungae: { advancePerPoll: 4 } });
    const { shipmentId } = await prepareShipped(t, 'CS-0004', 'BUNGAE');
    const version = (await t.http().get('/terminals/CS-0004')).body.version;
    await t
      .http()
      .post('/terminals/CS-0004/transitions')
      .set({ 'X-Operator': 'kang' })
      .send({ to: 'DELIVERED', reason: '가맹점 수령 확인 전화', expectedVersion: version });

    await sweepOnce();
    expect((await shipment(shipmentId)).status).toBe(ShipmentStatus.DELIVERED);
    const history = await deliveredHistory('CS-0004');
    expect(history.map((h) => h.source)).toEqual(['MANUAL']);
    const [run] = await runs(shipmentId);
    expect(run).toMatchObject({ outcome: 'NOOP', detail: '단말기 상태가 DELIVERED라 전이하지 않음' });
  });

  it('429면 Retry-After만큼 기다렸다가 재시도해 성공', async () => {
    const { shipmentId } = await prepareShipped(t, 'CS-0005', 'BUNGAE');
    await partners.configure({ bungae: { force429Rate: 1, retryAfterSec: 1 } });
    await sync.sweep();
    await waitFor(async () => (await runs(shipmentId)).length >= 1, { message: '첫 시도' });
    await partners.configure({ bungae: { force429Rate: 0 } });
    await waitForQueuesIdle(t.app);

    const r = await runs(shipmentId);
    expect(r.map((x) => [x.attempt, x.outcome])).toEqual([
      [1, 'ERROR'],
      [2, 'OK'],
    ]);
    expect(r[0].detail).toContain('PartnerRateLimitedError');
    // 두 번째 시도는 Retry-After(1초) 이후에 시작했다.
    expect(r[1].startedAt.getTime() - r[0].startedAt.getTime()).toBeGreaterThanOrEqual(900);
  });

  it('없는 운송장(404)은 재시도하지 않는다', async () => {
    const { shipmentId } = await prepareShipped(t, 'CS-0006', 'BUNGAE');
    await partners.reset(); // 택배사가 운송장을 잊었다
    await sweepOnce();
    const r = await runs(shipmentId);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ attempt: 1, outcome: 'ERROR' });
    expect(r[0].detail).toContain('PartnerPermanentError');
  });

  it('반영 직전에 같은 단말기가 다시 출고돼 운송장이 SUPERSEDED면 단말기를 바꾸지 않는다(decisions/0018)', async () => {
    await partners.configure({ bungae: { advancePerPoll: 4 } });
    const { shipmentId } = await prepareShipped(t, 'CS-0007', 'BUNGAE');
    const adapter = t.app.get(CarrierAdapters).get(Carrier.BUNGAE);
    const original = adapter.track.bind(adapter);
    // 택배사 응답(DELIVERED 포함)을 받은 뒤 반영하기 전에, 다른 요청이 이 단말기를 다시 출고한 상황을 만든다.
    const spy = vi.spyOn(adapter, 'track').mockImplementationOnce(async (trackingNo) => {
      const events = await original(trackingNo);
      await em().nativeUpdate(Shipment, shipmentId, { status: ShipmentStatus.SUPERSEDED });
      return events;
    });
    try {
      expect(await sync.track(shipmentId, { queue: 'test', attempt: 1 })).toBe('NOOP');
    } finally {
      spy.mockRestore();
    }
    const s = await shipment(shipmentId);
    expect(s.status).toBe(ShipmentStatus.SUPERSEDED);
    expect(s.terminal.status).toBe(TerminalStatus.SHIPPED);
    expect(await deliveredHistory('CS-0007')).toHaveLength(0);
    const [run] = await runs(shipmentId);
    expect(run).toMatchObject({ outcome: 'NOOP', detail: '운송장이 이미 SUPERSEDED' });
  });
});
```

`apps/api/test/scheduler.e2e.spec.ts`(새):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUE, type QueueName } from '../src/queue/queue-names.js';
import { clearJobSchedulers } from '../src/scheduler/job-schedulers.js';
import { SchedulerService } from '../src/scheduler/scheduler.service.js';
import { resetQueues, waitForQueuesIdle } from './helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('주기 작업 삭제 (scheduler:clear, decisions/0015)', () => {
  let t: TestApp;
  const queueOf = (name: QueueName) => t.app.get<Queue>(getQueueToken(name));

  beforeAll(async () => {
    // 워커를 띄워 주기 job이 실제로 처리되게 한다(sweep·relay가 테스트 DB를 읽는다).
    t = await createTestApp({ workers: true });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it('등록된 주기 작업을 지우면 다음 주기 job이 더 생기지 않는다. 다시 지우면 지울 것이 없다', async () => {
    // 테스트 앱에는 스케줄러가 없으므로(schedulers: false) 직접 등록한다. 접두사가 test-라 개발 Redis 키는 건드리지 않는다.
    await new SchedulerService(queueOf(QUEUE.CARRIER_SWEEP), queueOf(QUEUE.OUTBOX)).onApplicationBootstrap();
    expect(await queueOf(QUEUE.CARRIER_SWEEP).getJobSchedulersCount()).toBe(1);
    expect(await queueOf(QUEUE.OUTBOX).getJobSchedulersCount()).toBe(1);

    expect(await clearJobSchedulers(queueOf)).toEqual(['carrier-sweep', 'outbox-relay']);
    for (const name of [QUEUE.CARRIER_SWEEP, QUEUE.OUTBOX]) {
      expect(await queueOf(name).getJobSchedulersCount()).toBe(0);
      expect(await queueOf(name).getJobCountByTypes('delayed')).toBe(0);
    }
    // 등록 때 바로 넣어진 첫 job(waiting)은 남아 있을 수 있다. 그것이 처리된 뒤에도 다음 주기 job(delayed)이 생기지 않아야
    // 큐가 빈다. scheduler가 남아 있으면 delayed job이 계속 있어 이 대기가 시간 초과로 실패한다.
    await waitForQueuesIdle(t.app, 5_000);
    expect(await clearJobSchedulers(queueOf)).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit test/transition.e2e.spec.ts test/merchant.e2e.spec.ts test/shipment.e2e.spec.ts test/carrier-sync.e2e.spec.ts test/scheduler.e2e.spec.ts test/terminal-concurrency.e2e.spec.ts`
Expected: FAIL. `scheduler.e2e`는 `job-schedulers.js`를 못 찾아 파일 로드 실패. 나머지(사전 검증에서 14건): `IN_STOCK → ALLOCATED 는 [null] 출처만 허용`(`Src.ALLOCATION`이 아직 없어 undefined), `일반 전이 API로는 배정·출고…`(`expected 200 to be 422`), 배정 취소 2건(404, 라우트 없음), `B. 시스템 작업…`(`expected +0 to be 1`), 출고·배정 이력 source 불일치, `SUPERSEDED` 2건, `60초를 넘으면 60초로 자른다`(`expected 3600000 …`).

- [ ] **Step 3: 출처와 전이 규칙**

`apps/api/src/terminal/terminal-status.ts` 전체:
```ts
export enum TerminalStatus {
  RECEIVED = 'RECEIVED', // 입고
  INSPECTED = 'INSPECTED', // 검수 합격
  DEFECTIVE = 'DEFECTIVE', // 불량
  IN_STOCK = 'IN_STOCK', // 재고
  ALLOCATED = 'ALLOCATED', // 가맹점 배정
  SHIPPED = 'SHIPPED', // 출고(배송 중)
  DELIVERED = 'DELIVERED', // 배송 완료
  IN_SERVICE = 'IN_SERVICE', // 운영 중
  RETURN_REQUESTED = 'RETURN_REQUESTED', // 회수 요청
  RETURNING = 'RETURNING', // 회수 중
  RETURNED = 'RETURNED', // 회수 입고
  DISPOSED = 'DISPOSED', // 폐기
}

/** 상태를 바꾼 경로. 규칙별 허용 출처는 transition-rules.ts에서 정한다(decisions/0007). */
export enum TransitionSource {
  MANUAL = 'MANUAL',
  INSPECTION = 'INSPECTION',
  BATCH = 'BATCH', // 시스템 배치(택배 추적 수집 등)
  ALLOCATION = 'ALLOCATION', // 가맹점 배정·배정 취소 API (decisions/0017)
  SHIPMENT = 'SHIPMENT', // 출고 API
  SCAN = 'SCAN', // 박스 일괄 스캔
  IMPORT = 'IMPORT', // 엑셀 일괄 등록
  SERVICE = 'SERVICE', // A/S 접수·교체·설치 확인
}
```

`apps/api/src/terminal/transition-rules.ts` 전체:
```ts
import { TerminalStatus as S, TransitionSource } from './terminal-status.js';

export interface ModelPolicy {
  requiresReinspection: boolean;
}

interface TransitionRule {
  from: S;
  to: S;
  /** 이 전이를 일으킬 수 있는 경로. 없으면 MANUAL만 (decisions/0007) */
  only?: TransitionSource[];
  /** 모델 정책 때문에 막히면 이유를 돌려준다 */
  blockedBy?: (policy: ModelPolicy) => string | undefined;
}

/** `only`가 없는 규칙의 허용 출처. 새 출처를 추가해도 자동으로 넓어지지 않게 MANUAL만 둔다(decisions/0007). */
const DEFAULT_SOURCES: TransitionSource[] = [TransitionSource.MANUAL];

/** 단말기 상태 전이 표. 상태 변경 규칙은 여기 한 곳에만 둔다(decisions/0003). */
const RULES: TransitionRule[] = [
  { from: S.RECEIVED, to: S.INSPECTED, only: [TransitionSource.INSPECTION] },
  { from: S.RECEIVED, to: S.DEFECTIVE, only: [TransitionSource.INSPECTION] },
  { from: S.INSPECTED, to: S.IN_STOCK },
  // 배정·배정 취소는 가맹점을 함께 바꿔야 하므로 배정 API(ALLOCATION)로만 한다. 일반 전이 API로는 가맹점 없는 배정이 생긴다(decisions/0017).
  { from: S.IN_STOCK, to: S.ALLOCATED, only: [TransitionSource.ALLOCATION] },
  { from: S.ALLOCATED, to: S.IN_STOCK, only: [TransitionSource.ALLOCATION] },
  // 출고는 운송장과 함께여야 하므로 출고 API(SHIPMENT)로만 한다.
  { from: S.ALLOCATED, to: S.SHIPPED, only: [TransitionSource.SHIPMENT] },
  // 배송 완료는 택배 추적 수집(BATCH)이 자동으로, 또는 운영자가 수동으로 바꾼다.
  { from: S.SHIPPED, to: S.DELIVERED, only: [TransitionSource.MANUAL, TransitionSource.BATCH] },
  // 설치 확인: 운영자가 직접, 또는 A/S 교체 건의 설치 확인 API(SERVICE)가 바꾼다.
  { from: S.DELIVERED, to: S.IN_SERVICE, only: [TransitionSource.MANUAL, TransitionSource.SERVICE] },
  // 회수 요청: 운영자가 직접, 또는 A/S 교체 출고가 고장 단말기를 회수 요청으로 바꾼다.
  { from: S.IN_SERVICE, to: S.RETURN_REQUESTED, only: [TransitionSource.MANUAL, TransitionSource.SERVICE] },
  { from: S.RETURN_REQUESTED, to: S.RETURNING },
  // 회수 입고: 운영자가 직접, 또는 박스 스캔(RETURN_IN)이 일괄로 바꾼다.
  { from: S.RETURNING, to: S.RETURNED, only: [TransitionSource.MANUAL, TransitionSource.SCAN] },
  { from: S.RETURNED, to: S.INSPECTED, only: [TransitionSource.INSPECTION] },
  { from: S.RETURNED, to: S.DEFECTIVE, only: [TransitionSource.INSPECTION] },
  {
    from: S.RETURNED,
    to: S.IN_STOCK,
    blockedBy: (p) => (p.requiresReinspection ? '재검수 필수 모델은 회수 후 검수를 거쳐야 재고로 돌릴 수 있습니다.' : undefined),
  },
  { from: S.DEFECTIVE, to: S.DISPOSED },
];

export type TransitionCheck = { ok: true } | { ok: false; reason: string };

export function checkTransition(from: S, to: S, source: TransitionSource, policy: ModelPolicy): TransitionCheck {
  const rule = RULES.find((r) => r.from === from && r.to === to);
  if (!rule) return { ok: false, reason: `허용되지 않은 전이입니다: ${from} → ${to}` };

  const allowed = rule.only ?? DEFAULT_SOURCES;
  if (!allowed.includes(source)) {
    return { ok: false, reason: `${from} → ${to} 는 ${allowed.join(', ')} 경로로만 바꿀 수 있습니다(요청 경로: ${source}).` };
  }

  const blocked = rule.blockedBy?.(policy);
  if (blocked) return { ok: false, reason: blocked };
  return { ok: true };
}
```

- [ ] **Step 4: 배정은 ALLOCATION, 배정 취소 API**

`apps/api/src/merchant/dto/cancel-allocation.dto.ts`:
```ts
import { IsInt, IsString, Length, Matches, Min } from 'class-validator';

export class CancelAllocationDto {
  @IsString()
  @Length(1, 200)
  @Matches(/\S/, { message: 'reason은 공백만으로 쓸 수 없습니다.' })
  reason!: string;

  /** 화면에서 본 version (decisions/0004) */
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
```

`apps/api/src/merchant/merchant.service.ts` 전체:
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import { TransitionService } from '../terminal/transition.service.js';
import type { AllocateDto } from './dto/allocate.dto.js';
import type { CancelAllocationDto } from './dto/cancel-allocation.dto.js';
import { Merchant } from './merchant.entity.js';

@Injectable()
export class MerchantService {
  constructor(
    private readonly em: EntityManager,
    private readonly transitions: TransitionService,
  ) {}

  async list(): Promise<Merchant[]> {
    return this.em.find(Merchant, {}, { orderBy: { code: 'asc' } });
  }

  /** 재고 단말기를 가맹점에 배정한다. 상태(IN_STOCK → ALLOCATED)와 가맹점을 UPDATE 한 번으로 바꾼다. */
  async allocate(serialNo: string, dto: AllocateDto, actor: string): Promise<Terminal> {
    const merchant = await this.em.findOne(Merchant, { code: dto.merchantCode });
    if (!merchant) throw new NotFoundException(`가맹점 ${dto.merchantCode}이(가) 없습니다.`);
    return this.transitions.transition({
      serialNo,
      to: TerminalStatus.ALLOCATED,
      reason: `가맹점 배정: ${merchant.name}(${merchant.code})`,
      actor,
      source: TransitionSource.ALLOCATION,
      expectedVersion: dto.expectedVersion,
      mutate: (terminal) => {
        terminal.merchant = merchant;
      },
    });
  }

  /** 배정 취소: ALLOCATED → IN_STOCK과 가맹점 비우기를 UPDATE 한 번으로(decisions/0011, 0017). */
  async cancelAllocation(serialNo: string, dto: CancelAllocationDto, actor: string): Promise<Terminal> {
    return this.transitions.transition({
      serialNo,
      to: TerminalStatus.IN_STOCK,
      reason: `배정 취소: ${dto.reason}`,
      actor,
      source: TransitionSource.ALLOCATION,
      expectedVersion: dto.expectedVersion,
      mutate: (terminal) => {
        terminal.merchant = null;
      },
    });
  }
}
```

`apps/api/src/merchant/merchant.controller.ts` 전체:
```ts
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { toTerminalView } from '../terminal/terminal.views.js';
import { AllocateDto } from './dto/allocate.dto.js';
import { CancelAllocationDto } from './dto/cancel-allocation.dto.js';
import { MerchantService } from './merchant.service.js';

@Controller()
export class MerchantController {
  constructor(private readonly merchants: MerchantService) {}

  @Get('merchants')
  async list() {
    return (await this.merchants.list()).map((m) => ({ code: m.code, name: m.name, address: m.address }));
  }

  @Post('terminals/:serialNo/allocations')
  async allocate(@Param('serialNo') serialNo: string, @Body() dto: AllocateDto, @Operator() actor: string) {
    return toTerminalView(await this.merchants.allocate(serialNo, dto, actor));
  }

  @Post('terminals/:serialNo/allocation-cancellations')
  async cancelAllocation(@Param('serialNo') serialNo: string, @Body() dto: CancelAllocationDto, @Operator() actor: string) {
    return toTerminalView(await this.merchants.cancelAllocation(serialNo, dto, actor));
  }
}
```

- [ ] **Step 5: 출고는 SHIPMENT, 재출고 시 SUPERSEDED, 배송 완료는 IN_TRANSIT만**

`apps/api/src/shipment/shipment.entities.ts` 전체:
```ts
import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';
import { Carrier, CarrierEventCode } from '../carrier/carrier.types.js';
import { Terminal } from '../terminal/terminal.entity.js';

export enum ShipmentStatus {
  IN_TRANSIT = 'IN_TRANSIT',
  DELIVERED = 'DELIVERED',
  /** 같은 단말기를 다시 출고해 더는 이 운송장으로 단말기 상태를 바꾸지 않는다(decisions/0018). */
  SUPERSEDED = 'SUPERSEDED',
}

// 주의: `Date | null` 같은 유니온 타입은 데코레이터 메타데이터가 Object로 나와 MikroORM이 varchar(255)로 만든다.
// nullable 날짜에는 type: 'datetime'을 꼭 적는다.

/** 출고 1건 = 운송장 1장. 수집 작업이 IN_TRANSIT인 운송장을 주기적으로 조회한다. */
@Entity({ tableName: 'shipment' })
@Index({ properties: ['status'] })
export class Shipment {
  [OptionalProps]?: 'status' | 'createdAt';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => Terminal)
  terminal!: Rel<Terminal>;

  @Enum({ items: () => Carrier })
  carrier!: Carrier;

  @Property({ unique: true, length: 30 })
  trackingNo!: string;

  @Enum({ items: () => ShipmentStatus })
  status: ShipmentStatus = ShipmentStatus.IN_TRANSIT;

  /** 마지막으로 택배사 조회에 성공한 시각 */
  @Property({ type: 'datetime', nullable: true })
  lastSyncedAt?: Date | null;

  /** 택배사가 알려 준 배송 완료 시각 */
  @Property({ type: 'datetime', nullable: true })
  deliveredAt?: Date | null;

  @Property()
  createdAt: Date = new Date();
}

/** 택배사에서 받은 배송 이벤트. (운송장, eventKey)가 같으면 같은 이벤트라서 한 번만 저장한다. */
@Entity({ tableName: 'carrier_event' })
@Unique({ properties: ['shipment', 'eventKey'] })
export class CarrierEvent {
  [OptionalProps]?: 'receivedAt';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => Shipment)
  shipment!: Rel<Shipment>;

  @Property({ length: 50 })
  eventKey!: string;

  @Enum({ items: () => CarrierEventCode })
  code!: CarrierEventCode;

  @Property()
  occurredAt!: Date;

  /** 택배사 원본 */
  @Property({ type: 'json' })
  raw!: Record<string, unknown>;

  @Property()
  receivedAt: Date = new Date();
}

/** 수집 job 실행 1회의 기록. 실험에서 호출·중복·재시도 수를 셀 때 쓴다. */
@Entity({ tableName: 'sync_run' })
export class SyncRun {
  [OptionalProps]?: 'startedAt' | 'fetched' | 'inserted' | 'duplicated';

  @PrimaryKey()
  id!: number;

  /** 큐 이름(track-bungae 등) */
  @Property({ length: 50 })
  job!: string;

  @ManyToOne(() => Shipment, { nullable: true })
  shipment?: Rel<Shipment> | null;

  /** 몇 번째 시도인지(1부터) */
  @Property()
  attempt!: number;

  /** 처리한 프로세스(WORKER_NAME 또는 pid-<pid>) */
  @Property({ length: 50 })
  worker!: string;

  /** OK | DELIVERED | NOOP | SKIPPED | ERROR */
  @Property({ length: 20 })
  outcome!: string;

  @Property()
  startedAt: Date = new Date();

  @Property({ type: 'datetime', nullable: true })
  finishedAt?: Date | null;

  /** 택배사가 준 이벤트 수(중복 포함) */
  @Property()
  fetched: number = 0;

  /** 새로 저장한 이벤트 수 */
  @Property()
  inserted: number = 0;

  /** 이미 있어서 건너뛴 이벤트 수(응답 안 중복 + 이미 저장된 것) */
  @Property()
  duplicated: number = 0;

  /** 오류 메시지, 또는 NOOP·SKIPPED인 이유 */
  @Property({ length: 500, nullable: true })
  detail?: string | null;
}
```

`apps/api/src/shipment/shipment.service.ts` 전체(`recordShipment`는 Task 9 교체 출고도 쓴다):
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { CarrierAdapters } from '../carrier/carrier.adapters.js';
import type { Carrier } from '../carrier/carrier.types.js';
import { InvalidTransitionError } from '../common/domain-errors.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import { TransitionService } from '../terminal/transition.service.js';
import type { CreateShipmentDto } from './dto/create-shipment.dto.js';
import { CarrierEvent, Shipment, ShipmentStatus } from './shipment.entities.js';

@Injectable()
export class ShipmentService {
  constructor(
    private readonly em: EntityManager,
    private readonly transitions: TransitionService,
    private readonly adapters: CarrierAdapters,
  ) {}

  /**
   * 출고: ① 트랜잭션 밖에서 택배사에 운송장을 발급받고 ② 트랜잭션에서 단말기 전이(ALLOCATED → SHIPPED)를 먼저 한 뒤
   * 운송장(Shipment)을 저장한다. 외부 HTTP를 DB 트랜잭션 안에서 기다리지 않기 위해서다.
   * ②가 실패하면 ①의 운송장은 택배사 쪽에 고아로 남는다(알려진 한계, decisions/0012).
   */
  async create(dto: CreateShipmentDto, actor: string): Promise<{ shipment: Shipment; terminal: Terminal }> {
    // 운송장을 발급받기 전에 확인할 수 있는 실패는 먼저 걸러 고아 운송장을 줄인다.
    const terminal = await this.em.findOne(Terminal, { serialNo: dto.serialNo }, { populate: ['model', 'merchant'] });
    if (!terminal) throw new NotFoundException(`단말기 ${dto.serialNo}이(가) 없습니다.`);
    await this.em.lock(terminal, LockMode.OPTIMISTIC, dto.expectedVersion);
    const merchant = terminal.merchant;
    if (terminal.status !== TerminalStatus.ALLOCATED || !merchant) {
      throw new InvalidTransitionError(`가맹점에 배정된(ALLOCATED) 단말기만 출고할 수 있습니다(현재: ${terminal.status}).`);
    }

    const trackingNo = await this.adapters.get(dto.carrier).createWaybill({
      reference: `${dto.serialNo}-${Date.now()}`,
      receiverName: merchant.name,
      address: merchant.address,
    });

    return this.em.transactional(async (tx) => {
      // 전이(단말기 UPDATE)를 운송장 INSERT보다 먼저 한다. 운송장 INSERT의 FK 검사가 단말기 행에 S 락을 먼저 잡으면
      // 동시 요청끼리 S→X 데드락이 난다(troubleshooting/0004, decisions/0006).
      const updated = await this.transitions.transition(
        {
          serialNo: dto.serialNo,
          to: TerminalStatus.SHIPPED,
          reason: `출고: ${dto.carrier} ${trackingNo}`,
          actor,
          source: TransitionSource.SHIPMENT,
          expectedVersion: dto.expectedVersion,
        },
        tx,
      );
      const shipment = await this.recordShipment(tx, updated, dto.carrier, trackingNo);
      return { shipment, terminal: updated };
    });
  }

  /**
   * 단말기의 새 운송장을 저장한다. 같은 단말기의 이전 배송 중 운송장은 SUPERSEDED로 바꿔, 옛 운송장의 배송 완료가
   * 새 출고를 완료 처리하지 못하게 한다(decisions/0018). 단말기 UPDATE(전이) 뒤에 부른다 — 단말기 X 락을 먼저 쥔 상태라
   * 같은 단말기의 출고끼리는 여기서 순서가 정해진다. 교체 출고(F7)도 이 함수를 쓴다.
   */
  async recordShipment(tx: EntityManager, terminal: Terminal, carrier: Carrier, trackingNo: string): Promise<Shipment> {
    await tx.nativeUpdate(
      Shipment,
      { terminal: terminal.id, status: ShipmentStatus.IN_TRANSIT },
      { status: ShipmentStatus.SUPERSEDED },
    );
    return tx.create(Shipment, { terminal, carrier, trackingNo });
  }

  async get(id: number): Promise<{ shipment: Shipment; events: CarrierEvent[] }> {
    const shipment = await this.em.findOne(Shipment, id, { populate: ['terminal'] });
    if (!shipment) throw new NotFoundException(`출고 ${id}이(가) 없습니다.`);
    const events = await this.em.find(CarrierEvent, { shipment }, { orderBy: { occurredAt: 'asc', id: 'asc' } });
    return { shipment, events };
  }
}
```

`apps/api/src/carrier-sync/carrier-sync.service.ts` 전체(`applyDelivered`의 첫 검사만 바뀐다):
```ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/mysql';
import { CarrierAdapters } from '../carrier/carrier.adapters.js';
import { Carrier, CarrierEventCode, type NormalizedEvent } from '../carrier/carrier.types.js';
import { env } from '../config/env.js';
import { QUEUE } from '../queue/queue-names.js';
import { CarrierEvent, Shipment, ShipmentStatus, SyncRun } from '../shipment/shipment.entities.js';
import { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import { TransitionService } from '../terminal/transition.service.js';
import { TRACK_JOB_OPTIONS } from './retry-policy.js';

export interface TrackJobData {
  shipmentId: number;
}

export type TrackOutcome = 'OK' | 'DELIVERED' | 'NOOP' | 'SKIPPED' | 'ERROR';

interface RunCounts {
  fetched: number;
  inserted: number;
  duplicated: number;
}

/** 시스템 작업 actor는 `system:<작업명>` (decisions/0001) */
export const SYNC_ACTOR = 'system:carrier-sync';

/**
 * 택배 추적 자동 수집(F3).
 * - sweep: 배송 중인 운송장마다 추적 job을 넣는다(주기 실행).
 * - track: 한 운송장을 조회해 새 이벤트만 저장하고, 배송 완료면 단말기를 DELIVERED로 바꾼다.
 * 워커에는 요청 컨텍스트가 없으므로 작업마다 em.fork()를 쓴다.
 */
@Injectable()
export class CarrierSyncService {
  private readonly logger = new Logger(CarrierSyncService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly adapters: CarrierAdapters,
    private readonly transitions: TransitionService,
    @InjectQueue(QUEUE.TRACK_BUNGAE) private readonly bungaeQueue: Queue<TrackJobData>,
    @InjectQueue(QUEUE.TRACK_NEURIMBO) private readonly neurimboQueue: Queue<TrackJobData>,
  ) {}

  /** 배송 중인 운송장마다 추적 job을 넣는다. 같은 운송장의 job이 아직 대기·처리·재시도 중이면 jobId가 같아 무시된다. */
  async sweep(): Promise<{ shipments: number }> {
    const shipments = await this.em.fork().find(Shipment, { status: ShipmentStatus.IN_TRANSIT }, { orderBy: { id: 'asc' } });
    for (const s of shipments) {
      const queue = s.carrier === Carrier.BUNGAE ? this.bungaeQueue : this.neurimboQueue;
      // BullMQ 커스텀 jobId에는 ':'를 쓸 수 없다(쓰면 add가 에러).
      await queue.add('track', { shipmentId: s.id }, { ...TRACK_JOB_OPTIONS, jobId: `track-${s.id}` });
    }
    return { shipments: shipments.length };
  }

  /** 운송장 하나를 조회해 반영한다. 실행마다 SyncRun을 한 줄 남긴다. */
  async track(shipmentId: number, ctx: { queue: string; attempt: number }): Promise<TrackOutcome> {
    const em = this.em.fork();
    const counts: RunCounts = { fetched: 0, inserted: 0, duplicated: 0 };
    const startedAt = new Date();
    let outcome: TrackOutcome = 'OK';
    let detail: string | null = null;
    let shipmentFound = false;
    try {
      const shipment = await em.findOne(Shipment, shipmentId);
      shipmentFound = !!shipment;
      if (!shipment || shipment.status !== ShipmentStatus.IN_TRANSIT) {
        detail = shipment ? `이미 ${shipment.status}` : '운송장 없음';
        return (outcome = 'SKIPPED');
      }

      const events = await this.adapters.get(shipment.carrier).track(shipment.trackingNo);
      counts.fetched = events.length;
      await this.storeEvents(em, shipment, events, counts);

      const delivered = events.find((e) => e.code === CarrierEventCode.DELIVERED);
      if (delivered) {
        const result = await this.applyDelivered(shipmentId, delivered.occurredAt);
        outcome = result.outcome;
        detail = result.detail;
      } else {
        shipment.lastSyncedAt = new Date();
        await em.flush();
      }
      return outcome;
    } catch (error) {
      outcome = 'ERROR';
      detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw error;
    } finally {
      await this.recordRun({ ...counts, job: ctx.queue, attempt: ctx.attempt, shipmentId: shipmentFound ? shipmentId : null, startedAt, outcome, detail });
    }
  }

  /**
   * 새 이벤트만 저장한다. ① 응답 안의 같은 eventKey를 하나로 ② 이미 저장된 키를 한 번에 조회해 제외 ③ 나머지 INSERT.
   * ③에서 unique 위반이 나면(다른 워커가 먼저 넣은 경쟁 상황) 중복으로 센다 — unique 제약이 마지막 안전망이다.
   */
  private async storeEvents(em: EntityManager, shipment: Shipment, events: NormalizedEvent[], counts: RunCounts): Promise<void> {
    const byKey = new Map<string, NormalizedEvent>();
    for (const e of events) if (!byKey.has(e.eventKey)) byKey.set(e.eventKey, e);
    counts.duplicated += events.length - byKey.size;

    const existing = await em.find(CarrierEvent, { shipment, eventKey: { $in: [...byKey.keys()] } });
    const known = new Set(existing.map((e) => e.eventKey));

    for (const e of byKey.values()) {
      if (known.has(e.eventKey)) {
        counts.duplicated += 1;
        continue;
      }
      try {
        // em.insert는 Unit of Work를 거치지 않는 단건 INSERT(자동 커밋)라 unique 위반이 나도 em이 망가지지 않는다.
        await em.insert(CarrierEvent, {
          shipment: shipment.id,
          eventKey: e.eventKey,
          code: e.code,
          occurredAt: e.occurredAt,
          raw: e.raw,
          receivedAt: new Date(),
        });
        counts.inserted += 1;
      } catch (error) {
        if (!(error instanceof UniqueConstraintViolationException)) throw error;
        counts.duplicated += 1;
      }
    }
  }

  /**
   * 배송 완료 반영: 한 트랜잭션에서 단말기 전이(SHIPPED → DELIVERED, BATCH)를 먼저 하고 운송장을 완료로 바꾼다.
   * 운송장이 IN_TRANSIT가 아니면(완료·SUPERSEDED) no-op이다.
   * 단말기가 이미 SHIPPED가 아니면(운영자가 먼저 수동으로 바꾼 경우 등) 단말기는 건드리지 않고 운송장만 완료한다(no-op, decisions/0014).
   */
  private async applyDelivered(shipmentId: number, deliveredAt: Date): Promise<{ outcome: TrackOutcome; detail: string | null }> {
    return this.em.fork().transactional(async (tx) => {
      const shipment = await tx.findOneOrFail(Shipment, shipmentId, { populate: ['terminal'] });
      // 배송 중(IN_TRANSIT)인 운송장만 단말기를 바꾼다. 이미 완료됐거나, 그사이 같은 단말기가 다시 출고돼
      // SUPERSEDED가 된 옛 운송장이면 아무것도 하지 않는다(decisions/0018).
      if (shipment.status !== ShipmentStatus.IN_TRANSIT) return { outcome: 'NOOP', detail: `운송장이 이미 ${shipment.status}` };

      let result: { outcome: TrackOutcome; detail: string | null } = {
        outcome: 'NOOP',
        detail: `단말기 상태가 ${shipment.terminal.status}라 전이하지 않음`,
      };
      if (shipment.terminal.status === TerminalStatus.SHIPPED) {
        await this.transitions.transition(
          {
            serialNo: shipment.terminal.serialNo,
            to: TerminalStatus.DELIVERED,
            reason: `배송 완료: ${shipment.carrier} ${shipment.trackingNo}`,
            actor: SYNC_ACTOR,
            source: TransitionSource.BATCH,
          },
          tx,
        );
        result = { outcome: 'DELIVERED', detail: null };
      }
      shipment.status = ShipmentStatus.DELIVERED;
      shipment.deliveredAt = deliveredAt;
      shipment.lastSyncedAt = new Date();
      return result;
    });
  }

  private async recordRun(run: RunCounts & {
    job: string;
    attempt: number;
    shipmentId: number | null;
    startedAt: Date;
    outcome: TrackOutcome;
    detail: string | null;
  }): Promise<void> {
    try {
      const em = this.em.fork();
      em.create(SyncRun, {
        job: run.job,
        shipment: run.shipmentId,
        attempt: run.attempt,
        worker: env.workerName,
        outcome: run.outcome,
        startedAt: run.startedAt,
        finishedAt: new Date(),
        fetched: run.fetched,
        inserted: run.inserted,
        duplicated: run.duplicated,
        detail: run.detail?.slice(0, 500) ?? null,
      });
      await em.flush();
    } catch (error) {
      // 기록 실패가 수집 결과를 바꾸지 않게 한다.
      this.logger.error(`SyncRun 기록 실패: ${String(error)}`);
    }
  }
}
```

- [ ] **Step 6: 작은 이월 — Retry-After 상한, scheduler:clear, worker ready 누적, down() 주석**

`apps/api/src/common/partner-http.ts` 전체:
```ts
import { PartnerPermanentError, PartnerRateLimitedError, PartnerTransientError } from './partner-errors.js';

/** Retry-After 상한. 업체가 아주 큰 값을 줘도 job이 그만큼 잠들지 않게 한다(decisions/0014 갱신). */
export const MAX_RETRY_AFTER_MS = 60_000;

/** Retry-After(초 또는 HTTP 날짜)를 ms로. 없거나 못 읽으면 기본 1초, 0 ~ 60초로 자른다. */
export function parseRetryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 1000;
  const seconds = Number(value);
  const at = Date.parse(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Number.isNaN(at) ? 1000 : at - now;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
}

/**
 * 외부 업체 HTTP 호출. 2xx면 본문 문자열을 돌려주고, 아니면 재시도 판단에 쓰는 오류로 바꾼다.
 * - 429 → PartnerRateLimitedError(Retry-After)
 * - 5xx, 타임아웃, 연결 실패 → PartnerTransientError
 * - 그 밖의 4xx → PartnerPermanentError
 */
export async function partnerFetch(label: string, url: string, init: RequestInit, timeoutMs: number): Promise<string> {
  let res: Response;
  let body: string;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    // 헤더 뒤 본문을 읽다가 타임아웃·연결 끊김이 나도 같은 일시 오류로 본다.
    body = await res.text();
  } catch (error) {
    // AbortSignal.timeout은 TimeoutError, 연결 실패는 TypeError(fetch failed)
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new PartnerTransientError(`${label} 호출 실패(${reason})`);
  }
  if (res.ok) return body;
  const message = `${label} 응답 ${res.status}: ${body.slice(0, 200)}`;
  if (res.status === 429) throw new PartnerRateLimitedError(message, parseRetryAfter(res.headers.get('retry-after')));
  if (res.status >= 500) throw new PartnerTransientError(message);
  throw new PartnerPermanentError(message);
}
```

`apps/api/src/scheduler/job-schedulers.ts`(새):
```ts
import type { Queue } from 'bullmq';
import { QUEUE, type QueueName } from '../queue/queue-names.js';

/** 주기 작업 목록. 등록(SchedulerService)과 삭제(scheduler:clear)가 같은 id를 쓴다. */
export const JOB_SCHEDULERS = [
  { queue: QUEUE.CARRIER_SWEEP, id: 'carrier-sweep', jobName: 'sweep' },
  { queue: QUEUE.OUTBOX, id: 'outbox-relay', jobName: 'relay' },
] as const satisfies readonly { queue: QueueName; id: string; jobName: string }[];

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
import { env } from '../config/env.js';
import { QUEUE } from '../queue/queue-names.js';
import { JOB_SCHEDULERS } from './job-schedulers.js';

/**
 * 주기 작업 등록. BullMQ job scheduler는 Redis에 한 개만 저장되므로(같은 id면 덮어씀)
 * 이 서비스가 여러 프로세스에서 떠도 주기 작업은 하나다. 지우려면 npm run scheduler:clear (decisions/0015).
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @InjectQueue(QUEUE.CARRIER_SWEEP) private readonly sweepQueue: Queue,
    @InjectQueue(QUEUE.OUTBOX) private readonly outboxQueue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const [sweep, relay] = JOB_SCHEDULERS;
    await this.sweepQueue.upsertJobScheduler(
      sweep.id,
      { every: env.sweepIntervalMs },
      { name: sweep.jobName, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
    await this.outboxQueue.upsertJobScheduler(
      relay.id,
      { every: env.relayIntervalMs },
      { name: relay.jobName, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
    this.logger.log(`주기 작업 등록: ${sweep.id} ${env.sweepIntervalMs}ms, ${relay.id} ${env.relayIntervalMs}ms`);
  }
}
```

`apps/api/src/scheduler/clear-schedulers.ts`(새, 스크립트):
```ts
import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import type { QueueName } from '../queue/queue-names.js';
import { clearJobSchedulers } from './job-schedulers.js';

// npm run scheduler:clear — 이 접두사(QUEUE_PREFIX, 기본 terminal-ops)의 주기 작업을 지운다.
// 모든 프로세스를 RUN_SCHEDULERS=0으로 띄우고 싶을 때, 먼저 이것으로 남아 있는 주기 작업을 없앤다.
const queues = new Map<QueueName, Queue>();
const queueOf = (name: QueueName) => {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: { host: env.redis.host, port: env.redis.port }, prefix: env.queuePrefix });
    queues.set(name, q);
  }
  return q;
};
try {
  const removed = await clearJobSchedulers(queueOf);
  console.log(`주기 작업 삭제(접두사 ${env.queuePrefix}): ${removed.join(', ') || '없음'}`);
} finally {
  await Promise.all([...queues.values()].map((q) => q.close()));
}
```

`apps/api/package.json`의 `scripts`에 `db:seed` 다음 줄로 추가:
```json
    "scheduler:clear": "npm run build && node dist/scheduler/clear-schedulers.js"
```

`apps/api/test/experiments/two-workers.spec.ts`의 `startWorker` 안 stdout 처리 부분을 다음으로 바꾼다(나머지는 그대로):
```ts
      // stdout은 청크 경계가 정해져 있지 않다. 'worker ready'가 두 청크에 걸쳐 올 수 있어 누적해서 본다(Day 2 리뷰 Minor 5).
      let output = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes('worker ready')) {
          clearTimeout(timer);
          ready();
        }
      });
```

`apps/api/src/migrations/Migration20261022053251.ts`의 `override down()` 바로 위에 한 줄 추가:
```ts
  // 주의: source가 BATCH인 이력이 있으면 strict 모드에서 이 down()은 실패한다(enum에 없는 값). 되돌리기 전에 그 행을 처리해야 한다(Day 2 리뷰 Minor 7).
```

- [ ] **Step 7: 통과 확인**

Run: `npx vitest run && npm run typecheck`
Expected: 17개 파일 `127 passed`, typecheck exit 0

- [ ] **Step 8: enum ALTER 마이그레이션**

Run: `npm run db:migration:create`
Expected: `생성: Migration<시각>.ts`. up()은 다음 두 줄이어야 한다.
```ts
    this.addSql(`alter table \`shipment\` modify \`status\` enum('IN_TRANSIT','DELIVERED','SUPERSEDED') not null default 'IN_TRANSIT';`);

    this.addSql(`alter table \`terminal_status_history\` modify \`source\` enum('MANUAL','INSPECTION','BATCH','ALLOCATION','SHIPMENT','SCAN','IMPORT','SERVICE') not null;`);
```
down()이 `enum('in_transit','delivered')`, `enum('manual','inspection','batch')`처럼 **소문자**로 생성된다(사전 검증, troubleshooting/0005). down()을 다음으로 바꾼다.
```ts
  // 생성된 down()은 enum이 소문자였다(troubleshooting/0005). 대문자로 고쳤다.
  // 주의: SUPERSEDED 운송장이나 새 출처(ALLOCATION 등)의 이력이 있으면 strict 모드에서 실패한다. 되돌리기 전에 그 행을 처리한다.
  override down(): void | Promise<void> {
    this.addSql(`alter table \`shipment\` modify \`status\` enum('IN_TRANSIT','DELIVERED') not null default 'IN_TRANSIT';`);

    this.addSql(`alter table \`terminal_status_history\` modify \`source\` enum('MANUAL','INSPECTION','BATCH') not null;`);
  }
```
그리고 적용·확인:
```bash
npm run db:migrate
npm run db:migration:check
```
Expected: `적용: Migration<시각>`, `최신 상태`

- [ ] **Step 9: 기록과 커밋**

`docs/devlog/2026-10-23.md`(새 파일)를 이렇게 시작한다.
```markdown
# Day 3

> 2026-10-23. 이전: [2일차 요약](2026-10-22.md#2일차-요약). 스펙 `docs/specs/2026-10-23-day3-ops-workflows.md`, 계획 `docs/plans/2026-10-23-day3-ops-workflows.md`

## HH:MM Task 1 Day 2 이월: 전용 출처, 배정 취소, SUPERSEDED, 작은 이월 4건 (F2, F3)
이전 Task 커밋: (git log -1 --format=%h)
- 한 일: …
- 확인: 127 passed, typecheck exit 0, migration check 최신 상태, enum down() 소문자 → 대문자로 고침
- 막힌 것: …
- 결정: decisions/0017, 0018, 0014·0015 갱신
- 다음: Task 2 세움전자
```

`docs/decisions/0017-전이-출처-확장과-배정-출고-전용-출처.md`:
- 상황: Day 2까지 일반 전이 API(MANUAL)로 가맹점 없는 배정(IN_STOCK → ALLOCATED)과 운송장 없는 출고(ALLOCATED → SHIPPED)를 만들 수 있었고, 배정 취소 때 가맹점이 남았다(Day 2 스펙 10장, backlog). Day 3에는 박스 스캔·엑셀·A/S가 상태를 바꾼다. 이력에서 누가 바꿨는지 구분해야 한다.
- 선택지:
  1. 출처 하나(BATCH)에 다 넣는다: 이력에서 스캔·엑셀·A/S를 구분할 수 없다.
  2. 기능별 출처 5개(ALLOCATION, SHIPMENT, SCAN, IMPORT, SERVICE) + 배정·출고 전이에 `only`로 전용 출처: 일반 API로는 배정·출고가 막히고, 이력에서 경로가 보인다.
  3. 서비스 계층에서 "이 API에서만 이 전이"를 검사: 규칙이 두 곳으로 나뉜다(decisions/0003).
- 결정: 2. 교체 출고(F7)는 새 출처를 만들지 않고 ALLOCATION·SHIPMENT를 쓴다(교체도 배정·출고다). SERVICE는 고장 단말기 회수 요청과 설치 확인. 배정 취소는 ALLOCATION 출처 + `mutate`로 `merchant = null`(decisions/0011 방식, version +1).
- 결과·대가: 출처가 8개가 됐다(decisions/0007의 "5개를 넘으면 표 뒤집기 검토"에 걸린다 → 아직은 `only` 표가 읽기 쉬워 유지, 다음 출처 추가 때 다시 본다). 네이티브 enum ALTER가 또 필요했다(down() 소문자 문제 반복).
- 단위 테스트: 전용 출처 표 7줄을 모든 출처에 대해 확인, "MANUAL로 배정·배정 취소·출고 불가", "새 출처 6개는 only 없는 일반 전이 불가".

`docs/decisions/0018-재출고-시-이전-운송장-SUPERSEDED.md`:
- 상황: Day 2 리뷰 Minor 1. 단말기가 회수 후 다시 출고되면 운송장이 여러 장이 된다. 옛 운송장의 DELIVERED 이벤트가 새 출고(SHIPPED)를 배송 완료로 바꿀 수 있다. F7 교체 출고부터 실제로 생긴다.
- 선택지:
  1. 배송 완료 반영 때 "그 단말기의 가장 최근 운송장인지" 조회해 비교: 반영마다 조회 1번, 기준(최근)이 시간에 의존.
  2. 출고할 때 같은 단말기의 이전 IN_TRANSIT 운송장을 `SUPERSEDED`로 바꾸고, 반영은 IN_TRANSIT 운송장만: 상태로 드러나고 sweep 대상에서도 빠진다.
- 결정: 2. `ShipmentService.recordShipment(tx, terminal, carrier, trackingNo)`가 단말기 UPDATE(전이) 뒤에 `UPDATE shipment SET status='SUPERSEDED' WHERE terminal_id=? AND status='IN_TRANSIT'` → INSERT. 반영(`applyDelivered`)은 `status !== IN_TRANSIT`면 NOOP(`운송장이 이미 SUPERSEDED`).
- 경합: 반영 트랜잭션은 운송장을 잠그지 않고 읽는다. 그사이 재출고가 커밋되면 반영의 단말기 UPDATE가 version 검사에 걸려(OptimisticLockError) job이 재시도되고, 다음 시도는 처음에 운송장이 IN_TRANSIT가 아닌 것을 보고 건너뛴다(SKIPPED). 재출고가 반영보다 먼저 커밋됐으면 반영 트랜잭션이 SUPERSEDED를 읽고 NOOP이다. 운송장 행을 먼저 잠그면 재출고(단말기 → 운송장)와 잠금 순서가 반대가 되어 택하지 않았다. 테스트: 택배사 응답 직후 운송장을 SUPERSEDED로 바꾸는 상황을 spy로 만들어 NOOP·단말기 SHIPPED 그대로를 확인.
- 결과·대가: shipment status enum ALTER. 다시 볼 조건: 운송장 하나에 단말기 여러 대(합포장)가 생기면 다시 설계.

`docs/decisions/0014-배송-완료-반영-규칙과-재시도.md` 끝에 한 줄:
```
- 갱신(2026-10-23 Day 3): Retry-After를 0~60초로 자른다(`MAX_RETRY_AFTER_MS`). 429가 attempts를 소모하는 것은 그대로(Day 2 리뷰 Minor 4). 운송장이 IN_TRANSIT가 아니면(SUPERSEDED 포함) NOOP → decisions/0018
```

`docs/decisions/0015-실행-모드-워커와-스케줄러.md` 끝에 한 줄:
```
- 갱신(2026-10-23 Day 3): job scheduler는 등록한 프로세스가 끝나도 Redis에 남아 계속 job을 만든다(Day 2 리뷰 Minor 2). 모든 프로세스를 RUN_SCHEDULERS=0으로 띄우려면 먼저 `npm run scheduler:clear`(QUEUE_PREFIX 기준, removeJobScheduler). 등록 때 이미 넣어진 첫 job 1개는 남아 한 번 실행된다(사전 검증).
```

`docs/study/backlog.md`에 추가:
```
- [ ] 출처별 허용 전이 표가 커질 때 — 전이×출처 표를 출처별 허용 목록으로 뒤집는 설계 (decisions/0017)
- [ ] BullMQ job scheduler 삭제(removeJobScheduler)와 이미 넣어진 job (scheduler/job-schedulers.ts)
- [ ] Node stream 'data' 청크 경계 — 줄 단위가 아니라서 누적해서 봐야 하는 이유 (two-workers.spec.ts)
```

커밋:
```bash
git add apps/api docs
git commit -m "feat(F2): 배정·출고 전용 출처, 배정 취소, 재출고 운송장 SUPERSEDED" -m "Refs: docs/decisions/0017-전이-출처-확장과-배정-출고-전용-출처.md, docs/decisions/0018-재출고-시-이전-운송장-SUPERSEDED.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 가상 세움전자 — 발주와 납품 명세 (F10)

**Files:**
- Create: `apps/partners/src/seum.ts`
- Modify: `apps/partners/src/state.ts`, `apps/partners/src/server.ts`
- Test: `apps/partners/test/seum.spec.ts`
- Record: devlog, `docs/decisions/0009-가상-업체-서버는-node-http-별도-프로세스.md`(갱신 한 줄)

세움전자 동작 요약: `POST /seum/v1/purchase-orders { modelCode, quantity(1~5000), reference }` → 201 `{ poNo: 'SE…', modelCode, quantity }`. 발주를 받는 순간 납품 명세를 정한다: 시리얼은 `<poNo>-0001`부터 수량만큼. 골칫거리 `shortfall`(n대 덜 보냄), `foreignSerials`(다른 발주번호의 시리얼 n개를 시드 난수 자리에 섞음), `error5xxRate`(발주 503). `GET /seum/v1/purchase-orders/:poNo/delivery-note` → `{ poNo, modelCode, quantity, serials }`(몇 번을 불러도 같다), 없으면 404. 관리 API stats의 `calls`에 `seum.purchaseOrder`, `seum.deliveryNote`가 쌓인다. 시리얼은 우리 API 형식(대문자·숫자·하이픈 4~32자)에 맞는다(`SE` + 17자리 + `-` + 4자리 = 24자).

명령은 `apps/partners`에서 실행한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/partners/test/seum.spec.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPartners, type Partners } from './helpers.js';

describe('세움전자(공장)', () => {
  let p: Partners;

  async function order(body: Record<string, unknown> = { modelCode: 'SN-100', quantity: 5, reference: 'PO-REF-1' }) {
    return fetch(`${p.base}/seum/v1/purchase-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  async function note(poNo: string) {
    return fetch(`${p.base}/seum/v1/purchase-orders/${encodeURIComponent(poNo)}/delivery-note`);
  }
  async function orderAndNote(quantity = 5) {
    const { poNo } = await (await order({ modelCode: 'SN-100', quantity, reference: `REF-${quantity}` })).json();
    return (await (await note(poNo)).json()) as { poNo: string; modelCode: string; quantity: number; serials: string[] };
  }

  beforeAll(async () => {
    p = await startPartners();
  });
  beforeEach(async () => {
    await p.reset();
  });
  afterAll(() => p.close());

  it('발주하면 SE 발주번호를 주고, 납품 명세는 발주 수량만큼의 서로 다른 시리얼이다', async () => {
    const res = await order();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ modelCode: 'SN-100', quantity: 5 });
    expect(body.poNo).toMatch(/^SE\d+$/);

    const dn = await note(body.poNo);
    expect(dn.status).toBe(200);
    const { serials, ...rest } = await dn.json();
    expect(rest).toEqual({ poNo: body.poNo, modelCode: 'SN-100', quantity: 5 });
    expect(serials).toHaveLength(5);
    expect(new Set(serials).size).toBe(5);
    for (const s of serials) expect(s).toMatch(new RegExp(`^${body.poNo}-\\d{4}$`));
    // 우리 API의 시리얼 형식(대문자·숫자·하이픈 4~32자)에 맞는다.
    for (const s of serials) expect(s).toMatch(/^[A-Z0-9-]{4,32}$/);
  });

  it('명세는 몇 번을 조회해도 같다', async () => {
    const { poNo } = await (await order()).json();
    const a = await (await note(poNo)).json();
    const b = await (await note(poNo)).json();
    expect(b).toEqual(a);
  });

  it('골칫거리 shortfall: 발주보다 n대 적게 납품한다', async () => {
    await p.configure({ seum: { shortfall: 2 } });
    const dn = await orderAndNote(5);
    expect(dn.quantity).toBe(5);
    expect(dn.serials).toHaveLength(3);
  });

  it('골칫거리 foreignSerials: 다른 발주의 시리얼이 섞이고, 같은 시드면 같은 자리에 섞인다', async () => {
    const positions = async () => {
      await p.reset();
      await p.configure({ seed: 7, seum: { foreignSerials: 3 } });
      const dn = await orderAndNote(10);
      expect(dn.serials).toHaveLength(13);
      const foreign = dn.serials.flatMap((s, i) => (s.startsWith(`${dn.poNo}-`) ? [] : [i]));
      expect(foreign).toHaveLength(3);
      for (const i of foreign) expect(dn.serials[i]).toMatch(/^SE\d+-\d{4}$/);
      return foreign;
    };
    expect(await positions()).toEqual(await positions());
  });

  it('호출 수를 센다', async () => {
    const { poNo } = await (await order()).json();
    await note(poNo);
    await note(poNo);
    const stats = await p.stats();
    expect(stats.calls['seum.purchaseOrder']).toBe(1);
    expect(stats.calls['seum.deliveryNote']).toBe(2);
  });

  it('없는 발주의 명세는 404, 본문이 틀리면 400', async () => {
    expect((await note('SE0')).status).toBe(404);
    expect((await order({ modelCode: 'SN-100', quantity: 0, reference: 'x' })).status).toBe(400);
    expect((await order({ modelCode: '', quantity: 1, reference: 'x' })).status).toBe(400);
    expect((await order({ modelCode: 'SN-100', quantity: 1 })).status).toBe(400);
  });

  it('error5xxRate=1이면 발주가 503', async () => {
    await p.configure({ seum: { error5xxRate: 1 } });
    expect((await order()).status).toBe(503);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/seum.spec.ts`
Expected: FAIL — `6 failed | 1 passed`(라우트가 없어 404 `NO_ROUTE`. '명세는 몇 번을 조회해도 같다'는 404 응답 두 개가 같아 우연히 통과한다)

- [ ] **Step 3: 구현**

`apps/partners/src/seum.ts`:
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendJson } from './http.js';
import type { PartnersState } from './state.js';

/** 한 번에 받을 수 있는 발주 수량 상한 */
export const SEUM_MAX_QUANTITY = 5000;

const seq4 = (n: number) => String(n).padStart(4, '0');

/**
 * POST /seum/v1/purchase-orders  { modelCode, quantity, reference } → 201 { poNo, modelCode, quantity }
 * 발주를 받는 순간 납품 명세(보낼 시리얼 목록)를 정해 둔다. 골칫거리:
 * - shortfall: 발주보다 n대 적게 보낸다.
 * - foreignSerials: 다른 발주의 시리얼 n개가 명세에 섞인다(섞이는 자리는 시드 난수).
 */
export async function seumCreatePurchaseOrder(state: PartnersState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = state.config.seum;
  state.count('seum.purchaseOrder');
  const body = await readJson(req);
  const modelCode = body?.modelCode;
  const quantity = body?.quantity;
  const reference = body?.reference;
  if (
    typeof modelCode !== 'string' ||
    !modelCode ||
    typeof reference !== 'string' ||
    !reference ||
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > SEUM_MAX_QUANTITY
  ) {
    return sendJson(res, 400, { error: 'BAD_REQUEST', message: `modelCode, reference, quantity(1~${SEUM_MAX_QUANTITY})가 필요합니다.` });
  }
  if (state.chance(cfg.error5xxRate)) {
    state.stats.status5xx += 1;
    return sendJson(res, 503, { error: 'TEMPORARY_UNAVAILABLE' });
  }

  const poNo = `SE${state.nextNumber()}`;
  const count = Math.max(0, quantity - cfg.shortfall);
  const serials = Array.from({ length: count }, (_, i) => `${poNo}-${seq4(i + 1)}`);
  if (cfg.foreignSerials > 0) {
    // 다른 발주(우리가 발주한 적 없는 번호)의 시리얼을 섞는다.
    const otherPoNo = `SE${state.nextNumber()}`;
    for (let k = 1; k <= cfg.foreignSerials; k++) {
      serials.splice(Math.floor(state.rng() * (serials.length + 1)), 0, `${otherPoNo}-${seq4(k)}`);
    }
  }
  state.seum.set(poNo, { poNo, modelCode, quantity, reference, serials });
  sendJson(res, 201, { poNo, modelCode, quantity });
}

/** GET /seum/v1/purchase-orders/:poNo/delivery-note → { poNo, modelCode, quantity, serials } */
export function seumDeliveryNote(state: PartnersState, poNo: string, res: ServerResponse): void {
  state.count('seum.deliveryNote');
  const po = state.seum.get(poNo);
  if (!po) return sendJson(res, 404, { error: 'NOT_FOUND' });
  sendJson(res, 200, { poNo: po.poNo, modelCode: po.modelCode, quantity: po.quantity, serials: po.serials });
}
```

`apps/partners/src/state.ts` 전체(`SeumConfig`, `SeumPurchaseOrder`, `seum` 맵, reset·configure):
```ts
import { createRng } from './rng.js';

export interface BungaeConfig {
  /** 조회 1번에 진행하는 단계 수. 1이면 4번째 조회에 DELIVERED */
  advancePerPoll: number;
  /** 이벤트마다 같은 사본을 하나 더 섞을 확률(0~1) */
  duplicateRate: number;
  /** 추적 조회의 초당 허용 횟수. 넘으면 429 */
  rateLimitPerSec: number;
  /** 한도와 상관없이 429를 낼 확률(0~1) */
  force429Rate: number;
  /** 429 응답의 Retry-After(초) */
  retryAfterSec: number;
  /** 추적 조회 응답 지연(ms) */
  delayMs: number;
}

export interface NeurimboConfig {
  advancePerPoll: number;
  delayMs: number;
  /** 503을 낼 확률(0~1) */
  error5xxRate: number;
  /** 이벤트 순서를 뒤섞을지 */
  shuffle: boolean;
}

export interface ToktokConfig {
  /** 500을 낼 확률(0~1). 실패한 요청은 저장하지 않는다. */
  failRate: number;
}

export interface SeumConfig {
  /** 발주보다 덜 보내는 대수 */
  shortfall: number;
  /** 명세에 섞을 다른 발주의 시리얼 수 */
  foreignSerials: number;
  /** 발주 API가 503을 낼 확률(0~1) */
  error5xxRate: number;
}

export interface PartnersConfig {
  seed: number;
  bungae: BungaeConfig;
  neurimbo: NeurimboConfig;
  toktok: ToktokConfig;
  seum: SeumConfig;
}

export interface ConfigPatch {
  seed?: number;
  bungae?: Partial<BungaeConfig>;
  neurimbo?: Partial<NeurimboConfig>;
  toktok?: Partial<ToktokConfig>;
  seum?: Partial<SeumConfig>;
}

export function defaultConfig(): PartnersConfig {
  return {
    seed: 42,
    bungae: { advancePerPoll: 1, duplicateRate: 0, rateLimitPerSec: 20, force429Rate: 0, retryAfterSec: 1, delayMs: 0 },
    neurimbo: { advancePerPoll: 1, delayMs: 0, error5xxRate: 0, shuffle: false },
    toktok: { failRate: 0 },
    seum: { shortfall: 0, foreignSerials: 0, error5xxRate: 0 },
  };
}

/** 택배 한 건. polls는 성공한 조회 수(429·5xx는 세지 않는다). */
export interface Parcel {
  createdAt: number;
  polls: number;
}

/** 세움전자 발주 한 건과 납품 명세 */
export interface SeumPurchaseOrder {
  poNo: string;
  modelCode: string;
  quantity: number;
  reference: string;
  serials: string[];
}

export interface ToktokMessage {
  channel: string;
  idempotencyKey: string;
  text: string;
  receivedAt: string;
}

export interface Stats {
  /** 엔드포인트별 호출 수(429·5xx 포함) */
  calls: Record<string, number>;
  /** 운송장별 추적 조회 수(429·5xx 포함) */
  perTracking: Record<string, number>;
  /** 429 전체 = status429Limit + status429Forced */
  status429: number;
  /** 초당 한도(rateLimitPerSec)를 넘어서 낸 429 */
  status429Limit: number;
  /** force429Rate 난수로 낸 429 */
  status429Forced: number;
  status5xx: number;
  /** 같은 운송장 조회가 처리 중일 때 또 들어온 횟수 */
  overlaps: number;
  /** 같은 운송장 동시 처리 수의 최댓값 */
  maxInFlight: number;
  /** 지금 처리 중인 번개 추적 조회 수(운송장 구분 없이 전체) */
  inFlightTotal: number;
  /** 운송장 구분 없이 동시에 처리한 번개 추적 조회 수의 최댓값. 1보다 크면 실제로 겹쳐 돌았다는 뜻 */
  maxInFlightTotal: number;
}

function emptyStats(): Stats {
  return { calls: {}, perTracking: {}, status429: 0, status429Limit: 0, status429Forced: 0, status5xx: 0, overlaps: 0, maxInFlight: 0, inFlightTotal: 0, maxInFlightTotal: 0 };
}

/** 가상 업체 서버의 메모리 상태. 재시작하거나 reset하면 모두 사라진다. */
export class PartnersState {
  config: PartnersConfig = defaultConfig();
  rng = createRng(this.config.seed);
  /** 번호 앞부분. 서버를 다시 띄워도 이전 번호와 겹치지 않게 시작 시각을 쓴다. */
  epoch = Date.now();
  seq = 0;
  bungae = new Map<string, Parcel>();
  neurimbo = new Map<string, Parcel>();
  seum = new Map<string, SeumPurchaseOrder>();
  /** 번개 추적 조회가 받아들여진 시각(최근 1초) */
  bungaeWindow: number[] = [];
  messages: ToktokMessage[] = [];
  stats: Stats = emptyStats();
  private inFlight = new Map<string, number>();

  reset(): void {
    this.config = defaultConfig();
    this.rng = createRng(this.config.seed);
    this.epoch = Date.now();
    this.seq = 0;
    this.bungae.clear();
    this.neurimbo.clear();
    this.seum.clear();
    this.bungaeWindow = [];
    this.messages = [];
    this.stats = emptyStats();
    this.inFlight.clear();
  }

  /** 부분 병합. seed를 주면 난수를 그 시드로 다시 시작한다. */
  configure(patch: ConfigPatch): PartnersConfig {
    this.config = {
      seed: patch.seed ?? this.config.seed,
      bungae: { ...this.config.bungae, ...patch.bungae },
      neurimbo: { ...this.config.neurimbo, ...patch.neurimbo },
      toktok: { ...this.config.toktok, ...patch.toktok },
      seum: { ...this.config.seum, ...patch.seum },
    };
    if (patch.seed !== undefined) this.rng = createRng(patch.seed);
    return this.config;
  }

  /** 확률 p로 true. p가 0이면 난수를 쓰지 않는다(다른 설정의 난수 순서를 흔들지 않게). */
  chance(p: number): boolean {
    return p > 0 && this.rng() < p;
  }

  nextNumber(): string {
    this.seq += 1;
    return `${this.epoch}${String(this.seq).padStart(4, '0')}`;
  }

  count(endpoint: string, trackingNo?: string): void {
    this.stats.calls[endpoint] = (this.stats.calls[endpoint] ?? 0) + 1;
    if (trackingNo) this.stats.perTracking[trackingNo] = (this.stats.perTracking[trackingNo] ?? 0) + 1;
  }

  begin(trackingNo: string): void {
    const n = (this.inFlight.get(trackingNo) ?? 0) + 1;
    if (n > 1) this.stats.overlaps += 1;
    this.stats.maxInFlight = Math.max(this.stats.maxInFlight, n);
    this.inFlight.set(trackingNo, n);
    this.stats.inFlightTotal += 1;
    this.stats.maxInFlightTotal = Math.max(this.stats.maxInFlightTotal, this.stats.inFlightTotal);
  }

  end(trackingNo: string): void {
    const n = (this.inFlight.get(trackingNo) ?? 1) - 1;
    if (n <= 0) this.inFlight.delete(trackingNo);
    else this.inFlight.set(trackingNo, n);
    this.stats.inFlightTotal = Math.max(0, this.stats.inFlightTotal - 1);
  }
}
```

`apps/partners/src/server.ts` 전체(세움 라우트 2개):
```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { bungaeCreateWaybill, bungaeTrack } from './bungae.js';
import { BadJsonError, readJson, sendJson } from './http.js';
import { neurimboCreateInvoice, neurimboTrack } from './neurimbo.js';
import { seumCreatePurchaseOrder, seumDeliveryNote } from './seum.js';
import { PartnersState, type ConfigPatch } from './state.js';
import { toktokHook, toktokSummary } from './toktok.js';

async function route(state: PartnersState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://partners');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  let m: RegExpMatchArray | null;

  // 관리 API: 테스트·실험이 설정을 바꾸고 결과를 센다.
  if (method === 'GET' && path === '/__admin/health') return sendJson(res, 200, { status: 'ok' });
  if (method === 'POST' && path === '/__admin/reset') {
    state.reset();
    return sendJson(res, 200, state.config);
  }
  if (method === 'POST' && path === '/__admin/config') {
    const patch = (await readJson(req)) as ConfigPatch | undefined;
    return sendJson(res, 200, state.configure(patch ?? {}));
  }
  if (method === 'GET' && path === '/__admin/stats') return sendJson(res, 200, state.stats);
  if (method === 'GET' && path === '/__admin/toktok/messages') return sendJson(res, 200, toktokSummary(state));

  // 번개택배(JSON)
  if (method === 'POST' && path === '/bungae/v1/waybills') return bungaeCreateWaybill(state, req, res);
  if (method === 'GET' && (m = path.match(/^\/bungae\/v1\/trackings\/([^/]+)$/))) {
    return bungaeTrack(state, decodeURIComponent(m[1]), res);
  }

  // 느림보물류(XML)
  if (method === 'POST' && path === '/neurimbo/api/invoice') return neurimboCreateInvoice(state, req, res);
  if (method === 'GET' && path === '/neurimbo/api/track') return neurimboTrack(state, url.searchParams.get('invoiceNo') ?? '', res);

  // 세움전자(공장): 발주, 납품 명세
  if (method === 'POST' && path === '/seum/v1/purchase-orders') return seumCreatePurchaseOrder(state, req, res);
  if (method === 'GET' && (m = path.match(/^\/seum\/v1\/purchase-orders\/([^/]+)\/delivery-note$/))) {
    return seumDeliveryNote(state, decodeURIComponent(m[1]), res);
  }

  // 톡톡메신저 웹훅
  if (method === 'POST' && (m = path.match(/^\/toktok\/hooks\/([^/]+)$/))) {
    return toktokHook(state, decodeURIComponent(m[1]), req, res);
  }

  sendJson(res, 404, { error: 'NO_ROUTE', method, path });
}

/** 가상 업체 서버. 상태는 메모리에만 있다. */
export function createPartnersServer(state = new PartnersState()): { server: Server; state: PartnersState } {
  const server = createServer((req, res) => {
    route(state, req, res).catch((error: unknown) => {
      if (error instanceof BadJsonError && !res.headersSent) return sendJson(res, 400, { error: 'BAD_REQUEST', message: error.message });
      if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL', message: String(error) });
      else res.end();
    });
  });
  return { server, state };
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: 5개 파일 `39 passed`, typecheck·build exit 0

- [ ] **Step 5: 기록과 커밋**

`docs/decisions/0009-가상-업체-서버는-node-http-별도-프로세스.md` 끝에 한 줄:
```
- 갱신(2026-10-23 Day 3): 세움전자(공장)를 같은 서버에 더했다. 납품 명세는 발주 때 정해 두고(조회마다 같다), 다른 발주 시리얼이 섞이는 자리는 시드 난수로 재현한다.
```

devlog 항목(테스트 수, 골칫거리 3개). 커밋:
```bash
git add apps/partners docs
git commit -m "feat(F10): 가상 세움전자 발주와 납품 명세" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 발주 엔티티와 발주 API — 공장 호출은 트랜잭션 밖 (F10)

**Files:**
- Create: `apps/api/src/purchase-order/purchase-order.entity.ts`, `seum.client.ts`, `purchase-order.service.ts`, `purchase-order.controller.ts`, `purchase-order.views.ts`, `purchase-order.module.ts`, `dto/create-purchase-order.dto.ts`
- Modify: `apps/api/src/entities.ts`, `apps/api/src/app.module.ts`
- Create: `apps/api/src/migrations/Migration<시각>.ts`(생성 명령)
- Test: `apps/api/test/purchase-order.e2e.spec.ts`
- Record: devlog, `docs/study/backlog.md`

`POST /purchase-orders { modelCode, quantity }`(X-Operator 필수): 모델 확인(없으면 404, 공장 호출 없음) → 트랜잭션 밖에서 세움 발주 → 받은 `poNo`로 저장(ORDERED). 세움 오류는 기존 `partnerFetch` 분류 그대로 502 `PARTNER_ERROR`. 납품 명세(`deliveryNote`)는 이때 받지 않고 입고를 시작할 때 받는다(Task 5). `GET /purchase-orders/:poNo`.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/purchase-order.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PurchaseOrder, PurchaseOrderStatus } from '../src/purchase-order/purchase-order.entity.js';
import { partners } from './helpers/partners.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'jung' };

describe('발주 (F10)', () => {
  let t: TestApp;
  const factoryCalls = async () => (await partners.stats()).calls['seum.purchaseOrder'] ?? 0;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('발주하면 세움전자에 발주하고 그 발주번호로 저장한다(ORDERED)', async () => {
    const res = await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-100', quantity: 20 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ modelCode: 'SN-100', quantity: 20, status: 'ORDERED', orderedBy: 'jung', closedAt: null });
    expect(res.body.poNo).toMatch(/^SE\d+$/);
    expect(await factoryCalls()).toBe(1);

    const saved = await t.orm.em.fork().findOneOrFail(PurchaseOrder, { poNo: res.body.poNo });
    expect(saved.status).toBe(PurchaseOrderStatus.ORDERED);
    expect(saved.deliveryNote).toBeNull(); // 명세는 입고를 시작할 때 받아 온다

    const got = await t.http().get(`/purchase-orders/${res.body.poNo}`);
    expect(got.status).toBe(200);
    // createdAt은 DB datetime(초 단위)로 저장돼 응답과 밀리초가 다를 수 있어 비교에서 뺀다.
    expect({ ...got.body, createdAt: undefined }).toEqual({ ...res.body, createdAt: undefined });
  });

  it('없는 모델이면 404이고 공장을 부르지 않는다', async () => {
    const res = await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-999', quantity: 5 });
    expect(res.status).toBe(404);
    expect(await factoryCalls()).toBe(0);
  });

  it('공장이 503이면 502 PARTNER_ERROR, 발주는 저장하지 않는다', async () => {
    await partners.configure({ seum: { error5xxRate: 1 } });
    const before = await t.orm.em.fork().count(PurchaseOrder);
    const res = await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-100', quantity: 5 });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'PARTNER_ERROR', reason: 'PartnerTransientError' });
    expect(await t.orm.em.fork().count(PurchaseOrder)).toBe(before);
  });

  it('수량은 1~5000, 작업자 헤더 필수', async () => {
    expect((await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-100', quantity: 0 })).status).toBe(400);
    expect((await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-100', quantity: 5001 })).status).toBe(400);
    expect((await t.http().post('/purchase-orders').send({ modelCode: 'SN-100', quantity: 1 })).status).toBe(400);
  });

  it('없는 발주번호는 404', async () => {
    expect((await t.http().get('/purchase-orders/SE0')).status).toBe(404);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/purchase-order.e2e.spec.ts`
Expected: FAIL — `../src/purchase-order/purchase-order.entity.js`를 찾지 못해 파일 로드 실패

- [ ] **Step 3: 엔티티와 세움 클라이언트**

`apps/api/src/purchase-order/purchase-order.entity.ts`:
```ts
import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TerminalModel } from '../terminal/terminal-model.entity.js';

export enum PurchaseOrderStatus {
  ORDERED = 'ORDERED', // 공장에 발주함
  RECEIVING = 'RECEIVING', // 입고 스캔을 시작함
  CLOSED = 'CLOSED', // 마감. 더는 입고 스캔을 받지 않는다
}

/** 세움전자(가상 공장)에 낸 발주. 발주번호(poNo)는 공장이 정한다. */
@Entity({ tableName: 'purchase_order' })
export class PurchaseOrder {
  [OptionalProps]?: 'status' | 'deliveryNote' | 'createdAt' | 'closedAt';

  @PrimaryKey()
  id!: number;

  @Property({ unique: true, length: 30 })
  poNo!: string;

  @ManyToOne(() => TerminalModel)
  model!: Rel<TerminalModel>;

  @Property()
  quantity!: number;

  @Enum({ items: () => PurchaseOrderStatus })
  status: PurchaseOrderStatus = PurchaseOrderStatus.ORDERED;

  /** 공장이 보낸 납품 명세(시리얼 목록). 입고를 시작할 때 받아 와 저장한다. 아직 안 받았으면 null */
  @Property({ type: 'json', nullable: true })
  deliveryNote: string[] | null = null;

  @Property({ length: 50 })
  orderedBy!: string;

  @Property()
  createdAt: Date = new Date();

  // 유니온 타입(Date | null)은 데코레이터 메타데이터가 Object라 type을 꼭 적는다.
  @Property({ type: 'datetime', nullable: true })
  closedAt: Date | null = null;
}
```

`apps/api/src/purchase-order/seum.client.ts`:
```ts
import { partnerFetch } from '../common/partner-http.js';
import { PartnerPermanentError } from '../common/partner-errors.js';

export interface SeumOptions {
  baseUrl: string;
  timeoutMs: number;
}

export interface DeliveryNote {
  poNo: string;
  serials: string[];
}

function parseObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PartnerPermanentError('세움전자 응답이 JSON 객체가 아닙니다.');
  }
  return value as Record<string, unknown>;
}

/** 세움전자(가상 공장) API. 오류 분류는 택배사와 같은 partnerFetch를 쓴다(decisions/0010). */
export class SeumClient {
  constructor(private readonly opts: SeumOptions) {}

  /** 발주하고 공장이 정한 발주번호를 돌려준다. */
  async createPurchaseOrder(input: { modelCode: string; quantity: number; reference: string }): Promise<string> {
    const body = parseObject(
      await partnerFetch(
        '세움전자 발주',
        `${this.opts.baseUrl}/seum/v1/purchase-orders`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
        this.opts.timeoutMs,
      ),
    );
    if (typeof body.poNo !== 'string' || !body.poNo) throw new PartnerPermanentError('세움전자 발주 응답에 poNo가 없습니다.');
    return body.poNo;
  }

  /** 납품 명세(공장이 보낸다고 한 시리얼 목록) */
  async getDeliveryNote(poNo: string): Promise<DeliveryNote> {
    const body = parseObject(
      await partnerFetch(
        '세움전자 납품 명세',
        `${this.opts.baseUrl}/seum/v1/purchase-orders/${encodeURIComponent(poNo)}/delivery-note`,
        { method: 'GET' },
        this.opts.timeoutMs,
      ),
    );
    const serials = body.serials;
    if (!Array.isArray(serials) || !serials.every((s) => typeof s === 'string')) {
      throw new PartnerPermanentError('세움전자 납품 명세에 serials 배열이 없습니다.');
    }
    return { poNo, serials };
  }
}
```

`apps/api/src/entities.ts` 전체:
```ts
import { TerminalModel } from './terminal/terminal-model.entity.js';
import { Terminal } from './terminal/terminal.entity.js';
import { TerminalStatusHistory } from './terminal/terminal-status-history.entity.js';
import { InspectionItem } from './inspection/inspection-item.entity.js';
import { Inspection, InspectionResult } from './inspection/inspection.entities.js';
import { Merchant } from './merchant/merchant.entity.js';
import { CarrierEvent, Shipment, SyncRun } from './shipment/shipment.entities.js';
import { OutboxEvent } from './outbox/outbox-event.entity.js';
import { PurchaseOrder } from './purchase-order/purchase-order.entity.js';

/** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder];
```

- [ ] **Step 4: 서비스·API·모듈**

`apps/api/src/purchase-order/dto/create-purchase-order.dto.ts`:
```ts
import { IsInt, IsString, Max, Min, MinLength } from 'class-validator';

export class CreatePurchaseOrderDto {
  @IsString()
  @MinLength(1)
  modelCode!: string;

  /** 세움전자가 한 번에 받는 상한(5000)과 같다 */
  @IsInt()
  @Min(1)
  @Max(5000)
  quantity!: number;
}
```

`apps/api/src/purchase-order/purchase-order.views.ts`:
```ts
import type { PurchaseOrder } from './purchase-order.entity.js';

/** model이 populate돼 있어야 한다. */
export function toPurchaseOrderView(po: PurchaseOrder) {
  return {
    poNo: po.poNo,
    modelCode: po.model.code,
    quantity: po.quantity,
    status: po.status,
    orderedBy: po.orderedBy,
    createdAt: po.createdAt.toISOString(),
    closedAt: po.closedAt?.toISOString() ?? null,
  };
}
```

`apps/api/src/purchase-order/purchase-order.service.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { TerminalModel } from '../terminal/terminal-model.entity.js';
import type { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto.js';
import { PurchaseOrder } from './purchase-order.entity.js';
import { SeumClient } from './seum.client.js';

@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly em: EntityManager,
    private readonly seum: SeumClient,
  ) {}

  /**
   * 발주: ① 모델 확인 ② 트랜잭션 밖에서 세움전자에 발주(HTTP) ③ 받은 발주번호로 저장.
   * ③이 실패하면 공장 쪽에 발주가 남는다(운송장과 같은 한계, decisions/0012). 확인할 수 있는 실패(없는 모델)는 ①에서 거른다.
   */
  async create(dto: CreatePurchaseOrderDto, actor: string): Promise<PurchaseOrder> {
    const model = await this.em.findOne(TerminalModel, { code: dto.modelCode });
    if (!model) throw new NotFoundException(`단말기 모델 ${dto.modelCode}이(가) 없습니다.`);

    const poNo = await this.seum.createPurchaseOrder({ modelCode: model.code, quantity: dto.quantity, reference: randomUUID() });

    const po = this.em.create(PurchaseOrder, { poNo, model, quantity: dto.quantity, orderedBy: actor });
    await this.em.flush();
    return po;
  }

  async get(poNo: string): Promise<PurchaseOrder> {
    const po = await this.em.findOne(PurchaseOrder, { poNo }, { populate: ['model'] });
    if (!po) throw new NotFoundException(`발주 ${poNo}이(가) 없습니다.`);
    return po;
  }
}
```

`apps/api/src/purchase-order/purchase-order.controller.ts`:
```ts
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto.js';
import { PurchaseOrderService } from './purchase-order.service.js';
import { toPurchaseOrderView } from './purchase-order.views.js';

@Controller('purchase-orders')
export class PurchaseOrderController {
  constructor(private readonly orders: PurchaseOrderService) {}

  @Post()
  async create(@Body() dto: CreatePurchaseOrderDto, @Operator() actor: string) {
    return toPurchaseOrderView(await this.orders.create(dto, actor));
  }

  @Get(':poNo')
  async get(@Param('poNo') poNo: string) {
    return toPurchaseOrderView(await this.orders.get(poNo));
  }
}
```

`apps/api/src/purchase-order/purchase-order.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { env } from '../config/env.js';
import { PurchaseOrderController } from './purchase-order.controller.js';
import { PurchaseOrderService } from './purchase-order.service.js';
import { SeumClient } from './seum.client.js';

@Module({
  controllers: [PurchaseOrderController],
  providers: [
    PurchaseOrderService,
    // 설정값(문자열·숫자)을 생성자로 받으므로 팩토리로 만든다(CarrierModule과 같은 방식).
    { provide: SeumClient, useFactory: () => new SeumClient({ baseUrl: env.partnersUrl, timeoutMs: env.partnerTimeoutMs }) },
  ],
  exports: [PurchaseOrderService, SeumClient],
})
export class PurchaseOrderModule {}
```

`apps/api/src/app.module.ts` 전체(`PurchaseOrderModule` import):
```ts
import { type DynamicModule, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import ormConfig from './mikro-orm.config.js';
import { HealthController } from './health/health.controller.js';
import { DomainExceptionFilter } from './common/domain-exception.filter.js';
import { TerminalModule } from './terminal/terminal.module.js';
import { InspectionModule } from './inspection/inspection.module.js';
import { MerchantModule } from './merchant/merchant.module.js';
import { ShipmentModule } from './shipment/shipment.module.js';
import { QueuesModule } from './queue/queues.module.js';
import { CarrierSyncModule } from './carrier-sync/carrier-sync.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { PurchaseOrderModule } from './purchase-order/purchase-order.module.js';
import { WorkersModule } from './workers/workers.module.js';
import { SchedulerModule } from './scheduler/scheduler.module.js';

export interface AppOptions {
  /** 큐 job을 처리할지(RUN_WORKERS) */
  workers?: boolean;
  /** 주기 작업을 등록할지(RUN_SCHEDULERS) */
  schedulers?: boolean;
}

@Module({
  // forRoot가 요청마다 EntityManager를 fork하는 RequestContext 미들웨어를 자동 등록한다.
  imports: [
    MikroOrmModule.forRoot(ormConfig),
    QueuesModule,
    TerminalModule,
    InspectionModule,
    MerchantModule,
    ShipmentModule,
    CarrierSyncModule,
    OutboxModule,
    PurchaseOrderModule,
  ],
  controllers: [HealthController],
  providers: [
    // main.ts의 useGlobalPipes/Filters는 테스트 앱에 적용되지 않는다. 모듈 provider로 등록해 테스트에서도 같게 동작시킨다.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {
  /** 실행 모드에 따라 워커·스케줄러를 붙인다. `imports: [AppModule]`만 쓰면 둘 다 없다(decisions/0015). */
  static forRoot(options: AppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [...(options.workers ? [WorkersModule] : []), ...(options.schedulers ? [SchedulerModule] : [])],
    };
  }
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run && npm run typecheck`
Expected: 18개 파일 `132 passed`, typecheck exit 0. (처음 써 볼 때 GET 응답과 POST 응답을 `toEqual`로 비교하면 `createdAt`의 밀리초가 달라 실패한다 — DB datetime은 초 단위. 테스트는 그래서 `createdAt`을 빼고 비교한다.)

- [ ] **Step 6: 마이그레이션**

Run: `npm run db:migration:create`
Expected: up()이 다음과 같다(`closed_at`이 `datetime null`인지 본다).
```ts
    this.addSql(`create table \`purchase_order\` (\`id\` int unsigned not null auto_increment primary key, \`po_no\` varchar(30) not null, \`model_id\` int unsigned not null, \`quantity\` int not null, \`status\` enum('ORDERED','RECEIVING','CLOSED') not null default 'ORDERED', \`delivery_note\` json null, \`ordered_by\` varchar(50) not null, \`created_at\` datetime not null, \`closed_at\` datetime null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`purchase_order\` add unique \`purchase_order_po_no_unique\` (\`po_no\`);`);
    this.addSql(`alter table \`purchase_order\` add index \`purchase_order_model_id_index\` (\`model_id\`);`);

    this.addSql(`alter table \`purchase_order\` add constraint \`purchase_order_model_id_foreign\` foreign key (\`model_id\`) references \`terminal_model\` (\`id\`);`);
```
Run:
```bash
npm run db:migrate
npm run db:migration:check
```
Expected: `적용: Migration<시각>`, `최신 상태`

- [ ] **Step 7: 기록과 커밋**

devlog 항목. `docs/study/backlog.md`에 추가:
```
- [ ] 외부 업체 발주의 멱등 — reference를 고정 키로 보내 재시도해도 발주가 하나만 생기게 (purchase-order.service.ts, decisions/0012)
- [ ] MySQL datetime 정밀도(초)와 JS Date 밀리초 — 저장 후 다시 읽으면 값이 다른 이유 (purchase-order.e2e.spec.ts)
```

커밋:
```bash
git add apps/api docs
git commit -m "feat(F10): 발주 엔티티와 세움전자 발주 API" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 일괄 등록 엔진 — 조회 2번, 행별 결과, 한 트랜잭션 (F1·F6)

**Files:**
- Create: `apps/api/src/terminal/bulk-rows.ts`(형식 규칙·결과 코드·사전 검사), `apps/api/src/terminal/bulk-registration.service.ts`, `apps/api/src/common/retry-on-unique.ts`
- Modify: `apps/api/src/terminal/transition.service.ts`(`recordRegistration`에 사유 인자), `apps/api/src/terminal/terminal.module.ts`, `apps/api/src/terminal/dto/register-terminal.dto.ts`(형식 규칙 공유)
- Test: `apps/api/test/unit/bulk-rows.spec.ts`, `apps/api/test/bulk-registration.e2e.spec.ts`, `apps/api/test/helpers/query-log.ts`
- Record: devlog, `docs/decisions/0019-일괄-처리는-행별-결과와-한-트랜잭션.md`, `docs/study/backlog.md`

엔진은 HTTP를 모른다. 박스 스캔(Task 5)과 엑셀(Task 6)이 이것을 부른다.
1. 메모리에서: 형식(INVALID_FORMAT), 같은 요청 안 중복(두 번째부터 DUPLICATE_IN_REQUEST)
2. 조회 1: `terminal_model WHERE code IN (…)` → UNKNOWN_MODEL
3. 조회 2: `SELECT serial_no FROM terminal WHERE serial_no IN (…)`(QueryBuilder, 엔티티를 만들지 않는다) → ALREADY_EXISTS
4. 남은 행을 **시리얼 순서로** `create` + `recordRegistration`(이력·Outbox) → flush 때 다중 행 INSERT
5. `register()`는 자기 트랜잭션을 열고, 다른 요청과 겹쳐 unique 위반이 나면 처음부터 1회 다시 한다(그때는 3에서 ALREADY_EXISTS). 트랜잭션에 합류해야 하는 호출자(박스 스캔)는 `registerMany(tx, …)`를 쓴다.

쿼리 수는 `test/helpers/query-log.ts`가 MikroORM 연결의 `logQuery`를 감싸 센다(debug 설정과 상관없이 모든 SQL이 거친다).

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/unit/bulk-rows.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { precheckSerials, summarize } from '../../src/terminal/bulk-rows.js';

describe('precheckSerials', () => {
  it('통과한 행은 null, 결과는 입력 순서 그대로', () => {
    expect(precheckSerials(['A-0001', 'A-0002'])).toEqual([null, null]);
  });

  it('형식이 틀리면 INVALID_FORMAT', () => {
    const [lower, short, space] = precheckSerials(['a-0001', 'AB', 'A 0001']);
    expect(lower?.result).toBe('INVALID_FORMAT');
    expect(short?.result).toBe('INVALID_FORMAT');
    expect(space?.result).toBe('INVALID_FORMAT');
  });

  it('같은 요청에 같은 시리얼이 또 나오면 두 번째부터 DUPLICATE_IN_REQUEST', () => {
    const r = precheckSerials(['A-0001', 'A-0002', 'A-0001', 'A-0001']);
    expect(r.map((x) => x?.result ?? null)).toEqual([null, null, 'DUPLICATE_IN_REQUEST', 'DUPLICATE_IN_REQUEST']);
  });

  it('형식이 틀린 행은 중복 판단에 쓰지 않는다', () => {
    expect(precheckSerials(['bad', 'bad']).map((x) => x?.result)).toEqual(['INVALID_FORMAT', 'INVALID_FORMAT']);
  });
});

describe('summarize', () => {
  it('결과 코드별로 센다', () => {
    expect(
      summarize([
        { serialNo: 'A', result: 'CREATED' },
        { serialNo: 'B', result: 'CREATED' },
        { serialNo: 'C', result: 'ALREADY_EXISTS' },
      ]),
    ).toEqual({ CREATED: 2, ALREADY_EXISTS: 1 });
  });
});
```

`apps/api/test/helpers/query-log.ts`:
```ts
import type { MikroORM } from '@mikro-orm/mysql';

interface LoggingConnection {
  logQuery(query: string, context?: unknown): void;
}

/**
 * MikroORM이 보내는 SQL을 센다(begin·commit 포함). 연결 객체의 logQuery를 잠깐 감싼다 — debug 설정과 상관없이
 * 모든 쿼리가 이 함수를 거친다(@mikro-orm/core Connection.executeQuery). 다 쓰면 stop()으로 되돌린다.
 */
export function captureQueries(orm: MikroORM) {
  const conn = orm.em.getConnection() as unknown as LoggingConnection;
  const original = conn.logQuery;
  const queries: string[] = [];
  conn.logQuery = function (query: string, context?: unknown) {
    queries.push(query);
    return original.call(this, query, context);
  };
  return {
    queries,
    /** select로 시작하는 쿼리 수 */
    selects: () => queries.filter((q) => /^select /i.test(q)).length,
    stop: () => {
      conn.logQuery = original;
    },
  };
}
```

`apps/api/test/bulk-registration.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxEvent } from '../src/outbox/outbox-event.entity.js';
import { BulkRegistrationService, type BulkRegisterRow } from '../src/terminal/bulk-registration.service.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { TransitionSource } from '../src/terminal/terminal-status.js';
import { captureQueries } from './helpers/query-log.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const ctx = { actor: 'bulk-tester', source: TransitionSource.IMPORT };
const rowsOf = (prefix: string, n: number, modelCode = 'SN-100'): BulkRegisterRow[] =>
  Array.from({ length: n }, (_, i) => ({ serialNo: `${prefix}-${String(i + 1).padStart(4, '0')}`, modelCode }));

describe('일괄 등록 엔진 (F1·F6, decisions/0019)', () => {
  let t: TestApp;
  let bulk: BulkRegistrationService;
  const em = () => t.orm.em.fork();

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    bulk = t.app.get(BulkRegistrationService);
    await t.http().post('/terminals').set({ 'X-Operator': 'kim' }).send({ serialNo: 'BK-EXIST', modelCode: 'SN-100' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('행별 결과: 유효한 행만 만들고 나머지는 이유를 준다(입력 순서 그대로)', async () => {
    const results = await bulk.register(
      [
        { serialNo: 'BK-0001', modelCode: 'SN-100' },
        { serialNo: 'bk-bad', modelCode: 'SN-100' },
        { serialNo: 'BK-EXIST', modelCode: 'SN-100' },
        { serialNo: 'BK-0002', modelCode: 'SN-999' },
        { serialNo: 'BK-0001', modelCode: 'SN-100' },
        { serialNo: 'BK-0003', modelCode: 'SN-200' },
      ],
      ctx,
    );
    expect(results.map((r) => [r.serialNo, r.result])).toEqual([
      ['BK-0001', 'CREATED'],
      ['bk-bad', 'INVALID_FORMAT'],
      ['BK-EXIST', 'ALREADY_EXISTS'],
      ['BK-0002', 'UNKNOWN_MODEL'],
      ['BK-0001', 'DUPLICATE_IN_REQUEST'],
      ['BK-0003', 'CREATED'],
    ]);
    const created = await em().find(Terminal, { serialNo: { $in: ['BK-0001', 'BK-0003'] } }, { populate: ['model'] });
    expect(created.map((c) => [c.serialNo, c.model.code, c.status]).sort()).toEqual([
      ['BK-0001', 'SN-100', 'RECEIVED'],
      ['BK-0003', 'SN-200', 'RECEIVED'],
    ]);
  });

  it('만든 단말기마다 등록 이력과 알림(Outbox)이 같은 트랜잭션에 남는다', async () => {
    const history = await em().find(TerminalStatusHistory, { terminal: { serialNo: 'BK-0003' } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: null, toStatus: 'RECEIVED', source: 'IMPORT', actor: 'bulk-tester', reason: '신규 등록' });
    const outbox = await em().find(OutboxEvent, {});
    expect(outbox.filter((o) => (o.payload as { serialNo: string }).serialNo === 'BK-0003')).toHaveLength(1);
  });

  it('조회 수는 행 수와 상관없다(N+1 없음): 10행과 200행의 select 수가 같다', async () => {
    const small = captureQueries(t.orm);
    await bulk.register(rowsOf('NQ-A', 10), ctx);
    small.stop();
    const large = captureQueries(t.orm);
    await bulk.register(rowsOf('NQ-B', 200), ctx);
    large.stop();
    console.log(`[일괄 등록 쿼리] 10행: 전체 ${small.queries.length} select ${small.selects()} / 200행: 전체 ${large.queries.length} select ${large.selects()}`);
    expect(large.selects()).toBe(small.selects());
    expect(large.queries.length).toBeLessThan(30);
    expect(await em().count(Terminal, { serialNo: { $like: 'NQ-B-%' } })).toBe(200);
  });

  it('같은 시리얼이 겹친 두 요청이 동시에 와도 각 시리얼은 한 번만 만들어진다(unique 위반이면 한 번 다시)', async () => {
    const a = rowsOf('CO', 60).slice(0, 40); // CO-0001 ~ CO-0040
    const b = rowsOf('CO', 60).slice(20); // CO-0021 ~ CO-0060
    const [ra, rb] = await Promise.all([bulk.register(a, ctx), bulk.register(b, ctx)]);
    const createdBy = new Map<string, number>();
    for (const r of [...ra, ...rb]) if (r.result === 'CREATED') createdBy.set(r.serialNo, (createdBy.get(r.serialNo) ?? 0) + 1);
    const overlapResults = [...ra.slice(20), ...rb.slice(0, 20)].map((r) => r.result).sort();
    console.log(`[겹친 동시 등록] A 생성 ${ra.filter((r) => r.result === 'CREATED').length}, B 생성 ${rb.filter((r) => r.result === 'CREATED').length}`);
    expect(createdBy.size).toBe(60);
    expect([...createdBy.values()].every((n) => n === 1)).toBe(true);
    expect(overlapResults.filter((r) => r === 'ALREADY_EXISTS')).toHaveLength(20);
    expect(await em().count(Terminal, { serialNo: { $like: 'CO-%' } })).toBe(60);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit/bulk-rows.spec.ts test/bulk-registration.e2e.spec.ts`
Expected: FAIL — `bulk-rows.js`, `bulk-registration.service.js`를 찾지 못해 두 파일 모두 로드 실패

- [ ] **Step 3: 행 규칙과 엔진**

`apps/api/src/terminal/bulk-rows.ts`:
```ts
/** 시리얼 형식: 대문자·숫자·하이픈 4~32자. 단건 등록 DTO와 일괄 처리가 같은 규칙을 쓴다. */
export const SERIAL_NO_PATTERN = /^[A-Z0-9-]{4,32}$/;
export const SERIAL_NO_MESSAGE = 'serialNo는 대문자·숫자·하이픈 4~32자입니다.';

/**
 * 일괄 처리(박스 스캔·엑셀 등록)의 행별 결과 코드.
 * 성공: CREATED(신규 등록), RETURNED(회수 입고). 나머지는 그 행만 반영하지 않은 이유다(decisions/0019).
 */
export type RowResultCode =
  | 'CREATED'
  | 'RETURNED'
  | 'INVALID_FORMAT'
  | 'DUPLICATE_IN_REQUEST'
  | 'UNKNOWN_MODEL'
  | 'ALREADY_EXISTS'
  | 'NOT_IN_DELIVERY_NOTE'
  | 'NOT_FOUND'
  | 'INVALID_STATE';

export interface RowResult {
  serialNo: string;
  result: RowResultCode;
  message?: string;
}

/**
 * DB를 보지 않고 거를 수 있는 행을 고른다. 결과 배열은 입력과 같은 순서이고, 통과한 행은 null이다.
 * - 형식이 틀리면 INVALID_FORMAT
 * - 같은 요청에 같은 시리얼이 또 나오면 두 번째부터 DUPLICATE_IN_REQUEST(첫 번째만 처리한다)
 */
export function precheckSerials(serials: string[]): (RowResult | null)[] {
  const seen = new Set<string>();
  return serials.map((serialNo) => {
    if (!SERIAL_NO_PATTERN.test(serialNo)) return { serialNo, result: 'INVALID_FORMAT', message: SERIAL_NO_MESSAGE };
    if (seen.has(serialNo)) return { serialNo, result: 'DUPLICATE_IN_REQUEST', message: '같은 요청에 이미 있는 시리얼입니다.' };
    seen.add(serialNo);
    return null;
  });
}

/** 결과 코드별 개수 */
export function summarize(results: RowResult[]): Partial<Record<RowResultCode, number>> {
  const summary: Partial<Record<RowResultCode, number>> = {};
  for (const r of results) summary[r.result] = (summary[r.result] ?? 0) + 1;
  return summary;
}
```

`apps/api/src/common/retry-on-unique.ts`:
```ts
import { UniqueConstraintViolationException } from '@mikro-orm/mysql';

/**
 * unique 위반이면 처음부터 한 번 더 한다. 일괄 등록은 "기존 시리얼 조회 → INSERT" 사이에 다른 요청이 같은 시리얼을 먼저
 * 넣을 수 있다. 다시 하면 조회에서 ALREADY_EXISTS로 걸러진다(decisions/0019). fn은 매번 새 트랜잭션을 열어야 한다.
 */
export async function retryOnUniqueViolation<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof UniqueConstraintViolationException) || attempt >= attempts) throw error;
    }
  }
}
```

`apps/api/src/terminal/bulk-registration.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { retryOnUniqueViolation } from '../common/retry-on-unique.js';
import { precheckSerials, type RowResult } from './bulk-rows.js';
import { TerminalModel } from './terminal-model.entity.js';
import { Terminal } from './terminal.entity.js';
import { TransitionSource } from './terminal-status.js';
import { TransitionService } from './transition.service.js';

export interface BulkRegisterRow {
  serialNo: string;
  modelCode: string;
}

export interface BulkRegisterContext {
  actor: string;
  source: TransitionSource;
  /** 이력에 남길 사유. 기본 '신규 등록' */
  reason?: string;
  /** 새 단말기에 함께 넣을 필드(예: 입고된 발주). 상태는 바꾸지 않는다. */
  assign?: (terminal: Terminal) => void;
}

/**
 * 일괄 등록 엔진(F1·F6 공통, decisions/0019).
 * 조회는 행 수와 상관없이 두 번(모델, 기존 시리얼)이고, 유효한 행만 한 트랜잭션에서 만든다. 단말기·이력·Outbox INSERT는
 * flush 때 MikroORM이 테이블별 다중 행 INSERT로 묶는다(batchSize 300).
 */
@Injectable()
export class BulkRegistrationService {
  constructor(
    private readonly em: EntityManager,
    private readonly transitions: TransitionService,
  ) {}

  /** 자기 트랜잭션을 열어 등록한다. 다른 요청과 같은 시리얼이 겹쳐 unique 위반이 나면 한 번 다시 한다. */
  async register(rows: BulkRegisterRow[], ctx: BulkRegisterContext): Promise<RowResult[]> {
    return retryOnUniqueViolation(() => this.em.fork().transactional((tx) => this.registerMany(tx, rows, ctx)));
  }

  /**
   * 열린 트랜잭션(tx) 안에서 행별 결과를 정하고 유효한 행의 엔티티를 만든다(INSERT는 호출자 트랜잭션의 flush·커밋 때).
   * 결과는 입력과 같은 순서다.
   */
  async registerMany(tx: EntityManager, rows: BulkRegisterRow[], ctx: BulkRegisterContext): Promise<RowResult[]> {
    const results = precheckSerials(rows.map((r) => r.serialNo));
    const pending = () => rows.flatMap((row, i) => (results[i] ? [] : [{ row, i }]));

    // 조회 1: 모델(서로 다른 코드만)
    const codes = [...new Set(pending().map(({ row }) => row.modelCode))];
    const models = codes.length ? await tx.find(TerminalModel, { code: { $in: codes } }) : [];
    const modelByCode = new Map(models.map((m) => [m.code, m]));
    for (const { row, i } of pending()) {
      if (!modelByCode.has(row.modelCode)) {
        results[i] = { serialNo: row.serialNo, result: 'UNKNOWN_MODEL', message: `단말기 모델 ${row.modelCode}이(가) 없습니다.` };
      }
    }

    // 조회 2: 이미 있는 시리얼(행마다 findOne 하지 않는다 — N+1 금지)
    const serials = pending().map(({ row }) => row.serialNo);
    const existing = serials.length
      ? await tx.createQueryBuilder(Terminal, 't').select('t.serialNo').where({ serialNo: { $in: serials } }).execute<{ serialNo: string }[]>()
      : [];
    const known = new Set(existing.map((e) => e.serialNo));
    for (const { row, i } of pending()) {
      if (known.has(row.serialNo)) results[i] = { serialNo: row.serialNo, result: 'ALREADY_EXISTS', message: '이미 등록된 시리얼입니다.' };
    }

    // 만들기: 시리얼 순서로 만든다. 같은 시리얼을 넣는 트랜잭션들이 늘 같은 순서로 unique 키를 잡아 서로 엇갈려 기다리지 않게 한다.
    const toCreate = pending().sort((a, b) => (a.row.serialNo < b.row.serialNo ? -1 : 1));
    for (const { row, i } of toCreate) {
      const terminal = tx.create(Terminal, { serialNo: row.serialNo, model: modelByCode.get(row.modelCode)! });
      ctx.assign?.(terminal);
      this.transitions.recordRegistration(terminal, ctx.actor, ctx.source, tx, ctx.reason);
      results[i] = { serialNo: row.serialNo, result: 'CREATED' };
    }
    return results as RowResult[];
  }
}
```

`apps/api/src/terminal/transition.service.ts` 전체(`recordRegistration`의 다섯째 인자 `reason`, 기본 '신규 등록'):
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { InvalidTransitionError } from '../common/domain-errors.js';
import { OUTBOX_TYPE, OutboxEvent } from '../outbox/outbox-event.entity.js';
import { Terminal } from './terminal.entity.js';
import { TerminalStatusHistory } from './terminal-status-history.entity.js';
import { TerminalStatus, TransitionSource } from './terminal-status.js';
import { checkTransition } from './transition-rules.js';

export interface TransitionCommand {
  serialNo: string;
  to: TerminalStatus;
  reason: string;
  actor: string;
  source: TransitionSource;
  /** 사람이 화면을 보고 바꿀 때는 필수. 시스템 작업은 생략할 수 있다(flush 시 version 검사는 그래도 일어난다). */
  expectedVersion?: number;
  /**
   * 상태와 함께 바꿀 단말기 필드(예: 배정 가맹점). 규칙 확인 뒤, UPDATE 전에 적용해 상태 변경과 같은 UPDATE 한 번에 나간다
   * (decisions/0011). 상태(status)는 여기서 바꾸지 않는다.
   */
  mutate?: (terminal: Terminal) => void;
}

/** 단말기 상태를 바꾸는 유일한 경로. 규칙 확인, 상태 변경, 이력 기록을 한 트랜잭션으로 묶는다. */
@Injectable()
export class TransitionService {
  constructor(private readonly em: EntityManager) {}

  /**
   * @param em 이미 열린 트랜잭션에 합류할 때 넘긴다(예: 검수 저장과 같은 트랜잭션).
   */
  async transition(cmd: TransitionCommand, em: EntityManager = this.em): Promise<Terminal> {
    return em.transactional(async (tx) => {
      const terminal = await tx.findOne(Terminal, { serialNo: cmd.serialNo }, { populate: ['model', 'merchant'] });
      if (!terminal) throw new NotFoundException(`단말기 ${cmd.serialNo}이(가) 없습니다.`);

      // 규칙보다 version을 먼저 본다. 낡은 화면에서 온 요청은 "규칙 위반"이 아니라 "충돌"로 알려야 한다.
      if (cmd.expectedVersion !== undefined) {
        await tx.lock(terminal, LockMode.OPTIMISTIC, cmd.expectedVersion);
      }

      const check = checkTransition(terminal.status, cmd.to, cmd.source, {
        requiresReinspection: terminal.model.requiresReinspection,
      });
      if (!check.ok) throw new InvalidTransitionError(check.reason);

      const from = terminal.status;
      terminal.status = cmd.to;
      cmd.mutate?.(terminal);
      // version 검사 UPDATE를 이력 INSERT보다 먼저 보낸다. INSERT가 먼저면 FK 검사의 공유 락끼리 엉켜 데드락이 난다(troubleshooting/0004).
      await tx.flush();
      tx.create(TerminalStatusHistory, {
        terminal,
        fromStatus: from,
        toStatus: cmd.to,
        source: cmd.source,
        actor: cmd.actor,
        reason: cmd.reason,
      });
      this.recordOutbox(tx, terminal, from, cmd);
      return terminal;
    });
  }

  /**
   * 새로 만든 단말기의 첫 이력(null → 현재 상태)을 남긴다. 등록 트랜잭션 안에서 부른다(decisions/0008).
   * 단말기 INSERT와 이력 INSERT가 같은 트랜잭션이고 부모 행은 이 트랜잭션이 막 만든 행이라 S→X 승격이 생기지 않는다.
   */
  recordRegistration(
    terminal: Terminal,
    actor: string,
    source: TransitionSource,
    em: EntityManager,
    reason = '신규 등록',
  ): TerminalStatusHistory {
    const history = em.create(TerminalStatusHistory, {
      terminal,
      fromStatus: null,
      toStatus: terminal.status,
      source,
      actor,
      reason,
    });
    this.recordOutbox(em, terminal, null, { to: terminal.status, source, actor, reason });
    return history;
  }

  /**
   * 상태 변경 알림을 같은 트랜잭션에 기록한다(Outbox, decisions/0016). 커밋되면 알림도 반드시 남고, 롤백되면 같이 사라진다.
   * outbox_event에는 외래키가 없어 단말기 행에 락을 걸지 않는다(UPDATE 먼저 규칙과 충돌하지 않는다).
   */
  private recordOutbox(
    em: EntityManager,
    terminal: Terminal,
    from: TerminalStatus | null,
    change: { to: TerminalStatus; source: TransitionSource; actor: string; reason: string },
  ): void {
    em.create(OutboxEvent, {
      type: OUTBOX_TYPE.TERMINAL_STATUS_CHANGED,
      payload: {
        serialNo: terminal.serialNo,
        fromStatus: from,
        toStatus: change.to,
        source: change.source,
        actor: change.actor,
        reason: change.reason,
        occurredAt: new Date().toISOString(),
      },
    });
  }
}
```

`apps/api/src/terminal/terminal.module.ts` 전체:
```ts
import { Module } from '@nestjs/common';
import { BulkRegistrationService } from './bulk-registration.service.js';
import { TerminalController } from './terminal.controller.js';
import { TerminalService } from './terminal.service.js';
import { TransitionService } from './transition.service.js';

@Module({
  controllers: [TerminalController],
  providers: [TerminalService, TransitionService, BulkRegistrationService],
  exports: [TerminalService, TransitionService, BulkRegistrationService],
})
export class TerminalModule {}
```

`apps/api/src/terminal/dto/register-terminal.dto.ts` 전체(형식 규칙을 `bulk-rows.ts`와 공유):
```ts
import { IsString, Matches } from 'class-validator';
import { SERIAL_NO_MESSAGE, SERIAL_NO_PATTERN } from '../bulk-rows.js';

export class RegisterTerminalDto {
  @Matches(SERIAL_NO_PATTERN, { message: SERIAL_NO_MESSAGE })
  serialNo!: string;

  @IsString()
  modelCode!: string;
}
```

- [ ] **Step 4: 통과 확인 (겹친 동시 등록은 3회)**

Run:
```bash
npx vitest run && npm run typecheck
for i in 1 2 3; do npx vitest run test/bulk-registration.e2e.spec.ts --silent=false 2>&1 | grep -E "\[일괄 등록 쿼리\]|\[겹친 동시 등록\]|Tests "; done
```
Expected: 20개 파일 `141 passed`, typecheck exit 0. `[일괄 등록 쿼리]` 줄의 10행·200행 select 수가 같고(사전 검증에서는 둘 다 같은 값), 겹친 동시 등록 3회 모두 통과. 출력을 devlog에 붙인다.

- [ ] **Step 5: 재시도가 실제로 쓰이는지 확인 (되돌릴 실험)**

`src/common/retry-on-unique.ts`의 기본값 `attempts = 2`를 잠깐 `attempts = 1`로 바꾸고 `npx vitest run test/bulk-registration.e2e.spec.ts`를 돌린다.
Expected: 겹친 동시 등록 테스트가 `UniqueConstraintViolationException: Duplicate entry 'CO-0021' for key 'terminal.terminal_serial_no_unique'`처럼 실패한다(사전 검증 3회 모두). 확인했으면 `attempts = 2`로 되돌리고 다시 통과하는지 본다. 결과를 devlog와 decisions/0019에 적는다.

- [ ] **Step 6: 기록과 커밋**

`docs/decisions/0019-일괄-처리는-행별-결과와-한-트랜잭션.md`:
- 상황: 박스 스캔(수백 대)과 엑셀(수천 행)은 일부 행만 문제가 있는 것이 보통이다. 행마다 조회하면 N+1, 행마다 트랜잭션이면 이력·Outbox가 행마다 커밋된다. 설계안 Day 3 학습 주제(대량 flush, N+1).
- 선택지(부분 실패):
  1. 전부 아니면 전무: 한 행이라도 틀리면 400. 운영자가 박스 하나를 다시 찍어야 하고, 어떤 행이 문제인지 따로 알려야 한다.
  2. **행별 결과, 유효한 행만 반영**: 결과 코드(CREATED, INVALID_FORMAT, DUPLICATE_IN_REQUEST, UNKNOWN_MODEL, ALREADY_EXISTS, Task 5부터 NOT_IN_DELIVERY_NOTE, NOT_FOUND, INVALID_STATE, RETURNED)를 입력 순서대로 준다. 이미 있는 시리얼을 다시 찍어도 ALREADY_EXISTS로 끝나 재처리가 안전하다.
  3. 행마다 별도 트랜잭션: 부분 반영은 같지만 커밋이 N번이고, 중간에 죽으면 어디까지 했는지 알기 어렵다.
- 결정: 2, 유효한 행 전체는 **한 트랜잭션**. 조회는 행 수와 상관없이 2번(모델, 기존 시리얼). INSERT는 시리얼 순서로 만든다 — 같은 시리얼을 넣는 트랜잭션들이 unique 키를 같은 순서로 잡아 엇갈려 기다리지 않게.
- 동시성: 조회와 INSERT 사이에 다른 요청이 같은 시리얼을 넣으면 unique 위반 → 트랜잭션 전체를 1회 다시 한다(그때는 ALREADY_EXISTS). Step 5에서 재시도를 끄면 실패하는 것을 확인했다(출력 붙이기).
- 낙관적 락 충돌(Task 5 RETURN_IN에서 생긴다): 행별로 다시 하지 않고 **박스 전체 409**(VERSION_CONFLICT). 저장된 결과가 없으니 같은 scanId로 다시 보내면 새로 처리된다. 행별로 하려면 충돌 행을 빼고 다시 flush해야 하는데 MikroORM은 실패한 flush 뒤 Unit of Work를 믿기 어렵다.
- 결과·대가: 한 요청의 행 수에 상한이 필요하다(스캔 500, 엑셀 5000). 트랜잭션이 커지면 락 시간이 길어진다 → 실험 0006에서 잰다.
- 숫자: Step 4의 쿼리 수(10행·200행).

`docs/study/backlog.md`에 추가:
```
- [ ] MikroORM batchSize와 다중 행 INSERT, version 컬럼이 있으면 INSERT 뒤 select id, version을 하는 이유 (bulk-registration.service.ts)
- [ ] FlushMode AUTO — 쿼리 전에 자동 flush가 일어나는 조건 (실험 0006 N+1)
- [ ] unique 위반 재시도와 INSERT 순서 — 같은 키를 넣는 트랜잭션끼리 기다리는 방식 (decisions/0019)
```

커밋:
```bash
git add apps/api docs
git commit -m "feat(F6): 일괄 등록 엔진(조회 2번, 행별 결과, 한 트랜잭션)" -m "Refs: docs/decisions/0019-일괄-처리는-행별-결과와-한-트랜잭션.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 박스 일괄 스캔 — RECEIVE·RETURN_IN, Redis 처리 중 잠금 + ScanBatch 멱등 (F6)

**Files:**
- Create: `apps/api/src/scan/scan-batch.entity.ts`, `scan-lock.ts`, `scan.service.ts`, `scan.controller.ts`, `scan.module.ts`, `dto/create-scan.dto.ts`
- Modify: `apps/api/src/terminal/terminal.entity.ts`(`purchaseOrder` FK), `apps/api/src/terminal/transition.service.ts`(`transitionMany`), `apps/api/src/purchase-order/purchase-order.service.ts`(`ensureDeliveryNote`), `apps/api/src/common/domain-errors.ts`(`BusinessError`), `apps/api/src/common/domain-exception.filter.ts`, `apps/api/src/config/env.ts`(`scanLockTtlMs`), `apps/api/src/entities.ts`, `apps/api/src/app.module.ts`
- Create: `apps/api/src/migrations/Migration<시각>.ts`(생성 명령)
- Test: `apps/api/test/scan.e2e.spec.ts`, `apps/api/test/helpers/partners.ts`(`deliveryNote`), `apps/api/test/helpers/scenario.ts`(`orderPurchase`)
- Record: devlog, `docs/decisions/0020-박스-스캔-멱등은-Redis-잠금과-ScanBatch.md`, `docs/decisions/0021-입고는-명세-밖-시리얼을-거절한다.md`, `docs/decisions/0019-…`(갱신 한 줄), `docs/study/backlog.md`

`POST /scans { scanId, kind: RECEIVE|RETURN_IN, poNo?, serials[1~500] }`(X-Operator 필수). 새로 처리하면 201, 같은 scanId를 다시 보내 저장된 결과를 주면 200(`replayed: true`). 응답: `{ scanId, kind, poNo, actor, replayed, createdAt, summary, results }`. `GET /scans/:scanId`.

흐름(스펙 5.3):
```
ScanBatch(scanId) 있음 → 같은 내용(requestHash)이면 200 replayed, 다르면 422 SCAN_ID_REUSED
Redis SET <QUEUE_PREFIX>:scan-lock:<scanId> <token> PX 30000 NX 실패 → 409 SCAN_IN_PROGRESS
  잠근 뒤 ScanBatch를 한 번 더 확인
  RECEIVE: 발주 조회(404, CLOSED면 422 PO_CLOSED) → 명세 없으면 세움에서 받아 저장(트랜잭션 밖)
           트랜잭션: SELECT purchase_order FOR UPDATE → CLOSED 재확인 → RECEIVING
                    명세 밖 → NOT_IN_DELIVERY_NOTE, 나머지 → 엔진(source SCAN, terminal.purchaseOrder = 발주)
                    INSERT scan_batch
  RETURN_IN: 트랜잭션: 단말기 한 번에 조회(id 순) → transitionMany(RETURNING → RETURNED, SCAN) → INSERT scan_batch
finally: 내 토큰일 때만 잠금 해제(Lua)
```
`transitionMany`는 이미 읽은 단말기 여러 대의 규칙을 행마다 확인하고 통과한 것만 바꿔 flush 한 번(MikroORM이 CASE UPDATE 하나로 묶는다) → 이력·Outbox. version은 flush가 확인한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/helpers/partners.ts` 전체(`deliveryNote` 추가):
```ts
import { env } from '../../src/config/env.js';

/** 가상 업체 서버 관리 API 클라이언트. 설정 키는 apps/partners/src/state.ts의 PartnersConfig를 따른다. */
async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${env.partnersUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`partners ${method} ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export interface PartnersStats {
  calls: Record<string, number>;
  perTracking: Record<string, number>;
  status429: number;
  status429Limit: number;
  status429Forced: number;
  status5xx: number;
  overlaps: number;
  maxInFlight: number;
  /** 지금 처리 중인 번개 추적 조회 수(전체) */
  inFlightTotal: number;
  /** 운송장 구분 없이 동시에 처리한 번개 추적 조회 수의 최댓값 */
  maxInFlightTotal: number;
}

export interface ToktokSummary {
  total: number;
  byKey: Record<string, number>;
  messages: { channel: string; idempotencyKey: string; text: string; receivedAt: string }[];
}

export const partners = {
  reset: () => call<unknown>('POST', '/__admin/reset'),
  configure: (patch: Record<string, unknown>) => call<unknown>('POST', '/__admin/config', patch),
  stats: () => call<PartnersStats>('GET', '/__admin/stats'),
  toktok: () => call<ToktokSummary>('GET', '/__admin/toktok/messages'),
  /** 세움전자 납품 명세(테스트가 "공장이 보낸 박스"를 만들 때 쓴다). 호출 수(seum.deliveryNote)에 더해진다. */
  deliveryNote: (poNo: string) =>
    call<{ poNo: string; serials: string[] }>('GET', `/seum/v1/purchase-orders/${encodeURIComponent(poNo)}/delivery-note`),
};
```

`apps/api/test/helpers/scenario.ts` 전체(`orderPurchase` 추가):
```ts
import { expect } from 'vitest';
import { partners } from './partners.js';
import type { TestApp } from './test-app.js';

/** 시나리오 준비용 작업자 */
export const SCENARIO_OP = { 'X-Operator': 'scenario' };
const SN100_PASS = ['POWER', 'NETWORK', 'CARD_READER', 'PRINTER'].map((itemCode) => ({ itemCode, passed: true }));

/** 실제 API로 등록 → 검수 합격 → 재고까지 만든다. 현재 version을 돌려준다. */
export async function registerInStock(t: TestApp, serialNo: string): Promise<number> {
  expect((await t.http().post('/terminals').set(SCENARIO_OP).send({ serialNo, modelCode: 'SN-100' })).status).toBe(201);
  const inspected = await t.http().post(`/terminals/${serialNo}/inspections`).set(SCENARIO_OP).send({ results: SN100_PASS });
  expect(inspected.status).toBe(201);
  const stocked = await t
    .http()
    .post(`/terminals/${serialNo}/transitions`)
    .set(SCENARIO_OP)
    .send({ to: 'IN_STOCK', reason: '재고 편입', expectedVersion: inspected.body.terminal.version });
  expect(stocked.status).toBe(200);
  return stocked.body.version;
}

/** 재고 단말기를 가맹점에 배정한다. 현재 version을 돌려준다. */
export async function allocateTo(t: TestApp, serialNo: string, merchantCode = 'GANGNAM-KIMBAP'): Promise<number> {
  const version = (await t.http().get(`/terminals/${serialNo}`)).body.version;
  const res = await t.http().post(`/terminals/${serialNo}/allocations`).set(SCENARIO_OP).send({ merchantCode, expectedVersion: version });
  expect(res.status).toBe(201);
  return res.body.version;
}

/** 배정된 단말기를 출고한다. */
export async function shipWith(t: TestApp, serialNo: string, carrier: 'BUNGAE' | 'NEURIMBO') {
  const version = (await t.http().get(`/terminals/${serialNo}`)).body.version;
  const res = await t.http().post('/shipments').set(SCENARIO_OP).send({ serialNo, carrier, expectedVersion: version });
  expect(res.status).toBe(201);
  return { shipmentId: res.body.id as number, trackingNo: res.body.trackingNo as string };
}

/** 발주를 내고 공장의 납품 명세(시리얼 목록)를 함께 돌려준다. partners 설정(shortfall 등)은 미리 해 둔다. */
export async function orderPurchase(t: TestApp, quantity: number, modelCode = 'SN-100') {
  const res = await t.http().post('/purchase-orders').set(SCENARIO_OP).send({ modelCode, quantity });
  expect(res.status).toBe(201);
  const poNo = res.body.poNo as string;
  return { poNo, serials: (await partners.deliveryNote(poNo)).serials };
}

/** 등록부터 출고까지 한 번에. 수집 테스트·실험 준비용 */
export async function prepareShipped(t: TestApp, serialNo: string, carrier: 'BUNGAE' | 'NEURIMBO') {
  await registerInStock(t, serialNo);
  await allocateTo(t, serialNo);
  return shipWith(t, serialNo, carrier);
}
```

`apps/api/test/scan.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PurchaseOrder, PurchaseOrderStatus } from '../src/purchase-order/purchase-order.entity.js';
import { ScanBatch } from '../src/scan/scan-batch.entity.js';
import { ScanLock } from '../src/scan/scan-lock.js';
import { BulkRegistrationService } from '../src/terminal/bulk-registration.service.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { partners } from './helpers/partners.js';
import { orderPurchase, SCENARIO_OP } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'choi' };

describe('박스 일괄 스캔 (F6)', () => {
  let t: TestApp;
  const em = () => t.orm.em.fork();
  const scan = (body: Record<string, unknown>) => t.http().post('/scans').set(OP).send(body);
  const noteCalls = async () => (await partners.stats()).calls['seum.deliveryNote'] ?? 0;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  describe('입고(RECEIVE)', () => {
    it('명세에 있는 시리얼만 SCAN 출처로 등록하고 행별 결과를 준다. 발주는 RECEIVING', async () => {
      const { poNo, serials } = await orderPurchase(t, 5);
      const before = await noteCalls();
      const res = await scan({
        scanId: 'BOX-RCV-0001',
        kind: 'RECEIVE',
        poNo,
        serials: [serials[0], serials[1], 'SE0-9999', serials[0], 'bad', serials[2]],
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ scanId: 'BOX-RCV-0001', kind: 'RECEIVE', poNo, actor: 'choi', replayed: false });
      expect(res.body.results.map((r: { result: string }) => r.result)).toEqual([
        'CREATED',
        'CREATED',
        'NOT_IN_DELIVERY_NOTE',
        'DUPLICATE_IN_REQUEST',
        'INVALID_FORMAT',
        'CREATED',
      ]);
      expect(res.body.summary).toEqual({ CREATED: 3, NOT_IN_DELIVERY_NOTE: 1, DUPLICATE_IN_REQUEST: 1, INVALID_FORMAT: 1 });
      expect(await noteCalls()).toBe(before + 1); // 명세는 처음 한 번 받아 저장한다

      const created = await em().find(Terminal, { purchaseOrder: { poNo } }, { orderBy: { serialNo: 'asc' } });
      expect(created.map((c) => c.serialNo)).toEqual([serials[0], serials[1], serials[2]].sort());
      expect(created.every((c) => c.status === TerminalStatus.RECEIVED)).toBe(true);
      const [history] = await em().find(TerminalStatusHistory, { terminal: { serialNo: serials[0] } });
      expect(history).toMatchObject({ source: 'SCAN', actor: 'choi', reason: `박스 입고: 발주 ${poNo}` });
      const po = await em().findOneOrFail(PurchaseOrder, { poNo });
      expect(po.status).toBe(PurchaseOrderStatus.RECEIVING);
      expect(po.deliveryNote).toEqual(serials);
    });

    it('다음 박스: 이미 입고된 시리얼은 ALREADY_EXISTS, 명세는 다시 받지 않는다', async () => {
      const { poNo, serials } = await orderPurchase(t, 3);
      await scan({ scanId: 'BOX-RCV-0002', kind: 'RECEIVE', poNo, serials: [serials[0]] });
      const before = await noteCalls();
      const res = await scan({ scanId: 'BOX-RCV-0003', kind: 'RECEIVE', poNo, serials: [serials[0], serials[1]] });
      expect(res.body.results.map((r: { result: string }) => r.result)).toEqual(['ALREADY_EXISTS', 'CREATED']);
      expect(await noteCalls()).toBe(before);
    });

    it('poNo가 없으면 400, 없는 발주는 404, 마감된 발주는 422 PO_CLOSED, 501개 이상은 400', async () => {
      expect((await scan({ scanId: 'BOX-RCV-0010', kind: 'RECEIVE', serials: ['A-0001'] })).status).toBe(400);
      expect((await scan({ scanId: 'BOX-RCV-0011', kind: 'RECEIVE', poNo: 'SE0', serials: ['A-0001'] })).status).toBe(404);
      const { poNo, serials } = await orderPurchase(t, 1);
      await em().nativeUpdate(PurchaseOrder, { poNo }, { status: PurchaseOrderStatus.CLOSED });
      const closed = await scan({ scanId: 'BOX-RCV-0012', kind: 'RECEIVE', poNo, serials });
      expect(closed.status).toBe(422);
      expect(closed.body.code).toBe('PO_CLOSED');
      const many = Array.from({ length: 501 }, (_, i) => `MANY-${String(i).padStart(4, '0')}`);
      expect((await scan({ scanId: 'BOX-RCV-0013', kind: 'RECEIVE', poNo, serials: many })).status).toBe(400);
    });
  });

  describe('멱등(같은 scanId)', () => {
    it('같은 scanId를 다시 보내면 처리하지 않고 저장된 결과를 200으로 준다', async () => {
      const { poNo, serials } = await orderPurchase(t, 2);
      const body = { scanId: 'BOX-IDEM-0001', kind: 'RECEIVE', poNo, serials };
      const first = await scan(body);
      const historyBefore = await em().count(TerminalStatusHistory);
      const second = await scan(body);
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.replayed).toBe(true);
      expect(second.body.results).toEqual(first.body.results);
      expect(await em().count(TerminalStatusHistory)).toBe(historyBefore);
      expect(await em().count(ScanBatch, { scanId: 'BOX-IDEM-0001' })).toBe(1);
      expect((await t.http().get('/scans/BOX-IDEM-0001')).body.results).toEqual(first.body.results);
    });

    it('같은 scanId로 다른 내용을 보내면 422 SCAN_ID_REUSED', async () => {
      const { poNo, serials } = await orderPurchase(t, 2);
      await scan({ scanId: 'BOX-IDEM-0002', kind: 'RECEIVE', poNo, serials: [serials[0]] });
      const res = await scan({ scanId: 'BOX-IDEM-0002', kind: 'RECEIVE', poNo, serials: [serials[1]] });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('SCAN_ID_REUSED');
    });

    it('처리 중에 같은 scanId가 또 오면 409 SCAN_IN_PROGRESS, 끝난 뒤에는 저장된 결과', async () => {
      const { poNo, serials } = await orderPurchase(t, 2);
      const body = { scanId: 'BOX-IDEM-0003', kind: 'RECEIVE', poNo, serials };
      // 첫 요청이 등록 엔진 안에서 멈추게 한다(Redis 잠금을 쥔 채, 트랜잭션 열린 채).
      const bulk = t.app.get(BulkRegistrationService);
      const original = bulk.registerMany.bind(bulk);
      let release!: () => void;
      let markEntered!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const entered = new Promise<void>((r) => (markEntered = r));
      const spy = vi.spyOn(bulk, 'registerMany').mockImplementationOnce(async (...args) => {
        markEntered();
        await released;
        return original(...args);
      });
      try {
        const first = scan(body).then((r) => r);
        await entered;
        const second = await scan(body);
        expect(second.status).toBe(409);
        expect(second.body.code).toBe('SCAN_IN_PROGRESS');
        release();
        expect((await first).status).toBe(201);
      } finally {
        release();
        spy.mockRestore();
      }
      const third = await scan(body);
      expect(third.status).toBe(200);
      expect(third.body.replayed).toBe(true);
      // 잠금은 끝나면 풀린다
      expect(await t.app.get(ScanLock).acquire('BOX-IDEM-0003', 1000)).not.toBeNull();
    });
  });

  describe('회수 입고(RETURN_IN)', () => {
    async function registerWithStatus(serialNo: string, status: TerminalStatus) {
      await t.http().post('/terminals').set(SCENARIO_OP).send({ serialNo, modelCode: 'SN-100' });
      const e = em();
      const terminal = await e.findOneOrFail(Terminal, { serialNo });
      terminal.status = status;
      await e.flush();
      return terminal.version;
    }

    it('RETURNING만 RETURNED(SCAN)로 바꾸고, 상태가 다르면 INVALID_STATE, 없으면 NOT_FOUND', async () => {
      const v1 = await registerWithStatus('RT-0001', TerminalStatus.RETURNING);
      await registerWithStatus('RT-0002', TerminalStatus.RETURNING);
      await registerWithStatus('RT-0003', TerminalStatus.IN_STOCK);
      const res = await scan({ scanId: 'BOX-RET-0001', kind: 'RETURN_IN', serials: ['RT-0002', 'RT-0003', 'RT-9999', 'RT-0001'] });
      expect(res.status).toBe(201);
      expect(res.body.results.map((r: { serialNo: string; result: string }) => [r.serialNo, r.result])).toEqual([
        ['RT-0002', 'RETURNED'],
        ['RT-0003', 'INVALID_STATE'],
        ['RT-9999', 'NOT_FOUND'],
        ['RT-0001', 'RETURNED'],
      ]);
      expect(res.body.results[1].message).toContain('IN_STOCK → RETURNED');

      const t1 = await em().findOneOrFail(Terminal, { serialNo: 'RT-0001' });
      expect(t1).toMatchObject({ status: TerminalStatus.RETURNED, version: v1 + 1 });
      expect((await em().findOneOrFail(Terminal, { serialNo: 'RT-0003' })).status).toBe(TerminalStatus.IN_STOCK);
      const history = await t.http().get('/terminals/RT-0001/history');
      expect(history.body.at(-1)).toMatchObject({ fromStatus: 'RETURNING', toStatus: 'RETURNED', source: 'SCAN', actor: 'choi', reason: '박스 회수 입고' });
    });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/scan.e2e.spec.ts`
Expected: FAIL — `../src/scan/scan-batch.entity.js`를 찾지 못해 파일 로드 실패

- [ ] **Step 3: 업무 오류, 설정, 단말기의 발주 연결, 여러 대 전이**

`apps/api/src/common/domain-errors.ts` 전체:
```ts
/**
 * 업무 규칙 위반·충돌. code로 원인을 구분하고 status로 HTTP 상태를 정한다(409 충돌, 422 규칙 위반).
 * 예: SCAN_IN_PROGRESS(409), SCAN_ID_REUSED(422), PO_CLOSED(422)
 */
export class BusinessError extends Error {
  constructor(
    readonly status: 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BusinessError';
  }
}

/** 허용되지 않은 상태 전이. HTTP 422로 바뀐다. */
export class InvalidTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransitionError';
  }
}
```

`apps/api/src/common/domain-exception.filter.ts` 전체:
```ts
import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { OptimisticLockError, UniqueConstraintViolationException } from '@mikro-orm/mysql';
import type { Response } from 'express';
import { BusinessError, InvalidTransitionError } from './domain-errors.js';
import { PartnerError } from './partner-errors.js';

/** ORM·도메인·외부 업체 오류를 HTTP 응답으로 바꾼다. 응답의 code로 클라이언트가 원인을 구분한다. */
@Catch(OptimisticLockError, UniqueConstraintViolationException, InvalidTransitionError, PartnerError, BusinessError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: Error, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (error instanceof OptimisticLockError) {
      return res.status(409).json({
        statusCode: 409,
        code: 'VERSION_CONFLICT',
        message: '다른 작업이 먼저 이 단말기를 변경했습니다. 다시 조회한 뒤 시도하세요.',
      });
    }
    if (error instanceof UniqueConstraintViolationException) {
      return res.status(409).json({ statusCode: 409, code: 'DUPLICATE', message: '이미 존재하는 값입니다.' });
    }
    if (error instanceof BusinessError) {
      return res.status(error.status).json({ statusCode: error.status, code: error.code, message: error.message });
    }
    if (error instanceof PartnerError) {
      // 우리 잘못이 아니라 외부 업체(택배사) 쪽 실패. 원인 분류(error.name)를 함께 준다.
      return res.status(502).json({ statusCode: 502, code: 'PARTNER_ERROR', reason: error.name, message: error.message });
    }
    return res.status(422).json({ statusCode: 422, code: 'INVALID_TRANSITION', message: error.message });
  }
}
```

`apps/api/src/config/env.ts` 전체(`scanLockTtlMs` 추가, `SCAN_LOCK_TTL_MS`로 바꿀 수 있다):
```ts
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 스크립트·테스트는 apps/api에서 실행한다. 저장소 루트의 .env를 읽는다(이미 있는 환경변수는 덮어쓰지 않는다).
const envFile = resolve(process.cwd(), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경변수 ${name}가 없습니다. 저장소 루트 .env를 확인하세요.`);
  return value;
}

function flag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  return value === undefined ? fallback : value === '1' || value === 'true';
}

const isTest = process.env.NODE_ENV === 'test';

export const env = {
  port: Number(process.env.API_PORT ?? 3000),
  mysql: {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: required('MYSQL_USER'),
    password: required('MYSQL_PASSWORD'),
    dbName: isTest ? required('MYSQL_TEST_DATABASE') : required('MYSQL_DATABASE'),
  },
  /** 가상 업체 서버(apps/partners) 주소 */
  partnersUrl: process.env.PARTNERS_URL ?? 'http://127.0.0.1:4010',
  /** 택배사·메신저 호출 타임아웃 */
  partnerTimeoutMs: Number(process.env.PARTNER_TIMEOUT_MS ?? 3000),
  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
  /**
   * BullMQ 키 접두사. 테스트는 파일마다 다른 접두사를 써서 다른 파일의 job을 보지 않는다
   * (vitest는 테스트 파일마다 모듈을 새로 읽으므로 이 값도 파일마다 새로 정해진다).
   */
  queuePrefix: process.env.QUEUE_PREFIX ?? (isTest ? `test-${process.pid}-${Date.now()}` : 'terminal-ops'),
  /** 이 프로세스가 큐 job을 처리할지 */
  runWorkers: flag('RUN_WORKERS', true),
  /** 이 프로세스가 주기 작업(수집 sweep, outbox relay)을 등록할지 */
  runSchedulers: flag('RUN_SCHEDULERS', !isTest),
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? 30_000),
  relayIntervalMs: Number(process.env.RELAY_INTERVAL_MS ?? 2_000),
  /** 우리 쪽 호출 속도 제한(초당). 택배사 한도보다 낮게 둔다. */
  bungaeRatePerSec: Number(process.env.BUNGAE_RATE_PER_SEC ?? 10),
  neurimboRatePerSec: Number(process.env.NEURIMBO_RATE_PER_SEC ?? 5),
  /** 알림을 보낼 톡톡메신저 채널 */
  toktokChannel: process.env.TOKTOK_CHANNEL ?? 'ops',
  /** 박스 스캔 처리 중 잠금(Redis) 유지 시간. 처리가 이보다 길면 잠금이 풀린다(decisions/0020) */
  scanLockTtlMs: Number(process.env.SCAN_LOCK_TTL_MS ?? 30_000),
  /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
  workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
};
```

`apps/api/src/terminal/terminal.entity.ts` 전체(`purchaseOrder` 추가):
```ts
import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { Merchant } from '../merchant/merchant.entity.js';
import { PurchaseOrder } from '../purchase-order/purchase-order.entity.js';
import { TerminalModel } from './terminal-model.entity.js';
import { TerminalStatus } from './terminal-status.js';

@Entity({ tableName: 'terminal' })
@Index({ properties: ['status'] })
export class Terminal {
  [OptionalProps]?: 'status' | 'version' | 'createdAt' | 'updatedAt';

  @PrimaryKey()
  id!: number;

  @Property({ unique: true, length: 32 })
  serialNo!: string;

  // Rel<>: ESM 순환 import에서 데코레이터 메타데이터가 클래스를 너무 일찍 참조하지 않게 한다.
  @ManyToOne(() => TerminalModel)
  model!: Rel<TerminalModel>;

  /** 배정된 가맹점. 배정 전에는 null */
  @ManyToOne(() => Merchant, { nullable: true })
  merchant?: Rel<Merchant> | null;

  /** 박스 스캔으로 입고된 발주. 단건·엑셀 등록이면 null (F10 대조에 쓴다) */
  @ManyToOne(() => PurchaseOrder, { nullable: true })
  purchaseOrder?: Rel<PurchaseOrder> | null;

  @Enum({ items: () => TerminalStatus })
  status: TerminalStatus = TerminalStatus.RECEIVED;

  /** 낙관적 락. flush할 때 WHERE version = ? 로 확인하고 1 올린다. */
  @Property({ version: true })
  version!: number;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
```

`apps/api/src/terminal/transition.service.ts` 전체(`BulkTransitionItem`, `transitionMany` 추가):
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { InvalidTransitionError } from '../common/domain-errors.js';
import { OUTBOX_TYPE, OutboxEvent } from '../outbox/outbox-event.entity.js';
import { Terminal } from './terminal.entity.js';
import { TerminalStatusHistory } from './terminal-status-history.entity.js';
import { TerminalStatus, TransitionSource } from './terminal-status.js';
import { checkTransition, type TransitionCheck } from './transition-rules.js';

/** transitionMany 한 행 */
export interface BulkTransitionItem {
  /** 같은 트랜잭션에서 읽은 단말기(model populate 필수) */
  terminal: Terminal;
  to: TerminalStatus;
  reason: string;
}

export interface TransitionCommand {
  serialNo: string;
  to: TerminalStatus;
  reason: string;
  actor: string;
  source: TransitionSource;
  /** 사람이 화면을 보고 바꿀 때는 필수. 시스템 작업은 생략할 수 있다(flush 시 version 검사는 그래도 일어난다). */
  expectedVersion?: number;
  /**
   * 상태와 함께 바꿀 단말기 필드(예: 배정 가맹점). 규칙 확인 뒤, UPDATE 전에 적용해 상태 변경과 같은 UPDATE 한 번에 나간다
   * (decisions/0011). 상태(status)는 여기서 바꾸지 않는다.
   */
  mutate?: (terminal: Terminal) => void;
}

/** 단말기 상태를 바꾸는 유일한 경로. 규칙 확인, 상태 변경, 이력 기록을 한 트랜잭션으로 묶는다. */
@Injectable()
export class TransitionService {
  constructor(private readonly em: EntityManager) {}

  /**
   * @param em 이미 열린 트랜잭션에 합류할 때 넘긴다(예: 검수 저장과 같은 트랜잭션).
   */
  async transition(cmd: TransitionCommand, em: EntityManager = this.em): Promise<Terminal> {
    return em.transactional(async (tx) => {
      const terminal = await tx.findOne(Terminal, { serialNo: cmd.serialNo }, { populate: ['model', 'merchant'] });
      if (!terminal) throw new NotFoundException(`단말기 ${cmd.serialNo}이(가) 없습니다.`);

      // 규칙보다 version을 먼저 본다. 낡은 화면에서 온 요청은 "규칙 위반"이 아니라 "충돌"로 알려야 한다.
      if (cmd.expectedVersion !== undefined) {
        await tx.lock(terminal, LockMode.OPTIMISTIC, cmd.expectedVersion);
      }

      const check = checkTransition(terminal.status, cmd.to, cmd.source, {
        requiresReinspection: terminal.model.requiresReinspection,
      });
      if (!check.ok) throw new InvalidTransitionError(check.reason);

      const from = terminal.status;
      terminal.status = cmd.to;
      cmd.mutate?.(terminal);
      // version 검사 UPDATE를 이력 INSERT보다 먼저 보낸다. INSERT가 먼저면 FK 검사의 공유 락끼리 엉켜 데드락이 난다(troubleshooting/0004).
      await tx.flush();
      tx.create(TerminalStatusHistory, {
        terminal,
        fromStatus: from,
        toStatus: cmd.to,
        source: cmd.source,
        actor: cmd.actor,
        reason: cmd.reason,
      });
      this.recordOutbox(tx, terminal, from, cmd);
      return terminal;
    });
  }

  /**
   * 여러 단말기를 한 번에 전이한다(박스 스캔 RETURN_IN 등). 열린 트랜잭션(tx)에서 이미 읽은 단말기를 받는다.
   * 행마다 규칙을 확인해 통과한 것만 바꾸고, flush 한 번으로 UPDATE를 보낸 뒤(MikroORM이 CASE 문 하나로 묶는다)
   * 이력·Outbox를 만든다. version은 flush가 확인한다 — 하나라도 그사이 바뀌었으면 OptimisticLockError로 전체가 롤백된다
   * (부분 반영 없음, decisions/0019). 결과는 입력과 같은 순서의 규칙 확인 결과다.
   */
  async transitionMany(
    tx: EntityManager,
    items: BulkTransitionItem[],
    ctx: { actor: string; source: TransitionSource },
  ): Promise<TransitionCheck[]> {
    if (!tx.isInTransaction()) throw new Error('transitionMany는 트랜잭션 안에서만 부른다.');
    const checks = items.map((it) =>
      checkTransition(it.terminal.status, it.to, ctx.source, { requiresReinspection: it.terminal.model.requiresReinspection }),
    );
    const from = items.map((it) => it.terminal.status);
    items.forEach((it, i) => {
      if (checks[i].ok) it.terminal.status = it.to;
    });
    // UPDATE를 이력 INSERT보다 먼저 보낸다(troubleshooting/0004).
    await tx.flush();
    items.forEach((it, i) => {
      if (!checks[i].ok) return;
      tx.create(TerminalStatusHistory, {
        terminal: it.terminal,
        fromStatus: from[i],
        toStatus: it.to,
        source: ctx.source,
        actor: ctx.actor,
        reason: it.reason,
      });
      this.recordOutbox(tx, it.terminal, from[i], { to: it.to, source: ctx.source, actor: ctx.actor, reason: it.reason });
    });
    return checks;
  }

  /**
   * 새로 만든 단말기의 첫 이력(null → 현재 상태)을 남긴다. 등록 트랜잭션 안에서 부른다(decisions/0008).
   * 단말기 INSERT와 이력 INSERT가 같은 트랜잭션이고 부모 행은 이 트랜잭션이 막 만든 행이라 S→X 승격이 생기지 않는다.
   */
  recordRegistration(
    terminal: Terminal,
    actor: string,
    source: TransitionSource,
    em: EntityManager,
    reason = '신규 등록',
  ): TerminalStatusHistory {
    const history = em.create(TerminalStatusHistory, {
      terminal,
      fromStatus: null,
      toStatus: terminal.status,
      source,
      actor,
      reason,
    });
    this.recordOutbox(em, terminal, null, { to: terminal.status, source, actor, reason });
    return history;
  }

  /**
   * 상태 변경 알림을 같은 트랜잭션에 기록한다(Outbox, decisions/0016). 커밋되면 알림도 반드시 남고, 롤백되면 같이 사라진다.
   * outbox_event에는 외래키가 없어 단말기 행에 락을 걸지 않는다(UPDATE 먼저 규칙과 충돌하지 않는다).
   */
  private recordOutbox(
    em: EntityManager,
    terminal: Terminal,
    from: TerminalStatus | null,
    change: { to: TerminalStatus; source: TransitionSource; actor: string; reason: string },
  ): void {
    em.create(OutboxEvent, {
      type: OUTBOX_TYPE.TERMINAL_STATUS_CHANGED,
      payload: {
        serialNo: terminal.serialNo,
        fromStatus: from,
        toStatus: change.to,
        source: change.source,
        actor: change.actor,
        reason: change.reason,
        occurredAt: new Date().toISOString(),
      },
    });
  }
}
```

`apps/api/src/purchase-order/purchase-order.service.ts` 전체(`ensureDeliveryNote` 추가):
```ts
import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { TerminalModel } from '../terminal/terminal-model.entity.js';
import type { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto.js';
import { PurchaseOrder } from './purchase-order.entity.js';
import { SeumClient } from './seum.client.js';

@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly em: EntityManager,
    private readonly seum: SeumClient,
  ) {}

  /**
   * 발주: ① 모델 확인 ② 트랜잭션 밖에서 세움전자에 발주(HTTP) ③ 받은 발주번호로 저장.
   * ③이 실패하면 공장 쪽에 발주가 남는다(운송장과 같은 한계, decisions/0012). 확인할 수 있는 실패(없는 모델)는 ①에서 거른다.
   */
  async create(dto: CreatePurchaseOrderDto, actor: string): Promise<PurchaseOrder> {
    const model = await this.em.findOne(TerminalModel, { code: dto.modelCode });
    if (!model) throw new NotFoundException(`단말기 모델 ${dto.modelCode}이(가) 없습니다.`);

    const poNo = await this.seum.createPurchaseOrder({ modelCode: model.code, quantity: dto.quantity, reference: randomUUID() });

    const po = this.em.create(PurchaseOrder, { poNo, model, quantity: dto.quantity, orderedBy: actor });
    await this.em.flush();
    return po;
  }

  /**
   * 납품 명세를 돌려준다. 아직 안 받았으면 트랜잭션 밖에서 세움전자에 물어 저장한다(처음 한 번).
   * 동시에 두 요청이 받아 와도 내용이 같고, delivery_note가 null일 때만 쓰므로 덮어쓰지 않는다.
   */
  async ensureDeliveryNote(po: PurchaseOrder): Promise<string[]> {
    if (po.deliveryNote) return po.deliveryNote;
    const { serials } = await this.seum.getDeliveryNote(po.poNo);
    await this.em.fork().nativeUpdate(PurchaseOrder, { id: po.id, deliveryNote: null }, { deliveryNote: serials });
    po.deliveryNote = serials;
    return serials;
  }

  async get(poNo: string): Promise<PurchaseOrder> {
    const po = await this.em.findOne(PurchaseOrder, { poNo }, { populate: ['model'] });
    if (!po) throw new NotFoundException(`발주 ${poNo}이(가) 없습니다.`);
    return po;
  }
}
```

- [ ] **Step 4: 스캔 엔티티·잠금·서비스·API**

`apps/api/src/scan/scan-batch.entity.ts`:
```ts
import { OptionalProps } from '@mikro-orm/core';
import { Entity, Enum, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import type { RowResult } from '../terminal/bulk-rows.js';

export enum ScanKind {
  RECEIVE = 'RECEIVE', // 발주분 신규 입고
  RETURN_IN = 'RETURN_IN', // 회수 단말기 입고(RETURNING → RETURNED)
}

/**
 * 처리를 마친 박스 스캔 한 건. 같은 scanId가 다시 오면 처리하지 않고 이 결과를 그대로 돌려준다(멱등, decisions/0020).
 * 외래키를 두지 않는다(poNo는 문자열) — 단말기 INSERT와 같은 트랜잭션에서 부모 행에 S 락을 더 걸지 않게.
 */
@Entity({ tableName: 'scan_batch' })
@Index({ properties: ['poNo'] })
export class ScanBatch {
  [OptionalProps]?: 'createdAt';

  @PrimaryKey()
  id!: number;

  /** 스캐너가 박스마다 만드는 키 */
  @Property({ unique: true, length: 64 })
  scanId!: string;

  @Enum({ items: () => ScanKind })
  kind!: ScanKind;

  @Property({ length: 30, nullable: true })
  poNo?: string | null;

  /** 요청 내용(kind, poNo, serials)의 SHA-256. 같은 scanId로 다른 내용을 보내면 거절한다. */
  @Property({ length: 64 })
  requestHash!: string;

  @Property({ length: 50 })
  actor!: string;

  /** 행별 결과(입력 순서) */
  @Property({ type: 'json' })
  results!: RowResult[];

  @Property()
  createdAt: Date = new Date();
}
```

`apps/api/src/scan/scan-lock.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/** 내 토큰일 때만 지운다. TTL이 지나 다른 요청이 잡은 잠금을 지우지 않기 위해서다. */
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * 같은 scanId의 "처리 중" 잠금(Redis SET NX PX, decisions/0020).
 * 처리를 마친 결과는 MySQL(ScanBatch)에 영구히 남고, 이 잠금은 처리하는 동안 같은 scanId가 또 들어오는 것만 막는다.
 * 프로세스가 죽어도 TTL이 지나면 풀린다. 키는 큐와 같은 접두사를 써서 테스트(test-…)와 개발(terminal-ops)을 나눈다.
 */
@Injectable()
export class ScanLock implements OnModuleDestroy {
  private readonly redis = new Redis({ host: env.redis.host, port: env.redis.port, maxRetriesPerRequest: 1 });

  keyOf(scanId: string): string {
    return `${env.queuePrefix}:scan-lock:${scanId}`;
  }

  /** 잡으면 토큰, 이미 누가 잡고 있으면 null */
  async acquire(scanId: string, ttlMs = env.scanLockTtlMs): Promise<string | null> {
    const token = randomUUID();
    const ok = await this.redis.set(this.keyOf(scanId), token, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? token : null;
  }

  async release(scanId: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, this.keyOf(scanId), token);
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
```

`apps/api/src/scan/dto/create-scan.dto.ts`:
```ts
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsEnum, IsString, Matches, MinLength, ValidateIf } from 'class-validator';
import { ScanKind } from '../scan-batch.entity.js';

/** 박스 한 개의 스캔 결과. 시리얼 형식은 여기서 막지 않고 행별 결과(INVALID_FORMAT)로 돌려준다. */
export class CreateScanDto {
  /** 스캐너가 박스마다 만드는 멱등 키 */
  @Matches(/^[A-Za-z0-9_-]{8,64}$/, { message: 'scanId는 영문·숫자·_·- 8~64자입니다.' })
  scanId!: string;

  @IsEnum(ScanKind)
  kind!: ScanKind;

  /** RECEIVE일 때 필수 */
  @ValidateIf((o: CreateScanDto) => o.kind === ScanKind.RECEIVE)
  @IsString()
  @MinLength(1)
  poNo?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  serials!: string[];
}
```

`apps/api/src/scan/scan.service.ts`:
```ts
import { createHash } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode, UniqueConstraintViolationException } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { retryOnUniqueViolation } from '../common/retry-on-unique.js';
import { PurchaseOrder, PurchaseOrderStatus } from '../purchase-order/purchase-order.entity.js';
import { PurchaseOrderService } from '../purchase-order/purchase-order.service.js';
import { BulkRegistrationService } from '../terminal/bulk-registration.service.js';
import { precheckSerials, SERIAL_NO_PATTERN, type RowResult } from '../terminal/bulk-rows.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import { TransitionService } from '../terminal/transition.service.js';
import type { CreateScanDto } from './dto/create-scan.dto.js';
import { ScanBatch, ScanKind } from './scan-batch.entity.js';
import { ScanLock } from './scan-lock.js';

export function requestHashOf(dto: Pick<CreateScanDto, 'kind' | 'poNo' | 'serials'>): string {
  return createHash('sha256')
    .update(JSON.stringify([dto.kind, dto.poNo ?? null, dto.serials]))
    .digest('hex');
}

/**
 * 박스 일괄 스캔(F6). 박스 하나 = 요청 하나 = 트랜잭션 하나. 행별 결과를 돌려주고 유효한 행만 반영한다(decisions/0019).
 * 같은 scanId는 한 번만 처리한다: 처리 중이면 Redis 잠금으로 409, 끝났으면 ScanBatch에 저장한 결과를 그대로 준다(decisions/0020).
 */
@Injectable()
export class ScanService {
  constructor(
    private readonly em: EntityManager,
    private readonly lock: ScanLock,
    private readonly orders: PurchaseOrderService,
    private readonly bulk: BulkRegistrationService,
    private readonly transitions: TransitionService,
  ) {}

  async scan(dto: CreateScanDto, actor: string): Promise<{ batch: ScanBatch; replayed: boolean }> {
    const hash = requestHashOf(dto);
    const done = await this.findBatch(dto.scanId);
    if (done) return this.replay(done, hash);

    const token = await this.lock.acquire(dto.scanId);
    if (!token) throw new BusinessError(409, 'SCAN_IN_PROGRESS', `스캔 ${dto.scanId}을(를) 처리하는 중입니다. 잠시 뒤 같은 scanId로 다시 보내세요.`);
    try {
      // 잠금을 잡기 직전에 다른 요청이 끝냈을 수 있다.
      const again = await this.findBatch(dto.scanId);
      if (again) return this.replay(again, hash);
      const batch = dto.kind === ScanKind.RECEIVE ? await this.receive(dto, actor, hash) : await this.returnIn(dto, actor, hash);
      return { batch, replayed: false };
    } catch (error) {
      // 잠금 TTL이 지나 같은 scanId가 동시에 처리된 경우: scan_batch.scan_id unique가 막고, 먼저 끝난 결과를 준다.
      if (error instanceof UniqueConstraintViolationException) {
        const winner = await this.findBatch(dto.scanId);
        if (winner) return this.replay(winner, hash);
      }
      throw error;
    } finally {
      await this.lock.release(dto.scanId, token);
    }
  }

  async get(scanId: string): Promise<ScanBatch> {
    const batch = await this.findBatch(scanId);
    if (!batch) throw new NotFoundException(`스캔 ${scanId}이(가) 없습니다.`);
    return batch;
  }

  private findBatch(scanId: string): Promise<ScanBatch | null> {
    return this.em.fork().findOne(ScanBatch, { scanId });
  }

  private replay(batch: ScanBatch, hash: string): { batch: ScanBatch; replayed: boolean } {
    if (batch.requestHash !== hash) {
      throw new BusinessError(422, 'SCAN_ID_REUSED', `scanId ${batch.scanId}은(는) 다른 내용으로 이미 처리됐습니다.`);
    }
    return { batch, replayed: true };
  }

  /**
   * 발주분 입고. 납품 명세는 트랜잭션 밖에서 받아 두고(외부 HTTP), 트랜잭션에서는
   * ① 발주 행을 FOR UPDATE로 먼저 잠근다 — 단말기 INSERT의 FK 검사(S 락)보다 X 락이 먼저여야 같은 발주를 동시에 스캔해도
   *    S→X 데드락이 없다(troubleshooting/0004). 같은 발주의 스캔은 여기서 한 줄로 선다. 마감(CLOSED)도 이 잠금 아래에서 본다.
   * ② 명세에 없는 시리얼은 NOT_IN_DELIVERY_NOTE로 거절(등록하지 않는다, decisions/0021)
   * ③ 나머지는 일괄 등록 엔진(source SCAN)
   */
  private async receive(dto: CreateScanDto, actor: string, hash: string): Promise<ScanBatch> {
    const po = await this.orders.get(dto.poNo!);
    if (po.status === PurchaseOrderStatus.CLOSED) throw this.closed(po.poNo);
    const note = new Set(await this.orders.ensureDeliveryNote(po));

    return retryOnUniqueViolation(() =>
      this.em.fork().transactional(async (tx) => {
        const locked = await tx.findOneOrFail(PurchaseOrder, po.id, { lockMode: LockMode.PESSIMISTIC_WRITE, populate: ['model'] });
        if (locked.status === PurchaseOrderStatus.CLOSED) throw this.closed(locked.poNo);
        locked.status = PurchaseOrderStatus.RECEIVING;

        const results: (RowResult | null)[] = dto.serials.map((serialNo) =>
          SERIAL_NO_PATTERN.test(serialNo) && !note.has(serialNo)
            ? { serialNo, result: 'NOT_IN_DELIVERY_NOTE', message: `발주 ${locked.poNo}의 납품 명세에 없는 시리얼입니다.` }
            : null,
        );
        const rest = dto.serials.flatMap((serialNo, i) => (results[i] ? [] : [{ serialNo, i }]));
        const registered = await this.bulk.registerMany(
          tx,
          rest.map(({ serialNo }) => ({ serialNo, modelCode: locked.model.code })),
          {
            actor,
            source: TransitionSource.SCAN,
            reason: `박스 입고: 발주 ${locked.poNo}`,
            assign: (terminal) => {
              terminal.purchaseOrder = locked;
            },
          },
        );
        rest.forEach(({ i }, k) => (results[i] = registered[k]));
        return tx.create(ScanBatch, {
          scanId: dto.scanId,
          kind: ScanKind.RECEIVE,
          poNo: locked.poNo,
          requestHash: hash,
          actor,
          results: results as RowResult[],
        });
      }),
    );
  }

  /**
   * 회수 입고: RETURNING → RETURNED(source SCAN)를 한 트랜잭션에서. 단말기는 한 번의 조회로 id 순서대로 읽고,
   * 상태가 다르면 그 행만 INVALID_STATE. version이 그사이 바뀐 행이 있으면 박스 전체가 409로 롤백된다(같은 scanId로 다시 보내면 된다).
   */
  private async returnIn(dto: CreateScanDto, actor: string, hash: string): Promise<ScanBatch> {
    return this.em.fork().transactional(async (tx) => {
      const results = precheckSerials(dto.serials);
      const pending = dto.serials.flatMap((serialNo, i) => (results[i] ? [] : [{ serialNo, i }]));
      const terminals = pending.length
        ? await tx.find(Terminal, { serialNo: { $in: pending.map((p) => p.serialNo) } }, { populate: ['model'], orderBy: { id: 'asc' } })
        : [];
      const bySerial = new Map(terminals.map((t) => [t.serialNo, t]));
      const found = pending.filter((p) => {
        if (bySerial.has(p.serialNo)) return true;
        results[p.i] = { serialNo: p.serialNo, result: 'NOT_FOUND', message: '등록되지 않은 시리얼입니다.' };
        return false;
      });
      const checks = await this.transitions.transitionMany(
        tx,
        found.map((p) => ({ terminal: bySerial.get(p.serialNo)!, to: TerminalStatus.RETURNED, reason: '박스 회수 입고' })),
        { actor, source: TransitionSource.SCAN },
      );
      found.forEach((p, k) => {
        const check = checks[k];
        results[p.i] = check.ok
          ? { serialNo: p.serialNo, result: 'RETURNED' }
          : { serialNo: p.serialNo, result: 'INVALID_STATE', message: check.reason };
      });
      return tx.create(ScanBatch, { scanId: dto.scanId, kind: ScanKind.RETURN_IN, poNo: null, requestHash: hash, actor, results: results as RowResult[] });
    });
  }

  private closed(poNo: string): BusinessError {
    return new BusinessError(422, 'PO_CLOSED', `발주 ${poNo}은(는) 마감돼 입고 스캔을 받지 않습니다.`);
  }
}
```

`apps/api/src/scan/scan.controller.ts`:
```ts
import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Operator } from '../common/operator.decorator.js';
import { summarize } from '../terminal/bulk-rows.js';
import { CreateScanDto } from './dto/create-scan.dto.js';
import type { ScanBatch } from './scan-batch.entity.js';
import { ScanService } from './scan.service.js';

function toScanView(batch: ScanBatch, replayed: boolean) {
  return {
    scanId: batch.scanId,
    kind: batch.kind,
    poNo: batch.poNo ?? null,
    actor: batch.actor,
    replayed,
    createdAt: batch.createdAt.toISOString(),
    summary: summarize(batch.results),
    results: batch.results,
  };
}

@Controller('scans')
export class ScanController {
  constructor(private readonly scans: ScanService) {}

  /** 새로 처리했으면 201, 같은 scanId를 다시 보내 저장된 결과를 돌려주면 200(replayed: true) */
  @Post()
  async scan(@Body() dto: CreateScanDto, @Operator() actor: string, @Res({ passthrough: true }) res: Response) {
    const { batch, replayed } = await this.scans.scan(dto, actor);
    res.status(replayed ? 200 : 201);
    return toScanView(batch, replayed);
  }

  @Get(':scanId')
  async get(@Param('scanId') scanId: string) {
    return toScanView(await this.scans.get(scanId), true);
  }
}
```

`apps/api/src/scan/scan.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { PurchaseOrderModule } from '../purchase-order/purchase-order.module.js';
import { TerminalModule } from '../terminal/terminal.module.js';
import { ScanController } from './scan.controller.js';
import { ScanLock } from './scan-lock.js';
import { ScanService } from './scan.service.js';

@Module({
  imports: [TerminalModule, PurchaseOrderModule],
  controllers: [ScanController],
  providers: [ScanService, ScanLock],
})
export class ScanModule {}
```

`apps/api/src/entities.ts` 전체:
```ts
import { TerminalModel } from './terminal/terminal-model.entity.js';
import { Terminal } from './terminal/terminal.entity.js';
import { TerminalStatusHistory } from './terminal/terminal-status-history.entity.js';
import { InspectionItem } from './inspection/inspection-item.entity.js';
import { Inspection, InspectionResult } from './inspection/inspection.entities.js';
import { Merchant } from './merchant/merchant.entity.js';
import { CarrierEvent, Shipment, SyncRun } from './shipment/shipment.entities.js';
import { OutboxEvent } from './outbox/outbox-event.entity.js';
import { PurchaseOrder } from './purchase-order/purchase-order.entity.js';
import { ScanBatch } from './scan/scan-batch.entity.js';

/** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch];
```

`apps/api/src/app.module.ts` 전체(`ScanModule` import):
```ts
import { type DynamicModule, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import ormConfig from './mikro-orm.config.js';
import { HealthController } from './health/health.controller.js';
import { DomainExceptionFilter } from './common/domain-exception.filter.js';
import { TerminalModule } from './terminal/terminal.module.js';
import { InspectionModule } from './inspection/inspection.module.js';
import { MerchantModule } from './merchant/merchant.module.js';
import { ShipmentModule } from './shipment/shipment.module.js';
import { QueuesModule } from './queue/queues.module.js';
import { CarrierSyncModule } from './carrier-sync/carrier-sync.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { PurchaseOrderModule } from './purchase-order/purchase-order.module.js';
import { ScanModule } from './scan/scan.module.js';
import { WorkersModule } from './workers/workers.module.js';
import { SchedulerModule } from './scheduler/scheduler.module.js';

export interface AppOptions {
  /** 큐 job을 처리할지(RUN_WORKERS) */
  workers?: boolean;
  /** 주기 작업을 등록할지(RUN_SCHEDULERS) */
  schedulers?: boolean;
}

@Module({
  // forRoot가 요청마다 EntityManager를 fork하는 RequestContext 미들웨어를 자동 등록한다.
  imports: [
    MikroOrmModule.forRoot(ormConfig),
    QueuesModule,
    TerminalModule,
    InspectionModule,
    MerchantModule,
    ShipmentModule,
    CarrierSyncModule,
    OutboxModule,
    PurchaseOrderModule,
    ScanModule,
  ],
  controllers: [HealthController],
  providers: [
    // main.ts의 useGlobalPipes/Filters는 테스트 앱에 적용되지 않는다. 모듈 provider로 등록해 테스트에서도 같게 동작시킨다.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {
  /** 실행 모드에 따라 워커·스케줄러를 붙인다. `imports: [AppModule]`만 쓰면 둘 다 없다(decisions/0015). */
  static forRoot(options: AppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [...(options.workers ? [WorkersModule] : []), ...(options.schedulers ? [SchedulerModule] : [])],
    };
  }
}
```

- [ ] **Step 5: 통과 확인 (스캔 테스트는 3회)**

Run:
```bash
npx vitest run && npm run typecheck
for i in 1 2 3; do npx vitest run test/scan.e2e.spec.ts 2>&1 | grep -E "Tests "; done
```
Expected: 21개 파일 `148 passed`, typecheck exit 0, 스캔 테스트 3회 모두 `7 passed`

- [ ] **Step 6: 마이그레이션**

Run: `npm run db:migration:create`
Expected: up()이 다음과 같다(scan_batch에는 외래키가 없다).
```ts
    this.addSql(`create table \`scan_batch\` (\`id\` int unsigned not null auto_increment primary key, \`scan_id\` varchar(64) not null, \`kind\` enum('RECEIVE','RETURN_IN') not null, \`po_no\` varchar(30) null, \`request_hash\` varchar(64) not null, \`actor\` varchar(50) not null, \`results\` json not null, \`created_at\` datetime not null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`scan_batch\` add unique \`scan_batch_scan_id_unique\` (\`scan_id\`);`);
    this.addSql(`alter table \`scan_batch\` add index \`scan_batch_po_no_index\` (\`po_no\`);`);

    this.addSql(`alter table \`terminal\` add \`purchase_order_id\` int unsigned null;`);
    this.addSql(`alter table \`terminal\` add constraint \`terminal_purchase_order_id_foreign\` foreign key (\`purchase_order_id\`) references \`purchase_order\` (\`id\`) on delete set null;`);
    this.addSql(`alter table \`terminal\` add index \`terminal_purchase_order_id_index\` (\`purchase_order_id\`);`);
```
Run:
```bash
npm run db:migrate
npm run db:migration:check
```
Expected: `적용: Migration<시각>`, `최신 상태`

- [ ] **Step 7: 기록과 커밋**

`docs/decisions/0020-박스-스캔-멱등은-Redis-잠금과-ScanBatch.md`:
- 상황: 스캐너는 응답을 못 받으면 같은 박스를 다시 보낸다. 같은 박스를 두 번 반영하면 안 된다(설계안 F6 "중복 스캔은 한 번만"). 처리 중에 두 번째 요청이 오는 경우와, 끝난 뒤 다시 오는 경우가 있다.
- 왜 Redis인가(CLAUDE.md 원칙): "지금 처리 중"은 짧게 살다 사라지는 정보이고, 프로세스가 죽으면 저절로 풀려야 한다(TTL). MySQL로 하면 잠금 행을 만들고 지우는 쓰기가 늘고, 죽은 프로세스의 행을 치울 방법이 따로 필요하다.
- 왜 MySQL(ScanBatch)도인가: 처리 결과는 영구히 남아야 하고(재요청에 같은 결과, 대조 리포트의 unexpected 출처), 반영과 **같은 트랜잭션**에 저장돼야 "반영됐는데 결과 기록이 없다"가 생기지 않는다. Redis만 쓰면 TTL·유실 뒤 같은 scanId가 다시 처리된다.
- 선택지:
  1. MySQL만: ScanBatch를 트랜잭션 첫 문장으로 INSERT해 unique 키로 줄 세우기. 두 번째 요청은 첫 트랜잭션이 끝날 때까지 커넥션을 쥐고 기다린다(큰 박스면 수 초).
  2. Redis만: 위 이유로 영구 결과가 없다.
  3. **Redis SET NX PX(처리 중) + MySQL ScanBatch(완료 결과, scan_id unique)**: 처리 중 중복은 즉시 409 SCAN_IN_PROGRESS, 끝난 뒤 중복은 200 replayed.
- 결정: 3. 잠금 키는 큐와 같은 접두사(`<QUEUE_PREFIX>:scan-lock:<scanId>`)라 테스트 키는 globalSetup이 지운다. 해제는 토큰 비교 Lua(남이 잡은 잠금을 지우지 않게). TTL(30초)이 지나 둘 다 처리되면 `scan_batch.scan_id` unique가 늦은 쪽을 롤백시키고 먼저 끝난 결과를 준다.
- 같은 scanId, 다른 내용: 요청(kind, poNo, serials)의 SHA-256을 저장해 다르면 422 SCAN_ID_REUSED.
- 테스트: 첫 요청을 엔진 안에서 멈춘 채 같은 scanId → 409, 풀린 뒤 → 200 replayed, 이력 수 그대로.

`docs/decisions/0021-입고는-명세-밖-시리얼을-거절한다.md`:
- 상황: 공장 명세에 없는 시리얼이 박스에 들어 있을 수 있다(세움 골칫거리). 등록하고 표시할지, 거절할지(브리프 권장: 거절).
- 선택지:
  1. 등록하고 "명세 외" 표시: 재고에 출처 불명 단말기가 섞인다. 나중에 반품하려면 상태·이력을 또 만들어야 한다.
  2. **거절(NOT_IN_DELIVERY_NOTE), 결과에만 남김**: 대조 리포트의 unexpected는 ScanBatch 결과에서 구한다. 실물은 창고가 따로 격리한다.
- 결정: 2. 명세에 섞여 온 다른 발주의 시리얼(foreignSerials)은 "명세에 있으니" 받는다 — 공장 번호 체계를 알아야 걸러낼 수 있어 하지 않는다(스펙 9장).
- 잠금 순서: 입고 트랜잭션은 **발주 행을 FOR UPDATE로 먼저** 잠근다. 단말기 INSERT의 `purchase_order_id` FK 검사가 발주 행에 S 락을 거는데, 그보다 X 락이 먼저여야 같은 발주를 동시에 스캔해도 S→X 데드락이 없다(troubleshooting/0004). 같은 발주의 스캔·마감(Task 7)이 이 잠금에서 줄을 선다.
- 입고 연결: `terminal.purchase_order_id`(nullable FK). 대조에서 입고 수를 DB에서 센다.

`docs/decisions/0019-일괄-처리는-행별-결과와-한-트랜잭션.md` 끝에 한 줄:
```
- 갱신(Task 5): RETURN_IN은 TransitionService.transitionMany로 UPDATE 한 번(CASE). 그사이 version이 바뀐 행이 있으면 박스 전체 409, 같은 scanId로 다시 보내면 새로 처리된다.
```

`docs/study/backlog.md`에 추가:
```
- [ ] Redis 분산 잠금(SET NX PX + 토큰 비교 해제)과 그 한계 — TTL보다 오래 걸리면? Redlock 논쟁 (scan-lock.ts, decisions/0020)
- [ ] 멱등 키(Idempotency-Key) 설계 — 같은 키 다른 내용은 거절 (decisions/0020)
- [ ] MikroORM 다건 UPDATE가 CASE 문 하나로 나가는 방식과 낙관적 락 (transition.service.ts transitionMany)
```

커밋:
```bash
git add apps/api docs
git commit -m "feat(F6): 박스 일괄 스캔(입고·회수 입고)과 scanId 멱등" -m "Refs: docs/decisions/0020-박스-스캔-멱등은-Redis-잠금과-ScanBatch.md, docs/decisions/0021-입고는-명세-밖-시리얼을-거절한다.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 엑셀 일괄 등록 — exceljs + FileInterceptor, 같은 엔진 (F1)

**Files:**
- Modify: `apps/api/package.json`, `apps/api/package-lock.json`(설치 명령)
- Create: `apps/api/src/terminal/terminal-import.service.ts`
- Modify: `apps/api/src/terminal/terminal.controller.ts`(`POST /terminals/imports`), `apps/api/src/terminal/terminal.module.ts`
- Test: `apps/api/test/terminal-import.e2e.spec.ts`
- Record: devlog, `docs/decisions/0022-엑셀-일괄-등록은-exceljs와-메모리-업로드.md`, `docs/decisions/0005-엑셀-일괄-등록은-Day3로.md`(갱신 한 줄), `docs/study/backlog.md`

`POST /terminals/imports`(multipart, 필드 `file`, `.xlsx`, 2MB 이하, X-Operator 필수). 첫 시트 1행 머리글에서 `serialNo`·`modelCode` 열을 이름으로 찾고(순서·다른 열 무관), 빈 행은 건너뛰고, 셀은 보이는 글자(`cell.text`)를 앞뒤 공백 없이 쓴다. 데이터 5000행 초과는 400. 같은 엔진(source IMPORT, 사유 `엑셀 일괄 등록: <파일 이름>`)으로 등록하고 `{ fileName, total, summary, results: [{ row, serialNo, result, message? }] }`를 201로 준다(`row`는 엑셀 행 번호).

- [ ] **Step 1: exceljs 설치**

Run: `npm install exceljs@4.4.0`
Expected: `package.json` dependencies에 `"exceljs": "^4.4.0"`. `npm audit`이 exceljs가 쓰는 uuid의 moderate 2건을 보여 준다(사전 검증). `npm audit fix --force`는 exceljs를 3.4.0으로 내리므로 하지 않는다 — 결정 기록에 적는다.

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/api/test/terminal-import.e2e.spec.ts`:
```ts
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'oh' };

/** 첫 시트에 행들을 쓴 .xlsx 버퍼 */
async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('terminals');
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('엑셀 일괄 등록 (F1, decisions/0005·0022)', () => {
  let t: TestApp;
  const upload = (buffer: Buffer, name = 'terminals.xlsx') => t.http().post('/terminals/imports').set(OP).attach('file', buffer, name);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await t.http().post('/terminals').set(OP).send({ serialNo: 'XL-EXIST', modelCode: 'SN-100' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('행마다 엑셀 행 번호와 결과를 주고, 유효한 행만 IMPORT 출처로 등록한다', async () => {
    const file = await xlsx([
      ['serialNo', 'modelCode'],
      ['XL-0001', 'SN-100'],
      ['XL-EXIST', 'SN-100'],
      ['xl-bad', 'SN-100'],
      [],
      ['XL-0002', 'SN-999'],
      [' XL-0003 ', 'SN-200'],
      [20261023, 'SN-300'],
    ]);
    const res = await upload(file, '10월 입고.xlsx');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ total: 6, summary: { CREATED: 3, ALREADY_EXISTS: 1, INVALID_FORMAT: 1, UNKNOWN_MODEL: 1 } });
    // 빈 행(5행)은 건너뛰고, 앞뒤 공백은 지우고, 숫자 셀은 보이는 글자 그대로 쓴다.
    expect(res.body.results.map((r: { row: number; serialNo: string; result: string }) => [r.row, r.serialNo, r.result])).toEqual([
      [2, 'XL-0001', 'CREATED'],
      [3, 'XL-EXIST', 'ALREADY_EXISTS'],
      [4, 'xl-bad', 'INVALID_FORMAT'],
      [6, 'XL-0002', 'UNKNOWN_MODEL'],
      [7, 'XL-0003', 'CREATED'],
      [8, '20261023', 'CREATED'],
    ]);
    const [history] = await t.orm.em.fork().find(TerminalStatusHistory, { terminal: { serialNo: 'XL-0003' } });
    expect(history).toMatchObject({ source: 'IMPORT', actor: 'oh', reason: '엑셀 일괄 등록: 10월 입고.xlsx' });
  });

  it('열 순서가 달라도, 다른 열이 있어도 머리글 이름으로 찾는다', async () => {
    const res = await upload(await xlsx([['비고', 'modelCode', 'serialNo'], ['메모', 'SN-100', 'XL-0101']]));
    expect(res.status).toBe(201);
    expect(res.body.results).toEqual([{ row: 2, serialNo: 'XL-0101', result: 'CREATED' }]);
  });

  it('머리글에 serialNo·modelCode가 없으면 400 MISSING_COLUMNS', async () => {
    const res = await upload(await xlsx([['시리얼', '모델'], ['XL-0201', 'SN-100']]));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_COLUMNS');
  });

  it('xlsx가 아니면 400 INVALID_FILE, 파일이 없으면 400', async () => {
    const fake = await upload(Buffer.from('serialNo,modelCode\nXL-0301,SN-100\n'), 'terminals.xlsx');
    expect(fake.status).toBe(400);
    expect(fake.body.code).toBe('INVALID_FILE');
    const csv = await upload(await xlsx([['serialNo', 'modelCode']]), 'terminals.csv');
    expect(csv.status).toBe(400);
    expect(csv.body.code).toBe('INVALID_FILE');
    expect((await t.http().post('/terminals/imports').set(OP)).status).toBe(400);
  });

  it('데이터 행이 5000개를 넘으면 400 TOO_MANY_ROWS', async () => {
    const rows = [['serialNo', 'modelCode'], ...Array.from({ length: 5001 }, (_, i) => [`XL-M${String(i).padStart(5, '0')}`, 'SN-100'])];
    const res = await upload(await xlsx(rows));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TOO_MANY_ROWS');
  });

  it('2MB보다 큰 파일은 413', async () => {
    const res = await upload(Buffer.alloc(2 * 1024 * 1024 + 1), 'big.xlsx');
    expect(res.status).toBe(413);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run test/terminal-import.e2e.spec.ts`
Expected: FAIL — 6개 모두. 라우트가 없어 `POST /terminals/imports`가 404(`expected 404 to be 201` 등)

- [ ] **Step 4: 구현**

`apps/api/src/terminal/terminal-import.service.ts`:
```ts
import { BadRequestException, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { BulkRegistrationService, type BulkRegisterRow } from './bulk-registration.service.js';
import { summarize, type RowResult } from './bulk-rows.js';
import { TransitionSource } from './terminal-status.js';

/** 한 파일에서 받는 데이터 행 수 상한 */
export const MAX_IMPORT_ROWS = 5000;

/** multer 메모리 저장소가 주는 파일(필요한 필드만) */
export interface UploadedSpreadsheet {
  originalname: string;
  size: number;
  buffer: Buffer;
}

export interface ImportRow extends BulkRegisterRow {
  /** 엑셀 행 번호(머리글이 1행) */
  row: number;
}

function invalid(code: string, message: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, code, message });
}

/**
 * .xlsx 첫 시트를 읽는다. 1행은 머리글이고 serialNo·modelCode 열을 이름으로 찾는다(순서·다른 열 무관).
 * 빈 행은 건너뛰고, 셀은 보이는 글자(cell.text)를 앞뒤 공백 없이 쓴다 — 숫자로 저장된 시리얼도 글자 그대로 받는다.
 */
export async function readImportRows(buffer: Buffer): Promise<ImportRow[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs 4.4.0 타입은 load 인자를 ArrayBuffer 계열(자체 Buffer 선언)로 적어 Node Buffer(Uint8Array)와 타입이 맞지 않는다.
    // 실행에서는 Node Buffer를 그대로 읽는다(사전 검증). 타입만 맞춘다.
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw invalid('INVALID_FILE', '.xlsx 파일을 읽을 수 없습니다.');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw invalid('INVALID_FILE', '시트가 없습니다.');

  const header = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, col) => header.set(cell.text.trim(), col));
  const serialCol = header.get('serialNo');
  const modelCol = header.get('modelCode');
  if (!serialCol || !modelCol) throw invalid('MISSING_COLUMNS', '1행 머리글에 serialNo, modelCode 열이 있어야 합니다.');

  const rows: ImportRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const serialNo = row.getCell(serialCol).text.trim();
    const modelCode = row.getCell(modelCol).text.trim();
    if (!serialNo && !modelCode) return;
    rows.push({ row: rowNumber, serialNo, modelCode });
  });
  if (rows.length > MAX_IMPORT_ROWS) throw invalid('TOO_MANY_ROWS', `데이터 행은 ${MAX_IMPORT_ROWS}개까지 받습니다(받은 행: ${rows.length}).`);
  return rows;
}

/** 엑셀 일괄 등록(F1, decisions/0005·0022). 박스 스캔과 같은 일괄 등록 엔진을 쓴다(source IMPORT). */
@Injectable()
export class TerminalImportService {
  constructor(private readonly bulk: BulkRegistrationService) {}

  async import(file: UploadedSpreadsheet | undefined, actor: string) {
    if (!file) throw invalid('INVALID_FILE', 'file 필드로 .xlsx 파일을 보내세요.');
    if (!file.originalname.toLowerCase().endsWith('.xlsx')) throw invalid('INVALID_FILE', '.xlsx 파일만 받습니다.');
    const rows = await readImportRows(file.buffer);
    const results = await this.bulk.register(rows, {
      actor,
      source: TransitionSource.IMPORT,
      reason: `엑셀 일괄 등록: ${file.originalname}`.slice(0, 200),
    });
    return {
      fileName: file.originalname,
      total: rows.length,
      summary: summarize(results),
      results: results.map((r: RowResult, i) => ({ row: rows[i].row, ...r })),
    };
  }
}
```

`apps/api/src/terminal/terminal.controller.ts` 전체:
```ts
import { Body, Controller, Get, HttpCode, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Operator } from '../common/operator.decorator.js';
import { RegisterTerminalDto } from './dto/register-terminal.dto.js';
import { ListTerminalsQuery } from './dto/list-terminals.query.js';
import { TransitionDto } from './dto/transition.dto.js';
import { TerminalImportService, type UploadedSpreadsheet } from './terminal-import.service.js';
import { TerminalService } from './terminal.service.js';
import { TransitionService } from './transition.service.js';
import { TransitionSource } from './terminal-status.js';
import { toHistoryView, toTerminalView } from './terminal.views.js';

@Controller('terminals')
export class TerminalController {
  constructor(
    private readonly terminals: TerminalService,
    private readonly transitions: TransitionService,
    private readonly imports: TerminalImportService,
  ) {}

  /**
   * 엑셀 일괄 등록. multipart의 file 필드(.xlsx, 2MB 이하). multer 기본 메모리 저장소라 디스크에 쓰지 않는다.
   * defParamCharset utf8: 한글 파일 이름이 깨지지 않게(multer 기본은 latin1).
   */
  @Post('imports')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1 }, defParamCharset: 'utf8' }))
  async import(@UploadedFile() file: UploadedSpreadsheet | undefined, @Operator() actor: string) {
    return this.imports.import(file, actor);
  }

  @Post()
  async register(@Body() dto: RegisterTerminalDto, @Operator() actor: string) {
    return toTerminalView(await this.terminals.register(dto, actor));
  }

  @Get()
  async list(@Query() query: ListTerminalsQuery) {
    const result = await this.terminals.list(query);
    return { ...result, items: result.items.map(toTerminalView) };
  }

  @Get(':serialNo')
  async get(@Param('serialNo') serialNo: string) {
    return toTerminalView(await this.terminals.getBySerial(serialNo));
  }

  @Get(':serialNo/history')
  async history(@Param('serialNo') serialNo: string) {
    return (await this.terminals.history(serialNo)).map(toHistoryView);
  }

  @Post(':serialNo/transitions')
  @HttpCode(200)
  async transition(@Param('serialNo') serialNo: string, @Body() dto: TransitionDto, @Operator() actor: string) {
    const terminal = await this.transitions.transition({
      serialNo,
      to: dto.to,
      reason: dto.reason,
      actor,
      source: TransitionSource.MANUAL,
      expectedVersion: dto.expectedVersion,
    });
    return toTerminalView(terminal);
  }
}
```

`apps/api/src/terminal/terminal.module.ts` 전체:
```ts
import { Module } from '@nestjs/common';
import { BulkRegistrationService } from './bulk-registration.service.js';
import { TerminalController } from './terminal.controller.js';
import { TerminalImportService } from './terminal-import.service.js';
import { TerminalService } from './terminal.service.js';
import { TransitionService } from './transition.service.js';

@Module({
  controllers: [TerminalController],
  providers: [TerminalService, TransitionService, BulkRegistrationService, TerminalImportService],
  exports: [TerminalService, TransitionService, BulkRegistrationService],
})
export class TerminalModule {}
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run && npm run typecheck && npm run build`
Expected: 22개 파일 `154 passed`, typecheck·build exit 0. (`import ExcelJS from 'exceljs'`가 tsc·vitest·`node dist`에서 모두 동작해야 한다. `import { Workbook } from 'exceljs'`로 쓰면 실행 때 `undefined`다 — 사전 검증.)

- [ ] **Step 6: 한글 파일 이름 확인 (되돌릴 실험)**

`terminal.controller.ts`의 FileInterceptor 옵션에서 `defParamCharset: 'utf8'`을 잠깐 지우고 `npx vitest run test/terminal-import.e2e.spec.ts`를 돌린다.
Expected: 첫 테스트가 `"reason": "엑셀 일괄 등록: 10ì ìê³ .xlsx"`처럼 깨진 이름으로 실패한다(multer 기본 latin1). 확인했으면 되돌리고 통과를 다시 본다. 출력을 devlog와 결정 기록에 붙인다.

- [ ] **Step 7: 기록과 커밋**

`docs/decisions/0022-엑셀-일괄-등록은-exceljs와-메모리-업로드.md`:
- 상황: decisions/0005에서 Day 3로 미룬 엑셀 일괄 등록. 박스 스캔과 같은 규칙(행별 결과, 한 트랜잭션)이어야 한다.
- 선택지(라이브러리): 1) exceljs 4.4.0: 읽기·쓰기, 타입 포함, 테스트에서 파일도 만든다. CommonJS라 default import만 된다. uuid moderate 2건. 2) SheetJS(xlsx): 최신판이 npm 레지스트리 밖 배포라 버전 고정·감사가 번거롭다. 3) CSV만: 운영자가 엑셀에서 저장 형식을 바꿔야 한다.
- 선택지(업로드): 1) **multer 메모리 저장소 + 크기 제한**: 디스크 정리가 필요 없고 2MB면 메모리 부담이 작다. 2) 디스크 저장 후 스트리밍 읽기: 큰 파일엔 맞지만 임시 파일 정리가 생긴다.
- 결정: exceljs + 메모리. 제한: 2MB(`limits.fileSize`, 넘으면 413), 파일 1개, `.xlsx`만, 데이터 5000행. 머리글은 이름으로 찾는다. `defParamCharset: 'utf8'`(Step 6 근거). `xlsx.load`의 Buffer 타입 불일치는 `as unknown as ArrayBuffer`로 타입만 맞췄다(실행은 Node Buffer를 읽는다).
- 결과·대가: uuid 권고는 exceljs 내부 사용(v4 uuid 생성)이라 우리 입력이 그 경로로 가지 않는다고 판단하고 그대로 둔다(다시 볼 조건: exceljs 새 버전, 또는 권고 등급 상향). 5000행 × 한 트랜잭션의 시간은 실험 0006에서 1,000행으로 잰다.

`docs/decisions/0005-엑셀-일괄-등록은-Day3로.md` 끝에 한 줄:
```
- 갱신(2026-10-23 Day 3): 구현함 → decisions/0019(엔진), 0022(엑셀)
```

`docs/study/backlog.md`에 추가:
```
- [ ] multipart/form-data와 Content-Disposition filename 인코딩(latin1 기본, RFC 5987 filename*) (terminal.controller.ts, decisions/0022)
- [ ] CommonJS 패키지를 ESM에서 default import로 쓰기 — named import가 undefined가 되는 이유(cjs-module-lexer) (terminal-import.service.ts)
```

커밋:
```bash
git add apps/api docs
git commit -m "feat(F1): 엑셀 일괄 등록(exceljs, 같은 일괄 등록 엔진)" -m "Refs: docs/decisions/0022-엑셀-일괄-등록은-exceljs와-메모리-업로드.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 발주 대비 입고 대조와 발주 마감 (F10)

**Files:**
- Modify: `apps/api/src/purchase-order/purchase-order.service.ts`(`reconcile`, `close`), `purchase-order.controller.ts`, `purchase-order.entity.ts`(`closedBy`), `purchase-order.views.ts`
- Create: `apps/api/src/migrations/Migration<시각>.ts`(생성 명령)
- Test: `apps/api/test/reconciliation.e2e.spec.ts`(새), `apps/api/test/purchase-order.e2e.spec.ts`(`closedBy: null`)
- Record: devlog, `docs/troubleshooting/0008-JSON_TABLE-collation-충돌.md`, `docs/study/backlog.md`

- `GET /purchase-orders/:poNo/reconciliation` → `{ poNo, modelCode, status, ordered, noted, received, shortfall, missing, unexpected }`. 명세가 아직 없으면 받아 온다. 숫자와 목록은 DB에서 구한다: received = `count(*) … where purchase_order_id`, missing = 명세(JSON 배열)를 `JSON_TABLE`로 행으로 펼쳐 단말기와 LEFT JOIN(명세 순서), unexpected = `scan_batch.results`를 `JSON_TABLE`로 펼쳐 NOT_IN_DELIVERY_NOTE만(시리얼 순서).
- `POST /purchase-orders/:poNo/close`(X-Operator) → 200, 마감 시점의 대조 결과 + `status: CLOSED`, `closedAt`, `closedBy`. 발주 행을 FOR UPDATE로 잠그므로 진행 중인 입고 스캔이 있으면 그것이 커밋된 뒤 마감된다. 이미 마감이면 422 PO_ALREADY_CLOSED. 마감 뒤 입고 스캔은 422 PO_CLOSED(Task 5).

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/reconciliation.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkRegistrationService } from '../src/terminal/bulk-registration.service.js';
import { partners } from './helpers/partners.js';
import { captureQueries } from './helpers/query-log.js';
import { orderPurchase } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'ryu' };

describe('발주 대비 입고 대조·마감 (F10)', () => {
  let t: TestApp;
  const scan = (scanId: string, poNo: string, serials: string[]) =>
    t.http().post('/scans').set(OP).send({ scanId, kind: 'RECEIVE', poNo, serials });
  const reconcile = (poNo: string) => t.http().get(`/purchase-orders/${poNo}/reconciliation`);
  const close = (poNo: string) => t.http().post(`/purchase-orders/${poNo}/close`).set(OP);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('발주 수량·명세 수·입고 수와 미입고(missing)·명세 외(unexpected)·부족분(shortfall)을 DB에서 집계한다', async () => {
    // 공장 골칫거리: 2대 덜 보내고, 다른 발주의 시리얼 1개를 명세에 섞는다 → 명세 = 4 + 1
    await partners.configure({ seum: { shortfall: 2, foreignSerials: 1 } });
    const { poNo, serials } = await orderPurchase(t, 6);
    const own = serials.filter((s) => s.startsWith(`${poNo}-`));
    const foreign = serials.find((s) => !s.startsWith(`${poNo}-`))!;
    expect(own).toHaveLength(4);

    await scan('REC-BOX-0001', poNo, [own[0], own[1], 'SE999-0001']);
    await scan('REC-BOX-0002', poNo, [own[2], foreign, 'SE999-0002', 'SE999-0001']);

    const cap = captureQueries(t.orm);
    const res = await reconcile(poNo);
    cap.stop();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      poNo,
      modelCode: 'SN-100',
      status: 'RECEIVING',
      ordered: 6,
      noted: 5,
      received: 4,
      shortfall: 1,
      missing: [own[3]],
      unexpected: ['SE999-0001', 'SE999-0002'],
    });
    console.log(`[대조 쿼리] ${cap.queries.length}개: ${cap.queries.map((q) => q.slice(0, 40)).join(' | ')}`);
    expect(cap.selects()).toBeLessThanOrEqual(4);
  });

  it('입고 전이면 명세를 받아 와 전부 missing', async () => {
    const { poNo, serials } = await orderPurchase(t, 3);
    const res = await reconcile(poNo);
    expect(res.body).toMatchObject({ status: 'ORDERED', ordered: 3, noted: 3, received: 0, shortfall: 0, missing: serials, unexpected: [] });
  });

  it('마감하면 CLOSED와 마감 시점의 대조 결과를 주고, 이후 입고 스캔은 422 PO_CLOSED, 다시 마감하면 422', async () => {
    const { poNo, serials } = await orderPurchase(t, 2);
    await scan('REC-BOX-0101', poNo, [serials[0]]);
    const res = await close(poNo);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ poNo, status: 'CLOSED', closedBy: 'ryu', received: 1, missing: [serials[1]] });
    expect(res.body.closedAt).toEqual(expect.any(String));

    const late = await scan('REC-BOX-0102', poNo, [serials[1]]);
    expect(late.status).toBe(422);
    expect(late.body.code).toBe('PO_CLOSED');
    const again = await close(poNo);
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('PO_ALREADY_CLOSED');
  });

  it('입고 스캔 트랜잭션이 발주 행을 잠근 동안 마감은 기다렸다가, 스캔이 커밋된 뒤 마감된다', async () => {
    const { poNo, serials } = await orderPurchase(t, 2);
    const bulk = t.app.get(BulkRegistrationService);
    const original = bulk.registerMany.bind(bulk);
    let release!: () => void;
    let markEntered!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((r) => (markEntered = r));
    const spy = vi.spyOn(bulk, 'registerMany').mockImplementationOnce(async (...args) => {
      markEntered(); // 이 시점에 스캔 트랜잭션은 발주 행을 FOR UPDATE로 잡고 있다
      await released;
      return original(...args);
    });
    try {
      // supertest 요청은 then을 불러야 보내진다. 기다리지 않고 보내 두려고 then을 붙인다.
      const scanning = scan('REC-BOX-0201', poNo, serials).then((r) => r);
      await entered;
      let closedAt = 0;
      const closing = close(poNo).then((r) => ((closedAt = Date.now()), r));
      await new Promise((r) => setTimeout(r, 300));
      const closedWhileScanning = closedAt !== 0;
      const releasedAt = Date.now();
      release();
      expect((await scanning).status).toBe(201);
      const closed = await closing;
      expect(closedWhileScanning).toBe(false);
      expect(closedAt).toBeGreaterThanOrEqual(releasedAt);
      expect(closed.status).toBe(200);
      expect(closed.body).toMatchObject({ status: 'CLOSED', received: 2, missing: [] });
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('없는 발주는 404', async () => {
    expect((await reconcile('SE0')).status).toBe(404);
    expect((await close('SE0')).status).toBe(404);
  });
});
```

`apps/api/test/purchase-order.e2e.spec.ts` 전체(첫 테스트에 `closedBy: null`):
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PurchaseOrder, PurchaseOrderStatus } from '../src/purchase-order/purchase-order.entity.js';
import { partners } from './helpers/partners.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'jung' };

describe('발주 (F10)', () => {
  let t: TestApp;
  const factoryCalls = async () => (await partners.stats()).calls['seum.purchaseOrder'] ?? 0;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('발주하면 세움전자에 발주하고 그 발주번호로 저장한다(ORDERED)', async () => {
    const res = await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-100', quantity: 20 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ modelCode: 'SN-100', quantity: 20, status: 'ORDERED', orderedBy: 'jung', closedAt: null, closedBy: null });
    expect(res.body.poNo).toMatch(/^SE\d+$/);
    expect(await factoryCalls()).toBe(1);

    const saved = await t.orm.em.fork().findOneOrFail(PurchaseOrder, { poNo: res.body.poNo });
    expect(saved.status).toBe(PurchaseOrderStatus.ORDERED);
    expect(saved.deliveryNote).toBeNull(); // 명세는 입고를 시작할 때 받아 온다

    const got = await t.http().get(`/purchase-orders/${res.body.poNo}`);
    expect(got.status).toBe(200);
    // createdAt은 DB datetime(초 단위)로 저장돼 응답과 밀리초가 다를 수 있어 비교에서 뺀다.
    expect({ ...got.body, createdAt: undefined }).toEqual({ ...res.body, createdAt: undefined });
  });

  it('없는 모델이면 404이고 공장을 부르지 않는다', async () => {
    const res = await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-999', quantity: 5 });
    expect(res.status).toBe(404);
    expect(await factoryCalls()).toBe(0);
  });

  it('공장이 503이면 502 PARTNER_ERROR, 발주는 저장하지 않는다', async () => {
    await partners.configure({ seum: { error5xxRate: 1 } });
    const before = await t.orm.em.fork().count(PurchaseOrder);
    const res = await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-100', quantity: 5 });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'PARTNER_ERROR', reason: 'PartnerTransientError' });
    expect(await t.orm.em.fork().count(PurchaseOrder)).toBe(before);
  });

  it('수량은 1~5000, 작업자 헤더 필수', async () => {
    expect((await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-100', quantity: 0 })).status).toBe(400);
    expect((await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-100', quantity: 5001 })).status).toBe(400);
    expect((await t.http().post('/purchase-orders').send({ modelCode: 'SN-100', quantity: 1 })).status).toBe(400);
  });

  it('없는 발주번호는 404', async () => {
    expect((await t.http().get('/purchase-orders/SE0')).status).toBe(404);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/reconciliation.e2e.spec.ts test/purchase-order.e2e.spec.ts`
Expected: FAIL — 대조·마감 라우트가 없어 404(`expected 404 to be 200`), 발주 응답에 `closedBy`가 없음

- [ ] **Step 3: 엔티티·뷰·API**

`apps/api/src/purchase-order/purchase-order.entity.ts` 전체(`closedBy` — `string | null`이라 `type: 'varchar'`를 적는다):
```ts
import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TerminalModel } from '../terminal/terminal-model.entity.js';

export enum PurchaseOrderStatus {
  ORDERED = 'ORDERED', // 공장에 발주함
  RECEIVING = 'RECEIVING', // 입고 스캔을 시작함
  CLOSED = 'CLOSED', // 마감. 더는 입고 스캔을 받지 않는다
}

/** 세움전자(가상 공장)에 낸 발주. 발주번호(poNo)는 공장이 정한다. */
@Entity({ tableName: 'purchase_order' })
export class PurchaseOrder {
  [OptionalProps]?: 'status' | 'deliveryNote' | 'createdAt' | 'closedAt' | 'closedBy';

  @PrimaryKey()
  id!: number;

  @Property({ unique: true, length: 30 })
  poNo!: string;

  @ManyToOne(() => TerminalModel)
  model!: Rel<TerminalModel>;

  @Property()
  quantity!: number;

  @Enum({ items: () => PurchaseOrderStatus })
  status: PurchaseOrderStatus = PurchaseOrderStatus.ORDERED;

  /** 공장이 보낸 납품 명세(시리얼 목록). 입고를 시작할 때 받아 와 저장한다. 아직 안 받았으면 null */
  @Property({ type: 'json', nullable: true })
  deliveryNote: string[] | null = null;

  @Property({ length: 50 })
  orderedBy!: string;

  @Property()
  createdAt: Date = new Date();

  // 유니온 타입(Date | null)은 데코레이터 메타데이터가 Object라 type을 꼭 적는다.
  @Property({ type: 'datetime', nullable: true })
  closedAt: Date | null = null;

  @Property({ type: 'varchar', length: 50, nullable: true })
  closedBy: string | null = null;
}
```

`apps/api/src/purchase-order/purchase-order.views.ts` 전체:
```ts
import type { PurchaseOrder } from './purchase-order.entity.js';

/** model이 populate돼 있어야 한다. */
export function toPurchaseOrderView(po: PurchaseOrder) {
  return {
    poNo: po.poNo,
    modelCode: po.model.code,
    quantity: po.quantity,
    status: po.status,
    orderedBy: po.orderedBy,
    createdAt: po.createdAt.toISOString(),
    closedAt: po.closedAt?.toISOString() ?? null,
    closedBy: po.closedBy,
  };
}
```

`apps/api/src/purchase-order/purchase-order.controller.ts` 전체(`:poNo/reconciliation`을 `:poNo`보다 위에 둔다):
```ts
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto.js';
import { PurchaseOrderService } from './purchase-order.service.js';
import { toPurchaseOrderView } from './purchase-order.views.js';

@Controller('purchase-orders')
export class PurchaseOrderController {
  constructor(private readonly orders: PurchaseOrderService) {}

  @Post()
  async create(@Body() dto: CreatePurchaseOrderDto, @Operator() actor: string) {
    return toPurchaseOrderView(await this.orders.create(dto, actor));
  }

  @Get(':poNo/reconciliation')
  async reconciliation(@Param('poNo') poNo: string) {
    return this.orders.reconcile(poNo);
  }

  @Post(':poNo/close')
  @HttpCode(200)
  async close(@Param('poNo') poNo: string, @Operator() actor: string) {
    return this.orders.close(poNo, actor);
  }

  @Get(':poNo')
  async get(@Param('poNo') poNo: string) {
    return toPurchaseOrderView(await this.orders.get(poNo));
  }
}
```

- [ ] **Step 4: collation 충돌을 먼저 재현한다 (troubleshooting/0008)**

`apps/api/src/purchase-order/purchase-order.service.ts`를 Step 5 코드로 바꾸되, **missing 쿼리의 JSON_TABLE 열 정의에서 `collate utf8mb4_0900_ai_ci`만 빼고** 돌려 본다.
```bash
npx vitest run test/reconciliation.e2e.spec.ts
```
Expected(사전 검증, 3회 모두): 마감 경합 테스트가 `expected 500 to be 200`으로 실패하고 서버 로그에 `Error: Illegal mix of collations (utf8mb4_0900_ai_ci,IMPLICIT) and (utf8mb4_unicode_ci,IMPLICIT) for operation '='`. 첫 테스트는 같은 쿼리인데 통과했다 — 언제 비교가 실제로 평가되는지는 데이터·실행 계획에 따라 다른 것으로 보인다(추정, 확인하지 않음). MySQL 클라이언트로 원인을 확인한다(테스트 DB, 읽기만):
```bash
MSYS_NO_PATHCONV=1 docker exec terminal-ops-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" terminal_ops_test --default-character-set=utf8mb4 -e "set collation_connection=utf8mb4_unicode_ci; select n.s from json_table(\"[\\\"A\\\"]\", \"\$[*]\" columns (s varchar(32) path \"\$\")) n left join terminal t on t.serial_no = n.s;"'
MSYS_NO_PATHCONV=1 docker exec terminal-ops-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" terminal_ops_test --default-character-set=utf8mb4 -e "set collation_connection=utf8mb4_unicode_ci; explain select n.s from json_table(\"[\\\"A\\\"]\", \"\$[*]\" columns (s varchar(32) collate utf8mb4_0900_ai_ci path \"\$\")) n left join terminal t on t.serial_no = n.s where t.id is null;"'
```
Expected: 첫 명령 `ERROR 1267 (HY000) … Illegal mix of collations`, 둘째 명령 EXPLAIN에서 `t` 행이 `eq_ref | terminal_serial_no_unique`. (앱 연결의 collation은 `select @@collation_connection`으로 보면 `utf8mb4_unicode_ci` — mysql2 기본값. 테이블 열은 `information_schema.columns`에서 `utf8mb4_0900_ai_ci`.)
확인했으면 `collate`를 되돌려 넣는다(Step 5 코드 그대로).

- [ ] **Step 5: 대조·마감 서비스**

`apps/api/src/purchase-order/purchase-order.service.ts` 전체:
```ts
import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { TerminalModel } from '../terminal/terminal-model.entity.js';
import type { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto.js';
import { PurchaseOrder, PurchaseOrderStatus } from './purchase-order.entity.js';
import { SeumClient } from './seum.client.js';

@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly em: EntityManager,
    private readonly seum: SeumClient,
  ) {}

  /**
   * 발주: ① 모델 확인 ② 트랜잭션 밖에서 세움전자에 발주(HTTP) ③ 받은 발주번호로 저장.
   * ③이 실패하면 공장 쪽에 발주가 남는다(운송장과 같은 한계, decisions/0012). 확인할 수 있는 실패(없는 모델)는 ①에서 거른다.
   */
  async create(dto: CreatePurchaseOrderDto, actor: string): Promise<PurchaseOrder> {
    const model = await this.em.findOne(TerminalModel, { code: dto.modelCode });
    if (!model) throw new NotFoundException(`단말기 모델 ${dto.modelCode}이(가) 없습니다.`);

    const poNo = await this.seum.createPurchaseOrder({ modelCode: model.code, quantity: dto.quantity, reference: randomUUID() });

    const po = this.em.create(PurchaseOrder, { poNo, model, quantity: dto.quantity, orderedBy: actor });
    await this.em.flush();
    return po;
  }

  /**
   * 납품 명세를 돌려준다. 아직 안 받았으면 트랜잭션 밖에서 세움전자에 물어 저장한다(처음 한 번).
   * 동시에 두 요청이 받아 와도 내용이 같고, delivery_note가 null일 때만 쓰므로 덮어쓰지 않는다.
   */
  async ensureDeliveryNote(po: PurchaseOrder): Promise<string[]> {
    if (po.deliveryNote) return po.deliveryNote;
    const { serials } = await this.seum.getDeliveryNote(po.poNo);
    await this.em.fork().nativeUpdate(PurchaseOrder, { id: po.id, deliveryNote: null }, { deliveryNote: serials });
    po.deliveryNote = serials;
    return serials;
  }

  /**
   * 발주 대비 입고 대조(F10). 숫자와 목록은 DB에서 구한다(단말기를 앱으로 가져와 세지 않는다).
   * - noted: 납품 명세의 시리얼 수, shortfall = 발주 수량 - noted
   * - received: 이 발주로 입고 스캔돼 등록된 단말기 수
   * - missing: 명세에 있는데 아직 이 발주로 입고되지 않은 시리얼(명세 순서) — JSON_TABLE로 명세를 행으로 펼쳐 단말기와 LEFT JOIN
   * - unexpected: 입고 스캔에서 명세에 없다고 거절된 시리얼(scan_batch.results의 NOT_IN_DELIVERY_NOTE)
   * JSON_TABLE 열은 연결의 collation(mysql2 기본 utf8mb4_unicode_ci)을 따른다. 테이블 열(utf8mb4_0900_ai_ci)과 비교하면
   * ERROR 1267(Illegal mix of collations)이 나므로 열 정의에 collate를 적는다(troubleshooting/0008). 그러면 serial_no unique 인덱스도 쓴다.
   */
  async reconcile(poNo: string) {
    const po = await this.get(poNo);
    const note = await this.ensureDeliveryNote(po);
    const conn = this.em.getConnection();
    const [received] = await conn.execute<{ n: number | string }[]>(
      'select count(*) as n from terminal where purchase_order_id = ?',
      [po.id],
    );
    const missing = await conn.execute<{ serial_no: string }[]>(
      `select n.serial_no
         from purchase_order p
         join json_table(p.delivery_note, '$[*]' columns (ord for ordinality, serial_no varchar(32) collate utf8mb4_0900_ai_ci path '$')) n
         left join terminal t on t.serial_no = n.serial_no and t.purchase_order_id = p.id
        where p.id = ? and t.id is null
        order by n.ord`,
      [po.id],
    );
    const unexpected = await conn.execute<{ serial_no: string }[]>(
      `select distinct r.serial_no
         from scan_batch b
         join json_table(b.results, '$[*]' columns (serial_no varchar(64) collate utf8mb4_0900_ai_ci path '$.serialNo', result varchar(30) collate utf8mb4_0900_ai_ci path '$.result')) r
        where b.po_no = ? and r.result = 'NOT_IN_DELIVERY_NOTE'
        order by r.serial_no`,
      [po.poNo],
    );
    return {
      poNo: po.poNo,
      modelCode: po.model.code,
      status: po.status,
      ordered: po.quantity,
      noted: note.length,
      received: Number(received.n),
      shortfall: po.quantity - note.length,
      missing: missing.map((r) => r.serial_no),
      unexpected: unexpected.map((r) => r.serial_no),
    };
  }

  /**
   * 발주 마감. 입고 스캔과 같은 발주 행 잠금(FOR UPDATE)을 잡으므로, 진행 중인 입고 스캔이 있으면 그것이 커밋된 뒤에 마감된다.
   * 마감 뒤의 입고 스캔은 같은 잠금 아래에서 CLOSED를 보고 422로 거절된다.
   */
  async close(poNo: string, actor: string) {
    const { id } = await this.get(poNo);
    await this.em.fork().transactional(async (tx) => {
      const po = await tx.findOneOrFail(PurchaseOrder, id, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (po.status === PurchaseOrderStatus.CLOSED) {
        throw new BusinessError(422, 'PO_ALREADY_CLOSED', `발주 ${po.poNo}은(는) 이미 마감됐습니다.`);
      }
      po.status = PurchaseOrderStatus.CLOSED;
      po.closedAt = new Date();
      po.closedBy = actor;
    });
    const closed = await this.em.fork().findOneOrFail(PurchaseOrder, id);
    return { ...(await this.reconcile(poNo)), status: closed.status, closedAt: closed.closedAt?.toISOString() ?? null, closedBy: closed.closedBy };
  }

  async get(poNo: string): Promise<PurchaseOrder> {
    const po = await this.em.findOne(PurchaseOrder, { poNo }, { populate: ['model'] });
    if (!po) throw new NotFoundException(`발주 ${poNo}이(가) 없습니다.`);
    return po;
  }
}
```

- [ ] **Step 6: 통과 확인 (대조 테스트는 3회)**

Run:
```bash
npx vitest run && npm run typecheck
for i in 1 2 3; do npx vitest run test/reconciliation.e2e.spec.ts --silent=false 2>&1 | grep -E "\[대조 쿼리\]|Tests "; done
```
Expected: 23개 파일 `159 passed`, typecheck exit 0, 대조 테스트 3회 모두 `5 passed`. `[대조 쿼리]`는 4개(발주 조회, count, missing, unexpected).

- [ ] **Step 7: 마이그레이션**

Run: `npm run db:migration:create`
Expected: up()이 다음 한 줄이다.
```ts
    this.addSql(`alter table \`purchase_order\` add \`closed_by\` varchar(50) null;`);
```
그리고 `npm run db:migrate`, `npm run db:migration:check` → `최신 상태`.

- [ ] **Step 8: 기록과 커밋**

`docs/troubleshooting/0008-JSON_TABLE-collation-충돌.md`:
- 증상: Step 4 출력 그대로(`Illegal mix of collations (utf8mb4_0900_ai_ci,IMPLICIT) and (utf8mb4_unicode_ci,IMPLICIT) for operation '='`, 500).
- 가설: 1) 테이블마다 collation이 다르다 2) JSON_TABLE 열이 다른 collation을 받는다
- 확인: `information_schema.columns`에서 terminal·purchase_order·scan_batch의 문자열 열이 모두 `utf8mb4_0900_ai_ci` → 1 기각. 앱 연결 `@@collation_connection` = `utf8mb4_unicode_ci`, JSON_TABLE 열의 `collation()` = `utf8mb4_unicode_ci` → 2 확인. MySQL 클라이언트 재현(Step 4 명령과 출력).
- 원인: JSON_TABLE이 만드는 열은 연결의 collation을 따른다. mysql2 기본 연결 collation이 `utf8mb4_unicode_ci`이고 DB·테이블은 `utf8mb4_0900_ai_ci`(docker-compose의 서버 설정). 둘 다 IMPLICIT라 MySQL이 고르지 못한다.
- 해결: JSON_TABLE 열 정의에 `collate utf8mb4_0900_ai_ci`. 비교 쪽에 `COLLATE`를 붙이는 방법도 있지만 열 정의에 두면 EXPLAIN에서 serial_no unique 인덱스(eq_ref)를 그대로 쓴다. 연결 collation 자체를 바꾸는 것(MikroORM `charset`/`collate` 설정)은 모든 쿼리에 영향이 있어 이번엔 하지 않았다.
- 배운 것: → backlog

`docs/study/backlog.md`에 추가:
```
- [ ] MySQL collation 우선순위(EXPLICIT·IMPLICIT·COERCIBLE)와 연결 collation, mysql2 기본값 (troubleshooting/0008)
- [ ] JSON_TABLE — JSON 배열을 행으로 펼쳐 조인하기, FOR ORDINALITY (purchase-order.service.ts)
- [ ] 같은 행을 잠그는 두 기능(입고 스캔·마감)이 줄을 서는 방식 — 잠금으로 상태 검사를 직렬화 (reconciliation.e2e.spec.ts)
```

커밋:
```bash
git add apps/api docs
git commit -m "feat(F10): 발주 대비 입고 대조와 발주 마감" -m "Refs: docs/troubleshooting/0008-JSON_TABLE-collation-충돌.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: A/S 접수와 원격 점검 (F7)

**Files:**
- Create: `apps/api/src/service/service-ticket.entity.ts`, `service-ticket.service.ts`, `service-ticket.controller.ts`, `service-ticket.views.ts`, `service.module.ts`, `dto/service-ticket.dto.ts`
- Modify: `apps/api/src/entities.ts`, `apps/api/src/app.module.ts`
- Create: `apps/api/src/migrations/Migration<시각>.ts`(생성 명령)
- Test: `apps/api/test/service-ticket.e2e.spec.ts`, `apps/api/test/helpers/scenario.ts`(`transitionTo`, `prepareInService`)
- Record: devlog, `docs/study/backlog.md`

- `POST /service-tickets { serialNo, symptom }` → 201. 트랜잭션에서 **단말기 행을 FOR UPDATE로 먼저** 잠그고(같은 단말기 접수끼리 줄 세우기, 접수 INSERT의 FK S 락보다 X 락이 먼저) IN_SERVICE·가맹점 확인(422 TERMINAL_NOT_IN_SERVICE), 열린 접수(OPEN·REPLACING)가 있으면 409 TICKET_ALREADY_OPEN. 단말기 상태는 바꾸지 않는다.
- `POST /service-tickets/:id/remote-checks { resolved, note }` → 200. 접수 행 FOR UPDATE, OPEN만(422 TICKET_NOT_OPEN). resolved면 RESOLVED_REMOTELY + closedAt, 아니면 메모만.
- `GET /service-tickets/:id`. 응답: `{ id, serialNo, merchantCode, symptom, status, remoteNote, replacementSerialNo, outboundShipmentId, outboundTrackingNo, openedBy, createdAt, closedAt }`.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/helpers/scenario.ts` 전체(`transitionTo`, `prepareInService` 추가. 배송 완료·설치 확인은 일반 API(MANUAL)로도 되는 전이다):
```ts
import { expect } from 'vitest';
import { partners } from './partners.js';
import type { TestApp } from './test-app.js';

/** 시나리오 준비용 작업자 */
export const SCENARIO_OP = { 'X-Operator': 'scenario' };
const SN100_PASS = ['POWER', 'NETWORK', 'CARD_READER', 'PRINTER'].map((itemCode) => ({ itemCode, passed: true }));

/** 실제 API로 등록 → 검수 합격 → 재고까지 만든다. 현재 version을 돌려준다. */
export async function registerInStock(t: TestApp, serialNo: string): Promise<number> {
  expect((await t.http().post('/terminals').set(SCENARIO_OP).send({ serialNo, modelCode: 'SN-100' })).status).toBe(201);
  const inspected = await t.http().post(`/terminals/${serialNo}/inspections`).set(SCENARIO_OP).send({ results: SN100_PASS });
  expect(inspected.status).toBe(201);
  const stocked = await t
    .http()
    .post(`/terminals/${serialNo}/transitions`)
    .set(SCENARIO_OP)
    .send({ to: 'IN_STOCK', reason: '재고 편입', expectedVersion: inspected.body.terminal.version });
  expect(stocked.status).toBe(200);
  return stocked.body.version;
}

/** 재고 단말기를 가맹점에 배정한다. 현재 version을 돌려준다. */
export async function allocateTo(t: TestApp, serialNo: string, merchantCode = 'GANGNAM-KIMBAP'): Promise<number> {
  const version = (await t.http().get(`/terminals/${serialNo}`)).body.version;
  const res = await t.http().post(`/terminals/${serialNo}/allocations`).set(SCENARIO_OP).send({ merchantCode, expectedVersion: version });
  expect(res.status).toBe(201);
  return res.body.version;
}

/** 배정된 단말기를 출고한다. */
export async function shipWith(t: TestApp, serialNo: string, carrier: 'BUNGAE' | 'NEURIMBO') {
  const version = (await t.http().get(`/terminals/${serialNo}`)).body.version;
  const res = await t.http().post('/shipments').set(SCENARIO_OP).send({ serialNo, carrier, expectedVersion: version });
  expect(res.status).toBe(201);
  return { shipmentId: res.body.id as number, trackingNo: res.body.trackingNo as string };
}

/** 발주를 내고 공장의 납품 명세(시리얼 목록)를 함께 돌려준다. partners 설정(shortfall 등)은 미리 해 둔다. */
export async function orderPurchase(t: TestApp, quantity: number, modelCode = 'SN-100') {
  const res = await t.http().post('/purchase-orders').set(SCENARIO_OP).send({ modelCode, quantity });
  expect(res.status).toBe(201);
  const poNo = res.body.poNo as string;
  return { poNo, serials: (await partners.deliveryNote(poNo)).serials };
}

/** 등록부터 출고까지 한 번에. 수집 테스트·실험 준비용 */
export async function prepareShipped(t: TestApp, serialNo: string, carrier: 'BUNGAE' | 'NEURIMBO') {
  await registerInStock(t, serialNo);
  await allocateTo(t, serialNo);
  return shipWith(t, serialNo, carrier);
}

/** 일반 전이 API(MANUAL)로 한 단계 바꾼다. 현재 version을 돌려준다. */
export async function transitionTo(t: TestApp, serialNo: string, to: string, reason: string): Promise<number> {
  const version = (await t.http().get(`/terminals/${serialNo}`)).body.version;
  const res = await t.http().post(`/terminals/${serialNo}/transitions`).set(SCENARIO_OP).send({ to, reason, expectedVersion: version });
  expect(res.status).toBe(200);
  return res.body.version;
}

/** 가맹점에서 운영 중(IN_SERVICE)인 단말기를 만든다: 재고 → 배정 → 출고 → 배송 완료(수동) → 설치 확인(수동) */
export async function prepareInService(t: TestApp, serialNo: string, merchantCode = 'GANGNAM-KIMBAP'): Promise<number> {
  await registerInStock(t, serialNo);
  await allocateTo(t, serialNo, merchantCode);
  await shipWith(t, serialNo, 'BUNGAE');
  await transitionTo(t, serialNo, 'DELIVERED', 'delivered');
  return transitionTo(t, serialNo, 'IN_SERVICE', 'installed');
}
```

`apps/api/test/service-ticket.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { partners } from './helpers/partners.js';
import { prepareInService, registerInStock } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'ahn' };

describe('A/S 접수·원격 점검 (F7)', () => {
  let t: TestApp;
  let firstTicketId: number;
  const open = (serialNo: string, symptom = '카드 인식 불가') => t.http().post('/service-tickets').set(OP).send({ serialNo, symptom });
  const remoteCheck = (id: number, resolved: boolean, note: string) =>
    t.http().post(`/service-tickets/${id}/remote-checks`).set(OP).send({ resolved, note });

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await partners.reset();
    await prepareInService(t, 'AS-0001', 'YEOKSAM-CAFE');
    await prepareInService(t, 'AS-0002');
    await prepareInService(t, 'AS-0003');
    await registerInStock(t, 'AS-0009');
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('운영 중인 단말기만 접수한다. 가맹점은 단말기의 가맹점, 단말기 상태는 그대로', async () => {
    const res = await open('AS-0001');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      serialNo: 'AS-0001',
      merchantCode: 'YEOKSAM-CAFE',
      symptom: '카드 인식 불가',
      status: 'OPEN',
      remoteNote: null,
      replacementSerialNo: null,
      outboundTrackingNo: null,
      openedBy: 'ahn',
      closedAt: null,
    });
    expect((await t.http().get('/terminals/AS-0001')).body.status).toBe('IN_SERVICE');
    firstTicketId = res.body.id;
    expect((await t.http().get(`/service-tickets/${res.body.id}`)).body).toMatchObject({ id: res.body.id, status: 'OPEN' });
  });

  it('운영 중이 아니면 422 TERMINAL_NOT_IN_SERVICE, 없으면 404, 증상이 없으면 400', async () => {
    const notInService = await open('AS-0009');
    expect(notInService.status).toBe(422);
    expect(notInService.body.code).toBe('TERMINAL_NOT_IN_SERVICE');
    expect((await open('AS-9999')).status).toBe(404);
    expect((await open('AS-0002', '   ')).status).toBe(400);
  });

  it('같은 단말기에 열린 접수가 있으면 409 TICKET_ALREADY_OPEN — 동시에 2건이 와도 1건만 접수', async () => {
    const [a, b] = await Promise.all([open('AS-0002', '화면 꺼짐'), open('AS-0002', '화면 꺼짐')]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.code).toBe('TICKET_ALREADY_OPEN');
  });

  it('원격 점검으로 해결되면 RESOLVED_REMOTELY로 종결, 다시 점검하면 422, 같은 단말기를 새로 접수할 수 있다', async () => {
    const ticket = (await open('AS-0003', '영수증 안 나옴')).body;
    const res = await remoteCheck(ticket.id, true, '프린터 설정 초기화로 해결');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'RESOLVED_REMOTELY', remoteNote: '프린터 설정 초기화로 해결' });
    expect(res.body.closedAt).toEqual(expect.any(String));

    const again = await remoteCheck(ticket.id, true, '또');
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('TICKET_NOT_OPEN');
    expect((await open('AS-0003', '다시 고장')).status).toBe(201);
  });

  it('원격 점검으로 안 되면 OPEN 그대로, 메모만 남는다', async () => {
    const res = await remoteCheck(firstTicketId, false, '원격 재부팅해도 카드 인식 불가');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'OPEN', remoteNote: '원격 재부팅해도 카드 인식 불가', closedAt: null });
  });

  it('없는 접수는 404, id가 숫자가 아니면 400', async () => {
    expect((await t.http().get('/service-tickets/9999')).status).toBe(404);
    expect((await t.http().get('/service-tickets/abc')).status).toBe(400);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/service-ticket.e2e.spec.ts`
Expected: FAIL — `POST /service-tickets`가 404(`expected 404 to be 201` 등)

- [ ] **Step 3: 엔티티와 DTO**

`apps/api/src/service/service-ticket.entity.ts`:
```ts
import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { Merchant } from '../merchant/merchant.entity.js';
import { Shipment } from '../shipment/shipment.entities.js';
import { Terminal } from '../terminal/terminal.entity.js';

export enum ServiceTicketStatus {
  OPEN = 'OPEN', // 접수됨(원격 점검 전·후)
  RESOLVED_REMOTELY = 'RESOLVED_REMOTELY', // 원격으로 해결, 종결
  REPLACING = 'REPLACING', // 교체 단말기 출고됨, 설치 확인 대기
  CLOSED = 'CLOSED', // 교체 설치 확인, 종결
}

/** 열려 있는(아직 종결되지 않은) 상태 */
export const OPEN_TICKET_STATUSES = [ServiceTicketStatus.OPEN, ServiceTicketStatus.REPLACING];

/** A/S 접수 한 건(F7). 원격 점검으로 끝나거나, 교체 출고 → 설치 확인으로 끝난다. */
@Entity({ tableName: 'service_ticket' })
@Index({ properties: ['terminal', 'status'] })
export class ServiceTicket {
  [OptionalProps]?: 'status' | 'remoteNote' | 'replacementTerminal' | 'outboundShipment' | 'createdAt' | 'closedAt';

  @PrimaryKey()
  id!: number;

  /** 고장 접수된 단말기 */
  @ManyToOne(() => Terminal)
  terminal!: Rel<Terminal>;

  @ManyToOne(() => Merchant)
  merchant!: Rel<Merchant>;

  @Property({ length: 200 })
  symptom!: string;

  @Enum({ items: () => ServiceTicketStatus })
  status: ServiceTicketStatus = ServiceTicketStatus.OPEN;

  @Property({ type: 'varchar', length: 500, nullable: true })
  remoteNote: string | null = null;

  /** 교체로 보낸 단말기 */
  @ManyToOne(() => Terminal, { nullable: true })
  replacementTerminal: Rel<Terminal> | null = null;

  /** 교체 단말기 운송장 */
  @ManyToOne(() => Shipment, { nullable: true })
  outboundShipment: Rel<Shipment> | null = null;

  @Property({ length: 50 })
  openedBy!: string;

  @Property()
  createdAt: Date = new Date();

  @Property({ type: 'datetime', nullable: true })
  closedAt: Date | null = null;
}
```

`apps/api/src/service/dto/service-ticket.dto.ts`:
```ts
import { IsBoolean, IsString, Length, Matches } from 'class-validator';
import { SERIAL_NO_MESSAGE, SERIAL_NO_PATTERN } from '../../terminal/bulk-rows.js';

export class OpenTicketDto {
  @Matches(SERIAL_NO_PATTERN, { message: SERIAL_NO_MESSAGE })
  serialNo!: string;

  @IsString()
  @Length(1, 200)
  @Matches(/\S/, { message: 'symptom은 공백만으로 쓸 수 없습니다.' })
  symptom!: string;
}

export class RemoteCheckDto {
  /** 원격 점검으로 해결됐는지 */
  @IsBoolean()
  resolved!: boolean;

  @IsString()
  @Length(1, 500)
  @Matches(/\S/, { message: 'note는 공백만으로 쓸 수 없습니다.' })
  note!: string;
}
```

`apps/api/src/entities.ts` 전체:
```ts
import { TerminalModel } from './terminal/terminal-model.entity.js';
import { Terminal } from './terminal/terminal.entity.js';
import { TerminalStatusHistory } from './terminal/terminal-status-history.entity.js';
import { InspectionItem } from './inspection/inspection-item.entity.js';
import { Inspection, InspectionResult } from './inspection/inspection.entities.js';
import { Merchant } from './merchant/merchant.entity.js';
import { CarrierEvent, Shipment, SyncRun } from './shipment/shipment.entities.js';
import { OutboxEvent } from './outbox/outbox-event.entity.js';
import { PurchaseOrder } from './purchase-order/purchase-order.entity.js';
import { ScanBatch } from './scan/scan-batch.entity.js';
import { ServiceTicket } from './service/service-ticket.entity.js';

/** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch, ServiceTicket];
```

- [ ] **Step 4: 서비스·API·모듈**

`apps/api/src/service/service-ticket.views.ts`:
```ts
import type { ServiceTicket } from './service-ticket.entity.js';

/** terminal, merchant, replacementTerminal, outboundShipment가 populate돼 있어야 한다. */
export function toTicketView(t: ServiceTicket) {
  return {
    id: t.id,
    serialNo: t.terminal.serialNo,
    merchantCode: t.merchant.code,
    symptom: t.symptom,
    status: t.status,
    remoteNote: t.remoteNote,
    replacementSerialNo: t.replacementTerminal?.serialNo ?? null,
    outboundShipmentId: t.outboundShipment?.id ?? null,
    outboundTrackingNo: t.outboundShipment?.trackingNo ?? null,
    openedBy: t.openedBy,
    createdAt: t.createdAt.toISOString(),
    closedAt: t.closedAt?.toISOString() ?? null,
  };
}
```

`apps/api/src/service/service-ticket.service.ts`:
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus } from '../terminal/terminal-status.js';
import type { OpenTicketDto, RemoteCheckDto } from './dto/service-ticket.dto.js';
import { OPEN_TICKET_STATUSES, ServiceTicket, ServiceTicketStatus } from './service-ticket.entity.js';

export const TICKET_POPULATE = ['terminal', 'merchant', 'replacementTerminal', 'outboundShipment'] as const;

/** A/S 접수·원격 점검(F7). 교체 출고·설치 확인은 ReplacementService. */
@Injectable()
export class ServiceTicketService {
  constructor(private readonly em: EntityManager) {}

  /**
   * 접수. 단말기 행을 FOR UPDATE로 먼저 잠그고(같은 단말기 접수끼리 줄 세우기) 열린 접수가 없을 때만 만든다.
   * 접수 INSERT의 FK 검사(S 락)보다 단말기 X 락이 먼저라 S→X 데드락이 없다(troubleshooting/0004).
   * 단말기 상태는 바꾸지 않는다(운영 중 그대로).
   */
  async open(dto: OpenTicketDto, actor: string): Promise<ServiceTicket> {
    const id = await this.em.fork().transactional(async (tx) => {
      const terminal = await tx.findOne(Terminal, { serialNo: dto.serialNo }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (!terminal) throw new NotFoundException(`단말기 ${dto.serialNo}이(가) 없습니다.`);
      if (terminal.status !== TerminalStatus.IN_SERVICE || !terminal.merchant) {
        throw new BusinessError(422, 'TERMINAL_NOT_IN_SERVICE', `운영 중(IN_SERVICE)인 단말기만 A/S 접수할 수 있습니다(현재: ${terminal.status}).`);
      }
      const already = await tx.count(ServiceTicket, { terminal, status: { $in: OPEN_TICKET_STATUSES } });
      if (already > 0) throw new BusinessError(409, 'TICKET_ALREADY_OPEN', `단말기 ${dto.serialNo}에 이미 열린 A/S 접수가 있습니다.`);
      const ticket = tx.create(ServiceTicket, { terminal, merchant: terminal.merchant, symptom: dto.symptom, openedBy: actor });
      await tx.flush();
      return ticket.id;
    });
    return this.get(id);
  }

  /** 원격 점검 결과. 해결이면 종결(RESOLVED_REMOTELY), 아니면 메모만 남기고 OPEN 그대로. */
  async remoteCheck(id: number, dto: RemoteCheckDto): Promise<ServiceTicket> {
    await this.em.fork().transactional(async (tx) => {
      const ticket = await this.lockOpen(tx, id, [ServiceTicketStatus.OPEN]);
      ticket.remoteNote = dto.note;
      if (dto.resolved) {
        ticket.status = ServiceTicketStatus.RESOLVED_REMOTELY;
        ticket.closedAt = new Date();
      }
    });
    return this.get(id);
  }

  async get(id: number): Promise<ServiceTicket> {
    const ticket = await this.em.fork().findOne(ServiceTicket, id, { populate: TICKET_POPULATE });
    if (!ticket) throw new NotFoundException(`A/S 접수 ${id}이(가) 없습니다.`);
    return ticket;
  }

  /** 접수 행을 FOR UPDATE로 잠그고, 상태가 expected 중 하나인지 확인한다. */
  async lockOpen(tx: EntityManager, id: number, expected: ServiceTicketStatus[]): Promise<ServiceTicket> {
    const ticket = await tx.findOne(ServiceTicket, id, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!ticket) throw new NotFoundException(`A/S 접수 ${id}이(가) 없습니다.`);
    if (!expected.includes(ticket.status)) {
      throw new BusinessError(422, 'TICKET_NOT_OPEN', `A/S 접수 ${id}은(는) ${ticket.status} 상태라 이 작업을 할 수 없습니다(필요: ${expected.join(', ')}).`);
    }
    return ticket;
  }
}
```

`apps/api/src/service/service-ticket.controller.ts`:
```ts
import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { OpenTicketDto, RemoteCheckDto } from './dto/service-ticket.dto.js';
import { ServiceTicketService } from './service-ticket.service.js';
import { toTicketView } from './service-ticket.views.js';

@Controller('service-tickets')
export class ServiceTicketController {
  constructor(private readonly tickets: ServiceTicketService) {}

  @Post()
  async open(@Body() dto: OpenTicketDto, @Operator() actor: string) {
    return toTicketView(await this.tickets.open(dto, actor));
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    return toTicketView(await this.tickets.get(id));
  }

  @Post(':id/remote-checks')
  @HttpCode(200)
  // 작업자 헤더는 모든 쓰기 API에 받는다(decisions/0001). 원격 점검은 메모에 결과만 남긴다.
  async remoteCheck(@Param('id', ParseIntPipe) id: number, @Body() dto: RemoteCheckDto, @Operator() _actor: string) {
    return toTicketView(await this.tickets.remoteCheck(id, dto));
  }
}
```

`apps/api/src/service/service.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { ServiceTicketController } from './service-ticket.controller.js';
import { ServiceTicketService } from './service-ticket.service.js';

@Module({
  controllers: [ServiceTicketController],
  providers: [ServiceTicketService],
})
export class ServiceModule {}
```

`apps/api/src/app.module.ts` 전체(`ServiceModule` import):
```ts
import { type DynamicModule, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import ormConfig from './mikro-orm.config.js';
import { HealthController } from './health/health.controller.js';
import { DomainExceptionFilter } from './common/domain-exception.filter.js';
import { TerminalModule } from './terminal/terminal.module.js';
import { InspectionModule } from './inspection/inspection.module.js';
import { MerchantModule } from './merchant/merchant.module.js';
import { ShipmentModule } from './shipment/shipment.module.js';
import { QueuesModule } from './queue/queues.module.js';
import { CarrierSyncModule } from './carrier-sync/carrier-sync.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { PurchaseOrderModule } from './purchase-order/purchase-order.module.js';
import { ScanModule } from './scan/scan.module.js';
import { ServiceModule } from './service/service.module.js';
import { WorkersModule } from './workers/workers.module.js';
import { SchedulerModule } from './scheduler/scheduler.module.js';

export interface AppOptions {
  /** 큐 job을 처리할지(RUN_WORKERS) */
  workers?: boolean;
  /** 주기 작업을 등록할지(RUN_SCHEDULERS) */
  schedulers?: boolean;
}

@Module({
  // forRoot가 요청마다 EntityManager를 fork하는 RequestContext 미들웨어를 자동 등록한다.
  imports: [
    MikroOrmModule.forRoot(ormConfig),
    QueuesModule,
    TerminalModule,
    InspectionModule,
    MerchantModule,
    ShipmentModule,
    CarrierSyncModule,
    OutboxModule,
    PurchaseOrderModule,
    ScanModule,
    ServiceModule,
  ],
  controllers: [HealthController],
  providers: [
    // main.ts의 useGlobalPipes/Filters는 테스트 앱에 적용되지 않는다. 모듈 provider로 등록해 테스트에서도 같게 동작시킨다.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {
  /** 실행 모드에 따라 워커·스케줄러를 붙인다. `imports: [AppModule]`만 쓰면 둘 다 없다(decisions/0015). */
  static forRoot(options: AppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [...(options.workers ? [WorkersModule] : []), ...(options.schedulers ? [SchedulerModule] : [])],
    };
  }
}
```

- [ ] **Step 5: 통과 확인 (동시 접수 포함 3회)**

Run:
```bash
npx vitest run && npm run typecheck
for i in 1 2 3; do npx vitest run test/service-ticket.e2e.spec.ts 2>&1 | grep -E "Tests "; done
```
Expected: 24개 파일 `165 passed`, typecheck exit 0, 3회 모두 `6 passed`

- [ ] **Step 6: 마이그레이션**

Run: `npm run db:migration:create`
Expected: up()이 다음과 같다(`closed_at` datetime null, `remote_note` varchar(500) null).
```ts
    this.addSql(`create table \`service_ticket\` (\`id\` int unsigned not null auto_increment primary key, \`terminal_id\` int unsigned not null, \`merchant_id\` int unsigned not null, \`symptom\` varchar(200) not null, \`status\` enum('OPEN','RESOLVED_REMOTELY','REPLACING','CLOSED') not null default 'OPEN', \`remote_note\` varchar(500) null, \`replacement_terminal_id\` int unsigned null, \`outbound_shipment_id\` int unsigned null, \`opened_by\` varchar(50) not null, \`created_at\` datetime not null, \`closed_at\` datetime null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`service_ticket\` add index \`service_ticket_terminal_id_index\` (\`terminal_id\`);`);
    this.addSql(`alter table \`service_ticket\` add index \`service_ticket_merchant_id_index\` (\`merchant_id\`);`);
    this.addSql(`alter table \`service_ticket\` add index \`service_ticket_replacement_terminal_id_index\` (\`replacement_terminal_id\`);`);
    this.addSql(`alter table \`service_ticket\` add index \`service_ticket_outbound_shipment_id_index\` (\`outbound_shipment_id\`);`);
    this.addSql(`alter table \`service_ticket\` add index \`service_ticket_terminal_id_status_index\` (\`terminal_id\`, \`status\`);`);

    this.addSql(`alter table \`service_ticket\` add constraint \`service_ticket_terminal_id_foreign\` foreign key (\`terminal_id\`) references \`terminal\` (\`id\`);`);
    this.addSql(`alter table \`service_ticket\` add constraint \`service_ticket_merchant_id_foreign\` foreign key (\`merchant_id\`) references \`merchant\` (\`id\`);`);
    this.addSql(`alter table \`service_ticket\` add constraint \`service_ticket_replacement_terminal_id_foreign\` foreign key (\`replacement_terminal_id\`) references \`terminal\` (\`id\`) on delete set null;`);
    this.addSql(`alter table \`service_ticket\` add constraint \`service_ticket_outbound_shipment_id_foreign\` foreign key (\`outbound_shipment_id\`) references \`shipment\` (\`id\`) on delete set null;`);
```
`npm run db:migrate`, `npm run db:migration:check` → `최신 상태`.

- [ ] **Step 7: 기록과 커밋**

devlog 항목(동시 접수 결과 포함). 결정 기록은 Task 9(0023)에 함께 쓴다 — 접수의 "단말기 행 먼저 잠금"도 같은 규칙이다. `docs/study/backlog.md`에 추가:
```
- [ ] "열린 건은 하나만" 규칙을 잠금으로 지키기 vs 부분 unique 인덱스(generated column) (service-ticket.service.ts)
```

커밋:
```bash
git add apps/api docs
git commit -m "feat(F7): A/S 접수와 원격 점검" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: A/S 교체 출고와 설치 확인 — 두 단말기 + 운송장 + 접수를 한 트랜잭션 (F7)

**Files:**
- Create: `apps/api/src/service/replacement.service.ts`
- Modify: `apps/api/src/service/dto/service-ticket.dto.ts`(`ReplaceDto`), `apps/api/src/service/service-ticket.controller.ts`, `apps/api/src/service/service.module.ts`, `apps/api/src/shipment/shipment.module.ts`(`ShipmentService` export)
- Test: `apps/api/test/replacement.e2e.spec.ts`
- Record: devlog, `docs/decisions/0023-교체-출고는-한-트랜잭션과-정해진-잠금-순서.md`, `docs/study/backlog.md`

- `POST /service-tickets/:id/replacements { replacementSerialNo, carrier }` → 201(접수 REPLACING).
  1. 트랜잭션 밖 사전 확인: 접수 OPEN(422 TICKET_NOT_OPEN), 교체 단말기 있음(404)·IN_STOCK(422 REPLACEMENT_NOT_IN_STOCK)·같은 모델(422 MODEL_MISMATCH). 실패하면 택배사를 부르지 않는다.
  2. 트랜잭션 밖 운송장 발급(decisions/0012).
  3. 한 트랜잭션: 접수 행 FOR UPDATE(OPEN 재확인) → **두 단말기를 id 오름차순으로 한 행씩 FOR UPDATE** → 교체 단말기 IN_STOCK → ALLOCATED(ALLOCATION, 가맹점 = 접수 가맹점, `mutate`) → SHIPPED(SHIPMENT) → 고장 단말기 IN_SERVICE → RETURN_REQUESTED(SERVICE) → `recordShipment`(이전 IN_TRANSIT 정리 + INSERT) → 접수 REPLACING(교체 단말기, 운송장). 하나라도 실패하면 전부 롤백. 운송장은 고아로 남는다.
- `POST /service-tickets/:id/installations` → 200. 접수 FOR UPDATE(REPLACING) → 교체 단말기 DELIVERED → IN_SERVICE(SERVICE) → 접수 CLOSED. 배송 완료 전이면 422 INVALID_TRANSITION.
- 배송 완료(DELIVERED)는 기존 택배 추적 수집(F3)이 한다. 고장 단말기는 RETURN_REQUESTED → RETURNING(일반 API) → RETURN_IN 박스 스캔(Task 5)으로 RETURNED.
- `replace(id, cmd, actor, { lockOrder })`의 `lockOrder`는 실험 0007 전용(`'faulty-first'`). HTTP는 항상 `'id-asc'`.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/replacement.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CarrierSyncService } from '../src/carrier-sync/carrier-sync.service.js';
import { CarrierAdapters } from '../src/carrier/carrier.adapters.js';
import { Carrier } from '../src/carrier/carrier.types.js';
import { Shipment, ShipmentStatus } from '../src/shipment/shipment.entities.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { partners } from './helpers/partners.js';
import { prepareInService, registerInStock, transitionTo } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'moon' };

describe('A/S 교체 출고·설치 확인 (F7)', () => {
  let t: TestApp;
  const em = () => t.orm.em.fork();
  const terminal = (serialNo: string) => em().findOneOrFail(Terminal, { serialNo }, { populate: ['merchant'] });
  const history = async (serialNo: string) => (await t.http().get(`/terminals/${serialNo}/history`)).body;
  const waybillCalls = async () => (await partners.stats()).calls['bungae.waybill'] ?? 0;
  const openTicket = async (serialNo: string) =>
    (await t.http().post('/service-tickets').set(OP).send({ serialNo, symptom: '카드 인식 불가' })).body.id as number;
  const replace = (id: number, replacementSerialNo: string) =>
    t.http().post(`/service-tickets/${id}/replacements`).set(OP).send({ replacementSerialNo, carrier: 'BUNGAE' });
  const install = (id: number) => t.http().post(`/service-tickets/${id}/installations`).set(OP);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await partners.reset();
    for (const s of ['RP-0001', 'RP-0002', 'RP-0003', 'RP-0004', 'RP-0005']) await prepareInService(t, s, 'PANGYO-BUNSIK');
    for (const s of ['RP-0101', 'RP-0102', 'RP-0103', 'RP-0105']) await registerInStock(t, s);
    // 다른 모델(SN-200) 재고: 검수 항목이 달라 시나리오 헬퍼 대신 상태를 직접 맞춘다.
    await t.http().post('/terminals').set(OP).send({ serialNo: 'RP-0201', modelCode: 'SN-200' });
    await em().nativeUpdate(Terminal, { serialNo: 'RP-0201' }, { status: TerminalStatus.IN_STOCK });
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('교체 출고 → 배송 완료 → 설치 확인 → 고장 단말기 회수 스캔까지 한 흐름', async () => {
    const id = await openTicket('RP-0001');
    const res = await replace(id, 'RP-0101');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id, status: 'REPLACING', replacementSerialNo: 'RP-0101' });
    expect(res.body.outboundTrackingNo).toMatch(/^BG\d+$/);

    // 교체 단말기: 재고 → 배정(가맹점 = 접수 가맹점) → 출고. 고장 단말기: 회수 요청. 모두 한 트랜잭션.
    const replacement = await terminal('RP-0101');
    expect(replacement.status).toBe(TerminalStatus.SHIPPED);
    expect(replacement.merchant?.code).toBe('PANGYO-BUNSIK');
    expect((await terminal('RP-0001')).status).toBe(TerminalStatus.RETURN_REQUESTED);
    expect((await history('RP-0101')).slice(-2)).toMatchObject([
      { fromStatus: 'IN_STOCK', toStatus: 'ALLOCATED', source: 'ALLOCATION', actor: 'moon', reason: `A/S 교체 배정: 접수 #${id}` },
      { fromStatus: 'ALLOCATED', toStatus: 'SHIPPED', source: 'SHIPMENT', reason: `A/S 교체 출고: BUNGAE ${res.body.outboundTrackingNo}` },
    ]);
    expect((await history('RP-0001')).at(-1)).toMatchObject({ toStatus: 'RETURN_REQUESTED', source: 'SERVICE', reason: `A/S 교체로 회수 요청: 접수 #${id}` });
    const shipment = await em().findOneOrFail(Shipment, res.body.outboundShipmentId, { populate: ['terminal'] });
    expect([shipment.terminal.serialNo, shipment.status]).toEqual(['RP-0101', ShipmentStatus.IN_TRANSIT]);

    // 배송 전 설치 확인은 422(SHIPPED → IN_SERVICE 규칙 없음), 접수는 REPLACING 그대로
    const early = await install(id);
    expect(early.status).toBe(422);
    expect((await t.http().get(`/service-tickets/${id}`)).body.status).toBe('REPLACING');

    // 택배 추적 수집이 배송 완료를 반영한다(기존 F3 흐름)
    await partners.configure({ bungae: { advancePerPoll: 4 } });
    expect(await t.app.get(CarrierSyncService).track(shipment.id, { queue: 'test', attempt: 1 })).toBe('DELIVERED');

    const done = await install(id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'CLOSED' });
    expect(done.body.closedAt).toEqual(expect.any(String));
    expect((await terminal('RP-0101')).status).toBe(TerminalStatus.IN_SERVICE);
    expect((await history('RP-0101')).at(-1)).toMatchObject({ toStatus: 'IN_SERVICE', source: 'SERVICE', reason: `A/S 교체 설치 확인: 접수 #${id}` });

    // 고장 단말기 회수: 수거 시작(수동) → 회수 박스 스캔
    await transitionTo(t, 'RP-0001', 'RETURNING', 'pickup');
    const scan = await t.http().post('/scans').set(OP).send({ scanId: 'AS-RETURN-0001', kind: 'RETURN_IN', serials: ['RP-0001'] });
    expect(scan.body.results).toEqual([{ serialNo: 'RP-0001', result: 'RETURNED' }]);
  });

  it('출고 전에 확인할 수 있는 실패는 택배사를 부르지 않는다(422·404)', async () => {
    const id = await openTicket('RP-0002');
    const notInStock = await replace(id, 'RP-0101'); // 앞 테스트에서 이미 설치됨
    expect(notInStock.status).toBe(422);
    expect(notInStock.body.code).toBe('REPLACEMENT_NOT_IN_STOCK');
    const otherModel = await replace(id, 'RP-0201');
    expect(otherModel.status).toBe(422);
    expect(otherModel.body.code).toBe('MODEL_MISMATCH');
    expect((await replace(id, 'RP-9999')).status).toBe(404);
    expect(await waybillCalls()).toBe(0);

    await t.http().post(`/service-tickets/${id}/remote-checks`).set(OP).send({ resolved: true, note: '해결' });
    const closed = await replace(id, 'RP-0102');
    expect(closed.status).toBe(422);
    expect(closed.body.code).toBe('TICKET_NOT_OPEN');
    expect(await waybillCalls()).toBe(0);
  });

  it('트랜잭션 안에서 하나라도 실패하면 두 단말기·운송장·접수가 모두 그대로(운송장은 고아로 남는다)', async () => {
    const id = await openTicket('RP-0003');
    // 운송장 발급 직후, 다른 작업이 고장 단말기를 먼저 회수 요청으로 바꾼 상황
    const adapter = t.app.get(CarrierAdapters).get(Carrier.BUNGAE);
    const original = adapter.createWaybill.bind(adapter);
    const spy = vi.spyOn(adapter, 'createWaybill').mockImplementationOnce(async (input) => {
      const trackingNo = await original(input);
      await em().nativeUpdate(Terminal, { serialNo: 'RP-0003' }, { status: TerminalStatus.RETURN_REQUESTED });
      return trackingNo;
    });
    try {
      const res = await replace(id, 'RP-0102');
      expect(res.status).toBe(422);
    } finally {
      spy.mockRestore();
    }
    const r = await terminal('RP-0102');
    expect([r.status, r.merchant]).toEqual([TerminalStatus.IN_STOCK, null]);
    expect(await em().count(Shipment, { terminal: { serialNo: 'RP-0102' } })).toBe(0);
    expect((await t.http().get(`/service-tickets/${id}`)).body).toMatchObject({ status: 'OPEN', replacementSerialNo: null });
    expect(await waybillCalls()).toBe(1); // 발급된 운송장 1장은 저장되지 않았다(decisions/0012 한계)
  });

  it('두 접수가 같은 교체 단말기를 동시에 요청하면 1건만 성공, 나머지는 422', async () => {
    const [a, b] = [await openTicket('RP-0004'), await openTicket('RP-0005')];
    const results = await Promise.all([replace(a, 'RP-0105'), replace(b, 'RP-0105')]);
    const statuses = results.map((r) => r.status).sort();
    console.log(`[같은 교체 단말기 동시 요청] 응답=${JSON.stringify(statuses)} 코드=${JSON.stringify(results.map((r) => r.body.code ?? null))} 운송장발급=${await waybillCalls()}`);
    expect(statuses).toEqual([201, 422]);
    expect(await em().count(Shipment, { terminal: { serialNo: 'RP-0105' } })).toBe(1);
    const loser = results.find((r) => r.status === 422)!;
    const loserTicket = loser === results[0] ? a : b;
    expect((await t.http().get(`/service-tickets/${loserTicket}`)).body.status).toBe('OPEN');
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/replacement.e2e.spec.ts`
Expected: FAIL — `POST /service-tickets/:id/replacements`가 404(`expected 404 to be 201` 등), 4개 모두

- [ ] **Step 3: 구현**

`apps/api/src/service/dto/service-ticket.dto.ts` 전체(`ReplaceDto` 추가):
```ts
import { IsBoolean, IsEnum, IsString, Length, Matches } from 'class-validator';
import { Carrier } from '../../carrier/carrier.types.js';
import { SERIAL_NO_MESSAGE, SERIAL_NO_PATTERN } from '../../terminal/bulk-rows.js';

export class OpenTicketDto {
  @Matches(SERIAL_NO_PATTERN, { message: SERIAL_NO_MESSAGE })
  serialNo!: string;

  @IsString()
  @Length(1, 200)
  @Matches(/\S/, { message: 'symptom은 공백만으로 쓸 수 없습니다.' })
  symptom!: string;
}

export class RemoteCheckDto {
  /** 원격 점검으로 해결됐는지 */
  @IsBoolean()
  resolved!: boolean;

  @IsString()
  @Length(1, 500)
  @Matches(/\S/, { message: 'note는 공백만으로 쓸 수 없습니다.' })
  note!: string;
}

export class ReplaceDto {
  @Matches(SERIAL_NO_PATTERN, { message: SERIAL_NO_MESSAGE })
  replacementSerialNo!: string;

  @IsEnum(Carrier)
  carrier!: Carrier;
}
```

`apps/api/src/service/replacement.service.ts`:
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { CarrierAdapters } from '../carrier/carrier.adapters.js';
import type { Carrier } from '../carrier/carrier.types.js';
import { BusinessError } from '../common/domain-errors.js';
import { Merchant } from '../merchant/merchant.entity.js';
import { ShipmentService } from '../shipment/shipment.service.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import { TransitionService } from '../terminal/transition.service.js';
import { ServiceTicket, ServiceTicketStatus } from './service-ticket.entity.js';
import { ServiceTicketService } from './service-ticket.service.js';

/**
 * 두 단말기를 잠그는 순서. 운영 코드는 항상 'id-asc'(decisions/0023).
 * 'faulty-first'(고장 단말기 → 교체 단말기)는 실험 0007에서 순서를 바꿨을 때를 재 보려고만 둔다.
 */
export type LockOrder = 'id-asc' | 'faulty-first';

export interface ReplaceCommand {
  replacementSerialNo: string;
  carrier: Carrier;
}

/** A/S 교체 출고와 설치 확인(F7). "새 단말기 출고 + 고장 단말기 회수 요청"을 한 트랜잭션으로 처리한다. */
@Injectable()
export class ReplacementService {
  constructor(
    private readonly em: EntityManager,
    private readonly tickets: ServiceTicketService,
    private readonly transitions: TransitionService,
    private readonly shipments: ShipmentService,
    private readonly adapters: CarrierAdapters,
  ) {}

  /**
   * ① 트랜잭션 밖 사전 확인: 접수 OPEN, 교체 단말기 IN_STOCK·같은 모델. 실패하면 택배사를 부르지 않는다.
   * ② 트랜잭션 밖 운송장 발급(decisions/0012).
   * ③ 한 트랜잭션: 접수 행 잠금 → 두 단말기를 id 오름차순으로 잠금(FOR UPDATE) → 교체 단말기 IN_STOCK → ALLOCATED(가맹점)
   *    → SHIPPED, 고장 단말기 IN_SERVICE → RETURN_REQUESTED, 운송장 저장, 접수 REPLACING.
   *    하나라도 실패하면 전부 롤백된다. ②의 운송장은 고아로 남는다(알려진 한계).
   */
  async replace(id: number, cmd: ReplaceCommand, actor: string, opts: { lockOrder?: LockOrder } = {}): Promise<ServiceTicket> {
    const ticket = await this.tickets.get(id);
    if (ticket.status !== ServiceTicketStatus.OPEN) {
      throw new BusinessError(422, 'TICKET_NOT_OPEN', `A/S 접수 ${id}은(는) ${ticket.status} 상태라 교체 출고할 수 없습니다.`);
    }
    const replacement = await this.em.fork().findOne(Terminal, { serialNo: cmd.replacementSerialNo });
    if (!replacement) throw new NotFoundException(`단말기 ${cmd.replacementSerialNo}이(가) 없습니다.`);
    if (replacement.status !== TerminalStatus.IN_STOCK) {
      throw new BusinessError(422, 'REPLACEMENT_NOT_IN_STOCK', `교체 단말기는 재고(IN_STOCK)여야 합니다(현재: ${replacement.status}).`);
    }
    if (replacement.model.id !== ticket.terminal.model.id) {
      throw new BusinessError(422, 'MODEL_MISMATCH', '교체 단말기는 고장 단말기와 같은 모델이어야 합니다.');
    }

    const merchant = ticket.merchant;
    const trackingNo = await this.adapters.get(cmd.carrier).createWaybill({
      reference: `AS-${id}-${replacement.serialNo}`,
      receiverName: merchant.name,
      address: merchant.address,
    });

    const faultyId = ticket.terminal.id;
    await this.em.fork().transactional(async (tx) => {
      const locked = await this.tickets.lockOpen(tx, id, [ServiceTicketStatus.OPEN]);
      await this.lockTerminals(tx, faultyId, replacement.id, opts.lockOrder ?? 'id-asc');

      const assigned = tx.getReference(Merchant, merchant.id);
      await this.transitions.transition(
        {
          serialNo: replacement.serialNo,
          to: TerminalStatus.ALLOCATED,
          reason: `A/S 교체 배정: 접수 #${id}`,
          actor,
          source: TransitionSource.ALLOCATION,
          mutate: (t) => {
            t.merchant = assigned;
          },
        },
        tx,
      );
      const shipped = await this.transitions.transition(
        {
          serialNo: replacement.serialNo,
          to: TerminalStatus.SHIPPED,
          reason: `A/S 교체 출고: ${cmd.carrier} ${trackingNo}`,
          actor,
          source: TransitionSource.SHIPMENT,
        },
        tx,
      );
      await this.transitions.transition(
        {
          serialNo: ticket.terminal.serialNo,
          to: TerminalStatus.RETURN_REQUESTED,
          reason: `A/S 교체로 회수 요청: 접수 #${id}`,
          actor,
          source: TransitionSource.SERVICE,
        },
        tx,
      );
      const shipment = await this.shipments.recordShipment(tx, shipped, cmd.carrier, trackingNo);
      locked.status = ServiceTicketStatus.REPLACING;
      locked.replacementTerminal = shipped;
      locked.outboundShipment = shipment;
    });
    return this.tickets.get(id);
  }

  /** 설치 확인: 교체 단말기 DELIVERED → IN_SERVICE(SERVICE), 접수 CLOSED. 배송 완료 전이면 422. */
  async install(id: number, actor: string): Promise<ServiceTicket> {
    await this.em.fork().transactional(async (tx) => {
      const ticket = await this.tickets.lockOpen(tx, id, [ServiceTicketStatus.REPLACING]);
      const replacement = await tx.findOneOrFail(Terminal, ticket.replacementTerminal!.id);
      await this.transitions.transition(
        {
          serialNo: replacement.serialNo,
          to: TerminalStatus.IN_SERVICE,
          reason: `A/S 교체 설치 확인: 접수 #${id}`,
          actor,
          source: TransitionSource.SERVICE,
        },
        tx,
      );
      ticket.status = ServiceTicketStatus.CLOSED;
      ticket.closedAt = new Date();
    });
    return this.tickets.get(id);
  }

  /**
   * 두 단말기 행을 FOR UPDATE로 한 행씩 잠근다. 여러 행을 잠그는 트랜잭션들이 늘 같은 순서(id 오름차순)로 잠가야
   * 서로 상대가 쥔 행을 기다리는 순환(데드락)이 생기지 않는다(decisions/0023, experiments/0007).
   */
  private async lockTerminals(tx: EntityManager, faultyId: number, replacementId: number, order: LockOrder): Promise<void> {
    const ids = order === 'id-asc' ? [faultyId, replacementId].sort((a, b) => a - b) : [faultyId, replacementId];
    for (const terminalId of ids) await tx.findOneOrFail(Terminal, terminalId, { lockMode: LockMode.PESSIMISTIC_WRITE });
  }
}
```

`apps/api/src/service/service-ticket.controller.ts` 전체:
```ts
import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { OpenTicketDto, RemoteCheckDto, ReplaceDto } from './dto/service-ticket.dto.js';
import { ReplacementService } from './replacement.service.js';
import { ServiceTicketService } from './service-ticket.service.js';
import { toTicketView } from './service-ticket.views.js';

@Controller('service-tickets')
export class ServiceTicketController {
  constructor(
    private readonly tickets: ServiceTicketService,
    private readonly replacements: ReplacementService,
  ) {}

  @Post()
  async open(@Body() dto: OpenTicketDto, @Operator() actor: string) {
    return toTicketView(await this.tickets.open(dto, actor));
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    return toTicketView(await this.tickets.get(id));
  }

  @Post(':id/remote-checks')
  @HttpCode(200)
  // 작업자 헤더는 모든 쓰기 API에 받는다(decisions/0001). 원격 점검은 메모에 결과만 남긴다.
  async remoteCheck(@Param('id', ParseIntPipe) id: number, @Body() dto: RemoteCheckDto, @Operator() _actor: string) {
    return toTicketView(await this.tickets.remoteCheck(id, dto));
  }

  @Post(':id/replacements')
  async replace(@Param('id', ParseIntPipe) id: number, @Body() dto: ReplaceDto, @Operator() actor: string) {
    return toTicketView(await this.replacements.replace(id, dto, actor));
  }

  @Post(':id/installations')
  @HttpCode(200)
  async install(@Param('id', ParseIntPipe) id: number, @Operator() actor: string) {
    return toTicketView(await this.replacements.install(id, actor));
  }
}
```

`apps/api/src/service/service.module.ts` 전체:
```ts
import { Module } from '@nestjs/common';
import { CarrierModule } from '../carrier/carrier.module.js';
import { ShipmentModule } from '../shipment/shipment.module.js';
import { TerminalModule } from '../terminal/terminal.module.js';
import { ReplacementService } from './replacement.service.js';
import { ServiceTicketController } from './service-ticket.controller.js';
import { ServiceTicketService } from './service-ticket.service.js';

@Module({
  imports: [TerminalModule, ShipmentModule, CarrierModule],
  controllers: [ServiceTicketController],
  providers: [ServiceTicketService, ReplacementService],
})
export class ServiceModule {}
```

`apps/api/src/shipment/shipment.module.ts` 전체:
```ts
import { Module } from '@nestjs/common';
import { CarrierModule } from '../carrier/carrier.module.js';
import { TerminalModule } from '../terminal/terminal.module.js';
import { ShipmentController } from './shipment.controller.js';
import { ShipmentService } from './shipment.service.js';

@Module({
  imports: [TerminalModule, CarrierModule],
  controllers: [ShipmentController],
  providers: [ShipmentService],
  exports: [ShipmentService],
})
export class ShipmentModule {}
```

- [ ] **Step 4: 통과 확인 (3회)**

Run:
```bash
npx vitest run && npm run typecheck
for i in 1 2 3; do npx vitest run test/replacement.e2e.spec.ts --silent=false 2>&1 | grep -E "\[같은 교체 단말기 동시 요청\]|Tests "; done
```
Expected: 25개 파일 `169 passed`, typecheck exit 0, 3회 모두 `4 passed`. `[같은 교체 단말기 동시 요청]` 줄은 `응답=[201,422]`이고 코드·운송장 발급 수를 devlog에 적는다(사전 검증에서는 진 쪽이 `INVALID_TRANSITION` — 사전 확인은 둘 다 통과하고, 트랜잭션에서 잠금을 기다린 뒤 교체 단말기가 이미 SHIPPED인 것을 봤다).

마이그레이션은 없다(`npm run db:migration:check` → `최신 상태`).

- [ ] **Step 5: 기록과 커밋**

`docs/decisions/0023-교체-출고는-한-트랜잭션과-정해진-잠금-순서.md`:
- 상황: 교체 출고는 "새 단말기 배정·출고 + 고장 단말기 회수 요청 + 운송장 + 접수 상태"를 함께 바꾼다(설계안 F7 "한 건으로 처리"). 두 단말기 행을 잠그므로, 여러 교체 요청이 동시에 오면 잠금 순서가 엇갈릴 수 있다.
- 선택지(묶음): 1) 단계마다 따로 커밋: 중간 실패 시 교체 단말기만 SHIPPED인 상태가 남는다. 2) **한 트랜잭션**: 전부 아니면 전무. 외부 호출(운송장)은 밖에서 먼저.
- 선택지(잠금): 1) 잠금 없이 낙관적 락만: 경합에서 진 쪽이 409. 순서 문제는 UPDATE 순서에 숨는다. 2) **접수 행 → 단말기(id 오름차순) FOR UPDATE 명시**: 순서가 코드에 드러나고, 기다린 쪽은 최신 상태를 보고 규칙 위반(422)으로 끝난다. 3) 한 문장 `WHERE id IN (…) ORDER BY id FOR UPDATE`: 같은 효과지만 순서가 실행 계획에 숨는다.
- 결정: 한 트랜잭션 + 2. 접수 접수(Task 8)도 단말기 행을 먼저 잠근다. 같은 규칙: "부모 행 X 락을 자식 INSERT보다 먼저, 여러 행은 정해진 순서로".
- 출처: 교체 단말기는 ALLOCATION·SHIPMENT(교체도 배정·출고), 고장 단말기와 설치 확인은 SERVICE(decisions/0017).
- 결과·대가(알려진 한계): 사전 확인은 트랜잭션 밖이라 동시 요청은 모두 통과하고 모두 운송장을 발급받는다 → 진 요청 수만큼 고아 운송장(실험 0007에서 잰다). 교체 단말기를 먼저 "예약"하는 단계를 두면 줄지만 상태가 하나 더 생긴다 → Day 7 고아 정리와 함께 본다.
- 테스트: 전체 흐름(교체 → 배송 완료 → 설치 → 회수 스캔), 사전 확인 실패 시 운송장 0, 트랜잭션 중 실패 시 전부 롤백(운송장 1 고아), 같은 교체 단말기 동시 2건 → [201, 422].

`docs/study/backlog.md`에 추가:
```
- [ ] 여러 행 잠금 순서와 데드락 — 순환 대기 조건(공유 자원이 둘 이상이어야 한다) (decisions/0023, experiments/0007)
- [ ] 잠금 읽기(FOR UPDATE)는 스냅샷을 만들지 않고 최신 커밋을 읽는다 — RR에서 일반 SELECT와 다른 점 (replacement.service.ts)
```

커밋:
```bash
git add apps/api docs
git commit -m "feat(F7): A/S 교체 출고(한 트랜잭션, id 순 잠금)와 설치 확인" -m "Refs: docs/decisions/0023-교체-출고는-한-트랜잭션과-정해진-잠금-순서.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 실험 0006 — 대량 처리(N+1 대 일괄, 박스 500, 엑셀 1,000, outbox relay addBulk) (F6, F5)

**Files:**
- Modify: `apps/api/src/outbox/outbox.service.ts`(relay addBulk, 비교용 `enqueue: 'each'`)
- Test: `apps/api/test/outbox.e2e.spec.ts`(addBulk 테스트, 멈춤 지점을 addBulk로), `apps/api/test/experiments/bulk-ops.spec.ts`(새)
- Record: devlog, `docs/experiments/0006-대량-처리.md`, `docs/decisions/0024-outbox-relay는-addBulk로.md`, `docs/decisions/0016-…`(갱신 한 줄), `docs/study/backlog.md`

실험 내용(`EXPERIMENTS=1`일 때만):
- A. 신규 등록 500건: 행마다 `findOne` 후 `create`(N+1) vs 일괄 엔진. 쿼리 수(select·insert)와 시간.
- B. 박스 스캔 API로 발주분 500대 입고(HTTP, 명세 확인·발주 잠금 포함).
- C. 엑셀 1,000행 업로드(HTTP, 파일 읽기 포함).
- D. outbox 1,000행 relay(limit 100): 행마다 `add` vs `addBulk`. 전체 시간과 relay 1회의 최대 시간(= 행 락을 쥐는 시간). 워커 없이 job만 쌓고 수를 확인한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/outbox.e2e.spec.ts` 전체(`holdRelayEnqueue`가 `addBulk`에서 멈추게, 마지막에 addBulk 테스트 추가):
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { OutboxEvent, OutboxStatus } from '../src/outbox/outbox-event.entity.js';
import { OutboxService } from '../src/outbox/outbox.service.js';
import { QUEUE } from '../src/queue/queue-names.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { partners } from './helpers/partners.js';
import { resetQueues, waitFor, waitForQueuesIdle } from './helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'seo' };

describe('알림 Outbox (F5)', () => {
  let t: TestApp;
  let outbox: OutboxService;

  const rows = () => t.orm.em.fork().find(OutboxEvent, {}, { orderBy: { id: 'asc' } });
  const statusOf = async (id: number) => (await t.orm.em.fork().findOneOrFail(OutboxEvent, id)).status;

  /** PENDING을 모두 SENT·FAILED로 만든다(테스트 사이 정리). */
  async function drain() {
    await outbox.relay();
    await waitForQueuesIdle(t.app);
  }

  /**
   * 첫 번째 queue.addBulk 호출에서 멈추게 한다. relay 트랜잭션이 열린 채로 있는 상태를 만들려는 것. 그 뒤 호출은 그대로 통과한다.
   * entered: relay가 addBulk에 들어옴(= SELECT ... FOR UPDATE를 끝내고 락을 쥔 상태), release(): 이어서 진행.
   */
  function holdRelayEnqueue() {
    const queue = t.app.get<Queue>(getQueueToken(QUEUE.OUTBOX));
    const original = queue.addBulk.bind(queue);
    let release!: () => void;
    let markEntered!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((r) => (markEntered = r));
    let calls = 0;
    const spy = vi.spyOn(queue, 'addBulk').mockImplementation(async (...args: Parameters<Queue['addBulk']>) => {
      calls += 1;
      if (calls === 1) {
        markEntered();
        await released;
      }
      return original(...args);
    });
    return { entered, release, restore: () => spy.mockRestore() };
  }

  /** 요청이 끝날 때까지 걸린 시간을 잰다. */
  async function timed<T>(p: PromiseLike<T>): Promise<{ res: T; ms: number }> {
    const start = Date.now();
    const res = await p;
    return { res, ms: Date.now() - start };
  }

  beforeAll(async () => {
    t = await createTestApp({ workers: true });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    outbox = t.app.get(OutboxService);
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it('등록·전이는 같은 트랜잭션에서 알림을 PENDING으로 남긴다', async () => {
    await t.http().post('/terminals').set(OP).send({ serialNo: 'OB-0001', modelCode: 'SN-100' });
    const [registered] = await rows();
    expect(registered).toMatchObject({ type: 'terminal.status_changed', status: OutboxStatus.PENDING, attempts: 0 });
    expect(registered.payload).toMatchObject({ serialNo: 'OB-0001', fromStatus: null, toStatus: 'RECEIVED', actor: 'seo' });
  });

  it('거절된 전이(422)는 알림도 남기지 않는다(같이 롤백)', async () => {
    const before = (await rows()).length;
    const res = await t.http().post('/terminals/OB-0001/transitions').set(OP).send({ to: 'DISPOSED', reason: '폐기', expectedVersion: 1 });
    expect(res.status).toBe(422);
    expect(await rows()).toHaveLength(before);
  });

  it('relay → notify: 톡톡에 한 번 보내고 SENT', async () => {
    const { queued } = await outbox.relay();
    expect(queued).toHaveLength(1);
    expect(await statusOf(queued[0])).not.toBe(OutboxStatus.PENDING);
    await waitFor(async () => (await statusOf(queued[0])) === OutboxStatus.SENT, { message: 'SENT' });

    const toktok = await partners.toktok();
    expect(toktok.byKey).toEqual({ [`outbox-${queued[0]}`]: 1 });
    expect(toktok.messages[0].text).toBe('[단말온] OB-0001: 신규 → RECEIVED (seo) 신규 등록');
    expect((await outbox.relay()).queued).toHaveLength(0);
  });

  it('메신저가 계속 실패하면 재시도를 다 쓰고 FAILED, 마지막 오류를 남긴다', async () => {
    await partners.configure({ toktok: { failRate: 1 } });
    await t.http().post('/terminals').set(OP).send({ serialNo: 'OB-0002', modelCode: 'SN-100' });
    const { queued } = await outbox.relay();
    await waitFor(async () => (await statusOf(queued[0])) === OutboxStatus.FAILED, { timeoutMs: 15_000, message: 'FAILED' });
    const row = await t.orm.em.fork().findOneOrFail(OutboxEvent, queued[0]);
    expect(row.attempts).toBe(5);
    expect(row.lastError).toContain('PartnerTransientError');
    expect((await partners.toktok()).total).toBe(0);
  });

  it('한 번 실패해도 재시도로 보내면 SENT, 수신은 1번', async () => {
    await drain();
    await t.http().post('/terminals').set(OP).send({ serialNo: 'OB-0003', modelCode: 'SN-100' });
    await partners.configure({ toktok: { failRate: 1 } });
    const { queued } = await outbox.relay();
    await waitFor(async () => (await t.orm.em.fork().findOneOrFail(OutboxEvent, queued[0])).attempts >= 1, { message: '첫 시도' });
    await partners.configure({ toktok: { failRate: 0 } });
    await waitFor(async () => (await statusOf(queued[0])) === OutboxStatus.SENT, { message: 'SENT' });
    expect((await partners.toktok()).byKey[`outbox-${queued[0]}`]).toBe(1);
  });

  it('relay 여러 개가 동시에 돌아도 같은 행을 두 번 잡지 않는다(SKIP LOCKED)', async () => {
    await drain();
    for (let i = 0; i < 20; i++) {
      await t.http().post('/terminals').set(OP).send({ serialNo: `OB-1${String(i).padStart(3, '0')}`, modelCode: 'SN-100' });
    }
    // 한 번에 5건씩 잡는 relay 4개를 동시에 돌린다. 겹치지 않는 것만 본다.
    // 주의: 겹침 없음만으로는 SKIP LOCKED를 증명하지 못한다. 그냥 FOR UPDATE여도 relay들이 차례로 기다렸다 돌면
    // [5,5,5,5]가 나올 수 있다(실제로 바꿔 돌려 보니 여기서는 데드락으로 실패했다, troubleshooting/0007).
    // SKIP LOCKED의 진짜 차이는 "기다리지 않는다"이고, 그건 아래 'SKIP LOCKED' 테스트가 본다.
    const results = await Promise.all([1, 2, 3, 4].map(() => outbox.relay(5)));
    const all = results.flatMap((r) => r.queued);
    console.log(`[relay 동시] 각 relay가 잡은 수=${JSON.stringify(results.map((r) => r.queued.length))}`);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(20);

    await waitForQueuesIdle(t.app);
    const toktok = await partners.toktok();
    expect(Object.values(toktok.byKey).every((n) => n === 1)).toBe(true);
    expect(toktok.total).toBe(20);
  });

  it('relay 트랜잭션이 열려 있어도 등록·전이는 기다리지 않는다(gap 락, troubleshooting/0007)', async () => {
    await drain();
    // PENDING 1건(limit 100보다 적다) → RR이면 relay의 잠금 읽기가 (status, id) 인덱스의 다음 레코드·supremum까지 next-key 락을 건다.
    await t.http().post('/terminals').set(OP).send({ serialNo: 'OB-2000', modelCode: 'SN-100' });
    const em = t.orm.em.fork();
    const terminal = await em.findOneOrFail(Terminal, { serialNo: 'OB-2000' });
    terminal.status = TerminalStatus.INSPECTED;
    await em.flush();

    const hold = holdRelayEnqueue();
    try {
      const relaying = outbox.relay();
      await hold.entered;
      const register = timed(t.http().post('/terminals').set(OP).send({ serialNo: 'OB-2001', modelCode: 'SN-100' }));
      const transition = timed(
        t.http().post('/terminals/OB-2000/transitions').set(OP).send({ to: 'IN_STOCK', reason: '입고', expectedVersion: terminal.version }),
      );
      const LIMIT_MS = 1000;
      let timer: NodeJS.Timeout | undefined;
      const doneInTime = await Promise.race([
        Promise.all([register, transition]).then(() => true),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(false), LIMIT_MS);
        }),
      ]);
      clearTimeout(timer);
      hold.release();
      await relaying;
      const [reg, tr] = await Promise.all([register, transition]);
      console.log(`[relay 중 쓰기] 등록 ${reg.res.status} ${reg.ms}ms, 전이 ${tr.res.status} ${tr.ms}ms (relay가 addBulk에서 멈춘 동안, 한도 ${LIMIT_MS}ms)`);
      expect(doneInTime).toBe(true);
      expect(reg.res.status).toBe(201);
      expect(tr.res.status).toBe(200);
    } finally {
      hold.release();
      hold.restore();
    }
    await drain();
  });

  it('다른 relay가 행을 잡고 있으면 기다리지 않고 다음 행을 잡는다(SKIP LOCKED)', async () => {
    await drain();
    for (let i = 0; i < 10; i++) {
      await t.http().post('/terminals').set(OP).send({ serialNo: `OB-3${String(i).padStart(3, '0')}`, modelCode: 'SN-100' });
    }
    const hold = holdRelayEnqueue();
    try {
      let firstDone = false;
      const first = outbox.relay(5).then((r) => ((firstDone = true), r));
      await hold.entered; // 첫 relay가 5건을 잠그고 addBulk에서 멈춤
      const second = await timed(outbox.relay(5));
      const firstStillHolding = !firstDone;
      hold.release();
      const firstResult = await first;
      console.log(`[SKIP LOCKED] 둘째 relay ${second.ms}ms, 첫째=${JSON.stringify(firstResult.queued)} 둘째=${JSON.stringify(second.res.queued)}`);
      expect(firstStillHolding).toBe(true);
      expect(second.ms).toBeLessThan(1000);
      expect(firstResult.queued).toHaveLength(5);
      expect(second.res.queued).toHaveLength(5);
      expect(second.res.queued.filter((id) => firstResult.queued.includes(id))).toEqual([]);
    } finally {
      hold.release();
      hold.restore();
    }
    await waitForQueuesIdle(t.app);
  });

  it('relay는 잡은 행을 addBulk 한 번으로 큐에 넣는다(행마다 add하지 않는다, decisions/0024)', async () => {
    await drain();
    for (let i = 0; i < 5; i++) {
      await t.http().post('/terminals').set(OP).send({ serialNo: `OB-4${String(i).padStart(3, '0')}`, modelCode: 'SN-100' });
    }
    const queue = t.app.get<Queue>(getQueueToken(QUEUE.OUTBOX));
    const add = vi.spyOn(queue, 'add');
    const addBulk = vi.spyOn(queue, 'addBulk');
    try {
      const { queued } = await outbox.relay();
      expect(queued).toHaveLength(5);
      expect(addBulk).toHaveBeenCalledTimes(1);
      expect(addBulk.mock.calls[0][0].map((j) => j.opts?.jobId)).toEqual(queued.map((id) => `outbox-${id}`));
      expect(add).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
      addBulk.mockRestore();
    }
    await waitForQueuesIdle(t.app);
    expect(Object.values((await partners.toktok()).byKey).every((n) => n === 1)).toBe(true);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/outbox.e2e.spec.ts`
Expected: FAIL — `3 failed | 6 passed`. 'relay는 잡은 행을 addBulk 한 번으로…'가 `expected "addBulk" to be called 1 times, but got 0 times`. 멈춤 지점을 addBulk로 바꾼 두 테스트(gap 락, SKIP LOCKED)는 relay가 아직 add를 써서 `hold.entered`에 닿지 않아 `Test timed out in 30000ms`(각 30초 걸린다).

- [ ] **Step 3: relay를 addBulk로**

`apps/api/src/outbox/outbox.service.ts` 전체:
```ts
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { UnrecoverableError, type JobsOptions, type Queue } from 'bullmq';
import { EntityManager, IsolationLevel, LockMode } from '@mikro-orm/mysql';
import { PartnerPermanentError } from '../common/partner-errors.js';
import { QUEUE } from '../queue/queue-names.js';
import { OutboxEvent, OutboxStatus } from './outbox-event.entity.js';
import { ToktokClient } from './toktok.client.js';

export interface NotifyJobData {
  outboxId: number;
}

export const NOTIFY_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 200 },
  removeOnComplete: true,
  removeOnFail: true,
};

/** 메신저가 같은 알림을 한 번으로 볼 수 있게 보내는 키. outbox 행마다 하나 */
export function idempotencyKeyOf(id: number): string {
  return `outbox-${id}`;
}

function textOf(event: OutboxEvent): string {
  const p = event.payload as { serialNo?: string; fromStatus?: string | null; toStatus?: string; actor?: string; reason?: string };
  return `[단말온] ${p.serialNo}: ${p.fromStatus ?? '신규'} → ${p.toStatus} (${p.actor}) ${p.reason}`;
}

/**
 * Outbox(F5).
 * - relay: PENDING 행을 잠그고(다른 relay가 잡은 행은 건너뜀, SKIP LOCKED) notify job을 넣은 뒤 QUEUED로 바꾼다.
 *   READ COMMITTED로 돈다. 기본(REPEATABLE READ)이면 잠금 읽기가 (status, id) 인덱스의 gap까지 잠가
 *   새 PENDING 행 INSERT(= 전이·등록 트랜잭션)를 relay가 커밋할 때까지 막는다(troubleshooting/0007).
 * - notify: 톡톡메신저로 보내고 SENT로 바꾼다. 최종 실패면 FAILED.
 * 보장 수준은 "최소 한 번 + 멱등키"다(decisions/0016).
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly em: EntityManager,
    private readonly toktok: ToktokClient,
    @InjectQueue(QUEUE.OUTBOX) private readonly queue: Queue,
  ) {}

  /**
   * @param opts.enqueue 'bulk'(기본): 잡은 행을 addBulk 한 번으로 넣는다(Redis 왕복 1번). 'each': 행마다 add(Day 2 방식).
   *   'each'는 실험 0006에서 비교하려고만 남긴다(decisions/0024).
   */
  async relay(limit = 100, opts: { enqueue?: 'bulk' | 'each' } = {}): Promise<{ queued: number[] }> {
    const queued = await this.em.fork().transactional(async (tx) => {
      const rows = await tx.find(
        OutboxEvent,
        { status: OutboxStatus.PENDING },
        { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, limit, orderBy: { id: 'asc' } },
      );
      // jobId가 같으면 BullMQ가 한 번만 받는다(addBulk도 같다). 커밋 전에 죽어 이 행이 다시 relay돼도 job이 남아 있으면 중복으로 들어가지 않는다.
      const jobs = rows.map((row) => ({
        name: 'notify',
        data: { outboxId: row.id },
        opts: { ...NOTIFY_JOB_OPTIONS, jobId: idempotencyKeyOf(row.id) },
      }));
      if (opts.enqueue === 'each') {
        for (const job of jobs) await this.queue.add(job.name, job.data, job.opts);
      } else if (jobs.length > 0) {
        await this.queue.addBulk(jobs);
      }
      for (const row of rows) row.status = OutboxStatus.QUEUED;
      return rows.map((r) => r.id);
    }, { isolationLevel: IsolationLevel.READ_COMMITTED });
    return { queued };
  }

  async notify(outboxId: number, { lastAttempt }: { lastAttempt: boolean }): Promise<'SENT' | 'SKIPPED'> {
    const em = this.em.fork();
    const row = await em.findOne(OutboxEvent, outboxId);
    if (!row || row.status === OutboxStatus.SENT || row.status === OutboxStatus.FAILED) return 'SKIPPED';

    row.attempts += 1;
    try {
      await this.toktok.send({ idempotencyKey: idempotencyKeyOf(row.id), text: textOf(row) });
    } catch (error) {
      const permanent = error instanceof PartnerPermanentError;
      row.lastError = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
      if (permanent || lastAttempt) row.status = OutboxStatus.FAILED;
      await em.flush();
      throw permanent ? new UnrecoverableError(row.lastError) : error;
    }
    // 여기서 죽으면(메신저는 받았는데 SENT를 못 씀) job이 다시 실행돼 한 번 더 보낸다 → 멱등키로 메신저가 걸러야 한다.
    row.status = OutboxStatus.SENT;
    row.sentAt = new Date();
    row.lastError = null;
    await em.flush();
    return 'SENT';
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run && npm run typecheck`
Expected: 25개 파일 `170 passed`, typecheck exit 0. outbox 테스트의 `[relay 동시] [5,5,5,5]`, `[relay 중 쓰기]` 수십 ms 이하, `[SKIP LOCKED]` 둘째 relay 1초 미만이 그대로인지 본다.

- [ ] **Step 5: 실험 스펙**

`apps/api/test/experiments/bulk-ops.spec.ts`:
```ts
import ExcelJS from 'exceljs';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTBOX_TYPE, OutboxEvent, OutboxStatus } from '../../src/outbox/outbox-event.entity.js';
import { OutboxService } from '../../src/outbox/outbox.service.js';
import { QUEUE } from '../../src/queue/queue-names.js';
import { BulkRegistrationService } from '../../src/terminal/bulk-registration.service.js';
import { TerminalModel } from '../../src/terminal/terminal-model.entity.js';
import { Terminal } from '../../src/terminal/terminal.entity.js';
import { TransitionSource } from '../../src/terminal/terminal-status.js';
import { TransitionService } from '../../src/terminal/transition.service.js';
import { partners } from '../helpers/partners.js';
import { captureQueries } from '../helpers/query-log.js';
import { resetQueues } from '../helpers/queues.js';
import { orderPurchase } from '../helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

// experiments/0006. 실행: EXPERIMENTS=1 npx vitest run test/experiments/bulk-ops.spec.ts
const BOX = Number(process.env.EXP_BOX ?? 500);
const EXCEL_ROWS = Number(process.env.EXP_EXCEL ?? 1000);
const OUTBOX_ROWS = Number(process.env.EXP_OUTBOX ?? 1000);
const OP = { 'X-Operator': 'exp6' };
const serialsOf = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(5, '0')}`);

async function measure<T>(t: TestApp, fn: () => Promise<T>) {
  const cap = captureQueries(t.orm);
  const started = performance.now();
  try {
    const result = await fn();
    return { result, ms: Math.round(performance.now() - started), queries: cap.queries.length, selects: cap.selects(), inserts: cap.queries.filter((q) => /^insert /i.test(q)).length };
  } finally {
    cap.stop();
  }
}

describe(`실험 0006: 대량 처리 (박스 ${BOX}대, 엑셀 ${EXCEL_ROWS}행, outbox ${OUTBOX_ROWS}행)`, () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    await partners.reset();
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it(`A. 신규 등록 ${BOX}건: 행마다 findOne(N+1) vs 일괄 엔진`, async () => {
    const transitions = t.app.get(TransitionService);
    const bulk = t.app.get(BulkRegistrationService);
    // 행마다 존재 확인(findOne) 후 만들기. 같은 트랜잭션 하나, 이력·Outbox도 같이 쌓는다.
    const naive = await measure(t, () =>
      t.orm.em.fork().transactional(async (tx) => {
        const model = await tx.findOneOrFail(TerminalModel, { code: 'SN-100' });
        for (const serialNo of serialsOf('EXN', BOX)) {
          if (await tx.findOne(Terminal, { serialNo })) continue;
          const terminal = tx.create(Terminal, { serialNo, model });
          transitions.recordRegistration(terminal, 'exp6', TransitionSource.SCAN, tx);
        }
      }),
    );
    const engine = await measure(t, () =>
      bulk.register(serialsOf('EXB', BOX).map((serialNo) => ({ serialNo, modelCode: 'SN-100' })), { actor: 'exp6', source: TransitionSource.SCAN }),
    );
    console.log(
      `[실험 0006/A] ${BOX}건 N+1: ${naive.ms}ms 쿼리 ${naive.queries}(select ${naive.selects}, insert ${naive.inserts}) / ` +
        `일괄: ${engine.ms}ms 쿼리 ${engine.queries}(select ${engine.selects}, insert ${engine.inserts})`,
    );
    expect(await t.orm.em.fork().count(Terminal, { serialNo: { $like: 'EXN-%' } })).toBe(BOX);
    expect(await t.orm.em.fork().count(Terminal, { serialNo: { $like: 'EXB-%' } })).toBe(BOX);
    expect(naive.selects).toBeGreaterThanOrEqual(BOX);
    expect(engine.selects).toBeLessThanOrEqual(5);
  }, 300_000);

  it(`B. 박스 스캔 API로 발주분 ${BOX}대 입고(HTTP, 명세 확인·발주 잠금 포함)`, async () => {
    const { poNo, serials } = await orderPurchase(t, BOX);
    const scan = await measure(t, () => t.http().post('/scans').set(OP).send({ scanId: `EXP6-BOX-${Date.now()}`, kind: 'RECEIVE', poNo, serials }));
    console.log(`[실험 0006/B] 스캔 ${BOX}대: HTTP ${scan.result.status} ${scan.ms}ms 쿼리 ${scan.queries}(select ${scan.selects}, insert ${scan.inserts}) 결과=${JSON.stringify(scan.result.body.summary)}`);
    expect(scan.result.status).toBe(201);
    expect(scan.result.body.summary).toEqual({ CREATED: BOX });
  }, 300_000);

  it(`C. 엑셀 ${EXCEL_ROWS}행 등록(HTTP, 파일 읽기 포함)`, async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('terminals');
    ws.addRow(['serialNo', 'modelCode']);
    for (const serialNo of serialsOf('EXX', EXCEL_ROWS)) ws.addRow([serialNo, 'SN-100']);
    const file = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await measure(t, () => t.http().post('/terminals/imports').set(OP).attach('file', file, 'exp6.xlsx'));
    console.log(`[실험 0006/C] 엑셀 ${EXCEL_ROWS}행(${file.length}바이트): HTTP ${res.result.status} ${res.ms}ms 쿼리 ${res.queries}(select ${res.selects}, insert ${res.inserts})`);
    expect(res.result.status).toBe(201);
    expect(res.result.body.summary).toEqual({ CREATED: EXCEL_ROWS });
  }, 300_000);

  it(`D. outbox ${OUTBOX_ROWS}행 relay: 행마다 add vs addBulk (limit 100)`, async () => {
    const outbox = t.app.get(OutboxService);
    const queue = t.app.get<Queue>(getQueueToken(QUEUE.OUTBOX));
    const rows = Array.from({ length: OUTBOX_ROWS }, (_, i) => ({
      type: OUTBOX_TYPE.TERMINAL_STATUS_CHANGED,
      payload: { serialNo: `EXO-${i}` },
      status: OutboxStatus.PENDING,
      attempts: 0,
      createdAt: new Date(),
    }));
    const result: Record<string, { totalMs: number; maxRelayMs: number; relays: number; jobs: number }> = {};
    for (const mode of ['each', 'bulk'] as const) {
      // 이전 단계·이전 변형의 행과 job을 지우고 같은 조건에서 시작한다(워커가 없어 job은 처리되지 않고 쌓인다).
      await t.orm.em.fork().nativeDelete(OutboxEvent, {});
      await resetQueues(t.app);
      await t.orm.em.fork().insertMany(OutboxEvent, rows);
      const durations: number[] = [];
      const started = performance.now();
      for (;;) {
        const s = performance.now();
        const { queued } = await outbox.relay(100, { enqueue: mode });
        if (queued.length === 0) break;
        durations.push(performance.now() - s);
      }
      const totalMs = Math.round(performance.now() - started);
      const jobs = await queue.getJobCountByTypes('waiting');
      result[mode] = { totalMs, maxRelayMs: Math.round(Math.max(...durations)), relays: durations.length, jobs };
      expect(await t.orm.em.fork().count(OutboxEvent, { status: OutboxStatus.QUEUED })).toBe(OUTBOX_ROWS);
      expect(jobs).toBe(OUTBOX_ROWS);
    }
    console.log(`[실험 0006/D] outbox ${OUTBOX_ROWS}행 relay(limit 100): ${JSON.stringify(result)}`);
  }, 300_000);
});
```

- [ ] **Step 6: 기본 실행에서 빠지는지 확인**

Run: `npx vitest run 2>&1 | grep -E "Test Files|Tests "`
Expected: `25 passed`, `170 passed`(실험 파일은 포함되지 않는다)

- [ ] **Step 7: 실험 실행 (3회)**

Run:
```bash
for i in 1 2 3; do EXPERIMENTS=1 npx vitest run test/experiments/bulk-ops.spec.ts --silent=false 2>&1 | grep -E "\[실험 0006|Tests "; done
```
Expected: 3회 모두 `4 passed`. `[실험 0006/A]`~`[D]` 네 줄의 숫자를 그대로 기록한다(사전 검증에서는 A의 N+1이 select·insert 모두 행 수에 비례했고 일괄은 행 수와 상관없는 몇 개였다. D는 addBulk 쪽이 전체·1회 최대 모두 짧았다 — 실제 잰 값을 쓴다).

- [ ] **Step 8: 기록과 커밋**

`docs/experiments/0006-대량-처리.md`(README 양식):
- 질문: 1) 행마다 조회하는 N+1과 일괄 조회의 쿼리 수·시간 차이 2) 박스 500대·엑셀 1,000행을 한 요청·한 트랜잭션으로 처리하면 얼마나 걸리나 3) relay에 addBulk를 쓰면 행 락 시간이 줄어드나(Day 2 리뷰 Minor 3)
- 설정: `EXP_BOX=500`, `EXP_EXCEL=1000`, `EXP_OUTBOX=1000`, relay limit 100, 워커 없음, 로컬 한 PC(MySQL·Redis Docker)
- 재현: Step 7 명령
- 결과: 3회 출력 원문 + 표(A N+1/일괄 쿼리·ms, B, C, D each/bulk totalMs·maxRelayMs)
- 결론: (잰 숫자로) N+1이 쿼리를 얼마나 늘렸나, FlushMode AUTO 때문에 INSERT도 행마다 나간 것, 일괄 처리 시간, addBulk 채택 여부
- 한계: 한 PC, 동시 요청 없음, 네트워크 지연 거의 없음(원격 DB·Redis면 왕복 차이가 더 크다), 쿼리 수에 begin·commit 포함

`docs/decisions/0024-outbox-relay는-addBulk로.md`:
- 상황: relay는 PENDING 행을 FOR UPDATE SKIP LOCKED로 잡은 채(READ COMMITTED) 행마다 Redis `add`를 했다(Day 2 리뷰 Minor 3). 락을 쥔 시간이 행 수 × Redis 왕복이다. Day 3 일괄 등록으로 한 번에 수백 행의 Outbox가 생긴다.
- 선택지: 1) 그대로 add: 단순. 2) **addBulk 한 번**: 왕복 1번. jobId 중복 무시는 같다(사전 검증). 3) 먼저 QUEUED로 커밋하고 트랜잭션 밖에서 add: 락 시간은 0이지만 커밋 뒤 add 전에 죽으면 job 없는 QUEUED가 생긴다(decisions/0016에서 버린 선택지).
- 결정: 2(실험 0006 D의 숫자를 적는다). 비교용으로 `relay(limit, { enqueue: 'each' })`를 남긴다(운영 경로는 쓰지 않는다). 숫자가 예상과 반대였다면 기본값을 'each'로 두고 그 이유를 적는다.
- 결과·대가: addBulk는 MULTI로 묶여 여러 job을 한 번에 넣는다. 중간 실패 시 일부만 들어갈 수 있는지는 확인하지 않았다(추정: jobId가 같아 다음 relay가 다시 넣어도 중복은 안 된다).

`docs/decisions/0016-Outbox-최소-한-번과-멱등키.md` 끝에 한 줄:
```
- 갱신(2026-10-23 Day 3): relay가 행마다 add하던 것을 addBulk 한 번으로 바꿨다 → decisions/0024, experiments/0006
```

`docs/study/backlog.md`에 추가:
```
- [ ] BullMQ addBulk의 원자성 — 여러 job을 MULTI로 넣을 때 중간 실패 (decisions/0024)
- [ ] 쿼리 수를 세는 방법 — ORM 로거 훅, MySQL performance_schema·general log 비교 (test/helpers/query-log.ts)
```

커밋:
```bash
git add apps/api docs
git commit -m "exp(F6): 0006 대량 처리 실험과 outbox relay addBulk" -m "Refs: docs/experiments/0006-대량-처리.md, docs/decisions/0024-outbox-relay는-addBulk로.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 실험 0007 — 같은 교체 단말기를 여러 접수가 동시에 요청 (F7)

**Files:**
- Test: `apps/api/test/experiments/replacement-race.spec.ts`(새)
- Record: devlog, `docs/experiments/0007-교체-단말기-동시-요청.md`, `docs/decisions/0023-…`(갱신 한 줄), `docs/study/backlog.md`

질문: 같은 교체 단말기를 접수 10건이 동시에 요청하면 정확히 1건만 성공하는가, 500·데드락은 0인가, 고아 운송장은 몇 장인가. 잠금 순서를 id 오름차순(`id-asc`, 운영)과 고장 단말기 먼저(`faulty-first`)로 바꿔도 결과가 같은가. 교체 단말기를 먼저 만들어 id가 가장 작게 하므로 `faulty-first`는 실제로 반대 순서가 된다.

예상: 공유되는 행은 교체 단말기 하나뿐이다. 각 트랜잭션이 "자기 고장 단말기 + 공유 교체 단말기"를 잡으므로 순서를 바꿔도 서로 상대가 쥔 행을 기다리는 순환이 생기지 않는다 → 데드락은 두 순서 모두 0일 것이다. 데드락이 나오면 그 근거(`SHOW ENGINE INNODB STATUS`의 LATEST DETECTED DEADLOCK)를 남기고, 안 나오면 이 이유를 결론에 적는다(사전 검증에서는 두 순서 모두 3회 데드락 0).

- [ ] **Step 1: 실험 스펙**

`apps/api/test/experiments/replacement-race.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Carrier } from '../../src/carrier/carrier.types.js';
import { BusinessError, InvalidTransitionError } from '../../src/common/domain-errors.js';
import { ReplacementService, type LockOrder } from '../../src/service/replacement.service.js';
import { ServiceTicket, ServiceTicketStatus } from '../../src/service/service-ticket.entity.js';
import { Shipment } from '../../src/shipment/shipment.entities.js';
import { TerminalStatusHistory } from '../../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus } from '../../src/terminal/terminal-status.js';
import { partners } from '../helpers/partners.js';
import { prepareInService, registerInStock } from '../helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

// experiments/0007. 실행: EXPERIMENTS=1 npx vitest run test/experiments/replacement-race.spec.ts
const N = Number(process.env.EXP_N ?? 10);
const ROUNDS = Number(process.env.EXP_ROUNDS ?? 3);
const ORDERS: LockOrder[] = ['id-asc', 'faulty-first'];

/** 실패 사유를 짧은 이름으로 */
function reasonOf(error: unknown): string {
  if (error instanceof BusinessError) return error.code;
  if (error instanceof InvalidTransitionError) return 'INVALID_TRANSITION';
  return error instanceof Error ? error.name : String(error);
}

describe(`실험 0007: 같은 교체 단말기를 접수 ${N}건이 동시에 요청 (${ROUNDS}회 × 잠금 순서 ${ORDERS.join(', ')})`, () => {
  let t: TestApp;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await partners.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  for (const order of ORDERS) {
    it(`잠금 순서 ${order}: 정확히 1건 성공, 나머지 409/422, 500·데드락 0`, async () => {
      const replacements = t.app.get(ReplacementService);
      for (let round = 1; round <= ROUNDS; round++) {
        seq += 1;
        const tag = `R7${String(seq).padStart(2, '0')}`;
        // 교체 단말기를 먼저 만들어 id가 고장 단말기들보다 작게 한다 → 'faulty-first'는 id 오름차순과 반대 순서로 잠근다.
        await registerInStock(t, `${tag}-REPL`);
        const ticketIds: number[] = [];
        for (let i = 1; i <= N; i++) {
          const serialNo = `${tag}-F${String(i).padStart(3, '0')}`;
          await prepareInService(t, serialNo);
          ticketIds.push((await t.http().post('/service-tickets').set({ 'X-Operator': 'exp7' }).send({ serialNo, symptom: '고장' })).body.id);
        }
        await partners.reset();

        const started = performance.now();
        const settled = await Promise.allSettled(
          ticketIds.map((id) => replacements.replace(id, { replacementSerialNo: `${tag}-REPL`, carrier: Carrier.BUNGAE }, 'exp7', { lockOrder: order })),
        );
        const elapsed = Math.round(performance.now() - started);

        const ok = settled.filter((s) => s.status === 'fulfilled').length;
        const reasons: Record<string, number> = {};
        for (const s of settled) if (s.status === 'rejected') reasons[reasonOf(s.reason)] = (reasons[reasonOf(s.reason)] ?? 0) + 1;
        const em = t.orm.em.fork();
        const shipments = await em.count(Shipment, { terminal: { serialNo: `${tag}-REPL` } });
        const waybills = (await partners.stats()).calls['bungae.waybill'] ?? 0;
        const replacing = await em.count(ServiceTicket, { id: { $in: ticketIds }, status: ServiceTicketStatus.REPLACING });
        const returnRequested = await em.count(TerminalStatusHistory, {
          terminal: { serialNo: { $like: `${tag}-F%` } },
          toStatus: TerminalStatus.RETURN_REQUESTED,
        });
        console.log(
          `[실험 0007/${order} #${round}] N=${N} 성공=${ok} 실패=${JSON.stringify(reasons)} 운송장발급=${waybills} 저장=${shipments} ` +
            `고아=${waybills - shipments} REPLACING=${replacing} 회수요청이력=${returnRequested} 소요=${elapsed}ms`,
        );

        expect(ok).toBe(1);
        expect(Object.keys(reasons).every((k) => ['INVALID_TRANSITION', 'REPLACEMENT_NOT_IN_STOCK', 'OptimisticLockError'].includes(k))).toBe(true);
        expect(shipments).toBe(1);
        expect(replacing).toBe(1);
        expect(returnRequested).toBe(1); // 진 쪽의 고장 단말기는 회수 요청으로 바뀌지 않았다(전부 롤백)
      }
    }, 300_000);
  }
});
```

- [ ] **Step 2: 기본 실행에서 빠지는지 확인**

Run: `npx vitest run 2>&1 | grep -E "Test Files|Tests "`
Expected: `25 passed`, `170 passed`

- [ ] **Step 3: 실험 실행**

Run: `EXPERIMENTS=1 npx vitest run test/experiments/replacement-race.spec.ts --silent=false 2>&1 | grep -E "\[실험 0007|Tests "`
Expected: `2 passed`. 순서별 3줄씩 `[실험 0007/<순서> #<회>] N=10 성공=1 실패={…} 운송장발급=… 저장=1 고아=… REPLACING=1 회수요청이력=1 소요=…ms`. 실패 사유는 `INVALID_TRANSITION`(트랜잭션에서 잠금을 기다린 뒤 걸림) 또는 `REPLACEMENT_NOT_IN_STOCK`(사전 확인에서 걸림)만 나와야 한다. `DeadlockException` 등 다른 이름이 보이면 단언이 실패한다 → 그때는 MySQL에서 `SHOW ENGINE INNODB STATUS\G`의 LATEST DETECTED DEADLOCK 절을 바로 떠서 기록한다.

- [ ] **Step 4: 기록과 커밋**

`docs/experiments/0007-교체-단말기-동시-요청.md`:
- 질문·예상: 위 설명 그대로
- 설정: N=10(`EXP_N`), 3회(`EXP_ROUNDS`), 순서 `id-asc`·`faulty-first`, 번개택배, 서비스 직접 호출(`ReplacementService.replace`, 같은 프로세스·같은 커넥션 풀)
- 재현: Step 3 명령
- 결과: 6줄 원문 + 표(순서, 회차, 성공, 실패 사유별 수, 운송장 발급, 고아, 소요)
- 결론: 정확히 1건 성공·500 0·데드락 0 여부, 잠금 순서를 바꿔도 같은 이유(공유 행 1개 → 순환 대기 불가), 진 요청이 어디서 걸렸나(사전 확인 vs 잠금 뒤 규칙 위반), 고아 운송장 수(사전 확인이 동시 요청을 거의 거르지 못한다)
- 한계: 데드락이 날 수 있는 모양(두 트랜잭션이 같은 두 행을 반대 순서로)은 이 기능에서 만들 수 없어 재현하지 않았다. 다른 API(예: 같은 단말기 두 대를 다루는 다른 기능)가 생기면 그때 같은 규칙을 적용하고 실험한다.

`docs/decisions/0023-교체-출고는-한-트랜잭션과-정해진-잠금-순서.md` 끝에 한 줄:
```
- 갱신(Task 11): 실험 0007 — 두 잠금 순서 모두 3회 성공 1·데드락 0(잰 값). 공유 행이 교체 단말기 하나라 순서가 데드락을 만들지 않는다. 그래도 id 오름차순을 규칙으로 둔다(공유 행이 둘이 되는 기능이 생기면 바로 필요하다). 고아 운송장 (잰 값)장/회 → 예약 단계는 Day 7 검토
```

`docs/study/backlog.md`에 추가:
```
- [ ] SHOW ENGINE INNODB STATUS의 LATEST DETECTED DEADLOCK 읽는 법 (experiments/0007)
```

커밋:
```bash
git add apps/api docs
git commit -m "exp(F7): 0007 같은 교체 단말기 동시 요청과 잠금 순서" -m "Refs: docs/experiments/0007-교체-단말기-동시-요청.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: 3일차 마감 — 전체 검증, 마이그레이션 체인, 실서버 확인, 기록 정리

**Files:**
- Record: `docs/devlog/2026-10-23.md`(3일차 요약), `docs/study/backlog.md`
- Modify: `../01_B_단말기생애주기_설계안.md`(저장소 밖, 커밋 대상 아님)

- [ ] **Step 1: 전체 검증**

Run (`apps/partners`):
```bash
npx vitest run && npm run typecheck && npm run build
```
Run (`apps/api`):
```bash
npx vitest run
npm run typecheck
npm run build
npm run db:migration:check
```
Expected: partners 5개 파일 `39 passed`. api 25개 파일 `170 passed`(개수를 기록), typecheck·build exit 0, `최신 상태`

- [ ] **Step 2: 빈 테스트 DB에 마이그레이션 체인 전체 적용**

테스트 DB를 지우고 다시 만든 뒤(맨 위 "프로세스·데이터 안전 규칙"의 명령), 마이그레이션만으로 스키마를 만든다.
```bash
npm run build
MYSQL_DATABASE=terminal_ops_test node dist/db/migrate.js up
MYSQL_DATABASE=terminal_ops_test node dist/db/migrate.js check
```
Expected: Day 1~3 마이그레이션 12개가 차례로 `Applied`, `최신 상태`. (`check`는 테스트 DB 이름의 스냅샷 파일이 없어 DB 스키마와 엔티티를 직접 비교한다.) 그다음 `npx vitest run`을 한 번 더 돌려 테스트가 스키마를 다시 만들어도 문제없는지 본다.

- [ ] **Step 3: 실서버 확인 (partners + API + 워커·스케줄러 한 프로세스, 개발 DB)**

개발 DB에는 Task 1·3·5·7·8 마이그레이션이 적용돼 있어야 한다(`npm run db:migrate && npm run db:seed`).

Run (`apps/api`, Git Bash):
```bash
node ../partners/dist/main.js > smoke-partners.log 2>&1 & P1=$!
SWEEP_INTERVAL_MS=1000 RELAY_INTERVAL_MS=1000 node dist/main.js > smoke-api.log 2>&1 & P2=$!
sleep 5
B=localhost:3000; H='Content-Type: application/json'; O='X-Operator: manual'; S=$(date +%H%M%S)

echo '--- 1. 발주 + 박스 입고 스캔(재전송 포함) + 대조 + 마감'
PO=$(curl -s -X POST $B/purchase-orders -H "$H" -H "$O" -d '{"modelCode":"SN-100","quantity":3}'); echo $PO
PONO=$(echo $PO | sed 's/.*"poNo":"\([A-Z0-9]*\)".*/\1/')
NOTE=$(curl -s 127.0.0.1:4010/seum/v1/purchase-orders/$PONO/delivery-note); echo $NOTE
S1=$(echo $NOTE | sed 's/.*"serials":\["\([^"]*\)".*/\1/')
curl -s -X POST $B/scans -H "$H" -H "$O" -d "{\"scanId\":\"SMOKE-$S-1\",\"kind\":\"RECEIVE\",\"poNo\":\"$PONO\",\"serials\":[\"$S1\",\"SE0-0001\"]}"; echo
curl -s -X POST $B/scans -H "$H" -H "$O" -d "{\"scanId\":\"SMOKE-$S-1\",\"kind\":\"RECEIVE\",\"poNo\":\"$PONO\",\"serials\":[\"$S1\",\"SE0-0001\"]}" -o /dev/null -w 'replay status=%{http_code}\n'
curl -s $B/purchase-orders/$PONO/reconciliation; echo
curl -s -X POST $B/purchase-orders/$PONO/close -H "$O"; echo

echo '--- 2. 엑셀 일괄 등록'
node -e "
const ExcelJS = require('exceljs');
const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('t');
ws.addRow(['serialNo','modelCode']); ws.addRow(['XL-$S-1','SN-100']); ws.addRow(['bad','SN-100']);
wb.xlsx.writeFile('smoke-day3.xlsx').then(() => console.log('xlsx ok'));"
curl -s -X POST $B/terminals/imports -H "$O" -F "file=@smoke-day3.xlsx"; echo

echo '--- 3. A/S 교체 출고 → 자동 배송 완료 → 설치 확인'
for X in F R; do
  curl -s -X POST $B/terminals -H "$H" -H "$O" -d "{\"serialNo\":\"AS-$S-$X\",\"modelCode\":\"SN-100\"}" -o /dev/null
  curl -s -X POST $B/terminals/AS-$S-$X/inspections -H "$H" -H "$O" -d '{"results":[{"itemCode":"POWER","passed":true},{"itemCode":"NETWORK","passed":true},{"itemCode":"CARD_READER","passed":true},{"itemCode":"PRINTER","passed":true}]}' -o /dev/null
  curl -s -X POST $B/terminals/AS-$S-$X/transitions -H "$H" -H "$O" -d '{"to":"IN_STOCK","reason":"stock-in","expectedVersion":2}' -o /dev/null
done
curl -s -X POST $B/terminals/AS-$S-F/allocations -H "$H" -H "$O" -d '{"merchantCode":"PANGYO-BUNSIK","expectedVersion":3}' -o /dev/null
curl -s -X POST $B/shipments -H "$H" -H "$O" -d "{\"serialNo\":\"AS-$S-F\",\"carrier\":\"BUNGAE\",\"expectedVersion\":4}" -o /dev/null
curl -s -X POST $B/terminals/AS-$S-F/transitions -H "$H" -H "$O" -d '{"to":"DELIVERED","reason":"delivered","expectedVersion":5}' -o /dev/null
curl -s -X POST $B/terminals/AS-$S-F/transitions -H "$H" -H "$O" -d '{"to":"IN_SERVICE","reason":"installed","expectedVersion":6}'; echo
TK=$(curl -s -X POST $B/service-tickets -H "$H" -H "$O" -d "{\"serialNo\":\"AS-$S-F\",\"symptom\":\"card reader\"}"); echo $TK
TID=$(echo $TK | sed 's/.*"id":\([0-9]*\).*/\1/')
curl -s -X POST $B/service-tickets/$TID/replacements -H "$H" -H "$O" -d "{\"replacementSerialNo\":\"AS-$S-R\",\"carrier\":\"NEURIMBO\"}"; echo
sleep 8
curl -s $B/terminals/AS-$S-R; echo
curl -s -X POST $B/service-tickets/$TID/installations -H "$O"; echo
curl -s $B/terminals/AS-$S-R/history; echo
curl -s 127.0.0.1:4010/__admin/stats; echo

kill $P2 $P1
rm -f smoke-day3.xlsx
```
(사유·증상은 영문으로 쓴다. Git Bash `curl -d`의 한글이 깨지는 것을 Day 2에서 봤다. 서버 로그는 `smoke-api.log`, `smoke-partners.log`에 남고, 확인 뒤 지운다 — 커밋하지 않는다.)

Expected(사전 검증에서 테스트 DB·다른 포트로 같은 흐름을 확인했다):
- 발주 `status: ORDERED`, 명세 3개. 첫 스캔 `summary {"CREATED":1,"NOT_IN_DELIVERY_NOTE":1}`, 재전송 `replay status=200`
- 대조 `ordered 3, noted 3, received 1, missing 2개, unexpected ["SE0-0001"]`, 마감 `status: CLOSED`, `closedBy: manual`
- 엑셀 `summary {"CREATED":1,"INVALID_FORMAT":1}`, 행 번호 2·3
- 교체 출고 응답 `status: REPLACING`, `outboundTrackingNo: NR…`. 8초 뒤 교체 단말기 `DELIVERED`, 설치 확인 `status: CLOSED`
- 교체 단말기 이력 마지막 4줄: `ALLOCATED(ALLOCATION)` → `SHIPPED(SHIPMENT)` → `DELIVERED(BATCH, system:carrier-sync)` → `IN_SERVICE(SERVICE)`
- partners stats에 `seum.purchaseOrder: 1`, `seum.deliveryNote` 2 이상

출력을 devlog에 붙인다. 끝나면 `netstat -ano | grep -E ':(3000|4010) .*LISTENING'` 결과 없음을 확인하고, 로그 파일을 지운다(`rm smoke-api.log smoke-partners.log`).

- [ ] **Step 4: 개발 Redis의 주기 작업 정리**

Run: `npm run scheduler:clear`
Expected: `주기 작업 삭제(접두사 terminal-ops): carrier-sweep, outbox-relay`(이미 없으면 `없음`). 다음에 서버를 `RUN_SCHEDULERS=1`로 띄우면 다시 등록된다. Day 2 리뷰 Minor 2를 닫는다고 devlog에 적는다.

- [ ] **Step 5: 하루 요약과 공부거리 정리**

devlog 맨 아래에 `## 3일차 요약`을 쓴다(2일차 요약과 같은 항목).
- 만든 API: `POST /terminals/:serialNo/allocation-cancellations`, `POST/GET /purchase-orders`, `GET /purchase-orders/:poNo/reconciliation`, `POST /purchase-orders/:poNo/close`, `POST /scans`, `GET /scans/:scanId`, `POST /terminals/imports`, `POST/GET /service-tickets`, `POST /service-tickets/:id/{remote-checks,replacements,installations}`, 세움전자 `POST /seum/v1/purchase-orders`, `GET /seum/v1/purchase-orders/:poNo/delivery-note`, 스크립트 `npm run scheduler:clear`
- 테스트 수: api 170, partners 39(실제 값)
- 커밋 목록(`git log --oneline master..`)
- 실험 0006·0007 결론 한 줄씩(잰 숫자로)
- 락 관련 발견: 부모 행 먼저 잠금(발주·단말기), 여러 행 순서, JSON_TABLE collation(troubleshooting/0008)
- 계획과 달라진 점, 남은 문제(스펙 9장 + 새로 생긴 것)
- 내일(Day 4) 시작 전에 필요한 것

`docs/study/backlog.md`의 중복 항목을 합친다. 설계안 `../01_B_단말기생애주기_설계안.md` 8장 Day 3 행 끝에 `✅ 완료(커밋 범위)`를 표시한다(저장소 밖이라 커밋하지 않는다).

- [ ] **Step 6: 커밋**

```bash
git add docs
git commit -m "docs: 3일차 마감 기록" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-Review 결과

- 브리프 0(이월):
  - 출처 ALLOCATION·SHIPMENT·SCAN·IMPORT·SERVICE, 규칙(배정·배정 취소 ALLOCATION, 출고 SHIPMENT, RETURNING→RETURNED MANUAL·SCAN, IN_SERVICE→RETURN_REQUESTED MANUAL·SERVICE), 등록 출처 IMPORT·SCAN → Task 1(규칙), Task 4·5·6(등록 출처) / decisions/0017
  - 배정 취소 엔드포인트(mutate로 merchant=null) → Task 1
  - SUPERSEDED + applyDelivered IN_TRANSIT만 → Task 1 / decisions/0018
  - scheduler:clear(removeJobScheduler), Retry-After 60초, worker ready 누적, down() 주석 → Task 1
  - 일반 API로 ALLOCATED·SHIPPED를 만들던 기존 테스트 수정 → Task 1(terminal-concurrency A·B. transition.e2e는 결과가 같아 유지, 이유 적음)
  - 네이티브 enum ALTER와 down() 대문자 수정 → Task 1 Step 8
- 브리프 1(세움전자): 발주·명세, shortfall·foreignSerials(시드 난수 자리), stats 호출 수 → Task 2
- 브리프 2: PurchaseOrder + 발주 API(공장 호출 트랜잭션 밖) → Task 3. 일괄 등록 엔진(조회 1번에 기존 시리얼, 행별 결과, 한 트랜잭션, recordRegistration + outbox) → Task 4. 박스 스캔 RECEIVE·RETURN_IN, Redis SET NX + ScanBatch, 명세 밖 거절(결정), 부분 실패 정책·낙관적 락 충돌 정책(결정) → Task 5 / decisions/0019·0020·0021. 엑셀(exceljs, FileInterceptor 메모리·제한) → Task 6 / decisions/0022. 대조 리포트(DB 집계)와 마감 → Task 7
- 브리프 3(A/S): ServiceTicket, 접수(IN_SERVICE만), 원격 점검 → Task 8. 교체 출고(운송장 밖, 두 단말기 id 순 잠금, 한 트랜잭션, 전부 롤백), 설치 확인, 고장 단말기 회수(RETURN_IN 스캔) → Task 9 / decisions/0023. 실험 0007 → Task 11
- 브리프 4(실험 0006): 500 박스 쿼리 수·시간(N+1 대 일괄), 엑셀 1,000행, outbox 1,000 relay addBulk 결정 → Task 10 / decisions/0024. 모두 `EXPERIMENTS=1`
- 진행: 브랜치 day3-ops-workflows, devlog 새 파일(`# Day 3`, 2일차 요약 링크) → Task 1. 기록 번호 decisions 0017~0024, troubleshooting 0008, experiments 0006·0007. 안전 규칙 → 맨 위 절. 교훈(부모 UPDATE/잠금 먼저, relay RC 유지, 정렬된 순서, 외부 호출 밖) → 스펙 5.7, Task 5·8·9
- 브리프와 다르게 한 것: "범위 조정" 절에 이유와 함께 적었다(교체 단말기 출처, DELIVERED→IN_SERVICE 규칙 추가, purchase_order_id, requestHash, BusinessError, 세움 error5xxRate·수량 상한, closed_by, unique 재시도, 엑셀 제한, addBulk 비교 옵션, 0007 변형 하나).
- 플레이스홀더 점검: 모든 코드 단계에 전체 코드가 있다(사전 검증 저장소의 Task별 상태에서 그대로 가져왔다). 마이그레이션 파일 이름(`Migration<시각>`)과 기록 파일의 잰 숫자만 실행해서 채운다(숫자는 잰 값만 쓰는 규칙).
- 타입·이름 일관성:
  - `TransitionSource.{ALLOCATION,SHIPMENT,SCAN,IMPORT,SERVICE}`, `checkTransition`, `TransitionCheck`
  - `TransitionService.transition(cmd, em?)`, `recordRegistration(terminal, actor, source, em, reason?)`, `transitionMany(tx, BulkTransitionItem[], { actor, source })`
  - `ShipmentService.recordShipment(tx, terminal, carrier, trackingNo)`, `ShipmentStatus.SUPERSEDED`
  - `SERIAL_NO_PATTERN`, `SERIAL_NO_MESSAGE`, `RowResult`, `RowResultCode`, `precheckSerials`, `summarize`
  - `BulkRegistrationService.register(rows, ctx)`, `registerMany(tx, rows, ctx)`, `BulkRegisterRow`, `BulkRegisterContext { actor, source, reason?, assign? }`, `retryOnUniqueViolation(fn, attempts=2)`
  - `PurchaseOrderService.create/get/ensureDeliveryNote/reconcile/close`, `SeumClient.createPurchaseOrder/getDeliveryNote`, `PurchaseOrderStatus`
  - `ScanService.scan/get`, `ScanLock.acquire/release/keyOf`, `ScanBatch`, `ScanKind`, `requestHashOf`, `CreateScanDto`
  - `readImportRows`, `TerminalImportService.import`, `UploadedSpreadsheet`, `MAX_IMPORT_ROWS`
  - `ServiceTicketService.open/remoteCheck/get/lockOpen`, `TICKET_POPULATE`, `OPEN_TICKET_STATUSES`, `ReplacementService.replace(id, cmd, actor, { lockOrder })`, `install`, `LockOrder = 'id-asc' | 'faulty-first'`
  - `OutboxService.relay(limit, { enqueue: 'bulk' | 'each' })`
  - `BusinessError(status, code, message)` — codes: SCAN_IN_PROGRESS, SCAN_ID_REUSED, PO_CLOSED, PO_ALREADY_CLOSED, TERMINAL_NOT_IN_SERVICE, TICKET_ALREADY_OPEN, TICKET_NOT_OPEN, REPLACEMENT_NOT_IN_STOCK, MODEL_MISMATCH
  - `JOB_SCHEDULERS`, `clearJobSchedulers(queueOf)`, `MAX_RETRY_AFTER_MS`, `env.scanLockTtlMs`
  - 테스트 헬퍼: `captureQueries(orm)` → `{ queries, selects, stop }`, `orderPurchase`, `transitionTo`, `prepareInService`, `partners.deliveryNote`
- 사전 검증: Task 1~11을 이 순서로 적용해 Task마다 typecheck·테스트 통과를 확인했다(127 → 132 → 141 → 148 → 154 → 159 → 165 → 169 → 170, partners 39). 스캔·대조·교체 테스트는 3회 반복해 같은 결과. 실험 2개를 끝까지 한 번씩, 빈 테스트 DB 마이그레이션 체인과 enum down/up 왕복, 실서버 흐름(테스트 DB·포트 3100/4110)을 확인했다(숫자는 적지 않는다). Day 2 실험 0005(two-workers)도 바꾼 뒤 한 번 돌려 통과를 봤다.
