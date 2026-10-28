# 보강 3 — 매장(가맹점주) 화면 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **기록 규칙 필수**: 이 저장소의 `CLAUDE.md`를 먼저 읽는다. 모든 Task는 마지막에 `docs/devlog/2026-10-28.md`(`# 보강 3: 매장 화면` 아래, `## HH:MM 보강 3 계획 작성` 항목 뒤)에 항목을 덧붙이고(제목 시각 = 커밋 시각, 제목 끝에 `(커밋 = 이 항목이 든 커밋)`, 본문 첫 줄 `이전 커밋:`, 한 일·확인·막힌 것·결정·다음), Task에 적힌 결정 기록을 쓴 뒤 `node scripts/docs-index.mjs`로 색인을 다시 만들어 **코드와 같은 커밋**에 넣는다. 작업 중 날짜가 바뀌면 그날 날짜로 새 파일 `docs/devlog/YYYY-MM-DD.md`를 시작하고 첫 줄에 이전 파일을 링크한다. 예상과 다른 에러를 만나면 고치기 전에 `docs/troubleshooting/`에 기록을 시작한다(다음 번호 0033). 이 계획은 실험을 쓰지 않는다(다음 번호 0018). 결정 번호는 0057~0060을 쓴다.

**Goal:** 가맹점주가 휴대폰으로 쓰는 매장 화면(`apps/merchant`)을 만든다 — 내 매장 단말기(상태·연결·마지막 접속·펌웨어), 오고 있는 단말기의 운송장·택배 단계, 고장 접수와 A/S 진행 단계(접수 → 원격 점검 → 교체 출고 → 배송 중 → 설치 확인 → 완료)·설치 확인, 회수 안내. 이를 위해 `/me` API를 점주용 응답 모양으로 보강한다.

**Architecture:** api는 `/me/terminals`의 한 줄을 점주용 `MerchantTerminalView`(접속 요약 — 운영 중만, 이번 배정의 운송장·택배 이벤트 — 배송 중만)로 바꾸고, 상세에 이번 배정부터의 상태 변화를 붙인다(`MeService`, 접속은 `ConnectivityService.getMany`로 여러 대 한 번에). 범위(decisions/0053)에 "점주에게 보이는 상태"(배정 ~ 회수 완료)를 더한다. 새 엔드포인트는 `GET /me/merchant`, `GET /me/service-tickets/:id` 둘(표 68 → 70). 화면은 어드민과 같은 스택·같은 lock의 별도 Vite 앱(5174, `/api` 프록시 → 같은 출처 세션 쿠키), 공통 코드는 복사(decisions/0058), 점주 문구·진행 단계는 화면이 계약의 상태 값에서 만든다(이름표 `Record`, 순수 함수). 설계 스펙: `docs/specs/2026-10-28-merchant-portal.md`.

**Tech Stack:** api Nest.js 12.2(ESM, NodeNext, vitest 5 + swc), MikroORM 7.2(MySQL 8.4), ioredis 5(Redis 7.4), TypeScript 6.0.3. merchant(새 앱) React 19.3 + Vite 8.3.4 + TanStack Query 5.104.2 + react-router 8.4, Vitest 5.0.4 + Testing Library + jsdom — **어드민과 같은 판(어드민 lock 복사)**. **새 외부 의존성 없음.**

---

## 프로세스·데이터 안전 규칙 (모든 Task에 적용)

- **프로세스는 PID로만 끈다.** `taskkill /IM node.exe`, `pkill node`처럼 이름으로 끄지 않는다. 서버는 `node …` 단독 명령으로 띄우고 `netstat -ano | grep ':<포트> .*LISTENING'`으로 찾은 Windows PID(그 node 프로세스 자신 — Git Bash 서브셸의 `$!`가 아니다)를 `taskkill //PID <PID> //F`로 끈다. 끄기 전에 `tasklist //FI "PID eq <PID>" //FO CSV //NH`로 node.exe인지 본다.
- **Redis를 통째로 지우지 않는다.** `FLUSHALL`·`FLUSHDB` 금지. api를 직접 띄우는 확인은 `QUEUE_PREFIX`를 따로 주고, 끝나면 `docker exec terminal-ops-redis redis-cli --scan --pattern '<접두사>*'`로 본 키만 하나씩 `DEL`한다.
- **테스트는 테스트 DB(`terminal_ops_test`)에서만.** 개발 DB(`terminal_ops`)는 읽기만 한다(이 계획에는 마이그레이션이 없다 — Task 5의 `db:migration:check`, 로그인·읽기). 실서버 쓰기 확인은 테스트 DB로 띄운 api에서. 테스트 DB를 다시 만드는 명령(셸 없이 한 줄, root 비밀번호는 `.env`에서 변수로 읽고 **출력하지 않는다**):
  ```bash
  PW=$(grep '^MYSQL_ROOT_PASSWORD=' .env | cut -d= -f2- | tr -d '\r')
  MSYS_NO_PATHCONV=1 docker exec -e MYSQL_PWD="$PW" terminal-ops-mysql mysql -uroot -e "DROP DATABASE IF EXISTS terminal_ops_test; CREATE DATABASE terminal_ops_test"
  ```
  브랜치를 오가며 같은 테스트 DB를 쓰면 먼저 이 명령으로 다시 만든다(troubleshooting/0030). Task 5가 끝나면 빈 DB로 남긴다.
- **api 테스트를 두 개 동시에 돌리지 않는다**(globalSetup이 partners를 테스트 포트 4011에 띄운다). admin·merchant·device-sim·partners 테스트는 같이 돌려도 된다.
- **오래 도는 서버·백그라운드 명령을 남긴 채 끝내지 않는다.** 끝나면 `netstat -ano | grep -E ':(3000|3100|4010|4011|5173|5174|4174) .*LISTENING'` 출력이 없고 `tasklist //FI "IMAGENAME eq node.exe" //FO CSV //NH`가 시작 전과 같은 PID만 보여야 한다.
- **긴 기록·코드 편집은 Write·Edit 도구로 한다**(troubleshooting/0024).
- **시연 계정 비밀번호는 `apps/api/src/db/seed-accounts.ts`에만 있다.** 명령에 넣을 때는 그 파일에서 변수로 읽고(Task 5 스크립트), devlog·리뷰 보고·화면 캡처 설명에 옮겨 적지 않는다.

## 사전 검증으로 확인된 사실 (2026-10-28, 임시 폴더)

계획 작성 전에 저장소(브랜치 `merchant-portal`, master 75c4ba7)를 임시 폴더에 복제해 앱 네 개를 `npm ci`로 설치하고, 이 계획의 코드를 Task 순서대로 적용해 Task마다 커밋하며 돌렸다(테스트 DB `terminal_ops_test`, Redis는 테스트 접두사와 확인용 접두사 `merchantcheck-live`만). 코드 블록은 모두 그 커밋에서 스크립트로 뽑았다(새 파일 = `git show <커밋>:<경로>`, 바꾼 파일 = `git diff <앞 커밋> <커밋> -- <경로>`). 검증 뒤 확인용 Redis 키 6개를 하나씩 지웠고 테스트 DB는 빈 DB로 다시 만들었다.

- **테스트 수(실제로 돌려 센 값)**: api master 79/549 → Task 1 **80/558**(전체 312.72초, `Connection is closed` 0, typecheck 0). merchant(새 앱) Task 2 **3/11** → Task 3 **5/24** → Task 4 **6/32**(tsc 0, build 성공). admin 14/125 그대로(contracts 변경 뒤 tsc 0·build 성공, Task 5의 안내 문구 변경 뒤에도 14/125). device-sim 5/46·partners 6/53 그대로.
- **기존 api 테스트에서 고친 곳은 한 줄**: `me.e2e`의 상세 단언 `toMatchObject({ serialNo: 'ME-0001', merchantCode: 'GANGNAM-KIMBAP' })` → `{ serialNo: 'ME-0001', status: 'IN_SERVICE' }`(점주용 모양에 가맹점 코드가 없다). 접근 표 테스트는 두 줄 더한다.
- **회수가 끝난 단말기가 옛 가맹점에 보인다(지금 master)**: `terminal.merchant`는 배정 취소만 비운다(`merchant.service.ts` `cancelAllocation`). 회수 → 회수 입고 → 검수 → 재고로 간 단말기의 가맹점이 그대로 남아(e2e에서 `YEOKSAM-CAFE` 확인) 지금 코드면 옛 가맹점의 `/me/terminals`에 IN_STOCK으로 보이고 상세도 열린다. Task 1의 "보이는 상태"가 이것을 막는다(decisions/0059).
- **공유 런타임 패키지(`file:` + TS 소스)를 Vite 앱에서 실제로 해 봤다**(어드민에 임시 `packages/web-common` 연결, 확인 뒤 지움 — decisions/0058):
  - 의존성 없는 순수 TS 함수: 설정 없이 `tsc` 0, vitest `Tests 1 passed`, `vite build` 성공
  - `useSyncExternalStore`를 쓰는 훅·JSX 컴포넌트: `TS2307: Cannot find module 'react'`, `TS2875: This JSX tag requires the module path 'react/jsx-runtime' to exist`, vitest `Failed to resolve import "react" from "../../packages/web-common/src/store.ts"`, build `Rolldown failed to resolve import "react"`. 앱 `vite.config.ts`에 `resolve: { dedupe: ['react', 'react-dom'] }` + 앱 `tsconfig.json` `paths`(`react`·`react/*` → `./node_modules/@types/react…`)를 더하면 tsc 0·vitest 통과·build 성공
  - 계약 타입만 import해도(`import type { ErrorCode } from '@terminal-ops/contracts'`): `TS2307: Cannot find module '@terminal-ops/contracts'`
- **어드민 lock을 복사하면 같은 트리가 깔린다**: `apps/admin/package.json`·`package-lock.json`을 복사해 `"name"`만 `@terminal-ops/merchant`로(lock은 2·7행 두 곳) 바꾸고 `npm ci` → `added 113 packages`(어드민과 같은 수), `npm ls --depth=0`이 어드민과 같은 판, `node_modules/@terminal-ops/contracts` 링크 생김.
- **MikroORM `em.insert`는 속성 기본값을 넣지 않는다**: 택배 이벤트 행을 `em().insert(CarrierEvent, {...})`로 넣자 `NotNullConstraintViolationException: Field 'received_at' doesn't have a default value`(엔티티의 `receivedAt: Date = new Date()`는 `create`에서만 쓰인다) → 테스트는 `create` + `flush`로 넣는다(계획 코드에 반영됨, 공부거리 한 줄 — Task 1).
- **실서버 확인(테스트 DB에 `migrate up` + `seed`, api `API_PORT=3200 RUN_WORKERS=0 RUN_SCHEDULERS=0 QUEUE_PREFIX=merchantcheck-live`, 점주 개발 서버 `MERCHANT_API_URL=http://localhost:3200 … --port 5175`)**: `GET /`(점주 앱) 200 `<title>단말온 가맹점</title>`, 프록시 `/api/health` `{"status":"ok"}`, 로그인 없이 `/api/me/terminals` 401 `UNAUTHENTICATED`, 운영자(api 직접)로 등록·검수·재고·`GANGNAM-KIMBAP` 배정 201/…/201, **점주는 프록시로만**: 로그인 200(쿠키 파일에 `#HttpOnly_` 1줄), `/auth/me` MERCHANT·`GANGNAM-KIMBAP`, `/me/merchant` `{"code":"GANGNAM-KIMBAP","name":"강남김밥",…}`, `/me/terminals` 1건(`status":"ALLOCATED","connectivity":null,"shipment":null`, version·merchantCode 없음), 상세 `events":[{"status":"ALLOCATED",…}]`, `/me/service-tickets` 빈 목록, 점주의 `/terminals` 403, 운영자의 `/me/terminals` 403, 로그아웃 204 뒤 같은 쿠키 401. 두 서버를 PID로 끈 뒤 3200·5175 LISTENING 0, node PID는 시작 전 넷 그대로. 계획을 쓴 뒤 Task 5 Step 3의 스크립트를 계획 글에서 그대로 뽑아 포트 3100·5174로 한 번 더 돌려 같은 결과(`statusChangedAt`·시각만 다름)를 봤다. 두 번 모두 확인용 키는 큐 meta 6개였다(세션은 로그아웃으로 지워짐) — 하나씩 DEL.
- **`statusChangedAt`과 이력 시각이 1초 안에서 다르다**(`…37.964Z` 대 `…38.000Z`) — 초 단위 datetime 열의 반올림(troubleshooting/0031과 같은 원인). 화면은 분 단위(`MM-DD HH:mm`)로만 보여 주므로 그대로 둔다.

## 범위 조정 (브리프와 다르게 한 것과 이유)

- **배송은 `/me/shipments`를 따로 만들지 않고 단말기 응답에 묶었다**(decisions/0059) — 운송장의 범위를 "보이는 단말기의 이번 배정 운송장"으로 단말기에서 얻으므로 범위 규칙을 한 번 더 정의하지 않고, 홈이 요청 두 개로 그려진다.
- **접속도 단말기 응답에 묶었다**(운영 중만) — 홈이 단말기 수만큼 접속을 따로 부르지 않게. 여러 대를 한 번에 읽는 `getMany`를 더했다.
- **브리프에 없던 범위 수정 하나**: 회수 뒤 본사로 돌아간 단말기를 옛 가맹점에서 가린다(보이는 상태). 사전 검증에서 지금 보인다는 것을 확인했기 때문이다. 가맹점 값을 지우는 쪽은 택하지 않았다(대시보드·이상 규칙·VAN 대조가 같은 값을 본다 — 0059).
- **새 엔드포인트 `GET /me/merchant`**: 화면 위쪽 "내 매장 이름". `MeView`에는 가맹점 코드만 있어(세션에 이름이 없다) 세션 모양을 바꾸지 않고 따로 읽는다.
- **증상은 서버에 코드 칸을 더하지 않고 `"증상: 메모"` 글로**(decisions/0060).
- **launch.json**: 세션 루트(`C:\Devhyun\History\.claude\launch.json`)와 저장소 `.claude/launch.json`(gitignore) 둘 다에 `terminal-ops-merchant`를 더한다(Task 5). 커밋되는 것은 없다.

## 파일 구조

```
terminal-ops/
├─ packages/contracts/src/merchant.ts (새), statuses.ts·operations.ts·index.ts            (Task 1)
├─ apps/api/
│  ├─ src/me/me.service.ts·me.views.ts (새), me.controller.ts·me.dto.ts·me.module.ts      (Task 1)
│  ├─ src/merchant/merchant-scope.ts, src/terminal/terminal.service.ts                      (Task 1) 보이는 상태
│  ├─ src/device/connectivity.service.ts, src/service/service-ticket.views.ts              (Task 1)
│  ├─ src/common/contract-assertions.ts                                                    (Task 1) CarrierEventCode
│  └─ test/me-portal.e2e.spec.ts (새), test/me.e2e.spec.ts(한 줄), test/unit/access-table.spec.ts(두 줄)   (Task 1)
├─ apps/merchant/ (새 앱)
│  ├─ package.json·package-lock.json(어드민 복사), tsconfig.json(어드민 복사), vite.config.ts, index.html   (Task 2)
│  └─ src/
│     ├─ main.tsx, App.tsx(Task 3·4 보탬), styles.css(Task 4 보탬), session.ts, query-client.ts           (Task 2)
│     ├─ api/client.ts·query-keys.ts (Task 2), api/queries.ts (Task 3)
│     ├─ hooks/useSessionCheck.ts, components/AuthGate·LogoutButton·SessionCacheSync·Shell·ErrorBox     (Task 2)
│     ├─ components/StepList·TerminalBits (Task 3)
│     ├─ lib/format.ts (Task 2), lib/labels.ts·steps.ts (Task 3), lib/symptom.ts (Task 4)
│     ├─ pages/LoginPage (Task 2), HomePage·TerminalDetailPage (Task 3), ServiceTicketsPage·NewTicketPage·ServiceTicketDetailPage (Task 4)
│     ├─ test/setup.ts·render.tsx (Task 2), test/fixtures.ts (Task 3)
│     └─ 테스트: App.test.tsx·api/client.test.ts·lib/format.test.ts (Task 2), lib/steps.test.ts·pages/TerminalPages.test.tsx (Task 3), pages/ServicePages.test.tsx (Task 4)
├─ apps/admin/src/components/AuthGate.tsx                                                  (Task 5) 가맹점주 안내 문구
└─ docs/
   ├─ decisions/0057·0058 (Task 2), 0059 (Task 1), 0060 (Task 3), 0047·0052·0053 보탬 (Task 1·2)
   ├─ devlog/2026-10-28.md, index.md(스크립트), study/backlog.md
   └─ README.md, retrospective.md (Task 5)
```

## Task 순서

| Task | 내용 | 앱 | 기록 | 테스트 수(끝) | 추천 모델 |
|---|---|---|---|---|---|
| 1 | 점주 화면용 `/me` 보강 — 계약 타입, 점주용 단말기 모양(접속·운송장·이번 배정 이력), 보이는 상태, 내 매장·접수 상세 | contracts, api | decisions 0059, 0052·0053 보탬 | api 80/558 | opus(범위·노출 판단이 섞인 api 변경) |
| 2 | 점주 앱 골격 — 설치(어드민 lock), Vite 프록시, 로그인·로그인 문·화면 틀·api 클라이언트(복사) | merchant | decisions 0057·0058, 0047 보탬 | merchant 3/11 | sonnet |
| 3 | 홈·단말기 상세 — 점주 이름표, 택배·A/S 단계 함수, 접속·배송·회수 안내 | merchant | decisions 0060 | merchant 5/24 | sonnet |
| 4 | A/S — 목록·고장 접수(증상 + 메모)·상세(진행 단계)·설치 확인 | merchant | (0060 그대로) | merchant 6/32 | sonnet |
| 5 | 마감 — 전체 검증, 실서버 확인(테스트 DB + 점주 프록시), launch.json, 어드민 안내 문구, README·회고·색인 | 전체·docs | 요약 | 최종 확인 | sonnet |

의존: 차례대로 한다. Task 2~4의 화면은 Task 1의 계약 타입(`MerchantTerminalView` 등)을 쓴다(테스트는 가짜 fetch라 api를 띄우지 않는다). 각 Task 끝의 테스트 수가 위 표와 다르면 멈추고 원인을 적는다.

## 커밋 규칙(보강 3)

범위는 `merchant`로 쓴다: `type(merchant): 요약`. 기존 기능을 함께 바꾸면 그 ID를 붙인다(`/me` A/S·배송·접속 — `merchant, F7`, 단말기 홈 — `merchant, F3, F8`, 어드민 문구 — `merchant, 어드민`). 본문에 `Refs: <기록 경로>`, 마지막 줄 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. 이 규칙은 Task 1 devlog 항목에 한 줄로 적는다.

---


### Task 1: 점주 화면용 `/me` 보강 — 계약 타입, 점주용 단말기 모양, 보이는 상태, 내 매장·접수 상세

**Files:**
- Create: `packages/contracts/src/merchant.ts`, `apps/api/src/me/me.views.ts`, `apps/api/src/me/me.service.ts`
- Modify: `packages/contracts/src/{statuses,operations,index}.ts`, `apps/api/src/merchant/merchant-scope.ts`, `apps/api/src/me/{me.dto,me.controller,me.module}.ts`, `apps/api/src/terminal/terminal.service.ts`, `apps/api/src/device/connectivity.service.ts`, `apps/api/src/service/service-ticket.views.ts`, `apps/api/src/common/contract-assertions.ts`
- Test: Create `apps/api/test/me-portal.e2e.spec.ts`; Modify `apps/api/test/me.e2e.spec.ts`(한 줄), `apps/api/test/unit/access-table.spec.ts`(두 줄)
- Docs: Create `docs/decisions/0059-점주-화면용-me-보강은-점주용-모양과-보이는-상태로.md`; Modify `docs/decisions/0052-…`, `docs/decisions/0053-…`, `docs/study/backlog.md`, `docs/index.md`, `docs/devlog/2026-10-28.md`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`apps/api/test/me-portal.e2e.spec.ts`(새 파일):

