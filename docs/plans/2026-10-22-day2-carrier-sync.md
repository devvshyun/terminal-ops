# Day 2 — 택배사 연동·택배 추적 자동 수집·알림 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **기록 규칙 필수**: 이 저장소의 `CLAUDE.md`를 먼저 읽는다. 모든 Task는 마지막에 `docs/devlog/2026-10-22.md`에 항목을 덧붙이고(Day 1 항목과 같은 형식: 제목 시각 = 커밋 시각, `이전 Task 커밋:`, 한 일·확인·막힌 것·결정·다음), Task에 적힌 결정·트러블슈팅·실험 기록을 쓴 뒤 **코드와 같은 커밋**에 넣는다. 예상과 다른 에러를 만나면 고치기 전에 `docs/troubleshooting/`에 기록을 시작한다(다음 번호 0005부터, 이 계획이 0005를 Task 1에 예약했으므로 새로 생기면 0006부터).

**Goal:** 가상 업체 서버(번개택배·느림보물류·톡톡메신저)를 만들고, 택배사 어댑터(F12)로 출고한 단말기의 운송장을 BullMQ 워커가 주기적으로 조회해 배송 완료 시 자동으로 DELIVERED로 바꾸며(F3), 모든 상태 변경을 Outbox로 메신저에 알린다(F5). 중복 이벤트·429·워커 2개 상황에서 중복 반영이 없다는 것을 실험으로 남긴다.

**Architecture:** `apps/partners`는 의존성이 거의 없는 `node:http` 서버(메모리 상태, 시드 난수)다. `apps/api`에는 가맹점·배정·출고(Shipment)를 최소로 추가하고, 택배사 호출은 어댑터 뒤로 숨긴다(파싱은 순수 함수). 수집은 BullMQ 큐 4개(`carrier-sweep`, `track-bungae`, `track-neurimbo`, `outbox`)로 돈다. 상태 변경은 여전히 `TransitionService` 한 곳에서만 하고, 같은 트랜잭션에 Outbox 행을 남긴다. "부모 UPDATE 먼저, 자식 INSERT 나중" 규칙(troubleshooting/0004, decisions/0006)을 출고·배송 완료에도 지킨다. 설계 스펙: `docs/specs/2026-10-22-day2-carrier-sync.md`.

**Tech Stack:** Node 24, TypeScript 6.0, Nest.js 12.2 (ESM), MikroORM 7.2, BullMQ 6.4.0 + ioredis 5.11.1 + @nestjs/bullmq 12.0.0, fast-xml-parser 5.11.2, Redis 7.4, MySQL 8.4, Vitest 5 + unplugin-swc, supertest

---

## 사전 검증으로 확인된 사실 (2026-10-22, 임시 폴더 스파이크)

계획 작성 전에 임시 폴더에 저장소를 복사해 이 계획의 코드를 Task 순서대로 적용하고, Task마다 `tsc --noEmit`과 vitest를 돌려 통과를 확인했다(테스트 DB `terminal_ops_test`, Redis 접두사는 테스트 전용). 이 계획의 코드는 아래 사실을 전제로 한다.

- 테스트 수(누적): Day 1 끝 56 → Task 1 66 → Task 4 82 → Task 5 88 → Task 6 95 → Task 7 102 → Task 8 108. partners는 Task 2 14 → Task 3 26.
- **BullMQ 커스텀 jobId에는 `:`를 쓸 수 없다.** `queue.add(name, data, { jobId: 'track:1' })`는 `Custom Id cannot contain :` 에러를 던진다(`bullmq/dist/esm/classes/job.js` 913~915행, 실제 실행으로 확인). 그래서 jobId는 `track-<shipmentId>`, `outbox-<outboxId>`로 쓴다. 정수만으로 된 문자열도 안 된다(`Custom Id cannot be integers`).
- 같은 jobId의 job이 대기·처리·재시도 대기 중이거나 **완료 후 남아 있으면** 새 `add`는 무시된다. 반복 수집에는 `removeOnComplete: true`, `removeOnFail: true`가 필요하다.
- `@Processor(name, { limiter, concurrency, settings: { backoffStrategy } })`로 커스텀 백오프를 등록할 수 있다. `backoff: { type: 'carrier' }`처럼 내장(fixed·exponential)이 아닌 type을 쓰면 이 함수가 `(attemptsMade, type, err, job)`로 불리고, **던진 에러 객체를 그대로 받는다** → 429의 Retry-After를 존중할 수 있다(확인: Retry-After 300ms → 다음 시도 약 344ms 뒤).
- `UnrecoverableError`를 던지면 `attempts`가 남아 있어도 재시도하지 않는다(확인). `failed` 이벤트는 재시도 전 실패마다 한 번씩 나온다. 프로세서 안의 `job.attemptsMade`는 이번 시도 전까지 실패한 횟수다(첫 시도 0).
- `@nestjs/bullmq`는 워커를 `onApplicationShutdown`에서 닫는다(`bull.explorer.js`). 워커는 `BullModule.forRoot`의 `connection`·`prefix`를 그대로 쓴다.
- `queue.upsertJobScheduler(id, { every }, { name, data, opts })` 동작 확인. `opts`는 `jobId`·`repeat`·`delay`를 뺀 JobsOptions. BullMQ 6에는 `repeat` 옵션이 없다.
- MikroORM 7: `tx.find(Entity, where, { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, limit, orderBy })` → `... for update skip locked`(쿼리 로그로 확인). 두 트랜잭션이 동시에 `limit 1`로 잡으면 서로 다른 행을 받는다(확인). 트랜잭션 안에서만 쓸 수 있다.
- `em.insert(Entity, data)`는 Unit of Work를 거치지 않는 단건 INSERT다. unique 위반이면 `UniqueConstraintViolationException`이 나고 em은 그대로 쓸 수 있다. 클래스 필드 기본값이 적용되지 않으므로 `receivedAt` 같은 필드는 직접 넣는다. 관계 필드에는 PK 숫자를 넣어도 타입 검사를 통과한다.
- `@Property({ type: 'json' })` 왕복(한글 포함) 확인.
- **`Date | null` 같은 유니온 타입 속성은 데코레이터 메타데이터가 `Object`가 되어 MikroORM이 `varchar(255)` 컬럼을 만든다.** nullable 날짜는 `@Property({ type: 'datetime', nullable: true })`로 적는다(마이그레이션을 만들어 보고 확인). Day 1의 `note?: string | null`은 우연히 varchar라 문제가 없었다.
- `db:migration:create`로 enum을 바꾸면 **down()이 소문자 enum으로 생성된다**(`modify source enum('manual','inspection')`). 스냅샷의 `type` 문자열이 소문자로 저장돼 있어서다. up()은 정상. Task 1에서 down()을 손으로 고친다.
- `orm.schema.refresh()`는 현재 엔티티에 있는 테이블만 다시 만든다. 엔티티에 없는 테이블(다른 브랜치·나중 Task의 테이블)이 FK로 `terminal`을 참조하고 있으면 refresh가 실패한다. 브랜치를 오가다 테스트가 `beforeAll`에서 실패하면 테스트 DB를 지우고 다시 만든다(아래 명령).
  ```bash
  MSYS_NO_PATHCONV=1 docker exec terminal-ops-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "drop database terminal_ops_test; create database terminal_ops_test character set utf8mb4 collate utf8mb4_0900_ai_ci; grant all privileges on terminal_ops_test.* to '"'"'terminal_ops'"'"'@'"'"'%'"'"';"'
  ```
- supertest: `t.http().post(...).send({ v: await other() })`처럼 **요청 체인을 만든 뒤 그 인자 안에서 다른 요청을 await하면** 같은 http 서버를 두 번 listen/close해서 `Cannot read properties of null (reading 'address')`로 깨진다. 값을 먼저 구하고 요청을 만든다.
- vitest는 테스트 파일마다 워커 프로세스를 새로 띄운다(로그: `11 workers spawned`). 그래서 `env.ts`의 테스트 큐 접두사(`test-<pid>-<시각>`)가 파일마다 다르다. `test.env` 값은 `process.loadEnvFile`보다 우선한다(이미 있는 환경변수는 덮어쓰지 않음, 확인).
- vitest `globalSetup`은 default export(teardown 함수를 돌려줌)를 지원한다. partners를 `process.execPath`로 띄우고 `/__admin/health`를 폴링해 기다리는 방식으로 확인했다(Windows에서 `npm.cmd`를 거치지 않는다).
- fast-xml-parser 5: `new XMLParser({ parseTagValue: false, ignoreDeclaration: true, isArray: (name) => name === 'item' })` → 값은 문자열 그대로, item 하나여도 배열. `new XMLBuilder({}).build({ trace: { item: [...] } })` → `<item>` 반복.
- Git Bash의 `curl -d '{"reason":"재고 편입"}'`은 한글이 깨져 저장됐다(실서버 확인 때 관찰). 수동 확인에서는 사유를 영문으로 쓴다.
- 이 PC에서 npm install은 수 초 걸린다.

## 범위 조정

- 브리프의 오류 클래스 이름 `CarrierRateLimitedError`/`CarrierTransientError`/`CarrierPermanentError`는 **`PartnerRateLimitedError`/`PartnerTransientError`/`PartnerPermanentError`**(`src/common/partner-errors.ts`)로 바꾼다. 톡톡메신저 클라이언트도 같은 HTTP 헬퍼(`partnerFetch`)와 같은 분류를 쓰기 때문이다.
- `SyncRun.error`는 `detail`로 바꾸고 `attempt`, `worker`, `outcome` 컬럼을 더한다. NOOP·SKIPPED인 이유도 같은 칸에 남기고, 실험에서 재시도 수·워커별 처리 수를 SQL 없이 세기 위해서다.
- 워커 2개 실험(0005)은 `load/` 스크립트가 아니라 `apps/api/test/experiments/two-workers.spec.ts`(EXPERIMENTS=1에서만)로 만든다. 테스트 헬퍼(DB 초기화, 시나리오 준비, partners 관리 API)를 그대로 쓸 수 있다.
- 출고 API 동시 요청 테스트에서 고아 운송장이 생기는 것을 테스트로 보여 준다(알려진 한계, decisions/0012). 고아 운송장 취소는 하지 않는다.
- 하지 않는 것(스펙 10장): 일반 전이 API로 ALLOCATED·SHIPPED를 가맹점·운송장 없이 만드는 길 막기, 배정 취소 때 가맹점 비우기, QUEUED로 멈춘 outbox 복구, HTTP 경로의 데드락 매핑, Day 1 리뷰 Minor 2·4·5·6·7.

## 파일 구조

```
terminal-ops/
├─ .env.example                         Day 2 환경변수 추가
├─ apps/partners/                       (새로) 가상 업체 서버
│  ├─ package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts
│  ├─ src/rng.ts                        시드 난수(mulberry32)
│  ├─ src/state.ts                      설정·통계·메모리 상태
│  ├─ src/http.ts                       본문 읽기, JSON/XML 응답
│  ├─ src/bungae.ts                     번개택배(JSON)
│  ├─ src/neurimbo.ts                   느림보물류(XML)
│  ├─ src/toktok.ts                     톡톡메신저 웹훅
│  ├─ src/server.ts                     라우팅 + 관리 API
│  ├─ src/main.ts                       PARTNERS_PORT(기본 4010)로 listen
│  └─ test/helpers.ts, bungae.spec.ts, neurimbo.spec.ts, toktok.spec.ts
└─ apps/api/
   ├─ package.json                      bullmq, ioredis, @nestjs/bullmq, fast-xml-parser, start:worker
   ├─ vitest.config.ts                  globalSetup, PARTNERS_URL, 실험 분리
   ├─ src/
   │  ├─ config/env.ts                  partners·Redis·실행 모드·주기 설정
   │  ├─ app.module.ts                  AppModule.forRoot({ workers, schedulers })
   │  ├─ main.ts, worker.ts             HTTP 진입점, 워커 전용 진입점
   │  ├─ common/partner-errors.ts       외부 업체 오류 3분류
   │  ├─ common/partner-http.ts         fetch + 타임아웃 + 분류, Retry-After
   │  ├─ common/domain-exception.filter.ts  PartnerError → 502
   │  ├─ terminal/                      BATCH 출처, recordRegistration, mutate, outbox 기록, merchant
   │  ├─ merchant/                      Merchant, 배정 API
   │  ├─ carrier/                       carrier.types, 파서 2개, 어댑터, CarrierModule
   │  ├─ shipment/                      Shipment·CarrierEvent·SyncRun, 출고 API
   │  ├─ queue/                         큐 이름, QueuesModule(전역)
   │  ├─ carrier-sync/                  sweep·track, 재시도 정책, 프로세서
   │  ├─ outbox/                        OutboxEvent, relay·notify, 톡톡 클라이언트, 프로세서
   │  ├─ workers/workers.module.ts      프로세서 모음
   │  └─ scheduler/                     job scheduler 등록
   └─ test/
      ├─ global-setup.ts                partners 빌드·실행, 테스트 Redis 키 정리
      ├─ helpers/partners.ts, scenario.ts, queues.ts, experiment.ts, test-app.ts
      ├─ fixtures/                      번개 JSON, 느림보 XML
      ├─ unit/carrier-parsers.spec.ts
      ├─ carrier-adapters.e2e.spec.ts, merchant.e2e.spec.ts, shipment.e2e.spec.ts
      ├─ carrier-sync.e2e.spec.ts, outbox.e2e.spec.ts
      └─ experiments/                   carrier-duplicates, carrier-429, two-workers (EXPERIMENTS=1)
```

명령은 별도 표시가 없으면 `terminal-ops/apps/api`에서 실행한다. partners 명령은 `terminal-ops/apps/partners`에서 실행한다. Docker 명령이 PATH에 없으면 `"/c/Program Files/Docker/Docker/resources/bin/docker.exe"`를 쓴다. MySQL·Redis 컨테이너가 떠 있어야 한다(`docker compose ps`). Task 7부터는 **모든 API 테스트가 Redis를 쓴다**(큐 모듈이 기본 모듈에 들어간다).

기록 번호: decisions 0007~0016, troubleshooting 0005(Task 1 예약), experiments 0003~0005.

---

### Task 1: Day 1 이월 — BATCH 출처, 기본 허용 출처 축소, 등록 이력 일원화, 사유 공백 검증

**Files:**
- Modify: `apps/api/src/terminal/terminal-status.ts`, `apps/api/src/terminal/transition-rules.ts`, `apps/api/src/terminal/transition.service.ts`, `apps/api/src/terminal/terminal.service.ts`, `apps/api/src/terminal/dto/transition.dto.ts`
- Test: `apps/api/test/unit/transition-rules.spec.ts`, `apps/api/test/terminal.e2e.spec.ts`, `apps/api/test/transition.e2e.spec.ts`
- Create: `apps/api/src/migrations/Migration<시각>.ts` (생성 명령으로)
- Record: `docs/decisions/0007-전이-출처-BATCH와-기본-허용-출처.md`, `docs/decisions/0008-등록-이력도-전이-서비스가-남긴다.md`, `docs/decisions/0003-전이-규칙은-TS-표로.md`(갱신 한 줄), `docs/troubleshooting/0005-enum-마이그레이션-down-소문자.md`, devlog

- [ ] **Step 1: 실패하는 테스트 작성 (단위 + e2e)**

`apps/api/test/unit/transition-rules.spec.ts` 전체를 다음으로 바꾼다(Day 1 케이스 + 배치 케이스):
```ts
import { describe, expect, it } from 'vitest';
import { checkTransition } from '../../src/terminal/transition-rules.js';
import { TerminalStatus as S, TransitionSource as Src } from '../../src/terminal/terminal-status.js';

const normal = { requiresReinspection: false };
const strict = { requiresReinspection: true };

describe('checkTransition', () => {
  it.each([
    [S.INSPECTED, S.IN_STOCK],
    [S.IN_STOCK, S.ALLOCATED],
    [S.ALLOCATED, S.IN_STOCK],
    [S.ALLOCATED, S.SHIPPED],
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

  it('배송 완료는 수동과 배치 둘 다 가능', () => {
    expect(checkTransition(S.SHIPPED, S.DELIVERED, Src.MANUAL, normal)).toEqual({ ok: true });
    expect(checkTransition(S.SHIPPED, S.DELIVERED, Src.BATCH, normal)).toEqual({ ok: true });
  });

  it.each([
    [S.INSPECTED, S.IN_STOCK],
    [S.IN_STOCK, S.ALLOCATED],
    [S.ALLOCATED, S.SHIPPED],
    [S.DELIVERED, S.IN_SERVICE],
    [S.RETURNED, S.IN_STOCK],
    [S.DEFECTIVE, S.DISPOSED],
  ])('배치는 일반 전이 %s → %s 를 할 수 없다', (from, to) => {
    const r = checkTransition(from, to, Src.BATCH, normal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('MANUAL 경로로만');
  });

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

`apps/api/test/terminal.e2e.spec.ts` 전체를 다음으로 바꾼다("등록 이력도 전이 서비스가 남긴다" 추가. 시리얼 `REG-0001`은 뒤의 `q: 'T-000'` 검색 개수에 끼지 않게 고른 것):
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TransitionService } from '../src/terminal/transition.service.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'kim' };

describe('단말기 등록·조회 (F1)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('등록하면 RECEIVED, version 1로 만들어진다', async () => {
    const res = await t.http().post('/terminals').set(OP).send({ serialNo: 'T-0001', modelCode: 'SN-100' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ serialNo: 'T-0001', modelCode: 'SN-100', status: 'RECEIVED', version: 1 });
  });

  it('등록 이력이 작업자와 함께 남는다', async () => {
    const res = await t.http().get('/terminals/T-0001/history');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: 'RECEIVED', source: 'MANUAL', actor: 'kim', reason: '신규 등록' }),
    ]);
  });

  it('등록 이력도 전이 서비스가 남긴다(상태 변경 경로 일원화)', async () => {
    const spy = vi.spyOn(TransitionService.prototype, 'recordRegistration');
    try {
      const res = await t.http().post('/terminals').set(OP).send({ serialNo: 'REG-0001', modelCode: 'SN-100' });
      expect(res.status).toBe(201);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('한글 작업자 이름은 URL 인코딩해서 보낸다', async () => {
    const res = await t
      .http()
      .post('/terminals')
      .set({ 'X-Operator': encodeURIComponent('김운영') })
      .send({ serialNo: 'T-0002', modelCode: 'SN-200' });
    expect(res.status).toBe(201);
    const history = await t.http().get('/terminals/T-0002/history');
    expect(history.body[0].actor).toBe('김운영');
  });

  it('X-Operator가 없으면 400', async () => {
    const res = await t.http().post('/terminals').send({ serialNo: 'T-0003', modelCode: 'SN-100' });
    expect(res.status).toBe(400);
  });

  it('system: 으로 시작하는 작업자는 사람이 쓸 수 없다', async () => {
    const res = await t.http().post('/terminals').set({ 'X-Operator': 'system:batch' }).send({ serialNo: 'T-0003', modelCode: 'SN-100' });
    expect(res.status).toBe(400);
  });

  it('같은 시리얼을 다시 등록하면 409 DUPLICATE', async () => {
    const res = await t.http().post('/terminals').set(OP).send({ serialNo: 'T-0001', modelCode: 'SN-100' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE');
  });

  it('없는 모델이면 404', async () => {
    const res = await t.http().post('/terminals').set(OP).send({ serialNo: 'T-0009', modelCode: 'SN-999' });
    expect(res.status).toBe(404);
  });

  it('시리얼 형식이 틀리면 400', async () => {
    const res = await t.http().post('/terminals').set(OP).send({ serialNo: 'bad serial', modelCode: 'SN-100' });
    expect(res.status).toBe(400);
  });

  it('상태·모델·시리얼 앞부분으로 검색하고 페이지를 나눈다', async () => {
    const byModel = await t.http().get('/terminals').query({ modelCode: 'SN-200' });
    expect(byModel.body.total).toBe(1);
    expect(byModel.body.items[0].serialNo).toBe('T-0002');

    const byPrefix = await t.http().get('/terminals').query({ q: 'T-000', size: 1, page: 2 });
    expect(byPrefix.body).toMatchObject({ total: 2, page: 2, size: 1 });
    expect(byPrefix.body.items).toHaveLength(1);

    const byStatus = await t.http().get('/terminals').query({ status: 'IN_STOCK' });
    expect(byStatus.body.total).toBe(0);
  });

  it('검색어의 % 는 와일드카드로 쓰이지 않는다', async () => {
    const res = await t.http().get('/terminals').query({ q: '%' });
    expect(res.body.total).toBe(0);
  });

  it('단건 조회, 없으면 404', async () => {
    expect((await t.http().get('/terminals/T-0001')).body.serialNo).toBe('T-0001');
    expect((await t.http().get('/terminals/NOPE-1')).status).toBe(404);
  });
});
```

`apps/api/test/transition.e2e.spec.ts` 전체를 다음으로 바꾼다("reason이 공백뿐이면 400" 추가):
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

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/unit/transition-rules.spec.ts test/terminal.e2e.spec.ts test/transition.e2e.spec.ts`
Expected: FAIL
- 단위: `배송 완료는 수동과 배치 둘 다 가능` 실패(`Src.BATCH`가 아직 `undefined`라 어떤 규칙에도 허용되지 않음). `배치는 일반 전이 … 를 할 수 없다` 6건과 `검수 전용 전이는 배치로도 안 된다`는 지금도 통과할 수 있다(같은 이유). 이 7건은 enum에 BATCH를 넣고 기본값을 좁히지 않았을 때 실패하는 회귀 방지용이다.
- `등록 이력도 전이 서비스가 남긴다` 실패(`recordRegistration`이 없다는 spyOn 오류)
- `reason이 공백뿐이면 400` 실패(`expected 200 to be 400`)

- [ ] **Step 3: 출처 enum과 전이 규칙**

`apps/api/src/terminal/terminal-status.ts`:
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
}
```

`apps/api/src/terminal/transition-rules.ts`:
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
  { from: S.IN_STOCK, to: S.ALLOCATED },
  { from: S.ALLOCATED, to: S.IN_STOCK },
  { from: S.ALLOCATED, to: S.SHIPPED },
  // 배송 완료는 택배 추적 수집(BATCH)이 자동으로, 또는 운영자가 수동으로 바꾼다.
  { from: S.SHIPPED, to: S.DELIVERED, only: [TransitionSource.MANUAL, TransitionSource.BATCH] },
  { from: S.DELIVERED, to: S.IN_SERVICE },
  { from: S.IN_SERVICE, to: S.RETURN_REQUESTED },
  { from: S.RETURN_REQUESTED, to: S.RETURNING },
  { from: S.RETURNING, to: S.RETURNED },
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

- [ ] **Step 4: 등록 이력을 전이 서비스로, 사유 공백 검증**

`apps/api/src/terminal/transition.service.ts`:
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { InvalidTransitionError } from '../common/domain-errors.js';
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
      const terminal = await tx.findOne(Terminal, { serialNo: cmd.serialNo }, { populate: ['model'] });
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
      return terminal;
    });
  }

  /**
   * 새로 만든 단말기의 첫 이력(null → 현재 상태)을 남긴다. 등록 트랜잭션 안에서 부른다(decisions/0008).
   * 단말기 INSERT와 이력 INSERT가 같은 트랜잭션이고 부모 행은 이 트랜잭션이 막 만든 행이라 S→X 승격이 생기지 않는다.
   */
  recordRegistration(terminal: Terminal, actor: string, source: TransitionSource, em: EntityManager): TerminalStatusHistory {
    return em.create(TerminalStatusHistory, {
      terminal,
      fromStatus: null,
      toStatus: terminal.status,
      source,
      actor,
      reason: '신규 등록',
    });
  }

}
```

`apps/api/src/terminal/terminal.service.ts`:
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { RegisterTerminalDto } from './dto/register-terminal.dto.js';
import type { ListTerminalsQuery } from './dto/list-terminals.query.js';
import { TerminalModel } from './terminal-model.entity.js';
import { Terminal } from './terminal.entity.js';
import { TerminalStatusHistory } from './terminal-status-history.entity.js';
import { TransitionSource } from './terminal-status.js';
import { TransitionService } from './transition.service.js';

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class TerminalService {
  constructor(
    private readonly em: EntityManager,
    private readonly transitions: TransitionService,
  ) {}

  /** 단말기와 첫 이력(RECEIVED)을 한 트랜잭션으로 만든다. 이력은 전이 서비스가 남긴다(decisions/0008). */
  async register(dto: RegisterTerminalDto, actor: string): Promise<Terminal> {
    return this.em.transactional(async (tx) => {
      const model = await tx.findOne(TerminalModel, { code: dto.modelCode });
      if (!model) throw new NotFoundException(`단말기 모델 ${dto.modelCode}이(가) 없습니다.`);
      const terminal = tx.create(Terminal, { serialNo: dto.serialNo, model });
      this.transitions.recordRegistration(terminal, actor, TransitionSource.MANUAL, tx);
      return terminal;
    });
  }

  async list(query: ListTerminalsQuery) {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.modelCode ? { model: { code: query.modelCode } } : {}),
      ...(query.q ? { serialNo: { $like: `${escapeLike(query.q)}%` } } : {}),
    };
    const [items, total] = await this.em.findAndCount(Terminal, where, {
      populate: ['model'],
      orderBy: { id: 'desc' },
      limit: query.size,
      offset: (query.page - 1) * query.size,
    });
    return { items, total, page: query.page, size: query.size };
  }

  async getBySerial(serialNo: string): Promise<Terminal> {
    const terminal = await this.em.findOne(Terminal, { serialNo }, { populate: ['model'] });
    if (!terminal) throw new NotFoundException(`단말기 ${serialNo}이(가) 없습니다.`);
    return terminal;
  }

  async history(serialNo: string): Promise<TerminalStatusHistory[]> {
    const terminal = await this.getBySerial(serialNo);
    return this.em.find(TerminalStatusHistory, { terminal }, { orderBy: { id: 'asc' } });
  }
}
```

