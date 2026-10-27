# 보강 1 — 공유 타입 패키지 `packages/contracts` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **기록 규칙 필수**: 이 저장소의 `CLAUDE.md`를 먼저 읽는다. 모든 Task는 마지막에 `docs/devlog/2026-10-27.md`(Day 7 기록과 7일차 요약 뒤에 컨트롤러가 `# 보강 1: 공유 타입 패키지` 구분 줄과 `## HH:MM 공유 타입 패키지 계획 작성` 항목을 만들어 두었다. 작업 중 날짜가 바뀌면 그날 날짜로 새 파일 `docs/devlog/YYYY-MM-DD.md`를 시작하고 첫 줄에 이전 파일을 링크한다)에 항목을 덧붙이고(Day 7 항목과 같은 형식: 제목 시각 = 커밋 시각, `이전 커밋:`, 한 일·확인·막힌 것·결정·다음), Task에 적힌 결정 기록을 쓴 뒤 **코드와 같은 커밋**에 넣는다. 예상과 다른 에러를 만나면 고치기 전에 `docs/troubleshooting/`에 기록을 시작한다(다음 번호 0029). 실험 번호는 이번에 쓰지 않는다(다음 0017).

**Goal:** api 응답·요청 모양, 상태 값 목록, 오류 코드를 `packages/contracts` 한 곳에 두고, api가 그 모양을 지키지 않으면 api tsc가 실패하게 하며, 어드민은 자기 타입(`src/api/types.ts`와 화면 안 로컬 타입 14개)을 지우고 그 패키지를 import한다.

**Architecture:** 계약은 **타입만 있는** TS 소스 패키지(런타임 값·의존성 없음)이고, api·admin이 각자 `file:../../packages/contracts`로 의존한다(npm이 `node_modules/@terminal-ops/contracts` 링크를 만든다). 모든 import는 `import type`이라 빌드 결과와 런타임(node·swc·Vite)은 이 패키지를 읽지 않는다. api는 응답을 만드는 함수의 반환 타입, DTO의 `implements`, `BusinessError` 생성자 오버로드, 런타임 enum ↔ 계약 유니온 양방향 타입 단언으로 계약을 지킨다. 어긋남을 잡는다는 것은 컴파일러 API 테스트(계약을 메모리에서 바꿔 api를 검사)로 보인다. 설계 스펙: `docs/specs/2026-10-27-shared-contracts.md`.

**Tech Stack:** TypeScript 6.0(api ~6.0.2 → 설치 6.0.3, admin 6.0.3), api Nest.js 12.2(ESM, NodeNext, tsc 빌드, vitest 5 + unplugin-swc), admin React 19.3 + Vite 8.3.4(bundler 해석, vitest 5.0.4). 새 외부 의존성 없음(로컬 `file:` 의존 하나).

---

## 프로세스·데이터 안전 규칙 (모든 Task에 적용)

- **프로세스는 PID로만 끈다.** `taskkill /IM node.exe`, `pkill node`처럼 이름으로 끄지 않는다(다른 세션·IDE의 node가 함께 죽는다). Git Bash에서 `cd 폴더 && node … &`처럼 **목록 전체**를 백그라운드로 보내면 `$!`는 node가 아니라 그 서브셸의 PID라 `kill $!`로 node가 꺼지지 않는다(사전 검증에서 실제로 포트가 남았다). 서버는 `node …`를 단독 명령으로 `&` 보내거나, `netstat -ano | grep ':<포트> .*LISTENING'`으로 Windows PID를 찾아 `taskkill //PID <PID> //F`로 끈다.
- **Redis를 통째로 지우지 않는다.** `FLUSHALL`·`FLUSHDB` 금지. api를 직접 띄워 보는 확인은 `QUEUE_PREFIX`를 따로 주고(`RUN_WORKERS=0`이어도 큐마다 `<접두사>:<큐>:meta` 키 6개가 생긴다) 끝나면 `redis-cli --scan --pattern '<접두사>*'`로 본 키만 `DEL`한다.
- **테스트는 테스트 DB(`terminal_ops_test`)에서만.** 개발 DB(`terminal_ops`)에는 아무것도 쓰지 않는다(이번 보강은 마이그레이션도 시드도 없다). 테스트 DB는 지우고 다시 만들어도 된다:
  ```bash
  MSYS_NO_PATHCONV=1 docker exec terminal-ops-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "drop database terminal_ops_test; create database terminal_ops_test character set utf8mb4 collate utf8mb4_0900_ai_ci; grant all privileges on terminal_ops_test.* to '"'"'terminal_ops'"'"'@'"'"'%'"'"';"'
  ```
- **api 테스트를 두 개 동시에 돌리지 않는다**(globalSetup이 partners를 테스트 포트 4011에 띄운다, troubleshooting/0006). admin 테스트는 같이 돌려도 된다.
- **오래 도는 서버·백그라운드 명령을 남긴 채 끝내지 않는다.** 끝나면 `netstat -ano | grep -E ':(3000|3100|4010|4011|5173) .*LISTENING'` 결과가 없어야 하고 `tasklist //FI "IMAGENAME eq node.exe"`가 시작 전과 같은 PID만 보여야 한다.
- **긴 기록·코드 편집은 Write·Edit 도구로 한다**(troubleshooting/0024: Bash heredoc 안의 따옴표·백틱이 깨진다).
- **계약 파일을 일부러 바꿔 보는 확인(Task 2·4)은 끝나면 반드시 되돌리고 `git status`로 확인한다.** 되돌리지 않은 채 커밋하지 않는다.

## 사전 검증으로 확인된 사실 (2026-10-27, 임시 폴더)

계획 작성 전에 저장소(브랜치 `shared-contracts`, master 5d6a870)를 임시 폴더에 복제하고 `npm ci`로 설치한 뒤, 연결 방식 후보를 실제로 해 보고 이 계획의 코드를 Task 순서대로 적용해 돌렸다(테스트 DB `terminal_ops_test`, Redis는 테스트 접두사와 확인용 접두사만). 검증 뒤 확인용 Redis 키는 지웠고 테스트 DB는 빈 DB로 다시 만들었다.

- **연결 방식 비교(decisions/0047의 근거)**:
  - (b) `file:../../packages/contracts` + TS 소스 exports(`"types": "./src/index.ts"`): `npm install ../../packages/contracts`가 `package.json`에 한 줄, `package-lock.json`에 9줄을 더하고 `node_modules/@terminal-ops/contracts` 링크를 만든다. api `npm run build`(rootDir `src`) 성공 — TS6059 없음, `dist`에 계약 파일이 나오지 않고 `grep -rl "terminal-ops/contracts" dist`가 0곳. `node dist/main.js`(테스트 DB, 포트 3100, `RUN_WORKERS=0 RUN_SCHEDULERS=0`)가 떠서 `GET /terminals?size=1`·`/anomaly-rules`·`/terminal-models`·`/sync-runs?limit=1`이 응답했다. admin tsc·vitest·vite build 성공. 두 앱 모두 `rm -rf node_modules && npm ci`로 새로 설치해도 링크가 생기고 빌드가 된다.
  - (b') 같은 의존 + 손으로 쓴 `index.d.ts`: 필드 이름 변경은 잡지만, 계약 안의 오타 `version: Foo`가 api tsc를 **통과했다**(exit 0). 두 앱 모두 `skipLibCheck: true`라 `.d.ts`를 검사하지 않는다. 같은 오타를 TS 소스에 넣으면 api·admin 모두 `../../packages/contracts/src/index.ts(21,12): error TS2304: Cannot find name 'Foo'.`
  - (c) api tsconfig `paths`: `npx tsc --noEmit -p tsconfig.json`부터 `error TS6059: File '…/packages/contracts/src/index.ts' is not under 'rootDir' '…/apps/api'. 'rootDir' is expected to contain all source files.`(build도 같은 오류, `rootDir … /apps/api/src`)
  - (a) 루트 workspaces(`"workspaces": ["apps/*", "packages/*"]`, 앱별 lock 삭제, 루트 `npm install`): 25초에 설치, api build·admin tsc·vite build는 됨. 그러나 앱별 lock 네 개에 잠겨 있던 버전 707개 중 43개가 바뀌었다(`@nestjs/common`·`core`·`platform-express`·`testing` 12.2.0 → 12.3.2, `@swc/core` 1.16.18 → 1.16.20 …). api의 vitest는 `apps/api/node_modules`에 따로 깔렸다(admin이 5.0.4로 고정).
  - (d) OpenAPI: `npm view @nestjs/swagger` 12.0.5(peer `@nestjs/core ^12.0.0`, TS ^6.0.0)로 설치는 가능하다. 설치·생성은 하지 않았다 — 이유는 decisions/0047.
- **어긋남이 잡히는 모습(이 계획 코드 적용 뒤, api)**:
  - 계약 `TerminalView.serialNo` → `serialNumber`: `npm run build` → `src/terminal/terminal.views.ts(10,5): error TS2353: Object literal may only specify known properties, and 'serialNo' does not exist in type 'TerminalView'.` (다른 곳은 `toTerminalView`를 거치므로 이 한 줄뿐)
  - 계약 `TerminalStatus`에서 `'DISPOSED'` 빼기: `src/common/contract-assertions.ts(29,10): error TS2344: Type '{ onlyInApi: "DISPOSED"; }' does not satisfy the constraint 'true'.`(+ 그 상태를 응답에 넣는 view 함수의 TS2322들)
  - 계약 `ScanKind`에 `'REPAIR_IN'` 더하기: `src/common/contract-assertions.ts(33,10): error TS2344: Type '{ onlyInContract: "REPAIR_IN"; }' does not satisfy the constraint 'true'.`
  - 계약 오류 코드에서 `'PO_CLOSED'` 빼기: `src/scan/scan.service.ts`에서 `TS2769 No overload matches this call`
  - 계약 `TerminalView`에 `installedAt` 더하기: `terminal.views.ts`에서 `TS2741 Property 'installedAt' is missing`
  - 계약 `OpenTicketRequest.symptom` → `description`: `service-ticket.dto.ts`에서 `TS2420 Class 'OpenTicketDto' incorrectly implements interface 'OpenTicketRequest'`
- **어긋남이 잡히는 모습(admin)**: 계약 오류 코드에서 `'SCAN_IN_PROGRESS'` 빼기 → `src/pages/ScanPage.tsx(33,84): error TS2367: This comparison appears to be unintentional because the types 'ErrorCode | null' and '"SCAN_IN_PROGRESS"' have no overlap.` 계약 `'IN_STOCK'` → `'STOCKED'` → `src/lib/labels.ts(11,3): error TS2353: … 'IN_STOCK' does not exist in type 'Record<TerminalStatus, string>'.`과 테스트 가짜 응답들의 TS2322. 단, GET 쿼리(`query: { status: 'IN_STOCK' }`)는 잡히지 않는다(계약 범위 밖, decisions/0049).
- **실제 어긋남 하나를 찾았다**: `apps/admin/src/pages/BatchHistoryPage.test.tsx`의 가짜 주간 리포트가 `status: 'FAILED'`(두 곳)였다. 서버의 `WeeklyReportStatus`는 `PENDING | GENERATED | SENT`뿐이다. 화면은 이 값에 기대지 않아 테스트는 통과하고 있었다 → Task 3이 `PENDING`·`GENERATED`로 고친다.
- **contract-drift 테스트**: TypeScript 컴파일러 API(`ts.createProgram` + 계약 파일 하나만 바꿔 돌려주는 CompilerHost, `oldProgram`으로 재사용)로 7개 경우가 약 6~10초. 저장소가 `core.autocrlf=true`라 체크아웃한 파일이 CRLF일 수 있다 — 줄바꿈을 포함해 바꾸는 경우(`'PO_CLOSED'` 줄 지우기)는 `/ {2}\| 'PO_CLOSED'\r?\n/`로 쓴다(CRLF·LF 두 경우 모두 돌려 확인). 계약 파일이 아직 없을 때 돌리면 7개 모두 실패한다(TDD 빨강).
- **`Same<A extends B, B extends A>`는 쓸 수 없다**: `TS2313: Type parameter 'A' has a circular constraint.` → 조건부 타입 `Same<Api, Contract>`가 `true` 또는 `{ onlyInApi: … } / { onlyInContract: … }`를 내고 `Assert<T extends true>`로 막는다(계획 코드).
- **`BusinessError` 오버로드를 넣으면 api에서 두 곳만 실패한다**: 코드를 `string`으로 받는 `rollout.service.ts`의 `wrongStatus(…, code: string)`과 `service-ticket.service.ts`의 `lockOpen(…, code = 'TICKET_NOT_OPEN')`. 리터럴로 던지는 17곳은 이미 계약과 같았다.
- **`SyncRun.outcome`을 `SyncRunOutcome`으로 좁히면** `sync-run.controller.ts`의 where 조건이 `string`이라 TS2345 → `ListSyncRunsQuery.outcome`도 `SyncRunOutcome`(`@IsIn(SYNC_RUN_OUTCOMES)` 그대로). 빌드 결과 메타데이터는 `__metadata("design:type", String)` 그대로라 스키마가 바뀌지 않는다.
- **계약 인터페이스는 `Record<string, unknown>`에 넣을 수 없다**: `test/weekly-report.e2e.spec.ts`의 `body: toWeeklyReportView(…)`가 `TS2322 … Index signature for type 'string' is missing` → `{ ...toWeeklyReportView(…) }`로 펼친다.
- **`kill $!`이 node를 끄지 못한 경우**: 임시 폴더에서 `cd apps/api && … node dist/main.js > log 2>&1 &` 뒤 `kill $!`을 했더니 포트 3100이 그대로 LISTENING(Windows PID 42520)이었다. 같은 명령을 `apps/api`에 선 채 `… node dist/main.js > log 2>&1 &` 단독으로 띄우면 `kill $!`로 꺼졌다 — `&&` 목록 전체가 서브셸로 백그라운드에 가서 `$!`가 그 서브셸이었다. 남은 node는 `taskkill //PID 42520 //F`로 껐다. Task 4의 기동 확인은 단독 명령 + netstat PID로 끈다.
- **테스트 수(누적, 실제로 돌려서 센 값)**: api master 65개 파일 446 → Task 1 66/450 → Task 2 66/453(api 전체 약 262초). admin master 12/109(README 표의 108은 Day 7 최종 리뷰 반영 전 숫자 — master에서 돌리면 109) → Task 3 12/109 그대로. partners 6/53, device-sim 4/40은 바뀌지 않는다. 임시 폴더에서 device-sim을 설치하지 않았더니 api의 `device-sim.e2e.spec.ts`가 `Cannot find module 'typescript/bin/tsc'`로 실패했다 — api 전체 테스트에는 `apps/device-sim/node_modules`가 필요하다(실제 저장소는 설치돼 있다).

## 범위 조정 (브리프와 다르게 한 것과 이유)

- **계약에 런타임 값을 두지 않는다**(브리프는 `as const` 배열 몇 개를 허용). 어드민의 선택지 목록은 이름표 `Record<유니온, string>`의 키로 만들고(빠짐·남음을 tsc가 잡음), 순서가 필요한 짧은 배열(`OUTCOMES`, `OPEN_PO_STATUSES`)은 `as const satisfies readonly 유니온[]`(없는 값만 잡음)으로 둔다. 값이 들어오면 연결 방식부터 다시 봐야 해서다(decisions/0047 다시 볼 조건).
- **쿼리 문자열은 계약에 넣지 않는다**(decisions/0049). 쓰기 요청 본문만 넣는다.
- **어드민 런타임 테스트는 늘리지 않는다.** 어드민의 계약 검사는 `npm run build`/`typecheck`의 tsc이고, "어긋나면 실패한다"는 api 쪽 contract-drift 테스트와 Task 3의 수동 확인(출력 기록)으로 보인다.
- **api의 `TransitionTarget`(transition-rules.ts)은 그대로 둔다.** enum을 쓰는 내부 타입이고, view 경계에서 계약 `TransitionTarget[]`에 맞는지 tsc가 본다.

## 파일 구조

```
terminal-ops/
├─ packages/contracts/ (새)
│  ├─ package.json, tsconfig.json                         (Task 1)
│  └─ src/index.ts, statuses.ts, errors.ts, common.ts     (Task 1)
│     src/terminal.ts, operations.ts, reports.ts, requests.ts (Task 2, index.ts 보탬)
├─ apps/api/
│  ├─ package.json, package-lock.json                     (Task 1) file: 의존
│  ├─ src/common/contract-assertions.ts (새)              (Task 1) enum ↔ 유니온 단언
│  ├─ src/common/domain-errors.ts, domain-exception.filter.ts, upload.interceptor.ts (Task 1)
│  ├─ src/firmware/rollout.service.ts                     (Task 1 오류 코드, Task 2 StageStats·RolloutView)
│  ├─ src/report/weekly-report.controller.ts              (Task 1 ApiErrorBody, Task 2 WeeklyReportPage)
│  ├─ src/scan/scan.service.ts, service/service-ticket.service.ts, terminal/terminal-import.service.ts (Task 1)
│  ├─ src/terminal/bulk-rows.ts, shipment/shipment.entities.ts, shipment/dto/list-sync-runs.query.ts (Task 1)
│  ├─ src/**/*.views.ts 4개, 서비스·집계 10개, 컨트롤러 14개, dto 10개 파일 (Task 2)
│  └─ test/unit/contract-drift.spec.ts (새, Task 1·2), test/weekly-report.e2e.spec.ts (Task 2)
├─ apps/admin/
│  ├─ package.json, package-lock.json                     (Task 3)
│  ├─ src/api/types.ts (지움), api/client.ts, api/lists.ts, components/ErrorBox.tsx, components/TerminalActions.tsx, lib/labels.ts (Task 3)
│  └─ src/pages/** 17개 파일, test/fixtures.ts              (Task 3)
├─ docs/decisions/0047·0048 (Task 1), 0049 (Task 2), 0048 보탬 (Task 3)
└─ README.md, docs/index.md, docs/retrospective.md        (Task 4)
```

명령은 별도 표시가 없으면 `terminal-ops/apps/api`(Task 1·2) 또는 `terminal-ops/apps/admin`(Task 3)에서 실행한다. Docker 명령이 PATH에 없으면 `"/c/Program Files/Docker/Docker/resources/bin/docker.exe"`를 쓴다. MySQL·Redis 컨테이너가 떠 있어야 한다(`docker compose ps`).

기록 번호: decisions 0047·0048(Task 1), 0049(Task 2), 0048 보탬(Task 3). troubleshooting·experiments는 예약하지 않는다(새로 생기면 troubleshooting 0029부터). devlog는 `docs/devlog/2026-10-27.md`의 `# 보강 1: 공유 타입 패키지` 아래에 이어 쓴다.

코드 블록에 "전체"라고 적힌 파일은 그 내용으로 파일 전체를 쓴다(새 파일). `diff` 블록은 그 Task 직전 파일에 대한 바뀐 부분이다(`-` 줄을 지우고 `+` 줄을 넣는다, 앞뒤 세 줄은 위치 확인용). 모두 사전 검증 저장소의 Task별 상태에서 그대로 가져왔다. `package-lock.json`의 diff는 손으로 쓰지 않는다 — `npm install ../../packages/contracts`가 만든 결과가 계획의 diff와 같은지 본다.

devlog의 `이전 커밋:`은 그 Task를 시작할 때의 `git log -1 --format=%h`다. 커밋 메시지 끝에는 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`를 붙인다. 커밋한 뒤 `git log -1 --format=%ad --date=format:%H:%M`으로 시각을 보고 devlog 제목 시각과 다르면 제목을 고쳐 `git commit --amend --no-edit`한다(devlog 제목 = 커밋 시각).

---

## Task 순서

| Task | 내용 | 앱 | 기록 | 테스트 수(끝) |
|---|---|---|---|---|
| 1 | contracts 패키지와 연결, 상태 값·오류 코드, enum 단언, BusinessError 오버로드, 어긋남 테스트 | contracts, api | decisions 0047·0048 | api 66/450 |
| 2 | api 응답·요청 계약 — view·서비스·컨트롤러 반환 타입, DTO implements | contracts, api | decisions 0049 | api 66/453 |
| 3 | 어드민이 contracts를 쓴다 — types.ts·로컬 타입 지움, 이름표·오류 코드·요청 본문 | admin | 0048 보탬 | admin 12/109 |
| 4 | 전체 검증, 실제 저장소에서 어긋남 출력 기록, README·색인·회고 | 전체·docs | — | 최종 확인 |

의존: Task 2는 Task 1의 패키지·`index.ts`·drift 테스트에, Task 3은 Task 2의 응답·요청 타입에 기댄다. 순서대로 한다(Task 3은 Task 2가 커밋된 뒤 시작 — 계약 파일이 있어야 어드민 tsc가 돈다).

---

### Task 1: contracts 패키지와 연결 — 상태 값·오류 코드, enum 단언, BusinessError 오버로드, 어긋남 테스트

연결 방식(decisions/0047)과 강제 방법(decisions/0048)의 바탕을 놓는다. 이 Task의 계약은 상태 값·오류 코드·목록 페이지 모양뿐이고, 응답·요청 모양은 Task 2가 더한다.

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/src/index.ts`, `packages/contracts/src/statuses.ts`, `packages/contracts/src/errors.ts`, `packages/contracts/src/common.ts`
- Create: `apps/api/src/common/contract-assertions.ts`, `apps/api/test/unit/contract-drift.spec.ts`
- Modify: `apps/api/package.json`, `apps/api/package-lock.json`(npm이 만든다)
- Modify: `apps/api/src/common/domain-errors.ts`, `apps/api/src/common/domain-exception.filter.ts`, `apps/api/src/common/upload.interceptor.ts`, `apps/api/src/firmware/rollout.service.ts`, `apps/api/src/report/weekly-report.controller.ts`, `apps/api/src/scan/scan.service.ts`, `apps/api/src/service/service-ticket.service.ts`, `apps/api/src/terminal/terminal-import.service.ts`, `apps/api/src/terminal/bulk-rows.ts`, `apps/api/src/shipment/shipment.entities.ts`, `apps/api/src/shipment/dto/list-sync-runs.query.ts`
- Create: `docs/decisions/0047-공유-타입은-file-의존-타입-전용-TS-소스-패키지로.md`, `docs/decisions/0048-계약은-반환-타입-implements-enum-단언으로-강제한다.md`
- Modify: `docs/study/backlog.md`, `docs/devlog/2026-10-27.md`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`apps/api/test/unit/contract-drift.spec.ts` (전체) — 계약 파일 하나를 메모리에서 바꿔 api 일부를 컴파일러 API로 검사한다. 디스크의 계약 파일은 건드리지 않는다:

```ts
import { resolve } from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * contracts와 api가 어긋나면 api tsc가 실패하는지(decisions/0048). contracts 파일 하나의 글자를 메모리에서만 바꿔
 * TypeScript 컴파일러 API로 api 일부를 검사한다 — 디스크의 파일은 건드리지 않는다.
 * vitest(swc)는 타입을 검사하지 않으므로 이 테스트가 "타입 단언이 실제로 tsc를 멈추게 한다"는 것을 테스트 실행에서 보여 준다.
 */
const API = resolve(import.meta.dirname, '../..');
const CONTRACTS = resolve(API, '../../packages/contracts/src');
/** 검사 대상 api 파일(이 파일들이 import하는 것도 함께 검사된다) */
const ROOTS = ['src/common/contract-assertions.ts', 'src/scan/scan.service.ts'].map((f) => resolve(API, f));

const norm = (p: string) => p.replaceAll('\\', '/').toLowerCase();

function loadOptions(): ts.CompilerOptions {
  const file = resolve(API, 'tsconfig.json');
  const config = ts.readConfigFile(file, (p) => ts.sys.readFile(p));
  return { ...ts.parseJsonConfigFileContent(config.config, ts.sys, API).options, noEmit: true };
}

let options: ts.CompilerOptions;
let base: ts.Program;

/** contracts의 파일 하나(src 아래 이름)를 edit으로 바꾼 채 검사하고, 오류를 "파일:코드 메시지" 줄로 돌려준다 */
function diagnosticsWith(file: string, edit: (text: string) => string): string[] {
  const target = norm(resolve(CONTRACTS, file));
  const host = ts.createCompilerHost(options, true);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreate) => {
    if (norm(name) !== target) return original(name, languageVersion, onError, shouldCreate);
    const text = ts.sys.readFile(name)!;
    const changed = edit(text);
    if (changed === text) throw new Error(`${file}: 바꿀 글자를 찾지 못했다`);
    return ts.createSourceFile(name, changed, languageVersion);
  };
  const program = ts.createProgram({ rootNames: ROOTS, options, host, oldProgram: base });
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file ? norm(d.file.fileName).replace(norm(API) + '/', '') : '-';
    return `${where}:TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  });
}

describe('contracts가 바뀌면 api tsc가 실패한다 (decisions/0048)', () => {
  beforeAll(() => {
    options = loadOptions();
    base = ts.createProgram({ rootNames: ROOTS, options });
  });

  it('그대로면 오류가 없다', () => {
    expect(ts.getPreEmitDiagnostics(base).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))).toEqual([]);
  });

  it('상태 값을 contracts에서 빼면 api enum과 다르다고 실패한다(빠진 값이 메시지에)', () => {
    const errors = diagnosticsWith('statuses.ts', (t) => t.replace("  | 'DISPOSED';", ';'));
    // 그 상태를 응답에 넣는 view 함수들도 함께 실패한다(Task 2부터) — 빠진 값을 이름으로 알려 주는 것은 단언 파일
    expect(errors).toContainEqual(expect.stringMatching(/^src\/common\/contract-assertions\.ts:TS2344 .*onlyInApi: "DISPOSED"/));
  });

  it('contracts에만 상태 값을 더해도 실패한다', () => {
    const errors = diagnosticsWith('statuses.ts', (t) => t.replace("export type ScanKind = 'RECEIVE' | 'RETURN_IN';", "export type ScanKind = 'RECEIVE' | 'RETURN_IN' | 'REPAIR_IN';"));
    expect(errors).toEqual([expect.stringMatching(/^src\/common\/contract-assertions\.ts:TS2344 .*onlyInContract: "REPAIR_IN"/)]);
  });

  it('오류 코드를 contracts에서 빼면 그 코드를 던지는 곳이 실패한다', () => {
    const errors = diagnosticsWith('errors.ts', (t) => t.replace(/ {2}\| 'PO_CLOSED'\r?\n/, '')); // 체크아웃 줄바꿈(CRLF·LF) 어느 쪽이든
    expect(errors).toEqual([expect.stringMatching(/^src\/scan\/scan\.service\.ts:TS2769 No overload matches this call/)]);
  });
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run test/unit/contract-drift.spec.ts`
Expected: `Tests  4 failed (4)`. 첫 테스트의 Received에 `TS6053 File '…/apps/api/src/common/contract-assertions.ts' not found.`(아직 없는 파일). 나머지 셋도 같은 오류 한 줄을 받아 기대와 다르다(사전 검증 출력: `AssertionError: expected [ Array(1) ] to deeply equal []`, `… to deep equally contain StringMatching{…}`, `… to deeply equal [ StringMatching{…} ]` ×2).

- [ ] **Step 3: contracts 패키지를 만든다**

`packages/contracts/package.json` (전체):

```json
{
  "name": "@terminal-ops/contracts",
  "version": "0.0.0",
  "private": true,
  "description": "api 응답·요청 모양과 상태 값·오류 코드(타입만, 런타임 값 없음 — decisions/0047)",
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts"
    }
  }
}
```

`packages/contracts/tsconfig.json` (전체) — 편집기용. 이 패키지에는 `node_modules`가 없다(설치하지 않는다):

```json
{
  "//": "편집기용. 검사는 이 패키지를 import하는 api·admin의 tsc가 한다(소스 .ts라 skipLibCheck에 걸리지 않는다, decisions/0047)",
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2023",
    "strict": true,
    "noEmit": true,
    "isolatedModules": true
  },
  "include": ["src"]
}
```

`packages/contracts/src/statuses.ts` (전체):

```ts
/**
 * 상태·종류 값 목록(문자열 유니온). api의 런타임 enum(MikroORM 엔티티가 쓴다)과 같아야 한다 —
 * api `src/common/contract-assertions.ts`가 양방향으로 같은지 타입으로 단언한다(어긋나면 api tsc 실패, decisions/0048).
 * 화면 이름(한글)은 여기 두지 않는다(어드민 lib/labels.ts, 서버가 이름을 주는 것은 응답의 label 필드).
 */