```ts
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeviceConnectivity } from '../src/device/device-connectivity.entity.js';
import { deviceKeys } from '../src/device/device-keys.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { CarrierEventCode } from '../src/carrier/carrier.types.js';
import { CarrierEvent, Shipment } from '../src/shipment/shipment.entities.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { createAccount, login, withCookie } from './helpers/auth.js';
import { partners } from './helpers/partners.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { allocateTo, prepareInService, registerInStock, SCENARIO_OP, shipWith, transitionTo } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const SN100_PASS = ['POWER', 'NETWORK', 'CARD_READER', 'PRINTER'].map((itemCode) => ({ itemCode, passed: true }));

describe('점주 화면용 /me 보강 — 단말기 요약·접속·배송·이력, 접수 상세 (보강 3, decisions/0059)', () => {
  let t: TestApp;
  let redis: Redis;
  let gangnam: string;
  let yeoksam: string;
  const em = () => t.orm.em.fork();

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    await resetDatabase(t.orm);
    await partners.reset();
    await deleteTestKeys(redis, 'hb:');
    await prepareInService(t, 'MP-0001', 'GANGNAM-KIMBAP'); // 운영 중, Redis 하트비트
    await prepareInService(t, 'MP-0002', 'GANGNAM-KIMBAP'); // 운영 중, MySQL 스냅샷만
    await prepareInService(t, 'MP-0003', 'GANGNAM-KIMBAP'); // 운영 중, 접속 기록 없음 → 고장 접수·교체
    await registerInStock(t, 'MP-0101'); // 교체 단말기
    await registerInStock(t, 'MP-0004');
    await allocateTo(t, 'MP-0004', 'GANGNAM-KIMBAP');
    await shipWith(t, 'MP-0004', 'BUNGAE'); // 새로 배송 중
    await createAccount(t, 'owner-gangnam', 'MERCHANT', 'GANGNAM-KIMBAP');
    await createAccount(t, 'owner-yeoksam', 'MERCHANT', 'YEOKSAM-CAFE');
    gangnam = await login(t, 'owner-gangnam');
    yeoksam = await login(t, 'owner-yeoksam');
  });
  afterAll(async () => {
    await deleteTestKeys(redis);
    await t.app.close();
  });

  const terminalsOf = async (cookie: string) => (await withCookie(t, cookie).get('/me/terminals')).body.items as Record<string, unknown>[];
  const itemOf = async (cookie: string, serialNo: string) => (await terminalsOf(cookie)).find((i) => i.serialNo === serialNo);

  it('내 매장 정보는 로그인한 가맹점의 것(화면 위쪽 매장 이름). 직원 역할은 403', async () => {
    const res = await withCookie(t, gangnam).get('/me/merchant');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['address', 'code', 'name']);
    expect(res.body.code).toBe('GANGNAM-KIMBAP');
    expect((await withCookie(t, yeoksam).get('/me/merchant')).body.code).toBe('YEOKSAM-CAFE');
    expect((await t.http().get('/me/merchant')).status).toBe(403);
  });

  it('목록 한 줄은 점주용 모양 — version·가맹점 코드 없이 모델 이름·접속·배송', async () => {
    const item = await itemOf(gangnam, 'MP-0001');
    expect(Object.keys(item!).sort()).toEqual(['connectivity', 'modelCode', 'modelName', 'serialNo', 'shipment', 'status', 'statusChangedAt']);
    expect(item).toMatchObject({ modelCode: 'SN-100', status: 'IN_SERVICE', shipment: null });
    expect(typeof item!.modelName).toBe('string');
  });

  it('운영 중 단말기의 접속: Redis 최신값(기준 안이면 online), 없으면 MySQL 스냅샷, 둘 다 없으면 기록 없음. 운영 중이 아니면 null', async () => {
    const k = deviceKeys();
    const now = Date.now();
    await redis.zadd(k.lastSeen, now - 5_000, 'MP-0001');
    await redis.hset(k.firmware, { 'MP-0001': '1.2.0' });
    const mp2 = await em().findOneOrFail(Terminal, { serialNo: 'MP-0002' });
    const seen = new Date(now - 3_600_000);
    await em().insert(DeviceConnectivity, { terminalId: mp2.id, online: true, lastSeenAt: seen, firmwareVersion: '1.1.0', changedAt: seen });

    expect((await itemOf(gangnam, 'MP-0001'))!.connectivity).toEqual({ online: true, lastSeenAt: new Date(now - 5_000).toISOString(), firmwareVersion: '1.2.0' });
    // 스냅샷은 online=true로 남아 있어도 lastSeen이 기준(90초)보다 오래되면 오프라인(GET /terminals/:serialNo/connectivity와 같은 규칙)
    expect((await itemOf(gangnam, 'MP-0002'))!.connectivity).toEqual({ online: false, lastSeenAt: seen.toISOString(), firmwareVersion: '1.1.0' });
    expect((await itemOf(gangnam, 'MP-0003'))!.connectivity).toEqual({ online: false, lastSeenAt: null, firmwareVersion: null });
    expect((await itemOf(gangnam, 'MP-0004'))!.connectivity).toBeNull();
  });

  it('배송 중 단말기는 운송장과 택배 이벤트(오래된 것부터). 새 배정이면 ticketId null', async () => {
    const shipment = await em().findOneOrFail(Shipment, { terminal: { serialNo: 'MP-0004' } });
    const at = (m: number) => new Date(Date.UTC(2026, 9, 28, 1, m));
    const fork = em(); // 수집 job 대신 이벤트 행을 바로 넣는다(넣는 순서와 상관없이 시각 순으로 나와야 한다)
    fork.create(CarrierEvent, { shipment: shipment.id, eventKey: 'e2', code: CarrierEventCode.IN_TRANSIT, occurredAt: at(30), raw: {} });
    fork.create(CarrierEvent, { shipment: shipment.id, eventKey: 'e1', code: CarrierEventCode.PICKED_UP, occurredAt: at(0), raw: {} });
    await fork.flush();

    const item = await itemOf(gangnam, 'MP-0004');
    expect(item).toMatchObject({ status: 'SHIPPED', connectivity: null });
    expect(item!.shipment).toEqual({
      carrier: 'BUNGAE',
      trackingNo: shipment.trackingNo,
      status: 'IN_TRANSIT',
      createdAt: shipment.createdAt.toISOString(),
      deliveredAt: null,
      ticketId: null,
      events: [
        { code: CarrierEventCode.PICKED_UP, occurredAt: at(0).toISOString() },
        { code: CarrierEventCode.IN_TRANSIT, occurredAt: at(30).toISOString() },
      ],
    });
  });

  it('A/S 교체: 교체 단말기의 배송에 접수 번호, 접수 응답에 원격 점검 여부와 교체 단말기 상태. 접수 상세는 내 것만(남의 것 404)', async () => {
    const opened = await withCookie(t, gangnam).post('/me/service-tickets').send({ serialNo: 'MP-0003', symptom: '카드 인식 불가: 오전부터' });
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({ remoteChecked: false, replacementStatus: null });
    const id = opened.body.id as number;

    expect((await t.http().post(`/service-tickets/${id}/remote-checks`).send({ resolved: false, note: '내부 메모' })).status).toBeLessThan(300);
    expect((await withCookie(t, gangnam).get(`/me/service-tickets/${id}`)).body).toMatchObject({ id, status: 'OPEN', remoteChecked: true, replacementStatus: null });

    expect((await t.http().post(`/service-tickets/${id}/replacements`).send({ replacementSerialNo: 'MP-0101', carrier: 'NEURIMBO' })).status).toBe(201);
    const detail = await withCookie(t, gangnam).get(`/me/service-tickets/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ status: 'REPLACING', replacementSerialNo: 'MP-0101', replacementStatus: 'SHIPPED', openedByMe: true });
    expect(detail.body).not.toHaveProperty('remoteNote');
    expect((await itemOf(gangnam, 'MP-0101'))!.shipment).toMatchObject({ carrier: 'NEURIMBO', ticketId: id, events: [] });
    expect((await itemOf(gangnam, 'MP-0003'))!.status).toBe('RETURN_REQUESTED');

    const other = await withCookie(t, yeoksam).get(`/me/service-tickets/${id}`);
    expect(other.status).toBe(404);
    expect(other.body.message).toBe(`A/S 접수 ${id}이(가) 없습니다.`);
    expect((await withCookie(t, gangnam).get('/me/service-tickets/999999')).status).toBe(404);
  });

  it('접수 목록은 단말기 시리얼로 거를 수 있다(내 가맹점 안에서만)', async () => {
    const mine = await withCookie(t, gangnam).get('/me/service-tickets').query({ serialNo: 'MP-0003' });
    expect(mine.body.items.map((i: { serialNo: string }) => i.serialNo)).toEqual(['MP-0003']);
    expect((await withCookie(t, gangnam).get('/me/service-tickets').query({ serialNo: 'MP-0001' })).body.items).toEqual([]);
    expect((await withCookie(t, yeoksam).get('/me/service-tickets').query({ serialNo: 'MP-0003' })).body.items).toEqual([]);
  });

  it('상세의 이력은 이번 배정부터, 상태와 시각만(actor·reason 없음)', async () => {
    const res = await withCookie(t, gangnam).get('/me/terminals/MP-0001');
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { status: string }) => e.status)).toEqual(['ALLOCATED', 'SHIPPED', 'DELIVERED', 'IN_SERVICE']);
    for (const e of res.body.events) expect(Object.keys(e).sort()).toEqual(['occurredAt', 'status']);
    expect(res.body.connectivity).toMatchObject({ online: true });
  });

  it('회수가 끝나 본사로 돌아간(검수·재고) 단말기는 옛 가맹점에 보이지 않는다. 다른 가맹점에 다시 배정되면 그 가맹점은 새 배정부터만 본다', async () => {
    await prepareInService(t, 'MP-0201', 'YEOKSAM-CAFE');
    await transitionTo(t, 'MP-0201', 'RETURN_REQUESTED', '회수 요청');
    await transitionTo(t, 'MP-0201', 'RETURNING', '회수 중');
    await transitionTo(t, 'MP-0201', 'RETURNED', '회수 입고');
    expect((await itemOf(yeoksam, 'MP-0201'))!.status).toBe('RETURNED'); // 회수 완료까지는 보인다

    const inspected = await t.http().post('/terminals/MP-0201/inspections').set(SCENARIO_OP).send({ results: SN100_PASS });
    expect(inspected.status).toBe(201);
    await transitionTo(t, 'MP-0201', 'IN_STOCK', '재고 편입');
    expect((await em().findOneOrFail(Terminal, { serialNo: 'MP-0201' }, { populate: ['merchant'] })).merchant?.code).toBe('YEOKSAM-CAFE'); // 가맹점은 그대로 남아 있다
    expect(await itemOf(yeoksam, 'MP-0201')).toBeUndefined();
    expect((await withCookie(t, yeoksam).get('/me/terminals/MP-0201')).status).toBe(404);

    await allocateTo(t, 'MP-0201', 'GANGNAM-KIMBAP');
    const detail = await withCookie(t, gangnam).get('/me/terminals/MP-0201');
    expect(detail.body.events.map((e: { status: string }) => e.status)).toEqual(['ALLOCATED']);
  });

  it('점주에게 보이지 않는 상태로 거르면 400', async () => {
    expect((await withCookie(t, gangnam).get('/me/terminals').query({ status: 'IN_STOCK' })).status).toBe(400);
    const shipped = await withCookie(t, gangnam).get('/me/terminals').query({ status: 'SHIPPED' });
    expect(shipped.body.items.map((i: { serialNo: string }) => i.serialNo).sort()).toEqual(['MP-0004', 'MP-0101']);
  });
});
```

`apps/api/test/unit/access-table.spec.ts`(표에 두 줄):

```diff
diff --git a/apps/api/test/unit/access-table.spec.ts b/apps/api/test/unit/access-table.spec.ts
index a613c72..d59144d 100644
--- a/apps/api/test/unit/access-table.spec.ts
+++ b/apps/api/test/unit/access-table.spec.ts
@@ -74,10 +74,12 @@ const EXPECTED: Record<string, string> = {
   'POST /firmware-rollouts/:id/resume': 'OPERATOR',
   'POST /firmware-rollouts/:id/abort': 'OPERATOR',
 
-  // 가맹점주 전용(decisions/0053) — 가맹점주는 이 다섯 개와 /auth만 부를 수 있다
+  // 가맹점주 전용(decisions/0053, 보강 3 decisions/0059) — 가맹점주는 이 일곱 개와 /auth만 부를 수 있다
+  'GET /me/merchant': 'MERCHANT',
   'GET /me/terminals': 'MERCHANT',
   'GET /me/terminals/:serialNo': 'MERCHANT',
   'GET /me/service-tickets': 'MERCHANT',
+  'GET /me/service-tickets/:id': 'MERCHANT',
   'POST /me/service-tickets': 'MERCHANT',
   'POST /me/service-tickets/:id/installations': 'MERCHANT',
 
```

`apps/api/test/me.e2e.spec.ts`(상세 응답이 점주용 모양이 되어 가맹점 코드가 없다 — 한 줄):

```diff
diff --git a/apps/api/test/me.e2e.spec.ts b/apps/api/test/me.e2e.spec.ts
index 50fed0b..8cc3baf 100644
--- a/apps/api/test/me.e2e.spec.ts
+++ b/apps/api/test/me.e2e.spec.ts
@@ -41,7 +41,7 @@ describe('가맹점주 범위 /me (보강 2, decisions/0053)', () => {
   });
 
   it('남의 단말기·재고 단말기 상세는 404(있는지도 알려 주지 않는다)', async () => {
-    expect((await withCookie(t, gangnam).get('/me/terminals/ME-0001')).body).toMatchObject({ serialNo: 'ME-0001', merchantCode: 'GANGNAM-KIMBAP' });
+    expect((await withCookie(t, gangnam).get('/me/terminals/ME-0001')).body).toMatchObject({ serialNo: 'ME-0001', status: 'IN_SERVICE' });
     const other = await withCookie(t, gangnam).get('/me/terminals/ME-0003');
     expect(other.status).toBe(404);
     expect(other.body.message).toBe('단말기 ME-0003이(가) 없습니다.');
```

- [ ] **Step 2: 실패를 확인한다**

```bash
# 저장소 루트에서 테스트 DB를 새로 만든다(안전 규칙의 두 줄 — 비밀번호는 출력하지 않는다)
cd apps/api && npx vitest run test/me-portal.e2e.spec.ts test/unit/access-table.spec.ts test/me.e2e.spec.ts
```

Expected(사전 검증 원문): `Tests  11 failed | 10 passed (21)` — me-portal 9개 모두(`expected 404 to be 200`(내 매장 없음), `expected [ 'createdAt', 'merchantCode', …(6) ] to deeply equal [ 'connectivity', 'modelCode', …(5) ]`, `expected { serialNo: 'MP-0201', …(7) } to be undefined`(회수 뒤 재고 단말기가 보임), `expected 200 to be 400`(보이지 않는 상태 조건) …)와 접근 표 2개(`expected { …(68) } to deeply equal { …(70) }`, `expected 68 to be 70`). `me.e2e`는 아직 통과한다(지금 상세가 `TerminalView`라 `status`가 있다).

- [ ] **Step 3: 계약 타입**

`packages/contracts/src/merchant.ts`(새 파일):

```ts
/**
 * 가맹점주(점주) 화면이 받는 단말기 모양(보강 3, `apps/merchant`, `/me/terminals` — decisions/0059).
 * 운영자용 TerminalView·ShipmentView·HistoryView를 그대로 주지 않고 필드를 골라 준다 — version(낙관적 락)·이력의 actor·reason·
 * 접속 정보의 출처(redis·snapshot)처럼 점주에게 필요 없거나 내부 사정인 값은 없다. 화면 이름(한글)은 매장 앱 `lib/labels.ts`.
 */
import type { OffsetPage } from './common.js';
import type { Carrier, CarrierEventCode, ShipmentStatus, TerminalStatus } from './statuses.js';

/** 접속 요약(운영 중 단말기만) */
export interface MerchantConnectivity {
  online: boolean;
  /** 마지막 하트비트 시각. 한 번도 받지 못했으면 null */
  lastSeenAt: string | null;
  firmwareVersion: string | null;
}

/** 오고 있는(또는 막 도착한) 단말기의 운송장과 택배 단계 */
export interface MerchantShipmentView {
  carrier: Carrier;
  trackingNo: string;
  status: ShipmentStatus;
  createdAt: string;
  deliveredAt: string | null;
  /** A/S 교체로 보낸 것이면 그 접수 번호, 아니면 null */
  ticketId: number | null;
  /** 택배사 이벤트(오래된 것부터) */
  events: { code: CarrierEventCode; occurredAt: string }[];
}

/** GET /me/terminals 한 줄 */
export interface MerchantTerminalView {
  serialNo: string;
  modelCode: string;
  modelName: string;
  status: TerminalStatus;
  /** 지금 상태가 된 시각 */
  statusChangedAt: string;
  /** 운영 중(IN_SERVICE)일 때만, 아니면 null */
  connectivity: MerchantConnectivity | null;
  /** 배송 중(SHIPPED)·배송 완료(DELIVERED, 설치 전)일 때만 — 이번 배정의 운송장. 아니면 null */
  shipment: MerchantShipmentView | null;
}

/** GET /me/terminals */
export type MerchantTerminalPage = OffsetPage<MerchantTerminalView>;

/** 이 가맹점에 배정된 뒤의 상태 변화 하나(누가·왜는 주지 않는다) */
export interface MerchantTerminalEvent {
  status: TerminalStatus;
  occurredAt: string;
}

/** GET /me/terminals/:serialNo */
export interface MerchantTerminalDetail extends MerchantTerminalView {
  /** 이번 배정(마지막 ALLOCATED)부터의 상태 변화, 오래된 것부터 */
  events: MerchantTerminalEvent[];
}
```

`statuses.ts`·`operations.ts`·`index.ts`:

```diff
diff --git a/packages/contracts/src/statuses.ts b/packages/contracts/src/statuses.ts
index 518de68..cf661df 100644
--- a/packages/contracts/src/statuses.ts
+++ b/packages/contracts/src/statuses.ts
@@ -25,6 +25,9 @@ export type TransitionSource = 'MANUAL' | 'INSPECTION' | 'BATCH' | 'ALLOCATION'
 /** 택배사(api carrier/carrier.types.ts Carrier) */
 export type Carrier = 'BUNGAE' | 'NEURIMBO';
 
+/** 택배사 배송 이벤트(api carrier/carrier.types.ts CarrierEventCode). 가맹점주 화면의 배송 단계로 나간다(보강 3, decisions/0059) */
+export type CarrierEventCode = 'PICKED_UP' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED';
+
 /** 운송장 상태(api ShipmentStatus) */
 export type ShipmentStatus = 'IN_TRANSIT' | 'DELIVERED' | 'SUPERSEDED';
 
```

```diff
diff --git a/packages/contracts/src/operations.ts b/packages/contracts/src/operations.ts
index a3bb3b9..e31b5b4 100644
--- a/packages/contracts/src/operations.ts
+++ b/packages/contracts/src/operations.ts
@@ -1,5 +1,5 @@
 import type { RowResult } from './common.js';
-import type { PurchaseOrderStatus, RolloutStatus, RowResultCode, ScanKind, ServiceTicketStatus } from './statuses.js';
+import type { PurchaseOrderStatus, RolloutStatus, RowResultCode, ScanKind, ServiceTicketStatus, TerminalStatus } from './statuses.js';
 
 /** 박스 스캔 결과(POST /scans 201 새로 처리 · 200 replayed, GET /scans/:scanId, decisions/0020) */
 export interface ScanView {
@@ -75,6 +75,10 @@ export interface TicketView {
  */
 export interface MerchantTicketView extends Omit<TicketView, 'openedBy' | 'remoteNote'> {
   openedByMe: boolean;
+  /** 본사가 원격 점검을 했나(메모 내용은 주지 않는다 — 진행 단계 표시용, 보강 3 decisions/0059) */
+  remoteChecked: boolean;
+  /** 교체 단말기의 지금 상태(SHIPPED 배송 중 → DELIVERED 설치 확인 대기 → IN_SERVICE). 교체 전이면 null */
+  replacementStatus: TerminalStatus | null;
 }
 
 /** 펌웨어(api toFirmwareView, POST /firmware) */
```

```diff
diff --git a/packages/contracts/src/index.ts b/packages/contracts/src/index.ts
index 206bba4..717df46 100644
--- a/packages/contracts/src/index.ts
+++ b/packages/contracts/src/index.ts
@@ -1,5 +1,5 @@
 /**
- * @terminal-ops/contracts — api와 어드민이 함께 보는 HTTP 계약(응답·요청 모양, 상태 값, 오류 코드).
+ * @terminal-ops/contracts — api와 어드민·매장 화면이 함께 보는 HTTP 계약(응답·요청 모양, 상태 값, 오류 코드).
  * 타입만 있다(런타임 값 없음). 쓰는 쪽은 `import type`으로만 가져온다 — 빌드된 JS에 이 패키지 import가 남지 않는다(decisions/0047).
  * api는 응답을 만드는 함수의 반환 타입·DTO의 implements로 이 타입을 지키고(어긋나면 api tsc 실패), 어드민은 이 타입으로 응답을 읽는다(decisions/0048).
  */
@@ -11,3 +11,4 @@ export type * from './operations.js';
 export type * from './reports.js';
 export type * from './requests.js';
 export type * from './auth.js';
+export type * from './merchant.js';
```

api enum과 계약 유니온 단언(`apps/api/src/common/contract-assertions.ts`):

```diff
diff --git a/apps/api/src/common/contract-assertions.ts b/apps/api/src/common/contract-assertions.ts
index ed91a21..33b9eb3 100644
--- a/apps/api/src/common/contract-assertions.ts
+++ b/apps/api/src/common/contract-assertions.ts
@@ -1,14 +1,14 @@
 /**
  * api의 런타임 enum(MikroORM 엔티티·class-validator가 쓴다)과 @terminal-ops/contracts의 문자열 유니온이 같은 값 집합인지 타입으로 단언한다(decisions/0048).
  * 어느 한쪽에만 값이 있으면 api tsc(build·typecheck)가 이 파일에서 TS2344로 실패하고, 메시지에 빠진 값이 나온다.
- * 응답에 나가는 enum만 단언한다. 응답 본문에 나오지 않는 내부 enum(TargetStatus·VanStatus·CarrierEventCode·OutboxStatus)은 계약에 없고 여기서도 단언하지 않는다.
+ * 응답에 나가는 enum만 단언한다. 응답 본문에 나오지 않는 내부 enum(TargetStatus·VanStatus·OutboxStatus)은 계약에 없고 여기서도 단언하지 않는다.
  * 런타임 코드는 없다(빌드하면 빈 모듈). import하는 곳도 없다 — tsconfig의 include(src)로 검사 대상에 들어간다.
  */
 import type * as C from '@terminal-ops/contracts';
 import type { AnomalyRule } from '../anomaly/anomaly.entity.js';
 import type { PARTNER_SCOPES } from '../auth/partner-key.entity.js';
 import type { Role } from '../auth/role.js';
-import type { Carrier } from '../carrier/carrier.types.js';
+import type { Carrier, CarrierEventCode } from '../carrier/carrier.types.js';
 import type { RolloutStatus } from '../firmware/firmware.entities.js';
 import type { PurchaseOrderStatus } from '../purchase-order/purchase-order.entity.js';
 import type { WeeklyReportStatus } from '../report/weekly-report.entity.js';
@@ -32,6 +32,7 @@ export type ContractEnumAssertions = [
   Assert<Same<`${TerminalStatus}`, C.TerminalStatus>>,
   Assert<Same<`${TransitionSource}`, C.TransitionSource>>,
   Assert<Same<`${Carrier}`, C.Carrier>>,
+  Assert<Same<`${CarrierEventCode}`, C.CarrierEventCode>>,
   Assert<Same<`${ShipmentStatus}`, C.ShipmentStatus>>,
   Assert<Same<`${ScanKind}`, C.ScanKind>>,
   Assert<Same<`${PurchaseOrderStatus}`, C.PurchaseOrderStatus>>,
```

- [ ] **Step 4: 보이는 상태(범위)**

`apps/api/src/merchant/merchant-scope.ts`:

```diff
diff --git a/apps/api/src/merchant/merchant-scope.ts b/apps/api/src/merchant/merchant-scope.ts
index bd3c5ff..16fcad1 100644
--- a/apps/api/src/merchant/merchant-scope.ts
+++ b/apps/api/src/merchant/merchant-scope.ts
@@ -2,6 +2,7 @@ import { ForbiddenException, NotFoundException } from '@nestjs/common';
 import type { ApiErrorBody } from '@terminal-ops/contracts';
 import type { Principal } from '../auth/principal.js';
 import { Role } from '../auth/role.js';
+import { TerminalStatus } from '../terminal/terminal-status.js';
 
 /**
  * 가맹점주가 볼 수 있는 범위(decisions/0053). `/me/...` 컨트롤러가 로그인한 사람에서 만들어 서비스에 넘기고,
@@ -18,6 +19,20 @@ export function merchantScopeOf(principal: Principal): MerchantScope {
   return { merchantId: principal.merchantId };
 }
 
+/**
+ * 가맹점주에게 보이는 단말기 상태(보강 3, decisions/0059): 배정부터 회수 완료까지. 회수 뒤 검수·재고·폐기로 넘어간 단말기는
+ * terminal.merchant가 옛 가맹점으로 남아 있어도(배정 취소만 가맹점을 비운다) 이미 본사 것이라 보이지 않는다(목록에서 빠지고 상세는 404).
+ */
+export const MERCHANT_VISIBLE_STATUSES: readonly TerminalStatus[] = [
+  TerminalStatus.ALLOCATED,
+  TerminalStatus.SHIPPED,
+  TerminalStatus.DELIVERED,
+  TerminalStatus.IN_SERVICE,
+  TerminalStatus.RETURN_REQUESTED,
+  TerminalStatus.RETURNING,
+  TerminalStatus.RETURNED,
+];
+
 /** 범위 밖일 때 던지는 404(없는 것과 같은 응답) */
 export function outOfScope(what: string): NotFoundException {
   return new NotFoundException(`${what}이(가) 없습니다.`);
```

`apps/api/src/terminal/terminal.service.ts`(scope면 목록은 보이는 상태만, 상세는 그 밖이면 404):

```diff
diff --git a/apps/api/src/terminal/terminal.service.ts b/apps/api/src/terminal/terminal.service.ts
index c4dac0f..9dcf17d 100644
--- a/apps/api/src/terminal/terminal.service.ts
+++ b/apps/api/src/terminal/terminal.service.ts
@@ -2,7 +2,7 @@ import { Injectable, NotFoundException } from '@nestjs/common';
 import { EntityManager, LoadStrategy } from '@mikro-orm/mysql';
 import type { RegisterTerminalDto } from './dto/register-terminal.dto.js';
 import type { ListTerminalsQuery } from './dto/list-terminals.query.js';
-import { outOfScope, type MerchantScope } from '../merchant/merchant-scope.js';
+import { MERCHANT_VISIBLE_STATUSES, outOfScope, type MerchantScope } from '../merchant/merchant-scope.js';
 import { TerminalModel } from './terminal-model.entity.js';
 import { Terminal } from './terminal.entity.js';
 import { TerminalStatusHistory } from './terminal-status-history.entity.js';
@@ -37,11 +37,11 @@ export class TerminalService {
    * count도 같은 조인을 탄다. select-in이면 목록은 PK를 거꾸로 읽어 바로 멈추고, 모델·가맹점은 그 20행의 id로 한 번씩 읽는다.
    * 모델·가맹점 코드로 거를 때는 MikroORM이 거르기용 조인만 붙인다.
    * @param strategy 실험 0013이 joined와 비교하려고만 바꾼다(운영 코드는 기본값)
-   * @param scope 가맹점주(`/me`)면 그 가맹점 단말기만 — 가맹점 코드 조건보다 앞선다(decisions/0053)
+   * @param scope 가맹점주(`/me`)면 그 가맹점 단말기 중 점주에게 보이는 상태만 — 가맹점 코드 조건보다 앞선다(decisions/0053·0059)
    */
   async list(query: ListTerminalsQuery, strategy: LoadStrategy = LoadStrategy.SELECT_IN, scope?: MerchantScope) {
     const where = {
-      ...(query.status ? { status: query.status } : {}),
+      ...(query.status ? { status: query.status } : scope ? { status: { $in: [...MERCHANT_VISIBLE_STATUSES] } } : {}),
       ...(query.modelCode ? { model: { code: query.modelCode } } : {}),
       ...(scope ? { merchant: scope.merchantId } : query.merchantCode ? { merchant: { code: query.merchantCode } } : {}),
       ...(query.q ? { serialNo: { $like: `${escapeLike(query.q)}%` } } : {}),
@@ -61,10 +61,11 @@ export class TerminalService {
     return this.em.find(TerminalModel, {}, { orderBy: { code: 'asc' } });
   }
 
-  /** @param scope 가맹점주(`/me`)면 그 가맹점 단말기만 — 아니면 없는 것과 같은 404(decisions/0053) */
+  /** @param scope 가맹점주(`/me`)면 그 가맹점 단말기 중 점주에게 보이는 상태만 — 아니면 없는 것과 같은 404(decisions/0053·0059) */
   async getBySerial(serialNo: string, scope?: MerchantScope): Promise<Terminal> {
     const terminal = await this.em.findOne(Terminal, { serialNo }, { populate: ['model', 'merchant'] });
-    if (!terminal || (scope && terminal.merchant?.id !== scope.merchantId)) throw outOfScope(`단말기 ${serialNo}`);
+    const visible = (t: Terminal) => !scope || (t.merchant?.id === scope.merchantId && MERCHANT_VISIBLE_STATUSES.includes(t.status));
+    if (!terminal || !visible(terminal)) throw outOfScope(`단말기 ${serialNo}`);
     return terminal;
   }
 
```

`apps/api/src/me/me.dto.ts`(상태 조건은 보이는 상태만 — 그 밖 400, 접수 목록에 `serialNo`):

```diff
diff --git a/apps/api/src/me/me.dto.ts b/apps/api/src/me/me.dto.ts
index 1291a8f..1c5c87d 100644
--- a/apps/api/src/me/me.dto.ts
+++ b/apps/api/src/me/me.dto.ts
@@ -1,13 +1,17 @@
 import { Type } from 'class-transformer';
-import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
+import { IsEnum, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
 import { BeforeIdQuery } from '../common/keyset.js';
+import { MERCHANT_VISIBLE_STATUSES } from '../merchant/merchant-scope.js';
 import { ServiceTicketStatus } from '../service/service-ticket.entity.js';
 import { TerminalStatus } from '../terminal/terminal-status.js';
 
-/** GET /me/terminals — 가맹점 조건(merchantCode)은 받지 않는다(로그인한 가맹점으로 정해진다, 보내면 400) */
+/**
+ * GET /me/terminals — 가맹점 조건(merchantCode)은 받지 않는다(로그인한 가맹점으로 정해진다, 보내면 400).
+ * 상태 조건은 점주에게 보이는 상태만(MERCHANT_VISIBLE_STATUSES, 그 밖이면 400 — decisions/0059)
+ */
 export class MeTerminalsQuery {
   @IsOptional()
-  @IsEnum(TerminalStatus)
+  @IsIn(MERCHANT_VISIBLE_STATUSES)
   status?: TerminalStatus;
 
   @IsOptional()
@@ -35,4 +39,10 @@ export class MeTicketsQuery extends BeforeIdQuery {
   @IsOptional()
   @IsEnum(ServiceTicketStatus)
   status?: ServiceTicketStatus;
+
+  /** 고장 접수된 단말기 시리얼(정확히 같은 것) — 단말기 상세 화면의 "이 단말기의 A/S"(보강 3) */
+  @IsOptional()
+  @IsString()
+  @MaxLength(32)
+  serialNo?: string;
 }
```

- [ ] **Step 5: 여러 대 접속을 한 번에 — `ConnectivityService.getMany`**

`apps/api/src/device/connectivity.service.ts`(기존 `get`도 `getMany`를 쓴다 — 규칙은 그대로):

```diff
diff --git a/apps/api/src/device/connectivity.service.ts b/apps/api/src/device/connectivity.service.ts
index 0e22532..696cd67 100644
--- a/apps/api/src/device/connectivity.service.ts
+++ b/apps/api/src/device/connectivity.service.ts
@@ -103,31 +103,53 @@ export class ConnectivityService {
 
   /** 접속 상태 조회: Redis(최신값)가 있으면 그것, 없으면 MySQL 스냅샷 */
   async get(serialNo: string, now = Date.now()): Promise<ConnectivityView> {
-    const em = this.em.fork();
-    const terminal = await em.findOne(Terminal, { serialNo });
+    const terminal = await this.em.fork().findOne(Terminal, { serialNo });
     if (!terminal) throw new NotFoundException(`단말기 ${serialNo}이(가) 없습니다.`);
+    return (await this.getMany([terminal], now)).get(terminal.id)!;
+  }
+
+  /**
+   * 여러 단말기의 접속 상태를 한 번에(가맹점주 단말기 목록, 보강 3 decisions/0059): Redis 파이프라인 한 번(zscore·hget을 단말기마다)으로
+   * 최신값을 읽고, Redis에 없는 것만 MySQL 스냅샷을 한 번(`terminal_id IN (…)`)에 읽는다. 규칙은 get과 같다(get도 이 함수를 쓴다).
+   * @returns 단말기 id → 접속 상태(넘긴 단말기마다 하나씩)
+   */
+  async getMany(terminals: { id: number; serialNo: string }[], now = Date.now()): Promise<Map<number, ConnectivityView>> {
+    const out = new Map<number, ConnectivityView>();
+    if (terminals.length === 0) return out;
     const k = deviceKeys();
-    const [score, firmware] = (await execOrThrow(this.redis.pipeline().zscore(k.lastSeen, serialNo).hget(k.firmware, serialNo))) as [
-      string | null,
-      string | null,
-    ];
-    if (score !== null) {
+    const look = this.redis.pipeline();
+    for (const t of terminals) look.zscore(k.lastSeen, t.serialNo).hget(k.firmware, t.serialNo);
+    const values = (await execOrThrow(look)) as (string | null)[];
+    const missing: { id: number; serialNo: string }[] = [];
+    terminals.forEach((t, i) => {
+      const [score, firmware] = [values[i * 2], values[i * 2 + 1]];
+      if (score === null) {
+        missing.push(t);
+        return;
+      }
       const lastSeen = Number(score);
-      return {
-        serialNo,
+      out.set(t.id, {
+        serialNo: t.serialNo,
         source: 'redis',
         online: lastSeen > now - env.hbOfflineAfterMs,
         lastSeenAt: new Date(lastSeen).toISOString(),
         firmwareVersion: firmware,
-      };
-    }
-    const row = await em.findOne(DeviceConnectivity, { terminalId: terminal.id });
-    if (row) {
+      });
+    });
+    if (missing.length === 0) return out;
+    const rows = await this.em.fork().find(DeviceConnectivity, { terminalId: { $in: missing.map((t) => t.id) } });
+    const rowOf = new Map(rows.map((r) => [r.terminalId, r]));
+    for (const t of missing) {
+      const row = rowOf.get(t.id);
+      if (!row) {
+        out.set(t.id, { serialNo: t.serialNo, source: 'none', online: false, lastSeenAt: null, firmwareVersion: null });
+        continue;
+      }
       // 방어: 판정 job이 online을 못 내린 행(운영 이탈 직후 등)도 lastSeen이 기준보다 오래되면 오프라인으로 보인다
       const online = row.online && row.lastSeenAt.getTime() > now - env.hbOfflineAfterMs;
-      return { serialNo, source: 'snapshot', online, lastSeenAt: row.lastSeenAt.toISOString(), firmwareVersion: row.firmwareVersion };
+      out.set(t.id, { serialNo: t.serialNo, source: 'snapshot', online, lastSeenAt: row.lastSeenAt.toISOString(), firmwareVersion: row.firmwareVersion });
     }
-    return { serialNo, source: 'none', online: false, lastSeenAt: null, firmwareVersion: null };
+    return out;
   }
 
   private async detectLocked(now: number, offlineAfterMs: number): Promise<DetectResult> {
```

- [ ] **Step 6: 점주용 응답 — 접수 view, 단말기 view, `MeService`, 컨트롤러·모듈**

`apps/api/src/service/service-ticket.views.ts`:

```diff
diff --git a/apps/api/src/service/service-ticket.views.ts b/apps/api/src/service/service-ticket.views.ts
index 9acf635..ced15bc 100644
--- a/apps/api/src/service/service-ticket.views.ts
+++ b/apps/api/src/service/service-ticket.views.ts
@@ -34,6 +34,8 @@ export function toMerchantTicketView(t: ServiceTicket, myLoginId: string): Merch
     outboundShipmentId: t.outboundShipment?.id ?? null,
     outboundTrackingNo: t.outboundShipment?.trackingNo ?? null,
     openedByMe: t.openedBy === myLoginId,
+    remoteChecked: t.remoteNote !== null,
+    replacementStatus: t.replacementTerminal?.status ?? null,
     createdAt: t.createdAt.toISOString(),
     closedAt: t.closedAt?.toISOString() ?? null,
   };
```

`apps/api/src/me/me.views.ts`(새 파일):

```ts
import type { ConnectivityView, MerchantShipmentView, MerchantTerminalEvent, MerchantTerminalView } from '@terminal-ops/contracts';
import { MERCHANT_VISIBLE_STATUSES } from '../merchant/merchant-scope.js';
import type { CarrierEvent, Shipment } from '../shipment/shipment.entities.js';
import type { Terminal } from '../terminal/terminal.entity.js';
import type { TerminalStatusHistory } from '../terminal/terminal-status-history.entity.js';
import { TerminalStatus } from '../terminal/terminal-status.js';

/**
 * 가맹점주 화면용 응답(보강 3, decisions/0059). 운영자용 view를 펼치지 않고 필드를 하나씩 옮긴다 —
 * 운영자용 모양에 필드가 늘어도 점주에게 저절로 나가지 않게(toMerchantTicketView와 같은 방식, decisions/0053).
 * terminal은 model이 populate돼 있어야 한다.
 */
export function toMerchantTerminalView(
  t: Terminal,
  connectivity: ConnectivityView | null,
  shipment: MerchantShipmentView | null,
): MerchantTerminalView {
  return {
    serialNo: t.serialNo,
    modelCode: t.model.code,
    modelName: t.model.name,
    status: t.status,
    statusChangedAt: t.statusChangedAt.toISOString(),
    connectivity:
      t.status === TerminalStatus.IN_SERVICE && connectivity
        ? { online: connectivity.online, lastSeenAt: connectivity.lastSeenAt, firmwareVersion: connectivity.firmwareVersion }
        : null,
    shipment,
  };
}

/** 운송장 + 택배 이벤트(오래된 것부터 넘긴다) + 교체 출고면 접수 번호 */
export function toMerchantShipmentView(s: Shipment, events: CarrierEvent[], ticketId: number | null): MerchantShipmentView {
  return {
    carrier: s.carrier,
    trackingNo: s.trackingNo,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    deliveredAt: s.deliveredAt?.toISOString() ?? null,
    ticketId,
    events: events.map((e) => ({ code: e.code, occurredAt: e.occurredAt.toISOString() })),
  };
}

/**
 * 상태 이력 중 이번 배정(마지막 ALLOCATED)부터만, 상태와 시각만. 단말기가 회수돼 다른 가맹점에 다시 배정되면
 * 그 단말기의 앞 이력(옛 가맹점의 설치·회수)은 지금 가맹점과 상관없는 남의 기록이라 주지 않는다. 점주에게 보이는 상태만 남긴다
 * (배정 이력이 없는 단말기 — 데이터를 손으로 넣은 경우 — 에서 입고·검수 같은 본사 단계가 나가지 않게). history는 id 오름차순.
 */
export function merchantEvents(history: TerminalStatusHistory[]): MerchantTerminalEvent[] {
  const start = history.findLastIndex((h) => h.toStatus === TerminalStatus.ALLOCATED);
  return history
    .slice(Math.max(start, 0))
    .filter((h) => MERCHANT_VISIBLE_STATUSES.includes(h.toStatus))
    .map((h) => ({ status: h.toStatus, occurredAt: h.occurredAt.toISOString() }));
}
```

`apps/api/src/me/me.service.ts`(새 파일):

```ts
import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { MerchantShipmentView, MerchantTerminalDetail, MerchantTerminalPage, MerchantTerminalView, MerchantView } from '@terminal-ops/contracts';
import { ConnectivityService } from '../device/connectivity.service.js';
import type { MerchantScope } from '../merchant/merchant-scope.js';
import { Merchant } from '../merchant/merchant.entity.js';
import { ServiceTicket } from '../service/service-ticket.entity.js';
import { CarrierEvent, Shipment } from '../shipment/shipment.entities.js';
import type { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatusHistory } from '../terminal/terminal-status-history.entity.js';
import { TerminalStatus } from '../terminal/terminal-status.js';
import { TerminalService } from '../terminal/terminal.service.js';
import type { MeTerminalsQuery } from './me.dto.js';
import { merchantEvents, toMerchantShipmentView, toMerchantTerminalView } from './me.views.js';

/**
 * 가맹점주 화면의 단말기 묶음(보강 3, decisions/0059). 범위(어느 단말기가 보이나)는 TerminalService가 scope로 정하고(0053·0059),
 * 여기서는 그 단말기들에 접속 요약(운영 중만)과 이번 배정의 운송장(배송 중·배송 완료만)을 붙인다.
 * 쿼리 수는 쪽 크기와 상관없다: 목록 2(단말기·count) + 접속 Redis 파이프라인 1·스냅샷 0~1 + 운송장 0~3(운송장·이벤트·교체 접수).
 */
@Injectable()
export class MeService {
  constructor(
    private readonly em: EntityManager,
    private readonly terminals: TerminalService,
    private readonly connectivity: ConnectivityService,
  ) {}

  /** 로그인한 가맹점(화면 위쪽 매장 이름). 계정의 가맹점은 있어야 한다(merchantScopeOf가 확인) */
  async merchant(scope: MerchantScope): Promise<MerchantView> {
    const m = await this.em.fork().findOneOrFail(Merchant, scope.merchantId);
    return { code: m.code, name: m.name, address: m.address };
  }

  async terminalPage(query: MeTerminalsQuery, scope: MerchantScope): Promise<MerchantTerminalPage> {
    const page = await this.terminals.list(query, undefined, scope);
    return { ...page, items: await this.views(page.items) };
  }

  async terminalDetail(serialNo: string, scope: MerchantScope): Promise<MerchantTerminalDetail> {
    const terminal = await this.terminals.getBySerial(serialNo, scope);
    const [view] = await this.views([terminal]);
    const history = await this.em.fork().find(TerminalStatusHistory, { terminal: terminal.id }, { orderBy: { id: 'asc' } });
    return { ...view, events: merchantEvents(history) };
  }

  private async views(terminals: Terminal[]): Promise<MerchantTerminalView[]> {
    const live = terminals.filter((t) => t.status === TerminalStatus.IN_SERVICE);
    const moving = terminals.filter((t) => t.status === TerminalStatus.SHIPPED || t.status === TerminalStatus.DELIVERED);
    const connectivity = await this.connectivity.getMany(live);
    const shipments = await this.latestShipments(moving);
    return terminals.map((t) => toMerchantTerminalView(t, connectivity.get(t.id) ?? null, shipments.get(t.id) ?? null));
  }

  /**
   * 단말기마다 가장 최근 운송장(id가 가장 큰 것) — 배정 → 출고 순서라 배송 중·배송 완료인 단말기의 최근 운송장은 이번 배정의 것이다
   * (다시 출고하면 앞 운송장은 SUPERSEDED, decisions/0018). 교체 출고면 그 운송장을 가리키는 A/S 접수의 번호를 붙인다.
   */
  private async latestShipments(terminals: Terminal[]): Promise<Map<number, MerchantShipmentView>> {
    const out = new Map<number, MerchantShipmentView>();
    if (terminals.length === 0) return out;
    const em = this.em.fork();
    const all = await em.find(Shipment, { terminal: { $in: terminals.map((t) => t.id) } }, { orderBy: { id: 'desc' } });
    const latest = new Map<number, Shipment>();
    for (const s of all) if (!latest.has(s.terminal.id)) latest.set(s.terminal.id, s);
    const ids = [...latest.values()].map((s) => s.id);
    const events = await em.find(CarrierEvent, { shipment: { $in: ids } }, { orderBy: { occurredAt: 'asc', id: 'asc' } });
    const tickets = await em.find(ServiceTicket, { outboundShipment: { $in: ids } });
    for (const [terminalId, s] of latest) {
      const ticket = tickets.find((t) => t.outboundShipment?.id === s.id);
      out.set(terminalId, toMerchantShipmentView(s, events.filter((e) => e.shipment.id === s.id), ticket?.id ?? null));
    }
    return out;
  }
}
```

`apps/api/src/me/me.controller.ts`:

```diff
diff --git a/apps/api/src/me/me.controller.ts b/apps/api/src/me/me.controller.ts
index 588b96f..20d3e59 100644
--- a/apps/api/src/me/me.controller.ts
+++ b/apps/api/src/me/me.controller.ts
@@ -1,5 +1,5 @@
 import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
-import type { BeforeIdPage, MerchantTicketView, TerminalPage, TerminalView } from '@terminal-ops/contracts';
+import type { BeforeIdPage, MerchantTerminalDetail, MerchantTerminalPage, MerchantTicketView, MerchantView } from '@terminal-ops/contracts';
 import { Roles } from '../auth/access.js';
 import { CurrentPrincipal, type Principal } from '../auth/principal.js';
 import { Role } from '../auth/role.js';
@@ -8,34 +8,39 @@ import { OpenTicketDto } from '../service/dto/service-ticket.dto.js';
 import { ReplacementService } from '../service/replacement.service.js';
 import { ServiceTicketService } from '../service/service-ticket.service.js';
 import { toMerchantTicketView } from '../service/service-ticket.views.js';
-import { TerminalService } from '../terminal/terminal.service.js';
-import { toTerminalView } from '../terminal/terminal.views.js';
 import { MeTerminalsQuery, MeTicketsQuery } from './me.dto.js';
+import { MeService } from './me.service.js';
 
 /**
  * 가맹점주(MERCHANT) 전용 API(decisions/0053). 일반 엔드포인트에 가맹점 조건을 끼워 넣지 않고 `/me/...`를 따로 둔다 —
  * 가맹점주는 이 컨트롤러 밖의 업무 API를 하나도 부를 수 없고(표 decisions/0052), 여기서는 모든 호출이 로그인한 가맹점의 범위를 서비스에 넘긴다.
- * 단말기는 TerminalView(운영자 작업 목록 allowedTransitions가 있는 상세는 주지 않는다).
+ * 단말기는 점주용 모양 MerchantTerminalView(접속 요약·이번 배정의 운송장, 상세는 이번 배정부터의 상태 변화 — 보강 3 decisions/0059).
  */
 @Controller('me')
 export class MeController {
   constructor(
-    private readonly terminals: TerminalService,
+    private readonly me: MeService,
     private readonly tickets: ServiceTicketService,
     private readonly replacements: ReplacementService,
   ) {}
 
+  /** 내 매장(이름·주소) — 점주 화면 위쪽(보강 3) */
+  @Get('merchant')
+  @Roles(Role.MERCHANT)
+  async merchant(@CurrentPrincipal() p: Principal): Promise<MerchantView> {
+    return this.me.merchant(merchantScopeOf(p));
+  }
+
   @Get('terminals')
   @Roles(Role.MERCHANT)
-  async terminalList(@CurrentPrincipal() p: Principal, @Query() query: MeTerminalsQuery): Promise<TerminalPage> {
-    const result = await this.terminals.list(query, undefined, merchantScopeOf(p));
-    return { ...result, items: result.items.map(toTerminalView) };
+  async terminalList(@CurrentPrincipal() p: Principal, @Query() query: MeTerminalsQuery): Promise<MerchantTerminalPage> {
+    return this.me.terminalPage(query, merchantScopeOf(p));
   }
 
   @Get('terminals/:serialNo')
   @Roles(Role.MERCHANT)
-  async terminal(@CurrentPrincipal() p: Principal, @Param('serialNo') serialNo: string): Promise<TerminalView> {
-    return toTerminalView(await this.terminals.getBySerial(serialNo, merchantScopeOf(p)));
+  async terminal(@CurrentPrincipal() p: Principal, @Param('serialNo') serialNo: string): Promise<MerchantTerminalDetail> {
+    return this.me.terminalDetail(serialNo, merchantScopeOf(p));
   }
 
   @Get('service-tickets')
@@ -45,6 +50,13 @@ export class MeController {
     return { items: items.map((i) => toMerchantTicketView(i, p.loginId)), nextBeforeId };
   }
 
+  /** 접수 한 건(내 가맹점 접수만 — 남의 것은 없는 것과 같은 404). 진행 단계 화면용(보강 3) */
+  @Get('service-tickets/:id')
+  @Roles(Role.MERCHANT)
+  async ticket(@CurrentPrincipal() p: Principal, @Param('id', ParseIntPipe) id: number): Promise<MerchantTicketView> {
+    return toMerchantTicketView(await this.tickets.get(id, merchantScopeOf(p)), p.loginId);
+  }
+
   /** A/S 접수(내 가맹점의 운영 중 단말기만). 저장되는 openedBy = 가맹점주 로그인 아이디, 응답은 openedByMe(MerchantTicketView) */
   @Post('service-tickets')
   @Roles(Role.MERCHANT)
```

`apps/api/src/me/me.module.ts`(`ConnectivityService`는 `DeviceModule`이 export한다):

```diff
diff --git a/apps/api/src/me/me.module.ts b/apps/api/src/me/me.module.ts
index 1c403e9..58d624b 100644
--- a/apps/api/src/me/me.module.ts
+++ b/apps/api/src/me/me.module.ts
@@ -1,11 +1,14 @@
 import { Module } from '@nestjs/common';
+import { DeviceModule } from '../device/device.module.js';
 import { ServiceModule } from '../service/service.module.js';
 import { TerminalModule } from '../terminal/terminal.module.js';
 import { MeController } from './me.controller.js';
+import { MeService } from './me.service.js';
 
-/** 가맹점주 전용 API `/me/...`(decisions/0053) */
+/** 가맹점주 전용 API `/me/...`(decisions/0053, 점주 화면용 보강은 0059) */
 @Module({
-  imports: [TerminalModule, ServiceModule],
+  imports: [TerminalModule, ServiceModule, DeviceModule],
   controllers: [MeController],
+  providers: [MeService],
 })
 export class MeModule {}
```

- [ ] **Step 7: 통과를 확인한다**

```bash
cd apps/api && npx tsc --noEmit -p tsconfig.json && npx vitest run test/me-portal.e2e.spec.ts test/unit/access-table.spec.ts test/me.e2e.spec.ts test/connectivity.e2e.spec.ts test/unit/contract-drift.spec.ts
```

Expected: tsc 출력 없음(exit 0). `Test Files  5 passed (5)`, `Tests  40 passed (40)`(me-portal 9 + 접근 표 3 + me 9 + 접속 12 + 계약 어긋남 7 — `get`을 `getMany`로 바꾼 뒤 `connectivity.e2e`의 조회 테스트가 그대로 통과해야 한다).

- [ ] **Step 8: 전체 테스트**

```bash
# 테스트 DB를 새로 만든 뒤(안전 규칙)
cd apps/api && npx tsc --noEmit -p tsconfig.json && npm run build && npx vitest run 2>&1 | tee /tmp/merchant-t1-api.log | tail -5
grep -c "Connection is closed" /tmp/merchant-t1-api.log
(cd ../admin && npx tsc --noEmit -p tsconfig.json)   # contracts가 바뀌었다 — 어드민도 0이어야 한다
```

Expected: `Test Files  80 passed (80)`, `Tests  558 passed (558)`(사전 검증 312.72초), `Connection is closed` 0, 어드민 tsc 0.

- [ ] **Step 9: 기록**

`docs/decisions/0059-점주-화면용-me-보강은-점주용-모양과-보이는-상태로.md`(새 파일):

```markdown
# 0059. 점주 화면용 /me 보강은 점주용 응답 모양과 "점주에게 보이는 상태"로 한다

- 날짜 / 관련 기능: 2026-10-28 / 보강 3, F1(단말기 조회), F3(배송), F7(A/S), F8(접속 상태)
- 상황: 점주 화면(`apps/merchant`, decisions/0057)의 홈은 내 단말기의 상태·접속(온라인·마지막 접속·펌웨어)·오고 있는 단말기의 운송장과 택배 단계·진행 중 A/S를, 단말기 상세는 점주에게 의미 있는 이력을, A/S 상세는 진행 단계를 보여야 한다. 보강 2의 `/me`(decisions/0053)는 단말기에 운영자용 `TerminalView`(version 포함)만 주고, 접속은 OFFICE 전용 `GET /terminals/:serialNo/connectivity`, 배송은 OFFICE 전용 `GET /shipments/:id`, 이력은 STAFF 전용 `GET /terminals/:serialNo/history`(actor·reason 포함)에만 있다. 접수 한 건 조회도 없다. 또 사전 검증에서 **회수 뒤 검수·재고로 돌아간 단말기가 옛 가맹점의 `/me/terminals`에 계속 보이는 것**을 확인했다 — `terminal.merchant`는 배정 취소만 비우고(`merchant.service.ts` `cancelAllocation`), 회수 → 검수 → 재고 경로는 가맹점을 그대로 둔다(e2e `me-portal` "회수가 끝나 본사로 돌아간…"에서 재고 단말기의 가맹점이 `YEOKSAM-CAFE` 그대로).
- 선택지(접속·배송·이력을 점주에게 주는 길):
  1. 운영자용 엔드포인트(`/terminals/:serialNo/connectivity`, `/shipments/:id`, `/terminals/:serialNo/history`)에 MERCHANT를 열고 서비스에 scope를 넘김 — 엔드포인트가 늘지 않는다. 단점: 0053이 버린 길(같은 엔드포인트가 역할마다 다르게 동작, 한 곳이라도 scope를 빠뜨리면 전부 나감). 이력의 actor(직원 로그인 아이디 — 0053이 가린 값)·reason(내부 메모)이 그대로 나간다
  2. `/me` 아래 별도 엔드포인트(`/me/terminals/:serialNo/connectivity`, `/me/shipments`, `/me/terminals/:serialNo/history`) — 응답을 따로 고를 수 있다. 단점: 홈 한 화면이 단말기 수만큼 접속·배송을 따로 부르거나(N+1 요청), `/me/shipments`처럼 범위 규칙(어느 운송장이 내 것인가)을 한 번 더 정의한다
  3. **단말기 응답 자체를 점주용 모양으로: `/me/terminals` 한 줄 = `MerchantTerminalView`(모델 이름, 접속 요약 — 운영 중만, 이번 배정의 운송장·택배 이벤트·교체 접수 번호 — 배송 중·배송 완료만), 상세 = + 이번 배정부터의 상태 변화(상태·시각만)** — 홈이 요청 두 개(단말기·접수)로 그려진다. 범위는 지금처럼 단말기 하나(scope가 걸린 단말기 목록)에서 나오므로 운송장·이벤트에 따로 범위 규칙이 없다. 단점: 목록 응답이 무거워진다(쪽당 쿼리 고정 수로 막음), `/me/terminals` 응답 모양이 바뀐다(보강 2의 `TerminalView` → 점주용 — 쓰는 화면이 아직 없다)
- 결정: 3.
  - 계약: `packages/contracts/src/merchant.ts` — `MerchantTerminalView`·`MerchantTerminalPage`·`MerchantTerminalDetail`·`MerchantTerminalEvent`·`MerchantConnectivity`·`MerchantShipmentView`, `statuses.ts`에 `CarrierEventCode`(api enum과 단언 — `contract-assertions.ts`). 운영자용 view를 펼치지 않고 필드를 하나씩 옮긴다(`me.views.ts`, `toMerchantTicketView`와 같은 이유 — 운영자용에 필드가 늘어도 점주에게 저절로 나가지 않게). version·가맹점 코드·접속 출처(redis·snapshot)·actor·reason은 없다
  - 접속은 운영 중(IN_SERVICE)만, 규칙은 운영자 조회와 같다(Redis 최신값 → 없으면 MySQL 스냅샷, 기준보다 오래되면 오프라인 — decisions/0029). 여러 대를 한 번에 읽는 `ConnectivityService.getMany`(Redis 파이프라인 1번 + 스냅샷 `IN` 1번)를 더하고 기존 `get`도 이것을 쓴다
  - 운송장은 배송 중·배송 완료(설치 전)일 때만, 그 단말기의 가장 최근 운송장 — 배정 → 출고 순서라 지금 배송 중인 단말기의 최근 운송장은 이번 배정의 것이다(다시 출고하면 앞 운송장은 SUPERSEDED, decisions/0018). 교체 출고면 그 운송장을 가리키는 접수 번호(`ticketId`)
  - 상세 이력은 마지막 ALLOCATED부터 — 단말기가 회수돼 다른 가맹점에 다시 배정되면 앞 이력(옛 가맹점의 설치·회수)은 남의 기록이다
  - **점주에게 보이는 상태 = 배정부터 회수 완료까지**(`MERCHANT_VISIBLE_STATUSES`: ALLOCATED·SHIPPED·DELIVERED·IN_SERVICE·RETURN_REQUESTED·RETURNING·RETURNED). 그 밖(검수·재고·불량·폐기 — 이미 본사 것)은 가맹점이 남아 있어도 목록에서 빠지고 상세는 404(없는 것과 같은 응답, 0053). 상태 조건으로 그 밖의 상태를 보내면 400. 버린 것: 회수 입고·재고 전이에서 `terminal.merchant`를 비우기 — 전이 서비스의 여러 경로(수동 전이·박스 스캔·검수)를 바꾸고, 대시보드·이상 규칙·VAN 대조가 보는 가맹점 값이 함께 바뀐다(보강 범위를 넘는다. 운영자 화면에 남는 "옛 가맹점" 표시는 그대로다)
  - 새 엔드포인트 두 개(표 decisions/0052, MERCHANT): `GET /me/merchant`(내 매장 이름·주소 — 화면 위쪽), `GET /me/service-tickets/:id`(접수 한 건 — 남의 것은 404). `GET /me/service-tickets`에 `serialNo` 조건(단말기 상세의 "이 단말기의 A/S"). 엔드포인트 68 → 70
  - `MerchantTicketView`에 `remoteChecked`(본사가 원격 점검을 했나 — 메모 내용은 주지 않는다)와 `replacementStatus`(교체 단말기의 지금 상태)를 더한다 — 진행 단계(decisions/0060)를 화면이 만들 수 있게. 버린 것: 서버가 단계 이름을 주기(점주 문구가 api에 들어간다 — 이름표는 화면 몫, decisions/0037과 같은 방향)
- 결과·대가: `/me/terminals` 쪽 하나에 쿼리가 쪽 크기와 상관없이 고정 수(단말기·count 2, 접속 Redis 파이프라인 1·스냅샷 0~1, 운송장 0~3)로 는다. 운영자용 `/shipments/:id`·이력 응답과 같은 데이터가 두 모양으로 있다(바꿀 때 `me.views.ts`도 본다). 회수가 끝난 단말기가 옛 가맹점 데이터에 남는 것은 화면 쪽에서만 가린다(데이터는 그대로).
- 다시 볼 조건: 한 가맹점 단말기가 100대를 넘어 홈이 한 쪽으로 안 될 때(홈 요약 엔드포인트를 따로), 회수 뒤 가맹점을 비우는 규칙이 생길 때(그때 `MERCHANT_VISIBLE_STATUSES`의 RETURNED 이후 판단을 다시), 점주에게 반품 운송장(회수 택배)이 생길 때.
```

`docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md`(MERCHANT 줄과 끝에 보탬):

```diff
diff --git a/docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md b/docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md
index 1bc1c3f..21f2811 100644
--- a/docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md
+++ b/docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md
@@ -21,7 +21,7 @@
   | OPERATOR·MONITOR(관제 작업) | `POST /anomaly-scans`, `POST /van-reconciliations`, `POST /reports/weekly` |
   | OPERATOR·FIELD(현장 작업) | `POST /scans`, `POST /terminals/:serialNo/inspections` |
   | OPERATOR | `POST /terminals`, `POST /terminals/imports`, `POST /terminals/:serialNo/transitions`, `POST /terminals/:serialNo/allocations`, `POST /terminals/:serialNo/allocation-cancellations`, `POST /shipments`, `POST /purchase-orders`, `POST /purchase-orders/:poNo/close`, `POST /service-tickets`, `POST /service-tickets/:id/remote-checks`, `POST /service-tickets/:id/replacements`, `POST /service-tickets/:id/installations`, `POST /firmware`, `POST /firmware-rollouts`, `POST /firmware-rollouts/:id/pause`, `POST /firmware-rollouts/:id/resume`, `POST /firmware-rollouts/:id/abort` |
-  | MERCHANT(0053, Task 4) | `GET /me/terminals`, `GET /me/terminals/:serialNo`, `GET /me/service-tickets`, `POST /me/service-tickets`, `POST /me/service-tickets/:id/installations` |
+  | MERCHANT(0053, Task 4; 보강 3 0059) | `GET /me/merchant`(보강 3), `GET /me/terminals`, `GET /me/terminals/:serialNo`, `GET /me/service-tickets`, `GET /me/service-tickets/:id`(보강 3), `POST /me/service-tickets`, `POST /me/service-tickets/:id/installations` |
   | ADMIN(Task 5) | `GET·POST /admin/accounts`, `PATCH /admin/accounts/:id`, `GET·POST /admin/partner-keys`, `POST /admin/partner-keys/:id/revoke` |
   | partner:scope(0054, Task 5) | `GET /partner/v1/terminals/:serialNo`(terminal-status:read), `GET /partner/v1/merchants/:merchantCode/terminals`(merchant-terminals:read) |
 
@@ -30,3 +30,4 @@
 - HTTP가 아닌 실행 문맥(ws·rpc — 지금은 없다)은 가드가 `false`(기본 거부)를 돌려준다. 붙일 때 그 문맥의 인증 규칙을 따로 정한다(Task 2 보안 리뷰 반영, 처음에는 `true`로 통과시켰다).
 - 결과·대가: 엔드포인트 하나를 더할 때 데코레이터와 테스트 표 두 곳을 고친다(의도한 마찰). 역할을 하나 더하면 데코레이터 여러 곳을 바꾼다.
 - 다시 볼 조건: 역할이 일곱을 넘거나 사용자별 권한이 필요하면 3(권한 단위). 같은 엔드포인트가 역할마다 다른 데이터를 줘야 하면(0053처럼) 엔드포인트를 나눈다.
+- 보강 3 보탬(decisions/0059): 점주 화면용 `GET /me/merchant`·`GET /me/service-tickets/:id`(MERCHANT)를 더해 엔드포인트 68 → 70(접근 표 테스트가 센 값).
```

`docs/decisions/0053-가맹점주-범위는-me-전용-엔드포인트와-서비스-scope.md`(끝에 보탬):

```diff
diff --git a/docs/decisions/0053-가맹점주-범위는-me-전용-엔드포인트와-서비스-scope.md b/docs/decisions/0053-가맹점주-범위는-me-전용-엔드포인트와-서비스-scope.md
index 1d2c2ae..65c20c7 100644
--- a/docs/decisions/0053-가맹점주-범위는-me-전용-엔드포인트와-서비스-scope.md
+++ b/docs/decisions/0053-가맹점주-범위는-me-전용-엔드포인트와-서비스-scope.md
@@ -17,3 +17,4 @@
 - 보강 2 보안 리뷰(Task 2 리뷰, decisions/0050)와의 관계: 가맹점주 세션도 계정 세대값을 갖는다 — 계정 API(Task 5)가 가맹점을 바꾸면 `destroyAllFor`가 세대값을 올려, 로그인 도중이던 옛 가맹점 세션도 무효가 된다. 이미 세션 읽기를 통과한 요청 1건은 옛 범위로 끝날 수 있다(0050).
 - 응답에 보이는 범위(보강 2 마감, Task 4 보안 리뷰): `/me` 접수 응답은 `MerchantTicketView`다 — 직원 로그인 아이디(`openedBy`)는 빼고 `openedByMe`(로그인한 가맹점주 본인이 접수했나)만, 본사 원격 점검 메모(`remoteNote`)는 내부 메모라 뺀다(가맹점 공개용 문구 칸이 따로 없다 — 생기면 그 칸만 준다). 필드는 `toMerchantTicketView`가 하나씩 옮긴다(`TicketView`에 필드가 늘어도 저절로 나가지 않게). 직원 아이디를 가린 이유: 로그인 아이디는 로그인 실패 제한의 단위라(0050) 남이 알면 일부러 틀려 잠글 수 있다. 버린 것: "본인/본사" 두 값 — 같은 가맹점의 다른 계정이 접수한 것을 "본사"로 잘못 보이게 한다(계정 역할을 다시 읽어야 구분된다).
 - 접수는 **접수 당시 가맹점** 기준이다(의도): `service_ticket.merchant_id`는 접수할 때 단말기의 가맹점으로 정해지고 바뀌지 않는다. 단말기가 다른 가맹점으로 옮겨 가도 옛 가맹점주는 자기가 낸 옛 접수를 계속 보고(설치 확인도 그 접수 기준), 새 가맹점주는 옛 접수를 보지 못한다. 접수는 그 가맹점이 겪은 일의 기록이라 단말기의 지금 가맹점을 따라가지 않는다.
+- 보강 3 보탬(decisions/0059): 점주 화면이 쓰도록 `/me/terminals`의 응답을 점주용 모양(`MerchantTerminalView` — 접속 요약·이번 배정의 운송장, 상세는 이번 배정부터의 상태 변화)으로 바꿨다(위 "단말기는 TerminalView"를 대신한다). 범위에 **보이는 상태**(배정 ~ 회수 완료)를 더했다 — 회수 뒤 검수·재고로 돌아간 단말기는 `terminal.merchant`가 옛 가맹점으로 남아 있어 지금까지 옛 가맹점 목록에 보였다. 접수 한 건(`GET /me/service-tickets/:id`)·내 매장(`GET /me/merchant`)을 더하고, `MerchantTicketView`에 `remoteChecked`(메모 내용은 여전히 주지 않는다)·`replacementStatus`를 더했다.
```

`docs/study/backlog.md` 끝에 한 줄:

```markdown
- [ ] MikroORM `em.insert`(속성 기본값 `= new Date()`를 쓰지 않는 바로 INSERT)와 `create` + `flush`의 차이 — 테스트 준비 행에서 `NotNullConstraintViolationException: Field 'received_at' doesn't have a default value` (apps/api/test/me-portal.e2e.spec.ts, 보강 3 계획 사전 검증)
```

`node scripts/docs-index.mjs` → `docs/index.md: decisions 57, troubleshooting 32, experiments 17`(이 Task까지 0059 하나가 늘었다. 번호는 0059지만 개수는 57).

`docs/devlog/2026-10-28.md` 끝(`## HH:MM 보강 3 계획 작성` 항목 뒤)에:

```markdown
## HH:MM Task 1 점주 화면용 /me 보강 — 점주용 단말기 모양·접속·배송·보이는 상태·내 매장·접수 상세 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <보강 3 계획 커밋 해시> (docs: 보강 3 계획)
- 커밋 규칙(보강 3): `type(merchant): 요약`, 기존 기능을 같이 바꾸면 `merchant, F7`처럼 ID를 붙인다. 본문 `Refs:`, 마지막 줄 Co-Authored-By
- 한 일: contracts `merchant.ts`(MerchantTerminalView·Page·Detail·Event, MerchantConnectivity, MerchantShipmentView), `CarrierEventCode`(api enum과 단언), `MerchantTicketView`에 `remoteChecked`·`replacementStatus`. api `MeService`(접속은 `ConnectivityService.getMany` — Redis 파이프라인 1번 + 스냅샷 IN 1번, 운송장은 단말기마다 최근 것 + 이벤트 + 교체 접수 번호), 상세 이력은 마지막 ALLOCATED부터 상태·시각만. 범위에 보이는 상태(`MERCHANT_VISIBLE_STATUSES`). 새 엔드포인트 `GET /me/merchant`·`GET /me/service-tickets/:id`, 접수 목록 `serialNo` 조건
- 확인: 먼저 본 실패 `Tests  11 failed | 10 passed (21)`(…원문 한두 줄) → 통과 `Tests  40 passed (40)`(관련 5파일). 전체 `Test Files  80 passed (80)`, `Tests  558 passed (558)`, Duration <초>, `Connection is closed` <수>. api typecheck·build 0, 어드민 tsc 0
- 기존 테스트 수정: `me.e2e` 상세 단언 한 줄(가맹점 코드 → 상태)
- 결정: decisions/0059(점주용 모양·보이는 상태·배송과 접속은 단말기 응답에), 0052 표 68 → 70, 0053 보탬
- 막힌 것: (없으면 "없음")
- 다음: Task 2 점주 앱 골격
```

- [ ] **Step 10: 커밋**

```bash
git add packages/contracts apps/api docs
git commit -m "$(cat <<'EOF'
feat(merchant, F7): 점주 화면용 /me 보강 — 점주용 단말기 모양·접속·배송·보이는 상태·접수 상세

Refs: docs/decisions/0059-점주-화면용-me-보강은-점주용-모양과-보이는-상태로.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 제목의 `HH:MM`은 이 커밋 시각(`git log -1 --format=%cd --date=format:%H:%M`)과 같아야 한다 — 다르면 고쳐 `git commit --amend --no-edit`.


### Task 2: 점주 앱 골격 — 설치, Vite 프록시, 로그인·로그인 문·화면 틀·api 클라이언트

**Files:**
- Create(복사 + 이름만): `apps/merchant/package.json`, `apps/merchant/package-lock.json`, `apps/merchant/tsconfig.json`
- Create: `apps/merchant/vite.config.ts`, `apps/merchant/index.html`, `apps/merchant/src/{main.tsx,App.tsx,styles.css,session.ts,query-client.ts}`, `src/api/{client.ts,query-keys.ts}`, `src/hooks/useSessionCheck.ts`, `src/components/{AuthGate,LogoutButton,SessionCacheSync,Shell,ErrorBox}.tsx`, `src/lib/format.ts`, `src/pages/LoginPage.tsx`, `src/test/{setup.ts,render.tsx}`
- Test: Create `src/App.test.tsx`, `src/api/client.test.ts`, `src/lib/format.test.ts`
- Docs: Create `docs/decisions/0057-점주-화면은-별도-앱-apps-merchant.md`, `docs/decisions/0058-화면-공통-코드는-공유-패키지가-아니라-복사로.md`; Modify `docs/decisions/0047-…`, `docs/study/backlog.md`, `docs/index.md`, `docs/devlog/2026-10-28.md`

- [ ] **Step 1: 어드민과 같은 판으로 설치**

```bash
mkdir -p apps/merchant
sed 's#"name": "@terminal-ops/admin"#"name": "@terminal-ops/merchant"#' apps/admin/package.json > apps/merchant/package.json
sed 's#"name": "@terminal-ops/admin"#"name": "@terminal-ops/merchant"#g' apps/admin/package-lock.json > apps/merchant/package-lock.json
cp apps/admin/tsconfig.json apps/merchant/tsconfig.json
diff <(tr -d '\r' < apps/admin/package-lock.json) <(tr -d '\r' < apps/merchant/package-lock.json)   # 2·7행 name 두 줄만 달라야 한다
(cd apps/merchant && npm ci && npm ls --depth=0)
```

Expected: diff는 `2c2`·`7c7` 두 곳(`@terminal-ops/admin` → `@terminal-ops/merchant`)만. `added 113 packages`, `npm ls`가 어드민과 같은 판(react 19.3.0, vite 8.3.4, vitest 5.0.4, @tanstack/react-query 5.104.2, react-router 8.4.0, `@terminal-ops/contracts@0.0.0 -> .\..\..\packages\contracts` …). `found 0 vulnerabilities`. 새 판을 고르지 않으므로 출시일 확인(decisions/0041)은 어드민 때 것 그대로다.

- [ ] **Step 2: 테스트 도구와 실패하는 테스트**

`apps/merchant/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { resetSessionForTest } from '../session';

// globals를 켜지 않아 Testing Library가 자동으로 정리하지 않는다. 테스트마다 화면·fetch 가짜·로그인 정보를 비운다(어드민과 같다)
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetSessionForTest();
});
```

`apps/merchant/src/test/render.tsx`(가짜 fetch `mockApi`는 어드민과 같은 규칙, 앱 전체를 그리는 `renderApp`):

```tsx
import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { vi } from 'vitest';
import type { MeView } from '@terminal-ops/contracts';
import { App } from '../App';
import { setMe } from '../session';

/** 부른 요청 하나(가짜 fetch가 기록) */
export interface Call {
  method: string;
  /** /api를 뗀 경로(쿼리 제외) */
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type HandlerResult = { status?: number; body?: unknown } | undefined;
export type Handler = (call: Call) => HandlerResult | Promise<HandlerResult>;

/**
 * 가짜 api(어드민 test/render.tsx의 mockApi와 같은 규칙). 키는 'GET /me/terminals'처럼 메서드와 경로(쿼리 제외). 경로의 `:x`는 아무 한 마디와 맞는다.
 * 없는 경로를 부르면 404 — 테스트가 빠뜨린 요청이 바로 보이게. 부른 요청은 calls에 쌓인다.
 */
export function mockApi(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const patterns = Object.entries(handlers).map(([key, handler]) => {
    const [method, path] = key.split(' ');
    return { method, regex: new RegExp(`^${path.replace(/:[^/]+/g, '[^/]+')}$`), handler };
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://merchant.test');
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/api/, ''),
      query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const found = patterns.find((p) => p.method === call.method && p.regex.test(call.path));
    const result = found ? ((await found.handler(call)) ?? {}) : { status: 404, body: { statusCode: 404, message: `가짜 api에 없음: ${call.method} ${call.path}` } };
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

/** 화면 하나를 라우터·쿼리 캐시와 함께 그린다. path는 Route 경로(예 '/terminals/:serialNo'), route는 지금 주소 */
export function renderPage(element: ReactElement, { route = '/', path = '/' }: { route?: string; path?: string } = {}) {
  const client = newClient();
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path={path} element={element} />
            <Route path="*" element={<p>다른 화면</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

/** 앱 전체(로그인 문·화면 틀 포함)를 이 주소로 그린다 */
export function renderApp(route = '/') {
  const client = newClient();
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

/** 강남김밥 점주(시연 계정과 같은 아이디·가맹점) */
export const OWNER: MeView = { loginId: 'merchant-gangnam', displayName: '강남김밥 점주', role: 'MERCHANT', merchantCode: 'GANGNAM-KIMBAP' };

/** 로그인한 것으로 둔다(서버 세션 대신 화면의 내 정보만) */
export function loginAs(me: MeView = OWNER) {
  setMe(me);
}
```

`apps/merchant/src/App.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { getMe } from './session';
import { mockApi, OWNER, renderApp } from './test/render';

const STORE = { code: 'GANGNAM-KIMBAP', name: '강남김밥', address: '서울 강남구' };

describe('로그인 문과 화면 틀 (보강 3, decisions/0057)', () => {
  it('로그인 안 했으면(/auth/me 401) 로그인 화면으로 간다', async () => {
    mockApi({ 'GET /auth/me': () => ({ status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } }) });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: '단말온 가맹점' })).toBeInTheDocument();
  });

  it('로그인하면 처음 화면으로 가고 위에 내 매장 이름이 보인다', async () => {
    const { calls } = mockApi({
      'GET /auth/me': () => ({ status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } }),
      'POST /auth/login': () => ({ body: OWNER }),
      'GET /me/merchant': () => ({ body: STORE }),
    });
    renderApp('/');
    await userEvent.type(await screen.findByLabelText('아이디'), ' merchant-gangnam ');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByText('강남김밥')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({ loginId: 'merchant-gangnam', password: 'pw' });
    expect(screen.getByRole('navigation', { name: '메뉴' })).toBeInTheDocument();
  });

  it('틀린 비밀번호는 점주 안내 문구로', async () => {
    mockApi({
      'GET /auth/me': () => ({ status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: 'x' } }),
      'POST /auth/login': () => ({ status: 401, body: { statusCode: 401, code: 'LOGIN_FAILED', message: '아이디 또는 비밀번호가 틀립니다.' } }),
    });
    renderApp('/login');
    await userEvent.type(await screen.findByLabelText('아이디'), 'merchant-gangnam');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('아이디 또는 비밀번호가 맞지 않습니다.');
  });

  it('사내 직원 계정이면 안내와 로그아웃만 — 매장 API를 부르지 않는다', async () => {
    const { calls } = mockApi({
      'GET /auth/me': () => ({ body: { loginId: 'operator', displayName: '운영자', role: 'OPERATOR', merchantCode: null } }),
      'POST /auth/logout': () => ({ status: 204 }),
    });
    renderApp('/');
    expect(await screen.findByText(/가맹점\(점주\) 계정용입니다/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/me'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(await screen.findByRole('heading', { name: '단말온 가맹점' })).toBeInTheDocument();
    expect(getMe()).toBeNull();
  });

  it('매장 화면 요청이 401이면(세션 끝남) 로그인 화면으로', async () => {
    mockApi({
      'GET /auth/me': () => ({ body: OWNER }),
      'GET /me/merchant': () => ({ status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '세션이 끝났습니다.' } }),
    });
    renderApp('/');
    await waitFor(() => expect(screen.getByRole('heading', { name: '단말온 가맹점' })).toBeInTheDocument());
  });
});
```

`apps/merchant/src/api/client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { getMe } from '../session';
import { loginAs, mockApi } from '../test/render';
import { api, ApiError, toQueryString } from './client';

describe('api 클라이언트 (어드민 client와 같은 규칙, decisions/0058)', () => {
  it('빈 값은 쿼리에서 빼고, /api 앞붙임으로 부른다', async () => {
    expect(toQueryString({ a: 1, b: '', c: null, d: undefined, e: 'x y' })).toBe('?a=1&e=x+y');
    const { calls } = mockApi({ 'GET /me/terminals': () => ({ body: { items: [] } }) });
    await api('/me/terminals', { query: { size: 100, status: undefined } });
    expect(calls[0].path).toBe('/me/terminals');
    expect(calls[0].query.toString()).toBe('size=100');
  });

  it('오류는 ApiError(status·code·message) — 검증 오류 배열은 이어 붙인다', async () => {
    mockApi({
      'POST /me/service-tickets': () => ({ status: 400, body: { statusCode: 400, message: ['symptom은 공백만으로 쓸 수 없습니다.', 'serialNo must be a string'] } }),
      'GET /me/service-tickets/:id': () => ({ status: 409, body: { statusCode: 409, code: 'TICKET_ALREADY_OPEN', message: '이미 열린 A/S 접수가 있습니다.' } }),
    });
    const bad = await api('/me/service-tickets', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(ApiError);
    expect(bad).toMatchObject({ status: 400, code: null, message: 'symptom은 공백만으로 쓸 수 없습니다., serialNo must be a string' });
    expect(await api('/me/service-tickets/1').catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'TICKET_ALREADY_OPEN' });
  });

  it('401이면 로그인 정보를 비운다. 로그인 요청 자체의 401(비밀번호 틀림)은 그대로 둔다', async () => {
    mockApi({
      'GET /me/terminals': () => ({ status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: 'x' } }),
      'POST /auth/login': () => ({ status: 401, body: { statusCode: 401, code: 'LOGIN_FAILED', message: 'x' } }),
    });
    loginAs();
    await api('/auth/login', { method: 'POST', body: {} }).catch(() => undefined);
    expect(getMe()).not.toBeNull();
    await api('/me/terminals').catch(() => undefined);
    expect(getMe()).toBeNull();
  });
});
```

`apps/merchant/src/lib/format.test.ts`(KST 기대값은 어드민 `lib/format.test.ts`와 같다):

```ts
import { describe, expect, it } from 'vitest';
import { agoText, formatKst, formatKstShort } from './format';

describe('KST 시각 (어드민 lib/format.test.ts와 같은 값)', () => {
  it('UTC ISO를 KST로, 밀리초는 버린다', () => {
    expect(formatKst('2026-10-23T00:00:00.000Z')).toBe('2026-10-23 09:00:00 KST');
    expect(formatKst('2026-12-31T15:00:05.900Z')).toBe('2027-01-01 00:00:05 KST');
    expect(formatKst(null)).toBe('-');
    expect(formatKst(undefined)).toBe('-');
    expect(formatKst('T')).toBe('T');
  });

  it('짧은 KST는 월-일 시:분', () => {
    expect(formatKstShort('2026-10-27T15:30:45Z')).toBe('10-28 00:30');
    expect(formatKstShort(undefined)).toBe('-');
  });

  it('얼마나 전인가 — 분·시간·일, 미래는 방금 전', () => {
    const now = new Date('2026-10-28T03:00:00Z');
    expect(agoText('2026-10-28T02:59:30Z', now)).toBe('방금 전');
    expect(agoText('2026-10-28T02:15:00Z', now)).toBe('45분 전');
    expect(agoText('2026-10-27T22:00:00Z', now)).toBe('5시간 전');
    expect(agoText('2026-10-25T03:00:00Z', now)).toBe('3일 전');
    expect(agoText('2026-10-28T03:05:00Z', now)).toBe('방금 전');
  });
});
```

`vite.config.ts`(테스트 설정도 여기):

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 점주 화면(보강 3, decisions/0057). 어드민과 같은 방식으로 개발 서버가 /api를 Nest api로 넘긴다(앞의 /api는 떼고) — 같은 출처라
 * api에 CORS를 열지 않고 세션 쿠키(sid, SameSite=Strict)가 그대로 붙는다(api decisions/0041·0050).
 * MERCHANT_API_URL로 api 주소를 바꾼다(기본 http://localhost:3000). 포트는 어드민(5173·4173) 옆 5174·4174.
 */
const apiProxy = {
  '/api': {
    target: process.env.MERCHANT_API_URL ?? 'http://localhost:3000',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true, proxy: apiProxy },
  preview: { port: 4174, strictPort: true, proxy: apiProxy },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

```bash
cd apps/merchant && npx vitest run
```

Expected(사전 검증 원문): `Error: Failed to resolve import "../session" from "src/test/setup.ts". Does the file exist?`, `Test Files  3 failed (3)`, `Tests  no tests`.

- [ ] **Step 3: 앱 골격 — 어드민에서 옮겨 온 것(decisions/0058)**

`apps/merchant/index.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#0969da" />
    <title>단말온 가맹점</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/merchant/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { createQueryClient } from './query-client';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

`apps/merchant/src/api/client.ts`(어드민 `api/client.ts`에서 version 충돌 판정·내려받기 주소를 뺀 것):

```ts
import type { ApiErrorBody, ErrorCode } from '@terminal-ops/contracts';
import { setMe } from '../session';

/**
 * api 호출 한 곳. 어드민 `apps/admin/src/api/client.ts`를 옮겨 온 것이다(공유 패키지로 빼지 않은 이유: decisions/0058) —
 * 오류 모양·401 처리 규칙이 같아야 하므로 고칠 때는 두 파일을 같이 본다. 어드민에만 있던 것(파일 내려받기 주소, version 충돌 판정)은 뺐다.
 */

/** 개발 서버 프록시가 Nest api로 넘기는 경로 앞부분(vite.config.ts) */
export const API_BASE = '/api';

/** api 오류 응답. 서버는 { statusCode, code?, message } 모양(contracts ApiErrorBody)으로 준다 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** 서버가 준 원인 코드(TICKET_ALREADY_OPEN …). 검증 오류(400)·404에는 없다 */
    readonly code: ErrorCode | null,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  query?: Query;
}

/** 빈 값(undefined·null·'')은 빼고 쿼리 문자열을 만든다 */
export function toQueryString(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function messageOf(status: number, body: unknown): string {
  const raw = (body as { message?: unknown } | null)?.message;
  if (Array.isArray(raw)) return raw.join(', '); // ValidationPipe는 항목별 메시지 배열을 준다
  if (typeof raw === 'string' && raw) return raw;
  return `HTTP ${status}`;
}

/** 로그인 요청 자체의 401(LOGIN_FAILED)은 세션이 끝난 것이 아니다 */
const LOGIN_PATH = '/auth/login';

/**
 * 로그인은 서버 세션 쿠키(httpOnly, 같은 출처라 브라우저가 붙인다 — api decisions/0050)라 여기서 붙이는 인증 헤더는 없다.
 * 2xx가 아니면 ApiError를 던진다. 401이면 로그인 정보를 비워 AuthGate가 로그인 화면으로 보낸다.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}${toQueryString(options.query)}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }
  if (!res.ok) {
    if (res.status === 401 && path !== LOGIN_PATH) setMe(null);
    const code = (body as Partial<ApiErrorBody> | null)?.code;
    throw new ApiError(res.status, typeof code === 'string' ? code : null, messageOf(res.status, body), body);
  }
  return body as T;
}
```

`apps/merchant/src/session.ts`(어드민 `session.ts`에서 역할 묶음·`hasRole`을 뺀 것):

```ts
import { useSyncExternalStore } from 'react';
import type { MeView } from '@terminal-ops/contracts';

/**
 * 지금 로그인한 사람(GET /auth/me 결과만, 어드민 session.ts와 같은 규칙 — decisions/0058). 세션 자체는 서버의 httpOnly 쿠키다.
 * - undefined: 아직 모름(AuthGate가 /auth/me를 부른다)
 * - null: 로그인 안 함(또는 세션이 끝남 — api()가 401을 받으면 null로 바꾼다)
 * 저장소(localStorage)에 남기지 않는다 — 새로 열면 서버에 다시 묻는다.
 */
export type MeState = MeView | null | undefined;

let current: MeState = undefined;
const listeners = new Set<() => void>();

export function getMe(): MeState {
  return current;
}

/** 로그인한 사람이 바뀔 때 부르는 정리 함수(쿼리 캐시 비우기 — SessionCacheSync가 등록) */
let onUserChange: (() => void) | null = null;

export function registerUserChangeHandler(handler: (() => void) | null): void {
  onUserChange = handler;
}

/** 일부러 로그아웃했나(true면 AuthGate가 돌아올 주소를 남기지 않는다). 401로 끝난 것과 구분 */
let endedByLogout = false;

export function wasLoggedOutOnPurpose(): boolean {
  return endedByLogout;
}

export function setLoggedOut(): void {
  setMe(null);
  endedByLogout = true;
}

/** 아이디가 달라지면(null 포함) 구독자에게 알리기 전에 캐시부터 비운다 — 앞사람의 매장 데이터가 다음 사람에게 보이지 않게 */
export function setMe(me: MeView | null): void {
  if (current !== undefined && (current?.loginId ?? null) !== (me?.loginId ?? null)) onUserChange?.();
  if (me) endedByLogout = false;
  current = me;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMe(): MeState {
  return useSyncExternalStore(subscribe, getMe);
}

/** 테스트용: 모르는 상태로 되돌린다 */
export function resetSessionForTest(): void {
  current = undefined;
  endedByLogout = false;
  onUserChange = null;
  listeners.forEach((listener) => listener());
}
```

`apps/merchant/src/query-client.ts`:

```ts
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api/client';

/** 조회 재시도 판정: 4xx는 다시 해도 같아서 안 하고, 연결 실패·5xx는 한 번만(어드민과 같은 규칙) */
export function shouldRetry(count: number, error: unknown): boolean {
  return !(error instanceof ApiError && error.status < 500) && count < 1;
}

/**
 * 서버 상태 캐시(TanStack Query). 휴대폰은 앱을 오가며 쓰므로 어드민과 달리 창으로 돌아올 때 다시 읽는다(refetchOnWindowFocus 기본값) —
 * 점주가 다른 앱에서 돌아왔을 때 배송·A/S 단계가 바뀌어 있을 수 있다. staleTime 30초라 금방 다시 와도 매번 읽지는 않는다.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 30_000 },
      mutations: { retry: false },
    },
  });
}
```

`apps/merchant/src/lib/format.ts`:

```ts
/** 한국 시간(KST)은 UTC+9, 일광 절약 시간 없음. api common/kst.ts·어드민 lib/format.ts와 같은 규칙(같은 테스트 값으로 맞춘다, decisions/0058) */
const KST_OFFSET_MS = 9 * 3_600_000;

const pad = (n: number) => String(n).padStart(2, '0');

/** api가 주는 UTC ISO 시각을 'YYYY-MM-DD HH:mm:ss KST'로(밀리초 버림). null·undefined는 '-', 읽을 수 없는 값은 그대로 */
export function formatKst(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  return `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())} ${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}:${pad(k.getUTCSeconds())} KST`;
}

/** 휴대폰 화면용 짧은 KST: 'MM-DD HH:mm' */
export function formatKstShort(value: string | null | undefined): string {
  const full = formatKst(value);
  return /^\d{4}-/.test(full) ? full.slice(5, 16) : full;
}

/** 지금보다 얼마나 전인가: 1분 안 '방금 전', 1시간 안 'N분 전', 하루 안 'N시간 전', 그 뒤 'N일 전'(내림). 미래(시계 차이)는 '방금 전' */
export function agoText(iso: string, now: Date): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const min = Math.floor(Math.max(0, now.getTime() - t) / 60_000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}시간 전`;
  return `${Math.floor(min / (24 * 60))}일 전`;
}
```

`apps/merchant/src/hooks/useSessionCheck.ts`:

```ts
import { useEffect, useState } from 'react';
import type { MeView } from '@terminal-ops/contracts';
import { api, ApiError } from '../api/client';
import { setMe, useMe } from '../session';

/** 내 정보를 아직 모르면 GET /auth/me로 서버 세션을 확인해 채운다. 401이면 로그인 안 한 것(null). 어드민과 같다 */
export function useSessionCheck() {
  const me = useMe();
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (me !== undefined) return;
    let cancelled = false;
    api<MeView>('/auth/me')
      .then((m) => !cancelled && setMe(m))
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) setMe(null);
        else setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [me]);
  return { me, error };
}
```

`apps/merchant/src/components/SessionCacheSync.tsx`:

```tsx
import { useLayoutEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { registerUserChangeHandler } from '../session';

/** 로그인한 사람이 바뀌면(로그인·로그아웃·401) 서버 상태 캐시를 모두 비운다 — 어드민 SessionCacheSync와 같다(앞 점주의 매장 데이터가 남지 않게) */
export function SessionCacheSync() {
  const client = useQueryClient();
  useLayoutEffect(() => {
    registerUserChangeHandler(() => client.clear());
    return () => registerUserChangeHandler(null);
  }, [client]);
  return null;
}
```

`apps/merchant/src/api/query-keys.ts`:

```ts
/**
 * 쿼리 키. 모두 'me'로 시작한다 — 점주 화면의 쓰기(고장 접수·설치 확인)는 단말기 상태·배송·A/S를 함께 바꾸므로
 * 쓰기 뒤에는 `keys.all`을 통째로 무효화한다(화면이 몇 개 안 되고 한 매장 데이터라 다시 읽는 양이 작다).
 */
export const keys = {
  all: ['me'] as const,
  merchant: ['me', 'merchant'] as const,
  terminals: ['me', 'terminals'] as const,
  terminal: (serialNo: string) => ['me', 'terminal', serialNo] as const,
  tickets: (serialNo?: string) => ['me', 'tickets', serialNo ?? ''] as const,
  ticket: (id: number) => ['me', 'ticket', id] as const,
};
```

- [ ] **Step 4: 점주 앱만의 것 — 로그인 문(MERCHANT만), 화면 틀, 점주 오류 문구, 로그인 화면, CSS**

`apps/merchant/src/components/ErrorBox.tsx`:

```tsx
import type { ErrorCode } from '@terminal-ops/contracts';
import { ApiError } from '../api/client';

/**
 * 점주에게 보이는 안내. 어드민 ErrorBox와 모양은 같고 문구가 다르다(운영자 용어·할 일 대신 점주가 할 일, decisions/0060).
 * 서버 메시지(운영자용 문장일 수 있다)는 작은 글씨로 아래에 둔다 — 본사에 문의할 때 그대로 읽어 줄 수 있게.
 */
const HINT: Partial<Record<ErrorCode, string>> = {
  TICKET_ALREADY_OPEN: '이 단말기는 이미 접수된 A/S가 있습니다. A/S 목록에서 진행 상황을 확인하세요.',
  TERMINAL_NOT_IN_SERVICE: '사용 중인 단말기만 고장 접수할 수 있습니다.',
  TICKET_NOT_REPLACING: '지금은 설치 확인을 할 수 없는 단계입니다. 화면을 새로 고쳐 진행 상황을 확인하세요.',
  INVALID_TRANSITION: '교체 단말기가 아직 도착 처리되지 않아 설치 확인을 할 수 없습니다.',
  DEADLOCK: '잠시 뒤 다시 시도하세요.',
  FORBIDDEN: '가맹점 계정으로 로그인해야 쓸 수 있습니다.',
  UNAUTHENTICATED: '로그인이 끝났습니다. 다시 로그인하세요.',
  LOGIN_FAILED: '아이디 또는 비밀번호가 맞지 않습니다.',
  LOGIN_LOCKED: '로그인 실패가 많아 잠시 막혔습니다. 잠시 뒤 다시 시도하세요.',
};

export function describeError(error: unknown): { title: string; detail: string; code: ErrorCode | null } {
  if (error instanceof ApiError) {
    const hint = (error.code && HINT[error.code]) ?? (error.status === 400 ? '입력한 내용을 확인하세요.' : error.status === 404 ? '찾는 내용이 없습니다.' : null);
    return { title: hint ?? `요청이 실패했습니다(HTTP ${error.status}). 잠시 뒤 다시 시도하세요.`, detail: error.message, code: error.code };
  }
  return { title: '서버에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.', detail: error instanceof Error ? error.message : String(error), code: null };
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const { title, detail, code } = describeError(error);
  return (
    <div className="error" role="alert">
      <strong>{title}</strong>
      <small className="error-detail">
        {detail}
        {code ? ` (${code})` : null}
      </small>
    </div>
  );
}
```

`apps/merchant/src/components/LogoutButton.tsx`(어드민 `UserBar`의 로그아웃 규칙):

```tsx
import { useState } from 'react';
import { api, ApiError } from '../api/client';
import { setLoggedOut } from '../session';
import { describeError } from './ErrorBox';

/** 로그아웃: 서버 세션을 끊은 뒤 화면 쪽 로그인 정보를 비운다(캐시는 SessionCacheSync가 비운다). 어드민 UserBar와 같은 규칙 */
export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch (e) {
      // 401이면 서버 세션이 이미 끝난 것. 그 밖의 실패는 세션이 남았을 수 있어 로그인 상태를 유지하고 알린다
      if (!(e instanceof ApiError && e.status === 401)) {
        setError(e);
        setBusy(false);
        return;
      }
    }
    setLoggedOut();
  };

  return (
    <>
      <button type="button" className="link" disabled={busy} onClick={() => void logout()}>
        로그아웃
      </button>
      {error ? (
        <span className="error" role="alert">
          로그아웃하지 못했습니다. 다시 시도하세요. ({describeError(error).detail})
        </span>
      ) : null}
    </>
  );
}
```

`apps/merchant/src/components/AuthGate.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useSessionCheck } from '../hooks/useSessionCheck';
import { wasLoggedOutOnPurpose } from '../session';
import { ErrorBox } from './ErrorBox';
import { LogoutButton } from './LogoutButton';

/**
 * 로그인해야 보이는 화면들의 문. 처음에는 GET /auth/me로 서버 세션을 확인하고, 로그인 안 했으면 로그인 화면으로(돌아올 주소와 함께).
 * 가맹점 계정(MERCHANT)만 쓴다 — 사내 직원 계정이면 안내와 로그아웃만(어드민의 반대, decisions/0057). 서버도 `/me`를 MERCHANT만 받는다(403).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { me, error } = useSessionCheck();
  const location = useLocation();

  if (me === undefined) return error ? <ErrorBox error={error} /> : <p className="page">로그인 확인 중…</p>;
  if (me === null) {
    const state = wasLoggedOutOnPurpose() ? undefined : { from: `${location.pathname}${location.search}` };
    return <Navigate to="/login" replace state={state} />;
  }
  if (me.role !== 'MERCHANT') {
    return (
      <div className="page narrow">
        <p>이 화면은 가맹점(점주) 계정용입니다. 사내 직원 계정은 운영 어드민을 쓰세요.</p>
        <LogoutButton />
      </div>
    );
  }
  return <>{children}</>;
}
```

`apps/merchant/src/components/Shell.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router';
import type { MerchantView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { useMe } from '../session';
import { LogoutButton } from './LogoutButton';

/**
 * 휴대폰 화면 틀: 위에 내 매장 이름과 로그아웃, 가운데 화면, 아래에 탭 두 개(홈·A/S). 넓은 화면에서도 가운데 한 줄(최대 560px)로 둔다.
 * 매장 이름은 GET /me/merchant(로그인한 가맹점, 바뀌는 일이 드물어 staleTime 무한 — 사람이 바뀌면 캐시가 비워진다).
 */
export function Shell() {
  const me = useMe();
  const merchant = useQuery({ queryKey: keys.merchant, queryFn: () => api<MerchantView>('/me/merchant'), staleTime: Infinity });
  return (
    <div className="shell">
      <header className="top">
        <div>
          <strong className="store">{merchant.data?.name ?? me?.merchantCode ?? '내 매장'}</strong>
          <small>{me?.displayName}</small>
        </div>
        <LogoutButton />
      </header>
      <main className="page">
        <Outlet />
      </main>
      <nav className="tabs" aria-label="메뉴">
        <NavLink to="/" end>
          홈
        </NavLink>
        <NavLink to="/service-tickets">A/S</NavLink>
      </nav>
    </div>
  );
}
```

`apps/merchant/src/pages/LoginPage.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import type { LoginRequest, MeView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { ErrorBox } from '../components/ErrorBox';
import { useSessionCheck } from '../hooks/useSessionCheck';
import { setMe } from '../session';

/** 점주 로그인(api decisions/0050, 같은 POST /auth/login). 성공하면 서버가 httpOnly 세션 쿠키를 주고, 화면은 응답(내 정보)만 기억한다 */
export function LoginPage() {
  const { me, error: checkError } = useSessionCheck();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: (body: LoginRequest) => api<MeView>('/auth/login', { method: 'POST', body }),
    onSuccess: (m) => {
      setMe(m);
      navigate(from, { replace: true });
    },
  });

  if (me) return <Navigate to={from} replace />;
  if (me === undefined && !checkError) return <p className="page">로그인 확인 중…</p>;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate({ loginId: loginId.trim(), password } satisfies LoginRequest);
  };

  return (
    <form className="page narrow login" onSubmit={submit}>
      <h1>단말온 가맹점</h1>
      <p className="muted">우리 매장 단말기와 A/S를 확인합니다.</p>
      <label>
        아이디
        <input aria-label="아이디" autoComplete="username" autoCapitalize="none" value={loginId} maxLength={50} onChange={(e) => setLoginId(e.target.value)} />
      </label>
      <label>
        비밀번호
        <input aria-label="비밀번호" type="password" autoComplete="current-password" value={password} maxLength={200} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button type="submit" className="primary" disabled={!loginId.trim() || !password || login.isPending}>
        로그인
      </button>
      <ErrorBox error={login.error} />
    </form>
  );
}
```

`apps/merchant/src/App.tsx`(홈은 Task 3에서 채운다):

```tsx
import { Route, Routes } from 'react-router';
import { AuthGate } from './components/AuthGate';
import { SessionCacheSync } from './components/SessionCacheSync';
import { Shell } from './components/Shell';
import { LoginPage } from './pages/LoginPage';

/** 화면 경로. /login 말고는 모두 가맹점 계정으로 로그인해야 보인다(AuthGate) */
export function App() {
  return (
    <>
      <SessionCacheSync />
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route
          element={
            <AuthGate>
              <Shell />
            </AuthGate>
          }
        >
          <Route index element={<p>홈 화면은 다음 Task에서 채운다.</p>} />
          <Route path="*" element={<p>없는 화면입니다.</p>} />
        </Route>
      </Routes>
    </>
  );
}
```

`apps/merchant/src/styles.css`(휴대폰 폭 기준, Task 4가 끝에 고르기 칸을 더한다):

```css
/*
 * 점주 화면 전역 CSS 한 장(어드민과 같은 방식, decisions/0041·0057). 휴대폰 폭(360~430px)이 기준이고, 넓은 화면에서는 가운데 한 줄(최대 560px).
 * 누르는 것은 높이 44px 이상(손가락), 글자는 16px(입력칸이 16px보다 작으면 iOS가 확대한다).
 */
:root {
  --fg: #1f2328;
  --muted: #656d76;
  --line: #d0d7de;
  --bg: #f6f8fa;
  --card: #ffffff;
  --accent: #0969da;
  --danger: #cf222e;
  --ok: #1a7f37;
  --warn: #9a6700;
  font-family: system-ui, 'Malgun Gothic', sans-serif;
  font-size: 16px;
  line-height: 1.5;
  color: var(--fg);
  background: var(--bg);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
}

.shell {
  max-width: 560px;
  min-height: 100vh;
  margin: 0 auto;
  background: var(--bg);
  padding-bottom: 64px; /* 아래 탭 높이 */
}

.top {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 16px;
  background: var(--card);
  border-bottom: 1px solid var(--line);
}

.top .store {
  display: block;
  font-size: 18px;
}

.top small {
  color: var(--muted);
}

.page {
  padding: 16px;
}

.narrow {
  max-width: 420px;
  margin: 0 auto;
}

.tabs {
  position: fixed;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 100%;
  max-width: 560px;
  display: flex;
  background: var(--card);
  border-top: 1px solid var(--line);
}

.tabs a {
  flex: 1;
  min-height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  text-decoration: none;
  font-weight: 600;
}

.tabs a.active {
  color: var(--accent);
  box-shadow: inset 0 3px 0 var(--accent);
}

h1 {
  font-size: 22px;
  margin: 8px 0 16px;
}

h2 {
  font-size: 18px;
  margin: 24px 0 8px;
}

.muted {
  color: var(--muted);
}

.card {
  display: block;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px 16px;
  margin-bottom: 8px;
  color: inherit;
  text-decoration: none;
}

a.card:active {
  background: var(--bg);
}

.card-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  background: var(--bg);
  border: 1px solid var(--line);
  white-space: nowrap;
}

.badge.ok {
  color: var(--ok);
  border-color: var(--ok);
}

.badge.warn {
  color: var(--warn);
  border-color: var(--warn);
}

.badge.danger {
  color: var(--danger);
  border-color: var(--danger);
}

.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 6px;
  background: var(--muted);
}

.dot.on {
  background: var(--ok);
}

.dot.off {
  background: var(--danger);
}

/* 진행 단계: 위에서 아래로 한 줄씩(휴대폰 폭에서 가로 막대는 글자가 잘린다) */
.steps {
  list-style: none;
  margin: 8px 0;
  padding: 0;
}

.steps li {
  position: relative;
  padding: 0 0 12px 28px;
  color: var(--muted);
}

.steps li::before {
  content: '';
  position: absolute;
  left: 6px;
  top: 6px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--line);
  background: var(--card);
}

.steps li.done {
  color: var(--fg);
}

.steps li.done::before {
  background: var(--ok);
  border-color: var(--ok);
}

.steps li.current {
  color: var(--accent);
  font-weight: 700;
}

.steps li.current::before {
  border-color: var(--accent);
}

label {
  display: block;
  margin-bottom: 12px;
  font-weight: 600;
}

input,
select,
textarea {
  display: block;
  width: 100%;
  margin-top: 4px;
  padding: 10px 12px;
  font: inherit;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--card);
}

button {
  min-height: 44px;
  padding: 8px 16px;
  font: inherit;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--card);
  cursor: pointer;
}

button.primary {
  width: 100%;
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 700;
}

button.link {
  min-height: 44px;
  border: none;
  background: none;
  color: var(--accent);
  padding: 8px 0;
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}

.error {
  margin: 12px 0;
  padding: 12px;
  border: 1px solid var(--danger);
  border-radius: 8px;
  color: var(--danger);
  background: #fff5f5;
}

.error-detail {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  word-break: break-all;
}

.notice {
  padding: 12px;
  border-radius: 8px;
  background: #fff8c5;
  border: 1px solid #d4a72c;
}

dl.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 8px 0;
}