`apps/api/src/terminal/dto/transition.dto.ts`:
```ts
import { IsEnum, IsInt, IsString, Length, Matches, Min } from 'class-validator';
import { TerminalStatus } from '../terminal-status.js';

export class TransitionDto {
  @IsEnum(TerminalStatus)
  to!: TerminalStatus;

  @IsString()
  @Length(1, 200)
  @Matches(/\S/, { message: 'reason은 공백만으로 쓸 수 없습니다.' })
  reason!: string;

  /** 화면에서 본 version. 그 사이 다른 변경이 있었으면 409 (decisions/0004) */
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run && npm run typecheck`
Expected: 8개 파일 `66 passed`, typecheck exit 0

- [ ] **Step 6: enum ALTER 마이그레이션**

Run: `npm run db:migration:create`
Expected: `생성: Migration<시각>.ts`. 생성된 파일의 up()은 다음 한 줄이어야 한다.
```ts
    this.addSql(`alter table \`terminal_status_history\` modify \`source\` enum('MANUAL','INSPECTION','BATCH') not null;`);
```
down()이 `enum('manual','inspection')`처럼 **소문자**로 생성됐으면(사전 검증에서 그랬다) 다음으로 고친다. 소문자 enum으로 되돌리면 기존 값 `MANUAL`이 `manual`로 읽혀 앱의 enum 비교가 깨진다.
```ts
  override down(): void | Promise<void> {
    this.addSql(`alter table \`terminal_status_history\` modify \`source\` enum('MANUAL','INSPECTION') not null;`);
  }
```
그리고 적용·확인:
```bash
npm run db:migrate
npm run db:migration:check
```
Expected: `적용: Migration<시각>`, `최신 상태`

- [ ] **Step 7: 기록과 커밋**

`docs/decisions/0007-전이-출처-BATCH와-기본-허용-출처.md`:
- 상황: 택배 추적 수집이 SHIPPED → DELIVERED를 시스템이 바꾼다. 이력에서 사람이 바꾼 것과 구분해야 한다. decisions/0003 주의 사항대로, `only`가 없는 규칙은 INSPECTION을 뺀 모든 출처를 허용해서 BATCH를 추가하면 배치가 모든 일반 전이를 할 수 있게 된다.
- 선택지:
  1. BATCH만 추가하고 기본값은 그대로: 변경이 가장 작다. 배치가 배정·폐기까지 할 수 있게 된다.
  2. BATCH 추가 + `only` 없는 규칙의 기본 허용 출처를 `[MANUAL]`로 좁히고, 배치가 해야 하는 전이(SHIPPED → DELIVERED)에만 `only: [MANUAL, BATCH]`: 출처를 추가해도 허용 범위가 저절로 넓어지지 않는다.
  3. 배치 전용 상태 전이 함수를 따로: 규칙이 두 곳으로 나뉜다(decisions/0003 위반).
- 결정: 2. 단위 테스트에 "배치는 일반 전이를 할 수 없다" 6건을 넣었다.
- 결과·대가: 새 출처(SCAN, IMPORT 등)를 추가할 때마다 그 출처가 할 전이에 `only`를 적어야 한다. 네이티브 enum이라 출처 추가마다 ALTER 마이그레이션이 필요하다.
- 다시 볼 조건: 출처가 5개를 넘으면 규칙 표를 출처별 허용 목록으로 뒤집는 것을 검토한다.

`docs/decisions/0008-등록-이력도-전이-서비스가-남긴다.md`:
- 상황: Day 1 최종 리뷰 Important #1. `TerminalService.register`가 첫 이력(null → RECEIVED)을 직접 만들어 "상태 변경 기록은 전이 서비스 한 곳" 원칙의 예외였다. Day 2에서 Outbox(알림) 기록도 이력과 같은 자리에 붙어야 한다.
- 선택지:
  1. 예외임을 문서로만 남긴다: 코드 변경 없음. Outbox를 붙일 때 두 곳을 고쳐야 한다.
  2. `TransitionService.recordRegistration(terminal, actor, source, em)`을 두고 등록 트랜잭션에서 부른다: 이력·알림 기록이 한 클래스에 모인다.
  3. 등록도 `transition()`으로(from null 허용): 규칙 표에 "없음 → RECEIVED"를 넣어야 하고, 아직 없는 행을 조회하는 흐름과 맞지 않는다.
- 결정: 2. 이유: 이력을 쓰는 코드가 한 곳이 되고, Task 8에서 Outbox 기록을 한 번에 붙일 수 있다.
- 결과·대가: 등록은 규칙 검사를 거치지 않는다(첫 상태는 엔티티 기본값 RECEIVED). 등록 트랜잭션의 INSERT 순서(단말기 → 이력)는 부모가 같은 트랜잭션이 막 만든 행이라 S→X 승격이 생기지 않는다.

`docs/decisions/0003-전이-규칙은-TS-표로.md` 맨 끝에 한 줄 덧붙인다:
```
- 갱신(2026-10-22 Day 2): BATCH 출처를 추가하면서 기본 허용 출처를 MANUAL로 좁혔다 → decisions/0007
```

`docs/troubleshooting/0005-enum-마이그레이션-down-소문자.md` (Step 6에서 down()이 소문자였을 때만. 아니었으면 devlog에 "소문자 아님"이라고 적고 이 파일은 만들지 않는다):
- 증상: 생성된 down()이 `modify \`source\` enum('manual','inspection')` (생성 파일 그대로 붙인다)
- 가설: 1) 엔티티 enum 값이 소문자 2) 마이그레이션 스냅샷이 소문자로 저장
- 확인: `src/migrations/.snapshot-terminal_ops.json`에서 `source` 컬럼의 `"type"`과 `"enumItems"`를 찾아 붙인다(사전 검증에서는 `type`이 소문자 문자열, `enumItems`는 대문자였다) → 가설 2
- 원인: down()은 스냅샷의 이전 컬럼 `type` 문자열로 만들어진다(추정: MikroORM 7.2.5 동작, 소스 미확인이면 "추정"이라고 쓴다).
- 해결: down()을 대문자로 직접 고쳤다. 앞으로 enum을 바꾸는 마이그레이션은 down()을 꼭 확인한다.

`docs/study/backlog.md`에 추가:
```
- [ ] MikroORM 마이그레이션 스냅샷과 down() 생성 방식 — enum down이 소문자로 나온 이유 (troubleshooting/0005)
- [ ] 출처별 허용 전이 — 기본 허용을 좁히는 방식(deny by default) (decisions/0007)
```

devlog: `docs/devlog/2026-10-22.md` 끝에 Day 2 구분선을 넣고 첫 항목을 쓴다.
```markdown

---

# Day 2

## HH:MM Task 1 Day 1 이월: BATCH 출처, 등록 이력 일원화, 사유 공백 검증 (F2)
이전 Task 커밋: (git log -1 --format=%h)
- 한 일: …
- 확인: 66 passed, typecheck exit 0, migration check 최신 상태
- 막힌 것: (enum down 소문자 여부)
- 결정: decisions/0007, 0008
- 다음: Task 2 partners 골격
```

커밋:
```bash
git add apps/api docs
git commit -m "feat(F2): 전이 출처 BATCH와 등록 이력 일원화" -m "Refs: docs/decisions/0007-전이-출처-BATCH와-기본-허용-출처.md, docs/decisions/0008-등록-이력도-전이-서비스가-남긴다.md"
```

---

### Task 2: 가상 업체 서버 골격 + 관리 API + 번개택배 (F12)

**Files:**
- Create: `apps/partners/package.json`, `apps/partners/tsconfig.json`, `apps/partners/tsconfig.build.json`, `apps/partners/vitest.config.ts`
- Create: `apps/partners/src/rng.ts`, `src/state.ts`, `src/http.ts`, `src/bungae.ts`, `src/server.ts`, `src/main.ts`
- Test: `apps/partners/test/helpers.ts`, `apps/partners/test/bungae.spec.ts`
- Record: `docs/decisions/0009-가상-업체-서버는-node-http-별도-프로세스.md`, devlog

번개택배 동작 요약: `POST /bungae/v1/waybills { receiverName, address, reference }` → 201 `{ trackingNo: 'BG…' }`. `GET /bungae/v1/trackings/:trackingNo`는 **성공한 조회마다 한 단계씩** 진행한다(`advancePerPoll` 기본 1 → 4번째 조회에 DELIVERED). 이벤트 시각은 발급 시각 + k분(가상 시간표). 골칫거리: `duplicateRate`(이벤트 사본 섞기), 최근 1초 성공 조회가 `rateLimitPerSec` 이상이면 429 + `Retry-After`, `force429Rate`(무조건 429 확률), `delayMs`. 429는 진행하지 않는다. 난수는 시드(`seed`, 기본 42)로 재현한다.

관리 API: `GET /__admin/health`, `POST /__admin/config`(섹션별 부분 병합), `POST /__admin/reset`(설정·상태·통계 전부 초기화), `GET /__admin/stats`(엔드포인트별·운송장별 호출 수, 429·5xx 수, 같은 운송장 겹침 수). 운송장 번호는 서버 시작(또는 reset) 시각 + 일련번호라서 서버를 다시 띄워도 이전 번호와 겹치지 않는다(개발 DB의 `tracking_no` unique와 충돌하지 않게).

- [ ] **Step 1: 패키지와 설정**

`apps/partners/package.json`:
```json
{
  "name": "@terminal-ops/partners",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "fast-xml-parser": "^5.11.2"
  },
  "devDependencies": {
    "@types/node": "^24.19.2",
    "typescript": "~6.0.2",
    "vitest": "^5.0.5"
  }
}
```

`apps/partners/tsconfig.json`:
```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2023",
    "strict": true,
    "sourceMap": true,
    "outDir": "dist",
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`apps/partners/tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src" },
  "include": ["src"]
}
```

`apps/partners/vitest.config.ts` (데코레이터가 없어 swc가 필요 없다. 테스트 파일마다 서버를 빈 포트에 따로 띄우므로 병렬 실행해도 된다):
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.spec.ts'] },
});
```

- [ ] **Step 2: 의존성 설치**

Run (`apps/partners`): `npm install`
Expected: `node_modules`, `package-lock.json` 생성. `npm ls --depth=0`에 `fast-xml-parser@5.11.x`, `typescript@6.0.x`, `vitest@5.0.x`, `@types/node@24.x`

- [ ] **Step 3: 실패하는 테스트 작성**

`apps/partners/test/helpers.ts`:
```ts
import type { AddressInfo } from 'node:net';
import { createPartnersServer } from '../src/server.js';
import type { ConfigPatch } from '../src/state.js';

/** 빈 포트에 서버를 띄운다. 테스트 파일마다 따로 띄우므로 서로 상태를 공유하지 않는다. */
export async function startPartners() {
  const { server, state } = createPartnersServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    state,
    configure: (patch: ConfigPatch) =>
      fetch(`${base}/__admin/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }),
    reset: () => fetch(`${base}/__admin/reset`, { method: 'POST' }),
    stats: async () => (await fetch(`${base}/__admin/stats`)).json(),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type Partners = Awaited<ReturnType<typeof startPartners>>;
```

`apps/partners/test/bungae.spec.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRng } from '../src/rng.js';
import { startPartners, type Partners } from './helpers.js';