/** 단말기 상태(api terminal/terminal-status.ts TerminalStatus) */
export type TerminalStatus =
  | 'RECEIVED'
  | 'INSPECTED'
  | 'DEFECTIVE'
  | 'IN_STOCK'
  | 'ALLOCATED'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'IN_SERVICE'
  | 'RETURN_REQUESTED'
  | 'RETURNING'
  | 'RETURNED'
  | 'DISPOSED';

/** 상태를 바꾼 경로(api TransitionSource, decisions/0007) */
export type TransitionSource = 'MANUAL' | 'INSPECTION' | 'BATCH' | 'ALLOCATION' | 'SHIPMENT' | 'SCAN' | 'IMPORT' | 'SERVICE';

/** 택배사(api carrier/carrier.types.ts Carrier) */
export type Carrier = 'BUNGAE' | 'NEURIMBO';

/** 운송장 상태(api ShipmentStatus) */
export type ShipmentStatus = 'IN_TRANSIT' | 'DELIVERED' | 'SUPERSEDED';

/** 박스 스캔 종류(api ScanKind) */
export type ScanKind = 'RECEIVE' | 'RETURN_IN';

/**
 * 일괄 처리(박스 스캔·엑셀 등록)의 행별 결과 코드(decisions/0019). api는 이 타입을 그대로 쓴다(terminal/bulk-rows.ts).
 * 성공: CREATED, RETURNED. 나머지는 그 행을 반영하지 않은 이유.
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

/** 발주 상태(api PurchaseOrderStatus) */
export type PurchaseOrderStatus = 'ORDERED' | 'RECEIVING' | 'CLOSED';

/** A/S 접수 상태(api ServiceTicketStatus) */
export type ServiceTicketStatus = 'OPEN' | 'RESOLVED_REMOTELY' | 'REPLACING' | 'CLOSED';

/** 펌웨어 배포 상태(api RolloutStatus) */
export type RolloutStatus = 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'ABORTED';

/** 이상 단말기 규칙(api AnomalyRule) */
export type AnomalyRule =
  | 'DELIVERED_NOT_INSTALLED'
  | 'RETURN_STALLED'
  | 'SHIPPED_TOO_LONG'
  | 'ALLOCATED_NO_SHIPMENT'
  | 'IN_SERVICE_NO_MERCHANT'
  | 'OFFLINE_TOO_LONG';

/** VAN 대조 실행 상태·계기(api VanRunStatus, VanRunTrigger) */
export type VanRunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';
export type VanRunTrigger = 'MANUAL' | 'SCHEDULED';

/** VAN 대조 어긋남 종류(api VanMismatchKind, decisions/0033) */
export type VanMismatchKind = 'NOT_REGISTERED' | 'REGISTERED_BUT_NOT_IN_SERVICE' | 'MERCHANT_MISMATCH' | 'SUSPENDED_WHILE_IN_SERVICE';

/** 주간 리포트 상태(api WeeklyReportStatus) */
export type WeeklyReportStatus = 'PENDING' | 'GENERATED' | 'SENT';

/** 택배 수집 실행 결과(api shipment/shipment.entities.ts SYNC_RUN_OUTCOMES) */
export type SyncRunOutcome = 'OK' | 'DELIVERED' | 'NOOP' | 'SKIPPED' | 'ERROR';
```

`packages/contracts/src/errors.ts` (전체):

```ts
/**
 * 오류 응답의 원인 코드(`code`). 화면은 code로 원인을 가른다(어드민 ErrorBox 안내, 다시 보내도 되는지 등).
 * api는 이 유니온 밖의 코드를 던질 수 없다 — BusinessError의 code 타입이 BusinessErrorCode이고, 나머지 응답은 `satisfies ApiErrorBody`(decisions/0048).
 */

/** 업무 규칙 충돌(409) — api BusinessError(409, …) */
export type ConflictCode =
  | 'ANOMALY_SCAN_RUNNING'
  | 'REPLACEMENT_RESERVED'
  | 'ROLLOUT_ALREADY_ACTIVE'
  | 'SCAN_IN_PROGRESS'
  | 'TICKET_ALREADY_OPEN'
  | 'VAN_RECONCILIATION_RUNNING'
  | 'WEEKLY_REPORT_IN_PROGRESS';

/** 업무 규칙 위반(422) — api BusinessError(422, …) */
export type RuleViolationCode =
  | 'MODEL_MISMATCH'
  | 'PO_ALREADY_CLOSED'
  | 'PO_CLOSED'
  | 'REPLACEMENT_NOT_IN_STOCK'
  | 'ROLLOUT_FINISHED'
  | 'ROLLOUT_NOT_PAUSED'
  | 'ROLLOUT_NOT_RUNNING'
  | 'SCAN_ID_REUSED'
  | 'TERMINAL_NOT_IN_SERVICE'
  | 'TICKET_NOT_OPEN'
  | 'TICKET_NOT_REPLACING'
  | 'WEEK_NOT_ENDED'
  | 'WEEKLY_REPORT_TOO_LARGE';

/** api BusinessError가 쓰는 코드 */
export type BusinessErrorCode = ConflictCode | RuleViolationCode;

/** 오류 필터(DomainExceptionFilter)가 ORM·도메인·외부 업체 오류에서 만드는 코드 */
export type FilterErrorCode = 'VERSION_CONFLICT' | 'DEADLOCK' | 'DUPLICATE' | 'INVALID_TRANSITION' | 'PARTNER_ERROR';

/** 입력 오류(400)·파일 크기(413) 중 code를 붙여 주는 것. ValidationPipe의 항목별 검증 오류에는 code가 없다 */
export type InputErrorCode =
  | 'INVALID_STAGES'
  | 'INVALID_WEEK_START'
  | 'PO_NOT_ALLOWED'
  | 'INVALID_FILE'
  | 'FILE_TOO_LARGE'
  | 'MISSING_COLUMNS'
  | 'TOO_MANY_ROWS';

export type ErrorCode = BusinessErrorCode | FilterErrorCode | InputErrorCode;

/** 오류 응답 본문. 404·ValidationPipe 400에는 code가 없고, ValidationPipe의 message는 항목별 배열이다 */
export interface ApiErrorBody {
  statusCode: number;
  code?: ErrorCode;
  message: string | string[];
}

/** 502 PARTNER_ERROR: 외부 업체 쪽 실패. reason = 원인 분류(PartnerError의 name) */
export interface PartnerErrorBody extends ApiErrorBody {
  code: 'PARTNER_ERROR';
  reason: string;
}
```

`packages/contracts/src/common.ts` (전체):

```ts
import type { RowResultCode } from './statuses.js';

/** 최근 것부터 "더 보기" 목록(?beforeId=&limit=, id 내림차순 키셋, decisions/0039) */
export interface BeforeIdPage<T> {
  items: T[];
  /** 다음 쪽이 있으면 이 쪽 마지막 id, 없으면 null */
  nextBeforeId: number | null;
}

/** 오래된 것부터 이어 보는 목록(?afterId=&limit=, id 오름차순 키셋 — 이상 단말기·VAN 결과, decisions/0033) */
export interface AfterIdPage<T> {
  items: T[];
  nextAfterId: number | null;
}

/** 쪽 번호 목록(단말기 목록, ?page=&size=, decisions/0039) */
export interface OffsetPage<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

/** 일괄 처리(박스 스캔·엑셀 등록)의 행 하나의 결과. 요청의 행 순서 그대로 준다 */
export interface RowResult {
  serialNo: string;
  result: RowResultCode;
  message?: string;
}
```

`packages/contracts/src/index.ts` (전체 — Task 2가 네 줄을 더한다):

```ts
/**
 * @terminal-ops/contracts — api와 어드민이 함께 보는 HTTP 계약(응답·요청 모양, 상태 값, 오류 코드).
 * 타입만 있다(런타임 값 없음). 쓰는 쪽은 `import type`으로만 가져온다 — 빌드된 JS에 이 패키지 import가 남지 않는다(decisions/0047).
 * api는 응답을 만드는 함수의 반환 타입·DTO의 implements로 이 타입을 지키고(어긋나면 api tsc 실패), 어드민은 이 타입으로 응답을 읽는다(decisions/0048).
 */
export type * from './statuses.js';
export type * from './errors.js';
export type * from './common.js';
```

- [ ] **Step 4: api에 연결한다**

Run(`apps/api`): `npm install --no-audit --no-fund ../../packages/contracts`
Expected: `added 1 package`. 그리고 `ls -la node_modules/@terminal-ops/` → `contracts -> …/packages/contracts`(링크). `git diff --stat`은 `package.json | 1 +`, `package-lock.json | 9 +++++++++`이고 내용은 아래와 같아야 한다(다르면 멈추고 확인한다):

```diff
@@ -26,6 +26,7 @@
     "@nestjs/common": "^12.2.0",
     "@nestjs/core": "^12.2.0",
     "@nestjs/platform-express": "^12.2.0",
+    "@terminal-ops/contracts": "file:../../packages/contracts",
     "bullmq": "^6.4.0",
     "class-transformer": "^0.5.1",
     "class-validator": "^0.15.1",
```

```diff
@@ -15,6 +15,7 @@
         "@nestjs/common": "^12.2.0",
         "@nestjs/core": "^12.2.0",
         "@nestjs/platform-express": "^12.2.0",
+        "@terminal-ops/contracts": "file:../../packages/contracts",
         "bullmq": "^6.4.0",
         "class-transformer": "^0.5.1",
         "class-validator": "^0.15.1",
@@ -37,6 +38,10 @@
         "vitest": "^5.0.5"
       }
     },
+    "../../packages/contracts": {
+      "name": "@terminal-ops/contracts",
+      "version": "0.0.0"
+    },
     "node_modules/@borewit/text-codec": {
       "version": "0.2.2",
       "resolved": "https://registry.npmjs.org/@borewit/text-codec/-/text-codec-0.2.2.tgz",
@@ -1098,6 +1103,10 @@
         "@swc/counter": "^0.1.3"
       }
     },
+    "node_modules/@terminal-ops/contracts": {
+      "resolved": "../../packages/contracts",
+      "link": true
+    },
     "node_modules/@tokenizer/inflate": {
       "version": "0.4.1",
       "resolved": "https://registry.npmjs.org/@tokenizer/inflate/-/inflate-0.4.1.tgz",
```

- [ ] **Step 5: api가 계약을 지키게 한다(상태 값·오류 코드)**

`apps/api/src/common/contract-assertions.ts` (전체) — 런타임 코드 없이 tsconfig의 `include: ["src", …]`로 검사 대상에 들어간다:

```ts
/**
 * api의 런타임 enum(MikroORM 엔티티·class-validator가 쓴다)과 @terminal-ops/contracts의 문자열 유니온이 같은 값 집합인지 타입으로 단언한다(decisions/0048).
 * 어느 한쪽에만 값이 있으면 api tsc(build·typecheck)가 이 파일에서 TS2344로 실패하고, 메시지에 빠진 값이 나온다.
 * 런타임 코드는 없다(빌드하면 빈 모듈). import하는 곳도 없다 — tsconfig의 include(src)로 검사 대상에 들어간다.
 */
import type * as C from '@terminal-ops/contracts';
import type { AnomalyRule } from '../anomaly/anomaly.entity.js';
import type { Carrier } from '../carrier/carrier.types.js';
import type { RolloutStatus } from '../firmware/firmware.entities.js';
import type { PurchaseOrderStatus } from '../purchase-order/purchase-order.entity.js';
import type { WeeklyReportStatus } from '../report/weekly-report.entity.js';
import type { ScanKind } from '../scan/scan-batch.entity.js';
import type { ServiceTicketStatus } from '../service/service-ticket.entity.js';
import type { ShipmentStatus, SYNC_RUN_OUTCOMES } from '../shipment/shipment.entities.js';
import type { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import type { VanMismatchKind, VanRunStatus, VanRunTrigger } from '../van/van.entities.js';

/** 같은 값 집합이면 true, 아니면 한쪽에만 있는 값을 담은 객체 타입 */
type Same<Api, Contract> = [Api] extends [Contract]
  ? [Contract] extends [Api]
    ? true
    : { onlyInContract: Exclude<Contract, Api> }
  : { onlyInApi: Exclude<Api, Contract> };

/** true만 받는다. 아니면 TS2344 — 메시지에 onlyInApi/onlyInContract와 그 값이 보인다 */
type Assert<T extends true> = T;

export type ContractEnumAssertions = [
  Assert<Same<`${TerminalStatus}`, C.TerminalStatus>>,
  Assert<Same<`${TransitionSource}`, C.TransitionSource>>,
  Assert<Same<`${Carrier}`, C.Carrier>>,
  Assert<Same<`${ShipmentStatus}`, C.ShipmentStatus>>,
  Assert<Same<`${ScanKind}`, C.ScanKind>>,
  Assert<Same<`${PurchaseOrderStatus}`, C.PurchaseOrderStatus>>,
  Assert<Same<`${ServiceTicketStatus}`, C.ServiceTicketStatus>>,
  Assert<Same<`${RolloutStatus}`, C.RolloutStatus>>,
  Assert<Same<`${AnomalyRule}`, C.AnomalyRule>>,
  Assert<Same<`${VanRunStatus}`, C.VanRunStatus>>,
  Assert<Same<`${VanRunTrigger}`, C.VanRunTrigger>>,
  Assert<Same<`${VanMismatchKind}`, C.VanMismatchKind>>,
  Assert<Same<`${WeeklyReportStatus}`, C.WeeklyReportStatus>>,
  Assert<Same<(typeof SYNC_RUN_OUTCOMES)[number], C.SyncRunOutcome>>,
];
```

`apps/api/src/common/domain-errors.ts` — 상태별 오버로드:

```diff
@@ -1,11 +1,16 @@
+import type { BusinessErrorCode, ConflictCode, RuleViolationCode } from '@terminal-ops/contracts';
+
 /**
  * 업무 규칙 위반·충돌. code로 원인을 구분하고 status로 HTTP 상태를 정한다(409 충돌, 422 규칙 위반).
  * 예: SCAN_IN_PROGRESS(409), SCAN_ID_REUSED(422), PO_CLOSED(422)
+ * code는 contracts의 유니온만 받는다 — 409에는 ConflictCode, 422에는 RuleViolationCode(decisions/0048). 새 코드는 contracts errors.ts에 먼저 더한다.
  */
 export class BusinessError extends Error {
+  constructor(status: 409, code: ConflictCode, message: string);
+  constructor(status: 422, code: RuleViolationCode, message: string);
   constructor(
     readonly status: 409 | 422,
-    readonly code: string,
+    readonly code: BusinessErrorCode,
     message: string,
   ) {
     super(message);
```

`apps/api/src/firmware/rollout.service.ts` — 코드를 문자열로 받던 helper와 400 본문:

```diff
@@ -1,6 +1,7 @@
 import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
 import { EntityManager, LoadStrategy, LockMode } from '@mikro-orm/mysql';
 import type { Redis } from 'ioredis';
+import type { ApiErrorBody, RuleViolationCode } from '@terminal-ops/contracts';
 import { fromDbDatetime } from '../common/db-datetime.js';
 import { BusinessError } from '../common/domain-errors.js';
 import { beforeIdWhere, keysetPage } from '../common/keyset.js';
@@ -82,7 +83,7 @@ export class RolloutService {
 
   async create(dto: CreateRolloutDto, actor: string): Promise<FirmwareRollout> {
     const invalid = checkStages(dto.stages);
-    if (invalid) throw new BadRequestException({ statusCode: 400, code: 'INVALID_STAGES', message: invalid });
+    if (invalid) throw new BadRequestException({ statusCode: 400, code: 'INVALID_STAGES', message: invalid } satisfies ApiErrorBody);
     const firmware = await this.em.fork().findOne(Firmware, { model: { code: dto.modelCode }, version: dto.version }, { populate: ['model'] });
     if (!firmware) throw new NotFoundException(`펌웨어 ${dto.modelCode} ${dto.version}이(가) 등록되지 않았습니다.`);
 
@@ -444,7 +445,7 @@ export class RolloutService {
     }));
   }
 
-  private wrongStatus(rollout: FirmwareRollout, code: string): BusinessError {
+  private wrongStatus(rollout: FirmwareRollout, code: RuleViolationCode): BusinessError {
     return new BusinessError(422, code, `펌웨어 배포 ${rollout.id}은(는) ${rollout.status} 상태라 이 작업을 할 수 없습니다.`);
   }
 }
```

`apps/api/src/service/service-ticket.service.ts`:

```diff
@@ -1,5 +1,6 @@
 import { Injectable, NotFoundException } from '@nestjs/common';
 import { EntityManager, LoadStrategy, LockMode } from '@mikro-orm/mysql';
+import type { RuleViolationCode } from '@terminal-ops/contracts';
 import { BusinessError } from '../common/domain-errors.js';
 import { beforeIdWhere, keysetPage } from '../common/keyset.js';
 import { Terminal } from '../terminal/terminal.entity.js';
@@ -72,7 +73,7 @@ export class ServiceTicketService {
    * 접수 행을 FOR UPDATE로 잠그고, 상태가 expected 중 하나인지 확인한다.
    * @param code 상태가 다를 때의 오류 코드. 설치 확인은 TICKET_NOT_REPLACING(Day 3 리뷰 Minor 4)
    */
-  async lockOpen(tx: EntityManager, id: number, expected: ServiceTicketStatus[], code = 'TICKET_NOT_OPEN'): Promise<ServiceTicket> {
+  async lockOpen(tx: EntityManager, id: number, expected: ServiceTicketStatus[], code: RuleViolationCode = 'TICKET_NOT_OPEN'): Promise<ServiceTicket> {
     const ticket = await tx.findOne(ServiceTicket, id, { lockMode: LockMode.PESSIMISTIC_WRITE });
     if (!ticket) throw new NotFoundException(`A/S 접수 ${id}이(가) 없습니다.`);
     if (!expected.includes(ticket.status)) {
```

`apps/api/src/common/domain-exception.filter.ts`:

```diff
@@ -1,6 +1,7 @@
 import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
 import { DeadlockException, OptimisticLockError, UniqueConstraintViolationException } from '@mikro-orm/mysql';
 import type { Response } from 'express';
+import type { ApiErrorBody, PartnerErrorBody } from '@terminal-ops/contracts';
 import { BusinessError, InvalidTransitionError } from './domain-errors.js';
 import { PartnerError } from './partner-errors.js';
 
@@ -14,7 +15,7 @@ export class DomainExceptionFilter implements ExceptionFilter {
         statusCode: 409,
         code: 'VERSION_CONFLICT',
         message: '다른 작업이 먼저 이 단말기를 변경했습니다. 다시 조회한 뒤 시도하세요.',
-      });
+      } satisfies ApiErrorBody);
     }
     if (error instanceof DeadlockException) {
       // MySQL 1213: InnoDB가 이 트랜잭션을 통째로 롤백했다. 같은 요청을 다시 보내면 대개 통과한다(decisions/0043)
@@ -22,18 +23,18 @@ export class DomainExceptionFilter implements ExceptionFilter {
         statusCode: 409,
         code: 'DEADLOCK',
         message: '동시에 처리하던 다른 작업과 겹쳐 이번 요청을 되돌렸습니다. 잠시 뒤 다시 시도하세요.',
-      });
+      } satisfies ApiErrorBody);
     }
     if (error instanceof UniqueConstraintViolationException) {
-      return res.status(409).json({ statusCode: 409, code: 'DUPLICATE', message: '이미 존재하는 값입니다.' });
+      return res.status(409).json({ statusCode: 409, code: 'DUPLICATE', message: '이미 존재하는 값입니다.' } satisfies ApiErrorBody);
     }
     if (error instanceof BusinessError) {
-      return res.status(error.status).json({ statusCode: error.status, code: error.code, message: error.message });
+      return res.status(error.status).json({ statusCode: error.status, code: error.code, message: error.message } satisfies ApiErrorBody);
     }
     if (error instanceof PartnerError) {
       // 우리 잘못이 아니라 외부 업체(택배사) 쪽 실패. 원인 분류(error.name)를 함께 준다.
-      return res.status(502).json({ statusCode: 502, code: 'PARTNER_ERROR', reason: error.name, message: error.message });
+      return res.status(502).json({ statusCode: 502, code: 'PARTNER_ERROR', reason: error.name, message: error.message } satisfies PartnerErrorBody);
     }
-    return res.status(422).json({ statusCode: 422, code: 'INVALID_TRANSITION', message: error.message });
+    return res.status(422).json({ statusCode: 422, code: 'INVALID_TRANSITION', message: error.message } satisfies ApiErrorBody);
   }
 }
```

`apps/api/src/common/upload.interceptor.ts`:

```diff
@@ -1,5 +1,6 @@
 import { BadRequestException, type CallHandler, type ExecutionContext, mixin, type NestInterceptor, PayloadTooLargeException, type Type } from '@nestjs/common';
 import { FileInterceptor } from '@nestjs/platform-express';
+import type { ApiErrorBody } from '@terminal-ops/contracts';
 
 type FileInterceptorOptions = NonNullable<Parameters<typeof FileInterceptor>[1]>;
 
@@ -21,14 +22,14 @@ export function SingleFileInterceptor(fieldName: string, options: FileIntercepto
         return await super.intercept(context, next);
       } catch (error) {
         if (error instanceof PayloadTooLargeException) {
-          throw new PayloadTooLargeException({ statusCode: 413, code: 'FILE_TOO_LARGE', message: `파일은 ${sizeText}까지 받습니다.` });
+          throw new PayloadTooLargeException({ statusCode: 413, code: 'FILE_TOO_LARGE', message: `파일은 ${sizeText}까지 받습니다.` } satisfies ApiErrorBody);
         }
         if (error instanceof BadRequestException) {
           throw new BadRequestException({
             statusCode: 400,
             code: 'INVALID_FILE',
             message: `${fieldName} 필드에 파일 하나만 보내세요(다른 필드 없이). 원인: ${error.message}`,
-          });
+          } satisfies ApiErrorBody);
         }
         throw error;
       }
```

`apps/api/src/report/weekly-report.controller.ts`:

```diff
@@ -1,5 +1,6 @@
 import { BadRequestException, Body, Controller, Get, Header, NotFoundException, Param, Post, Query, Res, StreamableFile } from '@nestjs/common';
 import type { Response } from 'express';
+import type { ApiErrorBody } from '@terminal-ops/contracts';
 import { attachmentDisposition } from '../common/content-disposition.js';
 import { Operator } from '../common/operator.decorator.js';
 import { ListWeeklyReportsQuery } from './dto/list-weekly-reports.query.js';
@@ -10,7 +11,7 @@ import { XLSX_CONTENT_TYPE } from './weekly-report.xlsx.js';
 
 function weekOf(weekStart: string): KstWeek {
   const week = parseKstWeekStart(weekStart);
-  if (!week) throw new BadRequestException({ statusCode: 400, code: 'INVALID_WEEK_START', message: 'weekStart는 KST 월요일 날짜(YYYY-MM-DD)입니다.' });
+  if (!week) throw new BadRequestException({ statusCode: 400, code: 'INVALID_WEEK_START', message: 'weekStart는 KST 월요일 날짜(YYYY-MM-DD)입니다.' } satisfies ApiErrorBody);
   return week;
 }
 
```

`apps/api/src/scan/scan.service.ts`:

```diff
@@ -1,6 +1,7 @@
 import { createHash } from 'node:crypto';
 import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
 import { EntityManager, LockMode, UniqueConstraintViolationException } from '@mikro-orm/mysql';
+import type { ApiErrorBody } from '@terminal-ops/contracts';
 import { BusinessError } from '../common/domain-errors.js';
 import { retryOnUniqueViolation } from '../common/retry-on-unique.js';
 import { PurchaseOrder, PurchaseOrderStatus } from '../purchase-order/purchase-order.entity.js';