dl.facts dt {
  color: var(--muted);
}

dl.facts dd {
  margin: 0;
  word-break: break-all;
}
```

- [ ] **Step 5: 통과·타입·빌드**

```bash
cd apps/merchant && npx vitest run && npm run build && rm -rf dist
```

Expected: `Test Files  3 passed (3)`, `Tests  11 passed (11)`(App 5, client 3, format 3). build는 `tsc --noEmit` 출력 없음 → `✓ built in …ms`(index.html·css 약 3.5kB·js 약 298kB). `dist`는 `.gitignore`다(지워도 된다).

- [ ] **Step 6: 기록**

`docs/decisions/0057-점주-화면은-별도-앱-apps-merchant.md`(새 파일):

```markdown
# 0057. 점주 화면은 어드민 안이 아니라 별도 앱 apps/merchant로 만든다

- 날짜 / 관련 기능: 2026-10-28 / 보강 3(점주 화면), 어드민
- 상황: 보강 2로 가맹점주(MERCHANT) 로그인과 `/me` API가 생겼지만(decisions/0053) 어드민은 가맹점주에게 안내와 로그아웃만 보인다. 점주 화면은 사용자(가게 주인)·기기(휴대폰)·말투(운영자 용어가 아님)·메뉴(홈·A/S 둘)가 어드민과 다르다. 통합 시연(Docker 묶음)에서 "본사 화면"과 "점주 화면"이 따로 보이면 이야기가 분명하다.
- 선택지:
  1. 어드민 안에 MERCHANT 전용 경로(`/store/*`)와 레이아웃 — 장점: 설치·빌드·로그인 화면·api 클라이언트가 하나. 단점: 사이드 메뉴·넓은 표 중심의 어드민 CSS와 휴대폰 화면이 한 장의 CSS에서 섞이고(decisions/0041 "전역 CSS 한 장"), `AuthGate`·`RequireRole`·메뉴 표가 역할마다 갈라진다. 어드민 번들에 점주 화면이, 점주 휴대폰에 어드민 코드 전체가 내려간다. 운영자 화면을 고칠 때 점주 화면 테스트가 같이 깨질 수 있다
  2. **별도 앱 `apps/merchant`(React 19 + Vite + TanStack Query + react-router, 어드민과 같은 판·같은 방식)** — 장점: 화면·CSS·테스트가 분리되고 모바일 우선으로 처음부터 짠다. Vite 개발 서버 프록시(`/api` → api)로 같은 출처라 세션 쿠키(SameSite=Strict)가 그대로 붙고 api에 CORS를 열지 않는다(decisions/0041과 같은 이유). Docker 통합 때 컨테이너 하나로 따로 띄운다. 단점: 설치할 앱이 하나 늘고(`npm ci` 다섯 번), 어드민과 같은 코드(api 클라이언트·세션·KST 시각)가 두 벌이 된다(decisions/0058)
  3. 서버 렌더링(api가 점주 HTML을 그림) — Nest에 화면 템플릿이 들어가고, 화면 테스트 도구가 어드민과 달라진다