describe('난수', () => {
  it('같은 시드면 같은 값이 나온다', () => {
    const a = createRng(7);
    const b = createRng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('관리 API', () => {
  let p: Partners;
  beforeAll(async () => {
    p = await startPartners();
  });
  afterAll(() => p.close());

  it('health', async () => {
    expect(await (await fetch(`${p.base}/__admin/health`)).json()).toEqual({ status: 'ok' });
  });

  it('config는 부분 병합하고 reset은 기본값으로 돌린다', async () => {
    const merged = await (await p.configure({ bungae: { duplicateRate: 0.5 } })).json();
    expect(merged.bungae).toMatchObject({ duplicateRate: 0.5, advancePerPoll: 1, rateLimitPerSec: 20 });
    const reset = await (await p.reset()).json();
    expect(reset.bungae.duplicateRate).toBe(0);
  });

  it('모르는 경로는 404', async () => {
    expect((await fetch(`${p.base}/nope`)).status).toBe(404);
  });
});

describe('번개택배', () => {
  let p: Partners;

  async function waybill(reference = 'SHIP-1'): Promise<string> {
    const res = await fetch(`${p.base}/bungae/v1/waybills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiverName: '강남김밥', address: '서울 강남구 가상로 1', reference }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).trackingNo;
  }
  const track = (no: string) => fetch(`${p.base}/bungae/v1/trackings/${no}`);

  beforeAll(async () => {
    p = await startPartners();
  });
  beforeEach(async () => {
    await p.reset();
  });
  afterAll(() => p.close());

  it('운송장 번호는 BG로 시작하고 매번 다르다', async () => {
    const a = await waybill();
    const b = await waybill();
    expect(a).toMatch(/^BG\d+$/);
    expect(a).not.toBe(b);
  });

  it('reference가 없으면 400', async () => {
    const res = await fetch(`${p.base}/bungae/v1/waybills`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(400);
  });

  it('조회할 때마다 한 단계씩 진행해 4번째에 DELIVERED', async () => {
    const no = await waybill();
    const codes: string[][] = [];
    for (let i = 0; i < 5; i++) {
      const body = await (await track(no)).json();
      codes.push(body.events.map((e: { code: string }) => e.code));
    }
    expect(codes[0]).toEqual(['PICKED_UP']);
    expect(codes[3]).toEqual(['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED']);
    expect(codes[4]).toEqual(codes[3]);
  });

  it('이벤트에는 eventId와 ISO 시각이 있다', async () => {
    const no = await waybill();
    const body = await (await track(no)).json();
    expect(body.trackingNo).toBe(no);
    expect(body.events[0]).toEqual({ eventId: `${no}-1`, code: 'PICKED_UP', occurredAt: expect.stringMatching(/Z$/) });
  });

  it('advancePerPoll=4면 첫 조회에 DELIVERED', async () => {
    await p.configure({ bungae: { advancePerPoll: 4 } });
    const no = await waybill();
    const body = await (await track(no)).json();
    expect(body.events.at(-1).code).toBe('DELIVERED');
  });

  it('duplicateRate=1이면 모든 이벤트가 두 번씩 온다', async () => {
    await p.configure({ bungae: { duplicateRate: 1, advancePerPoll: 4 } });
    const no = await waybill();
    const body = await (await track(no)).json();
    expect(body.events).toHaveLength(8);
    expect(new Set(body.events.map((e: { eventId: string }) => e.eventId)).size).toBe(4);
  });

  it('없는 운송장은 404', async () => {
    expect((await track('BG000')).status).toBe(404);
  });

  it('초당 한도를 넘으면 429 + Retry-After, 그 조회는 진행하지 않는다', async () => {
    await p.configure({ bungae: { rateLimitPerSec: 2 } });
    const no = await waybill();
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await track(no)).status);
    expect(statuses).toEqual([200, 200, 429]);
    const limited = await track(no);
    expect(limited.headers.get('retry-after')).toBe('1');

    await new Promise((r) => setTimeout(r, 1100));
    const body = await (await track(no)).json();
    expect(body.events).toHaveLength(3); // 성공한 조회 3번째
    const stats = await p.stats();
    expect(stats.status429).toBe(2);
    expect(stats.calls['bungae.track']).toBe(5);
    expect(stats.perTracking[no]).toBe(5);
  });

  it('force429Rate=1이면 항상 429', async () => {
    await p.configure({ bungae: { force429Rate: 1, retryAfterSec: 2 } });
    const no = await waybill();
    const res = await track(no);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
  });

  it('같은 운송장을 동시에 조회하면 overlaps로 센다', async () => {
    await p.configure({ bungae: { delayMs: 50 } });
    const no = await waybill();
    await Promise.all([track(no), track(no)]);
    const stats = await p.stats();
    expect(stats.overlaps).toBe(1);
    expect(stats.maxInFlight).toBe(2);
  });
});
```

- [ ] **Step 4: 실패 확인**

Run (`apps/partners`): `npx vitest run`
Expected: FAIL, `../src/rng.js`·`../src/server.js`를 찾을 수 없다는 import 오류

- [ ] **Step 5: 구현**

`apps/partners/src/rng.ts`:
```ts
/** 시드로 재현할 수 있는 난수(mulberry32). 같은 시드, 같은 호출 순서면 같은 값이 나온다. 0 이상 1 미만. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

`apps/partners/src/state.ts` (느림보·톡톡 설정도 여기서 함께 정의한다. 처리 코드는 Task 3):
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

export interface PartnersConfig {
  seed: number;
  bungae: BungaeConfig;
  neurimbo: NeurimboConfig;
  toktok: ToktokConfig;
}

export interface ConfigPatch {
  seed?: number;
  bungae?: Partial<BungaeConfig>;
  neurimbo?: Partial<NeurimboConfig>;
  toktok?: Partial<ToktokConfig>;
}

export function defaultConfig(): PartnersConfig {
  return {
    seed: 42,
    bungae: { advancePerPoll: 1, duplicateRate: 0, rateLimitPerSec: 20, force429Rate: 0, retryAfterSec: 1, delayMs: 0 },
    neurimbo: { advancePerPoll: 1, delayMs: 0, error5xxRate: 0, shuffle: false },
    toktok: { failRate: 0 },
  };
}

/** 택배 한 건. polls는 성공한 조회 수(429·5xx는 세지 않는다). */
export interface Parcel {
  createdAt: number;
  polls: number;
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
  status429: number;
  status5xx: number;
  /** 같은 운송장 조회가 처리 중일 때 또 들어온 횟수 */
  overlaps: number;
  /** 같은 운송장 동시 처리 수의 최댓값 */
  maxInFlight: number;
}

function emptyStats(): Stats {
  return { calls: {}, perTracking: {}, status429: 0, status5xx: 0, overlaps: 0, maxInFlight: 0 };
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
  }

  end(trackingNo: string): void {
    const n = (this.inFlight.get(trackingNo) ?? 1) - 1;
    if (n <= 0) this.inFlight.delete(trackingNo);
    else this.inFlight.set(trackingNo, n);
  }
}
```

`apps/partners/src/http.ts`:
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** JSON 본문을 읽는다. 비었거나 깨졌으면 undefined */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const raw = await readBody(req);
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

export function sendXml(res: ServerResponse, status: number, xml: string): void {
  res.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${xml}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

`apps/partners/src/bungae.ts`:
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendJson, sleep } from './http.js';
import type { PartnersState } from './state.js';

/** 번개택배 상태 코드. 조회할 때마다 앞에서부터 한 단계씩 드러난다. */
export const BUNGAE_CODES = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'] as const;

/** POST /bungae/v1/waybills  { receiverName, address, reference } → 201 { trackingNo } */
export async function bungaeCreateWaybill(state: PartnersState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  state.count('bungae.waybill');
  const body = await readJson(req);
  if (!body || typeof body.reference !== 'string' || !body.reference) {
    return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'reference가 필요합니다.' });
  }
  const trackingNo = `BG${state.nextNumber()}`;
  state.bungae.set(trackingNo, { createdAt: Date.now(), polls: 0 });
  sendJson(res, 201, { trackingNo });
}

/** GET /bungae/v1/trackings/:trackingNo → { trackingNo, events: [{ eventId, code, occurredAt }] } */
export async function bungaeTrack(state: PartnersState, trackingNo: string, res: ServerResponse): Promise<void> {
  const cfg = state.config.bungae;
  state.count('bungae.track', trackingNo);

  const now = Date.now();
  state.bungaeWindow = state.bungaeWindow.filter((t) => now - t < 1000);
  if (state.bungaeWindow.length >= cfg.rateLimitPerSec || state.chance(cfg.force429Rate)) {
    state.stats.status429 += 1;
    return sendJson(res, 429, { error: 'RATE_LIMITED' }, { 'Retry-After': String(cfg.retryAfterSec) });
  }
  state.bungaeWindow.push(now);

  const parcel = state.bungae.get(trackingNo);
  if (!parcel) return sendJson(res, 404, { error: 'NOT_FOUND' });

  state.begin(trackingNo);
  try {
    if (cfg.delayMs > 0) await sleep(cfg.delayMs);
    parcel.polls += 1;
    const stage = Math.min(parcel.polls * cfg.advancePerPoll, BUNGAE_CODES.length);
    const events: { eventId: string; code: string; occurredAt: string }[] = [];
    for (let i = 0; i < stage; i++) {
      const event = {
        eventId: `${trackingNo}-${i + 1}`,
        code: BUNGAE_CODES[i],
        occurredAt: new Date(parcel.createdAt + (i + 1) * 60_000).toISOString(),
      };
      events.push(event);
      // 골칫거리: 같은 이벤트를 한 번 더 보낸다.
      if (state.chance(cfg.duplicateRate)) events.push({ ...event });
    }
    sendJson(res, 200, { trackingNo, events });
  } finally {
    state.end(trackingNo);
  }
}
```

`apps/partners/src/server.ts` (Task 3에서 느림보·톡톡 경로를 더한다):
```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { bungaeCreateWaybill, bungaeTrack } from './bungae.js';
import { readJson, sendJson } from './http.js';
import { PartnersState, type ConfigPatch } from './state.js';

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

  // 번개택배(JSON)
  if (method === 'POST' && path === '/bungae/v1/waybills') return bungaeCreateWaybill(state, req, res);
  if (method === 'GET' && (m = path.match(/^\/bungae\/v1\/trackings\/([^/]+)$/))) {
    return bungaeTrack(state, decodeURIComponent(m[1]), res);
  }

  sendJson(res, 404, { error: 'NO_ROUTE', method, path });
}

/** 가상 업체 서버. 상태는 메모리에만 있다. */
export function createPartnersServer(state = new PartnersState()): { server: Server; state: PartnersState } {
  const server = createServer((req, res) => {
    route(state, req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL', message: String(error) });
      else res.end();
    });
  });
  return { server, state };
}
```

`apps/partners/src/main.ts`:
```ts
import { createPartnersServer } from './server.js';

const port = Number(process.env.PARTNERS_PORT ?? 4010);
const { server } = createPartnersServer();

server.listen(port, '127.0.0.1', () => {
  console.log(`partners listening on http://127.0.0.1:${port}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 6: 통과 확인**

Run (`apps/partners`): `npx vitest run && npm run typecheck && npm run build`
Expected: `14 passed`, typecheck·build exit 0, `dist/main.js` 생성

- [ ] **Step 7: 실제로 띄워 보기**

Run (`apps/partners`):
```bash
node dist/main.js & PID=$!
sleep 1
curl -s 127.0.0.1:4010/__admin/health
curl -s -X POST 127.0.0.1:4010/bungae/v1/waybills -H 'Content-Type: application/json' -d '{"receiverName":"a","address":"b","reference":"r1"}'
kill $PID
```
Expected: `partners listening on http://127.0.0.1:4010`, `{"status":"ok"}`, `{"trackingNo":"BG…"}`. 출력을 devlog에 붙인다.

- [ ] **Step 8: 기록과 커밋**

`docs/decisions/0009-가상-업체-서버는-node-http-별도-프로세스.md`:
- 상황: 택배사 2곳과 메신저 1곳을 흉내 내야 한다. 실제 업체 API는 쓰지 않는다(CLAUDE.md). 골칫거리(중복·429·지연·5xx·순서 섞기)를 설정으로 켜고 끄고, 몇 번 불렸는지 세야 한다.
- 선택지:
  1. API 테스트 안에서 `fetch`를 가로채는 목(mock): 빠르지만 HTTP·타임아웃·직렬화를 건너뛰고, 워커 프로세스 2개 실험에서 공유할 수 없다.
  2. Nest로 서버를 하나 더: 익숙하지만 의존성이 무겁고, 가짜 서버에 DI가 필요 없다.
  3. `node:http` + TypeScript 별도 프로세스, 메모리 상태, 관리 API: 의존성은 fast-xml-parser 하나. API 서버·워커·실험이 같은 서버를 진짜 HTTP로 쓴다.
- 결정: 3. 난수는 시드로 재현(mulberry32). 확률이 0인 설정은 난수를 쓰지 않아 다른 설정의 난수 순서를 흔들지 않는다.
- 결과·대가: 상태가 메모리에만 있어 재시작하면 사라진다(운송장 번호는 시작 시각을 앞에 붙여 겹치지 않게 했다). 동시 요청 순서에 따라 난수가 어느 요청에 쓰일지는 달라진다(순서가 정해진 단일 요청 테스트에서만 완전히 재현된다).
- 다시 볼 조건: 업체가 늘어 라우팅이 복잡해지면 작은 라우터를 도입한다.

devlog 항목(Task 1과 같은 형식). 커밋:
```bash
git add apps/partners docs
git commit -m "feat(F12): 가상 업체 서버 골격과 번개택배" -m "Refs: docs/decisions/0009-가상-업체-서버는-node-http-별도-프로세스.md"
```

---

### Task 3: 가상 느림보물류(XML) + 톡톡메신저 웹훅 (F12, F5)

**Files:**
- Create: `apps/partners/src/neurimbo.ts`, `apps/partners/src/toktok.ts`
- Modify: `apps/partners/src/server.ts`
- Test: `apps/partners/test/neurimbo.spec.ts`, `apps/partners/test/toktok.spec.ts`
- Record: devlog

느림보물류: `POST /neurimbo/api/invoice`(XML `<invoice><receiver/><address/><reference/></invoice>`) → `<invoice><invoiceNo>NR…</invoiceNo></invoice>`. `GET /neurimbo/api/track?invoiceNo=` → `<trace><invoiceNo/><item><seq/><statusCd>10|20|30|40</statusCd><statusTime>yyyyMMddHHmmss(KST)</statusTime></item>…</trace>`. 골칫거리: `delayMs`, `error5xxRate`(발급·추적 모두 503), `shuffle`(item 순서 섞기). 톡톡: `POST /toktok/hooks/:channel { idempotencyKey, text }` → 200, `failRate`면 500(저장 안 함). 받은 메시지는 중복이어도 모두 저장하고 `GET /__admin/toktok/messages`가 키별 수신 횟수(`byKey`)를 준다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/partners/test/neurimbo.spec.ts`:
```ts
import { XMLParser } from 'fast-xml-parser';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toKstCompact } from '../src/neurimbo.js';
import { startPartners, type Partners } from './helpers.js';

const parser = new XMLParser({ parseTagValue: false, ignoreDeclaration: true, isArray: (name) => name === 'item' });

describe('느림보물류', () => {
  let p: Partners;

  async function invoice(): Promise<string> {
    const res = await fetch(`${p.base}/neurimbo/api/invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: '<invoice><receiver>역삼카페</receiver><address>서울 강남구 가상로 2</address><reference>SHIP-2</reference></invoice>',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    return parser.parse(await res.text()).invoice.invoiceNo;
  }
  async function track(no: string) {
    const res = await fetch(`${p.base}/neurimbo/api/track?invoiceNo=${no}`);
    return { status: res.status, body: parser.parse(await res.text()) };
  }

  beforeAll(async () => {
    p = await startPartners();
  });
  beforeEach(async () => {
    await p.reset();
  });
  afterAll(() => p.close());

  it('KST 시각 형식 yyyyMMddHHmmss', () => {
    expect(toKstCompact(Date.UTC(2026, 9, 22, 15, 30, 5))).toBe('20261023003005');
  });

  it('송장 번호는 NR로 시작한다', async () => {
    expect(await invoice()).toMatch(/^NR\d+$/);
  });

  it('reference가 없으면 400', async () => {
    const res = await fetch(`${p.base}/neurimbo/api/invoice`, { method: 'POST', body: '<invoice></invoice>' });
    expect(res.status).toBe(400);
  });

  it('조회할 때마다 한 단계씩, 4번째에 40(배송 완료)', async () => {
    const no = await invoice();
    let last;
    for (let i = 0; i < 4; i++) last = await track(no);
    expect(last!.status).toBe(200);
    expect(last!.body.trace.invoiceNo).toBe(no);
    expect(last!.body.trace.item.map((i: { statusCd: string }) => i.statusCd)).toEqual(['10', '20', '30', '40']);
    expect(last!.body.trace.item[0]).toEqual({ seq: '1', statusCd: '10', statusTime: expect.stringMatching(/^\d{14}$/) });
  });

  it('error5xxRate=1이면 송장 발급도 503', async () => {
    await p.configure({ neurimbo: { error5xxRate: 1 } });
    const res = await fetch(`${p.base}/neurimbo/api/invoice`, { method: 'POST', body: '<invoice><reference>R</reference></invoice>' });
    expect(res.status).toBe(503);
  });

  it('error5xxRate=1이면 503, 진행하지 않는다', async () => {
    const no = await invoice();
    await p.configure({ neurimbo: { error5xxRate: 1 } });
    expect((await track(no)).status).toBe(503);
    await p.configure({ neurimbo: { error5xxRate: 0 } });
    expect((await track(no)).body.trace.item).toHaveLength(1);
    expect((await p.stats()).status5xx).toBe(1);
  });

  it('delayMs만큼 늦게 응답한다', async () => {
    await p.configure({ neurimbo: { delayMs: 200 } });
    const no = await invoice();
    const started = performance.now();
    await track(no);
    expect(performance.now() - started).toBeGreaterThanOrEqual(190);
  });

  it('shuffle이면 순서가 섞여 오지만 seq 집합은 같다', async () => {
    await p.configure({ neurimbo: { shuffle: true, advancePerPoll: 4 } });
    const no = await invoice();
    const orders: string[] = [];
    for (let i = 0; i < 10; i++) {
      const items = (await track(no)).body.trace.item as { seq: string }[];
      expect(items.map((x) => x.seq).sort()).toEqual(['1', '2', '3', '4']);
      orders.push(items.map((x) => x.seq).join(''));
    }
    expect(orders.some((o) => o !== '1234')).toBe(true);
  });

  it('없는 송장은 404', async () => {
    expect((await track('NR000')).status).toBe(404);
  });
});
```

`apps/partners/test/toktok.spec.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPartners, type Partners } from './helpers.js';

describe('톡톡메신저 웹훅', () => {
  let p: Partners;
  const send = (body: unknown) =>
    fetch(`${p.base}/toktok/hooks/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const messages = async () => (await fetch(`${p.base}/__admin/toktok/messages`)).json();

  beforeAll(async () => {
    p = await startPartners();
  });
  beforeEach(async () => {
    await p.reset();
  });
  afterAll(() => p.close());

  it('받은 메시지를 중복까지 모두 저장하고 키별로 센다', async () => {
    expect((await send({ idempotencyKey: 'k1', text: '안녕' })).status).toBe(200);
    await send({ idempotencyKey: 'k1', text: '안녕' });
    await send({ idempotencyKey: 'k2', text: '둘' });
    const m = await messages();
    expect(m.total).toBe(3);
    expect(m.byKey).toEqual({ k1: 2, k2: 1 });
    expect(m.messages[0]).toMatchObject({ channel: 'ops', idempotencyKey: 'k1', text: '안녕' });
  });

  it('필드가 빠지면 400', async () => {
    expect((await send({ text: 'x' })).status).toBe(400);
  });

  it('failRate=1이면 500이고 저장하지 않는다', async () => {
    await p.configure({ toktok: { failRate: 1 } });
    expect((await send({ idempotencyKey: 'k1', text: 'x' })).status).toBe(500);
    expect((await messages()).total).toBe(0);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (`apps/partners`): `npx vitest run`
Expected: `neurimbo.spec.ts`는 `../src/neurimbo.js` import 오류로 FAIL, `toktok.spec.ts`는 웹훅 경로가 없어 404(`expected 404 to be 200`)로 FAIL. `bungae.spec.ts`는 통과.

- [ ] **Step 3: 구현**

`apps/partners/src/neurimbo.ts`:
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { readBody, sendXml, sleep } from './http.js';
import type { PartnersState } from './state.js';

/** 느림보물류 상태 코드: 10 집하, 20 이동 중, 30 배송 출발, 40 배송 완료 */
export const NEURIMBO_CODES = ['10', '20', '30', '40'] as const;

const parser = new XMLParser({ parseTagValue: false, ignoreDeclaration: true });
const builder = new XMLBuilder({});

/** 한국 시간(KST, UTC+9)으로 yyyyMMddHHmmss */
export function toKstCompact(ms: number): string {
  const d = new Date(ms + 9 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function errorXml(code: string): string {
  return builder.build({ error: { code } });
}

/** POST /neurimbo/api/invoice  <invoice><receiver/><address/><reference/></invoice> → <invoice><invoiceNo/></invoice> */
export async function neurimboCreateInvoice(state: PartnersState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cfg = state.config.neurimbo;
  state.count('neurimbo.invoice');
  let reference: unknown;
  try {
    reference = parser.parse(await readBody(req))?.invoice?.reference;
  } catch {
    reference = undefined;
  }
  if (typeof reference !== 'string' || !reference) return sendXml(res, 400, errorXml('BAD_REQUEST'));
  // 골칫거리: 발급도 가끔 503.
  if (state.chance(cfg.error5xxRate)) {
    state.stats.status5xx += 1;
    return sendXml(res, 503, errorXml('TEMPORARY_UNAVAILABLE'));
  }
  const invoiceNo = `NR${state.nextNumber()}`;
  state.neurimbo.set(invoiceNo, { createdAt: Date.now(), polls: 0 });
  sendXml(res, 200, builder.build({ invoice: { invoiceNo } }));
}

/** GET /neurimbo/api/track?invoiceNo= → <trace><invoiceNo/><item><seq/><statusCd/><statusTime/></item>…</trace> */
export async function neurimboTrack(state: PartnersState, invoiceNo: string, res: ServerResponse): Promise<void> {
  const cfg = state.config.neurimbo;
  state.count('neurimbo.track', invoiceNo);
  state.begin(invoiceNo);
  try {
    // 골칫거리: 느리다.
    if (cfg.delayMs > 0) await sleep(cfg.delayMs);
    // 골칫거리: 가끔 503.
    if (state.chance(cfg.error5xxRate)) {
      state.stats.status5xx += 1;
      return sendXml(res, 503, errorXml('TEMPORARY_UNAVAILABLE'));
    }
    const parcel = state.neurimbo.get(invoiceNo);
    if (!parcel) return sendXml(res, 404, errorXml('NOT_FOUND'));

    parcel.polls += 1;
    const stage = Math.min(parcel.polls * cfg.advancePerPoll, NEURIMBO_CODES.length);
    const items = Array.from({ length: stage }, (_, i) => ({
      seq: i + 1,
      statusCd: NEURIMBO_CODES[i],
      statusTime: toKstCompact(parcel.createdAt + (i + 1) * 60_000),
    }));
    // 골칫거리: 순서가 뒤섞여 온다(Fisher-Yates, 시드 난수).
    if (cfg.shuffle) {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(state.rng() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
    }
    sendXml(res, 200, builder.build({ trace: { invoiceNo, item: items } }));
  } finally {
    state.end(invoiceNo);
  }
}
```

`apps/partners/src/toktok.ts`:
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendJson } from './http.js';
import type { PartnersState } from './state.js';

/** POST /toktok/hooks/:channel  { idempotencyKey, text } → 200. 받은 메시지는 중복이어도 모두 저장한다. */
export async function toktokHook(state: PartnersState, channel: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  state.count('toktok.hook');
  const body = await readJson(req);
  if (!body || typeof body.idempotencyKey !== 'string' || typeof body.text !== 'string') {
    return sendJson(res, 400, { error: 'BAD_REQUEST', message: 'idempotencyKey, text가 필요합니다.' });
  }
  // 골칫거리: 가끔 실패한다. 실패한 요청은 저장하지 않는다(받지 못한 것으로 본다).
  if (state.chance(state.config.toktok.failRate)) {
    state.stats.status5xx += 1;
    return sendJson(res, 500, { error: 'TEMPORARY' });
  }
  state.messages.push({ channel, idempotencyKey: body.idempotencyKey, text: body.text, receivedAt: new Date().toISOString() });
  sendJson(res, 200, { ok: true });
}

/** 멱등키별 수신 횟수. 2 이상이면 같은 알림을 두 번 이상 받은 것이다. */
export function toktokSummary(state: PartnersState) {
  const byKey: Record<string, number> = {};
  for (const m of state.messages) byKey[m.idempotencyKey] = (byKey[m.idempotencyKey] ?? 0) + 1;
  return { total: state.messages.length, byKey, messages: state.messages };
}
```

`apps/partners/src/server.ts` 전체:
```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { bungaeCreateWaybill, bungaeTrack } from './bungae.js';
import { readJson, sendJson } from './http.js';
import { neurimboCreateInvoice, neurimboTrack } from './neurimbo.js';
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
      if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL', message: String(error) });
      else res.end();
    });
  });
  return { server, state };
}
```

- [ ] **Step 4: 통과 확인**

Run (`apps/partners`): `npx vitest run && npm run typecheck && npm run build`
Expected: 3개 파일 `26 passed`, typecheck·build exit 0

- [ ] **Step 5: 기록과 커밋**

`docs/study/backlog.md`에 추가:
```
- [ ] 시드 난수(mulberry32)와 재현 가능한 테스트 — 동시 요청에서는 왜 완전히 재현되지 않나 (decisions/0009)
- [ ] fast-xml-parser isArray·parseTagValue — XML 하나/여럿, 숫자처럼 보이는 문자열 (apps/partners/src/neurimbo.ts)
```

devlog 항목. 커밋:
```bash
git add apps/partners docs
git commit -m "feat(F12): 가상 느림보물류(XML)와 톡톡메신저 웹훅"
```

---

### Task 4: API 의존성·환경변수·테스트용 partners 자동 실행 + 택배사 어댑터 (F12)

**Files:**
- Modify: `apps/api/package.json`, `apps/api/package-lock.json` (npm install), `.env.example`, `apps/api/src/config/env.ts`, `apps/api/vitest.config.ts`
- Create: `apps/api/test/global-setup.ts`, `apps/api/test/helpers/partners.ts`
- Create: `apps/api/src/common/partner-errors.ts`, `apps/api/src/common/partner-http.ts`
- Create: `apps/api/src/carrier/carrier.types.ts`, `bungae.parser.ts`, `neurimbo.parser.ts`, `carrier.adapters.ts`, `carrier.module.ts`
- Test: `apps/api/test/fixtures/bungae-tracking.json`, `neurimbo-trace.xml`, `neurimbo-trace-single.xml`, `apps/api/test/unit/carrier-parsers.spec.ts`, `apps/api/test/carrier-adapters.e2e.spec.ts`
- Record: `docs/decisions/0010-택배사-어댑터와-오류-분류.md`, devlog

- [ ] **Step 1: 의존성 설치**

Run: `npm install bullmq@6.4.0 ioredis@5.11.1 @nestjs/bullmq@12.0.0 fast-xml-parser@5.11.2`
Expected: `package.json` dependencies에 네 개가 추가된다. `npm ls bullmq ioredis @nestjs/bullmq fast-xml-parser` → `bullmq@6.4.0`, `ioredis@5.11.1`, `@nestjs/bullmq@12.0.0`, `fast-xml-parser@5.11.2`. (ioredis는 bullmq 6의 선택 peer라 직접 설치한다. 6.0.0은 출시 열흘이라 5.11.1을 쓴다.)

- [ ] **Step 2: 환경변수**

`.env.example` 끝에 추가한다(`.env`는 아래 값이 env.ts 기본값과 같으므로 바꾸지 않아도 된다):
```
# Day 2: 가상 업체 서버, Redis(BullMQ), 실행 모드
PARTNERS_URL=http://127.0.0.1:4010
PARTNERS_PORT=4010
REDIS_HOST=127.0.0.1
RUN_WORKERS=1
RUN_SCHEDULERS=1
SWEEP_INTERVAL_MS=30000
RELAY_INTERVAL_MS=2000
BUNGAE_RATE_PER_SEC=10
NEURIMBO_RATE_PER_SEC=5
TOKTOK_CHANNEL=ops
```

`apps/api/src/config/env.ts` 전체:
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
  /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
  workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
};
```

- [ ] **Step 3: 테스트가 partners를 띄우게 한다**

`apps/api/test/global-setup.ts`:
```ts
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// vitest는 apps/api에서 실행한다. 가상 업체 서버(apps/partners)를 빌드해 자식 프로세스로 띄우고, 끝나면 끈다.
const partnersDir = resolve(process.cwd(), '../partners');
const PARTNERS_URL = new URL(process.env.PARTNERS_URL ?? 'http://127.0.0.1:4011');

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(new URL('/__admin/health', PARTNERS_URL), { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

export default async function setup() {
  if (await isUp()) {
    throw new Error(`${PARTNERS_URL.origin}에 이미 서버가 떠 있습니다. 테스트용 partners 포트를 비우고 다시 실행하세요.`);
  }

  // tsc는 partners 쪽 node_modules에서 찾는다(Windows에서 npm.cmd를 거치지 않으려고 node로 직접 실행).
  const tsc = createRequire(resolve(partnersDir, 'package.json')).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', resolve(partnersDir, 'tsconfig.build.json')], { stdio: 'inherit' });

  const child = spawn(process.execPath, [resolve(partnersDir, 'dist/main.js')], {
    env: { ...process.env, PARTNERS_PORT: PARTNERS_URL.port },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const deadline = Date.now() + 10_000;
  while (!(await isUp())) {
    if (child.exitCode !== null) throw new Error(`partners가 시작하자마자 종료됐습니다(exit ${child.exitCode}).`);
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('partners가 10초 안에 뜨지 않았습니다.');
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  };
}
```

`apps/api/vitest.config.ts`:
```ts
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // e2e 테스트가 같은 테스트 DB·같은 partners 서버를 쓰므로 파일 단위 병렬 실행을 끈다.
    fileParallelism: false,
    // 가상 업체 서버를 빌드해 띄운다(테스트 포트 4011, 개발용 4010과 겹치지 않게).
    globalSetup: ['test/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      PARTNERS_URL: 'http://127.0.0.1:4011',
      RUN_SCHEDULERS: '0',
    },
  },
  // swc가 데코레이터 메타데이터를 만들어야 Nest DI가 동작한다.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
```

`apps/api/test/helpers/partners.ts` (관리 API 클라이언트):
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
  status5xx: number;
  overlaps: number;
  maxInFlight: number;
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
};
```

Run: `npx vitest run && npm run typecheck`
Expected: partners 빌드 후 기존 8개 파일 `66 passed`, typecheck exit 0. 끝난 뒤 `curl -s -m 1 127.0.0.1:4011/__admin/health`가 응답하지 않아야 한다(자식 프로세스 종료 확인).

- [ ] **Step 4: 실패하는 테스트 작성 (파서 단위 + 어댑터 통합)**

`apps/api/test/fixtures/bungae-tracking.json` (같은 이벤트 사본 포함, 순서 섞임):
```json
{
  "trackingNo": "BG17611111111110001",
  "events": [
    { "eventId": "BG17611111111110001-2", "code": "IN_TRANSIT", "occurredAt": "2026-10-22T01:02:00.000Z" },
    { "eventId": "BG17611111111110001-1", "code": "PICKED_UP", "occurredAt": "2026-10-22T01:01:00.000Z" },
    { "eventId": "BG17611111111110001-1", "code": "PICKED_UP", "occurredAt": "2026-10-22T01:01:00.000Z" }
  ]
}
```

`apps/api/test/fixtures/neurimbo-trace.xml` (순서 섞임):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<trace>
  <invoiceNo>NR17611111111110001</invoiceNo>
  <item><seq>3</seq><statusCd>30</statusCd><statusTime>20261022100300</statusTime></item>
  <item><seq>1</seq><statusCd>10</statusCd><statusTime>20261022100100</statusTime></item>
  <item><seq>2</seq><statusCd>20</statusCd><statusTime>20261022100200</statusTime></item>
  <item><seq>4</seq><statusCd>40</statusCd><statusTime>20261022100400</statusTime></item>
</trace>
```

`apps/api/test/fixtures/neurimbo-trace-single.xml` (item 1개, 자정 넘는 KST):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<trace><invoiceNo>NR17611111111110002</invoiceNo><item><seq>1</seq><statusCd>10</statusCd><statusTime>20261022000500</statusTime></item></trace>
```

`apps/api/test/unit/carrier-parsers.spec.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBungaeTracking, parseBungaeWaybill } from '../../src/carrier/bungae.parser.js';
import {
  buildNeurimboInvoiceRequest,
  parseKstCompact,
  parseNeurimboInvoice,
  parseNeurimboTrace,
} from '../../src/carrier/neurimbo.parser.js';
import { CarrierEventCode as C } from '../../src/carrier/carrier.types.js';
import { PartnerPermanentError } from '../../src/common/partner-errors.js';
import { parseRetryAfter } from '../../src/common/partner-http.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

describe('번개택배 파서', () => {
  it('이벤트를 공통 형식으로 바꾸고 시각 순으로 정렬한다. 중복은 그대로 둔다', () => {
    const events = parseBungaeTracking(JSON.parse(fixture('bungae-tracking.json')));
    expect(events.map((e) => [e.eventKey, e.code])).toEqual([
      ['BG17611111111110001-1', C.PICKED_UP],
      ['BG17611111111110001-1', C.PICKED_UP],
      ['BG17611111111110001-2', C.IN_TRANSIT],
    ]);
    expect(events[0].occurredAt.toISOString()).toBe('2026-10-22T01:01:00.000Z');
    expect(events[0].raw).toMatchObject({ eventId: 'BG17611111111110001-1' });
  });

  it('모르는 상태 코드는 영구 오류', () => {
    expect(() => parseBungaeTracking({ events: [{ eventId: 'x', code: 'LOST', occurredAt: '2026-10-22T00:00:00Z' }] })).toThrow(
      PartnerPermanentError,
    );
  });

  it('events가 없으면 영구 오류', () => {
    expect(() => parseBungaeTracking({})).toThrow(PartnerPermanentError);
  });

  it('운송장 발급 응답', () => {
    expect(parseBungaeWaybill({ trackingNo: 'BG1' })).toBe('BG1');
    expect(() => parseBungaeWaybill({})).toThrow(PartnerPermanentError);
  });
});

describe('느림보물류 파서', () => {
  it('KST 시각을 UTC Date로', () => {
    expect(parseKstCompact('20261022100100').toISOString()).toBe('2026-10-22T01:01:00.000Z');
    expect(parseKstCompact('20261022000500').toISOString()).toBe('2026-10-21T15:05:00.000Z');
  });

  it('상태 코드를 공통 코드로, 뒤섞인 순서를 시각 순으로', () => {
    const events = parseNeurimboTrace(fixture('neurimbo-trace.xml'));
    expect(events.map((e) => [e.eventKey, e.code])).toEqual([
      ['1', C.PICKED_UP],
      ['2', C.IN_TRANSIT],
      ['3', C.OUT_FOR_DELIVERY],
      ['4', C.DELIVERED],
    ]);
    expect(events[0].raw).toEqual({ seq: '1', statusCd: '10', statusTime: '20261022100100' });
  });

  it('item이 하나여도 배열로 읽는다', () => {
    const events = parseNeurimboTrace(fixture('neurimbo-trace-single.xml'));
    expect(events).toHaveLength(1);
    expect(events[0].occurredAt.toISOString()).toBe('2026-10-21T15:05:00.000Z');
  });

  it('모르는 상태 코드·깨진 시각은 영구 오류', () => {
    expect(() => parseNeurimboTrace('<trace><item><seq>1</seq><statusCd>99</statusCd><statusTime>20261022100100</statusTime></item></trace>')).toThrow(
      PartnerPermanentError,
    );
    expect(() => parseNeurimboTrace('<trace><item><seq>1</seq><statusCd>10</statusCd><statusTime>2026-10-22</statusTime></item></trace>')).toThrow(
      PartnerPermanentError,
    );
  });

  it('송장 발급 요청·응답 XML', () => {
    expect(buildNeurimboInvoiceRequest({ reference: 'R1', receiverName: '역삼카페', address: '서울' })).toBe(
      '<invoice><receiver>역삼카페</receiver><address>서울</address><reference>R1</reference></invoice>',
    );
    expect(parseNeurimboInvoice('<?xml version="1.0"?><invoice><invoiceNo>NR1</invoiceNo></invoice>')).toBe('NR1');
  });
});

describe('Retry-After', () => {
  it('초 단위와 HTTP 날짜를 ms로, 없으면 1초', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(null)).toBe(1000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 7_000)).toBe(3000);
  });
});
```

`apps/api/test/carrier-adapters.e2e.spec.ts` (globalSetup이 띄운 partners에 진짜 HTTP로 붙는다):
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { BungaeAdapter, CarrierAdapters, NeurimboAdapter } from '../src/carrier/carrier.adapters.js';
import { Carrier, CarrierEventCode as C } from '../src/carrier/carrier.types.js';
import { PartnerPermanentError, PartnerRateLimitedError, PartnerTransientError } from '../src/common/partner-errors.js';
import { env } from '../src/config/env.js';
import { partners } from './helpers/partners.js';

const opts = { baseUrl: env.partnersUrl, timeoutMs: 1000 };
const adapters = new CarrierAdapters([new BungaeAdapter(opts), new NeurimboAdapter(opts)]);
const input = { reference: 'T-1', receiverName: '판교분식', address: '경기 성남시 분당구 가상길 303' };

describe('택배사 어댑터 ↔ 가상 업체 서버 (F12)', () => {
  beforeEach(async () => {
    await partners.reset();
  });

  it.each([Carrier.BUNGAE, Carrier.NEURIMBO])('%s: 운송장 발급 후 네 번째 조회에 DELIVERED', async (carrier) => {
    const adapter = adapters.get(carrier);
    const trackingNo = await adapter.createWaybill(input);
    let events = await adapter.track(trackingNo);
    expect(events.map((e) => e.code)).toEqual([C.PICKED_UP]);
    for (let i = 0; i < 3; i++) events = await adapter.track(trackingNo);
    expect(events.map((e) => e.code)).toEqual([C.PICKED_UP, C.IN_TRANSIT, C.OUT_FOR_DELIVERY, C.DELIVERED]);
  });

  it('번개 429 → PartnerRateLimitedError, Retry-After를 ms로', async () => {
    const adapter = adapters.get(Carrier.BUNGAE);
    const trackingNo = await adapter.createWaybill(input);
    await partners.configure({ bungae: { force429Rate: 1, retryAfterSec: 2 } });
    const error = await adapter.track(trackingNo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartnerRateLimitedError);
    expect((error as PartnerRateLimitedError).retryAfterMs).toBe(2000);
  });

  it('느림보 503 → PartnerTransientError', async () => {
    const adapter = adapters.get(Carrier.NEURIMBO);
    const trackingNo = await adapter.createWaybill(input);
    await partners.configure({ neurimbo: { error5xxRate: 1 } });
    await expect(adapter.track(trackingNo)).rejects.toBeInstanceOf(PartnerTransientError);
  });

  it('응답이 타임아웃보다 늦으면 PartnerTransientError', async () => {
    const slow = new NeurimboAdapter({ baseUrl: env.partnersUrl, timeoutMs: 100 });
    const trackingNo = await slow.createWaybill(input);
    await partners.configure({ neurimbo: { delayMs: 500 } });
    await expect(slow.track(trackingNo)).rejects.toThrow(/TimeoutError/);
  });

  it('없는 운송장(404) → PartnerPermanentError', async () => {
    await expect(adapters.get(Carrier.BUNGAE).track('BG0')).rejects.toBeInstanceOf(PartnerPermanentError);
  });
});
```

- [ ] **Step 5: 실패 확인**

Run: `npx vitest run test/unit/carrier-parsers.spec.ts test/carrier-adapters.e2e.spec.ts`
Expected: FAIL, `../../src/carrier/bungae.parser.js`, `../src/carrier/carrier.adapters.js` 등을 찾을 수 없다는 import 오류

- [ ] **Step 6: 오류 분류와 HTTP 헬퍼**

`apps/api/src/common/partner-errors.ts`:
```ts
/** 외부 업체(택배사·메신저) 호출 실패. 종류에 따라 재시도 여부가 갈린다(decisions/0010). */
export class PartnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 429. 기다렸다가 다시 하면 된다. */
export class PartnerRateLimitedError extends PartnerError {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

/** 5xx, 타임아웃, 연결 실패. 다시 하면 될 수도 있다. */
export class PartnerTransientError extends PartnerError {}

/** 4xx(429 제외), 응답 형식 오류. 다시 해도 같다. */
export class PartnerPermanentError extends PartnerError {}
```

`apps/api/src/common/partner-http.ts`:
```ts
import { PartnerPermanentError, PartnerRateLimitedError, PartnerTransientError } from './partner-errors.js';

/** Retry-After(초 또는 HTTP 날짜)를 ms로. 없거나 못 읽으면 기본 1초 */
export function parseRetryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? 1000 : Math.max(0, at - now);
}

/**
 * 외부 업체 HTTP 호출. 2xx면 본문 문자열을 돌려주고, 아니면 재시도 판단에 쓰는 오류로 바꾼다.
 * - 429 → PartnerRateLimitedError(Retry-After)
 * - 5xx, 타임아웃, 연결 실패 → PartnerTransientError
 * - 그 밖의 4xx → PartnerPermanentError
 */
export async function partnerFetch(label: string, url: string, init: RequestInit, timeoutMs: number): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    // AbortSignal.timeout은 TimeoutError, 연결 실패는 TypeError(fetch failed)
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new PartnerTransientError(`${label} 호출 실패(${reason})`);
  }
  const body = await res.text();
  if (res.ok) return body;
  const message = `${label} 응답 ${res.status}: ${body.slice(0, 200)}`;
  if (res.status === 429) throw new PartnerRateLimitedError(message, parseRetryAfter(res.headers.get('retry-after')));
  if (res.status >= 500) throw new PartnerTransientError(message);
  throw new PartnerPermanentError(message);
}
```

- [ ] **Step 7: 공통 타입, 파서(순수 함수), 어댑터**

`apps/api/src/carrier/carrier.types.ts`:
```ts
/** 연동하는 택배사 */
export enum Carrier {
  BUNGAE = 'BUNGAE', // 번개택배(JSON)
  NEURIMBO = 'NEURIMBO', // 느림보물류(XML)
}

/** 택배사마다 다른 상태 코드를 이 값으로 맞춘다(F12). */
export enum CarrierEventCode {
  PICKED_UP = 'PICKED_UP',
  IN_TRANSIT = 'IN_TRANSIT',
  OUT_FOR_DELIVERY = 'OUT_FOR_DELIVERY',
  DELIVERED = 'DELIVERED',
}

/** 택배사 응답을 변환한 배송 이벤트 */
export interface NormalizedEvent {
  /** 운송장 안에서 이벤트를 구분하는 키. 같은 키가 다시 오면 중복이다. */
  eventKey: string;
  code: CarrierEventCode;
  occurredAt: Date;
  /** 원본(디버깅·감사용) */
  raw: Record<string, unknown>;
}

export interface WaybillInput {
  /** 우리 쪽 참조 번호 */
  reference: string;
  receiverName: string;
  address: string;
}

/** 택배사 하나를 감싸는 어댑터. 택배사를 추가하면 이것만 하나 더 만든다. */
export interface CarrierAdapter {
  readonly carrier: Carrier;
  /** 운송장을 발급하고 운송장 번호를 돌려준다. */
  createWaybill(input: WaybillInput): Promise<string>;
  /** 지금까지의 배송 이벤트를 발생 시각 순으로 돌려준다. */
  track(trackingNo: string): Promise<NormalizedEvent[]>;
}
```

`apps/api/src/carrier/bungae.parser.ts`:
```ts
import { PartnerPermanentError } from '../common/partner-errors.js';
import { CarrierEventCode, type NormalizedEvent } from './carrier.types.js';

const CODES = new Set<string>(Object.values(CarrierEventCode));

function fail(detail: string): never {
  throw new PartnerPermanentError(`번개택배 응답 형식 오류: ${detail}`);
}

/** 번개택배 운송장 발급 응답 { trackingNo } */
export function parseBungaeWaybill(body: unknown): string {
  const trackingNo = (body as { trackingNo?: unknown } | null)?.trackingNo;
  if (typeof trackingNo !== 'string' || !trackingNo) fail('trackingNo 없음');
  return trackingNo;
}

/**
 * 번개택배 추적 응답 { trackingNo, events: [{ eventId, code, occurredAt }] }.
 * 번개는 같은 이벤트를 두 번 보내기도 한다. 여기서는 걸러내지 않고 그대로 돌려준다(중복 처리는 적재 단계의 몫).
 */
export function parseBungaeTracking(body: unknown): NormalizedEvent[] {
  const events = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) fail('events 배열 없음');
  return events
    .map((e: Record<string, unknown>) => {
      if (typeof e.eventId !== 'string' || !e.eventId) fail('eventId 없음');
      if (typeof e.code !== 'string' || !CODES.has(e.code)) fail(`알 수 없는 상태 코드 ${String(e.code)}`);
      const occurredAt = new Date(String(e.occurredAt));
      if (Number.isNaN(occurredAt.getTime())) fail(`시각 형식 ${String(e.occurredAt)}`);
      return { eventKey: e.eventId, code: e.code as CarrierEventCode, occurredAt, raw: e };
    })
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}
```

`apps/api/src/carrier/neurimbo.parser.ts`:
```ts
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { PartnerPermanentError } from '../common/partner-errors.js';
import { CarrierEventCode, type NormalizedEvent, type WaybillInput } from './carrier.types.js';

/** 느림보물류 상태 코드 → 공통 코드 */
const STATUS: Record<string, CarrierEventCode> = {
  '10': CarrierEventCode.PICKED_UP,
  '20': CarrierEventCode.IN_TRANSIT,
  '30': CarrierEventCode.OUT_FOR_DELIVERY,
  '40': CarrierEventCode.DELIVERED,
};

// parseTagValue: false → "0010" 같은 값을 숫자로 바꾸지 않고 문자열 그대로 둔다.
// isArray: item이 하나뿐이어도 배열로 받는다.
const parser = new XMLParser({ parseTagValue: false, ignoreDeclaration: true, isArray: (name) => name === 'item' });
const builder = new XMLBuilder({});

function fail(detail: string): never {
  throw new PartnerPermanentError(`느림보물류 응답 형식 오류: ${detail}`);
}

function parseXml(xml: string): Record<string, unknown> {
  try {
    return parser.parse(xml) as Record<string, unknown>;
  } catch (error) {
    fail(`XML 파싱 실패(${String(error)})`);
  }
}

/** yyyyMMddHHmmss(한국 시간) → Date */
export function parseKstCompact(value: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!m) fail(`시각 형식 ${value}`);
  const [, y, mo, d, h, mi, s] = m.map(Number);
  // KST = UTC+9. Date.UTC는 시가 음수여도 전날로 넘겨 계산한다.
  return new Date(Date.UTC(y, mo - 1, d, h - 9, mi, s));
}

export function buildNeurimboInvoiceRequest(input: WaybillInput): string {
  return builder.build({ invoice: { receiver: input.receiverName, address: input.address, reference: input.reference } });
}

export function parseNeurimboInvoice(xml: string): string {
  const invoiceNo = (parseXml(xml).invoice as { invoiceNo?: unknown } | undefined)?.invoiceNo;
  if (typeof invoiceNo !== 'string' || !invoiceNo) fail('invoiceNo 없음');
  return invoiceNo;
}

/** <trace><invoiceNo/><item><seq/><statusCd/><statusTime/></item>…</trace>. 순서가 섞여 와도 발생 시각 순으로 정렬한다. */
export function parseNeurimboTrace(xml: string): NormalizedEvent[] {
  const trace = parseXml(xml).trace as { item?: Record<string, unknown>[] } | undefined;
  if (!trace) fail('trace 없음');
  return (trace.item ?? [])
    .map((item) => {
      const seq = item.seq;
      const code = STATUS[String(item.statusCd)];
      if (typeof seq !== 'string' || !seq) fail('seq 없음');
      if (!code) fail(`알 수 없는 상태 코드 ${String(item.statusCd)}`);
      return { eventKey: seq, code, occurredAt: parseKstCompact(String(item.statusTime)), raw: item };
    })
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || Number(a.eventKey) - Number(b.eventKey));
}
```

`apps/api/src/carrier/carrier.adapters.ts`:
```ts
import { partnerFetch } from '../common/partner-http.js';
import { PartnerPermanentError } from '../common/partner-errors.js';
import { parseBungaeTracking, parseBungaeWaybill } from './bungae.parser.js';
import { Carrier, type CarrierAdapter, type NormalizedEvent, type WaybillInput } from './carrier.types.js';
import { buildNeurimboInvoiceRequest, parseNeurimboInvoice, parseNeurimboTrace } from './neurimbo.parser.js';

export interface AdapterOptions {
  baseUrl: string;
  timeoutMs: number;
}

function parseJson(label: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PartnerPermanentError(`${label} 응답이 JSON이 아닙니다.`);
  }
}

/** 번개택배: JSON API */
export class BungaeAdapter implements CarrierAdapter {
  readonly carrier = Carrier.BUNGAE;
  constructor(private readonly opts: AdapterOptions) {}

  async createWaybill(input: WaybillInput): Promise<string> {
    const text = await partnerFetch(
      '번개택배 운송장 발급',
      `${this.opts.baseUrl}/bungae/v1/waybills`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
      this.opts.timeoutMs,
    );
    return parseBungaeWaybill(parseJson('번개택배', text));
  }

  async track(trackingNo: string): Promise<NormalizedEvent[]> {
    const text = await partnerFetch(
      '번개택배 추적',
      `${this.opts.baseUrl}/bungae/v1/trackings/${encodeURIComponent(trackingNo)}`,
      { method: 'GET' },
      this.opts.timeoutMs,
    );
    return parseBungaeTracking(parseJson('번개택배', text));
  }
}

/** 느림보물류: XML API, 상태 코드 체계가 다르다 */
export class NeurimboAdapter implements CarrierAdapter {
  readonly carrier = Carrier.NEURIMBO;
  constructor(private readonly opts: AdapterOptions) {}

  async createWaybill(input: WaybillInput): Promise<string> {
    const text = await partnerFetch(
      '느림보물류 송장 발급',
      `${this.opts.baseUrl}/neurimbo/api/invoice`,
      { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: buildNeurimboInvoiceRequest(input) },
      this.opts.timeoutMs,
    );
    return parseNeurimboInvoice(text);
  }

  async track(trackingNo: string): Promise<NormalizedEvent[]> {
    const text = await partnerFetch(
      '느림보물류 추적',
      `${this.opts.baseUrl}/neurimbo/api/track?invoiceNo=${encodeURIComponent(trackingNo)}`,
      { method: 'GET' },
      this.opts.timeoutMs,
    );
    return parseNeurimboTrace(text);
  }
}

/** 택배사 → 어댑터. 서비스는 택배사를 몰라도 여기서 꺼내 쓴다. */
export class CarrierAdapters {
  private readonly byCarrier: Map<Carrier, CarrierAdapter>;

  constructor(adapters: CarrierAdapter[]) {
    this.byCarrier = new Map(adapters.map((a) => [a.carrier, a]));
  }

  get(carrier: Carrier): CarrierAdapter {
    const adapter = this.byCarrier.get(carrier);
    if (!adapter) throw new Error(`택배사 ${carrier} 어댑터가 없습니다.`);
    return adapter;
  }
}
```

`apps/api/src/carrier/carrier.module.ts` (어댑터 생성자가 문자열·숫자를 받으므로 Nest DI 대신 팩토리. 이 모듈은 Task 6에서 출고 모듈이 가져다 쓴다):
```ts
import { Module } from '@nestjs/common';
import { env } from '../config/env.js';
import { BungaeAdapter, CarrierAdapters, NeurimboAdapter } from './carrier.adapters.js';

@Module({
  providers: [
    {
      // 어댑터는 생성자에 설정값(문자열·숫자)을 받으므로 DI 대신 팩토리로 만든다.
      provide: CarrierAdapters,
      useFactory: () => {
        const opts = { baseUrl: env.partnersUrl, timeoutMs: env.partnerTimeoutMs };
        return new CarrierAdapters([new BungaeAdapter(opts), new NeurimboAdapter(opts)]);
      },
    },
  ],
  exports: [CarrierAdapters],
})
export class CarrierModule {}
```

- [ ] **Step 8: 통과 확인**

Run: `npx vitest run && npm run typecheck`
Expected: 10개 파일 `82 passed`, typecheck exit 0

- [ ] **Step 9: 기록과 커밋**

`docs/decisions/0010-택배사-어댑터와-오류-분류.md`:
- 상황: 번개(JSON)와 느림보(XML)는 형식·상태 코드·시각 표기(ISO UTC vs KST 문자열)가 다르다. 수집 워커는 어느 택배사인지 몰라도 같은 이벤트를 받아야 하고, 실패를 "다시 하면 되는 것"과 "다시 해도 안 되는 것"으로 나눠야 한다.
- 선택지:
  1. 수집 서비스 안에서 택배사별 if 분기: 빠르지만 택배사를 추가할 때마다 서비스를 고친다.
  2. `CarrierAdapter` 인터페이스(createWaybill, track) + 택배사별 클래스, 파싱은 순수 함수로 분리: 파서는 픽스처로 DB·HTTP 없이 테스트한다.
- 결정: 2. 정렬(발생 시각 순)은 파서가 한다. 응답 안의 중복은 파서가 걸러내지 않는다(중복 처리는 적재 단계가 eventKey로 한다 → Task 7).
- 오류 3분류(`PartnerRateLimitedError(retryAfterMs)` / `PartnerTransientError` / `PartnerPermanentError`): 429 / 5xx·타임아웃·연결 실패 / 그 밖의 4xx·형식 오류. 이름이 Carrier가 아니라 Partner인 것은 톡톡 클라이언트(Task 8)도 같은 헬퍼와 분류를 쓰기 때문이다. 타임아웃은 `AbortSignal.timeout`.
- 테스트: 어댑터 통합 테스트는 목 대신 vitest `globalSetup`이 띄운 partners(포트 4011)에 붙는다. 개발용 4010과 겹치지 않게 했고, 포트가 이미 쓰이면 테스트를 시작하지 않는다.
- 결과·대가: 테스트 실행마다 partners를 tsc로 빌드한다(약 1~2초). 모르는 상태 코드는 영구 오류라 그 운송장 수집이 멈춘다(SyncRun에 남는다).
- 다시 볼 조건: 세 번째 택배사가 생기면 어댑터 등록을 설정 기반으로 바꿀지 본다.

`docs/study/backlog.md`에 추가:
```
- [ ] fetch + AbortSignal.timeout — 타임아웃 에러 이름(TimeoutError)과 연결 실패(TypeError) 구분 (src/common/partner-http.ts)
- [ ] HTTP Retry-After(초 또는 날짜) (src/common/partner-http.ts)
- [ ] vitest globalSetup과 자식 프로세스 — 테스트용 서버 띄우고 정리하기 (test/global-setup.ts)
```

devlog 항목. 커밋:
```bash
git add apps/api .env.example docs
git commit -m "feat(F12): 택배사 어댑터와 테스트용 partners 자동 실행" -m "Refs: docs/decisions/0010-택배사-어댑터와-오류-분류.md"
```

---

### Task 5: 가맹점 시드 + 배정 API (상태와 가맹점을 UPDATE 한 번에) (F2)

**Files:**
- Create: `apps/api/src/merchant/merchant.entity.ts`, `dto/allocate.dto.ts`, `merchant.service.ts`, `merchant.controller.ts`, `merchant.module.ts`
- Modify: `apps/api/src/terminal/terminal.entity.ts`, `terminal.views.ts`, `terminal.service.ts`, `transition.service.ts`, `apps/api/src/db/seed-reference.ts`, `apps/api/src/entities.ts`, `apps/api/src/app.module.ts`
- Create: `apps/api/src/migrations/Migration<시각>.ts` (생성 명령으로)
- Test: `apps/api/test/helpers/scenario.ts`, `apps/api/test/merchant.e2e.spec.ts`
- Record: `docs/decisions/0011-배정은-mutate로-한-UPDATE에.md`, devlog

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/helpers/scenario.ts` (실제 API로 상태를 만드는 준비 함수. Task 6에서 출고 함수를 더한다):
```ts
import { expect } from 'vitest';
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
```

`apps/api/test/merchant.e2e.spec.ts`:
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
    expect(history.body.at(-1)).toMatchObject({ toStatus: 'ALLOCATED', actor: 'han', reason: '가맹점 배정: 역삼카페(YEOKSAM-CAFE)' });
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

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/merchant.e2e.spec.ts`
Expected: FAIL, `GET /merchants`·`POST /terminals/…/allocations`가 404 (`beforeAll`의 `registerInStock`은 Day 1 API라 통과)

- [ ] **Step 3: 가맹점 엔티티와 시드, 단말기에 가맹점 연결**

`apps/api/src/merchant/merchant.entity.ts`:
```ts
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** 가맹점(가상). 단말기를 배정받는 곳 */
@Entity({ tableName: 'merchant' })
export class Merchant {
  @PrimaryKey()
  id!: number;

  @Property({ unique: true, length: 20 })
  code!: string;

  @Property({ length: 50 })
  name!: string;

  @Property({ length: 200 })
  address!: string;
}
```

`apps/api/src/terminal/terminal.entity.ts`:
```ts
import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { Merchant } from '../merchant/merchant.entity.js';
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

`apps/api/src/terminal/terminal.views.ts`:
```ts
import type { Terminal } from './terminal.entity.js';
import type { TerminalStatusHistory } from './terminal-status-history.entity.js';

/** 엔티티를 그대로 내보내지 않고 응답 형태를 여기서 고정한다. model과 merchant가 populate돼 있어야 한다. */
export function toTerminalView(t: Terminal) {
  return {
    serialNo: t.serialNo,
    modelCode: t.model.code,
    merchantCode: t.merchant?.code ?? null,
    status: t.status,
    version: t.version,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function toHistoryView(h: TerminalStatusHistory) {
  return {
    fromStatus: h.fromStatus ?? null,
    toStatus: h.toStatus,
    source: h.source,
    actor: h.actor,
    reason: h.reason,
    occurredAt: h.occurredAt.toISOString(),
  };
}
```

`apps/api/src/terminal/terminal.service.ts` (조회에 merchant populate):
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { RegisterTerminalDto } from './dto/register-terminal.dto.js';
import type { ListTerminalsQuery } from './dto/list-terminals.query.js';
import { TerminalModel } from './terminal-model.entity.js';
import { Terminal } from './terminal.entity.js';
import { TerminalStatusHistory } from './terminal-status-history.entity.js';
import { TransitionSource } from './terminal-status.js';
import { TransitionService } from './transition.service.js';

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class TerminalService {
  constructor(
    private readonly em: EntityManager,
    private readonly transitions: TransitionService,
  ) {}

  /** 단말기와 첫 이력(RECEIVED)을 한 트랜잭션으로 만든다. 이력은 전이 서비스가 남긴다(decisions/0008). */
  async register(dto: RegisterTerminalDto, actor: string): Promise<Terminal> {
    return this.em.transactional(async (tx) => {
      const model = await tx.findOne(TerminalModel, { code: dto.modelCode });
      if (!model) throw new NotFoundException(`단말기 모델 ${dto.modelCode}이(가) 없습니다.`);
      const terminal = tx.create(Terminal, { serialNo: dto.serialNo, model });
      this.transitions.recordRegistration(terminal, actor, TransitionSource.MANUAL, tx);
      return terminal;
    });
  }

  async list(query: ListTerminalsQuery) {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.modelCode ? { model: { code: query.modelCode } } : {}),
      ...(query.q ? { serialNo: { $like: `${escapeLike(query.q)}%` } } : {}),
    };
    const [items, total] = await this.em.findAndCount(Terminal, where, {
      populate: ['model', 'merchant'],
      orderBy: { id: 'desc' },
      limit: query.size,
      offset: (query.page - 1) * query.size,
    });
    return { items, total, page: query.page, size: query.size };
  }

  async getBySerial(serialNo: string): Promise<Terminal> {
    const terminal = await this.em.findOne(Terminal, { serialNo }, { populate: ['model', 'merchant'] });
    if (!terminal) throw new NotFoundException(`단말기 ${serialNo}이(가) 없습니다.`);
    return terminal;
  }

  async history(serialNo: string): Promise<TerminalStatusHistory[]> {
    const terminal = await this.getBySerial(serialNo);
    return this.em.find(TerminalStatusHistory, { terminal }, { orderBy: { id: 'asc' } });
  }
}
```

`apps/api/src/db/seed-reference.ts`:
```ts
import type { EntityManager } from '@mikro-orm/mysql';
import { TerminalModel } from '../terminal/terminal-model.entity.js';
import { InspectionItem } from '../inspection/inspection-item.entity.js';
import { Merchant } from '../merchant/merchant.entity.js';

interface ModelSeed {
  code: string;
  name: string;
  requiresReinspection: boolean;
  /** 검수 항목 [코드, 이름], 순서대로 */
  items: [string, string][];
}

export const MODEL_SEEDS: ModelSeed[] = [
  {
    code: 'SN-100',
    name: '유선 카운터형',
    requiresReinspection: false,
    items: [['POWER', '전원'], ['NETWORK', '유선 통신'], ['CARD_READER', '카드리더'], ['PRINTER', '영수증 프린터']],
  },
  {
    code: 'SN-200',
    name: '무선 LTE형',
    requiresReinspection: true,
    items: [['POWER', '전원'], ['LTE', 'LTE 통신'], ['CARD_READER', '카드리더'], ['BATTERY', '배터리']],
  },
  {
    code: 'SN-300',
    name: '테이블오더 태블릿형',
    requiresReinspection: false,
    items: [['POWER', '전원'], ['NETWORK', '무선 통신'], ['TOUCHSCREEN', '터치스크린']],
  },
];

/** 가상 가맹점. 실제 상호·주소가 아니다. */
export const MERCHANT_SEEDS = [
  { code: 'GANGNAM-KIMBAP', name: '강남김밥', address: '서울 강남구 가상대로 101' },
  { code: 'YEOKSAM-CAFE', name: '역삼카페', address: '서울 강남구 가상로 202' },
  { code: 'PANGYO-BUNSIK', name: '판교분식', address: '경기 성남시 분당구 가상길 303' },
];

/** 기준 데이터(모델, 검수 항목, 가맹점)를 넣는다. 이미 있는 행은 건너뛰므로 여러 번 실행해도 된다. */
export async function seedReference(em: EntityManager): Promise<void> {
  for (const seed of MODEL_SEEDS) {
    let model = await em.findOne(TerminalModel, { code: seed.code });
    if (!model) {
      model = em.create(TerminalModel, { code: seed.code, name: seed.name, requiresReinspection: seed.requiresReinspection });
      await em.flush();
    }
    for (const [sortOrder, [code, label]] of seed.items.entries()) {
      const exists = await em.findOne(InspectionItem, { model, code });
      if (!exists) em.create(InspectionItem, { model, code, label, sortOrder });
    }
  }
  for (const seed of MERCHANT_SEEDS) {
    const exists = await em.findOne(Merchant, { code: seed.code });
    if (!exists) em.create(Merchant, seed);
  }
  await em.flush();
}
```

`apps/api/src/entities.ts`:
```ts
import { TerminalModel } from './terminal/terminal-model.entity.js';
import { Terminal } from './terminal/terminal.entity.js';
import { TerminalStatusHistory } from './terminal/terminal-status-history.entity.js';
import { InspectionItem } from './inspection/inspection-item.entity.js';
import { Inspection, InspectionResult } from './inspection/inspection.entities.js';
import { Merchant } from './merchant/merchant.entity.js';

/** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant];
```

- [ ] **Step 4: 전이 명령에 mutate 추가**

`apps/api/src/terminal/transition.service.ts` 전체(`mutate` 필드, merchant populate, `cmd.mutate?.(terminal)`이 바뀐 곳):
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { InvalidTransitionError } from '../common/domain-errors.js';
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
      return terminal;
    });
  }

  /**
   * 새로 만든 단말기의 첫 이력(null → 현재 상태)을 남긴다. 등록 트랜잭션 안에서 부른다(decisions/0008).
   * 단말기 INSERT와 이력 INSERT가 같은 트랜잭션이고 부모 행은 이 트랜잭션이 막 만든 행이라 S→X 승격이 생기지 않는다.
   */
  recordRegistration(terminal: Terminal, actor: string, source: TransitionSource, em: EntityManager): TerminalStatusHistory {
    return em.create(TerminalStatusHistory, {
      terminal,
      fromStatus: null,
      toStatus: terminal.status,
      source,
      actor,
      reason: '신규 등록',
    });
  }

}
```

- [ ] **Step 5: 배정 API**

`apps/api/src/merchant/dto/allocate.dto.ts`:
```ts
import { IsInt, IsString, Min, MinLength } from 'class-validator';

export class AllocateDto {
  @IsString()
  @MinLength(1)
  merchantCode!: string;

  /** 화면에서 본 version (decisions/0004) */
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
```

`apps/api/src/merchant/merchant.service.ts`:
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import { TransitionService } from '../terminal/transition.service.js';
import type { AllocateDto } from './dto/allocate.dto.js';
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
      source: TransitionSource.MANUAL,
      expectedVersion: dto.expectedVersion,
      mutate: (terminal) => {
        terminal.merchant = merchant;
      },
    });
  }
}
```

`apps/api/src/merchant/merchant.controller.ts`:
```ts
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { toTerminalView } from '../terminal/terminal.views.js';
import { AllocateDto } from './dto/allocate.dto.js';
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
}
```

`apps/api/src/merchant/merchant.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { TerminalModule } from '../terminal/terminal.module.js';
import { MerchantController } from './merchant.controller.js';
import { MerchantService } from './merchant.service.js';

@Module({
  imports: [TerminalModule],
  controllers: [MerchantController],
  providers: [MerchantService],
})
export class MerchantModule {}
```

`apps/api/src/app.module.ts`:
```ts
import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import ormConfig from './mikro-orm.config.js';
import { HealthController } from './health/health.controller.js';
import { DomainExceptionFilter } from './common/domain-exception.filter.js';
import { TerminalModule } from './terminal/terminal.module.js';
import { InspectionModule } from './inspection/inspection.module.js';
import { MerchantModule } from './merchant/merchant.module.js';

@Module({
  // forRoot가 요청마다 EntityManager를 fork하는 RequestContext 미들웨어를 자동 등록한다.
  imports: [MikroOrmModule.forRoot(ormConfig), TerminalModule, InspectionModule, MerchantModule],
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
export class AppModule {}
```

- [ ] **Step 6: 통과 확인**

Run: `npx vitest run && npm run typecheck`
Expected: 11개 파일 `88 passed`, typecheck exit 0. 기존 응답에 `merchantCode: null`이 추가돼도 Day 1 테스트는 `toMatchObject`라 통과한다.

- [ ] **Step 7: 마이그레이션과 개발 DB 시드**

Run:
```bash
npm run db:migration:create
```
Expected: 생성된 파일의 up()이 다음과 같다(순서는 달라도 된다).
```ts
    this.addSql(`create table \`merchant\` (\`id\` int unsigned not null auto_increment primary key, \`code\` varchar(20) not null, \`name\` varchar(50) not null, \`address\` varchar(200) not null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`merchant\` add unique \`merchant_code_unique\` (\`code\`);`);

    this.addSql(`alter table \`terminal\` add \`merchant_id\` int unsigned null;`);
    this.addSql(`alter table \`terminal\` add constraint \`terminal_merchant_id_foreign\` foreign key (\`merchant_id\`) references \`merchant\` (\`id\`) on delete set null;`);
    this.addSql(`alter table \`terminal\` add index \`terminal_merchant_id_index\` (\`merchant_id\`);`);
```
Run:
```bash
npm run db:migrate
npm run db:migration:check
npm run db:seed
```
Expected: `적용: Migration<시각>`, `최신 상태`, `기준 데이터 시드 완료`(개발 DB에 가맹점 3곳)

- [ ] **Step 8: 기록과 커밋**

`docs/decisions/0011-배정은-mutate로-한-UPDATE에.md`:
- 상황: 배정은 상태(IN_STOCK → ALLOCATED)와 가맹점을 함께 바꾼다. 상태 변경은 전이 서비스 한 곳에서만 한다(CLAUDE.md). 전이 서비스는 version 검사 UPDATE를 이력 INSERT보다 먼저 flush한다(troubleshooting/0004).
- 선택지:
  1. 전이 후 같은 트랜잭션에서 가맹점을 따로 설정: UPDATE가 두 번 나가 version이 2 오른다. 화면이 본 version과 응답 version이 2 차이 나 다음 요청의 expectedVersion 계산이 헷갈린다.
  2. 가맹점을 먼저 설정하고 전이: 전이 안 flush가 가맹점 변경까지 함께 보내 한 번이 되지만, 전이가 거절되면(422) 바깥 em에 바뀐 값이 남는다. 순서 의존이 숨는다.
  3. `TransitionCommand.mutate?: (terminal) => void`: 규칙 확인 뒤, flush 전에 적용 → 상태와 가맹점이 UPDATE 한 번, version +1. 거절되면 mutate가 호출되지 않는다.
- 결정: 3. 테스트가 version +1을 확인한다.
- 결과·대가: mutate 안에서 상태(status)를 바꾸면 규칙을 우회할 수 있다. 주석으로 금지만 해 두었다.
- 다시 볼 조건: mutate를 쓰는 곳이 늘어 실수가 보이면, 바꿀 수 있는 필드를 명시한 타입(예: `{ merchant?: Merchant }`)으로 좁힌다.

`docs/study/backlog.md`에 추가:
```
- [ ] 낙관적 락 version이 UPDATE 횟수만큼 오르는 것 — 한 요청에서 UPDATE를 한 번으로 묶는 이유 (decisions/0011)
```

devlog 항목. 커밋:
```bash
git add apps/api docs
git commit -m "feat(F2): 가맹점 시드와 배정 API" -m "Refs: docs/decisions/0011-배정은-mutate로-한-UPDATE에.md"
```

---

### Task 6: 출고 API + Shipment·CarrierEvent·SyncRun 모델 (F3)

**Files:**
- Create: `apps/api/src/shipment/shipment.entities.ts`, `dto/create-shipment.dto.ts`, `shipment.service.ts`, `shipment.views.ts`, `shipment.controller.ts`, `shipment.module.ts`
- Modify: `apps/api/src/common/domain-exception.filter.ts`, `apps/api/src/entities.ts`, `apps/api/src/app.module.ts`, `apps/api/test/helpers/scenario.ts`
- Create: `apps/api/src/migrations/Migration<시각>.ts` (생성 명령으로)
- Test: `apps/api/test/shipment.e2e.spec.ts`
- Record: `docs/decisions/0012-운송장-발급은-트랜잭션-밖에서.md`, devlog

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/helpers/scenario.ts` 끝에 추가:
```ts
/** 배정된 단말기를 출고한다. */
export async function shipWith(t: TestApp, serialNo: string, carrier: 'BUNGAE' | 'NEURIMBO') {
  const version = (await t.http().get(`/terminals/${serialNo}`)).body.version;
  const res = await t.http().post('/shipments').set(SCENARIO_OP).send({ serialNo, carrier, expectedVersion: version });
  expect(res.status).toBe(201);
  return { shipmentId: res.body.id as number, trackingNo: res.body.trackingNo as string };
}

/** 등록부터 출고까지 한 번에. 수집 테스트·실험 준비용 */
export async function prepareShipped(t: TestApp, serialNo: string, carrier: 'BUNGAE' | 'NEURIMBO') {
  await registerInStock(t, serialNo);
  await allocateTo(t, serialNo);
  return shipWith(t, serialNo, carrier);
}
```

`apps/api/test/shipment.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Shipment, ShipmentStatus } from '../src/shipment/shipment.entities.js';
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
    expect(history.body.at(-1)).toMatchObject({ toStatus: 'SHIPPED', actor: 'yoon', reason: `출고: BUNGAE ${res.body.trackingNo}` });
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

  it('없는 출고 id는 404, 숫자가 아니면 400', async () => {
    expect((await t.http().get('/shipments/9999')).status).toBe(404);
    expect((await t.http().get('/shipments/abc')).status).toBe(400);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/shipment.e2e.spec.ts`
Expected: FAIL, `../src/shipment/shipment.entities.js`를 찾을 수 없다는 import 오류(파일 전체 실패)

- [ ] **Step 3: 엔티티**

`apps/api/src/shipment/shipment.entities.ts` (nullable 날짜에 `type: 'datetime'`을 꼭 적는다. 빠지면 `varchar(255)` 컬럼이 생긴다 — 사전 검증에서 마이그레이션으로 확인):
```ts
import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';
import { Carrier, CarrierEventCode } from '../carrier/carrier.types.js';
import { Terminal } from '../terminal/terminal.entity.js';

export enum ShipmentStatus {
  IN_TRANSIT = 'IN_TRANSIT',
  DELIVERED = 'DELIVERED',
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

`apps/api/src/entities.ts`:
```ts
import { TerminalModel } from './terminal/terminal-model.entity.js';
import { Terminal } from './terminal/terminal.entity.js';
import { TerminalStatusHistory } from './terminal/terminal-status-history.entity.js';
import { InspectionItem } from './inspection/inspection-item.entity.js';
import { Inspection, InspectionResult } from './inspection/inspection.entities.js';
import { Merchant } from './merchant/merchant.entity.js';
import { CarrierEvent, Shipment, SyncRun } from './shipment/shipment.entities.js';

/** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun];
```

- [ ] **Step 4: 출고 서비스·API, 외부 업체 오류 → 502**

`apps/api/src/shipment/dto/create-shipment.dto.ts`:
```ts
import { IsEnum, IsInt, Matches, Min } from 'class-validator';
import { Carrier } from '../../carrier/carrier.types.js';

export class CreateShipmentDto {
  @Matches(/^[A-Z0-9-]{4,32}$/, { message: 'serialNo는 대문자·숫자·하이픈 4~32자입니다.' })
  serialNo!: string;

  @IsEnum(Carrier)
  carrier!: Carrier;

  /** 화면에서 본 version (decisions/0004) */
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
```

`apps/api/src/shipment/shipment.service.ts`:
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { CarrierAdapters } from '../carrier/carrier.adapters.js';
import { InvalidTransitionError } from '../common/domain-errors.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import { TransitionService } from '../terminal/transition.service.js';
import type { CreateShipmentDto } from './dto/create-shipment.dto.js';
import { CarrierEvent, Shipment } from './shipment.entities.js';

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
          source: TransitionSource.MANUAL,
          expectedVersion: dto.expectedVersion,
        },
        tx,
      );
      const shipment = tx.create(Shipment, { terminal: updated, carrier: dto.carrier, trackingNo });
      return { shipment, terminal: updated };
    });
  }

  async get(id: number): Promise<{ shipment: Shipment; events: CarrierEvent[] }> {
    const shipment = await this.em.findOne(Shipment, id, { populate: ['terminal'] });
    if (!shipment) throw new NotFoundException(`출고 ${id}이(가) 없습니다.`);
    const events = await this.em.find(CarrierEvent, { shipment }, { orderBy: { occurredAt: 'asc', id: 'asc' } });
    return { shipment, events };
  }
}
```

`apps/api/src/shipment/shipment.views.ts`:
```ts
import type { CarrierEvent, Shipment } from './shipment.entities.js';

/** terminal이 populate돼 있어야 한다. */
export function toShipmentView(s: Shipment, events?: CarrierEvent[]) {
  return {
    id: s.id,
    serialNo: s.terminal.serialNo,
    carrier: s.carrier,
    trackingNo: s.trackingNo,
    status: s.status,
    lastSyncedAt: s.lastSyncedAt?.toISOString() ?? null,
    deliveredAt: s.deliveredAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    ...(events
      ? { events: events.map((e) => ({ eventKey: e.eventKey, code: e.code, occurredAt: e.occurredAt.toISOString() })) }
      : {}),
  };
}
```

`apps/api/src/shipment/shipment.controller.ts`:
```ts
import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { toTerminalView } from '../terminal/terminal.views.js';
import { CreateShipmentDto } from './dto/create-shipment.dto.js';
import { ShipmentService } from './shipment.service.js';
import { toShipmentView } from './shipment.views.js';

@Controller('shipments')
export class ShipmentController {
  constructor(private readonly shipments: ShipmentService) {}

  @Post()
  async create(@Body() dto: CreateShipmentDto, @Operator() actor: string) {
    const { shipment, terminal } = await this.shipments.create(dto, actor);
    return { ...toShipmentView(shipment), terminal: toTerminalView(terminal) };
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    const { shipment, events } = await this.shipments.get(id);
    return toShipmentView(shipment, events);
  }
}
```

`apps/api/src/shipment/shipment.module.ts`:
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
})
export class ShipmentModule {}
```

`apps/api/src/common/domain-exception.filter.ts`:
```ts
import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { OptimisticLockError, UniqueConstraintViolationException } from '@mikro-orm/mysql';
import type { Response } from 'express';
import { InvalidTransitionError } from './domain-errors.js';
import { PartnerError } from './partner-errors.js';

/** ORM·도메인·외부 업체 오류를 HTTP 응답으로 바꾼다. 응답의 code로 클라이언트가 원인을 구분한다. */
@Catch(OptimisticLockError, UniqueConstraintViolationException, InvalidTransitionError, PartnerError)
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
    if (error instanceof PartnerError) {
      // 우리 잘못이 아니라 외부 업체(택배사) 쪽 실패. 원인 분류(error.name)를 함께 준다.
      return res.status(502).json({ statusCode: 502, code: 'PARTNER_ERROR', reason: error.name, message: error.message });
    }
    return res.status(422).json({ statusCode: 422, code: 'INVALID_TRANSITION', message: error.message });
  }
}
```

`apps/api/src/app.module.ts`:
```ts
import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import ormConfig from './mikro-orm.config.js';
import { HealthController } from './health/health.controller.js';
import { DomainExceptionFilter } from './common/domain-exception.filter.js';
import { TerminalModule } from './terminal/terminal.module.js';
import { InspectionModule } from './inspection/inspection.module.js';
import { MerchantModule } from './merchant/merchant.module.js';
import { ShipmentModule } from './shipment/shipment.module.js';

@Module({
  // forRoot가 요청마다 EntityManager를 fork하는 RequestContext 미들웨어를 자동 등록한다.
  imports: [MikroOrmModule.forRoot(ormConfig), TerminalModule, InspectionModule, MerchantModule, ShipmentModule],
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
export class AppModule {}
```

- [ ] **Step 5: 통과 확인 (동시 출고는 3회)**

Run:
```bash
npx vitest run && npm run typecheck
for i in 1 2 3; do npx vitest run test/shipment.e2e.spec.ts --silent=false 2>&1 | grep -E "\[동시 출고\]|Tests "; done
```
Expected: 12개 파일 `95 passed`, typecheck exit 0. 동시 출고 줄은 `응답=[201,409] … 저장=1`이고 `고아=` 값을 devlog에 3회 모두 적는다(사전 검증에서는 3회 모두 `운송장발급=2 저장=1 고아=1`이었다. 실제 잰 값을 적는다).

- [ ] **Step 6: 마이그레이션**

Run: `npm run db:migration:create`
Expected: 생성된 up()이 다음과 같다. **`last_synced_at`·`delivered_at`·`finished_at`이 `datetime null`인지 꼭 본다**(`varchar(255)`면 엔티티에 `type: 'datetime'`이 빠진 것).
```ts
    this.addSql(`create table \`shipment\` (\`id\` int unsigned not null auto_increment primary key, \`terminal_id\` int unsigned not null, \`carrier\` enum('BUNGAE','NEURIMBO') not null, \`tracking_no\` varchar(30) not null, \`status\` enum('IN_TRANSIT','DELIVERED') not null default 'IN_TRANSIT', \`last_synced_at\` datetime null, \`delivered_at\` datetime null, \`created_at\` datetime not null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`shipment\` add index \`shipment_terminal_id_index\` (\`terminal_id\`);`);
    this.addSql(`alter table \`shipment\` add unique \`shipment_tracking_no_unique\` (\`tracking_no\`);`);
    this.addSql(`alter table \`shipment\` add index \`shipment_status_index\` (\`status\`);`);

    this.addSql(`create table \`sync_run\` (\`id\` int unsigned not null auto_increment primary key, \`job\` varchar(50) not null, \`shipment_id\` int unsigned null, \`attempt\` int not null, \`worker\` varchar(50) not null, \`outcome\` varchar(20) not null, \`started_at\` datetime not null, \`finished_at\` datetime null, \`fetched\` int not null default 0, \`inserted\` int not null default 0, \`duplicated\` int not null default 0, \`detail\` varchar(500) null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`sync_run\` add index \`sync_run_shipment_id_index\` (\`shipment_id\`);`);

    this.addSql(`create table \`carrier_event\` (\`id\` int unsigned not null auto_increment primary key, \`shipment_id\` int unsigned not null, \`event_key\` varchar(50) not null, \`code\` enum('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED') not null, \`occurred_at\` datetime not null, \`raw\` json not null, \`received_at\` datetime not null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`carrier_event\` add index \`carrier_event_shipment_id_index\` (\`shipment_id\`);`);
    this.addSql(`alter table \`carrier_event\` add unique \`carrier_event_shipment_id_event_key_unique\` (\`shipment_id\`, \`event_key\`);`);

    this.addSql(`alter table \`shipment\` add constraint \`shipment_terminal_id_foreign\` foreign key (\`terminal_id\`) references \`terminal\` (\`id\`);`);

    this.addSql(`alter table \`sync_run\` add constraint \`sync_run_shipment_id_foreign\` foreign key (\`shipment_id\`) references \`shipment\` (\`id\`) on delete set null;`);

    this.addSql(`alter table \`carrier_event\` add constraint \`carrier_event_shipment_id_foreign\` foreign key (\`shipment_id\`) references \`shipment\` (\`id\`);`);
```
Run:
```bash
npm run db:migrate
npm run db:migration:check
```
Expected: `적용: Migration<시각>`, `최신 상태`

- [ ] **Step 7: 기록과 커밋**

`docs/decisions/0012-운송장-발급은-트랜잭션-밖에서.md`:
- 상황: 출고는 택배사에 운송장을 발급받고(외부 HTTP), 단말기를 SHIPPED로 바꾸고, 운송장을 저장한다. 외부 호출은 느리고(느림보) 실패할 수 있다.
- 선택지:
  1. DB 트랜잭션 안에서 택배사 호출: 실패하면 함께 롤백되지만, 호출 시간 동안 트랜잭션·커넥션을 잡고 있다. 택배사가 발급에 성공했는데 우리 커밋이 실패하면 어차피 고아가 생긴다.
  2. 트랜잭션 밖에서 먼저 발급, 그다음 짧은 트랜잭션(전이 먼저 → 운송장 INSERT): DB 락을 짧게 잡는다. 트랜잭션이 실패하면(동시 출고 409 등) 발급한 운송장이 고아로 남는다.
  3. 운송장을 "발급 대기"로 먼저 저장 → 커밋 → 발급 → 갱신(saga): 고아를 추적할 수 있지만 상태가 하나 더 생긴다.
- 결정: 2. 발급 전에 확인할 수 있는 실패(없는 단말기, version 불일치, 배정 안 됨)는 먼저 걸러 택배사를 부르지 않는다(테스트로 확인: 422·409일 때 발급 호출 0).
- 결과·대가(알려진 한계): 같은 단말기 동시 출고에서 고아 운송장이 생긴다. Step 5에서 잰 값: (3회 결과를 적는다). 택배사 취소 API가 없어 지금은 정리하지 않는다.
- 트랜잭션 안 순서: 전이(UPDATE terminal)를 먼저, shipment INSERT를 나중에 한다. shipment의 FK 검사가 terminal 행에 S 락을 잡기 전에 X 락을 먼저 잡기 위해서다(troubleshooting/0004, decisions/0006).
- 다시 볼 조건: 고아 운송장이 비용이 되면(택배사 과금) 3으로 바꾸고 정리 작업을 둔다.

`docs/study/backlog.md`에 추가:
```
- [ ] 외부 HTTP 호출을 DB 트랜잭션 밖으로 — 고아 자원과 saga (decisions/0012)
- [ ] reflect-metadata와 유니온 타입 — Date | null이 Object가 되어 varchar(255)가 되는 이유 (shipment.entities.ts)
- [ ] supertest가 listen하지 않은 서버에 요청할 때 서버를 열고 닫는 방식 — 요청 체인 안에서 다른 요청을 await하면 깨지는 이유 (shipment.e2e.spec.ts)
```

devlog 항목(동시 출고 3회 출력 포함). 커밋:
```bash
git add apps/api docs
git commit -m "feat(F3): 출고 API와 운송장·배송 이벤트 모델" -m "Refs: docs/decisions/0012-운송장-발급은-트랜잭션-밖에서.md"
```

---

### Task 7: BullMQ 연결 + 택배 추적 자동 수집(sweep·track) + 실행 모드 (F3)

**Files:**
- Create: `apps/api/src/queue/queue-names.ts`, `apps/api/src/queue/queues.module.ts`
- Create: `apps/api/src/carrier-sync/retry-policy.ts`, `carrier-sync.service.ts`, `carrier-sync.processors.ts`, `carrier-sync.module.ts`
- Create: `apps/api/src/workers/workers.module.ts`, `apps/api/src/scheduler/scheduler.service.ts`, `apps/api/src/scheduler/scheduler.module.ts`, `apps/api/src/worker.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/main.ts`, `apps/api/package.json`(스크립트), `apps/api/test/helpers/test-app.ts`, `apps/api/test/global-setup.ts`
- Create: `apps/api/test/helpers/queues.ts`
- Test: `apps/api/test/carrier-sync.e2e.spec.ts`
- Record: `docs/decisions/0013-BullMQ-큐-구성과-Redis를-쓰는-이유.md`, `docs/decisions/0014-배송-완료-반영-규칙과-재시도.md`, `docs/decisions/0015-실행-모드-워커와-스케줄러.md`, devlog

수집 흐름(스펙 4.3~4.5): sweep이 배송 중인 운송장마다 `track-<id>` job을 넣는다 → 택배사별 큐의 워커가 조회 → 새 이벤트만 저장(응답 안 중복 제거 → 이미 저장된 키 한 번에 조회 → 남은 것만 `em.insert`, unique 위반은 중복으로 셈) → DELIVERED가 있으면 한 트랜잭션에서 전이(SHIPPED → DELIVERED, BATCH, `system:carrier-sync`)를 먼저, 운송장 완료를 나중에 → 실행마다 SyncRun 1행. 단말기가 이미 SHIPPED가 아니면 단말기는 그대로 두고 운송장만 완료(NOOP).

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/helpers/queues.ts`:
```ts
import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { env } from '../../src/config/env.js';
import { ALL_QUEUES } from '../../src/queue/queue-names.js';

/** 조건이 참(또는 값)이 될 때까지 기다린다. 비동기 처리(큐 워커) 결과를 확인할 때 쓴다. */
export async function waitFor<T>(
  check: () => Promise<T | false | null | undefined>,
  { timeoutMs = 15_000, intervalMs = 100, message = '조건' }: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${message}을(를) ${timeoutMs}ms 안에 만족하지 못했습니다.`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function queuesOf(app: INestApplication): Queue[] {
  return ALL_QUEUES.map((name) => app.get<Queue>(getQueueToken(name)));
}

/**
 * 이 테스트 파일의 큐를 비운다. 접두사(env.queuePrefix)가 파일마다 달라 다른 파일·개발 서버의 job은 건드리지 않는다.
 * 안전장치: 테스트 접두사가 아니면 거절한다.
 */
export async function resetQueues(app: INestApplication): Promise<void> {
  if (!env.queuePrefix.startsWith('test-')) throw new Error(`테스트 접두사가 아닙니다: ${env.queuePrefix}`);
  for (const queue of queuesOf(app)) await queue.obliterate({ force: true });
}

/** 대기·처리 중·지연(재시도 대기) job이 모두 없어질 때까지 기다린다. */
export async function waitForQueuesIdle(app: INestApplication, timeoutMs = 15_000): Promise<void> {
  await waitFor(
    async () => {
      for (const queue of queuesOf(app)) {
        const c = await queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'waiting-children');
        if (Object.values(c).some((n) => n > 0)) return false;
      }
      return true;
    },
    { timeoutMs, message: '큐가 빈 상태' },
  );
}
```

`apps/api/test/carrier-sync.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CarrierSyncService, SYNC_ACTOR } from '../src/carrier-sync/carrier-sync.service.js';
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
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/carrier-sync.e2e.spec.ts`
Expected: FAIL, `../src/carrier-sync/carrier-sync.service.js` import 오류

- [ ] **Step 3: 큐 연결(전역 모듈)**

`apps/api/src/queue/queue-names.ts` (Task 8에서 `OUTBOX`를 더한다):
```ts
/** BullMQ 큐 이름. 택배사마다 호출 한도가 달라 추적 큐를 따로 둔다(decisions/0013). */
export const QUEUE = {
  TRACK_BUNGAE: 'track-bungae',
  TRACK_NEURIMBO: 'track-neurimbo',
  CARRIER_SWEEP: 'carrier-sweep',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export const ALL_QUEUES: QueueName[] = Object.values(QUEUE);
```

`apps/api/src/queue/queues.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { env } from '../config/env.js';
import { ALL_QUEUES } from './queue-names.js';

/** Redis 연결과 큐 등록. 어느 모듈에서든 @InjectQueue로 쓸 수 있게 전역으로 둔다. */
@Global()
@Module({
  imports: [
    BullModule.forRoot({ connection: { host: env.redis.host, port: env.redis.port }, prefix: env.queuePrefix }),
    BullModule.registerQueue(...ALL_QUEUES.map((name) => ({ name }))),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
```

- [ ] **Step 4: 재시도 정책과 수집 서비스**

`apps/api/src/carrier-sync/retry-policy.ts`:
```ts
import { NotFoundException } from '@nestjs/common';
import { UnrecoverableError, type JobsOptions } from 'bullmq';
import { InvalidTransitionError } from '../common/domain-errors.js';
import { PartnerPermanentError, PartnerRateLimitedError } from '../common/partner-errors.js';

/** 추적 job 기본 옵션. 완료·최종 실패한 job을 지워야 다음 sweep이 같은 jobId로 다시 넣을 수 있다(decisions/0013). */
export const TRACK_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'carrier', delay: 500 },
  removeOnComplete: true,
  removeOnFail: true,
};

const BASE_DELAY_MS = 500;

/**
 * 'carrier' 백오프: 429면 택배사가 알려 준 Retry-After만큼, 그 밖에는 500ms·1s·2s·4s… 지수 백오프(decisions/0014).
 * Worker 옵션 settings.backoffStrategy로 등록한다.
 */
export function carrierBackoff(attemptsMade: number, _type?: string, err?: Error): number {
  if (err instanceof PartnerRateLimitedError) return Math.max(err.retryAfterMs, BASE_DELAY_MS);
  return BASE_DELAY_MS * 2 ** (attemptsMade - 1);
}

/**
 * 다시 해도 같은 결과인 오류는 UnrecoverableError로 바꿔 재시도하지 않게 한다.
 * 429·5xx·타임아웃, 낙관적 락 충돌, 데드락은 그대로 던져 재시도한다.
 */
export function toJobError(error: unknown): unknown {
  if (error instanceof PartnerPermanentError || error instanceof InvalidTransitionError || error instanceof NotFoundException) {
    return new UnrecoverableError(`${error.name}: ${error.message}`);
  }
  return error;
}
```

`apps/api/src/carrier-sync/carrier-sync.service.ts`:
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
   * 단말기가 이미 SHIPPED가 아니면(운영자가 먼저 수동으로 바꾼 경우 등) 단말기는 건드리지 않고 운송장만 완료한다(no-op, decisions/0014).
   */
  private async applyDelivered(shipmentId: number, deliveredAt: Date): Promise<{ outcome: TrackOutcome; detail: string | null }> {
    return this.em.fork().transactional(async (tx) => {
      const shipment = await tx.findOneOrFail(Shipment, shipmentId, { populate: ['terminal'] });
      if (shipment.status === ShipmentStatus.DELIVERED) return { outcome: 'NOOP', detail: '운송장이 이미 완료됨' };

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

`apps/api/src/carrier-sync/carrier-sync.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { CarrierModule } from '../carrier/carrier.module.js';
import { TerminalModule } from '../terminal/terminal.module.js';
import { CarrierSyncService } from './carrier-sync.service.js';

@Module({
  imports: [CarrierModule, TerminalModule],
  providers: [CarrierSyncService],
  exports: [CarrierSyncService],
})
export class CarrierSyncModule {}
```

- [ ] **Step 5: 프로세서, 워커 모듈, 스케줄러**

`apps/api/src/carrier-sync/carrier-sync.processors.ts` (`@Processor` 옵션은 클래스 정의 시점에 정해지므로 `env`의 속도 값은 프로세스 시작 때 한 번 읽힌다):
```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { env } from '../config/env.js';
import { QUEUE } from '../queue/queue-names.js';
import { CarrierSyncService, type TrackJobData } from './carrier-sync.service.js';
import { carrierBackoff, toJobError } from './retry-policy.js';

async function runTrack(sync: CarrierSyncService, queue: string, job: Job<TrackJobData>) {
  try {
    return await sync.track(job.data.shipmentId, { queue, attempt: job.attemptsMade + 1 });
  } catch (error) {
    throw toJobError(error);
  }
}

/** 번개택배 추적. limiter로 우리 쪽 호출 속도를 택배사 한도 아래로 묶는다(초당 env.bungaeRatePerSec). */
@Processor(QUEUE.TRACK_BUNGAE, {
  concurrency: 5,
  limiter: { max: env.bungaeRatePerSec, duration: 1000 },
  settings: { backoffStrategy: carrierBackoff },
})
export class BungaeTrackProcessor extends WorkerHost {
  constructor(private readonly sync: CarrierSyncService) {
    super();
  }

  process(job: Job<TrackJobData>) {
    return runTrack(this.sync, QUEUE.TRACK_BUNGAE, job);
  }
}

/** 느림보물류 추적. 응답이 느려 동시 처리 수를 조금 더 둔다. */
@Processor(QUEUE.TRACK_NEURIMBO, {
  concurrency: 5,
  limiter: { max: env.neurimboRatePerSec, duration: 1000 },
  settings: { backoffStrategy: carrierBackoff },
})
export class NeurimboTrackProcessor extends WorkerHost {
  constructor(private readonly sync: CarrierSyncService) {
    super();
  }

  process(job: Job<TrackJobData>) {
    return runTrack(this.sync, QUEUE.TRACK_NEURIMBO, job);
  }
}

/** 주기 실행(job scheduler)이 넣는 sweep job을 처리한다. */
@Processor(QUEUE.CARRIER_SWEEP)
export class CarrierSweepProcessor extends WorkerHost {
  constructor(private readonly sync: CarrierSyncService) {
    super();
  }

  process() {
    return this.sync.sweep();
  }
}
```

`apps/api/src/workers/workers.module.ts` (Task 8에서 Outbox 프로세서를 더한다):
```ts
import { Module } from '@nestjs/common';
import {
  BungaeTrackProcessor,
  CarrierSweepProcessor,
  NeurimboTrackProcessor,
} from '../carrier-sync/carrier-sync.processors.js';
import { CarrierSyncModule } from '../carrier-sync/carrier-sync.module.js';

/** 큐 job을 처리하는 프로세서들. RUN_WORKERS=1인 프로세스에만 넣는다(decisions/0015). */
@Module({
  imports: [CarrierSyncModule],
  providers: [BungaeTrackProcessor, NeurimboTrackProcessor, CarrierSweepProcessor],
})
export class WorkersModule {}
```

`apps/api/src/scheduler/scheduler.service.ts` (Task 8에서 relay 주기 작업을 더한다):
```ts
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { QUEUE } from '../queue/queue-names.js';

/**
 * 주기 작업 등록. BullMQ job scheduler는 Redis에 한 개만 저장되므로(같은 id면 덮어씀)
 * 이 서비스가 여러 프로세스에서 떠도 주기 작업은 하나다.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(@InjectQueue(QUEUE.CARRIER_SWEEP) private readonly sweepQueue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.sweepQueue.upsertJobScheduler(
      'carrier-sweep',
      { every: env.sweepIntervalMs },
      { name: 'sweep', data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
    this.logger.log(`주기 작업 등록: carrier-sweep ${env.sweepIntervalMs}ms`);
  }
}
```

`apps/api/src/scheduler/scheduler.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service.js';

/** 주기 작업 등록. RUN_SCHEDULERS=1인 프로세스에만 넣는다(decisions/0015). */
@Module({
  providers: [SchedulerService],
})
export class SchedulerModule {}
```

- [ ] **Step 6: 실행 모드 — AppModule.forRoot, 진입점 2개**

`apps/api/src/app.module.ts`:
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

`apps/api/src/main.ts`:
```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { env } from './config/env.js';

const app = await NestFactory.create(AppModule.forRoot({ workers: env.runWorkers, schedulers: env.runSchedulers }));
app.enableShutdownHooks();
await app.listen(env.port);
console.log(
  `terminal-ops api listening on http://localhost:${env.port} (workers=${env.runWorkers}, schedulers=${env.runSchedulers}, queuePrefix=${env.queuePrefix})`,
);
```

`apps/api/src/worker.ts`:
```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { env } from './config/env.js';

// HTTP 없이 큐 job만 처리하는 프로세스. 여러 개 띄워 같은 큐를 나눠 처리할 수 있다(experiments/0005).
const app = await NestFactory.createApplicationContext(AppModule.forRoot({ workers: true, schedulers: env.runSchedulers }));
app.enableShutdownHooks();
console.log(`terminal-ops worker ready (name=${env.workerName}, schedulers=${env.runSchedulers}, queuePrefix=${env.queuePrefix})`);
```

`apps/api/package.json`의 `scripts`에서 `"start"` 줄 다음에 추가:
```json
    "start:worker": "node dist/worker.js",
```

- [ ] **Step 7: 테스트 앱이 워커를 선택하게, 테스트 Redis 키 정리**

`apps/api/test/helpers/test-app.ts`:
```ts
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/mysql';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { seedReference } from '../../src/db/seed-reference.js';

export interface TestApp {
  app: INestApplication;
  orm: MikroORM;
  http: () => ReturnType<typeof request>;
}

/**
 * @param options.workers true면 큐 프로세서까지 띄운다(수집·알림 테스트). 주기 작업(스케줄러)은 테스트에서 항상 끈다 —
 *   테스트가 sweep()·relay()를 직접 부른다.
 */
export async function createTestApp(options: { workers?: boolean } = {}): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ workers: options.workers ?? false, schedulers: false })],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  const orm: MikroORM = app.get(MikroORM);
  return { app, orm, http: () => request(app.getHttpServer()) };
}

/** 테스트 DB 스키마를 엔티티 기준으로 다시 만들고 기준 데이터를 넣는다. */
export async function resetDatabase(orm: MikroORM): Promise<void> {
  // 개발 DB를 실수로 지우지 않도록 테스트 DB에서만 실행한다.
  const dbName = orm.config.get('dbName');
  if (!process.env.MYSQL_TEST_DATABASE || dbName !== process.env.MYSQL_TEST_DATABASE) {
    throw new Error(`resetDatabase는 테스트 DB에서만 실행합니다(현재: ${dbName}).`);
  }
  await orm.schema.refresh();
  await seedReference(orm.em.fork());
}
```

`apps/api/test/global-setup.ts` 전체(시작·끝에 `test-*` 키 삭제, Redis가 없으면 바로 알려 준다):
```ts
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Redis } from 'ioredis';

// vitest는 apps/api에서 실행한다. 가상 업체 서버(apps/partners)를 빌드해 자식 프로세스로 띄우고, 끝나면 끈다.
const partnersDir = resolve(process.cwd(), '../partners');
const PARTNERS_URL = new URL(process.env.PARTNERS_URL ?? 'http://127.0.0.1:4011');

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(new URL('/__admin/health', PARTNERS_URL), { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 테스트가 만든 BullMQ 키(접두사 test-)를 지운다. 테스트 파일마다 접두사가 달라 파일 안에서 지우지 못한 키(큐 meta 등)가 쌓이기 때문이다.
 * 개발 서버는 접두사 terminal-ops를 쓰므로 건드리지 않는다.
 */
async function deleteTestQueueKeys(): Promise<number> {
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  try {
    await redis.connect();
  } catch (error) {
    throw new Error(`Redis에 연결할 수 없습니다. docker compose up -d redis 를 확인하세요. (${String(error)})`);
  }
  let deleted = 0;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'test-*', 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) deleted += await redis.unlink(...keys);
  } while (cursor !== '0');
  await redis.quit();
  return deleted;
}

export default async function setup() {
  await deleteTestQueueKeys();

  if (await isUp()) {
    throw new Error(`${PARTNERS_URL.origin}에 이미 서버가 떠 있습니다. 테스트용 partners 포트를 비우고 다시 실행하세요.`);
  }

  // tsc는 partners 쪽 node_modules에서 찾는다(Windows에서 npm.cmd를 거치지 않으려고 node로 직접 실행).
  const tsc = createRequire(resolve(partnersDir, 'package.json')).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', resolve(partnersDir, 'tsconfig.build.json')], { stdio: 'inherit' });

  const child = spawn(process.execPath, [resolve(partnersDir, 'dist/main.js')], {
    env: { ...process.env, PARTNERS_PORT: PARTNERS_URL.port },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const deadline = Date.now() + 10_000;
  while (!(await isUp())) {
    if (child.exitCode !== null) throw new Error(`partners가 시작하자마자 종료됐습니다(exit ${child.exitCode}).`);
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('partners가 10초 안에 뜨지 않았습니다.');
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await deleteTestQueueKeys();
  };
}
```

- [ ] **Step 8: 통과 확인**

Run:
```bash
npx vitest run && npm run typecheck
for i in 1 2 3; do npx vitest run test/carrier-sync.e2e.spec.ts 2>&1 | grep -E "Tests |FAIL"; done
MSYS_NO_PATHCONV=1 docker exec terminal-ops-redis redis-cli --scan --pattern 'test-*' | wc -l
```
Expected: 13개 파일 `102 passed`, typecheck exit 0, 수집 테스트 3회 모두 `7 passed`, 남은 `test-*` 키 0

- [ ] **Step 9: 워커 진입점 확인**

Run:
```bash
npm run build
RUN_SCHEDULERS=0 timeout 10 node dist/worker.js
```
Expected: `terminal-ops worker ready (name=pid-…, schedulers=false, queuePrefix=terminal-ops)`가 찍히고 10초 뒤 timeout으로 끝난다(exit 124). 출력을 devlog에 붙인다.

- [ ] **Step 10: 기록과 커밋**

`docs/decisions/0013-BullMQ-큐-구성과-Redis를-쓰는-이유.md`:
- 상황: 배송 중 운송장을 주기적으로 조회해야 한다. 택배사마다 호출 한도가 다르고(번개 429), 워커를 여러 개 띄워도 같은 운송장을 동시에 두 번 조회하면 안 된다.
- 왜 Redis인가(MySQL이 아니라, CLAUDE.md 원칙): 작업 큐는 "꺼내기 + 잠금 + 재시도 예약 + 속도 제한"을 여러 프로세스가 동시에 한다. MySQL 테이블 큐(`SELECT … FOR UPDATE SKIP LOCKED` 폴링)로도 되지만 지연 재시도·속도 제한·완료 정리를 직접 만들어야 한다. BullMQ(Redis)는 이것을 원자적 Lua 스크립트로 제공하고, 데이터는 잃어도 다시 만들 수 있는 job뿐이다(원본 상태는 MySQL의 Shipment·OutboxEvent에 있다). Redis는 AOF·noeviction으로 띄웠다.
- 선택지(큐 구성):
  1. 큐 하나 + job 이름으로 택배사 구분: limiter가 큐 단위라 택배사별 한도를 따로 줄 수 없다.
  2. 택배사별 큐(`track-bungae`, `track-neurimbo`) + 주기 sweep 큐 + outbox 큐: 택배사마다 limiter·동시 처리 수를 따로 정한다. limiter는 Redis에 저장돼 워커 프로세스가 여러 개여도 큐 전체 합산 속도로 묶인다.
  3. BullMQ group limiter(Pro 기능): 쓰지 않는다.
- 결정: 2.
- jobId 규칙: `track-<shipmentId>`. 같은 jobId의 job이 있으면 add가 무시되어 같은 운송장이 동시에 두 번 처리되지 않는다. **`:`는 jobId에 쓸 수 없다**(add가 에러, 사전 검증). 완료·최종 실패 job이 남아 있으면 다음 sweep이 같은 jobId를 못 넣으므로 `removeOnComplete: true`, `removeOnFail: true`. 실패 기록은 SyncRun이 대신한다.
- 테스트 격리: 큐 접두사를 테스트 파일마다 다르게(`test-<pid>-<시각>`), 워커를 쓰는 파일은 `obliterate`, globalSetup이 `test-*`를 지운다. 개발 서버는 `terminal-ops`.
- 결과·대가: Redis가 없으면 API 테스트 전부가 돌지 않는다(큐 모듈이 기본 모듈). sweep 간격 동안은 배송 완료가 늦게 반영된다(기본 30초).
- 다시 볼 조건: 운송장이 수만 건이 되면 sweep 한 번에 전부 넣지 않고 last_synced_at 순으로 나눠 넣는다.

`docs/decisions/0014-배송-완료-반영-규칙과-재시도.md`:
- 상황: 배송 완료 이벤트는 여러 번 온다(중복, 재조회). 운영자가 먼저 손으로 DELIVERED를 찍을 수도 있다. 택배사 오류는 종류에 따라 다시 하면 되는 것과 안 되는 것이 있다.
- 결정 1 (no-op): 운송장이 이미 DELIVERED면 아무것도 안 한다. 단말기가 SHIPPED가 아니면(이미 DELIVERED 이후) 단말기는 건드리지 않고 운송장만 완료한다. 이유를 SyncRun.detail에 남긴다. 버린 안: InvalidTransition으로 실패 처리 → 운송장이 IN_TRANSIT로 남아 sweep마다 영원히 실패한다.
- 결정 2 (재시도 분류): 429·5xx·타임아웃·낙관적 락 충돌·데드락 → 던져서 재시도(최대 5회). 4xx·형식 오류·규칙 위반·단말기 없음 → `UnrecoverableError`로 바꿔 재시도 안 함.
- 결정 3 (백오프): 커스텀 백오프 'carrier' — 429면 Retry-After(최소 500ms), 그 밖에는 500ms·1s·2s·4s. 버린 안: 큐 전체를 멈추는 `worker.rateLimit()` → 한 택배사의 429가 정상 운송장까지 멈춘다. 지금 규모에서는 job별 백오프로 충분하다(실험 0004에서 잰다).
- 결정 4 (적재 순서): 이벤트 INSERT는 트랜잭션 없이 문장마다 자동 커밋으로 먼저 끝내고, 배송 완료 트랜잭션은 그 뒤에 따로 연다. 배송 완료 트랜잭션 안에서는 전이(단말기 UPDATE)가 먼저, 운송장 UPDATE가 나중이다. carrier_event INSERT가 같은 트랜잭션에 있으면 shipment 행에 S 락을 쥔 채 UPDATE하게 되어 Day 1과 같은 S→X 문제가 생길 수 있다.
- 결과·대가: 이벤트는 저장됐는데 배송 완료 트랜잭션이 실패하면(충돌) 다음 시도에서 이벤트는 "이미 있음"으로 건너뛰고 DELIVERED 이벤트로 다시 반영을 시도한다(응답 전체에서 DELIVERED를 찾기 때문). 워커 actor는 `system:carrier-sync`.

`docs/decisions/0015-실행-모드-워커와-스케줄러.md`:
- 상황: API 서버, 워커, 주기 작업을 한 프로세스에서도, 따로도 띄울 수 있어야 한다(워커 2개 실험). 테스트는 주기 작업 없이 sweep을 직접 불러야 결과가 결정적이다.
- 선택지:
  1. 환경변수를 모듈 import 시점에 읽어 `@Module.imports`를 정한다: 테스트 파일마다 다르게 하기 어렵다.
  2. `AppModule.forRoot({ workers, schedulers })` 동적 모듈 + 진입점 2개(`main.ts`는 `RUN_WORKERS`·`RUN_SCHEDULERS`, `worker.ts`는 HTTP 없이 워커 전용): 테스트는 `createTestApp({ workers })`로 고른다.
- 결정: 2. 테스트에서는 스케줄러를 항상 끈다. job scheduler는 id가 같으면 하나만 남아서, 스케줄러를 켠 프로세스가 여러 개여도 주기 작업은 하나다.
- 결과·대가: `imports: [AppModule]`(Day 1 health 테스트)은 워커·스케줄러 없이 뜬다.

`docs/study/backlog.md`에 추가:
```
- [ ] BullMQ jobId 중복 방지와 removeOnComplete — 완료된 job이 남아 있으면 같은 jobId를 다시 못 넣는 이유 (decisions/0013)
- [ ] BullMQ limiter가 큐 단위(Redis)라 워커 여러 개의 합산 속도가 제한되는 방식 (decisions/0013)
- [ ] BullMQ job scheduler(upsertJobScheduler) vs 예전 repeat 옵션 (scheduler.service.ts)
- [ ] 커스텀 backoffStrategy와 UnrecoverableError (retry-policy.ts)
- [ ] 워커에는 RequestContext가 없다 — em.fork()로 작업 단위를 나누는 이유 (carrier-sync.service.ts)
- [ ] em.insert(UoW 밖 단건 INSERT)와 em.create+flush의 차이 (carrier-sync.service.ts)
- [ ] Nest 동적 모듈(forRoot)과 정적 @Module 메타데이터가 합쳐지는 방식 (app.module.ts)
```

devlog 항목. 커밋:
```bash
git add apps/api docs
git commit -m "feat(F3): BullMQ 택배 추적 자동 수집과 실행 모드" -m "Refs: docs/decisions/0013-BullMQ-큐-구성과-Redis를-쓰는-이유.md, docs/decisions/0014-배송-완료-반영-규칙과-재시도.md, docs/decisions/0015-실행-모드-워커와-스케줄러.md"
```

---

### Task 8: Outbox 알림 — 같은 트랜잭션 기록, SKIP LOCKED relay, 톡톡 전송 (F5)

**Files:**
- Create: `apps/api/src/outbox/outbox-event.entity.ts`, `toktok.client.ts`, `outbox.service.ts`, `outbox.processor.ts`, `outbox.module.ts`
- Modify: `apps/api/src/terminal/transition.service.ts`, `apps/api/src/queue/queue-names.ts`, `apps/api/src/workers/workers.module.ts`, `apps/api/src/scheduler/scheduler.service.ts`, `apps/api/src/app.module.ts`, `apps/api/src/entities.ts`
- Create: `apps/api/src/migrations/Migration<시각>.ts` (생성 명령으로)
- Test: `apps/api/test/outbox.e2e.spec.ts`
- Record: `docs/decisions/0016-Outbox-최소-한-번과-멱등키.md`, devlog

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/outbox.e2e.spec.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxEvent, OutboxStatus } from '../src/outbox/outbox-event.entity.js';
import { OutboxService } from '../src/outbox/outbox.service.js';
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
    // 한 번에 5건씩 잡는 relay 4개를 동시에 돌린다. SKIP LOCKED가 없으면 같은 행을 기다리거나 두 번 잡는다.
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
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/outbox.e2e.spec.ts`
Expected: FAIL, `../src/outbox/outbox-event.entity.js` import 오류

- [ ] **Step 3: 엔티티와 톡톡 클라이언트**

`apps/api/src/outbox/outbox-event.entity.ts`:
```ts
import { OptionalProps } from '@mikro-orm/core';
import { Entity, Enum, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

export enum OutboxStatus {
  PENDING = 'PENDING', // 기록됨, 아직 큐에 안 넣음
  QUEUED = 'QUEUED', // 알림 job을 큐에 넣음
  SENT = 'SENT', // 메신저가 200을 줌
  FAILED = 'FAILED', // 재시도를 다 써도 실패
}

export const OUTBOX_TYPE = {
  TERMINAL_STATUS_CHANGED: 'terminal.status_changed',
} as const;

/**
 * 보낼 알림. 상태 변경과 같은 트랜잭션에서 기록하고(유실 없음), relay가 나중에 큐로 옮긴다(decisions/0016).
 * 외래키를 두지 않는다 — 부모 행 락을 잡지 않고, 단말기를 지워도 알림 기록은 남게 하기 위해서다.
 */
@Entity({ tableName: 'outbox_event' })
@Index({ properties: ['status', 'id'] })
export class OutboxEvent {
  [OptionalProps]?: 'status' | 'attempts' | 'createdAt';

  @PrimaryKey()
  id!: number;

  @Property({ length: 50 })
  type!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Enum({ items: () => OutboxStatus })
  status: OutboxStatus = OutboxStatus.PENDING;

  /** 전송 시도 횟수 */
  @Property()
  attempts: number = 0;

  @Property({ length: 500, nullable: true })
  lastError?: string | null;

  @Property()
  createdAt: Date = new Date();

  // 유니온 타입(Date | null)은 데코레이터 메타데이터가 Object라 type을 꼭 적는다(varchar(255)가 되는 것을 막는다).
  @Property({ type: 'datetime', nullable: true })
  sentAt?: Date | null;
}
```

`apps/api/src/outbox/toktok.client.ts`:
```ts
import { partnerFetch } from '../common/partner-http.js';

export interface ToktokOptions {
  baseUrl: string;
  channel: string;
  timeoutMs: number;
}

/** 톡톡메신저 웹훅. 같은 idempotencyKey를 다시 보내도 메신저가 한 번으로 보이게 하는 것이 약속이다(가상). */
export class ToktokClient {
  constructor(private readonly opts: ToktokOptions) {}

  async send(message: { idempotencyKey: string; text: string }): Promise<void> {
    await partnerFetch(
      '톡톡메신저',
      `${this.opts.baseUrl}/toktok/hooks/${encodeURIComponent(this.opts.channel)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(message) },
      this.opts.timeoutMs,
    );
  }
}
```

`apps/api/src/entities.ts`:
```ts
import { TerminalModel } from './terminal/terminal-model.entity.js';
import { Terminal } from './terminal/terminal.entity.js';
import { TerminalStatusHistory } from './terminal/terminal-status-history.entity.js';
import { InspectionItem } from './inspection/inspection-item.entity.js';
import { Inspection, InspectionResult } from './inspection/inspection.entities.js';
import { Merchant } from './merchant/merchant.entity.js';
import { CarrierEvent, Shipment, SyncRun } from './shipment/shipment.entities.js';
import { OutboxEvent } from './outbox/outbox-event.entity.js';

/** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent];
```

- [ ] **Step 4: 전이·등록과 같은 트랜잭션에 Outbox 기록**

`apps/api/src/terminal/transition.service.ts` 전체(`recordOutbox` 추가, `transition()`과 `recordRegistration()`에서 호출):
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
  recordRegistration(terminal: Terminal, actor: string, source: TransitionSource, em: EntityManager): TerminalStatusHistory {
    const reason = '신규 등록';
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

- [ ] **Step 5: relay·notify, 프로세서, 모듈 연결**

`apps/api/src/queue/queue-names.ts`:
```ts
/** BullMQ 큐 이름. 택배사마다 호출 한도가 달라 추적 큐를 따로 둔다(decisions/0013). */
export const QUEUE = {
  TRACK_BUNGAE: 'track-bungae',
  TRACK_NEURIMBO: 'track-neurimbo',
  CARRIER_SWEEP: 'carrier-sweep',
  OUTBOX: 'outbox',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export const ALL_QUEUES: QueueName[] = Object.values(QUEUE);
```

`apps/api/src/outbox/outbox.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { UnrecoverableError, type JobsOptions, type Queue } from 'bullmq';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
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

  async relay(limit = 100): Promise<{ queued: number[] }> {
    const queued = await this.em.fork().transactional(async (tx) => {
      const rows = await tx.find(
        OutboxEvent,
        { status: OutboxStatus.PENDING },
        { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, limit, orderBy: { id: 'asc' } },
      );
      for (const row of rows) {
        // jobId가 같으면 BullMQ가 한 번만 받는다. 커밋 전에 죽어 이 행이 다시 relay돼도 job이 남아 있으면 중복으로 들어가지 않는다.
        await this.queue.add('notify', { outboxId: row.id }, { ...NOTIFY_JOB_OPTIONS, jobId: idempotencyKeyOf(row.id) });
        row.status = OutboxStatus.QUEUED;
      }
      return rows.map((r) => r.id);
    });
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

`apps/api/src/outbox/outbox.processor.ts`:
```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { QUEUE } from '../queue/queue-names.js';
import { OutboxService, type NotifyJobData } from './outbox.service.js';

/** outbox 큐: relay(주기 실행)와 notify(행마다) 두 종류의 job을 처리한다. */
@Processor(QUEUE.OUTBOX, { concurrency: 5 })
export class OutboxProcessor extends WorkerHost {
  constructor(private readonly outbox: OutboxService) {
    super();
  }

  async process(job: Job<NotifyJobData | Record<string, never>>) {
    if (job.name === 'relay') return this.outbox.relay();
    if (job.name === 'notify') {
      // attemptsMade는 이번 시도 전까지 실패한 횟수다. 이번이 마지막 시도면 실패 시 FAILED로 남긴다.
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      return this.outbox.notify((job.data as NotifyJobData).outboxId, { lastAttempt });
    }
    throw new UnrecoverableError(`모르는 outbox job: ${job.name}`);
  }
}
```

`apps/api/src/outbox/outbox.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { env } from '../config/env.js';
import { OutboxService } from './outbox.service.js';
import { ToktokClient } from './toktok.client.js';

@Module({
  providers: [
    OutboxService,
    {
      provide: ToktokClient,
      useFactory: () => new ToktokClient({ baseUrl: env.partnersUrl, channel: env.toktokChannel, timeoutMs: env.partnerTimeoutMs }),
    },
  ],
  exports: [OutboxService],
})
export class OutboxModule {}
```

`apps/api/src/workers/workers.module.ts`:
```ts
import { Module } from '@nestjs/common';
import {
  BungaeTrackProcessor,
  CarrierSweepProcessor,
  NeurimboTrackProcessor,
} from '../carrier-sync/carrier-sync.processors.js';
import { CarrierSyncModule } from '../carrier-sync/carrier-sync.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { OutboxProcessor } from '../outbox/outbox.processor.js';

/** 큐 job을 처리하는 프로세서들. RUN_WORKERS=1인 프로세스에만 넣는다(decisions/0015). */
@Module({
  imports: [CarrierSyncModule, OutboxModule],
  providers: [BungaeTrackProcessor, NeurimboTrackProcessor, CarrierSweepProcessor, OutboxProcessor],
})
export class WorkersModule {}
```

`apps/api/src/scheduler/scheduler.service.ts`:
```ts
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { QUEUE } from '../queue/queue-names.js';

/**
 * 주기 작업 등록. BullMQ job scheduler는 Redis에 한 개만 저장되므로(같은 id면 덮어씀)
 * 이 서비스가 여러 프로세스에서 떠도 주기 작업은 하나다.
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @InjectQueue(QUEUE.CARRIER_SWEEP) private readonly sweepQueue: Queue,
    @InjectQueue(QUEUE.OUTBOX) private readonly outboxQueue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.sweepQueue.upsertJobScheduler(
      'carrier-sweep',
      { every: env.sweepIntervalMs },
      { name: 'sweep', data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
    await this.outboxQueue.upsertJobScheduler(
      'outbox-relay',
      { every: env.relayIntervalMs },
      { name: 'relay', data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
    );
    this.logger.log(`주기 작업 등록: carrier-sweep ${env.sweepIntervalMs}ms, outbox-relay ${env.relayIntervalMs}ms`);
  }
}
```

`apps/api/src/app.module.ts`:
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

- [ ] **Step 6: 통과 확인**

Run:
```bash
npx vitest run && npm run typecheck
for i in 1 2 3; do npx vitest run test/outbox.e2e.spec.ts --silent=false 2>&1 | grep -E "\[relay 동시\]|Tests |FAIL"; done
```
Expected: 14개 파일 `108 passed`, typecheck exit 0. relay 동시 줄은 각 relay가 잡은 수의 합이 20이고 겹침이 없다(사전 검증: `[5,5,5,5]`). 3회 출력을 devlog에 적는다. Day 1 동시성 테스트(실험 A·B·C)도 여전히 통과해야 한다 — outbox_event에 FK가 없어 새 S 락이 생기지 않는다.

- [ ] **Step 7: 마이그레이션**

Run: `npm run db:migration:create`
Expected: 생성된 up()이 다음과 같다(`sent_at`이 `datetime null`인지 본다).
```ts
    this.addSql(`create table \`outbox_event\` (\`id\` int unsigned not null auto_increment primary key, \`type\` varchar(50) not null, \`payload\` json not null, \`status\` enum('PENDING','QUEUED','SENT','FAILED') not null default 'PENDING', \`attempts\` int not null default 0, \`last_error\` varchar(500) null, \`created_at\` datetime not null, \`sent_at\` datetime null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`outbox_event\` add index \`outbox_event_status_id_index\` (\`status\`, \`id\`);`);
```
Run:
```bash
npm run db:migrate
npm run db:migration:check
```
Expected: `적용: Migration<시각>`, `최신 상태`

- [ ] **Step 8: 기록과 커밋**

`docs/decisions/0016-Outbox-최소-한-번과-멱등키.md`:
- 상황: 상태가 바뀌면 메신저로 알려야 한다(F5, "유실·중복 없이"). 전이 트랜잭션 안에서 메신저를 부르면 메신저가 느릴 때 락을 오래 잡고, 커밋 후에 부르면 그 사이 프로세스가 죽을 때 알림이 사라진다.
- 선택지:
  1. 커밋 후 바로 HTTP 호출: 단순하지만 유실된다.
  2. 커밋 후 바로 큐에 add: Redis add 전에 죽으면 유실된다(DB와 Redis는 한 트랜잭션이 아니다).
  3. Outbox: 같은 트랜잭션에 `outbox_event(PENDING)`를 기록하고, relay가 나중에 큐로 옮긴다. 커밋됐으면 알림 기록도 반드시 있다.
- 결정: 3.
- relay: `FOR UPDATE SKIP LOCKED`(MikroORM `LockMode.PESSIMISTIC_PARTIAL_WRITE`)로 PENDING을 최대 N건 잠그고 notify job(`jobId: outbox-<id>`)을 넣은 뒤 QUEUED로 바꾼다. relay 여러 개가 같은 행을 잡지 않는다(테스트로 확인). Redis add 뒤 커밋 전에 죽으면 행은 PENDING으로 남아 다시 relay되지만, job이 아직 있으면 jobId가 같아 중복으로 들어가지 않는다.
- 보장 수준: **최소 한 번 + 멱등키**. 메신저가 받은 뒤 SENT를 쓰기 전에 죽으면 다시 보낸다. 메신저가 `idempotencyKey`로 걸러야 "한 번"이 된다. 정확히 한 번이라고 쓰지 않는다.
- FK를 두지 않은 이유: outbox INSERT가 단말기 행에 S 락을 걸지 않게(UPDATE 먼저 규칙과 무관해진다), 알림 기록이 단말기 삭제와 묶이지 않게.
- 결과·대가: 알림이 relay 간격만큼 늦다(기본 2초). QUEUED인데 job이 사라진 행(Redis 유실)은 지금은 다시 보내지 않는다 → 워커 강제 종료 실험(Day 7)에서 복구 sweep을 정한다.
- 다시 볼 조건: 알림 종류가 늘면 type별 채널·문구를 분리한다.

`docs/study/backlog.md`에 추가:
```
- [ ] SELECT … FOR UPDATE SKIP LOCKED — 여러 relay가 행을 나눠 갖는 방식 (decisions/0016)
- [ ] at-least-once와 멱등키, exactly-once가 어려운 이유 (decisions/0016)
```

devlog 항목. 커밋:
```bash
git add apps/api docs
git commit -m "feat(F5): Outbox 알림과 톡톡메신저 전송" -m "Refs: docs/decisions/0016-Outbox-최소-한-번과-멱등키.md"
```

---

### Task 9: 실험 0003(번개 중복 이벤트)·0004(429 비율) (F3, F12)

**Files:**
- Modify: `apps/api/vitest.config.ts` (실험은 EXPERIMENTS=1일 때만)
- Create: `apps/api/test/helpers/experiment.ts`, `apps/api/test/experiments/carrier-duplicates.spec.ts`, `apps/api/test/experiments/carrier-429.spec.ts`
- Record: `docs/experiments/0003-번개택배-중복-이벤트.md`, `docs/experiments/0004-번개택배-429-비율별-수집.md`, devlog

실험은 숫자를 재는 것이 목적이라 TDD 순서 대신 "스펙 작성 → 기본 실행에서 빠지는지 확인 → 실행 → 원본 출력 기록"으로 한다. 단언은 불변식(중복 반영 0)만 건다. **숫자는 실제로 잰 값만 적는다.**

- [ ] **Step 1: 실험을 기본 테스트에서 분리**

`apps/api/vitest.config.ts`:
```ts
import swc from 'unplugin-swc';
import { configDefaults, defineConfig } from 'vitest/config';

// 실험(test/experiments)은 오래 걸리므로 EXPERIMENTS=1일 때만, 그때는 실험만 돈다.
const experiments = process.env.EXPERIMENTS === '1';

export default defineConfig({
  test: {
    include: experiments ? ['test/experiments/**/*.spec.ts'] : ['test/**/*.spec.ts'],
    exclude: experiments ? configDefaults.exclude : [...configDefaults.exclude, 'test/experiments/**'],
    // e2e 테스트가 같은 테스트 DB·같은 partners 서버를 쓰므로 파일 단위 병렬 실행을 끈다.
    fileParallelism: false,
    // 가상 업체 서버를 빌드해 띄운다(테스트 포트 4011, 개발용 4010과 겹치지 않게).
    globalSetup: ['test/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      PARTNERS_URL: 'http://127.0.0.1:4011',
      RUN_SCHEDULERS: '0',
    },
  },
  // swc가 데코레이터 메타데이터를 만들어야 Nest DI가 동작한다.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
```

- [ ] **Step 2: 실험 헬퍼와 스펙**

`apps/api/test/helpers/experiment.ts`:
```ts
import { Shipment, ShipmentStatus, SyncRun } from '../../src/shipment/shipment.entities.js';
import { prepareShipped } from './scenario.js';
import type { TestApp } from './test-app.js';

/** 실험용 출고 N건을 만든다(시리얼: <prefix>-0001 …). */
export async function prepareMany(t: TestApp, prefix: string, n: number, carrier: 'BUNGAE' | 'NEURIMBO') {
  const shipments = [];
  for (let i = 1; i <= n; i++) shipments.push(await prepareShipped(t, `${prefix}-${String(i).padStart(4, '0')}`, carrier));
  return shipments;
}

export function countInTransit(t: TestApp): Promise<number> {
  return t.orm.em.fork().count(Shipment, { status: ShipmentStatus.IN_TRANSIT });
}

/** 단말기 하나에 DELIVERED 이력이 가장 많이 붙은 수. 1이어야 중복 반영이 없는 것이다. */
export async function maxDeliveredPerTerminal(t: TestApp): Promise<number> {
  const rows: { m: number | string | null }[] = await t.orm.em
    .fork()
    .execute(
      "select max(c) as m from (select count(*) as c from terminal_status_history where to_status = 'DELIVERED' group by terminal_id) x",
    );
  return Number(rows[0]?.m ?? 0);
}

/** SyncRun 합계(실험 기록용) */
export async function syncRunTotals(t: TestApp) {
  const runs = await t.orm.em.fork().find(SyncRun, {});
  const sum = (f: (r: SyncRun) => number) => runs.reduce((acc, r) => acc + f(r), 0);
  const byOutcome: Record<string, number> = {};
  const byWorker: Record<string, number> = {};
  for (const r of runs) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    byWorker[r.worker] = (byWorker[r.worker] ?? 0) + 1;
  }
  return {
    runs: runs.length,
    fetched: sum((r) => r.fetched),
    inserted: sum((r) => r.inserted),
    duplicated: sum((r) => r.duplicated),
    maxAttempt: runs.reduce((m, r) => Math.max(m, r.attempt), 0),
    exhausted: runs.filter((r) => r.outcome === 'ERROR' && r.attempt >= 5).length,
    byOutcome,
    byWorker,
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

`apps/api/test/experiments/carrier-duplicates.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CarrierSyncService } from '../../src/carrier-sync/carrier-sync.service.js';
import { CarrierEvent } from '../../src/shipment/shipment.entities.js';
import { TerminalStatusHistory } from '../../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus } from '../../src/terminal/terminal-status.js';
import { countInTransit, maxDeliveredPerTerminal, prepareMany, syncRunTotals } from '../helpers/experiment.js';
import { partners } from '../helpers/partners.js';
import { resetQueues, waitForQueuesIdle } from '../helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

// experiments/0003. 실행: EXPERIMENTS=1 npx vitest run test/experiments/carrier-duplicates.spec.ts
const N = Number(process.env.EXP_N ?? 30);
const DUPLICATE_RATE = Number(process.env.EXP_DUP ?? 0.3);

describe(`실험 0003: 번개택배 중복 이벤트 (duplicateRate=${DUPLICATE_RATE}, 운송장 ${N}건)`, () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ workers: true });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    await partners.reset();
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it('중복 반영 0건: 이벤트는 운송장당 4개, DELIVERED 이력은 단말기당 1개', async () => {
    await prepareMany(t, 'EXP3', N, 'BUNGAE');
    await partners.configure({ seed: 3, bungae: { duplicateRate: DUPLICATE_RATE } });
    const sync = t.app.get(CarrierSyncService);

    const started = performance.now();
    let rounds = 0;
    while ((await countInTransit(t)) > 0 && rounds < 10) {
      await sync.sweep();
      await waitForQueuesIdle(t.app, 60_000);
      rounds += 1;
    }
    const elapsed = Math.round(performance.now() - started);

    const em = t.orm.em.fork();
    const events = await em.count(CarrierEvent);
    const delivered = await em.count(TerminalStatusHistory, { toStatus: TerminalStatus.DELIVERED });
    const maxPerTerminal = await maxDeliveredPerTerminal(t);
    const runs = await syncRunTotals(t);
    const stats = await partners.stats();
    // 조회 k번째 응답에는 서로 다른 이벤트가 k개 있다(1+2+3+4 = 10개/운송장). 그보다 많이 받은 만큼이 응답 안의 중복이다.
    const inResponseDuplicates = runs.fetched - 10 * N;
    console.log(
      `[실험 0003] N=${N} dup=${DUPLICATE_RATE} sweep=${rounds}회 조회=${stats.calls['bungae.track']} ` +
        `받은이벤트=${runs.fetched} 응답안중복=${inResponseDuplicates} 저장=${runs.inserted} 건너뜀=${runs.duplicated} ` +
        `carrier_event=${events} DELIVERED이력=${delivered} 단말기당최대=${maxPerTerminal} 결과=${JSON.stringify(runs.byOutcome)} 소요=${elapsed}ms`,
    );

    expect(events).toBe(N * 4);
    expect(runs.inserted).toBe(N * 4);
    expect(delivered).toBe(N);
    expect(maxPerTerminal).toBe(1);
    expect(inResponseDuplicates).toBeGreaterThan(0); // 골칫거리가 실제로 일어났는지
  }, 180_000);
});
```

`apps/api/test/experiments/carrier-429.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CarrierSyncService } from '../../src/carrier-sync/carrier-sync.service.js';
import { countInTransit, maxDeliveredPerTerminal, prepareMany, sleep, syncRunTotals } from '../helpers/experiment.js';
import { partners } from '../helpers/partners.js';
import { resetQueues, waitForQueuesIdle } from '../helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

// experiments/0004. 실행: EXPERIMENTS=1 npx vitest run test/experiments/carrier-429.spec.ts
const N = Number(process.env.EXP_N ?? 30);
const RATES = (process.env.EXP_RATES ?? '0.1,0.3,0.5').split(',').map(Number);
const SWEEP_EVERY_MS = 500; // 스케줄러 대신 테스트가 이 간격으로 sweep한다
const LIMIT_MS = 120_000; // 이 시간 안에 못 끝나면 미완료로 센다

describe(`실험 0004: 번개택배 429 비율별 수집 (운송장 ${N}건, 비율 ${RATES.join('/')})`, () => {
  let t: TestApp;
  const table: string[] = [];

  beforeAll(async () => {
    t = await createTestApp({ workers: true });
  });
  afterAll(async () => {
    console.log(['[실험 0004 요약]', '| 429 비율 | 완료 | 소요(ms) | 조회 | 429 | 재시도(ERROR 실행) | 재시도 소진 | 최대 시도 |', '|---|---|---|---|---|---|---|---|', ...table].join('\n'));
    await resetQueues(t.app);
    await t.app.close();
  });

  for (const rate of RATES) {
    it(`429 비율 ${rate * 100}%`, async () => {
      await resetDatabase(t.orm);
      await resetQueues(t.app);
      await partners.reset();
      await prepareMany(t, `EXP4-${rate * 100}`, N, 'BUNGAE');
      await partners.configure({ seed: 4, bungae: { force429Rate: rate, retryAfterSec: 1 } });
      const sync = t.app.get(CarrierSyncService);

      const started = performance.now();
      const deadline = Date.now() + LIMIT_MS;
      while ((await countInTransit(t)) > 0 && Date.now() < deadline) {
        await sync.sweep();
        await sleep(SWEEP_EVERY_MS);
      }
      const elapsed = Math.round(performance.now() - started);
      const remaining = await countInTransit(t);
      await waitForQueuesIdle(t.app, 30_000);

      const runs = await syncRunTotals(t);
      const stats = await partners.stats();
      const row = `| ${rate * 100}% | ${N - remaining}/${N} | ${elapsed} | ${stats.calls['bungae.track']} | ${stats.status429} | ${runs.byOutcome.ERROR ?? 0} | ${runs.exhausted} | ${runs.maxAttempt} |`;
      table.push(row);
      console.log(`[실험 0004] rate=${rate} ${row} 결과=${JSON.stringify(runs.byOutcome)}`);

      expect(await maxDeliveredPerTerminal(t)).toBeLessThanOrEqual(1); // 몇 번을 재시도해도 중복 반영은 없어야 한다
    }, LIMIT_MS + 120_000);
  }
});
```

- [ ] **Step 3: 기본 실행에서 빠지는지 확인**

Run: `npx vitest run && npm run typecheck`
Expected: 여전히 14개 파일 `108 passed`(실험 파일은 목록에 없다), typecheck exit 0

- [ ] **Step 4: 실험 0003 실행 (3회)**

Run:
```bash
for i in 1 2 3; do EXPERIMENTS=1 npx vitest run test/experiments/carrier-duplicates.spec.ts --silent=false 2>&1 | grep -E "\[실험 0003\]|Tests |FAIL"; done
```
Expected: 3회 모두 `1 passed`. `[실험 0003]` 줄에 `carrier_event=120 DELIVERED이력=30 단말기당최대=1`, `응답안중복`이 0보다 크다. 나머지 숫자(조회 수, 받은 이벤트, 건너뜀, 소요)는 그대로 기록한다. (참고: 사전 검증 1회는 sweep 4회, 조회 120, 소요 약 11초 — 우리 쪽 limiter 초당 10이 병목. 이 값은 기록하지 말고 직접 잰 값을 쓴다.)

- [ ] **Step 5: 실험 0004 실행**

Run:
```bash
EXPERIMENTS=1 npx vitest run test/experiments/carrier-429.spec.ts --silent=false 2>&1 | grep -E "\[실험 0004|^\||Tests |FAIL"
```
Expected: `3 passed`(1~2분). 마지막에 `[실험 0004 요약]` 표가 출력된다. 시간이 되면 한 번 더 돌려 두 번의 표를 모두 기록한다.

- [ ] **Step 6: 기록**

`docs/experiments/0003-번개택배-중복-이벤트.md` (Day 1 실험 기록과 같은 형식):
- 날짜 / 관련 기능: 2026-10-22 / F3, F12
- 질문: 번개택배가 이벤트를 30% 확률로 두 번 보낼 때, 우리 DB에 같은 이벤트가 두 번 저장되거나 배송 완료가 두 번 반영되는가?
- 설정: partners `seed=3, bungae.duplicateRate=0.3, advancePerPoll=1`(조회 4번째에 DELIVERED), 운송장 N=30, 워커 1개 프로세스(테스트 앱 안), `track-bungae` limiter 초당 10·동시 5, sweep → 큐가 빌 때까지 대기를 반복
- 재현(`apps/api`): Step 4 명령
- 결과: `[실험 0003]` 원본 3줄을 붙이고 표로 옮긴다(회차, sweep 수, 조회, 받은 이벤트, 응답 안 중복, 저장, 건너뜀, carrier_event, DELIVERED 이력, 단말기당 최대, 소요)
- 결론: 중복 반영 여부를 숫자로 한 줄. 중복을 막은 장치 3단(응답 안 eventKey 중복 제거 → 이미 저장된 키 조회 → unique 제약)을 적고, 이번 실험에서는 unique 위반(경쟁)이 일어날 수 없는 이유(같은 운송장 job은 jobId로 하나뿐)를 적는다.
- 한계: 워커 1개, 같은 운송장 동시 처리 없음 → 0005에서 워커 2개. 실제 택배사의 중복 패턴(재전송 지연 등)은 흉내 내지 않았다.

`docs/experiments/0004-번개택배-429-비율별-수집.md`:
- 질문: 번개택배가 429를 10/30/50% 비율로 줄 때 수집이 끝나는가, 얼마나 걸리고 몇 번 더 부르는가?
- 설정: `seed=4, force429Rate ∈ {0.1, 0.3, 0.5}, retryAfterSec=1`, 운송장 30, sweep 500ms 간격(스케줄러 대신 테스트 루프), 제한 시간 120초, 재시도 최대 5회(429는 Retry-After, 그 외 500ms 지수), limiter 초당 10
- 재현: Step 5 명령
- 결과: 요약 표(429 비율, 완료, 소요, 조회, 429, 재시도(ERROR 실행), 재시도 소진, 최대 시도) 원본 그대로 + 비율별 `[실험 0004]` 줄
- 결론: 비율이 오를 때 시간·호출이 어떻게 느는지, "재시도 소진"이 있으면 그 운송장이 다음 sweep에서 다시 들어가 결국 끝났는지(완료 수로 확인).
- 한계: 429를 확률로만 냈다(실제는 시간대·버스트). 우리 limiter(초당 10)가 partners 한도(초당 20)보다 낮아 "진짜 한도 초과 429"는 재지 않았다. Retry-After 1초 고정.

`docs/study/backlog.md`에 추가:
```
- [ ] 재시도 폭주(retry storm)와 지터 — 429가 많을 때 백오프에 jitter를 넣는 이유 (experiments/0004)
```

- [ ] **Step 7: 커밋**

devlog 항목(실험 결론 한 줄씩). 커밋:
```bash
git add apps/api docs
git commit -m "exp(F3): 번개택배 중복 이벤트·429 비율 실험" -m "Refs: docs/experiments/0003-번개택배-중복-이벤트.md, docs/experiments/0004-번개택배-429-비율별-수집.md"
```

---

### Task 10: 실험 0005 — 워커 프로세스 2개 (F3, F5)

**Files:**
- Create: `apps/api/test/experiments/two-workers.spec.ts`
- Record: `docs/experiments/0005-워커-프로세스-2개.md`, devlog

테스트 프로세스는 job을 넣기만 하고(`createTestApp({ workers: false })`), 처리는 `node dist/worker.js` 자식 프로세스 2개(`WORKER_NAME=w1`, `w2`)가 한다. 자식은 테스트와 같은 큐 접두사(`QUEUE_PREFIX`)와 테스트 DB(`NODE_ENV=test`)를 쓴다. 번개 응답을 100ms 늦춰 두 워커가 같은 운송장을 겹쳐 조회할 기회를 넓힌다.

- [ ] **Step 1: 실험 스펙**

`apps/api/test/experiments/two-workers.spec.ts`:
```ts
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CarrierSyncService } from '../../src/carrier-sync/carrier-sync.service.js';
import { env } from '../../src/config/env.js';
import { OutboxEvent, OutboxStatus } from '../../src/outbox/outbox-event.entity.js';
import { OutboxService } from '../../src/outbox/outbox.service.js';
import { countInTransit, maxDeliveredPerTerminal, prepareMany, sleep, syncRunTotals } from '../helpers/experiment.js';
import { partners } from '../helpers/partners.js';
import { resetQueues, waitForQueuesIdle } from '../helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

// experiments/0005. 실행: npm run build && EXPERIMENTS=1 npx vitest run test/experiments/two-workers.spec.ts
const N = Number(process.env.EXP_N ?? 30);
const WORKER_JS = resolve(process.cwd(), 'dist/worker.js');

/** dist/worker.js를 자식 프로세스로 띄우고 "worker ready"가 찍힐 때까지 기다린다. 테스트와 같은 큐 접두사·테스트 DB를 쓴다. */
async function startWorker(name: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [WORKER_JS], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', QUEUE_PREFIX: env.queuePrefix, WORKER_NAME: name, RUN_SCHEDULERS: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(() => fail(new Error(`${name}가 15초 안에 준비되지 않았습니다.`)), 15_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('worker ready')) {
        clearTimeout(timer);
        ready();
      }
    });
    child.once('exit', (code) => fail(new Error(`${name}가 종료됐습니다(exit ${code}).`)));
  });
  return child;
}

describe(`실험 0005: 워커 프로세스 2개가 같은 큐를 나눠 처리 (운송장 ${N}건)`, () => {
  let t: TestApp;
  const workers: ChildProcess[] = [];

  beforeAll(async () => {
    if (!existsSync(WORKER_JS)) throw new Error('dist/worker.js가 없습니다. 먼저 npm run build 하세요.');
    // 이 테스트 프로세스는 job을 넣기만 한다(workers: false). 처리는 자식 프로세스 2개가 한다.
    t = await createTestApp({ workers: false });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    await partners.reset();
    workers.push(await startWorker('w1'), await startWorker('w2'));
  }, 60_000);
  afterAll(async () => {
    for (const w of workers) {
      if (w.exitCode === null) {
        w.kill();
        await once(w, 'exit');
      }
    }
    await resetQueues(t.app);
    await t.app.close();
  });

  it('같은 운송장 동시 조회 0, DELIVERED 이력 중복 0, 톡톡 수신 중복 수를 잰다', async () => {
    await prepareMany(t, 'EXP5', N, 'BUNGAE');
    // 응답을 늦춰 두 워커가 겹칠 기회를 넓힌다.
    await partners.configure({ seed: 5, bungae: { delayMs: 100 } });
    const sync = t.app.get(CarrierSyncService);
    const outbox = t.app.get(OutboxService);

    const started = performance.now();
    const deadline = Date.now() + 120_000;
    const pending = () => t.orm.em.fork().count(OutboxEvent, { status: { $in: [OutboxStatus.PENDING, OutboxStatus.QUEUED] } });
    while (((await countInTransit(t)) > 0 || (await pending()) > 0) && Date.now() < deadline) {
      await sync.sweep();
      await outbox.relay();
      await sleep(300);
    }
    await waitForQueuesIdle(t.app, 30_000);
    const elapsed = Math.round(performance.now() - started);

    const runs = await syncRunTotals(t);
    const stats = await partners.stats();
    const toktok = await partners.toktok();
    const duplicateKeys = Object.values(toktok.byKey).filter((n) => n > 1).length;
    const em = t.orm.em.fork();
    const outboxTotal = await em.count(OutboxEvent);
    const sent = await em.count(OutboxEvent, { status: OutboxStatus.SENT });
    console.log(
      `[실험 0005] N=${N} 워커별 실행=${JSON.stringify(runs.byWorker)} 조회=${stats.calls['bungae.track']} ` +
        `같은운송장겹침=${stats.overlaps} 동시최대=${stats.maxInFlight} DELIVERED단말기당최대=${await maxDeliveredPerTerminal(t)} ` +
        `outbox=${outboxTotal} SENT=${sent} 톡톡수신=${toktok.total} 중복수신키=${duplicateKeys} 남은배송중=${await countInTransit(t)} 소요=${elapsed}ms`,
    );

    expect(Object.keys(runs.byWorker).sort()).toEqual(['w1', 'w2']); // 두 워커가 실제로 나눠 처리했다
    expect(stats.overlaps).toBe(0);
    expect(await maxDeliveredPerTerminal(t)).toBe(1);
    expect(sent).toBe(outboxTotal);
  }, 240_000);
});
```

- [ ] **Step 2: 실행 (3회)**

Run:
```bash
npm run build
for i in 1 2 3; do EXPERIMENTS=1 npx vitest run test/experiments/two-workers.spec.ts --silent=false 2>&1 | grep -E "\[실험 0005\]|Tests |FAIL"; done
```
Expected: 3회 모두 `1 passed`. `[실험 0005]` 줄에 `워커별 실행`에 w1·w2가 둘 다 있고, `같은운송장겹침=0`, `DELIVERED단말기당최대=1`, `outbox`와 `SENT`가 같다. `중복수신키`는 잰 값을 그대로 적는다(0이 아니어도 실패가 아니다 — 최소 한 번 보장이므로).

`dist/worker.js가 없습니다`면 `npm run build`를 먼저 한다. 자식 프로세스가 `worker ready`를 안 찍고 끝나면 stderr(그대로 보인다)를 troubleshooting에 기록한다.

- [ ] **Step 3: 기록과 커밋**

`docs/experiments/0005-워커-프로세스-2개.md`:
- 질문: 워커 프로세스 2개가 같은 큐를 나눠 처리할 때 같은 운송장을 동시에 조회하거나, 배송 완료를 두 번 반영하거나, 알림을 두 번 보내는가?
- 설정: `dist/worker.js` × 2(`RUN_SCHEDULERS=0`, 각자 프로세서 concurrency 5), 테스트 프로세스는 300ms마다 sweep + relay, 운송장 30, `bungae.delayMs=100`, `seed=5`, limiter 초당 10(큐 단위라 두 워커 합산)
- 재현: Step 2 명령
- 결과: 원본 3줄 + 표(워커별 실행 수, 조회, 겹침, 동시 최대, DELIVERED 단말기당 최대, outbox 수, SENT, 톡톡 수신, 중복 수신 키, 소요)
- 결론: 겹침이 0인 이유(jobId `track-<id>`로 같은 운송장 job은 한 번에 하나), 소요 시간이 워커 1개(0003)와 비슷하거나 다르면 그 이유(limiter가 큐 단위라 워커를 늘려도 택배사 호출 속도는 그대로인지)를 숫자로 확인해 적는다.
- 한계: 워커를 강제로 죽이지 않았다(설계안 7장 "워커 강제 종료 → 알림 유실 0건"은 Day 7). 한 PC·한 Redis.

devlog 항목. 커밋:
```bash
git add apps/api docs
git commit -m "exp(F3): 워커 프로세스 2개 실험" -m "Refs: docs/experiments/0005-워커-프로세스-2개.md"
```

---

### Task 11: 2일차 마감 — 전체 검증, 실서버 확인, 기록 정리

**Files:**
- Record: `docs/devlog/2026-10-22.md`(2일차 요약), `docs/study/backlog.md`
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
Expected: partners `26 passed`. api 14개 파일 `108 passed`(개수를 기록), typecheck·build exit 0, `최신 상태`

- [ ] **Step 2: 실서버 확인 (partners + API + 워커·스케줄러 한 프로세스, 개발 DB)**

개발 DB에는 Task 5~8 마이그레이션과 가맹점 시드가 적용돼 있어야 한다(`npm run db:migrate && npm run db:seed`, 둘 다 여러 번 실행해도 된다).

Run (`apps/api`, Git Bash):
```bash
node ../partners/dist/main.js & P1=$!
SWEEP_INTERVAL_MS=1000 RELAY_INTERVAL_MS=1000 node dist/main.js & P2=$!
sleep 4
B=localhost:3000; H='Content-Type: application/json'; O='X-Operator: manual'; S=DEV-$(date +%H%M%S)
curl -s -X POST $B/terminals -H "$H" -H "$O" -d "{\"serialNo\":\"$S\",\"modelCode\":\"SN-100\"}"; echo
curl -s -X POST $B/terminals/$S/inspections -H "$H" -H "$O" -d '{"results":[{"itemCode":"POWER","passed":true},{"itemCode":"NETWORK","passed":true},{"itemCode":"CARD_READER","passed":true},{"itemCode":"PRINTER","passed":true}]}'; echo
curl -s -X POST $B/terminals/$S/transitions -H "$H" -H "$O" -d '{"to":"IN_STOCK","reason":"stock-in","expectedVersion":2}'; echo
curl -s $B/merchants; echo
curl -s -X POST $B/terminals/$S/allocations -H "$H" -H "$O" -d '{"merchantCode":"PANGYO-BUNSIK","expectedVersion":3}'; echo
SH=$(curl -s -X POST $B/shipments -H "$H" -H "$O" -d "{\"serialNo\":\"$S\",\"carrier\":\"NEURIMBO\",\"expectedVersion\":4}"); echo $SH
ID=$(echo $SH | sed 's/.*"id":\([0-9]*\).*/\1/')
sleep 8
curl -s $B/shipments/$ID; echo
curl -s $B/terminals/$S/history; echo
curl -s 127.0.0.1:4010/__admin/toktok/messages; echo
kill $P2 $P1
```
(사유는 영문으로 쓴다. Git Bash에서 `curl -d`로 보낸 한글이 깨져 저장되는 것을 사전 검증에서 봤다.)

Expected:
- 서버 로그 `workers=true, schedulers=true, queuePrefix=terminal-ops`, `주기 작업 등록: carrier-sweep 1000ms, outbox-relay 1000ms`
- 배정 응답 `merchantCode: PANGYO-BUNSIK`, 출고 응답 `trackingNo: NR…`, `terminal.status: SHIPPED`
- 8초 뒤 `GET /shipments/:id`가 `status: DELIVERED`, 이벤트 4개(PICKED_UP → DELIVERED)
- 이력 6건, 마지막은 `SHIPPED → DELIVERED`, `source: BATCH`, `actor: system:carrier-sync`
- 톡톡 수신 6건, `byKey` 값이 모두 1

출력을 devlog에 붙인다. 끝나면 3000·4010 포트에 리스너가 없는지 확인한다(`netstat -ano | grep -E ':(3000|4010) .*LISTENING'` 결과 없음). 개발 Redis의 `terminal-ops:*` job scheduler 2개는 남아 있어도 된다(다음에 서버를 띄우면 같은 id로 덮어쓴다).

- [ ] **Step 3: 하루 요약과 공부거리 정리**

devlog 맨 아래에 `## 2일차 요약`을 쓴다(1일차 요약과 같은 항목).
- 만든 API: `GET /merchants`, `POST /terminals/:serialNo/allocations`, `POST /shipments`, `GET /shipments/:id`, 가상 업체 서버 엔드포인트, 워커 진입점 `node dist/worker.js`
- 테스트 수: api 108, partners 26
- 커밋 목록(`git log --oneline master..`)
- 실험 0003·0004·0005 결론 한 줄씩(잰 숫자로)
- 계획과 달라진 점, 남은 문제(스펙 10장 + 새로 생긴 것)
- 내일(Day 3) 시작 전에 필요한 것

`docs/study/backlog.md`의 중복 항목을 합친다. 설계안 `../01_B_단말기생애주기_설계안.md` 8장 Day 2 행 끝에 `✅ 완료(커밋 범위)`를 표시한다(저장소 밖이라 커밋하지 않는다).

- [ ] **Step 4: 커밋**

```bash
git add docs
git commit -m "docs: 2일차 마감 기록"
```

---

## Self-Review 결과

- 브리프 이월:
  - C1 등록 이력 일원화 → Task 1 (`recordRegistration`, decisions/0008)
  - C2 BATCH + 기본 허용 MANUAL + SHIPPED→DELIVERED `[MANUAL, BATCH]` + 단위 테스트 + enum ALTER → Task 1 (decisions/0007, troubleshooting/0005)
  - C3 사유 공백 거절 → Task 1 (`@Matches(/\S/)`)
- partners: 번개(advance-per-poll, duplicateRate, rateLimitPerSec+Retry-After, force429Rate) → Task 2. 느림보(XML, delayMs, error5xxRate, shuffle), 톡톡(failRate, 키별 수신) → Task 3. 관리 API(config 부분 병합, reset, stats, toktok/messages) → Task 2·3. 시드 난수 → Task 2.
- F12 어댑터(인터페이스, 순수 파서, 픽스처 단위 테스트, 오류 3분류, fetch + AbortSignal.timeout), globalSetup으로 partners 실행 → Task 4
- 가맹점 시드 3곳, `Terminal.merchant`, 배정 API(`mutate`로 UPDATE 한 번) → Task 5
- 출고 API(운송장 트랜잭션 밖 → 전이 먼저 → Shipment), Shipment·CarrierEvent·SyncRun, 고아 운송장 한계 → Task 6
- 큐(택배사별 + sweep + outbox), Redis env, 접두사 격리·obliterate, sweep(jobId + removeOnComplete), 트랙 프로세서(limiter, 멱등 적재, DELIVERED → BATCH 전이, no-op, SyncRun, 재시도 분류, Retry-After 백오프), RUN_WORKERS·RUN_SCHEDULERS, `worker.ts`, 헬퍼(waitFor, 큐 초기화, partners 클라이언트) → Task 7
- Outbox(전이·등록과 같은 트랜잭션, UPDATE 먼저 유지, SKIP LOCKED relay, notify → 톡톡, FAILED, 최소 한 번 + 멱등키) → Task 8
- 실험 0003·0004(EXPERIMENTS=1) → Task 9, 0005(워커 프로세스 2개) → Task 10
- 브리프와 다르게 한 것: 오류 클래스 이름 Partner*, SyncRun `detail`·`attempt`·`worker`·`outcome`, jobId `track-<id>`/`outbox-<id>`(콜론 불가), 0005를 vitest 실험 스펙으로. 범위 조정 절에 이유를 적었다.
- 플레이스홀더 점검: 모든 코드 단계에 전체 코드가 있다. 기록 파일의 결과 숫자는 실행해서 채운다(잰 값만 쓰는 규칙).
- 타입·이름 일관성:
  - `TransitionService.transition(cmd, em?)`, `TransitionCommand.mutate`, `recordRegistration(terminal, actor, source, em)`, `recordOutbox`(private)
  - `CarrierAdapter { carrier, createWaybill, track }`, `CarrierAdapters.get(carrier)`, `NormalizedEvent { eventKey, code, occurredAt, raw }`, `CarrierEventCode`
  - `partnerFetch(label, url, init, timeoutMs)`, `PartnerRateLimitedError.retryAfterMs`
  - `CarrierSyncService.sweep()` → `{ shipments }`, `track(shipmentId, { queue, attempt })` → `TrackOutcome`, `SYNC_ACTOR`
  - `OutboxService.relay(limit?)` → `{ queued: number[] }`, `notify(id, { lastAttempt })`, `idempotencyKeyOf(id)`
  - `QUEUE.TRACK_BUNGAE | TRACK_NEURIMBO | CARRIER_SWEEP | OUTBOX`, `ALL_QUEUES`
  - 테스트 헬퍼: `createTestApp({ workers })`, `resetDatabase`, `resetQueues`, `waitFor`, `waitForQueuesIdle`, `partners.{reset, configure, stats, toktok}`, `registerInStock`, `allocateTo`, `shipWith`, `prepareShipped`, `prepareMany`, `countInTransit`, `maxDeliveredPerTerminal`, `syncRunTotals`
- 사전 검증: Task 1~8을 이 순서로 적용해 Task마다 typecheck·테스트 통과를 확인했다(66 → 82 → 88 → 95 → 102 → 108, partners 14 → 26). 실험 3개와 실서버 흐름(출고 → 3초 안에 DELIVERED, 톡톡 6건)도 한 번씩 돌려 동작을 확인했다(숫자는 기록하지 않는다).