@@ -40,7 +41,7 @@ export class ScanService {
   async scan(input: CreateScanDto, actor: string): Promise<{ batch: ScanBatch; replayed: boolean }> {
     // 회수 입고는 발주와 상관없다. 쓰지 않는 값이 요청 해시에 섞이지 않게 받지 않는다(decisions/0020).
     if (input.kind === ScanKind.RETURN_IN && input.poNo !== undefined && input.poNo !== null) {
-      throw new BadRequestException({ statusCode: 400, code: 'PO_NOT_ALLOWED', message: '회수 입고(RETURN_IN)에는 poNo를 보내지 않습니다.' });
+      throw new BadRequestException({ statusCode: 400, code: 'PO_NOT_ALLOWED', message: '회수 입고(RETURN_IN)에는 poNo를 보내지 않습니다.' } satisfies ApiErrorBody);
     }
     // 시리얼은 입구에서 한 번 다듬고(앞뒤 공백·CR), 요청 해시·명세 검사·등록·회수 입고 모두 이 값을 쓴다(troubleshooting/0012).
     const dto: CreateScanDto = { ...input, serials: input.serials.map(normalizeValue) };
```

`apps/api/src/terminal/terminal-import.service.ts`:

```diff
@@ -1,5 +1,6 @@
 import { BadRequestException, Injectable } from '@nestjs/common';
 import ExcelJS from 'exceljs';
+import type { ApiErrorBody, InputErrorCode } from '@terminal-ops/contracts';
 import { BulkRegistrationService, type BulkRegisterRow } from './bulk-registration.service.js';
 import { summarize, type RowResult } from './bulk-rows.js';
 import { readCellValue } from './import-cells.js';
@@ -28,8 +29,8 @@ function readCell(cell: ExcelJS.Cell) {
   return readCellValue(value, cell.numFmt);
 }
 
-function invalid(code: string, message: string): BadRequestException {
-  return new BadRequestException({ statusCode: 400, code, message });
+function invalid(code: InputErrorCode, message: string): BadRequestException {
+  return new BadRequestException({ statusCode: 400, code, message } satisfies ApiErrorBody);
 }
 
 /**
```

`apps/api/src/terminal/bulk-rows.ts` — 원래 유니온이던 행 결과는 계약 것을 그대로 쓴다:

```diff
@@ -1,27 +1,14 @@
+import type { RowResult, RowResultCode } from '@terminal-ops/contracts';
+
 /** 시리얼 형식: 대문자·숫자·하이픈 4~32자. 단건 등록 DTO와 일괄 처리가 같은 규칙을 쓴다. */
 export const SERIAL_NO_PATTERN = /^[A-Z0-9-]{4,32}$/;
 export const SERIAL_NO_MESSAGE = 'serialNo는 대문자·숫자·하이픈 4~32자입니다.';
 
 /**
- * 일괄 처리(박스 스캔·엑셀 등록)의 행별 결과 코드.
+ * 일괄 처리(박스 스캔·엑셀 등록)의 행별 결과 코드와 행 결과. 정의는 contracts 한 곳(응답에 그대로 나간다, decisions/0048) —
  * 성공: CREATED(신규 등록), RETURNED(회수 입고). 나머지는 그 행만 반영하지 않은 이유다(decisions/0019).
  */
-export type RowResultCode =
-  | 'CREATED'
-  | 'RETURNED'
-  | 'INVALID_FORMAT'
-  | 'DUPLICATE_IN_REQUEST'
-  | 'UNKNOWN_MODEL'
-  | 'ALREADY_EXISTS'
-  | 'NOT_IN_DELIVERY_NOTE'
-  | 'NOT_FOUND'
-  | 'INVALID_STATE';
-
-export interface RowResult {
-  serialNo: string;
-  result: RowResultCode;
-  message?: string;
-}
+export type { RowResult, RowResultCode };
 
 /**
  * 엔진 입구에서 값을 문자열로 맞춘다: 문자열이 아니면 String()으로, 앞뒤 공백은 지우고, 없으면 빈 문자열.
```

`apps/api/src/shipment/shipment.entities.ts` — `outcome`을 값 목록의 유니온으로 좁힌다(메타데이터는 그대로 `String`):

```diff
@@ -78,6 +78,7 @@ export class CarrierEvent {
 
 /** 택배 수집 실행 한 번의 결과(SyncRun.outcome). 컬럼은 varchar라 값 목록은 여기 한 곳에 둔다 */
 export const SYNC_RUN_OUTCOMES = ['OK', 'DELIVERED', 'NOOP', 'SKIPPED', 'ERROR'] as const;
+export type SyncRunOutcome = (typeof SYNC_RUN_OUTCOMES)[number];
 
 /** 수집 job 실행 1회의 기록. 실험에서 호출·중복·재시도 수를 셀 때 쓴다. */
 @Entity({ tableName: 'sync_run' })
@@ -104,7 +105,7 @@ export class SyncRun {
 
   /** SYNC_RUN_OUTCOMES 중 하나 */
   @Property({ length: 20 })
-  outcome!: string;
+  outcome!: SyncRunOutcome;
 
   @Property()
   startedAt: Date = new Date();
```

`apps/api/src/shipment/dto/list-sync-runs.query.ts` — 위 변경으로 where 조건이 TS2345가 되므로:

```diff
@@ -1,7 +1,7 @@
 import { IsIn, IsOptional } from 'class-validator';
 import { BeforeIdQuery } from '../../common/keyset.js';
 import { QUEUE } from '../../queue/queue-names.js';
-import { SYNC_RUN_OUTCOMES } from '../shipment.entities.js';
+import { SYNC_RUN_OUTCOMES, type SyncRunOutcome } from '../shipment.entities.js';
 
 /** SyncRun을 남기는 큐(택배 추적). 오타가 빈 목록으로 보이지 않게 정해진 값만 받는다 */
 export const SYNC_RUN_JOBS = [QUEUE.TRACK_BUNGAE, QUEUE.TRACK_NEURIMBO] as const;
@@ -16,5 +16,5 @@ export class ListSyncRunsQuery extends BeforeIdQuery {
   /** OK | DELIVERED | NOOP | SKIPPED | ERROR */
   @IsOptional()
   @IsIn(SYNC_RUN_OUTCOMES)
-  outcome?: string;
+  outcome?: SyncRunOutcome;
 }
```

- [ ] **Step 6: 통과를 확인한다**

Run: `npx vitest run test/unit/contract-drift.spec.ts` → `Tests  4 passed (4)`(약 6~8초)
Run: `npx tsc --noEmit -p tsconfig.json && echo tsc=0` → `tsc=0`
Run: `npx tsc -p ../../packages/contracts && echo contracts=0` → `contracts=0`(계약 패키지 혼자서도 strict로 컴파일된다 — 편집기 설정 확인용, api의 tsc를 빌려 쓴다)
Run: `npm run build && grep -rl "terminal-ops/contracts" dist | wc -l` → 빌드 exit 0, `0`(계약 import가 JS에 남지 않는다). `cat dist/common/contract-assertions.js`는 `export {};` 한 줄(+ sourcemap 주석).
Run: `grep -A3 "outcome" dist/shipment/shipment.entities.js | grep design:type` → `__metadata("design:type", String)`(엔티티 메타데이터가 그대로 — 스키마 변화 없음)
Run: 테스트 DB를 빈 DB로 다시 만든 뒤(안전 규칙의 명령) `npx vitest run 2>&1 | tee <스크래치패드>/c-t1-full.log | grep -E "Test Files|Tests |Duration"`
Expected: `Test Files  66 passed (66)`, `Tests  450 passed (450)`(master 65/446 + 이 파일 1개·4개, 약 250~260초)

어긋남을 손으로도 한 번 본다(되돌리는 것까지 한 단계): Edit 도구로 `packages/contracts/src/statuses.ts`의 `  | 'DISPOSED';`를 `;`로 바꾸고 `npx tsc --noEmit -p tsconfig.json`
Expected: `src/common/contract-assertions.ts(29,10): error TS2344: Type '{ onlyInApi: "DISPOSED"; }' does not satisfy the constraint 'true'.`(이 Task에서는 이 한 줄) → Edit 도구로 **되돌리고** `grep -c "'DISPOSED'" ../../packages/contracts/src/statuses.ts` → `1`, `npx tsc --noEmit -p tsconfig.json && echo tsc=0` → `tsc=0`. (아직 커밋 전 새 파일이라 `git diff`로는 되돌림을 확인할 수 없다.)

- [ ] **Step 7: 결정 기록, backlog, devlog, 커밋**

`docs/decisions/0047-공유-타입은-file-의존-타입-전용-TS-소스-패키지로.md` (전체):

```markdown
# 0047. 공유 타입은 각 앱의 file: 의존으로 연결하는 타입 전용 TS 소스 패키지로 둔다

- 날짜 / 관련 기능: 2026-10-27 / 보강 1(전 기능의 HTTP 계약), 어드민
- 상황: api 응답 타입(`*.views.ts`와 서비스·컨트롤러가 만드는 객체)과 어드민 타입(`src/api/types.ts` + 화면 안 로컬 타입 14개)이 따로 있어 같은지를 리뷰가 대조했다. 한 곳에 두고 api·어드민이 같이 쓰려면 두 앱이 그 코드를 찾을 길이 필요하다. 조건: 앱마다 package-lock이 따로 있고 `npm ci`로 설치한다(README), api는 NodeNext ESM(`.js` 접미사)·tsc 빌드(`rootDir: src`)·vitest는 swc, admin은 Vite(bundler 해석)·`isolatedModules`. 두 앱 모두 `skipLibCheck: true`. TypeScript 6.0.3.
- 선택지(모두 임시 폴더에서 실제로 해 봄, (d)만 이유로 판단 — 출력은 `docs/plans/2026-10-27-shared-contracts.md` "사전 검증"):
  1. 루트 npm workspaces(`apps/*`, `packages/*`) — 장점: 표준 방식, 설치 한 번. 단점: 앱별 lock 네 개를 루트 하나로 합치면서 잠긴 버전 707개 중 43개가 바뀌었다(`@nestjs/*` 12.2.0 → 12.3.2, `@swc/core` 1.16.18 → 1.16.20 …). 타입을 나누려다 의존성 판 올림이 같이 들어오고, README 설치 명령·각 앱 `npm ci` 습관이 바뀐다. 앱마다 고정한 판이 달라(vitest admin 5.0.4, api ^5.0.5) 일부는 앱 안에 따로 깔린다.
  2. 각 앱 `"@terminal-ops/contracts": "file:../../packages/contracts"` + 패키지 `exports`가 **TS 소스**(`"types": "./src/index.ts"`)를 가리킴 — 장점: 앱별 lock·`npm ci` 그대로(lock 9줄 추가), npm이 `node_modules`에 링크를 만들어 두 앱의 해석 방식(NodeNext·bundler) 모두 `exports.types`로 찾는다. `node_modules`를 거쳐 찾은 파일이라 api `rootDir` 검사(TS6059)에 걸리지 않고 `dist`에 나오지 않는다. 소스 `.ts`라 쓰는 쪽 tsc가 계약 파일 자체도 검사한다(오타 → TS2304). 단점: 패키지에 런타임 값을 넣으면 node가 `.ts`를 읽을 수 없어 이 방식으로는 안 된다. 앱 폴더만 떼어 설치할 수 없다.
  3. 2와 같지만 손으로 쓴 `index.d.ts` — 단점: `skipLibCheck: true`라 계약 파일 안의 오류를 아무도 보지 않는다. 사전 검증에서 `version: Foo`(없는 타입)가 api tsc를 통과했고 그 필드는 `any`가 되어 검사가 조용히 사라졌다.
  4. tsconfig `paths`나 상대 경로 import(패키지 아님) — 단점: api `rootDir` 밖 소스라 typecheck·build 모두 TS6059. 피하려면 rootDir을 바꿔 `dist` 구조(`dist/main.js`)가 바뀐다. 런타임 해석도 없다.
  5. OpenAPI(@nestjs/swagger로 스펙 생성 → openapi-typescript로 어드민 타입 생성) — 장점: 언어 밖에서도 쓰는 문서가 나온다. 단점: 응답이 함수가 만드는 평범한 객체라 엔드포인트마다 응답 클래스와 `@ApiProperty`·`@ApiOkResponse`를 새로 써야 하고, 그 클래스와 실제 반환값이 같은지는 여전히 검사하지 않는다(어긋남의 자리가 옮겨질 뿐). 의존성 2개, 생성 단계와 생성물 관리가 는다. 외부 소비자가 없다.
- 결정: 2. 이유: 지금 저장소 구조(앱별 lock, `npm ci`)를 그대로 두고, 계약 파일까지 tsc가 검사하며, 런타임에는 아무것도 더하지 않는다. 계약은 **타입만** 둔다 — 모든 import는 `import type`이고 빌드된 JS에 이 패키지 import가 남지 않는다(사전 검증: `grep -rl "terminal-ops/contracts" dist` 0곳, `node dist/main.js` 기동·응답 확인).
- 결과·대가: `packages/contracts`는 의존성이 없어 따로 설치하지 않는다. 두 앱의 `npm ci`가 링크를 만든다(`node_modules/@terminal-ops/contracts` → `packages/contracts`). 계약 편집기 설정용 `tsconfig.json`만 두고 검사는 쓰는 쪽 tsc에 맡긴다. 어드민의 선택지 목록 같은 값은 계약에 두지 않고 이름표 `Record<유니온, string>`의 키로 만든다.
- 다시 볼 조건: 계약에 런타임 값(상수 배열, 검증 스키마)을 넣어야 할 때 — 빌드 산출물(JS + d.ts)을 내는 패키지나 workspaces로. 앱이 늘어 설치·버전 관리를 한 곳에서 하고 싶어질 때 — workspaces(그때는 의존성 판 올림을 따로 한 커밋으로). api를 외부에 공개할 때 — OpenAPI.
```

`docs/decisions/0048-계약은-반환-타입-implements-enum-단언으로-강제한다.md` (전체):

```markdown
# 0048. 계약은 반환 타입·implements·enum 단언·오류 코드 오버로드로 컴파일 때 강제한다

- 날짜 / 관련 기능: 2026-10-27 / 보강 1, 전 기능 HTTP 응답, 어드민
- 상황: 계약(decisions/0047)이 있어도 api가 그 타입을 쓰지 않으면 어긋남은 그대로다. api의 응답은 view 함수·서비스·컨트롤러의 반환값을 TypeScript가 추론한 모양이고, 상태는 MikroORM 엔티티·class-validator가 쓰는 런타임 enum이며, 오류 코드는 `BusinessError(status, code: string, …)`의 문자열이다. vitest(swc)는 타입을 검사하지 않는다.
- 선택지:
  1. 응답: (a) 함수 반환 타입 `): TerminalView` / (b) `return { … } satisfies TerminalView` / (c) 런타임 검증(zod 등) — (a)는 함수 밖에서 보이는 타입이 곧 계약이라 다른 view(`{ ...toTerminalView(t), … }`)·테스트가 그 타입으로 이어진다. (b)도 남는·빠진 필드를 잡지만 함수의 타입은 추론값 그대로라 경계가 흐려진다. (c)는 런타임 비용과 새 의존성, 이 저장소처럼 서버·화면이 같이 바뀌는 곳에는 컴파일 시점 검사로 충분하다.
  2. 상태 값: (a) 엔티티 enum을 계약 유니온으로 바꿈 / (b) enum은 api에 두고 계약 유니온과 같은지 타입으로 단언 / (c) 계약에 `as const` 배열을 두고 api가 그것으로 enum을 만듦 — (a)는 `@Enum({ items: () => TerminalStatus })`·`@IsEnum`·`TerminalStatus.IN_STOCK` 사용처 수백 곳을 바꾸고 런타임 값이 필요해진다. (c)는 계약에 런타임 값이 생겨 0047의 방식이 안 된다. (b)는 api 코드를 그대로 두고 어긋남만 잡는다.
  3. 오류 코드: (a) `code: BusinessErrorCode` 하나 / (b) 상태별 오버로드 `(409, ConflictCode)`·`(422, RuleViolationCode)` — (b)는 "충돌인지 규칙 위반인지"까지 계약으로 묶는다.
  4. 요청 본문: (a) DTO 클래스를 계약으로 옮김 / (b) DTO는 api에 두고 계약 인터페이스를 `implements` — 검증 데코레이터(class-validator)는 서버 일이고 런타임 값이라 계약에 둘 수 없다. (b).
- 결정:
  - 응답을 만드는 함수(view 함수, 객체를 직접 만드는 서비스·컨트롤러 메서드)에 계약 반환 타입을 단다. 이미 계약 타입이 붙은 view를 그대로 돌려주는 컨트롤러 메서드에는 달지 않는다.
  - `src/common/contract-assertions.ts`가 `` `${Enum}` ``과 계약 유니온이 양방향으로 같은지 단언한다(`Assert<Same<Api, Contract>>`, 다르면 TS2344에 `onlyInApi`/`onlyInContract`와 그 값). 원래 유니온이던 `RowResultCode`·`RowResult`는 api가 계약 것을 그대로 쓴다.
  - `BusinessError` 생성자는 (b) 오버로드. 필터·400 응답 본문은 `satisfies ApiErrorBody`(PARTNER_ERROR는 `PartnerErrorBody`).
  - DTO는 `implements` 계약 요청 타입. 어드민은 보내는 본문에 `satisfies`.
  - 어드민은 계약 타입으로 응답을 읽고, 이름표는 `Record<유니온, string>`, `ApiError.code`는 `ErrorCode | null`.
  - 증명: `apps/api/test/unit/contract-drift.spec.ts` — 계약 파일 하나를 메모리에서 바꿔 TypeScript 컴파일러 API로 api 일부(단언 파일, 박스 스캔 서비스, 단말기 view, A/S DTO)를 검사하고, 기대한 파일에서 기대한 오류 코드(TS2344·TS2769·TS2353·TS2741·TS2420)가 나는지 본다. 바꾸지 않은 상태는 오류 0.
- 결과·대가: 계약을 바꾸면 api·어드민 tsc가 바로 실패해 같은 커밋에서 맞추게 된다. 대신 검사는 `npm run build`·`typecheck`(그리고 drift 테스트의 대표 경우)에서만 일어난다 — `npm test`만 돌리면 api·어드민의 다른 어긋남은 보이지 않는다. 반환 타입을 단 함수가 거짓말을 하면(예: raw SQL 결과를 `as`로 넣음) 잡지 못한다. 어드민은 서버가 계약 밖 오류 코드를 보내지 않는다고 믿는다(캐스트 한 곳).
- 다시 볼 조건: 계약 밖 응답이 실제로 나간 사고가 생기면 해당 경계에 런타임 검증을. 테스트만 돌리는 흐름(CI)이 생기면 `npm test` 앞에 `typecheck`를 묶는다.
```

`docs/study/backlog.md` — `## Nest·TypeScript·빌드·도구` 묶음 끝에 두 줄:

```markdown
- [ ] TypeScript 모듈 해석에서 `node_modules`를 거친 링크 파일이 rootDir 검사(TS6059)·emit에서 빠지는 이유(isExternalLibraryImport) (decisions/0047)
- [ ] `skipLibCheck`가 정확히 무엇을 건너뛰나 — 손으로 쓴 `.d.ts`의 오류가 조용히 `any`가 되는 경우 (decisions/0047)
```

`docs/devlog/2026-10-27.md` 끝에(제목 시각은 커밋 시각 — Step 8에서 맞춘다):

```markdown
## HH:MM Task 1 contracts 패키지와 연결 — 상태 값·오류 코드, enum 단언, BusinessError 오버로드, 어긋남 테스트
이전 커밋: <Task 시작 때 git log -1 --format=%h>
- 한 일:
  - `packages/contracts`(타입만, 의존성 없음): 상태 유니온 14개 + `RowResultCode`, 오류 코드(409 7개·422 13개·필터 5개·입력 7개)와 `ApiErrorBody`, 목록 페이지 모양 세 가지, `RowResult`
  - api `file:../../packages/contracts` 의존(decisions/0047), `contract-assertions.ts`로 enum ↔ 유니온 양방향 단언, `BusinessError` 상태별 오버로드, 필터·400 본문 `satisfies ApiErrorBody`, `SyncRun.outcome` 유니온(decisions/0048)
  - `test/unit/contract-drift.spec.ts`: 계약을 메모리에서 바꿔 컴파일러 API로 api가 실패하는지 4가지
- 확인:
  - 먼저 실패: (Step 2 출력 — 4 failed, TS6053)
  - drift 4 passed, tsc 0, build 0, `dist`에 계약 import 0곳, api 전체 `Test Files 66 passed (66)`, `Tests 450 passed (450)`(Duration …s)
  - 손으로 `'DISPOSED'`를 빼 본 출력: (Step 6 출력 한 줄) → 되돌림
- 막힌 것: (없으면 없음)
- 결정: decisions/0047(연결 방식 — workspaces·.d.ts·paths·OpenAPI를 버린 이유), 0048(강제 방법)
- 다음: Task 2 api 응답·요청 계약
```

```bash
cd ../.. && git add packages/contracts apps/api docs && git status --short && git commit -m "feat: 공유 타입 패키지 contracts — 상태 값·오류 코드, enum 단언, BusinessError 오버로드, 어긋남 테스트

Refs: docs/decisions/0047-공유-타입은-file-의존-타입-전용-TS-소스-패키지로.md, docs/decisions/0048-계약은-반환-타입-implements-enum-단언으로-강제한다.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

`git status --short`에 `apps/api/dist`·`node_modules`가 보이면 안 된다(`.gitignore`). `packages/contracts`에 `node_modules`가 생기지 않았는지도 본다.

- [ ] **Step 8: devlog 제목 시각을 커밋 시각과 맞춘다**

Run: `git log -1 --format=%ad --date=format:%H:%M` → 그 시각으로 devlog 제목의 `HH:MM`을 고치고 `git add docs/devlog/2026-10-27.md && git commit --amend --no-edit`. 다시 `git log -1 --format=%ad --date=format:%H:%M`이 같은지 본다(분이 넘어가면 한 번 더).

---

### Task 2: api 응답·요청 계약 — view·서비스·컨트롤러 반환 타입, DTO implements

계약에 응답·요청 모양을 더하고, api에서 응답 객체를 만드는 모든 함수에 그 타입을 단다(decisions/0048). 범위는 decisions/0049. 응답 JSON은 한 글자도 바뀌지 않는다 — 타입만 붙인다.

**Files:**
- Create: `packages/contracts/src/terminal.ts`, `packages/contracts/src/operations.ts`, `packages/contracts/src/reports.ts`, `packages/contracts/src/requests.ts`
- Modify: `packages/contracts/src/index.ts`, `apps/api/test/unit/contract-drift.spec.ts`, `apps/api/test/weekly-report.e2e.spec.ts`
- Modify(view·서비스·집계): `apps/api/src/terminal/terminal.views.ts`, `purchase-order/purchase-order.views.ts`, `service/service-ticket.views.ts`, `shipment/shipment.views.ts`, `van/van-reconciliation.service.ts`, `report/weekly-report.service.ts`, `anomaly/anomaly.service.ts`, `inspection/inspection.service.ts`, `purchase-order/purchase-order.service.ts`, `firmware/firmware.service.ts`, `firmware/rollout.service.ts`, `device/connectivity.service.ts`, `dashboard/dashboard.queries.ts`, `dashboard/dashboard.service.ts`
- Modify(컨트롤러): `apps/api/src/terminal/terminal.controller.ts`, `terminal/terminal-model.controller.ts`, `merchant/merchant.controller.ts`, `inspection/inspection.controller.ts`, `shipment/sync-run.controller.ts`, `shipment/shipment.controller.ts`, `anomaly/anomaly.controller.ts`, `van/van-reconciliation.controller.ts`, `report/weekly-report.controller.ts`, `firmware/firmware.controller.ts`, `service/service-ticket.controller.ts`, `purchase-order/purchase-order.controller.ts`, `health/health.controller.ts`, `scan/scan.controller.ts`
- Modify(DTO): `apps/api/src/terminal/dto/transition.dto.ts`, `merchant/dto/allocate.dto.ts`, `merchant/dto/cancel-allocation.dto.ts`, `shipment/dto/create-shipment.dto.ts`, `inspection/dto/inspect.dto.ts`, `purchase-order/dto/create-purchase-order.dto.ts`, `van/dto/start-van-reconciliation.dto.ts`, `report/dto/send-weekly-report.dto.ts`, `scan/dto/create-scan.dto.ts`, `service/dto/service-ticket.dto.ts`
- Create: `docs/decisions/0049-계약-범위는-응답-요청-본문-오류-코드까지.md`
- Modify: `docs/devlog/2026-10-27.md`

- [ ] **Step 1: 실패하는 테스트를 더한다**

`apps/api/test/unit/contract-drift.spec.ts` — 검사 대상에 단말기 view·A/S DTO를 더하고 경우 셋:

```diff
@@ -10,7 +10,9 @@ import { beforeAll, describe, expect, it } from 'vitest';
 const API = resolve(import.meta.dirname, '../..');
 const CONTRACTS = resolve(API, '../../packages/contracts/src');
 /** 검사 대상 api 파일(이 파일들이 import하는 것도 함께 검사된다) */
-const ROOTS = ['src/common/contract-assertions.ts', 'src/scan/scan.service.ts'].map((f) => resolve(API, f));
+const ROOTS = ['src/common/contract-assertions.ts', 'src/scan/scan.service.ts', 'src/terminal/terminal.views.ts', 'src/service/dto/service-ticket.dto.ts'].map((f) =>
+  resolve(API, f),
+);
 
 const norm = (p: string) => p.replaceAll('\\', '/').toLowerCase();
 
@@ -67,4 +69,19 @@ describe('contracts가 바뀌면 api tsc가 실패한다 (decisions/0048)', () =
     const errors = diagnosticsWith('errors.ts', (t) => t.replace(/ {2}\| 'PO_CLOSED'\r?\n/, '')); // 체크아웃 줄바꿈(CRLF·LF) 어느 쪽이든
     expect(errors).toEqual([expect.stringMatching(/^src\/scan\/scan\.service\.ts:TS2769 No overload matches this call/)]);
   });
+
+  it('응답 필드 이름을 contracts에서 바꾸면 그 응답을 만드는 view 함수가 실패한다', () => {
+    const errors = diagnosticsWith('terminal.ts', (t) => t.replace('  serialNo: string;', '  serialNumber: string;')); // 첫 번째 = TerminalView
+    expect(errors).toEqual([expect.stringMatching(/^src\/terminal\/terminal\.views\.ts:TS2353 .*'serialNo' does not exist in type 'TerminalView'/)]);
+  });
+
+  it('contracts에 응답 필드를 더하고 api가 채우지 않으면 실패한다', () => {
+    const errors = diagnosticsWith('terminal.ts', (t) => t.replace('  merchantCode: string | null;', '  merchantCode: string | null;\n  installedAt: string | null;'));
+    expect(errors).toEqual([expect.stringMatching(/^src\/terminal\/terminal\.views\.ts:TS2741 Property 'installedAt' is missing/)]);
+  });
+
+  it('요청 본문 필드를 contracts에서 바꾸면 그 모양을 implements한 DTO가 실패한다', () => {
+    const errors = diagnosticsWith('requests.ts', (t) => t.replace('  symptom: string;', '  description: string;'));
+    expect(errors).toEqual([expect.stringMatching(/^src\/service\/dto\/service-ticket\.dto\.ts:TS2420 Class 'OpenTicketDto' incorrectly implements interface 'OpenTicketRequest'/)]);
+  });
 });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run test/unit/contract-drift.spec.ts`
Expected: `Tests  3 failed | 4 passed (7)`. 새 셋은 `AssertionError: expected [] to deeply equal [ StringMatching{…} ]` — 아직 `terminal.ts`·`requests.ts`가 없고 view·DTO가 계약을 쓰지 않아 바꿔도 아무 오류가 없다.

- [ ] **Step 3: 계약에 응답·요청 모양을 더한다**

`packages/contracts/src/terminal.ts` (전체):

```ts
import type { OffsetPage } from './common.js';
import type { Carrier, ShipmentStatus, TerminalStatus, TransitionSource } from './statuses.js';

/** 단말기(api toTerminalView). 시각은 모두 ISO 문자열 */
export interface TerminalView {
  serialNo: string;
  modelCode: string;
  merchantCode: string | null;
  status: TerminalStatus;
  /** 지금 상태가 된 시각(decisions/0034) */
  statusChangedAt: string;
  /** 낙관적 락 버전 — 쓰기 요청의 expectedVersion(decisions/0004) */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** GET /terminals */
export type TerminalPage = OffsetPage<TerminalView>;

/** 지금 상태에서 일반 전이로 갈 수 있는 상태. 모델 정책에 막혔으면 이유(decisions/0040) */
export interface TransitionTarget {
  to: TerminalStatus;
  blockedReason: string | null;
}

/** 전용 API로만 하는 일을 지금 할 수 있는지(decisions/0040) */
export interface TerminalActionFlags {
  allocate: boolean;
  cancelAllocation: boolean;
  ship: boolean;
  inspect: boolean;
}

/** GET /terminals/:serialNo (api toTerminalDetailView) */
export interface TerminalDetail extends TerminalView {
  modelName: string;
  merchantName: string | null;
  allowedTransitions: TransitionTarget[];
  actions: TerminalActionFlags;
}

/** GET /terminals/:serialNo/history (api toHistoryView) */
export interface HistoryView {
  fromStatus: TerminalStatus | null;
  toStatus: TerminalStatus;
  source: TransitionSource;
  actor: string;
  reason: string;
  occurredAt: string;
}

/** GET /terminals/:serialNo/connectivity — redis: 하트비트 최신값, snapshot: MySQL 스냅샷, none: 기록 없음(decisions/0029) */
export interface ConnectivityView {
  serialNo: string;
  source: 'redis' | 'snapshot' | 'none';
  online: boolean;
  lastSeenAt: string | null;
  firmwareVersion: string | null;
}

/** GET /terminals/:serialNo/inspections 한 건(최근 것부터). 항목 이름(label)을 붙여 준다 */
export interface InspectionRecord {
  id: number;
  passed: boolean;
  actor: string;
  inspectedAt: string;
  results: { itemCode: string; label: string; passed: boolean; note: string | null }[];
}

/** POST /terminals/:serialNo/inspections 응답 */
export interface InspectResult {
  inspectionId: number;
  passed: boolean;
  failedItems: string[];
  terminal: TerminalView;
}

/** GET /inspection-items?modelCode= */
export interface InspectionItemView {
  code: string;
  label: string;
  sortOrder: number;
}

/** GET /merchants */
export interface MerchantView {
  code: string;
  name: string;
  address: string;
}

/** GET /terminal-models */
export interface TerminalModelView {
  code: string;
  name: string;
  requiresReinspection: boolean;
}

/** 운송장(api toShipmentView). events는 GET /shipments/:id에만 */
export interface ShipmentView {
  id: number;
  serialNo: string;
  carrier: Carrier;
  trackingNo: string;
  status: ShipmentStatus;
  lastSyncedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  events?: { eventKey: string; code: string; occurredAt: string }[];
}

/** POST /shipments 응답: 운송장 + 바뀐 단말기 */
export interface CreatedShipmentView extends ShipmentView {
  terminal: TerminalView;
}
```

`packages/contracts/src/operations.ts` (전체):

```ts
import type { RowResult } from './common.js';
import type { PurchaseOrderStatus, RolloutStatus, RowResultCode, ScanKind, ServiceTicketStatus } from './statuses.js';

/** 박스 스캔 결과(POST /scans 201 새로 처리 · 200 replayed, GET /scans/:scanId, decisions/0020) */
export interface ScanView {
  scanId: string;
  kind: ScanKind;
  poNo: string | null;
  actor: string;
  /** 같은 scanId로 다시 보내 저장된 결과를 돌려줬으면 true */
  replayed: boolean;
  createdAt: string;
  /** 결과 코드별 행 수(0인 코드는 빠진다) */
  summary: Partial<Record<RowResultCode, number>>;
  /** 요청의 시리얼 순서 그대로 */
  results: RowResult[];
}

/** 발주(api toPurchaseOrderView) */
export interface PurchaseOrderView {
  id: number;
  poNo: string;
  modelCode: string;
  quantity: number;
  status: PurchaseOrderStatus;
  orderedBy: string;
  createdAt: string;
  closedAt: string | null;
  closedBy: string | null;
}

/** GET /purchase-orders/:poNo/reconciliation — 발주 대비 입고 대조(F10) */
export interface PurchaseOrderReconciliation {
  poNo: string;
  modelCode: string;
  status: PurchaseOrderStatus;
  ordered: number;
  /** 납품 명세의 시리얼 수 */
  noted: number;
  received: number;
  /** ordered − noted */
  shortfall: number;
  /** 명세에는 있는데 입고되지 않은 시리얼 */
  missing: string[];
  /** 입고 스캔에서 명세 밖이라 거절된 시리얼 */
  unexpected: string[];
}

/** POST /purchase-orders/:poNo/close 응답: 마감 뒤 대조 */
export interface ClosedPurchaseOrder extends PurchaseOrderReconciliation {
  closedAt: string | null;
  closedBy: string | null;
}

/** A/S 접수(api toTicketView) */
export interface TicketView {
  id: number;
  serialNo: string;
  merchantCode: string;
  symptom: string;
  status: ServiceTicketStatus;
  remoteNote: string | null;
  replacementSerialNo: string | null;
  outboundShipmentId: number | null;
  outboundTrackingNo: string | null;
  openedBy: string;
  createdAt: string;
  closedAt: string | null;
}

/** 펌웨어(api toFirmwareView, POST /firmware) */
export interface FirmwareView {
  id: number;
  modelCode: string;
  version: string;
  createdBy: string;
  createdAt: string;
}

/** 배포 단계 하나의 대상·결과 수 */
export interface StageStats {
  stage: number;
  /** 이 단계까지의 누적 비율(%) */
  percent: number;
  targets: number;
  offered: number;
  succeeded: number;
  failed: number;
  timedOut: number;
}

/** 펌웨어 단계 배포(api toRolloutView) */
export interface RolloutView {
  id: number;
  modelCode: string;
  version: string;
  status: RolloutStatus;
  /** 단계별 누적 비율(%), 예 [10, 50, 100] */
  stages: number[];
  /** 지금 단계(stages의 위치, 0부터) */
  currentStage: number;
  failureThreshold: number;
  minSamples: number;
  stageTimeoutMs: number;
  stageStartedAt: string;
  createdBy: string;
  createdAt: string;
  finishedAt: string | null;
  endReason: string | null;
  stageStats: StageStats[];
}
```

`packages/contracts/src/reports.ts` (전체):

```ts
import type { AfterIdPage } from './common.js';
import type { AnomalyRule, SyncRunOutcome, TerminalStatus, VanMismatchKind, VanRunStatus, VanRunTrigger, WeeklyReportStatus } from './statuses.js';

/** GET /anomaly-rules — 규칙 이름·기준일(화면의 규칙 필터, decisions/0040) */
export interface AnomalyRuleView {
  rule: AnomalyRule;
  label: string;
  /** 기준일. 날짜 기준이 아닌 규칙(IN_SERVICE_NO_MERCHANT)은 null */
  days: number | null;
}

/** 이상 하나의 근거. 규칙마다 담는 것이 다르다(api anomaly-rules.ts) — 화면은 days만 쓴다 */
export type AnomalyDetail = Record<string, unknown> & { days?: number };

/** 이상 단말기 한 건(GET /anomalies, afterId 키셋) */
export interface AnomalyView {
  id: number;
  /** 단말기가 지워졌으면 null */
  serialNo: string | null;
  status: TerminalStatus | null;
  rule: AnomalyRule;
  ruleLabel: string;
  detectedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  detail: AnomalyDetail;
}

/** POST /anomaly-scans 응답(동기 찾기 한 번) */
export interface AnomalyScanSummary {
  detected: number;
  continuing: number;
  resolved: number;
  /** 찾기가 끝난 뒤 열린 이상 수(규칙별, 0인 규칙은 빠진다) */
  open: Partial<Record<AnomalyRule, number>>;
  /** 새로 걸린 단말기(최대 100) */
  newSerials: string[];
}

/** VAN 대조 실행(api toVanRunView) */
export interface VanRunView {
  id: number;
  status: VanRunStatus;
  trigger: VanRunTrigger;
  requestedBy: string;
  acknowledgeDrop: boolean;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  pages: number;
  fetched: number;
  retries: number;
  candidates: number;
  confirmed: number;
  resolved: number;
  unverifiable: number;
  /** 어긋남 종류별 확정 수 */
  counts: Record<string, number>;
  /** 단계별 걸린 시간(ms) */
  phaseMs: { collect?: number; compare?: number; reverify?: number };
  error: string | null;
}

/** VAN 대조 결과 항목 하나 */
export interface VanItemView {
  id: number;
  serialNo: string;
  kind: VanMismatchKind;
  kindLabel: string;
  ourValue: string;
  vanValue: string;
  verified: boolean;
  reason: string | null;
}

/** GET /van-reconciliations/:id — 실행 요약 + 결과 한 쪽(?kind=&verified=&afterId=&limit=) */
export type VanRunDetail = VanRunView & AfterIdPage<VanItemView>;

/** 주간 리포트 주별 행(api toWeeklyReportView + 큐 상태, decisions/0038) */
export interface WeeklyReportView {
  /** 그 주 월요일(KST) YYYY-MM-DD */
  weekStart: string;
  status: WeeklyReportStatus;
  fileName: string | null;
  fileSize: number | null;
  generatedAt: string | null;
  sentAt: string | null;
  attempts: number;
  lastError: string | null;
  /** POST에서 이미 보낸 주라 job 없이 200 */
  alreadySent: boolean;
  /** 수동 보내기 job이 대기·처리 중 */
  queued: boolean;
  /** 그 job을 넣은 시각(대기·처리 중일 때만 ISO, POST 202 응답에는 null) */
  queuedAt: string | null;
}

/** GET /reports/weekly?before=YYYY-MM-DD (주 키셋) */
export interface WeeklyReportPage {
  items: WeeklyReportView[];
  nextBefore: string | null;
}

/** 택배 수집 job 실행 한 번(GET /sync-runs) */
export interface SyncRunView {
  id: number;
  /** 큐 이름(track-bungae, track-neurimbo) */
  job: string;
  shipmentId: number | null;
  trackingNo: string | null;
  attempt: number;
  worker: string;
  outcome: SyncRunOutcome;
  startedAt: string;
  finishedAt: string | null;
  fetched: number;
  inserted: number;
  duplicated: number;
  detail: string | null;
}

/** 어드민 처음 화면의 숫자 묶음(decisions/0044). 모두 집계 시각 기준 */
export interface DashboardSummary {
  terminals: {
    total: number;
    /** 상태 순서(전이 표의 enum 순서), 0대인 상태는 빠진다 */
    byStatus: { status: TerminalStatus; count: number }[];
    byModel: { modelCode: string; count: number }[];
  };
  /** 운영 중 단말기의 접속 상태(주간 리포트와 같은 MySQL 기준) */
  connectivity: { inService: number; online: number; offline: number; noRecord: number };
  /** 열린 이상(규칙 순서, 0인 규칙은 빠진다) */
  anomalies: { open: number; byRule: { rule: AnomalyRule; label: string; open: number }[] };
  /** 끝나지 않은 펌웨어 배포(RUNNING·PAUSED) */
  rollouts: { active: number };
  /** 열린 A/S(OPEN·REPLACING) */
  serviceTickets: { open: number };
  /** 가장 최근에 끝난(COMPLETED) VAN 대조 */
  van: { runId: number; finishedAt: string; confirmed: number; counts: Record<string, number> } | null;
  /** 이번 주(KST 월요일 00:00부터 집계 시각까지) 상태 전이 수 */
  week: { weekStart: string; transitions: number };
}

/** GET /dashboard/summary — 집계 + 그 집계를 만든 시각, 이번 응답이 캐시에서 왔는지 */
export interface DashboardView extends DashboardSummary {
  cachedAt: string;
  fromCache: boolean;
}

/** GET /health */
export interface HealthView {
  status: 'ok';
}
```

`packages/contracts/src/requests.ts` (전체):

```ts
/**
 * 쓰기 요청 본문. 검증 규칙(길이·형식)은 api의 class-validator DTO에 있고, DTO가 `implements`로 이 모양을 따른다(decisions/0048).
 * 어드민은 보내는 본문에 `satisfies`를 붙인다.
 */
import type { Carrier, ScanKind, TerminalStatus } from './statuses.js';

/** 낙관적 락: 화면에서 본 version(decisions/0004) */
interface Versioned {
  expectedVersion: number;
}

/** POST /terminals/:serialNo/transitions */
export interface TransitionRequest extends Versioned {
  to: TerminalStatus;
  /** 1~200자, 공백만은 안 된다 */
  reason: string;
}

/** POST /terminals/:serialNo/allocations */
export interface AllocateRequest extends Versioned {
  merchantCode: string;
}

/** POST /terminals/:serialNo/allocation-cancellations */
export interface CancelAllocationRequest extends Versioned {
  reason: string;
}

/** POST /shipments */
export interface CreateShipmentRequest extends Versioned {
  serialNo: string;
  carrier: Carrier;
}

/** 검수 항목 하나의 결과 */
export interface InspectionResultInput {
  itemCode: string;
  passed: boolean;
  note?: string;
}

/** POST /terminals/:serialNo/inspections — 모델 체크리스트 항목을 빠짐없이 한 번씩 */
export interface InspectRequest {
  results: InspectionResultInput[];
}

/** POST /purchase-orders */
export interface CreatePurchaseOrderRequest {
  modelCode: string;
  /** 1~5000 */
  quantity: number;
}

/** POST /scans — 박스 하나. scanId는 박스마다 만드는 멱등 키(영문·숫자·_·- 8~64자), RECEIVE면 poNo 필수 */
export interface CreateScanRequest {
  scanId: string;
  kind: ScanKind;
  poNo?: string;
  serials: string[];
}

/** POST /service-tickets */
export interface OpenTicketRequest {
  serialNo: string;
  symptom: string;
}

/** POST /service-tickets/:id/remote-checks */
export interface RemoteCheckRequest {
  resolved: boolean;
  note: string;
}

/** POST /service-tickets/:id/replacements */
export interface ReplaceRequest {
  replacementSerialNo: string;
  carrier: Carrier;
}

/** POST /van-reconciliations(본문 없어도 된다). true면 이 실행만 수집 급감 검사를 건너뛴다(decisions/0033) */
export interface StartVanReconciliationRequest {
  acknowledgeDrop?: boolean;
}

/** POST /reports/weekly — 그 주 월요일(KST) YYYY-MM-DD, 없으면 지난주 */
export interface SendWeeklyReportRequest {
  weekStart?: string;
}
```

`packages/contracts/src/index.ts`:

```diff
@@ -6,3 +6,7 @@
 export type * from './statuses.js';
 export type * from './errors.js';
 export type * from './common.js';
+export type * from './terminal.js';
+export type * from './operations.js';
+export type * from './reports.js';
+export type * from './requests.js';
```

- [ ] **Step 4: view 함수와 서비스에 반환 타입을 단다**

`apps/api/src/terminal/terminal.views.ts`:

```diff
@@ -1,10 +1,11 @@
+import type { HistoryView, TerminalDetail, TerminalView } from '@terminal-ops/contracts';
 import type { Terminal } from './terminal.entity.js';
 import type { TerminalStatusHistory } from './terminal-status-history.entity.js';
 import { TerminalStatus, TransitionSource } from './terminal-status.js';
 import { targetsFrom } from './transition-rules.js';
 
 /** 엔티티를 그대로 내보내지 않고 응답 형태를 여기서 고정한다. model과 merchant가 populate돼 있어야 한다. */
-export function toTerminalView(t: Terminal) {
+export function toTerminalView(t: Terminal): TerminalView {
   return {
     serialNo: t.serialNo,
     modelCode: t.model.code,
@@ -23,7 +24,7 @@ export function toTerminalView(t: Terminal) {
  * - allowedTransitions: 일반 전이 API(POST /terminals/:serialNo/transitions, MANUAL)로 갈 수 있는 상태. 모델 정책에 막힌 것은 blockedReason
  * - actions: 전용 API로만 하는 일 — 배정·배정 취소(ALLOCATION), 출고(SHIPMENT), 검수(INSPECTION)
  */
-export function toTerminalDetailView(t: Terminal) {
+export function toTerminalDetailView(t: Terminal): TerminalDetail {
   const policy = { requiresReinspection: t.model.requiresReinspection };
   const can = (source: TransitionSource, to: TerminalStatus) =>
     targetsFrom(t.status, source, policy).some((x) => x.to === to && x.blockedReason === null);
@@ -41,7 +42,7 @@ export function toTerminalDetailView(t: Terminal) {
   };
 }
 
-export function toHistoryView(h: TerminalStatusHistory) {
+export function toHistoryView(h: TerminalStatusHistory): HistoryView {
   return {
     fromStatus: h.fromStatus ?? null,
     toStatus: h.toStatus,
```

`apps/api/src/purchase-order/purchase-order.views.ts`:

```diff
@@ -1,7 +1,8 @@
+import type { PurchaseOrderView } from '@terminal-ops/contracts';
 import type { PurchaseOrder } from './purchase-order.entity.js';
 
 /** model이 populate돼 있어야 한다. */
-export function toPurchaseOrderView(po: PurchaseOrder) {
+export function toPurchaseOrderView(po: PurchaseOrder): PurchaseOrderView {
   return {
     id: po.id,
     poNo: po.poNo,
```

`apps/api/src/service/service-ticket.views.ts`:

```diff
@@ -1,7 +1,8 @@
+import type { TicketView } from '@terminal-ops/contracts';
 import type { ServiceTicket } from './service-ticket.entity.js';
 
 /** terminal, merchant, replacementTerminal, outboundShipment가 populate돼 있어야 한다. */
-export function toTicketView(t: ServiceTicket) {
+export function toTicketView(t: ServiceTicket): TicketView {
   return {
     id: t.id,
     serialNo: t.terminal.serialNo,
```

`apps/api/src/shipment/shipment.views.ts`:

```diff
@@ -1,7 +1,8 @@
+import type { ShipmentView } from '@terminal-ops/contracts';
 import type { CarrierEvent, Shipment } from './shipment.entities.js';
 
 /** terminal이 populate돼 있어야 한다. */
-export function toShipmentView(s: Shipment, events?: CarrierEvent[]) {
+export function toShipmentView(s: Shipment, events?: CarrierEvent[]): ShipmentView {
   return {
     id: s.id,
     serialNo: s.terminal.serialNo,
```

`apps/api/src/van/van-reconciliation.service.ts`:

```diff
@@ -2,6 +2,7 @@ import { Injectable, Logger, NotFoundException } from '@nestjs/common';
 import { InjectQueue } from '@nestjs/bullmq';
 import type { Queue } from 'bullmq';
 import { EntityManager, IsolationLevel, UniqueConstraintViolationException, type QueryResult } from '@mikro-orm/mysql';
+import type { AfterIdPage, VanItemView, VanRunView } from '@terminal-ops/contracts';
 import { fromDbDatetime } from '../common/db-datetime.js';
 import { BusinessError } from '../common/domain-errors.js';
 import { beforeIdWhere, keysetPage } from '../common/keyset.js';
@@ -519,7 +520,7 @@ export class VanReconciliationService {
   }
 
   /** 결과 행 한 페이지(id 순, afterId 뒤부터). 다음 페이지가 있으면 nextAfterId */
-  async items(runId: number, q: { kind?: VanMismatchKind; verified?: boolean; afterId?: number; limit: number }) {
+  async items(runId: number, q: { kind?: VanMismatchKind; verified?: boolean; afterId?: number; limit: number }): Promise<AfterIdPage<VanItemView>> {
     const rows = await this.em.fork().find(
       VanReconciliationItem,
       {
@@ -604,7 +605,7 @@ export class VanReconciliationService {
   }
 }
 
-export function toVanRunView(run: VanReconciliationRun) {
+export function toVanRunView(run: VanReconciliationRun): VanRunView {
   return {
     id: run.id,
     status: run.status,
```

`apps/api/src/report/weekly-report.service.ts`:

```diff
@@ -2,6 +2,7 @@ import { Injectable, Logger, NotFoundException } from '@nestjs/common';
 import { InjectQueue } from '@nestjs/bullmq';
 import type { Queue } from 'bullmq';
 import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/mysql';
+import type { WeeklyReportView } from '@terminal-ops/contracts';
 import { BusinessError } from '../common/domain-errors.js';
 import { PartnerPermanentError } from '../common/partner-errors.js';
 import { MAX_RETRY_AFTER_MS } from '../common/partner-http.js';
@@ -327,7 +328,7 @@ export class WeeklyReportService {
   }
 }
 
-export function toWeeklyReportView(r: WeeklyReport, alreadySent = false, queued = false, queuedAt: string | null = null) {
+export function toWeeklyReportView(r: WeeklyReport, alreadySent = false, queued = false, queuedAt: string | null = null): WeeklyReportView {
   return {
     weekStart: r.weekStart,
     status: r.status,
```

`apps/api/src/anomaly/anomaly.service.ts`:

```diff
@@ -1,6 +1,7 @@
 import { Injectable, Logger } from '@nestjs/common';
 import { raw } from '@mikro-orm/core';
 import { EntityManager } from '@mikro-orm/mysql';
+import type { AfterIdPage, AnomalyView } from '@terminal-ops/contracts';
 import { BusinessError } from '../common/domain-errors.js';
 import { env } from '../config/env.js';
 import { OUTBOX_TYPE, OutboxEvent } from '../outbox/outbox-event.entity.js';
@@ -158,7 +159,7 @@ export class AnomalyService {
   }
 
   /** 이상 목록 한 페이지(id 순, afterId 뒤부터). 단말기 시리얼·지금 상태를 붙인다 */
-  async list(q: { rule?: AnomalyRule; open?: boolean; afterId?: number; limit: number }) {
+  async list(q: { rule?: AnomalyRule; open?: boolean; afterId?: number; limit: number }): Promise<AfterIdPage<AnomalyView>> {
     const em = this.em.fork();
     const rows = await em.find(
       Anomaly,
```

`apps/api/src/inspection/inspection.service.ts`:

```diff
@@ -1,5 +1,6 @@
 import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
 import { EntityManager } from '@mikro-orm/mysql';
+import type { InspectionRecord } from '@terminal-ops/contracts';
 import { Terminal } from '../terminal/terminal.entity.js';
 import { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
 import { TransitionService } from '../terminal/transition.service.js';
@@ -66,7 +67,7 @@ export class InspectionService {
   }
 
   /** 단말기의 검수 기록(최근 것부터, 결과 항목은 체크리스트 순서). 단말기가 없으면 404 */
-  async history(serialNo: string) {
+  async history(serialNo: string): Promise<InspectionRecord[]> {
     const em = this.em.fork();
     const terminal = await em.findOne(Terminal, { serialNo }, { populate: ['model'] });
     if (!terminal) throw new NotFoundException(`단말기 ${serialNo}이(가) 없습니다.`);
```

`apps/api/src/purchase-order/purchase-order.service.ts`:

```diff
@@ -1,6 +1,7 @@
 import { randomUUID } from 'node:crypto';
 import { Injectable, Logger, NotFoundException } from '@nestjs/common';
 import { EntityManager, IsolationLevel, LoadStrategy, LockMode } from '@mikro-orm/mysql';
+import type { ClosedPurchaseOrder, PurchaseOrderReconciliation } from '@terminal-ops/contracts';
 import { BusinessError } from '../common/domain-errors.js';
 import { beforeIdWhere, keysetPage } from '../common/keyset.js';
 import { TerminalModel } from '../terminal/terminal-model.entity.js';
@@ -67,7 +68,7 @@ export class PurchaseOrderService {
    * utf8mb4_0900_ai_ci로 맞췄지만(decisions/0025), 쿼리가 연결 설정에 기대지 않도록 열 정의에도 collate를 적는다(troubleshooting/0008).
    * 그러면 serial_no unique 인덱스(eq_ref)도 쓴다.
    */
-  async reconcile(poNo: string) {
+  async reconcile(poNo: string): Promise<PurchaseOrderReconciliation> {
     const po = await this.get(poNo);
     const note = await this.ensureDeliveryNote(po);
     const { received, missing, unexpected } = await this.em.fork().transactional(
@@ -118,7 +119,7 @@ export class PurchaseOrderService {
    * 명세는 마감 트랜잭션 전에(밖에서) 받는다. 응답의 대조 결과에 명세가 필요한데, 마감을 커밋한 뒤 공장 호출이 실패하면
    * "마감은 됐는데 요청은 502"가 되기 때문이다. 먼저 받아 두면 공장이 실패할 때 마감하지 않고 502로 끝난다(HTTP를 트랜잭션 안에 두지 않는 것은 decisions/0012와 같음).
    */
-  async close(poNo: string, actor: string) {
+  async close(poNo: string, actor: string): Promise<ClosedPurchaseOrder> {
     const found = await this.get(poNo);
     if (found.status !== PurchaseOrderStatus.CLOSED) await this.ensureDeliveryNote(found);
     await this.em.fork().transactional(async (tx) => {
```

`apps/api/src/firmware/firmware.service.ts`:

```diff
@@ -1,5 +1,6 @@
 import { Injectable, NotFoundException } from '@nestjs/common';
 import { EntityManager } from '@mikro-orm/mysql';
+import type { FirmwareView } from '@terminal-ops/contracts';
 import { TerminalModel } from '../terminal/terminal-model.entity.js';
 import type { RegisterFirmwareDto } from './dto/firmware.dto.js';
 import { Firmware } from './firmware.entities.js';
@@ -19,6 +20,6 @@ export class FirmwareService {
   }
 }
 
-export function toFirmwareView(f: Firmware) {
+export function toFirmwareView(f: Firmware): FirmwareView {
   return { id: f.id, modelCode: f.model.code, version: f.version, createdBy: f.createdBy, createdAt: f.createdAt.toISOString() };
 }
```

`apps/api/src/firmware/rollout.service.ts` — api의 `StageStats`는 지우고 계약 것을 쓴다:

```diff
@@ -1,7 +1,7 @@
 import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
 import { EntityManager, LoadStrategy, LockMode } from '@mikro-orm/mysql';
 import type { Redis } from 'ioredis';
-import type { ApiErrorBody, RuleViolationCode } from '@terminal-ops/contracts';
+import type { ApiErrorBody, RolloutView, RuleViolationCode, StageStats } from '@terminal-ops/contracts';
 import { fromDbDatetime } from '../common/db-datetime.js';
 import { BusinessError } from '../common/domain-errors.js';
 import { beforeIdWhere, keysetPage } from '../common/keyset.js';
@@ -49,16 +49,6 @@ interface OfferedTarget {
   inService: boolean;
 }
 
-export interface StageStats {
-  stage: number;
-  percent: number;
-  targets: number;
-  offered: number;
-  succeeded: number;
-  failed: number;
-  timedOut: number;
-}
-
 /** 단계 비율은 1~100, 커지는 순서, 마지막은 100 */
 export function checkStages(stages: number[]): string | null {
   if (stages.some((p, i) => i > 0 && p <= stages[i - 1])) return 'stages는 커지는 순서여야 합니다(누적 비율).';
@@ -466,7 +456,7 @@ function toStageStats(rollout: FirmwareRollout, rows: TargetCount[]): StageStats
   });
 }
 
-export function toRolloutView(rollout: FirmwareRollout, stats: StageStats[]) {
+export function toRolloutView(rollout: FirmwareRollout, stats: StageStats[]): RolloutView {
   return {
     id: rollout.id,
     modelCode: rollout.firmware.model.code,
```

`apps/api/src/device/connectivity.service.ts` — api의 `ConnectivityView`는 지우고 계약 것을 쓴다:

```diff
@@ -2,6 +2,7 @@ import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
 import { raw } from '@mikro-orm/core';
 import { EntityManager } from '@mikro-orm/mysql';
 import type { Redis } from 'ioredis';
+import type { ConnectivityView } from '@terminal-ops/contracts';
 import { env } from '../config/env.js';
 import { OUTBOX_TYPE, OutboxEvent } from '../outbox/outbox-event.entity.js';
 import { execOrThrow } from '../redis/redis-exec.js';
@@ -23,15 +24,6 @@ export interface DetectResult {
   skipped?: boolean;
 }
 
-export interface ConnectivityView {
-  serialNo: string;
-  /** redis: 하트비트 최신값, snapshot: MySQL 스냅샷, none: 기록 없음 */
-  source: 'redis' | 'snapshot' | 'none';
-  online: boolean;
-  lastSeenAt: string | null;
-  firmwareVersion: string | null;
-}
-
 export type ConnectivityRow = Pick<DeviceConnectivity, 'terminalId' | 'online' | 'lastSeenAt' | 'firmwareVersion' | 'changedAt'>;
 
 /** UPSERT 한 문장에 담는 행 수 */
```

`apps/api/src/dashboard/dashboard.queries.ts` — 모양은 계약 한 곳에(다시 내보내 기존 import는 그대로):

```diff
@@ -1,5 +1,6 @@
 import { Injectable } from '@nestjs/common';
 import { EntityManager, IsolationLevel } from '@mikro-orm/mysql';
+import type { DashboardSummary } from '@terminal-ops/contracts';
 import { ANOMALY_RULE_LABEL } from '../anomaly/anomaly-labels.js';
 import type { AnomalyRule } from '../anomaly/anomaly.entity.js';
 import { fromDbDatetime } from '../common/db-datetime.js';
@@ -7,27 +8,11 @@ import { kstWeekOf } from '../report/kst-week.js';
 import { reportOnlineWindowMs } from '../report/weekly-report.queries.js';
 import { TerminalStatus } from '../terminal/terminal-status.js';
 
-/** 어드민 처음 화면의 숫자 묶음(decisions/0044). 모두 집계 시각(now) 기준 */
-export interface DashboardSummary {
-  terminals: {
-    total: number;
-    /** 상태 순서(전이 표의 enum 순서), 0대인 상태는 빠진다 */
-    byStatus: { status: string; count: number }[];
-    byModel: { modelCode: string; count: number }[];
-  };
-  /** 운영 중 단말기의 접속 상태(주간 리포트와 같은 MySQL 기준 — 판정 job이 맞추는 online, 창 = 오프라인 기준 + 스냅샷 주기) */
-  connectivity: { inService: number; online: number; offline: number; noRecord: number };
-  /** 열린 이상(규칙 순서, 0인 규칙은 빠진다) */
-  anomalies: { open: number; byRule: { rule: string; label: string; open: number }[] };
-  /** 끝나지 않은 펌웨어 배포(RUNNING·PAUSED) */
-  rollouts: { active: number };
-  /** 열린 A/S(OPEN·REPLACING) */
-  serviceTickets: { open: number };
-  /** 가장 최근에 끝난(COMPLETED) VAN 대조 */
-  van: { runId: number; finishedAt: string; confirmed: number; counts: Record<string, number> } | null;
-  /** 이번 주(KST 월요일 00:00부터 집계 시각까지) 상태 전이 수 */
-  week: { weekStart: string; transitions: number };
-}
+/**
+ * 어드민 처음 화면의 숫자 묶음(decisions/0044). 모두 집계 시각(now) 기준. 모양은 contracts DashboardSummary 한 곳에 있다(decisions/0048).
+ * 접속 상태는 주간 리포트와 같은 MySQL 기준 — 판정 job이 맞추는 online, 창 = 오프라인 기준 + 스냅샷 주기.
+ */
+export type { DashboardSummary };
 
 const n = (v: unknown) => Number(v ?? 0);
 
```

`apps/api/src/dashboard/dashboard.service.ts` — 실험 0015 파일이 `type DashboardView`를 이 파일에서 import하므로 다시 내보낸다:

```diff
@@ -1,14 +1,12 @@
 import { Inject, Injectable, Logger } from '@nestjs/common';
 import type { Redis } from 'ioredis';
+import type { DashboardView } from '@terminal-ops/contracts';
 import { env } from '../config/env.js';
 import { REDIS } from '../redis/redis.provider.js';
-import { DashboardQueries, type DashboardSummary } from './dashboard.queries.js';
+import { DashboardQueries } from './dashboard.queries.js';
 
-/** 화면에 주는 값: 집계 + 그 집계를 만든 시각(cachedAt)과 이번 응답이 캐시에서 왔는지 */
-export interface DashboardView extends DashboardSummary {
-  cachedAt: string;
-  fromCache: boolean;
-}
+/** 화면에 주는 값: 집계 + 그 집계를 만든 시각(cachedAt)과 이번 응답이 캐시에서 왔는지(contracts DashboardView) */
+export type { DashboardView };
 
 /** 캐시 키. 큐와 같은 접두사라 테스트(test-…)와 개발(terminal-ops)이 섞이지 않는다 */
 export const dashboardCacheKey = () => `${env.queuePrefix}:dash:summary`;
```

- [ ] **Step 5: 객체를 직접 만드는 컨트롤러 메서드에 반환 타입을 단다**

이미 계약 타입이 붙은 view·서비스를 그대로 돌려주는 메서드에는 달지 않는다(decisions/0048).

`apps/api/src/terminal/terminal.controller.ts`:

```diff
@@ -1,4 +1,5 @@
 import { Body, Controller, Get, HttpCode, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
+import type { TerminalPage } from '@terminal-ops/contracts';
 import { Operator } from '../common/operator.decorator.js';
 import { SingleFileInterceptor } from '../common/upload.interceptor.js';
 import { RegisterTerminalDto } from './dto/register-terminal.dto.js';
@@ -37,7 +38,7 @@ export class TerminalController {
   }
 
   @Get()
-  async list(@Query() query: ListTerminalsQuery) {
+  async list(@Query() query: ListTerminalsQuery): Promise<TerminalPage> {
     const result = await this.terminals.list(query);
     return { ...result, items: result.items.map(toTerminalView) };
   }
```

`apps/api/src/terminal/terminal-model.controller.ts`:

```diff
@@ -1,4 +1,5 @@
 import { Controller, Get } from '@nestjs/common';
+import type { TerminalModelView } from '@terminal-ops/contracts';
 import { TerminalService } from './terminal.service.js';
 
 @Controller('terminal-models')
@@ -7,7 +8,7 @@ export class TerminalModelController {
 
   /** 모델 목록. 화면의 모델 필터·선택지(SN-100 등) */
   @Get()
-  async list() {
+  async list(): Promise<TerminalModelView[]> {
     return (await this.terminals.models()).map((m) => ({ code: m.code, name: m.name, requiresReinspection: m.requiresReinspection }));
   }
 }
```

`apps/api/src/merchant/merchant.controller.ts`:

```diff
@@ -1,4 +1,5 @@
 import { Body, Controller, Get, Param, Post } from '@nestjs/common';
+import type { MerchantView } from '@terminal-ops/contracts';
 import { Operator } from '../common/operator.decorator.js';
 import { toTerminalView } from '../terminal/terminal.views.js';
 import { AllocateDto } from './dto/allocate.dto.js';
@@ -10,7 +11,7 @@ export class MerchantController {
   constructor(private readonly merchants: MerchantService) {}
 
   @Get('merchants')
-  async list() {
+  async list(): Promise<MerchantView[]> {
     return (await this.merchants.list()).map((m) => ({ code: m.code, name: m.name, address: m.address }));
   }
 
```

`apps/api/src/inspection/inspection.controller.ts`:

```diff
@@ -1,4 +1,5 @@
 import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
+import type { InspectionItemView, InspectResult } from '@terminal-ops/contracts';
 import { Operator } from '../common/operator.decorator.js';
 import { toTerminalView } from '../terminal/terminal.views.js';
 import { InspectionItemsQuery } from './dto/inspection-items.query.js';
@@ -11,13 +12,13 @@ export class InspectionController {
   constructor(private readonly inspections: InspectionService) {}
 
   @Get('inspection-items')
-  async items(@Query() query: InspectionItemsQuery) {
+  async items(@Query() query: InspectionItemsQuery): Promise<InspectionItemView[]> {
     const items = await this.inspections.itemsForModel(query.modelCode);
     return items.map((i) => ({ code: i.code, label: i.label, sortOrder: i.sortOrder }));
   }
 
   @Post('terminals/:serialNo/inspections')
-  async inspect(@Param('serialNo') serialNo: string, @Body() dto: InspectDto, @Operator() actor: string) {
+  async inspect(@Param('serialNo') serialNo: string, @Body() dto: InspectDto, @Operator() actor: string): Promise<InspectResult> {
     const r = await this.inspections.inspect(serialNo, dto, actor);
     return { inspectionId: r.inspection.id, passed: r.passed, failedItems: r.failedItems, terminal: toTerminalView(r.terminal) };
   }
```

`apps/api/src/shipment/sync-run.controller.ts`:

```diff
@@ -1,4 +1,5 @@
 import { Controller, Get, Query } from '@nestjs/common';
+import type { BeforeIdPage, SyncRunView } from '@terminal-ops/contracts';
 import { EntityManager, LoadStrategy } from '@mikro-orm/mysql';
 import { beforeIdWhere, keysetPage } from '../common/keyset.js';
 import { ListSyncRunsQuery } from './dto/list-sync-runs.query.js';
@@ -11,7 +12,7 @@ export class SyncRunController {
 
   /** 최근 실행부터(?job=&outcome=&beforeId=&limit=, id 키셋 — decisions/0039) */
   @Get()
-  async list(@Query() q: ListSyncRunsQuery) {
+  async list(@Query() q: ListSyncRunsQuery): Promise<BeforeIdPage<SyncRunView>> {
     const rows = await this.em.fork().find(
       SyncRun,
       { ...beforeIdWhere(q.beforeId), ...(q.job ? { job: q.job } : {}), ...(q.outcome ? { outcome: q.outcome } : {}) },
```

`apps/api/src/shipment/shipment.controller.ts`:

```diff
@@ -1,4 +1,5 @@
 import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
+import type { CreatedShipmentView } from '@terminal-ops/contracts';
 import { Operator } from '../common/operator.decorator.js';
 import { toTerminalView } from '../terminal/terminal.views.js';
 import { CreateShipmentDto } from './dto/create-shipment.dto.js';
@@ -10,7 +11,7 @@ export class ShipmentController {
   constructor(private readonly shipments: ShipmentService) {}
 
   @Post()
-  async create(@Body() dto: CreateShipmentDto, @Operator() actor: string) {
+  async create(@Body() dto: CreateShipmentDto, @Operator() actor: string): Promise<CreatedShipmentView> {
     const { shipment, terminal } = await this.shipments.create(dto, actor);
     return { ...toShipmentView(shipment), terminal: toTerminalView(terminal) };
   }
```

`apps/api/src/anomaly/anomaly.controller.ts`:

```diff
@@ -1,4 +1,5 @@
 import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
+import type { AnomalyRuleView, AnomalyScanSummary } from '@terminal-ops/contracts';
 import { Operator } from '../common/operator.decorator.js';
 import { ANOMALY_RULE_LABEL } from './anomaly-labels.js';
 import { ruleThresholdDays } from './anomaly-rules.js';
@@ -13,7 +14,7 @@ export class AnomalyController {
 
   /** 규칙 목록(이름·기준일). 화면의 규칙 필터가 쓴다 — 규칙 이름을 화면에 따로 두지 않게(decisions/0040) */
   @Get('anomaly-rules')
-  rules() {
+  rules(): AnomalyRuleView[] {
     return Object.values(AnomalyRule).map((rule) => ({ rule, label: ANOMALY_RULE_LABEL[rule], days: ruleThresholdDays(rule) }));
   }
 
@@ -25,7 +26,7 @@ export class AnomalyController {
   /** 수동 찾기(동기). 다른 찾기가 돌고 있으면 409 ANOMALY_SCAN_RUNNING */
   @Post('anomaly-scans')
   @HttpCode(200)
-  async scan(@Operator() _actor: string) {
+  async scan(@Operator() _actor: string): Promise<AnomalyScanSummary> {
     const { newMatches, ...summary } = await this.anomalies.scan();
     return { ...summary, newSerials: newMatches.slice(0, 100).map((m) => m.serialNo) };
   }
```

`apps/api/src/van/van-reconciliation.controller.ts`:

```diff
@@ -1,4 +1,5 @@
 import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
+import type { BeforeIdPage, VanRunDetail, VanRunView } from '@terminal-ops/contracts';
 import { BeforeIdQuery } from '../common/keyset.js';
 import { Operator } from '../common/operator.decorator.js';
 import { StartVanReconciliationDto } from './dto/start-van-reconciliation.dto.js';
@@ -19,14 +20,14 @@ export class VanReconciliationController {
 
   /** 실행 목록(최근 것부터, ?beforeId=&limit=) */
   @Get()
-  async list(@Query() query: BeforeIdQuery) {
+  async list(@Query() query: BeforeIdQuery): Promise<BeforeIdPage<VanRunView>> {
     const { items, nextBeforeId } = await this.runs.list(query);
     return { items: items.map(toVanRunView), nextBeforeId };
   }
 
   /** 실행 요약 + 결과 한 페이지(?kind=&verified=&afterId=&limit=) */
   @Get(':id')
-  async get(@Param('id', ParseIntPipe) id: number, @Query() query: VanItemsQuery) {
+  async get(@Param('id', ParseIntPipe) id: number, @Query() query: VanItemsQuery): Promise<VanRunDetail> {
     const run = toVanRunView(await this.runs.get(id));
     return { ...run, ...(await this.runs.items(id, query)) };
   }
```

`apps/api/src/report/weekly-report.controller.ts`:

```diff
@@ -1,6 +1,6 @@
 import { BadRequestException, Body, Controller, Get, Header, NotFoundException, Param, Post, Query, Res, StreamableFile } from '@nestjs/common';
 import type { Response } from 'express';
-import type { ApiErrorBody } from '@terminal-ops/contracts';
+import type { ApiErrorBody, WeeklyReportPage } from '@terminal-ops/contracts';
 import { attachmentDisposition } from '../common/content-disposition.js';
 import { Operator } from '../common/operator.decorator.js';
 import { ListWeeklyReportsQuery } from './dto/list-weekly-reports.query.js';
@@ -37,7 +37,7 @@ export class WeeklyReportController {
    * queued·queuedAt은 주마다 큐를 본다(limit 상한 100, 한꺼번에 — 왕복을 차례로 기다리지 않는다) — 이미 보낸 주는 Redis를 보지 않는다(queueState)
    */
   @Get()
-  async list(@Query() query: ListWeeklyReportsQuery) {
+  async list(@Query() query: ListWeeklyReportsQuery): Promise<WeeklyReportPage> {
     const { items, nextBefore } = await this.reports.list(query);
     const states = await Promise.all(items.map((r) => this.reports.queueState(r)));
     return { items: items.map((r, i) => toWeeklyReportView(r, false, states[i].queued, states[i].queuedAt)), nextBefore };
```

`apps/api/src/firmware/firmware.controller.ts`:

```diff
@@ -1,4 +1,5 @@
 import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
+import type { BeforeIdPage, RolloutView } from '@terminal-ops/contracts';
 import { Operator } from '../common/operator.decorator.js';
 import { CreateRolloutDto, ListRolloutsQuery, RegisterFirmwareDto } from './dto/firmware.dto.js';
 import { FirmwareService, toFirmwareView } from './firmware.service.js';
@@ -25,7 +26,7 @@ export class FirmwareController {
 
   /** 배포 목록과 단계별 통계(최근 것부터, ?status=&beforeId=&limit=) */
   @Get('firmware-rollouts')
-  async list(@Query() query: ListRolloutsQuery) {
+  async list(@Query() query: ListRolloutsQuery): Promise<BeforeIdPage<RolloutView>> {
     const { items, nextBeforeId } = await this.rollouts.list(query);
     return { items: items.map(({ rollout, stats }) => toRolloutView(rollout, stats)), nextBeforeId };
   }
```

`apps/api/src/service/service-ticket.controller.ts`:

```diff
@@ -1,4 +1,5 @@
 import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
+import type { BeforeIdPage, TicketView } from '@terminal-ops/contracts';
 import { Operator } from '../common/operator.decorator.js';
 import { ListTicketsQuery, OpenTicketDto, RemoteCheckDto, ReplaceDto } from './dto/service-ticket.dto.js';
 import { ReplacementService } from './replacement.service.js';
@@ -19,7 +20,7 @@ export class ServiceTicketController {
 
   /** 접수 목록(최근 것부터, ?status=&serialNo=&beforeId=&limit=) */
   @Get()
-  async list(@Query() query: ListTicketsQuery) {
+  async list(@Query() query: ListTicketsQuery): Promise<BeforeIdPage<TicketView>> {
     const { items, nextBeforeId } = await this.tickets.list(query);
     return { items: items.map(toTicketView), nextBeforeId };
   }
```

`apps/api/src/purchase-order/purchase-order.controller.ts`:

```diff
@@ -1,4 +1,5 @@
 import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
+import type { BeforeIdPage, PurchaseOrderView } from '@terminal-ops/contracts';
 import { Operator } from '../common/operator.decorator.js';
 import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto.js';
 import { ListPurchaseOrdersQuery } from './dto/list-purchase-orders.query.js';
@@ -16,7 +17,7 @@ export class PurchaseOrderController {
 
   /** 발주 목록(최근 것부터, ?status=&beforeId=&limit=) */
   @Get()
-  async list(@Query() query: ListPurchaseOrdersQuery) {
+  async list(@Query() query: ListPurchaseOrdersQuery): Promise<BeforeIdPage<PurchaseOrderView>> {
     const { items, nextBeforeId } = await this.orders.list(query);
     return { items: items.map(toPurchaseOrderView), nextBeforeId };
   }
```

`apps/api/src/health/health.controller.ts`:

```diff
@@ -1,9 +1,10 @@
 import { Controller, Get } from '@nestjs/common';
+import type { HealthView } from '@terminal-ops/contracts';
 
 @Controller('health')
 export class HealthController {
   @Get()
-  check() {
+  check(): HealthView {
     return { status: 'ok' };
   }
 }
```

`apps/api/src/scan/scan.controller.ts`:

```diff
@@ -1,12 +1,13 @@
 import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
 import type { Response } from 'express';
+import type { ScanView } from '@terminal-ops/contracts';
 import { Operator } from '../common/operator.decorator.js';
 import { summarize } from '../terminal/bulk-rows.js';
 import { CreateScanDto } from './dto/create-scan.dto.js';
 import type { ScanBatch } from './scan-batch.entity.js';
 import { ScanService } from './scan.service.js';
 
-function toScanView(batch: ScanBatch, replayed: boolean) {
+function toScanView(batch: ScanBatch, replayed: boolean): ScanView {
   return {
     scanId: batch.scanId,
     kind: batch.kind,
```

- [ ] **Step 6: DTO가 요청 계약을 implements하고, 깨지는 테스트 한 곳을 고친다**

`apps/api/src/terminal/dto/transition.dto.ts`:

```diff
@@ -1,7 +1,8 @@
 import { IsEnum, IsInt, IsString, Length, Matches, Min } from 'class-validator';
+import type { TransitionRequest } from '@terminal-ops/contracts';
 import { TerminalStatus } from '../terminal-status.js';
 
-export class TransitionDto {
+export class TransitionDto implements TransitionRequest {
   @IsEnum(TerminalStatus)
   to!: TerminalStatus;
 
```

`apps/api/src/merchant/dto/allocate.dto.ts`:

```diff
@@ -1,6 +1,7 @@
 import { IsInt, IsString, Min, MinLength } from 'class-validator';
+import type { AllocateRequest } from '@terminal-ops/contracts';
 
-export class AllocateDto {
+export class AllocateDto implements AllocateRequest {
   @IsString()
   @MinLength(1)
   merchantCode!: string;
```

`apps/api/src/merchant/dto/cancel-allocation.dto.ts`:

```diff
@@ -1,6 +1,7 @@
 import { IsInt, IsString, Length, Matches, Min } from 'class-validator';
+import type { CancelAllocationRequest } from '@terminal-ops/contracts';
 
-export class CancelAllocationDto {
+export class CancelAllocationDto implements CancelAllocationRequest {
   @IsString()
   @Length(1, 200)
   @Matches(/\S/, { message: 'reason은 공백만으로 쓸 수 없습니다.' })
```

`apps/api/src/shipment/dto/create-shipment.dto.ts`:

```diff
@@ -1,7 +1,8 @@
 import { IsEnum, IsInt, Matches, Min } from 'class-validator';
+import type { CreateShipmentRequest } from '@terminal-ops/contracts';
 import { Carrier } from '../../carrier/carrier.types.js';
 
-export class CreateShipmentDto {
+export class CreateShipmentDto implements CreateShipmentRequest {
   @Matches(/^[A-Z0-9-]{4,32}$/, { message: 'serialNo는 대문자·숫자·하이픈 4~32자입니다.' })
   serialNo!: string;
 
```

`apps/api/src/inspection/dto/inspect.dto.ts`:

```diff
@@ -1,7 +1,8 @@
 import { Type } from 'class-transformer';
 import { ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsString, Length, ValidateNested } from 'class-validator';
+import type { InspectionResultInput, InspectRequest } from '@terminal-ops/contracts';
 
-export class InspectionResultDto {
+export class InspectionResultDto implements InspectionResultInput {
   @IsString()
   itemCode!: string;
 
@@ -14,7 +15,7 @@ export class InspectionResultDto {
   note?: string;
 }
 
-export class InspectDto {
+export class InspectDto implements InspectRequest {
   @IsArray()
   @ArrayNotEmpty()
   @ValidateNested({ each: true })
```

`apps/api/src/purchase-order/dto/create-purchase-order.dto.ts`:

```diff
@@ -1,6 +1,7 @@
 import { IsInt, IsString, Max, Min, MinLength } from 'class-validator';
+import type { CreatePurchaseOrderRequest } from '@terminal-ops/contracts';
 
-export class CreatePurchaseOrderDto {
+export class CreatePurchaseOrderDto implements CreatePurchaseOrderRequest {
   @IsString()
   @MinLength(1)
   modelCode!: string;
```

`apps/api/src/van/dto/start-van-reconciliation.dto.ts`:

```diff
@@ -1,7 +1,8 @@
 import { IsBoolean, IsOptional } from 'class-validator';
+import type { StartVanReconciliationRequest } from '@terminal-ops/contracts';
 
 /** POST /van-reconciliations 본문(없어도 된다) */
-export class StartVanReconciliationDto {
+export class StartVanReconciliationDto implements StartVanReconciliationRequest {
   /**
    * 수집 급감을 운영자가 확인했다: 이 실행만 수집 급감 검사(마지막 완료 대비 VAN_FETCH_MIN_PCT, VAN 0건인데 운영 중 단말기 있음)를 건너뛴다.
    * 실행 행과 요약 알림에 남는다(decisions/0033). 후보 수 상한은 그대로 검사한다.
```

`apps/api/src/report/dto/send-weekly-report.dto.ts`:

```diff
@@ -1,6 +1,7 @@
 import { IsOptional, Matches } from 'class-validator';
+import type { SendWeeklyReportRequest } from '@terminal-ops/contracts';
 
-export class SendWeeklyReportDto {
+export class SendWeeklyReportDto implements SendWeeklyReportRequest {
   /** 그 주 월요일(KST) 'YYYY-MM-DD'. 없으면 지난주 */
   @IsOptional()
   @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'weekStart는 YYYY-MM-DD(KST 월요일)입니다.' })
```

`apps/api/src/scan/dto/create-scan.dto.ts`:

```diff
@@ -1,8 +1,9 @@
 import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsEnum, IsString, Matches, MinLength, ValidateIf } from 'class-validator';
+import type { CreateScanRequest } from '@terminal-ops/contracts';
 import { ScanKind } from '../scan-batch.entity.js';
 
 /** 박스 한 개의 스캔 결과. 시리얼 형식은 여기서 막지 않고 행별 결과(INVALID_FORMAT)로 돌려준다. */
-export class CreateScanDto {
+export class CreateScanDto implements CreateScanRequest {
   /** 스캐너가 박스마다 만드는 멱등 키 */
   @Matches(/^[A-Za-z0-9_-]{8,64}$/, { message: 'scanId는 영문·숫자·_·- 8~64자입니다.' })
   scanId!: string;
```

`apps/api/src/service/dto/service-ticket.dto.ts`:

```diff
@@ -1,10 +1,11 @@
 import { IsBoolean, IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';
+import type { OpenTicketRequest, RemoteCheckRequest, ReplaceRequest } from '@terminal-ops/contracts';
 import { Carrier } from '../../carrier/carrier.types.js';
 import { BeforeIdQuery } from '../../common/keyset.js';
 import { SERIAL_NO_MESSAGE, SERIAL_NO_PATTERN } from '../../terminal/bulk-rows.js';
 import { ServiceTicketStatus } from '../service-ticket.entity.js';
 
-export class OpenTicketDto {
+export class OpenTicketDto implements OpenTicketRequest {
   @Matches(SERIAL_NO_PATTERN, { message: SERIAL_NO_MESSAGE })
   serialNo!: string;
 
@@ -14,7 +15,7 @@ export class OpenTicketDto {
   symptom!: string;
 }
 
-export class RemoteCheckDto {
+export class RemoteCheckDto implements RemoteCheckRequest {
   /** 원격 점검으로 해결됐는지 */
   @IsBoolean()
   resolved!: boolean;
@@ -25,7 +26,7 @@ export class RemoteCheckDto {
   note!: string;
 }
 
-export class ReplaceDto {
+export class ReplaceDto implements ReplaceRequest {
   @Matches(SERIAL_NO_PATTERN, { message: SERIAL_NO_MESSAGE })
   replacementSerialNo!: string;
 
```

`apps/api/test/weekly-report.e2e.spec.ts` — 계약 인터페이스는 인덱스 시그니처가 없어 `Record<string, unknown>`에 바로 넣을 수 없다(`TS2322 … Index signature for type 'string' is missing`):

```diff
@@ -40,7 +40,7 @@ describe('주간 운영 리포트 — xlsx, 톡톡 첨부, 멱등, 내려받기
   const send = async (weekStart: string): Promise<{ status: number; body: Record<string, unknown> }> => {
     try {
       const { report, alreadySent } = await t.app.get(WeeklyReportService).send(parseKstWeekStart(weekStart)!);
-      return { status: 200, body: toWeeklyReportView(report, alreadySent) };
+      return { status: 200, body: { ...toWeeklyReportView(report, alreadySent) } }; // 계약 인터페이스는 인덱스 시그니처가 없어 펼쳐 담는다
     } catch (error) {
       if (error instanceof BusinessError) return { status: error.status, body: { code: error.code, message: error.message } };
       if (error instanceof PartnerError) return { status: 502, body: { code: 'PARTNER_ERROR', reason: error.name, message: error.message } };
```

- [ ] **Step 7: 통과를 확인한다**

Run: `npx vitest run test/unit/contract-drift.spec.ts` → `Tests  7 passed (7)`(약 8~10초)
Run: `npx tsc --noEmit -p tsconfig.json && echo tsc=0` → `tsc=0`
Run: `npm run build && grep -rl "terminal-ops/contracts" dist | wc -l` → exit 0, `0`
Run: 테스트 DB를 빈 DB로 다시 만든 뒤 `npx vitest run 2>&1 | tee <스크래치패드>/c-t2-full.log | grep -E "Test Files|Tests |Duration"`
Expected: `Test Files  66 passed (66)`, `Tests  453 passed (453)`(사전 검증 254.99초). 응답 JSON은 바뀌지 않았으므로 e2e 기대값은 그대로 통과해야 한다 — 실패가 있으면 타입을 맞추려고 값을 바꾼 곳이 있다는 뜻이다(멈추고 확인).

어긋남을 실제 빌드로 한 번 본다: Edit 도구로 `packages/contracts/src/terminal.ts`의 **첫 번째** `  serialNo: string;`(TerminalView)를 `  serialNumber: string;`로 바꾸고 `npm run build`
Expected:
```
src/terminal/terminal.views.ts(10,5): error TS2353: Object literal may only specify known properties, and 'serialNo' does not exist in type 'TerminalView'.
```
→ `git checkout -- ../../packages/contracts/src/terminal.ts`가 아니라(아직 커밋 전 새 파일) Edit 도구로 되돌리고 `npm run build && echo build=0` → `build=0`.

- [ ] **Step 8: 결정 기록, devlog, 커밋**

`docs/decisions/0049-계약-범위는-응답-요청-본문-오류-코드까지.md` (전체):

```markdown
# 0049. 계약 범위는 응답·쓰기 요청 본문·오류 코드까지, 쿼리 문자열과 런타임 검증은 넣지 않는다

- 날짜 / 관련 기능: 2026-10-27 / 보강 1, 어드민이 부르는 API 전부
- 상황: 계약(decisions/0047·0048)에 무엇을 넣을지 정해야 한다. 너무 좁으면 어드민 화면 안의 로컬 타입이 남아 대조가 계속되고, 너무 넓으면 어드민이 부르지 않는 응답까지 손보느라 api 변경이 커진다.
- 선택지:
  1. 어드민 `src/api/types.ts`에 있던 것만 — 화면 안 로컬 타입 14개(배치 실행 이력·이상·발주·VAN·배포·A/S·박스 스캔)가 그대로 남는다.
  2. 어드민이 실제로 부르는 응답 전부 + view 함수가 있는 응답 + 쓰기 요청 본문 + 오류 코드 — 어드민의 모든 `api<…>()`가 계약 타입이 된다.
  3. 2 + GET 쿼리 문자열(`?status=&beforeId=…`) — 어드민 `Query`를 엔드포인트별 타입으로 바꿔야 하고, 쿼리 DTO(`ListTerminalsQuery` 등)는 class-transformer가 문자열을 숫자로 바꾸는 단계가 있어 "보내는 모양"과 "받는 모양"이 다르다.
  4. 2 + 런타임 응답 검증(zod 스키마를 계약에 두고 어드민이 응답을 parse) — 계약에 런타임 값이 생겨 0047 방식이 안 되고, 새 의존성이 든다.
- 결정: 2. 넣는 것: 단말기 목록·상세·이력·접속·검수 기록·검수 항목·검수 결과·가맹점·모델·운송장(`toShipmentView`, POST /shipments), 박스 스캔, 발주·발주 대조·마감, A/S, 펌웨어·배포·단계 통계, 이상 단말기·규칙·찾기 결과, VAN 실행·결과, 주간 리포트·주 목록, 택배 수집 실행, 대시보드, health, 목록 페이지 세 모양, 쓰기 요청 본문 13가지(DTO가 implements), 오류 응답 본문과 코드 전부. 넣지 않는 것: 쿼리 문자열, 어드민이 부르지 않는 응답(엑셀 일괄 등록 결과, 검수 불합격 통계, 하트비트·펌웨어 보고 — 단말기 시뮬레이터 쪽), 런타임 검증.
- 결과·대가: 어드민의 응답 타입·요청 본문·오류 코드 비교·상태 이름표가 모두 계약에 묶인다. 쿼리는 여전히 자유 형식이라 `query: { status: 'IN_STOCK' }` 같은 값은 계약이 바뀌어도 잡히지 않는다(사전 검증에서 `'IN_STOCK'` → `'STOCKED'`로 바꿨을 때 이름표·가짜 응답은 실패했지만 A/S 화면의 재고 조회 쿼리는 통과). api의 엔티티 하나(`SyncRun.outcome`)만 타입을 좁혔다(스키마 변화 없음).
- 다시 볼 조건: 쿼리 값 오타로 빈 목록이 나온 사고가 생기면 3을 엔드포인트 몇 개부터. 어드민이 엑셀 등록·검수 통계를 부르게 되면 그 응답을 계약에 더한다.
```

`docs/devlog/2026-10-27.md` 끝에:

```markdown
## HH:MM Task 2 api 응답·요청 계약 — view·서비스·컨트롤러 반환 타입, DTO implements
이전 커밋: <Task 시작 때 git log -1 --format=%h>
- 한 일:
  - 계약에 응답·요청 모양(`terminal.ts`·`operations.ts`·`reports.ts`·`requests.ts`)
  - api: view 함수 4개 파일·서비스와 집계 10개 파일·컨트롤러 14개에 계약 반환 타입, api의 `StageStats`·`ConnectivityView`·`DashboardSummary`·`DashboardView` 정의를 계약으로 옮김, DTO 13개가 요청 계약을 implements
  - drift 테스트에 경우 셋(응답 필드 이름 변경 TS2353, 응답 필드 추가 TS2741, 요청 필드 변경 TS2420)
- 확인:
  - 먼저 실패: (Step 2 출력 — 3 failed | 4 passed)
  - drift 7 passed, tsc 0, build 0, `dist`에 계약 import 0곳, api 전체 `Test Files 66 passed (66)`, `Tests 453 passed (453)`(Duration …s)
  - 실제 빌드로 본 어긋남: (Step 7의 TS2353 한 줄) → 되돌린 뒤 build 0
- 막힌 것: (없으면 없음)
- 결정: decisions/0049(범위 — 쿼리 문자열·런타임 검증은 넣지 않음)
- 다음: Task 3 어드민이 contracts를 쓴다
```

```bash
cd ../.. && git add packages/contracts apps/api docs && git status --short && git commit -m "refactor: api 응답·요청을 contracts 타입으로 — view·서비스·컨트롤러 반환 타입, DTO implements

Refs: docs/decisions/0049-계약-범위는-응답-요청-본문-오류-코드까지.md, docs/decisions/0048-계약은-반환-타입-implements-enum-단언으로-강제한다.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: devlog 제목 시각을 커밋 시각과 맞춘다**

Task 1 Step 8과 같다.

---

### Task 3: 어드민이 contracts를 쓴다 — types.ts·로컬 타입 지움, 이름표·오류 코드·요청 본문

어드민의 응답 타입을 모두 계약으로 바꾸고, 상태 이름표·오류 안내·요청 본문을 계약 유니온에 묶는다(decisions/0048). 화면 동작은 바뀌지 않는다. 바꾸는 순간 테스트 가짜 응답의 어긋남 네 곳이 tsc에 드러난다(그중 하나는 서버에 없는 상태 값).

**Files:**
- Modify: `apps/admin/package.json`, `apps/admin/package-lock.json`(npm이 만든다)
- Delete: `apps/admin/src/api/types.ts`
- Modify: `apps/admin/src/api/client.ts`, `src/api/lists.ts`, `src/components/ErrorBox.tsx`, `src/components/TerminalActions.tsx`, `src/lib/labels.ts`, `src/test/fixtures.ts`
- Modify: `apps/admin/src/pages/` — `BatchHistoryPage.tsx`, `BatchHistoryPage.test.tsx`, `HomePage.tsx`, `RolloutsPage.tsx`, `ScanPage.tsx`, `ServiceAndRollouts.test.tsx`, `ServiceTicketDetailPage.tsx`, `ServiceTicketsPage.tsx`, `TerminalDetailPage.tsx`, `TerminalListPage.tsx`, `TerminalPages.test.tsx`, `reports/AnomaliesPage.tsx`, `reports/PurchaseOrdersPage.tsx`, `reports/ReportsPages.test.tsx`, `reports/VanRunDetailPage.tsx`, `reports/VanRunsPage.tsx`, `reports/WeeklyReportsPage.tsx`
- Modify: `docs/decisions/0048-계약은-반환-타입-implements-enum-단언으로-강제한다.md`(보탬), `docs/devlog/2026-10-27.md`

- [ ] **Step 1: 어드민에 연결한다**

Run(`apps/admin`): `npm install --no-audit --no-fund ../../packages/contracts`
Expected: `added 1 package`, `ls -la node_modules/@terminal-ops/` → `contracts -> …/packages/contracts`. 바뀐 내용:

```diff
@@ -11,6 +11,7 @@
   },
   "dependencies": {
     "@tanstack/react-query": "5.104.2",
+    "@terminal-ops/contracts": "file:../../packages/contracts",
     "react": "19.3.0",
     "react-dom": "19.3.0",
     "react-router": "8.4.0"
```

```diff
@@ -7,6 +7,7 @@
       "name": "@terminal-ops/admin",
       "dependencies": {
         "@tanstack/react-query": "5.104.2",
+        "@terminal-ops/contracts": "file:../../packages/contracts",
         "react": "19.3.0",
         "react-dom": "19.3.0",
         "react-router": "8.4.0"
@@ -26,6 +27,10 @@
         "vitest": "5.0.4"
       }
     },
+    "../../packages/contracts": {
+      "name": "@terminal-ops/contracts",
+      "version": "0.0.0"
+    },
     "node_modules/@adobe/css-tools": {
       "version": "4.5.0",
       "resolved": "https://registry.npmjs.org/@adobe/css-tools/-/css-tools-4.5.0.tgz",
@@ -622,6 +627,10 @@
         "react": "^18 || ^19"
       }
     },
+    "node_modules/@terminal-ops/contracts": {
+      "resolved": "../../packages/contracts",
+      "link": true
+    },
     "node_modules/@testing-library/dom": {
       "version": "10.4.2",
       "resolved": "https://registry.npmjs.org/@testing-library/dom/-/dom-10.4.2.tgz",
```

- [ ] **Step 2: types.ts를 지우고 import를 바꾼 뒤 tsc가 무엇을 잡는지 본다(빨강)**

Run(`apps/admin`):
```bash
git rm -q src/api/types.ts
grep -rln "api/types'\|from './types'" src | xargs sed -i "s#from '\.\./api/types';#from '@terminal-ops/contracts';#; s#from '\.\./\.\./api/types';#from '@terminal-ops/contracts';#; s#from './types';#from '@terminal-ops/contracts';#"
grep -rn "@terminal-ops/contracts" src | wc -l
npx tsc --noEmit -p tsconfig.json
```
(`sed` 한 줄짜리 치환이라 heredoc 규칙에 걸리지 않는다. Step 3의 diff가 최종 모양이므로 여기서 바뀐 줄도 Step 3과 같아진다.)
Expected: `11`(import 줄 수), 그리고 tsc 오류 4개(사전 검증 출력 그대로):
```
src/pages/BatchHistoryPage.test.tsx(98,47): error TS2322: Type '"FAILED"' is not assignable to type 'WeeklyReportStatus | undefined'.
src/pages/BatchHistoryPage.test.tsx(99,47): error TS2322: Type '"FAILED"' is not assignable to type 'WeeklyReportStatus | undefined'.
src/pages/TerminalPages.test.tsx(110,75): error TS2322: Type '{ modelName: string; … }' is not assignable to type 'TerminalDetail'.
  Types of property 'status' are incompatible.
    Type 'string' is not assignable to type 'TerminalStatus'.
src/pages/TerminalPages.test.tsx(297,55): error TS2322: Type '{ to: string; blockedReason: string | null; }[]' is not assignable to type 'TransitionTarget[]'.
```
첫 둘은 **서버에 없는 상태 값**이다(`WeeklyReportStatus` = `PENDING | GENERATED | SENT`, 실패한 시도는 `lastError`만 남는다). 화면은 이 값에 기대지 않아 지금까지 테스트가 통과했다. 나머지 둘은 가짜 응답을 만드는 helper가 상태를 `string`으로 받던 것.

- [ ] **Step 3: 로컬 타입을 지우고 계약을 쓴다**

먼저 Step 2의 `sed` 치환만 되돌린다: `git checkout -- src`(`git rm`한 `src/api/types.ts`는 지워진 채로 남는다 — `git status --short`에 `D  src/api/types.ts` 한 줄). 아래 diff는 이 Task 직전 파일 기준이고 Step 2의 import 치환을 포함한다.

화면·컴포넌트·테스트의 바뀐 부분:

`apps/admin/src/api/client.ts`:

```diff
@@ -1,14 +1,15 @@
+import type { ApiErrorBody, ErrorCode } from '@terminal-ops/contracts';
 import { getOperator } from '../operator';
 
 /** 개발 서버 프록시가 Nest api로 넘기는 경로 앞부분(vite.config.ts, decisions/0041) */
 export const API_BASE = '/api';
 
-/** api 오류 응답. 서버는 { statusCode, code?, message } 모양으로 준다(DomainExceptionFilter, ValidationPipe) */
+/** api 오류 응답. 서버는 { statusCode, code?, message } 모양(contracts ApiErrorBody)으로 준다(DomainExceptionFilter, ValidationPipe) */
 export class ApiError extends Error {
   constructor(
     readonly status: number,
     /** 서버가 준 원인 코드(VERSION_CONFLICT, PO_CLOSED …). 검증 오류(400)·404에는 없다 */
-    readonly code: string | null,
+    readonly code: ErrorCode | null,
     message: string,
     readonly body: unknown,
   ) {
@@ -72,7 +73,8 @@ export async function api<T>(path: string, options: RequestOptions = {}): Promis
     }
   }
   if (!res.ok) {
-    const code = (body as { code?: unknown } | null)?.code;
+    // 서버가 contracts 밖의 코드를 주지 않는다는 전제(api는 ErrorCode 유니온 밖의 코드를 컴파일하지 못한다, decisions/0048)
+    const code = (body as Partial<ApiErrorBody> | null)?.code;
     throw new ApiError(res.status, typeof code === 'string' ? code : null, messageOf(res.status, body), body);
   }
   return body as T;
```

`apps/admin/src/api/lists.ts`:

```diff
@@ -1,6 +1,6 @@
 import { useInfiniteQuery } from '@tanstack/react-query';
 import { api, type Query } from './client';
-import type { BeforeIdPage, WeeklyReportView } from './types';
+import type { BeforeIdPage, WeeklyReportPage } from '@terminal-ops/contracts';
 import { keys, keysetKey } from './query-keys';
 
 /**
@@ -28,7 +28,7 @@ export function itemsOf<T>(data: { pages: BeforeIdPage<T>[] } | undefined): T[]
 export function useWeeklyReports() {
   return useInfiniteQuery({
     queryKey: keys.weeklyReports.all,
-    queryFn: ({ pageParam }) => api<{ items: WeeklyReportView[]; nextBefore: string | null }>('/reports/weekly', { query: { before: pageParam ?? undefined } }),
+    queryFn: ({ pageParam }) => api<WeeklyReportPage>('/reports/weekly', { query: { before: pageParam ?? undefined } }),
     initialPageParam: null as string | null,
     getNextPageParam: (last) => last.nextBefore,
   });
```

`apps/admin/src/components/ErrorBox.tsx`:

```diff
@@ -1,7 +1,8 @@
+import type { ErrorCode } from '@terminal-ops/contracts';
 import { ApiError } from '../api/client';
 
 /** 코드별로 운영자가 할 일을 덧붙인다. 서버 메시지는 그대로 보여 준다 */
-const HINT: Record<string, string> = {
+const HINT: Partial<Record<ErrorCode, string>> = {
   VERSION_CONFLICT: '다른 작업이 먼저 이 단말기를 바꿨습니다. 다시 불러온 뒤 확인하고 시도하세요.',
   DEADLOCK: '동시에 처리하던 다른 작업과 겹쳤습니다. 잠시 뒤 다시 시도하세요.',
   INVALID_TRANSITION: '지금 상태에서 할 수 없는 변경입니다.',
@@ -11,7 +12,7 @@ const HINT: Record<string, string> = {
   ANOMALY_SCAN_RUNNING: '이미 진행 중인 작업이 있습니다. 끝난 뒤 다시 실행하세요.',
 };
 
-export function describeError(error: unknown): { title: string; detail: string; code: string | null } {
+export function describeError(error: unknown): { title: string; detail: string; code: ErrorCode | null } {
   if (error instanceof ApiError) {
     const hint = (error.code && HINT[error.code]) ?? (error.status === 400 ? '입력값을 확인하세요.' : error.status === 404 ? '찾는 대상이 없습니다.' : null);
     return { title: hint ?? `요청이 실패했습니다(HTTP ${error.status}).`, detail: error.message, code: error.code };
```

`apps/admin/src/components/TerminalActions.tsx`:

```diff
@@ -1,12 +1,28 @@
 import { useState } from 'react';
 import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
 import { api } from '../api/client';
-import type { InspectionItemView, MerchantView, TerminalDetail } from '../api/types';
+import type {
+  AllocateRequest,
+  CancelAllocationRequest,
+  Carrier,
+  CreateShipmentRequest,
+  InspectionItemView,
+  InspectionResultInput,
+  InspectRequest,
+  InspectResult,
+  MerchantView,
+  TerminalDetail,
+  TerminalStatus,
+  TransitionRequest,
+} from '@terminal-ops/contracts';
 import { CARRIER_LABEL, label, TERMINAL_STATUS_LABEL } from '../lib/labels';
 import { ErrorBox } from './ErrorBox';
 import { WriteButton } from './WriteButton';
 import { keys } from '../api/query-keys';
 
+/** expectedVersion은 run()이 붙인다 */
+type Unversioned<T> = Omit<T, 'expectedVersion'>;
+
 /**
  * 단말기 상세의 "할 수 있는 일". 무엇을 보여 줄지는 서버가 준 allowedTransitions·actions만 본다(전이 규칙을 화면에 두지 않는다, decisions/0040).
  * 모든 요청에 화면에서 본 version(expectedVersion)을 실어 보낸다 — 그사이 다른 변경이 있으면 409 VERSION_CONFLICT(decisions/0004).
@@ -14,13 +30,13 @@ import { keys } from '../api/query-keys';
 export function TerminalActions({ terminal, onReload }: { terminal: TerminalDetail; onReload: () => void }) {
   const client = useQueryClient();
   const path = `/terminals/${encodeURIComponent(terminal.serialNo)}`;
-  const [pick, setSelected] = useState<string | null>(null);
+  const [pick, setSelected] = useState<TerminalStatus | null>(null);
   // 다시 불러온 상세에서 고른 전이가 없어졌거나 막혔으면 선택을 푼다
   const selected = terminal.allowedTransitions.some((t) => t.to === pick && t.blockedReason === null) ? pick : null;
   const [reason, setReason] = useState('');
   const [merchantCode, setMerchantCode] = useState('');
   const [cancelReason, setCancelReason] = useState('');
-  const [carrier, setCarrier] = useState('BUNGAE');
+  const [carrier, setCarrier] = useState<Carrier>('BUNGAE');
 
   const merchants = useQuery({
     queryKey: keys.merchants,
@@ -39,7 +55,8 @@ export function TerminalActions({ terminal, onReload }: { terminal: TerminalDeta
       await client.invalidateQueries({ queryKey: keys.terminals.all });
     },
   });
-  const run = (url: string, body: Record<string, unknown>) => action.mutate({ url, body: { ...body, expectedVersion: terminal.version } });
+  /** 본문에 화면에서 본 version을 붙여 보낸다. 본문 모양은 부르는 곳에서 contracts 요청 타입으로 satisfies */
+  const run = (url: string, body: object) => action.mutate({ url, body: { ...body, expectedVersion: terminal.version } });
 
   const nothing =
     terminal.allowedTransitions.length === 0 && !Object.values(terminal.actions).some(Boolean);
@@ -85,7 +102,7 @@ export function TerminalActions({ terminal, onReload }: { terminal: TerminalDeta
               <WriteButton
                 className="primary"
                 disabled={!reason.trim() || action.isPending}
-                onClick={() => run(`${path}/transitions`, { to: selected, reason: reason.trim() })}
+                onClick={() => run(`${path}/transitions`, { to: selected, reason: reason.trim() } satisfies Unversioned<TransitionRequest>)}
               >
                 {label(TERMINAL_STATUS_LABEL, selected)}(으)로 바꾸기
               </WriteButton>
@@ -104,7 +121,7 @@ export function TerminalActions({ terminal, onReload }: { terminal: TerminalDeta
               </option>
             ))}
           </select>
-          <WriteButton disabled={!merchantCode || action.isPending} onClick={() => run(`${path}/allocations`, { merchantCode })}>
+          <WriteButton disabled={!merchantCode || action.isPending} onClick={() => run(`${path}/allocations`, { merchantCode } satisfies Unversioned<AllocateRequest>)}>
             가맹점 배정
           </WriteButton>
         </div>
@@ -115,7 +132,7 @@ export function TerminalActions({ terminal, onReload }: { terminal: TerminalDeta
           <input aria-label="배정 취소 사유" placeholder="배정 취소 사유" value={cancelReason} maxLength={200} onChange={(e) => setCancelReason(e.target.value)} />
           <WriteButton
             disabled={!cancelReason.trim() || action.isPending}
-            onClick={() => run(`${path}/allocation-cancellations`, { reason: cancelReason.trim() })}
+            onClick={() => run(`${path}/allocation-cancellations`, { reason: cancelReason.trim() } satisfies Unversioned<CancelAllocationRequest>)}
           >
             배정 취소
           </WriteButton>
@@ -124,14 +141,14 @@ export function TerminalActions({ terminal, onReload }: { terminal: TerminalDeta
 
       {terminal.actions.ship ? (
         <div className="row">
-          <select aria-label="택배사" value={carrier} onChange={(e) => setCarrier(e.target.value)}>
+          <select aria-label="택배사" value={carrier} onChange={(e) => setCarrier(e.target.value as Carrier)}>
             {Object.entries(CARRIER_LABEL).map(([code, name]) => (
               <option key={code} value={code}>
                 {name}
               </option>
             ))}
           </select>
-          <WriteButton disabled={action.isPending} onClick={() => run('/shipments', { serialNo: terminal.serialNo, carrier })}>
+          <WriteButton disabled={action.isPending} onClick={() => run('/shipments', { serialNo: terminal.serialNo, carrier } satisfies Unversioned<CreateShipmentRequest>)}>
             출고(운송장 발급)
           </WriteButton>
         </div>
@@ -152,8 +169,8 @@ function InspectForm({ terminal, onReload }: { terminal: TerminalDetail; onReloa
   });
   const [failed, setFailed] = useState<Record<string, boolean>>({});
   const inspect = useMutation({
-    mutationFn: (results: { itemCode: string; passed: boolean }[]) =>
-      api(`/terminals/${encodeURIComponent(terminal.serialNo)}/inspections`, { method: 'POST', body: { results } }),
+    mutationFn: (results: InspectionResultInput[]) =>
+      api<InspectResult>(`/terminals/${encodeURIComponent(terminal.serialNo)}/inspections`, { method: 'POST', body: { results } satisfies InspectRequest }),
     onSuccess: async () => {
       setFailed({});
       await client.invalidateQueries({ queryKey: keys.terminal.one(terminal.serialNo) });
```

`apps/admin/src/lib/labels.ts`:

```diff
@@ -1,8 +1,10 @@
+import type { Carrier, TerminalStatus, TransitionSource } from '@terminal-ops/contracts';
+
 /**
  * 화면에 보이는 이름만 둔다(규칙은 두지 않는다 — 가능한 전이는 서버가 준다, decisions/0040).
- * 키는 api enum 값(terminal-status.ts 등)이다. 모르는 값이 오면 값을 그대로 보여 준다(label()).
+ * 키는 contracts의 상태 유니온이다 — 값이 하나라도 빠지거나 없는 값이 있으면 tsc가 막는다(decisions/0048). 모르는 값이 오면 값을 그대로 보여 준다(label()).
  */
-export const TERMINAL_STATUS_LABEL: Record<string, string> = {
+export const TERMINAL_STATUS_LABEL: Record<TerminalStatus, string> = {
   RECEIVED: '입고',
   INSPECTED: '검수 합격',
   DEFECTIVE: '불량',
@@ -17,9 +19,9 @@ export const TERMINAL_STATUS_LABEL: Record<string, string> = {
   DISPOSED: '폐기',
 };
 
-export const TERMINAL_STATUSES = Object.keys(TERMINAL_STATUS_LABEL);
+export const TERMINAL_STATUSES = Object.keys(TERMINAL_STATUS_LABEL) as TerminalStatus[];
 
-export const SOURCE_LABEL: Record<string, string> = {
+export const SOURCE_LABEL: Record<TransitionSource, string> = {
   MANUAL: '수동',
   INSPECTION: '검수',
   BATCH: '배치',
@@ -30,7 +32,7 @@ export const SOURCE_LABEL: Record<string, string> = {
   SERVICE: 'A/S',
 };
 
-export const CARRIER_LABEL: Record<string, string> = {
+export const CARRIER_LABEL: Record<Carrier, string> = {
   BUNGAE: '번개택배',
   NEURIMBO: '느림보물류',
 };
```

`apps/admin/src/test/fixtures.ts`:

```diff
@@ -1,4 +1,4 @@
-import type { DashboardView } from '../api/types';
+import type { DashboardView } from '@terminal-ops/contracts';
 
 /** 서버 GET /dashboard/summary 응답 모양(api DashboardView, decisions/0044) — 처음 화면을 그리는 테스트가 함께 쓴다 */
 export const dashboardBody = (over: Partial<DashboardView> = {}): DashboardView => ({
```

`apps/admin/src/pages/BatchHistoryPage.tsx`:

```diff
@@ -4,25 +4,9 @@ import { ErrorBox } from '../components/ErrorBox';
 import { MoreButton } from '../components/MoreButton';
 import { RunningPoller, type Refetch } from '../components/RunningPoller';
 import { formatKst } from '../lib/format';
-import type { VanRunView } from './reports/VanRunsPage';
+import type { SyncRunOutcome, SyncRunView, VanRunView } from '@terminal-ops/contracts';
 import { keys } from '../api/query-keys';
 
-interface SyncRunView {
-  id: number;
-  job: string;
-  shipmentId: number | null;
-  trackingNo: string | null;
-  attempt: number;
-  worker: string;
-  outcome: string;
-  startedAt: string;
-  finishedAt: string | null;
-  fetched: number;
-  inserted: number;
-  duplicated: number;
-  detail: string | null;
-}
-
 const TABS = [
   { key: 'sync', label: '택배 수집' },
   { key: 'van', label: 'VAN 대조' },
@@ -30,7 +14,8 @@ const TABS = [
 ] as const;
 type Tab = (typeof TABS)[number]['key'];
 
-const OUTCOMES = ['OK', 'DELIVERED', 'NOOP', 'SKIPPED', 'ERROR'];
+/** 결과 필터 선택지. contracts에 없는 값이면 tsc가 막는다(빠진 값은 막지 못한다 — 순서를 화면이 정하므로 배열로 둔다) */
+const OUTCOMES = ['OK', 'DELIVERED', 'NOOP', 'SKIPPED', 'ERROR'] as const satisfies readonly SyncRunOutcome[];
 
 /**
  * 배치 실행 이력: 실행마다 행을 남기는 배치 세 가지(택배 수집 SyncRun, VAN 대조 실행, 주간 리포트 주별 행).
```

`apps/admin/src/pages/BatchHistoryPage.test.tsx`:

```diff
@@ -3,7 +3,7 @@ import userEvent from '@testing-library/user-event';
 import { describe, expect, it, vi } from 'vitest';
 import { mockApi, renderPage } from '../test/render';
 import { BatchHistoryPage } from './BatchHistoryPage';
-import type { WeeklyReportView } from './reports/WeeklyReportsPage';
+import type { WeeklyReportView } from '@terminal-ops/contracts';
 
 const syncRun = (over: Record<string, unknown> = {}) => ({
   id: 9,
@@ -95,8 +95,8 @@ describe('배치 실행 이력 (decisions/0039)', () => {
       'GET /reports/weekly': () => ({
         body: {
           items: [
-            weekly({ weekStart: '2026-10-26', status: 'FAILED', attempts: 2, sentAt: null, lastError: '메일 서버 응답 없음', queued: true, queuedAt: '2026-10-27T00:00:00.000Z' }),
-            weekly({ weekStart: '2026-10-19', status: 'FAILED', attempts: 1, sentAt: null, lastError: '첨부 생성 실패' }),
+            weekly({ weekStart: '2026-10-26', status: 'PENDING', attempts: 2, sentAt: null, lastError: '메일 서버 응답 없음', queued: true, queuedAt: '2026-10-27T00:00:00.000Z' }),
+            weekly({ weekStart: '2026-10-19', status: 'GENERATED', attempts: 1, sentAt: null, lastError: '첨부 생성 실패' }),
           ],
           nextBefore: null,
         },
```

`apps/admin/src/pages/HomePage.tsx`:

```diff
@@ -3,7 +3,7 @@ import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
 import { Link } from 'react-router';
 import { api } from '../api/client';
 import { keys } from '../api/query-keys';
-import type { DashboardView } from '../api/types';
+import type { DashboardView } from '@terminal-ops/contracts';
 import { ErrorBox } from '../components/ErrorBox';
 import { useNow } from '../hooks/useNow';
 import { ageText, formatKst } from '../lib/format';
```

`apps/admin/src/pages/RolloutsPage.tsx`:

```diff
@@ -8,36 +8,10 @@ import { WriteButton } from '../components/WriteButton';
 import { formatKst } from '../lib/format';
 import { label } from '../lib/labels';
 import { keys } from '../api/query-keys';
+import type { RolloutStatus, RolloutView } from '@terminal-ops/contracts';
 
-export interface StageStats {
-  stage: number;
-  percent: number;
-  targets: number;
-  offered: number;
-  succeeded: number;
-  failed: number;
-  timedOut: number;
-}
-
-export interface RolloutView {
-  id: number;
-  modelCode: string;
-  version: string;
-  status: string;
-  stages: number[];
-  currentStage: number;
-  failureThreshold: number;
-  minSamples: number;
-  stageTimeoutMs: number;
-  stageStartedAt: string;
-  createdBy: string;
-  createdAt: string;
-  finishedAt: string | null;
-  endReason: string | null;
-  stageStats: StageStats[];
-}
-
-const ROLLOUT_STATUS_LABEL: Record<string, string> = {
+/** 배포 상태 이름. 키가 contracts RolloutStatus와 하나라도 다르면 tsc가 막는다 */
+const ROLLOUT_STATUS_LABEL: Record<RolloutStatus, string> = {
   RUNNING: '진행 중',
   PAUSED: '멈춤',
   COMPLETED: '완료',
```

`apps/admin/src/pages/ScanPage.tsx`:

```diff
@@ -1,31 +1,12 @@
 import { useRef, useState } from 'react';
 import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
 import { api, ApiError } from '../api/client';
-import type { BeforeIdPage } from '../api/types';
+import type { BeforeIdPage, CreateScanRequest, PurchaseOrderStatus, PurchaseOrderView, RowResultCode, ScanKind, ScanView } from '@terminal-ops/contracts';
 import { ErrorBox } from '../components/ErrorBox';
 import { WriteButton } from '../components/WriteButton';
 import { formatKst } from '../lib/format';
 import { keys } from '../api/query-keys';
 
-interface PurchaseOrderView {
-  id: number;
-  poNo: string;
-  modelCode: string;
-  quantity: number;
-  status: string;
-}
-
-interface ScanResultView {
-  scanId: string;
-  kind: string;
-  poNo: string | null;
-  actor: string;
-  replayed: boolean;
-  createdAt: string;
-  summary: Record<string, number>;
-  results: { serialNo: string; result: string; message?: string }[];
-}
-
 /** 스캐너가 박스마다 만드는 멱등 키(서버 규칙: 영문·숫자·_·- 8~64자) */
 export function newScanId(): string {
   return `BOX-${crypto.randomUUID()}`;
@@ -52,9 +33,9 @@ const retryable = (error: unknown) =>
   !(error instanceof ApiError) || error.status >= 500 || (error.status === 409 && (error.code === 'SCAN_IN_PROGRESS' || error.code === 'VERSION_CONFLICT'));
 
 /** 열린 발주 상태. 상태별로 따로 불러 합친다 — 한 번에 최근 100개를 받아 거르면 CLOSED가 쌓였을 때 오래된 열린 발주가 잘린다 */
-const OPEN_PO_STATUSES = ['ORDERED', 'RECEIVING'] as const;
+const OPEN_PO_STATUSES = ['ORDERED', 'RECEIVING'] as const satisfies readonly PurchaseOrderStatus[];
 
-const SUCCESS = new Set(['CREATED', 'RETURNED']);
+const SUCCESS = new Set<RowResultCode>(['CREATED', 'RETURNED']);
 
 /**
  * 박스 일괄 스캔(F6). 박스 하나 = 요청 하나. scanId는 처음 보낼 때 만들고, 결과를 받거나 박스를 버릴 때까지 같은 값을 쓴다 —
@@ -63,7 +44,7 @@ const SUCCESS = new Set(['CREATED', 'RETURNED']);
  */
 export function ScanPage() {
   const client = useQueryClient();
-  const [kind, setKind] = useState<'RECEIVE' | 'RETURN_IN'>('RECEIVE');
+  const [kind, setKind] = useState<ScanKind>('RECEIVE');
   const [poNo, setPoNo] = useState('');
   const [text, setText] = useState('');
   const [scanId, setScanId] = useState<string | null>(null);
@@ -86,7 +67,7 @@ export function ScanPage() {
   });
 
   const scan = useMutation({
-    mutationFn: (body: { scanId: string; kind: string; poNo?: string; serials: string[] }) => api<ScanResultView>('/scans', { method: 'POST', body }),
+    mutationFn: (body: CreateScanRequest) => api<ScanView>('/scans', { method: 'POST', body }),
     onSuccess: () => {
       // 스캔은 여러 단말기의 상태와 발주 입고 수를 바꾼다: 단말기 목록·상세, 발주 목록·입고 대조를 모두 다시 읽는다(Day 6 최종 리뷰 Minor 4)
       void client.invalidateQueries({ queryKey: keys.terminals.all });
```

`apps/admin/src/pages/ServiceAndRollouts.test.tsx`:

```diff
@@ -2,9 +2,10 @@ import { screen, waitFor, within } from '@testing-library/react';
 import userEvent from '@testing-library/user-event';
 import { describe, expect, it, vi } from 'vitest';
 import { loginAs, mockApi, renderPage } from '../test/render';
-import { RolloutsPage, type RolloutView } from './RolloutsPage';
+import type { RolloutView, TicketView } from '@terminal-ops/contracts';
+import { RolloutsPage } from './RolloutsPage';
 import { ServiceTicketDetailPage } from './ServiceTicketDetailPage';
-import { ServiceTicketsPage, type TicketView } from './ServiceTicketsPage';
+import { ServiceTicketsPage } from './ServiceTicketsPage';
 
 const ticket = (over: Partial<TicketView> = {}): TicketView => ({
   id: 7,
```

`apps/admin/src/pages/ServiceTicketDetailPage.tsx`:

```diff
@@ -2,12 +2,12 @@ import { useState } from 'react';
 import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
 import { Link, useParams } from 'react-router';
 import { api } from '../api/client';
-import type { TerminalDetail, TerminalPage } from '../api/types';
+import type { Carrier, RemoteCheckRequest, ReplaceRequest, TerminalDetail, TerminalPage, TicketView } from '@terminal-ops/contracts';
 import { ErrorBox } from '../components/ErrorBox';
 import { WriteButton } from '../components/WriteButton';
 import { formatKst } from '../lib/format';
 import { CARRIER_LABEL, label } from '../lib/labels';
-import { TICKET_STATUS_LABEL, type TicketView } from './ServiceTicketsPage';
+import { TICKET_STATUS_LABEL } from './ServiceTicketsPage';
 import { keys } from '../api/query-keys';
 
 /**
@@ -21,7 +21,7 @@ export function ServiceTicketDetailPage() {
   const [note, setNote] = useState('');
   const [resolved, setResolved] = useState(false);
   const [replacement, setReplacement] = useState('');
-  const [carrier, setCarrier] = useState('BUNGAE');
+  const [carrier, setCarrier] = useState<Carrier>('BUNGAE');
 
   const ticket = useQuery({ queryKey: keys.serviceTicket.one(id), queryFn: () => api<TicketView>(`/service-tickets/${id}`), enabled: validId });
   const t = ticket.data;
@@ -112,7 +112,7 @@ export function ServiceTicketDetailPage() {
                   <label>
                     <input type="checkbox" checked={resolved} onChange={(e) => setResolved(e.target.checked)} /> 원격으로 해결됨(종결)
                   </label>
-                  <WriteButton disabled={!note.trim() || act.isPending} onClick={() => act.mutate({ path: 'remote-checks', body: { resolved, note: note.trim() } })}>
+                  <WriteButton disabled={!note.trim() || act.isPending} onClick={() => act.mutate({ path: 'remote-checks', body: { resolved, note: note.trim() } satisfies RemoteCheckRequest })}>
                     점검 기록
                   </WriteButton>
                 </div>
@@ -128,7 +128,7 @@ export function ServiceTicketDetailPage() {
                       </option>
                     ))}
                   </select>
-                  <select aria-label="교체 택배사" value={carrier} onChange={(e) => setCarrier(e.target.value)}>
+                  <select aria-label="교체 택배사" value={carrier} onChange={(e) => setCarrier(e.target.value as Carrier)}>
                     {Object.entries(CARRIER_LABEL).map(([code, name]) => (
                       <option key={code} value={code}>
                         {name}
@@ -138,7 +138,7 @@ export function ServiceTicketDetailPage() {
                   <WriteButton
                     className="primary"
                     disabled={!chosen || act.isPending}
-                    onClick={() => act.mutate({ path: 'replacements', body: { replacementSerialNo: chosen, carrier } })}
+                    onClick={() => act.mutate({ path: 'replacements', body: { replacementSerialNo: chosen, carrier } satisfies ReplaceRequest })}
                   >
                     교체 출고
                   </WriteButton>
```

`apps/admin/src/pages/ServiceTicketsPage.tsx`:

```diff
@@ -9,23 +9,10 @@ import { WriteButton } from '../components/WriteButton';
 import { formatKst } from '../lib/format';
 import { label } from '../lib/labels';
 import { keys } from '../api/query-keys';
+import type { OpenTicketRequest, ServiceTicketStatus, TicketView } from '@terminal-ops/contracts';
 
-export interface TicketView {
-  id: number;
-  serialNo: string;
-  merchantCode: string;
-  symptom: string;
-  status: string;
-  remoteNote: string | null;
-  replacementSerialNo: string | null;
-  outboundShipmentId: number | null;
-  outboundTrackingNo: string | null;
-  openedBy: string;
-  createdAt: string;
-  closedAt: string | null;
-}
-
-export const TICKET_STATUS_LABEL: Record<string, string> = {
+/** A/S 접수 상태 이름. 키가 contracts ServiceTicketStatus와 하나라도 다르면 tsc가 막는다 */
+export const TICKET_STATUS_LABEL: Record<ServiceTicketStatus, string> = {
   OPEN: '접수됨',
   RESOLVED_REMOTELY: '원격 해결',
   REPLACING: '교체 출고됨',
@@ -41,7 +28,7 @@ export function ServiceTicketsPage() {
   const [symptom, setSymptom] = useState('');
   const list = useBeforeIdList<TicketView>(keys.serviceTickets.all, '/service-tickets', { status });
   const open = useMutation({
-    mutationFn: () => api<TicketView>('/service-tickets', { method: 'POST', body: { serialNo: serialNo.trim(), symptom: symptom.trim() } }),
+    mutationFn: () => api<TicketView>('/service-tickets', { method: 'POST', body: { serialNo: serialNo.trim(), symptom: symptom.trim() } satisfies OpenTicketRequest }),
     onSuccess: async (ticket) => {
       await client.invalidateQueries({ queryKey: keys.serviceTickets.all });
       await navigate(`/service-tickets/${ticket.id}`);
```

`apps/admin/src/pages/TerminalDetailPage.tsx`:

```diff
@@ -1,7 +1,7 @@
 import { useQuery, useQueryClient } from '@tanstack/react-query';
 import { Link, useParams } from 'react-router';
 import { api } from '../api/client';
-import type { ConnectivityView, HistoryView, InspectionRecord, TerminalDetail } from '../api/types';
+import type { ConnectivityView, HistoryView, InspectionRecord, TerminalDetail } from '@terminal-ops/contracts';
 import { ErrorBox } from '../components/ErrorBox';
 import { TerminalActions } from '../components/TerminalActions';
 import { formatKst } from '../lib/format';
```

`apps/admin/src/pages/TerminalListPage.tsx`:

```diff
@@ -2,7 +2,7 @@ import { useEffect, useState, type FormEvent } from 'react';
 import { keepPreviousData, useQuery } from '@tanstack/react-query';
 import { Link, useSearchParams } from 'react-router';
 import { api } from '../api/client';
-import type { MerchantView, TerminalModelView, TerminalPage } from '../api/types';
+import type { MerchantView, TerminalModelView, TerminalPage } from '@terminal-ops/contracts';
 import { ErrorBox } from '../components/ErrorBox';
 import { formatKst } from '../lib/format';
 import { label, TERMINAL_STATUS_LABEL, TERMINAL_STATUSES } from '../lib/labels';
```

`apps/admin/src/pages/TerminalPages.test.tsx`:

```diff
@@ -2,12 +2,12 @@ import { screen, waitFor, within } from '@testing-library/react';
 import userEvent from '@testing-library/user-event';
 import { Link, useNavigate } from 'react-router';
 import { describe, expect, it } from 'vitest';
-import type { TerminalDetail } from '../api/types';
+import type { TerminalDetail, TerminalStatus, TerminalView, TransitionTarget } from '@terminal-ops/contracts';
 import { loginAs, mockApi, renderPage } from '../test/render';
 import { TerminalDetailPage } from './TerminalDetailPage';
 import { TerminalListPage } from './TerminalListPage';
 
-const row = (serialNo: string, status = 'IN_STOCK') => ({
+const row = (serialNo: string, status: TerminalStatus = 'IN_STOCK'): TerminalView => ({
   serialNo,
   modelCode: 'SN-100',
   merchantCode: null,
@@ -293,7 +293,7 @@ describe('단말기 상세 (F2, decisions/0040)', () => {
     });
 
     it('다시 불러온 상세에서 고른 전이가 사라졌으면 선택을 풀고, 상세 전체(타임라인 포함)를 다시 읽는다', async () => {
-      let transitions = [{ to: 'DELIVERED', blockedReason: null as string | null }];
+      let transitions: TransitionTarget[] = [{ to: 'DELIVERED', blockedReason: null }];
       const { calls } = mockApi(common(() => detail({ allowedTransitions: transitions })));
       open();
       await userEvent.click(await screen.findByRole('button', { name: '→ 배송 완료' }));
```

`apps/admin/src/pages/reports/AnomaliesPage.tsx`:

```diff
@@ -8,31 +8,7 @@ import { WriteButton } from '../../components/WriteButton';
 import { formatKst } from '../../lib/format';
 import { label, TERMINAL_STATUS_LABEL } from '../../lib/labels';
 import { keys } from '../../api/query-keys';
-
-interface AnomalyRuleView {
-  rule: string;
-  label: string;
-  days: number | null;
-}
-
-interface AnomalyView {
-  id: number;
-  serialNo: string | null;
-  status: string | null;
-  rule: string;
-  ruleLabel: string;
-  detectedAt: string;
-  lastSeenAt: string;
-  resolvedAt: string | null;
-  detail: { days?: number };
-}
-
-interface ScanSummary {
-  detected: number;
-  continuing: number;
-  resolved: number;
-  newSerials: string[];
-}
+import type { AfterIdPage, AnomalyRuleView, AnomalyScanSummary, AnomalyView } from '@terminal-ops/contracts';
 
 /** 이상 단말기(F4): 규칙·열림으로 거르고 afterId로 이어 본다(서버 목록은 오름차순 키셋, decisions/0033). 바로 찾기는 동기(decisions/0038) */
 export function AnomaliesPage() {
@@ -43,12 +19,12 @@ export function AnomaliesPage() {
   const list = useInfiniteQuery({
     queryKey: keys.anomalies.list(rule, open),
     queryFn: ({ pageParam }) =>
-      api<{ items: AnomalyView[]; nextAfterId: number | null }>('/anomalies', { query: { rule, open, afterId: pageParam ?? undefined, limit: 100 } }),
+      api<AfterIdPage<AnomalyView>>('/anomalies', { query: { rule, open, afterId: pageParam ?? undefined, limit: 100 } }),
     initialPageParam: null as number | null,
     getNextPageParam: (last) => last.nextAfterId,
   });
   const scan = useMutation({
-    mutationFn: () => api<ScanSummary>('/anomaly-scans', { method: 'POST' }),
+    mutationFn: () => api<AnomalyScanSummary>('/anomaly-scans', { method: 'POST' }),
     onSuccess: () => client.invalidateQueries({ queryKey: keys.anomalies.all }),
   });
   const items = list.data?.pages.flatMap((p) => p.items) ?? [];
```

`apps/admin/src/pages/reports/PurchaseOrdersPage.tsx`:

```diff
@@ -2,37 +2,19 @@ import { useState } from 'react';
 import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
 import { api } from '../../api/client';
 import { itemsOf, useBeforeIdList } from '../../api/lists';
-import type { TerminalModelView } from '../../api/types';
+import type {
+  ClosedPurchaseOrder,
+  CreatePurchaseOrderRequest,
+  PurchaseOrderReconciliation,
+  PurchaseOrderView,
+  TerminalModelView,
+} from '@terminal-ops/contracts';
 import { ErrorBox } from '../../components/ErrorBox';
 import { MoreButton } from '../../components/MoreButton';
 import { WriteButton } from '../../components/WriteButton';
 import { formatKst } from '../../lib/format';
 import { keys } from '../../api/query-keys';
 
-interface PurchaseOrderView {
-  id: number;
-  poNo: string;
-  modelCode: string;
-  quantity: number;
-  status: string;
-  orderedBy: string;
-  createdAt: string;
-  closedAt: string | null;
-  closedBy: string | null;
-}
-
-interface Reconciliation {
-  poNo: string;
-  modelCode: string;
-  status: string;
-  ordered: number;
-  noted: number;
-  received: number;
-  shortfall: number;
-  missing: string[];
-  unexpected: string[];
-}
-
 /** 발주 대비 입고 대조(F10): 발주 목록, 발주하기, 고른 발주의 대조(명세·입고·빠진 것·명세 밖), 마감 */
 export function PurchaseOrdersPage() {
   const client = useQueryClient();
@@ -43,18 +25,18 @@ export function PurchaseOrdersPage() {
   const models = useQuery({ queryKey: keys.terminalModels, queryFn: () => api<TerminalModelView[]>('/terminal-models'), staleTime: Infinity });
   const recon = useQuery({
     queryKey: keys.purchaseOrder.reconciliation(selected),
-    queryFn: () => api<Reconciliation>(`/purchase-orders/${encodeURIComponent(selected!)}/reconciliation`),
+    queryFn: () => api<PurchaseOrderReconciliation>(`/purchase-orders/${encodeURIComponent(selected!)}/reconciliation`),
     enabled: selected !== null,
   });
   const order = useMutation({
-    mutationFn: () => api<PurchaseOrderView>('/purchase-orders', { method: 'POST', body: { modelCode, quantity: Number(quantity) } }),
+    mutationFn: () => api<PurchaseOrderView>('/purchase-orders', { method: 'POST', body: { modelCode, quantity: Number(quantity) } satisfies CreatePurchaseOrderRequest }),
     onSuccess: async (po) => {
       await client.invalidateQueries({ queryKey: keys.purchaseOrders.all });
       setSelected(po.poNo);
     },
   });
   const close = useMutation({
-    mutationFn: (poNo: string) => api(`/purchase-orders/${encodeURIComponent(poNo)}/close`, { method: 'POST' }),
+    mutationFn: (poNo: string) => api<ClosedPurchaseOrder>(`/purchase-orders/${encodeURIComponent(poNo)}/close`, { method: 'POST' }),
     onSuccess: async () => {
       await client.invalidateQueries({ queryKey: keys.purchaseOrders.all });
       await client.invalidateQueries({ queryKey: keys.purchaseOrder.all });
```

`apps/admin/src/pages/reports/ReportsPages.test.tsx`:

```diff
@@ -6,8 +6,9 @@ import { loginAs, mockApi, renderPage } from '../../test/render';
 import { AnomaliesPage } from './AnomaliesPage';
 import { PurchaseOrdersPage } from './PurchaseOrdersPage';
 import { VanRunDetailPage } from './VanRunDetailPage';
-import { VanRunsPage, type VanRunView } from './VanRunsPage';
-import { lastWeekMonday, queueWait, WORKER_HINT_AFTER_MIN, weekStartProblem, WeeklyReportsPage, type WeeklyReportView } from './WeeklyReportsPage';
+import type { VanRunView, WeeklyReportView } from '@terminal-ops/contracts';
+import { VanRunsPage } from './VanRunsPage';
+import { lastWeekMonday, queueWait, WORKER_HINT_AFTER_MIN, weekStartProblem, WeeklyReportsPage } from './WeeklyReportsPage';
 
 /** 'YYYY-MM-DD'에 days일을 더한다(테스트용) */
 const addDays = (day: string, days: number) => {
```

`apps/admin/src/pages/reports/VanRunDetailPage.tsx`:

```diff
@@ -6,22 +6,9 @@ import { ErrorBox } from '../../components/ErrorBox';
 import { MoreButton } from '../../components/MoreButton';
 import { RunningPoller } from '../../components/RunningPoller';
 import { formatKst } from '../../lib/format';
-import type { VanRunView } from './VanRunsPage';
+import type { VanRunDetail } from '@terminal-ops/contracts';
 import { keys } from '../../api/query-keys';
 
-interface VanItemView {
-  id: number;
-  serialNo: string;
-  kind: string;
-  kindLabel: string;
-  ourValue: string;
-  vanValue: string;
-  verified: boolean;
-  reason: string | null;
-}
-
-type RunWithItems = VanRunView & { items: VanItemView[]; nextAfterId: number | null };
-
 /** VAN 대조 실행 하나. 실행 번호가 바뀌면 key로 새로 그려 필터(종류·재검증)를 처음 값으로 되돌린다 */
 export function VanRunDetailPage() {
   const id = useParams().id ?? '';
@@ -35,7 +22,7 @@ function VanRunDetail({ id }: { id: number }) {
   const detail = useInfiniteQuery({
     queryKey: keys.vanRun.items(id, kind, verified),
     queryFn: ({ pageParam }) =>
-      api<RunWithItems>(`/van-reconciliations/${id}`, { query: { kind, verified, afterId: pageParam ?? undefined, limit: 100 } }),
+      api<VanRunDetail>(`/van-reconciliations/${id}`, { query: { kind, verified, afterId: pageParam ?? undefined, limit: 100 } }),
     initialPageParam: null as number | null,
     getNextPageParam: (last) => last.nextAfterId,
   });
```

`apps/admin/src/pages/reports/VanRunsPage.tsx`:

```diff
@@ -9,27 +9,7 @@ import { RunningPoller } from '../../components/RunningPoller';
 import { WriteButton } from '../../components/WriteButton';
 import { formatKst } from '../../lib/format';
 import { keys } from '../../api/query-keys';
-
-export interface VanRunView {
-  id: number;
-  status: string;
-  trigger: string;
-  requestedBy: string;
-  acknowledgeDrop: boolean;
-  startedAt: string;
-  heartbeatAt: string;
-  finishedAt: string | null;
-  pages: number;
-  fetched: number;
-  retries: number;
-  candidates: number;
-  confirmed: number;
-  resolved: number;
-  unverifiable: number;
-  counts: Record<string, number>;
-  phaseMs: { collect?: number; compare?: number; reverify?: number };
-  error: string | null;
-}
+import type { StartVanReconciliationRequest, VanRunView } from '@terminal-ops/contracts';
 
 /**
  * VAN 등록 대조(F9) 실행 목록과 수동 실행. 실행은 비동기(202) — 목록이 RUNNING이면 저절로 다시 읽는다.
@@ -43,7 +23,7 @@ export function VanRunsPage() {
   const runs = itemsOf(list.data);
   const running = runs.some((r) => r.status === 'RUNNING');
   const start = useMutation({
-    mutationFn: () => api<VanRunView>('/van-reconciliations', { method: 'POST', body: { acknowledgeDrop } }),
+    mutationFn: () => api<VanRunView>('/van-reconciliations', { method: 'POST', body: { acknowledgeDrop } satisfies StartVanReconciliationRequest }),
     onSuccess: () => {
       setAcknowledgeDrop(false);
       return client.invalidateQueries({ queryKey: keys.vanRuns.all });
```

`apps/admin/src/pages/reports/WeeklyReportsPage.tsx`:

```diff
@@ -3,7 +3,7 @@ import { useMutation, useQueryClient } from '@tanstack/react-query';
 import { useSearchParams } from 'react-router';
 import { api, downloadUrl } from '../../api/client';
 import { useWeeklyReports } from '../../api/lists';
-import type { WeeklyReportView } from '../../api/types';
+import type { SendWeeklyReportRequest, WeeklyReportView } from '@terminal-ops/contracts';
 import { ErrorBox } from '../../components/ErrorBox';
 import { MoreButton } from '../../components/MoreButton';
 import { RunningPoller } from '../../components/RunningPoller';
@@ -11,8 +11,6 @@ import { WriteButton } from '../../components/WriteButton';
 import { formatKst, kstToday } from '../../lib/format';
 import { keys } from '../../api/query-keys';
 
-export type { WeeklyReportView };
-
 /** 이만큼 넘게 대기열에 있으면 워커가 안 도는 것을 의심한다(decisions/0038 — 워커가 없으면 job이 waiting에 남는다) */
 export const WORKER_HINT_AFTER_MIN = 10;
 
@@ -57,7 +55,7 @@ export function WeeklyReportsPage() {
   const weekProblem = weekStartProblem(weekStart, maxWeek);
   const list = useWeeklyReports();
   const send = useMutation({
-    mutationFn: (week: string) => api<WeeklyReportView>('/reports/weekly', { method: 'POST', body: { weekStart: week } }),
+    mutationFn: (week: string) => api<WeeklyReportView>('/reports/weekly', { method: 'POST', body: { weekStart: week } satisfies SendWeeklyReportRequest }),
     onSuccess: () => client.invalidateQueries({ queryKey: keys.weeklyReports.all }),
   });
   const items = list.data?.pages.flatMap((p) => p.items) ?? [];
```

- [ ] **Step 4: 통과를 확인한다**

Run: `grep -rn "^interface \|^export interface " src --include=*.tsx --include=*.ts | grep -v "\.test\.\|src/test/"` → `src/api/client.ts:28:export interface RequestOptions {` 한 줄뿐(응답 모양 로컬 타입이 남지 않았다)
Run: `npx tsc --noEmit -p tsconfig.json && echo tsc=0` → `tsc=0`
Run: `npx vitest run 2>&1 | grep -E "Test Files|Tests "` → `Test Files  12 passed (12)`, `Tests  109 passed (109)`
Run: `npm run build 2>&1 | tail -2` → `✓ built in …ms`. `grep -c "terminal-ops/contracts" dist/assets/*.js` → `0`

어긋남이 어드민에서 잡히는지 한 번 본다(되돌리는 것까지): Edit 도구로 `packages/contracts/src/errors.ts`의 `  | 'SCAN_IN_PROGRESS'` 줄을 지우고 `npx tsc --noEmit -p tsconfig.json`
Expected:
```
src/pages/ScanPage.tsx(33,84): error TS2367: This comparison appears to be unintentional because the types 'ErrorCode | null' and '"SCAN_IN_PROGRESS"' have no overlap.
```
(api 쪽은 같은 변경으로 `scan.service.ts` 등이 TS2769 — 여기서는 어드민만 본다) → `git checkout -- ../../packages/contracts/src/errors.ts`로 되돌리고 `git status --short ../../packages` → 출력 없음.

- [ ] **Step 5: 결정 기록 보탬, devlog, 커밋**

`docs/decisions/0048-계약은-반환-타입-implements-enum-단언으로-강제한다.md` 끝에:

```markdown
### 보탬 (Task 3, 어드민)
- 어드민 `src/api/types.ts`(114줄)와 화면 안 로컬 타입 14개를 지우고 모두 `@terminal-ops/contracts`에서 `import type`. 상태 이름표(`TERMINAL_STATUS_LABEL`·`SOURCE_LABEL`·`CARRIER_LABEL`·`TICKET_STATUS_LABEL`·`ROLLOUT_STATUS_LABEL`)는 `Record<유니온, string>`, `ErrorBox`의 안내는 `Partial<Record<ErrorCode, string>>`, `ApiError.code`는 `ErrorCode | null`(서버를 믿는 캐스트 한 곳 — 응답 본문을 `Partial<ApiErrorBody>`로 읽음). 순서가 필요한 짧은 목록(`OUTCOMES`, `OPEN_PO_STATUSES`)은 `as const satisfies readonly 유니온[]` — 없는 값은 잡고 빠진 값은 못 잡는다.
- 보내는 본문은 `satisfies` 요청 타입. 단말기 작업 버튼의 `run()`이 `expectedVersion`을 붙이므로 부르는 곳은 `Omit<요청, 'expectedVersion'>`(`Unversioned<T>`)로 맞춘다. select 값(`e.target.value`)은 이름표 키에서 나오므로 `as Carrier` 캐스트 두 곳.
- 바꾸는 순간 tsc가 테스트 가짜 응답의 어긋남 네 곳을 잡았다. 둘은 서버에 없는 주간 리포트 상태 `'FAILED'`(→ `PENDING`·`GENERATED`), 둘은 상태를 `string`으로 받던 helper. 화면 코드의 어긋남은 없었다.
- 확인한 모습: 계약에서 `'SCAN_IN_PROGRESS'`를 빼면 `ScanPage.tsx`의 비교가 TS2367. 계약의 `'IN_STOCK'`을 바꾸면 `labels.ts`가 TS2353, 가짜 응답들이 TS2322. GET 쿼리(`query: { status: 'IN_STOCK' }`)는 잡히지 않는다(decisions/0049).
```

`docs/devlog/2026-10-27.md` 끝에:

```markdown
## HH:MM Task 3 어드민이 contracts를 쓴다 — types.ts·로컬 타입 지움, 이름표·오류 코드·요청 본문
이전 커밋: <Task 시작 때 git log -1 --format=%h>
- 한 일:
  - admin `file:../../packages/contracts` 의존, `src/api/types.ts` 삭제, 화면 안 로컬 타입 14개 삭제 → 계약 타입
  - 상태 이름표 `Record<유니온, string>`, `ApiError.code`·ErrorBox 안내 `ErrorCode`, 보내는 본문 `satisfies` 요청 타입(단말기 작업·검수·A/S·발주·스캔·VAN·주간 리포트)
  - 테스트 가짜 응답: 주간 리포트 `'FAILED'`(서버에 없는 상태) → `PENDING`·`GENERATED`, 상태 helper 타입
- 확인:
  - 빨강: (Step 2의 tsc 오류 4개)
  - tsc 0, vitest `Test Files 12 passed (12)`, `Tests 109 passed (109)`, build `✓ built`, 번들에 계약 문자열 0
  - 어드민에서 잡히는 모습: (Step 4의 TS2367 한 줄) → 되돌림, `git status` 깨끗
- 막힌 것: (없으면 없음)
- 결정: decisions/0048 보탬(어드민 쪽)
- 다음: Task 4 전체 검증과 마감
```

```bash
cd ../.. && git add apps/admin docs && git status --short && git commit -m "refactor: 어드민이 contracts 타입을 쓴다 — types.ts·화면 로컬 타입 지움, 상태 이름표·오류 코드·요청 본문을 계약에 묶음

Refs: docs/decisions/0048-계약은-반환-타입-implements-enum-단언으로-강제한다.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: devlog 제목 시각을 커밋 시각과 맞춘다**

Task 1 Step 8과 같다.

---

### Task 4: 마감 — 전체 검증, 새로 설치, 실제 저장소에서 어긋남 출력 기록, 기동 확인, README·색인·회고

**Files:**
- Modify: `README.md`, `docs/retrospective.md`, `docs/index.md`(스크립트로), `docs/devlog/2026-10-27.md`(Task 4 항목 + `## 보강 1 요약`)

- [ ] **Step 1: 전체 검증**

시작 전 `tasklist //FI "IMAGENAME eq node.exe" //FO CSV //NH`를 적어 둔다. 테스트 DB를 빈 DB로 다시 만들고 시작한다(안전 규칙의 명령).

Run(`apps/api`):
```bash
npm run typecheck && echo tsc=0
npx vitest run 2>&1 | tee <스크래치패드>/c-final-api.log | grep -E "Test Files|Tests |Duration"; grep -c "Connection is closed" <스크래치패드>/c-final-api.log
npm run build && echo build=0 && grep -rl "terminal-ops/contracts" dist | wc -l
```
Expected: `tsc=0`, `Test Files  66 passed (66)`, `Tests  453 passed (453)`(약 255초), `Connection is closed` 0, `build=0`, `0`

Run(`apps/admin`): `npm run build 2>&1 | tail -2 && npx vitest run 2>&1 | grep -E "Test Files|Tests "`
Expected: `✓ built in …ms`(tsc 포함), `Test Files  12 passed (12)`, `Tests  109 passed (109)`

Run(`apps/partners`·`apps/device-sim` 각각): `npx tsc --noEmit -p tsconfig.json && npx vitest run 2>&1 | grep -E "Test Files|Tests "`
Expected: partners `6 passed (6)`·`53 passed (53)`, device-sim `4 passed (4)`·`40 passed (40)`(이번 보강이 건드리지 않음)

- [ ] **Step 2: 새로 설치해도 연결되는지**

Run(`apps/api`, 그다음 `apps/admin`): `rm -rf node_modules && npm ci --no-audit --no-fund 2>&1 | tail -1 && ls -la node_modules/@terminal-ops/ | tail -1`
Expected: `added 396 packages`(api)·`added 113 packages`(admin) 근처, 마지막 줄 `contracts -> …/packages/contracts`. 그 뒤 api `npm run build && echo build=0`, admin `npm run build 2>&1 | tail -1` 다시 통과.

- [ ] **Step 3: 실제 저장소에서 어긋남이 빌드를 멈추는 것을 기록한다**

Edit 도구로 `packages/contracts/src/terminal.ts`의 첫 번째 `  serialNo: string;`(TerminalView)를 `  serialNumber: string;`로 바꾼다.

Run(`apps/api`): `npm run build 2>&1 | tail -3; echo exit=${PIPESTATUS[0]}`
Expected:
```
src/terminal/terminal.views.ts(10,5): error TS2353: Object literal may only specify known properties, and 'serialNo' does not exist in type 'TerminalView'.
exit=2
```
Run(`apps/admin`): `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"` → `15`(사전 검증 값. 어드민은 `serialNo`를 읽는 곳마다 실패 — 나온 숫자를 devlog에 적는다)

**되돌린다**: `git checkout -- packages/contracts/src/terminal.ts`(저장소 루트), `git status --short` → 출력 없음, api `npm run build && echo build=0` → `build=0`. 이 출력(두 줄과 어드민 오류 수)을 devlog에 그대로 남긴다.

- [ ] **Step 4: 빌드한 api가 뜨고 응답하는지(테스트 DB, 읽기만)**

Step 1의 api 테스트가 테스트 DB에 표를 만들어 두었다(아직 지우지 않는다). 포트 3100이 비어 있는지(`netstat -ano | grep -E ':3100 .*LISTENING'` 없음) 본 뒤, Git Bash에서 `apps/api`에 서서 `node`를 **단독 명령으로** 백그라운드로 띄운다(안전 규칙 — `cd … && node … &`로 묶지 않는다):

```bash
MYSQL_DATABASE=terminal_ops_test API_PORT=3100 RUN_WORKERS=0 RUN_SCHEDULERS=0 QUEUE_PREFIX=contracts-check node dist/main.js > <스크래치패드>/c-boot.log 2>&1 &
n=0; until curl -sf -o /dev/null http://127.0.0.1:3100/health; do sleep 0.5; n=$((n+1)); [ $n -gt 60 ] && { echo "안 뜸"; break; }; done
for p in /health "/terminals?size=1" /anomaly-rules /terminal-models "/sync-runs?limit=1"; do curl -s -m 5 "http://127.0.0.1:3100$p" | cut -c1-160; echo; done
WPID=$(netstat -ano | grep -E ':3100 .*LISTENING' | awk '{print $5}' | head -1); tasklist //FI "PID eq $WPID" | tail -1; taskkill //PID $WPID //F
netstat -ano | grep -E ':3100 .*LISTENING'; tail -1 <스크래치패드>/c-boot.log
```
Expected: `{"status":"ok"}`, `{"items":[…],"total":…,"page":1,"size":1}`, 규칙 6개 배열(`"rule":"DELIVERED_NOT_INSTALLED","label":"배송 완료 후 미설치","days":7` …), 모델 3개, `{"items":[…],"nextBeforeId":…}`. `tasklist` 줄이 `node.exe <WPID>`, 끈 뒤 netstat 출력 없음, 로그 끝 `terminal-ops api listening on http://localhost:3100 (workers=false, schedulers=false, queuePrefix=contracts-check)`.

확인용 Redis 키를 지운다(`FLUSH` 금지, 본 키만):
```bash
MSYS_NO_PATHCONV=1 docker exec terminal-ops-redis redis-cli --scan --pattern 'contracts-check*'
```
Expected: `contracts-check:<큐>:meta` 6개 → 그 이름 그대로 `MSYS_NO_PATHCONV=1 docker exec terminal-ops-redis redis-cli DEL <키1> … <키6>` → `(integer) 6`, 다시 scan → 출력 없음.

끝나면 테스트 DB를 빈 DB로 다시 만든다(안전 규칙의 명령). `tasklist //FI "IMAGENAME eq node.exe" //FO CSV //NH`가 시작 때와 같은지 본다.

- [ ] **Step 5: README, 회고, 기록 색인**

`README.md`(숫자가 Step 1과 다르면 그 숫자로 — 결정 수도 실제 파일 수로):

````diff
@@ -22,6 +22,8 @@ terminal-ops/
 │  ├─ admin/             React 19 + Vite 8 + TanStack Query 어드민(Vite 프록시 /api → api)
 │  ├─ partners/          가상 업체 서버(node:http, 포트 4010): 세움전자·번개택배·느림보물류·브릿지VAN·톡톡메신저
 │  └─ device-sim/        단말기 시뮬레이터(하트비트, 펌웨어 업데이트 결과 보고)
+├─ packages/
+│  └─ contracts/         api·어드민이 함께 보는 HTTP 계약(응답·요청 모양, 상태 값, 오류 코드). 타입만, 각 앱이 file: 의존
 ├─ infra/                MySQL 초기화(테스트 DB), 미리보기 env
 ├─ scripts/              기록 색인 생성
 └─ docs/                 기록(아래 "기록")
@@ -34,7 +36,7 @@ Node 24, Docker Desktop(WSL2)이 필요하다. 명령은 Git Bash 기준.
 ```bash
 cp .env.example .env                 # 로컬 개발 전용 값
 docker compose up -d --wait          # MySQL·Redis, healthcheck가 healthy가 될 때까지 기다린다(첫 실행은 MySQL 초기화에 수십 초)
-for a in api admin partners device-sim; do (cd apps/$a && npm ci); done
+for a in api admin partners device-sim; do (cd apps/$a && npm ci); done   # api·admin은 packages/contracts를 링크한다(따로 설치하지 않는다)
 cd apps/api && npm run db:migrate && npm run db:seed && cd ../..   # 개발 DB 스키마와 기준 데이터(모델·가맹점·검수 항목)
 
 # 터미널 네 개(또는 백그라운드 — 끌 때는 PID로)
@@ -46,6 +48,7 @@ cd apps/api && npm run db:migrate && npm run db:seed && cd ../..   # 개발 DB 
 
 - 워커 프로세스를 띄우는 실험(0005·0014)은 먼저 `cd apps/api && npm run build` — `dist/worker.js`를 자식 프로세스로 띄우므로, 빌드하지 않으면 멈추고("먼저 npm run build 하세요"), 소스만 고치고 빌드를 잊으면 옛 워커로 잰다(경고 없음).
 - 테스트: 각 앱 폴더에서 `npm test`. api 테스트는 테스트 DB(`terminal_ops_test`)와 Redis 테스트 접두사(`test-`)만 쓰고, 가상 업체 서버를 테스트 포트(4011)에 직접 띄운다 — api 테스트를 두 개 동시에 돌리지 않는다. 실험은 `EXPERIMENTS=1 npx vitest run test/experiments/<파일> --silent=false`.
+- 타입 검사: vitest는 타입을 보지 않는다. api `npm run typecheck`(또는 `npm run build`), admin `npm run build`(tsc 포함) — api·어드민이 `packages/contracts`와 어긋나면 여기서 실패한다([decisions/0048](docs/decisions/0048-계약은-반환-타입-implements-enum-단언으로-강제한다.md)).
 - 미리보기(화면 확인)는 `infra/preview.env`(주기 작업을 등록하지 않음)를 저장소 `.env` 뒤에 읽는다. 띄우기 전 점검(빌드, 남은 주기 작업 `npm run scheduler:clear`, 같은 접두사의 다른 워커)은 그 파일 주석에 있다.
 - 주기 작업은 Redis에 남는다(BullMQ job scheduler). 지우려면 `cd apps/api && npm run scheduler:clear`(이 접두사의 주기 작업만 — Redis 전체를 비우지 않는다).
 
@@ -67,6 +70,7 @@ cd apps/api && npm run db:migrate && npm run db:seed && cd ../..   # 개발 DB 
 | F12 | 택배사 어댑터(JSON·XML → 같은 이벤트) | `apps/api/src/carrier/` |
 | F13 | 검수 체크리스트와 불합격 통계 | `apps/api/src/inspection/` |
 | 어드민 | 처음 화면(운영 현황), 단말기 목록·상세, 박스 스캔, A/S, 펌웨어 배포, 이상·VAN·입고 대조·주간 리포트, 배치 실행 이력 | `apps/admin/src/pages/` |
+| 공유 타입(보강 1) | api 응답·요청 모양·상태 값·오류 코드를 한 곳에. api가 어기면 tsc 실패(view 반환 타입, DTO implements, enum ↔ 유니온 단언), 어드민은 그 타입을 import | `packages/contracts/`, `apps/api/src/common/contract-assertions.ts`, `apps/api/test/unit/contract-drift.spec.ts` |
 
 ## 실험 결과
 
@@ -109,18 +113,18 @@ cd apps/api && npm run db:migrate && npm run db:seed && cd ../..   # 개발 DB 
 
 이 프로젝트의 산출물은 코드와 기록이다(규칙 `CLAUDE.md`, 양식 `docs/README.md`).
 
-- 기록 색인(제목 목록): [`docs/index.md`](docs/index.md) — 결정 46·트러블슈팅 28·실험 16 (`node scripts/docs-index.mjs`로 만든다)
+- 기록 색인(제목 목록): [`docs/index.md`](docs/index.md) — 결정 49·트러블슈팅 28·실험 16 (`node scripts/docs-index.mjs`로 만든다)
 - 개발일지: [`docs/devlog/`](docs/devlog/)(날짜별, 날마다 "N일차 요약"), 설계 스펙 [`docs/specs/`](docs/specs/), 구현 계획 [`docs/plans/`](docs/plans/), 날마다의 최종 리뷰 [`docs/reviews/`](docs/reviews/)
-- 7일 회고: [`docs/retrospective.md`](docs/retrospective.md) — 날별로 만든 것, 잘 된 것·안 된 것, 반복된 실수, 면접에서 말할 거리, 남은 이월
+- 7일 회고: [`docs/retrospective.md`](docs/retrospective.md) — 날별로 만든 것, 잘 된 것·안 된 것, 반복된 실수, 면접에서 말할 거리, 남은 이월과 그 뒤 보강
 - 공부거리: [`docs/study/backlog.md`](docs/study/backlog.md)
 
 ## 테스트
 
-(Day 7, 실험 0016과 리뷰 반영 뒤 실제로 돌려 센 값. api는 실험 파일 제외 — 실험은 `EXPERIMENTS=1`에서만 돈다)
+(보강 1 공유 타입 패키지 뒤 실제로 돌려 센 값. api는 실험 파일 제외 — 실험은 `EXPERIMENTS=1`에서만 돈다)
 
 | 앱 | 파일 | 테스트 |
 |---|---|---|
-| api(실험 제외) | 65 | 446 |
-| admin | 12 | 108 |
+| api(실험 제외) | 66 | 453 |
+| admin | 12 | 109 |
 | partners | 6 | 53 |
 | device-sim | 4 | 40 |
````

`docs/retrospective.md` 6장 끝에:

```diff
@@ -82,3 +82,8 @@ devlog 2026-10-27 "최종 리뷰 반영 정리"의 "Day 7로 넘긴 것"과 [Day
   - 주기 작업 경로(scheduler → processor → `requeueStale()`)를 지나는 테스트가 없다. e2e·실험 0014는 `requeueStale({ staleMs: 0, … })`을 직접 부르고 `scheduler.e2e`는 등록 개수만 센다. job 이름 `requeue`가 processor 분기에 닿는지, 기본값(60초·limit 100)으로 도는지는 검증되지 않았다
   - `scripts/docs-index.mjs`가 번호 중복(같은 0042 두 파일)과 빈 번호를 잡지 않는다. `--check`가 "최신"이어도 번호 충돌은 지나간다
   - (반영함) 첫 조회 중 새로고침 실패, `.env.example` 세 개, README 빌드 전제, 표 기준 표시는 리뷰 반영 커밋에서 고쳤다
+
+### 7일 뒤 보강
+
+- [x] **보강 1: api·어드민 공유 타입 패키지** — Day 6·7 리뷰에서 응답 필드를 사람이 대조하던 것을 컴파일러가 하게 했다. `packages/contracts`(타입만, 각 앱 `file:` 의존 — [decisions/0047](decisions/0047-공유-타입은-file-의존-타입-전용-TS-소스-패키지로.md)), view 반환 타입·DTO implements·enum ↔ 유니온 단언·`BusinessError` 오버로드([0048](decisions/0048-계약은-반환-타입-implements-enum-단언으로-강제한다.md)), 범위는 응답·쓰기 요청 본문·오류 코드([0049](decisions/0049-계약-범위는-응답-요청-본문-오류-코드까지.md)). 어드민 `types.ts`와 화면 로컬 타입 14개를 지웠고, 바꾸는 순간 테스트 가짜 응답의 없는 상태 값(`'FAILED'`)이 드러났다. 기록: devlog 2026-10-27 `# 보강 1`, [계획](plans/2026-10-27-shared-contracts.md)
+  - 보강 1이 남긴 것: GET 쿼리 문자열은 계약 밖(어드민 `Query` 자유 형식), `npm test`만으로는 계약 어긋남이 보이지 않음(`typecheck`·`build`를 따로 — CI가 생기면 묶기), 런타임 응답 검증 없음
```

Run(저장소 루트): `node scripts/docs-index.mjs && node scripts/docs-index.mjs --check`
Expected: `docs/index.md`에 `## 결정 기록 (49)`와 0047·0048·0049 세 줄이 더해지고 `--check`가 `docs/index.md 최신`. (troubleshooting을 새로 썼다면 그 수도 README에 맞춘다.)

- [ ] **Step 6: devlog와 커밋**

`docs/devlog/2026-10-27.md` 끝에 Task 4 항목(형식은 앞 Task와 같다 — 한 일: Step 1~5, 확인: Step 1 숫자·Step 2 링크·Step 3 출력 그대로·Step 4 응답과 끈 PID·지운 키 수, 다음: 최종 리뷰)과, 그 뒤에 요약:

```markdown
## 보강 1 요약

**한 일**: api·어드민이 함께 보는 HTTP 계약을 `packages/contracts`(타입만)에 두고, api가 어기면 tsc가 실패하게 했다. 어드민의 `types.ts`와 화면 로컬 타입 14개를 지웠다.

**커밋**(오래된 것부터 — `git log --oneline 5d6a870..HEAD`로 채운다)

**결정**(decisions/0047~0049)
- 0047 연결은 각 앱 `file:` 의존 + 타입 전용 TS 소스 패키지(workspaces는 잠긴 버전 43개 변경, `.d.ts`는 `skipLibCheck`로 오타가 조용히 any, `paths`는 TS6059, OpenAPI는 반환값 검사가 여전히 없음)
- 0048 반환 타입·DTO implements·enum ↔ 유니온 양방향 단언·`BusinessError` 상태별 오버로드, 증명은 컴파일러 API 테스트
- 0049 범위는 응답·쓰기 요청 본문·오류 코드, 쿼리 문자열·런타임 검증은 밖

**숫자**: api 65/446 → 66/453, admin 12/109(README의 108을 실제 값으로), partners 6/53, device-sim 4/40

**찾은 것**: 테스트 가짜 응답의 주간 리포트 상태 `'FAILED'`(서버에 없음)

**남은 것**: [retrospective.md 6장 "7일 뒤 보강"](../retrospective.md)
```

```bash
git add README.md docs && git status --short && git commit -m "docs: 보강 1 마감 — 전체 검증, 어긋남 빌드 출력 기록, README·색인·회고

Refs: docs/decisions/0047-공유-타입은-file-의존-타입-전용-TS-소스-패키지로.md, docs/decisions/0048-계약은-반환-타입-implements-enum-단언으로-강제한다.md, docs/decisions/0049-계약-범위는-응답-요청-본문-오류-코드까지.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: devlog 제목 시각을 커밋 시각과 맞춘다**

Task 1 Step 8과 같다. 마지막으로 `netstat -ano | grep -E ':(3000|3100|4010|4011|5173) .*LISTENING'` 출력 없음, `git status --short` 출력 없음을 확인한다. 브랜치는 병합·push하지 않는다(컨트롤러가 정한다).

---

## 자체 점검

- 스펙 대응: 스펙 3.1 → Task 1(0047), 3.2 → Task 1(단언·오류 코드·drift 테스트)·Task 2(반환 타입·implements)·Task 3(어드민), 3.3 → Task 2(0049), 4장 → Task 3, 5장 → Task 1·2·3의 통과 확인 + Task 4, 6장 위험 → 0048·0049 "결과·대가"와 회고 "보강 1이 남긴 것".
- 이름 일치: 계약 타입 이름(`TerminalView`, `TerminalDetail`, `TerminalPage`, `HistoryView`, `ConnectivityView`, `InspectionRecord`, `InspectionItemView`, `MerchantView`, `TerminalModelView`, `BeforeIdPage`, `WeeklyReportView`, `DashboardView`)은 어드민 `types.ts`의 이름을 그대로 써서 어드민 import 치환이 한 줄로 끝난다. 새 이름: `AfterIdPage`, `OffsetPage`, `AnomalyScanSummary`(어드민 `ScanSummary`), `PurchaseOrderReconciliation`(어드민 `Reconciliation`), `ScanView`(어드민 `ScanResultView`), `VanRunDetail`(어드민 `RunWithItems`), `ClosedPurchaseOrder`, `CreatedShipmentView`, `InspectResult`, `WeeklyReportPage`, `HealthView`, 요청 `*Request` 13가지, `InspectionResultInput`.
- 런타임 영향 없음: 모든 계약 import는 `import type`·`export type`. api `dist`와 admin 번들에 `terminal-ops/contracts` 문자열 0(Task 1·2·3·4에서 매번 확인). 엔티티 메타데이터 변화 없음(`SyncRun.outcome`은 `String` 그대로).
- 숫자를 실행 때 채우는 곳: 각 Task의 devlog `Duration …s`, Task 4 Step 3의 어드민 오류 수(사전 검증 15), Task 4 Step 5의 README 숫자(Step 1 결과로).
- 코드 블록은 모두 사전 검증 저장소의 Task별 커밋에서 그대로 뽑았다(전체 파일 = `git show <커밋>:<경로>`, diff = `git diff <앞 커밋> <커밋> -- <경로>`). 커밋: Task 1 `t1`, Task 2 `t2`, Task 3 `t3`, Task 4 문서 `t4`(임시 폴더 `contractscheck`).