- 결정: 2.
  - 포트: 개발 서버 5174, 미리보기 4174(어드민 5173·4173 옆, `strictPort`). api 주소는 `MERCHANT_API_URL`(기본 `http://localhost:3000`)
  - 의존성 판은 어드민과 **같게**: 어드민 `package.json`·`package-lock.json`을 복사해 `name`만 바꾸고(lock은 두 줄) `npm ci` — 사전 검증에서 같은 트리(`npm ls --depth=0`이 어드민과 같은 16개), 새 판을 고르지 않으니 2주 규칙(decisions/0041)도 그대로다
  - 로그인은 같은 `POST /auth/login`. 점주 화면은 MERCHANT만 쓴다 — 직원 계정이면 안내와 로그아웃만(어드민의 반대). 서버도 `/me`를 MERCHANT만 받는다(403)
  - 화면: 홈(오고 있는 단말기·진행 중 A/S·사용 중 단말기·회수), 단말기 상세, A/S 목록·접수·상세(설치 확인). 아래 탭 두 개(홈·A/S), 위에 매장 이름·로그아웃. 휴대폰 폭이 기준이고 넓은 화면에서는 가운데 한 줄(최대 560px)
  - 창으로 돌아올 때 다시 읽는다(TanStack Query 기본값, staleTime 30초) — 어드민은 끄지만(운영자가 보던 값이 바뀌지 않게) 점주는 다른 앱을 오가다 돌아와 배송·A/S 단계를 본다
