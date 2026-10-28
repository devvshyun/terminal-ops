# 보강 2 — 로그인·권한 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **기록 규칙 필수**: 이 저장소의 `CLAUDE.md`를 먼저 읽는다. 모든 Task는 마지막에 `docs/devlog/2026-10-28.md`(컨트롤러가 만든 파일, `## HH:MM 보강 2 계획 작성` 항목 뒤)에 항목을 덧붙이고(제목 시각 = 커밋 시각, `이전 커밋:`, 한 일·확인·막힌 것·결정·다음), Task에 적힌 결정·트러블슈팅·실험 기록을 쓴 뒤 `node scripts/docs-index.mjs`로 색인을 다시 만들어 **코드와 같은 커밋**에 넣는다. 작업 중 날짜가 바뀌면 그날 날짜로 새 파일 `docs/devlog/YYYY-MM-DD.md`를 시작하고 첫 줄에 이전 파일을 링크한다. 예상과 다른 에러를 만나면 고치기 전에 `docs/troubleshooting/`에 기록을 시작한다(이 계획이 0030·0031을 쓰므로 그다음은 0032). 실험 번호는 0017을 Task 3이 쓴다(그다음 0018).

**Goal:** 사람은 로그인하고(서버 세션), 역할(ADMIN·OPERATOR·MONITOR·FIELD·MERCHANT)마다 정해진 엔드포인트만 부르며(표에 없으면 거부), 가맹점주는 자기 가맹점 데이터만, 외부 업체는 scope가 있는 API 키로, 단말기는 단말기 키로 부른다. 이력의 작업자는 `X-Operator` 헤더가 아니라 로그인 아이디다.

**Architecture:** 전역 가드(`APP_GUARD`) 하나가 핸들러마다 단 접근 규칙(`@Public`·`@Roles`·`@DeviceAuth`·`@PartnerAuth`)을 읽고, 규칙이 없으면 403으로 막는다(기본 거부). 사람은 Redis 서버 세션 + httpOnly·SameSite=Strict 쿠키(`sid`), 비밀번호는 node:crypto scrypt. 가맹점주는 `/me/...` 전용 엔드포인트가 서비스에 `MerchantScope`를 넘긴다. 기존 테스트는 `AUTH_TEST_HEADERS=1`(NODE_ENV=test에서만 켜짐)일 때 가드가 `X-Operator`·`X-Test-Role` 헤더를 사람으로 받아 주고, `createTestApp().http()`가 기본 사람(`tester`, OPERATOR)과 단말기 키를 붙인다. 어드민은 로그인 화면·`AuthGate`·역할별 메뉴. 설계 스펙: `docs/specs/2026-10-28-auth-roles.md`.

**Tech Stack:** api Nest.js 12.2(ESM, NodeNext, tsc 빌드, vitest 5 + unplugin-swc), MikroORM 7.2(MySQL 8.4), ioredis 5(Redis 7.4), TypeScript 6.0. admin React 19.3 + Vite 8.3.4 + TanStack Query 5.104, react-router 8.4. device-sim node:http. **새 외부 의존성 없음**(scrypt·SHA-256·timingSafeEqual은 node:crypto, 쿠키 파싱은 직접, 쿠키 쓰기는 express `res.cookie`).

---

## 프로세스·데이터 안전 규칙 (모든 Task에 적용)

- **프로세스는 PID로만 끈다.** `taskkill /IM node.exe`, `pkill node`처럼 이름으로 끄지 않는다. Git Bash에서 `cd 폴더 && node … &`처럼 목록 전체를 백그라운드로 보내면 `$!`가 서브셸이다. 서버는 `node …` 단독 명령으로 띄우고 `netstat -ano | grep ':<포트> .*LISTENING'`으로 찾은 Windows PID를 `taskkill //PID <PID> //F`로 끈다.
- **Redis를 통째로 지우지 않는다.** `FLUSHALL`·`FLUSHDB` 금지. api를 직접 띄우는 확인은 `QUEUE_PREFIX`를 따로 주고(세션 키도 이 접두사 아래에 생긴다: `<접두사>:sess:*`, `<접두사>:sess-of:*`) 끝나면 `redis-cli --scan --pattern '<접두사>*'`로 본 키만 `DEL`한다.
- **테스트는 테스트 DB(`terminal_ops_test`)에서만.** 개발 DB(`terminal_ops`)는 마이그레이션 만들기·적용(`npm run db:migration:create`, `npm run db:migrate`), 시드(`npm run db:seed`), 실서버 확인(로그인·읽기)만 한다 — 실서버 확인에서 쓰기(단말기 등록 등)는 테스트 DB로 띄운 서버에서만. 테스트 DB를 다시 만드는 명령(셸 없이 한 줄):
  ```bash
  MSYS_NO_PATHCONV=1 docker exec -e MYSQL_PWD=<.env의 MYSQL_ROOT_PASSWORD> terminal-ops-mysql mysql -uroot -e "DROP DATABASE IF EXISTS terminal_ops_test; CREATE DATABASE terminal_ops_test"
  ```
  (권한은 DB를 지워도 남는다 — 사전 검증에서 이 명령 뒤 테스트가 바로 돌았다.) **이 브랜치의 테스트를 한 번 돌린 테스트 DB로 master 테스트를 돌리면 `Cannot drop table 'merchant' referenced by a foreign key constraint 'user_account_merchant_id_foreign'`로 실패한다** — 브랜치를 오가면 먼저 위 명령으로 다시 만든다(troubleshooting/0030, Task 1).
- **api 테스트를 두 개 동시에 돌리지 않는다**(globalSetup이 partners를 테스트 포트 4011에 띄운다). admin·device-sim·partners 테스트는 같이 돌려도 된다.
- **오래 도는 서버·백그라운드 명령을 남긴 채 끝내지 않는다.** 끝나면 `netstat -ano | grep -E ':(3000|3100|4010|4011|4020|4021|5173) .*LISTENING'` 출력이 없고 `tasklist //FI "IMAGENAME eq node.exe" //FO CSV //NH`가 시작 전과 같은 PID만 보여야 한다.
- **긴 기록·코드 편집은 Write·Edit 도구로 한다**(troubleshooting/0024: Bash heredoc 안의 따옴표·백틱이 깨진다).
- **비밀번호·키는 모두 테스트 값이다.** 시연 값은 `apps/api/src/db/seed-accounts.ts`와 `.env.example`에 있고 README에 "로컬 시연 전용 값"으로 적는다. devlog·리뷰 보고에 비밀번호·키 원문을 옮겨 적지 않는다(파일 경로로 가리킨다).
  - (최종 리뷰 Minor 2·7c 뒤 보탬) 시연 비밀번호 원문의 기준은 seed 파일 하나다 — 이 계획의 비밀번호 자리는 `(seed 파일 참고)`로 바꿨다. 이 계획에 적힌 `DEVICE_API_KEY` 값은 **폐기**했다(로컬 `.env`는 무작위 값으로 바꿨고, api는 `.env.example`의 `change-me…` 자리표시자로는 뜨지 않는다).
- **저장소 `.env`는 커밋하지 않는다**(`.gitignore`). Task 3이 `.env.example`에 더한 줄을 `.env`에도 덧붙여야 api가 뜬다(`DEVICE_API_KEY`가 없으면 시작할 때 던진다 — 마이그레이션 만들기·시드 스크립트도 env를 읽으므로 Task 5의 `db:migration:create`도 마찬가지).

## 사전 검증으로 확인된 사실 (2026-10-28, 임시 폴더)

계획 작성 전에 저장소(브랜치 `auth-roles`, master 7487fe4)를 임시 폴더에 복제해 앱 네 개를 `npm ci`로 설치하고, 이 계획의 코드를 Task 순서대로 적용해 Task마다 커밋하며 돌렸다(테스트 DB `terminal_ops_test`, Redis는 테스트 접두사와 확인용 접두사만). 코드 블록은 모두 그 커밋에서 그대로 뽑았다(전체 파일 = `git show <커밋>:<경로>`, 바꾼 파일 = `git diff <앞 커밋> <커밋> -- <경로>`). 검증 뒤 확인용 Redis 키는 지웠고 테스트 DB는 빈 DB로 다시 만들었다.

- **테스트 수(실제로 돌려 센 값, 누적)**: api master 66/453 → Task 1 68/461 → Task 2 71/483(전체 약 265초) → Task 3 72/488 → Task 4 73/496 → Task 5 75/512(전체 약 301초, `Connection is closed` 0). admin 12/109 → Task 6 12/111. device-sim 4/40 → Task 3 5/43. partners 6/53 그대로. (Task 1·3·4는 그 Task의 테스트 파일과 관련 e2e를 돌려 더한 수, Task 2·5·마감은 전체를 돌린 수.)
- **기존 api 테스트에서 고친 곳은 다섯 줄**: "작업자 헤더가 없으면 400"을 확인하던 `terminal.e2e`(2개)·`firmware-rollout.e2e`·`purchase-order.e2e`·`van-collect.e2e` — 이제 `t.http(null)`(헤더 없음)로 부르고 401을 기대한다. 나머지 448개는 그대로 통과했다(테스트 도우미가 기본 사람 `tester`와 단말기 키를 붙이고, 기존 테스트의 `.set({ 'X-Operator': 'kim' })`이 그 사람을 kim으로 바꾼다 — actor 단언 약 20곳이 그대로 맞는다).
- **접근 표 전수 검사가 빠뜨림을 잡는다**: `health.controller.ts`에서 `@Public()`을 지우고 돌리면
  ```
  × 모든 핸들러에 접근 규칙이 있다(없으면 기본 거부 403 — 달아야 한다)
  AssertionError: expected [ 'GET /health' ] to deeply equal []
  × 실제 규칙이 결정 기록의 표와 같다(엔드포인트가 새로 생기거나 역할이 바뀌면 표도 바꾼다)
  -   "GET /health": "public",
  +   "GET /health": null,
  ```
  (확인 뒤 되돌림.) 모듈 메타데이터를 훑는 방식이라 동적 모듈(`MikroOrmModule.forRoot`)의 `imports`가 `undefined`일 수 있다 — 처음 버전이 `is not iterable`로 실패해 `?? []`를 붙였다(계획 코드에 반영됨).
- **비밀번호 해시 비용(이 PC, `crypto.scryptSync` 5회 평균)**: N=2^14·r=8·p=1 26ms, N=2^15·p=1 51ms, N=2^15·p=3 142ms, N=2^16·p=1 109ms. N=2^15는 메모리 128·N·r = 32MiB라 node 기본 `maxmem`(32MiB)에 걸린다 → `maxmem` 64MiB(decisions/0051).
- **마이그레이션은 스냅샷 파일로 만든다**: 사전 검증은 개발 DB를 건드리지 않으려고 `.snapshot-terminal_ops.json`을 `.snapshot-terminal_ops_test.json`으로 복사해 `MYSQL_DATABASE=terminal_ops_test npm run db:migration:create`로 만들고 다시 옮겼다. 실제 저장소에서는 그냥 `npm run db:migration:create`(개발 DB 연결, 스냅샷과 엔티티를 비교)를 쓴다 — 파일 이름(시각)은 다르고 SQL은 계획과 같아야 한다.
- **초 단위 `datetime` 열은 밀리초를 반올림한다**: 외부 업체 키 폐기 응답의 `revokedAt`이 메모리 값(`…29.790Z`)이고 다시 읽으면 `…30.000Z`라 "두 번 폐기해도 처음 시각" 테스트가 실패했다(`expected '2026-10-27T15:55:30.000Z' to be '2026-10-27T15:55:29.790Z'`) → 저장 뒤 다시 읽어 응답(troubleshooting/0031, Task 5).
- **실서버 확인(테스트 DB, 포트 3100, `RUN_WORKERS=0 RUN_SCHEDULERS=0 QUEUE_PREFIX=authcheck-live`)**: `GET /health` 200, 로그인 없이 `GET /terminals` 401 `UNAUTHENTICATED`, `X-Operator`만 보내도 401(운영 실행이라 테스트 헤더 꺼짐), 틀린 비밀번호 401 `LOGIN_FAILED`, operator 로그인 200(쿠키 1줄, `#HttpOnly_`), `/auth/me` 200, 단말기 등록·검수·재고·배정 201/201/200/201, 이력 actor `operator`, monitor의 `POST /terminals` 403 `이 작업은 OPERATOR 역할만 할 수 있습니다(지금: MONITOR).`, field의 `/dashboard/summary` 403, merchant-gangnam `/me/terminals`는 LV-0001만, 역삼 단말기 `/me/terminals/LV-0002` 404 `단말기 LV-0002이(가) 없습니다.`, 가맹점주의 `/terminals` 403, 로그아웃 204 뒤 같은 쿠키 401, 단말기 키 없음 401·있음 200, 시연 외부 업체 키 Bearer 200 `{"serialNo":"LV-0001","modelCode":"SN-100","status":"ALLOCATED","merchantCode":"GANGNAM-KIMBAP"}`, 키 없음 401. 끈 뒤 3100 LISTENING 0. `authcheck-live*` 키 12개(큐 meta 6, 세션 3, 계정 색인 3)를 하나씩 `DEL`.
- **실험 0017(하트비트 처리량)**: 기본 부하(5,000대·5초·30초)는 인증 전후 모두 30,000/30,000·오류 0, p50·p95 차이 없음. 단건 최대 처리량(주기 100ms)은 master와 Task 3을 번갈아 3번씩 재서 평균 4,023/s → 3,824/s(−4.9%), p50 3.4 → 3.6ms. 묶음 100 최대(주기 20ms)는 약 97,700 → 100,200/s로 차이 없음(잡음 안). 같은 master 코드가 30분 사이에 4,800 → 4,020/s로 달라져 순서대로 잰 값끼리는 비교하지 않는다(번갈아 잰 값만).
- **`apps/device-sim/node_modules`가 있어야 api 전체 테스트가 돈다**(`device-sim.e2e`가 시뮬레이터를 빌드해 띄운다 — 보강 1 사전 검증과 같음).

## 범위 조정 (브리프와 다르게 한 것과 이유)

- **결정 번호는 브리프 순서로 미리 정했다**(0050 세션, 0051 해시, 0052 역할 표, 0053 가맹점 범위, 0054 외부 업체 키, 0055 단말기, 0056 `X-Operator` 이전·테스트 전략). Task 순서와 달라 Task 1이 0051을, Task 2가 0050·0052·0056을 쓴다. 0001은 "대체됨 → 0050"(Task 7).
- **역할 변경은 "그 계정의 세션을 모두 끊기"로 반영한다** — 세션에 역할을 넣어 요청마다 MySQL을 읽지 않는다. 계정 API(`PATCH /admin/accounts/:id`)가 역할·가맹점·비밀번호·사용 중지를 바꾸면 끊는다(decisions/0050).
- **ADMIN은 업무 쓰기를 하지 않는다**(계정·키 관리와 읽기만). 브리프의 "ADMIN(계정·역할·외부 업체 키 관리)"를 그대로 좁게 읽었다.
- **외부 업체 키의 호출 로그 테이블은 Bundle 7로 미룬다** — 지금은 `last_used_at`(1분에 한 번 갱신)만(decisions/0054).
- **시연 외부 업체 키는 시드에 고정한 테스트 값**(시드 실행 때 한 번 출력하지 않음) — README의 curl을 그대로 쓸 수 있게(decisions/0054).
- **가맹점주 화면은 만들지 않는다**(Bundle 3). 어드민은 가맹점주가 로그인하면 안내와 로그아웃만 보인다.
- **계정·키 관리 화면은 만들지 않는다**(Bundle 7). API와 테스트까지.

## 파일 구조

```
terminal-ops/
├─ .env.example                                  (Task 3) DEVICE_API_KEY·세션·로그인 제한 값
├─ packages/contracts/src/auth.ts (새)            (Task 1) Role, LoginRequest, MeView, AccountView, 계정·키 요청/응답, PartnerScope, PartnerTerminalView
│  └─ errors.ts, index.ts                        (Task 1) AuthErrorCode
├─ apps/api/
│  ├─ vitest.config.ts                           (Task 2 AUTH_TEST_HEADERS, Task 3 DEVICE_API_KEY)
│  ├─ src/auth/ (새)
│  │  ├─ role.ts, user-account.entity.ts, password.ts                                (Task 1)
│  │  ├─ access.ts, principal.ts, cookies.ts, session.store.ts, auth.service.ts,
│  │  │  auth.controller.ts, auth.guard.ts, auth.module.ts, dto/login.dto.ts         (Task 2; guard는 Task 3·5 보탬, access·module은 Task 5 보탬)
│  │  └─ account.service.ts, partner-key.entity.ts, partner-key.service.ts           (Task 5)
│  ├─ src/config/auth-test-headers.ts (새), env.ts                                  (Task 2, env는 Task 3 보탬)
│  ├─ src/common/operator.decorator.ts                                               (Task 2) 헤더 대신 로그인 아이디
│  ├─ src/common/contract-assertions.ts, src/entities.ts                             (Task 1·5)
│  ├─ src/db/seed-accounts.ts (새), seed.ts                                          (Task 1·5)
│  ├─ src/migrations/Migration<시각>.ts ×2, .snapshot-terminal_ops.json               (Task 1·5)
│  ├─ src/**/*.controller.ts 기존 18개                                              (Task 2) 접근 규칙(정정: 처음 '20개'라 적었으나 실제 기존 18개 + 새 auth.controller = 19)
│  ├─ src/merchant/merchant-scope.ts (새), src/me/ (새)                              (Task 4)
│  ├─ src/terminal/terminal.service.ts, src/service/*.service.ts, service.module.ts  (Task 4) scope 인자
│  ├─ src/admin/ (새), src/partner-api/ (새), src/app.module.ts                      (Task 2·4·5)
│  └─ test/
│     ├─ helpers/test-app.ts                     (Task 2·3) 기본 사람·단말기 키, http(null)
│     ├─ helpers/auth.ts (새)                    (Task 2) 계정 만들기·실제 로그인
│     ├─ unit/password.spec.ts, account-seed.e2e.spec.ts                             (Task 1)
│     ├─ unit/auth-guard.spec.ts, unit/access-table.spec.ts, auth.e2e.spec.ts        (Task 2; 표는 Task 4·5 보탬)
│     ├─ device-auth.e2e.spec.ts (Task 3), me.e2e.spec.ts (Task 4), admin-accounts.e2e.spec.ts·partner-api.e2e.spec.ts (Task 5)
│     └─ terminal·firmware-rollout·purchase-order·van-collect.e2e.spec.ts            (Task 2) 400 → 401 다섯 줄
├─ apps/device-sim/src/config.ts, client.ts, fleet.ts, server.ts; test/helpers.ts, test/device-key.spec.ts (새)   (Task 3)
├─ apps/admin/src/
│  ├─ session.ts (새), components/AuthGate.tsx·UserBar.tsx (새), pages/LoginPage.tsx·LoginPage.test.tsx (새)       (Task 6)
│  ├─ operator.ts, operator.test.tsx, components/OperatorBar.tsx (삭제)                                             (Task 6)
│  └─ App.tsx, nav.ts, api/client.ts, components/Layout·WriteButton·ErrorBox·TerminalActions, lib/labels.ts,
│     pages(Home·Scan·Anomalies·VanRuns·WeeklyReports), styles.css, test/render.tsx·setup.ts, 테스트 4개               (Task 6)
└─ docs/
   ├─ decisions/0050~0056 (새), 0001(대체됨 표시, Task 7)
   ├─ troubleshooting/0030 (Task 1), 0031 (Task 5)
   ├─ experiments/0017 (Task 3)
   ├─ devlog/2026-10-28.md, index.md(스크립트), study/backlog.md
   └─ README.md, retrospective.md (Task 7)
```

## Task 순서

| Task | 내용 | 앱 | 기록 | 테스트 수(끝) | 추천 모델 |
|---|---|---|---|---|---|
| 1 | 계약 타입, 계정 테이블, scrypt 해시, 시연 계정 시드 | contracts, api | decisions 0051, troubleshooting 0030 | api 68/461 | sonnet |
| 2 | 세션·로그인 API·전역 가드(기본 거부)·역할 표·작업자 = 로그인 아이디·테스트 도우미 | api | decisions 0050·0052·0056 | api 71/483 | opus |
| 3 | 단말기 키 — 가드, env, device-sim, 실험 0017 | api, device-sim | decisions 0055, experiments 0017 | api 72/488, device-sim 5/43 | opus |
| 4 | 가맹점주 범위 — `/me`, 서비스 scope, 범위 밖 404 | api | decisions 0053 | api 73/496 | sonnet |
| 5 | 계정 관리 API·외부 업체 키·`/partner/v1`·시연 키 | api | decisions 0054, troubleshooting 0031 | api 75/512 | sonnet |
| 6 | 어드민 로그인 화면·로그아웃·역할별 메뉴·버튼·401/403 | admin | decisions 0041 보탬 | admin 12/111 | sonnet |
| 7 | 마감 — 전체 검증, 개발 DB 마이그레이션·시드, 실서버 확인, README·색인·회고, 0001 대체 | 전체·docs | 0001 표시 | 최종 확인 | sonnet |

의존: 차례대로 한다. Task 2의 가드가 모든 컨트롤러를 바꾸므로 Task 3~5는 그 위에 얹는다. Task 6은 Task 1의 계약 타입과 Task 2의 `/auth/*` 응답에 기댄다. 각 Task 끝의 테스트 수가 위 표와 다르면 멈추고 원인을 적는다.

## 커밋 규칙(보강 2)

인증에는 기능 ID가 없으므로 범위를 `auth`로 쓴다: `type(auth): 요약`. 기존 기능을 함께 바꾸면 그 ID를 붙인다(단말기 키 `auth, F8`, 가맹점 A/S `auth, F7`, 어드민 화면 `auth, 어드민`). 본문에 `Refs: <기록 경로>`, 마지막 줄 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. 이 규칙은 Task 1 devlog 항목에 한 줄로 적는다.

---

### Task 1: 계약 타입, 계정 테이블, scrypt 비밀번호 해시, 시연 계정 시드

**Files:**
- Create: `packages/contracts/src/auth.ts`
- Modify: `packages/contracts/src/errors.ts`, `packages/contracts/src/index.ts`
- Create: `apps/api/src/auth/role.ts`, `apps/api/src/auth/user-account.entity.ts`, `apps/api/src/auth/password.ts`, `apps/api/src/db/seed-accounts.ts`
- Modify: `apps/api/src/entities.ts`, `apps/api/src/common/contract-assertions.ts`, `apps/api/src/db/seed.ts`
- Create(생성 명령): `apps/api/src/migrations/Migration<시각>.ts`, Modify: `apps/api/src/migrations/.snapshot-terminal_ops.json`
- Test: `apps/api/test/unit/password.spec.ts`, `apps/api/test/account-seed.e2e.spec.ts`
- Docs: `docs/decisions/0051-비밀번호-해시는-node-scrypt-계정-테이블은-user-account.md`, `docs/troubleshooting/0030-다른-브랜치가-쓴-테스트-DB에서-schema-refresh가-merchant를-못-지운다.md`, `docs/index.md`, `docs/devlog/2026-10-28.md`, `docs/study/backlog.md`

- [ ] **Step 1: 시작 상태 확인**

Run(저장소 루트): `git status --short && git log --oneline -1 && tasklist //FI "IMAGENAME eq node.exe" //FO CSV //NH`
Expected: 브랜치 `auth-roles`, 마지막 커밋은 이 계획의 `docs: 보강 2 계획 — 로그인·권한`, 변경 없음. node PID 목록을 적어 둔다. 테스트 DB를 안전 규칙의 명령으로 다시 만든다.

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`apps/api/test/unit/password.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { dummyPasswordHash, hashPassword, SCRYPT_PARAMS, verifyPassword } from '../../src/auth/password.js';

describe('비밀번호 해시 — scrypt (decisions/0051)', () => {
  it('형식은 scrypt$N$r$p$salt$hash이고, 같은 비밀번호도 소금이 달라 해시가 다르다', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    expect(a).toMatch(/^scrypt\$32768\$8\$3\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(SCRYPT_PARAMS).toEqual({ N: 32768, r: 8, p: 3 });
    expect(a).not.toBe(b);
  });

  it('맞는 비밀번호만 true', async () => {
    const stored = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', stored)).toBe(true);
    expect(await verifyPassword('correct hors', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('저장된 비용 값으로 확인한다 — 비용을 올려도 옛 해시가 맞는다', async () => {
    const stored = await hashPassword('pw-1234567');
    const [, , r, p, salt] = stored.split('$');
    // 같은 소금·r·p에 N만 다르면 다른 키가 나온다 → 저장 형식의 N을 읽지 않으면 틀린다
    const changedN = ['scrypt', '16384', r, p, salt, stored.split('$')[5]].join('$');
    expect(await verifyPassword('pw-1234567', changedN)).toBe(false);
    expect(await verifyPassword('pw-1234567', stored)).toBe(true);
  });

  it('형식이 틀린 해시는 던지지 않고 false', async () => {
    for (const bad of ['', 'plain', 'bcrypt$1$2$3$a$b', 'scrypt$x$8$1$AAAA$BBBB', 'scrypt$16384$8$1$$BBBB', 'scrypt$16384$8$1$AAAA$short']) {
      expect(await verifyPassword('pw', bad)).toBe(false);
    }
  });

  it('가짜 해시는 한 번만 만들고 어떤 비밀번호와도 맞지 않는다', async () => {
    const first = await dummyPasswordHash();
    expect(await dummyPasswordHash()).toBe(first);
    expect(await verifyPassword('anything', first)).toBe(false);
  });
});
```

`apps/api/test/account-seed.e2e.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyPassword } from '../src/auth/password.js';
import { UserAccount } from '../src/auth/user-account.entity.js';
import { DEMO_ACCOUNTS, seedDemoAccounts } from '../src/db/seed-accounts.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('시연 계정 시드 (보강 2, decisions/0051)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('테스트 DB 기준 데이터에는 계정이 없다(필요한 테스트가 직접 만든다)', async () => {
    expect(await t.orm.em.fork().count(UserAccount)).toBe(0);
  });

  it('역할마다 하나, 가맹점주는 가맹점마다 하나 — 7개. 두 번 돌려도 늘지 않는다', async () => {
    expect(await seedDemoAccounts(t.orm.em.fork())).toBe(7);
    expect(await seedDemoAccounts(t.orm.em.fork())).toBe(0);
    const rows = await t.orm.em.fork().find(UserAccount, {}, { populate: ['merchant'], orderBy: { id: 'asc' } });
    expect(rows.map((a) => [a.loginId, a.role, a.merchant?.code ?? null])).toEqual([
      ['admin', 'ADMIN', null],
      ['operator', 'OPERATOR', null],
      ['monitor', 'MONITOR', null],
      ['field', 'FIELD', null],
      ['merchant-gangnam', 'MERCHANT', 'GANGNAM-KIMBAP'],
      ['merchant-yeoksam', 'MERCHANT', 'YEOKSAM-CAFE'],
      ['merchant-pangyo', 'MERCHANT', 'PANGYO-BUNSIK'],
    ]);
  });

  it('저장된 것은 해시이고 시드 비밀번호로 확인된다', async () => {
    const operator = await t.orm.em.fork().findOneOrFail(UserAccount, { loginId: 'operator' });
    const seed = DEMO_ACCOUNTS.find((a) => a.loginId === 'operator')!;
    expect(operator.passwordHash).not.toContain(seed.password);
    expect(await verifyPassword(seed.password, operator.passwordHash)).toBe(true);
  });
});
```

- [ ] **Step 3: 실패를 확인한다**

Run(`apps/api`): `npx vitest run test/unit/password.spec.ts test/account-seed.e2e.spec.ts`
Expected: 두 파일 모두 FAIL — `../../src/auth/password.js`·`../src/auth/user-account.entity.js`·`../src/db/seed-accounts.js`를 찾지 못한다(`Failed to load url` 또는 `Cannot find module`).

- [ ] **Step 4: 계약 타입**

`packages/contracts/src/auth.ts`(새 파일 — Task 5·6이 쓰는 계정·키 타입까지 한 번에 둔다):

```ts
/**
 * 로그인·역할·계정·외부 업체 키(보강 2). 역할 값은 api `auth/role.ts` Role enum과 같아야 한다(contract-assertions.ts가 단언).
 * 역할별로 할 수 있는 일(엔드포인트 표)은 decisions/0052에 있다. 화면은 역할로 메뉴·버튼을 숨기지만 최종 판단은 서버가 한다.
 */
import type { TerminalStatus } from './statuses.js';

/**
 * ADMIN: 계정·역할·외부 업체 키 관리(업무 데이터는 읽기만)
 * OPERATOR: 운영자 — 어드민의 모든 업무 쓰기
 * MONITOR: 운영 관제·개발자 — 읽기 + 관제 작업(이상 찾기, VAN 대조, 주간 리포트 보내기)
 * FIELD: 현장 작업자 — 박스 스캔·검수와 그에 필요한 조회
 * MERCHANT: 가맹점주 — 자기 가맹점 데이터만(`/me/...`)
 */
export type Role = 'ADMIN' | 'OPERATOR' | 'MONITOR' | 'FIELD' | 'MERCHANT';

/** POST /auth/login */
export interface LoginRequest {
  loginId: string;
  password: string;
}

/** GET /auth/me, POST /auth/login 응답 — 지금 로그인한 사람 */
export interface MeView {
  loginId: string;
  displayName: string;
  role: Role;
  /** MERCHANT만 값이 있다 */
  merchantCode: string | null;
}

/** GET /admin/accounts 한 줄 */
export interface AccountView extends MeView {
  id: number;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

/** POST /admin/accounts */
export interface CreateAccountRequest {
  /** 영문 소문자·숫자·`.`·`-`·`_` 3~50자 */
  loginId: string;
  displayName: string;
  /** 10~200자 */
  password: string;
  role: Role;
  /** role이 MERCHANT일 때만, 그때는 꼭 */
  merchantCode?: string | null;
}

/** PATCH /admin/accounts/:id — 준 것만 바꾼다. 역할·가맹점·비밀번호·사용 중지를 바꾸면 그 계정의 세션을 모두 끊는다 */
export interface UpdateAccountRequest {
  displayName?: string;
  role?: Role;
  merchantCode?: string | null;
  password?: string;
  disabled?: boolean;
}

/** 외부 업체 키가 할 수 있는 일(decisions/0054) */
export type PartnerScope = 'terminal-status:read' | 'merchant-terminals:read';

/** GET /admin/partner-keys 한 줄. 키 원문은 없다(만들 때 한 번만 준다) */
export interface PartnerKeyView {
  id: number;
  /** 업체 이름(표시용) */
  name: string;
  /** 키 앞부분(`pk_` + 8자). 어느 키인지 알아보는 용도 */
  prefix: string;
  scopes: PartnerScope[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdBy: string;
  createdAt: string;
}

/** POST /admin/partner-keys 응답 — key(원문)는 이 응답에만 있다 */
export interface CreatedPartnerKeyView extends PartnerKeyView {
  key: string;
}

/** POST /admin/partner-keys */
export interface CreatePartnerKeyRequest {
  name: string;
  scopes: PartnerScope[];
  /** ISO 시각. 없으면 만료 없음 */
  expiresAt?: string | null;
}

/** GET /partner/v1/terminals/:serialNo, GET /partner/v1/merchants/:code/terminals 한 줄 */
export interface PartnerTerminalView {
  serialNo: string;
  modelCode: string;
  status: TerminalStatus;
  merchantCode: string | null;
}
```

`packages/contracts/src/errors.ts`와 `index.ts`:

```diff
--- a/packages/contracts/src/errors.ts
+++ b/packages/contracts/src/errors.ts
@@ -45,7 +45,14 @@ export type InputErrorCode =
   | 'MISSING_COLUMNS'
   | 'TOO_MANY_ROWS';
 
-export type ErrorCode = BusinessErrorCode | FilterErrorCode | InputErrorCode;
+/**
+ * 인증·권한(보강 2). 401 UNAUTHENTICATED: 로그인(세션)·키가 없거나 끝남 → 화면은 로그인으로. 403 FORBIDDEN: 로그인했지만 역할·범위 밖.
+ * 401 LOGIN_FAILED: 아이디·비밀번호가 틀림(어느 쪽인지 말하지 않는다). 429 LOGIN_LOCKED: 실패가 많아 잠시 막음.
+ * 400 MERCHANT_REQUIRED: MERCHANT 계정에 가맹점이 없거나, 다른 역할에 가맹점을 줌
+ */
+export type AuthErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'LOGIN_FAILED' | 'LOGIN_LOCKED' | 'MERCHANT_REQUIRED';
+
+export type ErrorCode = BusinessErrorCode | FilterErrorCode | InputErrorCode | AuthErrorCode;
 
 /** 오류 응답 본문. 404·ValidationPipe 400에는 code가 없고, ValidationPipe의 message는 항목별 배열이다 */
 export interface ApiErrorBody {
```

```diff
--- a/packages/contracts/src/index.ts
+++ b/packages/contracts/src/index.ts
@@ -10,3 +10,4 @@ export type * from './terminal.js';
 export type * from './operations.js';
 export type * from './reports.js';
 export type * from './requests.js';
+export type * from './auth.js';
```

- [ ] **Step 5: 역할 enum·계정 엔티티·비밀번호 해시**

`apps/api/src/auth/role.ts`:

```ts
/** 사람 계정의 역할(보강 2). 값은 contracts `Role`과 같다(common/contract-assertions.ts). 역할별 엔드포인트 표는 decisions/0052 */
export enum Role {
  ADMIN = 'ADMIN',
  OPERATOR = 'OPERATOR',
  MONITOR = 'MONITOR',
  FIELD = 'FIELD',
  MERCHANT = 'MERCHANT',
}
```

`apps/api/src/auth/user-account.entity.ts`(nullable 열은 `type`을 명시한다 — swc와 tsc의 데코레이터 메타데이터 차이, troubleshooting/0029):

```ts
import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { Merchant } from '../merchant/merchant.entity.js';
import { Role } from './role.js';

/**
 * 사람 계정(보강 2, decisions/0051). 로그인 아이디가 이력·검수·스캔의 actor가 된다(decisions/0056).
 * MERCHANT만 merchant가 있다 — 서비스(AccountService)가 지킨다(DB 제약은 두지 않음, decisions/0051).
 */
@Entity({ tableName: 'user_account' })
export class UserAccount {
  [OptionalProps]?: 'merchant' | 'disabledAt' | 'lastLoginAt' | 'createdAt' | 'updatedAt';

  @PrimaryKey()
  id!: number;

  /** 로그인 아이디(영문 소문자·숫자·`.`·`-`·`_` 3~50자). 이력 actor로 남으므로 바꾸지 않는다 */
  @Property({ unique: true, length: 50 })
  loginId!: string;

  @Property({ length: 50 })
  displayName!: string;

  /** `scrypt$N$r$p$salt$hash`(password.ts) */
  @Property({ length: 200 })
  passwordHash!: string;

  @Enum({ items: () => Role })
  role!: Role;

  @ManyToOne(() => Merchant, { nullable: true })
  merchant: Rel<Merchant> | null = null;

  /** 값이 있으면 로그인할 수 없다 */
  @Property({ type: 'datetime', nullable: true })
  disabledAt: Date | null = null;

  @Property({ type: 'datetime', nullable: true })
  lastLoginAt: Date | null = null;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
```

`apps/api/src/auth/password.ts`:

```ts
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * 비밀번호 해시(decisions/0051). node:crypto scrypt — 새 의존성·네이티브 빌드가 없다.
 * 비용은 OWASP 비밀번호 저장 권고표의 scrypt 한 줄(N=2^15, r=8, p=3). 이 PC에서 한 번에 약 140ms(계획 사전 검증).
 * 저장 형식: `scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>` — 비용을 올려도 옛 해시를 그 값으로 확인할 수 있다.
 */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 3 } as const;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
/** scrypt 메모리 128·N·r = 32MiB. node 기본 maxmem(32MiB)에 딱 걸리므로 넉넉히 연다 */
const MAX_MEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { ...params, maxmem: MAX_MEM };
  return new Promise((resolve, reject) => scrypt(password, salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, SCRYPT_PARAMS);
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** 저장된 해시와 같은 비밀번호인지. 형식이 틀린 해시는 false(던지지 않는다). 비교는 timingSafeEqual */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length === 0 || expected.length !== KEY_LENGTH) return false;
  const actual = await derive(password, salt, { N, r, p });
  return timingSafeEqual(actual, expected);
}

/**
 * 없는 아이디로 로그인할 때도 비슷한 시간을 쓰게 하는 가짜 해시(응답 시간으로 계정 유무를 알아내지 못하게).
 * 처음 한 번 만들어 두고 이것과 비교한다(결과는 늘 false).
 */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}
```

- [ ] **Step 6: 엔티티 등록·계약 단언·시드**

```diff
--- a/apps/api/src/entities.ts
+++ b/apps/api/src/entities.ts
@@ -14,6 +14,7 @@ import { Firmware, FirmwareRollout, FirmwareRolloutTarget } from './firmware/fir
 import { VanReconciliationItem, VanReconciliationRun, VanRegistrationSnapshot } from './van/van.entities.js';
 import { Anomaly } from './anomaly/anomaly.entity.js';
 import { WeeklyReport } from './report/weekly-report.entity.js';
+import { UserAccount } from './auth/user-account.entity.js';
 
 /** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
-export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch, ServiceTicket, DeviceConnectivity, Firmware, FirmwareRollout, FirmwareRolloutTarget, VanReconciliationRun, VanRegistrationSnapshot, VanReconciliationItem, Anomaly, WeeklyReport];
+export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch, ServiceTicket, DeviceConnectivity, Firmware, FirmwareRollout, FirmwareRolloutTarget, VanReconciliationRun, VanRegistrationSnapshot, VanReconciliationItem, Anomaly, WeeklyReport, UserAccount];
```

```diff
--- a/apps/api/src/common/contract-assertions.ts
+++ b/apps/api/src/common/contract-assertions.ts
@@ -6,6 +6,7 @@
  */
 import type * as C from '@terminal-ops/contracts';
 import type { AnomalyRule } from '../anomaly/anomaly.entity.js';
+import type { Role } from '../auth/role.js';
 import type { Carrier } from '../carrier/carrier.types.js';
 import type { RolloutStatus } from '../firmware/firmware.entities.js';
 import type { PurchaseOrderStatus } from '../purchase-order/purchase-order.entity.js';
@@ -41,4 +42,5 @@ export type ContractEnumAssertions = [
   Assert<Same<`${VanMismatchKind}`, C.VanMismatchKind>>,
   Assert<Same<`${WeeklyReportStatus}`, C.WeeklyReportStatus>>,
   Assert<Same<(typeof SYNC_RUN_OUTCOMES)[number], C.SyncRunOutcome>>,
+  Assert<Same<`${Role}`, C.Role>>,
 ];
```

`apps/api/src/db/seed-accounts.ts`(비밀번호는 로컬 시연 전용 테스트 값 — 이 파일 자체가 기록이다):

```ts
import type { EntityManager } from '@mikro-orm/mysql';
import { hashPassword } from '../auth/password.js';
import { Role } from '../auth/role.js';
import { UserAccount } from '../auth/user-account.entity.js';
import { Merchant } from '../merchant/merchant.entity.js';

/**
 * 로컬 시연 전용 계정(보강 2). 비밀번호는 이 저장소에 공개된 **테스트 값**이다 — 실제 서비스에 쓰지 않는다(README "로컬 시연 전용 값").
 * 역할마다 하나, 가맹점주는 시드 가맹점(seed-reference.ts MERCHANT_SEEDS) 세 곳에 하나씩.
 * 테스트(resetDatabase)는 이 계정을 넣지 않는다 — 해시 7번(약 1초)을 파일마다 쓰지 않게, 필요한 테스트가 직접 만든다.
 */
export const DEMO_ACCOUNTS: { loginId: string; displayName: string; role: Role; password: string; merchantCode?: string }[] = [
  { loginId: 'admin', displayName: '관리자(시연)', role: Role.ADMIN, password: '(seed 파일 참고)' },
  { loginId: 'operator', displayName: '운영자(시연)', role: Role.OPERATOR, password: '(seed 파일 참고)' },
  { loginId: 'monitor', displayName: '관제(시연)', role: Role.MONITOR, password: '(seed 파일 참고)' },
  { loginId: 'field', displayName: '현장 작업자(시연)', role: Role.FIELD, password: '(seed 파일 참고)' },
  { loginId: 'merchant-gangnam', displayName: '강남김밥 점주(시연)', role: Role.MERCHANT, password: '(seed 파일 참고)', merchantCode: 'GANGNAM-KIMBAP' },
  { loginId: 'merchant-yeoksam', displayName: '역삼카페 점주(시연)', role: Role.MERCHANT, password: '(seed 파일 참고)', merchantCode: 'YEOKSAM-CAFE' },
  { loginId: 'merchant-pangyo', displayName: '판교분식 점주(시연)', role: Role.MERCHANT, password: '(seed 파일 참고)', merchantCode: 'PANGYO-BUNSIK' },
];

/** 시연 계정을 넣는다. 이미 있는 아이디는 건너뛴다(비밀번호·역할을 되돌리지 않는다 — 시연 중 바꾼 값을 지우지 않게). 넣은 수를 돌려준다 */
export async function seedDemoAccounts(em: EntityManager): Promise<number> {
  let created = 0;
  for (const seed of DEMO_ACCOUNTS) {
    if (await em.findOne(UserAccount, { loginId: seed.loginId })) continue;
    const merchant = seed.merchantCode ? await em.findOneOrFail(Merchant, { code: seed.merchantCode }) : null;
    em.create(UserAccount, {
      loginId: seed.loginId,
      displayName: seed.displayName,
      role: seed.role,
      merchant,
      passwordHash: await hashPassword(seed.password),
    });
    created += 1;
  }
  await em.flush();
  return created;
}
```

`apps/api/src/db/seed.ts`:

```ts
import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/mysql';
import config from '../mikro-orm.config.js';
import { seedDemoAccounts } from './seed-accounts.js';
import { seedReference } from './seed-reference.js';

const orm = await MikroORM.init(config);
try {
  await seedReference(orm.em.fork());
  console.log('기준 데이터 시드 완료');
  const accounts = await seedDemoAccounts(orm.em.fork());
  console.log(`시연 계정 시드 완료(새로 ${accounts}개, 비밀번호는 src/db/seed-accounts.ts — 로컬 시연 전용 값)`);
} finally {
  await orm.close(true);
}
```

- [ ] **Step 7: 테스트가 통과하는지 본다**

Run(`apps/api`): `npx vitest run test/unit/password.spec.ts test/account-seed.e2e.spec.ts && npm run typecheck`
Expected: `Test Files  2 passed (2)`, `Tests  8 passed (8)`, typecheck 출력 없이 끝남.

- [ ] **Step 8: 마이그레이션을 만든다(개발 DB 연결 — 만들기만)**

Run(`apps/api`): `npm run db:migration:create`
Expected: `생성: Migration<시각>.ts`. 새 파일의 `up()`이 아래와 같아야 한다(클래스 이름·`name`은 만든 시각):

```ts
import { Migration } from '@mikro-orm/migrations';

export class Migration20261027151714 extends Migration {

  override name = 'Migration20261027151714';

  override up(): void | Promise<void> {
    this.addSql(`create table \`user_account\` (\`id\` int unsigned not null auto_increment primary key, \`login_id\` varchar(50) not null, \`display_name\` varchar(50) not null, \`password_hash\` varchar(200) not null, \`role\` enum('ADMIN','OPERATOR','MONITOR','FIELD','MERCHANT') not null, \`merchant_id\` int unsigned null, \`disabled_at\` datetime null, \`last_login_at\` datetime null, \`created_at\` datetime not null, \`updated_at\` datetime not null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`user_account\` add unique \`user_account_login_id_unique\` (\`login_id\`);`);
    this.addSql(`alter table \`user_account\` add index \`user_account_merchant_id_index\` (\`merchant_id\`);`);

    this.addSql(`alter table \`user_account\` add constraint \`user_account_merchant_id_foreign\` foreign key (\`merchant_id\`) references \`merchant\` (\`id\`) on delete set null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`user_account\`;`);
  }

}
```

`.snapshot-terminal_ops.json`에 `user_account` 테이블이 더해진다(같이 커밋). 다르면 엔티티를 다시 보고, 같아질 때까지 파일을 지우고 다시 만든다. 개발 DB 적용(`db:migrate`)은 Task 7에서 한 번에 한다.

- [ ] **Step 9: 전체 api 테스트(선택이 아니라 필수 — 엔티티 추가는 모든 테스트의 `schema.refresh`에 닿는다)**

Run(`apps/api`): `npx vitest run 2>&1 | tail -5`
Expected: `Test Files  68 passed (68)`, `Tests  461 passed (461)`.

- [ ] **Step 10: 결정 기록 0051**

`docs/decisions/0051-비밀번호-해시는-node-scrypt-계정-테이블은-user-account.md`:

````markdown
# 0051. 비밀번호 해시는 node:crypto scrypt, 계정 테이블은 user_account

- 날짜 / 관련 기능: 2026-10-28 / 보강 2(로그인), decisions/0050·0052
- 상황: 사람 로그인을 위해 계정과 비밀번호를 저장해야 한다. 역할은 다섯(ADMIN·OPERATOR·MONITOR·FIELD·MERCHANT)이고 가맹점주는 가맹점 하나에 묶인다. 학습·로컬 시연용이지만 비밀번호 원문이나 빠른 해시(SHA-256 등)로 두지는 않는다.
- 선택지(해시):
  1. `bcrypt` 패키지 — 장점: 널리 쓰임. 단점: 네이티브 빌드(Windows node-gyp), 72바이트 넘는 비밀번호를 잘라 쓴다, 새 의존성
  2. `bcryptjs` — 장점: 순수 JS. 단점: 같은 비용에서 느리고 해시 계산이 이벤트 루프를 붙잡는다, 새 의존성
  3. `argon2` 패키지(argon2id) — 장점: OWASP 첫 권고. 단점: 네이티브 바이너리 의존성, 이 프로젝트의 "새 의존성 없이" 흐름(보강 1)과 맞지 않음
  4. **node:crypto `scrypt`** — 장점: 의존성 0, libuv 스레드풀에서 돌아 이벤트 루프를 막지 않는다, OWASP 비밀번호 저장 권고표에 scrypt 비용 조합이 있다. 단점: argon2id보다 한 단계 아래 권고, 비용 매개변수를 직접 관리
- 측정(이 PC, `crypto.scryptSync` 5회 평균): N=2^14·r=8·p=1 26ms, N=2^15·p=1 51ms, **N=2^15·p=3 142ms**, N=2^16·p=1 109ms. N=2^15는 메모리 128·N·r = 32MiB로 node 기본 `maxmem`(32MiB) 경계라 `maxmem` 64MiB를 준다.
- 결정: 4. N=2^15·r=8·p=3(OWASP 표의 한 줄), 소금 16바이트, 키 64바이트. 저장 형식 `scrypt$N$r$p$salt$hash`(base64) — 비용을 올려도 옛 해시를 그 값으로 확인한다. 비교는 `timingSafeEqual`. 없는 아이디로 로그인해도 가짜 해시 하나만큼 시간을 쓴다(응답 시간으로 아이디 유무를 알아내지 못하게).
- 선택지(테이블 이름): `operator_account`(가맹점주도 들어가 이름이 틀린다), `account`(너무 넓다), `user`(다른 DB에서 예약어) → **`user_account`**. 열: `login_id`(unique, 영문 소문자·숫자·`.`·`-`·`_` 3~50자 — 이력 actor로 남으므로 바꾸지 않는다), `display_name`, `password_hash`, `role`(enum), `merchant_id`(FK, nullable), `disabled_at`, `last_login_at`, 시각들.
- "MERCHANT ⇔ 가맹점 있음"은 서비스(AccountService, Task 5)가 지킨다. DB CHECK 제약은 두지 않았다 — 테스트의 `schema.refresh`(엔티티 기준)와 마이그레이션 두 곳에 같은 제약을 손으로 맞춰야 한다.
- 시연 계정: 역할마다 하나 + 가맹점주는 시드 가맹점 세 곳에 하나씩, 모두 7개. 비밀번호는 `src/db/seed-accounts.ts`에 고정한 테스트 값(README "로컬 시연 전용 값"). 테스트(`resetDatabase`)는 이 계정을 넣지 않는다 — 해시 7번(약 1초)을 파일마다 쓰지 않게, 필요한 테스트가 직접 만든다.
- 결과·대가: 로그인 한 번에 약 140ms·32MiB. 동시 로그인이 libuv 스레드풀(기본 4)을 다투면 줄을 선다 — 로그인 실패 제한(0050)이 무차별 대입은 막는다. 저장소에 공개된 시연 비밀번호는 로컬 시연 밖에서 쓰면 안 된다.
- 다시 볼 조건: 실제 서비스로 내보낼 때(argon2id, 비밀번호 정책, 재해시), 동시 로그인이 많아질 때(`UV_THREADPOOL_SIZE`), 계정 행을 손으로 고치는 일이 생기면(DB CHECK).
````

- [ ] **Step 11: 트러블슈팅 기록 0030(사전 검증에서 만난 것)**

`docs/troubleshooting/0030-다른-브랜치가-쓴-테스트-DB에서-schema-refresh가-merchant를-못-지운다.md`:

````markdown
# 0030. 다른 브랜치가 쓴 테스트 DB에서 schema.refresh가 merchant를 못 지운다

- 날짜 / 관련 기능: 2026-10-28 / 보강 2(user_account), 테스트 도구
- 증상: 보강 2 계획 사전 검증에서 `auth-roles`(Task 2까지)로 api 테스트를 돌린 뒤, 같은 테스트 DB로 master(7487fe4)의 실험 0008을 돌리자 `resetDatabase`에서 멈췄다:
  ```
  DriverException: Cannot drop table 'merchant' referenced by a foreign key constraint 'user_account_merchant_id_foreign' on table 'user_account'.
   ❯ SqlSchemaGenerator.drop node_modules/@mikro-orm/sql/schema/SqlSchemaGenerator.js:117:9
   ❯ SqlSchemaGenerator.refresh node_modules/@mikro-orm/core/utils/AbstractSchemaGenerator.js:35:13
   ❯ resetDatabase test/helpers/test-app.ts:36:3
  ```
  `Tests  5 skipped (5)`(beforeAll에서 실패).
- 가설: 1) `merchant` 테이블에 데이터가 남아 지우지 못한다 2) `schema.refresh`는 지금 코드의 엔티티가 아는 테이블만 지우고, 모르는 `user_account`의 FK가 `merchant`를 붙잡는다
- 확인: master 코드의 `ENTITIES`에는 `UserAccount`가 없다(보강 2에서 더함). 오류는 데이터가 아니라 FK 제약 이름(`user_account_merchant_id_foreign`)을 말한다 → 가설 1 기각, 2 확인. 테스트 DB를 지우고 다시 만든 뒤(`DROP DATABASE IF EXISTS terminal_ops_test; CREATE DATABASE terminal_ops_test`) 같은 명령이 통과했다(`Tests  2 passed | 3 skipped (5)`).
- 원인: `orm.schema.refresh()`는 메타데이터(엔티티 목록) 기준으로 drop → create 한다. 다른 브랜치가 만든 테이블은 모르니 지우지 않고, 그 테이블의 FK가 아는 테이블(`merchant`)의 drop을 막는다.
- 해결: 브랜치를 오가며 테스트할 때는 먼저 테스트 DB를 다시 만든다(계획 안전 규칙의 명령). 코드는 바꾸지 않았다 — `resetDatabase`가 DB 전체를 지우게 하면 테스트 DB 이름 확인 말고 안전장치가 하나 더 줄어든다.
- 배운 것: → study/backlog.md "MikroORM schema.refresh는 메타데이터에 있는 테이블만 다룬다"
````

`docs/study/backlog.md` 끝에 한 줄:

```markdown
- [ ] MikroORM `schema.refresh()`는 메타데이터에 있는 테이블만 지운다 — 다른 브랜치가 만든 테이블의 FK가 drop을 막는다 (troubleshooting/0030)
```

- [ ] **Step 12: 색인과 devlog**

Run(저장소 루트): `node scripts/docs-index.mjs && node scripts/docs-index.mjs --check`
Expected: 두 번째 명령이 최신이라고 말하고 exit 0.

`docs/devlog/2026-10-28.md`에 덧붙인다(시각은 Step 14에서 맞춘다):

```markdown
## HH:MM Task 1 계정 테이블과 비밀번호 해시 (커밋 <해시>)
- 이전 커밋: <계획 커밋 해시>
- 한 일: contracts `auth.ts`(역할·로그인·계정·키 타입, AuthErrorCode), `user_account` 엔티티·마이그레이션, scrypt 해시(N=2^15·r=8·p=3), 시연 계정 7개 시드(`seed-accounts.ts`, 테스트 값), Role enum ↔ 계약 단언
- 확인: 새 테스트 2파일 8개, api 전체 68/461(Duration …s), typecheck 0, 마이그레이션 SQL이 계획과 같음
- 커밋 규칙(보강 2): 인증은 기능 ID가 없어 `type(auth): …`, 기존 기능을 같이 바꾸면 그 ID를 붙인다(`auth, F8` 등)
- 결정: decisions/0051(scrypt, user_account). 트러블슈팅: 0030(사전 검증에서 만난 테스트 DB FK — 이번 실행에서 만났으면 그 출력도)
- 막힌 것: 없음(있으면 적는다)
- 다음: Task 2 세션·가드·역할 표
```

- [ ] **Step 13: 커밋**

```bash
git add packages/contracts apps/api/src apps/api/test docs
git status --short
git commit -m "feat(auth): 계정 테이블과 비밀번호 해시 — user_account, scrypt, 시연 계정 시드, 로그인 계약 타입

Refs: docs/decisions/0051-비밀번호-해시는-node-scrypt-계정-테이블은-user-account.md, docs/troubleshooting/0030-다른-브랜치가-쓴-테스트-DB에서-schema-refresh가-merchant를-못-지운다.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 14: devlog 제목 시각을 커밋 시각과 맞춘다**

Run: `git log -1 --format='%h %ad' --date=format:'%H:%M'` → devlog 제목의 `HH:MM`과 `<해시>`를 그 값으로 고치고 `git add docs/devlog && git commit --amend --no-edit`. 고친 뒤 `git log -1 --format=%ad --date=format:%H:%M`이 제목과 같은지 다시 본다(amend는 시각을 바꾸지 않는다 — 같으면 끝).

### Task 2: 세션·로그인 API·전역 가드(기본 거부)·역할 표·작업자 = 로그인 아이디

**Files:**
- Create: `apps/api/src/config/auth-test-headers.ts`, `apps/api/src/auth/{access,principal,cookies,session.store,auth.service,auth.controller,auth.guard,auth.module}.ts`, `apps/api/src/auth/dto/login.dto.ts`
- Modify: `apps/api/src/config/env.ts`, `apps/api/src/common/operator.decorator.ts`(전체 바꿈), `apps/api/src/app.module.ts`, 기존 컨트롤러 18개(아래 Step 8. 정정: 처음 '20개'로 적었다)
- Modify(테스트 도구): `apps/api/vitest.config.ts`, `apps/api/test/helpers/test-app.ts`; Create `apps/api/test/helpers/auth.ts`
- Test: Create `apps/api/test/unit/auth-guard.spec.ts`, `apps/api/test/unit/access-table.spec.ts`, `apps/api/test/auth.e2e.spec.ts`; Modify `apps/api/test/{terminal,firmware-rollout,purchase-order,van-collect}.e2e.spec.ts`
- Docs: `docs/decisions/0050-로그인은-Redis-서버-세션과-httpOnly-쿠키로.md`, `docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md`, `docs/decisions/0056-작업자는-로그인-아이디-X-Operator는-테스트-전용.md`, `docs/index.md`, `docs/devlog/2026-10-28.md`, `docs/study/backlog.md`

- [ ] **Step 1: 테스트 도구를 먼저 바꾼다(기존 테스트가 쓸 기본 사람)**

`apps/api/vitest.config.ts`:

```diff
--- a/apps/api/vitest.config.ts
+++ b/apps/api/vitest.config.ts
@@ -20,6 +20,8 @@ export default defineConfig({
       NODE_ENV: 'test',
       PARTNERS_URL: TEST_PARTNERS_URL,
       RUN_SCHEDULERS: '0',
+      // 테스트 전용 인증 헤더(X-Operator·X-Test-Role, decisions/0056). NODE_ENV=test일 때만 켜진다
+      AUTH_TEST_HEADERS: '1',
     },
   },
   // swc가 데코레이터 메타데이터를 만들어야 Nest DI가 동작한다.
```

`apps/api/test/helpers/test-app.ts`(전체):

```ts
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/mysql';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { seedReference } from '../../src/db/seed-reference.js';

/**
 * 테스트 전용 인증 헤더(decisions/0056, vitest.config.ts의 AUTH_TEST_HEADERS=1). `X-Operator`가 로그인 아이디, `X-Test-Role`이 역할(없으면 OPERATOR).
 * 기존 테스트가 `.set({ 'X-Operator': 'kim' })`으로 덮어쓰면 그 이름의 운영자가 된다. MERCHANT는 이 길로 만들 수 없다(실제 로그인 — test/helpers/auth.ts).
 */
export type TestIdentity = { 'X-Operator': string; 'X-Test-Role'?: string };

/** 기본 사람: tester(OPERATOR) — 지금까지 모든 테스트가 쓰던 권한(어드민의 모든 쓰기) */
export const DEFAULT_IDENTITY: TestIdentity = { 'X-Operator': 'tester' };

export interface TestApp {
  app: INestApplication;
  orm: MikroORM;
  /**
   * supertest 에이전트. 기본으로 DEFAULT_IDENTITY 헤더를 붙인다. `http(null)`은 아무 헤더도 붙이지 않는다(로그인 안 한 요청, 쿠키 로그인).
   * 에이전트는 부를 때마다 새로 만든다 — 쿠키가 다음 요청으로 새지 않는다.
   */
  http: (identity?: TestIdentity | null) => ReturnType<typeof request>;
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
  const http = (identity: TestIdentity | null = DEFAULT_IDENTITY) => {
    const agent = request.agent(app.getHttpServer());
    if (identity) agent.set(identity);
    return agent;
  };
  return { app, orm, http };
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

`apps/api/test/helpers/auth.ts`(새 파일 — 실제 쿠키 로그인을 쓰는 테스트용):

```ts
import { expect } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import type { Role } from '../../src/auth/role.js';
import { UserAccount } from '../../src/auth/user-account.entity.js';
import { Merchant } from '../../src/merchant/merchant.entity.js';
import type { TestApp } from './test-app.js';

/** 테스트 계정의 비밀번호(테스트 DB 전용 값) */
export const TEST_PASSWORD = 'test-password-1234';

/** 계정 행을 바로 만든다(ADMIN API를 거치지 않는 준비용). merchantCode는 MERCHANT일 때 */
export async function createAccount(t: TestApp, loginId: string, role: Role | `${Role}`, merchantCode?: string): Promise<UserAccount> {
  const em = t.orm.em.fork();
  const merchant = merchantCode ? await em.findOneOrFail(Merchant, { code: merchantCode }) : null;
  const account = em.create(UserAccount, {
    loginId,
    displayName: `${loginId} 이름`,
    role: role as Role,
    merchant,
    passwordHash: await hashPassword(TEST_PASSWORD),
  });
  await em.flush();
  return account;
}

/** 실제 로그인(POST /auth/login)으로 세션 쿠키(`sid=…`)를 받는다 */
export async function login(t: TestApp, loginId: string, password = TEST_PASSWORD): Promise<string> {
  const res = await t.http(null).post('/auth/login').send({ loginId, password });
  expect(res.status).toBe(200);
  const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('sid='));
  expect(cookie).toBeDefined();
  return cookie!.split(';')[0];
}

/** 세션 쿠키만 붙인 요청(테스트 헤더 없음) */
export function withCookie(t: TestApp, cookie: string) {
  return t.http(null).set('Cookie', cookie);
}
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`apps/api/test/unit/auth-guard.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { testPrincipal } from '../../src/auth/auth.guard.js';
import { readCookie } from '../../src/auth/cookies.js';
import { resolveAuthTestHeaders } from '../../src/config/auth-test-headers.js';

describe('테스트 전용 인증 헤더 스위치 (decisions/0056)', () => {
  it('켜지 않으면 false', () => {
    expect(resolveAuthTestHeaders(undefined, 'test')).toBe(false);
    expect(resolveAuthTestHeaders('0', 'production')).toBe(false);
  });

  it('NODE_ENV=test에서만 켤 수 있다 — 아니면 던진다(서버가 뜨지 않는다)', () => {
    expect(resolveAuthTestHeaders('1', 'test')).toBe(true);
    expect(resolveAuthTestHeaders('true', 'test')).toBe(true);
    expect(() => resolveAuthTestHeaders('1', 'production')).toThrow(/테스트\(NODE_ENV=test\)에서만/);
    expect(() => resolveAuthTestHeaders('1', undefined)).toThrow(/테스트\(NODE_ENV=test\)에서만/);
  });
});

describe('테스트 전용 헤더의 사람', () => {
  it('X-Operator가 로그인 아이디, 역할 기본은 OPERATOR. 한글은 URL 인코딩', () => {
    expect(testPrincipal('kim', undefined)).toEqual({ accountId: null, loginId: 'kim', displayName: 'kim', role: 'OPERATOR', merchantId: null, merchantCode: null });
    expect(testPrincipal(encodeURIComponent('김운영'), 'FIELD')).toMatchObject({ loginId: '김운영', role: 'FIELD' });
  });

  it('이름 규칙(1~50자, system: 금지)과 역할(MERCHANT·모르는 값 거절)을 어기면 null', () => {
    for (const [name, role] of [
      [undefined, undefined],
      ['', undefined],
      ['x'.repeat(51), undefined],
      ['system:batch', undefined],
      ['%E0%A4%A', undefined],
      ['kim', 'MERCHANT'],
      ['kim', 'ROOT'],
    ] as const) {
      expect(testPrincipal(name, role)).toBeNull();
    }
  });
});

describe('쿠키 읽기', () => {
  it('이름이 정확히 같은 것의 값, 없으면 null', () => {
    expect(readCookie('a=1; sid=abc; b=2', 'sid')).toBe('abc');
    expect(readCookie('xsid=nope; sid=yes', 'sid')).toBe('yes');
    expect(readCookie('sid=', 'sid')).toBeNull();
    expect(readCookie(undefined, 'sid')).toBeNull();
    expect(readCookie('other=1', 'sid')).toBeNull();
  });
});
```

`apps/api/test/unit/access-table.spec.ts`(엔드포인트 접근 표 — decisions/0052의 표와 같은 내용):

```ts
import 'reflect-metadata';
import { RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { ACCESS_KEY, type Access } from '../../src/auth/access.js';

/**
 * 엔드포인트별 접근 규칙 표(decisions/0052). 앱의 모든 컨트롤러 핸들러를 모듈 메타데이터로 훑어 실제 규칙과 이 표를 맞춘다.
 * - 새 엔드포인트에 @Public/@Roles/@DeviceAuth를 달지 않으면 "규칙 없음"으로 실패한다(가드는 403으로 막는다 — 기본 거부).
 * - 규칙을 바꾸면(역할을 더하거나 빼면) 이 표도 같이 바꿔야 통과한다 — 권한 변경이 리뷰에서 보이게.
 * 값: 'public' | 'device' | 역할을 쉼표로(알파벳 순).
 */
const EXPECTED: Record<string, string> = {
  'GET /health': 'public',
  'POST /auth/login': 'public',
  'POST /auth/logout': 'ADMIN,FIELD,MERCHANT,MONITOR,OPERATOR',
  'GET /auth/me': 'ADMIN,FIELD,MERCHANT,MONITOR,OPERATOR',

  'POST /devices/heartbeats': 'device',
  'POST /devices/firmware-reports': 'device',

  'GET /terminals': 'ADMIN,FIELD,MONITOR,OPERATOR',
  'GET /terminals/:serialNo': 'ADMIN,FIELD,MONITOR,OPERATOR',
  'GET /terminals/:serialNo/history': 'ADMIN,FIELD,MONITOR,OPERATOR',
  'GET /terminals/:serialNo/inspections': 'ADMIN,FIELD,MONITOR,OPERATOR',
  'GET /terminal-models': 'ADMIN,FIELD,MONITOR,OPERATOR',
  'GET /inspection-items': 'ADMIN,FIELD,MONITOR,OPERATOR',
  'GET /purchase-orders': 'ADMIN,FIELD,MONITOR,OPERATOR',
  'GET /purchase-orders/:poNo': 'ADMIN,FIELD,MONITOR,OPERATOR',
  'GET /scans/:scanId': 'ADMIN,FIELD,MONITOR,OPERATOR',

  'GET /terminals/:serialNo/connectivity': 'ADMIN,MONITOR,OPERATOR',
  'GET /merchants': 'ADMIN,MONITOR,OPERATOR',
  'GET /inspections/stats': 'ADMIN,MONITOR,OPERATOR',
  'GET /purchase-orders/:poNo/reconciliation': 'ADMIN,MONITOR,OPERATOR',
  'GET /shipments/:id': 'ADMIN,MONITOR,OPERATOR',
  'GET /sync-runs': 'ADMIN,MONITOR,OPERATOR',
  'GET /service-tickets': 'ADMIN,MONITOR,OPERATOR',
  'GET /service-tickets/:id': 'ADMIN,MONITOR,OPERATOR',
  'GET /firmware-rollouts': 'ADMIN,MONITOR,OPERATOR',
  'GET /firmware-rollouts/:id': 'ADMIN,MONITOR,OPERATOR',
  'GET /anomaly-rules': 'ADMIN,MONITOR,OPERATOR',
  'GET /anomalies': 'ADMIN,MONITOR,OPERATOR',
  'GET /van-reconciliations': 'ADMIN,MONITOR,OPERATOR',
  'GET /van-reconciliations/:id': 'ADMIN,MONITOR,OPERATOR',
  'GET /reports/weekly': 'ADMIN,MONITOR,OPERATOR',
  'GET /reports/weekly/:weekStart': 'ADMIN,MONITOR,OPERATOR',
  'GET /reports/weekly/:weekStart/file': 'ADMIN,MONITOR,OPERATOR',
  'GET /dashboard/summary': 'ADMIN,MONITOR,OPERATOR',

  'POST /anomaly-scans': 'MONITOR,OPERATOR',
  'POST /van-reconciliations': 'MONITOR,OPERATOR',
  'POST /reports/weekly': 'MONITOR,OPERATOR',

  'POST /scans': 'FIELD,OPERATOR',
  'POST /terminals/:serialNo/inspections': 'FIELD,OPERATOR',

  'POST /terminals': 'OPERATOR',
  'POST /terminals/imports': 'OPERATOR',
  'POST /terminals/:serialNo/transitions': 'OPERATOR',
  'POST /terminals/:serialNo/allocations': 'OPERATOR',
  'POST /terminals/:serialNo/allocation-cancellations': 'OPERATOR',
  'POST /shipments': 'OPERATOR',
  'POST /purchase-orders': 'OPERATOR',
  'POST /purchase-orders/:poNo/close': 'OPERATOR',
  'POST /service-tickets': 'OPERATOR',
  'POST /service-tickets/:id/remote-checks': 'OPERATOR',
  'POST /service-tickets/:id/replacements': 'OPERATOR',
  'POST /service-tickets/:id/installations': 'OPERATOR',
  'POST /firmware': 'OPERATOR',
  'POST /firmware-rollouts': 'OPERATOR',
  'POST /firmware-rollouts/:id/pause': 'OPERATOR',
  'POST /firmware-rollouts/:id/resume': 'OPERATOR',
  'POST /firmware-rollouts/:id/abort': 'OPERATOR',
};

type ModuleLike = Type<unknown> | { module: Type<unknown>; imports?: unknown[]; controllers?: Type<unknown>[] };

/** 모듈 트리를 훑어 컨트롤러를 모은다(정적 @Module 메타데이터 + forRoot 같은 동적 모듈) */
function collectControllers(root: ModuleLike, seen = new Set<unknown>(), out = new Set<Type<unknown>>()): Set<Type<unknown>> {
  if (!root || seen.has(root)) return out;
  seen.add(root);
  const isDynamic = typeof root === 'object' && 'module' in root;
  const cls = isDynamic ? root.module : root;
  const imports = [...((Reflect.getMetadata(MODULE_METADATA.IMPORTS, cls) as ModuleLike[] | undefined) ?? []), ...(((isDynamic ? root.imports : undefined) ?? []) as ModuleLike[])];
  const controllers = [...((Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, cls) as Type<unknown>[] | undefined) ?? []), ...((isDynamic ? root.controllers : undefined) ?? [])];
  controllers.forEach((c) => out.add(c));
  for (const imported of imports) collectControllers(imported, seen, out);
  return out;
}

const join = (...parts: string[]) => `/${parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;

/** 'GET /terminals/:serialNo' → 규칙 문자열(없으면 null) */
function routeTable(): Map<string, string | null> {
  const table = new Map<string, string | null>();
  const controllers = collectControllers(AppModule.forRoot({ workers: true, schedulers: true }));
  for (const controller of controllers) {
    const base = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '/';
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = controller.prototype[name] as unknown;
      if (typeof handler !== 'function' || name === 'constructor') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const path = (Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? '/';
      const key = `${RequestMethod[method]} ${join(base, path)}`;
      const access = Reflect.getMetadata(ACCESS_KEY, handler) as Access | undefined;
      table.set(key, !access ? null : access.kind === 'roles' ? [...access.roles].sort().join(',') : access.kind);
    }
  }
  return table;
}

describe('엔드포인트 접근 규칙 표 (decisions/0052)', () => {
  const actual = routeTable();

  it('모든 핸들러에 접근 규칙이 있다(없으면 기본 거부 403 — 달아야 한다)', () => {
    const missing = [...actual].filter(([, rule]) => rule === null).map(([key]) => key);
    expect(missing).toEqual([]);
  });

  it('실제 규칙이 결정 기록의 표와 같다(엔드포인트가 새로 생기거나 역할이 바뀌면 표도 바꾼다)', () => {
    expect(Object.fromEntries([...actual].sort(([a], [b]) => a.localeCompare(b)))).toEqual(
      Object.fromEntries(Object.entries(EXPECTED).sort(([a], [b]) => a.localeCompare(b))),
    );
  });

  it('훑기가 실제로 컨트롤러를 찾는다(표가 비어 통과하지 않게)', () => {
    expect(actual.size).toBe(Object.keys(EXPECTED).length);
    expect(actual.size).toBeGreaterThan(50);
  });
});
```

`apps/api/test/auth.e2e.spec.ts`:

```ts
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/auth/session.store.js';
import { UserAccount } from '../src/auth/user-account.entity.js';
import { env } from '../src/config/env.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { createAccount, login, TEST_PASSWORD, withCookie } from './helpers/auth.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('로그인·세션·역할 (보강 2, decisions/0050·0052·0056)', () => {
  let t: TestApp;
  let redis: Redis;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    redis = t.app.get(REDIS);
    await deleteTestKeys(redis);
    await createAccount(t, 'op1', 'OPERATOR');
    await createAccount(t, 'mon1', 'MONITOR');
    await createAccount(t, 'field1', 'FIELD');
    await createAccount(t, 'admin1', 'ADMIN');
  });
  afterAll(async () => {
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('로그인하면 200 내 정보와 httpOnly·SameSite=Strict 세션 쿠키. 토큰은 응답 본문에 없다', async () => {
    const res = await t.http(null).post('/auth/login').send({ loginId: 'op1', password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ loginId: 'op1', displayName: 'op1 이름', role: 'OPERATOR', merchantCode: null });
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0];
    expect(cookie).toMatch(/^sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);
    const me = await withCookie(t, cookie.split(';')[0]).get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.loginId).toBe('op1');
    const account = await t.orm.em.fork().findOneOrFail(UserAccount, { loginId: 'op1' });
    expect(account.lastLoginAt).not.toBeNull();
  });

  it('Redis에는 토큰이 아니라 토큰의 SHA-256이 키로, 유휴 TTL과 함께 남는다', async () => {
    const cookie = await login(t, 'op1');
    const keys = await redis.keys(`${env.queuePrefix}:sess:*`);
    const token = cookie.slice('sid='.length);
    expect(keys.some((k) => k.endsWith(token))).toBe(false);
    expect(keys.every((k) => /:sess:[0-9a-f]{64}$/.test(k))).toBe(true);
    const ttl = await redis.pttl(keys[0]);
    expect(ttl).toBeGreaterThan(env.sessionIdleTtlMs - 60_000);
    expect(ttl).toBeLessThanOrEqual(env.sessionIdleTtlMs);
  });

  it('비밀번호가 틀리거나 없는 아이디면 같은 401 LOGIN_FAILED', async () => {
    const wrong = await t.http(null).post('/auth/login').send({ loginId: 'mon1', password: 'nope-nope-nope' });
    const unknown = await t.http(null).post('/auth/login').send({ loginId: 'ghost', password: 'nope-nope-nope' });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.code).toBe('LOGIN_FAILED');
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('로그인 없이(쿠키·테스트 헤더 없음) 부르면 401 UNAUTHENTICATED, health는 열려 있다', async () => {
    const res = await t.http(null).get('/terminals');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });
    expect((await t.http(null).get('/health')).status).toBe(200);
  });

  it('역할 밖이면 403 FORBIDDEN — 관제(MONITOR)는 읽기와 관제 작업만, 업무 쓰기는 못 한다', async () => {
    const mon = await login(t, 'mon1');
    expect((await withCookie(t, mon).get('/terminals')).status).toBe(200);
    expect((await withCookie(t, mon).get('/dashboard/summary')).status).toBe(200);
    const write = await withCookie(t, mon).post('/terminals').send({ serialNo: 'AU-0001', modelCode: 'SN-100' });
    expect(write.status).toBe(403);
    expect(write.body).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect((await withCookie(t, mon).post('/anomaly-scans')).status).toBe(200);
  });

  it('현장 작업자(FIELD)는 단말기 조회는 되고 운영 현황·업무 쓰기는 403', async () => {
    const field = await login(t, 'field1');
    expect((await withCookie(t, field).get('/terminals')).status).toBe(200);
    expect((await withCookie(t, field).get('/dashboard/summary')).status).toBe(403);
    expect((await withCookie(t, field).post('/terminals').send({ serialNo: 'AU-0002', modelCode: 'SN-100' })).status).toBe(403);
  });

  it('관리자(ADMIN)도 업무 쓰기는 못 한다(계정·키 관리 역할)', async () => {
    const admin = await login(t, 'admin1');
    expect((await withCookie(t, admin).get('/terminals')).status).toBe(200);
    expect((await withCookie(t, admin).post('/terminals').send({ serialNo: 'AU-0003', modelCode: 'SN-100' })).status).toBe(403);
  });

  it('이력의 작업자(actor)는 로그인 아이디다', async () => {
    const op = await login(t, 'op1');
    expect((await withCookie(t, op).post('/terminals').send({ serialNo: 'AU-0004', modelCode: 'SN-100' })).status).toBe(201);
    const history = await withCookie(t, op).get('/terminals/AU-0004/history');
    expect(history.body[0]).toMatchObject({ actor: 'op1', source: 'MANUAL' });
  });

  it('쿠키가 있으면 쿠키만 본다 — 끝난 세션 쿠키에 테스트 헤더를 붙여도 401', async () => {
    const res = await t.http(null).get('/terminals').set('Cookie', 'sid=not-a-real-session').set('X-Operator', 'kim');
    expect(res.status).toBe(401);
  });

  it('로그아웃하면 204, 쿠키를 지우고 그 세션은 더 쓸 수 없다', async () => {
    const op = await login(t, 'op1');
    const out = await withCookie(t, op).post('/auth/logout');
    expect(out.status).toBe(204);
    expect(([] as string[]).concat(out.headers['set-cookie'] ?? [])[0]).toMatch(/^sid=; Path=\/; Expires=Thu, 01 Jan 1970/);
    expect((await withCookie(t, op).get('/auth/me')).status).toBe(401);
  });

  it('계정의 세션을 모두 끊으면(역할 변경 등) 그 계정의 쿠키는 모두 401, 다른 계정은 그대로', async () => {
    const a = await login(t, 'op1');
    const b = await login(t, 'op1');
    const other = await login(t, 'mon1');
    const account = await t.orm.em.fork().findOneOrFail(UserAccount, { loginId: 'op1' });
    expect(await t.app.get(SessionStore).destroyAllFor(account.id)).toBeGreaterThanOrEqual(2);
    expect((await withCookie(t, a).get('/auth/me')).status).toBe(401);
    expect((await withCookie(t, b).get('/auth/me')).status).toBe(401);
    expect((await withCookie(t, other).get('/auth/me')).status).toBe(200);
  });

  it('사용 중지 계정은 맞는 비밀번호여도 401 LOGIN_FAILED', async () => {
    await createAccount(t, 'gone1', 'OPERATOR');
    await t.orm.em.fork().nativeUpdate(UserAccount, { loginId: 'gone1' }, { disabledAt: new Date() });
    const res = await t.http(null).post('/auth/login').send({ loginId: 'gone1', password: TEST_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('LOGIN_FAILED');
  });

  it(`같은 아이디로 ${env.loginMaxFailures}번 틀리면 맞는 비밀번호도 429 LOGIN_LOCKED, 다른 아이디는 영향 없음`, async () => {
    await createAccount(t, 'lock1', 'OPERATOR');
    for (let i = 0; i < env.loginMaxFailures; i++) {
      expect((await t.http(null).post('/auth/login').send({ loginId: 'lock1', password: 'wrong-wrong' })).status).toBe(401);
    }
    const locked = await t.http(null).post('/auth/login').send({ loginId: 'LOCK1', password: TEST_PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('LOGIN_LOCKED');
    const ttl = await redis.pttl(`${env.queuePrefix}:login-fail:lock1`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(env.loginLockMs);
    expect((await t.http(null).post('/auth/login').send({ loginId: 'op1', password: TEST_PASSWORD })).status).toBe(200);
  });

  it('테스트 전용 헤더: X-Test-Role로 역할을 바꾸고, MERCHANT·모르는 역할은 401', async () => {
    expect((await t.http({ 'X-Operator': 'm1', 'X-Test-Role': 'MONITOR' }).post('/terminals').send({ serialNo: 'AU-0005', modelCode: 'SN-100' })).status).toBe(403);
    expect((await t.http({ 'X-Operator': 'm1', 'X-Test-Role': 'MERCHANT' }).get('/auth/me')).status).toBe(401);
    expect((await t.http({ 'X-Operator': 'm1', 'X-Test-Role': 'ROOT' }).get('/auth/me')).status).toBe(401);
    expect((await t.http().get('/auth/me')).body).toEqual({ loginId: 'tester', displayName: 'tester', role: 'OPERATOR', merchantCode: null });
  });
});
```

"작업자 헤더가 없으면 400"을 보던 기존 테스트 다섯 줄을 401로(로그인 없음):

```diff
--- a/apps/api/test/terminal.e2e.spec.ts
+++ b/apps/api/test/terminal.e2e.spec.ts
@@ -50,14 +50,15 @@ describe('단말기 등록·조회 (F1)', () => {
     expect(history.body[0].actor).toBe('김운영');
   });
 
-  it('X-Operator가 없으면 400', async () => {
-    const res = await t.http().post('/terminals').send({ serialNo: 'T-0003', modelCode: 'SN-100' });
-    expect(res.status).toBe(400);
+  it('로그인(세션·테스트 헤더)이 없으면 401 UNAUTHENTICATED (보강 2 — 전에는 X-Operator가 없으면 400)', async () => {
+    const res = await t.http(null).post('/terminals').send({ serialNo: 'T-0003', modelCode: 'SN-100' });
+    expect(res.status).toBe(401);
+    expect(res.body.code).toBe('UNAUTHENTICATED');
   });
 
-  it('system: 으로 시작하는 작업자는 사람이 쓸 수 없다', async () => {
-    const res = await t.http().post('/terminals').set({ 'X-Operator': 'system:batch' }).send({ serialNo: 'T-0003', modelCode: 'SN-100' });
-    expect(res.status).toBe(400);
+  it('system: 으로 시작하는 작업자는 사람이 쓸 수 없다(테스트 헤더로도 401)', async () => {
+    const res = await t.http(null).post('/terminals').set({ 'X-Operator': 'system:batch' }).send({ serialNo: 'T-0003', modelCode: 'SN-100' });
+    expect(res.status).toBe(401);
   });
 
   it('같은 시리얼을 다시 등록하면 409 DUPLICATE', async () => {
```

```diff
--- a/apps/api/test/firmware-rollout.e2e.spec.ts
+++ b/apps/api/test/firmware-rollout.e2e.spec.ts
@@ -44,13 +44,13 @@ describe('펌웨어 등록·단계 배포 시작·멈춤·재개·중단 (F8, de
     await t.app.close();
   });
 
-  it('펌웨어 등록: 201, 같은 (모델, 버전)은 409 DUPLICATE, 없는 모델 404, 작업자 헤더 필수', async () => {
+  it('펌웨어 등록: 201, 같은 (모델, 버전)은 409 DUPLICATE, 없는 모델 404, 로그인 필수(401)', async () => {
     const res = await t.http().post('/firmware').set(OP).send({ modelCode: 'SN-100', version: '2.0.0' });
     expect(res.status).toBe(201);
     expect(res.body).toMatchObject({ modelCode: 'SN-100', version: '2.0.0', createdBy: 'han' });
     expect((await t.http().post('/firmware').set(OP).send({ modelCode: 'SN-100', version: '2.0.0' })).body.code).toBe('DUPLICATE');
     expect((await t.http().post('/firmware').set(OP).send({ modelCode: 'NONE', version: '2.0.0' })).status).toBe(404);
-    expect((await t.http().post('/firmware').send({ modelCode: 'SN-100', version: '2.0.1' })).status).toBe(400);
+    expect((await t.http(null).post('/firmware').send({ modelCode: 'SN-100', version: '2.0.1' })).status).toBe(401);
     expect((await t.http().post('/firmware').set(OP).send({ modelCode: 'SN-200', version: '2.0.0' })).status).toBe(201);
   });
 
```

```diff
--- a/apps/api/test/purchase-order.e2e.spec.ts
+++ b/apps/api/test/purchase-order.e2e.spec.ts
@@ -69,10 +69,10 @@ describe('발주 (F10)', () => {
     }
   });
 
-  it('수량은 1~5000, 작업자 헤더 필수', async () => {
+  it('수량은 1~5000, 로그인 필수(401)', async () => {
     expect((await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-100', quantity: 0 })).status).toBe(400);
     expect((await t.http().post('/purchase-orders').set(OP).send({ modelCode: 'SN-100', quantity: 5001 })).status).toBe(400);
-    expect((await t.http().post('/purchase-orders').send({ modelCode: 'SN-100', quantity: 1 })).status).toBe(400);
+    expect((await t.http(null).post('/purchase-orders').send({ modelCode: 'SN-100', quantity: 1 })).status).toBe(401);
   });
 
   it('없는 발주번호는 404', async () => {
```

```diff
--- a/apps/api/test/van-collect.e2e.spec.ts
+++ b/apps/api/test/van-collect.e2e.spec.ts
@@ -186,7 +186,7 @@ describe('VAN 등록 대조 — 실행·커서 수집·스테이징 (F9)', () =>
     });
     expect(done).toMatchObject({ pages: 3, fetched: 1200, error: null });
     expect((await t.http().get('/van-reconciliations/999999')).status).toBe(404);
-    expect((await t.http().post('/van-reconciliations')).status).toBe(400); // 작업자 헤더 없음
+    expect((await t.http(null).post('/van-reconciliations')).status).toBe(401); // 로그인 없음(보강 2 — 전에는 작업자 헤더 없음 400)
 
     // 급감 확인 플래그(fix): 본문으로 받아 실행 행에 남긴다
     await partners.configure({ bridgevan: { delayMs: 0 } });
```

- [ ] **Step 3: 실패를 확인한다**

Run(`apps/api`): `npx vitest run test/unit/auth-guard.spec.ts test/unit/access-table.spec.ts test/auth.e2e.spec.ts`
Expected: 세 파일 FAIL — `../../src/auth/auth.guard.js`·`../../src/config/auth-test-headers.js`·`../../src/auth/access.js`·`../src/auth/session.store.js`를 찾지 못한다.

- [ ] **Step 4: 테스트 전용 인증 헤더 스위치와 env**

`apps/api/src/config/auth-test-headers.ts`:

```ts
/**
 * AUTH_TEST_HEADERS=1이면 AuthGuard가 세션 쿠키가 없는 요청을 `X-Operator`(로그인 아이디)·`X-Test-Role`(역할) 헤더로 받아 준다(decisions/0056).
 * 기존 api 테스트 453개가 로그인 없이 그대로 돌게 하는 **테스트 전용** 길이다. 누구나 헤더로 운영자가 될 수 있으므로
 * NODE_ENV=test가 아니면 켤 수 없다 — 켜려고 하면 env를 읽는 순간(서버 시작) 던진다.
 */
export function resolveAuthTestHeaders(raw: string | undefined, nodeEnv: string | undefined): boolean {
  if (raw !== '1' && raw !== 'true') return false;
  if (nodeEnv !== 'test') {
    throw new Error('AUTH_TEST_HEADERS는 테스트(NODE_ENV=test)에서만 켤 수 있습니다. 헤더만으로 누구나 로그인한 것처럼 됩니다(decisions/0056).');
  }
  return true;
}
```

`apps/api/src/config/env.ts`:

```diff
--- a/apps/api/src/config/env.ts
+++ b/apps/api/src/config/env.ts
@@ -3,6 +3,7 @@ import { resolve } from 'node:path';
 import { cronFromEnv } from './env-cron.js';
 import { DAY_MS, intFromEnv } from './env-number.js';
 import { resolveHeartbeatWriteMode } from './heartbeat-write-mode.js';
+import { resolveAuthTestHeaders } from './auth-test-headers.js';
 import { checkVanHeartbeatTiming } from '../van/van-limits.js';
 
 // 스크립트·테스트는 apps/api에서 실행한다. 저장소 루트의 .env를 읽는다(이미 있는 환경변수는 덮어쓰지 않는다).
@@ -134,6 +135,15 @@ export const env = {
   vanReconcileCron: cronFromEnv('VAN_RECONCILE_CRON', '0 3 * * *'),
   /** 주간 리포트(F11): 매주 월요일 09:00 KST에 지난주를 보낸다 */
   weeklyReportCron: cronFromEnv('WEEKLY_REPORT_CRON', '0 9 * * 1'),
+  /** 로그인 세션(Redis)이 쓰이지 않고 이만큼 지나면 끝난다. 요청마다 다시 늘린다(decisions/0050). 기본 8시간 */
+  sessionIdleTtlMs: intFromEnv('SESSION_IDLE_TTL_MS', 8 * 60 * 60_000, MS),
+  /** 세션 쿠키에 Secure를 붙일지. 로컬 http 시연은 0, https 뒤에 둘 때 1(decisions/0050) */
+  sessionCookieSecure: flag('SESSION_COOKIE_SECURE', false),
+  /** 같은 아이디로 로그인 실패가 이만큼 쌓이면 LOGIN_LOCK_MS 동안 막는다(첫 실패부터 잰다, decisions/0050) */
+  loginMaxFailures: intFromEnv('LOGIN_MAX_FAILURES', 5, { min: 1, max: 100 }),
+  loginLockMs: intFromEnv('LOGIN_LOCK_MS', 15 * 60_000, MS),
+  /** 테스트 전용 인증 헤더(X-Operator·X-Test-Role). NODE_ENV=test가 아니면 켜지지 않고 던진다(decisions/0056) */
+  authTestHeaders: resolveAuthTestHeaders(process.env.AUTH_TEST_HEADERS, process.env.NODE_ENV),
   /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
   workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
 };
```

- [ ] **Step 5: 접근 규칙 데코레이터·요청한 사람·쿠키**

`apps/api/src/auth/access.ts`:

```ts
import { SetMetadata } from '@nestjs/common';
import { Role } from './role.js';

/**
 * 엔드포인트마다 "누가 부를 수 있나"를 하나 단다(decisions/0052). AuthGuard가 읽고, 아무것도 없으면 403(기본 거부).
 * 핸들러(메서드)에만 단다 — 클래스에 달아 여러 메서드에 퍼지게 하지 않는다(표와 코드가 한 줄씩 맞게).
 * 빠뜨리면 test/unit/access-table.spec.ts가 실패한다.
 */
export type Access = { kind: 'public' } | { kind: 'roles'; roles: readonly Role[] } | { kind: 'device' };

export const ACCESS_KEY = 'terminal-ops:access';

/** 로그인 없이(health, 로그인 자체) */
export const Public = () => SetMetadata(ACCESS_KEY, { kind: 'public' } satisfies Access);

/** 로그인한 사람 중 이 역할만 */
export const Roles = (...roles: Role[]) => SetMetadata(ACCESS_KEY, { kind: 'roles', roles } satisfies Access);

/** 단말기(시뮬레이터)가 부르는 API — 단말기 키(decisions/0055) */
export const DeviceAuth = () => SetMetadata(ACCESS_KEY, { kind: 'device' } satisfies Access);

/** 사내 직원 전부(가맹점주 빼고). 단말기·검수·발주 조회처럼 현장 작업자도 보는 것 */
export const STAFF = [Role.ADMIN, Role.OPERATOR, Role.MONITOR, Role.FIELD] as const;
/** 사무실 조회(운영 현황·리포트·이력). 현장 작업자는 쓰지 않는다 */
export const OFFICE = [Role.ADMIN, Role.OPERATOR, Role.MONITOR] as const;
/** 로그인한 누구나(내 정보, 로그아웃) */
export const ANY_ROLE = [Role.ADMIN, Role.OPERATOR, Role.MONITOR, Role.FIELD, Role.MERCHANT] as const;
```

`apps/api/src/auth/principal.ts`:

```ts
import { createParamDecorator, type ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import type { MeView } from '@terminal-ops/contracts';
import type { Request } from 'express';
import type { Role } from './role.js';

/** 요청한 사람(로그인 세션, 또는 테스트 전용 헤더). AuthGuard가 `req.principal`에 넣는다 */
export interface Principal {
  /** 계정 id. 테스트 전용 헤더로 들어온 사람은 null(계정 행이 없다) */
  accountId: number | null;
  loginId: string;
  displayName: string;
  role: Role;
  /** MERCHANT만 값이 있다 — 범위 조건에 쓴다(decisions/0053) */
  merchantId: number | null;
  merchantCode: string | null;
}

export type RequestWithPrincipal = Request & { principal?: Principal };

/** 핸들러에서 지금 사람을 받는다. `@Roles()`가 없는 핸들러(가드가 사람을 확인하지 않은 곳)에서 쓰면 500 — 코드 실수다 */
export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => {
  const principal = ctx.switchToHttp().getRequest<RequestWithPrincipal>().principal;
  if (!principal) throw new InternalServerErrorException('로그인한 사람이 없습니다 — 이 핸들러에 @Roles()가 있어야 합니다.');
  return principal;
});

export function toMeView(p: Principal): MeView {
  return { loginId: p.loginId, displayName: p.displayName, role: p.role, merchantCode: p.merchantCode };
}
```

`apps/api/src/auth/cookies.ts`:

```ts
/** 세션 쿠키 이름(decisions/0050) */
export const SESSION_COOKIE = 'sid';

/**
 * Cookie 헤더에서 이름 하나의 값을 꺼낸다(cookie-parser 의존성 없이). 값은 우리가 만든 base64url이라 디코드하지 않는다.
 * 같은 이름이 여러 번 오면 처음 것.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}
```

- [ ] **Step 6: 세션 저장소·로그인 서비스·컨트롤러**

`apps/api/src/auth/session.store.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { execOrThrow } from '../redis/redis-exec.js';
import { REDIS } from '../redis/redis.provider.js';
import type { Principal } from './principal.js';

/** 세션에 넣는 것 = 요청마다 필요한 사람 정보(요청마다 MySQL을 읽지 않으려고 역할까지 넣는다 — 바뀌면 세션을 끊는다) */
export type SessionData = Principal & { accountId: number };

/**
 * 서버 세션(decisions/0050). 토큰(32바이트 무작위, 쿠키 값)의 SHA-256을 키로 Redis에 둔다 — Redis 내용이 새어도 쿠키를 만들 수 없다.
 * - `<접두사>:sess:<해시>`      STRING JSON(SessionData), PX = 유휴 TTL. 읽을 때마다 GETEX로 다시 늘린다
 * - `<접두사>:sess-of:<계정 id>` SET 해시들 — 역할 변경·사용 중지·비밀번호 변경 때 그 계정의 세션을 한 번에 끊는다
 * MySQL이 아니라 Redis인 이유: 요청마다 읽고, 저절로 끝나야(TTL) 하고, 잃어도 다시 로그인하면 되는 값이다.
 */
@Injectable()
export class SessionStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private sessionKey(hash: string) {
    return `${env.queuePrefix}:sess:${hash}`;
  }

  private indexKey(accountId: number) {
    return `${env.queuePrefix}:sess-of:${accountId}`;
  }

  private static hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  /** 새 세션을 만들고 토큰(쿠키 값)을 돌려준다. 이 계정의 끝난 세션 해시는 색인에서 치운다 */
  async create(data: SessionData): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const hash = SessionStore.hash(token);
    const index = this.indexKey(data.accountId);
    const old = await this.redis.smembers(index);
    const alive = old.length > 0 ? ((await execOrThrow(old.reduce((p, h) => p.exists(this.sessionKey(h)), this.redis.pipeline()))) as number[]) : [];
    const dead = old.filter((_, i) => alive[i] === 0);
    const tx = this.redis.multi().set(this.sessionKey(hash), JSON.stringify(data), 'PX', env.sessionIdleTtlMs).sadd(index, hash);
    if (dead.length > 0) tx.srem(index, ...dead);
    await execOrThrow(tx);
    return token;
  }

  /** 토큰의 세션. 없거나 끝났으면 null. 찾으면 유휴 TTL을 다시 늘린다(GETEX — 읽기와 늘리기가 명령 하나) */
  async get(token: string): Promise<SessionData | null> {
    const raw = await this.redis.getex(this.sessionKey(SessionStore.hash(token)), 'PX', env.sessionIdleTtlMs);
    return raw ? (JSON.parse(raw) as SessionData) : null;
  }

  /** 로그아웃 */
  async destroy(token: string): Promise<void> {
    const hash = SessionStore.hash(token);
    const raw = await this.redis.get(this.sessionKey(hash));
    const tx = this.redis.multi().del(this.sessionKey(hash));
    if (raw) tx.srem(this.indexKey((JSON.parse(raw) as SessionData).accountId), hash);
    await execOrThrow(tx);
  }

  /** 이 계정의 세션을 모두 끊는다(역할·가맹점·비밀번호를 바꾸거나 사용 중지할 때). 끊은 세션 수 */
  async destroyAllFor(accountId: number): Promise<number> {
    const index = this.indexKey(accountId);
    const hashes = await this.redis.smembers(index);
    if (hashes.length === 0) return 0;
    const [deleted] = (await execOrThrow(this.redis.multi().del(...hashes.map((h) => this.sessionKey(h))).del(index))) as number[];
    return deleted;
  }
}
```

`apps/api/src/auth/dto/login.dto.ts`:

```ts
import { IsString, Length } from 'class-validator';
import type { LoginRequest } from '@terminal-ops/contracts';

export class LoginDto implements LoginRequest {
  @IsString()
  @Length(1, 50)
  loginId!: string;

  @IsString()
  @Length(1, 200)
  password!: string;
}
```

`apps/api/src/auth/auth.service.ts`:

```ts
import { HttpException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { ApiErrorBody } from '@terminal-ops/contracts';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { execOrThrow } from '../redis/redis-exec.js';
import { REDIS } from '../redis/redis.provider.js';
import { dummyPasswordHash, verifyPassword } from './password.js';
import { SessionStore, type SessionData } from './session.store.js';
import { UserAccount } from './user-account.entity.js';

const LOGIN_FAILED: ApiErrorBody = { statusCode: 401, code: 'LOGIN_FAILED', message: '아이디 또는 비밀번호가 맞지 않습니다.' };

/** 로그인·로그아웃(decisions/0050). 세션은 SessionStore, 실패 횟수는 Redis 카운터 */
@Injectable()
export class AuthService {
  constructor(
    private readonly em: EntityManager,
    private readonly sessions: SessionStore,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** 아이디별 실패 카운터. 대소문자를 가리지 않는 아이디(collation)라 소문자로 묶는다 */
  private failKey(loginId: string) {
    return `${env.queuePrefix}:login-fail:${loginId.toLowerCase()}`;
  }

  /**
   * 맞으면 세션 토큰과 사람 정보. 틀리면 401 LOGIN_FAILED(아이디가 없는지·비밀번호가 틀린지·사용 중지인지 말하지 않는다).
   * 같은 아이디로 실패가 LOGIN_MAX_FAILURES번 쌓이면 첫 실패부터 LOGIN_LOCK_MS 동안 429 LOGIN_LOCKED — 맞는 비밀번호여도.
   */
  async login(loginId: string, password: string): Promise<{ token: string; session: SessionData }> {
    const failKey = this.failKey(loginId);
    const failures = Number((await this.redis.get(failKey)) ?? 0);
    if (failures >= env.loginMaxFailures) {
      const ttl = await this.redis.pttl(failKey);
      throw new HttpException(
        {
          statusCode: 429,
          code: 'LOGIN_LOCKED',
          message: `로그인 실패가 ${env.loginMaxFailures}번 넘어 잠시 막았습니다. 약 ${Math.max(1, Math.ceil(ttl / 60_000))}분 뒤 다시 시도하세요.`,
        } satisfies ApiErrorBody,
        429,
      );
    }
    const em = this.em.fork();
    const account = await em.findOne(UserAccount, { loginId }, { populate: ['merchant'] });
    // 없는 아이디도 해시 하나만큼 시간을 쓴다(응답 시간으로 아이디가 있는지 알아내지 못하게)
    const ok = await verifyPassword(password, account?.passwordHash ?? (await dummyPasswordHash()));
    if (!account || !ok || account.disabledAt) {
      // 첫 실패에만 만료를 건다(NX) — 실패가 이어져도 창이 밀리지 않는다
      await execOrThrow(this.redis.multi().incr(failKey).pexpire(failKey, env.loginLockMs, 'NX'));
      throw new UnauthorizedException(LOGIN_FAILED);
    }
    await this.redis.del(failKey);
    account.lastLoginAt = new Date();
    await em.flush();
    const session: SessionData = {
      accountId: account.id,
      loginId: account.loginId,
      displayName: account.displayName,
      role: account.role,
      merchantId: account.merchant?.id ?? null,
      merchantCode: account.merchant?.code ?? null,
    };
    return { token: await this.sessions.create(session), session };
  }

  async logout(token: string | null): Promise<void> {
    if (token) await this.sessions.destroy(token);
  }
}
```

`apps/api/src/auth/auth.controller.ts`:

```ts
import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { MeView } from '@terminal-ops/contracts';
import type { Request, Response } from 'express';
import { env } from '../config/env.js';
import { ANY_ROLE, Public, Roles } from './access.js';
import { AuthService } from './auth.service.js';
import { readCookie, SESSION_COOKIE } from './cookies.js';
import { LoginDto } from './dto/login.dto.js';
import { CurrentPrincipal, toMeView, type Principal } from './principal.js';

/** 사람 로그인(decisions/0050). 세션 토큰은 httpOnly 쿠키로만 준다 — 화면 JS가 읽을 수 없다 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response): Promise<MeView> {
    const { token, session } = await this.auth.login(dto.loginId, dto.password);
    // SameSite=Strict: 다른 사이트에서 시작한 요청에는 쿠키가 붙지 않는다(CSRF 막기, decisions/0050). 만료는 서버(Redis TTL)가 정한다
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: env.sessionCookieSecure, path: '/' });
    return toMeView(session);
  }

  @Post('logout')
  @Roles(...ANY_ROLE)
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(readCookie(req.headers.cookie, SESSION_COOKIE));
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: env.sessionCookieSecure, path: '/' });
  }

  @Get('me')
  @Roles(...ANY_ROLE)
  me(@CurrentPrincipal() principal: Principal): MeView {
    return toMeView(principal);
  }
}
```

- [ ] **Step 7: 전역 가드·모듈·작업자 데코레이터**

`apps/api/src/auth/auth.guard.ts`(단말기 키 검사는 Task 3에서 이 `case 'device'`를 바꾼다 — 그때까지 단말기 API는 지금처럼 열려 있다):

```ts
import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiErrorBody } from '@terminal-ops/contracts';
import { env } from '../config/env.js';
import { ACCESS_KEY, type Access } from './access.js';
import { readCookie, SESSION_COOKIE } from './cookies.js';
import type { Principal, RequestWithPrincipal } from './principal.js';
import { Role } from './role.js';
import { SessionStore } from './session.store.js';

const UNAUTHENTICATED: ApiErrorBody = { statusCode: 401, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다(세션이 없거나 끝났습니다).' };

/** 테스트 전용 헤더(decisions/0056). 기존 테스트의 `X-Operator: kim`이 그대로 로그인 아이디 kim(OPERATOR)이 된다 */
export const TEST_OPERATOR_HEADER = 'x-operator';
export const TEST_ROLE_HEADER = 'x-test-role';

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return '';
  }
}

/** 테스트 전용 헤더의 사람. 이름 규칙은 예전 X-Operator와 같다(1~50자, `system:` 금지). MERCHANT는 가맹점이 없어 받지 않는다(실제 로그인으로) */
export function testPrincipal(operator: string | undefined, role: string | undefined): Principal | null {
  const name = operator ? decodeName(operator) : '';
  if (!name || name.length > 50 || name.startsWith('system:')) return null;
  const r = (role ?? Role.OPERATOR) as Role;
  if (!Object.values(Role).includes(r) || r === Role.MERCHANT) return null;
  return { accountId: null, loginId: name, displayName: name, role: r, merchantId: null, merchantCode: null };
}

/**
 * 모든 HTTP 요청의 문(APP_GUARD, decisions/0052). 핸들러의 Access 메타데이터대로:
 * 없음 → 403(기본 거부), public → 통과, roles → 세션 쿠키의 사람이 그 역할이어야(없으면 401, 역할 밖이면 403),
 * device → 단말기 키(Task 3에서 붙인다).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionStore,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const access = this.reflector.get<Access | undefined>(ACCESS_KEY, ctx.getHandler());
    const req = ctx.switchToHttp().getRequest<RequestWithPrincipal>();
    if (!access) {
      throw new ForbiddenException({ statusCode: 403, code: 'FORBIDDEN', message: '접근 규칙이 정해지지 않은 API입니다(decisions/0052).' } satisfies ApiErrorBody);
    }
    switch (access.kind) {
      case 'public':
        return true;
      case 'device':
        return true; // 단말기 키 검사는 Task 3(decisions/0055)에서 붙인다
      case 'roles': {
        const principal = await this.principal(req);
        if (!principal) throw new UnauthorizedException(UNAUTHENTICATED);
        if (!access.roles.includes(principal.role)) {
          throw new ForbiddenException({
            statusCode: 403,
            code: 'FORBIDDEN',
            message: `이 작업은 ${access.roles.join(', ')} 역할만 할 수 있습니다(지금: ${principal.role}).`,
          } satisfies ApiErrorBody);
        }
        req.principal = principal;
        return true;
      }
    }
  }

  /** 세션 쿠키가 있으면 그것만 본다(끝난 세션이면 null — 헤더로 넘어가지 않는다). 없을 때만, 테스트에서만 헤더 */
  private async principal(req: RequestWithPrincipal): Promise<Principal | null> {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (token) return this.sessions.get(token);
    if (!env.authTestHeaders) return null;
    return testPrincipal(req.header(TEST_OPERATOR_HEADER), req.header(TEST_ROLE_HEADER));
  }
}
```

`apps/api/src/auth/auth.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { SessionStore } from './session.store.js';

/** 로그인·세션·가드(보강 2). 가드는 앱 전체(APP_GUARD) — 모든 핸들러가 접근 규칙을 가져야 한다(decisions/0052) */
@Global()
@Module({
  controllers: [AuthController],
  providers: [SessionStore, AuthService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [SessionStore],
})
export class AuthModule {}
```

`apps/api/src/common/operator.decorator.ts`(전체 바꿈 — 헤더를 읽지 않는다. 쓰는 곳 22곳은 그대로):

```ts
import { createParamDecorator, type ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import type { RequestWithPrincipal } from '../auth/principal.js';

/**
 * 요청한 작업자 — 로그인한 계정의 로그인 아이디(decisions/0056). 이력·검수·스캔·배포의 actor로 남는다.
 * 전에는 `X-Operator` 헤더를 그대로 믿었다(decisions/0001, 대체됨). 이제 헤더는 테스트 전용 인증 길에서만 읽는다(auth.guard.ts).
 * AuthGuard가 `@Roles()` 핸들러에서 사람을 확인한 뒤라 여기서는 꺼내기만 한다. 시스템 작업의 `system:<작업명>`은 그대로다.
 */
export const Operator = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const principal = ctx.switchToHttp().getRequest<RequestWithPrincipal>().principal;
  if (!principal) throw new InternalServerErrorException('로그인한 사람이 없습니다 — 이 핸들러에 @Roles()가 있어야 합니다.');
  return principal.loginId;
});
```

`apps/api/src/app.module.ts`:

```diff
--- a/apps/api/src/app.module.ts
+++ b/apps/api/src/app.module.ts
@@ -23,6 +23,7 @@ import { ReportModule } from './report/report.module.js';
 import { DashboardModule } from './dashboard/dashboard.module.js';
 import { WorkersModule } from './workers/workers.module.js';
 import { SchedulerModule } from './scheduler/scheduler.module.js';
+import { AuthModule } from './auth/auth.module.js';
 
 export interface AppOptions {
   /** 큐 job을 처리할지(RUN_WORKERS) */
@@ -37,6 +38,7 @@ export interface AppOptions {
     MikroOrmModule.forRoot(ormConfig),
     RedisModule,
     QueuesModule,
+    AuthModule,
     TerminalModule,
     InspectionModule,
     MerchantModule,
```

- [ ] **Step 8: 기존 컨트롤러 18개에 접근 규칙을 단다**(정정: 처음 '20개'로 적었다 — 실제 18개)

규칙은 decisions/0052의 표 그대로다(표 = Step 2의 `access-table.spec.ts` `EXPECTED`). 핸들러마다 하나, 클래스에는 달지 않는다.

```diff
--- a/apps/api/src/health/health.controller.ts
+++ b/apps/api/src/health/health.controller.ts
@@ -1,9 +1,11 @@
 import { Controller, Get } from '@nestjs/common';
 import type { HealthView } from '@terminal-ops/contracts';
+import { Public } from '../auth/access.js';
 
 @Controller('health')
 export class HealthController {
   @Get()
+  @Public()
   check(): HealthView {
     return { status: 'ok' };
   }
```

```diff
--- a/apps/api/src/anomaly/anomaly.controller.ts
+++ b/apps/api/src/anomaly/anomaly.controller.ts
@@ -1,5 +1,7 @@
 import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
 import type { AnomalyRuleView, AnomalyScanSummary } from '@terminal-ops/contracts';
+import { OFFICE, Roles } from '../auth/access.js';
+import { Role } from '../auth/role.js';
 import { Operator } from '../common/operator.decorator.js';
 import { ANOMALY_RULE_LABEL } from './anomaly-labels.js';
 import { ruleThresholdDays } from './anomaly-rules.js';
@@ -14,17 +16,20 @@ export class AnomalyController {
 
   /** 규칙 목록(이름·기준일). 화면의 규칙 필터가 쓴다 — 규칙 이름을 화면에 따로 두지 않게(decisions/0040) */
   @Get('anomaly-rules')
+  @Roles(...OFFICE)
   rules(): AnomalyRuleView[] {
     return Object.values(AnomalyRule).map((rule) => ({ rule, label: ANOMALY_RULE_LABEL[rule], days: ruleThresholdDays(rule) }));
   }
 
   @Get('anomalies')
+  @Roles(...OFFICE)
   async list(@Query() query: ListAnomaliesQuery) {
     return this.anomalies.list(query);
   }
 
   /** 수동 찾기(동기). 다른 찾기가 돌고 있으면 409 ANOMALY_SCAN_RUNNING */
   @Post('anomaly-scans')
+  @Roles(Role.OPERATOR, Role.MONITOR)
   @HttpCode(200)
   async scan(@Operator() _actor: string): Promise<AnomalyScanSummary> {
     const { newMatches, ...summary } = await this.anomalies.scan();
```

```diff
--- a/apps/api/src/dashboard/dashboard.controller.ts
+++ b/apps/api/src/dashboard/dashboard.controller.ts
@@ -1,5 +1,6 @@
 import { Controller, Get, Query } from '@nestjs/common';
 import { IsIn, IsOptional } from 'class-validator';
+import { OFFICE, Roles } from '../auth/access.js';
 import { DashboardService } from './dashboard.service.js';
 
 export class DashboardQuery {
@@ -15,6 +16,7 @@ export class DashboardController {
   constructor(private readonly dashboard: DashboardService) {}
 
   @Get('summary')
+  @Roles(...OFFICE)
   summary(@Query() query: DashboardQuery) {
     return this.dashboard.summary({ refresh: query.refresh === 'true' });
   }
```

```diff
--- a/apps/api/src/device/connectivity.controller.ts
+++ b/apps/api/src/device/connectivity.controller.ts
@@ -1,4 +1,5 @@
 import { Controller, Get, Param } from '@nestjs/common';
+import { OFFICE, Roles } from '../auth/access.js';
 import { ConnectivityService } from './connectivity.service.js';
 
 @Controller('terminals')
@@ -7,6 +8,7 @@ export class ConnectivityController {
 
   /** 접속 상태: Redis(최신 하트비트)가 있으면 그것, 없으면 MySQL 스냅샷(decisions/0029) */
   @Get(':serialNo/connectivity')
+  @Roles(...OFFICE)
   async get(@Param('serialNo') serialNo: string) {
     return this.connectivity.get(serialNo);
   }
```

```diff
--- a/apps/api/src/device/device.controller.ts
+++ b/apps/api/src/device/device.controller.ts
@@ -1,17 +1,16 @@
 import { Body, Controller, HttpCode, Post } from '@nestjs/common';
+import { DeviceAuth } from '../auth/access.js';
 import { HeartbeatBatchDto } from './dto/heartbeat.dto.js';
 import { HeartbeatService } from './heartbeat.service.js';
 
-/**
- * 단말기가 부르는 API. 사람이 아니라 단말기라서 작업자 헤더(X-Operator)를 받지 않는다.
- * 단말기 인증도 이번에는 하지 않는다(가상 프로젝트, decisions/0001과 같은 이유로 미룸). 대신 형식을 검사한다.
- */
+/** 단말기가 부르는 API. 사람이 아니라 단말기라서 로그인 세션이 아니라 단말기 키로 받는다(decisions/0055). 형식은 행마다 검사한다. */
 @Controller('devices')
 export class DeviceController {
   constructor(private readonly heartbeats: HeartbeatService) {}
 
   /** 하트비트 묶음(1~500개). 항목마다 결과를 돌려준다. 단건은 항목 1개짜리 묶음으로 보낸다. */
   @Post('heartbeats')
+  @DeviceAuth()
   @HttpCode(200)
   async heartbeat(@Body() dto: HeartbeatBatchDto) {
     return this.heartbeats.receive(dto.items);
```

```diff
--- a/apps/api/src/firmware/firmware-report.controller.ts
+++ b/apps/api/src/firmware/firmware-report.controller.ts
@@ -1,13 +1,15 @@
 import { Body, Controller, HttpCode, Post } from '@nestjs/common';
+import { DeviceAuth } from '../auth/access.js';
 import { FirmwareReportDto } from './dto/firmware.dto.js';
 import { FirmwareReportService } from './firmware-report.service.js';
 
-/** 단말기가 부르는 API(하트비트와 같이 작업자 헤더 없음) */
+/** 단말기가 부르는 API(하트비트와 같이 단말기 키, decisions/0055) */
 @Controller('devices')
 export class FirmwareReportController {
   constructor(private readonly reports: FirmwareReportService) {}
 
   @Post('firmware-reports')
+  @DeviceAuth()
   @HttpCode(200)
   async report(@Body() dto: FirmwareReportDto) {
     return this.reports.report(dto);
```

```diff
--- a/apps/api/src/firmware/firmware.controller.ts
+++ b/apps/api/src/firmware/firmware.controller.ts
@@ -1,12 +1,14 @@
 import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
 import type { BeforeIdPage, RolloutView } from '@terminal-ops/contracts';
+import { OFFICE, Roles } from '../auth/access.js';
+import { Role } from '../auth/role.js';
 import { Operator } from '../common/operator.decorator.js';
 import { CreateRolloutDto, ListRolloutsQuery, RegisterFirmwareDto } from './dto/firmware.dto.js';
 import { FirmwareService, toFirmwareView } from './firmware.service.js';
 import { RolloutService, toRolloutView } from './rollout.service.js';
 import type { FirmwareRollout } from './firmware.entities.js';
 
-/** 펌웨어 등록과 단계 배포 관리(운영자). 쓰기는 작업자 헤더가 필요하다(decisions/0001). */
+/** 펌웨어 등록과 단계 배포 관리. 쓰기는 운영자(OPERATOR)만(decisions/0052). */
 @Controller()
 export class FirmwareController {
   constructor(
@@ -15,40 +17,47 @@ export class FirmwareController {
   ) {}
 
   @Post('firmware')
+  @Roles(Role.OPERATOR)
   async register(@Body() dto: RegisterFirmwareDto, @Operator() actor: string) {
     return toFirmwareView(await this.firmware.register(dto, actor));
   }
 
   @Post('firmware-rollouts')
+  @Roles(Role.OPERATOR)
   async create(@Body() dto: CreateRolloutDto, @Operator() actor: string) {
     return this.view(await this.rollouts.create(dto, actor));
   }
 
   /** 배포 목록과 단계별 통계(최근 것부터, ?status=&beforeId=&limit=) */
   @Get('firmware-rollouts')
+  @Roles(...OFFICE)
   async list(@Query() query: ListRolloutsQuery): Promise<BeforeIdPage<RolloutView>> {
     const { items, nextBeforeId } = await this.rollouts.list(query);
     return { items: items.map(({ rollout, stats }) => toRolloutView(rollout, stats)), nextBeforeId };
   }
 
   @Get('firmware-rollouts/:id')
+  @Roles(...OFFICE)
   async get(@Param('id', ParseIntPipe) id: number) {
     return this.view(await this.rollouts.get(id));
   }
 
   @Post('firmware-rollouts/:id/pause')
+  @Roles(Role.OPERATOR)
   @HttpCode(200)
   async pause(@Param('id', ParseIntPipe) id: number, @Operator() _actor: string) {
     return this.view(await this.rollouts.pause(id));
   }
 
   @Post('firmware-rollouts/:id/resume')
+  @Roles(Role.OPERATOR)
   @HttpCode(200)
   async resume(@Param('id', ParseIntPipe) id: number, @Operator() _actor: string) {
     return this.view(await this.rollouts.resume(id));
   }
 
   @Post('firmware-rollouts/:id/abort')
+  @Roles(Role.OPERATOR)
   @HttpCode(200)
   async abort(@Param('id', ParseIntPipe) id: number, @Operator() actor: string) {
     return this.view(await this.rollouts.abort(id, actor));
```

```diff
--- a/apps/api/src/inspection/inspection.controller.ts
+++ b/apps/api/src/inspection/inspection.controller.ts
@@ -1,5 +1,7 @@
 import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
 import type { InspectionItemView, InspectResult } from '@terminal-ops/contracts';
+import { OFFICE, Roles, STAFF } from '../auth/access.js';
+import { Role } from '../auth/role.js';
 import { Operator } from '../common/operator.decorator.js';
 import { toTerminalView } from '../terminal/terminal.views.js';
 import { InspectionItemsQuery } from './dto/inspection-items.query.js';
@@ -12,12 +14,14 @@ export class InspectionController {
   constructor(private readonly inspections: InspectionService) {}
 
   @Get('inspection-items')
+  @Roles(...STAFF)
   async items(@Query() query: InspectionItemsQuery): Promise<InspectionItemView[]> {
     const items = await this.inspections.itemsForModel(query.modelCode);
     return items.map((i) => ({ code: i.code, label: i.label, sortOrder: i.sortOrder }));
   }
 
   @Post('terminals/:serialNo/inspections')
+  @Roles(Role.OPERATOR, Role.FIELD)
   async inspect(@Param('serialNo') serialNo: string, @Body() dto: InspectDto, @Operator() actor: string): Promise<InspectResult> {
     const r = await this.inspections.inspect(serialNo, dto, actor);
     return { inspectionId: r.inspection.id, passed: r.passed, failedItems: r.failedItems, terminal: toTerminalView(r.terminal) };
@@ -25,11 +29,13 @@ export class InspectionController {
 
   /** 이 단말기의 검수 기록(최근 것부터). 항목 이름을 붙인다 */
   @Get('terminals/:serialNo/inspections')
+  @Roles(...STAFF)
   async history(@Param('serialNo') serialNo: string) {
     return this.inspections.history(serialNo);
   }
 
   @Get('inspections/stats')
+  @Roles(...OFFICE)
   async stats(@Query() query: InspectionStatsQuery) {
     return this.inspections.failureStats(query.modelCode);
   }
```

```diff
--- a/apps/api/src/merchant/merchant.controller.ts
+++ b/apps/api/src/merchant/merchant.controller.ts
@@ -1,5 +1,7 @@
 import { Body, Controller, Get, Param, Post } from '@nestjs/common';
 import type { MerchantView } from '@terminal-ops/contracts';
+import { OFFICE, Roles } from '../auth/access.js';
+import { Role } from '../auth/role.js';
 import { Operator } from '../common/operator.decorator.js';
 import { toTerminalView } from '../terminal/terminal.views.js';
 import { AllocateDto } from './dto/allocate.dto.js';
@@ -11,16 +13,19 @@ export class MerchantController {
   constructor(private readonly merchants: MerchantService) {}
 
   @Get('merchants')
+  @Roles(...OFFICE)
   async list(): Promise<MerchantView[]> {
     return (await this.merchants.list()).map((m) => ({ code: m.code, name: m.name, address: m.address }));
   }
 
   @Post('terminals/:serialNo/allocations')
+  @Roles(Role.OPERATOR)
   async allocate(@Param('serialNo') serialNo: string, @Body() dto: AllocateDto, @Operator() actor: string) {
     return toTerminalView(await this.merchants.allocate(serialNo, dto, actor));
   }
 
   @Post('terminals/:serialNo/allocation-cancellations')
+  @Roles(Role.OPERATOR)
   async cancelAllocation(@Param('serialNo') serialNo: string, @Body() dto: CancelAllocationDto, @Operator() actor: string) {
     return toTerminalView(await this.merchants.cancelAllocation(serialNo, dto, actor));
   }
```

```diff
--- a/apps/api/src/purchase-order/purchase-order.controller.ts
+++ b/apps/api/src/purchase-order/purchase-order.controller.ts
@@ -1,5 +1,7 @@
 import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
 import type { BeforeIdPage, PurchaseOrderView } from '@terminal-ops/contracts';
+import { OFFICE, Roles, STAFF } from '../auth/access.js';
+import { Role } from '../auth/role.js';
 import { Operator } from '../common/operator.decorator.js';
 import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto.js';
 import { ListPurchaseOrdersQuery } from './dto/list-purchase-orders.query.js';
@@ -11,29 +13,34 @@ export class PurchaseOrderController {
   constructor(private readonly orders: PurchaseOrderService) {}
 
   @Post()
+  @Roles(Role.OPERATOR)
   async create(@Body() dto: CreatePurchaseOrderDto, @Operator() actor: string) {
     return toPurchaseOrderView(await this.orders.create(dto, actor));
   }
 
-  /** 발주 목록(최근 것부터, ?status=&beforeId=&limit=) */
+  /** 발주 목록(최근 것부터, ?status=&beforeId=&limit=). 현장 작업자도 입고 박스의 발주를 고른다 */
   @Get()
+  @Roles(...STAFF)
   async list(@Query() query: ListPurchaseOrdersQuery): Promise<BeforeIdPage<PurchaseOrderView>> {
     const { items, nextBeforeId } = await this.orders.list(query);
     return { items: items.map(toPurchaseOrderView), nextBeforeId };
   }
 
   @Get(':poNo/reconciliation')
+  @Roles(...OFFICE)
   async reconciliation(@Param('poNo') poNo: string) {
     return this.orders.reconcile(poNo);
   }
 
   @Post(':poNo/close')
+  @Roles(Role.OPERATOR)
   @HttpCode(200)
   async close(@Param('poNo') poNo: string, @Operator() actor: string) {
     return this.orders.close(poNo, actor);
   }
 
   @Get(':poNo')
+  @Roles(...STAFF)
   async get(@Param('poNo') poNo: string) {
     return toPurchaseOrderView(await this.orders.get(poNo));
   }
```

```diff
--- a/apps/api/src/report/weekly-report.controller.ts
+++ b/apps/api/src/report/weekly-report.controller.ts
@@ -1,6 +1,8 @@
 import { BadRequestException, Body, Controller, Get, Header, NotFoundException, Param, Post, Query, Res, StreamableFile } from '@nestjs/common';
 import type { Response } from 'express';
 import type { ApiErrorBody, WeeklyReportPage } from '@terminal-ops/contracts';
+import { OFFICE, Roles } from '../auth/access.js';
+import { Role } from '../auth/role.js';
 import { attachmentDisposition } from '../common/content-disposition.js';
 import { Operator } from '../common/operator.decorator.js';
 import { ListWeeklyReportsQuery } from './dto/list-weekly-reports.query.js';
@@ -25,6 +27,7 @@ export class WeeklyReportController {
    * 끝나지 않은 주는 422 WEEK_NOT_ENDED. 결과(SENT·lastError)는 GET /reports/weekly/:weekStart로 본다.
    */
   @Post()
+  @Roles(Role.OPERATOR, Role.MONITOR)
   async send(@Body() dto: SendWeeklyReportDto, @Operator() _actor: string, @Res({ passthrough: true }) res: Response) {
     const week = dto.weekStart ? weekOf(dto.weekStart) : previousKstWeek(new Date());
     const { report, alreadySent, queued } = await this.reports.request(week);
@@ -37,6 +40,7 @@ export class WeeklyReportController {
    * queued·queuedAt은 주마다 큐를 본다(limit 상한 100, 한꺼번에 — 왕복을 차례로 기다리지 않는다) — 이미 보낸 주는 Redis를 보지 않는다(queueState)
    */
   @Get()
+  @Roles(...OFFICE)
   async list(@Query() query: ListWeeklyReportsQuery): Promise<WeeklyReportPage> {
     const { items, nextBefore } = await this.reports.list(query);
     const states = await Promise.all(items.map((r) => this.reports.queueState(r)));
@@ -45,6 +49,7 @@ export class WeeklyReportController {
 
   /** 상태. queued: 수동 보내기 job이 아직 대기·처리 중, queuedAt: 그 job을 넣은 시각(POST 응답에는 없다 — 화면은 GET으로 다시 읽는다) */
   @Get(':weekStart')
+  @Roles(...OFFICE)
   async get(@Param('weekStart') weekStart: string) {
     const report = await this.reports.get(weekOf(weekStart).weekStart);
     const { queued, queuedAt } = await this.reports.queueState(report);
@@ -53,6 +58,7 @@ export class WeeklyReportController {
 
   /** 저장된 xlsx 내려받기. 파일 이름이 한글이라 filename*(RFC 5987)로 보낸다. 운영 수치라 중간 캐시에 남지 않게 no-store */
   @Get(':weekStart/file')
+  @Roles(...OFFICE)
   @Header('Cache-Control', 'no-store')
   async file(@Param('weekStart') weekStart: string) {
     const report = await this.reports.get(weekOf(weekStart).weekStart);
```

```diff
--- a/apps/api/src/scan/scan.controller.ts
+++ b/apps/api/src/scan/scan.controller.ts
@@ -1,6 +1,8 @@
 import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
 import type { Response } from 'express';
 import type { ScanView } from '@terminal-ops/contracts';
+import { Roles, STAFF } from '../auth/access.js';
+import { Role } from '../auth/role.js';
 import { Operator } from '../common/operator.decorator.js';
 import { summarize } from '../terminal/bulk-rows.js';
 import { CreateScanDto } from './dto/create-scan.dto.js';
@@ -26,6 +28,7 @@ export class ScanController {
 
   /** 새로 처리했으면 201, 같은 scanId를 다시 보내 저장된 결과를 돌려주면 200(replayed: true) */
   @Post()
+  @Roles(Role.OPERATOR, Role.FIELD)
   async scan(@Body() dto: CreateScanDto, @Operator() actor: string, @Res({ passthrough: true }) res: Response) {
     const { batch, replayed } = await this.scans.scan(dto, actor);
     res.status(replayed ? 200 : 201);
@@ -33,6 +36,7 @@ export class ScanController {
   }
 
   @Get(':scanId')
+  @Roles(...STAFF)
   async get(@Param('scanId') scanId: string) {
     return toScanView(await this.scans.get(scanId), true);
   }
```

```diff
--- a/apps/api/src/service/service-ticket.controller.ts
+++ b/apps/api/src/service/service-ticket.controller.ts
@@ -1,5 +1,7 @@
 import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
 import type { BeforeIdPage, TicketView } from '@terminal-ops/contracts';
+import { OFFICE, Roles } from '../auth/access.js';
+import { Role } from '../auth/role.js';
 import { Operator } from '../common/operator.decorator.js';
 import { ListTicketsQuery, OpenTicketDto, RemoteCheckDto, ReplaceDto } from './dto/service-ticket.dto.js';
 import { ReplacementService } from './replacement.service.js';
@@ -14,35 +16,41 @@ export class ServiceTicketController {
   ) {}
 
   @Post()
+  @Roles(Role.OPERATOR)
   async open(@Body() dto: OpenTicketDto, @Operator() actor: string) {
     return toTicketView(await this.tickets.open(dto, actor));
   }
 
   /** 접수 목록(최근 것부터, ?status=&serialNo=&beforeId=&limit=) */
   @Get()
+  @Roles(...OFFICE)
   async list(@Query() query: ListTicketsQuery): Promise<BeforeIdPage<TicketView>> {
     const { items, nextBeforeId } = await this.tickets.list(query);
     return { items: items.map(toTicketView), nextBeforeId };
   }
 
   @Get(':id')
+  @Roles(...OFFICE)
   async get(@Param('id', ParseIntPipe) id: number) {
     return toTicketView(await this.tickets.get(id));
   }
 
   @Post(':id/remote-checks')
+  @Roles(Role.OPERATOR)
   @HttpCode(200)
-  // 작업자 헤더는 모든 쓰기 API에 받는다(decisions/0001). 원격 점검은 메모에 결과만 남긴다.
+  // 원격 점검은 메모에 결과만 남긴다(작업자는 이력에 남기지 않지만 운영자만 할 수 있다)
   async remoteCheck(@Param('id', ParseIntPipe) id: number, @Body() dto: RemoteCheckDto, @Operator() _actor: string) {
     return toTicketView(await this.tickets.remoteCheck(id, dto));
   }
 
   @Post(':id/replacements')
+  @Roles(Role.OPERATOR)
   async replace(@Param('id', ParseIntPipe) id: number, @Body() dto: ReplaceDto, @Operator() actor: string) {
     return toTicketView(await this.replacements.replace(id, dto, actor));
   }
 
   @Post(':id/installations')
+  @Roles(Role.OPERATOR)
   @HttpCode(200)
   async install(@Param('id', ParseIntPipe) id: number, @Operator() actor: string) {
     return toTicketView(await this.replacements.install(id, actor));
```

```diff
--- a/apps/api/src/shipment/shipment.controller.ts
+++ b/apps/api/src/shipment/shipment.controller.ts
@@ -1,5 +1,7 @@
 import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
 import type { CreatedShipmentView } from '@terminal-ops/contracts';
+import { OFFICE, Roles } from '../auth/access.js';
+import { Role } from '../auth/role.js';
 import { Operator } from '../common/operator.decorator.js';
 import { toTerminalView } from '../terminal/terminal.views.js';
 import { CreateShipmentDto } from './dto/create-shipment.dto.js';
@@ -11,12 +13,14 @@ export class ShipmentController {
   constructor(private readonly shipments: ShipmentService) {}
 
   @Post()
+  @Roles(Role.OPERATOR)
   async create(@Body() dto: CreateShipmentDto, @Operator() actor: string): Promise<CreatedShipmentView> {
     const { shipment, terminal } = await this.shipments.create(dto, actor);
     return { ...toShipmentView(shipment), terminal: toTerminalView(terminal) };
   }
 
   @Get(':id')
+  @Roles(...OFFICE)
   async get(@Param('id', ParseIntPipe) id: number) {
     const { shipment, events } = await this.shipments.get(id);
     return toShipmentView(shipment, events);
```

```diff
--- a/apps/api/src/shipment/sync-run.controller.ts
+++ b/apps/api/src/shipment/sync-run.controller.ts
@@ -1,6 +1,7 @@
 import { Controller, Get, Query } from '@nestjs/common';
 import type { BeforeIdPage, SyncRunView } from '@terminal-ops/contracts';
 import { EntityManager, LoadStrategy } from '@mikro-orm/mysql';
+import { OFFICE, Roles } from '../auth/access.js';
 import { beforeIdWhere, keysetPage } from '../common/keyset.js';
 import { ListSyncRunsQuery } from './dto/list-sync-runs.query.js';
 import { SyncRun } from './shipment.entities.js';
@@ -12,6 +13,7 @@ export class SyncRunController {
 
   /** 최근 실행부터(?job=&outcome=&beforeId=&limit=, id 키셋 — decisions/0039) */
   @Get()
+  @Roles(...OFFICE)
   async list(@Query() q: ListSyncRunsQuery): Promise<BeforeIdPage<SyncRunView>> {
     const rows = await this.em.fork().find(
       SyncRun,
```

```diff
--- a/apps/api/src/terminal/terminal-model.controller.ts
+++ b/apps/api/src/terminal/terminal-model.controller.ts
@@ -1,5 +1,6 @@
 import { Controller, Get } from '@nestjs/common';
 import type { TerminalModelView } from '@terminal-ops/contracts';
+import { Roles, STAFF } from '../auth/access.js';
 import { TerminalService } from './terminal.service.js';
 
 @Controller('terminal-models')
@@ -8,6 +9,7 @@ export class TerminalModelController {
 
   /** 모델 목록. 화면의 모델 필터·선택지(SN-100 등) */
   @Get()
+  @Roles(...STAFF)
   async list(): Promise<TerminalModelView[]> {
     return (await this.terminals.models()).map((m) => ({ code: m.code, name: m.name, requiresReinspection: m.requiresReinspection }));
   }
```

```diff
--- a/apps/api/src/terminal/terminal.controller.ts
+++ b/apps/api/src/terminal/terminal.controller.ts
@@ -1,5 +1,7 @@
 import { Body, Controller, Get, HttpCode, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
 import type { TerminalPage } from '@terminal-ops/contracts';
+import { Roles, STAFF } from '../auth/access.js';
+import { Role } from '../auth/role.js';
 import { Operator } from '../common/operator.decorator.js';
 import { SingleFileInterceptor } from '../common/upload.interceptor.js';
 import { RegisterTerminalDto } from './dto/register-terminal.dto.js';
@@ -25,6 +27,7 @@ export class TerminalController {
    * fields 0·parts 1: 글자 필드나 두 번째 part가 오면 바로 400 INVALID_FILE(파일 크기 초과는 413 FILE_TOO_LARGE, decisions/0022).
    */
   @Post('imports')
+  @Roles(Role.OPERATOR)
   @UseInterceptors(
     SingleFileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0, parts: 1 }, defParamCharset: 'utf8' }),
   )
@@ -33,11 +36,13 @@ export class TerminalController {
   }
 
   @Post()
+  @Roles(Role.OPERATOR)
   async register(@Body() dto: RegisterTerminalDto, @Operator() actor: string) {
     return toTerminalView(await this.terminals.register(dto, actor));
   }
 
   @Get()
+  @Roles(...STAFF)
   async list(@Query() query: ListTerminalsQuery): Promise<TerminalPage> {
     const result = await this.terminals.list(query);
     return { ...result, items: result.items.map(toTerminalView) };
@@ -45,16 +50,19 @@ export class TerminalController {
 
   /** 상세: 기본 정보 + 지금 상태에서 할 수 있는 전이·작업(decisions/0040) */
   @Get(':serialNo')
+  @Roles(...STAFF)
   async get(@Param('serialNo') serialNo: string) {
     return toTerminalDetailView(await this.terminals.getBySerial(serialNo));
   }
 
   @Get(':serialNo/history')
+  @Roles(...STAFF)
   async history(@Param('serialNo') serialNo: string) {
     return (await this.terminals.history(serialNo)).map(toHistoryView);
   }
 
   @Post(':serialNo/transitions')
+  @Roles(Role.OPERATOR)
   @HttpCode(200)
   async transition(@Param('serialNo') serialNo: string, @Body() dto: TransitionDto, @Operator() actor: string) {
     const terminal = await this.transitions.transition({
```

```diff
--- a/apps/api/src/van/van-reconciliation.controller.ts
+++ b/apps/api/src/van/van-reconciliation.controller.ts
@@ -1,5 +1,7 @@
 import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
 import type { BeforeIdPage, VanRunDetail, VanRunView } from '@terminal-ops/contracts';
+import { OFFICE, Roles } from '../auth/access.js';
+import { Role } from '../auth/role.js';
 import { BeforeIdQuery } from '../common/keyset.js';
 import { Operator } from '../common/operator.decorator.js';
 import { StartVanReconciliationDto } from './dto/start-van-reconciliation.dto.js';
@@ -13,6 +15,7 @@ export class VanReconciliationController {
 
   /** 수동 실행. 진행 중인 실행이 있으면 409 VAN_RECONCILIATION_RUNNING. 본문 { acknowledgeDrop: true }면 이 실행만 수집 급감 검사를 건너뛴다 */
   @Post()
+  @Roles(Role.OPERATOR, Role.MONITOR)
   @HttpCode(202)
   async start(@Operator() actor: string, @Body() body: StartVanReconciliationDto) {
     return toVanRunView(await this.runs.request(actor, { acknowledgeDrop: body.acknowledgeDrop === true }));
@@ -20,6 +23,7 @@ export class VanReconciliationController {
 
   /** 실행 목록(최근 것부터, ?beforeId=&limit=) */
   @Get()
+  @Roles(...OFFICE)
   async list(@Query() query: BeforeIdQuery): Promise<BeforeIdPage<VanRunView>> {
     const { items, nextBeforeId } = await this.runs.list(query);
     return { items: items.map(toVanRunView), nextBeforeId };
@@ -27,6 +31,7 @@ export class VanReconciliationController {
 
   /** 실행 요약 + 결과 한 페이지(?kind=&verified=&afterId=&limit=) */
   @Get(':id')
+  @Roles(...OFFICE)
   async get(@Param('id', ParseIntPipe) id: number, @Query() query: VanItemsQuery): Promise<VanRunDetail> {
     const run = toVanRunView(await this.runs.get(id));
     return { ...run, ...(await this.runs.items(id, query)) };
```

(`auth.controller.ts`는 Step 6에서 이미 규칙을 달았다 — 합쳐 컨트롤러 19개 + health. `grep -rL "@Public\|@Roles\|@DeviceAuth" src --include=*.controller.ts`가 아무것도 내지 않아야 한다.)

- [ ] **Step 9: 새 테스트가 통과하는지 본다**

Run(`apps/api`): `npm run typecheck && npx vitest run test/unit/auth-guard.spec.ts test/unit/access-table.spec.ts test/auth.e2e.spec.ts test/terminal.e2e.spec.ts`
Expected: typecheck 0, `Test Files  4 passed (4)`, `Tests  34 passed (34)`(auth.e2e 14, access-table 3, auth-guard 5, terminal.e2e 12).

- [ ] **Step 10: 접근 표가 빠뜨림을 잡는지 한 번 본다(되돌리기 필수)**

`apps/api/src/health/health.controller.ts`에서 `@Public()` 줄을 지우고 `npx vitest run test/unit/access-table.spec.ts` → 사전 검증과 같은 두 실패(`expected [ 'GET /health' ] to deeply equal []`, `"GET /health": null`)를 devlog에 붙인다. `git checkout -- apps/api/src/health/health.controller.ts`가 아니라 **Edit로 `@Public()`을 되돌린다**(이 파일은 아직 커밋 전이라 checkout하면 Step 8의 변경까지 사라진다 — 사전 검증에서 실제로 그렇게 되어 다시 썼다). 다시 돌려 3 passed.

- [ ] **Step 11: 전체 api 테스트**

테스트 DB를 다시 만든 뒤 Run(`apps/api`): `npx vitest run > ../../.auth-t2.log 2>&1; grep -E "Test Files|Tests |Duration" ../../.auth-t2.log; grep -c "Connection is closed" ../../.auth-t2.log; rm ../../.auth-t2.log`
Expected: `Test Files  71 passed (71)`, `Tests  483 passed (483)`(사전 검증 약 265초), `Connection is closed` 0. 다른 숫자면 실패한 테스트가 무엇을 기대했는지(400? 헤더? actor?) 보고 이 계획의 다섯 줄 말고 고친 곳이 생기면 devlog에 이유를 적는다.

- [ ] **Step 12: 결정 기록 0050·0052·0056**

`docs/decisions/0050-로그인은-Redis-서버-세션과-httpOnly-쿠키로.md`:

````markdown
# 0050. 로그인은 Redis 서버 세션과 httpOnly 쿠키로 한다

- 날짜 / 관련 기능: 2026-10-28 / 보강 2(로그인), 어드민. decisions/0001을 대체한다
- 상황: 사람이 로그인하고, 서버가 요청마다 누구인지·어떤 역할인지 알아야 한다. 화면(어드민, 앞으로 매장·현장·관제 화면)은 Vite 프록시로 api와 같은 출처다(decisions/0041). 비교 기준은 로그아웃이 바로 되는가, 계정을 막으면(사용 중지) 바로 끊기는가, 역할을 바꾸면 바로 반영되는가, 구현·의존성, 토큰 탈취 위험.
- 선택지:
  1. JWT(액세스 15분 + 리프레시) — 장점: 서버가 상태 없이 서명만 검증, 다른 출처·모바일에 쉽다. 단점: 로그아웃·사용 중지·역할 변경이 액세스 토큰 만료까지 남는다. 바로 막으려면 거부 목록(denylist)이나 토큰 버전을 서버(Redis·DB)에 둬야 해 결국 상태가 생긴다. 리프레시 토큰 회전·저장, 라이브러리(`@nestjs/jwt`·`jose`) 의존성. 토큰을 화면 JS가 들고 있으면 XSS에 털리고, 쿠키에 넣으면 CSRF 문제는 세션과 같다
  2. **서버 세션 + httpOnly 쿠키** — 장점: 로그아웃 = 키 삭제, 사용 중지·역할 변경 = 그 계정 세션 일괄 삭제가 바로 반영된다. 화면 JS가 토큰을 못 읽는다. 같은 출처라 쿠키가 그대로 간다. 의존성 0. 단점: 요청마다 저장소 조회 한 번, 다른 출처 클라이언트에는 CORS·SameSite 설정이 필요
  - 세션 저장소: MySQL 테이블(요청마다 SELECT, 만료 행 청소 작업 필요) 대 **Redis**(요청마다 읽기 한 번 — `GETEX`로 읽으며 TTL을 늘림, 만료는 TTL이 알아서). 잃어도 다시 로그인하면 되는 값이라 Redis의 휘발성이 문제가 되지 않는다(CLAUDE.md "Redis를 쓰는 이유")
- 결정: 2 + Redis.
  - 토큰 32바이트 무작위(base64url) = 쿠키 `sid`(HttpOnly, SameSite=Strict, Path=/, Secure는 `SESSION_COOKIE_SECURE`). Redis 키는 토큰의 SHA-256(`<접두사>:sess:<hex>`) — Redis 내용이 새어도 쿠키를 만들 수 없다. 로그인마다 새 토큰(세션 고정 공격 없음).
  - 세션 값 = 계정 id·로그인 아이디·표시 이름·역할·가맹점 id·코드(JSON). 요청마다 MySQL을 읽지 않는다. 대신 계정 API가 역할·가맹점·비밀번호를 바꾸거나 사용 중지하면 `<접두사>:sess-of:<계정 id>` SET에 모아 둔 그 계정의 세션을 모두 지운다(Task 5).
  - 유휴 만료 8시간(`SESSION_IDLE_TTL_MS`), 요청마다 늘린다. 쿠키에는 만료를 두지 않는다(브라우저 세션 쿠키, 서버가 정한다).
  - 로그인 실패 제한: 아이디별 Redis 카운터(`<접두사>:login-fail:<아이디 소문자>`, `INCR` + 첫 실패에만 `PEXPIRE … NX`). 첫 실패부터 15분(`LOGIN_LOCK_MS`) 안에 5번(`LOGIN_MAX_FAILURES`) 틀리면 그 창이 끝날 때까지 429 `LOGIN_LOCKED`(맞는 비밀번호여도). 성공하면 카운터를 지운다. 틀린 이유(없는 아이디·틀린 비밀번호·사용 중지)는 모두 같은 401 `LOGIN_FAILED`.
  - API: `POST /auth/login`(공개, 200 MeView + Set-Cookie), `POST /auth/logout`(204, 쿠키 지움), `GET /auth/me`(MeView).
- 다룬 보안 범위와 다루지 않은 범위(학습·로컬 시연용):
  - 다룸: 비밀번호 해시(0051), httpOnly(XSS가 토큰을 못 읽음), SameSite=Strict(다른 사이트에서 시작한 요청에 쿠키가 붙지 않음 — CSRF), 토큰 해시 저장, 실패 제한, 로그인마다 새 토큰.
  - 다루지 않음: CSRF 토큰(SameSite에만 기댄다 — `localhost`의 다른 포트는 같은 사이트로 본다), HTTPS(로컬 http, Secure 기본 꺼짐), 절대 만료(쓰는 한 계속 늘어남), IP별 실패 제한(아이디별만 — 남이 일부러 틀려 15분 잠글 수 있다), 비밀번호 변경·재설정 화면, 2단계 인증, 동시 세션 수 제한.
- 결과·대가: 요청마다 Redis 명령 하나(GETEX). 로그인한 사람의 역할은 세션에 고정돼, 계정 행을 SQL로 직접 고치면 세션이 끊길 때까지 옛 역할이다(계정 API를 쓴다). 계정 색인 SET은 TTL 없이 남고, 다음 로그인 때 끝난 세션 해시를 치운다.
- 다시 볼 조건: 화면이 다른 출처로 나가거나 모바일 앱이 사람 API를 부를 때(토큰 방식 또는 SameSite=None + CSRF 토큰), 실제 서비스로 내보낼 때(HTTPS·Secure, 절대 만료, IP 제한).
````

`docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md`:

````markdown
# 0052. 역할별 엔드포인트 표와 기본 거부

- 날짜 / 관련 기능: 2026-10-28 / 보강 2, 모든 HTTP API
- 상황: 역할 다섯(ADMIN 계정·역할·외부 업체 키 관리 / OPERATOR 운영자, 어드민의 모든 업무 쓰기 / MONITOR 관제·개발자, 읽기 + 관제 작업 / FIELD 현장 작업자, 스캔·검수 / MERCHANT 가맹점주, 자기 가맹점만)이 생긴다. 엔드포인트 55개(Task 2 끝, `/auth` 3개 포함 — 접근 표 테스트가 센 값. 보강 2 끝 예상 68개. 정정: 처음 '59개(72개)'로 적었다)에 누가 부를 수 있는지 정하고, 새 엔드포인트가 규칙 없이 열리지 않게 해야 한다.
- 선택지:
  1. 기본 허용 + 막을 곳에만 `@Roles` — 빠뜨린 곳이 조용히 열린다
  2. **기본 거부: 전역 가드(`APP_GUARD`) + 핸들러마다 규칙 하나(`@Public`·`@Roles(...)`·`@DeviceAuth`·`@PartnerAuth(scope)`), 없으면 403** — 빠뜨리면 막힌다(안전한 쪽으로 틀린다)
  3. 권한 단위(`terminal:write` 등) + 역할 → 권한 표 — 역할이 많거나 사용자별 권한일 때 좋다. 역할 다섯·화면 몇 개에는 표가 두 겹이 된다
  4. 컨트롤러(클래스) 단위 규칙 — 짧지만 같은 컨트롤러 안의 읽기·쓰기가 다른 역할이다(단말기 조회는 FIELD도, 등록은 OPERATOR만)
- 결정: 2. 규칙은 핸들러(메서드)에만 단다. `test/unit/access-table.spec.ts`가 앱 모듈 메타데이터를 훑어 모든 핸들러의 실제 규칙을 모으고 (a) 규칙 없는 핸들러가 0인지 (b) 아래 표(테스트의 `EXPECTED`)와 같은지 본다 — 엔드포인트가 생기거나 역할이 바뀌면 표도 같은 커밋에서 바꿔야 통과한다(권한 변경이 리뷰에 보이게).
- 역할 묶음(`src/auth/access.ts`): `STAFF` = ADMIN·OPERATOR·MONITOR·FIELD, `OFFICE` = ADMIN·OPERATOR·MONITOR, `ANY_ROLE` = 다섯 모두.
- 표(보강 2 끝 기준, Task 4·5가 더한 줄 포함):

  | 규칙 | 엔드포인트 |
  |---|---|
  | public | `GET /health`, `POST /auth/login` |
  | ANY_ROLE | `GET /auth/me`, `POST /auth/logout` |
  | device(단말기 키, 0055) | `POST /devices/heartbeats`, `POST /devices/firmware-reports` |
  | STAFF | `GET /terminals`, `GET /terminals/:serialNo`, `GET /terminals/:serialNo/history`, `GET /terminals/:serialNo/inspections`, `GET /terminal-models`, `GET /inspection-items`, `GET /purchase-orders`, `GET /purchase-orders/:poNo`, `GET /scans/:scanId` |
  | OFFICE | `GET /terminals/:serialNo/connectivity`, `GET /merchants`, `GET /inspections/stats`, `GET /purchase-orders/:poNo/reconciliation`, `GET /shipments/:id`, `GET /sync-runs`, `GET /service-tickets`, `GET /service-tickets/:id`, `GET /firmware-rollouts`, `GET /firmware-rollouts/:id`, `GET /anomaly-rules`, `GET /anomalies`, `GET /van-reconciliations`, `GET /van-reconciliations/:id`, `GET /reports/weekly`, `GET /reports/weekly/:weekStart`, `GET /reports/weekly/:weekStart/file`, `GET /dashboard/summary` |
  | OPERATOR·MONITOR(관제 작업) | `POST /anomaly-scans`, `POST /van-reconciliations`, `POST /reports/weekly` |
  | OPERATOR·FIELD(현장 작업) | `POST /scans`, `POST /terminals/:serialNo/inspections` |
  | OPERATOR | `POST /terminals`, `POST /terminals/imports`, `POST /terminals/:serialNo/transitions`, `POST /terminals/:serialNo/allocations`, `POST /terminals/:serialNo/allocation-cancellations`, `POST /shipments`, `POST /purchase-orders`, `POST /purchase-orders/:poNo/close`, `POST /service-tickets`, `POST /service-tickets/:id/remote-checks`, `POST /service-tickets/:id/replacements`, `POST /service-tickets/:id/installations`, `POST /firmware`, `POST /firmware-rollouts`, `POST /firmware-rollouts/:id/pause`, `POST /firmware-rollouts/:id/resume`, `POST /firmware-rollouts/:id/abort` |
  | MERCHANT(0053, Task 4) | `GET /me/terminals`, `GET /me/terminals/:serialNo`, `GET /me/service-tickets`, `POST /me/service-tickets`, `POST /me/service-tickets/:id/installations` |
  | ADMIN(Task 5) | `GET·POST /admin/accounts`, `PATCH /admin/accounts/:id`, `GET·POST /admin/partner-keys`, `POST /admin/partner-keys/:id/revoke` |
  | partner:scope(0054, Task 5) | `GET /partner/v1/terminals/:serialNo`(terminal-status:read), `GET /partner/v1/merchants/:merchantCode/terminals`(merchant-terminals:read) |

  고른 이유 몇 가지: FIELD는 박스 스캔 화면이 고르는 발주 목록과 단말기 조회가 필요해 STAFF에 넣고, 대시보드·리포트는 뺐다. 펌웨어 배포 멈춤·중단은 업무 상태를 바꾸므로 MONITOR에 주지 않았다. ADMIN은 업무 데이터를 읽기만 한다.
- 응답: 로그인 없음·세션 끝 401 `UNAUTHENTICATED`, 역할 밖 403 `FORBIDDEN`(메시지에 필요한 역할과 지금 역할), 규칙 없는 핸들러 403(코드 실수).
- 결과·대가: 엔드포인트 하나를 더할 때 데코레이터와 테스트 표 두 곳을 고친다(의도한 마찰). 역할을 하나 더하면 데코레이터 여러 곳을 바꾼다.
- 다시 볼 조건: 역할이 일곱을 넘거나 사용자별 권한이 필요하면 3(권한 단위). 같은 엔드포인트가 역할마다 다른 데이터를 줘야 하면(0053처럼) 엔드포인트를 나눈다.
````

`docs/decisions/0056-작업자는-로그인-아이디-X-Operator는-테스트-전용.md`:

````markdown
# 0056. 작업자는 로그인 아이디, X-Operator는 테스트 전용 인증 길로만 남긴다

- 날짜 / 관련 기능: 2026-10-28 / 보강 2, 이력·검수·스캔·배포의 actor(decisions/0001 대체), api 테스트 전체
- 상황: 쓰기 API 22곳이 `@Operator()`로 `X-Operator` 헤더의 이름을 작업자로 남겼다(0001). 이제 서버가 로그인한 사람을 안다. 기존 api 테스트 453개(파일 54개가 `t.http()`를 씀)는 GET을 헤더 없이, 쓰기를 `X-Operator: kim` 같은 헤더로 부르고 actor 약 20곳을 그 이름으로 단언한다.
- 선택지(actor):
  1. **로그인 아이디** — 계정마다 하나, 바꾸지 않는다(0051)
  2. 표시 이름 — 사람이 읽기 좋지만 바뀌고 겹친다(이력이 누구인지 흐려진다)
  3. 계정 id(숫자) — 이력만 보고는 누구인지 모른다, actor 열이 문자열(`system:<작업명>`과 같은 열)
- 선택지(헤더와 테스트):
  a. 헤더를 지우고 모든 테스트가 실제 로그인 — `resetDatabase`가 계정을 지우므로 파일마다 계정 생성(scrypt 약 140ms)·로그인, 54파일과 actor 단언 약 20곳 수정
  b. `Test.createTestingModule().overrideGuard()`로 테스트에서 가드를 바꿈 — 테스트가 가드 자체(401·403·기본 거부)를 지나지 않는다
  c. **테스트 전용 인증 길**: `AUTH_TEST_HEADERS=1`이면 가드가 세션 쿠키가 **없는** 요청을 `X-Operator`(로그인 아이디)·`X-Test-Role`(역할, 기본 OPERATOR)로 받아 준다. `createTestApp().http()`가 기본 사람 `tester`(OPERATOR)를 붙이고, 기존 `.set({ 'X-Operator': 'kim' })`이 그 사람을 kim으로 바꾼다. `http(null)`은 아무 헤더도 붙이지 않는다
- 결정: actor 1, 테스트 c.
  - `@Operator()`는 `req.principal.loginId`(가드가 넣음)를 돌려준다. 22곳 호출은 그대로. 시스템 작업의 `system:<작업명>`은 그대로.
  - 테스트 길은 가드 안에서만, 쿠키가 없을 때만 탄다(끝난 쿠키에 헤더를 붙여도 401). 이름 규칙은 예전 헤더와 같다(1~50자, `system:` 금지). MERCHANT는 이 길로 만들 수 없다(가맹점이 없다 — 실제 로그인으로).
  - 스위치 `AUTH_TEST_HEADERS`는 `NODE_ENV=test`가 아니면 켤 수 없다 — 켜려 하면 env를 읽는 순간(서버 시작) 던진다(`config/auth-test-headers.ts`, 단위 테스트). vitest 설정만 켠다.
  - 실제 쿠키 길은 새 e2e가 덮는다: `auth.e2e`(로그인·역할·로그아웃·실패 제한·계정 세션 끊기), Task 4 `me.e2e`, Task 5 `admin-accounts.e2e`·`partner-api.e2e`(`test/helpers/auth.ts`의 `createAccount`·`login`·`withCookie`).
  - 기존 테스트 수정은 "작업자 헤더가 없으면 400"을 보던 다섯 줄(→ `http(null)`로 401)뿐.
- 결과·대가: 운영과 기존 테스트의 인증 길이 다르다(테스트는 헤더). 가드의 역할 판단·기본 거부는 두 길이 같은 코드를 지난다. 스위치를 운영에 실수로 넣으면 서버가 뜨지 않는다.
- 다시 볼 조건: 테스트에서 헤더 길과 쿠키 길의 동작 차이로 놓친 버그가 생기면 해당 테스트를 쿠키로 옮긴다. CI가 생기면 `NODE_ENV=test` 밖에서 스위치가 꺼져 있는지 한 번 더 본다.
````

`docs/study/backlog.md` 끝에:

```markdown
- [ ] 세션 대 JWT — 로그아웃·강제 만료·권한 변경 반영, 거부 목록이 결국 상태를 만드는 이유, 쿠키 SameSite(Lax·Strict·None)와 "같은 사이트"의 범위(localhost 포트) (decisions/0050)
- [ ] Nest 가드·Reflector·SetMetadata와 APP_GUARD, 모듈 메타데이터를 훑어 라우트 표 만들기 (decisions/0052)
```

- [ ] **Step 13: 색인·devlog·커밋·시각 맞추기**

`node scripts/docs-index.mjs && node scripts/docs-index.mjs --check`. devlog 항목:

```markdown
## HH:MM Task 2 세션·로그인·전역 가드·역할 표 (커밋 <해시>)
- 이전 커밋: <Task 1 해시>
- 한 일: Redis 서버 세션(`sid` httpOnly·SameSite=Strict, 토큰 SHA-256 키, GETEX 유휴 8시간, 계정 색인 SET), `/auth/login·logout·me`, 아이디별 실패 제한(5번/15분 → 429), 전역 가드(규칙 없으면 403), 기존 컨트롤러 18개 접근 규칙, `@Operator()` = 로그인 아이디, 테스트 전용 인증 길(`AUTH_TEST_HEADERS`, NODE_ENV=test만)과 `createTestApp().http(identity | null)`
- 확인: 새 테스트 3파일 22개, 기존 테스트 수정 다섯 줄(400 → 401), api 전체 71/483(Duration …s, Connection is closed 0), 접근 표 빠뜨림 확인 출력(Step 10)
- 결정: decisions/0050(세션), 0052(역할 표·기본 거부), 0056(작업자·테스트 전략)
- 막힌 것: …
- 다음: Task 3 단말기 키
```

```bash
git add apps/api docs
git status --short
git commit -m "feat(auth): 로그인 세션과 역할 — Redis 세션·httpOnly 쿠키, 전역 가드 기본 거부, 엔드포인트 역할 표, 작업자는 로그인 아이디

Refs: docs/decisions/0050-로그인은-Redis-서버-세션과-httpOnly-쿠키로.md, docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md, docs/decisions/0056-작업자는-로그인-아이디-X-Operator는-테스트-전용.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Task 1 Step 14와 같이 devlog 제목 시각·해시를 커밋에 맞추고 amend.

### Task 3: 단말기 키 — 가드, env, device-sim, 실험 0017

**Files:**
- Modify: `.env.example`(그리고 커밋하지 않는 `.env`에 같은 줄), `apps/api/src/config/env.ts`, `apps/api/src/auth/auth.guard.ts`, `apps/api/vitest.config.ts`, `apps/api/test/helpers/test-app.ts`
- Test: Create `apps/api/test/device-auth.e2e.spec.ts`
- Modify: `apps/device-sim/src/{config,client,fleet,server}.ts`, `apps/device-sim/test/helpers.ts`; Test: Create `apps/device-sim/test/device-key.spec.ts`
- Docs: `docs/decisions/0055-단말기는-공유-단말기-키로.md`, `docs/experiments/0017-인증-뒤-하트비트-처리량.md`, `docs/index.md`, `docs/devlog/2026-10-28.md`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`apps/api/test/device-auth.e2e.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('단말기 키 (보강 2, decisions/0055)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  afterAll(async () => {
    await t.app.close();
  });

  const beat = { items: [{ serialNo: 'DK-0001', firmwareVersion: '1.0.0' }] };

  it.each(['/devices/heartbeats', '/devices/firmware-reports'])('%s: 키가 없거나 틀리면 401 UNAUTHENTICATED', async (path) => {
    const none = await t.http(null).post(path).send(beat);
    expect(none.status).toBe(401);
    expect(none.body.code).toBe('UNAUTHENTICATED');
    expect((await t.http(null).post(path).set('X-Device-Key', `${env.deviceApiKey}x`).send(beat)).status).toBe(401);
    expect((await t.http(null).post(path).set('X-Device-Key', env.deviceApiKey.slice(0, -1)).send(beat)).status).toBe(401);
  });

  it('맞는 키면 사람 로그인 없이 받는다(하트비트 행별 결과)', async () => {
    const res = await t.http(null).post('/devices/heartbeats').set('X-Device-Key', env.deviceApiKey).send(beat);
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });

  it('사람 세션·테스트 헤더만으로는 단말기 API를 부를 수 없다', async () => {
    expect((await t.http(null).post('/devices/heartbeats').set('X-Operator', 'kim').send(beat)).status).toBe(401);
  });

  it('단말기 키로는 사람 API를 부를 수 없다', async () => {
    expect((await t.http(null).get('/terminals').set('X-Device-Key', env.deviceApiKey)).status).toBe(401);
  });
});
```

`apps/device-sim/test/helpers.ts`(가짜 api가 요청 헤더를 남기게):

```diff
--- a/apps/device-sim/test/helpers.ts
+++ b/apps/device-sim/test/helpers.ts
@@ -8,6 +8,8 @@ export interface ReceivedRequest {
   body: Record<string, unknown>;
   /** 요청이 온 소켓(클라이언트 포트). keep-alive면 같은 값이 되풀이된다 */
   remotePort: number;
+  /** 요청 헤더(이름은 소문자) */
+  headers: IncomingMessage['headers'];
 }
 
 type Handler = (req: ReceivedRequest, res: ServerResponse) => Promise<void> | void;
@@ -29,7 +31,7 @@ export async function startFakeApi(handler: Handler = okHandler) {
       inFlight += 1;
       maxInFlight = Math.max(maxInFlight, inFlight);
       try {
-        const r = { path: req.url ?? '', body: (await readJson(req)) ?? {}, remotePort: req.socket.remotePort ?? 0 };
+        const r = { path: req.url ?? '', body: (await readJson(req)) ?? {}, remotePort: req.socket.remotePort ?? 0, headers: req.headers };
         received.push(r);
         await current(r, res);
       } finally {
```

`apps/device-sim/test/device-key.spec.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultConfig, type SimConfig } from '../src/config.js';
import { Fleet } from '../src/fleet.js';
import { okHandler, startFakeApi, startSim, type FakeApi } from './helpers.js';

describe('단말기 키 X-Device-Key (api decisions/0055)', () => {
  let api: FakeApi;
  let fleet: Fleet | undefined;
  const config = (patch: Partial<SimConfig>): SimConfig => ({ ...defaultConfig(), targetUrl: api.url, ...patch });

  beforeAll(async () => {
    api = await startFakeApi();
  });
  afterEach(async () => {
    await fleet?.close();
    fleet = undefined;
    api.received.length = 0;
    api.setHandler(okHandler);
    vi.unstubAllEnvs();
  });
  afterAll(() => api.close());

  it('키가 있으면 모든 하트비트 요청에 X-Device-Key, 없으면 헤더를 보내지 않는다', async () => {
    fleet = new Fleet(config({ count: 3, batchSize: 2, deviceKey: 'sim-key-0123456789' }));
    await fleet.tick();
    expect(api.received.map((r) => r.headers['x-device-key'])).toEqual(['sim-key-0123456789', 'sim-key-0123456789']);
    await fleet.close();
    api.received.length = 0;
    fleet = new Fleet(config({ count: 1, deviceKey: '' }));
    await fleet.tick();
    expect(api.received[0].headers['x-device-key']).toBeUndefined();
  });

  it('기본 키는 환경변수 DEVICE_API_KEY', () => {
    vi.stubEnv('DEVICE_API_KEY', 'env-key-0123456789');
    expect(defaultConfig().deviceKey).toBe('env-key-0123456789');
  });

  it('관리 API는 키를 받지만 보여 줄 때는 "(설정됨)"으로 가린다', async () => {
    const sim = await startSim();
    try {
      const res = await sim.post('/__admin/config', { targetUrl: api.url, deviceKey: 'secret-key-0123456789' });
      expect(res.status).toBe(200);
      const text = JSON.stringify(await res.json()) + JSON.stringify(await sim.get('/__admin/config'));
      expect(text).not.toContain('secret-key-0123456789');
      expect((await sim.get('/__admin/config')).deviceKey).toBe('(설정됨)');
      expect(sim.fleet.config.deviceKey).toBe('secret-key-0123456789');
      expect((await sim.post('/__admin/config', { deviceKey: 5 })).status).toBe(400);
    } finally {
      await sim.close();
    }
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run(`apps/api`): `npx vitest run test/device-auth.e2e.spec.ts` → Expected: FAIL — 키가 없어도 200(단말기 API가 아직 열려 있다), `env.deviceApiKey`가 아직 없어 `.slice`에서 `TypeError: Cannot read properties of undefined`.
Run(`apps/device-sim`): `npx vitest run test/device-key.spec.ts` → Expected: FAIL(`x-device-key`가 `undefined`, 관리 API의 `deviceKey`는 알 수 없는 설정 키라 400).

- [ ] **Step 3: env와 `.env.example`**

`.env.example` 끝에(값은 로컬 시연 전용 테스트 값 — Task 4·5가 쓰는 세션·로그인 제한 값도 여기서 함께 적는다):

```diff
--- a/.env.example
+++ b/.env.example
@@ -72,3 +72,13 @@ OUTBOX_REQUEUE_INTERVAL_MS=60000
 OUTBOX_REQUEUE_AFTER_MS=60000
 # 처음 화면 대시보드 집계 Redis 캐시 TTL(ms) — decisions/0044 (화면 문구는 "기본 30초"라 바꾸면 화면 안내와 어긋난다)
 DASHBOARD_CACHE_TTL_MS=30000
+
+# 보강 2: 로그인·권한 — decisions/0050~0056 (값은 모두 로컬 시연 전용 테스트 값)
+# 단말기(시뮬레이터)가 X-Device-Key로 보내는 공유 키(16자 이상). api와 device-sim이 같은 값을 읽는다
+DEVICE_API_KEY=demo-device-NTLP5MxPGtlzOw4KTaNDvFy209xRlty7
+# 로그인 세션 유휴 만료(ms, 기본 8시간), 쿠키 Secure(https 뒤에서만 1)
+SESSION_IDLE_TTL_MS=28800000
+SESSION_COOKIE_SECURE=0
+# 같은 아이디로 로그인 실패 N번이면 LOGIN_LOCK_MS 동안 막는다
+LOGIN_MAX_FAILURES=5
+LOGIN_LOCK_MS=900000
```

같은 줄들을 저장소 `.env` 끝에도 덧붙인다(Edit — `.env`는 커밋하지 않는다). `.env`에 `DEVICE_API_KEY`가 없으면 이 Task 뒤로 api·마이그레이션·시드 스크립트가 `환경변수 DEVICE_API_KEY가 없습니다`로 멈춘다(사전 검증에서 Task 5의 `db:migration:create`가 이렇게 멈췄다).

`apps/api/src/config/env.ts`:

```diff
--- a/apps/api/src/config/env.ts
+++ b/apps/api/src/config/env.ts
@@ -16,6 +16,13 @@ function required(name: string): string {
   return value;
 }
 
+/** 비밀 값(키). 없거나 너무 짧으면 시작할 때 던진다 */
+function requiredSecret(name: string, minLength: number): string {
+  const value = required(name);
+  if (value.length < minLength) throw new Error(`환경변수 ${name}는 ${minLength}자 이상이어야 합니다.`);
+  return value;
+}
+
 function flag(name: string, fallback: boolean): boolean {
   const value = process.env[name];
   return value === undefined ? fallback : value === '1' || value === 'true';
@@ -142,6 +149,8 @@ export const env = {
   /** 같은 아이디로 로그인 실패가 이만큼 쌓이면 LOGIN_LOCK_MS 동안 막는다(첫 실패부터 잰다, decisions/0050) */
   loginMaxFailures: intFromEnv('LOGIN_MAX_FAILURES', 5, { min: 1, max: 100 }),
   loginLockMs: intFromEnv('LOGIN_LOCK_MS', 15 * 60_000, MS),
+  /** 단말기(시뮬레이터)가 `X-Device-Key`로 보내는 공유 키. 16자 이상(decisions/0055) */
+  deviceApiKey: requiredSecret('DEVICE_API_KEY', 16),
   /** 테스트 전용 인증 헤더(X-Operator·X-Test-Role). NODE_ENV=test가 아니면 켜지지 않고 던진다(decisions/0056) */
   authTestHeaders: resolveAuthTestHeaders(process.env.AUTH_TEST_HEADERS, process.env.NODE_ENV),
   /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
```

`apps/api/vitest.config.ts`:

```diff
--- a/apps/api/vitest.config.ts
+++ b/apps/api/vitest.config.ts
@@ -22,6 +22,8 @@ export default defineConfig({
       RUN_SCHEDULERS: '0',
       // 테스트 전용 인증 헤더(X-Operator·X-Test-Role, decisions/0056). NODE_ENV=test일 때만 켜진다
       AUTH_TEST_HEADERS: '1',
+      // 단말기 키(decisions/0055) — 테스트 값. createTestApp의 기본 요청과 startDeviceSim(환경변수 상속)이 이 값을 보낸다
+      DEVICE_API_KEY: 'test-device-key-0123456789',
     },
   },
   // swc가 데코레이터 메타데이터를 만들어야 Nest DI가 동작한다.
```

- [ ] **Step 4: 가드의 단말기 길과 테스트 도우미**

`apps/api/src/auth/auth.guard.ts`:

```diff
--- a/apps/api/src/auth/auth.guard.ts
+++ b/apps/api/src/auth/auth.guard.ts
@@ -1,3 +1,4 @@
+import { createHash, timingSafeEqual } from 'node:crypto';
 import { type CanActivate, type ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
 import { Reflector } from '@nestjs/core';
 import type { ApiErrorBody } from '@terminal-ops/contracts';
@@ -13,6 +14,8 @@ const UNAUTHENTICATED: ApiErrorBody = { statusCode: 401, code: 'UNAUTHENTICATED'
 /** 테스트 전용 헤더(decisions/0056). 기존 테스트의 `X-Operator: kim`이 그대로 로그인 아이디 kim(OPERATOR)이 된다 */
 export const TEST_OPERATOR_HEADER = 'x-operator';
 export const TEST_ROLE_HEADER = 'x-test-role';
+/** 단말기 키 헤더(decisions/0055) */
+export const DEVICE_KEY_HEADER = 'x-device-key';
 
 function decodeName(raw: string): string {
   try {
@@ -34,10 +37,12 @@ export function testPrincipal(operator: string | undefined, role: string | undef
 /**
  * 모든 HTTP 요청의 문(APP_GUARD, decisions/0052). 핸들러의 Access 메타데이터대로:
  * 없음 → 403(기본 거부), public → 통과, roles → 세션 쿠키의 사람이 그 역할이어야(없으면 401, 역할 밖이면 403),
- * device → 단말기 키(Task 3에서 붙인다).
+ * device → `X-Device-Key`가 DEVICE_API_KEY와 같아야(없거나 틀리면 401, decisions/0055).
  */
 @Injectable()
 export class AuthGuard implements CanActivate {
+  private readonly deviceKeyDigest = createHash('sha256').update(env.deviceApiKey).digest();
+
   constructor(
     private readonly reflector: Reflector,
     private readonly sessions: SessionStore,
@@ -54,7 +59,10 @@ export class AuthGuard implements CanActivate {
       case 'public':
         return true;
       case 'device':
-        return true; // 단말기 키 검사는 Task 3(decisions/0055)에서 붙인다
+        if (!this.deviceKeyMatches(req.header(DEVICE_KEY_HEADER))) {
+          throw new UnauthorizedException({ statusCode: 401, code: 'UNAUTHENTICATED', message: '단말기 키(X-Device-Key)가 없거나 맞지 않습니다.' } satisfies ApiErrorBody);
+        }
+        return true;
       case 'roles': {
         const principal = await this.principal(req);
         if (!principal) throw new UnauthorizedException(UNAUTHENTICATED);
@@ -71,6 +79,12 @@ export class AuthGuard implements CanActivate {
     }
   }
 
+  /** 단말기 키 비교. 길이가 달라도 같은 시간이 들게 양쪽을 SHA-256으로 바꿔 timingSafeEqual(요청마다 해시 하나 — 실험 0017) */
+  private deviceKeyMatches(given: string | undefined): boolean {
+    if (!given) return false;
+    return timingSafeEqual(createHash('sha256').update(given).digest(), this.deviceKeyDigest);
+  }
+
   /** 세션 쿠키가 있으면 그것만 본다(끝난 세션이면 null — 헤더로 넘어가지 않는다). 없을 때만, 테스트에서만 헤더 */
   private async principal(req: RequestWithPrincipal): Promise<Principal | null> {
     const token = readCookie(req.headers.cookie, SESSION_COOKIE);
```

`apps/api/test/helpers/test-app.ts`(기본 요청에 단말기 키도 — 하트비트를 부르는 기존 테스트가 그대로 돈다. `startDeviceSim`은 vitest env를 물려받아 키를 안다):

```diff
--- a/apps/api/test/helpers/test-app.ts
+++ b/apps/api/test/helpers/test-app.ts
@@ -4,6 +4,7 @@ import type { INestApplication } from '@nestjs/common';
 import { MikroORM } from '@mikro-orm/mysql';
 import request from 'supertest';
 import { AppModule } from '../../src/app.module.js';
+import { env } from '../../src/config/env.js';
 import { seedReference } from '../../src/db/seed-reference.js';
 
 /**
@@ -19,7 +20,7 @@ export interface TestApp {
   app: INestApplication;
   orm: MikroORM;
   /**
-   * supertest 에이전트. 기본으로 DEFAULT_IDENTITY 헤더를 붙인다. `http(null)`은 아무 헤더도 붙이지 않는다(로그인 안 한 요청, 쿠키 로그인).
+   * supertest 에이전트. 기본으로 DEFAULT_IDENTITY 헤더와 단말기 키(X-Device-Key)를 붙인다. `http(null)`은 아무 헤더도 붙이지 않는다(로그인 안 한 요청, 쿠키 로그인).
    * 에이전트는 부를 때마다 새로 만든다 — 쿠키가 다음 요청으로 새지 않는다.
    */
   http: (identity?: TestIdentity | null) => ReturnType<typeof request>;
@@ -38,7 +39,8 @@ export async function createTestApp(options: { workers?: boolean } = {}): Promis
   const orm: MikroORM = app.get(MikroORM);
   const http = (identity: TestIdentity | null = DEFAULT_IDENTITY) => {
     const agent = request.agent(app.getHttpServer());
-    if (identity) agent.set(identity);
+    // 사람 헤더와 함께 단말기 키도 붙인다(단말기 API를 부르는 기존 테스트가 그대로 돌게, decisions/0055). 사람 API는 이 헤더를 보지 않는다
+    if (identity) agent.set({ ...identity, 'X-Device-Key': env.deviceApiKey });
     return agent;
   };
   return { app, orm, http };
```

- [ ] **Step 5: device-sim이 키를 보낸다**

```diff
--- a/apps/device-sim/src/config.ts
+++ b/apps/device-sim/src/config.ts
@@ -2,6 +2,8 @@
 export interface SimConfig {
   /** 하트비트를 보낼 API 주소(예: http://127.0.0.1:3000) */
   targetUrl: string;
+  /** API의 단말기 키(`X-Device-Key`, api decisions/0055). 기본은 환경변수 DEVICE_API_KEY. 비면 헤더를 보내지 않는다(API가 401) */
+  deviceKey: string;
   /** 단말기 시리얼 목록. 비어 있으면 serialPrefix·serialStart·count로 만든다(`HB-0001` …) */
   serials: string[];
   serialPrefix: string;
@@ -38,6 +40,7 @@ export type SimConfigPatch = Partial<SimConfig>;
 export function defaultConfig(): SimConfig {
   return {
     targetUrl: 'http://127.0.0.1:3000',
+    deviceKey: process.env.DEVICE_API_KEY ?? '',
     serials: [],
     serialPrefix: 'HB',
     serialStart: 1,
@@ -56,6 +59,11 @@ export function defaultConfig(): SimConfig {
   };
 }
 
+/** 관리 API가 보여 주는 설정 — 단말기 키는 있는지만 보인다(`(설정됨)`) */
+export function publicConfig(config: SimConfig): SimConfig {
+  return { ...config, deviceKey: config.deviceKey ? '(설정됨)' : '' };
+}
+
 /** 단말기 시리얼 목록 */
 export function serialsOf(config: SimConfig): string[] {
   if (config.serials.length > 0) return [...config.serials];
@@ -72,6 +80,7 @@ type Rule =
 /** 설정 키마다 형식·범위. 새 설정 키는 여기에 한 줄을 더해야 관리 API가 받는다(알 수 없는 키는 400) */
 export const CONFIG_RULES: Record<keyof SimConfig, Rule> = {
   targetUrl: { type: 'url' },
+  deviceKey: { type: 'string' },
   serials: { type: 'strings', max: MAX_DEVICES },
   serialPrefix: { type: 'string', nonEmpty: true },
   serialStart: { type: 'int', min: 0, max: 1_000_000_000 },
```

```diff
--- a/apps/device-sim/src/client.ts
+++ b/apps/device-sim/src/client.ts
@@ -29,6 +29,8 @@ export class ApiClient {
     private readonly baseUrl: string,
     maxSockets: number,
     private readonly timeoutMs: number,
+    /** 요청마다 붙일 헤더(단말기 키 X-Device-Key) */
+    private readonly headers: Record<string, string> = {},
   ) {
     new URL(baseUrl); // 주소가 틀리면 여기서 바로 던진다(설정을 바꾸는 중이면 이전 설정이 남는다)
     this.agent = new Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets });
@@ -47,7 +49,7 @@ export class ApiClient {
         {
           method: 'POST',
           agent: this.agent,
-          headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
+          headers: { ...this.headers, 'Content-Type': 'application/json', 'Content-Length': payload.length },
           timeout: this.timeoutMs,
         },
         (res) => {
```

```diff
--- a/apps/device-sim/src/fleet.ts
+++ b/apps/device-sim/src/fleet.ts
@@ -104,7 +104,7 @@ export class Fleet {
         updating: this.updating.has(serialNo),
       });
     }
-    const client = new ApiClient(config.targetUrl, config.concurrency, config.requestTimeoutMs);
+    const client = new ApiClient(config.targetUrl, config.concurrency, config.requestTimeoutMs, config.deviceKey ? { 'X-Device-Key': config.deviceKey } : {});
     this.client?.close();
     this.client = client;
     this.config = config;
```

```diff
--- a/apps/device-sim/src/server.ts
+++ b/apps/device-sim/src/server.ts
@@ -1,5 +1,5 @@
 import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
-import { defaultConfig, invalidPatchReason, invalidReason, type SimConfig } from './config.js';
+import { defaultConfig, invalidPatchReason, invalidReason, publicConfig, type SimConfig } from './config.js';
 import { Fleet } from './fleet.js';
 import { BadJsonError, readJson, sendJson } from './http.js';
 
@@ -21,7 +21,7 @@ async function route(fleet: Fleet, serialize: Serialize, req: IncomingMessage, r
   let m: RegExpMatchArray | null;
 
   if (method === 'GET' && path === '/__admin/health') return sendJson(res, 200, { status: 'ok' });
-  if (method === 'GET' && path === '/__admin/config') return sendJson(res, 200, fleet.config);
+  if (method === 'GET' && path === '/__admin/config') return sendJson(res, 200, publicConfig(fleet.config));
   if (method === 'POST' && path === '/__admin/config') {
     const patch = (await readJson(req)) ?? {};
     const patchReason = invalidPatchReason(patch);
@@ -40,7 +40,7 @@ async function route(fleet: Fleet, serialize: Serialize, req: IncomingMessage, r
       } finally {
         if (wasRunning) fleet.start();
       }
-      return sendJson(res, 200, fleet.config);
+      return sendJson(res, 200, publicConfig(fleet.config));
     });
   }
   if (method === 'POST' && path === '/__admin/start') {
@@ -58,7 +58,7 @@ async function route(fleet: Fleet, serialize: Serialize, req: IncomingMessage, r
   if (method === 'POST' && path === '/__admin/reset') {
     return serialize(async () => {
       await fleet.reset(defaultConfig());
-      return sendJson(res, 200, fleet.config);
+      return sendJson(res, 200, publicConfig(fleet.config));
     });
   }
   if (method === 'GET' && path === '/__admin/stats') return sendJson(res, 200, { running: fleet.running, ...fleet.stats.view() });
```

- [ ] **Step 6: 통과 확인**

Run(`apps/device-sim`): `npx tsc --noEmit -p tsconfig.json && npx vitest run 2>&1 | grep -E "Test Files|Tests "`
Expected: tsc 0, `Test Files  5 passed (5)`, `Tests  43 passed (43)`.

Run(`apps/api`): `npm run typecheck && npx vitest run test/device-auth.e2e.spec.ts test/heartbeat.e2e.spec.ts test/device-sim.e2e.spec.ts test/firmware-control.e2e.spec.ts test/connectivity.e2e.spec.ts 2>&1 | grep -E "Test Files|Tests "`
Expected: typecheck 0, `Test Files  5 passed (5)`, `Tests  44 passed (44)`(device-auth 5개 포함). api 전체는 72/488이 된다(Task 4 끝 전체 실행에서 함께 확인해도 된다 — 여기서 돌리면 적는다).

- [ ] **Step 7: 실험 0017 — 인증 뒤 하트비트 처리량**

질문: 전역 가드와 단말기 키 검사가 실험 0008의 하트비트 처리량을 깨는가? 기준(재기 전에 정함): 기본 부하(5,000대·5초·30초)에서 받음 = 보냄·오류 0이 유지되고, 단건 최대 처리량 감소가 10% 안이면 공유 키 방식을 그대로 둔다.

이 Task의 커밋 전 작업 트리(인증 있음)와 master(인증 없음)를 **번갈아** 잰다 — 같은 코드도 시간에 따라 20% 가까이 달라졌다(사전 검증: master 4,800/s → 30분 뒤 4,020/s). master를 따로 체크아웃하려면 작업 트리를 `git worktree add ../tok-master 7487fe4`로 따로 만든다(앱별 `npm ci` 필요 — 약 10초씩). 브랜치를 오가면 테스트 DB를 다시 만든다(troubleshooting/0030). 재현(Git Bash, 각 트리의 `apps/api`에서):

```bash
# 기본 부하(각 2회): 받음/보냄, p50·p95
EXP_VARIANTS=redis-batch,redis-single EXPERIMENTS=1 npx vitest run test/experiments/heartbeat-load.spec.ts --silent=false 2>&1 | grep -E "\[실험 0008/|Tests "
# 단건 최대(주기 100ms, 20초): 두 트리를 번갈아 3번씩
EXP_VARIANTS=redis-single EXP_INTERVAL_MS=100 EXP_DURATION_MS=20000 EXP_LOOSE=1 EXPERIMENTS=1 npx vitest run test/experiments/heartbeat-load.spec.ts --silent=false 2>&1 | grep -E "\[실험 0008/redis-single\] (N|응답)"
# 묶음 최대(주기 20ms, 20초): 각 2회
EXP_VARIANTS=redis-batch EXP_INTERVAL_MS=20 EXP_DURATION_MS=20000 EXP_LOOSE=1 EXPERIMENTS=1 npx vitest run test/experiments/heartbeat-load.spec.ts --silent=false 2>&1 | grep -E "\[실험 0008/redis-batch\] (N|응답)"
```

사전 검증 값(같은 PC, 2026-10-28 00:30~00:55, 테스트 DB): 아래 기록 초안의 표. 이번 실행에서 다시 잰 값을 표 옆에 더하고(최소: 기본 부하 각 1회 + 단건 최대 번갈아 2번씩), 결론이 같은지 적는다. 끝나면 `git worktree remove ../tok-master`, node PID 목록이 시작과 같은지, 3000·4011·4021 리스너가 없는지 본다.

`docs/experiments/0017-인증-뒤-하트비트-처리량.md`(이번 실행 값을 더해 완성한다):

````markdown
# 0017. 인증(전역 가드 + 단말기 키) 뒤 하트비트 처리량

- 날짜 / 관련 기능: 2026-10-28 / F8, 보강 2(decisions/0055·0052), 실험 0008 다시 재기
- 질문:
  1. 전역 가드와 단말기 키 검사(요청마다 SHA-256 하나 + timingSafeEqual)를 더해도 5,000대·5초 주기(초당 1,000건)를 다 받는가?
  2. 요청 하나에 드는 비용이 처리량 한계를 얼마나 낮추나(단건·묶음)?
- 채택 기준(재기 전에 정함): 기본 부하에서 받음 = 보냄·오류 0, 단건 최대 처리량 감소 10% 안이면 공유 키 그대로(decisions/0055).
- 설정: 실험 0008과 같다 — `apps/api/test/experiments/heartbeat-load.spec.ts`(EXPERIMENTS=1), 테스트 앱 한 프로세스(워커·스케줄러 꺼짐, `t.app.listen(0)`), device-sim 별도 프로세스(`startDeviceSim`, 포트 4021, vitest env의 `DEVICE_API_KEY`를 물려받아 `X-Device-Key`를 보냄), 동시 16·keep-alive, Redis 경로. 단건 = 요청마다 하트비트 1개, 묶음 = 100개. 로컬 한 PC(Windows 11, 논리 16), Docker MySQL 8.4·Redis 7.4, 테스트 DB.
  - 전(인증 없음) = master 7487fe4, 후 = 보강 2 Task 3 코드(사전 검증 복제본).
- 재현: 계획 `docs/plans/2026-10-28-auth-roles.md` Task 3 Step 7의 명령. 번갈아 재기는 두 작업 트리에서 한 번씩 차례로(트리를 바꿀 때 테스트 DB를 다시 만듦).

## 결과

### 기본 부하(N=5,000, 주기 5초, 30초) — 2회씩

| 변형 | 전: 받음/보냄 | 전: p50 / p95 ms | 후: 받음/보냄 | 후: p50 / p95 ms |
|---|---|---|---|---|
| redis-batch(요청 300) | 30,000/30,000 ×2 | 16.5·15.4 / 37.7·36.6 | 30,000/30,000 ×2 | 13.5·15.4 / 34.8·39.2 |
| redis-single(요청 30,000) | 30,000/30,000 ×2 | 3.8·3.6 / 5.9·5.9 | 30,000/30,000 ×2 | 3.7·3.7 / 6.0·6.2 |

오류 0, MySQL 앱 쓰기 30문장(스냅샷), Redis 명령 합 같음(단건 120,034~120,040) — 가드는 Redis·MySQL 명령을 더하지 않는다(세션 조회는 사람 API에서만).

### 단건 최대(주기 100ms, 20초, LOOSE) — 번갈아 3라운드

| 라운드 | 전 처리량/s · p50 · p95 | 후 처리량/s · p50 · p95 |
|---|---|---|
| 1 | 4,022 · 3.4 · 5.4 | 3,872 · 3.6 · 5.6 |
| 2 | 4,006 · 3.4 · 5.4 | 3,770 · 3.6 · 5.7 |
| 3 | 4,041 · 3.4 · 5.3 | 3,829 · 3.6 · 5.7 |
| 평균 | 4,023 | 3,824(−4.9%) |

(번갈아 재기 전에 차례로 잰 값: 전 4,802·4,798/s, 후 4,507·4,513/s, 단말기 키 검사 없는 가드만 3,990·4,010/s(가장 늦게 잼) — 시간이 지날수록 같은 코드도 느려져 이 값끼리는 비교하지 않는다.)

### 묶음 최대(주기 20ms, 20초, LOOSE) — 2회씩

| | 처리량/s | p50 / p95 ms |
|---|---|---|
| 전 | 98,832 · 96,621 | 9.4·9.6 / 12.1·12.7 |
| 후 | 99,194 · 101,272 | 8.6·8.6 / 11.8·11.7 |

(이번 실행 값: …)

## 결론

- 기본 부하는 인증 뒤에도 다 받는다(오류 0, p95 차이는 회차 사이 차이 안). 0008의 결론(Redis 경로, 묶음 보내기)은 그대로다.
- 요청 하나에 약 0.2ms(동시 16에서 p50 3.4 → 3.6ms)가 더 들어 단건 최대 처리량이 약 5% 줄었다. 묶음 100에서는 요청 수가 1/100이라 차이가 잡음에 묻힌다. 기준(10% 안)에 들어 공유 키를 그대로 둔다(decisions/0055). 시뮬레이터 기본 묶음은 100이다.
- 한계: 닫힌 루프(동시 16 상한)라 처리량은 16 / 응답 시간이다. 0.2ms 중 가드(Reflector 조회·분기)와 SHA-256의 몫을 나눠 재지 않았다(가드만 있는 측정은 번갈아 재지 않아 비교하지 않음). 같은 PC의 다른 일·온도에 따라 같은 코드가 20% 가까이 달라졌다 — 번갈아 잰 값만 믿는다.
````

- [ ] **Step 8: 결정 기록 0055**

`docs/decisions/0055-단말기는-공유-단말기-키로.md`:

````markdown
# 0055. 단말기는 공유 단말기 키(X-Device-Key)로 부른다

- 날짜 / 관련 기능: 2026-10-28 / F8(하트비트·펌웨어 보고), 보강 2, apps/device-sim
- 상황: `POST /devices/heartbeats`·`POST /devices/firmware-reports`는 사람이 아니라 단말기가 부르고, 지금은 아무나 부를 수 있다(0001과 같은 이유로 미뤘다). 시뮬레이터 한 프로세스가 5,000대를 흉내 내며 한 요청에 여러 단말기의 하트비트를 묶어 보낸다(최대 500개). 실험 0008(초당 1,000건)의 성능과 시연 단순성을 지켜야 한다.
- 선택지:
  1. **공유 단말기 키** — env `DEVICE_API_KEY` 하나, 요청 헤더 `X-Device-Key`. 장점: 요청마다 비교 한 번, 저장소 조회 없음, 시연 설정이 한 줄. 단점: 키 하나가 새면 모든 단말기를 사칭, 단말기 하나만 막을 수 없음, 묶음 안의 시리얼은 여전히 믿는다
  2. 단말기별 비밀(발급·DB 저장) — 장점: 단말기별 폐기. 단점: 발급 절차·저장소 조회, 묶음 요청이면 항목마다 비밀을 실어야 해 요청 모양과 0008 부하가 바뀐다
  3. 단말기별 파생 토큰(HMAC(마스터 키, 시리얼)) — 장점: 저장 없이 단말기별. 단점: 묶음 항목마다 HMAC(최대 500번/요청), 마스터 키가 새면 같다, 폐기 목록이 따로 필요
  4. mTLS(단말기 인증서) — 실제 결제 단말기에 가깝지만 로컬 시연·Node http 설정 범위를 넘는다
- 측정(실험 0017): 가드 + 키 검사로 단건 최대 처리량 −4.9%(번갈아 3라운드), 묶음 100은 차이 없음, 기본 부하 다 받음.
- 결정: 1. 비교는 양쪽을 SHA-256으로 바꿔 `timingSafeEqual`(길이가 달라도 같은 시간). 키는 16자 이상이어야 서버가 뜬다. device-sim은 설정 `deviceKey`(기본 환경변수 `DEVICE_API_KEY`)를 모든 요청 헤더에 싣고, 관리 API는 키를 `(설정됨)`으로 가려 보여 준다. 사람 세션·테스트 헤더로는 단말기 API를, 단말기 키로는 사람 API를 부를 수 없다(e2e).
- 결과·대가: 1의 단점 그대로(사칭·단말기별 폐기 불가·시리얼 위조). 키가 `.env`에 평문이다(로컬 시연 전용 값). 테스트는 vitest env의 테스트 키를 쓰고 `createTestApp().http()`가 기본으로 붙인다.
- 다시 볼 조건: 단말기를 하나씩 막아야 하는 요구(분실·도난), 묶음 대신 단말기마다 직접 보내는 구조로 바뀔 때(2·3), 실제 망에 내놓을 때(4 + HTTPS).
````

- [ ] **Step 9: 색인·devlog·커밋·시각 맞추기**

`node scripts/docs-index.mjs && node scripts/docs-index.mjs --check`. devlog 항목(한 일: 가드 단말기 길·env·device-sim `deviceKey`·관리 API 가림, 확인: device-sim 5/43·api 관련 e2e 44개(전체를 돌렸으면 72/488)·실험 0017 이번 값, 결정 0055, 실험 0017, 다음: Task 4).

```bash
git add .env.example apps/api apps/device-sim docs
git status --short   # .env가 없어야 한다
git commit -m "feat(auth, F8): 단말기 키 — X-Device-Key 가드, device-sim이 키를 보낸다, 실험 0017 하트비트 처리량

Refs: docs/decisions/0055-단말기는-공유-단말기-키로.md, docs/experiments/0017-인증-뒤-하트비트-처리량.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Task 1 Step 14와 같이 시각·해시를 맞추고 amend.

### Task 4: 가맹점주 범위 — `/me`, 서비스 scope, 범위 밖 404

**Files:**
- Create: `apps/api/src/merchant/merchant-scope.ts`, `apps/api/src/me/{me.dto,me.controller,me.module}.ts`
- Modify: `apps/api/src/terminal/terminal.service.ts`, `apps/api/src/service/service-ticket.service.ts`, `apps/api/src/service/replacement.service.ts`, `apps/api/src/service/service.module.ts`, `apps/api/src/app.module.ts`
- Test: Create `apps/api/test/me.e2e.spec.ts`; Modify `apps/api/test/unit/access-table.spec.ts`
- Docs: `docs/decisions/0053-가맹점주-범위는-me-전용-엔드포인트와-서비스-scope.md`, `docs/index.md`, `docs/devlog/2026-10-28.md`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`apps/api/test/me.e2e.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServiceTicket } from '../src/service/service-ticket.entity.js';
import { createAccount, login, withCookie } from './helpers/auth.js';
import { partners } from './helpers/partners.js';
import { prepareInService, registerInStock, transitionTo } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('가맹점주 범위 /me (보강 2, decisions/0053)', () => {
  let t: TestApp;
  let gangnam: string;
  let yeoksam: string;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await partners.reset();
    await prepareInService(t, 'ME-0001', 'GANGNAM-KIMBAP');
    await prepareInService(t, 'ME-0002', 'GANGNAM-KIMBAP');
    await prepareInService(t, 'ME-0003', 'YEOKSAM-CAFE');
    await registerInStock(t, 'ME-0101');
    await createAccount(t, 'owner-gangnam', 'MERCHANT', 'GANGNAM-KIMBAP');
    await createAccount(t, 'owner-yeoksam', 'MERCHANT', 'YEOKSAM-CAFE');
    gangnam = await login(t, 'owner-gangnam');
    yeoksam = await login(t, 'owner-yeoksam');
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('로그인하면 내 정보에 가맹점 코드가 있다', async () => {
    expect((await withCookie(t, gangnam).get('/auth/me')).body).toMatchObject({ role: 'MERCHANT', merchantCode: 'GANGNAM-KIMBAP' });
  });

  it('단말기 목록은 내 가맹점 것만. 가맹점 조건을 보내면 400(바꿀 수 없다)', async () => {
    const res = await withCookie(t, gangnam).get('/me/terminals');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { serialNo: string }) => i.serialNo).sort()).toEqual(['ME-0001', 'ME-0002']);
    expect(res.body.total).toBe(2);
    expect((await withCookie(t, gangnam).get('/me/terminals').query({ merchantCode: 'YEOKSAM-CAFE' })).status).toBe(400);
    expect((await withCookie(t, yeoksam).get('/me/terminals')).body.items.map((i: { serialNo: string }) => i.serialNo)).toEqual(['ME-0003']);
  });

  it('남의 단말기·재고 단말기 상세는 404(있는지도 알려 주지 않는다)', async () => {
    expect((await withCookie(t, gangnam).get('/me/terminals/ME-0001')).body).toMatchObject({ serialNo: 'ME-0001', merchantCode: 'GANGNAM-KIMBAP' });
    const other = await withCookie(t, gangnam).get('/me/terminals/ME-0003');
    expect(other.status).toBe(404);
    expect(other.body.message).toBe('단말기 ME-0003이(가) 없습니다.');
    expect((await withCookie(t, gangnam).get('/me/terminals/ME-0101')).status).toBe(404);
    expect((await withCookie(t, gangnam).get('/me/terminals/NOPE-1')).body.message).toBe('단말기 NOPE-1이(가) 없습니다.');
  });

  it('가맹점주는 일반 업무 API를 부를 수 없다(403)', async () => {
    for (const path of ['/terminals', '/terminals/ME-0001', '/service-tickets', '/dashboard/summary', '/merchants']) {
      expect((await withCookie(t, gangnam).get(path)).status, path).toBe(403);
    }
    expect((await withCookie(t, gangnam).post('/service-tickets').send({ serialNo: 'ME-0001', symptom: 'x' })).status).toBe(403);
  });

  it('운영자 등 다른 역할은 /me를 부를 수 없다(403)', async () => {
    expect((await t.http().get('/me/terminals')).status).toBe(403);
  });

  it('A/S 접수는 내 단말기만 — 남의 단말기는 404이고 접수가 생기지 않는다. openedBy는 가맹점주 아이디', async () => {
    const mine = await withCookie(t, gangnam).post('/me/service-tickets').send({ serialNo: 'ME-0001', symptom: '카드 인식 불가' });
    expect(mine.status).toBe(201);
    expect(mine.body).toMatchObject({ serialNo: 'ME-0001', merchantCode: 'GANGNAM-KIMBAP', status: 'OPEN', openedBy: 'owner-gangnam' });
    const other = await withCookie(t, gangnam).post('/me/service-tickets').send({ serialNo: 'ME-0003', symptom: '남의 것' });
    expect(other.status).toBe(404);
    expect(await t.orm.em.fork().count(ServiceTicket, { terminal: { serialNo: 'ME-0003' } })).toBe(0);
  });

  it('접수 목록은 내 가맹점 것만', async () => {
    await withCookie(t, yeoksam).post('/me/service-tickets').send({ serialNo: 'ME-0003', symptom: '화면 꺼짐' });
    const g = await withCookie(t, gangnam).get('/me/service-tickets');
    const y = await withCookie(t, yeoksam).get('/me/service-tickets');
    expect(g.body.items.map((i: { serialNo: string }) => i.serialNo)).toEqual(['ME-0001']);
    expect(y.body.items.map((i: { serialNo: string }) => i.serialNo)).toEqual(['ME-0003']);
  });

  it('설치 확인은 내 가맹점 접수만 — 남의 접수는 404, 내 것은 CLOSED이고 이력 actor가 가맹점주 아이디', async () => {
    const id = (await withCookie(t, gangnam).get('/me/service-tickets')).body.items[0].id as number;
    const replaced = await t.http().post(`/service-tickets/${id}/replacements`).send({ replacementSerialNo: 'ME-0101', carrier: 'BUNGAE' });
    expect(replaced.status).toBe(201);
    await transitionTo(t, 'ME-0101', 'DELIVERED', '배송 완료(수동)');

    expect((await withCookie(t, yeoksam).post(`/me/service-tickets/${id}/installations`)).status).toBe(404);
    expect((await t.http().get(`/service-tickets/${id}`)).body.status).toBe('REPLACING');

    const done = await withCookie(t, gangnam).post(`/me/service-tickets/${id}/installations`);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('CLOSED');
    const history = (await t.http().get('/terminals/ME-0101/history')).body;
    expect(history.at(-1)).toMatchObject({ toStatus: 'IN_SERVICE', actor: 'owner-gangnam', source: 'SERVICE' });
  });
});
```

접근 표에 가맹점주 줄을 더한다:

```diff
--- a/apps/api/test/unit/access-table.spec.ts
+++ b/apps/api/test/unit/access-table.spec.ts
@@ -73,6 +73,13 @@ const EXPECTED: Record<string, string> = {
   'POST /firmware-rollouts/:id/pause': 'OPERATOR',
   'POST /firmware-rollouts/:id/resume': 'OPERATOR',
   'POST /firmware-rollouts/:id/abort': 'OPERATOR',
+
+  // 가맹점주 전용(decisions/0053) — 가맹점주는 이 다섯 개와 /auth만 부를 수 있다
+  'GET /me/terminals': 'MERCHANT',
+  'GET /me/terminals/:serialNo': 'MERCHANT',
+  'GET /me/service-tickets': 'MERCHANT',
+  'POST /me/service-tickets': 'MERCHANT',
+  'POST /me/service-tickets/:id/installations': 'MERCHANT',
 };
 
 type ModuleLike = Type<unknown> | { module: Type<unknown>; imports?: unknown[]; controllers?: Type<unknown>[] };
```

- [ ] **Step 2: 실패를 확인한다**

Run(`apps/api`): `npx vitest run test/me.e2e.spec.ts test/unit/access-table.spec.ts`
Expected: me.e2e는 `/me/terminals` 등이 404(라우트 없음)라 실패, access-table은 표에 있는 `GET /me/terminals` 등이 실제에 없어 "표와 같다"가 실패.

- [ ] **Step 3: 범위 타입과 서비스의 scope 인자**

`apps/api/src/merchant/merchant-scope.ts`:

```ts
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ApiErrorBody } from '@terminal-ops/contracts';
import type { Principal } from '../auth/principal.js';
import { Role } from '../auth/role.js';

/**
 * 가맹점주가 볼 수 있는 범위(decisions/0053). `/me/...` 컨트롤러가 로그인한 사람에서 만들어 서비스에 넘기고,
 * 서비스는 이 값이 있으면 조회 조건·트랜잭션 안 검사에 merchant_id를 넣는다. 범위 밖이면 403이 아니라 404 — 남의 단말기가 있는지도 알려 주지 않는다.
 */
export interface MerchantScope {
  merchantId: number;
}

export function merchantScopeOf(principal: Principal): MerchantScope {
  if (principal.role !== Role.MERCHANT || principal.merchantId === null) {
    throw new ForbiddenException({ statusCode: 403, code: 'FORBIDDEN', message: '가맹점 계정만 쓸 수 있습니다.' } satisfies ApiErrorBody);
  }
  return { merchantId: principal.merchantId };
}

/** 범위 밖일 때 던지는 404(없는 것과 같은 응답) */
export function outOfScope(what: string): NotFoundException {
  return new NotFoundException(`${what}이(가) 없습니다.`);
}
```

```diff
--- a/apps/api/src/terminal/terminal.service.ts
+++ b/apps/api/src/terminal/terminal.service.ts
@@ -2,6 +2,7 @@ import { Injectable, NotFoundException } from '@nestjs/common';
 import { EntityManager, LoadStrategy } from '@mikro-orm/mysql';
 import type { RegisterTerminalDto } from './dto/register-terminal.dto.js';
 import type { ListTerminalsQuery } from './dto/list-terminals.query.js';
+import { outOfScope, type MerchantScope } from '../merchant/merchant-scope.js';
 import { TerminalModel } from './terminal-model.entity.js';
 import { Terminal } from './terminal.entity.js';
 import { TerminalStatusHistory } from './terminal-status-history.entity.js';
@@ -36,12 +37,13 @@ export class TerminalService {
    * count도 같은 조인을 탄다. select-in이면 목록은 PK를 거꾸로 읽어 바로 멈추고, 모델·가맹점은 그 20행의 id로 한 번씩 읽는다.
    * 모델·가맹점 코드로 거를 때는 MikroORM이 거르기용 조인만 붙인다.
    * @param strategy 실험 0013이 joined와 비교하려고만 바꾼다(운영 코드는 기본값)
+   * @param scope 가맹점주(`/me`)면 그 가맹점 단말기만 — 가맹점 코드 조건보다 앞선다(decisions/0053)
    */
-  async list(query: ListTerminalsQuery, strategy: LoadStrategy = LoadStrategy.SELECT_IN) {
+  async list(query: ListTerminalsQuery, strategy: LoadStrategy = LoadStrategy.SELECT_IN, scope?: MerchantScope) {
     const where = {
       ...(query.status ? { status: query.status } : {}),
       ...(query.modelCode ? { model: { code: query.modelCode } } : {}),
-      ...(query.merchantCode ? { merchant: { code: query.merchantCode } } : {}),
+      ...(scope ? { merchant: scope.merchantId } : query.merchantCode ? { merchant: { code: query.merchantCode } } : {}),
       ...(query.q ? { serialNo: { $like: `${escapeLike(query.q)}%` } } : {}),
     };
     const [items, total] = await this.em.findAndCount(Terminal, where, {
@@ -59,9 +61,10 @@ export class TerminalService {
     return this.em.find(TerminalModel, {}, { orderBy: { code: 'asc' } });
   }
 
-  async getBySerial(serialNo: string): Promise<Terminal> {
+  /** @param scope 가맹점주(`/me`)면 그 가맹점 단말기만 — 아니면 없는 것과 같은 404(decisions/0053) */
+  async getBySerial(serialNo: string, scope?: MerchantScope): Promise<Terminal> {
     const terminal = await this.em.findOne(Terminal, { serialNo }, { populate: ['model', 'merchant'] });
-    if (!terminal) throw new NotFoundException(`단말기 ${serialNo}이(가) 없습니다.`);
+    if (!terminal || (scope && terminal.merchant?.id !== scope.merchantId)) throw outOfScope(`단말기 ${serialNo}`);
     return terminal;
   }
 
```

```diff
--- a/apps/api/src/service/service-ticket.service.ts
+++ b/apps/api/src/service/service-ticket.service.ts
@@ -3,6 +3,7 @@ import { EntityManager, LoadStrategy, LockMode } from '@mikro-orm/mysql';
 import type { RuleViolationCode } from '@terminal-ops/contracts';
 import { BusinessError } from '../common/domain-errors.js';
 import { beforeIdWhere, keysetPage } from '../common/keyset.js';
+import { outOfScope, type MerchantScope } from '../merchant/merchant-scope.js';
 import { Terminal } from '../terminal/terminal.entity.js';
 import { TerminalStatus } from '../terminal/terminal-status.js';
 import type { ListTicketsQuery, OpenTicketDto, RemoteCheckDto } from './dto/service-ticket.dto.js';
@@ -19,11 +20,12 @@ export class ServiceTicketService {
    * 접수. 단말기 행을 FOR UPDATE로 먼저 잠그고(같은 단말기 접수끼리 줄 세우기) 열린 접수가 없을 때만 만든다.
    * 접수 INSERT의 FK 검사(S 락)보다 단말기 X 락이 먼저라 S→X 데드락이 없다(troubleshooting/0004).
    * 단말기 상태는 바꾸지 않는다(운영 중 그대로).
+   * @param scope 가맹점주 접수(`/me`)면 그 가맹점 단말기만 — 잠근 행의 가맹점으로 확인한다(잠그기 전 확인과 접수 사이에 배정이 바뀌는 틈이 없게, decisions/0053)
    */
-  async open(dto: OpenTicketDto, actor: string): Promise<ServiceTicket> {
+  async open(dto: OpenTicketDto, actor: string, scope?: MerchantScope): Promise<ServiceTicket> {
     const id = await this.em.fork().transactional(async (tx) => {
       const terminal = await tx.findOne(Terminal, { serialNo: dto.serialNo }, { lockMode: LockMode.PESSIMISTIC_WRITE });
-      if (!terminal) throw new NotFoundException(`단말기 ${dto.serialNo}이(가) 없습니다.`);
+      if (!terminal || (scope && terminal.merchant?.id !== scope.merchantId)) throw outOfScope(`단말기 ${dto.serialNo}`);
       if (terminal.status !== TerminalStatus.IN_SERVICE || !terminal.merchant) {
         throw new BusinessError(422, 'TERMINAL_NOT_IN_SERVICE', `운영 중(IN_SERVICE)인 단말기만 A/S 접수할 수 있습니다(현재: ${terminal.status}).`);
       }
@@ -49,23 +51,24 @@ export class ServiceTicketService {
     return this.get(id);
   }
 
-  /** 접수 목록(최근 것부터, id 키셋 — decisions/0039) */
-  async list(q: ListTicketsQuery) {
+  /** 접수 목록(최근 것부터, id 키셋 — decisions/0039). scope가 있으면 그 가맹점 접수만(decisions/0053) */
+  async list(q: ListTicketsQuery, scope?: MerchantScope) {
     const rows = await this.em.fork().find(
       ServiceTicket,
       {
         ...beforeIdWhere(q.beforeId),
         ...(q.status ? { status: q.status } : {}),
         ...(q.serialNo ? { terminal: { serialNo: q.serialNo } } : {}),
+        ...(scope ? { merchant: scope.merchantId } : {}),
       },
       { populate: TICKET_POPULATE, strategy: LoadStrategy.SELECT_IN, orderBy: { id: 'desc' }, limit: q.limit + 1 },
     );
     return keysetPage(rows, q.limit);
   }
 
-  async get(id: number): Promise<ServiceTicket> {
+  async get(id: number, scope?: MerchantScope): Promise<ServiceTicket> {
     const ticket = await this.em.fork().findOne(ServiceTicket, id, { populate: TICKET_POPULATE });
-    if (!ticket) throw new NotFoundException(`A/S 접수 ${id}이(가) 없습니다.`);
+    if (!ticket || (scope && ticket.merchant.id !== scope.merchantId)) throw outOfScope(`A/S 접수 ${id}`);
     return ticket;
   }
 
```

```diff
--- a/apps/api/src/service/replacement.service.ts
+++ b/apps/api/src/service/replacement.service.ts
@@ -5,6 +5,7 @@ import type { Carrier } from '../carrier/carrier.types.js';
 import { BusinessError } from '../common/domain-errors.js';
 import { env } from '../config/env.js';
 import { Merchant } from '../merchant/merchant.entity.js';
+import type { MerchantScope } from '../merchant/merchant-scope.js';
 import { RedisLock } from '../redis/redis-lock.js';
 import { ShipmentService } from '../shipment/shipment.service.js';
 import { Terminal } from '../terminal/terminal.entity.js';
@@ -141,8 +142,9 @@ export class ReplacementService {
    * 잠금 순서는 교체 출고와 같다(단말기 → 접수, decisions/0023). 그래서 접수를 잠그지 않고 먼저 읽어 교체 단말기 id만 알아낸다.
    * REPLACING이 된 뒤에는 교체 단말기가 바뀌지 않으므로, 접수 잠금 뒤 상태만 다시 본다.
    */
-  async install(id: number, actor: string): Promise<ServiceTicket> {
-    const current = await this.tickets.get(id);
+  /** @param scope 가맹점주의 설치 확인(`/me`)이면 그 가맹점 접수만 — 접수의 가맹점은 바뀌지 않으므로 처음 읽을 때 확인한다(decisions/0053) */
+  async install(id: number, actor: string, scope?: MerchantScope): Promise<ServiceTicket> {
+    const current = await this.tickets.get(id, scope);
     if (current.status !== ServiceTicketStatus.REPLACING || !current.replacementTerminal) {
       throw new BusinessError(
         422,
```

```diff
--- a/apps/api/src/service/service.module.ts
+++ b/apps/api/src/service/service.module.ts
@@ -10,5 +10,7 @@ import { ServiceTicketService } from './service-ticket.service.js';
   imports: [TerminalModule, ShipmentModule, CarrierModule],
   controllers: [ServiceTicketController],
   providers: [ServiceTicketService, ReplacementService],
+  // 가맹점주 화면(`/me`, MeModule)이 같은 서비스를 범위와 함께 쓴다(decisions/0053)
+  exports: [ServiceTicketService, ReplacementService],
 })
 export class ServiceModule {}
```

- [ ] **Step 4: `/me` 컨트롤러와 모듈**

`apps/api/src/me/me.dto.ts`:

```ts
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { BeforeIdQuery } from '../common/keyset.js';
import { ServiceTicketStatus } from '../service/service-ticket.entity.js';
import { TerminalStatus } from '../terminal/terminal-status.js';

/** GET /me/terminals — 가맹점 조건(merchantCode)은 받지 않는다(로그인한 가맹점으로 정해진다, 보내면 400) */
export class MeTerminalsQuery {
  @IsOptional()
  @IsEnum(TerminalStatus)
  status?: TerminalStatus;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Math.floor(Number.MAX_SAFE_INTEGER / 100))
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size: number = 20;
}

/** GET /me/service-tickets — 내 가맹점 접수만(최근 것부터) */
export class MeTicketsQuery extends BeforeIdQuery {
  @IsOptional()
  @IsEnum(ServiceTicketStatus)
  status?: ServiceTicketStatus;
}
```

`apps/api/src/me/me.controller.ts`:

```ts
import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import type { BeforeIdPage, TerminalPage, TerminalView, TicketView } from '@terminal-ops/contracts';
import { Roles } from '../auth/access.js';
import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { Role } from '../auth/role.js';
import { merchantScopeOf } from '../merchant/merchant-scope.js';
import { OpenTicketDto } from '../service/dto/service-ticket.dto.js';
import { ReplacementService } from '../service/replacement.service.js';
import { ServiceTicketService } from '../service/service-ticket.service.js';
import { toTicketView } from '../service/service-ticket.views.js';
import { TerminalService } from '../terminal/terminal.service.js';
import { toTerminalView } from '../terminal/terminal.views.js';
import { MeTerminalsQuery, MeTicketsQuery } from './me.dto.js';

/**
 * 가맹점주(MERCHANT) 전용 API(decisions/0053). 일반 엔드포인트에 가맹점 조건을 끼워 넣지 않고 `/me/...`를 따로 둔다 —
 * 가맹점주는 이 컨트롤러 밖의 업무 API를 하나도 부를 수 없고(표 decisions/0052), 여기서는 모든 호출이 로그인한 가맹점의 범위를 서비스에 넘긴다.
 * 단말기는 TerminalView(운영자 작업 목록 allowedTransitions가 있는 상세는 주지 않는다).
 */
@Controller('me')
export class MeController {
  constructor(
    private readonly terminals: TerminalService,
    private readonly tickets: ServiceTicketService,
    private readonly replacements: ReplacementService,
  ) {}

  @Get('terminals')
  @Roles(Role.MERCHANT)
  async terminalList(@CurrentPrincipal() p: Principal, @Query() query: MeTerminalsQuery): Promise<TerminalPage> {
    const result = await this.terminals.list(query, undefined, merchantScopeOf(p));
    return { ...result, items: result.items.map(toTerminalView) };
  }

  @Get('terminals/:serialNo')
  @Roles(Role.MERCHANT)
  async terminal(@CurrentPrincipal() p: Principal, @Param('serialNo') serialNo: string): Promise<TerminalView> {
    return toTerminalView(await this.terminals.getBySerial(serialNo, merchantScopeOf(p)));
  }

  @Get('service-tickets')
  @Roles(Role.MERCHANT)
  async ticketList(@CurrentPrincipal() p: Principal, @Query() query: MeTicketsQuery): Promise<BeforeIdPage<TicketView>> {
    const { items, nextBeforeId } = await this.tickets.list(query, merchantScopeOf(p));
    return { items: items.map(toTicketView), nextBeforeId };
  }

  /** A/S 접수(내 가맹점의 운영 중 단말기만). openedBy = 가맹점주 로그인 아이디 */
  @Post('service-tickets')
  @Roles(Role.MERCHANT)
  async openTicket(@CurrentPrincipal() p: Principal, @Body() dto: OpenTicketDto): Promise<TicketView> {
    return toTicketView(await this.tickets.open(dto, p.loginId, merchantScopeOf(p)));
  }

  /** 교체 단말기 설치 확인(내 가맹점 접수만). 이력 actor = 가맹점주 로그인 아이디 */
  @Post('service-tickets/:id/installations')
  @Roles(Role.MERCHANT)
  @HttpCode(200)
  async install(@CurrentPrincipal() p: Principal, @Param('id', ParseIntPipe) id: number): Promise<TicketView> {
    return toTicketView(await this.replacements.install(id, p.loginId, merchantScopeOf(p)));
  }
}
```

`apps/api/src/me/me.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { ServiceModule } from '../service/service.module.js';
import { TerminalModule } from '../terminal/terminal.module.js';
import { MeController } from './me.controller.js';

/** 가맹점주 전용 API `/me/...`(decisions/0053) */
@Module({
  imports: [TerminalModule, ServiceModule],
  controllers: [MeController],
})
export class MeModule {}
```

```diff
--- a/apps/api/src/app.module.ts
+++ b/apps/api/src/app.module.ts
@@ -24,6 +24,7 @@ import { DashboardModule } from './dashboard/dashboard.module.js';
 import { WorkersModule } from './workers/workers.module.js';
 import { SchedulerModule } from './scheduler/scheduler.module.js';
 import { AuthModule } from './auth/auth.module.js';
+import { MeModule } from './me/me.module.js';
 
 export interface AppOptions {
   /** 큐 job을 처리할지(RUN_WORKERS) */
@@ -54,6 +55,7 @@ export interface AppOptions {
     AnomalyModule,
     ReportModule,
     DashboardModule,
+    MeModule,
   ],
   controllers: [HealthController],
   providers: [
```

- [ ] **Step 5: 통과 확인**

Run(`apps/api`): `npm run typecheck && npx vitest run test/me.e2e.spec.ts test/unit/access-table.spec.ts test/service-ticket.e2e.spec.ts test/replacement.e2e.spec.ts 2>&1 | grep -E "Test Files|Tests "`
Expected: typecheck 0, `Test Files  4 passed (4)`, `Tests  22 passed (22)`(me.e2e 8개). 그다음 테스트 DB를 다시 만들고 api 전체: `Test Files  73 passed (73)`, `Tests  496 passed (496)`.

- [ ] **Step 6: 결정 기록 0053**

`docs/decisions/0053-가맹점주-범위는-me-전용-엔드포인트와-서비스-scope.md`:

````markdown
# 0053. 가맹점주 범위는 /me 전용 엔드포인트와 서비스 scope 인자로 강제한다

- 날짜 / 관련 기능: 2026-10-28 / 보강 2, F1(단말기 조회), F7(A/S 접수·설치 확인)
- 상황: 가맹점주(MERCHANT)는 자기 가맹점(`user_account.merchant_id`) 데이터만 봐야 한다. 볼 것: 자기 단말기 목록·상세, A/S 접수 목록, 할 것: A/S 접수, 교체 단말기 설치 확인. 화면은 Bundle 3 — 여기서는 API와 범위 강제·테스트까지.
- 선택지:
  1. 일반 엔드포인트(`GET /terminals` 등)에 MERCHANT를 허용하고 컨트롤러가 가맹점 조건을 주입 — 장점: 엔드포인트가 늘지 않는다. 단점: 같은 엔드포인트가 역할마다 다르게 동작하고, 한 곳이라도 주입을 빠뜨리면 전체 데이터가 나간다. 역할 표(0052)에 MERCHANT가 업무 엔드포인트마다 섞여 "어디까지 보이나"가 흐려진다. 상세 응답의 운영자 작업 목록(`allowedTransitions`)까지 나간다
  2. MikroORM 필터(`@Filter`, 요청 컨텍스트 값) — 장점: 쿼리마다 자동. 단점: 숨은 동작이고, 이 코드베이스는 서비스마다 `em.fork()`를 많이 써 필터 값 전달을 놓치기 쉽다. raw SQL·`nativeUpdate`·집계 쿼리(대시보드, 리포트)에는 걸리지 않는다. 운영자 요청에서 실수로 켜지면 잠금·전이 쿼리가 행을 못 찾는다
  3. **가맹점주 전용 `/me/...` + 서비스 메서드의 `scope?: MerchantScope` 인자** — 장점: 가맹점주가 부를 수 있는 것이 다섯 개로 눈에 보인다(0052 표). 서비스는 scope가 있으면 조회 조건(`merchant = ?`)과 트랜잭션 안 검사(잠근 행의 가맹점)에 넣는다. 응답 모양도 가맹점용으로 고른다(TerminalView, 상세의 작업 목록 없음). 단점: 엔드포인트를 따로 만든다, scope를 넘기는 것은 컨트롤러의 책임
- 결정: 3.
  - `merchantScopeOf(principal)`가 MERCHANT·가맹점 id를 확인해 scope를 만든다(아니면 403).
  - 범위 밖은 **404**이고 메시지도 없는 것과 같다(`단말기 X이(가) 없습니다.`) — 남의 단말기가 있는지 알려 주지 않는다.
  - A/S 접수는 단말기 행을 FOR UPDATE로 잠근 **뒤** 그 행의 가맹점으로 확인한다(확인과 접수 사이에 배정이 바뀌는 틈이 없게). 설치 확인은 접수의 가맹점(바뀌지 않음)으로 처음 읽을 때 확인한다.
  - `/me/terminals`는 `merchantCode` 조건을 받지 않는다(보내면 400 — DTO whitelist). 서비스에서도 scope가 가맹점 코드 조건보다 앞선다.
  - 이력 actor·`openedBy`는 가맹점주 로그인 아이디(0056).
- 결과·대가: 가맹점 화면이 늘면 `/me` 쪽 엔드포인트도 는다. 서비스에 scope를 안 넘기면 범위가 없다 — `me.e2e`가 다섯 엔드포인트 모두 남의 것 404·목록 범위를 본다. 가맹점주는 일반 업무 API를 하나도 부를 수 없다(403, e2e).
- 다시 볼 조건: `/me` 엔드포인트가 수십 개가 되거나 같은 조회를 두 벌 유지하는 비용이 커지면 2(필터)를 서비스 일부에. 가맹점 계정이 여러 가맹점을 가지면 scope를 목록으로.
````

- [ ] **Step 7: 색인·devlog·커밋·시각 맞추기**

`node scripts/docs-index.mjs && node scripts/docs-index.mjs --check`. devlog 항목(한 일: `/me` 다섯 개, MerchantScope, 서비스 scope 인자, 범위 밖 404, 확인: me.e2e 8개·api 전체 73/496, 결정 0053, 다음: Task 5).

```bash
git add apps/api docs
git commit -m "feat(auth, F7): 가맹점주 범위 — /me 단말기·A/S, 서비스 scope, 범위 밖 404

Refs: docs/decisions/0053-가맹점주-범위는-me-전용-엔드포인트와-서비스-scope.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Task 1 Step 14와 같이 시각·해시를 맞추고 amend.

### Task 5: 계정 관리 API·외부 업체 키·`/partner/v1`·시연 키

**Files:**
- Create: `apps/api/src/auth/{partner-key.entity,partner-key.service,account.service}.ts`, `apps/api/src/admin/{admin.dto,admin.controllers,admin.module}.ts`, `apps/api/src/partner-api/{partner-api.controller,partner-api.module}.ts`
- Modify: `apps/api/src/auth/access.ts`, `apps/api/src/auth/auth.guard.ts`, `apps/api/src/auth/auth.module.ts`, `apps/api/src/entities.ts`, `apps/api/src/common/contract-assertions.ts`, `apps/api/src/app.module.ts`, `apps/api/src/db/seed-accounts.ts`, `apps/api/src/db/seed.ts`
- Create(생성 명령): `apps/api/src/migrations/Migration<시각>.ts`, Modify: `.snapshot-terminal_ops.json`
- Test: Create `apps/api/test/admin-accounts.e2e.spec.ts`, `apps/api/test/partner-api.e2e.spec.ts`; Modify `apps/api/test/unit/access-table.spec.ts`
- Docs: `docs/decisions/0054-외부-업체-키는-해시-저장과-scope.md`, `docs/troubleshooting/0031-초-단위-datetime-열은-밀리초를-반올림해-응답과-다시-읽은-값이-다르다.md`, `docs/index.md`, `docs/devlog/2026-10-28.md`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`apps/api/test/admin-accounts.e2e.spec.ts`:

```ts
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDIS } from '../src/redis/redis.provider.js';
import { createAccount, login, withCookie } from './helpers/auth.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('계정 관리 ADMIN API (보강 2, decisions/0051·0050)', () => {
  let t: TestApp;
  let admin: string;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await createAccount(t, 'root-admin', 'ADMIN');
    admin = await login(t, 'root-admin');
  });
  afterAll(async () => {
    await deleteTestKeys(t.app.get<Redis>(REDIS));
    await t.app.close();
  });

  const create = (body: Record<string, unknown>) => withCookie(t, admin).post('/admin/accounts').send(body);

  it('ADMIN만 부를 수 있다(운영자도 403)', async () => {
    expect((await t.http().get('/admin/accounts')).status).toBe(403);
    expect((await withCookie(t, admin).get('/admin/accounts')).status).toBe(200);
  });

  it('계정을 만들면 201, 응답에 비밀번호·해시가 없다. 같은 아이디는 409 DUPLICATE', async () => {
    const res = await create({ loginId: 'new.op', displayName: '새 운영자', password: 'password-1234', role: 'OPERATOR' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ loginId: 'new.op', displayName: '새 운영자', role: 'OPERATOR', merchantCode: null, disabled: false, lastLoginAt: null });
    expect(JSON.stringify(res.body)).not.toMatch(/password|scrypt/);
    expect((await create({ loginId: 'new.op', displayName: 'x', password: 'password-1234', role: 'OPERATOR' })).body.code).toBe('DUPLICATE');
    expect((await t.http(null).post('/auth/login').send({ loginId: 'new.op', password: 'password-1234' })).status).toBe(200);
  });

  it('입력 검증: 아이디 모양·비밀번호 10자·역할 값은 400, MERCHANT ⇔ 가맹점은 400 MERCHANT_REQUIRED, 없는 가맹점 404', async () => {
    expect((await create({ loginId: 'Bad Id', displayName: 'x', password: 'password-1234', role: 'OPERATOR' })).status).toBe(400);
    expect((await create({ loginId: 'short.pw', displayName: 'x', password: 'short', role: 'OPERATOR' })).status).toBe(400);
    expect((await create({ loginId: 'bad.role', displayName: 'x', password: 'password-1234', role: 'ROOT' })).status).toBe(400);
    const noMerchant = await create({ loginId: 'm.none', displayName: 'x', password: 'password-1234', role: 'MERCHANT' });
    expect([noMerchant.status, noMerchant.body.code]).toEqual([400, 'MERCHANT_REQUIRED']);
    const opWithMerchant = await create({ loginId: 'op.m', displayName: 'x', password: 'password-1234', role: 'OPERATOR', merchantCode: 'GANGNAM-KIMBAP' });
    expect([opWithMerchant.status, opWithMerchant.body.code]).toEqual([400, 'MERCHANT_REQUIRED']);
    expect((await create({ loginId: 'm.ghost', displayName: 'x', password: 'password-1234', role: 'MERCHANT', merchantCode: 'NOPE' })).status).toBe(404);
    const merchant = await create({ loginId: 'm.pangyo', displayName: '판교 점주', password: 'password-1234', role: 'MERCHANT', merchantCode: 'PANGYO-BUNSIK' });
    expect(merchant.body).toMatchObject({ role: 'MERCHANT', merchantCode: 'PANGYO-BUNSIK' });
  });

  it('역할을 바꾸면 그 계정의 세션이 끊기고, 다시 로그인하면 새 역할이다', async () => {
    const target = await createAccount(t, 'promote.me', 'MONITOR');
    const before = await login(t, 'promote.me');
    expect((await withCookie(t, before).post('/terminals').send({ serialNo: 'AD-0001', modelCode: 'SN-100' })).status).toBe(403);
    const res = await withCookie(t, admin).patch(`/admin/accounts/${target.id}`).send({ role: 'OPERATOR' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('OPERATOR');
    expect((await withCookie(t, before).get('/auth/me')).status).toBe(401);
    const after = await login(t, 'promote.me');
    expect((await withCookie(t, after).post('/terminals').send({ serialNo: 'AD-0001', modelCode: 'SN-100' })).status).toBe(201);
  });

  it('표시 이름만 바꾸면 세션은 그대로다', async () => {
    const target = await createAccount(t, 'rename.me', 'MONITOR');
    const cookie = await login(t, 'rename.me');
    expect((await withCookie(t, admin).patch(`/admin/accounts/${target.id}`).send({ displayName: '새 이름' })).body.displayName).toBe('새 이름');
    expect((await withCookie(t, cookie).get('/auth/me')).status).toBe(200);
  });

  it('사용 중지하면 세션이 끊기고 로그인도 안 된다. 다시 켜면 로그인된다', async () => {
    const target = await createAccount(t, 'disable.me', 'FIELD');
    const cookie = await login(t, 'disable.me');
    expect((await withCookie(t, admin).patch(`/admin/accounts/${target.id}`).send({ disabled: true })).body.disabled).toBe(true);
    expect((await withCookie(t, cookie).get('/auth/me')).status).toBe(401);
    expect((await t.http(null).post('/auth/login').send({ loginId: 'disable.me', password: 'test-password-1234' })).status).toBe(401);
    await withCookie(t, admin).patch(`/admin/accounts/${target.id}`).send({ disabled: false });
    expect((await t.http(null).post('/auth/login').send({ loginId: 'disable.me', password: 'test-password-1234' })).status).toBe(200);
  });

  it('MERCHANT로 바꾸려면 가맹점이 필요하고, 다른 역할로 바꾸면 가맹점이 지워진다', async () => {
    const target = await createAccount(t, 'switch.me', 'OPERATOR');
    expect((await withCookie(t, admin).patch(`/admin/accounts/${target.id}`).send({ role: 'MERCHANT' })).body.code).toBe('MERCHANT_REQUIRED');
    const m = await withCookie(t, admin).patch(`/admin/accounts/${target.id}`).send({ role: 'MERCHANT', merchantCode: 'YEOKSAM-CAFE' });
    expect(m.body).toMatchObject({ role: 'MERCHANT', merchantCode: 'YEOKSAM-CAFE' });
    const back = await withCookie(t, admin).patch(`/admin/accounts/${target.id}`).send({ role: 'MONITOR' });
    expect(back.body).toMatchObject({ role: 'MONITOR', merchantCode: null });
    expect((await withCookie(t, admin).patch('/admin/accounts/999999').send({ displayName: 'x' })).status).toBe(404);
  });
});
```

`apps/api/test/partner-api.e2e.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PartnerApiKey } from '../src/auth/partner-key.entity.js';
import { PartnerKeyService } from '../src/auth/partner-key.service.js';
import { DEMO_PARTNER_KEY, seedDemoPartnerKey } from '../src/db/seed-accounts.js';
import { createAccount, login, withCookie } from './helpers/auth.js';
import { partners } from './helpers/partners.js';
import { prepareInService, registerInStock } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('외부 업체 API 키 (보강 2, decisions/0054)', () => {
  let t: TestApp;
  let admin: string;
  let statusOnly: string;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await partners.reset();
    await prepareInService(t, 'PK-0001', 'GANGNAM-KIMBAP');
    await registerInStock(t, 'PK-0002');
    await createAccount(t, 'key-admin', 'ADMIN');
    admin = await login(t, 'key-admin');
  });
  afterAll(async () => {
    await t.app.close();
  });

  const terminal = (serial: string) => t.http(null).get(`/partner/v1/terminals/${serial}`);

  it('ADMIN이 발급하면 원문은 응답에 한 번만, DB에는 접두사와 SHA-256만', async () => {
    expect((await t.http().post('/admin/partner-keys').send({ name: 'x', scopes: ['terminal-status:read'] })).status).toBe(403);
    const res = await withCookie(t, admin).post('/admin/partner-keys').send({ name: '연동 업체 A', scopes: ['terminal-status:read'] });
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(/^pk_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    expect(res.body).toMatchObject({ name: '연동 업체 A', prefix: res.body.key.slice(0, 11), scopes: ['terminal-status:read'], createdBy: 'key-admin', revokedAt: null, lastUsedAt: null });
    statusOnly = res.body.key;
    const row = await t.orm.em.fork().findOneOrFail(PartnerApiKey, { prefix: res.body.prefix });
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(statusOnly.slice(12));
    const list = await withCookie(t, admin).get('/admin/partner-keys');
    expect(list.body[0]).not.toHaveProperty('key');
  });

  it('Bearer 또는 X-Api-Key로 단말기 상태를 읽는다(외부용 좁은 응답)', async () => {
    const bearer = await terminal('PK-0001').set('Authorization', `Bearer ${statusOnly}`);
    expect(bearer.status).toBe(200);
    expect(bearer.body).toEqual({ serialNo: 'PK-0001', modelCode: 'SN-100', status: 'IN_SERVICE', merchantCode: 'GANGNAM-KIMBAP' });
    expect((await terminal('PK-0002').set('X-Api-Key', statusOnly)).body.status).toBe('IN_STOCK');
    expect((await terminal('NOPE-1').set('X-Api-Key', statusOnly)).status).toBe(404);
  });

  it('키가 없거나 모양·값이 틀리면 401, scope 밖이면 403', async () => {
    expect((await terminal('PK-0001')).status).toBe(401);
    expect((await terminal('PK-0001').set('X-Api-Key', 'pk_nope')).status).toBe(401);
    const tampered = `${statusOnly.slice(0, -1)}${statusOnly.endsWith('A') ? 'B' : 'A'}`;
    expect((await terminal('PK-0001').set('X-Api-Key', tampered)).status).toBe(401);
    const scoped = await t.http(null).get('/partner/v1/merchants/GANGNAM-KIMBAP/terminals').set('X-Api-Key', statusOnly);
    expect([scoped.status, scoped.body.code]).toEqual([403, 'FORBIDDEN']);
  });

  it('사람 세션·테스트 헤더로는 외부 업체 API를 부를 수 없고, 외부 업체 키로는 사내 API를 부를 수 없다', async () => {
    expect((await withCookie(t, admin).get('/partner/v1/terminals/PK-0001')).status).toBe(401);
    expect((await t.http().get('/partner/v1/terminals/PK-0001')).status).toBe(401);
    expect((await t.http(null).get('/terminals/PK-0001').set('Authorization', `Bearer ${statusOnly}`)).status).toBe(401);
  });

  it('쓰면 lastUsedAt이 남는다(1분에 한 번만 갱신)', async () => {
    const svc = t.app.get(PartnerKeyService);
    const first = await withCookie(t, admin).get('/admin/partner-keys');
    const used = first.body.find((k: { key?: string; prefix: string }) => k.prefix === statusOnly.slice(0, 11)).lastUsedAt as string;
    expect(used).not.toBeNull();
    await svc.verify(statusOnly, new Date(Date.parse(used) + 30_000));
    expect((await t.orm.em.fork().findOneOrFail(PartnerApiKey, { prefix: statusOnly.slice(0, 11) })).lastUsedAt?.toISOString()).toBe(new Date(used).toISOString());
    // 열이 datetime(초 단위)이라 MySQL이 밀리초를 반올림한다 — 비교가 흔들리지 않게 정확한 초로 준다
    const later = new Date(Math.ceil((Date.parse(used) + 61_000) / 1000) * 1000);
    await svc.verify(statusOnly, later);
    expect((await t.orm.em.fork().findOneOrFail(PartnerApiKey, { prefix: statusOnly.slice(0, 11) })).lastUsedAt!.getTime()).toBe(later.getTime());
  });

  it('폐기하면 바로 401. 다시 폐기해도 처음 시각 그대로', async () => {
    const created = await withCookie(t, admin).post('/admin/partner-keys').send({ name: '연동 업체 B', scopes: ['terminal-status:read'] });
    expect((await terminal('PK-0001').set('X-Api-Key', created.body.key)).status).toBe(200);
    const revoked = await withCookie(t, admin).post(`/admin/partner-keys/${created.body.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedAt).not.toBeNull();
    expect((await terminal('PK-0001').set('X-Api-Key', created.body.key)).status).toBe(401);
    expect((await withCookie(t, admin).post(`/admin/partner-keys/${created.body.id}/revoke`)).body.revokedAt).toBe(revoked.body.revokedAt);
    expect((await withCookie(t, admin).post('/admin/partner-keys/999999/revoke')).status).toBe(404);
  });

  it('만료 시각이 지나면 401', async () => {
    const created = await withCookie(t, admin)
      .post('/admin/partner-keys')
      .send({ name: '연동 업체 C', scopes: ['terminal-status:read'], expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect((await terminal('PK-0001').set('X-Api-Key', created.body.key)).status).toBe(200);
    await t.orm.em.fork().nativeUpdate(PartnerApiKey, { id: created.body.id }, { expiresAt: new Date(Date.now() - 1000) });
    expect((await terminal('PK-0001').set('X-Api-Key', created.body.key)).status).toBe(401);
  });

  it('시연 키(시드)는 두 scope 모두 — 가맹점 단말기 목록을 쪽 단위로 읽는다. 없는 가맹점은 404', async () => {
    expect(await seedDemoPartnerKey(t.orm.em.fork())).toBe(true);
    expect(await seedDemoPartnerKey(t.orm.em.fork())).toBe(false);
    const res = await t.http(null).get('/partner/v1/merchants/GANGNAM-KIMBAP/terminals').set('Authorization', `Bearer ${DEMO_PARTNER_KEY.key}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, page: 1, size: 50, items: [{ serialNo: 'PK-0001', status: 'IN_SERVICE' }] });
    expect((await t.http(null).get('/partner/v1/merchants/NOPE/terminals').set('X-Api-Key', DEMO_PARTNER_KEY.key)).status).toBe(404);
  });

  it('발급 입력 검증: 모르는 scope·빈 scope·빈 이름은 400', async () => {
    for (const body of [
      { name: 'x', scopes: ['admin:all'] },
      { name: 'x', scopes: [] },
      { name: '  ', scopes: ['terminal-status:read'] },
      { name: 'x', scopes: ['terminal-status:read'], expiresAt: 'tomorrow' },
    ]) {
      expect((await withCookie(t, admin).post('/admin/partner-keys').send(body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});
```

접근 표에 관리·외부 업체 줄과 `partner:<scope>` 표기를 더한다:

```diff
--- a/apps/api/test/unit/access-table.spec.ts
+++ b/apps/api/test/unit/access-table.spec.ts
@@ -9,7 +9,7 @@ import { ACCESS_KEY, type Access } from '../../src/auth/access.js';
  * 엔드포인트별 접근 규칙 표(decisions/0052). 앱의 모든 컨트롤러 핸들러를 모듈 메타데이터로 훑어 실제 규칙과 이 표를 맞춘다.
  * - 새 엔드포인트에 @Public/@Roles/@DeviceAuth를 달지 않으면 "규칙 없음"으로 실패한다(가드는 403으로 막는다 — 기본 거부).
  * - 규칙을 바꾸면(역할을 더하거나 빼면) 이 표도 같이 바꿔야 통과한다 — 권한 변경이 리뷰에서 보이게.
- * 값: 'public' | 'device' | 역할을 쉼표로(알파벳 순).
+ * 값: 'public' | 'device' | 'partner:<scope>' | 역할을 쉼표로(알파벳 순).
  */
 const EXPECTED: Record<string, string> = {
   'GET /health': 'public',
@@ -80,6 +80,18 @@ const EXPECTED: Record<string, string> = {
   'GET /me/service-tickets': 'MERCHANT',
   'POST /me/service-tickets': 'MERCHANT',
   'POST /me/service-tickets/:id/installations': 'MERCHANT',
+
+  // 계정·외부 업체 키 관리(decisions/0054)
+  'GET /admin/accounts': 'ADMIN',
+  'POST /admin/accounts': 'ADMIN',
+  'PATCH /admin/accounts/:id': 'ADMIN',
+  'GET /admin/partner-keys': 'ADMIN',
+  'POST /admin/partner-keys': 'ADMIN',
+  'POST /admin/partner-keys/:id/revoke': 'ADMIN',
+
+  // 외부 업체 키(scope별)
+  'GET /partner/v1/terminals/:serialNo': 'partner:terminal-status:read',
+  'GET /partner/v1/merchants/:merchantCode/terminals': 'partner:merchant-terminals:read',
 };
 
 type ModuleLike = Type<unknown> | { module: Type<unknown>; imports?: unknown[]; controllers?: Type<unknown>[] };
@@ -99,6 +111,13 @@ function collectControllers(root: ModuleLike, seen = new Set<unknown>(), out = n
 
 const join = (...parts: string[]) => `/${parts.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
 
+function describeAccess(access: Access | undefined): string | null {
+  if (!access) return null;
+  if (access.kind === 'roles') return [...access.roles].sort().join(',');
+  if (access.kind === 'partner') return `partner:${access.scope}`;
+  return access.kind;
+}
+
 /** 'GET /terminals/:serialNo' → 규칙 문자열(없으면 null) */
 function routeTable(): Map<string, string | null> {
   const table = new Map<string, string | null>();
@@ -113,7 +132,7 @@ function routeTable(): Map<string, string | null> {
       const path = (Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? '/';
       const key = `${RequestMethod[method]} ${join(base, path)}`;
       const access = Reflect.getMetadata(ACCESS_KEY, handler) as Access | undefined;
-      table.set(key, !access ? null : access.kind === 'roles' ? [...access.roles].sort().join(',') : access.kind);
+      table.set(key, describeAccess(access));
     }
   }
   return table;
```

- [ ] **Step 2: 실패를 확인한다**

Run(`apps/api`): `npx vitest run test/admin-accounts.e2e.spec.ts test/partner-api.e2e.spec.ts test/unit/access-table.spec.ts`
Expected: 세 파일 FAIL(`../src/auth/partner-key.entity.js` 등을 찾지 못함, access-table은 `../../src/auth/access.js`의 `Access`에 partner가 없어 표가 다름).

- [ ] **Step 3: 외부 업체 키 엔티티·서비스**

`apps/api/src/auth/partner-key.entity.ts`:

```ts
import { OptionalProps } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import type { PartnerScope } from '@terminal-ops/contracts';

/** 외부 업체 키가 할 수 있는 일(contracts PartnerScope와 같다 — contract-assertions.ts) */
export const PARTNER_SCOPES = ['terminal-status:read', 'merchant-terminals:read'] as const;

/**
 * 외부 업체 API 키(보강 2, decisions/0054). 원문은 저장하지 않는다 — SHA-256만(키가 32바이트 무작위라 느린 해시가 필요 없다).
 * 키 모양 `pk_<접두사 8자>_<비밀 43자>`. prefix(`pk_xxxxxxxx`)는 평문으로 두어 찾기·화면 표시에 쓴다.
 */
@Entity({ tableName: 'partner_api_key' })
export class PartnerApiKey {
  [OptionalProps]?: 'expiresAt' | 'revokedAt' | 'lastUsedAt' | 'createdAt';

  @PrimaryKey()
  id!: number;

  /** 업체 이름(표시용) */
  @Property({ length: 50 })
  name!: string;

  @Property({ unique: true, length: 16 })
  prefix!: string;

  /** 키 원문의 SHA-256(hex) */
  @Property({ length: 64 })
  keyHash!: string;

  @Property({ type: 'json' })
  scopes!: PartnerScope[];

  @Property({ type: 'datetime', nullable: true })
  expiresAt: Date | null = null;

  @Property({ type: 'datetime', nullable: true })
  revokedAt: Date | null = null;

  /** 마지막으로 쓴 시각. 1분에 한 번만 갱신한다(요청마다 UPDATE하지 않게) */
  @Property({ type: 'datetime', nullable: true })
  lastUsedAt: Date | null = null;

  @Property({ length: 50 })
  createdBy!: string;

  @Property()
  createdAt: Date = new Date();
}
```

`apps/api/src/auth/partner-key.service.ts`(폐기 응답은 저장 뒤 다시 읽는다 — troubleshooting/0031):

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { CreatedPartnerKeyView, PartnerKeyView, PartnerScope } from '@terminal-ops/contracts';
import { PartnerApiKey } from './partner-key.entity.js';

/** `pk_` + 소문자·숫자 8자 + `_` + base64url 43자(32바이트) */
const KEY_PATTERN = /^(pk_[a-z0-9]{8})_[A-Za-z0-9_-]{43}$/;
/** lastUsedAt을 이보다 자주 쓰지 않는다 */
const TOUCH_EVERY_MS = 60_000;

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

export function toPartnerKeyView(k: PartnerApiKey): PartnerKeyView {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    createdBy: k.createdBy,
    createdAt: k.createdAt.toISOString(),
  };
}

/** 외부 업체 키 발급·폐기·확인(decisions/0054). 발급·폐기는 ADMIN API, 확인은 AuthGuard가 부른다 */
@Injectable()
export class PartnerKeyService {
  constructor(private readonly em: EntityManager) {}

  /** 새 키. 원문(key)은 이 응답에만 있다 */
  async create(input: { name: string; scopes: PartnerScope[]; expiresAt?: Date | null }, actor: string, rawKey?: string): Promise<CreatedPartnerKeyView> {
    const key = rawKey ?? `pk_${randomBytes(6).toString('hex').slice(0, 8)}_${randomBytes(32).toString('base64url')}`;
    const match = KEY_PATTERN.exec(key);
    if (!match) throw new Error('외부 업체 키 모양이 아닙니다.');
    const em = this.em.fork();
    const row = em.create(PartnerApiKey, {
      name: input.name,
      prefix: match[1],
      keyHash: sha256Hex(key),
      scopes: [...new Set(input.scopes)],
      expiresAt: input.expiresAt ?? null,
      createdBy: actor,
    });
    await em.flush();
    return { ...toPartnerKeyView(row), key };
  }

  async list(): Promise<PartnerKeyView[]> {
    return (await this.em.fork().find(PartnerApiKey, {}, { orderBy: { id: 'desc' } })).map(toPartnerKeyView);
  }

  /** 폐기. 이미 폐기된 키는 그대로 돌려준다(처음 폐기 시각 유지) */
  async revoke(id: number): Promise<PartnerKeyView> {
    const em = this.em.fork();
    const row = await em.findOne(PartnerApiKey, id);
    if (!row) throw new NotFoundException(`외부 업체 키 ${id}이(가) 없습니다.`);
    row.revokedAt ??= new Date();
    await em.flush();
    // 열이 초 단위(datetime)라 저장된 값은 밀리초가 반올림된다 — 다시 읽어 저장된 값으로 응답한다(두 번째 폐기 응답과 같게)
    return toPartnerKeyView(await this.em.fork().findOneOrFail(PartnerApiKey, id));
  }

  /**
   * 요청에 온 키 원문을 확인한다. 모양이 틀리거나, 없거나, 해시가 다르거나, 폐기·만료됐으면 null.
   * 접두사로 한 행을 찾고 해시는 timingSafeEqual로 비교한다. 맞으면 lastUsedAt을 1분에 한 번만 갱신한다(조건부 UPDATE 한 문장).
   */
  async verify(raw: string | null, now = new Date()): Promise<PartnerApiKey | null> {
    const match = raw ? KEY_PATTERN.exec(raw) : null;
    if (!raw || !match) return null;
    const em = this.em.fork();
    const row = await em.findOne(PartnerApiKey, { prefix: match[1] });
    if (!row) return null;
    if (!timingSafeEqual(Buffer.from(sha256Hex(raw), 'hex'), Buffer.from(row.keyHash, 'hex'))) return null;
    if (row.revokedAt || (row.expiresAt && row.expiresAt <= now)) return null;
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= TOUCH_EVERY_MS) {
      await em.nativeUpdate(
        PartnerApiKey,
        { id: row.id, $or: [{ lastUsedAt: null }, { lastUsedAt: { $lte: new Date(now.getTime() - TOUCH_EVERY_MS) } }] },
        { lastUsedAt: now },
      );
    }
    return row;
  }
}
```

- [ ] **Step 4: 계정 서비스**

`apps/api/src/auth/account.service.ts`:

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { AccountView, ApiErrorBody, CreateAccountRequest, UpdateAccountRequest } from '@terminal-ops/contracts';
import { Merchant } from '../merchant/merchant.entity.js';
import { hashPassword } from './password.js';
import { Role } from './role.js';
import { SessionStore } from './session.store.js';
import { UserAccount } from './user-account.entity.js';

export function toAccountView(a: UserAccount): AccountView {
  return {
    id: a.id,
    loginId: a.loginId,
    displayName: a.displayName,
    role: a.role,
    merchantCode: a.merchant?.code ?? null,
    disabled: a.disabledAt !== null,
    createdAt: a.createdAt.toISOString(),
    lastLoginAt: a.lastLoginAt?.toISOString() ?? null,
  };
}

const merchantRequired = (message: string) =>
  new BadRequestException({ statusCode: 400, code: 'MERCHANT_REQUIRED', message } satisfies ApiErrorBody);

/**
 * 계정 관리(ADMIN API, decisions/0051·0050). MERCHANT ⇔ 가맹점이 있음을 여기서 지킨다.
 * 역할·가맹점·비밀번호를 바꾸거나 사용 중지하면 그 계정의 세션을 모두 끊는다 — 세션에 역할을 넣어 두었으므로(요청마다 MySQL을 읽지 않음) 바뀐 권한은 다시 로그인해야 적용된다.
 */
@Injectable()
export class AccountService {
  constructor(
    private readonly em: EntityManager,
    private readonly sessions: SessionStore,
  ) {}

  async list(): Promise<AccountView[]> {
    return (await this.em.fork().find(UserAccount, {}, { populate: ['merchant'], orderBy: { id: 'asc' } })).map(toAccountView);
  }

  private async merchantFor(em: EntityManager, role: Role, merchantCode: string | null | undefined): Promise<Merchant | null> {
    if (role !== Role.MERCHANT) {
      if (merchantCode) throw merchantRequired('가맹점은 MERCHANT 계정에만 줄 수 있습니다.');
      return null;
    }
    if (!merchantCode) throw merchantRequired('MERCHANT 계정에는 가맹점(merchantCode)이 필요합니다.');
    const merchant = await em.findOne(Merchant, { code: merchantCode });
    if (!merchant) throw new NotFoundException(`가맹점 ${merchantCode}이(가) 없습니다.`);
    return merchant;
  }

  async create(dto: CreateAccountRequest): Promise<AccountView> {
    const em = this.em.fork();
    const role = dto.role as Role;
    const merchant = await this.merchantFor(em, role, dto.merchantCode);
    const account = em.create(UserAccount, { loginId: dto.loginId, displayName: dto.displayName, role, merchant, passwordHash: await hashPassword(dto.password) });
    await em.flush();
    return toAccountView(account);
  }

  /** 준 것만 바꾼다. 끊은 세션 수를 함께 돌려준다 */
  async update(id: number, dto: UpdateAccountRequest): Promise<{ account: AccountView; revokedSessions: number }> {
    const em = this.em.fork();
    const account = await em.findOne(UserAccount, id, { populate: ['merchant'] });
    if (!account) throw new NotFoundException(`계정 ${id}이(가) 없습니다.`);
    const role = (dto.role as Role | undefined) ?? account.role;
    const merchantCode = dto.merchantCode !== undefined ? dto.merchantCode : role === account.role ? account.merchant?.code : undefined;
    const merchant = await this.merchantFor(em, role, merchantCode);
    const accessChanged =
      role !== account.role || (merchant?.id ?? null) !== (account.merchant?.id ?? null) || dto.password !== undefined || (dto.disabled !== undefined && dto.disabled !== (account.disabledAt !== null));
    if (dto.displayName !== undefined) account.displayName = dto.displayName;
    account.role = role;
    account.merchant = merchant;
    if (dto.password !== undefined) account.passwordHash = await hashPassword(dto.password);
    if (dto.disabled !== undefined) account.disabledAt = dto.disabled ? (account.disabledAt ?? new Date()) : null;
    await em.flush();
    const revokedSessions = accessChanged ? await this.sessions.destroyAllFor(account.id) : 0;
    return { account: toAccountView(account), revokedSessions };
  }
}
```

- [ ] **Step 5: 가드의 외부 업체 길·데코레이터·모듈**

```diff
--- a/apps/api/src/auth/access.ts
+++ b/apps/api/src/auth/access.ts
@@ -1,4 +1,5 @@
 import { SetMetadata } from '@nestjs/common';
+import type { PartnerScope } from '@terminal-ops/contracts';
 import { Role } from './role.js';
 
 /**
@@ -6,7 +7,11 @@ import { Role } from './role.js';
  * 핸들러(메서드)에만 단다 — 클래스에 달아 여러 메서드에 퍼지게 하지 않는다(표와 코드가 한 줄씩 맞게).
  * 빠뜨리면 test/unit/access-table.spec.ts가 실패한다.
  */
-export type Access = { kind: 'public' } | { kind: 'roles'; roles: readonly Role[] } | { kind: 'device' };
+export type Access =
+  | { kind: 'public' }
+  | { kind: 'roles'; roles: readonly Role[] }
+  | { kind: 'device' }
+  | { kind: 'partner'; scope: PartnerScope };
 
 export const ACCESS_KEY = 'terminal-ops:access';
 
@@ -19,6 +24,9 @@ export const Roles = (...roles: Role[]) => SetMetadata(ACCESS_KEY, { kind: 'role
 /** 단말기(시뮬레이터)가 부르는 API — 단말기 키(decisions/0055) */
 export const DeviceAuth = () => SetMetadata(ACCESS_KEY, { kind: 'device' } satisfies Access);
 
+/** 외부 업체 키(Bearer 또는 X-Api-Key)로, 이 scope가 있는 키만(decisions/0054) */
+export const PartnerAuth = (scope: PartnerScope) => SetMetadata(ACCESS_KEY, { kind: 'partner', scope } satisfies Access);
+
 /** 사내 직원 전부(가맹점주 빼고). 단말기·검수·발주 조회처럼 현장 작업자도 보는 것 */
 export const STAFF = [Role.ADMIN, Role.OPERATOR, Role.MONITOR, Role.FIELD] as const;
 /** 사무실 조회(운영 현황·리포트·이력). 현장 작업자는 쓰지 않는다 */
```

```diff
--- a/apps/api/src/auth/auth.guard.ts
+++ b/apps/api/src/auth/auth.guard.ts
@@ -7,6 +7,7 @@ import { ACCESS_KEY, type Access } from './access.js';
 import { readCookie, SESSION_COOKIE } from './cookies.js';
 import type { Principal, RequestWithPrincipal } from './principal.js';
 import { Role } from './role.js';
+import { PartnerKeyService } from './partner-key.service.js';
 import { SessionStore } from './session.store.js';
 
 const UNAUTHENTICATED: ApiErrorBody = { statusCode: 401, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다(세션이 없거나 끝났습니다).' };
@@ -16,6 +17,14 @@ export const TEST_OPERATOR_HEADER = 'x-operator';
 export const TEST_ROLE_HEADER = 'x-test-role';
 /** 단말기 키 헤더(decisions/0055) */
 export const DEVICE_KEY_HEADER = 'x-device-key';
+/** 외부 업체 키 헤더(Authorization: Bearer 대신 쓸 수 있다, decisions/0054) */
+export const PARTNER_KEY_HEADER = 'x-api-key';
+
+/** `Authorization: Bearer <키>`가 있으면 그것, 없으면 `X-Api-Key` */
+export function partnerKeyOf(authorization: string | undefined, apiKey: string | undefined): string | null {
+  const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
+  return bearer ?? apiKey?.trim() ?? null;
+}
 
 function decodeName(raw: string): string {
   try {
@@ -37,7 +46,8 @@ export function testPrincipal(operator: string | undefined, role: string | undef
 /**
  * 모든 HTTP 요청의 문(APP_GUARD, decisions/0052). 핸들러의 Access 메타데이터대로:
  * 없음 → 403(기본 거부), public → 통과, roles → 세션 쿠키의 사람이 그 역할이어야(없으면 401, 역할 밖이면 403),
- * device → `X-Device-Key`가 DEVICE_API_KEY와 같아야(없거나 틀리면 401, decisions/0055).
+ * device → `X-Device-Key`가 DEVICE_API_KEY와 같아야(없거나 틀리면 401, decisions/0055),
+ * partner → 외부 업체 키가 살아 있어야(401) 그리고 그 scope가 있어야(403, decisions/0054).
  */
 @Injectable()
 export class AuthGuard implements CanActivate {
@@ -46,6 +56,7 @@ export class AuthGuard implements CanActivate {
   constructor(
     private readonly reflector: Reflector,
     private readonly sessions: SessionStore,
+    private readonly partnerKeys: PartnerKeyService,
   ) {}
 
   async canActivate(ctx: ExecutionContext): Promise<boolean> {
@@ -76,6 +87,14 @@ export class AuthGuard implements CanActivate {
         req.principal = principal;
         return true;
       }
+      case 'partner': {
+        const key = await this.partnerKeys.verify(partnerKeyOf(req.header('authorization'), req.header(PARTNER_KEY_HEADER)));
+        if (!key) throw new UnauthorizedException({ statusCode: 401, code: 'UNAUTHENTICATED', message: '외부 업체 키가 없거나, 맞지 않거나, 폐기·만료됐습니다.' } satisfies ApiErrorBody);
+        if (!key.scopes.includes(access.scope)) {
+          throw new ForbiddenException({ statusCode: 403, code: 'FORBIDDEN', message: `이 키에는 ${access.scope} 권한이 없습니다.` } satisfies ApiErrorBody);
+        }
+        return true;
+      }
     }
   }
 
```

`apps/api/src/auth/auth.module.ts`(전체):

```ts
import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AccountService } from './account.service.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { PartnerKeyService } from './partner-key.service.js';
import { SessionStore } from './session.store.js';

/** 로그인·세션·가드(보강 2). 가드는 앱 전체(APP_GUARD) — 모든 핸들러가 접근 규칙을 가져야 한다(decisions/0052) */
@Global()
@Module({
  controllers: [AuthController],
  providers: [SessionStore, AuthService, AccountService, PartnerKeyService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [SessionStore, AccountService, PartnerKeyService],
})
export class AuthModule {}
```

- [ ] **Step 6: 관리·외부 업체 컨트롤러**

`apps/api/src/admin/admin.dto.ts`:

```ts
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsIn, IsOptional, IsString, Length, Matches, ValidateIf } from 'class-validator';
import type { CreateAccountRequest, CreatePartnerKeyRequest, PartnerScope, UpdateAccountRequest } from '@terminal-ops/contracts';
import { PARTNER_SCOPES } from '../auth/partner-key.entity.js';
import { Role } from '../auth/role.js';

const LOGIN_ID = /^[a-z0-9._-]{3,50}$/;
const NOT_BLANK = /\S/;

export class CreateAccountDto implements CreateAccountRequest {
  @Matches(LOGIN_ID, { message: 'loginId는 영문 소문자·숫자·`.`·`-`·`_` 3~50자입니다.' })
  loginId!: string;

  @IsString()
  @Length(1, 50)
  @Matches(NOT_BLANK, { message: 'displayName은 공백만으로 쓸 수 없습니다.' })
  displayName!: string;

  @IsString()
  @Length(10, 200)
  password!: string;

  @IsEnum(Role)
  role!: Role;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  merchantCode?: string | null;
}

export class UpdateAccountDto implements UpdateAccountRequest {
  @IsOptional()
  @IsString()
  @Length(1, 50)
  @Matches(NOT_BLANK, { message: 'displayName은 공백만으로 쓸 수 없습니다.' })
  displayName?: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  merchantCode?: string | null;

  @IsOptional()
  @IsString()
  @Length(10, 200)
  password?: string;

  @IsOptional()
  @IsBoolean()
  disabled?: boolean;
}

export class CreatePartnerKeyDto implements CreatePartnerKeyRequest {
  @IsString()
  @Length(1, 50)
  @Matches(NOT_BLANK, { message: 'name은 공백만으로 쓸 수 없습니다.' })
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PARTNER_SCOPES.length)
  @IsIn(PARTNER_SCOPES, { each: true })
  scopes!: PartnerScope[];

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  expiresAt?: string | null;
}
```

`apps/api/src/admin/admin.controllers.ts`:

```ts
import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import type { AccountView, CreatedPartnerKeyView, PartnerKeyView } from '@terminal-ops/contracts';
import { Roles } from '../auth/access.js';
import { AccountService } from '../auth/account.service.js';
import { PartnerKeyService } from '../auth/partner-key.service.js';
import { Role } from '../auth/role.js';
import { Operator } from '../common/operator.decorator.js';
import { CreateAccountDto, CreatePartnerKeyDto, UpdateAccountDto } from './admin.dto.js';

/** 계정·역할 관리(ADMIN만, decisions/0052). 화면은 Bundle 7 이후 — 지금은 API와 테스트까지 */
@Controller('admin/accounts')
export class AdminAccountsController {
  constructor(private readonly accounts: AccountService) {}

  @Get()
  @Roles(Role.ADMIN)
  list(): Promise<AccountView[]> {
    return this.accounts.list();
  }

  @Post()
  @Roles(Role.ADMIN)
  create(@Body() dto: CreateAccountDto): Promise<AccountView> {
    return this.accounts.create(dto);
  }

  /** 역할·가맹점·비밀번호·사용 중지를 바꾸면 그 계정의 세션을 모두 끊는다(다시 로그인해야 새 권한) */
  @Patch(':id')
  @Roles(Role.ADMIN)
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateAccountDto): Promise<AccountView> {
    return (await this.accounts.update(id, dto)).account;
  }
}

/** 외부 업체 키 발급·폐기(ADMIN만, decisions/0054). 개발자센터 화면은 Bundle 7 */
@Controller('admin/partner-keys')
export class AdminPartnerKeysController {
  constructor(private readonly keys: PartnerKeyService) {}

  @Get()
  @Roles(Role.ADMIN)
  list(): Promise<PartnerKeyView[]> {
    return this.keys.list();
  }

  /** 응답의 key(원문)는 이번 한 번만 — 저장하지 않는다 */
  @Post()
  @Roles(Role.ADMIN)
  create(@Body() dto: CreatePartnerKeyDto, @Operator() actor: string): Promise<CreatedPartnerKeyView> {
    return this.keys.create({ name: dto.name, scopes: dto.scopes, expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null }, actor);
  }

  @Post(':id/revoke')
  @Roles(Role.ADMIN)
  @HttpCode(200)
  revoke(@Param('id', ParseIntPipe) id: number): Promise<PartnerKeyView> {
    return this.keys.revoke(id);
  }
}
```

`apps/api/src/admin/admin.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { AdminAccountsController, AdminPartnerKeysController } from './admin.controllers.js';

/** ADMIN 전용 API(계정, 외부 업체 키). 서비스는 AuthModule(전역)에 있다 */
@Module({
  controllers: [AdminAccountsController, AdminPartnerKeysController],
})
export class AdminModule {}
```

`apps/api/src/partner-api/partner-api.controller.ts`:

```ts
import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { OffsetPage, PartnerTerminalView } from '@terminal-ops/contracts';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PartnerAuth } from '../auth/access.js';
import { Merchant } from '../merchant/merchant.entity.js';
import type { Terminal } from '../terminal/terminal.entity.js';
import { TerminalService } from '../terminal/terminal.service.js';

export class PartnerPageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size: number = 50;
}

function toPartnerTerminalView(t: Terminal): PartnerTerminalView {
  return { serialNo: t.serialNo, modelCode: t.model.code, status: t.status, merchantCode: t.merchant?.code ?? null };
}

/**
 * 외부 업체용 읽기 API(decisions/0054). 사람 세션이 아니라 `Authorization: Bearer <키>` 또는 `X-Api-Key`로 받고, 키의 scope마다 열린다.
 * 응답은 사내 TerminalView보다 좁다(version·시각 없음) — 외부에 내보낼 필드만. 경로에 버전(v1)을 둔다(사내 API와 따로 바꾸게).
 */
@Controller('partner/v1')
export class PartnerApiController {
  constructor(
    private readonly terminals: TerminalService,
    private readonly em: EntityManager,
  ) {}

  @Get('terminals/:serialNo')
  @PartnerAuth('terminal-status:read')
  async terminal(@Param('serialNo') serialNo: string): Promise<PartnerTerminalView> {
    return toPartnerTerminalView(await this.terminals.getBySerial(serialNo));
  }

  @Get('merchants/:merchantCode/terminals')
  @PartnerAuth('merchant-terminals:read')
  async merchantTerminals(@Param('merchantCode') merchantCode: string, @Query() q: PartnerPageQuery): Promise<OffsetPage<PartnerTerminalView>> {
    if (!(await this.em.fork().count(Merchant, { code: merchantCode }))) throw new NotFoundException(`가맹점 ${merchantCode}이(가) 없습니다.`);
    const result = await this.terminals.list({ merchantCode, page: q.page, size: q.size });
    return { ...result, items: result.items.map(toPartnerTerminalView) };
  }
}
```

`apps/api/src/partner-api/partner-api.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { TerminalModule } from '../terminal/terminal.module.js';
import { PartnerApiController } from './partner-api.controller.js';

/** 외부 업체용 API `/partner/v1/...`(decisions/0054) */
@Module({
  imports: [TerminalModule],
  controllers: [PartnerApiController],
})
export class PartnerApiModule {}
```

```diff
--- a/apps/api/src/app.module.ts
+++ b/apps/api/src/app.module.ts
@@ -25,6 +25,8 @@ import { WorkersModule } from './workers/workers.module.js';
 import { SchedulerModule } from './scheduler/scheduler.module.js';
 import { AuthModule } from './auth/auth.module.js';
 import { MeModule } from './me/me.module.js';
+import { AdminModule } from './admin/admin.module.js';
+import { PartnerApiModule } from './partner-api/partner-api.module.js';
 
 export interface AppOptions {
   /** 큐 job을 처리할지(RUN_WORKERS) */
@@ -56,6 +58,8 @@ export interface AppOptions {
     ReportModule,
     DashboardModule,
     MeModule,
+    AdminModule,
+    PartnerApiModule,
   ],
   controllers: [HealthController],
   providers: [
```

- [ ] **Step 7: 엔티티 등록·계약 단언·시연 키 시드**

```diff
--- a/apps/api/src/entities.ts
+++ b/apps/api/src/entities.ts
@@ -15,6 +15,7 @@ import { VanReconciliationItem, VanReconciliationRun, VanRegistrationSnapshot }
 import { Anomaly } from './anomaly/anomaly.entity.js';
 import { WeeklyReport } from './report/weekly-report.entity.js';
 import { UserAccount } from './auth/user-account.entity.js';
+import { PartnerApiKey } from './auth/partner-key.entity.js';
 
 /** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
-export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch, ServiceTicket, DeviceConnectivity, Firmware, FirmwareRollout, FirmwareRolloutTarget, VanReconciliationRun, VanRegistrationSnapshot, VanReconciliationItem, Anomaly, WeeklyReport, UserAccount];
+export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch, ServiceTicket, DeviceConnectivity, Firmware, FirmwareRollout, FirmwareRolloutTarget, VanReconciliationRun, VanRegistrationSnapshot, VanReconciliationItem, Anomaly, WeeklyReport, UserAccount, PartnerApiKey];
```

```diff
--- a/apps/api/src/common/contract-assertions.ts
+++ b/apps/api/src/common/contract-assertions.ts
@@ -6,6 +6,7 @@
  */
 import type * as C from '@terminal-ops/contracts';
 import type { AnomalyRule } from '../anomaly/anomaly.entity.js';
+import type { PARTNER_SCOPES } from '../auth/partner-key.entity.js';
 import type { Role } from '../auth/role.js';
 import type { Carrier } from '../carrier/carrier.types.js';
 import type { RolloutStatus } from '../firmware/firmware.entities.js';
@@ -43,4 +44,5 @@ export type ContractEnumAssertions = [
   Assert<Same<`${WeeklyReportStatus}`, C.WeeklyReportStatus>>,
   Assert<Same<(typeof SYNC_RUN_OUTCOMES)[number], C.SyncRunOutcome>>,
   Assert<Same<`${Role}`, C.Role>>,
+  Assert<Same<(typeof PARTNER_SCOPES)[number], C.PartnerScope>>,
 ];
```

```diff
--- a/apps/api/src/db/seed-accounts.ts
+++ b/apps/api/src/db/seed-accounts.ts
@@ -1,4 +1,7 @@
 import type { EntityManager } from '@mikro-orm/mysql';
+import type { PartnerScope } from '@terminal-ops/contracts';
+import { PartnerApiKey } from '../auth/partner-key.entity.js';
+import { sha256Hex } from '../auth/partner-key.service.js';
 import { hashPassword } from '../auth/password.js';
 import { Role } from '../auth/role.js';
 import { UserAccount } from '../auth/user-account.entity.js';
@@ -19,6 +22,30 @@ export const DEMO_ACCOUNTS: { loginId: string; displayName: string; role: Role;
   { loginId: 'merchant-pangyo', displayName: '판교분식 점주(시연)', role: Role.MERCHANT, password: '(seed 파일 참고)', merchantCode: 'PANGYO-BUNSIK' },
 ];
 
+/**
+ * 외부 업체 시연 키(decisions/0054). 원문을 시드에 고정한 **테스트 값**이다 — 시연 때 README의 curl을 그대로 쓰게.
+ * 실제 발급(POST /admin/partner-keys)은 원문을 그 응답에서 한 번만 보여 주고 저장하지 않는다.
+ */
+export const DEMO_PARTNER_KEY = {
+  name: '데모 연동 업체(시연)',
+  key: 'pk_demo0001_iT6FP93uZalQ_kHGfNaufkHW8XgpwiJQcEbq1k0SW4g',
+  scopes: ['terminal-status:read', 'merchant-terminals:read'] as PartnerScope[],
+};
+
+/** 시연 외부 업체 키를 넣는다. 같은 접두사가 있으면 건너뛴다. 넣었으면 true */
+export async function seedDemoPartnerKey(em: EntityManager): Promise<boolean> {
+  if (await em.findOne(PartnerApiKey, { prefix: DEMO_PARTNER_KEY.key.slice(0, 11) })) return false;
+  em.create(PartnerApiKey, {
+    name: DEMO_PARTNER_KEY.name,
+    prefix: DEMO_PARTNER_KEY.key.slice(0, 11),
+    keyHash: sha256Hex(DEMO_PARTNER_KEY.key),
+    scopes: DEMO_PARTNER_KEY.scopes,
+    createdBy: 'system:seed',
+  });
+  await em.flush();
+  return true;
+}
+
 /** 시연 계정을 넣는다. 이미 있는 아이디는 건너뛴다(비밀번호·역할을 되돌리지 않는다 — 시연 중 바꾼 값을 지우지 않게). 넣은 수를 돌려준다 */
 export async function seedDemoAccounts(em: EntityManager): Promise<number> {
   let created = 0;
```

```diff
--- a/apps/api/src/db/seed.ts
+++ b/apps/api/src/db/seed.ts
@@ -1,7 +1,7 @@
 import 'reflect-metadata';
 import { MikroORM } from '@mikro-orm/mysql';
 import config from '../mikro-orm.config.js';
-import { seedDemoAccounts } from './seed-accounts.js';
+import { seedDemoAccounts, seedDemoPartnerKey } from './seed-accounts.js';
 import { seedReference } from './seed-reference.js';
 
 const orm = await MikroORM.init(config);
@@ -10,6 +10,8 @@ try {
   console.log('기준 데이터 시드 완료');
   const accounts = await seedDemoAccounts(orm.em.fork());
   console.log(`시연 계정 시드 완료(새로 ${accounts}개, 비밀번호는 src/db/seed-accounts.ts — 로컬 시연 전용 값)`);
+  const key = await seedDemoPartnerKey(orm.em.fork());
+  console.log(`시연 외부 업체 키 ${key ? '넣음' : '이미 있음'}(원문은 src/db/seed-accounts.ts DEMO_PARTNER_KEY — 로컬 시연 전용 값)`);
 } finally {
   await orm.close(true);
 }
```

- [ ] **Step 8: 통과 확인과 마이그레이션**

Run(`apps/api`): `npm run typecheck && npx vitest run test/admin-accounts.e2e.spec.ts test/partner-api.e2e.spec.ts test/unit/access-table.spec.ts 2>&1 | grep -E "Test Files|Tests "`
Expected: typecheck 0, `Test Files  3 passed (3)`, `Tests  19 passed (19)`(계정 7, 키 9, 표 3).

Run(`apps/api`, `.env`에 `DEVICE_API_KEY`가 있어야 한다 — Task 3 Step 3): `npm run db:migration:create`
Expected: `생성: Migration<시각>.ts`, `up()`이:

```ts
import { Migration } from '@mikro-orm/migrations';

export class Migration20261027155644 extends Migration {

  override name = 'Migration20261027155644';

  override up(): void | Promise<void> {
    this.addSql(`create table \`partner_api_key\` (\`id\` int unsigned not null auto_increment primary key, \`name\` varchar(50) not null, \`prefix\` varchar(16) not null, \`key_hash\` varchar(64) not null, \`scopes\` json not null, \`expires_at\` datetime null, \`revoked_at\` datetime null, \`last_used_at\` datetime null, \`created_by\` varchar(50) not null, \`created_at\` datetime not null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`partner_api_key\` add unique \`partner_api_key_prefix_unique\` (\`prefix\`);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`partner_api_key\`;`);
  }

}
```

그다음 테스트 DB를 다시 만들고 api 전체: `Test Files  75 passed (75)`, `Tests  512 passed (512)`(사전 검증 약 301초), `Connection is closed` 0.

- [ ] **Step 9: 결정 기록 0054**

`docs/decisions/0054-외부-업체-키는-해시-저장과-scope.md`:

````markdown
# 0054. 외부 업체 API 키는 해시로 저장하고 scope로 연다

- 날짜 / 관련 기능: 2026-10-28 / 보강 2, 외부 연동(개발자센터는 Bundle 7)
- 상황: 외부 업체(가상)가 단말기 상태·가맹점 단말기 목록을 읽어 가야 한다. 사람 세션이 아니라 업체별 키로, 키마다 할 수 있는 일을 좁히고, 발급·폐기는 ADMIN만 한다.
- 선택지(저장):
  1. 원문 저장 — DB가 새면 키가 그대로 쓰인다
  2. 느린 해시(scrypt, 0051) — 사람이 고른 비밀번호가 아니라 32바이트 무작위라 무차별 대입이 의미 없는데, 요청마다 약 140ms가 든다
  3. **SHA-256 + 접두사 평문** — 키 `pk_<접두사 8자>_<비밀 43자>`(32바이트 base64url). 접두사(`pk_xxxxxxxx`, unique)로 행 하나를 찾고 해시를 `timingSafeEqual`로 비교. 화면·로그는 접두사로 어느 키인지 알아본다
- 선택지(전달): `Authorization: Bearer <키>`(표준) / `X-Api-Key`(도구에서 쉽다) — **둘 다 받는다**(Bearer 먼저).
- 선택지(권한): 키별 scope 목록 / 키별 가맹점 제한 / 둘 다 — **scope만**, 두 개로 시작: `terminal-status:read`(`GET /partner/v1/terminals/:serialNo`), `merchant-terminals:read`(`GET /partner/v1/merchants/:merchantCode/terminals`). 가맹점 제한은 실제 연동 요구가 생기면.
- 결정: 3, 둘 다, scope.
  - 발급(`POST /admin/partner-keys`, ADMIN)은 원문을 그 응답에서 **한 번만** 준다. 목록에는 접두사·scope·만료·폐기·마지막 사용 시각만. 폐기(`POST /admin/partner-keys/:id/revoke`)는 바로 401이 되고, 다시 폐기해도 처음 시각을 지킨다. 만료 시각이 지나면 401.
  - 키 없음·모양 틀림·해시 다름·폐기·만료는 모두 401 `UNAUTHENTICATED`(이유를 나누지 않는다), scope 밖은 403 `FORBIDDEN`. 사람 세션으로는 `/partner/v1`을, 키로는 사내 API를 부를 수 없다(e2e).
  - `last_used_at`은 1분에 한 번만 갱신한다(조건부 UPDATE 한 문장 — 요청마다 쓰지 않게).
  - 응답은 외부용으로 좁힌다(`PartnerTerminalView`: 시리얼·모델·상태·가맹점 — version·시각 없음), 경로에 버전(`/partner/v1`)을 둔다.
  - **호출 로그 테이블은 Bundle 7로 미룬다** — 개발자센터 화면(업체가 자기 호출을 보는 곳)과 같이 만든다. 지금은 `last_used_at`이 "쓰고 있나"만 답한다.
  - 시연 키: 시드(`seed-accounts.ts` `DEMO_PARTNER_KEY`)에 원문을 고정한 테스트 값, 두 scope 모두. 버린 선택지: 시드 실행 때 무작위로 만들어 한 번 출력(시연을 반복하거나 README curl을 따라 할 때 매번 새 키를 찾아야 한다).
- 함께 넣은 계정 관리 API(ADMIN): `GET·POST /admin/accounts`, `PATCH /admin/accounts/:id`(표시 이름·역할·가맹점·비밀번호·사용 중지 — 역할·가맹점·비밀번호·사용 중지를 바꾸면 그 계정의 세션을 모두 끊는다, 0050). MERCHANT ⇔ 가맹점은 400 `MERCHANT_REQUIRED`, 같은 아이디는 409 `DUPLICATE`.
- 결과·대가: 호출 한도(rate limit)·IP 허용 목록·키 회전 자동화는 없다. 시연 키가 저장소에 공개돼 있다(로컬 시연 전용). 자기 자신(ADMIN)을 사용 중지하거나 역할을 내리는 것을 막지 않는다 — 마지막 ADMIN이 없어지면 시드나 SQL로 되살린다.
- 다시 볼 조건: 외부 업체가 실제로 붙을 때(호출 로그·한도·IP 제한·가맹점 제한), 키가 수천 개가 되어 목록이 커질 때(페이지).
````

- [ ] **Step 10: 트러블슈팅 기록 0031(사전 검증에서 만난 것)**

`docs/troubleshooting/0031-초-단위-datetime-열은-밀리초를-반올림해-응답과-다시-읽은-값이-다르다.md`:

````markdown
# 0031. 초 단위 datetime 열은 밀리초를 반올림해 응답과 다시 읽은 값이 다르다

- 날짜 / 관련 기능: 2026-10-28 / 보강 2(외부 업체 키 폐기)
- 증상: 계획 사전 검증에서 `partner-api.e2e` "폐기하면 바로 401. 다시 폐기해도 처음 시각 그대로"가 실패:
  ```
  AssertionError: expected '2026-10-27T15:55:30.000Z' to be '2026-10-27T15:55:29.790Z' // Object.is equality
  ```
  첫 폐기 응답의 `revokedAt`(…29.790Z)과 두 번째 폐기 응답(…30.000Z)이 달랐다.
- 가설: 1) 두 번째 폐기가 시각을 다시 썼다(`??=`가 안 먹음) 2) 첫 응답은 메모리의 `new Date()`(밀리초 있음)이고, DB 열은 초 단위라 저장 때 바뀐 값을 두 번째가 읽었다
- 확인: 마이그레이션의 열 정의가 `revoked_at datetime null`(소수 초 자릿수 0). 두 번째 값이 정확히 다음 초(30.000)로 **반올림**돼 있다 — 다시 썼다면 두 번째 요청 시각이어야 한다 → 1 기각, 2 확인. MySQL은 소수 초를 버리지 않고 반올림한다(`TIME_TRUNCATE_FRACTIONAL` 모드가 아니면).
- 원인: MikroORM `@Property({ type: 'datetime' })`에 길이를 주지 않으면 `datetime`(fsp 0). 응답을 메모리 엔티티에서 만들면 저장된 값과 최대 0.5초 다르다.
- 해결: `PartnerKeyService.revoke`가 flush 뒤 행을 다시 읽어 응답한다(Task 5 커밋). `lastUsedAt` 테스트는 정확한 초를 넣어 비교한다. 열 정밀도(`length: 3`)는 바꾸지 않았다 — 키·계정 시각에 밀리초가 필요 없고, 다른 테이블들과 섞여 있다.
- 배운 것: → study/backlog.md "MySQL datetime 소수 초 정밀도와 반올림"
````

`docs/study/backlog.md` 끝에:

```markdown
- [ ] MySQL `datetime`의 소수 초 정밀도(fsp)와 반올림(`TIME_TRUNCATE_FRACTIONAL`), MikroORM `length` (troubleshooting/0031)
- [ ] API 키 설계 — 접두사 + 해시 저장, 원문 한 번만, scope, 마지막 사용 시각 쓰기 줄이기 (decisions/0054)
```

- [ ] **Step 11: 색인·devlog·커밋·시각 맞추기**

`node scripts/docs-index.mjs && node scripts/docs-index.mjs --check`. devlog 항목(한 일: 계정 관리 API, 외부 업체 키 발급·폐기·확인, `/partner/v1` 두 개, 시연 키 시드, `partner_api_key` 마이그레이션, 확인: 새 e2e 2파일 16개·api 전체 75/512(Duration …s), 결정 0054, 트러블슈팅 0031, 다음: Task 6).

```bash
git add apps/api docs
git commit -m "feat(auth): 계정 관리·외부 업체 키 — /admin/accounts·partner-keys, /partner/v1, scope, 시연 키

Refs: docs/decisions/0054-외부-업체-키는-해시-저장과-scope.md, docs/troubleshooting/0031-초-단위-datetime-열은-밀리초를-반올림해-응답과-다시-읽은-값이-다르다.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Task 1 Step 14와 같이 시각·해시를 맞추고 amend.

### Task 6: 어드민 — 로그인 화면·로그아웃·역할별 메뉴·버튼·401/403

**Files:**
- Create: `apps/admin/src/session.ts`, `apps/admin/src/components/AuthGate.tsx`, `apps/admin/src/components/UserBar.tsx`, `apps/admin/src/pages/LoginPage.tsx`
- Delete: `apps/admin/src/operator.ts`, `apps/admin/src/operator.test.tsx`, `apps/admin/src/components/OperatorBar.tsx`
- Modify: `apps/admin/src/{App.tsx,nav.ts,styles.css}`, `src/api/client.ts`, `src/components/{Layout,WriteButton,ErrorBox,TerminalActions}.tsx`, `src/lib/labels.ts`, `src/pages/{HomePage,ScanPage}.tsx`, `src/pages/reports/{AnomaliesPage,VanRunsPage,WeeklyReportsPage}.tsx`, `src/test/{render.tsx,setup.ts}`
- Test: Create `apps/admin/src/pages/LoginPage.test.tsx`; Modify `src/components/Layout.test.tsx`(전체), `src/api/client.test.tsx`, `src/pages/ScanPage.test.tsx`, `src/pages/TerminalPages.test.tsx`
- Docs: `docs/decisions/0041-어드민-골격-Vite-프록시-작업자-헤더-도구.md`(보탬), `docs/devlog/2026-10-28.md`

- [ ] **Step 1: 테스트 도구와 실패하는 테스트**

`apps/admin/src/test/render.tsx`·`setup.ts`(`loginAs(이름, 역할, 가맹점)`이 화면의 내 정보를 넣는다 — 기존 호출 `loginAs()`·`loginAs('김운영')`은 그대로 운영자):

```diff
--- a/apps/admin/src/test/render.tsx
+++ b/apps/admin/src/test/render.tsx
@@ -3,7 +3,8 @@ import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
 import { render } from '@testing-library/react';
 import { MemoryRouter, Route, Routes } from 'react-router';
 import { vi } from 'vitest';
-import { setOperator } from '../operator';
+import type { Role } from '@terminal-ops/contracts';
+import { setMe } from '../session';
 
 /** 부른 요청 하나(가짜 fetch가 기록) */
 export interface Call {
@@ -71,7 +72,7 @@ export function renderPage(element: ReactElement, { route = '/', path = '/' }: {
   };
 }
 
-/** 작업자 이름을 저장해 둔다(쓰기 버튼이 켜지게) */
-export function loginAs(name = '김운영') {
-  setOperator(name);
+/** 로그인한 것으로 둔다(서버 세션 대신 화면의 내 정보만 — 쓰기 버튼이 켜지게). 기본 운영자 */
+export function loginAs(name = '김운영', role: Role = 'OPERATOR', merchantCode: string | null = null) {
+  setMe({ loginId: name, displayName: name, role, merchantCode });
 }
```

```diff
--- a/apps/admin/src/test/setup.ts
+++ b/apps/admin/src/test/setup.ts
@@ -1,13 +1,13 @@
 import '@testing-library/jest-dom/vitest';
 import { cleanup } from '@testing-library/react';
 import { afterEach, vi } from 'vitest';
-import { reloadOperatorForTest } from '../operator';
+import { resetSessionForTest } from '../session';
 
-// globals를 켜지 않아 Testing Library가 자동으로 정리하지 않는다. 테스트마다 화면·fetch 가짜·작업자 이름을 비운다
+// globals를 켜지 않아 Testing Library가 자동으로 정리하지 않는다. 테스트마다 화면·fetch 가짜·로그인 정보를 비운다
 afterEach(() => {
   cleanup();
   vi.unstubAllGlobals();
   vi.restoreAllMocks();
   window.localStorage.clear();
-  reloadOperatorForTest();
+  resetSessionForTest();
 });
```

`apps/admin/src/pages/LoginPage.test.tsx`:

```tsx
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { ErrorBox } from '../components/ErrorBox';
import { ApiError } from '../api/client';
import { getMe } from '../session';
import { dashboardBody } from '../test/fixtures';
import { loginAs, mockApi, renderPage } from '../test/render';

const HOME = { 'GET /health': () => ({ body: { status: 'ok' } }), 'GET /dashboard/summary': () => ({ body: dashboardBody() }) };
const ME_401 = { 'GET /auth/me': () => ({ status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다' } }) };

async function fillLogin(id: string, pw: string) {
  await userEvent.type(await screen.findByLabelText('아이디'), id);
  await userEvent.type(screen.getByLabelText('비밀번호'), pw);
  await userEvent.click(screen.getByRole('button', { name: '로그인' }));
}

describe('로그인·로그아웃 (보강 2, api decisions/0050)', () => {
  it('세션이 없으면(/auth/me 401) 로그인 화면 → 로그인하면 가려던 화면으로 돌아간다', async () => {
    const { calls } = mockApi({
      ...ME_401,
      ...HOME,
      'GET /terminals': () => ({ body: { items: [], total: 0, page: 1, size: 20 } }),
      'GET /terminal-models': () => ({ body: [] }),
      'POST /auth/login': () => ({ body: { loginId: 'op1', displayName: '운영 1', role: 'OPERATOR', merchantCode: null } }),
    });
    renderPage(<App />, { path: '/*', route: '/terminals' });
    await fillLogin('op1', 'pw-1234567890');
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({ loginId: 'op1', password: 'pw-1234567890' });
    expect(await screen.findByRole('heading', { name: '단말기' })).toBeInTheDocument();
    expect(screen.getByText('운영 1')).toBeInTheDocument();
    expect(getMe()).toMatchObject({ loginId: 'op1', role: 'OPERATOR' });
  });

  it('틀리면 LOGIN_FAILED 안내, 잠기면 LOGIN_LOCKED 안내 — 로그인 화면에 남는다', async () => {
    let locked = false;
    mockApi({
      ...ME_401,
      'POST /auth/login': () =>
        locked
          ? { status: 429, body: { statusCode: 429, code: 'LOGIN_LOCKED', message: '잠시 막았습니다' } }
          : { status: 401, body: { statusCode: 401, code: 'LOGIN_FAILED', message: '아이디 또는 비밀번호가 맞지 않습니다.' } },
    });
    renderPage(<App />, { path: '/*' });
    await fillLogin('op1', 'wrong-password');
    expect(await screen.findByRole('alert')).toHaveTextContent('LOGIN_FAILED');
    locked = true;
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByText(/잠시 막혔습니다/)).toBeInTheDocument();
    expect(getMe()).toBeNull();
  });

  it('로그아웃하면 POST /auth/logout 뒤 로그인 화면', async () => {
    const { calls } = mockApi({ ...HOME, 'POST /auth/logout': () => ({ status: 204 }) });
    loginAs('김운영');
    renderPage(<App />, { path: '/*' });
    await userEvent.click(await screen.findByRole('button', { name: '로그아웃' }));
    expect(await screen.findByLabelText('아이디')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/auth/logout')).toBe(true);
    expect(getMe()).toBeNull();
  });

  it('쓰는 중에 세션이 끝나면(401) 로그인 화면으로 간다', async () => {
    mockApi({
      'GET /health': () => ({ body: { status: 'ok' } }),
      'GET /dashboard/summary': () => ({ status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '세션이 끝났습니다' } }),
    });
    loginAs('김운영');
    renderPage(<App />, { path: '/*' });
    expect(await screen.findByLabelText('아이디')).toBeInTheDocument();
  });

  it('현장 작업자는 처음 화면 대신 박스 스캔, 메뉴는 단말기·박스 스캔 둘', async () => {
    mockApi({ 'GET /purchase-orders': () => ({ body: { items: [], nextBeforeId: null } }) });
    loginAs('현장1', 'FIELD');
    renderPage(<App />, { path: '/*' });
    expect(await screen.findByRole('heading', { name: '박스 스캔' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: '메뉴' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['단말기', '박스 스캔']);
  });

  it('가맹점주는 사내 어드민 대신 안내와 로그아웃만', async () => {
    mockApi({});
    loginAs('점주1', 'MERCHANT', 'GANGNAM-KIMBAP');
    renderPage(<App />, { path: '/*' });
    expect(await screen.findByText(/가맹점 계정은 사내 운영 어드민을 쓰지 않습니다/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '메뉴' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeInTheDocument();
  });

  it('403 FORBIDDEN은 권한 안내', () => {
    renderPage(<ErrorBox error={new ApiError(403, 'FORBIDDEN', '이 작업은 OPERATOR 역할만 할 수 있습니다(지금: MONITOR).', null)} />);
    expect(screen.getByRole('alert')).toHaveTextContent('이 작업을 할 권한이 없습니다');
    expect(screen.getByRole('alert')).toHaveTextContent('FORBIDDEN');
  });
});
```

`apps/admin/src/components/Layout.test.tsx`(전체 — 작업자 이름 테스트를 로그인한 사람·역할별 메뉴·쓰기 버튼으로):

```tsx
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { dashboardBody } from '../test/fixtures';
import { loginAs, mockApi, renderPage } from '../test/render';
import { WriteButton } from './WriteButton';

const HOME = { 'GET /health': () => ({ body: { status: 'ok' } }), 'GET /dashboard/summary': () => ({ body: dashboardBody() }) };

describe('틀 — 로그인한 사람과 역할별 메뉴 (decisions/0041, api decisions/0052)', () => {
  it('처음 화면은 api 연결(GET /health)을 보여 준다', async () => {
    mockApi(HOME);
    loginAs();
    renderPage(<App />, { path: '/*' });
    expect(await screen.findByText('ok')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '메뉴' })).toBeInTheDocument();
  });

  it('api가 없으면 연결 실패와 오류를 보여 준다', async () => {
    mockApi({
      'GET /health': () => ({ status: 502, body: { statusCode: 502, code: 'PARTNER_ERROR', message: '연결 실패' } }),
      'GET /dashboard/summary': () => ({ body: dashboardBody() }),
    });
    loginAs();
    renderPage(<App />, { path: '/*' });
    expect(await screen.findByRole('alert')).toHaveTextContent('PARTNER_ERROR');
  });

  it('위쪽에 표시 이름·아이디·역할, 작업자 이름 입력칸은 없다', async () => {
    mockApi(HOME);
    loginAs('박운영');
    renderPage(<App />, { path: '/*' });
    expect(await screen.findByText('박운영')).toBeInTheDocument();
    expect(screen.getByLabelText('역할')).toHaveTextContent('운영자');
    expect(screen.queryByLabelText('작업자 이름')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeInTheDocument();
  });

  it('메뉴는 역할에 맞는 것만 — 관제는 박스 스캔이 없고, 운영자는 모두', async () => {
    mockApi(HOME);
    loginAs('관제1', 'MONITOR');
    renderPage(<App />, { path: '/*' });
    const nav = await screen.findByRole('navigation', { name: '메뉴' });
    expect(within(nav).queryByRole('link', { name: '박스 스캔' })).not.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: '단말기' })).toBeInTheDocument();
    expect(within(nav).getAllByRole('link')).toHaveLength(9);
  });

  it('쓰기 버튼: 로그인 정보가 없으면 꺼지고, 운영자면 켜지고, 역할이 아니면 보이지 않는다', () => {
    const { unmount } = renderPage(<WriteButton>바꾸기</WriteButton>);
    expect(screen.getByRole('button', { name: '바꾸기' })).toBeDisabled();
    unmount();
    loginAs('운영1', 'OPERATOR');
    const op = renderPage(<WriteButton>바꾸기</WriteButton>);
    expect(screen.getByRole('button', { name: '바꾸기' })).toBeEnabled();
    op.unmount();
    loginAs('관제1', 'MONITOR');
    renderPage(
      <>
        <WriteButton>바꾸기</WriteButton>
        <WriteButton roles={['OPERATOR', 'MONITOR']}>찾기</WriteButton>
      </>,
    );
    expect(screen.queryByRole('button', { name: '바꾸기' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '찾기' })).toBeEnabled();
  });
});
```

```diff
--- a/apps/admin/src/api/client.test.tsx
+++ b/apps/admin/src/api/client.test.tsx
@@ -1,23 +1,30 @@
 import { render, screen } from '@testing-library/react';
 import { describe, expect, it, vi } from 'vitest';
 import { ErrorBox } from '../components/ErrorBox';
-import { setOperator } from '../operator';
-import { mockApi } from '../test/render';
+import { getMe } from '../session';
+import { loginAs, mockApi } from '../test/render';
 import { api, ApiError, toQueryString } from './client';
 
 describe('api 클라이언트 (decisions/0041)', () => {
-  it('/api를 붙여 부르고, 작업자 이름이 있으면 X-Operator를 URL 인코딩해 붙인다', async () => {
+  it('/api를 붙여 부르고, 인증 헤더는 붙이지 않는다(세션은 브라우저가 붙이는 httpOnly 쿠키, 보강 2)', async () => {
     const { calls } = mockApi({ 'POST /terminals': () => ({ status: 201, body: { serialNo: 'A-1' } }) });
-    setOperator('김운영');
+    loginAs('김운영');
     expect(await api('/terminals', { method: 'POST', body: { serialNo: 'A-1' } })).toEqual({ serialNo: 'A-1' });
     expect(calls[0]).toMatchObject({ method: 'POST', path: '/terminals', body: { serialNo: 'A-1' } });
-    expect(calls[0].headers).toMatchObject({ 'X-Operator': encodeURIComponent('김운영'), 'Content-Type': 'application/json' });
+    expect(calls[0].headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/json' });
   });
 
-  it('작업자 이름이 없으면 X-Operator를 보내지 않는다', async () => {
-    const { calls } = mockApi({ 'GET /health': () => ({ body: { status: 'ok' } }) });
-    await api('/health');
-    expect(calls[0].headers['X-Operator']).toBeUndefined();
+  it('401이면 로그인 정보를 비운다(AuthGate가 로그인 화면으로). 로그인 요청 자체의 401은 비우지 않는다', async () => {
+    mockApi({
+      'GET /terminals': () => ({ status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다' } }),
+      'POST /auth/login': () => ({ status: 401, body: { statusCode: 401, code: 'LOGIN_FAILED', message: '틀림' } }),
+    });
+    loginAs('김운영');
+    await api('/auth/login', { method: 'POST', body: {} }).catch(() => undefined);
+    expect(getMe()).not.toBeNull();
+    const error = await api('/terminals').catch((e: unknown) => e);
+    expect(error).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
+    expect(getMe()).toBeNull();
   });
 
   it('쿼리는 빈 값을 뺀다', () => {
```

```diff
--- a/apps/admin/src/pages/ScanPage.test.tsx
+++ b/apps/admin/src/pages/ScanPage.test.tsx
@@ -100,7 +100,7 @@ describe('박스 스캔 (F6, decisions/0020)', () => {
     expect(bodyOf(posts(calls)[1]).scanId).not.toBe(bodyOf(posts(calls)[0]).scanId);
   });
 
-  it('작업자 이름이 없으면 보내기가 꺼진다', async () => {
+  it('로그인 정보가 없으면 보내기가 꺼진다', async () => {
     mockApi({});
     renderPage(<ScanPage />);
     await userEvent.click(screen.getByLabelText(/회수 입고/));
```

```diff
--- a/apps/admin/src/pages/TerminalPages.test.tsx
+++ b/apps/admin/src/pages/TerminalPages.test.tsx
@@ -130,7 +130,7 @@ describe('단말기 상세 (F2, decisions/0040)', () => {
   });
   const open = () => renderPage(<TerminalDetailPage />, { route: '/terminals/AS-1', path: '/terminals/:serialNo' });
 
-  it('기본 정보와 타임라인(최근 것부터), 서버가 준 전이만 버튼으로. 작업자 이름이 없으면 바꾸기가 꺼진다', async () => {
+  it('기본 정보와 타임라인(최근 것부터), 서버가 준 전이만 버튼으로. 로그인 정보가 없으면 바꾸기가 꺼진다', async () => {
     mockApi(common(() => detail({ allowedTransitions: [{ to: 'DELIVERED', blockedReason: null }, { to: 'IN_STOCK', blockedReason: '재검수 필수' }] })));
     open();
     expect(await screen.findByText('강남김밥 (GANGNAM-KIMBAP)')).toBeInTheDocument();
@@ -162,7 +162,7 @@ describe('단말기 상세 (F2, decisions/0040)', () => {
     expect(await screen.findByRole('button', { name: '→ 운영 중' })).toBeInTheDocument();
     const post = calls.find((c) => c.method === 'POST')!;
     expect(post.body).toEqual({ to: 'DELIVERED', reason: '현장 확인', expectedVersion: 1 });
-    expect(post.headers['X-Operator']).toBe(encodeURIComponent('김운영'));
+    expect(post.headers['X-Operator']).toBeUndefined(); // 작업자는 서버가 세션에서 정한다(보강 2)
   });
 
   it('409 VERSION_CONFLICT면 안내와 "다시 불러오기" — 누르면 상세를 다시 읽는다', async () => {
```

작업자 이름 저장소의 테스트를 지운다: `git rm apps/admin/src/operator.test.tsx`

- [ ] **Step 2: 실패를 확인한다**

Run(`apps/admin`): `npx vitest run 2>&1 | grep -E "Test Files|Tests |FAIL"`
Expected: `../session`·`./pages/LoginPage`를 찾지 못해 여러 파일 FAIL(render.tsx를 모두가 쓰므로 대부분).

- [ ] **Step 3: 내 정보 저장소·api 클라이언트**

`apps/admin/src/session.ts`:

```ts
import { useSyncExternalStore } from 'react';
import type { MeView, Role } from '@terminal-ops/contracts';

/**
 * 지금 로그인한 사람(보강 2, api decisions/0050). 세션 자체는 서버의 httpOnly 쿠키라 화면 JS는 읽지 못하고, 여기에는 GET /auth/me의 결과만 둔다.
 * - undefined: 아직 모름(처음 화면을 열면 AuthGate가 /auth/me를 부른다)
 * - null: 로그인 안 함(또는 세션이 끝남 — api()가 401을 받으면 null로 바꾼다)
 * 저장소(localStorage)에 남기지 않는다 — 새로 열면 서버에 다시 묻는다(서버가 진실).
 */
export type MeState = MeView | null | undefined;

let current: MeState = undefined;
const listeners = new Set<() => void>();

export function getMe(): MeState {
  return current;
}

export function setMe(me: MeView | null): void {
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

/** 이 사람이 이 역할 중 하나인가. 화면에서 메뉴·버튼을 숨길 때만 쓴다 — 최종 판단은 서버(403) */
export function hasRole(me: MeState, roles: readonly Role[]): boolean {
  return !!me && roles.includes(me.role);
}

/** 화면 쪽 역할 묶음(api auth/access.ts의 STAFF·OFFICE와 같은 뜻, api decisions/0052) */
export const STAFF: readonly Role[] = ['ADMIN', 'OPERATOR', 'MONITOR', 'FIELD'];
export const OFFICE: readonly Role[] = ['ADMIN', 'OPERATOR', 'MONITOR'];

/** 테스트용: 모르는 상태로 되돌린다 */
export function resetSessionForTest(): void {
  setMe(null);
  current = undefined;
}
```

```diff
--- a/apps/admin/src/api/client.ts
+++ b/apps/admin/src/api/client.ts
@@ -1,5 +1,5 @@
 import type { ApiErrorBody, ErrorCode } from '@terminal-ops/contracts';
-import { getOperator } from '../operator';
+import { setMe } from '../session';
 
 /** 개발 서버 프록시가 Nest api로 넘기는 경로 앞부분(vite.config.ts, decisions/0041) */
 export const API_BASE = '/api';
@@ -49,14 +49,15 @@ function messageOf(status: number, body: unknown): string {
   return `HTTP ${status}`;
 }
 
+/** 로그인 요청 자체의 401(LOGIN_FAILED)은 세션이 끝난 것이 아니다 */
+const LOGIN_PATH = '/auth/login';
+
 /**
- * api 호출 한 곳. 작업자 이름이 있으면 모든 요청에 X-Operator(URL 인코딩, decisions/0001·0041)를 붙인다.
- * 2xx가 아니면 ApiError를 던진다 — 화면은 ErrorBox로 code·message를 보여 준다.
+ * api 호출 한 곳. 로그인은 서버 세션 쿠키(httpOnly, 같은 출처라 브라우저가 붙인다 — api decisions/0050)라 여기서 붙이는 인증 헤더는 없다.
+ * 2xx가 아니면 ApiError를 던진다 — 화면은 ErrorBox로 code·message를 보여 준다. 401이면 로그인 정보를 비워 AuthGate가 로그인 화면으로 보낸다.
  */
 export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
   const headers: Record<string, string> = { Accept: 'application/json' };
-  const operator = getOperator();
-  if (operator) headers['X-Operator'] = encodeURIComponent(operator);
   if (options.body !== undefined) headers['Content-Type'] = 'application/json';
   const res = await fetch(`${API_BASE}${path}${toQueryString(options.query)}`, {
     method: options.method ?? 'GET',
@@ -73,6 +74,7 @@ export async function api<T>(path: string, options: RequestOptions = {}): Promis
     }
   }
   if (!res.ok) {
+    if (res.status === 401 && path !== LOGIN_PATH) setMe(null);
     // 서버가 contracts 밖의 코드를 주지 않는다는 전제(api는 ErrorCode 유니온 밖의 코드를 컴파일하지 못한다, decisions/0048)
     const code = (body as Partial<ApiErrorBody> | null)?.code;
     throw new ApiError(res.status, typeof code === 'string' ? code : null, messageOf(res.status, body), body);
@@ -80,5 +82,5 @@ export async function api<T>(path: string, options: RequestOptions = {}): Promis
   return body as T;
 }
 
-/** 파일 내려받기 주소(브라우저가 직접 연다 — 헤더가 필요 없는 GET만) */
+/** 파일 내려받기 주소(브라우저가 직접 연다 — 같은 출처라 세션 쿠키가 붙는다) */
 export const downloadUrl = (path: string) => `${API_BASE}${path}`;
```

`git rm apps/admin/src/operator.ts apps/admin/src/components/OperatorBar.tsx`

- [ ] **Step 4: 로그인 화면·문·위쪽 사용자 표시**

`apps/admin/src/pages/LoginPage.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import type { LoginRequest, MeView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { ErrorBox } from '../components/ErrorBox';
import { setMe, useMe } from '../session';

/** 로그인(api decisions/0050). 성공하면 서버가 httpOnly 세션 쿠키를 주고, 화면은 응답(내 정보)만 기억한다 */
export function LoginPage() {
  const me = useMe();
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

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate({ loginId: loginId.trim(), password } satisfies LoginRequest);
  };

  return (
    <form className="login" onSubmit={submit}>
      <h1>단말온 운영 어드민</h1>
      <label>
        아이디 <input aria-label="아이디" autoComplete="username" value={loginId} maxLength={50} onChange={(e) => setLoginId(e.target.value)} />
      </label>
      <label>
        비밀번호{' '}
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

`apps/admin/src/components/AuthGate.tsx`:

```tsx
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { MeView } from '@terminal-ops/contracts';
import { api, ApiError } from '../api/client';
import { setMe, useMe } from '../session';
import { ErrorBox } from './ErrorBox';
import { UserBar } from './UserBar';

/**
 * 로그인해야 보이는 화면들의 문. 처음에는 GET /auth/me로 서버 세션을 확인하고, 로그인 안 했으면(401) 로그인 화면으로 보낸다(돌아올 주소를 함께).
 * 가맹점주는 이 사내 어드민을 쓰지 않는다 — 안내와 로그아웃만(가맹점 화면은 다음 묶음, API는 `/me`).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
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

  if (me === undefined) return error ? <ErrorBox error={error} /> : <p>로그인 확인 중…</p>;
  if (me === null) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  if (me.role === 'MERCHANT') {
    return (
      <div className="login">
        <p>가맹점 계정은 사내 운영 어드민을 쓰지 않습니다. 가맹점 화면은 다음 묶음에서 열립니다.</p>
        <UserBar />
      </div>
    );
  }
  return <>{children}</>;
}
```

`apps/admin/src/components/UserBar.tsx`:

```tsx
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { ROLE_LABEL } from '../lib/labels';
import { setMe, useMe } from '../session';

/**
 * 위쪽: 로그인한 사람(표시 이름·아이디·역할)과 로그아웃. 작업자 이름 입력(OperatorBar, decisions/0041)을 대신한다 —
 * 이력의 작업자는 이제 서버가 세션에서 정한다(api decisions/0056).
 */
export function UserBar() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (!me) return null;

  const logout = async () => {
    setBusy(true);
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // 서버 세션이 이미 끝났어도 화면은 로그아웃한다
    } finally {
      queryClient.clear(); // 다른 사람이 로그인했을 때 앞사람의 화면 데이터가 보이지 않게
      setMe(null);
    }
  };

  return (
    <div className="user">
      <span>
        <strong>{me.displayName}</strong> ({me.loginId}) · <span aria-label="역할">{ROLE_LABEL[me.role]}</span>
        {me.merchantCode ? ` · ${me.merchantCode}` : null}
      </span>
      <button type="button" disabled={busy} onClick={() => void logout()}>
        로그아웃
      </button>
    </div>
  );
}
```

- [ ] **Step 5: 경로·메뉴·틀·쓰기 버튼**

```diff
--- a/apps/admin/src/App.tsx
+++ b/apps/admin/src/App.tsx
@@ -1,5 +1,8 @@
-import { Route, Routes } from 'react-router';
+import { Navigate, Route, Routes } from 'react-router';
+import { AuthGate } from './components/AuthGate';
 import { Layout } from './components/Layout';
+import { LoginPage } from './pages/LoginPage';
+import { useMe } from './session';
 import { BatchHistoryPage } from './pages/BatchHistoryPage';
 import { AnomaliesPage } from './pages/reports/AnomaliesPage';
 import { PurchaseOrdersPage } from './pages/reports/PurchaseOrdersPage';
@@ -14,12 +17,24 @@ import { ServiceTicketsPage } from './pages/ServiceTicketsPage';
 import { TerminalDetailPage } from './pages/TerminalDetailPage';
 import { TerminalListPage } from './pages/TerminalListPage';
 
-/** 화면 경로. 메뉴(nav.ts)와 함께 고친다 */
+/** 처음 화면(운영 현황)은 사무실 역할용. 현장 작업자는 박스 스캔이 처음 화면이다 */
+function Home() {
+  return useMe()?.role === 'FIELD' ? <Navigate to="/scans" replace /> : <HomePage />;
+}
+
+/** 화면 경로. 메뉴(nav.ts)와 함께 고친다. /login 말고는 모두 로그인해야 보인다(AuthGate) */
 export function App() {
   return (
     <Routes>
-      <Route element={<Layout />}>
-        <Route index element={<HomePage />} />
+      <Route path="login" element={<LoginPage />} />
+      <Route
+        element={
+          <AuthGate>
+            <Layout />
+          </AuthGate>
+        }
+      >
+        <Route index element={<Home />} />
         <Route path="terminals" element={<TerminalListPage />} />
         <Route path="terminals/:serialNo" element={<TerminalDetailPage />} />
         <Route path="scans" element={<ScanPage />} />
```

`apps/admin/src/nav.ts`(전체):

```ts
import type { Role } from '@terminal-ops/contracts';
import { OFFICE, STAFF } from './session';

/**
 * 왼쪽 메뉴. 화면을 더할 때 여기와 App.tsx의 Route를 함께 고친다.
 * roles: 이 메뉴를 보이는 역할 — 그 화면이 부르는 api의 역할(api decisions/0052)과 맞춘다. 숨겨도 주소로 들어오면 서버가 403으로 막는다.
 */
export const NAV: { to: string; label: string; roles: readonly Role[] }[] = [
  { to: '/', label: '처음', roles: OFFICE },
  { to: '/terminals', label: '단말기', roles: STAFF },
  { to: '/scans', label: '박스 스캔', roles: ['OPERATOR', 'FIELD'] },
  { to: '/service-tickets', label: 'A/S', roles: OFFICE },
  { to: '/firmware-rollouts', label: '펌웨어 배포', roles: OFFICE },
  { to: '/reports/anomalies', label: '이상 단말기', roles: OFFICE },
  { to: '/reports/van', label: 'VAN 대조', roles: OFFICE },
  { to: '/reports/purchase-orders', label: '발주 입고 대조', roles: OFFICE },
  { to: '/reports/weekly', label: '주간 리포트', roles: OFFICE },
  { to: '/batch-runs', label: '배치 실행 이력', roles: OFFICE },
];
```

`apps/admin/src/components/Layout.tsx`(전체):

```tsx
import { NavLink, Outlet } from 'react-router';
import { NAV } from '../nav';
import { hasRole, useMe } from '../session';
import { UserBar } from './UserBar';

/** 공통 틀: 위쪽 제목·로그인한 사람, 왼쪽 메뉴(역할에 맞는 것만), 오른쪽 화면 */
export function Layout() {
  const me = useMe();
  return (
    <div className="app">
      <header className="top">
        <h1>단말온 운영 어드민</h1>
        <UserBar />
      </header>
      <nav className="side" aria-label="메뉴">
        {NAV.filter((item) => hasRole(me, item.roles)).map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === '/'}>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
```

`apps/admin/src/components/WriteButton.tsx`(전체):

```tsx
import type { ButtonHTMLAttributes } from 'react';
import type { Role } from '@terminal-ops/contracts';
import { hasRole, useMe } from '../session';

/**
 * 쓰기 버튼. roles(기본 운영자)가 아닌 사람에게는 보이지 않는다 — 서버도 403으로 막는다(api decisions/0052).
 * 로그인 정보를 아직 모르면(또는 없으면) 꺼진 채로 보인다.
 */
export function WriteButton({ disabled, title, roles = ['OPERATOR'], ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { roles?: readonly Role[] }) {
  const me = useMe();
  if (me && !hasRole(me, roles)) return null;
  return <button type="button" {...rest} disabled={!me || disabled} title={!me ? '로그인이 필요합니다' : title} />;
}
```

- [ ] **Step 6: 이름표·오류 안내·역할이 다른 버튼·문구·스타일**

```diff
--- a/apps/admin/src/lib/labels.ts
+++ b/apps/admin/src/lib/labels.ts
@@ -1,9 +1,18 @@
-import type { Carrier, TerminalStatus, TransitionSource } from '@terminal-ops/contracts';
+import type { Carrier, Role, TerminalStatus, TransitionSource } from '@terminal-ops/contracts';
 
 /**
  * 화면에 보이는 이름만 둔다(규칙은 두지 않는다 — 가능한 전이는 서버가 준다, decisions/0040).
  * 키는 contracts의 상태 유니온이다 — 값이 하나라도 빠지거나 없는 값이 있으면 tsc가 막는다(decisions/0048). 모르는 값이 오면 값을 그대로 보여 준다(label()).
  */
+/** 역할(api decisions/0052) */
+export const ROLE_LABEL: Record<Role, string> = {
+  ADMIN: '관리자',
+  OPERATOR: '운영자',
+  MONITOR: '관제',
+  FIELD: '현장 작업자',
+  MERCHANT: '가맹점주',
+};
+
 export const TERMINAL_STATUS_LABEL: Record<TerminalStatus, string> = {
   RECEIVED: '입고',
   INSPECTED: '검수 합격',
```

```diff
--- a/apps/admin/src/components/ErrorBox.tsx
+++ b/apps/admin/src/components/ErrorBox.tsx
@@ -10,6 +10,10 @@ const HINT: Partial<Record<ErrorCode, string>> = {
   PARTNER_ERROR: '외부 업체(가상) 응답이 실패했습니다. 잠시 뒤 다시 시도하세요.',
   VAN_RECONCILIATION_RUNNING: '이미 진행 중인 작업이 있습니다. 끝난 뒤 다시 실행하세요.',
   ANOMALY_SCAN_RUNNING: '이미 진행 중인 작업이 있습니다. 끝난 뒤 다시 실행하세요.',
+  FORBIDDEN: '이 작업을 할 권한이 없습니다(역할 확인).',
+  UNAUTHENTICATED: '로그인이 끝났습니다. 다시 로그인하세요.',
+  LOGIN_FAILED: '아이디 또는 비밀번호가 맞지 않습니다.',
+  LOGIN_LOCKED: '로그인 실패가 많아 잠시 막혔습니다. 잠시 뒤 다시 시도하세요.',
 };
 
 export function describeError(error: unknown): { title: string; detail: string; code: ErrorCode | null } {
```

```diff
--- a/apps/admin/src/components/TerminalActions.tsx
+++ b/apps/admin/src/components/TerminalActions.tsx
@@ -200,6 +200,7 @@ function InspectForm({ terminal, onReload }: { terminal: TerminalDetail; onReloa
         }}
       />
       <WriteButton
+        roles={['OPERATOR', 'FIELD']}
         disabled={inspect.isPending}
         onClick={() => inspect.mutate(items.data.map((item) => ({ itemCode: item.code, passed: !failed[item.code] })))}
       >
```

```diff
--- a/apps/admin/src/pages/ScanPage.tsx
+++ b/apps/admin/src/pages/ScanPage.tsx
@@ -139,6 +139,7 @@ export function ScanPage() {
         {scanId ? <code aria-label="scanId">{scanId}</code> : null}
         <WriteButton
           className="primary"
+          roles={['OPERATOR', 'FIELD']}
           disabled={serials.length === 0 || serials.length > 500 || (kind === 'RECEIVE' && !poNo) || scan.isPending || result !== undefined}
           onClick={send}
         >
```

```diff
--- a/apps/admin/src/pages/reports/AnomaliesPage.tsx
+++ b/apps/admin/src/pages/reports/AnomaliesPage.tsx
@@ -47,7 +47,7 @@ export function AnomaliesPage() {
           <option value="false">닫힌 것</option>
           <option value="">전체</option>
         </select>
-        <WriteButton disabled={scan.isPending} onClick={() => scan.mutate()}>
+        <WriteButton roles={['OPERATOR', 'MONITOR']} disabled={scan.isPending} onClick={() => scan.mutate()}>
           {scan.isPending ? '찾는 중' : '지금 찾기'}
         </WriteButton>
       </div>
```

```diff
--- a/apps/admin/src/pages/reports/VanRunsPage.tsx
+++ b/apps/admin/src/pages/reports/VanRunsPage.tsx
@@ -37,7 +37,7 @@ export function VanRunsPage() {
         <label>
           <input type="checkbox" checked={acknowledgeDrop} onChange={(e) => setAcknowledgeDrop(e.target.checked)} /> 수집 급감 확인함(이번 실행만 급감 검사 건너뜀)
         </label>
-        <WriteButton className="primary" disabled={start.isPending} onClick={() => start.mutate()}>
+        <WriteButton className="primary" roles={['OPERATOR', 'MONITOR']} disabled={start.isPending} onClick={() => start.mutate()}>
           대조 실행
         </WriteButton>
         <button type="button" onClick={() => void list.refetch()}>
```

```diff
--- a/apps/admin/src/pages/reports/WeeklyReportsPage.tsx
+++ b/apps/admin/src/pages/reports/WeeklyReportsPage.tsx
@@ -71,7 +71,7 @@ export function WeeklyReportsPage() {
           주(월요일){' '}
           <input aria-label="보낼 주" type="date" max={maxWeek} value={weekStart} onChange={(e) => setWeekStart(e.target.value)} />
         </label>
-        <WriteButton className="primary" disabled={weekProblem !== null || send.isPending} onClick={() => send.mutate(weekStart)}>
+        <WriteButton className="primary" roles={['OPERATOR', 'MONITOR']} disabled={weekProblem !== null || send.isPending} onClick={() => send.mutate(weekStart)}>
           보내기
         </WriteButton>
         {weekProblem ? <span className="bad">{weekProblem}</span> : null}
@@ -129,7 +129,7 @@ export function WeeklyReportsPage() {
                 </td>
                 <td>
                   {r.status !== 'SENT' && !r.queued ? (
-                    <WriteButton disabled={send.isPending} onClick={() => send.mutate(r.weekStart)}>
+                    <WriteButton roles={['OPERATOR', 'MONITOR']} disabled={send.isPending} onClick={() => send.mutate(r.weekStart)}>
                       다시 보내기
                     </WriteButton>
                   ) : null}
```

```diff
--- a/apps/admin/src/pages/HomePage.tsx
+++ b/apps/admin/src/pages/HomePage.tsx
@@ -125,7 +125,7 @@ export function HomePage() {
       <ul className="hint">
         <li>시각은 모두 한국 시간(KST)으로 보여 줍니다.</li>
         <li>운영 현황 숫자는 서버가 잠시 재사용하는 집계입니다(기본 30초). 바로 보려면 새로고침을 누르세요.</li>
-        <li>바꾸는 작업(전이·스캔·A/S 등)은 위쪽에 작업자 이름을 저장해야 할 수 있습니다. 이름은 이력에 남습니다.</li>
+        <li>바꾸는 작업(전이·스캔·A/S 등)은 역할에 따라 보이고, 이력에는 로그인 아이디가 남습니다.</li>
       </ul>
     </section>
   );
```

```diff
--- a/apps/admin/src/styles.css
+++ b/apps/admin/src/styles.css
@@ -71,18 +71,19 @@ body {
   min-width: 0;
 }
 
-.operator {
+.user {
   display: flex;
   align-items: center;
   gap: 8px;
 }
 
-.operator-missing {
-  color: var(--warn);
-}
-
-.operator-now {
-  color: var(--muted);
+.login {
+  display: flex;
+  flex-direction: column;
+  gap: 12px;
+  max-width: 360px;
+  margin: 64px auto;
+  padding: 0 16px;
 }
 
 table {
```

- [ ] **Step 7: 통과 확인**

Run(`apps/admin`): `npm run build 2>&1 | tail -2 && npx vitest run 2>&1 | grep -E "Test Files|Tests " && grep -rn "X-Operator\|operator" src --include=*.ts --include=*.tsx`
Expected: `✓ built in …ms`(tsc 포함), `Test Files  12 passed (12)`, `Tests  111 passed (111)`, grep은 `TerminalPages.test.tsx`의 `toBeUndefined()` 한 줄만. `grep -c "terminal-ops/contracts" dist/assets/*.js` → 0.

- [ ] **Step 8: decisions/0041 보탬**

`docs/decisions/0041-어드민-골격-Vite-프록시-작업자-헤더-도구.md` 끝에:

```markdown
### 보강 2 보탬 (로그인 — api decisions/0050·0052·0056)
- 작업자 이름 입력(`OperatorBar`, `operator.ts`, localStorage `terminal-ops.operator`)과 `X-Operator` 헤더를 지웠다. 로그인은 서버 세션 쿠키(httpOnly)라 화면 JS가 토큰을 다루지 않는다 — `api()`는 인증 헤더를 붙이지 않고, 같은 출처(Vite 프록시)라 브라우저가 쿠키를 붙인다.
- `session.ts`는 `GET /auth/me` 결과만 기억한다(undefined = 모름, null = 로그인 안 함). localStorage에 두지 않는다 — 새로 열면 서버에 다시 묻는다. 저장소 구독은 작업자 이름 때와 같은 `useSyncExternalStore`.
- `AuthGate`가 로그인해야 보이는 화면들을 감싼다: 모르면 `/auth/me`, 401이면 `/login`으로(돌아올 주소를 state로), 가맹점주면 안내와 로그아웃만. 어떤 요청이든 401(로그인 요청 자체 빼고)이면 `api()`가 내 정보를 비워 로그인 화면으로 간다. 로그아웃은 쿼리 캐시를 비운다(다음 사람이 앞사람 데이터를 보지 않게).
- 메뉴(`nav.ts`의 `roles`)와 쓰기 버튼(`WriteButton roles`, 기본 운영자)은 역할이 아니면 숨긴다. 서버가 최종 판단하고, 403 `FORBIDDEN`은 ErrorBox가 "권한이 없습니다"로 안내한다. 현장 작업자의 처음 화면은 박스 스캔.
- 버린 선택지: 내 정보를 TanStack Query로(`useQuery(['me'])`) — 모든 쓰기 버튼이 쿼리를 구독해 화면 테스트마다 `/auth/me` 가짜 응답이 필요해진다(지금 테스트는 `loginAs()` 한 줄). 쓰기 버튼을 역할 밖에서도 꺼진 채 보이기 — 브리프의 "숨김"과 다르고, 할 수 없는 일을 화면이 늘어놓는다.
```

- [ ] **Step 9: devlog·커밋·시각 맞추기**

devlog 항목(한 일: 로그인 화면·AuthGate·UserBar·역할별 메뉴·버튼, 작업자 입력 삭제, 401 → 로그인, 확인: admin 12/111·build, 결정 0041 보탬, 다음: Task 7).

```bash
git add apps/admin docs
git status --short
git commit -m "feat(auth, 어드민): 로그인 화면 — 세션 확인·로그아웃, 역할별 메뉴·버튼, 401 → 로그인, 작업자 입력칸 삭제

Refs: docs/decisions/0041-어드민-골격-Vite-프록시-작업자-헤더-도구.md, docs/decisions/0050-로그인은-Redis-서버-세션과-httpOnly-쿠키로.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Task 1 Step 14와 같이 시각·해시를 맞추고 amend.

### Task 7: 마감 — 전체 검증, 개발 DB 마이그레이션·시드, 실서버 확인, README·색인·회고, 0001 대체

**Files:**
- Modify: `README.md`, `docs/retrospective.md`, `docs/decisions/0001-인증은-작업자-헤더로.md`, `docs/index.md`(스크립트), `docs/devlog/2026-10-28.md`(Task 7 항목 + `## 보강 2 요약`)

- [ ] **Step 1: 전체 검증**

시작 전 node PID 목록을 적어 둔다. 테스트 DB를 다시 만든다.

Run(`apps/api`): `npm run typecheck && echo tsc=0; npx vitest run > ../../.auth-final.log 2>&1; grep -E "Test Files|Tests |Duration" ../../.auth-final.log; grep -c "Connection is closed" ../../.auth-final.log; rm ../../.auth-final.log; npm run build && grep -rl "terminal-ops/contracts" dist | wc -l`
Expected: `tsc=0`, `Test Files  75 passed (75)`, `Tests  512 passed (512)`, `0`, build 성공, `0`.

Run(`apps/admin`): `npm run build 2>&1 | tail -1 && npx vitest run 2>&1 | grep -E "Test Files|Tests "` → `12 passed (12)`, `111 passed (111)`.
Run(`apps/device-sim`): `npx tsc --noEmit -p tsconfig.json && npx vitest run 2>&1 | grep -E "Test Files|Tests "` → `5 passed (5)`, `43 passed (43)`.
Run(`apps/partners`): `npx tsc --noEmit -p tsconfig.json && npx vitest run 2>&1 | grep -E "Test Files|Tests "` → `6 passed (6)`, `53 passed (53)`.

- [ ] **Step 2: 개발 DB 마이그레이션·시드(허용된 쓰기)**

Run(`apps/api`): `npm run db:migrate && npm run db:seed && node dist/db/migrate.js check`
Expected: `적용: Migration<Task 1 시각>, Migration<Task 5 시각>`, `기준 데이터 시드 완료`, `시연 계정 시드 완료(새로 7개 …)`, `시연 외부 업체 키 넣음 …`, `최신 상태`. 다시 돌리면 계정 0개·키 "이미 있음"(멱등).

- [ ] **Step 3: 실서버 확인 — 테스트 DB로 쓰기 흐름, 개발 DB로 로그인·읽기**

(a) 테스트 DB: 사전 검증과 같은 흐름을 curl로 — 테스트 DB를 다시 만들고 `MYSQL_DATABASE=terminal_ops_test node dist/db/migrate.js up && MYSQL_DATABASE=terminal_ops_test node dist/db/seed.js`, 그다음 `apps/api`에서 단독 백그라운드 명령으로 띄운다:

```bash
MYSQL_DATABASE=terminal_ops_test API_PORT=3100 QUEUE_PREFIX=auth-live RUN_WORKERS=0 RUN_SCHEDULERS=0 node dist/main.js > ../../.auth-live.log 2>&1 &
netstat -ano | grep ':3100 .*LISTENING'   # Windows PID를 적는다
```

curl로(쿠키는 `-c`/`-b` 파일, 비밀번호는 `src/db/seed-accounts.ts`에서 — 출력·devlog에 옮겨 적지 않는다) 사전 검증 목록의 각 줄(`/health` 200, 로그인 없음 401, `X-Operator`만 401, 틀린 비밀번호 401 LOGIN_FAILED, operator 로그인 200·HttpOnly, `/auth/me`, 등록·검수·재고·배정, 이력 actor, monitor 쓰기 403, field 대시보드 403, merchant `/me/terminals` 자기 것만·남의 것 404·`/terminals` 403, 로그아웃 204 뒤 401, 단말기 키 없음 401·있음 200, 시연 외부 업체 키 Bearer 200·키 없음 401)을 확인해 상태 코드를 devlog에 적는다. 끝나면 `taskkill //PID <PID> //F`, 3100 LISTENING 없음, `MSYS_NO_PATHCONV=1 docker exec terminal-ops-redis redis-cli --scan --pattern 'auth-live*'`로 본 키만 하나씩 `DEL`(사전 검증: 큐 meta 6 + 세션 3 + 계정 색인 3), 다시 scan 출력 없음. 테스트 DB를 다시 만든다(빈 DB).

(b) 개발 DB: 같은 방식으로 `API_PORT=3100 QUEUE_PREFIX=auth-live RUN_WORKERS=0 RUN_SCHEDULERS=0 node dist/main.js`(MYSQL_DATABASE는 `.env` 그대로)로 띄워 operator·monitor·field·merchant-gangnam 로그인 200과 `/auth/me`, `GET /terminals?size=1`(operator 200, merchant 403), `GET /me/terminals`(merchant 200)만 본다 — 쓰기 없음. 끄고 키를 지운다.

(c) 화면은 컨트롤러가 내장 브라우저로 본다(admin `npm run dev` + api) — 이 Task는 띄우지 않는다.

- [ ] **Step 4: 0001 대체 표시**

`docs/decisions/0001-인증은-작업자-헤더로.md`의 첫 줄(제목) 바로 아래에 한 줄을 넣는다(제목 줄은 그대로 — 색인 스크립트가 첫 줄을 읽는다):

```markdown

> **대체됨 → [0050](0050-로그인은-Redis-서버-세션과-httpOnly-쿠키로.md)** (2026-10-28, 보강 2). 작업자는 로그인 아이디([0056](0056-작업자는-로그인-아이디-X-Operator는-테스트-전용.md)), 역할 표는 [0052](0052-역할별-엔드포인트-표와-기본-거부.md). `X-Operator` 헤더는 테스트 전용 인증 길로만 남았다.
```

- [ ] **Step 5: README**

- "구성" 트리의 `apps/api` 줄 뒤 설명에 `로그인·역할(보강 2)`을 더하고, `packages/contracts` 설명에 `로그인·계정·키 타입`.
- "실행": `cp .env.example .env` 줄 뒤에 "(보강 2 뒤 `.env`가 이미 있으면 `.env.example`의 `# 보강 2` 아래 줄들을 덧붙인다 — `DEVICE_API_KEY`가 없으면 api가 뜨지 않는다)". `npm run db:seed` 설명을 `기준 데이터와 시연 계정 7개·시연 외부 업체 키`로.
- 새 절 `## 로그인과 역할(보강 2)` — 역할 다섯 줄 설명, 시연 계정 표(아이디·역할·가맹점; **비밀번호는 표에 적지 않고** "`apps/api/src/db/seed-accounts.ts`의 로컬 시연 전용 값"), 어드민은 `http://localhost:5173/login`, curl 예(로그인 → 쿠키 → 호출, 외부 업체 키 `Authorization: Bearer $(grep -o "pk_demo0001_[^']*" apps/api/src/db/seed-accounts.ts)`), 단말기 키는 `.env`의 `DEVICE_API_KEY`(device-sim이 같은 env를 읽음). 굵게: "**여기 나오는 비밀번호·키는 저장소에 공개된 로컬 시연 전용 값이다. 다른 곳에 쓰지 않는다.**"
- "기능" 표에 줄 하나: `| 로그인·권한(보강 2) | 서버 세션(Redis)·httpOnly 쿠키, 역할 다섯과 엔드포인트 표(기본 거부, 전수 검사 테스트), 가맹점주 /me 범위, 외부 업체 키·scope, 단말기 키 | apps/api/src/auth/, src/me/, src/admin/, src/partner-api/, apps/admin/src/session.ts·components/AuthGate.tsx |`
- "실험 결과" 표에 0017 줄(질문: 인증 뒤 하트비트 처리량, 숫자: 기본 부하 30,000/30,000·오류 0, 단건 최대 4,023 → 3,824/s(−4.9%, 번갈아 3라운드), 묶음 100 차이 없음, 결론: 공유 단말기 키 유지(decisions/0055)). 이번 실행에서 다시 잰 값이 있으면 그 값으로.
- "기록" 줄의 수: 결정 56·트러블슈팅 31·실험 17(색인 스크립트 출력과 맞춘다).
- "테스트" 표: api 75/512, admin 12/111, partners 6/53, device-sim 5/43, 표 위 문장 "(보강 2 로그인·권한 뒤 실제로 돌려 센 값 …)".

- [ ] **Step 6: 회고·색인**

`docs/retrospective.md` 6장 "### 7일 뒤 보강"에 보강 1 항목 뒤로:

```markdown
- [x] **보강 2: 로그인·권한** — decisions/0001의 "다시 볼 조건"(역할별 권한)이 왔다. Redis 서버 세션·httpOnly 쿠키([0050](decisions/0050-로그인은-Redis-서버-세션과-httpOnly-쿠키로.md)), scrypt([0051](decisions/0051-비밀번호-해시는-node-scrypt-계정-테이블은-user-account.md)), 역할 다섯과 엔드포인트 표·기본 거부·전수 검사 테스트([0052](decisions/0052-역할별-엔드포인트-표와-기본-거부.md)), 가맹점주 `/me` 범위([0053](decisions/0053-가맹점주-범위는-me-전용-엔드포인트와-서비스-scope.md)), 외부 업체 키([0054](decisions/0054-외부-업체-키는-해시-저장과-scope.md)), 단말기 키([0055](decisions/0055-단말기는-공유-단말기-키로.md), 실험 0017), 작업자 = 로그인 아이디·테스트 전용 헤더 길([0056](decisions/0056-작업자는-로그인-아이디-X-Operator는-테스트-전용.md)). 기존 테스트 453개는 다섯 줄만 고쳐 통과. 기록: devlog 2026-10-28, [계획](plans/2026-10-28-auth-roles.md)
  - 보강 2가 남긴 것: CSRF 토큰 없음(SameSite만), HTTPS·절대 만료·IP별 실패 제한 없음, 단말기 키 하나(단말기별 폐기 불가), 외부 업체 호출 로그·한도 없음(Bundle 7), 계정·키 관리 화면 없음(Bundle 7), 가맹점 화면 없음(Bundle 3), 계정 행을 SQL로 고치면 세션의 역할은 그대로, 마지막 ADMIN 사용 중지를 막지 않음
```

`node scripts/docs-index.mjs && node scripts/docs-index.mjs --check`

- [ ] **Step 7: devlog와 보강 2 요약, 커밋**

Task 7 항목(한 일·확인: Step 1~3의 숫자와 상태 코드, 막힌 것, 다음: 최종 리뷰) 뒤에:

```markdown
## 보강 2 요약

**한 일**: 사람 로그인(Redis 세션·httpOnly 쿠키), 역할 다섯과 엔드포인트 표(기본 거부), 가맹점주 범위, 외부 업체 키, 단말기 키, 작업자 = 로그인 아이디, 어드민 로그인 화면.

**커밋**(오래된 것부터 — `git log --oneline 7487fe4..HEAD`로 채운다)

**결정**(decisions/0050~0056)
- 0050 세션: Redis 서버 세션 + httpOnly·SameSite=Strict 쿠키(JWT는 즉시 반영에 결국 서버 상태), 아이디별 실패 제한
- 0051 scrypt N=2^15·r=8·p=3(의존성 0), `user_account`
- 0052 핸들러마다 규칙, 없으면 403, 표 전체를 단위 테스트가 대조
- 0053 가맹점주는 `/me` + 서비스 scope, 범위 밖 404
- 0054 외부 업체 키 SHA-256 + 접두사, Bearer/X-Api-Key, scope 2개, 호출 로그는 Bundle 7, 시연 키 고정
- 0055 공유 단말기 키(실험 0017: 단건 최대 −4.9%, 묶음 차이 없음)
- 0056 actor = 로그인 아이디, `X-Operator`는 테스트 전용 인증 길(NODE_ENV=test만)

**숫자**: api 66/453 → 75/512, admin 12/109 → 12/111, device-sim 4/40 → 5/43, partners 6/53

**찾은 것**: 브랜치를 오가며 같은 테스트 DB를 쓰면 `schema.refresh`가 막힘(troubleshooting/0030), 초 단위 datetime 반올림(0031)

**남은 것**: [retrospective.md 6장 "7일 뒤 보강"](../retrospective.md) 보강 2 항목
```

```bash
git add README.md docs
git status --short
git commit -m "docs: 보강 2 마감 — 전체 검증, 실서버 확인, README·색인·회고, 0001 대체 표시

Refs: docs/decisions/0050-로그인은-Redis-서버-세션과-httpOnly-쿠키로.md, docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md, docs/decisions/0056-작업자는-로그인-아이디-X-Operator는-테스트-전용.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

devlog 시각·해시를 맞추고 amend. 마지막으로 `netstat -ano | grep -E ':(3000|3100|4010|4011|4020|4021|5173) .*LISTENING'` 출력 없음, node PID 목록이 시작과 같음, `git status --short` 출력 없음, 테스트 DB 빈 DB. 브랜치는 병합·push하지 않는다(컨트롤러가 정한다).

---

## 자체 점검

- 브리프 대응: 1(사람 로그인·해시·세션·실패 제한) → Task 1·2(0050·0051), 2(역할·`@Roles`·기본 거부·전수 검사) → Task 2(0052), 3(가맹점 범위) → Task 4(0053), 4(외부 업체 키·scope·발급·폐기·호출 로그 미룸) → Task 5(0054), 5(단말기 키·device-sim·0008 성능) → Task 3(0055, 실험 0017), 6(`@Operator()` 이전·`X-Operator` 처리·`system:` 그대로·테스트 최소 수정) → Task 2(0056), 7(어드민 로그인·로그아웃·내 정보·OperatorBar 제거·역할별 숨김·401·403·계약 타입) → Task 1(계약)·Task 6, 8(시드 계정·시연 키·README 문구) → Task 1·5·7. 0001 대체 표시 → Task 7. 보안 메모(다룬 것·안 다룬 것) → 0050·0054·0055 본문, 스펙 6장.
- 이름 일치: 계약 `Role`·`MeView`·`AccountView`·`CreateAccountRequest`·`UpdateAccountRequest`·`PartnerScope`·`PartnerKeyView`·`CreatedPartnerKeyView`·`CreatePartnerKeyRequest`·`PartnerTerminalView`·`AuthErrorCode`(Task 1)를 Task 2·4·5·6이 같은 이름으로 쓴다. api `Principal`(Task 2) → `merchantScopeOf`(Task 4). `SessionStore.destroyAllFor`(Task 2) → `AccountService.update`(Task 5). `Access`의 `partner` 종류와 `PartnerAuth`는 Task 5에서 더하고 표 테스트의 `describeAccess`도 그때 바뀐다.
- 플레이스홀더 검사: 코드 블록은 모두 사전 검증 커밋에서 뽑은 실제 코드다(Task 1 `dcb8bba`, 2 `6b1fe18`, 3 `e2628a9`, 4 `d200684`, 5 `85d483a`, 6 `0932e4f` — 임시 폴더 `authcheck`). 실행 때 채우는 것은 devlog의 `HH:MM`·해시·`Duration`, 실험 0017의 "이번 실행 값", 마이그레이션 파일 이름(시각)뿐이다. Task 2 가드의 `case 'device': return true`는 Task 3이 바꾸는 중간 상태다(주석으로 표시).
- 안전: 개발 DB 쓰기는 Task 1·5의 마이그레이션 만들기(읽기)와 Task 7 Step 2의 migrate·seed, Step 3(b)의 로그인뿐. 실서버 쓰기 흐름은 테스트 DB. Redis는 접두사 키만 지운다. 비밀번호·키 원문은 seed 파일·`.env.example`에만.