- 결과·대가: 앱 다섯 개. README 설치 줄·테스트 표·launch.json에 한 줄씩. 어드민의 가맹점주 안내 문구가 이 앱을 가리키게 된다. 운영 배포(정적 파일 + 역프록시)는 어드민과 같이 범위 밖.
- 다시 볼 조건: 화면이 세 번째로 늘거나(현장 작업자 앱 등) 공통 코드가 자주 함께 바뀌면 — 공유 패키지(decisions/0058 다시 볼 조건). 점주가 오프라인·푸시 알림이 필요하면 PWA·네이티브.
```

`docs/decisions/0058-화면-공통-코드는-공유-패키지가-아니라-복사로.md`(새 파일 — 사전 검증 출력은 이 계획 "사전 검증" 절):

```markdown
# 0058. 어드민·점주 화면의 공통 코드는 공유 패키지로 빼지 않고 복사한다

- 날짜 / 관련 기능: 2026-10-28 / 보강 3, 어드민·점주 화면
- 상황: 점주 앱(decisions/0057)에도 api 클라이언트(`api()`·`ApiError`·쿼리 문자열·401이면 로그인 정보 비우기), 세션 저장소(`useSyncExternalStore`), 사람이 바뀌면 캐시 비우기, 세션 확인 훅, KST 시각 형식, 조회 재시도 판정이 필요하다. 어드민에 이미 있다. 보강 1은 **타입만** 있는 `packages/contracts`를 `file:` 의존 + TS 소스로 나눴고(decisions/0047), 그 결정의 단점이 "런타임 값을 넣으면 이 방식으로는 안 된다"(node가 `.ts`를 못 읽음)였다. 이번 소비자는 둘 다 Vite 앱이라 Vite가 TS 소스를 직접 번들하면 될 수도 있다 — 사전 검증으로 확인했다.
- 사전 검증(임시 복제본, 어드민에 `packages/web-common`을 `file:../../packages/web-common`으로 연결 — `npm install`이 lock에 9줄, `node_modules/@terminal-ops/web-common`은 패키지 폴더 링크. `exports`는 TS 소스 `./src/index.ts`):
  - (a) **의존성 없는 순수 TS 함수**(KST 형식): 설정 없이 tsc 0, vitest 통과(`Tests 1 passed`), `vite build` 성공(번들에 함수가 들어감). Vite는 링크의 실제 경로(`packages/…`, `node_modules` 밖)를 소스로 보고 변환한다
  - (b) **React 훅·JSX가 든 모듈**: tsc `TS2307: Cannot find module 'react'`·`TS2875: … 'react/jsx-runtime' …`, vitest `Failed to resolve import "react" from "../../packages/web-common/src/store.ts"`, build `Rolldown failed to resolve import "react"` — 패키지 폴더 위로 `node_modules`가 없어(저장소 루트 `node_modules`는 비어 있다) bare import를 못 찾는다. 앱 `vite.config.ts`에 `resolve: { dedupe: ['react', 'react-dom'] }`와 앱 `tsconfig.json`에 `paths`(`react`·`react/*` → 앱의 `node_modules/@types/react`)를 더하면 tsc 0·vitest 통과(훅이 앱의 React 하나로 돌았다)·build 성공
  - (c) **계약 타입만 import해도**(`import type { ErrorCode } from '@terminal-ops/contracts'` — `ApiError`가 쓴다): `TS2307: Cannot find module '@terminal-ops/contracts'` — 공유 패키지 자신에게 contracts 링크가 없다. `paths`를 하나 더 두거나 공유 패키지도 `npm install`로 자기 `node_modules`를 가져야 한다
- 선택지:
  1. `packages/web-common`(TS 소스, `file:` 의존) — 장점: 한 곳에서 고친다. 단점: 위 (b)(c) 때문에 쓰는 앱마다 `resolve.dedupe`와 `paths`(react·react-dom·@tanstack/react-query·contracts — 공유 코드가 import하는 것마다)를 손으로 맞추거나, 공유 패키지가 자기 lock과 `npm ci`를 가져 React가 두 벌 설치된다(dedupe를 잊으면 훅 오류는 실행 때만 보인다). 어드민 코드를 옮기는 변경이 함께 들어가 어드민 테스트 125개가 영향 범위에 들어온다
  2. 빌드 산출물 패키지(JS + d.ts, peerDependencies) — 빌드 단계·산출물 관리가 생기고 두 앱이 개발 중에 그 빌드를 기다린다
  3. 루트 npm workspaces — decisions/0047이 잰 것처럼 lock을 합치며 잠긴 판이 바뀐다(43/707). 이번 보강의 범위를 넘는다
  4. **복사(점주 앱에 맞게 덜어 낸 사본)** — 장점: 설정 없음, 어드민을 건드리지 않음, 점주 쪽은 필요 없는 것을 뺀다(version 충돌 판정, 파일 내려받기 주소, 역할 묶음). 단점: 같은 규칙이 두 곳 — 고칠 때 둘 다 봐야 한다
- 결정: 4. 사본 머리 주석에 "어드민 `…`을 옮겨 온 것 — 고칠 때 두 파일을 같이 본다"를 적고, KST 형식은 어드민 테스트와 **같은 기대값**으로 테스트한다(api `common/kst.ts`·어드민·점주 세 곳이 같은 값). 오류 안내(`ErrorBox`)는 복사가 아니라 점주 문구로 새로 쓴다(decisions/0060). 공유 안 하는 대신 의존성 판을 어드민과 같은 lock으로 맞춘다(decisions/0057).
- 결과·대가: 같은 규칙의 코드가 두 벌(점주 쪽 파일 7개, 주석 포함 약 270줄 — `api/client.ts`, `session.ts`, `components/SessionCacheSync.tsx`, `hooks/useSessionCheck.ts`, `query-client.ts`의 재시도 판정, `lib/format.ts`의 `formatKst`, 어드민 `UserBar`의 로그아웃 부분을 옮긴 `components/LogoutButton.tsx`). 버그를 한쪽에서만 고칠 위험 — 머리 주석과 같은 테스트 값으로 줄인다.
- 다시 볼 조건: 화면 앱이 셋이 되거나, 같은 버그를 두 사본에서 고치는 일이 두 번 생기면 — workspaces(lock 판 올림은 따로 한 커밋으로) 또는 빌드 산출물 패키지. 그때 위 (b)(c)의 설정이 필요 없는 길을 고른다. React를 쓰지 않는 순수 함수만 나눌 때는 (a)처럼 지금 방식(`file:` + TS 소스)으로도 된다.
```

`docs/decisions/0047-공유-타입은-file-의존-타입-전용-TS-소스-패키지로.md` 끝에:

```diff
diff --git a/docs/decisions/0047-공유-타입은-file-의존-타입-전용-TS-소스-패키지로.md b/docs/decisions/0047-공유-타입은-file-의존-타입-전용-TS-소스-패키지로.md
index f3bb380..89f7f42 100644
--- a/docs/decisions/0047-공유-타입은-file-의존-타입-전용-TS-소스-패키지로.md
+++ b/docs/decisions/0047-공유-타입은-file-의존-타입-전용-TS-소스-패키지로.md
@@ -11,3 +11,4 @@
 - 결정: 2. 이유: 지금 저장소 구조(앱별 lock, `npm ci`)를 그대로 두고, 계약 파일까지 tsc가 검사하며, 런타임에는 아무것도 더하지 않는다. 계약은 **타입만** 둔다 — 모든 import는 `import type`이고 빌드된 JS에 이 패키지 import가 남지 않는다(사전 검증: `grep -rl "terminal-ops/contracts" dist` 0곳, `node dist/main.js` 기동·응답 확인).
 - 결과·대가: `packages/contracts`는 의존성이 없어 따로 설치하지 않는다. 두 앱의 `npm ci`가 링크를 만든다(`node_modules/@terminal-ops/contracts` → `packages/contracts`). 계약 편집기 설정용 `tsconfig.json`만 두고 검사는 쓰는 쪽 tsc에 맡긴다. 어드민의 선택지 목록 같은 값은 계약에 두지 않고 이름표 `Record<유니온, string>`의 키로 만든다.
 - 다시 볼 조건: 계약에 런타임 값(상수 배열, 검증 스키마)을 넣어야 할 때 — 빌드 산출물(JS + d.ts)을 내는 패키지나 workspaces로. 앱이 늘어 설치·버전 관리를 한 곳에서 하고 싶어질 때 — workspaces(그때는 의존성 판 올림을 따로 한 커밋으로). api를 외부에 공개할 때 — OpenAPI. contracts에 의존성이나 버전을 더하거나 바꿀 때는 각 앱(api·admin)의 `package-lock.json`을 다시 만든다(`file:` 링크의 lock 항목이 어긋난다). drift 테스트가 TypeScript 진단 문구(오류 코드와 메시지)에 기대므로 TS 7(네이티브)로 올릴 때는 테스트의 기대값을 다시 본다.
+- 보강 3 보탬(decisions/0058): 화면 공통 런타임 코드(api 클라이언트·세션)를 이 방식(`file:` + TS 소스)으로 나눌 수 있는지 사전 검증했다. 소비자가 Vite 앱이면 순수 함수는 설정 없이 tsc·vitest·build가 됐지만, React나 contracts를 import하는 모듈은 패키지 폴더 위에 `node_modules`가 없어 앱마다 `resolve.dedupe`와 tsconfig `paths`가 필요했다 → 점주 앱은 복사로 갔다. 이 패키지(contracts)는 계속 타입만.
```

`docs/study/backlog.md` 끝에 한 줄:

```markdown
- [ ] Vite가 `node_modules` 밖으로 링크된 패키지(npm `file:`)를 다루는 방식 — 링크의 실제 경로를 소스로 변환, bare import는 그 파일 위치에서 찾음, `resolve.dedupe`·tsconfig `paths` (decisions/0058)
```

`node scripts/docs-index.mjs` → `decisions 59, troubleshooting 32, experiments 17`.

devlog 항목:

```markdown
## HH:MM Task 2 점주 앱 골격 — 설치·Vite 프록시·로그인 문·화면 틀·api 클라이언트 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <Task 1 커밋 해시> (feat(merchant, F7): 점주 화면용 /me 보강)
- 한 일: `apps/merchant` — 어드민 package.json·lock을 복사해 name만 바꾸고 `npm ci`(added 113, 어드민과 같은 판), Vite 5174/4174·`/api` 프록시(`MERCHANT_API_URL`), api 클라이언트·세션·캐시 비우기·세션 확인·KST(어드민 사본), 로그인 문(MERCHANT만 — 직원 계정은 안내와 로그아웃), 화면 틀(매장 이름 `GET /me/merchant`·로그아웃·아래 탭), 점주 문구 ErrorBox, 휴대폰 폭 CSS
- 확인: 먼저 본 실패 `Test Files  3 failed (3)`(모듈 없음) → `Tests  11 passed (11)`, build 성공
- 결정: decisions/0057(별도 앱), 0058(공통 코드는 복사 — 공유 패키지 사전 검증 결과), 0047 보탬
- 막힌 것: (없으면 "없음")
- 다음: Task 3 홈·단말기 상세
```

- [ ] **Step 7: 커밋**

```bash
git add apps/merchant docs
git status --short apps/merchant   # node_modules·dist가 없어야 한다(.gitignore)
git commit -m "$(cat <<'EOF'
feat(merchant): 점주 앱 골격 — 로그인 문·화면 틀·api 클라이언트(어드민과 같은 판)

Refs: docs/decisions/0057-점주-화면은-별도-앱-apps-merchant.md, docs/decisions/0058-화면-공통-코드는-공유-패키지가-아니라-복사로.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 시각 = 커밋 시각 확인(다르면 고쳐 amend).


### Task 3: 홈·단말기 상세 — 점주 이름표, 택배·A/S 단계 함수, 접속·배송·회수 안내

**Files:**
- Create: `apps/merchant/src/lib/{labels.ts,steps.ts}`, `src/components/{StepList,TerminalBits}.tsx`, `src/api/queries.ts`, `src/pages/{HomePage,TerminalDetailPage}.tsx`, `src/test/fixtures.ts`
- Modify: `apps/merchant/src/App.tsx`
- Test: Create `src/lib/steps.test.ts`, `src/pages/TerminalPages.test.tsx`
- Docs: Create `docs/decisions/0060-점주-문구와-진행-단계는-화면이-상태에서-만든다.md`; Modify `docs/study/backlog.md`, `docs/index.md`, `docs/devlog/2026-10-28.md`

- [ ] **Step 1: 실패하는 테스트**

`apps/merchant/src/lib/steps.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { canConfirmInstall, shipmentSteps, ticketSteps, type Step } from './steps';

/** 'done·current·todo'를 한 줄로: 지난 칸 ✓, 지금 ▶, 아직 · */
const line = (steps: Step[]) => steps.map((s) => `${s.state === 'done' ? '✓' : s.state === 'current' ? '▶' : '·'}${s.label}`).join(' ');

describe('A/S 진행 단계 (decisions/0060)', () => {
  it('접수만 됐으면 원격 점검을 기다린다, 원격 점검 뒤에는 교체 출고를 기다린다', () => {
    expect(line(ticketSteps({ status: 'OPEN', remoteChecked: false, replacementStatus: null }))).toBe('✓접수 ▶원격 점검 ·교체 출고 ·배송 중 ·설치 확인 ·완료');
    expect(line(ticketSteps({ status: 'OPEN', remoteChecked: true, replacementStatus: null }))).toBe('✓접수 ✓원격 점검 ▶교체 출고 ·배송 중 ·설치 확인 ·완료');
  });

  it('교체 단말기가 배송 중이면 배송 중, 도착하면 설치 확인 차례', () => {
    expect(line(ticketSteps({ status: 'REPLACING', remoteChecked: true, replacementStatus: 'SHIPPED' }))).toBe('✓접수 ✓원격 점검 ✓교체 출고 ▶배송 중 ·설치 확인 ·완료');
    expect(line(ticketSteps({ status: 'REPLACING', remoteChecked: false, replacementStatus: 'DELIVERED' }))).toBe('✓접수 ✓원격 점검 ✓교체 출고 ✓배송 중 ▶설치 확인 ·완료');
  });

  it('완료와 원격 해결은 모두 지남', () => {
    expect(line(ticketSteps({ status: 'CLOSED', remoteChecked: true, replacementStatus: 'IN_SERVICE' }))).toBe('✓접수 ✓원격 점검 ✓교체 출고 ✓배송 중 ✓설치 확인 ✓완료');
    expect(line(ticketSteps({ status: 'RESOLVED_REMOTELY', remoteChecked: true, replacementStatus: null }))).toBe('✓접수 ✓원격 점검 ✓원격으로 해결');
  });

  it('설치 확인은 교체 진행 중 + 교체 단말기 도착일 때만', () => {
    expect(canConfirmInstall({ status: 'REPLACING', replacementStatus: 'DELIVERED' })).toBe(true);
    expect(canConfirmInstall({ status: 'REPLACING', replacementStatus: 'SHIPPED' })).toBe(false);
    expect(canConfirmInstall({ status: 'CLOSED', replacementStatus: 'IN_SERVICE' })).toBe(false);
    expect(canConfirmInstall({ status: 'OPEN', replacementStatus: null })).toBe(false);
  });
});

describe('택배 단계', () => {
  const at = '2026-10-28T01:00:00.000Z';
  it('이벤트가 없으면 출고 다음(택배사 인수)을 기다린다', () => {
    expect(line(shipmentSteps({ status: 'IN_TRANSIT', events: [] }))).toBe('✓출고 ▶택배사 인수 ·이동 중 ·배송 출발 ·배송 완료');
  });

  it('가장 멀리 간 이벤트까지 지남(순서 없이 와도)', () => {
    const events = [
      { code: 'OUT_FOR_DELIVERY' as const, occurredAt: at },
      { code: 'PICKED_UP' as const, occurredAt: at },
    ];
    expect(line(shipmentSteps({ status: 'IN_TRANSIT', events }))).toBe('✓출고 ✓택배사 인수 ✓이동 중 ✓배송 출발 ▶배송 완료');
  });

  it('운송장이 배송 완료면 이벤트가 없어도 모두 지남(손으로 넣은 배송 완료)', () => {
    expect(line(shipmentSteps({ status: 'DELIVERED', events: [] }))).toBe('✓출고 ✓택배사 인수 ✓이동 중 ✓배송 출발 ✓배송 완료');
  });
});
```

`apps/merchant/src/test/fixtures.ts`(서버 응답 모양 — 계약 타입으로 만든다):

```ts
import type { MerchantTerminalDetail, MerchantTerminalView, MerchantTicketView } from '@terminal-ops/contracts';

/** 서버 GET /me/terminals 한 줄 모양(api toMerchantTerminalView). 기본은 사용 중·연결됨 */
export const terminal = (over: Partial<MerchantTerminalView> = {}): MerchantTerminalView => ({
  serialNo: 'SN-0001',
  modelCode: 'SN-100',
  modelName: '단말온 S100',
  status: 'IN_SERVICE',
  statusChangedAt: '2026-10-20T01:00:00.000Z',
  connectivity: { online: true, lastSeenAt: '2026-10-28T02:58:00.000Z', firmwareVersion: '1.2.0' },
  shipment: null,
  ...over,
});

export const terminalDetail = (over: Partial<MerchantTerminalDetail> = {}): MerchantTerminalDetail => ({
  ...terminal(),
  events: [
    { status: 'ALLOCATED', occurredAt: '2026-10-18T01:00:00.000Z' },
    { status: 'SHIPPED', occurredAt: '2026-10-18T03:00:00.000Z' },
    { status: 'DELIVERED', occurredAt: '2026-10-19T05:00:00.000Z' },
    { status: 'IN_SERVICE', occurredAt: '2026-10-20T01:00:00.000Z' },
  ],
  ...over,
});

/** 서버 /me/service-tickets 한 줄 모양(api toMerchantTicketView). 기본은 막 접수한 것 */
export const ticket = (over: Partial<MerchantTicketView> = {}): MerchantTicketView => ({
  id: 7,
  serialNo: 'SN-0001',
  merchantCode: 'GANGNAM-KIMBAP',
  symptom: '카드 인식 안 됨: 오전부터',
  status: 'OPEN',
  replacementSerialNo: null,
  outboundShipmentId: null,
  outboundTrackingNo: null,
  openedByMe: true,
  remoteChecked: false,
  replacementStatus: null,
  createdAt: '2026-10-28T01:00:00.000Z',
  closedAt: null,
  ...over,
});

/** 빈 목록 응답 */
export const page = <T>(items: T[]) => ({ items, total: items.length, page: 1, size: 100 });
export const keyset = <T>(items: T[]) => ({ items, nextBeforeId: null });
```

`apps/merchant/src/pages/TerminalPages.test.tsx`("N분 전"이 흔들리지 않게 `Date`만 가짜로):

```tsx
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { keyset, page, terminal, terminalDetail, ticket } from '../test/fixtures';
import { loginAs, mockApi, renderPage } from '../test/render';
import { HomePage } from './HomePage';
import { TerminalDetailPage } from './TerminalDetailPage';

/** "N분 전"이 실제 시계에 흔들리지 않게 Date만 고정한다(타이머는 진짜 — TanStack Query·user-event가 쓴다) */
const freeze = () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-28T03:00:00.000Z'));
};

const shipping = terminal({
  serialNo: 'SN-0101',
  status: 'SHIPPED',
  connectivity: null,
  shipment: {
    carrier: 'NEURIMBO',
    trackingNo: 'NR-123',
    status: 'IN_TRANSIT',
    createdAt: '2026-10-28T00:00:00.000Z',
    deliveredAt: null,
    ticketId: 7,
    events: [{ code: 'PICKED_UP', occurredAt: '2026-10-28T01:00:00.000Z' }],
  },
});

describe('홈 (보강 3, decisions/0060)', () => {
  it('오고 있는 단말기 → 진행 중 A/S → 사용 중 단말기 → 회수, 점주 말로', async () => {
    freeze();
    loginAs();
    const { calls } = mockApi({
      'GET /me/terminals': () => ({
        body: page([
          terminal(),
          terminal({ serialNo: 'SN-0002', connectivity: { online: false, lastSeenAt: '2026-10-28T01:00:00.000Z', firmwareVersion: '1.1.0' } }),
          shipping,
          terminal({ serialNo: 'SN-0009', status: 'RETURN_REQUESTED', connectivity: null }),
        ]),
      }),
      'GET /me/service-tickets': () => ({ body: keyset([ticket({ status: 'REPLACING', remoteChecked: true, replacementStatus: 'SHIPPED' }), ticket({ id: 3, status: 'CLOSED' })]) }),
    });
    renderPage(<HomePage />);

    const headings = await screen.findAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual(['오고 있는 단말기', '진행 중인 A/S', '사용 중인 단말기', '회수']);

    const coming = within(screen.getByRole('region', { name: '오고 있는 단말기' }));
    expect(coming.getByText('배송 중')).toBeInTheDocument();
    expect(coming.getByText('느림보물류 NR-123 · 이동 중')).toBeInTheDocument();
    expect(coming.getByText('A/S #7 교체 단말기')).toBeInTheDocument();

    const tickets = within(screen.getByRole('region', { name: '진행 중인 A/S' }));
    expect(tickets.getAllByRole('link')).toHaveLength(1); // 완료(CLOSED)는 빠진다
    expect(tickets.getByText('지금 단계: 배송 중')).toBeInTheDocument();
    expect(tickets.getByText('교체 진행 중')).toBeInTheDocument();

    const inService = within(screen.getByRole('region', { name: '사용 중인 단말기' }));
    expect(inService.getByText(/연결됨 · 마지막 접속 2분 전/)).toBeInTheDocument();
    expect(inService.getByText(/연결 끊김 · 마지막 접속 2시간 전/)).toBeInTheDocument();
    expect(inService.getAllByRole('link')[0]).toHaveAttribute('href', '/terminals/SN-0001');

    const returns = within(screen.getByRole('region', { name: '회수' }));
    expect(returns.getByText('회수 준비 중')).toBeInTheDocument();
    expect(returns.getByText(/기사님이 방문해 수거합니다/)).toBeInTheDocument();

    expect(calls.find((c) => c.path === '/me/terminals')?.query.get('size')).toBe('100');
  });

  it('단말기도 A/S도 없으면 안내만', async () => {
    loginAs();
    mockApi({ 'GET /me/terminals': () => ({ body: page([]) }), 'GET /me/service-tickets': () => ({ body: keyset([]) }) });
    renderPage(<HomePage />);
    expect(await screen.findByText('우리 매장에 등록된 단말기가 없습니다.')).toBeInTheDocument();
    expect(await screen.findByText('진행 중인 A/S가 없습니다.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '사용 중인 단말기' })).not.toBeInTheDocument();
  });
});

describe('단말기 상세', () => {
  const renderDetail = (serialNo = 'SN-0001') => renderPage(<TerminalDetailPage />, { route: `/terminals/${serialNo}`, path: '/terminals/:serialNo' });

  it('사용 중: 연결·펌웨어, 지난 일은 최근 것 위에 점주 말로, 열린 A/S가 없으면 고장 접수 링크', async () => {
    freeze();
    loginAs();
    const { calls } = mockApi({
      'GET /me/terminals/:serialNo': () => ({ body: terminalDetail() }),
      'GET /me/service-tickets': () => ({ body: keyset([ticket({ id: 3, status: 'CLOSED' })]) }),
    });
    renderDetail();
    expect(await screen.findByRole('heading', { name: '단말온 S100' })).toBeInTheDocument();
    expect(screen.getByText(/연결됨 · 마지막 접속 2분 전/)).toBeInTheDocument();
    expect(screen.getByText('2026-10-28 11:58:00 KST')).toBeInTheDocument();
    expect(screen.getByText('1.2.0')).toBeInTheDocument();
    const events = within(screen.getByRole('list', { name: '지난 일' })).getAllByRole('listitem');
    expect(events.map((e) => e.textContent)).toEqual(['10-20 10:00 설치 완료', '10-19 14:00 매장 도착', '10-18 12:00 택배 출발', '10-18 10:00 우리 매장으로 배정']);
    expect(await screen.findByRole('link', { name: /고장 접수하기/ })).toHaveAttribute('href', '/service-tickets/new?serialNo=SN-0001');
    expect(screen.getByRole('link', { name: /A\/S #3/ })).toHaveAttribute('href', '/service-tickets/3');
    expect(calls.find((c) => c.path === '/me/service-tickets')?.query.get('serialNo')).toBe('SN-0001');
  });

  it('열린 A/S가 있으면 고장 접수 링크를 숨긴다', async () => {
    loginAs();
    mockApi({
      'GET /me/terminals/:serialNo': () => ({ body: terminalDetail() }),
      'GET /me/service-tickets': () => ({ body: keyset([ticket({ status: 'OPEN' })]) }),
    });
    renderDetail();
    expect(await screen.findByRole('link', { name: /A\/S #7/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /고장 접수하기/ })).not.toBeInTheDocument();
  });

  it('배송 중인 교체 단말기: 택배 단계(지금 단계 표시)와 A/S 링크, 연결 칸은 없다', async () => {
    loginAs();
    mockApi({
      'GET /me/terminals/:serialNo': () => ({ body: { ...shipping, events: [{ status: 'ALLOCATED', occurredAt: '2026-10-28T00:00:00.000Z' }] } }),
      'GET /me/service-tickets': () => ({ body: keyset([]) }),
    });
    renderDetail('SN-0101');
    const steps = within(await screen.findByRole('list', { name: '배송 단계' })).getAllByRole('listitem');
    expect(steps.map((s) => s.textContent)).toEqual(['출고', '택배사 인수', '이동 중', '배송 출발', '배송 완료']);
    expect(steps[2]).toHaveAttribute('aria-current', 'step');
    expect(screen.getByRole('link', { name: '#7 교체 단말기' })).toHaveAttribute('href', '/service-tickets/7');
    expect(screen.queryByRole('heading', { name: '연결' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /고장 접수하기/ })).not.toBeInTheDocument();
  });

  it('남의 단말기·본사로 돌아간 단말기(404)는 "찾는 내용이 없습니다"', async () => {
    loginAs();
    mockApi({
      'GET /me/terminals/:serialNo': () => ({ status: 404, body: { statusCode: 404, message: '단말기 SN-9이(가) 없습니다.' } }),
      'GET /me/service-tickets': () => ({ body: keyset([]) }),
    });
    renderDetail('SN-9');
    expect(await screen.findByRole('alert')).toHaveTextContent('찾는 내용이 없습니다.');
  });
});
```

```bash
cd apps/merchant && npx vitest run
```

Expected(사전 검증 원문): `Error: Failed to resolve import "./steps" from "src/lib/steps.test.ts"`, `Error: Failed to resolve import "./HomePage" from "src/pages/TerminalPages.test.tsx"`, `Test Files  2 failed | 3 passed (5)`, `Tests  11 passed (11)`.

- [ ] **Step 2: 이름표와 단계 함수**

`apps/merchant/src/lib/labels.ts`(점주 말 — 키는 contracts 유니온):

```ts
import type { Carrier, CarrierEventCode, ServiceTicketStatus, TerminalStatus } from '@terminal-ops/contracts';

/**
 * 점주에게 보이는 이름(decisions/0060). 어드민 lib/labels.ts(운영자 용어)와 일부러 다르다 — 점주는 "배정·회수 요청" 같은 본사 업무 단계가 아니라
 * "언제 오나, 쓸 수 있나, 무엇을 하면 되나"를 본다. 키는 contracts의 상태 유니온 — 상태가 늘면 여기서 tsc가 빠진 이름을 알려 준다.
 * 점주에게 보이지 않는 상태(입고·검수·재고·불량·폐기, api MERCHANT_VISIBLE_STATUSES 밖)도 Record라 이름은 둔다(화면에 나오지 않는다).
 */
export const TERMINAL_STATUS_LABEL: Record<TerminalStatus, string> = {
  RECEIVED: '본사 입고',
  INSPECTED: '본사 검수 완료',
  DEFECTIVE: '본사 불량 처리',
  IN_STOCK: '본사 보관',
  ALLOCATED: '보낼 준비 중',
  SHIPPED: '배송 중',
  DELIVERED: '도착(설치 전)',
  IN_SERVICE: '사용 중',
  RETURN_REQUESTED: '회수 준비 중',
  RETURNING: '회수 중',
  RETURNED: '회수 완료',
  DISPOSED: '본사 폐기',
};

/** 상태 배지 색(ok 초록·warn 노랑·danger 빨강, 없으면 회색) */
export const TERMINAL_STATUS_TONE: Partial<Record<TerminalStatus, 'ok' | 'warn' | 'danger'>> = {
  IN_SERVICE: 'ok',
  SHIPPED: 'warn',
  DELIVERED: 'warn',
  ALLOCATED: 'warn',
  RETURN_REQUESTED: 'danger',
  RETURNING: 'danger',
};

/** 단말기 상세의 "지난 일" 한 줄 — 상태가 된 순간을 점주 말로 */
export const TERMINAL_EVENT_LABEL: Record<TerminalStatus, string> = {
  RECEIVED: '본사 입고',
  INSPECTED: '본사 검수',
  DEFECTIVE: '본사 불량 판정',
  IN_STOCK: '본사 보관',
  ALLOCATED: '우리 매장으로 배정',
  SHIPPED: '택배 출발',
  DELIVERED: '매장 도착',
  IN_SERVICE: '설치 완료',
  RETURN_REQUESTED: '회수 요청(고장 단말기)',
  RETURNING: '기사님 수거',
  RETURNED: '본사 도착(회수 완료)',
  DISPOSED: '본사 폐기',
};

/** 회수 중인 단말기에 붙이는 안내 — 점주가 할 일 */
export const RETURN_GUIDE: Partial<Record<TerminalStatus, string>> = {
  RETURN_REQUESTED: '교체 단말기를 설치한 뒤 고장 단말기는 상자에 담아 두세요. 기사님이 방문해 수거합니다.',
  RETURNING: '기사님이 수거했습니다. 본사에 도착하면 회수 완료로 바뀝니다.',
  RETURNED: '본사에 도착했습니다. 더 하실 일은 없습니다.',
};

export const TICKET_STATUS_LABEL: Record<ServiceTicketStatus, string> = {
  OPEN: '확인 중',
  RESOLVED_REMOTELY: '원격으로 해결',
  REPLACING: '교체 진행 중',
  CLOSED: '완료',
};

export const CARRIER_LABEL: Record<Carrier, string> = {
  BUNGAE: '번개택배',
  NEURIMBO: '느림보물류',
};

/** 택배 단계(택배사 이벤트 코드) */
export const CARRIER_EVENT_LABEL: Record<CarrierEventCode, string> = {
  PICKED_UP: '택배사 인수',
  IN_TRANSIT: '이동 중',
  OUT_FOR_DELIVERY: '배송 출발',
  DELIVERED: '배송 완료',
};

/** 고장 증상 고르기(A/S 접수). 고른 것과 메모를 "증상: 메모"로 이어 symptom(200자)에 넣는다 — 서버 칸은 글 하나다(decisions/0060) */
export const SYMPTOMS = ['카드 인식 안 됨', '영수증 출력 안 됨', '전원 안 켜짐', '통신 연결 안 됨', '화면·버튼 이상', '기타'] as const;
```

`apps/merchant/src/lib/steps.ts`:

```ts
import type { CarrierEventCode, MerchantShipmentView, MerchantTicketView } from '@terminal-ops/contracts';
import { CARRIER_EVENT_LABEL } from './labels';

/** 진행 단계 한 칸: 지난 단계(done), 지금 기다리는 단계(current), 아직(todo) */
export interface Step {
  label: string;
  state: 'done' | 'current' | 'todo';
}

/** 앞에서 n칸은 지남, 그다음 한 칸이 지금, 나머지는 아직. n이 칸 수 이상이면 모두 지남 */
function fill(labels: readonly string[], done: number): Step[] {
  return labels.map((label, i) => ({ label, state: i < done ? 'done' : i === done ? 'current' : 'todo' }));
}

/**
 * A/S 진행 단계(decisions/0060): 접수 → 원격 점검 → 교체 출고 → 배송 중 → 설치 확인 → 완료. 서버가 주는 상태 값(접수 상태, 원격 점검 여부,
 * 교체 단말기 상태)에서 화면이 만든다 — 서버에 "단계" 칸을 따로 두지 않는다. 원격으로 해결되면 세 칸(접수 → 원격 점검 → 원격으로 해결).
 * 원격 점검 없이 바로 교체한 접수도 교체 뒤에는 원격 점검 칸이 지난 것으로 보인다(점주에게는 "그 단계를 지났다"가 중요하다).
 */
export const TICKET_STEP_LABELS = ['접수', '원격 점검', '교체 출고', '배송 중', '설치 확인', '완료'] as const;

export function ticketSteps(t: Pick<MerchantTicketView, 'status' | 'remoteChecked' | 'replacementStatus'>): Step[] {
  switch (t.status) {
    case 'RESOLVED_REMOTELY':
      return fill(['접수', '원격 점검', '원격으로 해결'], 3);
    case 'CLOSED':
      return fill(TICKET_STEP_LABELS, TICKET_STEP_LABELS.length);
    case 'REPLACING':
      return fill(TICKET_STEP_LABELS, t.replacementStatus === 'DELIVERED' ? 4 : 3);
    case 'OPEN':
      return fill(TICKET_STEP_LABELS, t.remoteChecked ? 2 : 1);
  }
}

/** 설치 확인 버튼을 켤 때: 교체 진행 중이고 교체 단말기가 도착(DELIVERED)했을 때만. 서버도 같은 조건을 다시 검사한다(422) */
export function canConfirmInstall(t: Pick<MerchantTicketView, 'status' | 'replacementStatus'>): boolean {
  return t.status === 'REPLACING' && t.replacementStatus === 'DELIVERED';
}

const CARRIER_CODES: readonly CarrierEventCode[] = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'];

/**
 * 택배 단계: 출고 → 택배사 인수 → 이동 중 → 배송 출발 → 배송 완료. 가장 멀리 간 이벤트까지 지난 것으로 본다(이벤트가 늦게·순서 없이 와도).
 * 운송장이 배송 완료(DELIVERED)면 이벤트가 없어도 모두 지남 — 운영자가 손으로 배송 완료를 넣는 경우가 있다.
 */
export function shipmentSteps(s: Pick<MerchantShipmentView, 'status' | 'events'>): Step[] {
  const labels = ['출고', ...CARRIER_CODES.map((c) => CARRIER_EVENT_LABEL[c])];
  if (s.status === 'DELIVERED') return fill(labels, labels.length);
  const furthest = Math.max(-1, ...s.events.map((e) => CARRIER_CODES.indexOf(e.code)));
  return fill(labels, furthest + 2);
}
```

- [ ] **Step 3: 조회 훅과 작은 조각**

`apps/merchant/src/api/queries.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import type { BeforeIdPage, MerchantTerminalDetail, MerchantTerminalPage, MerchantTicketView } from '@terminal-ops/contracts';
import { api } from './client';
import { keys } from './query-keys';

/** 한 번에 받는 단말기 수(서버 상한 100). 한 매장 단말기는 이보다 훨씬 적다 — 넘으면 홈이 "N대 중 100대" 안내 */
export const TERMINAL_PAGE = 100;
/** 받는 최근 접수 수(서버 상한 100). 진행 중인 것만 고를 때는 화면이 거른다(서버 상태 조건은 하나만 된다) */
export const RECENT_TICKETS = 50;

/** 매장 단말기 목록(홈·A/S 접수 화면이 같은 키로 쓴다) */
export function useMyTerminals() {
  return useQuery({ queryKey: keys.terminals, queryFn: () => api<MerchantTerminalPage>('/me/terminals', { query: { size: TERMINAL_PAGE } }) });
}

/** 단말기 하나(이번 배정부터의 이력 포함). 남의 것·본사로 돌아간 것은 404 */
export function useMyTerminal(serialNo: string) {
  return useQuery({ queryKey: keys.terminal(serialNo), queryFn: () => api<MerchantTerminalDetail>(`/me/terminals/${encodeURIComponent(serialNo)}`) });
}

/** 최근 A/S 접수(serialNo가 있으면 그 단말기 것만) */
export function useMyTickets(serialNo?: string) {
  return useQuery({
    queryKey: keys.tickets(serialNo),
    queryFn: () => api<BeforeIdPage<MerchantTicketView>>('/me/service-tickets', { query: { limit: RECENT_TICKETS, serialNo } }),
  });
}

/** A/S 접수 한 건 */
export function useMyTicket(id: number) {
  return useQuery({ queryKey: keys.ticket(id), queryFn: () => api<MerchantTicketView>(`/me/service-tickets/${id}`) });
}
```

`apps/merchant/src/components/StepList.tsx`:

```tsx
import type { Step } from '../lib/steps';

/** 진행 단계를 위에서 아래로(휴대폰 폭에서 가로 막대는 글자가 잘린다). 지금 단계는 aria-current="step" */
export function StepList({ steps, label }: { steps: Step[]; label: string }) {
  return (
    <ol className="steps" aria-label={label}>
      {steps.map((s) => (
        <li key={s.label} className={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
          {s.label}
        </li>
      ))}
    </ol>
  );
}

/** 지금 단계 이름(모두 지났으면 마지막 칸) — 목록 카드의 한 줄 요약 */
export function currentStep(steps: Step[]): string {
  return (steps.find((s) => s.state === 'current') ?? steps[steps.length - 1]).label;
}
```

`apps/merchant/src/components/TerminalBits.tsx`:

```tsx
import type { MerchantConnectivity, MerchantShipmentView, TerminalStatus } from '@terminal-ops/contracts';
import { agoText, formatKst } from '../lib/format';
import { CARRIER_LABEL, TERMINAL_STATUS_LABEL, TERMINAL_STATUS_TONE } from '../lib/labels';
import { shipmentSteps } from '../lib/steps';
import { currentStep } from './StepList';

/** 상태 배지(점주 말, 색은 TERMINAL_STATUS_TONE) */
export function StatusBadge({ status }: { status: TerminalStatus }) {
  return <span className={`badge ${TERMINAL_STATUS_TONE[status] ?? ''}`}>{TERMINAL_STATUS_LABEL[status]}</span>;
}

/** 접속 한 줄: ● 연결됨/연결 끊김 · 마지막 접속 N분 전. 기록이 없으면 "접속 기록 없음" */
export function ConnectivityLine({ c, now }: { c: MerchantConnectivity; now: Date }) {
  if (!c.lastSeenAt) {
    return (
      <span>
        <span className="dot" aria-hidden />
        접속 기록 없음
      </span>
    );
  }
  return (
    <span title={formatKst(c.lastSeenAt)}>
      <span className={`dot ${c.online ? 'on' : 'off'}`} aria-hidden />
      {c.online ? '연결됨' : '연결 끊김'} · 마지막 접속 {agoText(c.lastSeenAt, now)}
    </span>
  );
}

/** 운송장 한 줄: 택배사 운송장번호 · 지금 단계 */
export function ShipmentLine({ s }: { s: MerchantShipmentView }) {
  return (
    <span>
      {CARRIER_LABEL[s.carrier]} {s.trackingNo} · {currentStep(shipmentSteps(s))}
    </span>
  );
}
```

- [ ] **Step 4: 화면**

`apps/merchant/src/pages/HomePage.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { MerchantTerminalView, TerminalStatus } from '@terminal-ops/contracts';
import { useMyTerminals, useMyTickets } from '../api/queries';
import { ErrorBox } from '../components/ErrorBox';
import { currentStep } from '../components/StepList';
import { ConnectivityLine, ShipmentLine, StatusBadge } from '../components/TerminalBits';
import { RETURN_GUIDE, TICKET_STATUS_LABEL } from '../lib/labels';
import { ticketSteps } from '../lib/steps';

const COMING: TerminalStatus[] = ['ALLOCATED', 'SHIPPED', 'DELIVERED'];
const RETURNS: TerminalStatus[] = ['RETURN_REQUESTED', 'RETURNING', 'RETURNED'];

function TerminalCard({ t, now, children }: { t: MerchantTerminalView; now: Date; children?: ReactNode }) {
  return (
    <Link className="card" to={`/terminals/${encodeURIComponent(t.serialNo)}`}>
      <div className="card-head">
        <strong>{t.modelName}</strong>
        <StatusBadge status={t.status} />
      </div>
      <div className="muted">{t.serialNo}</div>
      {t.connectivity ? (
        <div>
          <ConnectivityLine c={t.connectivity} now={now} />
          {t.connectivity.firmwareVersion ? <span className="muted"> · 펌웨어 {t.connectivity.firmwareVersion}</span> : null}
        </div>
      ) : null}
      {children}
    </Link>
  );
}

/**
 * 홈(점주가 가장 먼저 보는 화면, decisions/0060): 오고 있는 단말기(배송) → 진행 중 A/S → 사용 중 단말기(접속) → 회수 순서.
 * 점주가 지금 기다리거나 해야 할 일이 위에 온다. 단말기를 누르면 상세(이력·배송 단계·고장 접수).
 */
export function HomePage() {
  const terminals = useMyTerminals();
  const tickets = useMyTickets();
  const now = new Date(terminals.dataUpdatedAt || Date.now());

  if (terminals.error) return <ErrorBox error={terminals.error} />;
  if (!terminals.data) return <p>불러오는 중…</p>;

  const items = terminals.data.items;
  const coming = items.filter((t) => COMING.includes(t.status));
  const inService = items.filter((t) => t.status === 'IN_SERVICE');
  const returns = items.filter((t) => RETURNS.includes(t.status));
  const openTickets = (tickets.data?.items ?? []).filter((t) => t.status === 'OPEN' || t.status === 'REPLACING');

  return (
    <>
      {items.length === 0 ? <p className="muted">우리 매장에 등록된 단말기가 없습니다.</p> : null}
      {terminals.data.total > items.length ? (
        <p className="muted">
          {terminals.data.total}대 중 최근 {items.length}대만 보입니다.
        </p>
      ) : null}

      {coming.length > 0 ? (
        <section aria-labelledby="h-coming">
          <h2 id="h-coming">오고 있는 단말기</h2>
          {coming.map((t) => (
            <TerminalCard key={t.serialNo} t={t} now={now}>
              {t.shipment ? (
                <div>
                  <ShipmentLine s={t.shipment} />
                  {t.shipment.ticketId ? <div className="muted">A/S #{t.shipment.ticketId} 교체 단말기</div> : null}
                </div>
              ) : null}
              {t.status === 'DELIVERED' ? (
                <div className="muted">{t.shipment?.ticketId ? '설치한 뒤 A/S 화면에서 설치 확인을 눌러 주세요.' : '설치가 끝나면 사용 중으로 바뀝니다.'}</div>
              ) : null}
            </TerminalCard>
          ))}
        </section>
      ) : null}

      <section aria-labelledby="h-tickets">
        <h2 id="h-tickets">진행 중인 A/S</h2>
        {tickets.error ? <ErrorBox error={tickets.error} /> : null}
        {tickets.data && openTickets.length === 0 ? <p className="muted">진행 중인 A/S가 없습니다.</p> : null}
        {openTickets.map((t) => (
          <Link key={t.id} className="card" to={`/service-tickets/${t.id}`}>
            <div className="card-head">
              <strong>A/S #{t.id}</strong>
              <span className="badge warn">{TICKET_STATUS_LABEL[t.status]}</span>
            </div>
            <div className="muted">
              {t.serialNo} · {t.symptom}
            </div>
            <div>지금 단계: {currentStep(ticketSteps(t))}</div>
          </Link>
        ))}
      </section>

      {inService.length > 0 ? (
        <section aria-labelledby="h-terminals">
          <h2 id="h-terminals">사용 중인 단말기</h2>
          {inService.map((t) => (
            <TerminalCard key={t.serialNo} t={t} now={now} />
          ))}
        </section>
      ) : null}

      {returns.length > 0 ? (
        <section aria-labelledby="h-returns">
          <h2 id="h-returns">회수</h2>
          {returns.map((t) => (
            <TerminalCard key={t.serialNo} t={t} now={now}>
              <div className="muted">{RETURN_GUIDE[t.status]}</div>
            </TerminalCard>
          ))}
        </section>
      ) : null}
    </>
  );
}
```

`apps/merchant/src/pages/TerminalDetailPage.tsx`(고장 접수 링크의 화면은 Task 4가 만든다 — 그전에는 "없는 화면입니다"):

```tsx
import { Link, useParams } from 'react-router';
import { useMyTerminal, useMyTickets } from '../api/queries';
import { ErrorBox } from '../components/ErrorBox';
import { StepList } from '../components/StepList';
import { ConnectivityLine, StatusBadge } from '../components/TerminalBits';
import { formatKst, formatKstShort } from '../lib/format';
import { CARRIER_LABEL, RETURN_GUIDE, TERMINAL_EVENT_LABEL, TICKET_STATUS_LABEL } from '../lib/labels';
import { shipmentSteps } from '../lib/steps';

/**
 * 단말기 상세: 지금 상태, 접속(사용 중일 때), 배송 단계(오고 있을 때), 회수 안내, 지난 일(이번 배정부터, 최근 것 위), 이 단말기의 A/S.
 * 고장 접수 버튼은 사용 중이고 열린 A/S가 없을 때만 — 서버도 같은 조건을 다시 본다(422 TERMINAL_NOT_IN_SERVICE, 409 TICKET_ALREADY_OPEN).
 */
export function TerminalDetailPage() {
  const serialNo = useParams().serialNo!;
  const detail = useMyTerminal(serialNo);
  const tickets = useMyTickets(serialNo);

  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!detail.data) return <p>불러오는 중…</p>;
  const t = detail.data;
  const now = new Date(detail.dataUpdatedAt || Date.now());
  const hasOpenTicket = (tickets.data?.items ?? []).some((x) => x.status === 'OPEN' || x.status === 'REPLACING');

  return (
    <>
      <h1>{t.modelName}</h1>
      <p>
        <StatusBadge status={t.status} /> <span className="muted">{t.serialNo}</span>
      </p>

      {t.connectivity ? (
        <section aria-labelledby="h-conn">
          <h2 id="h-conn">연결</h2>
          <p>
            <ConnectivityLine c={t.connectivity} now={now} />
          </p>
          <dl className="facts">
            <dt>마지막 접속</dt>
            <dd>{formatKst(t.connectivity.lastSeenAt)}</dd>
            <dt>펌웨어</dt>
            <dd>{t.connectivity.firmwareVersion ?? '-'}</dd>
          </dl>
          {!t.connectivity.online && t.connectivity.lastSeenAt ? (
            <p className="notice">단말기 전원과 인터넷 선을 확인해 주세요. 계속 연결이 끊기면 고장 접수를 해 주세요.</p>
          ) : null}
        </section>
      ) : null}

      {t.shipment ? (
        <section aria-labelledby="h-ship">
          <h2 id="h-ship">배송</h2>
          <dl className="facts">
            <dt>택배사</dt>
            <dd>{CARRIER_LABEL[t.shipment.carrier]}</dd>
            <dt>운송장</dt>
            <dd>{t.shipment.trackingNo}</dd>
            {t.shipment.ticketId ? (
              <>
                <dt>A/S</dt>
                <dd>
                  <Link to={`/service-tickets/${t.shipment.ticketId}`}>#{t.shipment.ticketId} 교체 단말기</Link>
                </dd>
              </>
            ) : null}
          </dl>
          <StepList label="배송 단계" steps={shipmentSteps(t.shipment)} />
        </section>
      ) : null}

      {RETURN_GUIDE[t.status] ? <p className="notice">{RETURN_GUIDE[t.status]}</p> : null}

      {t.status === 'IN_SERVICE' && tickets.data && !hasOpenTicket ? (
        <Link className="card" to={`/service-tickets/new?serialNo=${encodeURIComponent(t.serialNo)}`}>
          <strong>고장 접수하기</strong>
          <div className="muted">증상을 고르면 본사가 원격으로 먼저 점검합니다.</div>
        </Link>
      ) : null}

      <section aria-labelledby="h-tickets">
        <h2 id="h-tickets">이 단말기의 A/S</h2>
        {tickets.error ? <ErrorBox error={tickets.error} /> : null}
        {tickets.data && tickets.data.items.length === 0 ? <p className="muted">A/S 접수가 없습니다.</p> : null}
        {(tickets.data?.items ?? []).map((x) => (
          <Link key={x.id} className="card" to={`/service-tickets/${x.id}`}>
            <div className="card-head">
              <strong>A/S #{x.id}</strong>
              <span className="badge">{TICKET_STATUS_LABEL[x.status]}</span>
            </div>
            <div className="muted">
              {formatKstShort(x.createdAt)} · {x.symptom}
            </div>
          </Link>
        ))}
      </section>

      <section aria-labelledby="h-events">
        <h2 id="h-events">지난 일</h2>
        <ul aria-label="지난 일" className="card">
          {[...t.events].reverse().map((e) => (
            <li key={`${e.status}-${e.occurredAt}`}>
              <span className="muted">{formatKstShort(e.occurredAt)}</span> {TERMINAL_EVENT_LABEL[e.status]}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
```

`apps/merchant/src/App.tsx`:

```diff
diff --git a/apps/merchant/src/App.tsx b/apps/merchant/src/App.tsx
index f7d429a..bde3146 100644
--- a/apps/merchant/src/App.tsx
+++ b/apps/merchant/src/App.tsx
@@ -2,7 +2,9 @@ import { Route, Routes } from 'react-router';
 import { AuthGate } from './components/AuthGate';
 import { SessionCacheSync } from './components/SessionCacheSync';
 import { Shell } from './components/Shell';
+import { HomePage } from './pages/HomePage';
 import { LoginPage } from './pages/LoginPage';
+import { TerminalDetailPage } from './pages/TerminalDetailPage';
 
 /** 화면 경로. /login 말고는 모두 가맹점 계정으로 로그인해야 보인다(AuthGate) */
 export function App() {
@@ -18,7 +20,8 @@ export function App() {
             </AuthGate>
           }
         >
-          <Route index element={<p>홈 화면은 다음 Task에서 채운다.</p>} />
+          <Route index element={<HomePage />} />
+          <Route path="terminals/:serialNo" element={<TerminalDetailPage />} />
           <Route path="*" element={<p>없는 화면입니다.</p>} />
         </Route>
       </Routes>
```

- [ ] **Step 5: 통과·타입·빌드**

```bash
cd apps/merchant && npx vitest run && npm run build && rm -rf dist
```

Expected: `Test Files  5 passed (5)`, `Tests  24 passed (24)`(steps 7, 홈·상세 6 더함), build 성공.

- [ ] **Step 6: 기록**

`docs/decisions/0060-점주-문구와-진행-단계는-화면이-상태에서-만든다.md`(새 파일 — A/S 화면의 증상 고르기는 Task 4가 쓰지만 결정은 여기서 함께 적는다. `SYMPTOMS`가 이 Task의 `labels.ts`에 있다):

```markdown
# 0060. 점주에게 보이는 문구와 진행 단계는 화면이 상태 값에서 만든다

- 날짜 / 관련 기능: 2026-10-28 / 보강 3, F7(A/S), F3(배송)
- 상황: 점주는 운영자 용어(배정·회수 요청·RETURN_REQUESTED)가 아니라 "언제 오나, 쓸 수 있나, 내가 무엇을 하면 되나"를 본다. A/S는 접수 → 원격 점검 → 교체 출고 → 배송 중 → 설치 확인 → 완료로 보여야 하는데 서버의 접수 상태는 넷(OPEN·RESOLVED_REMOTELY·REPLACING·CLOSED)뿐이다. 배송은 택배사 이벤트 코드(PICKED_UP …)로 온다. 고장 접수는 증상을 고르고 메모를 덧붙이게 하고 싶은데 서버 칸은 `symptom`(1~200자) 하나다.
- 선택지:
  1. 서버가 점주 문구·단계 이름을 응답에 넣기(`statusLabel`, `stepName`) — 장점: 화면이 얇다. 단점: 점주 말투가 api에 들어가고 문구를 바꿀 때마다 api 배포. 어드민도 같은 상태를 다른 말로 보여 줘 서버 문구가 두 벌이 된다(api 레이블은 알림·리포트처럼 서버가 쓰는 곳만 — decisions/0037)
  2. 서버에 단계 칸(`step` enum)을 따로 저장 — 단계가 상태에서 계산되는 값인데 저장하면 두 값이 어긋날 수 있다
  3. **화면이 계약의 상태 값으로 만든다** — 이름표는 `Record<상태 유니온, string>`(contracts 유니온이 키라 상태가 늘면 tsc가 빠진 이름을 알려 준다, decisions/0047의 이름표 방식), 단계는 순수 함수(`ticketSteps`, `shipmentSteps`) + 단위 테스트. 서버는 단계 계산에 필요한 사실만 준다(`remoteChecked`, `replacementStatus`, 택배 이벤트 — decisions/0059)
- 결정: 3.
  - 이름표(`apps/merchant/src/lib/labels.ts`): 단말기 상태(예: ALLOCATED "보낼 준비 중", SHIPPED "배송 중", DELIVERED "도착(설치 전)", IN_SERVICE "사용 중", RETURN_REQUESTED "회수 준비 중", RETURNING "회수 중", RETURNED "회수 완료"), 상세 이력 한 줄(ALLOCATED "우리 매장으로 배정", SHIPPED "택배 출발" …), 회수 안내(점주가 할 일), 접수 상태(OPEN "확인 중", REPLACING "교체 진행 중" …), 택배 단계. 점주에게 보이지 않는 상태(decisions/0059)도 `Record`라 이름은 둔다(화면에 나오지 않는다)
  - A/S 단계(`lib/steps.ts` `ticketSteps`): OPEN이면 원격 점검 전/후(`remoteChecked`), REPLACING이면 교체 단말기가 SHIPPED → "배송 중", DELIVERED → "설치 확인" 차례, CLOSED는 모두 지남, RESOLVED_REMOTELY는 세 칸(접수 → 원격 점검 → 원격으로 해결). 원격 점검 없이 바로 교체한 접수도 교체 뒤에는 원격 점검 칸이 지난 것으로 보인다(점주에게는 "그 단계를 지났다"가 중요). 설치 확인 버튼은 `REPLACING` + 교체 단말기 `DELIVERED`일 때만(`canConfirmInstall`) — 서버도 다시 검사한다(422)
  - 택배 단계(`shipmentSteps`): 출고 → 택배사 인수 → 이동 중 → 배송 출발 → 배송 완료, 가장 멀리 간 이벤트까지 지남(늦게·순서 없이 와도), 운송장이 DELIVERED면 이벤트가 없어도 모두 지남(운영자가 손으로 배송 완료를 넣는 경우)
  - 증상: 고르기 여섯(`SYMPTOMS`) + 메모(선택)를 `"증상: 메모"`로 이어 `symptom`에 넣는다. 메모 입력칸 길이는 합쳐 200자가 넘지 않게(`memoMax`). 버린 것: 서버에 증상 코드 칸 더하기(운영자 A/S 화면·리포트도 바꿔야 하고, 지금 운영자는 글을 읽는다)
  - 오류 안내(`ErrorBox`)도 점주 문구(예: `TICKET_ALREADY_OPEN` "이 단말기는 이미 접수된 A/S가 있습니다 …"). 서버 메시지는 작은 글씨로 아래에(본사에 문의할 때 읽어 줄 수 있게)
- 결과·대가: 같은 상태의 이름이 어드민(운영자 말)·점주(점주 말) 두 곳에 있다 — 의도. 단계 규칙이 화면에 있어 다른 클라이언트(앱·알림)가 생기면 다시 만들어야 한다. 증상 고르기가 글 안에 섞여 통계를 내려면 글을 잘라야 한다.
- 다시 볼 조건: 점주용 알림(문자·톡)처럼 서버가 점주 문구를 보내야 할 때 — 그때는 이름표를 서버(api 레이블 파일)로. 증상별 통계가 필요해지면 증상 코드 칸.
```

`docs/study/backlog.md` 끝에 한 줄:

```markdown
- [ ] `aria-current="step"`과 `<section aria-labelledby>` — 진행 단계의 "지금"과 영역 이름을 화면 읽기 도구에 알리기, Testing Library `getByRole('region', { name })` (apps/merchant/src/components/StepList.tsx, pages/TerminalPages.test.tsx)
```

`node scripts/docs-index.mjs` → `decisions 60, troubleshooting 32, experiments 17`.

devlog 항목:

```markdown
## HH:MM Task 3 점주 홈·단말기 상세 — 이름표, 택배·A/S 단계, 접속·배송·회수 안내 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <Task 2 커밋 해시> (feat(merchant): 점주 앱 골격)
- 한 일: 점주 이름표(`labels.ts` — 단말기 상태·지난 일·회수 안내·접수 상태·택배사·택배 단계·증상), 단계 함수(`ticketSteps`·`canConfirmInstall`·`shipmentSteps`), 홈(오고 있는 단말기 → 진행 중 A/S → 사용 중 단말기 → 회수), 단말기 상세(연결·배송 단계·회수 안내·고장 접수 링크·이 단말기의 A/S·지난 일)
- 확인: 먼저 본 실패 `Test Files  2 failed | 3 passed (5)`(모듈 없음) → `Tests  24 passed (24)`, build 성공
- 결정: decisions/0060(점주 문구·단계는 화면이 상태 값에서)
- 막힌 것: (없으면 "없음")
- 다음: Task 4 A/S 화면
```

- [ ] **Step 7: 커밋**

```bash
git add apps/merchant docs
git commit -m "$(cat <<'EOF'
feat(merchant, F3, F8): 점주 홈·단말기 상세 — 배송 단계·접속·회수 안내

Refs: docs/decisions/0060-점주-문구와-진행-단계는-화면이-상태에서-만든다.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 시각 = 커밋 시각 확인(다르면 고쳐 amend).


### Task 4: A/S — 목록·고장 접수(증상 + 메모)·상세(진행 단계)·설치 확인

**Files:**
- Create: `apps/merchant/src/lib/symptom.ts`, `src/pages/{ServiceTicketsPage,NewTicketPage,ServiceTicketDetailPage}.tsx`
- Modify: `apps/merchant/src/App.tsx`, `apps/merchant/src/styles.css`
- Test: Create `src/pages/ServicePages.test.tsx`
- Docs: Modify `docs/study/backlog.md`, `docs/index.md`(바뀌지 않으면 그대로), `docs/devlog/2026-10-28.md`

- [ ] **Step 1: 실패하는 테스트**

`apps/merchant/src/pages/ServicePages.test.tsx`:

```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { composeSymptom, memoMax } from '../lib/symptom';
import { keyset, page, terminal, ticket } from '../test/fixtures';
import { loginAs, mockApi, renderPage } from '../test/render';
import { NewTicketPage } from './NewTicketPage';
import { ServiceTicketDetailPage } from './ServiceTicketDetailPage';
import { ServiceTicketsPage } from './ServiceTicketsPage';

describe('증상 글 (decisions/0060)', () => {
  it('고른 증상 + 메모를 "증상: 메모"로, 메모가 비면 증상만. 합쳐 200자를 넘지 않게 메모 길이를 줄인다', () => {
    expect(composeSymptom('카드 인식 안 됨', '  오전부터 ')).toBe('카드 인식 안 됨: 오전부터');
    expect(composeSymptom('기타', '   ')).toBe('기타');
    expect('기타'.length + 2 + memoMax('기타')).toBe(200);
  });
});

describe('A/S 목록', () => {
  it('최근 것 위에 상태 이름표, 진행 중이면 지금 단계. 위에 고장 접수 링크', async () => {
    loginAs();
    mockApi({
      'GET /me/service-tickets': () => ({ body: keyset([ticket({ remoteChecked: true }), ticket({ id: 3, status: 'RESOLVED_REMOTELY' })]) }),
    });
    renderPage(<ServiceTicketsPage />, { route: '/service-tickets', path: '/service-tickets' });
    const first = await screen.findByRole('link', { name: /A\/S #7/ });
    expect(first).toHaveAttribute('href', '/service-tickets/7');
    expect(within(first).getByText('확인 중')).toBeInTheDocument();
    expect(within(first).getByText('지금 단계: 교체 출고')).toBeInTheDocument();
    expect(within(screen.getByRole('link', { name: /A\/S #3/ })).getByText('원격으로 해결')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /고장 접수하기/ })).toHaveAttribute('href', '/service-tickets/new');
  });
});

describe('고장 접수', () => {
  const terminals = page([terminal(), terminal({ serialNo: 'SN-0101', status: 'SHIPPED', connectivity: null })]);
  const renderNew = (route = '/service-tickets/new') => renderPage(<NewTicketPage />, { route, path: '/service-tickets/new' });

  it('단말기 상세에서 오면 그 단말기가 골라져 있고, 사용 중인 단말기만 고를 수 있다. 증상을 골라야 접수 버튼이 켜진다', async () => {
    loginAs();
    const { calls } = mockApi({
      'GET /me/terminals': () => ({ body: terminals }),
      'POST /me/service-tickets': () => ({ status: 201, body: ticket() }),
    });
    renderNew('/service-tickets/new?serialNo=SN-0001');
    const select = await screen.findByLabelText('단말기');
    expect(select).toHaveValue('SN-0001');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['고르세요', '단말온 S100 SN-0001']);
    expect(screen.getByRole('button', { name: '접수하기' })).toBeDisabled();

    await userEvent.click(screen.getByLabelText('카드 인식 안 됨'));
    await userEvent.type(screen.getByLabelText('메모'), '오전부터');
    await userEvent.click(screen.getByRole('button', { name: '접수하기' }));
    expect(await screen.findByText('다른 화면')).toBeInTheDocument(); // 접수 화면(/service-tickets/7)으로 갔다
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ serialNo: 'SN-0001', symptom: '카드 인식 안 됨: 오전부터' });
  });

  it('이미 열린 A/S가 있으면(409) 점주 안내', async () => {
    loginAs();
    mockApi({
      'GET /me/terminals': () => ({ body: terminals }),
      'POST /me/service-tickets': () => ({ status: 409, body: { statusCode: 409, code: 'TICKET_ALREADY_OPEN', message: '단말기 SN-0001에 이미 열린 A/S 접수가 있습니다.' } }),
    });
    renderNew('/service-tickets/new?serialNo=SN-0001');
    await userEvent.click(await screen.findByLabelText('전원 안 켜짐'));
    await userEvent.click(screen.getByRole('button', { name: '접수하기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('이 단말기는 이미 접수된 A/S가 있습니다.');
  });

  it('주소의 시리얼이 사용 중 목록에 없으면 고르지 않은 것으로', async () => {
    loginAs();
    mockApi({ 'GET /me/terminals': () => ({ body: terminals }) });
    renderNew('/service-tickets/new?serialNo=SN-0101');
    expect(await screen.findByLabelText('단말기')).toHaveValue('');
  });
});

describe('A/S 상세와 설치 확인', () => {
  const renderDetail = () => renderPage(<ServiceTicketDetailPage />, { route: '/service-tickets/7', path: '/service-tickets/:id' });
  const replacing = (replacementStatus: 'SHIPPED' | 'DELIVERED') =>
    ticket({ status: 'REPLACING', remoteChecked: true, replacementSerialNo: 'SN-0101', replacementStatus, outboundTrackingNo: 'NR-123' });

  it('교체 단말기가 배송 중이면 배송 중 단계이고 설치 확인 버튼이 없다', async () => {
    loginAs();
    mockApi({ 'GET /me/service-tickets/:id': () => ({ body: replacing('SHIPPED') }) });
    renderDetail();
    const steps = within(await screen.findByRole('list', { name: 'A/S 진행 단계' })).getAllByRole('listitem');
    expect(steps.find((s) => s.getAttribute('aria-current') === 'step')).toHaveTextContent('배송 중');
    expect(screen.getByText(/교체 단말기가 배송 중입니다/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'SN-0101' })).toHaveAttribute('href', '/terminals/SN-0101');
    expect(screen.queryByRole('button', { name: '설치 확인' })).not.toBeInTheDocument();
  });

  it('도착했으면 설치 확인 — 한 번 더 묻고, 확인하면 POST 뒤 다시 읽어 완료로', async () => {
    loginAs();
    let current = replacing('DELIVERED');
    const { calls } = mockApi({
      'GET /me/service-tickets/:id': () => ({ body: current }),
      'POST /me/service-tickets/:id/installations': () => {
        current = { ...current, status: 'CLOSED', replacementStatus: 'IN_SERVICE', closedAt: '2026-10-28T05:00:00.000Z' };
        return { body: current };
      },
    });
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderDetail();
    const button = await screen.findByRole('button', { name: '설치 확인' });
    await userEvent.click(button);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0); // 취소하면 보내지 않는다
    await userEvent.click(button);
    expect(await screen.findByText('2026-10-28 14:00:00 KST')).toBeInTheDocument(); // 다시 읽은 접수의 끝난 때
    expect(ask).toHaveBeenCalledTimes(2);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/me/service-tickets/7/installations']);
    expect(screen.queryByRole('button', { name: '설치 확인' })).not.toBeInTheDocument();
    const steps = within(screen.getByRole('list', { name: 'A/S 진행 단계' })).getAllByRole('listitem');
    expect(steps.every((s) => s.className === 'done')).toBe(true);
  });

  it('설치 확인이 실패하면(422) 안내하고 다시 읽는다', async () => {
    loginAs();
    const { calls } = mockApi({
      'GET /me/service-tickets/:id': () => ({ body: replacing('DELIVERED') }),
      'POST /me/service-tickets/:id/installations': () => ({ status: 422, body: { statusCode: 422, code: 'TICKET_NOT_REPLACING', message: 'A/S 접수 7은(는) CLOSED 상태라 설치 확인을 할 수 없습니다(필요: REPLACING).' } }),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: '설치 확인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('지금은 설치 확인을 할 수 없는 단계입니다.');
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET' && c.path === '/me/service-tickets/7')).toHaveLength(2));
  });
});
```

```bash
cd apps/merchant && npx vitest run
```

Expected(사전 검증 원문): `Error: Failed to resolve import "./NewTicketPage" from "src/pages/ServicePages.test.tsx"`, `Test Files  1 failed | 5 passed (6)`, `Tests  24 passed (24)`.

- [ ] **Step 2: 증상 글**

`apps/merchant/src/lib/symptom.ts`:

```ts
/** 서버 symptom 칸 길이(api OpenTicketDto @Length(1, 200)) */
export const SYMPTOM_MAX = 200;

/** 고른 증상과 메모를 "증상: 메모"로 잇는다(메모가 비면 증상만). 서버 칸은 글 하나다(decisions/0060) */
export function composeSymptom(choice: string, memo: string): string {
  const note = memo.trim();
  return note ? `${choice}: ${note}` : choice;
}

/** 이 증상을 고른 뒤 메모에 쓸 수 있는 글자 수(합쳐서 200자를 넘지 않게) */
export function memoMax(choice: string): number {
  return SYMPTOM_MAX - choice.length - 2;
}
```

- [ ] **Step 3: 화면**

`apps/merchant/src/pages/ServiceTicketsPage.tsx`:

```tsx
import { Link } from 'react-router';
import { RECENT_TICKETS, useMyTickets } from '../api/queries';
import { ErrorBox } from '../components/ErrorBox';
import { currentStep } from '../components/StepList';
import { formatKstShort } from '../lib/format';
import { TICKET_STATUS_LABEL } from '../lib/labels';
import { ticketSteps } from '../lib/steps';

/** A/S 목록(최근 50건, 최근 것 위). 진행 중인 것은 지금 단계를 함께 보인다. 위에 고장 접수 */
export function ServiceTicketsPage() {
  const tickets = useMyTickets();
  return (
    <>
      <h1>A/S</h1>
      <Link className="card" to="/service-tickets/new">
        <strong>고장 접수하기</strong>
        <div className="muted">사용 중인 단말기가 고장 났을 때</div>
      </Link>
      {tickets.error ? <ErrorBox error={tickets.error} /> : null}
      {!tickets.data && !tickets.error ? <p>불러오는 중…</p> : null}
      {tickets.data && tickets.data.items.length === 0 ? <p className="muted">A/S 접수가 없습니다.</p> : null}
      {(tickets.data?.items ?? []).map((t) => (
        <Link key={t.id} className="card" to={`/service-tickets/${t.id}`}>
          <div className="card-head">
            <strong>A/S #{t.id}</strong>
            <span className={`badge ${t.status === 'OPEN' || t.status === 'REPLACING' ? 'warn' : 'ok'}`}>{TICKET_STATUS_LABEL[t.status]}</span>
          </div>
          <div className="muted">
            {formatKstShort(t.createdAt)} · {t.serialNo}
          </div>
          <div>{t.symptom}</div>
          {t.status === 'OPEN' || t.status === 'REPLACING' ? <div>지금 단계: {currentStep(ticketSteps(t))}</div> : null}
        </Link>
      ))}
      {tickets.data?.nextBeforeId ? <p className="muted">최근 {RECENT_TICKETS}건만 보입니다. 지난 접수는 본사에 문의하세요.</p> : null}
    </>
  );
}
```

`apps/merchant/src/pages/NewTicketPage.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MerchantTicketView, OpenTicketRequest } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { useMyTerminals } from '../api/queries';
import { keys } from '../api/query-keys';
import { ErrorBox } from '../components/ErrorBox';
import { SYMPTOMS } from '../lib/labels';
import { composeSymptom, memoMax } from '../lib/symptom';

/**
 * 고장 접수: 사용 중인 단말기 고르기(단말기 상세에서 오면 ?serialNo=로 골라 둔다) → 증상 고르기 → 메모(선택) → 접수.
 * 접수되면 그 접수 화면으로. 쓰기 뒤에는 'me' 묶음 전체를 무효화한다(단말기·A/S 목록이 함께 바뀐다, query-keys.ts).
 */
export function NewTicketPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const terminals = useMyTerminals();
  const [serialNo, setSerialNo] = useState(params.get('serialNo') ?? '');
  const [choice, setChoice] = useState('');
  const [memo, setMemo] = useState('');
  const open = useMutation({
    mutationFn: (body: OpenTicketRequest) => api<MerchantTicketView>('/me/service-tickets', { method: 'POST', body }),
    onSuccess: async (t) => {
      await client.invalidateQueries({ queryKey: keys.all });
      navigate(`/service-tickets/${t.id}`, { replace: true });
    },
  });

  if (terminals.error) return <ErrorBox error={terminals.error} />;
  if (!terminals.data) return <p>불러오는 중…</p>;
  const usable = terminals.data.items.filter((t) => t.status === 'IN_SERVICE');
  // 고른 시리얼이 사용 중 목록에 없으면(주소를 손으로 고침, 그사이 상태가 바뀜) 고르지 않은 것으로 본다
  const chosen = usable.find((t) => t.serialNo === serialNo)?.serialNo ?? '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    open.mutate({ serialNo: chosen, symptom: composeSymptom(choice, memo) } satisfies OpenTicketRequest);
  };

  return (
    <form onSubmit={submit}>
      <h1>고장 접수</h1>
      {usable.length === 0 ? <p className="muted">사용 중인 단말기가 없어 접수할 수 없습니다.</p> : null}
      <label>
        단말기
        <select aria-label="단말기" value={chosen} onChange={(e) => setSerialNo(e.target.value)}>
          <option value="">고르세요</option>
          {usable.map((t) => (
            <option key={t.serialNo} value={t.serialNo}>
              {t.modelName} {t.serialNo}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="card">
        <legend>증상</legend>
        {SYMPTOMS.map((s) => (
          <label key={s} className="choice">
            <input type="radio" name="symptom" value={s} checked={choice === s} onChange={() => setChoice(s)} />
            {s}
          </label>
        ))}
      </fieldset>
      <label>
        메모(선택)
        <textarea aria-label="메모" rows={3} value={memo} maxLength={choice ? memoMax(choice) : undefined} onChange={(e) => setMemo(e.target.value)} placeholder="언제부터, 어떤 화면이 나오는지" />
      </label>
      <button type="submit" className="primary" disabled={!chosen || !choice || open.isPending}>
        접수하기
      </button>
      <ErrorBox error={open.error} />
    </form>
  );
}
```

`apps/merchant/src/pages/ServiceTicketDetailPage.tsx`:

```tsx
import { Link, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MerchantTicketView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { useMyTicket } from '../api/queries';
import { keys } from '../api/query-keys';
import { ErrorBox } from '../components/ErrorBox';
import { StepList } from '../components/StepList';
import { formatKst } from '../lib/format';
import { TERMINAL_STATUS_LABEL, TICKET_STATUS_LABEL } from '../lib/labels';
import { canConfirmInstall, ticketSteps } from '../lib/steps';

/**
 * A/S 한 건: 진행 단계(접수 → 원격 점검 → 교체 출고 → 배송 중 → 설치 확인 → 완료), 교체 단말기, 설치 확인 버튼.
 * 설치 확인은 되돌릴 수 없어 한 번 더 묻는다(어드민과 같은 규칙, decisions/0041). 성공·실패 모두 'me' 묶음을 다시 읽는다 —
 * 실패(422)는 대개 화면이 낡았다는 뜻이다(본사가 먼저 바꿨거나 아직 배송 완료 전).
 */
export function ServiceTicketDetailPage() {
  const id = Number(useParams().id);
  const client = useQueryClient();
  const ticket = useMyTicket(id);
  const install = useMutation({
    mutationFn: () => api<MerchantTicketView>(`/me/service-tickets/${id}/installations`, { method: 'POST' }),
    onSettled: () => client.invalidateQueries({ queryKey: keys.all }),
  });

  if (ticket.error) return <ErrorBox error={ticket.error} />;
  if (!ticket.data) return <p>불러오는 중…</p>;
  const t = ticket.data;

  const confirm = () => {
    if (window.confirm('교체 단말기를 설치하고 결제가 되는 것을 확인했나요? 확인하면 A/S가 완료됩니다.')) install.mutate();
  };

  return (
    <>
      <h1>A/S #{t.id}</h1>
      <p>
        <span className="badge">{TICKET_STATUS_LABEL[t.status]}</span>
      </p>
      <dl className="facts">
        <dt>단말기</dt>
        <dd>
          <Link to={`/terminals/${encodeURIComponent(t.serialNo)}`}>{t.serialNo}</Link>
        </dd>
        <dt>증상</dt>
        <dd>{t.symptom}</dd>
        <dt>접수</dt>
        <dd>
          {formatKst(t.createdAt)}
          {t.openedByMe ? '' : ' (본사 또는 다른 계정이 접수)'}
        </dd>
        {t.closedAt ? (
          <>
            <dt>끝난 때</dt>
            <dd>{formatKst(t.closedAt)}</dd>
          </>
        ) : null}
      </dl>

      <h2>진행 단계</h2>
      <StepList label="A/S 진행 단계" steps={ticketSteps(t)} />

      {t.replacementSerialNo ? (
        <section aria-labelledby="h-replacement">
          <h2 id="h-replacement">교체 단말기</h2>
          <p>
            <Link to={`/terminals/${encodeURIComponent(t.replacementSerialNo)}`}>{t.replacementSerialNo}</Link>
            {t.replacementStatus ? ` · ${TERMINAL_STATUS_LABEL[t.replacementStatus]}` : null}
            {t.outboundTrackingNo ? <span className="muted"> · 운송장 {t.outboundTrackingNo}</span> : null}
          </p>
        </section>
      ) : null}

      {t.status === 'REPLACING' && t.replacementStatus === 'SHIPPED' ? <p className="notice">교체 단말기가 배송 중입니다. 도착하면 설치 확인을 할 수 있습니다.</p> : null}
      {canConfirmInstall(t) ? (
        <>
          <p className="notice">교체 단말기가 도착했습니다. 설치하고 카드 결제가 되는지 확인한 뒤 눌러 주세요.</p>
          <button type="button" className="primary" disabled={install.isPending} onClick={confirm}>
            설치 확인
          </button>
        </>
      ) : null}
      {t.status === 'RESOLVED_REMOTELY' ? <p className="notice">본사가 원격으로 해결했습니다. 다시 문제가 생기면 새로 접수해 주세요.</p> : null}
      <ErrorBox error={install.error} />
    </>
  );
}
```

`apps/merchant/src/App.tsx`:

```diff
diff --git a/apps/merchant/src/App.tsx b/apps/merchant/src/App.tsx
index bde3146..7bf9b51 100644
--- a/apps/merchant/src/App.tsx
+++ b/apps/merchant/src/App.tsx
@@ -4,6 +4,9 @@ import { SessionCacheSync } from './components/SessionCacheSync';
 import { Shell } from './components/Shell';
 import { HomePage } from './pages/HomePage';
 import { LoginPage } from './pages/LoginPage';
+import { NewTicketPage } from './pages/NewTicketPage';
+import { ServiceTicketDetailPage } from './pages/ServiceTicketDetailPage';
+import { ServiceTicketsPage } from './pages/ServiceTicketsPage';
 import { TerminalDetailPage } from './pages/TerminalDetailPage';
 
 /** 화면 경로. /login 말고는 모두 가맹점 계정으로 로그인해야 보인다(AuthGate) */
@@ -22,6 +25,9 @@ export function App() {
         >
           <Route index element={<HomePage />} />
           <Route path="terminals/:serialNo" element={<TerminalDetailPage />} />
+          <Route path="service-tickets" element={<ServiceTicketsPage />} />
+          <Route path="service-tickets/new" element={<NewTicketPage />} />
+          <Route path="service-tickets/:id" element={<ServiceTicketDetailPage />} />
           <Route path="*" element={<p>없는 화면입니다.</p>} />
         </Route>
       </Routes>
```

`apps/merchant/src/styles.css`(끝에 고르기 칸):

```diff
diff --git a/apps/merchant/src/styles.css b/apps/merchant/src/styles.css
index e1e082a..3e0f607 100644
--- a/apps/merchant/src/styles.css
+++ b/apps/merchant/src/styles.css
@@ -304,3 +304,27 @@ dl.facts dd {
   margin: 0;
   word-break: break-all;
 }
+
+/* 고르기(라디오): 한 줄 전체를 눌러도 고른다(손가락) */
+label.choice {
+  display: flex;
+  align-items: center;
+  gap: 8px;
+  min-height: 44px;
+  margin: 0;
+  font-weight: 400;
+}
+
+label.choice input {
+  display: inline;
+  width: auto;
+  margin: 0;
+}
+
+fieldset {
+  margin: 0 0 12px;
+}
+
+legend {
+  font-weight: 600;
+}
```

- [ ] **Step 4: 통과·타입·빌드**

```bash
cd apps/merchant && npx vitest run && npm run build && rm -rf dist
```

Expected: `Test Files  6 passed (6)`, `Tests  32 passed (32)`(A/S 8 더함), build 성공.

- [ ] **Step 5: 기록**

`docs/study/backlog.md` 끝에 한 줄:

```markdown
- [ ] `window.confirm` 대신 화면 안 확인 대화상자(`<dialog>`, `showModal`) — 휴대폰 브라우저·앱 안 웹뷰에서 confirm이 막히거나 모양을 못 바꾸는 경우 (apps/merchant/src/pages/ServiceTicketDetailPage.tsx)
```

`node scripts/docs-index.mjs --check` → `docs/index.md 최신`(새 결정·트러블슈팅이 없으면).

devlog 항목:

```markdown
## HH:MM Task 4 점주 A/S — 목록·고장 접수·진행 단계·설치 확인 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <Task 3 커밋 해시> (feat(merchant, F3, F8): 점주 홈·단말기 상세)
- 한 일: A/S 목록(최근 50건, 진행 중이면 지금 단계), 고장 접수(사용 중 단말기만, `?serialNo=`로 골라 둠, 증상 여섯 + 메모 → `"증상: 메모"`, 합쳐 200자), 접수 상세(진행 단계, 교체 단말기, 설치 확인 — 교체 단말기 도착 때만·한 번 더 묻기·성공/실패 모두 다시 읽기)
- 확인: 먼저 본 실패 `Test Files  1 failed | 5 passed (6)`(모듈 없음) → `Tests  32 passed (32)`, build 성공
- 결정: decisions/0060 그대로(증상 글·설치 확인 조건)
- 막힌 것: (없으면 "없음")
- 다음: Task 5 마감
```

- [ ] **Step 6: 커밋**

```bash
git add apps/merchant docs
git commit -m "$(cat <<'EOF'
feat(merchant, F7): 점주 A/S — 고장 접수·진행 단계·설치 확인

Refs: docs/decisions/0060-점주-문구와-진행-단계는-화면이-상태에서-만든다.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 시각 = 커밋 시각 확인(다르면 고쳐 amend).


### Task 5: 마감 — 전체 검증, 실서버 확인, launch.json, 어드민 안내 문구, README·회고·색인

**Files:**
- Modify: `apps/admin/src/components/AuthGate.tsx`(가맹점주 안내 문구), `README.md`, `docs/retrospective.md`, `docs/index.md`, `docs/devlog/2026-10-28.md`
- 저장소 밖(커밋 안 함): `C:\Devhyun\History\.claude\launch.json`, 저장소 `.claude/launch.json`(gitignore)

- [ ] **Step 1: 어드민의 가맹점주 안내가 점주 앱을 가리키게**

`apps/admin/src/components/AuthGate.tsx`:

```diff
diff --git a/apps/admin/src/components/AuthGate.tsx b/apps/admin/src/components/AuthGate.tsx
index 41e43c0..7b2aa4d 100644
--- a/apps/admin/src/components/AuthGate.tsx
+++ b/apps/admin/src/components/AuthGate.tsx
@@ -7,7 +7,7 @@ import { UserBar } from './UserBar';
 
 /**
  * 로그인해야 보이는 화면들의 문. 처음에는 GET /auth/me로 서버 세션을 확인하고, 로그인 안 했으면(401) 로그인 화면으로 보낸다(돌아올 주소를 함께).
- * 가맹점주는 이 사내 어드민을 쓰지 않는다 — 안내와 로그아웃만(가맹점 화면은 다음 묶음, API는 `/me`).
+ * 가맹점주는 이 사내 어드민을 쓰지 않는다 — 안내와 로그아웃만(점주는 매장 화면 `apps/merchant`, 보강 3 decisions/0057).
  */
 export function AuthGate({ children }: { children: ReactNode }) {
   const { me, error } = useSessionCheck();
@@ -22,7 +22,7 @@ export function AuthGate({ children }: { children: ReactNode }) {
   if (me.role === 'MERCHANT') {
     return (
       <div className="login">
-        <p>가맹점 계정은 사내 운영 어드민을 쓰지 않습니다. 가맹점 화면은 다음 묶음에서 열립니다.</p>
+        <p>가맹점 계정은 사내 운영 어드민을 쓰지 않습니다. 매장 화면(개발 서버 :5174)을 쓰세요.</p>
         <UserBar />
       </div>
     );
```

(`LoginPage.test.tsx`의 단언 `/가맹점 계정은 사내 운영 어드민을 쓰지 않습니다/`는 앞 문장이라 그대로 통과한다.)

- [ ] **Step 2: 전체 검증**

```bash
# 시작 전 node PID를 적어 둔다
tasklist //FI "IMAGENAME eq node.exe" //FO CSV //NH
# 테스트 DB를 새로 만든 뒤(안전 규칙)
(cd apps/api && npx tsc --noEmit -p tsconfig.json && npm run build && npx vitest run 2>&1 | tee /tmp/merchant-final-api.log | tail -5; grep -c "Connection is closed" /tmp/merchant-final-api.log)
(cd apps/admin && npx vitest run 2>&1 | tail -4 && npm run build && rm -rf dist)
(cd apps/merchant && npx vitest run 2>&1 | tail -4 && npm run build && rm -rf dist)
(cd apps/device-sim && npx tsc --noEmit -p tsconfig.json && npx vitest run 2>&1 | tail -4)
(cd apps/partners && npx vitest run 2>&1 | tail -4)
(cd apps/api && npm run db:migration:check)   # 개발 DB 읽기 — 이 계획은 마이그레이션이 없다
```

Expected: api `Test Files  80 passed (80)`·`Tests  558 passed (558)`(약 310초), `Connection is closed` 0. admin `14 passed`·`125 passed`, build 성공. merchant `6 passed`·`32 passed`, build 성공. device-sim `5`·`46`, tsc 0. partners `6`·`53`. `db:migration:check` → `최신 상태`(exit 0). 개발 DB 스냅샷 파일 외에 `apps/api/src/migrations/.snapshot-terminal_ops_test.json`이 생기지 않았는지 `git status --short --ignored apps/api/src/migrations`로 본다(생겼으면 지운다 — troubleshooting/0032).

- [ ] **Step 3: 실서버 확인 — 테스트 DB로 띄운 api + 점주 개발 서버 프록시**

포트가 비어 있는지 먼저 본다: `netstat -ano | grep -E ':(3100|5174) .*LISTENING'` → 출력 없음.

테스트 DB(Step 2 뒤 표가 있다)를 다시 만들고 스키마·기준 데이터·시연 계정을 넣는다(쓰기는 테스트 DB만):

```bash
# 테스트 DB를 새로 만든 뒤(안전 규칙)
cd apps/api
MYSQL_DATABASE=terminal_ops_test node --env-file=../../.env dist/db/migrate.js up | tail -1
MYSQL_DATABASE=terminal_ops_test node --env-file=../../.env dist/db/seed.js
rm -f src/migrations/.snapshot-terminal_ops_test.json   # 테스트 DB 이름의 스냅샷(troubleshooting/0032)
cd ../..
```

서버 두 개를 각각 **단독 `node` 명령**으로 백그라운드에 띄운다(셸 목록으로 묶지 않는다 — PID가 서브셸이 된다):

```bash
# (1) 저장소 루트에서
API_PORT=3100 MYSQL_DATABASE=terminal_ops_test RUN_WORKERS=0 RUN_SCHEDULERS=0 QUEUE_PREFIX=merchant-live node --env-file=.env apps/api/dist/main.js
# (2) apps/merchant 폴더에서
MERCHANT_API_URL=http://localhost:3100 node node_modules/vite/bin/vite.js
```

`netstat -ano | grep -E ':(3100|5174) .*LISTENING'`으로 둘 다 뜬 것과 PID를 본다. 아래 스크립트를 저장소 **밖** 임시 파일(예: 세션 scratchpad의 `merchant-live.sh`)에 Write로 만들고 저장소 루트에서 `bash <경로>/merchant-live.sh`로 돌린다. 비밀번호는 seed 파일에서 변수로만 읽고 출력하지 않는다.

```bash
#!/bin/bash
# 점주 화면 실서버 확인(테스트 DB api :3100 + 점주 개발 서버 :5174 프록시). 저장소 루트에서 실행
SEED=apps/api/src/db/seed-accounts.ts
pw() { node -e "const s=require('fs').readFileSync(process.argv[1],'utf8');const m=s.match(new RegExp(\"loginId: '\"+process.argv[2]+\"'[^}]*password: '([^']+)'\"));process.stdout.write(m[1])" "$SEED" "$1"; }
OP_PW=$(pw operator); M_PW=$(pw merchant-gangnam)
J=$(mktemp -d)
API=http://localhost:3100; WEB=http://localhost:5174/api
login() { curl -s -c "$2" -o /dev/null -w "%{http_code}" -H 'Content-Type: application/json' -d "{\"loginId\":\"$1\",\"password\":\"$3\"}" "$4/auth/login"; }
num() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(String(eval('JSON.parse(s)'+process.argv[1]))))" "$1"; }

echo "index.html: $(curl -s -o /dev/null -w '%{http_code}' http://localhost:5174/) $(curl -s http://localhost:5174/ | grep -o '<title>[^<]*</title>')"
echo "proxy /api/health: $(curl -s $WEB/health)"
echo "no login /api/me/terminals: $(curl -s -w ' %{http_code}' $WEB/me/terminals)"

# 운영자(api 직접)로 단말기 하나를 강남김밥에 배정(테스트 DB 쓰기)
echo "operator login: $(login operator $J/op "$OP_PW" $API)"
H=(-b $J/op -H 'Content-Type: application/json')
echo "register: $(curl -s -o /dev/null -w '%{http_code}' "${H[@]}" -d '{"serialNo":"LIVE-M-0001","modelCode":"SN-100"}' $API/terminals)"
V=$(curl -s "${H[@]}" -d '{"results":[{"itemCode":"POWER","passed":true},{"itemCode":"NETWORK","passed":true},{"itemCode":"CARD_READER","passed":true},{"itemCode":"PRINTER","passed":true}]}' $API/terminals/LIVE-M-0001/inspections | num .terminal.version)
V=$(curl -s "${H[@]}" -d "{\"to\":\"IN_STOCK\",\"reason\":\"재고\",\"expectedVersion\":$V}" $API/terminals/LIVE-M-0001/transitions | num .version)
echo "allocate: $(curl -s -o /dev/null -w '%{http_code}' "${H[@]}" -d "{\"merchantCode\":\"GANGNAM-KIMBAP\",\"expectedVersion\":$V}" $API/terminals/LIVE-M-0001/allocations)"

# 점주는 점주 개발 서버의 프록시로만
echo "merchant login via proxy: $(login merchant-gangnam $J/m "$M_PW" $WEB)"
echo "httpOnly cookie lines: $(grep -c 'HttpOnly_' $J/m)"
echo "auth/me: $(curl -s -b $J/m $WEB/auth/me)"
echo "me/merchant: $(curl -s -b $J/m $WEB/me/merchant)"
echo "me/terminals: $(curl -s -b $J/m $WEB/me/terminals)"
echo "me/terminals/LIVE-M-0001: $(curl -s -b $J/m $WEB/me/terminals/LIVE-M-0001)"
echo "me/service-tickets: $(curl -s -b $J/m $WEB/me/service-tickets)"
echo "merchant /terminals (403): $(curl -s -o /dev/null -w '%{http_code}' -b $J/m $WEB/terminals)"
echo "operator /me/terminals (403): $(curl -s -o /dev/null -w '%{http_code}' -b $J/op $API/me/terminals)"
echo "logout: $(curl -s -o /dev/null -w '%{http_code}' -X POST -b $J/m $WEB/auth/logout) then /me/terminals $(curl -s -o /dev/null -w '%{http_code}' -b $J/m $WEB/me/terminals)"
curl -s -o /dev/null -X POST -b $J/op $API/auth/logout
rm -rf $J
```

Expected(사전 검증 원문, 포트만 다름): `index.html: 200 <title>단말온 가맹점</title>`, `proxy /api/health: {"status":"ok"}`, `no login …: {"statusCode":401,"code":"UNAUTHENTICATED",…} 401`, `operator login: 200`, `register: 201`, `allocate: 201`, `merchant login via proxy: 200`, `httpOnly cookie lines: 1`, `auth/me: {…"role":"MERCHANT","merchantCode":"GANGNAM-KIMBAP"}`, `me/merchant: {"code":"GANGNAM-KIMBAP","name":"강남김밥","address":"서울 강남구 가상대로 101"}`, `me/terminals: {"items":[{"serialNo":"LIVE-M-0001","modelCode":"SN-100","modelName":"유선 카운터형","status":"ALLOCATED",…,"connectivity":null,"shipment":null}],"total":1,"page":1,"size":20}`(version·merchantCode 없음), 상세에 `"events":[{"status":"ALLOCATED",…}]`, `me/service-tickets: {"items":[],"nextBeforeId":null}`, 403·403, `logout: 204 then /me/terminals 401`.

**컨트롤러 확인 요청**(devlog에 "컨트롤러 확인 대기"로 적는다): 두 서버가 떠 있는 동안 컨트롤러가 내장 브라우저로 `http://localhost:5174/login`을 열어 휴대폰 크기(375×812)에서 로그인 → 홈 → 단말기 상세 → A/S → 고장 접수 화면을 본다. 컨트롤러가 다 봤다고 하면 다음으로.

끄기와 정리:

```bash
netstat -ano | grep -E ':(3100|5174) .*LISTENING'          # PID 두 개
tasklist //FI "PID eq <api PID>" //FO CSV //NH              # node.exe인지
tasklist //FI "PID eq <vite PID>" //FO CSV //NH
taskkill //PID <api PID> //F; taskkill //PID <vite PID> //F
netstat -ano | grep -E ':(3100|5174) .*LISTENING'          # 출력 없음
tasklist //FI "IMAGENAME eq node.exe" //FO CSV //NH          # 시작 전과 같은 PID만
MSYS_NO_PATHCONV=1 docker exec terminal-ops-redis redis-cli --scan --pattern 'merchant-live*'   # 본 키만 하나씩 DEL
# MSYS_NO_PATHCONV=1 docker exec terminal-ops-redis redis-cli DEL <키>   (키마다, 사전 검증에서는 큐 meta 6개 — 세션은 로그아웃으로 지워졌다)
# 마지막으로 테스트 DB를 빈 DB로 다시 만든다(안전 규칙)
```

- [ ] **Step 4: launch.json(커밋 안 함)**

세션 루트 `C:\Devhyun\History\.claude\launch.json`과 저장소 `.claude/launch.json` **둘 다** `configurations` 끝(`terminal-ops-admin` 뒤)에 같은 항목을 더한다(Edit 도구, JSON 쉼표 주의):

```json
    {
      "name": "terminal-ops-merchant",
      "runtimeExecutable": "node",
      "runtimeArgs": [
        "C:/Devhyun/History/ToyProject/terminal-ops/apps/merchant/node_modules/vite/bin/vite.js",
        "C:/Devhyun/History/ToyProject/terminal-ops/apps/merchant"
      ],
      "port": 5174
    }
```

`node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" <파일>`로 두 파일 모두 JSON이 맞는지 본다. `git status --short`에 `.claude/`가 나오지 않아야 한다(gitignore).

- [ ] **Step 5: README**

`README.md`에서 아래를 바꾼다(Edit 도구, 각 줄 그대로 찾아 바꾼다).

1. 구성 — `admin/` 줄 아래에 한 줄을 더하고, contracts 줄의 "api·어드민이"를 "api·어드민·매장 화면이"로:
   ```
   │  ├─ admin/             React 19 + Vite 8 + TanStack Query 어드민(Vite 프록시 /api → api)
   │  ├─ merchant/          매장(가맹점주) 화면 — 휴대폰 폭, 어드민과 같은 스택·같은 판(Vite 프록시 /api → api, 보강 3)
   ```
2. 설치 줄:
   ```
   for a in api admin merchant partners device-sim; do (cd apps/$a && npm ci); done   # api·admin·merchant는 packages/contracts를 링크한다(따로 설치하지 않는다)
   ```
3. 실행 블록의 `(cd apps/admin && npm run dev)` 줄 아래에:
   ```
   (cd apps/merchant && npm run dev)                      # :5174 → 휴대폰 크기로 http://localhost:5174/login (가맹점 계정)
   ```
4. 타입 검사 줄의 "admin `npm run build`(tsc 포함) — api·어드민이"를 "admin·merchant `npm run build`(tsc 포함) — api·화면이"로.
5. "로그인과 역할" MERCHANT 줄을:
   ```
   - **MERCHANT**: 가맹점주 — `/me/*`로 자기 가맹점의 단말기·A/S만([decisions/0053](docs/decisions/0053-가맹점주-범위는-me-전용-엔드포인트와-서비스-scope.md)). 화면은 매장 화면 `apps/merchant`(:5174, 보강 3 — [decisions/0057](docs/decisions/0057-점주-화면은-별도-앱-apps-merchant.md)). 어드민은 안내와 로그아웃만
   ```
6. "로그인과 역할" 절 끝(테스트 헤더 줄 뒤)에 절 하나:
   ```markdown
   ## 매장 화면(보강 3)

   가맹점주가 휴대폰으로 쓰는 화면이다. `http://localhost:5174/login`에 위 표의 `merchant-*` 계정으로 들어간다(직원 계정이면 안내와 로그아웃만).

   - 홈: 오고 있는 단말기(운송장·택배 단계, A/S 교체품이면 접수 번호) → 진행 중 A/S(지금 단계) → 사용 중 단말기(연결·마지막 접속·펌웨어) → 회수(점주가 할 일)
   - 단말기 상세(이번 배정부터의 지난 일), 고장 접수(증상 + 메모), A/S 진행 단계(접수 → 원격 점검 → 교체 출고 → 배송 중 → 설치 확인 → 완료)와 설치 확인
   - 점주에게 보이는 단말기는 배정부터 회수 완료까지다 — 회수 뒤 본사로 돌아간(검수·재고) 단말기는 옛 가맹점에 보이지 않는다([decisions/0059](docs/decisions/0059-점주-화면용-me-보강은-점주용-모양과-보이는-상태로.md)). 점주 문구·단계는 화면이 상태 값에서 만든다([0060](docs/decisions/0060-점주-문구와-진행-단계는-화면이-상태에서-만든다.md)). api 클라이언트·세션 코드는 어드민 사본이다([0058](docs/decisions/0058-화면-공통-코드는-공유-패키지가-아니라-복사로.md))
   ```
7. 기능 표 마지막 줄(로그인·권한) 아래에:
   ```
   | 매장 화면(보강 3) | 점주 홈(오고 있는 단말기·진행 중 A/S·사용 중 단말기 접속·회수), 단말기 상세, 고장 접수, A/S 진행 단계·설치 확인. `/me` 점주용 응답·보이는 상태·내 매장·접수 상세 | `apps/merchant/src/`, `apps/api/src/me/` |
   ```
8. 기록 색인 줄 "결정 56·트러블슈팅 32·실험 17" → "결정 60·트러블슈팅 32·실험 17"(Task 중 트러블슈팅이 생겼으면 실제 수 — `node scripts/docs-index.mjs` 출력).
9. 테스트 절 설명과 표(Step 2에서 센 실제 값으로):
   ```markdown
   (보강 3 매장 화면 뒤 실제로 돌려 센 값(2026-10-28). api는 실험 파일 제외 — 실험은 `EXPERIMENTS=1`에서만 돈다. 보강 2 뒤에는 api 79/549, 보강 1 뒤에는 api 66/453, admin 12/109, device-sim 4/40이었다)

   | 앱 | 파일 | 테스트 |
   |---|---|---|
   | api(실험 제외) | 80 | 558 |
   | admin | 14 | 125 |
   | merchant | 6 | 32 |
   | partners | 6 | 53 |
   | device-sim | 5 | 46 |
   ```

- [ ] **Step 6: 회고**

`docs/retrospective.md` 6장 "7일 뒤 보강"의 보강 2 항목(두 줄 — `- [x] **보강 2: …`와 그 아래 `  - 보강 2가 남긴 것: …`) 뒤에:

```markdown
- [x] **보강 3: 매장(가맹점주) 화면** — 보강 2의 `/me` 위에 점주가 휴대폰으로 쓰는 별도 앱 `apps/merchant`([0057](decisions/0057-점주-화면은-별도-앱-apps-merchant.md), 어드민과 같은 lock). 공통 코드를 공유 패키지로 빼려다 사전 검증에서 React·contracts import가 패키지 폴더에서 풀리지 않는 것을 보고 복사로([0058](decisions/0058-화면-공통-코드는-공유-패키지가-아니라-복사로.md)). `/me` 단말기 응답을 점주용 모양(접속 요약·이번 배정의 운송장·이번 배정부터의 이력)으로, 범위에 보이는 상태(배정 ~ 회수 완료) — 회수 뒤 재고로 돌아간 단말기가 옛 가맹점에 보이던 것을 사전 검증에서 찾았다([0059](decisions/0059-점주-화면용-me-보강은-점주용-모양과-보이는-상태로.md)). 점주 문구·A/S·택배 단계는 화면이 상태에서([0060](decisions/0060-점주-문구와-진행-단계는-화면이-상태에서-만든다.md)). 기존 테스트는 한 줄만 바꿨다. 기록: devlog 2026-10-28 `# 보강 3: 매장 화면`, [계획](plans/2026-10-28-merchant-portal.md)
  - 보강 3이 남긴 것: 회수 뒤에도 `terminal.merchant`는 옛 가맹점(화면에서만 가림 — 운영자 화면·partner API `merchant-terminals`는 여전히 옛 가맹점으로 본다), 회수 택배(반품 운송장) 없음, 공통 코드 두 벌(같은 버그를 두 번 고치면 workspaces), 점주 알림·푸시 없음, 증상이 글 안에 섞임(통계를 내려면 코드 칸), 휴대폰 화면 자동 테스트 없음(컨트롤러 눈 확인), 한 매장 100대 넘으면 홈이 한 쪽에 안 됨
```

같은 장의 보강 2 "남긴 것" 줄의 `가맹점 화면 없음(Bundle 3)`을 `가맹점 화면 없음(→ 보강 3에서 만듦)`으로.

- [ ] **Step 7: 색인·devlog 마감**

`node scripts/docs-index.mjs --check` → `docs/index.md 최신`(아니면 `node scripts/docs-index.mjs`).

devlog 끝에 항목과 요약:

```markdown
## HH:MM Task 5 보강 3 마감 — 전체 검증, 실서버 확인, launch.json, 어드민 안내 문구, README·회고 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <Task 4 커밋 해시> (feat(merchant, F7): 점주 A/S)
- 시작 전 node PID: <목록>(이 작업이 띄운 것 아님). 끝난 뒤에도 같은 PID
- 전체 검증: api `Test Files  80 passed (80)`, `Tests  558 passed (558)`, Duration <초>, `Connection is closed` <수>. admin 14/125·build, merchant 6/32·build, device-sim 5/46·tsc 0, partners 6/53. 개발 DB `db:migration:check` 최신 상태
- 실서버(테스트 DB, api :3100 `QUEUE_PREFIX=merchant-live`, 점주 :5174 프록시): (스크립트 출력 요약 — 비밀번호 없이)
- 끔: api PID <…>·vite PID <…>(node.exe 확인 뒤), 3100·5174 LISTENING 0. `merchant-live*` 키 <N>개 하나씩 DEL. 테스트 DB 빈 DB로
- launch.json: 세션 루트·저장소 `.claude` 둘 다 `terminal-ops-merchant`(:5174), JSON 확인(커밋 안 함)
- 어드민 가맹점주 안내 → 매장 화면(:5174)
- README(구성·설치·실행·MERCHANT·매장 화면 절·기능 표·색인 수·테스트 표), 회고 6장 보강 3
- 컨트롤러 확인: (대기 / 컨트롤러가 본 것)
- 다음: 컨트롤러 확인. 병합·push 안 함

## 보강 3 요약

**한 일**: 점주 화면 `apps/merchant`(홈·단말기 상세·A/S 접수·진행 단계·설치 확인, 휴대폰 폭), `/me` 점주용 응답(접속·운송장·이번 배정 이력)·보이는 상태·내 매장·접수 상세.

**커밋**(오래된 것부터 — `git log --oneline 75c4ba7..HEAD`)
- (해시) docs: 보강 3 계획 — 매장(가맹점주) 화면
- (해시) feat(merchant, F7): 점주 화면용 /me 보강
- (해시) feat(merchant): 점주 앱 골격
- (해시) feat(merchant, F3, F8): 점주 홈·단말기 상세
- (해시) feat(merchant, F7): 점주 A/S
- (이 항목이 든 커밋) docs(merchant, 어드민): 보강 3 마감

**결정**(decisions/0057~0060)
- 0057 별도 앱(어드민과 같은 lock), 0058 공통 코드는 복사(공유 패키지 사전 검증), 0059 점주용 응답 모양·보이는 상태, 0060 점주 문구·단계는 화면이 상태에서

**숫자**: api 79/549 → 80/558, merchant 0 → 6/32, admin 14/125·device-sim 5/46·partners 6/53 그대로

**찾은 것**: 회수 뒤 재고로 돌아간 단말기가 옛 가맹점에 보이던 것(0059), `file:` TS 소스 패키지는 React·contracts import가 풀리지 않음(0058), `em.insert`는 속성 기본값을 안 씀(공부거리)

**남은 것**: [retrospective.md 6장 "7일 뒤 보강"](../retrospective.md) 보강 3 항목
```

- [ ] **Step 8: 커밋**

```bash
git add apps/admin README.md docs
git status --short   # .claude/·node_modules·dist가 없어야 한다
git commit -m "$(cat <<'EOF'
docs(merchant, 어드민): 보강 3 마감 — 전체 검증·실서버 확인·README·회고, 어드민 가맹점주 안내

Refs: docs/decisions/0057-점주-화면은-별도-앱-apps-merchant.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 시각 = 커밋 시각 확인(다르면 고쳐 amend). 끝나면 안전 규칙의 netstat·tasklist를 다시 본다.

---

## 자체 점검

- 브리프 대응: 1(별도 앱 vs 어드민, 같은 스택·프록시·포트 5174, 공통 코드 방식 사전 검증) → Task 2(0057·0058). 2(로그인·로그아웃·매장 이름, 홈 카드·진행 중 A/S·배송 중 운송장·단계, 단말기 상세의 쉬운 이력, 고장 접수·목록·상세·진행 단계·설치 확인, 회수 안내, `/me` 보강 — 접속은 단말기 응답에, 배송도 단말기 응답에(`/me/shipments` 대신, 이유 0059), 범위·404 유지, contracts 타입, 접근 표) → Task 1·3·4. 3(점주 문구·이름표 `Record`) → Task 3(0060). 4(Vitest + Testing Library 가짜 fetch, 휴대폰 폭 CSS·컨트롤러 브라우저 확인, api e2e) → Task 1~5. 5(launch.json 두 곳) → Task 5 Step 4.
- 이름 일치: 계약 `MerchantTerminalView`·`MerchantTerminalPage`·`MerchantTerminalDetail`·`MerchantTerminalEvent`·`MerchantConnectivity`·`MerchantShipmentView`·`CarrierEventCode`·`MerchantTicketView.remoteChecked/replacementStatus`(Task 1)를 Task 3·4 화면·fixtures가 같은 이름으로 쓴다. api `MERCHANT_VISIBLE_STATUSES`(Task 1)는 화면에 복제하지 않는다(화면은 서버가 준 것만 그린다). `keys.all`(Task 2)을 Task 4 쓰기 뒤 무효화가 쓴다. `useMyTerminals`·`useMyTickets`·`useMyTerminal`·`useMyTicket`(Task 3 `queries.ts`)을 Task 4가 쓴다.
- 플레이스홀더 검사: 코드 블록은 모두 사전 검증 커밋에서 뽑은 실제 코드다(Task 1 `9cfb1eb`, 2 `69e8b0d`, 3 `c79ccc9`, 4 `38404de`, 결정·문구 `9dd33ca` — 임시 폴더 `merchantcheck`). 실행 때 채우는 것은 devlog의 `HH:MM`·해시·Duration·PID·키 수, README 색인 수(트러블슈팅이 생겼을 때)뿐이다.
- 안전: 개발 DB는 Task 5의 `db:migration:check`(읽기)뿐. 실서버 쓰기는 테스트 DB. Redis는 `merchant-live*` 키만 하나씩. 서버는 단독 node 명령·PID로 끄기. 비밀번호는 seed 파일에서 변수로만.
