# 보강 6 — 운영 관제 화면 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **기록 규칙 필수**: 이 저장소의 `CLAUDE.md`를 먼저 읽는다. 모든 Task는 마지막에 `docs/devlog/2026-10-29.md`(`# 보강 6: 운영 관제 화면` 아래, `## HH:MM 보강 6 계획 작성` 항목 뒤)에 항목을 덧붙이고(제목 시각 = 커밋 시각, 제목 끝에 `(커밋 = 이 항목이 든 커밋)`, 본문 첫 줄 `이전 커밋:`, 한 일·확인·막힌 것·결정·다음), Task에 적힌 결정 기록을 쓴 뒤 `node scripts/docs-index.mjs`로 색인을 다시 만들어 **코드와 같은 커밋**에 넣는다. 작업 중 날짜가 바뀌면 그날 날짜로 새 파일 `docs/devlog/YYYY-MM-DD.md`를 시작하고 첫 줄에 이전 파일을 링크한다. 예상과 다른 에러를 만나면 고치기 전에 `docs/troubleshooting/`에 기록을 시작한다(다음 번호 0033). 이 계획은 실험을 쓰지 않는다(다음 번호 0018). 결정 번호는 0070~0076을 쓴다.

**Goal:** 관제(MONITOR)·개발자가 큐·주기 작업·워커·Outbox·업무 오류를 한 화면에서 보고, 실패한 job을 다시 시도·지우고 멈춘 Outbox를 복구하는 운영 관제 화면(`apps/console`, :5176)과 그 API(`/ops`)를 만든다. 관제 작업은 감사 기록으로 남는다.

**Architecture:** api에 `src/ops/` 모듈 하나 — 읽기 다섯(`GET /ops/queues·schedulers·system·outbox·errors`)은 BullMQ(`getJobCounts`·`getMetrics`·`getWorkers`·`getJobSchedulers`)와 MySQL을 그때그때 읽고(캐시 없음, decisions/0070), 최근 업무 오류는 새 표 없이 기존 기록 넷을 합친다. 모든 `@Processor`에 워커 이름(`WORKER_NAME`)과 분 단위 metrics를 켜서 워커 생존·처리량을 Redis에서 본다(decisions/0071). 실패 job은 Redis에 남은 것만, data는 이름으로 가리고, 다시 시도는 시도 수를 되돌린다(decisions/0072). 관제 작업(다시 시도·지우기·복구 sweep)은 MONITOR만, 새 표 `ops_action_log`에 남긴다(decisions/0073). 화면은 별도 앱 `apps/console`(decisions/0074) — 점주 앱 사본 9개 + 사본 검사(decisions/0075), 읽기 쿼리마다 10초 자동 새로고침·탭 숨김이면 멈춤·끄기 단추(decisions/0076). 설계 스펙: `docs/specs/2026-10-29-ops-console.md`.

**Tech Stack:** api Nest.js 12.2(ESM, NodeNext, vitest 5 + swc), MikroORM 7.2(MySQL 8.4), BullMQ 6.4.0(`@nestjs/bullmq` 12), TypeScript 6.0.3. console React 19.3 + Vite 8.3.4 + TanStack Query 5.104.2 + react-router 8.4, Vitest 5.0.4 + Testing Library + jsdom(현장 앱과 같은 판·같은 lock). **새 외부 의존성 없음.**

---

## 프로세스·데이터 안전 규칙 (모든 Task에 적용)

- **프로세스는 PID로만 끈다.** `taskkill /IM node.exe`, `pkill node`처럼 이름으로 끄지 않는다. 서버는 `node …` 단독 명령으로 띄우고 `netstat -ano | grep ':<포트> .*LISTENING'`으로 찾은 Windows PID(그 node 프로세스 자신 — Git Bash 서브셸의 `$!`가 아니다)를 `taskkill //PID <PID> //F`로 끈다. 끄기 전에 `tasklist //FI "PID eq <PID>" //FO CSV //NH`로 node.exe인지 본다. 포트가 없는 워커 프로세스는 `wmic process where "name='node.exe'" get ProcessId,CommandLine`으로 `dist/worker.js`가 든 줄의 PID를 찾는다.
- **Redis를 통째로 지우지 않는다.** `FLUSHALL`·`FLUSHDB` 금지. api 테스트는 파일마다 `test-<pid>-<시각>` 접두사만 쓴다. api를 직접 띄우는 확인은 `QUEUE_PREFIX=opsx-live`를 주고, 끝나면 `docker exec terminal-ops-redis redis-cli --scan --pattern 'opsx-live*'`로 본 키만 하나씩 `DEL`한다.
- **테스트는 테스트 DB(`terminal_ops_test`)에서만.** 개발 DB(`terminal_ops`)는 마이그레이션 만들기(Task 2 `db:migration:create` — 스냅샷과 엔티티를 비교, 쓰지 않는다)와 마지막 적용(`db:migrate`, Task 5)·`db:migration:check`만 한다. 실서버 쓰기 확인은 테스트 DB로 띄운 api에서. 테스트 DB를 다시 만드는 명령(셸 없이 한 줄, root 비밀번호는 `.env`에서 변수로 읽고 **출력하지 않는다**):
  ```bash
  PW=$(grep '^MYSQL_ROOT_PASSWORD=' .env | cut -d= -f2- | tr -d '\r')
  MSYS_NO_PATHCONV=1 docker exec -e MYSQL_PWD="$PW" terminal-ops-mysql mysql -uroot -e "DROP DATABASE IF EXISTS terminal_ops_test; CREATE DATABASE terminal_ops_test"
  ```
  브랜치를 오가며 같은 테스트 DB를 쓰면 먼저 이 명령으로 다시 만든다(troubleshooting/0030). Task 5가 끝나면 빈 DB로 남긴다.
- **api 테스트를 두 개 동시에 돌리지 않는다**(globalSetup이 partners를 테스트 포트 4011에 띄운다). api 테스트가 도는 동안 같은 폴더의 api 소스를 고치지 않는다(파일마다 소스를 새로 읽어 섞인 결과가 나온다 — 사전 검증에서 겪음). admin·merchant·field·console 테스트는 같이 돌려도 된다.
- **오래 도는 서버·백그라운드 명령을 남긴 채 끝내지 않는다.** 끝나면 `netstat -ano | grep -E ':(3000|3200|4010|4011|5173|5174|5175|5176|5276|4176) .*LISTENING'` 출력이 없고 `tasklist //FI "IMAGENAME eq node.exe" //FO CSV //NH`가 시작 전과 같은 PID만 보여야 한다.
- **긴 기록·코드 편집은 Write·Edit 도구로 한다**(troubleshooting/0024). python3은 쓰지 않는다(이 PC에서 멈춘다).
- **시연 계정 비밀번호는 `apps/api/src/db/seed-accounts.ts`에만 있다.** 명령에 넣을 때는 그 파일에서 읽어 임시 파일로만 쓰고(Task 5 스크립트), devlog·리뷰 보고·화면 캡처 설명에 옮겨 적지 않는다.
- **localhost 쿠키는 포트를 가리지 않는다**(보강 3 기록): 어드민(:5173)·점주(:5174)·현장(:5175)·관제(:5176)가 `sid` 하나를 함께 쓴다. 다른 화면에서 로그인하면 이 화면의 세션이 끝난다. 브라우저로 볼 때는 프로필을 나누거나 차례로 본다.
- **커밋 파일은 LF.** 저장소는 `core.autocrlf=true`라 작업 폴더의 CRLF는 커밋 때 LF가 된다. 커밋 전 `git diff --cached --stat`·`git ls-files --eol <새 파일>`이 `i/lf`인지 본다.

## 사전 검증으로 확인된 사실 (2026-10-29, 임시 폴더)

계획 작성 전에 저장소(브랜치 `ops-console`, master 10a3f6c)를 임시 폴더에 복제해 api·partners·device-sim·admin·merchant·field·console을 `npm ci`로 설치하고, 이 계획의 코드를 Task 순서대로 적용해 Task 1~4를 하나씩 커밋하며 돌렸다(테스트 DB `terminal_ops_test`, Redis는 테스트 접두사와 확인용 접두사 `opsx-live`만). 코드 블록은 모두 그 커밋에서 스크립트로 뽑았다(새 파일 = `git show <커밋>:<경로>`, 바꾼 파일 = `git diff <앞 커밋> <커밋> -- <경로>`). Task마다 "실패 확인" 출력은 앞 커밋에 그 Task의 테스트 파일만 얹어 돌린 원문 요약이다.

- **테스트 수(실제로 돌려 센 값)**: api master 83/571(330.78초) → Task 1 **86/584**(335.82초) → Task 2 **88/593**(350.55초, Task 4 커밋에서 다시 88/593·346.90초), 모두 `Connection is closed` 0, typecheck 0. console Task 3 **5/33** → Task 4 **8/48**(세 번 같음, tsc·build 성공). admin 19/163 그대로(관제 주소 기대값 넷만 바꿈, build 성공). merchant 7/47·field 7/60 그대로(contracts가 늘고 점주 머리 주석이 바뀐 뒤 tsc·build 성공, 현장 사본 검사 그대로). device-sim 5/46(tsc 0)·partners 6/53 그대로. 엔드포인트 72 → 77 → 82(접근 표 테스트가 센 값).
- **기존 테스트에서 고친 곳**: 접근 표(`access-table.spec.ts`)에 열 줄, 어드민 `apps.test.ts`의 `ops` 기대값 셋(null → `http://localhost:5176`)과 `Layout.test.tsx`의 "다른 화면" 테스트 하나(링크 2 → 3, 준비 중 넷 → 셋). 나머지는 새 파일이다.
- **BullMQ 6.4.0 사전 확인(테스트 접두사, 끝나고 키를 하나씩 지움)**: 큐를 `pause()`해도 job은 `waiting`으로 세고 `paused` 수는 늘 0이다(멈춤은 `isPaused()`로 본다). `getJobs(['waiting'], 0, 0, true)`의 첫 칸이 가장 오래 기다린 job이다. 이름을 준 워커는 `getWorkers()`에 `rawname: '<접두사>:<큐 base64>:w:<이름>'`으로 나오고, 닫으면 0. `metrics`를 켠 워커에서 막 끝난 job 2개는 `getMetrics` `data: []`·`meta.count 2`(마지막 갱신 분의 수는 count − prevCount). 실패 job 다시 시도는 `resetAttemptsMade`·`resetAttemptsStarted` 없이는 한 번만 더 돌고 끝났고(attemptsMade 2 → 3), 주면 attempts를 다시 다 돌았다. 완료된 job을 `retry`하면 `Job 3 is not in the failed state. reprocessJob`. `getJobSchedulers(0, -1, true)`는 등록된 것마다 `key`·`every` 또는 `pattern`·`tz`·`next`를 준다.
- **`findOne(Entity, {})`는 MikroORM이 거절한다**(`validateEmptyWhere`) — 최근 오류의 "가장 큰 수집 기록 id"를 처음에 `findOne(SyncRun, {}, …)`로 읽자 `/ops/errors`가 500이었다 → `find(…, { limit: 1 })`(계획 코드에 반영됨, 주석 있음).
- **자동 새로고침 테스트가 실제로 잡는지 확인**: 대시보드 큐 쿼리에 `refetchIntervalInBackground: true`를 넣자 "탭이 안 보이면 간격 읽기를 건너뛴다" 테스트가 실패했다(되돌려 통과). 테스트는 `focusManager.setFocused(false)`로 탭 숨김을 흉내 내고 40ms 간격·실제 시계로 센다.
- **api 테스트가 도는 중에 그 폴더의 api 소스를 고치면 결과가 섞인다** — 사전 검증 첫 전체 실행이 이 때문에 버려졌다(파일마다 소스를 새로 읽는다). 깨끗한 복제본에서 다시 쟀다.
- **실서버 확인(테스트 DB에 `migrate up` + `seed`, api `API_PORT=3200 RUN_WORKERS=0 RUN_SCHEDULERS=0`, 워커 프로세스 `WORKER_NAME=opsx-worker RUN_SCHEDULERS=1`, 둘 다 `QUEUE_PREFIX=opsx-live PARTNERS_URL=http://localhost:4019`, 관제 개발 서버 `CONSOLE_API_URL=http://localhost:3200 … --port 5276`, 모두 관제 프록시로)**: index `<title>단말온 운영 관제</title>`, 로그인 없이 `/api/ops/queues` 401, health 200, 관제 로그인 200. 큐 여섯 모두 워커 1(워커 프로세스 하나), 기동 직후 최근 15분 완료 carrier-sweep 1·outbox 10·device 8(주기 작업 job), 프로세스 `workerNames ["opsx-worker"]`·api `runWorkers false`, 주기 작업 열 개 모두 "등록", Outbox 0. report 큐에 처리기가 모르는 이름의 job(`apiToken` 값을 data에 넣음)을 넣자 실패 목록 1건 — data `{"runId":1,"apiToken":"[가림]"}`, 응답에 원래 값 0번, 이유 `모르는 report job: opsx-unknown`, 시도 `1/1`. 다시 시도 200(작업 기록 #1) → 다시 실패(처리기가 여전히 모름, 시도 1), 지우기 200(#2), 다시 지우기 404, 복구 sweep 200(`checked 0`, #3), 작업 기록 셋(최근부터 REQUEUE_OUTBOX·REMOVE_JOB·RETRY_JOB, `monitor(MONITOR)`), report 최근 15분 실패 2, 로그아웃 204 뒤 401. 세 프로세스를 PID로 끈 뒤 3200·5276 LISTENING 0, node PID는 시작 전 넷 그대로. 확인용 Redis 키 48개를 하나씩 DEL, 테스트 DB는 빈 DB로 다시 만들었다. api·워커 로그에 ERROR 0.

## 범위 조정 (브리프와 다르게 한 것과 이유)

- **이상 단말기 찾기는 최근 오류에 없다** — 실행 기록 표가 없다(Redis 잠금만, decisions/0034). 새 표를 만들지 않고 빼고, 스펙 범위 밖에 적는다.
- **워커 생존은 하트비트 키가 아니라 BullMQ 워커 연결**(`getWorkers` — Redis CLIENT LIST, decisions/0071). 처리량은 "가능하면"이던 것을 워커 metrics(분 단위)로 채웠다 — `@Processor` 다섯 곳에 옵션 한 줄씩이 든다.
- **실패 job 목록은 Redis에 남은 것만** — 알림·택배 추적·주간 리포트 수동 보내기 job은 `removeOnFail: true`라 실패해도 Redis에 없다. 그 실패는 업무 기록(최근 오류)으로 본다(decisions/0072). 남는 것은 주기 작업 job(`removeOnFail: 100`)과 VAN 대조 job이다.
- **관제 작업은 MONITOR만**(브리프대로) — ADMIN은 보기만(화면은 단추 대신 안내). 운영자는 관제 화면을 쓰지 않는다(403).
- **화면 메뉴는 다섯**(대시보드·실패 job·주기 작업·최근 오류·작업 기록) — Outbox 카드와 복구 단추, 상태 카드는 대시보드 안에 둔다.
- **launch.json은 커밋하지 않는다** — 저장소 `.claude/launch.json`은 `.gitignore`에 있다(이 PC 전용, decisions/0041). 두 파일(세션 루트 `C:\Devhyun\History\.claude\launch.json`, 저장소 `.claude/launch.json`)에 같은 구성을 Edit로 더한다(Task 3).

## 파일 구조

```
terminal-ops/
├─ packages/contracts/src/ops.ts (새), index.ts, errors.ts(JOB_NOT_FAILED)                                   (Task 1·2)
├─ apps/api/
│  ├─ src/ops/ops.module.ts·ops.controller.ts (새, Task 1 → 2)
│  ├─ src/ops/ops-queues.service.ts·queue-metrics.ts·ops-outbox.service.ts·ops-errors.service.ts (새)      (Task 1, ops-queues·ops-outbox는 Task 2에서 더함)
│  ├─ src/ops/job-data.ts·ops-jobs.service.ts·ops-audit.service.ts·ops-action-log.entity.ts (새)           (Task 2)
│  ├─ src/queue/worker-options.ts (새), 프로세서 다섯(carrier-sync·outbox·device·report), app.module.ts, config/env.ts, auth/access.ts, common/contract-assertions.ts   (Task 1)
│  ├─ src/entities.ts, src/migrations/Migration<시각>.ts (생성), .snapshot-terminal_ops.json                (Task 2)
│  └─ test/ops-status.e2e.spec.ts·ops-outbox-errors.e2e.spec.ts·unit/queue-metrics.spec.ts (Task 1), ops-jobs.e2e.spec.ts·unit/job-data.spec.ts (Task 2), unit/access-table.spec.ts (둘 다)
├─ apps/console/ (새)
│  ├─ package.json·package-lock.json·tsconfig.json·vite.config.ts·index.html, src/ 사본 9개(현장 앱에서 cp), copies.test.ts   (Task 3)
│  ├─ src/App.tsx·styles.css·lib/refresh.ts·api/query-keys.ts·components/(AuthGate·Shell·ErrorBox·Freshness)·pages/(LoginPage·DashboardPage), test/(render·fixtures)   (Task 3)
│  └─ src/lib/labels.ts·pages/(FailedJobsPage·SchedulersPage·ErrorsPage·ActionsPage), DashboardPage 복구 단추   (Task 4)
├─ apps/admin/src/apps.ts·apps.test.ts·components/Layout.test.tsx (관제 주소)                                (Task 3)
└─ docs/
   ├─ decisions/0070·0071·0052 보탬 (Task 1), 0072·0073·0052 보탬 (Task 2), 0074·0075·0076·0062·0067 보탬 (Task 3), 0076 보탬 (Task 4)
   ├─ devlog/2026-10-29.md, index.md(스크립트), study/backlog.md
   └─ README.md, retrospective.md (Task 5)
```

## Task 순서

| Task | 내용 | 앱 | 기록 | 테스트 수(끝) | 추천 모델 |
|---|---|---|---|---|---|
| 1 | 관제 읽기 API — 큐 요약·주기 작업·프로세스 상태·Outbox 요약·최근 오류, 워커 이름·metrics, contracts, 접근 표 72 → 77 | contracts, api | decisions 0070·0071, 0052 보탬 | api 86/584 | opus(BullMQ metrics 해석·워커 옵션이 모든 프로세서에 닿음) |
| 2 | 관제 작업 API — 실패 job 목록(data 가리기)·다시 시도·지우기, Outbox 복구 sweep, 감사 기록 표·`GET /ops/actions`, 접근 표 77 → 82 | contracts, api | decisions 0072·0073, 0052 보탬 | api 88/593 | opus(경쟁 조건 409·마이그레이션) |
| 3 | 관제 앱 골격 — 점주 사본 9개 + 사본 검사, 로그인 문·틀·대시보드(상태·큐·Outbox)·자동 새로고침, 어드민 관제 주소, launch.json | console, admin | decisions 0074·0075·0076, 0062·0067 보탬 | console 5/33, admin 19/163 | sonnet |
| 4 | 관제 화면 — 실패 job(다시 시도·지우기·확인창·409 안내), 주기 작업, 최근 오류, 작업 기록, 복구 sweep 단추 | console | 0076 보탬 | console 8/48 | sonnet |
| 5 | 마감 — 전체 검증, 개발 DB 마이그레이션, 실서버 확인(테스트 DB api + 워커 + 관제 프록시), README·회고·색인 | 전체·docs | 요약 | 최종 확인 | sonnet |

의존: 차례대로 한다. Task 2는 Task 1의 `OpsQueuesService`·컨트롤러·contracts를 넓힌다. Task 3·4의 화면은 Task 1·2의 contracts 타입(`Ops*`)과 오류 코드 `JOB_NOT_FAILED`를 쓴다(화면 테스트는 가짜 fetch라 api를 띄우지 않는다). 각 Task 끝의 테스트 수가 위 표와 다르면 멈추고 원인을 적는다.

## 커밋 규칙(보강 6)

범위는 `ops`로 쓴다: `type(ops): 요약`. 기존 기능을 함께 바꾸면 그 ID를 붙인다(워커 옵션 — `ops, F3`처럼 하지 않고 `ops`만: 모든 프로세서에 같은 옵션). Outbox 복구 sweep — `ops, F5`. 본문에 `Refs: <기록 경로>`, 마지막 줄 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. git 작성자 설정은 바꾸지 않는다(decisions/0065). 이 규칙은 Task 1 devlog 항목에 한 줄로 적는다.

---

### Task 1: 관제 읽기 API — 큐 요약·주기 작업·프로세스 상태·Outbox 요약·최근 오류, 워커 이름·metrics

**Files:**
- Create: `packages/contracts/src/ops.ts`; Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/queue/worker-options.ts`, `apps/api/src/ops/queue-metrics.ts`, `apps/api/src/ops/ops-queues.service.ts`, `apps/api/src/ops/ops-outbox.service.ts`, `apps/api/src/ops/ops-errors.service.ts`, `apps/api/src/ops/ops.controller.ts`, `apps/api/src/ops/ops.module.ts`
- Modify: `apps/api/src/app.module.ts`, `apps/api/src/auth/access.ts`, `apps/api/src/config/env.ts`, `apps/api/src/common/contract-assertions.ts`, `apps/api/src/carrier-sync/carrier-sync.processors.ts`, `apps/api/src/device/device.processor.ts`, `apps/api/src/outbox/outbox.processor.ts`, `apps/api/src/report/report.processor.ts`
- Test: Create `apps/api/test/ops-status.e2e.spec.ts`, `apps/api/test/ops-outbox-errors.e2e.spec.ts`, `apps/api/test/unit/queue-metrics.spec.ts`; Modify `apps/api/test/unit/access-table.spec.ts`
- Docs: Create `docs/decisions/0070-운영-관제-API는-ops-아래-그때그때-읽기와-관제만의-작업.md`, `docs/decisions/0071-워커-생존은-BullMQ-워커-연결과-이름-처리량은-워커-metrics.md`; Modify `docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md`, `docs/study/backlog.md`, `docs/index.md`, `docs/devlog/2026-10-29.md`

- [ ] **Step 1: 실패하는 테스트**

`apps/api/test/unit/queue-metrics.spec.ts`(BullMQ 분 단위 metrics 읽기와 워커 이름 — 순수 함수):

```ts
import { describe, expect, it } from 'vitest';
import { recentCount } from '../../src/ops/queue-metrics.js';
import { workerNameOf } from '../../src/ops/ops-queues.service.js';

const MIN = 60_000;
/** 10:00:30 UTC 같은 분 안의 한 시각 */
const at = (minute: number, sec = 30) => Date.UTC(2026, 9, 29, 1, minute, sec);

describe('최근 N분 처리량 — BullMQ 분 단위 metrics 읽기 (decisions/0071)', () => {
  it('기록이 없으면(prevTS 0) null — 워커가 metrics를 켜지 않았거나 아직 끝난 job이 없다', () => {
    expect(recentCount({ meta: { count: 0, prevTS: 0, prevCount: 0 }, data: [] }, at(10), 15)).toBeNull();
  });

  it('마지막 갱신 분의 수는 data가 아니라 count − prevCount다(같은 분에 2개 끝남: data [], count 2 — 사전 검증)', () => {
    expect(recentCount({ meta: { count: 2, prevTS: at(10, 5), prevCount: 0 }, data: [] }, at(10, 50), 15)).toBe(2);
  });

  it('data[i]는 마지막 갱신 분보다 i+1분 앞 — 창(지금 분 포함 15분) 안의 칸만 더한다', () => {
    // 마지막 갱신 10분(그 분 3개), 앞으로 9분 4개, 8분 0개, 7분 5개, … 지금 12분이면 창은 −2분~12분
    const m = { meta: { count: 100, prevTS: at(10), prevCount: 97 }, data: [4, 0, 5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 7, 9] };
    // 10분 3 + 9분 4 + 8분 0 + 7분 5 + 6~0분 7칸×1 + −1분(data[10]) 1 + −2분(data[11]) 1 = 21, −3분(data[12]=7)부터 창 밖
    expect(recentCount(m, at(12), 15)).toBe(3 + 4 + 0 + 5 + 7 + 1 + 1);
  });

  it('한동안 끝난 job이 없으면 data가 그때에 멈춰 있다 — 창 밖의 오래된 수는 세지 않는다', () => {
    const m = { meta: { count: 10, prevTS: at(10), prevCount: 4 }, data: [3, 1] };
    expect(recentCount(m, at(10) + 30 * MIN, 15)).toBe(0);
    // 마지막 갱신 분이 창 맨 앞이면 그 분만
    expect(recentCount(m, at(10) + 14 * MIN, 15)).toBe(6);
  });
});

describe('워커 이름 — BullMQ getWorkers()의 rawname에서', () => {
  it('`<접두사>:<큐 base64>:w:<이름>`의 이름, 이름 없이 뜬 워커는 null', () => {
    expect(workerNameOf('test-probe:cHE=:w:pid-123')).toBe('pid-123');
    expect(workerNameOf('terminal-ops:b3V0Ym94:w:worker-a')).toBe('worker-a');
    expect(workerNameOf('terminal-ops:b3V0Ym94')).toBeNull();
    expect(workerNameOf(undefined)).toBeNull();
  });
});
```

`apps/api/test/ops-status.e2e.spec.ts`(워커를 띄운 테스트 앱 — 이 파일의 `test-` 접두사 큐를 실제로 처리한다. 주기 작업은 테스트 앱에 없어 직접 등록해 본다):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { OpsQueuesView } from '@terminal-ops/contracts';
import { env } from '../src/config/env.js';
import { ALL_QUEUES, QUEUE, type QueueName } from '../src/queue/queue-names.js';
import { JOB_SCHEDULERS } from '../src/scheduler/job-schedulers.js';
import { resetQueues, waitFor } from './helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const MONITOR = { 'X-Operator': 'mon', 'X-Test-Role': 'MONITOR' };
const ADMIN = { 'X-Operator': 'adm', 'X-Test-Role': 'ADMIN' };

/**
 * 운영 관제 읽기 — 큐 요약·주기 작업·프로세스 상태(보강 6, decisions/0070·0071).
 * 워커를 띄운 앱이라 이 파일의 큐(test- 접두사)를 실제로 처리한다. 주기 작업은 테스트 앱에 없으므로(schedulers: false) 직접 등록해 본다.
 */
describe('운영 관제 읽기 /ops/queues·/ops/schedulers·/ops/system (보강 6)', () => {
  let t: TestApp;
  const queueOf = (name: QueueName) => t.app.get<Queue>(getQueueToken(name));
  const view = (body: OpsQueuesView, name: QueueName) => body.queues.find((q) => q.name === name)!;

  beforeAll(async () => {
    t = await createTestApp({ workers: true });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it('큐 요약: 여섯 큐가 정해진 순서로, 상태별 수·멈춤·가장 오래 기다린 job·워커 수', async () => {
    // carrier-sweep 큐를 멈추고 job 둘을 넣으면 워커가 있어도 waiting에 남는다(BullMQ 6은 멈춘 큐의 job도 waiting으로 센다)
    await queueOf(QUEUE.CARRIER_SWEEP).pause();
    const first = await queueOf(QUEUE.CARRIER_SWEEP).add('sweep', {}, { removeOnComplete: true });
    await new Promise((r) => setTimeout(r, 20));
    await queueOf(QUEUE.CARRIER_SWEEP).add('sweep', {}, { removeOnComplete: true });
    // report 큐에 1분 뒤 job(delayed)
    const delayed = await queueOf(QUEUE.REPORT).add('weekly-report', {}, { delay: 60_000, removeOnComplete: true });

    const res = await t.http(MONITOR).get('/ops/queues');
    expect(res.status).toBe(200);
    expect(res.body.recentMinutes).toBe(15);
    expect(res.body.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.queues.map((q: { name: string }) => q.name)).toEqual(ALL_QUEUES);
    expect(view(res.body, QUEUE.CARRIER_SWEEP)).toMatchObject({
      counts: { waiting: 2, active: 0, delayed: 0, prioritized: 0, failed: 0, completed: 0 },
      paused: true,
      oldestWaitingAt: new Date(first.timestamp).toISOString(),
    });
    expect(view(res.body, QUEUE.REPORT)).toMatchObject({ counts: { delayed: 1, waiting: 0 }, paused: false, oldestWaitingAt: null });
    // 워커를 띄운 앱이라 큐마다 워커 연결이 하나씩 있다
    for (const q of res.body.queues) expect(q.workers).toBeGreaterThanOrEqual(1);

    await delayed.remove();
    await queueOf(QUEUE.CARRIER_SWEEP).resume();
    await waitFor(async () => (await queueOf(QUEUE.CARRIER_SWEEP).getJobCounts('waiting', 'active')).waiting === 0, { message: 'sweep job 처리' });
  });

  it('최근 15분 처리량은 워커의 metrics로 센다 — 끝나서 지워진 job도 세고(removeOnComplete), 실패도 따로 센다', async () => {
    const before = (await t.http(MONITOR).get('/ops/queues')).body;
    // 앞 테스트의 sweep 2개가 끝났다(지워졌지만 metrics에 남는다)
    expect(view(before, QUEUE.CARRIER_SWEEP)).toMatchObject({ completedRecent: 2, counts: { completed: 0 } });
    // 한 번도 끝난 job이 없는 큐는 null
    expect(view(before, QUEUE.TRACK_BUNGAE)).toMatchObject({ completedRecent: null, failedRecent: null });

    // device 큐에 모르는 job → 프로세서가 UnrecoverableError로 실패(재시도 없음)
    await queueOf(QUEUE.DEVICE).add('no-such-job', {}, { removeOnFail: true });
    const after = await waitFor(
      async () => {
        const body = (await t.http(MONITOR).get('/ops/queues')).body;
        return view(body, QUEUE.DEVICE).failedRecent === 1 ? body : null;
      },
      { message: 'device 실패 metrics' },
    );
    expect(view(after, QUEUE.DEVICE)).toMatchObject({ completedRecent: null, failedRecent: 1, counts: { failed: 0 } });
  });

  it('주기 작업: 코드 목록이 모두 보이고, 등록된 것만 registered·다음 실행 시각. Redis에만 있는 것은 defined false로 뒤에', async () => {
    const none = await t.http(ADMIN).get('/ops/schedulers');
    expect(none.status).toBe(200);
    expect(none.body.map((s: { id: string }) => s.id)).toEqual(JOB_SCHEDULERS.map((s) => s.id));
    expect(none.body.every((s: { registered: boolean; nextRunAt: string | null }) => !s.registered && s.nextRunAt === null)).toBe(true);
    expect(none.body.find((s: { id: string }) => s.id === 'weekly-report')).toEqual({
      id: 'weekly-report',
      queue: 'report',
      jobName: 'weekly-report',
      every: null,
      pattern: env.weeklyReportCron,
      tz: 'Asia/Seoul',
      defined: true,
      registered: false,
      nextRunAt: null,
    });

    await queueOf(QUEUE.OUTBOX).upsertJobScheduler('outbox-relay', { every: 600_000 }, { name: 'relay', data: {} });
    await queueOf(QUEUE.DEVICE).upsertJobScheduler('old-renamed', { every: 600_000 }, { name: 'detect-offline', data: {} });
    const some = (await t.http(MONITOR).get('/ops/schedulers')).body;
    const relay = some.find((s: { id: string }) => s.id === 'outbox-relay');
    // 등록된 것은 Redis 값(여기서는 600000 — 코드 기본 2000이 아니라)을 보인다
    expect(relay).toMatchObject({ queue: 'outbox', every: 600_000, pattern: null, defined: true, registered: true });
    expect(Date.parse(relay.nextRunAt)).toBeGreaterThan(Date.now() - 5_000);
    expect(some.at(-1)).toMatchObject({ id: 'old-renamed', queue: 'device', jobName: 'detect-offline', every: 600_000, defined: false, registered: true });
    expect(some).toHaveLength(JOB_SCHEDULERS.length + 1);

    await queueOf(QUEUE.OUTBOX).removeJobScheduler('outbox-relay');
    await queueOf(QUEUE.DEVICE).removeJobScheduler('old-renamed');
  });

  it('프로세스 상태: MySQL·Redis 응답, api 실행 정보, 큐마다 워커(이름 = WORKER_NAME 또는 pid-<pid>)', async () => {
    const res = await t.http(MONITOR).get('/ops/system');
    expect(res.status).toBe(200);
    expect(res.body.mysql).toEqual({ ok: true, latencyMs: expect.any(Number), error: null });
    expect(res.body.redis).toEqual({ ok: true, latencyMs: expect.any(Number), error: null });
    expect(res.body.api).toEqual({
      version: 'dev',
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      node: process.version,
      queuePrefix: env.queuePrefix,
      runWorkers: env.runWorkers,
      runSchedulers: false,
    });
    expect(Date.parse(res.body.api.startedAt)).toBeLessThanOrEqual(Date.now());
    expect([...new Set(res.body.workers.map((w: { queue: string }) => w.queue))].sort()).toEqual([...ALL_QUEUES].sort());
    for (const w of res.body.workers) expect(w).toEqual({ queue: expect.any(String), name: env.workerName, idleSeconds: expect.any(Number) });
  });

  it('역할: 관제·ADMIN만 본다 — 운영자·현장 작업자 403, 로그인 없으면 401', async () => {
    for (const path of ['/ops/queues', '/ops/schedulers', '/ops/system']) {
      expect((await t.http(ADMIN).get(path)).status).toBe(200);
      const op = await t.http({ 'X-Operator': 'op', 'X-Test-Role': 'OPERATOR' }).get(path);
      expect(op.status).toBe(403);
      expect(op.body.code).toBe('FORBIDDEN');
      expect((await t.http({ 'X-Operator': 'fld', 'X-Test-Role': 'FIELD' }).get(path)).status).toBe(403);
      expect((await t.http(null).get(path)).status).toBe(401);
    }
  });
});
```

`apps/api/test/ops-outbox-errors.e2e.spec.ts`(워커 없는 앱, 행을 직접 넣는다 — Task 2가 이 파일에 복구 sweep 테스트를 더한다):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTBOX_TYPE, OutboxEvent, OutboxStatus } from '../src/outbox/outbox-event.entity.js';
import { WeeklyReport, WeeklyReportStatus } from '../src/report/weekly-report.entity.js';
import { SyncRun } from '../src/shipment/shipment.entities.js';
import { VanReconciliationRun, VanRunStatus, VanRunTrigger } from '../src/van/van.entities.js';
import { resetQueues } from './helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const MONITOR = { 'X-Operator': 'mon', 'X-Test-Role': 'MONITOR' };
const ADMIN = { 'X-Operator': 'adm', 'X-Test-Role': 'ADMIN' };

/**
 * Outbox 요약과 최근 업무 오류(보강 6, decisions/0070·0042).
 * 워커 없는 앱이라 행을 직접 넣는다 — 만든 시각을 정해 두고 상태별 수·가장 오래된 행·오류 순서를 본다.
 */
describe('Outbox 요약 /ops/outbox, 최근 업무 오류 /ops/errors (보강 6)', () => {
  let t: TestApp;
  const em = () => t.orm.em.fork();
  const now = Date.now();
  /** 만든 시각을 정해 행을 넣는다(datetime(0) 열이 있어 초 단위로 맞춘다) */
  const minutesAgo = (m: number) => new Date(Math.floor((now - m * 60_000) / 1000) * 1000);
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    const e = em();
    const payload = { serialNo: 'OPS-1', fromStatus: 'IN_STOCK', toStatus: 'ALLOCATED', actor: 'kim', reason: 'r' };
    const row = (status: OutboxStatus, createdAt: Date, extra: Partial<OutboxEvent> = {}) =>
      e.create(OutboxEvent, { type: OUTBOX_TYPE.TERMINAL_STATUS_CHANGED, payload, status, createdAt, ...extra });
    row(OutboxStatus.PENDING, minutesAgo(9));
    row(OutboxStatus.PENDING, minutesAgo(1));
    const queuedOld = row(OutboxStatus.QUEUED, minutesAgo(5));
    row(OutboxStatus.QUEUED, minutesAgo(3));
    row(OutboxStatus.QUEUED, new Date(Math.floor(now / 1000) * 1000)); // 막 넣은 것 — 복구 sweep 기준(60초) 안
    row(OutboxStatus.SENT, minutesAgo(20));
    const failed = row(OutboxStatus.FAILED, minutesAgo(40), { attempts: 5, lastError: 'PartnerPermanentError: 톡톡메신저 400 INVALID_CHANNEL' });
    // 업무 오류 셋(시각을 다르게 두어 순서를 본다)과 오류가 아닌 행 하나씩
    const sync = e.create(SyncRun, { job: 'track-bungae', attempt: 3, worker: 'pid-1', outcome: 'ERROR', startedAt: minutesAgo(10), detail: 'PartnerTemporaryError: 번개택배 503' });
    e.create(SyncRun, { job: 'track-bungae', attempt: 1, worker: 'pid-1', outcome: 'OK', startedAt: minutesAgo(2) });
    const van = e.create(VanReconciliationRun, {
      status: VanRunStatus.FAILED,
      trigger: VanRunTrigger.SCHEDULED,
      requestedBy: 'system:van-reconcile',
      startedAt: minutesAgo(31),
      heartbeatAt: minutesAgo(30),
      finishedAt: minutesAgo(30),
      error: '수집 0건인데 운영 중 단말기가 3대입니다',
    });
    const weekly = e.create(WeeklyReport, { weekStart: '2026-10-19', status: WeeklyReportStatus.GENERATED, generatedAt: minutesAgo(20), attempts: 2, lastError: 'ToktokError: 톡톡메신저 503' });
    e.create(WeeklyReport, { weekStart: '2026-10-12', status: WeeklyReportStatus.SENT, generatedAt: minutesAgo(15), attempts: 1 });
    await e.flush();
    Object.assign(ids, { queuedOld: queuedOld.id, failed: failed.id, sync: sync.id, van: van.id, weekly: weekly.id });
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it('Outbox 요약: 상태별 수와 가장 오래된 PENDING·QUEUED 시각, 복구 sweep 기준', async () => {
    const res = await t.http(ADMIN).get('/ops/outbox');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      checkedAt: expect.stringMatching(/^\d{4}-/),
      counts: { PENDING: 2, QUEUED: 3, SENT: 1, FAILED: 1 },
      oldestPendingAt: minutesAgo(9).toISOString(),
      oldestQueuedAt: minutesAgo(5).toISOString(),
      requeueAfterMs: 60_000,
    });
  });

  it('최근 업무 오류: 수집 실패·VAN 대조 실패·주간 리포트 lastError·알림 실패를 시각 순으로 한 목록에(오류가 아닌 행은 빠진다)', async () => {
    const res = await t.http(MONITOR).get('/ops/errors');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { source: 'SYNC_RUN', id: ids.sync, at: minutesAgo(10).toISOString(), title: '택배 수집 실패 — track-bungae, 3번째 시도', message: 'PartnerTemporaryError: 번개택배 503' },
      { source: 'WEEKLY_REPORT', id: ids.weekly, at: minutesAgo(20).toISOString(), title: '주간 리포트 2026-10-19 주 보내기 실패 — GENERATED, 2번 시도', message: 'ToktokError: 톡톡메신저 503' },
      { source: 'VAN_RUN', id: ids.van, at: minutesAgo(30).toISOString(), title: `VAN 대조 #${ids.van} 실패 — 주기 실행`, message: '수집 0건인데 운영 중 단말기가 3대입니다' },
      {
        source: 'OUTBOX',
        id: ids.failed,
        at: minutesAgo(40).toISOString(),
        title: `알림 #${ids.failed} 보내기 실패 — terminal.status_changed, 5번 시도`,
        message: 'PartnerPermanentError: 톡톡메신저 400 INVALID_CHANNEL',
      },
    ]);
    expect((await t.http(ADMIN).get('/ops/errors').query({ limit: 2 })).body.map((e: { source: string }) => e.source)).toEqual(['SYNC_RUN', 'WEEKLY_REPORT']);
    expect((await t.http(MONITOR).get('/ops/errors').query({ limit: 0 })).status).toBe(400);
  });

  it('역할: 관제·ADMIN만 본다 — 운영자·현장 작업자 403, 로그인 없으면 401', async () => {
    for (const path of ['/ops/outbox', '/ops/errors']) {
      expect((await t.http({ 'X-Operator': 'op', 'X-Test-Role': 'OPERATOR' }).get(path)).status).toBe(403);
      expect((await t.http({ 'X-Operator': 'fld', 'X-Test-Role': 'FIELD' }).get(path)).status).toBe(403);
      expect((await t.http(null).get(path)).status).toBe(401);
    }
  });
});
```

`apps/api/test/unit/access-table.spec.ts`(표에 다섯 줄):

```diff
diff --git a/apps/api/test/unit/access-table.spec.ts b/apps/api/test/unit/access-table.spec.ts
index 4913847..d59f4a6 100644
--- a/apps/api/test/unit/access-table.spec.ts
+++ b/apps/api/test/unit/access-table.spec.ts
@@ -95,6 +95,13 @@ const EXPECTED: Record<string, string> = {
   'POST /admin/partner-keys': 'ADMIN',
   'POST /admin/partner-keys/:id/revoke': 'ADMIN',
 
+  // 운영 관제(보강 6, decisions/0070) — 보기는 관제·ADMIN, 관제 작업은 관제만
+  'GET /ops/queues': 'ADMIN,MONITOR',
+  'GET /ops/schedulers': 'ADMIN,MONITOR',
+  'GET /ops/system': 'ADMIN,MONITOR',
+  'GET /ops/outbox': 'ADMIN,MONITOR',
+  'GET /ops/errors': 'ADMIN,MONITOR',
+
   // 외부 업체 키(scope별)
   'GET /partner/v1/terminals/:serialNo': 'partner:terminal-status:read',
   'GET /partner/v1/merchants/:merchantCode/terminals': 'partner:merchant-terminals:read',
```

- [ ] **Step 2: 실패 확인**

```bash
# 저장소 루트에서 테스트 DB를 새로 만든다(안전 규칙의 두 줄 — 비밀번호는 출력하지 않는다)
cd apps/api && npx vitest run test/unit/access-table.spec.ts test/unit/queue-metrics.spec.ts test/ops-status.e2e.spec.ts test/ops-outbox-errors.e2e.spec.ts
```

Expected(사전 검증 원문 요약): `Test Files  4 failed (4)`, `Tests  10 failed | 1 passed (11)` —
- queue-metrics: `Error: Cannot find module '../../src/ops/queue-metrics.js'`(파일 전체)
- ops-status 다섯·ops-outbox-errors 셋: `AssertionError: expected 404 to be 200`(역할 테스트는 `expected 404 to be 403`), 처리량 테스트는 `TypeError: Cannot read properties of undefined (reading 'find')`
- access-table 둘: 표가 다름, `AssertionError: expected 72 to be 77`

- [ ] **Step 3: 계약 타입**

`packages/contracts/src/ops.ts`(Task 2가 실패 job·감사 기록 타입을 뒤에 더한다):

```ts
/**
 * 운영 관제(보강 6, decisions/0070). `GET /ops/...`는 관제·ADMIN이 읽고, 관제 작업(다시 시도·지우기·복구 sweep)은 관제(MONITOR)만 한다.
 * 큐·주기 작업·워커 상태는 BullMQ(Redis)에서, Outbox·업무 오류·감사 기록은 MySQL에서 그때그때 읽는다(캐시 없음).
 */

/** BullMQ 큐 이름(api queue-names.ts QUEUE와 같은 값 — api contract-assertions.ts가 단언) */
export type OpsQueueName = 'track-bungae' | 'track-neurimbo' | 'carrier-sweep' | 'outbox' | 'device' | 'report';

/**
 * 큐의 상태별 job 수. BullMQ는 큐를 멈춰도(Queue.pause) job을 waiting에 그대로 센다 — 멈춤은 `paused` 플래그로 본다(사전 검증).
 * completed·failed는 Redis에 남은 것만 센다 — 이 시스템의 job 대부분은 끝나면 지워진다(removeOnComplete·removeOnFail, decisions/0072).
 */
export interface OpsJobCounts {
  waiting: number;
  active: number;
  delayed: number;
  prioritized: number;
  failed: number;
  completed: number;
}

/** 큐 하나의 요약(GET /ops/queues) */
export interface OpsQueueView {
  name: OpsQueueName;
  counts: OpsJobCounts;
  /** 큐 전체가 멈춤(Queue.pause)인가 */
  paused: boolean;
  /** 가장 오래 기다린(waiting) job이 들어온 시각. 기다리는 job이 없으면 null */
  oldestWaitingAt: string | null;
  /** 최근 recentMinutes분(지금 분 포함) 동안 끝난·실패한 job 수(BullMQ 분 단위 metrics). 워커가 아직 한 번도 기록하지 않았으면 null(decisions/0071) */
  completedRecent: number | null;
  failedRecent: number | null;
  /** 이 큐를 처리하는 워커 연결 수(BullMQ getWorkers — Redis CLIENT LIST) */
  workers: number;
}

export interface OpsQueuesView {
  checkedAt: string;
  recentMinutes: number;
  queues: OpsQueueView[];
}

/** 주기 작업 하나(GET /ops/schedulers) — 코드의 목록(JOB_SCHEDULERS)과 Redis에 등록된 것을 합친다 */
export interface OpsSchedulerView {
  id: string;
  queue: OpsQueueName;
  jobName: string;
  /** 간격(ms) — cron이면 null */
  every: number | null;
  /** cron 식과 시간대 — 간격이면 null */
  pattern: string | null;
  tz: string | null;
  /** 코드의 주기 작업 목록에 있나. false면 Redis에만 남은 것(이름을 바꾸기 전 것 등 — scheduler:clear 대상이 아니다) */
  defined: boolean;
  /** Redis에 등록돼 있나. false면 RUN_SCHEDULERS=1인 프로세스가 아직 뜨지 않았거나 scheduler:clear로 지운 것 */
  registered: boolean;
  /** 다음 실행 시각(등록된 것만) */
  nextRunAt: string | null;
}

/** 의존 서비스 하나의 응답(MySQL `select 1`, Redis PING) */
export interface OpsDependencyView {
  ok: boolean;
  latencyMs: number | null;
  error: string | null;
}

/** 큐를 처리하는 워커 연결 하나(BullMQ getWorkers) */
export interface OpsWorkerView {
  queue: OpsQueueName;
  /** 워커 이름(api WORKER_NAME, 없으면 pid-<pid>). 이름 없이 뜬 워커는 null */
  name: string | null;
  /** 마지막 명령 뒤 지난 초(Redis CLIENT LIST idle) */
  idleSeconds: number;
}

/** 프로세스·의존 상태(GET /ops/system) */
export interface OpsSystemView {
  checkedAt: string;
  api: {
    /** APP_VERSION env(없으면 'dev') */
    version: string;
    startedAt: string;
    node: string;
    queuePrefix: string;
    runWorkers: boolean;
    runSchedulers: boolean;
  };
  mysql: OpsDependencyView;
  redis: OpsDependencyView;
  workers: OpsWorkerView[];
}

/** Outbox 행 상태(api OutboxStatus와 같은 값 — contract-assertions.ts, decisions/0016) */
export type OpsOutboxStatus = 'PENDING' | 'QUEUED' | 'SENT' | 'FAILED';

/** Outbox 요약(GET /ops/outbox) */
export interface OpsOutboxView {
  checkedAt: string;
  counts: Record<OpsOutboxStatus, number>;
  /** 가장 오래된 PENDING·QUEUED 행을 만든 시각(없으면 null). PENDING이 오래되면 relay가 멈춘 것, QUEUED가 오래되면 notify job이 사라졌거나 밀린 것 */
  oldestPendingAt: string | null;
  oldestQueuedAt: string | null;
  /** 복구 sweep은 만든 지 이만큼 지난 QUEUED 행만 본다(OUTBOX_REQUEUE_AFTER_MS, decisions/0042) */
  requeueAfterMs: number;
}

/** 최근 업무 오류의 출처 — 새 표 없이 오류를 이미 남기는 기록을 읽는다(decisions/0070) */
export type OpsErrorSource = 'SYNC_RUN' | 'VAN_RUN' | 'WEEKLY_REPORT' | 'OUTBOX';

/** 최근 업무 오류 한 건(GET /ops/errors) */
export interface OpsErrorView {
  source: OpsErrorSource;
  /** 그 표의 행 id */
  id: number;
  /**
   * 기록 시각: 수집 기록은 시작 시각, VAN 대조는 끝난 시각(없으면 시작), 주간 리포트는 파일을 만든 시각(없으면 행을 만든 시각 — 실패 시각 열이 없다),
   * outbox는 행을 만든 시각(마지막 시도 시각 열이 없다)
   */
  at: string;
  title: string;
  /** 그 행에 남은 오류 글(500자까지) */
  message: string;
}
```

```diff
diff --git a/packages/contracts/src/index.ts b/packages/contracts/src/index.ts
index 77fd177..d5b5002 100644
--- a/packages/contracts/src/index.ts
+++ b/packages/contracts/src/index.ts
@@ -1,5 +1,5 @@
 /**
- * @terminal-ops/contracts — api와 어드민·매장·현장 화면이 함께 보는 HTTP 계약(응답·요청 모양, 상태 값, 오류 코드).
+ * @terminal-ops/contracts — api와 어드민·매장·현장·관제 화면이 함께 보는 HTTP 계약(응답·요청 모양, 상태 값, 오류 코드).
  * 타입만 있다(런타임 값 없음). 쓰는 쪽은 `import type`으로만 가져온다 — 빌드된 JS에 이 패키지 import가 남지 않는다(decisions/0047).
  * api는 응답을 만드는 함수의 반환 타입·DTO의 implements로 이 타입을 지키고(어긋나면 api tsc 실패), 어드민은 이 타입으로 응답을 읽는다(decisions/0048).
  */
@@ -13,3 +13,4 @@ export type * from './requests.js';
 export type * from './auth.js';
 export type * from './merchant.js';
 export type * from './field.js';
+export type * from './ops.js';
```

- [ ] **Step 4: 구현**

역할 묶음(`OPS_VIEW`), 앱 버전 env, enum 단언 둘(큐 이름·Outbox 상태 — Outbox 상태가 이제 응답에 나가므로 "단언하지 않는 내부 enum" 목록에서 뺀다):

```diff
diff --git a/apps/api/src/auth/access.ts b/apps/api/src/auth/access.ts
index 65e930e..8ff5f5c 100644
--- a/apps/api/src/auth/access.ts
+++ b/apps/api/src/auth/access.ts
@@ -31,5 +31,7 @@ export const PartnerAuth = (scope: PartnerScope) => SetMetadata(ACCESS_KEY, { ki
 export const STAFF = [Role.ADMIN, Role.OPERATOR, Role.MONITOR, Role.FIELD] as const;
 /** 사무실 조회(운영 현황·리포트·이력). 현장 작업자는 쓰지 않는다 */
 export const OFFICE = [Role.ADMIN, Role.OPERATOR, Role.MONITOR] as const;
+/** 운영 관제 보기(보강 6, decisions/0070). 관제 작업(다시 시도·지우기·복구 sweep)은 MONITOR만 */
+export const OPS_VIEW = [Role.ADMIN, Role.MONITOR] as const;
 /** 로그인한 누구나(내 정보, 로그아웃) */
 export const ANY_ROLE = [Role.ADMIN, Role.OPERATOR, Role.MONITOR, Role.FIELD, Role.MERCHANT] as const;
```

```diff
diff --git a/apps/api/src/config/env.ts b/apps/api/src/config/env.ts
index 9e7b7a8..552b8fc 100644
--- a/apps/api/src/config/env.ts
+++ b/apps/api/src/config/env.ts
@@ -149,7 +149,9 @@ export const env = {
   deviceApiKey: resolveDeviceApiKey(process.env.DEVICE_API_KEY),
   /** 테스트 전용 인증 헤더(X-Operator·X-Test-Role). NODE_ENV=test가 아니면 켜지지 않고 던진다(decisions/0056) */
   authTestHeaders: resolveAuthTestHeaders(process.env.AUTH_TEST_HEADERS, process.env.NODE_ENV),
-  /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
+  /** 운영 관제에 보이는 앱 버전(보강 6, decisions/0071). 띄우는 쪽(이후 Docker)이 넣는다 — 없으면 dev */
+  appVersion: process.env.APP_VERSION ?? 'dev',
+  /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용). 워커 연결 이름에도 붙어 운영 관제가 어느 프로세스가 큐를 처리하는지 본다(decisions/0071) */
   workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
 };
 
```

```diff
diff --git a/apps/api/src/common/contract-assertions.ts b/apps/api/src/common/contract-assertions.ts
index 33b9eb3..3e235db 100644
--- a/apps/api/src/common/contract-assertions.ts
+++ b/apps/api/src/common/contract-assertions.ts
@@ -1,7 +1,7 @@
 /**
  * api의 런타임 enum(MikroORM 엔티티·class-validator가 쓴다)과 @terminal-ops/contracts의 문자열 유니온이 같은 값 집합인지 타입으로 단언한다(decisions/0048).
  * 어느 한쪽에만 값이 있으면 api tsc(build·typecheck)가 이 파일에서 TS2344로 실패하고, 메시지에 빠진 값이 나온다.
- * 응답에 나가는 enum만 단언한다. 응답 본문에 나오지 않는 내부 enum(TargetStatus·VanStatus·OutboxStatus)은 계약에 없고 여기서도 단언하지 않는다.
+ * 응답에 나가는 enum만 단언한다. 응답 본문에 나오지 않는 내부 enum(TargetStatus·VanStatus)은 계약에 없고 여기서도 단언하지 않는다.
  * 런타임 코드는 없다(빌드하면 빈 모듈). import하는 곳도 없다 — tsconfig의 include(src)로 검사 대상에 들어간다.
  */
 import type * as C from '@terminal-ops/contracts';
@@ -10,6 +10,8 @@ import type { PARTNER_SCOPES } from '../auth/partner-key.entity.js';
 import type { Role } from '../auth/role.js';
 import type { Carrier, CarrierEventCode } from '../carrier/carrier.types.js';
 import type { RolloutStatus } from '../firmware/firmware.entities.js';
+import type { OutboxStatus } from '../outbox/outbox-event.entity.js';
+import type { QueueName } from '../queue/queue-names.js';
 import type { PurchaseOrderStatus } from '../purchase-order/purchase-order.entity.js';
 import type { WeeklyReportStatus } from '../report/weekly-report.entity.js';
 import type { ScanKind } from '../scan/scan-batch.entity.js';
@@ -46,4 +48,6 @@ export type ContractEnumAssertions = [
   Assert<Same<(typeof SYNC_RUN_OUTCOMES)[number], C.SyncRunOutcome>>,
   Assert<Same<`${Role}`, C.Role>>,
   Assert<Same<(typeof PARTNER_SCOPES)[number], C.PartnerScope>>,
+  Assert<Same<QueueName, C.OpsQueueName>>,
+  Assert<Same<`${OutboxStatus}`, C.OpsOutboxStatus>>,
 ];
```

워커 관찰 옵션 `apps/api/src/queue/worker-options.ts`와 프로세서 다섯에 한 줄씩(옵션 객체를 펼쳐 넣는다 — 기존 concurrency·limiter·settings는 그대로):

```ts
import { env } from '../config/env.js';

/** 워커가 남기는 분 단위 처리 수(BullMQ metrics)를 몇 분치 둘까 — 하루. 큐마다 completed·failed 목록 두 개, 1,440칸씩 */
export const METRICS_MAX_DATA_POINTS = 24 * 60;

/**
 * 모든 @Processor에 붙이는 관찰용 워커 옵션(보강 6, decisions/0071).
 * - name: Redis 연결 이름에 붙어(`<접두사>:<큐 base64>:w:<이름>`) 운영 관제가 `getWorkers()`로 어느 프로세스가 이 큐를 처리하는지 본다
 * - metrics: job이 끝날 때마다 분 단위 완료·실패 수를 Redis에 쌓는다(job을 지워도 — removeOnComplete — 센다). 관제의 "최근 15분 처리량"
 */
export const WORKER_OBSERVABILITY = {
  name: env.workerName,
  metrics: { maxDataPoints: METRICS_MAX_DATA_POINTS },
};
```

```diff
diff --git a/apps/api/src/carrier-sync/carrier-sync.processors.ts b/apps/api/src/carrier-sync/carrier-sync.processors.ts
index 630a144..4e2ef86 100644
--- a/apps/api/src/carrier-sync/carrier-sync.processors.ts
+++ b/apps/api/src/carrier-sync/carrier-sync.processors.ts
@@ -2,6 +2,7 @@ import { Processor, WorkerHost } from '@nestjs/bullmq';
 import type { Job } from 'bullmq';
 import { env } from '../config/env.js';
 import { QUEUE } from '../queue/queue-names.js';
+import { WORKER_OBSERVABILITY } from '../queue/worker-options.js';
 import { CarrierSyncService, type TrackJobData } from './carrier-sync.service.js';
 import { carrierBackoff, toJobError } from './retry-policy.js';
 
@@ -15,6 +16,7 @@ async function runTrack(sync: CarrierSyncService, queue: string, job: Job<TrackJ
 
 /** 번개택배 추적. limiter로 우리 쪽 호출 속도를 택배사 한도 아래로 묶는다(초당 env.bungaeRatePerSec). */
 @Processor(QUEUE.TRACK_BUNGAE, {
+  ...WORKER_OBSERVABILITY,
   concurrency: 5,
   limiter: { max: env.bungaeRatePerSec, duration: 1000 },
   settings: { backoffStrategy: carrierBackoff },
@@ -31,6 +33,7 @@ export class BungaeTrackProcessor extends WorkerHost {
 
 /** 느림보물류 추적. 응답이 느려 동시 처리 수를 조금 더 둔다. */
 @Processor(QUEUE.TRACK_NEURIMBO, {
+  ...WORKER_OBSERVABILITY,
   concurrency: 5,
   limiter: { max: env.neurimboRatePerSec, duration: 1000 },
   settings: { backoffStrategy: carrierBackoff },
@@ -46,7 +49,7 @@ export class NeurimboTrackProcessor extends WorkerHost {
 }
 
 /** 주기 실행(job scheduler)이 넣는 sweep job을 처리한다. */
-@Processor(QUEUE.CARRIER_SWEEP)
+@Processor(QUEUE.CARRIER_SWEEP, WORKER_OBSERVABILITY)
 export class CarrierSweepProcessor extends WorkerHost {
   constructor(private readonly sync: CarrierSyncService) {
     super();
```

```diff
diff --git a/apps/api/src/device/device.processor.ts b/apps/api/src/device/device.processor.ts
index fd8edf1..952711c 100644
--- a/apps/api/src/device/device.processor.ts
+++ b/apps/api/src/device/device.processor.ts
@@ -3,6 +3,7 @@ import { UnrecoverableError, type Job } from 'bullmq';
 import { RolloutService } from '../firmware/rollout.service.js';
 import type { ProjectJobData } from '../outbox/outbox.service.js';
 import { QUEUE } from '../queue/queue-names.js';
+import { WORKER_OBSERVABILITY } from '../queue/worker-options.js';
 import { ActiveSetService } from './active-set.service.js';
 import { ConnectivityService } from './connectivity.service.js';
 
@@ -10,7 +11,7 @@ import { ConnectivityService } from './connectivity.service.js';
  * device 큐. concurrency 1: 한 워커 프로세스 안에서는 active 갱신이 한 번에 하나씩 돈다(읽고 쓰는 사이에 다른 갱신이 끼지 않게).
  * 워커 프로세스가 여럿이면 겹칠 수 있고, 그 틈은 주기 재구성이 메운다(decisions/0028).
  */
-@Processor(QUEUE.DEVICE, { concurrency: 1 })
+@Processor(QUEUE.DEVICE, { ...WORKER_OBSERVABILITY, concurrency: 1 })
 export class DeviceProcessor extends WorkerHost {
   constructor(
     private readonly activeSet: ActiveSetService,
```

```diff
diff --git a/apps/api/src/outbox/outbox.processor.ts b/apps/api/src/outbox/outbox.processor.ts
index 1de91d9..8b8c83d 100644
--- a/apps/api/src/outbox/outbox.processor.ts
+++ b/apps/api/src/outbox/outbox.processor.ts
@@ -1,10 +1,11 @@
 import { Processor, WorkerHost } from '@nestjs/bullmq';
 import { UnrecoverableError, type Job } from 'bullmq';
 import { QUEUE } from '../queue/queue-names.js';
+import { WORKER_OBSERVABILITY } from '../queue/worker-options.js';
 import { OutboxService, type NotifyJobData } from './outbox.service.js';
 
 /** outbox 큐: relay·requeue(주기 실행)와 notify(행마다) 세 종류의 job을 처리한다. */
-@Processor(QUEUE.OUTBOX, { concurrency: 5 })
+@Processor(QUEUE.OUTBOX, { ...WORKER_OBSERVABILITY, concurrency: 5 })
 export class OutboxProcessor extends WorkerHost {
   constructor(private readonly outbox: OutboxService) {
     super();
```

```diff
diff --git a/apps/api/src/report/report.processor.ts b/apps/api/src/report/report.processor.ts
index 9152f89..e13c476 100644
--- a/apps/api/src/report/report.processor.ts
+++ b/apps/api/src/report/report.processor.ts
@@ -4,6 +4,7 @@ import { UnrecoverableError, type Job } from 'bullmq';
 import { AnomalyService } from '../anomaly/anomaly.service.js';
 import { BusinessError } from '../common/domain-errors.js';
 import { QUEUE } from '../queue/queue-names.js';
+import { WORKER_OBSERVABILITY } from '../queue/worker-options.js';
 import { toVanRunView, VanReconciliationService, type VanRunJobData } from '../van/van-reconciliation.service.js';
 import { VanRunStatus } from '../van/van.entities.js';
 import { parseKstWeekStart } from './kst-week.js';
@@ -13,7 +14,7 @@ import { isPermanentWeeklyReportError, WEEKLY_REPORT_SEND_JOB, WeeklyReportServi
  * report 큐: 오래 걸리는 집계 job(VAN 대조, 이상 단말기 찾기, 주간 리포트). device 큐(concurrency 1, 짧은 job)와 나눠
  * 무거운 일이 active 갱신·오프라인 판정을 막지 않게 한다(experiments/0010). 이 큐도 concurrency 1 — 집계끼리는 겹치지 않는다.
  */
-@Processor(QUEUE.REPORT, { concurrency: 1 })
+@Processor(QUEUE.REPORT, { ...WORKER_OBSERVABILITY, concurrency: 1 })
 export class ReportProcessor extends WorkerHost {
   /** 주기 job은 밤에 사람 없이 돈다. 건너뜀은 warn, 끝나면 한 줄 요약(fix: 로그만 보고 그날 돌았는지 알 수 있게) */
   private readonly logger = new Logger(ReportProcessor.name);
```

`apps/api/src/ops/queue-metrics.ts`:

```ts
/** BullMQ `Queue.getMetrics()`가 주는 것 중 여기서 쓰는 부분 */
export interface MetricsSnapshot {
  meta: { count: number; prevTS: number; prevCount: number };
  data: number[];
}

const MINUTE_MS = 60_000;

/**
 * BullMQ 분 단위 metrics에서 최근 `minutes`분(지금 분 포함) 동안 끝난 job 수(보강 6, decisions/0071). 기록이 한 번도 없으면 null.
 *
 * BullMQ는 job이 끝날 때만 metrics를 갱신한다(collectMetrics 스크립트). 갱신 시각의 분이 바뀌었으면 앞 분의 수(count − prevCount)를
 * data 앞에 넣고(사이에 빈 분이 있으면 0을 채운다) prevTS·prevCount를 지금으로 옮긴다. 그래서
 * - data[i]는 "마지막 갱신 분(prevTS의 분)보다 i+1분 앞"의 수이고
 * - 마지막 갱신 분 자체의 수는 아직 data에 없고 `count − prevCount`다(사전 검증: 막 끝난 job 2개는 data가 [], meta.count 2).
 * 한동안 끝난 job이 없으면 data가 그때에 멈춰 있다 — 지금 시각으로 창을 잘라야 오래된 수를 "최근"으로 세지 않는다.
 */
export function recentCount(m: MetricsSnapshot, now: number, minutes: number): number | null {
  const prevTS = Number(m.meta.prevTS) || 0;
  if (prevTS === 0) return null;
  const nowMinute = Math.floor(now / MINUTE_MS);
  const lastMinute = Math.floor(prevTS / MINUTE_MS);
  const from = nowMinute - minutes + 1;
  const inWindow = (minute: number) => minute >= from && minute <= nowMinute;
  let sum = inWindow(lastMinute) ? Number(m.meta.count) - Number(m.meta.prevCount) : 0;
  m.data.forEach((n, i) => {
    if (inWindow(lastMinute - 1 - i)) sum += Number(n);
  });
  return sum;
}
```

`apps/api/src/ops/ops-queues.service.ts`(Task 2가 이름으로 큐를 찾는 `queue()`를 더한다):

```ts
import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { EntityManager } from '@mikro-orm/mysql';
import type { OpsDependencyView, OpsQueueView, OpsQueuesView, OpsSchedulerView, OpsSystemView, OpsWorkerView } from '@terminal-ops/contracts';
import { env } from '../config/env.js';
import { ALL_QUEUES, QUEUE, type QueueName } from '../queue/queue-names.js';
import { REDIS } from '../redis/redis.provider.js';
import { JOB_SCHEDULERS } from '../scheduler/job-schedulers.js';
import { recentCount } from './queue-metrics.js';

/** 처리량을 보는 창(분). 화면 카드의 "최근 15분" */
export const RECENT_MINUTES = 15;

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

/** 오류를 화면에 보일 한 줄로(연결 문자열 같은 긴 내용은 자른다) */
const oneLine = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 200);

/** BullMQ getWorkers()의 rawname `<접두사>:<큐 base64>:w:<워커 이름>`에서 워커 이름. 이름 없이 뜬 워커는 null */
export function workerNameOf(rawname: string | undefined): string | null {
  const at = rawname?.lastIndexOf(':w:') ?? -1;
  return at >= 0 ? rawname!.slice(at + 3) || null : null;
}

/**
 * 운영 관제의 읽기(보강 6, decisions/0070·0071): 큐 요약, 주기 작업, 프로세스·의존 상태.
 * 큐마다 Redis 명령 몇 개(getJobCounts·isPaused·getJobs·getMetrics×2·getWorkers)라 6개 큐를 한 번에 Promise.all로 읽는다.
 */
@Injectable()
export class OpsQueuesService {
  private readonly queues: Record<QueueName, Queue>;

  constructor(
    private readonly em: EntityManager,
    @Inject(REDIS) private readonly redis: Redis,
    @InjectQueue(QUEUE.TRACK_BUNGAE) bungae: Queue,
    @InjectQueue(QUEUE.TRACK_NEURIMBO) neurimbo: Queue,
    @InjectQueue(QUEUE.CARRIER_SWEEP) sweep: Queue,
    @InjectQueue(QUEUE.OUTBOX) outbox: Queue,
    @InjectQueue(QUEUE.DEVICE) device: Queue,
    @InjectQueue(QUEUE.REPORT) report: Queue,
  ) {
    this.queues = {
      [QUEUE.TRACK_BUNGAE]: bungae,
      [QUEUE.TRACK_NEURIMBO]: neurimbo,
      [QUEUE.CARRIER_SWEEP]: sweep,
      [QUEUE.OUTBOX]: outbox,
      [QUEUE.DEVICE]: device,
      [QUEUE.REPORT]: report,
    };
  }

  async summary(now = Date.now()): Promise<OpsQueuesView> {
    const queues = await Promise.all(ALL_QUEUES.map((name) => this.queueView(name, now)));
    return { checkedAt: new Date(now).toISOString(), recentMinutes: RECENT_MINUTES, queues };
  }

  private async queueView(name: QueueName, now: number): Promise<OpsQueueView> {
    const q = this.queues[name];
    const [counts, paused, oldest, completed, failed, workers] = await Promise.all([
      q.getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'failed', 'completed'),
      q.isPaused(),
      // waiting은 LPUSH 목록이라 asc=true의 첫 칸이 가장 오래된 job(사전 검증)
      q.getJobs(['waiting'], 0, 0, true),
      q.getMetrics('completed', 0, RECENT_MINUTES),
      q.getMetrics('failed', 0, RECENT_MINUTES),
      q.getWorkersCount(),
    ]);
    return {
      name,
      counts: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        prioritized: counts.prioritized ?? 0,
        failed: counts.failed ?? 0,
        completed: counts.completed ?? 0,
      },
      paused,
      oldestWaitingAt: iso(oldest[0]?.timestamp),
      completedRecent: recentCount(completed, now, RECENT_MINUTES),
      failedRecent: recentCount(failed, now, RECENT_MINUTES),
      workers,
    };
  }

  /** 코드의 주기 작업 목록 + Redis에 등록된 것(목록에 없는 것은 defined false로 뒤에) */
  async schedulers(): Promise<OpsSchedulerView[]> {
    const registered = new Map<string, { queue: QueueName; s: Awaited<ReturnType<Queue['getJobSchedulers']>>[number] }>();
    for (const name of ALL_QUEUES) {
      for (const s of await this.queues[name].getJobSchedulers(0, -1, true)) registered.set(`${name}/${s.key}`, { queue: name, s });
    }
    const rows: OpsSchedulerView[] = [];
    for (const def of JOB_SCHEDULERS) {
      const found = registered.get(`${def.queue}/${def.id}`);
      registered.delete(`${def.queue}/${def.id}`);
      const schedule = found ? { every: found.s.every ?? null, pattern: found.s.pattern ?? null, tz: found.s.tz ?? null } : this.fromDefinition(def.schedule());
      rows.push({ id: def.id, queue: def.queue, jobName: def.jobName, ...schedule, defined: true, registered: !!found, nextRunAt: iso(found?.s.next) });
    }
    for (const { queue, s } of registered.values()) {
      rows.push({ id: s.key, queue, jobName: s.name, every: s.every ?? null, pattern: s.pattern ?? null, tz: s.tz ?? null, defined: false, registered: true, nextRunAt: iso(s.next) });
    }
    return rows;
  }

  private fromDefinition(s: { every: number } | { pattern: string; tz: string }) {
    return 'every' in s ? { every: s.every, pattern: null, tz: null } : { every: null, pattern: s.pattern, tz: s.tz };
  }

  async system(now = Date.now()): Promise<OpsSystemView> {
    const [mysql, redis, workers] = await Promise.all([
      this.ping(() => this.em.getConnection().execute('select 1')),
      this.ping(() => this.redis.ping()),
      this.workers(),
    ]);
    return {
      checkedAt: new Date(now).toISOString(),
      api: {
        version: env.appVersion,
        startedAt: new Date(now - Math.round(process.uptime() * 1000)).toISOString(),
        node: process.version,
        queuePrefix: env.queuePrefix,
        runWorkers: env.runWorkers,
        runSchedulers: env.runSchedulers,
      },
      mysql,
      redis,
      workers,
    };
  }

  private async ping(run: () => Promise<unknown>): Promise<OpsDependencyView> {
    const started = performance.now();
    try {
      await run();
      return { ok: true, latencyMs: Math.round((performance.now() - started) * 10) / 10, error: null };
    } catch (error) {
      return { ok: false, latencyMs: null, error: oneLine(error) };
    }
  }

  /**
   * 큐마다 워커 연결(Redis CLIENT LIST의 연결 이름). CLIENT 명령을 막은 Redis(일부 관리형)면 BullMQ가 이름 없는 항목 하나
   * (`{ name: 'GCP does not support client list' }`)를 준다 — 이름 없는 워커 1로 보인다(decisions/0071 대가). 이 프로젝트의 Docker Redis는 된다
   */
  private async workers(): Promise<OpsWorkerView[]> {
    const lists = await Promise.all(
      ALL_QUEUES.map(async (name) => (await this.queues[name].getWorkers()).map((w) => ({ queue: name, name: workerNameOf(w.rawname), idleSeconds: Number(w.idle) || 0 }))),
    );
    return lists.flat();
  }
}
```

`apps/api/src/ops/ops-outbox.service.ts`(Task 2가 복구 sweep을 더한다):

```ts
import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { OpsOutboxStatus, OpsOutboxView } from '@terminal-ops/contracts';
import { env } from '../config/env.js';
import { OutboxEvent, OutboxStatus } from '../outbox/outbox-event.entity.js';

/**
 * Outbox 요약(보강 6, decisions/0070·0042).
 * 상태별 수는 (status, id) 인덱스로 센다(상태마다 count 하나). 가장 오래된 PENDING·QUEUED는 그 상태의 가장 작은 id 행의 만든 시각.
 */
@Injectable()
export class OpsOutboxService {
  constructor(private readonly em: EntityManager) {}

  async summary(now = new Date()): Promise<OpsOutboxView> {
    const em = this.em.fork();
    const statuses = Object.values(OutboxStatus);
    const counts = await Promise.all(statuses.map((status) => em.count(OutboxEvent, { status })));
    const oldest = (status: OutboxStatus) => em.findOne(OutboxEvent, { status }, { orderBy: { id: 'asc' }, fields: ['id', 'createdAt'] });
    const [pending, queued] = await Promise.all([oldest(OutboxStatus.PENDING), oldest(OutboxStatus.QUEUED)]);
    return {
      checkedAt: now.toISOString(),
      counts: Object.fromEntries(statuses.map((s, i) => [s, counts[i]])) as Record<OpsOutboxStatus, number>,
      oldestPendingAt: pending?.createdAt.toISOString() ?? null,
      oldestQueuedAt: queued?.createdAt.toISOString() ?? null,
      requeueAfterMs: env.outboxRequeueAfterMs,
    };
  }
}
```

`apps/api/src/ops/ops-errors.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { OpsErrorView } from '@terminal-ops/contracts';
import { OutboxEvent, OutboxStatus } from '../outbox/outbox-event.entity.js';
import { WeeklyReport } from '../report/weekly-report.entity.js';
import { SyncRun } from '../shipment/shipment.entities.js';
import { VanReconciliationRun, VanRunStatus } from '../van/van.entities.js';

/** 수집 기록은 최근 이만큼의 행(id) 안에서만 오류를 찾는다 — outcome에 인덱스가 없어 PK 범위로 읽는 양을 묶는다(decisions/0070) */
export const SYNC_RUN_SCAN_WINDOW = 10_000;

const clip = (text: string | null | undefined) => (text ?? '').slice(0, 500);

/**
 * 최근 업무 오류 한 목록(보강 6, decisions/0070). 새 표 없이 오류를 이미 남기는 네 곳을 읽어 시각 순으로 합친다 —
 * 택배 수집 기록(sync_run outcome ERROR), VAN 대조 실행(FAILED), 주간 리포트(lastError — 보내면 비워진다), Outbox(FAILED).
 * 출처마다 최근 limit개(id 내림차순)를 읽고 합쳐 limit개. 이상 단말기 찾기는 실행 기록 표가 없어(Redis 잠금만) 빠진다.
 * sync_run은 job 실행마다 한 행이라 가장 크다 — 가장 큰 id에서 SYNC_RUN_SCAN_WINDOW행 안(PK 범위)만 본다. 그보다 오래된 수집 오류는 이 목록에 없다(대가).
 */
@Injectable()
export class OpsErrorsService {
  constructor(private readonly em: EntityManager) {}

  async recent(limit: number): Promise<OpsErrorView[]> {
    const em = this.em.fork();
    const desc = { orderBy: { id: 'desc' as const }, limit };
    // findOne은 빈 조건({})을 거절한다(MikroORM validateEmptyWhere) — 가장 큰 id 한 행은 find + limit 1로
    const [last] = await em.find(SyncRun, {}, { orderBy: { id: 'desc' }, limit: 1, fields: ['id'] });
    const [syncRuns, vanRuns, reports, outbox] = await Promise.all([
      last ? em.find(SyncRun, { outcome: 'ERROR', id: { $gt: last.id - SYNC_RUN_SCAN_WINDOW } }, desc) : Promise.resolve([]),
      em.find(VanReconciliationRun, { status: VanRunStatus.FAILED }, desc),
      em.find(WeeklyReport, { lastError: { $ne: null } }, { ...desc, exclude: ['file'] }),
      em.find(OutboxEvent, { status: OutboxStatus.FAILED }, desc),
    ]);
    const rows: OpsErrorView[] = [
      ...syncRuns.map((r) => ({
        source: 'SYNC_RUN' as const,
        id: r.id,
        at: r.startedAt.toISOString(),
        title: `택배 수집 실패 — ${r.job}${r.shipment ? ` 운송장 #${r.shipment.id}` : ''}, ${r.attempt}번째 시도`,
        message: clip(r.detail),
      })),
      ...vanRuns.map((r) => ({
        source: 'VAN_RUN' as const,
        id: r.id,
        at: (r.finishedAt ?? r.startedAt).toISOString(),
        title: `VAN 대조 #${r.id} 실패 — ${r.trigger === 'SCHEDULED' ? '주기 실행' : `${r.requestedBy} 실행`}`,
        message: clip(r.error),
      })),
      ...reports.map((r) => ({
        source: 'WEEKLY_REPORT' as const,
        id: r.id,
        at: (r.generatedAt ?? r.createdAt).toISOString(),
        title: `주간 리포트 ${r.weekStart} 주 보내기 실패 — ${r.status}, ${r.attempts}번 시도`,
        message: clip(r.lastError),
      })),
      ...outbox.map((r) => ({
        source: 'OUTBOX' as const,
        id: r.id,
        at: r.createdAt.toISOString(),
        title: `알림 #${r.id} 보내기 실패 — ${r.type}, ${r.attempts}번 시도`,
        message: clip(r.lastError),
      })),
    ];
    // 같은 시각이면 출처·id 순으로 정해 두어 목록이 매번 같게
    return rows.sort((a, b) => b.at.localeCompare(a.at) || a.source.localeCompare(b.source) || b.id - a.id).slice(0, limit);
  }
}
```

`apps/api/src/ops/ops.controller.ts`:

```ts
import { Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type { OpsErrorView, OpsOutboxView, OpsQueuesView, OpsSchedulerView, OpsSystemView } from '@terminal-ops/contracts';
import { OPS_VIEW, Roles } from '../auth/access.js';
import { OpsErrorsService } from './ops-errors.service.js';
import { OpsOutboxService } from './ops-outbox.service.js';
import { OpsQueuesService } from './ops-queues.service.js';

/** 최근 업무 오류 몇 건(합친 뒤 limit개) */
export class RecentErrorsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 30;
}

/**
 * 운영 관제 API(보강 6, decisions/0070). 관제 화면(apps/console)이 부른다. 보기는 관제·ADMIN(OPS_VIEW), 관제 작업은 관제(MONITOR)만.
 * 모두 그때그때 읽는다(캐시 없음) — 화면이 10초마다 다시 부르므로 한 번 읽기가 가벼워야 한다(큐마다 Redis 명령 몇 개, 표마다 인덱스 읽기 몇 번).
 */
@Controller('ops')
export class OpsController {
  constructor(
    private readonly queues: OpsQueuesService,
    private readonly outbox: OpsOutboxService,
    private readonly errors: OpsErrorsService,
  ) {}

  /** 큐마다 상태별 수·멈춤·가장 오래 기다린 job·최근 15분 처리량·워커 수 */
  @Get('queues')
  @Roles(...OPS_VIEW)
  queueSummary(): Promise<OpsQueuesView> {
    return this.queues.summary();
  }

  /** 주기 작업(코드 목록 + Redis 등록 상태·다음 실행 시각) */
  @Get('schedulers')
  @Roles(...OPS_VIEW)
  schedulers(): Promise<OpsSchedulerView[]> {
    return this.queues.schedulers();
  }

  /** api 프로세스 정보, MySQL·Redis 응답 시간, 큐를 처리하는 워커 */
  @Get('system')
  @Roles(...OPS_VIEW)
  system(): Promise<OpsSystemView> {
    return this.queues.system();
  }

  /** Outbox 상태별 수, 가장 오래된 PENDING·QUEUED */
  @Get('outbox')
  @Roles(...OPS_VIEW)
  outboxSummary(): Promise<OpsOutboxView> {
    return this.outbox.summary();
  }

  /** 최근 업무 오류(수집 실패·VAN 대조 실패·주간 리포트 보내기 실패·알림 실패) 한 목록, 최근부터 */
  @Get('errors')
  @Roles(...OPS_VIEW)
  recentErrors(@Query() query: RecentErrorsQuery): Promise<OpsErrorView[]> {
    return this.errors.recent(query.limit);
  }
}
```

`apps/api/src/ops/ops.module.ts`와 앱 모듈:

```ts
import { Module } from '@nestjs/common';
import { OpsController } from './ops.controller.js';
import { OpsErrorsService } from './ops-errors.service.js';
import { OpsOutboxService } from './ops-outbox.service.js';
import { OpsQueuesService } from './ops-queues.service.js';

/** 운영 관제(보강 6, decisions/0070). 큐는 전역 QueuesModule, Redis는 전역 RedisModule의 것을 쓴다 */
@Module({
  controllers: [OpsController],
  providers: [OpsQueuesService, OpsOutboxService, OpsErrorsService],
})
export class OpsModule {}
```

```diff
diff --git a/apps/api/src/app.module.ts b/apps/api/src/app.module.ts
index accb9e0..dc0caf8 100644
--- a/apps/api/src/app.module.ts
+++ b/apps/api/src/app.module.ts
@@ -28,6 +28,7 @@ import { MeModule } from './me/me.module.js';
 import { FieldModule } from './field/field.module.js';
 import { AdminModule } from './admin/admin.module.js';
 import { PartnerApiModule } from './partner-api/partner-api.module.js';
+import { OpsModule } from './ops/ops.module.js';
 
 export interface AppOptions {
   /** 큐 job을 처리할지(RUN_WORKERS) */
@@ -62,6 +63,7 @@ export interface AppOptions {
     FieldModule,
     AdminModule,
     PartnerApiModule,
+    OpsModule,
   ],
   controllers: [HealthController],
   providers: [
```

- [ ] **Step 5: 통과 확인과 전체 api**

```bash
cd apps/api
npx vitest run test/unit/access-table.spec.ts test/unit/queue-metrics.spec.ts test/unit/contract-drift.spec.ts test/ops-status.e2e.spec.ts test/ops-outbox-errors.e2e.spec.ts
npm run typecheck
# 테스트 DB를 새로 만든 뒤(안전 규칙) 전체 — 약 6분
npx vitest run > /tmp/ops-t1-api.log 2>&1; grep -E "Test Files|Tests |Duration" /tmp/ops-t1-api.log; grep -c "Connection is closed" /tmp/ops-t1-api.log
```

Expected: 다섯 파일 `Test Files  5 passed (5)`, `Tests  23 passed (23)`. typecheck 출력 없음(exit 0). 전체 `Test Files  86 passed (86)`·`Tests  584 passed (584)`(사전 검증 Duration 335.82s), `Connection is closed` 0. 기존 테스트는 고치지 않았다(접근 표에 다섯 줄만). contracts만 늘었으므로 admin·merchant·field `npm run build`(tsc 포함)도 그대로 통과한다.

- [ ] **Step 6: 기록**

`docs/decisions/0070-운영-관제-API는-ops-아래-그때그때-읽기와-관제만의-작업.md`:

````markdown
# 0070. 운영 관제 API는 /ops 아래, 그때그때 읽기와 관제만의 작업

- 날짜 / 관련 기능: 2026-10-29 / 보강 6, F3·F5·F9·F11, 운영 관제
- 상황: 관제·개발자가 큐·주기 작업·워커·Outbox·업무 오류를 보고, 실패한 job을 다시 돌릴 화면이 필요하다(스펙 `docs/specs/2026-10-29-ops-console.md`). 지금은 `redis-cli`와 DB를 직접 본다. 화면이 띄워진 채 10초마다 다시 부른다(decisions/0076). 정할 것: 경로·역할, 캐시, 실패 목록 쪽 나누기, 작업의 HTTP 모양, 업무 오류를 어디서 읽나.
- 선택지:
  1. 기존 컨트롤러에 흩어 넣기(`GET /sync-runs`처럼 기능마다) — 경로는 자연스럽지만 큐·워커·주기 작업은 어느 기능에도 속하지 않는다
  2. **`/ops` 아래 한 모듈(`src/ops/`)** — 관제 화면 하나가 부르는 것이 한 곳에. 기존 모듈은 읽기만 한다(복구 sweep은 `OutboxService.requeueStale` 그대로)
  3. bull-board 같은 기성 대시보드를 붙이기 — 화면이 빨리 생기지만 로그인·역할(decisions/0050·0052)·감사 기록과 따로 놀고, 새 의존성이다. 학습 목적(BullMQ API를 직접 읽기)에도 맞지 않다
- 결정: 2.
  - 역할: 보기 다섯 + 실패 목록 + 감사 기록은 관제·ADMIN(`OPS_VIEW`), 관제 작업(다시 시도·지우기·복구 sweep — Task 2)은 MONITOR만. 운영자는 업무 쓰기 담당이라 관제 화면을 쓰지 않는다. ADMIN은 업무를 읽기만 한다는 0052의 규칙대로 보기만
  - 캐시 없음: 한 번 읽기가 큐마다 Redis 명령 여섯(getJobCounts·isPaused·getJobs·getMetrics×2·getWorkers)이고 Outbox는 `(status, id)` 인덱스로 상태마다 count 하나라 가볍다. 대시보드(0044)처럼 Redis 캐시를 두면 "지금"을 보려는 화면이 최대 TTL만큼 늦는다. 관제 화면을 여는 사람은 몇 명이다
  - 최근 업무 오류는 **새 표 없이** 오류를 이미 남기는 네 곳을 읽어 합친다 — 수집 기록(`sync_run.outcome = 'ERROR'`), VAN 대조 실행(FAILED), 주간 리포트(`lastError`가 있는 행 — 보내면 비워진다), Outbox(FAILED). 출처마다 최근 limit개를 읽어 시각 순으로 합쳐 limit개. 이상 단말기 찾기는 실행 기록 표가 없어(Redis 잠금만, 0034) 빠진다
  - `sync_run`은 job 실행마다 한 행이라 가장 크고 `outcome`에 인덱스가 없다 — 가장 큰 id에서 1만 행 안(PK 범위)에서만 찾는다(`SYNC_RUN_SCAN_WINDOW`). 인덱스를 더하면(0045처럼) 수집마다 쓰기가 는다
  - (Task 2) 실패 job 목록은 offset(`start`·`limit`, 최대 100) — BullMQ 실패 목록은 끝난 시각 정렬 집합이라 키셋으로 쓸 id 순서가 없다. 감사 기록은 다른 목록처럼 beforeId 키셋(0039)
  - (Task 2) 관제 작업은 `POST /ops/queues/:name/jobs/:id/retry`·`/remove`, `POST /ops/outbox/requeue` — 지우기도 DELETE가 아니라 POST다. 화면 api 클라이언트(점주 앱 사본, 0062)가 GET·POST만 받는다(DELETE를 쓰려면 사본 셋을 함께 고쳐야 한다). 둘 다 "감사 기록을 남기는 명령"이라 같은 모양으로 둔다
- 결과·대가: 엔드포인트 72 → 77(Task 1) → 82(Task 2, 접근 표 테스트가 센 값 — 0052 보탬). 화면을 띄운 사람 수 × 10초마다 큐 여섯의 Redis 명령 약 36개 + MySQL count 넷·find 다섯. 수집 오류가 1만 행보다 오래되면 최근 오류에서 빠진다(그때는 어드민 "배치 실행 이력"으로 본다). 업무 오류의 시각은 표마다 다르다(수집은 시작, VAN은 끝, 주간 리포트는 파일 만든 시각, Outbox는 행 만든 시각 — 실패 시각 열이 없다).
- 다시 볼 조건: 관제 화면을 여럿이 오래 띄워 Redis 명령이 눈에 띄면 서버에서 몇 초 캐시. 업무 오류 출처가 다섯을 넘거나 실패 시각이 중요해지면 오류 표 하나(쓰는 곳마다 한 줄)를 둔다.
````

`docs/decisions/0071-워커-생존은-BullMQ-워커-연결과-이름-처리량은-워커-metrics.md`:

````markdown
# 0071. 워커가 살아 있나는 BullMQ 워커 연결과 이름으로, 처리량은 워커 metrics로

- 날짜 / 관련 기능: 2026-10-29 / 보강 6, 운영 관제
- 상황: 관제 화면에 "이 큐를 처리하는 워커가 있나"와 "최근 몇 분 동안 몇 개를 처리했나"가 있어야 한다. api는 워커를 같은 프로세스(RUN_WORKERS=1)나 따로 띄운 워커 프로세스(`dist/worker.js`)에서 돌린다(0015). 이 시스템의 job은 거의 다 끝나면 지워진다(`removeOnComplete`) — Redis의 completed 수로는 처리량을 셀 수 없다.
- 사전 검증(BullMQ 6.4.0, 테스트 접두사): 이름을 준 워커를 띄우면 `queue.getWorkers()`가 `[{ rawname: '<접두사>:<큐 base64>:w:<이름>', idle, … }]`를 주고, 워커를 닫으면 0이 된다. `metrics: { maxDataPoints }`를 준 워커는 job이 끝날 때마다 `getMetrics('completed'|'failed')`의 `meta.count`를 올린다 — 막 끝난 job 2개는 `data: []`, `meta: { count: 2, prevCount: 0 }`(마지막 갱신 분의 수는 아직 data에 없고 count − prevCount다). job을 지워도(`removeOnComplete`) 센다.
- 선택지(생존):
  1. **BullMQ 워커 연결(`getWorkers` — Redis `CLIENT LIST`의 연결 이름)** — 워커가 블로킹 연결을 쥐고 있는 동안만 보인다. 프로세스가 죽으면 연결이 끊겨 바로 사라진다. 코드는 `@Processor` 옵션에 `name` 한 줄
  2. 워커 하트비트 키(`ops:worker:<이름>`, N초마다 SET EX) — 관리형 Redis처럼 `CLIENT` 명령이 막혀도 된다. 대신 타이머·키 이름 규칙·만료를 직접 만들고, 이벤트 루프가 멈춘(살아 있지만 처리 못 하는) 워커도 하트비트가 끊길 때까지 산 것으로 보인다 — 1과 같은 한계에 코드가 는다
  3. 마지막 처리 시각(`getMetrics`의 prevTS)으로 추정 — 할 일이 없는 큐(밤의 report)는 오래 조용한 것이 정상이라 죽음과 구분이 안 된다
- 선택지(처리량): (a) **워커 metrics** — 워커 옵션 한 줄, Redis에 큐마다 분 단위 목록 두 개(1,440칸 = 하루) (b) 처리할 때마다 우리 카운터를 INCR — 프로세서마다 코드가 든다 (c) `sync_run`처럼 DB 기록 — 큐 하나(택배 추적)에만 있다
- 결정: 생존 1, 처리량 (a). 모든 `@Processor`에 `WORKER_OBSERVABILITY = { name: env.workerName, metrics: { maxDataPoints: 1440 } }`(`src/queue/worker-options.ts`)를 펼쳐 넣는다. 워커 이름은 이미 있는 `WORKER_NAME`(없으면 `pid-<pid>`, SyncRun에도 남는 값)이다. "최근 15분"은 `recentCount`(`src/ops/queue-metrics.ts`)가 metrics를 지금 시각으로 잘라 센다 — BullMQ는 job이 끝날 때만 metrics를 갱신해, 한동안 끝난 job이 없으면 data가 그때에 멈춰 있다(그대로 더하면 옛 수를 "최근"으로 센다). 기록이 한 번도 없으면 null(화면 '-').
  - api 버전은 `APP_VERSION` env(없으면 `dev`) — Docker로 띄울 때(보강 9) 넣는다. 기동 시각은 `process.uptime()`으로 계산한다(그 api 프로세스 것 — 따로 띄운 워커 프로세스의 기동 시각은 보이지 않는다)
- 결과·대가: CLIENT 명령을 막은 Redis(일부 관리형)에서는 BullMQ가 이름 없는 항목 하나를 줘 "이름 없는 워커 1"로 보인다 — 이 프로젝트의 Docker Redis는 된다. 연결이 살아 있어도 처리기가 멈춘 워커(무한 루프 등)는 산 것으로 보인다(처리량 0·대기 증가로 알아챈다). metrics는 큐마다 Redis 목록 두 개(각 최대 1,440칸)를 더 쓴다. 워커 옵션은 데코레이터 인자라 env를 모듈을 읽을 때 한 번 읽는다(테스트는 파일마다 새로 읽는다).
- 다시 볼 조건: 관리형 Redis로 옮기거나, 멈춘 워커를 자동으로 알아채야 하면 2(하트비트 + 처리 진행 시각). 처리량 그래프가 필요하면 metrics data를 그대로 내려준다.
````

`docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md` — 표에서 `| FIELD(보강 4, 0063) | …` 줄 뒤에 한 줄을 넣고(Edit 도구), 역할 묶음 줄(`- 역할 묶음(…)`)의 `` `ANY_ROLE` = 다섯 모두.`` 앞에 `` `OPS_VIEW` = ADMIN·MONITOR(보강 6), ``를 넣는다:

```markdown
  | OPS_VIEW = ADMIN·MONITOR(보강 6, 0070) | `GET /ops/queues`, `GET /ops/schedulers`, `GET /ops/system`, `GET /ops/outbox`, `GET /ops/errors` |
```

같은 파일 끝(마지막 줄 `- 보강 5 보탬(decisions/0066): …` 뒤)에 한 줄:

```markdown
- 보강 6 보탬(decisions/0070): 운영 관제 읽기 다섯(`/ops/queues·schedulers·system·outbox·errors`)을 관제·ADMIN(`OPS_VIEW`)으로 더해 엔드포인트 72 → 77(접근 표 테스트가 센 값). 운영자·현장 작업자는 403 — 관제 화면은 관제·개발자용이다.
```

`docs/study/backlog.md` 끝에 두 줄:

```markdown
- [ ] BullMQ metrics의 저장 모양(`meta.count`·`prevTS`·`prevCount`와 분 단위 data)과 갱신 시점 — 왜 "마지막 갱신 분"의 수는 data에 없나 (apps/api/src/ops/queue-metrics.ts, decisions/0071)
- [ ] Redis `CLIENT LIST`·`CLIENT SETNAME`과 BullMQ `getWorkers` — 블로킹 연결이 살아 있다는 것이 워커가 살아 있다는 것과 어디까지 같나 (apps/api/src/ops/ops-queues.service.ts, decisions/0071)
```

devlog — `docs/devlog/2026-10-29.md`의 `## HH:MM 보강 6 계획 작성` 항목 뒤에:

```markdown
## HH:MM Task 1 관제 읽기 API — 큐 요약·주기 작업·프로세스 상태·Outbox·최근 오류, 워커 이름·metrics (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <계획 커밋 해시> (docs: 보강 6 계획 — 운영 관제 화면)
- 한 일: api `src/ops/` — `GET /ops/queues`(큐마다 상태별 수·멈춤·가장 오래 기다린 job·최근 15분 완료/실패·워커 수), `/ops/schedulers`(코드 목록 + Redis 등록·다음 실행), `/ops/system`(api 버전·기동 시각, MySQL·Redis 응답 시간, 워커), `/ops/outbox`(상태별 수·가장 오래된 PENDING/QUEUED), `/ops/errors`(수집·VAN·주간 리포트·Outbox 오류를 시각 순으로). 모든 `@Processor`에 워커 이름·분 단위 metrics(`WORKER_OBSERVABILITY`). contracts `ops.ts`, enum 단언 둘(큐 이름·Outbox 상태). 접근 표 72 → 77
- 확인: 새 테스트 10개 실패(404, 모듈 없음, 표 72/77) → 통과(5파일 <수>개). api 전체 `Test Files  <수> passed (<수>)`, `Tests  <수> passed (<수>)`, Duration <초>, `Connection is closed` <수>. typecheck 0
- 결정: decisions/0070(API 모양 — /ops, 캐시 없음, 최근 오류는 기존 기록 합침), 0071(워커 생존·처리량), 0052 표·보탬
- 커밋 규칙(보강 6): `type(ops): 요약`, Outbox 복구는 `ops, F5`, 본문 `Refs:`, 마지막 줄 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 다음: Task 2 관제 작업 API(실패 job·다시 시도·지우기·복구 sweep·감사 기록)
```

```bash
node scripts/docs-index.mjs
```

- [ ] **Step 7: 커밋**

```bash
git add packages/contracts apps/api docs
git status --short   # node_modules·dist가 없어야 한다
git commit -m "$(cat <<'EOF'
feat(ops): 운영 관제 읽기 API — 큐 요약·주기 작업·프로세스 상태·Outbox·최근 오류, 워커 이름·metrics

Refs: docs/decisions/0070-운영-관제-API는-ops-아래-그때그때-읽기와-관제만의-작업.md, docs/decisions/0071-워커-생존은-BullMQ-워커-연결과-이름-처리량은-워커-metrics.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 제목 시각 = 커밋 시각(`git log -1 --format=%cd --date=format:%H:%M`)인지 보고, 다르면 고쳐 `git commit --amend --no-edit`.

---


### Task 2: 관제 작업 API — 실패 job 목록·다시 시도·지우기, Outbox 복구 sweep, 감사 기록

**Files:**
- Modify: `packages/contracts/src/ops.ts`, `packages/contracts/src/errors.ts`
- Create: `apps/api/src/ops/job-data.ts`, `apps/api/src/ops/ops-action-log.entity.ts`, `apps/api/src/ops/ops-audit.service.ts`, `apps/api/src/ops/ops-jobs.service.ts`
- Modify: `apps/api/src/ops/ops-queues.service.ts`, `apps/api/src/ops/ops-outbox.service.ts`, `apps/api/src/ops/ops.controller.ts`, `apps/api/src/ops/ops.module.ts`, `apps/api/src/entities.ts`, `apps/api/src/common/contract-assertions.ts`
- Create(생성 명령): `apps/api/src/migrations/Migration<시각>.ts`, Modify: `apps/api/src/migrations/.snapshot-terminal_ops.json`
- Test: Create `apps/api/test/ops-jobs.e2e.spec.ts`, `apps/api/test/unit/job-data.spec.ts`; Modify `apps/api/test/ops-outbox-errors.e2e.spec.ts`, `apps/api/test/unit/access-table.spec.ts`
- Docs: Create `docs/decisions/0072-실패-job은-Redis에-남은-것만-data는-가리고-다시-시도는-시도-수를-되돌린다.md`, `docs/decisions/0073-관제-작업-감사-기록은-새-표-ops_action_log.md`; Modify `docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md`, `docs/study/backlog.md`, `docs/index.md`, `docs/devlog/2026-10-29.md`

- [ ] **Step 1: 실패하는 테스트**

`apps/api/test/unit/job-data.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MASK, redactJobData, shortReason } from '../../src/ops/job-data.js';

describe('실패 job data 가리기 (decisions/0072)', () => {
  it('지금 큐에 들어가는 data(id·시리얼·주 시작일)는 그대로 보인다', () => {
    for (const data of [{ shipmentId: 3 }, { outboxId: 12 }, { serialNo: 'SN1-0001' }, { runId: 7 }, { weekStart: '2026-10-19' }, {}]) {
      expect(redactJobData(data)).toEqual(data);
    }
  });

  it('비밀·개인정보처럼 보이는 이름의 값은 깊이와 상관없이 가린다(대소문자 무시)', () => {
    expect(
      redactJobData({ password: 'p', apiKey: 'k', Authorization: 'Bearer x', nested: { phoneNo: '010', list: [{ sessionId: 's', ok: 1 }] } }),
    ).toEqual({ password: MASK, apiKey: MASK, Authorization: MASK, nested: { phoneNo: MASK, list: [{ sessionId: MASK, ok: 1 }] } });
  });

  it('긴 글자는 100자로 자르고, 긴 목록은 20개까지, 너무 깊은 것은 [깊음]', () => {
    expect(redactJobData({ text: 'x'.repeat(101) })).toEqual({ text: `${'x'.repeat(100)}…(101자)` });
    expect((redactJobData({ ids: Array.from({ length: 25 }, (_, i) => i) }).ids as unknown[]).slice(-2)).toEqual([19, '…외 5개']);
    expect(redactJobData({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: { d: '[깊음]' } } } });
  });

  it('객체가 아닌 data는 { value }로, 없으면 빈 객체. 실패 이유는 500자까지', () => {
    expect(redactJobData(null)).toEqual({});
    expect(redactJobData(undefined)).toEqual({});
    expect(redactJobData('글자')).toEqual({ value: '글자' });
    expect(redactJobData([1, 2])).toEqual({ value: [1, 2] });
    expect(shortReason('e'.repeat(600))).toBe(`${'e'.repeat(500)}…`);
    expect(shortReason(undefined)).toBe('');
  });
});
```

`apps/api/test/ops-jobs.e2e.spec.ts`(앱은 워커 없이 띄우고, 이 파일이 report 큐(테스트 접두사)에 직접 워커를 붙여 실패를 실제로 만든다 — `failNow`가 true면 던진다):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import { Worker, type Job, type Queue } from 'bullmq';
import { env } from '../src/config/env.js';
import { OpsActionLog } from '../src/ops/ops-action-log.entity.js';
import { QUEUE } from '../src/queue/queue-names.js';
import { resetQueues, waitFor } from './helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const MONITOR = { 'X-Operator': 'mon', 'X-Test-Role': 'MONITOR' };
const ADMIN = { 'X-Operator': 'adm', 'X-Test-Role': 'ADMIN' };
const OPERATOR = { 'X-Operator': 'op', 'X-Test-Role': 'OPERATOR' };

/**
 * 실패 job 보기·다시 시도·지우기와 감사 기록(보강 6, decisions/0072·0073).
 * 앱은 워커 없이 띄우고, 이 파일이 report 큐(test- 접두사)에 직접 워커를 붙여 실패를 실제로 만든다 — failNow가 true면 던진다.
 */
describe('실패 job과 관제 작업 /ops/queues/:name/failed·retry·remove, /ops/actions (보강 6)', () => {
  let t: TestApp;
  let queue: Queue;
  let worker: Worker;
  let failNow = true;
  let sendJob: Job;
  let vanJob: Job;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    queue = t.app.get<Queue>(getQueueToken(QUEUE.REPORT));
    worker = new Worker(
      QUEUE.REPORT,
      async (job) => {
        if (failNow) throw new Error(`톡톡메신저 503: ${job.name}`);
        return 'ok';
      },
      { connection: { host: env.redis.host, port: env.redis.port }, prefix: env.queuePrefix },
    );
    // 실패를 남기는 job 둘. 비밀처럼 보이는 이름의 값과 긴 글자를 data에 넣어 가리기를 본다
    sendJob = await queue.add(
      'weekly-report-send',
      { weekStart: '2026-10-19', apiToken: 'tok-123', note: '가'.repeat(150) },
      { attempts: 2, backoff: { type: 'fixed', delay: 10 }, removeOnFail: 100 },
    );
    await waitFor(async () => (await sendJob.getState()) === 'failed', { message: '보내기 job 실패' });
    vanJob = await queue.add('van-reconcile', { runId: 7 }, { jobId: 'van-run-7', attempts: 1, removeOnFail: 100 });
    await waitFor(async () => (await vanJob.getState()) === 'failed', { message: 'VAN job 실패' });
  });
  afterAll(async () => {
    await worker.close();
    await resetQueues(t.app);
    await t.app.close();
  });

  it('실패 job 목록: 최근 실패부터, 실패 이유·시도 수, data는 비밀처럼 보이는 이름을 가리고 긴 글자를 자른다', async () => {
    const res = await t.http(MONITOR).get(`/ops/queues/${QUEUE.REPORT}/failed`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, start: 0, limit: 20 });
    expect(res.body.items.map((j: { id: string }) => j.id)).toEqual(['van-run-7', sendJob.id]);
    expect(res.body.items[1]).toEqual({
      queue: 'report',
      id: sendJob.id,
      name: 'weekly-report-send',
      data: { weekStart: '2026-10-19', apiToken: '[가림]', note: `${'가'.repeat(100)}…(150자)` },
      failedReason: '톡톡메신저 503: weekly-report-send',
      attemptsMade: 2,
      maxAttempts: 2,
      createdAt: new Date(sendJob.timestamp).toISOString(),
      failedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(JSON.stringify(res.body)).not.toContain('tok-123');
    // 쪽 나누기(start·limit), ADMIN도 본다
    const second = await t.http(ADMIN).get(`/ops/queues/${QUEUE.REPORT}/failed`).query({ start: 1, limit: 1 });
    expect(second.body).toMatchObject({ total: 2, start: 1, limit: 1, items: [{ id: sendJob.id }] });
    // 실패가 없는 큐는 빈 목록, 없는 큐 이름은 404, limit 범위 밖은 400
    expect((await t.http(MONITOR).get(`/ops/queues/${QUEUE.DEVICE}/failed`)).body).toEqual({ items: [], total: 0, start: 0, limit: 20 });
    expect((await t.http(MONITOR).get('/ops/queues/no-such-queue/failed')).status).toBe(404);
    expect((await t.http(MONITOR).get(`/ops/queues/${QUEUE.REPORT}/failed`).query({ limit: 101 })).status).toBe(400);
  });

  it('다시 시도는 관제만: ADMIN·운영자 403. 관제가 하면 시도 수를 되돌려 다시 처리되고, 다시 하면 409 JOB_NOT_FAILED', async () => {
    expect((await t.http(ADMIN).post(`/ops/queues/${QUEUE.REPORT}/jobs/${sendJob.id}/retry`)).status).toBe(403);
    expect((await t.http(OPERATOR).post(`/ops/queues/${QUEUE.REPORT}/jobs/${sendJob.id}/retry`)).status).toBe(403);

    failNow = false;
    const res = await t.http(MONITOR).post(`/ops/queues/${QUEUE.REPORT}/jobs/${sendJob.id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ queue: 'report', jobId: sendJob.id, action: 'RETRY_JOB', actionId: expect.any(Number) });
    await waitFor(async () => (await queue.getJobState(sendJob.id!)) === 'completed', { message: '다시 시도한 job 완료' });

    const again = await t.http(MONITOR).post(`/ops/queues/${QUEUE.REPORT}/jobs/${sendJob.id}/retry`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('JOB_NOT_FAILED');
    expect((await t.http(MONITOR).post(`/ops/queues/${QUEUE.REPORT}/jobs/no-such-job/retry`)).status).toBe(404);
    expect((await t.http(MONITOR).post(`/ops/queues/no-such-queue/jobs/${sendJob.id}/retry`)).status).toBe(404);
    expect((await t.http(MONITOR).get(`/ops/queues/${QUEUE.REPORT}/failed`)).body.total).toBe(1);
  });

  it('지우기도 관제만: 실패 job이 Redis에서 사라지고, 다시 지우면 404', async () => {
    expect((await t.http(ADMIN).post(`/ops/queues/${QUEUE.REPORT}/jobs/van-run-7/remove`)).status).toBe(403);
    const res = await t.http(MONITOR).post(`/ops/queues/${QUEUE.REPORT}/jobs/van-run-7/remove`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ jobId: 'van-run-7', action: 'REMOVE_JOB' });
    expect(await queue.getJob('van-run-7')).toBeUndefined();
    expect((await t.http(MONITOR).post(`/ops/queues/${QUEUE.REPORT}/jobs/van-run-7/remove`)).status).toBe(404);
    expect((await t.http(MONITOR).get(`/ops/queues/${QUEUE.REPORT}/failed`)).body).toMatchObject({ total: 0, items: [] });
  });

  it('감사 기록: 성공한 작업만 최근부터 — 누가(아이디·역할)·무엇을(큐·job·그때의 실패 이유). 403·404·409는 남지 않는다', async () => {
    const res = await t.http(ADMIN).get('/ops/actions');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toEqual({
      id: expect.any(Number),
      action: 'REMOVE_JOB',
      actor: 'mon',
      actorRole: 'MONITOR',
      queue: 'report',
      jobId: 'van-run-7',
      jobName: 'van-reconcile',
      detail: { failedReason: '톡톡메신저 503: van-reconcile', attemptsMade: 1, failedAt: expect.stringMatching(/^\d{4}-/) },
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(res.body.items[1]).toMatchObject({ action: 'RETRY_JOB', actor: 'mon', jobId: sendJob.id, jobName: 'weekly-report-send', detail: { attemptsMade: 2 } });
    const first = await t.http(MONITOR).get('/ops/actions').query({ limit: 1 });
    expect(first.body.nextBeforeId).toBe(first.body.items[0].id);
    expect((await t.http(MONITOR).get('/ops/actions').query({ beforeId: first.body.nextBeforeId })).body.items.map((a: { action: string }) => a.action)).toEqual(['RETRY_JOB']);
    expect(await t.orm.em.fork().count(OpsActionLog)).toBe(2);
    expect((await t.http(OPERATOR).get('/ops/actions')).status).toBe(403);
  });
});
```

`apps/api/test/ops-outbox-errors.e2e.spec.ts`(복구 sweep 테스트 하나와 그에 필요한 import·큐):

```diff
diff --git a/apps/api/test/ops-outbox-errors.e2e.spec.ts b/apps/api/test/ops-outbox-errors.e2e.spec.ts
index 367f3ed..569e477 100644
--- a/apps/api/test/ops-outbox-errors.e2e.spec.ts
+++ b/apps/api/test/ops-outbox-errors.e2e.spec.ts
@@ -1,5 +1,10 @@
 import { afterAll, beforeAll, describe, expect, it } from 'vitest';
+import { getQueueToken } from '@nestjs/bullmq';
+import type { Queue } from 'bullmq';
+import { OpsActionLog } from '../src/ops/ops-action-log.entity.js';
 import { OUTBOX_TYPE, OutboxEvent, OutboxStatus } from '../src/outbox/outbox-event.entity.js';
+import { idempotencyKeyOf } from '../src/outbox/outbox.service.js';
+import { QUEUE } from '../src/queue/queue-names.js';
 import { WeeklyReport, WeeklyReportStatus } from '../src/report/weekly-report.entity.js';
 import { SyncRun } from '../src/shipment/shipment.entities.js';
 import { VanReconciliationRun, VanRunStatus, VanRunTrigger } from '../src/van/van.entities.js';
@@ -10,11 +15,13 @@ const MONITOR = { 'X-Operator': 'mon', 'X-Test-Role': 'MONITOR' };
 const ADMIN = { 'X-Operator': 'adm', 'X-Test-Role': 'ADMIN' };
 
 /**
- * Outbox 요약과 최근 업무 오류(보강 6, decisions/0070·0042).
+ * Outbox 요약·복구 sweep 수동 실행과 최근 업무 오류(보강 6, decisions/0070·0042·0073).
  * 워커 없는 앱이라 행을 직접 넣는다 — 만든 시각을 정해 두고 상태별 수·가장 오래된 행·오류 순서를 본다.
+ * 넣은 notify job은 waiting에 그대로 남는다 — 행만 QUEUED로 넣어 "job이 사라진 QUEUED 행"을 만든다(outbox-requeue 테스트와 같은 방법).
  */
-describe('Outbox 요약 /ops/outbox, 최근 업무 오류 /ops/errors (보강 6)', () => {
+describe('Outbox 요약·복구 sweep /ops/outbox, 최근 업무 오류 /ops/errors (보강 6)', () => {
   let t: TestApp;
+  let queue: Queue;
   const em = () => t.orm.em.fork();
   const now = Date.now();
   /** 만든 시각을 정해 행을 넣는다(datetime(0) 열이 있어 초 단위로 맞춘다) */
@@ -25,6 +32,7 @@ describe('Outbox 요약 /ops/outbox, 최근 업무 오류 /ops/errors (보강 6)
     t = await createTestApp();
     await resetDatabase(t.orm);
     await resetQueues(t.app);
+    queue = t.app.get<Queue>(getQueueToken(QUEUE.OUTBOX));
     const e = em();
     const payload = { serialNo: 'OPS-1', fromStatus: 'IN_STOCK', toStatus: 'ALLOCATED', actor: 'kim', reason: 'r' };
     const row = (status: OutboxStatus, createdAt: Date, extra: Partial<OutboxEvent> = {}) =>
@@ -70,6 +78,22 @@ describe('Outbox 요약 /ops/outbox, 최근 업무 오류 /ops/errors (보강 6)
     });
   });
 
+  it('복구 sweep 수동 실행은 관제만: 만든 지 1분 지난 QUEUED 중 job이 없는 행에 같은 jobId로 다시 넣고 감사 기록을 남긴다', async () => {
+    expect((await t.http(ADMIN).post('/ops/outbox/requeue')).status).toBe(403);
+    expect((await t.http({ 'X-Operator': 'op', 'X-Test-Role': 'OPERATOR' }).post('/ops/outbox/requeue')).status).toBe(403);
+
+    const res = await t.http(MONITOR).post('/ops/outbox/requeue');
+    expect(res.status).toBe(200);
+    expect(res.body).toEqual({ checked: 2, requeued: [ids.queuedOld, ids.queuedOld + 1], actionId: expect.any(Number) });
+    expect(await queue.getJobState(idempotencyKeyOf(ids.queuedOld))).toBe('waiting');
+    // 다시 누르면 job이 있으니 넣지 않는다 — 그래도 누른 기록은 남는다
+    expect((await t.http(MONITOR).post('/ops/outbox/requeue')).body).toMatchObject({ checked: 2, requeued: [] });
+    const actions = (await t.http(MONITOR).get('/ops/actions')).body.items;
+    expect(actions.map((a: { action: string }) => a.action)).toEqual(['REQUEUE_OUTBOX', 'REQUEUE_OUTBOX']);
+    expect(actions[1]).toMatchObject({ actor: 'mon', actorRole: 'MONITOR', queue: null, jobId: null, detail: { checked: 2, requeuedCount: 2, requeued: [ids.queuedOld, ids.queuedOld + 1] } });
+    expect(await em().count(OpsActionLog)).toBe(2);
+  });
+
   it('최근 업무 오류: 수집 실패·VAN 대조 실패·주간 리포트 lastError·알림 실패를 시각 순으로 한 목록에(오류가 아닌 행은 빠진다)', async () => {
     const res = await t.http(MONITOR).get('/ops/errors');
     expect(res.status).toBe(200);
```

`apps/api/test/unit/access-table.spec.ts`(다섯 줄 더):

```diff
diff --git a/apps/api/test/unit/access-table.spec.ts b/apps/api/test/unit/access-table.spec.ts
index d59f4a6..46e9940 100644
--- a/apps/api/test/unit/access-table.spec.ts
+++ b/apps/api/test/unit/access-table.spec.ts
@@ -101,6 +101,11 @@ const EXPECTED: Record<string, string> = {
   'GET /ops/system': 'ADMIN,MONITOR',
   'GET /ops/outbox': 'ADMIN,MONITOR',
   'GET /ops/errors': 'ADMIN,MONITOR',
+  'GET /ops/queues/:name/failed': 'ADMIN,MONITOR',
+  'GET /ops/actions': 'ADMIN,MONITOR',
+  'POST /ops/queues/:name/jobs/:id/retry': 'MONITOR',
+  'POST /ops/queues/:name/jobs/:id/remove': 'MONITOR',
+  'POST /ops/outbox/requeue': 'MONITOR',
 
   // 외부 업체 키(scope별)
   'GET /partner/v1/terminals/:serialNo': 'partner:terminal-status:read',
```

- [ ] **Step 2: 실패 확인**

```bash
# 테스트 DB를 새로 만든 뒤(안전 규칙)
cd apps/api && npx vitest run test/unit/access-table.spec.ts test/unit/job-data.spec.ts test/ops-jobs.e2e.spec.ts test/ops-outbox-errors.e2e.spec.ts
```

Expected(사전 검증 원문 요약): `Test Files  4 failed (4)`, `Tests  2 failed | 1 passed (3)` —
- job-data: `Error: Cannot find module '../../src/ops/job-data.js'`(파일 전체)
- ops-jobs·ops-outbox-errors: `Error: Cannot find module '../src/ops/ops-action-log.entity.js'`(파일 전체 — 복구 sweep 테스트가 감사 기록 엔티티를 import한다)
- access-table 둘: `expected { …(77) } to deeply equal { …(82) }`, `expected 77 to be 82`

- [ ] **Step 3: 계약 타입**

```diff
diff --git a/packages/contracts/src/ops.ts b/packages/contracts/src/ops.ts
index e4f8b38..2f446b7 100644
--- a/packages/contracts/src/ops.ts
+++ b/packages/contracts/src/ops.ts
@@ -122,3 +122,67 @@ export interface OpsErrorView {
   /** 그 행에 남은 오류 글(500자까지) */
   message: string;
 }
+
+/**
+ * 실패한 job 하나(GET /ops/queues/:name/failed). Redis에 남은 실패만 보인다 — 끝나면 지우는 job(removeOnFail: true)의 실패는
+ * 업무 기록(outbox FAILED, 수집 기록 ERROR, 주간 리포트 lastError)으로 본다(GET /ops/errors, decisions/0072).
+ */
+export interface OpsFailedJobView {
+  queue: OpsQueueName;
+  /** BullMQ job id(주기 job은 `repeat:<id>:<시각>`) */
+  id: string;
+  name: string;
+  /** job data — 비밀·개인정보처럼 보이는 이름의 값은 '[가림]', 긴 글자는 자른다(decisions/0072) */
+  data: Record<string, unknown>;
+  /** 마지막 실패 이유(500자까지). 스택은 보내지 않는다 */
+  failedReason: string;
+  attemptsMade: number;
+  /** job 옵션의 최대 시도 수(없으면 1) */
+  maxAttempts: number;
+  createdAt: string;
+  failedAt: string | null;
+}
+
+/** 실패 job 목록 한 쪽(최근 실패부터 start번째부터 limit개). total = 이 큐의 실패 job 수 */
+export interface OpsFailedJobsPage {
+  items: OpsFailedJobView[];
+  total: number;
+  start: number;
+  limit: number;
+}
+
+/** 관제 작업 종류(감사 기록, decisions/0073) */
+export type OpsActionKind = 'RETRY_JOB' | 'REMOVE_JOB' | 'REQUEUE_OUTBOX';
+
+/** 관제 작업 한 건의 감사 기록(GET /ops/actions, 최근부터 beforeId 키셋) */
+export interface OpsActionView {
+  id: number;
+  action: OpsActionKind;
+  /** 로그인 아이디와 그때의 역할 */
+  actor: string;
+  actorRole: string;
+  queue: OpsQueueName | null;
+  jobId: string | null;
+  jobName: string | null;
+  /** 작업 때의 사정(job의 실패 이유·시도 수, sweep 결과 수) */
+  detail: Record<string, unknown> | null;
+  createdAt: string;
+}
+
+/** POST /ops/queues/:name/jobs/:id/retry·remove 응답 */
+export interface OpsJobActionResult {
+  queue: OpsQueueName;
+  jobId: string;
+  action: 'RETRY_JOB' | 'REMOVE_JOB';
+  /** 남긴 감사 기록 id */
+  actionId: number;
+}
+
+/** POST /ops/outbox/requeue — 멈춘 QUEUED 복구 sweep을 지금 한 번(주기 작업 outbox-requeue와 같은 일, decisions/0042) */
+export interface OpsRequeueResult {
+  /** 본 QUEUED 행 수(최대 100) */
+  checked: number;
+  /** notify job이 없어 다시 넣은 outbox id */
+  requeued: number[];
+  actionId: number;
+}
```

```diff
diff --git a/packages/contracts/src/errors.ts b/packages/contracts/src/errors.ts
index 7a25245..d10af3e 100644
--- a/packages/contracts/src/errors.ts
+++ b/packages/contracts/src/errors.ts
@@ -6,6 +6,7 @@
 /** 업무 규칙 충돌(409) — api BusinessError(409, …) */
 export type ConflictCode =
   | 'ANOMALY_SCAN_RUNNING'
+  | 'JOB_NOT_FAILED'
   | 'LAST_ADMIN'
   | 'REPLACEMENT_RESERVED'
   | 'ROLLOUT_ALREADY_ACTIVE'
```

- [ ] **Step 4: 감사 기록 표**

`apps/api/src/ops/ops-action-log.entity.ts`:

```ts
import { OptionalProps } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** 관제 작업 종류(contracts OpsActionKind와 같다 — contract-assertions.ts) */
export const OPS_ACTIONS = ['RETRY_JOB', 'REMOVE_JOB', 'REQUEUE_OUTBOX'] as const;
export type OpsAction = (typeof OPS_ACTIONS)[number];

/**
 * 관제 작업 감사 기록(보강 6, decisions/0073): 누가(로그인 아이디·역할) 언제 무엇을(작업·큐·job) 했나.
 * 작업이 성공한 뒤 한 행을 넣는다 — 실패한 작업(404·409)은 남기지 않는다. 고치거나 지우는 API는 없다(쌓기만).
 * 외래키를 두지 않는다 — 계정을 지워도(사용 중지가 아니라 행 삭제) 기록은 남게. 이력의 actor(로그인 아이디 문자열)와 같은 방식.
 */
@Entity({ tableName: 'ops_action_log' })
export class OpsActionLog {
  [OptionalProps]?: 'queue' | 'jobId' | 'jobName' | 'detail' | 'createdAt';

  @PrimaryKey()
  id!: number;

  /** OPS_ACTIONS 중 하나. type을 적는 이유: 유니온 별칭은 swc가 design:type을 Object로 내보낸다(troubleshooting/0029) */
  @Property({ type: 'string', length: 20 })
  action!: OpsAction;

  /** 로그인 아이디 */
  @Property({ length: 50 })
  actor!: string;

  /** 그때의 역할(나중에 역할이 바뀌어도 기록은 그대로) */
  @Property({ length: 20 })
  actorRole!: string;

  /** job 작업이면 큐 이름, sweep이면 null */
  @Property({ type: 'varchar', length: 30, nullable: true })
  queue: string | null = null;

  /** BullMQ job id(주기 job은 `repeat:<id>:<시각>`처럼 길다) */
  @Property({ type: 'varchar', length: 200, nullable: true })
  jobId: string | null = null;

  @Property({ type: 'varchar', length: 50, nullable: true })
  jobName: string | null = null;

  /** 작업 때의 사정(다시 시도·지운 job의 실패 이유·시도 횟수, sweep의 결과 수). 화면에 그대로 보인다 — 비밀 값을 넣지 않는다 */
  @Property({ type: 'json', nullable: true })
  detail: Record<string, unknown> | null = null;

  @Property({ type: 'datetime', length: 3 })
  createdAt: Date = new Date();
}
```

```diff
diff --git a/apps/api/src/entities.ts b/apps/api/src/entities.ts
index f95fe0b..cee8841 100644
--- a/apps/api/src/entities.ts
+++ b/apps/api/src/entities.ts
@@ -16,6 +16,7 @@ import { Anomaly } from './anomaly/anomaly.entity.js';
 import { WeeklyReport } from './report/weekly-report.entity.js';
 import { UserAccount } from './auth/user-account.entity.js';
 import { PartnerApiKey } from './auth/partner-key.entity.js';
+import { OpsActionLog } from './ops/ops-action-log.entity.js';
 
 /** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
-export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch, ServiceTicket, DeviceConnectivity, Firmware, FirmwareRollout, FirmwareRolloutTarget, VanReconciliationRun, VanRegistrationSnapshot, VanReconciliationItem, Anomaly, WeeklyReport, UserAccount, PartnerApiKey];
+export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch, ServiceTicket, DeviceConnectivity, Firmware, FirmwareRollout, FirmwareRolloutTarget, VanReconciliationRun, VanRegistrationSnapshot, VanReconciliationItem, Anomaly, WeeklyReport, UserAccount, PartnerApiKey, OpsActionLog];
```

마이그레이션은 만들기 명령으로 만든다(개발 DB에 연결해 스냅샷과 엔티티를 비교한다 — 개발 DB에 쓰지 않는다. 적용은 Task 5):

```bash
cd apps/api && npm run db:migration:create
```

Expected: `생성: Migration<시각>.ts`. 파일 이름(시각)은 다르고 SQL은 아래와 같아야 한다(사전 검증은 개발 DB를 건드리지 않으려고 스냅샷을 `.snapshot-terminal_ops_test.json`으로 복사해 `MYSQL_DATABASE=terminal_ops_test node --env-file=../../.env dist/db/migrate.js create`로 만들고 스냅샷을 다시 옮겼다). `.snapshot-terminal_ops.json`에 `ops_action_log` 표가 더해진다(+174줄, 같이 커밋). 다르면 엔티티를 다시 보고, 같아질 때까지 파일을 지우고 다시 만든다.

```ts
import { Migration } from '@mikro-orm/migrations';

export class Migration20261029031632 extends Migration {

  override name = 'Migration20261029031632';

  override up(): void | Promise<void> {
    this.addSql(`create table \`ops_action_log\` (\`id\` int unsigned not null auto_increment primary key, \`action\` varchar(20) not null, \`actor\` varchar(50) not null, \`actor_role\` varchar(20) not null, \`queue\` varchar(30) null, \`job_id\` varchar(200) null, \`job_name\` varchar(50) null, \`detail\` json null, \`created_at\` datetime(3) not null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`ops_action_log\`;`);
  }

}
```

`apps/api/src/ops/ops-audit.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { BeforeIdPage, OpsActionView, OpsQueueName } from '@terminal-ops/contracts';
import type { Principal } from '../auth/principal.js';
import { beforeIdWhere, keysetPage } from '../common/keyset.js';
import { OpsActionLog, type OpsAction } from './ops-action-log.entity.js';

export function toOpsActionView(row: OpsActionLog): OpsActionView {
  return {
    id: row.id,
    action: row.action,
    actor: row.actor,
    actorRole: row.actorRole,
    queue: row.queue as OpsQueueName | null,
    jobId: row.jobId,
    jobName: row.jobName,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 관제 작업 감사 기록(보강 6, decisions/0073). 작업이 성공한 뒤 한 행 — 이 서비스는 쌓기와 읽기만 한다 */
@Injectable()
export class OpsAuditService {
  constructor(private readonly em: EntityManager) {}

  async record(
    who: Pick<Principal, 'loginId' | 'role'>,
    action: OpsAction,
    target: { queue?: string | null; jobId?: string | null; jobName?: string | null; detail?: Record<string, unknown> | null } = {},
  ): Promise<OpsActionLog> {
    const em = this.em.fork();
    const row = em.create(OpsActionLog, {
      action,
      actor: who.loginId,
      actorRole: who.role,
      queue: target.queue ?? null,
      jobId: target.jobId ?? null,
      jobName: target.jobName ?? null,
      detail: target.detail ?? null,
    });
    await em.flush();
    return row;
  }

  /** 최근부터(id 내림차순) beforeId 키셋(decisions/0039) */
  async list(query: { beforeId?: number; limit: number }): Promise<BeforeIdPage<OpsActionView>> {
    const rows = await this.em.fork().find(OpsActionLog, beforeIdWhere(query.beforeId), { orderBy: { id: 'desc' }, limit: query.limit + 1 });
    const page = keysetPage(rows, query.limit);
    return { items: page.items.map(toOpsActionView), nextBeforeId: page.nextBeforeId };
  }
}
```

- [ ] **Step 5: 실패 job·복구 sweep 구현**

`apps/api/src/ops/job-data.ts`:

```ts
/**
 * 실패 job의 data를 화면에 보이기 전에 가린다(보강 6, decisions/0072).
 * 지금 큐에 들어가는 data는 id·시리얼·주 시작일뿐이다({ shipmentId }, { outboxId }, { serialNo }, { runId }, { weekStart }, {}) —
 * 개인정보·비밀 값은 없다. 그래도 관제 화면은 "Redis에 든 것을 그대로 보여 주는 창"이 되기 쉬워, 나중에 누가 data에 값을 더해도
 * 새지 않게 이름으로 가리고 길이를 자른다(허용 목록이 아니라 차단 목록 — 새 job을 더할 때마다 이 파일을 고치지 않아도 되게. 대가: 이름이 애매한 값은 못 거른다).
 */
export const MASK = '[가림]';

/** 이름에 이 글자가 들어간 키는 값을 가린다(대소문자 무시). key는 idempotencyKey 같은 것도 가린다 — 지나치게 가리는 쪽을 고른다 */
const SECRET_KEY = /pass|secret|token|key|auth|cookie|session|phone|email|card|account|address/i;
const MAX_STRING = 100;
const MAX_ITEMS = 20;
const MAX_DEPTH = 4;

function redact(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(${value.length}자)` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[깊음]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => redact(v, depth + 1));
    return value.length > MAX_ITEMS ? [...items, `…외 ${value.length - MAX_ITEMS}개`] : items;
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? MASK : redact(v, depth + 1)]));
}

/** job.data(어떤 값이든)를 화면용 객체로. 객체가 아니면 { value }로 감싼다 */
export function redactJobData(data: unknown): Record<string, unknown> {
  if (data === null || data === undefined) return {};
  const out = redact(data, 0);
  return out !== null && typeof out === 'object' && !Array.isArray(out) ? (out as Record<string, unknown>) : { value: out };
}

/** 실패 이유 한 줄(외부 업체 응답 본문이 길게 붙을 수 있다 — 500자) */
export function shortReason(reason: string | undefined): string {
  const text = reason ?? '';
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
```

`apps/api/src/ops/ops-jobs.service.ts`:

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { OpsFailedJobsPage, OpsFailedJobView, OpsJobActionResult, OpsQueueName } from '@terminal-ops/contracts';
import type { Principal } from '../auth/principal.js';
import { BusinessError } from '../common/domain-errors.js';
import { redactJobData, shortReason } from './job-data.js';
import { OpsAuditService } from './ops-audit.service.js';
import { OpsQueuesService } from './ops-queues.service.js';

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

export function toFailedJobView(queue: OpsQueueName, job: Job): OpsFailedJobView {
  return {
    queue,
    id: String(job.id),
    name: job.name,
    data: redactJobData(job.data),
    failedReason: shortReason(job.failedReason),
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 1,
    createdAt: new Date(job.timestamp).toISOString(),
    failedAt: iso(job.finishedOn),
  };
}

/**
 * 실패 job 보기·다시 시도·지우기(보강 6, decisions/0072·0073).
 * 다시 시도·지우기는 지금 failed 상태인 job만 — 없으면 404, 실패 상태가 아니면(이미 다시 시도함·처리 중·지워짐) 409 JOB_NOT_FAILED.
 * 성공하면 감사 기록을 남긴다(누가·언제·어느 큐의 어느 job·그때의 실패 이유).
 */
@Injectable()
export class OpsJobsService {
  constructor(
    private readonly queues: OpsQueuesService,
    private readonly audit: OpsAuditService,
  ) {}

  /** 최근 실패부터(BullMQ getFailed는 끝난 시각 내림차순) start번째부터 limit개 */
  async listFailed(name: string, start: number, limit: number): Promise<OpsFailedJobsPage> {
    const q = this.queues.queue(name);
    const [jobs, total] = await Promise.all([q.getFailed(start, start + limit - 1), q.getFailedCount()]);
    return { items: jobs.filter(Boolean).map((j) => toFailedJobView(name as OpsQueueName, j)), total, start, limit };
  }

  /**
   * 실패한 job을 다시 대기열로. 시도 횟수를 0으로 되돌린다 — 그 job의 재시도 규칙(attempts·backoff)이 처음부터 다시 적용된다
   * (되돌리지 않으면 attempts를 다 쓴 job은 한 번만 돌고 바로 실패한다, decisions/0072).
   */
  async retry(name: string, jobId: string, who: Principal): Promise<OpsJobActionResult> {
    const job = await this.failedJob(name, jobId);
    // 기록할 사정은 다시 시도 전에 읽는다 — retry 직후 이 job 객체의 failedReason이 비었다(사전 검증, decisions/0072)
    const detail = this.detailOf(job);
    try {
      await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
    } catch (error) {
      // 확인과 다시 시도 사이에 다른 사람이 먼저 다시 시도·지웠다(BullMQ: Missing key / not in failed state)
      throw await this.notFailedAfterRace(name, jobId, error);
    }
    const row = await this.audit.record(who, 'RETRY_JOB', { queue: name, jobId, jobName: job.name, detail });
    return { queue: name as OpsQueueName, jobId, action: 'RETRY_JOB', actionId: row.id };
  }

  /** 실패한 job을 Redis에서 지운다(되돌릴 수 없다 — 화면은 확인창을 띄운다) */
  async remove(name: string, jobId: string, who: Principal): Promise<OpsJobActionResult> {
    const job = await this.failedJob(name, jobId);
    const detail = this.detailOf(job);
    try {
      await job.remove();
    } catch (error) {
      throw await this.notFailedAfterRace(name, jobId, error);
    }
    const row = await this.audit.record(who, 'REMOVE_JOB', { queue: name, jobId, jobName: job.name, detail });
    return { queue: name as OpsQueueName, jobId, action: 'REMOVE_JOB', actionId: row.id };
  }

  private detailOf(job: Job): Record<string, unknown> {
    return { failedReason: shortReason(job.failedReason), attemptsMade: job.attemptsMade, failedAt: iso(job.finishedOn) };
  }

  private async failedJob(name: string, jobId: string): Promise<Job> {
    const q = this.queues.queue(name);
    const job = await q.getJob(jobId);
    if (!job) throw new NotFoundException(`job이 없습니다: ${name} ${jobId}`);
    const state = await job.getState();
    if (state !== 'failed') throw new BusinessError(409, 'JOB_NOT_FAILED', `실패 상태가 아닌 job입니다(지금 ${state}): ${name} ${jobId}`);
    return job;
  }

  private async notFailedAfterRace(name: string, jobId: string, error: unknown): Promise<Error> {
    const job = await this.queues.queue(name).getJob(jobId);
    if (!job) return new NotFoundException(`job이 없습니다: ${name} ${jobId}`);
    const state = await job.getState();
    if (state !== 'failed') return new BusinessError(409, 'JOB_NOT_FAILED', `실패 상태가 아닌 job입니다(지금 ${state}): ${name} ${jobId}`);
    return error instanceof Error ? error : new Error(String(error));
  }
}
```

```diff
diff --git a/apps/api/src/ops/ops-queues.service.ts b/apps/api/src/ops/ops-queues.service.ts
index 5443d29..d94ab90 100644
--- a/apps/api/src/ops/ops-queues.service.ts
+++ b/apps/api/src/ops/ops-queues.service.ts
@@ -1,4 +1,4 @@
-import { Inject, Injectable } from '@nestjs/common';
+import { Inject, Injectable, NotFoundException } from '@nestjs/common';
 import { InjectQueue } from '@nestjs/bullmq';
 import type { Queue } from 'bullmq';
 import type { Redis } from 'ioredis';
@@ -52,6 +52,12 @@ export class OpsQueuesService {
     };
   }
 
+  /** 이름으로 큐. 없는 이름은 404(경로 :name) */
+  queue(name: string): Queue {
+    if (!(ALL_QUEUES as string[]).includes(name)) throw new NotFoundException(`없는 큐입니다: ${name}`);
+    return this.queues[name as QueueName];
+  }
+
   async summary(now = Date.now()): Promise<OpsQueuesView> {
     const queues = await Promise.all(ALL_QUEUES.map((name) => this.queueView(name, now)));
     return { checkedAt: new Date(now).toISOString(), recentMinutes: RECENT_MINUTES, queues };
```

```diff
diff --git a/apps/api/src/ops/ops-outbox.service.ts b/apps/api/src/ops/ops-outbox.service.ts
index d502ae9..db9e96a 100644
--- a/apps/api/src/ops/ops-outbox.service.ts
+++ b/apps/api/src/ops/ops-outbox.service.ts
@@ -1,16 +1,26 @@
 import { Injectable } from '@nestjs/common';
 import { EntityManager } from '@mikro-orm/mysql';
-import type { OpsOutboxStatus, OpsOutboxView } from '@terminal-ops/contracts';
+import type { OpsOutboxStatus, OpsOutboxView, OpsRequeueResult } from '@terminal-ops/contracts';
+import type { Principal } from '../auth/principal.js';
 import { env } from '../config/env.js';
 import { OutboxEvent, OutboxStatus } from '../outbox/outbox-event.entity.js';
+import { OutboxService } from '../outbox/outbox.service.js';
+import { OpsAuditService } from './ops-audit.service.js';
+
+/** 감사 기록에 남길 다시 넣은 id 수(그 뒤는 수만) */
+const AUDIT_IDS = 50;
 
 /**
- * Outbox 요약(보강 6, decisions/0070·0042).
+ * Outbox 요약과 복구 sweep 수동 실행(보강 6, decisions/0070·0042·0073).
  * 상태별 수는 (status, id) 인덱스로 센다(상태마다 count 하나). 가장 오래된 PENDING·QUEUED는 그 상태의 가장 작은 id 행의 만든 시각.
  */
 @Injectable()
 export class OpsOutboxService {
-  constructor(private readonly em: EntityManager) {}
+  constructor(
+    private readonly em: EntityManager,
+    private readonly outbox: OutboxService,
+    private readonly audit: OpsAuditService,
+  ) {}
 
   async summary(now = new Date()): Promise<OpsOutboxView> {
     const em = this.em.fork();
@@ -26,4 +36,13 @@ export class OpsOutboxService {
       requeueAfterMs: env.outboxRequeueAfterMs,
     };
   }
+
+  /** 주기 작업 outbox-requeue와 같은 일(OutboxService.requeueStale 그대로)을 지금 한 번. 다시 넣은 것이 없어도 감사 기록은 남긴다(눌렀다는 사실) */
+  async requeue(who: Principal): Promise<OpsRequeueResult> {
+    const { checked, requeued } = await this.outbox.requeueStale();
+    const row = await this.audit.record(who, 'REQUEUE_OUTBOX', {
+      detail: { checked, requeuedCount: requeued.length, requeued: requeued.slice(0, AUDIT_IDS) },
+    });
+    return { checked, requeued, actionId: row.id };
+  }
 }
```

```diff
diff --git a/apps/api/src/ops/ops.controller.ts b/apps/api/src/ops/ops.controller.ts
index d68eb0c..e02f3c2 100644
--- a/apps/api/src/ops/ops.controller.ts
+++ b/apps/api/src/ops/ops.controller.ts
@@ -1,9 +1,25 @@
-import { Controller, Get, Query } from '@nestjs/common';
+import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
 import { Type } from 'class-transformer';
 import { IsInt, IsOptional, Max, Min } from 'class-validator';
-import type { OpsErrorView, OpsOutboxView, OpsQueuesView, OpsSchedulerView, OpsSystemView } from '@terminal-ops/contracts';
+import type {
+  BeforeIdPage,
+  OpsActionView,
+  OpsErrorView,
+  OpsFailedJobsPage,
+  OpsJobActionResult,
+  OpsOutboxView,
+  OpsQueuesView,
+  OpsRequeueResult,
+  OpsSchedulerView,
+  OpsSystemView,
+} from '@terminal-ops/contracts';
 import { OPS_VIEW, Roles } from '../auth/access.js';
+import { CurrentPrincipal, type Principal } from '../auth/principal.js';
+import { Role } from '../auth/role.js';
+import { BeforeIdQuery } from '../common/keyset.js';
+import { OpsAuditService } from './ops-audit.service.js';
 import { OpsErrorsService } from './ops-errors.service.js';
+import { OpsJobsService } from './ops-jobs.service.js';
 import { OpsOutboxService } from './ops-outbox.service.js';
 import { OpsQueuesService } from './ops-queues.service.js';
 
@@ -17,9 +33,27 @@ export class RecentErrorsQuery {
   limit: number = 30;
 }
 
+/** 실패 job 목록 쪽(최근 실패부터 start번째부터 limit개). 실패 job은 Redis 정렬 집합이라 offset으로 본다(키셋 id가 없다, decisions/0070) */
+export class FailedJobsQuery {
+  @IsOptional()
+  @Type(() => Number)
+  @IsInt()
+  @Min(0)
+  @Max(10_000)
+  start: number = 0;
+
+  @IsOptional()
+  @Type(() => Number)
+  @IsInt()
+  @Min(1)
+  @Max(100)
+  limit: number = 20;
+}
+
 /**
  * 운영 관제 API(보강 6, decisions/0070). 관제 화면(apps/console)이 부른다. 보기는 관제·ADMIN(OPS_VIEW), 관제 작업은 관제(MONITOR)만.
  * 모두 그때그때 읽는다(캐시 없음) — 화면이 10초마다 다시 부르므로 한 번 읽기가 가벼워야 한다(큐마다 Redis 명령 몇 개, 표마다 인덱스 읽기 몇 번).
+ * 관제 작업은 DELETE가 아니라 POST `/…/retry`·`/…/remove`다 — 둘 다 "실패 job에 하는 동작"이고 감사 기록을 남기는 명령이라 같은 모양으로 둔다.
  */
 @Controller('ops')
 export class OpsController {
@@ -27,6 +61,8 @@ export class OpsController {
     private readonly queues: OpsQueuesService,
     private readonly outbox: OpsOutboxService,
     private readonly errors: OpsErrorsService,
+    private readonly jobs: OpsJobsService,
+    private readonly audit: OpsAuditService,
   ) {}
 
   /** 큐마다 상태별 수·멈춤·가장 오래 기다린 job·최근 15분 처리량·워커 수 */
@@ -63,4 +99,42 @@ export class OpsController {
   recentErrors(@Query() query: RecentErrorsQuery): Promise<OpsErrorView[]> {
     return this.errors.recent(query.limit);
   }
+
+  /** 이 큐에 남은 실패 job(최근 실패부터). 없는 큐 이름은 404 */
+  @Get('queues/:name/failed')
+  @Roles(...OPS_VIEW)
+  failed(@Param('name') name: string, @Query() query: FailedJobsQuery): Promise<OpsFailedJobsPage> {
+    return this.jobs.listFailed(name, query.start, query.limit);
+  }
+
+  /** 실패 job 다시 시도(관제만, 감사 기록). 없으면 404, 실패 상태가 아니면 409 JOB_NOT_FAILED */
+  @Post('queues/:name/jobs/:id/retry')
+  @Roles(Role.MONITOR)
+  @HttpCode(200)
+  retry(@Param('name') name: string, @Param('id') id: string, @CurrentPrincipal() who: Principal): Promise<OpsJobActionResult> {
+    return this.jobs.retry(name, id, who);
+  }
+
+  /** 실패 job 지우기(관제만, 감사 기록, 되돌릴 수 없음) */
+  @Post('queues/:name/jobs/:id/remove')
+  @Roles(Role.MONITOR)
+  @HttpCode(200)
+  remove(@Param('name') name: string, @Param('id') id: string, @CurrentPrincipal() who: Principal): Promise<OpsJobActionResult> {
+    return this.jobs.remove(name, id, who);
+  }
+
+  /** 멈춘 QUEUED 복구 sweep을 지금 한 번(관제만, 감사 기록, decisions/0042) */
+  @Post('outbox/requeue')
+  @Roles(Role.MONITOR)
+  @HttpCode(200)
+  requeueOutbox(@CurrentPrincipal() who: Principal): Promise<OpsRequeueResult> {
+    return this.outbox.requeue(who);
+  }
+
+  /** 관제 작업 감사 기록(최근부터 beforeId 키셋) */
+  @Get('actions')
+  @Roles(...OPS_VIEW)
+  actions(@Query() query: BeforeIdQuery): Promise<BeforeIdPage<OpsActionView>> {
+    return this.audit.list(query);
+  }
 }
```

```diff
diff --git a/apps/api/src/ops/ops.module.ts b/apps/api/src/ops/ops.module.ts
index 0eaad45..6afcde1 100644
--- a/apps/api/src/ops/ops.module.ts
+++ b/apps/api/src/ops/ops.module.ts
@@ -1,12 +1,16 @@
 import { Module } from '@nestjs/common';
+import { OutboxModule } from '../outbox/outbox.module.js';
+import { OpsAuditService } from './ops-audit.service.js';
 import { OpsController } from './ops.controller.js';
 import { OpsErrorsService } from './ops-errors.service.js';
+import { OpsJobsService } from './ops-jobs.service.js';
 import { OpsOutboxService } from './ops-outbox.service.js';
 import { OpsQueuesService } from './ops-queues.service.js';
 
-/** 운영 관제(보강 6, decisions/0070). 큐는 전역 QueuesModule, Redis는 전역 RedisModule의 것을 쓴다 */
+/** 운영 관제(보강 6, decisions/0070). 큐는 전역 QueuesModule, Redis는 전역 RedisModule의 것을 쓴다. 복구 sweep은 OutboxService.requeueStale 그대로(decisions/0042) */
 @Module({
+  imports: [OutboxModule],
   controllers: [OpsController],
-  providers: [OpsQueuesService, OpsOutboxService, OpsErrorsService],
+  providers: [OpsQueuesService, OpsOutboxService, OpsErrorsService, OpsJobsService, OpsAuditService],
 })
 export class OpsModule {}
```

```diff
diff --git a/apps/api/src/common/contract-assertions.ts b/apps/api/src/common/contract-assertions.ts
index 3e235db..d88eea5 100644
--- a/apps/api/src/common/contract-assertions.ts
+++ b/apps/api/src/common/contract-assertions.ts
@@ -10,6 +10,7 @@ import type { PARTNER_SCOPES } from '../auth/partner-key.entity.js';
 import type { Role } from '../auth/role.js';
 import type { Carrier, CarrierEventCode } from '../carrier/carrier.types.js';
 import type { RolloutStatus } from '../firmware/firmware.entities.js';
+import type { OPS_ACTIONS } from '../ops/ops-action-log.entity.js';
 import type { OutboxStatus } from '../outbox/outbox-event.entity.js';
 import type { QueueName } from '../queue/queue-names.js';
 import type { PurchaseOrderStatus } from '../purchase-order/purchase-order.entity.js';
@@ -50,4 +51,5 @@ export type ContractEnumAssertions = [
   Assert<Same<(typeof PARTNER_SCOPES)[number], C.PartnerScope>>,
   Assert<Same<QueueName, C.OpsQueueName>>,
   Assert<Same<`${OutboxStatus}`, C.OpsOutboxStatus>>,
+  Assert<Same<(typeof OPS_ACTIONS)[number], C.OpsActionKind>>,
 ];
```

- [ ] **Step 6: 통과 확인과 전체 api**

```bash
cd apps/api
npx vitest run test/unit/access-table.spec.ts test/unit/queue-metrics.spec.ts test/unit/job-data.spec.ts test/unit/contract-drift.spec.ts test/ops-status.e2e.spec.ts test/ops-outbox-errors.e2e.spec.ts test/ops-jobs.e2e.spec.ts
npm run typecheck
# 테스트 DB를 새로 만든 뒤(안전 규칙) 전체 — 약 6분
npx vitest run > /tmp/ops-t2-api.log 2>&1; grep -E "Test Files|Tests |Duration" /tmp/ops-t2-api.log; grep -c "Connection is closed" /tmp/ops-t2-api.log
git status --short --ignored src/migrations   # .snapshot-terminal_ops_test.json이 있으면 지운다(troubleshooting/0032)
```

Expected: 일곱 파일 `Test Files  7 passed (7)`, `Tests  32 passed (32)`. typecheck 0. 전체 `Test Files  88 passed (88)`·`Tests  593 passed (593)`(사전 검증 Duration 350.55s), `Connection is closed` 0.

- [ ] **Step 7: 기록**

`docs/decisions/0072-실패-job은-Redis에-남은-것만-data는-가리고-다시-시도는-시도-수를-되돌린다.md`:

````markdown
# 0072. 실패 job은 Redis에 남은 것만 보이고, data는 이름으로 가리고, 다시 시도는 시도 수를 되돌린다

- 날짜 / 관련 기능: 2026-10-29 / 보강 6, F3·F5·F9·F11, 운영 관제
- 상황: 관제 화면이 실패한 job을 보여 주고 다시 시도·지우기를 해야 한다. 세 가지를 정한다. (1) 무엇이 보이나: 이 시스템의 job 옵션은 큐마다 다르다 — 알림 notify·project(`removeOnFail: true`, 0016), 택배 추적(`removeOnFail: true`), 주간 리포트 수동 보내기(`removeOnFail: true`, 0038)는 실패하면 Redis에서 사라지고, 주기 작업 job(`removeOnFail: 100`)과 VAN 대조 job(`removeOnFail: 100`)만 남는다. (2) data를 그대로 보여도 되나. (3) 다시 시도의 의미.
- 사전 검증(BullMQ 6.4.0, 테스트 접두사 probe): `attempts: 2`로 두 번 실패한 job에 `job.retry('failed')`만 하면 시도 수가 이어진다 — 한 번만 더 돌고 실패로 끝났다(`attemptsMade` 2 → 3). `retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true })`면 두 번을 다시 다 돌았다(다시 실패 뒤 `attemptsMade` 2). 완료된 job을 `retry`하면 `Job 3 is not in the failed state. reprocessJob`, 이미 다시 시도해 키가 바뀐 job은 `Missing key for job 2. reprocessJob`으로 던진다. `retry` 직후 그 job 객체의 `failedReason`은 null로 비었다 — 감사 기록에 남길 값은 그 전에 읽는다. 지금 큐에 들어가는 data는 id·시리얼·주 시작일뿐이다(`{ shipmentId }`, `{ outboxId }`, `{ serialNo }`, `{ runId }`, `{ weekStart }`, `{}`).
- 선택지(보이는 범위):
  1. **Redis에 남은 실패만, 지워지는 job의 실패는 업무 기록으로**(Outbox FAILED·수집 기록 ERROR·주간 리포트 lastError — `GET /ops/errors`, 0070) — job 옵션을 바꾸지 않는다
  2. 모든 job을 `removeOnFail: { count: N }`으로 바꿔 Redis에 남기기 — 알림 복구 sweep(0042)이 "job이 없으면(unknown) 다시 넣기"에 기대고 있어 실패한 notify가 남으면 그 행을 다시 넣지 못한다. 수동 보내기는 같은 jobId를 다시 넣을 수 없게 된다(0038)
- 선택지(data):
  (a) 그대로 — 지금은 비밀이 없지만, 관제 화면은 "Redis에 든 것을 보여 주는 창"이 되기 쉬워 나중에 누가 data에 값을 더하면 그대로 샌다
  (b) **이름 차단 목록으로 가리고 자른다** — 키 이름에 `pass·secret·token·key·auth·cookie·session·phone·email·card·account·address`가 들어가면(대소문자 무시, 깊이 상관없이) `[가림]`, 글자 100자·목록 20개·깊이 4까지. 새 job을 더할 때 이 파일을 고치지 않아도 된다
  (c) 큐·job 이름마다 보일 키 허용 목록 — 가장 안전하지만 job을 더할 때마다 고쳐야 하고, 빠뜨리면 아무것도 안 보여 관제가 원인을 못 본다
- 선택지(다시 시도): 시도 수를 이어 가기 / **0으로 되돌리기**
- 결정: 범위 1, data (b), 다시 시도는 0으로 되돌린다 — 관제가 원인을 고친 뒤(업체 복구 등) 누르는 것이라 job의 재시도 규칙(attempts·backoff)이 처음부터 다시 적용돼야 한다. 다시 시도·지우기는 지금 `failed`인 job만 — 없으면 404, 다른 상태면 409 `JOB_NOT_FAILED`. 확인과 동작 사이에 다른 사람이 먼저 처리하면 BullMQ가 던지는데, 그때 상태를 다시 읽어 404·409로 바꾼다. 실패 이유는 500자까지(외부 업체 응답 본문이 길게 붙는다), 스택은 보내지 않는다.
  - 다시 시도가 안전한 이유: 남는 job은 주기 작업(같은 일을 다음 주기에도 한다)과 VAN 대조(`execute`가 RUNNING이 아닌 실행은 다시 하지 않는다 — `van-reconciliation.service.ts`)뿐이다
- 결과·대가: 알림·택배 추적 job의 실패는 실패 job 화면에 없다(최근 오류 화면에 업무 기록으로). 차단 목록이라 이름이 애매한 값(`note`에 전화번호를 넣는 등)은 못 거른다. `key`를 포함하는 이름(`idempotencyKey` 등)은 비밀이 아니어도 가려진다(지나치게 가리는 쪽).
- 다시 볼 조건: job data에 사람 정보가 들어가야 하면 (c) 허용 목록으로. 지워지는 job의 실패를 job 단위로 다시 시도해야 하면 그 큐만 `removeOnFail: { age }`로 남기고, 0042의 "unknown이면 다시 넣기" 조건을 "unknown 또는 failed"로 함께 바꾼다.
````

`docs/decisions/0073-관제-작업-감사-기록은-새-표-ops_action_log.md`:

````markdown
# 0073. 관제 작업 감사 기록은 새 표 ops_action_log

- 날짜 / 관련 기능: 2026-10-29 / 보강 6, 운영 관제
- 상황: 관제 작업(실패 job 다시 시도·지우기, Outbox 복구 sweep 수동 실행)은 업무 데이터를 직접 바꾸지는 않지만 결과를 바꾼다(지운 job은 돌아오지 않는다). 누가 언제 무엇에 했는지 남아야 한다. 지금 있는 기록: 상태 이력(`terminal_status_history` — 단말기 전이 전용, 0002), Outbox(알림 — 보낼 것이지 기록이 아니다), 애플리케이션 로그(파일이 없고 콘솔뿐).
- 선택지:
  1. **새 표 `ops_action_log`**(action·actor·actor_role·queue·job_id·job_name·detail JSON·created_at) — 쿼리·화면이 쉽다. 마이그레이션 하나
  2. Outbox에 `ops.action` 이벤트를 남겨 메신저로도 알리기 — 기록과 알림이 섞이고, 메신저가 실패하면 기록도 FAILED로 보인다. 화면에서 "누가 무엇을" 목록으로 읽기 어렵다
  3. 로그(`Logger`)만 — 남지만 화면에서 볼 수 없고 프로세스를 다시 띄우면 사라진다
  4. Redis 목록(LPUSH + LTRIM) — 빠르지만 영속성이 MySQL보다 약하고, "Redis는 필요한 자리에만"(CLAUDE.md) — 여기는 MySQL이 맞다
- 결정: 1.
  - 작업이 **성공한 뒤** 한 행을 넣는다 — 403·404·409로 실패한 시도는 남기지 않는다(실패한 시도는 아무것도 바꾸지 않았다)
  - 외래키를 두지 않는다 — 계정 행을 지워도 기록은 남게(이력의 actor처럼 로그인 아이디 문자열, 0056). 그때의 역할도 함께 남긴다
  - detail에는 작업 때의 사정을 넣는다: 다시 시도·지우기는 그 job의 실패 이유·시도 수·실패 시각(다시 시도하면 job에서 지워지므로 그 전에 읽는다, 0072), 복구 sweep은 본 행 수·다시 넣은 수·id(앞 50개). 화면에 그대로 보이므로 비밀 값을 넣지 않는다
  - 고치거나 지우는 API는 없다(쌓기만). 읽기는 `GET /ops/actions`(관제·ADMIN, beforeId 키셋 — 0039)
  - 복구 sweep은 다시 넣은 것이 없어도 남긴다(눌렀다는 사실)
- 결과·대가: 작업과 기록이 한 트랜잭션이 아니다 — Redis 작업(retry·remove·addBulk)은 끝났는데 기록 INSERT가 실패하면 기록 없이 작업만 된다(응답은 500). Redis와 MySQL을 한 트랜잭션으로 묶을 수 없어서다(0016과 같은 사정). 기록을 먼저 쓰고 작업이 실패하면 지우는 방식은 "하지 않은 일"의 기록이 잠깐 보인다. 표는 계속 자란다(관제 작업은 하루 몇 건이라 정리 작업은 두지 않았다).
- 다시 볼 조건: 다른 관제 작업(큐 멈춤·재개, 일괄 다시 시도)이 늘면 action 값을 더한다(contracts `OpsActionKind`와 단언). 기록 누락이 문제가 되면 "의도 기록 → 작업 → 결과 갱신" 두 단계로.
````

`docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md` — Task 1이 넣은 `| OPS_VIEW = … |` 줄의 끝(`` `GET /ops/errors` ``) 뒤에 `` , `GET /ops/queues/:name/failed`, `GET /ops/actions` ``를 더하고, 그 줄 바로 뒤에 한 줄을 넣는다(Edit 도구):

```markdown
  | MONITOR(관제 작업, 보강 6, 0070·0073) | `POST /ops/queues/:name/jobs/:id/retry`, `POST /ops/queues/:name/jobs/:id/remove`, `POST /ops/outbox/requeue` |
```

같은 파일 끝에 한 줄:

```markdown
- 보강 6 보탬(decisions/0072·0073): 실패 job 목록·감사 기록 읽기(OPS_VIEW)와 관제 작업 셋(MONITOR만 — ADMIN은 보기만, 운영자는 관제 화면을 쓰지 않는다)을 더해 엔드포인트 77 → 82.
```

`docs/study/backlog.md` 끝에 한 줄:

```markdown
- [ ] BullMQ `Job.retry`의 `resetAttemptsMade`·`resetAttemptsStarted`, 실패 job이 다시 처리될 때 backoff는 어디서부터인가 (apps/api/src/ops/ops-jobs.service.ts, decisions/0072)
```

devlog(Task 1 항목 뒤):

```markdown
## HH:MM Task 2 관제 작업 API — 실패 job·다시 시도·지우기, 복구 sweep, 감사 기록 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <Task 1 커밋 해시>
- 한 일: `GET /ops/queues/:name/failed`(Redis에 남은 실패, 최근부터 start·limit, data 이름으로 가림·자름), `POST …/jobs/:id/retry`(시도 수 0으로)·`/remove`, `POST /ops/outbox/requeue`(requeueStale 그대로), `GET /ops/actions`. 관제 작업 셋은 MONITOR만, 성공하면 `ops_action_log`에 한 행(마이그레이션 <파일 이름>). contracts 실패 job·감사 기록 타입, 오류 코드 `JOB_NOT_FAILED`, 단언 `OPS_ACTIONS`. 접근 표 77 → 82
- 확인: 새 테스트 <수>개 실패 → 통과(7파일 32개). api 전체 `Test Files  <수> passed (<수>)`, `Tests  <수> passed (<수>)`, Duration <초>, `Connection is closed` <수>. typecheck 0. 마이그레이션 SQL이 계획과 같음
- 결정: decisions/0072(실패 job 범위·data 가리기·다시 시도 의미), 0073(감사 기록 새 표), 0052 표·보탬
- 다음: Task 3 관제 앱 골격
```

```bash
node scripts/docs-index.mjs
```

- [ ] **Step 8: 커밋**

```bash
git add packages/contracts apps/api docs
git status --short   # .snapshot-terminal_ops_test.json·dist가 없어야 한다
git commit -m "$(cat <<'EOF'
feat(ops, F5): 관제 작업 API — 실패 job 다시 시도·지우기, Outbox 복구 sweep, 감사 기록 ops_action_log

Refs: docs/decisions/0072-실패-job은-Redis에-남은-것만-data는-가리고-다시-시도는-시도-수를-되돌린다.md, docs/decisions/0073-관제-작업-감사-기록은-새-표-ops_action_log.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 제목 시각 = 커밋 시각인지 보고, 다르면 고쳐 `git commit --amend --no-edit`.

---


### Task 3: 관제 앱 골격 — 점주 사본·사본 검사, 로그인 문·틀·대시보드·자동 새로고침, 어드민 관제 주소

**Files:**
- Create: `apps/console/package.json`·`package-lock.json`·`tsconfig.json`·`vite.config.ts`·`index.html`
- Create(현장 앱에서 복사 — 점주 앱 사본): `apps/console/src/api/client.ts`, `session.ts`, `query-client.ts`, `lib/format.ts`, `components/SessionCacheSync.tsx`, `components/LogoutButton.tsx`, `hooks/useSessionCheck.ts`, `test/setup.ts`, `main.tsx`
- Create: `apps/console/src/App.tsx`, `styles.css`, `lib/refresh.ts`, `api/query-keys.ts`, `components/AuthGate.tsx`·`Shell.tsx`·`ErrorBox.tsx`·`Freshness.tsx`, `pages/LoginPage.tsx`·`DashboardPage.tsx`
- Test: Create `apps/console/src/copies.test.ts`, `App.test.tsx`, `api/query-keys.test.ts`, `components/ErrorBox.test.ts`, `pages/DashboardPage.test.tsx`, `test/render.tsx`, `test/fixtures.ts`
- Modify: `apps/admin/src/apps.ts`, `apps/admin/src/apps.test.ts`, `apps/admin/src/components/Layout.test.tsx`
- Modify(머리 주석 한 줄씩): 점주 앱 사본 9개 `apps/merchant/src/api/client.ts`, `session.ts`, `query-client.ts`, `lib/format.ts`, `components/SessionCacheSync.tsx`, `components/LogoutButton.tsx`, `hooks/useSessionCheck.ts`, `test/setup.ts`, `main.tsx`
- 저장소 밖·커밋 안 함: `C:\Devhyun\History\.claude\launch.json`, 저장소 `.claude/launch.json`(gitignore)
- Docs: Create `docs/decisions/0074-운영-관제-화면은-별도-앱-apps-console.md`, `docs/decisions/0075-네-번째-화면도-점주-사본과-사본-검사로.md`, `docs/decisions/0076-관제-화면-자동-새로고침은-10초-탭-숨김이면-멈춤.md`; Modify `docs/decisions/0062-세-번째-화면도-복사와-사본-검사-테스트로.md`, `docs/decisions/0067-다른-화면-바로가기-주소는-apps-ts-한-곳과-Vite-env로.md`, `docs/study/backlog.md`, `docs/index.md`, `docs/devlog/2026-10-29.md`

- [ ] **Step 1: 앱 바탕 — 설정과 사본**

현장 앱과 같은 판·같은 lock(이름 두 줄만 다름). 포트는 현장 앱(5175·4175) 옆 5176·4176이다(다른 앱 vite.config의 strictPort와 겹치지 않는다).

```bash
mkdir -p apps/console/src/{api,components,hooks,lib,pages,test}
sed 's/"@terminal-ops\/field"/"@terminal-ops\/console"/' apps/field/package.json > apps/console/package.json
sed 's/"@terminal-ops\/field"/"@terminal-ops\/console"/' apps/field/package-lock.json > apps/console/package-lock.json
cp apps/field/tsconfig.json apps/console/
for f in api/client.ts session.ts query-client.ts lib/format.ts components/SessionCacheSync.tsx components/LogoutButton.tsx hooks/useSessionCheck.ts test/setup.ts main.tsx; do cp apps/field/src/$f apps/console/src/$f; done
diff --strip-trailing-cr apps/field/package-lock.json apps/console/package-lock.json   # "name" 두 줄만 달라야 한다
```

현장 사본은 점주 앱과 코드가 같다(현장 `copies.test.ts`가 지킨다). 사본의 머리 주석은 "점주 앱 `…`의 사본(decisions/0062)" 그대로 둔다. 점주 앱 쪽 머리 주석("현장 앱 `…`에 사본이 있다 — 같이 고친다", 보강 4 리뷰 cd59070)에 관제 사본도 적는다(주석만 — 점주 테스트는 그대로):

```bash
cd apps/merchant/src && sed -i 's|^// 현장 앱 `apps/field/src/\([^`]*\)`에 사본이 있다 — 같이 고친다(decisions/0062, 현장 `src/copies.test.ts`가 코드 차이를 본다)|// 현장 앱 `apps/field/src/\1`·관제 앱 `apps/console/src/\1`에 사본이 있다 — 같이 고친다(decisions/0062·0075, 두 앱의 `src/copies.test.ts`가 코드 차이를 본다)|' api/client.ts session.ts query-client.ts lib/format.ts components/SessionCacheSync.tsx components/LogoutButton.tsx hooks/useSessionCheck.ts test/setup.ts main.tsx && cd ../../..
git diff --stat apps/merchant   # 9 files changed, 9 insertions(+), 9 deletions(-)
```

예(아홉 파일 모두 같은 모양):

```diff
diff --git a/apps/merchant/src/main.tsx b/apps/merchant/src/main.tsx
index 61227d2..68bc4f5 100644
--- a/apps/merchant/src/main.tsx
+++ b/apps/merchant/src/main.tsx
@@ -1,4 +1,4 @@
-// 현장 앱 `apps/field/src/main.tsx`에 사본이 있다 — 같이 고친다(decisions/0062, 현장 `src/copies.test.ts`가 코드 차이를 본다)
+// 현장 앱 `apps/field/src/main.tsx`·관제 앱 `apps/console/src/main.tsx`에 사본이 있다 — 같이 고친다(decisions/0062·0075, 두 앱의 `src/copies.test.ts`가 코드 차이를 본다)
 import { StrictMode } from 'react';
 import { createRoot } from 'react-dom/client';
 import { QueryClientProvider } from '@tanstack/react-query';
```

관제 사본은 `query-client.ts`의 설명 주석만 관제 화면에 맞게 고친다(주석이라 사본 검사에 걸리지 않는다):

```diff
diff --git a/apps/field/src/query-client.ts b/apps/console/src/query-client.ts
index e809c1f..b38e5db 100644
--- a/apps/field/src/query-client.ts
+++ b/apps/console/src/query-client.ts
@@ -7,8 +7,8 @@ export function shouldRetry(count: number, error: unknown): boolean {
 }
 
 /**
- * 서버 상태 캐시(TanStack Query). 점주 앱과 같게 창으로 돌아올 때 다시 읽는다(refetchOnWindowFocus 기본값) — 현장 작업자는 휴대폰·PDA에서
- * 다른 앱(메신저 등)을 오가고, 그사이 다른 작업자가 발주·검수 대기를 바꿨을 수 있다. staleTime 30초라 금방 다시 와도 매번 읽지는 않는다.
+ * 서버 상태 캐시(TanStack Query). 점주 앱과 같은 기본값 — 관제 화면은 읽기 쿼리마다 refetchInterval(10초, lib/refresh.ts)을 따로 걸어
+ * staleTime(30초)과 상관없이 간격마다 다시 읽는다. 탭으로 돌아올 때 다시 읽기(refetchOnWindowFocus)는 30초가 지났을 때만(decisions/0076).
  */
 export function createQueryClient(): QueryClient {
   return new QueryClient({
```

`apps/console/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 운영 관제 화면(보강 6, decisions/0074). 어드민·점주·현장 앱과 같은 방식으로 개발 서버가 /api를 Nest api로 넘긴다(앞의 /api는 떼고) —
 * 같은 출처라 api에 CORS를 열지 않고 세션 쿠키(sid, SameSite=Strict)가 그대로 붙는다(api decisions/0041·0050).
 * CONSOLE_API_URL로 api 주소를 바꾼다(기본 http://localhost:3000). 포트는 현장 앱(5175·4175) 옆 5176·4176.
 */
const apiProxy = {
  '/api': {
    target: process.env.CONSOLE_API_URL ?? 'http://localhost:3000',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5176, strictPort: true, proxy: apiProxy },
  preview: { port: 4176, strictPort: true, proxy: apiProxy },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

`apps/console/index.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#24292f" />
    <title>단말온 운영 관제</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

```bash
cd apps/console && npm ci
```

- [ ] **Step 2: 실패하는 테스트**

`apps/console/src/copies.test.ts`는 현장 앱 것을 복사해(`cp apps/field/src/copies.test.ts apps/console/src/copies.test.ts`) 비교할 앱 이름과 주석만 바꾼다:

```diff
diff --git a/apps/field/src/copies.test.ts b/apps/console/src/copies.test.ts
index c845da2..58339f4 100644
--- a/apps/field/src/copies.test.ts
+++ b/apps/console/src/copies.test.ts
@@ -5,8 +5,9 @@ import ts from 'typescript';
 import { describe, expect, it } from 'vitest';
 
 /**
- * 점주 앱에서 옮겨 온 사본(decisions/0062). 주석은 앱마다 다르게 쓰되 코드는 같아야 한다 — 한쪽만 고치면 여기서 실패한다.
+ * 점주 앱에서 옮겨 온 사본(decisions/0062, 네 번째 앱도 같은 방식 — decisions/0075). 주석은 앱마다 다르게 쓰되 코드는 같아야 한다 — 한쪽만 고치면 여기서 실패한다.
  * 사본의 동작 테스트(api 클라이언트·KST 형식 등)는 점주 앱에 한 벌만 있다. 이 테스트가 "코드가 같다"를 지켜 그 테스트가 이 앱에도 맞게 한다.
+ * 이 파일 자체는 현장 앱 `apps/field/src/copies.test.ts`를 옮긴 것이다(비교할 앱 이름 'console'과 주석만 다르다).
  */
 const COPIES = [
   'api/client.ts',
@@ -64,7 +65,7 @@ export function codeOnly(text: string, fileName = 'copy.tsx'): string {
  * 다른 앱 파일까지 불러오려다 `Denied ID …?url`로 실패한다(사전 검증) — 경로는 node:path로 만든다.
  */
 const APPS = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
-const read = (app: 'field' | 'merchant', path: string) => readFileSync(resolve(APPS, app, 'src', path), 'utf8');
+const read = (app: 'console' | 'merchant', path: string) => readFileSync(resolve(APPS, app, 'src', path), 'utf8');
 
 describe('점주 앱 사본 (decisions/0062)', () => {
   it('codeOnly는 주석만 빼고 코드 차이는 남긴다', () => {
@@ -92,7 +93,7 @@ describe('점주 앱 사본 (decisions/0062)', () => {
     expect(codeOnly('const a = <string>b;', 'x.ts')).not.toBe(codeOnly('const a = <string>c;', 'x.ts'));
   });
 
-  it('머리 주석에 "의 사본(decisions/0062)"이라 적은 현장 파일은 모두 COPIES에 있다(목록에서 빠진 사본 방지)', () => {
+  it('머리 주석에 "의 사본(decisions/0062)"이라 적은 관제 파일은 모두 COPIES에 있다(목록에서 빠진 사본 방지)', () => {
     const sources = import.meta.glob(['./**/*.ts', './**/*.tsx', '!./**/*.test.ts', '!./**/*.test.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
     const files = Object.keys(sources);
     expect(files.length).toBeGreaterThan(10); // glob이 실제로 소스를 읽었는지
@@ -102,6 +103,6 @@ describe('점주 앱 사본 (decisions/0062)', () => {
   });
 
   it.each(COPIES)('%s는 점주 앱 것과 코드가 같다', (path) => {
-    expect(codeOnly(read('field', path), path)).toBe(codeOnly(read('merchant', path), path));
+    expect(codeOnly(read('console', path), path)).toBe(codeOnly(read('merchant', path), path));
   });
 });
```

`apps/console/src/test/render.tsx`도 현장 앱 것(`cp apps/field/src/test/render.tsx apps/console/src/test/render.tsx`)에서 자동 새로고침 되돌리기·관제 계정만 바꾼다:

```diff
diff --git a/apps/field/src/test/render.tsx b/apps/console/src/test/render.tsx
index 33dd3eb..bb5dc81 100644
--- a/apps/field/src/test/render.tsx
+++ b/apps/console/src/test/render.tsx
@@ -5,6 +5,7 @@ import { MemoryRouter, Route, Routes } from 'react-router';
 import { vi } from 'vitest';
 import type { MeView } from '@terminal-ops/contracts';
 import { App } from '../App';
+import { resetAutoRefreshForTest } from '../lib/refresh';
 import { setMe } from '../session';
 
 /** 부른 요청 하나(가짜 fetch가 기록) */
@@ -20,7 +21,7 @@ type HandlerResult = { status?: number; body?: unknown } | undefined;
 export type Handler = (call: Call) => HandlerResult | Promise<HandlerResult>;
 
 /**
- * 가짜 api(어드민·점주 test/render.tsx의 mockApi와 같은 규칙). 키는 'GET /field/today'처럼 메서드와 경로(쿼리 제외). 경로의 `:x`는 아무 한 마디와 맞는다.
+ * 가짜 api(어드민·점주·현장 test/render.tsx의 mockApi와 같은 규칙). 키는 'GET /ops/queues'처럼 메서드와 경로(쿼리 제외). 경로의 `:x`는 아무 한 마디와 맞는다.
  * 없는 경로를 부르면 404 — 테스트가 빠뜨린 요청이 바로 보이게. 부른 요청은 calls에 쌓인다.
  */
 export function mockApi(handlers: Record<string, Handler>) {
@@ -30,7 +31,7 @@ export function mockApi(handlers: Record<string, Handler>) {
     return { method, regex: new RegExp(`^${path.replace(/:[^/]+/g, '[^/]+')}$`), handler };
   });
   const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
-    const url = new URL(String(input), 'http://field.test');
+    const url = new URL(String(input), 'http://console.test');
     const call: Call = {
       method: init?.method ?? 'GET',
       path: url.pathname.replace(/^\/api/, ''),
@@ -50,7 +51,12 @@ export function mockApi(handlers: Record<string, Handler>) {
   return { calls, fetchMock };
 }
 
-const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
+/** 그릴 때마다 자동 새로고침을 켜짐·refreshMs(기본 10초)로 되돌린다(앞 테스트가 껐을 수 있다) */
+const newClient = (refreshMs?: number) => {
+  resetAutoRefreshForTest(refreshMs);
+  return createClient();
+};
+const createClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
 
 /** 화면 하나를 라우터·쿼리 캐시와 함께 그린다. path는 Route 경로(예 '/terminals/:serialNo'), route는 지금 주소 */
 export function renderPage(element: ReactElement, { route = '/', path = '/' }: { route?: string; path?: string } = {}) {
@@ -70,9 +76,9 @@ export function renderPage(element: ReactElement, { route = '/', path = '/' }: {
   };
 }
 
-/** 앱 전체(로그인 문·화면 틀 포함)를 이 주소로 그린다 */
-export function renderApp(route = '/') {
-  const client = newClient();
+/** 앱 전체(로그인 문·화면 틀 포함)를 이 주소로 그린다. refreshMs를 주면 자동 새로고침 간격을 그만큼 짧게 */
+export function renderApp(route = '/', { refreshMs }: { refreshMs?: number } = {}) {
+  const client = newClient(refreshMs);
   return {
     client,
     ...render(
@@ -85,10 +91,12 @@ export function renderApp(route = '/') {
   };
 }
 
-/** 현장 작업자(시연 계정과 같은 아이디) */
-export const WORKER: MeView = { loginId: 'field', displayName: '현장 작업자', role: 'FIELD', merchantCode: null };
+/** 관제(시연 계정과 같은 아이디) — 관제 작업을 할 수 있다 */
+export const MONITOR: MeView = { loginId: 'monitor', displayName: '관제 담당', role: 'MONITOR', merchantCode: null };
+/** ADMIN — 보기만 한다(관제 작업 단추 대신 안내) */
+export const ADMIN: MeView = { loginId: 'admin', displayName: '관리자', role: 'ADMIN', merchantCode: null };
 
 /** 로그인한 것으로 둔다(서버 세션 대신 화면의 내 정보만) */
-export function loginAs(me: MeView = WORKER) {
+export function loginAs(me: MeView = MONITOR) {
   setMe(me);
 }
```

`apps/console/src/test/fixtures.ts`:

```ts
import type { OpsOutboxView, OpsQueueName, OpsQueueView, OpsQueuesView, OpsSystemView } from '@terminal-ops/contracts';

/** 지금보다 m분 전 ISO 시각(화면의 "N분 전"이 테스트 시각과 상관없이 같게) */
export const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export const queue = (name: OpsQueueName, over: Partial<OpsQueueView> = {}): OpsQueueView => ({
  name,
  counts: { waiting: 0, active: 0, delayed: 0, prioritized: 0, failed: 0, completed: 0 },
  paused: false,
  oldestWaitingAt: null,
  completedRecent: null,
  failedRecent: null,
  workers: 1,
  ...over,
});

export const queuesView = (queues: OpsQueueView[] = []): OpsQueuesView => ({ checkedAt: new Date().toISOString(), recentMinutes: 15, queues });

export const systemView = (over: Partial<OpsSystemView> = {}): OpsSystemView => ({
  checkedAt: new Date().toISOString(),
  api: { version: 'dev', startedAt: minutesAgo(90), node: 'v24.0.0', queuePrefix: 'terminal-ops', runWorkers: true, runSchedulers: true },
  mysql: { ok: true, latencyMs: 1.2, error: null },
  redis: { ok: true, latencyMs: 0.4, error: null },
  workers: [
    { queue: 'outbox', name: 'worker-a', idleSeconds: 1 },
    { queue: 'report', name: 'worker-a', idleSeconds: 3 },
  ],
  ...over,
});

export const outboxView = (over: Partial<OpsOutboxView> = {}): OpsOutboxView => ({
  checkedAt: new Date().toISOString(),
  counts: { PENDING: 0, QUEUED: 0, SENT: 0, FAILED: 0 },
  oldestPendingAt: null,
  oldestQueuedAt: null,
  requeueAfterMs: 60_000,
  ...over,
});

/** 대시보드가 부르는 세 GET(값을 바꾸려면 덮어쓴다) */
export const dashboardApi = (over: { queues?: OpsQueuesView; system?: OpsSystemView; outbox?: OpsOutboxView } = {}) => ({
  'GET /ops/queues': () => ({ body: over.queues ?? queuesView([queue('outbox')]) }),
  'GET /ops/system': () => ({ body: over.system ?? systemView() }),
  'GET /ops/outbox': () => ({ body: over.outbox ?? outboxView() }),
});
```

`apps/console/src/components/ErrorBox.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { describeError } from './ErrorBox';

/**
 * describeError의 모양. LogoutButton(점주 앱 사본)이 `describeError(error).detail`을 부른다 — 사본 검사는 LogoutButton 코드만 보고
 * 이 앱의 ErrorBox는 새로 쓴 것이라(decisions/0075), detail이 서버 메시지·연결 오류 메시지를 담는다는 약속을 여기서 지킨다(현장 앱과 같은 회귀 방지).
 */
describe('describeError (회귀 방지)', () => {
  it('api 오류: 관제 안내(title)와 서버 메시지(detail)·코드', () => {
    expect(describeError(new ApiError(409, 'JOB_NOT_FAILED', '실패 상태가 아닌 job입니다(지금 completed): report 3', null))).toEqual({
      title: '이 job은 이미 실패 상태가 아닙니다(다른 사람이 먼저 다시 시도했거나 지웠을 수 있습니다). 목록을 다시 읽었습니다.',
      detail: '실패 상태가 아닌 job입니다(지금 completed): report 3',
      code: 'JOB_NOT_FAILED',
    });
    expect(describeError(new ApiError(404, null, 'job이 없습니다: report 9', null)).title).toBe('찾는 큐·job이 없습니다(이미 지워졌을 수 있습니다).');
    expect(describeError(new ApiError(500, null, '서버 오류', null))).toEqual({ title: '요청이 실패했습니다(HTTP 500).', detail: '서버 오류', code: null });
  });

  it('연결 실패(api 오류가 아님): detail은 오류 메시지, 오류가 아닌 값은 글자로', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toEqual({
      title: 'api 서버에 연결하지 못했습니다. api가 떠 있는지 확인하세요.',
      detail: 'Failed to fetch',
      code: null,
    });
    expect(describeError('끊김').detail).toBe('끊김');
  });
});
```

`apps/console/src/api/query-keys.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { keys } from './query-keys';

/** 화면·컴포넌트 소스(테스트 제외). 키 글자를 직접 쓰는 곳이 없는지 본다 — 점주 앱 `api/query-keys.test.ts`와 같은 검사(decisions/0058) */
const sources = import.meta.glob(['../**/*.tsx', '../**/*.ts', '!../**/*.test.tsx', '!../**/*.test.ts', '!./query-keys.ts', '!../test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('쿼리 키 팩토리', () => {
  it('모든 키가 keys.all로 시작하고, 실패 목록 키는 keys.failedAll로 시작한다(다시 시도·지우기 뒤 무효화가 닿는다)', () => {
    const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) => prefix.every((p, i) => key[i] === p);
    for (const key of [keys.queues, keys.system, keys.outbox, keys.schedulers, keys.errors, keys.failedAll, keys.failed('report', 0), keys.actions]) {
      expect(startsWith(key, keys.all)).toBe(true);
    }
    expect(startsWith(keys.failed('outbox', 20), keys.failedAll)).toBe(true);
  });

  it('화면·컴포넌트는 키 글자를 직접 쓰지 않고 이 파일의 keys만 쓴다', () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(8); // glob이 실제로 소스를 읽었는지
    const offenders = files.filter((f) => /queryKey:\s*\[/.test(sources[f]));
    expect(offenders).toEqual([]);
  });
});
```

`apps/console/src/App.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { MeView } from '@terminal-ops/contracts';
import { getMe } from './session';
import { dashboardApi } from './test/fixtures';
import { ADMIN, MONITOR, mockApi, renderApp } from './test/render';

const UNAUTH = { status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } };

describe('로그인 문과 화면 틀 (보강 6, decisions/0074)', () => {
  it('로그인 안 했으면(/auth/me 401) 로그인 화면으로 간다', async () => {
    mockApi({ 'GET /auth/me': () => UNAUTH });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: '단말온 운영 관제' })).toBeInTheDocument();
  });

  it('관제로 로그인하면 대시보드로 가고 위에 메뉴 다섯과 자동 새로고침 단추가 보인다', async () => {
    const { calls } = mockApi({ 'GET /auth/me': () => UNAUTH, 'POST /auth/login': () => ({ body: MONITOR }), ...dashboardApi() });
    renderApp('/');
    await userEvent.type(await screen.findByLabelText('아이디'), ' monitor ');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('heading', { name: '대시보드' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({ loginId: 'monitor', password: 'pw' });
    const nav = screen.getByRole('navigation', { name: '메뉴' });
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['대시보드', '실패 job', '주기 작업', '최근 오류', '작업 기록']);
    expect(screen.getByRole('button', { name: '자동 새로고침 10초 · 켜짐' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('관제 담당 (관제)')).toBeInTheDocument();
  });

  it('ADMIN도 들어온다(보기)', async () => {
    mockApi({ 'GET /auth/me': () => ({ body: ADMIN }), ...dashboardApi() });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: '대시보드' })).toBeInTheDocument();
    expect(screen.getByText('관리자 (ADMIN)')).toBeInTheDocument();
  });

  it.each([
    ['운영자', { loginId: 'operator', displayName: '운영자', role: 'OPERATOR', merchantCode: null }],
    ['현장 작업자', { loginId: 'field', displayName: '현장', role: 'FIELD', merchantCode: null }],
    ['가맹점주', { loginId: 'merchant-gangnam', displayName: '점주', role: 'MERCHANT', merchantCode: 'GANGNAM-KIMBAP' }],
  ] as [string, MeView][])('%s 계정이면 안내와 로그아웃만 — 관제 API를 부르지 않는다', async (_name, me) => {
    const { calls } = mockApi({ 'GET /auth/me': () => ({ body: me }), 'POST /auth/logout': () => ({ status: 204 }) });
    renderApp('/');
    expect(await screen.findByText(/관제·ADMIN 계정용입니다/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/ops'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(await screen.findByRole('heading', { name: '단말온 운영 관제' })).toBeInTheDocument();
    expect(getMe()).toBeNull();
  });

  it('화면 요청이 401이면(세션 끝남) 로그인 화면으로', async () => {
    mockApi({ 'GET /auth/me': () => ({ body: MONITOR }), 'GET /ops/queues': () => UNAUTH, 'GET /ops/system': () => UNAUTH, 'GET /ops/outbox': () => UNAUTH });
    renderApp('/');
    await waitFor(() => expect(screen.getByRole('heading', { name: '단말온 운영 관제' })).toBeInTheDocument());
  });

  it('틀린 비밀번호는 안내 문구로', async () => {
    mockApi({
      'GET /auth/me': () => UNAUTH,
      'POST /auth/login': () => ({ status: 401, body: { statusCode: 401, code: 'LOGIN_FAILED', message: '아이디 또는 비밀번호가 틀립니다.' } }),
    });
    renderApp('/login');
    await userEvent.type(await screen.findByLabelText('아이디'), 'monitor');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('아이디 또는 비밀번호가 맞지 않습니다.');
  });
});
```

`apps/console/src/pages/DashboardPage.test.tsx`(자동 새로고침은 짧은 간격(40·50ms)과 실제 시계로 본다 — `renderApp(route, { refreshMs })`):

```tsx
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { focusManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { dashboardApi, minutesAgo, outboxView, queue, queuesView, systemView } from '../test/fixtures';
import { MONITOR, mockApi, renderApp } from '../test/render';

const ME = { 'GET /auth/me': () => ({ body: MONITOR }) };
const row = (name: string) => screen.getByRole('cell', { name: new RegExp(`^${name}`) }).closest('tr')!;

describe('대시보드 (보강 6)', () => {
  it('상태 카드: api 버전·기동 시각, MySQL·Redis 응답, 워커 프로세스 이름(큐마다 겹치면 하나로)', async () => {
    mockApi({ ...ME, ...dashboardApi({ system: systemView({ redis: { ok: false, latencyMs: null, error: 'Error: connect ECONNREFUSED 127.0.0.1:6379' } }) }) });
    renderApp('/');
    expect(await screen.findByText('worker-a')).toBeInTheDocument();
    expect(screen.getByText('1.2ms')).toBeInTheDocument();
    expect(screen.getByText('응답 없음')).toBeInTheDocument();
    expect(screen.getByText('Error: connect ECONNREFUSED 127.0.0.1:6379')).toBeInTheDocument();
    expect(screen.getByText('(1시간 전)')).toBeInTheDocument(); // 기동 90분 전
  });

  it('워커가 하나도 없으면 경고', async () => {
    mockApi({ ...ME, ...dashboardApi({ system: systemView({ workers: [] }) }) });
    renderApp('/');
    expect(await screen.findByText('큐를 처리하는 워커가 없습니다')).toBeInTheDocument();
  });

  it('큐 표: 대기(우선순위 포함)·처리 중·지연·남은 실패(실패 job 화면 링크)·최근 15분·가장 오래 기다린 job·워커, 멈춤 표시', async () => {
    const queues = queuesView([
      queue('track-bungae', { counts: { waiting: 3, active: 1, delayed: 2, prioritized: 1, failed: 0, completed: 0 }, oldestWaitingAt: minutesAgo(5), completedRecent: 42, failedRecent: 0 }),
      queue('report', { counts: { waiting: 0, active: 0, delayed: 0, prioritized: 0, failed: 2, completed: 0 }, paused: true, failedRecent: 2, workers: 0 }),
    ]);
    mockApi({ ...ME, ...dashboardApi({ queues }) });
    renderApp('/');
    await screen.findByRole('heading', { name: '대시보드' });
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
    const bungae = within(row('track-bungae'));
    expect(bungae.getAllByRole('cell').map((c) => c.textContent)).toEqual(['track-bungae ', '4', '1', '2', '0', '42', '0', expect.stringContaining('(5분 전)'), '1']);
    const report = within(row('report'));
    expect(report.getByText('멈춤')).toBeInTheDocument();
    expect(report.getByRole('link', { name: '2' })).toHaveAttribute('href', '/failed?queue=report');
    expect(report.getAllByRole('cell').at(-1)).toHaveClass('alert'); // 워커 0
    expect(screen.getByRole('columnheader', { name: '최근 15분 완료' })).toBeInTheDocument();
  });

  it('Outbox: 상태별 수와 가장 오래된 PENDING·QUEUED', async () => {
    mockApi({ ...ME, ...dashboardApi({ outbox: outboxView({ counts: { PENDING: 3, QUEUED: 7, SENT: 120, FAILED: 1 }, oldestPendingAt: minutesAgo(2), oldestQueuedAt: minutesAgo(30) }) }) });
    renderApp('/');
    expect(await screen.findByText('120')).toBeInTheDocument();
    expect(screen.getByText('큐에 넣음(QUEUED)').nextSibling).toHaveTextContent('7');
    expect(screen.getByText('(2분 전)')).toBeInTheDocument();
    expect(screen.getByText('(30분 전)')).toBeInTheDocument();
  });

  it('다시 읽다 실패하면 마지막 값을 두고 오류를 함께 보인다', async () => {
    let down = false;
    const api = dashboardApi({ queues: queuesView([queue('outbox', { completedRecent: 9 })]) });
    mockApi({ ...ME, ...api, 'GET /ops/queues': () => (down ? { status: 503, body: { statusCode: 503, message: '잠시 멈춤' } } : api['GET /ops/queues']()) });
    renderApp('/', { refreshMs: 50 });
    expect(await screen.findByText('9')).toBeInTheDocument();
    down = true;
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('요청이 실패했습니다(HTTP 503).');
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/^마지막 갱신 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} KST/);
  });
});

describe('자동 새로고침 (decisions/0076)', () => {
  afterEach(() => {
    act(() => focusManager.setFocused(undefined));
  });

  const countQueues = (calls: { path: string }[]) => calls.filter((c) => c.path === '/ops/queues').length;

  it('간격마다 다시 읽고, 위 단추로 끄면 멈춘다', async () => {
    const { calls } = mockApi({ ...ME, ...dashboardApi() });
    renderApp('/', { refreshMs: 40 });
    await waitFor(() => expect(countQueues(calls)).toBeGreaterThanOrEqual(3));
    await userEvent.click(screen.getByRole('button', { name: '자동 새로고침 10초 · 켜짐' }));
    expect(screen.getByRole('button', { name: '자동 새로고침 10초 · 꺼짐' })).toHaveAttribute('aria-pressed', 'false');
    const stopped = countQueues(calls);
    await new Promise((r) => setTimeout(r, 200));
    expect(countQueues(calls)).toBe(stopped);
  });

  it('탭이 안 보이면(focusManager가 포커스 없음) 간격 읽기를 건너뛴다', async () => {
    const { calls } = mockApi({ ...ME, ...dashboardApi() });
    renderApp('/', { refreshMs: 40 });
    await waitFor(() => expect(countQueues(calls)).toBeGreaterThanOrEqual(2));
    act(() => focusManager.setFocused(false));
    const hidden = countQueues(calls);
    await new Promise((r) => setTimeout(r, 200));
    expect(countQueues(calls)).toBe(hidden);
  });
});
```

어드민 — 관제 주소 기대값(기존 테스트 넷의 기대값만 바꾼다):

```diff
diff --git a/apps/admin/src/apps.test.ts b/apps/admin/src/apps.test.ts
index b6d8bb1..cb78a52 100644
--- a/apps/admin/src/apps.test.ts
+++ b/apps/admin/src/apps.test.ts
@@ -8,7 +8,7 @@ describe('다른 화면 주소 — 한 곳(apps.ts)과 env (보강 5, decisions/
     expect(urls({})).toEqual({
       merchant: 'http://localhost:5174',
       field: 'http://localhost:5175',
-      ops: null,
+      ops: 'http://localhost:5176',
       developers: null,
       partners: null,
       simulator: null,
@@ -22,7 +22,7 @@ describe('다른 화면 주소 — 한 곳(apps.ts)과 env (보강 5, decisions/
         VITE_FIELD_APP_URL: '',
         VITE_DEVELOPERS_APP_URL: 'http://developers.demo:8083',
       }),
-    ).toMatchObject({ merchant: 'http://merchant.demo:8081', field: 'http://localhost:5175', developers: 'http://developers.demo:8083', ops: null });
+    ).toMatchObject({ merchant: 'http://merchant.demo:8081', field: 'http://localhost:5175', developers: 'http://developers.demo:8083', ops: 'http://localhost:5176' });
   });
 
   it('http·https가 아닌 주소(javascript: 등)나 스킴 없는 값, 공백만 있는 값은 쓰지 않고 기본값', () => {
@@ -34,7 +34,7 @@ describe('다른 화면 주소 — 한 곳(apps.ts)과 env (보강 5, decisions/
         VITE_DEVELOPERS_APP_URL: 'data:text/html,x',
         VITE_SIMULATOR_APP_URL: 'HTTPS://sim.demo',
       }),
-    ).toMatchObject({ merchant: 'http://localhost:5174', field: 'http://localhost:5175', ops: null, developers: null, simulator: 'HTTPS://sim.demo' });
+    ).toMatchObject({ merchant: 'http://localhost:5174', field: 'http://localhost:5175', ops: 'http://localhost:5176', developers: null, simulator: 'HTTPS://sim.demo' });
   });
 
   it('테스트 실행(vitest)의 import.meta.env를 기본으로 읽는다 — VITE_ 주소를 주지 않았으면 기본 주소', () => {
```

```diff
diff --git a/apps/admin/src/components/Layout.test.tsx b/apps/admin/src/components/Layout.test.tsx
index 83fa38b..75b6688 100644
--- a/apps/admin/src/components/Layout.test.tsx
+++ b/apps/admin/src/components/Layout.test.tsx
@@ -46,15 +46,16 @@ describe('틀 — 로그인한 사람과 역할별 메뉴 (decisions/0041, api d
     expect(within(nav).getAllByRole('link')).toHaveLength(9);
   });
 
-  it('왼쪽 아래 "다른 화면": 매장·현장은 새 탭 링크, 아직 없는 화면 넷은 준비 중(링크 아님). 메뉴 링크 수에는 들지 않는다(보강 5)', async () => {
+  it('왼쪽 아래 "다른 화면": 매장·현장·관제는 새 탭 링크, 아직 없는 화면 셋은 준비 중(링크 아님). 메뉴 링크 수에는 들지 않는다(보강 5·6)', async () => {
     mockApi(HOME);
     loginAs('관제1', 'MONITOR');
     renderPage(<App />, { path: '/*' });
     const others = await screen.findByRole('navigation', { name: '다른 화면' });
     expect(within(others).getByRole('link', { name: '매장 화면' })).toHaveAttribute('href', 'http://localhost:5174');
     expect(within(others).getByRole('link', { name: '현장 화면' })).toHaveAttribute('target', '_blank');
-    expect(within(others).getAllByRole('link')).toHaveLength(2);
-    for (const name of ['운영 관제', '개발자센터', '가상 업체 콘솔', '단말기 시뮬레이터']) expect(within(others).getByText(`${name}(준비 중)`)).toBeInTheDocument();
+    expect(within(others).getByRole('link', { name: '운영 관제' })).toHaveAttribute('href', 'http://localhost:5176');
+    expect(within(others).getAllByRole('link')).toHaveLength(3);
+    for (const name of ['개발자센터', '가상 업체 콘솔', '단말기 시뮬레이터']) expect(within(others).getByText(`${name}(준비 중)`)).toBeInTheDocument();
     expect(within(screen.getByRole('navigation', { name: '메뉴' })).getAllByRole('link')).toHaveLength(9);
   });
 
```

- [ ] **Step 3: 실패 확인**

```bash
(cd apps/console && npx vitest run)
(cd apps/admin && npx vitest run src/apps.test.ts src/components/Layout.test.tsx)
```

Expected(사전 검증 원문 요약):
- console `Test Files  4 failed | 1 passed (5)`, `Tests  14 passed (14)` — `Failed to resolve import "../lib/refresh" from "src/test/render.tsx"`(App·DashboardPage), `"./query-keys"`, `"./ErrorBox"`. 사본 검사(14)는 이미 통과한다(사본이 같다)
- admin `Test Files  2 failed (2)`, `Tests  4 failed | 6 passed (10)` — `expected { …(6) } to deeply equal { …(6) }`(ops가 null), 다른 화면 링크 수 2 ≠ 3

- [ ] **Step 4: 구현**

`apps/console/src/styles.css`:

```css
/*
 * 운영 관제 화면 전역 CSS 한 장(어드민·점주·현장 앱과 같은 방식, decisions/0041·0074).
 * 넓은 모니터에 띄워 두고 보는 화면이라 데스크톱 우선(최대 1280px). 숫자는 고정폭 숫자(tabular-nums)로 줄이 흔들리지 않게.
 */
:root {
  --fg: #1f2328;
  --muted: #656d76;
  --line: #d0d7de;
  --bg: #f6f8fa;
  --card: #ffffff;
  --accent: #24292f;
  --danger: #cf222e;
  --ok: #1a7f37;
  --warn: #9a6700;
  font-family: system-ui, 'Malgun Gothic', sans-serif;
  font-size: 15px;
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

.top {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 24px;
  padding: 8px 24px;
  background: var(--accent);
  color: #fff;
}

.top .app-name {
  font-size: 17px;
}

.top .menu {
  display: flex;
  gap: 4px;
  flex: 1;
}

.top .menu a {
  color: #d0d7de;
  text-decoration: none;
  padding: 4px 10px;
  border-radius: 6px;
}

.top .menu a.active {
  color: #fff;
  background: rgba(255, 255, 255, 0.15);
}

.top .who {
  display: flex;
  align-items: center;
  gap: 8px;
}

.top .who small {
  color: #d0d7de;
}

.page {
  max-width: 1280px;
  margin: 0 auto;
  padding: 16px 24px 48px;
}

.page.narrow {
  max-width: 420px;
}

h1 {
  font-size: 20px;
  margin: 8px 0 12px;
}

h2 {
  font-size: 16px;
  margin: 24px 0 8px;
}

.muted {
  color: var(--muted);
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}

.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px 14px;
}

.card h3 {
  margin: 0 0 4px;
  font-size: 14px;
  color: var(--muted);
  font-weight: 600;
}

.card .big {
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.badge {
  display: inline-block;
  padding: 0 8px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  border: 1px solid currentColor;
}

.badge.ok {
  color: var(--ok);
}

.badge.bad {
  color: var(--danger);
}

.badge.warn {
  color: var(--warn);
}

table {
  width: 100%;
  border-collapse: collapse;
  background: var(--card);
  border: 1px solid var(--line);
}

th,
td {
  text-align: left;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}

td.num,
th.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

td.alert {
  color: var(--danger);
  font-weight: 700;
}

pre {
  margin: 4px 0 0;
  padding: 8px;
  background: var(--bg);
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 13px;
}

button {
  font: inherit;
  padding: 4px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--card);
  color: var(--fg);
  cursor: pointer;
}

button:disabled {
  opacity: 0.5;
  cursor: default;
}

button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}

button.danger {
  color: var(--danger);
  border-color: var(--danger);
}

.top button.toggle {
  background: transparent;
  color: #d0d7de;
  border-color: #57606a;
}

.top button.toggle.on {
  color: #fff;
  border-color: #fff;
}

.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin: 8px 0;
}

.login {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 64px;
}

.login label {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

input,
select {
  font: inherit;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 6px;
}

.error {
  margin: 8px 0;
  padding: 8px 12px;
  border: 1px solid var(--danger);
  border-radius: 6px;
  background: #ffebe9;
  color: var(--danger);
}

.error-detail {
  display: block;
  color: var(--muted);
}

.notice {
  margin: 8px 0;
  padding: 8px 12px;
  border: 1px solid var(--ok);
  border-radius: 6px;
  background: #dafbe1;
}

.logout-error {
  color: #ffb3b3;
}

.top button.link {
  background: transparent;
  color: #fff;
  border-color: #57606a;
}
```

`apps/console/src/lib/refresh.ts`:

```ts
import { useSyncExternalStore } from 'react';

/**
 * 자동 새로고침(보강 6, decisions/0076). 관제 화면은 띄워 두고 보는 화면이라 읽기 쿼리마다 10초 간격(refetchInterval)을 건다.
 * - 탭이 안 보이면 멈춘다: TanStack Query는 refetchIntervalInBackground가 false(기본)면 문서가 숨었을 때(focusManager) 간격 읽기를 건너뛴다
 * - 위 막대의 단추로 끌 수 있다(장애를 들여다보는 동안 숫자가 바뀌지 않게). 켜고 끈 것은 이 탭에서만 — 저장하지 않는다
 * - 관제 작업(다시 시도·지우기·복구 sweep) 뒤에는 간격을 기다리지 않고 그 작업이 바꾸는 쿼리를 무효화한다(api/query-keys.ts)
 */
export const REFRESH_MS = 10_000;

let enabled = true;
let intervalMs = REFRESH_MS;
const listeners = new Set<() => void>();

export function setAutoRefresh(on: boolean): void {
  enabled = on;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAutoRefresh(): boolean {
  return useSyncExternalStore(subscribe, () => enabled);
}

/** 읽기 쿼리에 붙이는 간격: 켜져 있으면 REFRESH_MS, 꺼져 있으면 false */
export function useRefetchInterval(): number | false {
  return useAutoRefresh() ? intervalMs : false;
}

/** 테스트용: 켜짐으로 되돌리고 간격을 정한다(test/render.tsx가 그릴 때마다 부른다 — 짧게 주면 실제 시계로 몇십 ms) */
export function resetAutoRefreshForTest(ms = REFRESH_MS): void {
  intervalMs = ms;
  setAutoRefresh(true);
}
```

`apps/console/src/api/query-keys.ts`(Task 4 화면의 키까지 한 번에):

```ts
/**
 * 쿼리 키. 모두 'console'로 시작한다(점주·현장 앱과 같은 방식 — 화면이 몇 개 안 된다).
 * 관제 작업 뒤에는 그 작업이 바꾸는 것만 무효화한다: 다시 시도·지우기 → 큐 요약·실패 목록·작업 기록, 복구 sweep → Outbox·작업 기록.
 */
export const keys = {
  all: ['console'] as const,
  queues: ['console', 'queues'] as const,
  system: ['console', 'system'] as const,
  outbox: ['console', 'outbox'] as const,
  schedulers: ['console', 'schedulers'] as const,
  errors: ['console', 'errors'] as const,
  failedAll: ['console', 'failed'] as const,
  failed: (queue: string, start: number) => ['console', 'failed', queue, start] as const,
  actions: ['console', 'actions'] as const,
};
```

`apps/console/src/components/ErrorBox.tsx`(사본이 아니라 관제 문구로 새로 씀 — `LogoutButton` 사본이 `describeError(error).detail`을 부른다):

```tsx
import type { ErrorCode } from '@terminal-ops/contracts';
import { ApiError } from '../api/client';

/**
 * 관제 화면의 오류 안내. 점주·현장 앱 ErrorBox와 모양은 같고 문구가 관제 일(큐·job·sweep)에 맞춘 것이다(사본이 아니라 새로 씀 — decisions/0062·0075).
 * 서버 메시지와 코드는 작은 글씨로 아래에 둔다(개발자가 그대로 찾아볼 수 있게).
 */
const HINT: Partial<Record<ErrorCode, string>> = {
  JOB_NOT_FAILED: '이 job은 이미 실패 상태가 아닙니다(다른 사람이 먼저 다시 시도했거나 지웠을 수 있습니다). 목록을 다시 읽었습니다.',
  FORBIDDEN: '이 작업은 관제 계정만 할 수 있습니다. ADMIN은 보기만 합니다.',
  UNAUTHENTICATED: '로그인이 끝났습니다. 다시 로그인하세요.',
  LOGIN_FAILED: '아이디 또는 비밀번호가 맞지 않습니다.',
  LOGIN_LOCKED: '로그인 실패가 많아 잠시 막혔습니다. 잠시 뒤 다시 시도하세요.',
};

export function describeError(error: unknown): { title: string; detail: string; code: ErrorCode | null } {
  if (error instanceof ApiError) {
    const hint = (error.code && HINT[error.code]) ?? (error.status === 404 ? '찾는 큐·job이 없습니다(이미 지워졌을 수 있습니다).' : error.status === 400 ? '요청 값을 확인하세요.' : null);
    return { title: hint ?? `요청이 실패했습니다(HTTP ${error.status}).`, detail: error.message, code: error.code };
  }
  return { title: 'api 서버에 연결하지 못했습니다. api가 떠 있는지 확인하세요.', detail: error instanceof Error ? error.message : String(error), code: null };
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

`apps/console/src/components/AuthGate.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useSessionCheck } from '../hooks/useSessionCheck';
import { wasLoggedOutOnPurpose } from '../session';
import { ErrorBox } from './ErrorBox';
import { LogoutButton } from './LogoutButton';

/**
 * 로그인해야 보이는 화면들의 문. 처음에는 GET /auth/me로 서버 세션을 확인하고, 로그인 안 했으면 로그인 화면으로(돌아올 주소와 함께).
 * 관제(MONITOR)와 ADMIN만 쓴다 — 서버의 /ops 보기 규칙(OPS_VIEW)과 같다(decisions/0070·0074). 다른 계정이면 안내와 로그아웃만.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { me, error } = useSessionCheck();
  const location = useLocation();

  if (me === undefined) return error ? <ErrorBox error={error} /> : <p className="page">로그인 확인 중…</p>;
  if (me === null) {
    const state = wasLoggedOutOnPurpose() ? undefined : { from: `${location.pathname}${location.search}` };
    return <Navigate to="/login" replace state={state} />;
  }
  if (me.role !== 'MONITOR' && me.role !== 'ADMIN') {
    return (
      <div className="page narrow">
        <p>이 화면은 관제·ADMIN 계정용입니다. 운영자는 운영 어드민을, 현장 작업자는 현장 화면을, 가맹점주는 매장 화면을 쓰세요.</p>
        <LogoutButton />
      </div>
    );
  }
  return <>{children}</>;
}

/** 관제 작업(다시 시도·지우기·sweep)을 할 수 있나 — 서버 규칙과 같게 MONITOR만. ADMIN은 보기만(단추 대신 안내) */
export const canOperate = (role: string | undefined) => role === 'MONITOR';
```

`apps/console/src/components/Shell.tsx`(메뉴 다섯은 Task 4 화면까지 — 이 Task에서는 대시보드 말고는 "없는 화면입니다"):

```tsx
import { NavLink, Outlet } from 'react-router';
import { REFRESH_MS, setAutoRefresh, useAutoRefresh } from '../lib/refresh';
import { useMe } from '../session';
import { LogoutButton } from './LogoutButton';

const ROLE_LABEL: Record<string, string> = { MONITOR: '관제', ADMIN: 'ADMIN' };

/**
 * 관제 화면 틀: 위 막대(앱 이름·메뉴·자동 새로고침 단추·내 이름·로그아웃)와 가운데 화면. 넓은 모니터에 띄워 두는 화면이라 데스크톱 우선.
 * 메뉴는 다섯 — 대시보드(상태·큐·Outbox), 실패 job, 주기 작업, 최근 오류, 작업 기록.
 */
export function Shell() {
  const me = useMe();
  const auto = useAutoRefresh();
  return (
    <>
      <header className="top">
        <strong className="app-name">단말온 운영 관제</strong>
        <nav className="menu" aria-label="메뉴">
          <NavLink to="/" end>
            대시보드
          </NavLink>
          <NavLink to="/failed">실패 job</NavLink>
          <NavLink to="/schedulers">주기 작업</NavLink>
          <NavLink to="/errors">최근 오류</NavLink>
          <NavLink to="/actions">작업 기록</NavLink>
        </nav>
        <div className="who">
          <button type="button" className={auto ? 'toggle on' : 'toggle'} aria-pressed={auto} onClick={() => setAutoRefresh(!auto)}>
            자동 새로고침 {REFRESH_MS / 1000}초 · {auto ? '켜짐' : '꺼짐'}
          </button>
          <small>
            {me?.displayName} ({me ? (ROLE_LABEL[me.role] ?? me.role) : ''})
          </small>
          <LogoutButton />
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </>
  );
}
```

`apps/console/src/components/Freshness.tsx`:

```tsx
import { formatKst } from '../lib/format';
import { ErrorBox } from './ErrorBox';

/**
 * 읽기 쿼리 하나의 "마지막 갱신" 줄(decisions/0076). 다시 읽다 실패하면 TanStack Query는 마지막 값을 그대로 두므로,
 * 화면에는 그 값을 두고 위에 오류와 "N 시각 값"을 함께 보인다 — 숫자가 멈춘 것을 모르고 보지 않게.
 */
export function Freshness({ updatedAt, fetching, error }: { updatedAt: number; fetching: boolean; error: unknown }) {
  return (
    <>
      <p className="muted" role="status">
        {updatedAt ? `마지막 갱신 ${formatKst(new Date(updatedAt).toISOString())}` : '읽는 중…'}
        {fetching && updatedAt ? ' · 다시 읽는 중' : ''}
      </p>
      {error ? <ErrorBox error={error} /> : null}
    </>
  );
}
```

`apps/console/src/pages/LoginPage.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import type { LoginRequest, MeView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { ErrorBox } from '../components/ErrorBox';
import { useSessionCheck } from '../hooks/useSessionCheck';
import { setMe } from '../session';

/** 관제·ADMIN 로그인(api decisions/0050, 같은 POST /auth/login). 성공하면 서버가 httpOnly 세션 쿠키를 주고, 화면은 응답(내 정보)만 기억한다 */
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
      <h1>단말온 운영 관제</h1>
      <p className="muted">큐·주기 작업·Outbox·오류를 보고, 실패한 job을 다시 시도합니다.</p>
      <label>
        아이디
        <input aria-label="아이디" autoComplete="username" value={loginId} maxLength={50} onChange={(e) => setLoginId(e.target.value)} />
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

`apps/console/src/pages/DashboardPage.tsx`(Task 4가 복구 sweep 단추를 더한다):

```tsx
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { OpsDependencyView, OpsOutboxView, OpsQueuesView, OpsSystemView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { Freshness } from '../components/Freshness';
import { agoText, formatKst } from '../lib/format';
import { useRefetchInterval } from '../lib/refresh';

/** 시각과 "N분 전"을 한 칸에. 없으면 '-' */
export function When({ iso, now }: { iso: string | null; now: Date }) {
  if (!iso) return <>-</>;
  return (
    <span title={iso}>
      {formatKst(iso)} <small className="muted">({agoText(iso, now)})</small>
    </span>
  );
}

function Dependency({ name, dep }: { name: string; dep: OpsDependencyView }) {
  return (
    <div className="card">
      <h3>{name}</h3>
      {dep.ok ? <span className="badge ok">정상</span> : <span className="badge bad">응답 없음</span>}{' '}
      <span className="big">{dep.latencyMs === null ? '' : `${dep.latencyMs}ms`}</span>
      {dep.error ? <pre>{dep.error}</pre> : null}
    </div>
  );
}

function SystemCards({ system, now }: { system: OpsSystemView; now: Date }) {
  const names = [...new Set(system.workers.map((w) => w.name ?? '(이름 없음)'))];
  return (
    <div className="cards">
      <div className="card">
        <h3>api</h3>
        <span className="big">{system.api.version}</span>
        <div className="muted">
          기동 <When iso={system.api.startedAt} now={now} />
        </div>
        <div className="muted">
          node {system.api.node} · 큐 접두사 {system.api.queuePrefix}
        </div>
      </div>
      <Dependency name="MySQL" dep={system.mysql} />
      <Dependency name="Redis" dep={system.redis} />
      <div className="card">
        <h3>워커 프로세스</h3>
        <span className="big">{names.length}</span>
        {names.length === 0 ? <div className="badge bad">큐를 처리하는 워커가 없습니다</div> : <div className="muted">{names.join(', ')}</div>}
      </div>
    </div>
  );
}

function QueueTable({ data, now }: { data: OpsQueuesView; now: Date }) {
  return (
    <table>
      <thead>
        <tr>
          <th>큐</th>
          <th className="num">대기</th>
          <th className="num">처리 중</th>
          <th className="num">지연</th>
          <th className="num">실패(남은 것)</th>
          <th className="num">최근 {data.recentMinutes}분 완료</th>
          <th className="num">최근 {data.recentMinutes}분 실패</th>
          <th>가장 오래 기다린 job</th>
          <th className="num">워커</th>
        </tr>
      </thead>
      <tbody>
        {data.queues.map((q) => (
          <tr key={q.name}>
            <td>
              {q.name} {q.paused ? <span className="badge warn">멈춤</span> : null}
            </td>
            <td className="num">{q.counts.waiting + q.counts.prioritized}</td>
            <td className="num">{q.counts.active}</td>
            <td className="num">{q.counts.delayed}</td>
            <td className={q.counts.failed > 0 ? 'num alert' : 'num'}>
              {q.counts.failed > 0 ? <Link to={`/failed?queue=${q.name}`}>{q.counts.failed}</Link> : 0}
            </td>
            <td className="num">{q.completedRecent ?? '-'}</td>
            <td className={q.failedRecent ? 'num alert' : 'num'}>{q.failedRecent ?? '-'}</td>
            <td>
              <When iso={q.oldestWaitingAt} now={now} />
            </td>
            <td className={q.workers === 0 ? 'num alert' : 'num'}>{q.workers}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const OUTBOX_LABEL = { PENDING: '대기(PENDING)', QUEUED: '큐에 넣음(QUEUED)', SENT: '보냄(SENT)', FAILED: '실패(FAILED)' } as const;

function OutboxCards({ outbox, now }: { outbox: OpsOutboxView; now: Date }) {
  return (
    <>
      <div className="cards">
        {(Object.keys(OUTBOX_LABEL) as (keyof typeof OUTBOX_LABEL)[]).map((s) => (
          <div className="card" key={s}>
            <h3>{OUTBOX_LABEL[s]}</h3>
            <span className="big">{outbox.counts[s]}</span>
          </div>
        ))}
      </div>
      <p>
        가장 오래된 PENDING: <When iso={outbox.oldestPendingAt} now={now} /> · 가장 오래된 QUEUED: <When iso={outbox.oldestQueuedAt} now={now} />
      </p>
    </>
  );
}

/**
 * 대시보드(보강 6): 프로세스·의존 상태 카드, 큐 표(실패 수는 실패 job 화면으로 가는 링크), Outbox 카드.
 * 세 쿼리 모두 자동 새로고침(decisions/0076). "N분 전"은 다시 읽을 때마다 지금 시각으로 다시 센다.
 */
export function DashboardPage() {
  const refetchInterval = useRefetchInterval();
  const system = useQuery({ queryKey: keys.system, queryFn: () => api<OpsSystemView>('/ops/system'), refetchInterval });
  const queues = useQuery({ queryKey: keys.queues, queryFn: () => api<OpsQueuesView>('/ops/queues'), refetchInterval });
  const outbox = useQuery({ queryKey: keys.outbox, queryFn: () => api<OpsOutboxView>('/ops/outbox'), refetchInterval });
  const now = new Date(Math.max(system.dataUpdatedAt, queues.dataUpdatedAt, outbox.dataUpdatedAt) || Date.now());

  return (
    <>
      <h1>대시보드</h1>
      <Freshness updatedAt={queues.dataUpdatedAt} fetching={queues.isFetching} error={system.error ?? queues.error ?? outbox.error} />

      <h2>프로세스·의존 상태</h2>
      {system.data ? <SystemCards system={system.data} now={now} /> : null}

      <h2>큐</h2>
      {queues.data ? <QueueTable data={queues.data} now={now} /> : null}

      <h2>Outbox(알림)</h2>
      {outbox.data ? <OutboxCards outbox={outbox.data} now={now} /> : null}
    </>
  );
}
```

`apps/console/src/App.tsx`(Task 4가 경로 넷을 더한다):

```tsx
import { Route, Routes } from 'react-router';
import { AuthGate } from './components/AuthGate';
import { SessionCacheSync } from './components/SessionCacheSync';
import { Shell } from './components/Shell';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';

/** 화면 경로. /login 말고는 모두 관제·ADMIN 계정으로 로그인해야 보인다(AuthGate) */
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
          <Route index element={<DashboardPage />} />
          <Route path="*" element={<p>없는 화면입니다.</p>} />
        </Route>
      </Routes>
    </>
  );
}
```

어드민 관제 주소:

```diff
diff --git a/apps/admin/src/apps.ts b/apps/admin/src/apps.ts
index 342cf45..527649c 100644
--- a/apps/admin/src/apps.ts
+++ b/apps/admin/src/apps.ts
@@ -25,7 +25,8 @@ export function otherApps(env: Env = import.meta.env): OtherApp[] {
   return [
     { key: 'merchant', label: '매장 화면', who: '가맹점주', url: pick('VITE_MERCHANT_APP_URL', 'http://localhost:5174') },
     { key: 'field', label: '현장 화면', who: '현장 작업자', url: pick('VITE_FIELD_APP_URL', 'http://localhost:5175') },
-    { key: 'ops', label: '운영 관제', who: '관제·개발자', url: pick('VITE_OPS_APP_URL', null) },
+    // 보강 6: 운영 관제 화면 apps/console(:5176, decisions/0074)
+    { key: 'ops', label: '운영 관제', who: '관제·개발자', url: pick('VITE_OPS_APP_URL', 'http://localhost:5176') },
     { key: 'developers', label: '개발자센터', who: '외부 업체 연동(키 발급·폐기)', url: pick('VITE_DEVELOPERS_APP_URL', null) },
     { key: 'partners', label: '가상 업체 콘솔', who: '세움전자·번개택배·느림보물류·브릿지VAN·톡톡메신저', url: pick('VITE_PARTNERS_CONSOLE_URL', null) },
     { key: 'simulator', label: '단말기 시뮬레이터', who: '하트비트·펌웨어 보고', url: pick('VITE_SIMULATOR_APP_URL', null) },
```

- [ ] **Step 5: launch.json(커밋 안 함)**

세션 루트 `C:\Devhyun\History\.claude\launch.json`과 저장소 `.claude/launch.json`의 `configurations` 끝(`terminal-ops-field` 항목 뒤)에 같은 항목을 더한다(Edit 도구, 앞 항목 뒤에 쉼표):

```json
    {
      "name": "terminal-ops-console",
      "runtimeExecutable": "node",
      "runtimeArgs": [
        "C:/Devhyun/History/ToyProject/terminal-ops/apps/console/node_modules/vite/bin/vite.js",
        "C:/Devhyun/History/ToyProject/terminal-ops/apps/console"
      ],
      "port": 5176
    }
```

```bash
node -e "for (const f of ['C:/Devhyun/History/.claude/launch.json', '.claude/launch.json']) console.log(f, JSON.parse(require('fs').readFileSync(f, 'utf8')).configurations.map((c) => c.name).join(', '))"
git status --short .claude   # 아무것도 나오지 않는다(gitignore)
```

Expected: 두 파일 모두 `…, terminal-ops-field, terminal-ops-console`.

- [ ] **Step 6: 통과 확인**

```bash
(cd apps/console && npx vitest run && npm run build && rm -rf dist)
(cd apps/admin && npx vitest run && npm run build && rm -rf dist)
(cd apps/field && npx vitest run 2>&1 | tail -3)   # 현장 사본 검사 그대로
(cd apps/merchant && npx vitest run 2>&1 | tail -3)   # 머리 주석만 바뀜
```

Expected(사전 검증): console `Test Files  5 passed (5)`, `Tests  33 passed (33)`, build 성공(tsc 포함). admin `Test Files  19 passed (19)`, `Tests  163 passed (163)`(수 그대로 — 기대값만 바꿈), build 성공. field `7 passed`·`60 passed`, merchant `7 passed`·`47 passed`.

- [ ] **Step 7: 기록**

`docs/decisions/0074-운영-관제-화면은-별도-앱-apps-console.md`:

````markdown
# 0074. 운영 관제 화면은 별도 앱 apps/console

- 날짜 / 관련 기능: 2026-10-29 / 보강 6, 운영 관제
- 상황: 관제·개발자가 큐·워커·주기 작업·Outbox·업무 오류를 보고 실패 job을 다시 돌리는 화면(0070의 `/ops`)을 어디에 둘지. 사용자가 원한 것은 "운영 관제 화면 + 운영자 어드민 + 외부 연동 개발자센터"로 셋이 나뉘어 있고, 어드민의 "다른 화면"은 운영 관제를 별도 화면 자리로 잡아 두었다(0067, `VITE_OPS_APP_URL`).
- 선택지:
  1. 어드민 안 "관제" 메뉴(MONITOR·ADMIN) — 로그인·api 클라이언트·틀이 이미 있어 사본이 없다. 단점: 어드민은 운영자 업무 화면(메뉴 9개, MONITOR도 업무 읽기로 이미 쓴다)이고 관제 화면은 띄워 두고 보는 자동 새로고침·개발자용 값(job id, 큐 접두사, 워커 이름)이 주인이라 성격이 다르다. 어드민 메뉴 수·역할 테스트(163개)가 영향 범위에 들어오고, 어드민 `RequireRole`·메뉴 표를 넓혀야 한다
  2. **별도 앱 `apps/console`(:5176)** — 다른 화면 앱(점주 0057·현장 0061)처럼 목적 하나. 넓은 모니터 기본 레이아웃·자동 새로고침을 앱 전체 기본으로 둔다. 어드민은 `apps.ts` 주소 한 줄만
  3. 정적 HTML·기성 대시보드(bull-board) — 0070에서 버렸다(로그인·감사 기록과 따로 논다)
- 결정: 2. 포트는 현장 앱 옆 5176(미리보기 4176), `CONSOLE_API_URL`로 api 주소를 바꾼다(다른 앱과 같은 Vite 프록시 — CORS를 열지 않는다). 관제·ADMIN만 들어오고(`/ops` 보기 규칙과 같다), 다른 역할이면 안내와 로그아웃만. 관제 작업 단추는 MONITOR에게만 보인다(서버도 403).
- 결과·대가: 공통 코드가 네 벌째(0075). localhost 쿠키(`sid`)를 네 앱이 함께 쓴다 — 관제 화면에서 로그인하면 같은 브라우저의 어드민 세션이 끝난다(기존 한계, 화면 안내 그대로). 개발 서버·launch 구성이 하나 는다.
- 다시 볼 조건: 관제 화면이 어드민의 업무 화면(단말기 상세 등)으로 자주 건너가야 하거나, 화면 앱이 다섯을 넘어 공통 틀을 나누게 되면(0075) 묶는 것을 다시 본다.
````

`docs/decisions/0075-네-번째-화면도-점주-사본과-사본-검사로.md`:

````markdown
# 0075. 네 번째 화면 앱도 점주 앱 사본과 사본 검사로

- 날짜 / 관련 기능: 2026-10-29 / 보강 6, 관제·점주·현장 화면
- 상황: 관제 앱(0074)에도 api 클라이언트·세션 저장소·사람이 바뀌면 캐시 비우기·세션 확인 훅·조회 재시도 판정·KST 형식·로그아웃 버튼·테스트 정리·시작점이 필요하다(점주 앱 사본 9개, 주석 포함 310줄). 0062는 "화면 앱이 넷이 되거나 같은 버그를 두 사본에서 고치는 일이 두 번 생기면" 공유 패키지(설정은 이미 확인됨) 또는 workspaces를 다시 보라고 했다 — 앱이 넷이 됐다.
- 확인한 것: 현장 사본 9개는 만든 뒤(보강 4, f307bfc) 코드가 바뀐 적이 없다 — `git log -- apps/field/src/<사본>`에 나오는 커밋은 만든 커밋과 `main.tsx` 머리 주석·사본 목록을 더한 943dd95 하나뿐이고, 점주 쪽 사본도 그 뒤로는 머리 주석에 현장 사본 표시를 더한 cd59070 하나뿐이다. 두 사본을 같이 고친 버그는 0번.
- 선택지:
  1. 공유 패키지(`packages/web-common`, `file:` + TS 소스) — 0062가 잰 비용이 앱마다 든다: `resolve.dedupe` 1줄·`paths` 4줄·의존 1줄·lock 9줄·다시 내보내기 6파일. 이번에는 점주·현장·관제 세 앱이고, 점주·현장 앱(테스트 107개)을 이 보강에서 고쳐야 한다. `LogoutButton`은 앱마다 다른 `describeError`를 불러 그대로 옮기지 못한다
  2. 루트 npm workspaces — 0047이 잰 것처럼 lock을 합치며 판이 바뀐다(43/707). 관제 기능과 섞지 않고 따로 한 묶음이어야 한다
  3. **복사 + 사본 검사(0062 그대로)** — 관제 앱 사본은 현장 앱에서 `cp`(현장 사본은 점주와 코드가 같다), 관제 `src/copies.test.ts`가 점주 앱과 비교한다. 설정·lock 변화 없음, 점주·현장 앱을 건드리지 않는다
- 결정: 3. 고친 적이 없는 사본을 위해 세 앱의 설정을 바꾸는 것(1)과 lock 판 올림(2)은 관제 기능과 섞을 일이 아니다. 사본 검사가 "모르는 사이에 어긋남"을 막는다(점주만 고치면 현장·관제 테스트가 실패한다).
  - 사본 검사 파일 자체도 현장 앱 것의 사본이다(비교할 앱 이름 `'console'`과 주석만 다르다) — 검사 대상은 아니다
  - 오류 안내(`ErrorBox`)·화면 틀·로그인 문은 복사하지 않고 관제 문구로 새로 쓴다(0062와 같은 방향)
- 결과·대가: 같은 규칙의 코드가 어드민·점주·현장·관제 네 곳(점주·현장·관제는 테스트로 묶임). 점주 사본을 고치면 현장·관제 사본도 고쳐야 각 앱 테스트가 통과한다(고칠 곳이 셋). 사본 검사 파일이 두 벌(약 110줄씩).
- 다시 볼 조건: 다음 화면 앱(보강 7 개발자센터, 보강 8 업체 콘솔·시뮬레이터)으로 다섯을 넘기 전에 workspaces 또는 공유 패키지를 **따로 한 묶음**(lock 판 올림은 한 커밋)으로 다시 잰다. 그 전이라도 사본을 고치는 일이 두 번 생기면 그때.
````

`docs/decisions/0076-관제-화면-자동-새로고침은-10초-탭-숨김이면-멈춤.md`:

````markdown
# 0076. 관제 화면 자동 새로고침은 10초, 탭이 안 보이면 멈추고, 단추로 끈다

- 날짜 / 관련 기능: 2026-10-29 / 보강 6, 운영 관제 화면
- 상황: 관제 화면은 띄워 두고 보는 화면이다. 숫자가 저절로 바뀌어야 하지만, 여러 탭·여러 사람이 띄워 두면 api·Redis를 계속 부른다(0070: 캐시 없음). 장애를 들여다보는 동안에는 숫자가 움직이지 않는 편이 낫다.
- 선택지:
  1. 수동 새로고침만 — 띄워 두는 화면에 맞지 않다
  2. **TanStack Query `refetchInterval` 10초 + 탭 숨김이면 멈춤 + 끄기 단추** — 라이브러리 기본 동작(`refetchIntervalInBackground: false`면 문서가 숨었을 때 간격 읽기를 건너뛴다)을 그대로 쓴다
  3. 서버 푸시(SSE·웹소켓) — 새 연결 종류·쿠키 인증·프록시 설정이 든다(0038에서도 버림)
  4. 2초(0038 `RunningPoller`처럼) — 진행 중인 한 작업을 기다릴 때 맞는 간격이다. 관제 화면은 경향을 본다
- 결정: 2.
  - 간격 10초: 주기 작업 중 짧은 것(relay 2초, 배포 판단 5초, 오프라인 판정 10초)이 한두 번 돈 뒤에 보인다. 대시보드 한 화면은 10초마다 요청 셋(`/ops/queues`·`/ops/system`·`/ops/outbox`)
  - 끄기 단추(위 막대 "자동 새로고침 10초 · 켜짐/꺼짐", `aria-pressed`)는 이 탭에서만 — 저장하지 않는다(다시 열면 켜짐: 띄워 둔 화면이 멈춘 채 잊히지 않게)
  - 다시 읽다 실패하면 TanStack Query가 마지막 값을 그대로 두므로, 화면은 그 값 위에 오류와 "마지막 갱신 … KST"를 함께 보인다(`Freshness` — 숫자가 멈춘 것을 모르고 보지 않게)
  - "N분 전"은 응답을 받은 시각 기준으로 센다(다시 읽을 때마다 바뀐다)
  - 사전 검증: 대시보드 쿼리에 `refetchIntervalInBackground: true`를 넣자 "탭이 안 보이면 간격 읽기를 건너뛴다" 테스트가 실패했다(테스트가 그 동작을 실제로 잡는다)
- 결과·대가: 화면을 띄운 탭 수만큼 10초마다 요청이 는다. 탭이 보이는 채 다른 창 뒤에 있으면(가려졌지만 hidden이 아님) 계속 읽는다. 창으로 돌아올 때 다시 읽기(`refetchOnWindowFocus`)는 staleTime(30초, 사본 `query-client.ts`)이 지났을 때만이다.
- 다시 볼 조건: 관제 화면을 상시 여럿이 띄우게 되면 간격을 늘리거나 서버에서 몇 초 캐시(0070 다시 볼 조건). 실시간에 가까워야 하는 지표가 생기면 3.
````

`docs/decisions/0062-세-번째-화면도-복사와-사본-검사-테스트로.md` 끝에 한 줄:

```markdown
- 보강 6 보탬(decisions/0075): 네 번째 화면 앱(관제 `apps/console`)이 "다시 볼 조건"에 닿았다. 현장 사본이 만든 뒤 한 번도 고쳐지지 않았고(두 사본을 같이 고친 버그 0번) 공유 패키지·workspaces는 세 앱의 설정·lock을 바꾸는 일이라, 이번에도 복사 + 사본 검사로 하고 다섯 번째 앱 전에 따로 한 묶음으로 다시 재기로 했다.
```

`docs/decisions/0067-다른-화면-바로가기-주소는-apps-ts-한-곳과-Vite-env로.md` 끝에 한 줄:

```markdown
- 보강 6 보탬(decisions/0074): 운영 관제 화면(`apps/console`)이 생겨 `apps.ts`의 `ops` 기본 주소를 `http://localhost:5176`으로 채웠다(`VITE_OPS_APP_URL`로 바꾼다). "준비 중"은 개발자센터·가상 업체 콘솔·단말기 시뮬레이터 셋.
```

`docs/study/backlog.md` 끝에 한 줄:

```markdown
- [ ] TanStack Query `focusManager`와 `refetchIntervalInBackground` — "문서가 숨었다"를 무엇으로 아나(visibilitychange), 가려진 창은? (apps/console/src/lib/refresh.ts, decisions/0076)
```

devlog(Task 2 항목 뒤):

```markdown
## HH:MM Task 3 관제 앱 골격 — 점주 사본·사본 검사, 로그인 문·대시보드·자동 새로고침, 어드민 관제 주소 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <Task 2 커밋 해시>
- 한 일: `apps/console`(:5176·4176, 현장 앱과 같은 판·lock) — 점주 사본 9개(현장 앱에서 cp)와 사본 검사, 관제 문구 ErrorBox, 로그인 문(관제·ADMIN만), 위 막대(메뉴 다섯·자동 새로고침 단추), 대시보드(상태 카드·큐 표·Outbox 카드), `Freshness`(마지막 갱신·오류). 어드민 `apps.ts` 관제 주소 :5176, 점주 사본 9개 머리 주석에 관제 사본 표시. launch.json 두 곳에 `terminal-ops-console`(커밋 안 함)
- 확인: console 실패(`Failed to resolve import` 넷) → `Test Files  <수> passed (<수>)`, `Tests  <수> passed (<수>)`, build 성공. admin `Tests  <수> passed (<수>)`(기대값 넷만 바꿈), build. field 그대로
- 결정: decisions/0074(별도 앱), 0075(사본 + 사본 검사 유지, 다섯 번째 앱 전에 다시), 0076(자동 새로고침), 0062·0067 보탬
- 다음: Task 4 관제 화면(실패 job·주기 작업·최근 오류·작업 기록·복구 sweep)
```

```bash
node scripts/docs-index.mjs
```

- [ ] **Step 8: 커밋**

```bash
git add apps/console apps/admin apps/merchant docs
git status --short   # node_modules·dist가 없어야 한다
git ls-files --eol apps/console/src/App.tsx apps/console/package-lock.json   # i/lf
git commit -m "$(cat <<'EOF'
feat(ops): 운영 관제 앱 골격 — 점주 사본·사본 검사, 로그인 문·대시보드·자동 새로고침, 어드민 관제 주소

Refs: docs/decisions/0074-운영-관제-화면은-별도-앱-apps-console.md, docs/decisions/0075-네-번째-화면도-점주-사본과-사본-검사로.md, docs/decisions/0076-관제-화면-자동-새로고침은-10초-탭-숨김이면-멈춤.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 제목 시각 = 커밋 시각인지 보고, 다르면 고쳐 `git commit --amend --no-edit`.

---


### Task 4: 관제 화면 — 실패 job·주기 작업·최근 오류·작업 기록, Outbox 복구 sweep 단추

**Files:**
- Create: `apps/console/src/lib/labels.ts`, `apps/console/src/pages/FailedJobsPage.tsx`, `SchedulersPage.tsx`, `ErrorsPage.tsx`, `ActionsPage.tsx`
- Modify: `apps/console/src/pages/DashboardPage.tsx`, `apps/console/src/App.tsx`
- Test: Create `apps/console/src/lib/labels.test.ts`, `apps/console/src/pages/FailedJobsPage.test.tsx`, `apps/console/src/pages/ListPages.test.tsx`
- Docs: Modify `docs/decisions/0076-관제-화면-자동-새로고침은-10초-탭-숨김이면-멈춤.md`, `docs/index.md`, `docs/devlog/2026-10-29.md`

- [ ] **Step 1: 실패하는 테스트**

`apps/console/src/lib/labels.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { scheduleText } from './labels';

describe('주기 글자', () => {
  it('간격은 딱 떨어지는 가장 큰 단위로, 안 떨어지면 ms', () => {
    expect(scheduleText({ every: 2_000, pattern: null, tz: null })).toBe('2초마다');
    expect(scheduleText({ every: 60_000, pattern: null, tz: null })).toBe('1분마다');
    expect(scheduleText({ every: 7_200_000, pattern: null, tz: null })).toBe('2시간마다');
    expect(scheduleText({ every: 1_500, pattern: null, tz: null })).toBe('1500ms마다');
  });

  it('cron은 식과 시간대', () => {
    expect(scheduleText({ every: null, pattern: '0 9 * * 1', tz: 'Asia/Seoul' })).toBe('cron 0 9 * * 1 (Asia/Seoul)');
    expect(scheduleText({ every: null, pattern: '0 2 * * *', tz: null })).toBe('cron 0 2 * * * (서버 시간대)');
  });
});
```

`apps/console/src/pages/FailedJobsPage.test.tsx`(가짜 api가 큐마다 남은 job을 들고 있어 다시 시도·지우기 뒤 목록이 실제로 줄어든다. 확인창은 `vi.spyOn(window, 'confirm')`):

```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { OpsFailedJobView } from '@terminal-ops/contracts';
import { minutesAgo, queue, queuesView } from '../test/fixtures';
import { ADMIN, MONITOR, mockApi, renderApp } from '../test/render';

const job = (id: string, over: Partial<OpsFailedJobView> = {}): OpsFailedJobView => ({
  queue: 'report',
  id,
  name: 'van-reconcile',
  data: { runId: 7, apiToken: '[가림]' },
  failedReason: '브릿지VAN 목록 응답 503',
  attemptsMade: 1,
  maxAttempts: 1,
  createdAt: minutesAgo(30),
  failedAt: minutesAgo(29),
  ...over,
});

const QUEUES = queuesView([
  queue('outbox'),
  queue('report', { counts: { waiting: 0, active: 0, delayed: 0, prioritized: 0, failed: 2, completed: 0 } }),
]);

/** 실패 job 화면의 가짜 api. failed는 큐 이름마다 남은 job(부를 때마다 지금 값을 읽는다) */
function failedApi(me = MONITOR, failed: Record<string, OpsFailedJobView[]> = { report: [job('van-run-7'), job('repeat:weekly-report:1', { name: 'weekly-report', data: {} })] }) {
  return mockApi({
    'GET /auth/me': () => ({ body: me }),
    'GET /ops/queues': () => ({ body: QUEUES }),
    'GET /ops/queues/:name/failed': (call) => {
      const name = call.path.split('/')[3];
      const items = failed[name] ?? [];
      const start = Number(call.query.get('start'));
      return { body: { items: items.slice(start, start + 20), total: items.length, start, limit: 20 } };
    },
    'POST /ops/queues/:name/jobs/:id/retry': (call) => {
      const id = decodeURIComponent(call.path.split('/')[5]);
      failed.report = failed.report.filter((j) => j.id !== id);
      return { body: { queue: 'report', jobId: id, action: 'RETRY_JOB', actionId: 11 } };
    },
    'POST /ops/queues/:name/jobs/:id/remove': (call) => {
      const id = decodeURIComponent(call.path.split('/')[5]);
      failed.report = failed.report.filter((j) => j.id !== id);
      return { body: { queue: 'report', jobId: id, action: 'REMOVE_JOB', actionId: 12 } };
    },
  });
}

describe('실패 job (보강 6, decisions/0072)', () => {
  it('큐를 고르지 않으면 실패가 있는 첫 큐를 보이고, 실패 시각·job·시도·이유, 자세히는 가린 data', async () => {
    const { calls } = failedApi();
    renderApp('/failed');
    expect(await screen.findByText('van-run-7')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '큐' })).toHaveValue('report');
    expect(screen.getByRole('option', { name: 'report (실패 2)' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/ops/queues/report/failed')?.query.get('limit')).toBe('20');
    const row = screen.getByText('van-run-7').closest('tr')!;
    expect(within(row).getByText('1/1')).toBeInTheDocument();
    expect(within(row).getByText('브릿지VAN 목록 응답 503')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: '자세히' }));
    expect(screen.getByText(/"apiToken": "\[가림\]"/)).toBeInTheDocument();
    expect(screen.getByText('1–2 / 2')).toBeInTheDocument();
  });

  it('주소의 ?queue=로 큐를 고르고, 고르기를 바꾸면 그 큐를 읽는다', async () => {
    const { calls } = failedApi();
    renderApp('/failed?queue=outbox');
    expect(await screen.findByText('이 큐에 남은 실패 job이 없습니다.')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '큐' }), 'report');
    expect(await screen.findByText('van-run-7')).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith('/failed')).map((c) => c.path)).toEqual(['/ops/queues/outbox/failed', '/ops/queues/report/failed']);
  });

  it('다시 시도: 확인창을 취소하면 부르지 않고, 확인하면 POST 뒤 알림과 목록·큐 요약·작업 기록을 다시 읽는다(job id는 주소에 맞게 인코딩)', async () => {
    const { calls } = failedApi();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    renderApp('/failed');
    const row = (await screen.findByText('repeat:weekly-report:1')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: '다시 시도' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await userEvent.click(within(row).getByRole('button', { name: '다시 시도' }));
    expect(confirm.mock.calls[1][0]).toBe('report의 job repeat:weekly-report:1(weekly-report)을(를) 다시 시도할까요? 시도 횟수를 0으로 되돌려 처음부터 다시 처리합니다.');
    expect(await screen.findByText('report의 job repeat:weekly-report:1을(를) 다시 시도했습니다(작업 기록 #11).')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.path).toBe('/ops/queues/report/jobs/repeat%3Aweekly-report%3A1/retry');
    await waitFor(() => expect(screen.queryByText('repeat:weekly-report:1')).not.toBeInTheDocument());
    expect(calls.filter((c) => c.path === '/ops/queues').length).toBeGreaterThanOrEqual(2);
  });

  it('지우기는 되돌릴 수 없다고 묻고 지운다', async () => {
    const { calls } = failedApi();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/failed');
    const row = (await screen.findByText('van-run-7')).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: '지우기' }));
    expect(confirm.mock.calls[0][0]).toContain('되돌릴 수 없습니다.');
    expect(await screen.findByText('report의 job van-run-7을(를) 지웠습니다(작업 기록 #12).')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.path).toBe('/ops/queues/report/jobs/van-run-7/remove');
  });

  it('409 JOB_NOT_FAILED(다른 사람이 먼저 처리)면 안내를 보이고 목록을 다시 읽는다', async () => {
    const failed = { report: [job('van-run-7')] };
    const { calls } = mockApi({
      'GET /auth/me': () => ({ body: MONITOR }),
      'GET /ops/queues': () => ({ body: QUEUES }),
      'GET /ops/queues/:name/failed': () => ({ body: { items: failed.report, total: failed.report.length, start: 0, limit: 20 } }),
      'POST /ops/queues/:name/jobs/:id/retry': () => {
        failed.report = [];
        return { status: 409, body: { statusCode: 409, code: 'JOB_NOT_FAILED', message: '실패 상태가 아닌 job입니다(지금 completed): report van-run-7' } };
      },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/failed?queue=report');
    await userEvent.click(within((await screen.findByText('van-run-7')).closest('tr')!).getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('이 job은 이미 실패 상태가 아닙니다');
    expect(await screen.findByText('이 큐에 남은 실패 job이 없습니다.')).toBeInTheDocument();
    expect(calls.filter((c) => c.path.endsWith('/failed')).length).toBeGreaterThanOrEqual(2);
  });

  it('ADMIN은 보기만 — 다시 시도·지우기 단추 대신 안내', async () => {
    failedApi(ADMIN);
    renderApp('/failed');
    expect(await screen.findByText('van-run-7')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '다시 시도' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '지우기' })).not.toBeInTheDocument();
    expect(screen.getByText('다시 시도·지우기는 관제 계정만 할 수 있습니다(ADMIN은 보기만).')).toBeInTheDocument();
  });

  it('20개가 넘으면 다음·이전으로 start를 옮긴다', async () => {
    const many = Array.from({ length: 25 }, (_, i) => job(`j-${i + 1}`));
    const { calls } = failedApi(MONITOR, { report: many });
    renderApp('/failed?queue=report');
    expect(await screen.findByText('1–20 / 25')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '다음' }));
    expect(await screen.findByText('21–25 / 25')).toBeInTheDocument();
    expect(screen.getByText('j-21')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다음' })).toBeDisabled();
    expect(calls.filter((c) => c.path.endsWith('/failed')).map((c) => c.query.get('start'))).toEqual(['0', '20']);
  });
});
```

`apps/console/src/pages/ListPages.test.tsx`(주기 작업·최근 오류·작업 기록·대시보드의 복구 sweep 단추):

```tsx
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { OpsActionView, OpsSchedulerView } from '@terminal-ops/contracts';
import { resetSessionForTest } from '../session';
import { dashboardApi, minutesAgo, outboxView } from '../test/fixtures';
import { ADMIN, MONITOR, mockApi, renderApp } from '../test/render';

const ME = { 'GET /auth/me': () => ({ body: MONITOR }) };

describe('주기 작업 (보강 6)', () => {
  it('코드 목록 순서대로 주기·등록 여부·다음 실행, Redis에만 남은 것은 "코드에 없음"', async () => {
    const list: OpsSchedulerView[] = [
      { id: 'outbox-relay', queue: 'outbox', jobName: 'relay', every: 2_000, pattern: null, tz: null, defined: true, registered: true, nextRunAt: new Date(Date.now() + 2_000).toISOString() },
      { id: 'weekly-report', queue: 'report', jobName: 'weekly-report', every: null, pattern: '0 9 * * 1', tz: 'Asia/Seoul', defined: true, registered: false, nextRunAt: null },
      { id: 'old-renamed', queue: 'device', jobName: 'detect-offline', every: 600_000, pattern: null, tz: null, defined: false, registered: true, nextRunAt: null },
    ];
    mockApi({ ...ME, 'GET /ops/schedulers': () => ({ body: list }) });
    renderApp('/schedulers');
    const relay = (await screen.findByText('outbox-relay')).closest('tr')!;
    expect(within(relay).getByText('2초마다')).toBeInTheDocument();
    expect(within(relay).getByText('등록됨')).toBeInTheDocument();
    const weekly = screen.getByText('weekly-report', { selector: 'td' }).closest('tr')!;
    expect(within(weekly).getByText('cron 0 9 * * 1 (Asia/Seoul)')).toBeInTheDocument();
    expect(within(weekly).getByText('등록 안 됨')).toBeInTheDocument();
    expect(within(screen.getByText(/old-renamed/).closest('tr')!).getByText('코드에 없음')).toBeInTheDocument();
  });
});

describe('최근 오류 (보강 6, decisions/0070)', () => {
  it('출처 이름·무엇·오류 글을 시각 순으로', async () => {
    mockApi({
      ...ME,
      'GET /ops/errors': () => ({
        body: [
          { source: 'SYNC_RUN', id: 3, at: minutesAgo(10), title: '택배 수집 실패 — track-bungae, 3번째 시도', message: 'PartnerTemporaryError: 번개택배 503' },
          { source: 'OUTBOX', id: 9, at: minutesAgo(40), title: '알림 #9 보내기 실패 — terminal.status_changed, 5번 시도', message: '톡톡메신저 400' },
        ],
      }),
    });
    renderApp('/errors');
    const first = (await screen.findByText('택배 수집 실패 — track-bungae, 3번째 시도')).closest('tr')!;
    expect(within(first).getByText('택배 수집')).toBeInTheDocument();
    expect(within(first).getByText('(10분 전)')).toBeInTheDocument();
    expect(screen.getAllByRole('row').map((r) => r.querySelectorAll('td')[1]?.textContent ?? 'head')).toEqual(['head', '택배 수집', '알림(Outbox)']);
  });

  it('없으면 없다고', async () => {
    mockApi({ ...ME, 'GET /ops/errors': () => ({ body: [] }) });
    renderApp('/errors');
    expect(await screen.findByText('최근 오류가 없습니다.')).toBeInTheDocument();
  });
});

describe('작업 기록 (보강 6, decisions/0073)', () => {
  const action = (id: number, over: Partial<OpsActionView> = {}): OpsActionView => ({
    id,
    action: 'RETRY_JOB',
    actor: 'monitor',
    actorRole: 'MONITOR',
    queue: 'report',
    jobId: `van-run-${id}`,
    jobName: 'van-reconcile',
    detail: { failedReason: '503', attemptsMade: 1 },
    createdAt: minutesAgo(id),
    ...over,
  });

  it('누가·작업·대상·그때 사정, "더 보기"는 beforeId로 다음 쪽', async () => {
    const { calls } = mockApi({
      ...ME,
      'GET /ops/actions': (call) =>
        call.query.get('beforeId') === '5'
          ? { body: { items: [action(4, { action: 'REQUEUE_OUTBOX', queue: null, jobId: null, jobName: null, detail: { checked: 2, requeuedCount: 1 } })], nextBeforeId: null } }
          : { body: { items: [action(6), action(5, { action: 'REMOVE_JOB' })], nextBeforeId: 5 } },
    });
    renderApp('/actions');
    const first = (await screen.findByText('report / van-run-6 (van-reconcile)')).closest('tr')!;
    expect(within(first).getByText('monitor (MONITOR)')).toBeInTheDocument();
    expect(within(first).getByText('다시 시도')).toBeInTheDocument();
    expect(within(first).getByText('{"failedReason":"503","attemptsMade":1}')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '더 보기' }));
    const sweep = (await screen.findByText('Outbox 복구 sweep')).closest('tr')!;
    expect(within(sweep).getByText('Outbox')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '더 보기' })).not.toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/ops/actions').map((c) => c.query.get('beforeId'))).toEqual([null, '5']);
  });
});

describe('Outbox 복구 sweep (보강 6, decisions/0042·0073)', () => {
  it('관제: 확인 뒤 POST, 결과(본 수·다시 넣은 id·작업 기록)를 보이고 Outbox 요약을 다시 읽는다', async () => {
    const { calls } = mockApi({ ...ME, ...dashboardApi({ outbox: outboxView({ counts: { PENDING: 0, QUEUED: 4, SENT: 1, FAILED: 0 } }) }), 'POST /ops/outbox/requeue': () => ({ body: { checked: 3, requeued: [7, 8], actionId: 21 } }) });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: '멈춘 QUEUED 복구 sweep 지금 실행' }));
    expect(confirm.mock.calls[0][0]).toBe('만든 지 60초 지난 QUEUED 알림 중 큐에 job이 없는 것을 다시 넣을까요? (주기 작업 outbox-requeue와 같은 일)');
    expect(await screen.findByText('QUEUED 3건을 보고 2건을 다시 넣었습니다(#7, #8). 작업 기록 #21')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/ops/outbox').length).toBeGreaterThanOrEqual(2);
  });

  it('확인창을 취소하면 부르지 않는다. ADMIN에게는 단추가 없다', async () => {
    const { calls } = mockApi({ ...ME, ...dashboardApi() });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { unmount } = renderApp('/');
    await userEvent.click(await screen.findByRole('button', { name: '멈춘 QUEUED 복구 sweep 지금 실행' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    unmount();
    resetSessionForTest(); // 다음 그리기에서 /auth/me를 다시 묻게

    mockApi({ 'GET /auth/me': () => ({ body: ADMIN }), ...dashboardApi() });
    renderApp('/');
    expect(await screen.findByText('보냄(SENT)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '멈춘 QUEUED 복구 sweep 지금 실행' })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd apps/console && npx vitest run
```

Expected(사전 검증 원문 요약): `Test Files  3 failed | 5 passed (8)`, `Tests  13 failed | 33 passed (46)` — labels `Failed to resolve import "./labels"`(파일 전체), 화면 열하나는 경로가 없어("없는 화면입니다.") `Unable to find an element with the text: van-run-7`·`outbox-relay` 등, 복구 sweep 둘은 `Unable to find role="button" and name "멈춘 QUEUED 복구 sweep 지금 실행"`.

- [ ] **Step 3: 구현**

`apps/console/src/lib/labels.ts`:

```ts
import type { OpsActionKind, OpsErrorSource, OpsSchedulerView } from '@terminal-ops/contracts';

/** 최근 오류 출처(GET /ops/errors, decisions/0070) */
export const ERROR_SOURCE_LABEL: Record<OpsErrorSource, string> = {
  SYNC_RUN: '택배 수집',
  VAN_RUN: 'VAN 대조',
  WEEKLY_REPORT: '주간 리포트',
  OUTBOX: '알림(Outbox)',
};

/** 관제 작업 종류(GET /ops/actions, decisions/0073) */
export const ACTION_LABEL: Record<OpsActionKind, string> = {
  RETRY_JOB: '다시 시도',
  REMOVE_JOB: '지우기',
  REQUEUE_OUTBOX: 'Outbox 복구 sweep',
};

/** 주기: 간격은 가장 큰 딱 떨어지는 단위로('30초마다', '1분마다'), cron은 식과 시간대 그대로 */
export function scheduleText(s: Pick<OpsSchedulerView, 'every' | 'pattern' | 'tz'>): string {
  if (s.every !== null) {
    const units: [number, string][] = [
      [3_600_000, '시간'],
      [60_000, '분'],
      [1_000, '초'],
    ];
    const unit = units.find(([ms]) => s.every! % ms === 0);
    return unit ? `${s.every / unit[0]}${unit[1]}마다` : `${s.every}ms마다`;
  }
  return `cron ${s.pattern ?? '?'} (${s.tz ?? '서버 시간대'})`;
}
```

`apps/console/src/pages/FailedJobsPage.tsx`:

```tsx
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OpsFailedJobsPage, OpsFailedJobView, OpsJobActionResult, OpsQueuesView } from '@terminal-ops/contracts';
import { api, ApiError } from '../api/client';
import { keys } from '../api/query-keys';
import { canOperate } from '../components/AuthGate';
import { ErrorBox } from '../components/ErrorBox';
import { Freshness } from '../components/Freshness';
import { formatKst } from '../lib/format';
import { useRefetchInterval } from '../lib/refresh';
import { useMe } from '../session';

export const PAGE_SIZE = 20;

type Action = 'retry' | 'remove';

const CONFIRM: Record<Action, (job: OpsFailedJobView) => string> = {
  retry: (job) => `${job.queue}의 job ${job.id}(${job.name})을(를) 다시 시도할까요? 시도 횟수를 0으로 되돌려 처음부터 다시 처리합니다.`,
  remove: (job) => `${job.queue}의 job ${job.id}(${job.name})을(를) 지울까요? 되돌릴 수 없습니다.`,
};

const DONE: Record<Action, string> = { retry: '다시 시도했습니다', remove: '지웠습니다' };

function JobRow({ job, operate, onAction, busy }: { job: OpsFailedJobView; operate: boolean; onAction: (action: Action, job: OpsFailedJobView) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr>
        <td>{formatKst(job.failedAt)}</td>
        <td>
          <code>{job.id}</code>
          <div className="muted">{job.name}</div>
        </td>
        <td className="num">
          {job.attemptsMade}/{job.maxAttempts}
        </td>
        <td>{job.failedReason}</td>
        <td>
          <div className="toolbar">
            <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? '접기' : '자세히'}
            </button>
            {operate ? (
              <>
                <button type="button" className="primary" disabled={busy} onClick={() => onAction('retry', job)}>
                  다시 시도
                </button>
                <button type="button" className="danger" disabled={busy} onClick={() => onAction('remove', job)}>
                  지우기
                </button>
              </>
            ) : null}
          </div>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={5}>
            <div className="muted">넣은 시각 {formatKst(job.createdAt)} · data(비밀처럼 보이는 이름의 값은 가림)</div>
            <pre>{JSON.stringify(job.data, null, 2)}</pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * 실패 job(보강 6, decisions/0072): 큐를 고르면 Redis에 남은 실패 job을 최근부터 20개씩. 자세히 = data(가린 것)·넣은 시각.
 * 다시 시도·지우기는 관제만(확인창 뒤). 성공하면 큐 요약·실패 목록·작업 기록을 다시 읽고, 409(이미 실패 상태 아님)·404(없음)여도 목록을 다시 읽는다.
 * 끝나면 지우는 job(알림·택배 추적·주간 리포트 수동 보내기)의 실패는 여기 없다 — "최근 오류" 화면이 업무 기록으로 보인다.
 */
export function FailedJobsPage() {
  const me = useMe();
  const operate = canOperate(me?.role);
  const client = useQueryClient();
  const refetchInterval = useRefetchInterval();
  const [params, setParams] = useSearchParams();
  const [start, setStart] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const queues = useQuery({ queryKey: keys.queues, queryFn: () => api<OpsQueuesView>('/ops/queues'), refetchInterval });
  const names = queues.data?.queues ?? [];
  const selected = params.get('queue') ?? names.find((q) => q.counts.failed > 0)?.name ?? names[0]?.name ?? null;

  const failed = useQuery({
    queryKey: keys.failed(selected ?? '', start),
    queryFn: () => api<OpsFailedJobsPage>(`/ops/queues/${encodeURIComponent(selected!)}/failed`, { query: { start, limit: PAGE_SIZE } }),
    enabled: selected !== null,
    refetchInterval,
  });

  const action = useMutation({
    mutationFn: ({ kind, job }: { kind: Action; job: OpsFailedJobView }) =>
      api<OpsJobActionResult>(`/ops/queues/${encodeURIComponent(job.queue)}/jobs/${encodeURIComponent(job.id)}/${kind}`, { method: 'POST' }),
    onSuccess: (result, { kind }) => setNotice(`${result.queue}의 job ${result.jobId}을(를) ${DONE[kind]}(작업 기록 #${result.actionId}).`),
    onSettled: (_data, error) => {
      if (error && !(error instanceof ApiError && (error.status === 409 || error.status === 404))) return;
      void client.invalidateQueries({ queryKey: keys.queues });
      void client.invalidateQueries({ queryKey: keys.failedAll });
      void client.invalidateQueries({ queryKey: keys.actions });
    },
  });

  const onAction = (kind: Action, job: OpsFailedJobView) => {
    if (!window.confirm(CONFIRM[kind](job))) return;
    setNotice(null);
    action.mutate({ kind, job });
  };

  const choose = (name: string) => {
    setStart(0);
    setNotice(null);
    setParams({ queue: name });
  };

  const page = failed.data;
  return (
    <>
      <h1>실패 job</h1>
      <div className="toolbar">
        <label>
          큐{' '}
          <select aria-label="큐" value={selected ?? ''} onChange={(e) => choose(e.target.value)}>
            {names.map((q) => (
              <option key={q.name} value={q.name}>
                {q.name} (실패 {q.counts.failed})
              </option>
            ))}
          </select>
        </label>
        {operate ? null : <span className="muted">다시 시도·지우기는 관제 계정만 할 수 있습니다(ADMIN은 보기만).</span>}
      </div>
      <Freshness updatedAt={failed.dataUpdatedAt} fetching={failed.isFetching} error={failed.error ?? queues.error} />
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}
      <ErrorBox error={action.error} />
      {page && page.items.length === 0 ? <p>이 큐에 남은 실패 job이 없습니다.</p> : null}
      {page && page.items.length > 0 ? (
        <>
          <table>
            <thead>
              <tr>
                <th>실패 시각</th>
                <th>job</th>
                <th className="num">시도</th>
                <th>실패 이유</th>
                <th>할 일</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((job) => (
                <JobRow key={job.id} job={job} operate={operate} onAction={onAction} busy={action.isPending} />
              ))}
            </tbody>
          </table>
          <div className="toolbar">
            <button type="button" disabled={start === 0} onClick={() => setStart(Math.max(0, start - PAGE_SIZE))}>
              이전
            </button>
            <span>
              {page.start + 1}–{page.start + page.items.length} / {page.total}
            </span>
            <button type="button" disabled={page.start + page.items.length >= page.total} onClick={() => setStart(start + PAGE_SIZE)}>
              다음
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}
```

`apps/console/src/pages/SchedulersPage.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import type { OpsSchedulerView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { Freshness } from '../components/Freshness';
import { scheduleText } from '../lib/labels';
import { useRefetchInterval } from '../lib/refresh';
import { When } from './DashboardPage';

/**
 * 주기 작업(보강 6): 코드의 목록(JOB_SCHEDULERS) 순서대로 큐·job·주기·Redis 등록 여부·다음 실행 시각.
 * 등록 안 됨 = RUN_SCHEDULERS=1인 프로세스가 아직 안 떴거나 scheduler:clear로 지운 것. 코드에 없음 = Redis에만 남은 옛 주기 작업.
 */
export function SchedulersPage() {
  const refetchInterval = useRefetchInterval();
  const list = useQuery({ queryKey: keys.schedulers, queryFn: () => api<OpsSchedulerView[]>('/ops/schedulers'), refetchInterval });
  const now = new Date(list.dataUpdatedAt || Date.now());
  return (
    <>
      <h1>주기 작업</h1>
      <Freshness updatedAt={list.dataUpdatedAt} fetching={list.isFetching} error={list.error} />
      {list.data ? (
        <table>
          <thead>
            <tr>
              <th>id</th>
              <th>큐 / job</th>
              <th>주기</th>
              <th>등록</th>
              <th>다음 실행</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((s) => (
              <tr key={`${s.queue}/${s.id}`}>
                <td>
                  {s.id} {s.defined ? null : <span className="badge warn">코드에 없음</span>}
                </td>
                <td>
                  {s.queue} / {s.jobName}
                </td>
                <td>{scheduleText(s)}</td>
                <td>{s.registered ? <span className="badge ok">등록됨</span> : <span className="badge bad">등록 안 됨</span>}</td>
                <td>
                  <When iso={s.nextRunAt} now={now} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}
```

`apps/console/src/pages/ErrorsPage.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import type { OpsErrorView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { Freshness } from '../components/Freshness';
import { ERROR_SOURCE_LABEL } from '../lib/labels';
import { useRefetchInterval } from '../lib/refresh';
import { When } from './DashboardPage';

/**
 * 최근 오류(보강 6, decisions/0070): 택배 수집 실패·VAN 대조 실패·주간 리포트 보내기 실패·알림 실패를 시각 순으로 30건.
 * 끝나면 지워지는 job의 실패는 실패 job 화면에 없고 여기에 업무 기록으로 보인다.
 */
export function ErrorsPage() {
  const refetchInterval = useRefetchInterval();
  const list = useQuery({ queryKey: keys.errors, queryFn: () => api<OpsErrorView[]>('/ops/errors'), refetchInterval });
  const now = new Date(list.dataUpdatedAt || Date.now());
  return (
    <>
      <h1>최근 오류</h1>
      <Freshness updatedAt={list.dataUpdatedAt} fetching={list.isFetching} error={list.error} />
      {list.data && list.data.length === 0 ? <p>최근 오류가 없습니다.</p> : null}
      {list.data && list.data.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>시각</th>
              <th>출처</th>
              <th>무엇</th>
              <th>오류</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((e) => (
              <tr key={`${e.source}-${e.id}`}>
                <td>
                  <When iso={e.at} now={now} />
                </td>
                <td>{ERROR_SOURCE_LABEL[e.source]}</td>
                <td>{e.title}</td>
                <td>
                  <pre>{e.message}</pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}
```

`apps/console/src/pages/ActionsPage.tsx`:

```tsx
import { useInfiniteQuery } from '@tanstack/react-query';
import type { BeforeIdPage, OpsActionView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { Freshness } from '../components/Freshness';
import { formatKst } from '../lib/format';
import { ACTION_LABEL } from '../lib/labels';
import { useRefetchInterval } from '../lib/refresh';

/**
 * 작업 기록(보강 6, decisions/0073): 관제 작업(다시 시도·지우기·Outbox 복구 sweep)을 누가 언제 무엇에 했나, 최근부터 20개씩 "더 보기".
 * 고치거나 지우는 단추는 없다(api도 없다 — 쌓기만).
 */
export function ActionsPage() {
  const refetchInterval = useRefetchInterval();
  const list = useInfiniteQuery({
    queryKey: keys.actions,
    queryFn: ({ pageParam }) => api<BeforeIdPage<OpsActionView>>('/ops/actions', { query: { beforeId: pageParam } }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBeforeId ?? undefined,
    refetchInterval,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <h1>작업 기록</h1>
      <Freshness updatedAt={list.dataUpdatedAt} fetching={list.isFetching} error={list.error} />
      {list.data && items.length === 0 ? <p>아직 관제 작업이 없습니다.</p> : null}
      {items.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>시각</th>
              <th>누가</th>
              <th>작업</th>
              <th>대상</th>
              <th>그때 사정</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr key={a.id}>
                <td>{formatKst(a.createdAt)}</td>
                <td>
                  {a.actor} ({a.actorRole})
                </td>
                <td>{ACTION_LABEL[a.action]}</td>
                <td>{a.queue ? `${a.queue} / ${a.jobId} (${a.jobName})` : 'Outbox'}</td>
                <td>{a.detail ? <pre>{JSON.stringify(a.detail)}</pre> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {list.hasNextPage ? (
        <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          더 보기
        </button>
      ) : null}
    </>
  );
}
```

대시보드에 복구 sweep 단추(관제만), 앱에 경로 넷:

```diff
diff --git a/apps/console/src/pages/DashboardPage.tsx b/apps/console/src/pages/DashboardPage.tsx
index b8afa7d..4562568 100644
--- a/apps/console/src/pages/DashboardPage.tsx
+++ b/apps/console/src/pages/DashboardPage.tsx
@@ -1,11 +1,15 @@
-import { useQuery } from '@tanstack/react-query';
+import { useState } from 'react';
+import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
 import { Link } from 'react-router';
-import type { OpsDependencyView, OpsOutboxView, OpsQueuesView, OpsSystemView } from '@terminal-ops/contracts';
+import type { OpsDependencyView, OpsOutboxView, OpsQueuesView, OpsRequeueResult, OpsSystemView } from '@terminal-ops/contracts';
 import { api } from '../api/client';
 import { keys } from '../api/query-keys';
+import { canOperate } from '../components/AuthGate';
+import { ErrorBox } from '../components/ErrorBox';
 import { Freshness } from '../components/Freshness';
 import { agoText, formatKst } from '../lib/format';
 import { useRefetchInterval } from '../lib/refresh';
+import { useMe } from '../session';
 
 /** 시각과 "N분 전"을 한 칸에. 없으면 '-' */
 export function When({ iso, now }: { iso: string | null; now: Date }) {
@@ -114,11 +118,49 @@ function OutboxCards({ outbox, now }: { outbox: OpsOutboxView; now: Date }) {
   );
 }
 
+/**
+ * 멈춘 QUEUED 복구 sweep 지금 한 번(관제만, 확인창 뒤 — decisions/0042·0073). 주기 작업 outbox-requeue와 같은 일이라 눌러도 해롭지 않다
+ * (job이 살아 있는 행은 건너뛴다). 끝나면 Outbox 요약·작업 기록을 다시 읽는다.
+ */
+function RequeueButton({ afterMs }: { afterMs: number }) {
+  const client = useQueryClient();
+  const [result, setResult] = useState<OpsRequeueResult | null>(null);
+  const requeue = useMutation({
+    mutationFn: () => api<OpsRequeueResult>('/ops/outbox/requeue', { method: 'POST' }),
+    onSuccess: (r) => {
+      setResult(r);
+      void client.invalidateQueries({ queryKey: keys.outbox });
+      void client.invalidateQueries({ queryKey: keys.actions });
+    },
+  });
+  const run = () => {
+    if (!window.confirm(`만든 지 ${afterMs / 1000}초 지난 QUEUED 알림 중 큐에 job이 없는 것을 다시 넣을까요? (주기 작업 outbox-requeue와 같은 일)`)) return;
+    setResult(null);
+    requeue.mutate();
+  };
+  return (
+    <>
+      <div className="toolbar">
+        <button type="button" className="primary" disabled={requeue.isPending} onClick={run}>
+          멈춘 QUEUED 복구 sweep 지금 실행
+        </button>
+      </div>
+      {result ? (
+        <p className="notice" role="status">
+          QUEUED {result.checked}건을 보고 {result.requeued.length}건을 다시 넣었습니다{result.requeued.length > 0 ? `(#${result.requeued.join(', #')})` : ''}. 작업 기록 #{result.actionId}
+        </p>
+      ) : null}
+      <ErrorBox error={requeue.error} />
+    </>
+  );
+}
+
 /**
  * 대시보드(보강 6): 프로세스·의존 상태 카드, 큐 표(실패 수는 실패 job 화면으로 가는 링크), Outbox 카드.
- * 세 쿼리 모두 자동 새로고침(decisions/0076). "N분 전"은 다시 읽을 때마다 지금 시각으로 다시 센다.
+ * 세 쿼리 모두 자동 새로고침(decisions/0076). "N분 전"은 다시 읽을 때마다 지금 시각으로 다시 센다. 관제는 Outbox 복구 sweep을 여기서 돌린다.
  */
 export function DashboardPage() {
+  const me = useMe();
   const refetchInterval = useRefetchInterval();
   const system = useQuery({ queryKey: keys.system, queryFn: () => api<OpsSystemView>('/ops/system'), refetchInterval });
   const queues = useQuery({ queryKey: keys.queues, queryFn: () => api<OpsQueuesView>('/ops/queues'), refetchInterval });
@@ -138,6 +180,7 @@ export function DashboardPage() {
 
       <h2>Outbox(알림)</h2>
       {outbox.data ? <OutboxCards outbox={outbox.data} now={now} /> : null}
+      {outbox.data && canOperate(me?.role) ? <RequeueButton afterMs={outbox.data.requeueAfterMs} /> : null}
     </>
   );
 }
```

```diff
diff --git a/apps/console/src/App.tsx b/apps/console/src/App.tsx
index e5fddf4..8ddfdb3 100644
--- a/apps/console/src/App.tsx
+++ b/apps/console/src/App.tsx
@@ -2,8 +2,12 @@ import { Route, Routes } from 'react-router';
 import { AuthGate } from './components/AuthGate';
 import { SessionCacheSync } from './components/SessionCacheSync';
 import { Shell } from './components/Shell';
+import { ActionsPage } from './pages/ActionsPage';
 import { DashboardPage } from './pages/DashboardPage';
+import { ErrorsPage } from './pages/ErrorsPage';
+import { FailedJobsPage } from './pages/FailedJobsPage';
 import { LoginPage } from './pages/LoginPage';
+import { SchedulersPage } from './pages/SchedulersPage';
 
 /** 화면 경로. /login 말고는 모두 관제·ADMIN 계정으로 로그인해야 보인다(AuthGate) */
 export function App() {
@@ -20,6 +24,10 @@ export function App() {
           }
         >
           <Route index element={<DashboardPage />} />
+          <Route path="failed" element={<FailedJobsPage />} />
+          <Route path="schedulers" element={<SchedulersPage />} />
+          <Route path="errors" element={<ErrorsPage />} />
+          <Route path="actions" element={<ActionsPage />} />
           <Route path="*" element={<p>없는 화면입니다.</p>} />
         </Route>
       </Routes>
```

- [ ] **Step 4: 통과 확인**

```bash
cd apps/console && npx vitest run && npm run build && rm -rf dist
```

Expected(사전 검증): `Test Files  8 passed (8)`, `Tests  48 passed (48)`, build 성공(tsc 포함). 세 번 돌려 같은지 본다(자동 새로고침 테스트가 실제 시계를 쓴다).

- [ ] **Step 5: 기록**

`docs/decisions/0076-관제-화면-자동-새로고침은-10초-탭-숨김이면-멈춤.md` 끝에 한 줄:

```markdown
- Task 4 보탬: 관제 작업 뒤에는 간격을 기다리지 않고 그 작업이 바꾸는 쿼리만 무효화한다 — 다시 시도·지우기 → 큐 요약·실패 목록(모든 쪽)·작업 기록, 복구 sweep → Outbox·작업 기록(`api/query-keys.ts`). 409 `JOB_NOT_FAILED`·404(다른 사람이 먼저 처리)여도 실패 목록을 다시 읽는다 — 안내("목록을 다시 읽었습니다")와 화면이 맞게. 그 밖의 오류(403·500·연결 실패)는 바뀐 것이 없어 다시 읽지 않는다.
```

devlog(Task 3 항목 뒤):

```markdown
## HH:MM Task 4 관제 화면 — 실패 job·주기 작업·최근 오류·작업 기록, 복구 sweep 단추 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <Task 3 커밋 해시>
- 한 일: 실패 job(큐 고르기·`?queue=`, 20개씩, 자세히 = 가린 data, 관제만 다시 시도·지우기 확인창, 409·404면 안내 + 목록 다시 읽기, ADMIN은 안내), 주기 작업(주기 글자·등록 여부·다음 실행·코드에 없음), 최근 오류(출처·무엇·오류 글), 작업 기록(더 보기 = beforeId), 대시보드 "멈춘 QUEUED 복구 sweep 지금 실행"(관제만, 결과·작업 기록 번호)
- 확인: 새 테스트 13개 실패 → console `Test Files  <수> passed (<수>)`, `Tests  <수> passed (<수>)` 세 번 같음, build 성공
- 결정: 0076 보탬(작업 뒤 무효화 범위)
- 다음: Task 5 마감(전체 검증·개발 DB 마이그레이션·실서버 확인·README)
```

```bash
node scripts/docs-index.mjs
```

- [ ] **Step 6: 커밋**

```bash
git add apps/console docs
git status --short
git commit -m "$(cat <<'EOF'
feat(ops): 관제 화면 — 실패 job 다시 시도·지우기, 주기 작업·최근 오류·작업 기록, 복구 sweep 단추

Refs: docs/decisions/0072-실패-job은-Redis에-남은-것만-data는-가리고-다시-시도는-시도-수를-되돌린다.md, docs/decisions/0076-관제-화면-자동-새로고침은-10초-탭-숨김이면-멈춤.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 제목 시각 = 커밋 시각인지 보고, 다르면 고쳐 `git commit --amend --no-edit`.

---


### Task 5: 마감 — 전체 검증, 개발 DB 마이그레이션, 실서버 확인, README·회고·색인

**Files:**
- Modify: `README.md`, `docs/retrospective.md`, `docs/index.md`, `docs/devlog/2026-10-29.md`
- 저장소 밖(커밋 안 함): 실서버 확인 스크립트(세션 scratchpad)

- [ ] **Step 1: 전체 검증**

```bash
# 시작 전 node PID를 적어 둔다
tasklist //FI "IMAGENAME eq node.exe" //FO CSV //NH
# 테스트 DB를 새로 만든 뒤(안전 규칙)
(cd apps/api && npx tsc --noEmit -p tsconfig.json && npm run build && npx vitest run > /tmp/ops-final-api.log 2>&1; grep -E "Test Files|Tests |Duration" /tmp/ops-final-api.log; grep -c "Connection is closed" /tmp/ops-final-api.log)
for a in console admin merchant field; do (cd apps/$a && npx vitest run 2>&1 | grep -E "Test Files|Tests " && npm run build > /dev/null && rm -rf dist && echo "$a build ok"); done
(cd apps/device-sim && npx tsc --noEmit -p tsconfig.json && npx vitest run 2>&1 | grep -E "Test Files|Tests ")
(cd apps/partners && npx vitest run 2>&1 | grep -E "Test Files|Tests ")
```

Expected(사전 검증 값): api `Test Files  88 passed (88)`·`Tests  593 passed (593)`, `Connection is closed` 0. console `8 passed`·`48 passed`, admin `19 passed`·`163 passed`, merchant `7 passed`·`47 passed`, field `7 passed`·`60 passed`, 넷 다 build ok. device-sim `5 passed`·`46 passed`, tsc 0. partners `6 passed`·`53 passed`.

- [ ] **Step 2: 개발 DB에 마이그레이션 적용**

Task 2의 `ops_action_log` 표를 개발 DB에 만든다(개발 DB 쓰기는 이것 하나 — 표 하나를 더할 뿐 기존 데이터는 건드리지 않는다).

```bash
cd apps/api && npm run db:migrate && npm run db:migration:check
```

Expected: `적용: Migration<Task 2의 시각>`, 이어서 `최신 상태`(exit 0). `git status --short --ignored src/migrations`에 `.snapshot-terminal_ops_test.json`이 없어야 한다(있으면 지운다 — troubleshooting/0032).

- [ ] **Step 3: 실서버 확인 — 테스트 DB api + 워커 프로세스 + 관제 개발 서버 프록시**

포트가 비어 있는지 먼저 본다: `netstat -ano | grep -E ':(3200|5276) .*LISTENING'` → 출력 없음. 쓰기는 테스트 DB만, Redis는 `opsx-live` 접두사만 쓴다. 가상 업체 서버는 띄우지 않는다(이 확인은 업체를 부르지 않는다 — 주기 작업의 수집·알림이 업체를 부르면 연결 실패로 끝나 최근 오류에 보일 수 있다).

테스트 DB를 다시 만들고 스키마·기준 데이터·시연 계정을 넣는다:

```bash
# 테스트 DB를 새로 만든 뒤(안전 규칙)
cd apps/api
MYSQL_DATABASE=terminal_ops_test node --env-file=../../.env dist/db/migrate.js up | tail -1
MYSQL_DATABASE=terminal_ops_test node --env-file=../../.env dist/db/seed.js
rm -f src/migrations/.snapshot-terminal_ops_test.json   # 테스트 DB 이름의 스냅샷(troubleshooting/0032)
cd ../..
```

세 프로세스를 각각 단독 node 명령으로 띄운다(Bash 도구의 백그라운드 실행, 저장소 루트에서):

```bash
# 1) api — 워커 없이(RUN_WORKERS=0), 주기 작업도 이 프로세스는 등록하지 않는다
MYSQL_DATABASE=terminal_ops_test API_PORT=3200 RUN_WORKERS=0 RUN_SCHEDULERS=0 QUEUE_PREFIX=opsx-live PARTNERS_URL=http://localhost:4019 node --env-file=.env apps/api/dist/main.js
# 2) 워커 프로세스 — 이름을 주고 주기 작업을 등록한다(관제 화면의 워커 이름·주기 작업 "등록됨"을 보려고)
MYSQL_DATABASE=terminal_ops_test RUN_WORKERS=1 RUN_SCHEDULERS=1 QUEUE_PREFIX=opsx-live WORKER_NAME=opsx-worker PARTNERS_URL=http://localhost:4019 node --env-file=.env apps/api/dist/worker.js
# 3) 관제 개발 서버 — api :3200으로 넘긴다
CONSOLE_API_URL=http://localhost:3200 node apps/console/node_modules/vite/bin/vite.js apps/console --port 5276 --strictPort
```

(`PARTNERS_URL`은 아무것도 듣지 않는 4019 — 업체 호출이 실수로 개발용 가상 업체 서버(:4010)에 닿지 않게.)

확인 스크립트(세션 scratchpad에 `ops-live.sh`로 저장해 `bash ops-live.sh <저장소 루트> <scratchpad>`로 돌린다 — 관제 비밀번호는 seed 파일에서 읽어 임시 파일로만 쓰고 지운다):

```bash
#!/usr/bin/env bash
# 운영 관제 실서버 확인(보강 6 사전 검증). 이미 떠 있는: api :3200(RUN_WORKERS=0), 워커(WORKER_NAME=opsx-worker, RUN_SCHEDULERS=1), 관제 개발 서버 :5276(→ api :3200)
# 모두 테스트 DB·QUEUE_PREFIX=opsx-live. 비밀번호는 seed 파일에서 읽어 임시 파일로만 쓰고 출력하지 않는다.
set -u
ROOT="$1"            # 저장소(복제본) 루트
OUT="$2"             # 임시 폴더(쿠키·본문)
BASE=http://localhost:5276/api
JAR="$OUT/opsx-jar.txt"
SUM="node $OUT/opsx-sum.mjs"
rm -f "$JAR"

cat > "$OUT/opsx-sum.mjs" <<'EOF'
// 표준 입력 JSON에서 필요한 칸만 한 줄로(비밀 값이 없는 응답만 넣는다)
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const pick = process.argv[2];
  try {
    const j = JSON.parse(s);
    console.log(JSON.stringify(new Function('j', `return (${pick});`)(j)));
  } catch {
    console.log(s.slice(0, 300));
  }
});
EOF

# 1) 관제 로그인 본문을 파일로(비밀번호는 출력하지 않는다)
node -e "
const fs = require('fs');
const text = fs.readFileSync(process.argv[1], 'utf8');
const m = text.match(/loginId: 'monitor'[^}]*password: '([^']+)'/);
if (!m) { console.error('monitor 계정을 찾지 못함'); process.exit(1); }
fs.writeFileSync(process.argv[2], JSON.stringify({ loginId: 'monitor', password: m[1] }));
" "$ROOT/apps/api/src/db/seed-accounts.ts" "$OUT/opsx-login.json"

code() { curl -s -o "$OUT/opsx-body.json" -w '%{http_code}' -b "$JAR" -c "$JAR" "$@"; }

echo "index: $(curl -s http://localhost:5276/ | grep -o '<title>[^<]*</title>')"
echo "로그인 없이 /api/ops/queues: $(curl -s -o /dev/null -w '%{http_code}' $BASE/ops/queues)"
echo "health: $(code $BASE/health) $(cat "$OUT/opsx-body.json")"
echo "로그인: $(code -H 'Content-Type: application/json' --data @"$OUT/opsx-login.json" $BASE/auth/login) $($SUM 'j.role' < "$OUT/opsx-body.json")"
rm -f "$OUT/opsx-login.json"

echo "큐 요약: $(code $BASE/ops/queues) $($SUM 'j.queues.map(q => `${q.name} w${q.counts.waiting} f${q.counts.failed} workers${q.workers} done15=${q.completedRecent}`)' < "$OUT/opsx-body.json")"
echo "프로세스: $(code $BASE/ops/system) $($SUM '({ api: j.api.version, prefix: j.api.queuePrefix, workersOfApi: j.api.runWorkers, mysql: j.mysql.ok, redis: j.redis.ok, workerNames: [...new Set(j.workers.map(w => w.name))], queuesWithWorker: new Set(j.workers.map(w => w.queue)).size })' < "$OUT/opsx-body.json")"
echo "주기 작업: $(code $BASE/ops/schedulers) $($SUM 'j.map(s => `${s.id}:${s.registered ? "등록" : "없음"}${s.nextRunAt ? "" : "(다음 없음)"}`)' < "$OUT/opsx-body.json")"
echo "Outbox: $(code $BASE/ops/outbox) $($SUM '({ counts: j.counts, oldestQueuedAt: j.oldestQueuedAt })' < "$OUT/opsx-body.json")"
echo "최근 오류: $(code $BASE/ops/errors) $($SUM 'j.length' < "$OUT/opsx-body.json")"

# 2) 실패하는 job 하나: report 큐에 처리기가 모르는 이름 → UnrecoverableError로 실패(시도 1). data에 비밀처럼 보이는 이름을 넣어 가리기를 본다
(cd "$ROOT/apps/api" && node --input-type=module -e "
import { Queue } from 'bullmq';
const q = new Queue('report', { connection: { host: '127.0.0.1', port: 6379 }, prefix: 'opsx-live' });
const job = await q.add('opsx-unknown', { runId: 1, apiToken: 'live-secret-value' }, { jobId: 'opsx-fail-1', attempts: 1 });
console.log('넣은 job:', job.id);
await q.close();
" 2>&1 | tail -1)
for i in $(seq 1 50); do
  code $BASE/ops/queues/report/failed > /dev/null
  if node -e "process.exit(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).total>0?0:1)" "$OUT/opsx-body.json"; then break; fi
  sleep 0.2
done
echo "실패 목록: $(code $BASE/ops/queues/report/failed) $($SUM '({ total: j.total, items: j.items.map(i => ({ id: i.id, name: i.name, data: i.data, reason: i.failedReason, attempts: `${i.attemptsMade}/${i.maxAttempts}` })) })' < "$OUT/opsx-body.json")"
grep -c 'live-secret-value' "$OUT/opsx-body.json" | sed 's/^/비밀 값이 응답에 든 횟수: /'
echo "다시 시도: $(code -X POST $BASE/ops/queues/report/jobs/opsx-fail-1/retry) $(cat "$OUT/opsx-body.json")"
sleep 1
echo "다시 시도 뒤 실패 목록: $(code $BASE/ops/queues/report/failed) $($SUM '({ total: j.total, failedAt: j.items[0] && j.items[0].failedAt, attempts: j.items[0] && j.items[0].attemptsMade })' < "$OUT/opsx-body.json")"
echo "지우기: $(code -X POST $BASE/ops/queues/report/jobs/opsx-fail-1/remove) $(cat "$OUT/opsx-body.json")"
echo "다시 지우기: $(code -X POST $BASE/ops/queues/report/jobs/opsx-fail-1/remove) $($SUM 'j.statusCode' < "$OUT/opsx-body.json")"
echo "복구 sweep: $(code -X POST $BASE/ops/outbox/requeue) $(cat "$OUT/opsx-body.json")"
echo "작업 기록: $(code $BASE/ops/actions) $($SUM 'j.items.map(a => `#${a.id} ${a.action} ${a.actor}(${a.actorRole}) ${a.queue ?? "-"}/${a.jobId ?? "-"}`)' < "$OUT/opsx-body.json")"
echo "큐 요약(뒤): $(code $BASE/ops/queues) $($SUM 'j.queues.filter(q => q.name === "report").map(q => `report f${q.counts.failed} failed15=${q.failedRecent} workers${q.workers}`)' < "$OUT/opsx-body.json")"
echo "로그아웃: $(code -X POST $BASE/auth/logout)"
echo "로그아웃 뒤 /ops/queues: $(code $BASE/ops/queues)"
rm -f "$JAR" "$OUT/opsx-body.json" "$OUT/opsx-sum.mjs"
```

Expected(사전 검증 출력, 시각·id·지연 값은 다르다):

```
index: <title>단말온 운영 관제</title>
로그인 없이 /api/ops/queues: 401
health: 200 {"status":"ok"}
로그인: 200 "MONITOR"
큐 요약: 200 ["track-bungae w0 f0 workers1 done15=null","track-neurimbo w0 f0 workers1 done15=null","carrier-sweep w0 f0 workers1 done15=1","outbox w0 f0 workers1 done15=10","device w0 f0 workers1 done15=8","report w0 f0 workers1 done15=null"]
프로세스: 200 {"api":"dev","prefix":"opsx-live","workersOfApi":false,"mysql":true,"redis":true,"workerNames":["opsx-worker"],"queuesWithWorker":6}
주기 작업: 200 ["carrier-sweep:등록","outbox-relay:등록","outbox-requeue:등록","active-rebuild:등록","offline-detect:등록","connectivity-snapshot:등록","rollout-control:등록","anomaly-scan-daily:등록","van-reconcile-daily:등록","weekly-report:등록"]
Outbox: 200 {"counts":{"PENDING":0,"QUEUED":0,"SENT":0,"FAILED":0},"oldestQueuedAt":null}
최근 오류: 200 0
넣은 job: opsx-fail-1
실패 목록: 200 {"total":1,"items":[{"id":"opsx-fail-1","name":"opsx-unknown","data":{"runId":1,"apiToken":"[가림]"},"reason":"모르는 report job: opsx-unknown","attempts":"1/1"}]}
비밀 값이 응답에 든 횟수: 0
다시 시도: 200 {"queue":"report","jobId":"opsx-fail-1","action":"RETRY_JOB","actionId":1}
다시 시도 뒤 실패 목록: 200 {"total":1,"failedAt":"2026-10-29T03:40:16.864Z","attempts":1}
지우기: 200 {"queue":"report","jobId":"opsx-fail-1","action":"REMOVE_JOB","actionId":2}
다시 지우기: 404 404
복구 sweep: 200 {"checked":0,"requeued":[],"actionId":3}
작업 기록: 200 ["#3 REQUEUE_OUTBOX monitor(MONITOR) -/-","#2 REMOVE_JOB monitor(MONITOR) report/opsx-fail-1","#1 RETRY_JOB monitor(MONITOR) report/opsx-fail-1"]
큐 요약(뒤): 200 ["report f0 failed15=2 workers1"]
로그아웃: 204
로그아웃 뒤 /ops/queues: 401
```

끄기와 정리:

```bash
netstat -ano | grep -E ':(3200|5276) .*LISTENING'                       # api·vite PID
wmic process where "name='node.exe'" get ProcessId,CommandLine | grep worker.js   # 워커 PID
tasklist //FI "PID eq <PID>" //FO CSV //NH                               # 셋 다 node.exe인지
taskkill //PID <api PID> //F; taskkill //PID <worker PID> //F; taskkill //PID <vite PID> //F
netstat -ano | grep -E ':(3200|5276) .*LISTENING'                       # 출력 없음
tasklist //FI "IMAGENAME eq node.exe" //FO CSV //NH                      # 시작 전과 같은 PID만
MSYS_NO_PATHCONV=1 docker exec terminal-ops-redis redis-cli --scan --pattern 'opsx-live*' | wc -l
for k in $(MSYS_NO_PATHCONV=1 docker exec terminal-ops-redis redis-cli --scan --pattern 'opsx-live*' | tr -d '\r'); do MSYS_NO_PATHCONV=1 docker exec terminal-ops-redis redis-cli DEL "$k" > /dev/null; done
MSYS_NO_PATHCONV=1 docker exec terminal-ops-redis redis-cli --scan --pattern 'opsx-live*' | wc -l   # 0
# 마지막으로 테스트 DB를 빈 DB로 다시 만든다(안전 규칙)
```

컨트롤러가 내장 브라우저로 화면을 볼 때는 같은 세 프로세스를 띄운 채 `http://localhost:5276/login`(관제 계정)을 연다 — 대시보드·실패 job·주기 작업·최근 오류·작업 기록. 본 것은 devlog에 "받아 적은 것"으로 적는다.

- [ ] **Step 4: README**

`README.md`에서 아래를 바꾼다(Edit 도구, 각 줄 그대로 찾아 바꾼다).

1. 구성의 field 줄 뒤에 한 줄:
   ```
   │  ├─ console/           운영 관제 화면 — 큐·워커·주기 작업·Outbox·업무 오류 보기, 실패 job 다시 시도·지우기(Vite 프록시 /api → api, 보강 6)
   ```
   contracts 줄의 `api·어드민·매장·현장 화면이` → `api·어드민·매장·현장·관제 화면이`
2. 실행 블록: `for a in api admin merchant field partners device-sim; do (cd apps/$a && npm ci); done   # api·admin·merchant·field는` → `for a in api admin merchant field console partners device-sim; do (cd apps/$a && npm ci); done   # api·admin·merchant·field·console은`. `(cd apps/field && npm run dev) …` 줄 뒤에:
   ```
   (cd apps/console && npm run dev)                       # :5176 → 넓은 화면으로 http://localhost:5176/login (관제 계정 monitor, ADMIN은 보기만)
   ```
   타입 검사 줄의 `admin·merchant·field `npm run build`` → `admin·merchant·field·console `npm run build``
3. 역할의 MONITOR 줄:
   ```
   - **MONITOR**: 관제·개발자 — 읽기와 관제 작업(이상 찾기·VAN 대조·주간 리포트 실행). 화면은 어드민과 운영 관제 `apps/console`(:5176, 보강 6 — [decisions/0074](docs/decisions/0074-운영-관제-화면은-별도-앱-apps-console.md)): 큐·워커·주기 작업·Outbox·오류 보기, 실패 job 다시 시도·지우기·Outbox 복구(감사 기록)
   ```
4. "통합 어드민(보강 5)" 절의 "다른 화면" 줄에서 `매장(:5174)·현장(:5175) 새 탭, 이후 화면(관제·개발자센터·업체 콘솔·시뮬레이터)은 준비 중` → `매장(:5174)·현장(:5175)·관제(:5176, 보강 6) 새 탭, 이후 화면(개발자센터·업체 콘솔·시뮬레이터)은 준비 중`
5. 그 절 뒤(`## 기능` 앞)에 절 하나:
   ```markdown
   ## 운영 관제(보강 6)

   관제·개발자가 시스템 상태를 보는 화면이다. `http://localhost:5176/login`에 `monitor` 계정으로 들어간다(ADMIN은 보기만, 다른 역할은 안내와 로그아웃만). 10초마다 다시 읽고, 탭이 안 보이면 멈추며, 위 막대 단추로 끈다([decisions/0076](docs/decisions/0076-관제-화면-자동-새로고침은-10초-탭-숨김이면-멈춤.md)).

   - 대시보드: api 버전·기동 시각, MySQL·Redis 응답 시간, 큐를 처리하는 워커 프로세스(이름 = `WORKER_NAME`), 큐 여섯의 대기·처리 중·지연·남은 실패·최근 15분 완료/실패·가장 오래 기다린 job·워커 수, Outbox 상태별 수와 가장 오래된 PENDING/QUEUED, "멈춘 QUEUED 복구 sweep 지금 실행"(관제만)
   - 실패 job: Redis에 남은 실패(주기 작업·VAN 대조 job — 알림·택배 추적은 끝나면 지워져 "최근 오류"로 본다), data는 비밀처럼 보이는 이름을 가림, 다시 시도(시도 수 0부터)·지우기(확인창, 관제만) — [decisions/0072](docs/decisions/0072-실패-job은-Redis에-남은-것만-data는-가리고-다시-시도는-시도-수를-되돌린다.md)
   - 주기 작업(주기·등록 여부·다음 실행), 최근 오류(수집·VAN 대조·주간 리포트·알림 실패를 한 목록, [decisions/0070](docs/decisions/0070-운영-관제-API는-ops-아래-그때그때-읽기와-관제만의-작업.md)), 작업 기록(관제 작업의 누가·언제·무엇, [decisions/0073](docs/decisions/0073-관제-작업-감사-기록은-새-표-ops_action_log.md))
   - api: `GET /ops/queues·schedulers·system·outbox·errors·queues/:name/failed·actions`(관제·ADMIN), `POST /ops/queues/:name/jobs/:id/retry·remove`, `POST /ops/outbox/requeue`(관제만). 워커 생존은 BullMQ 워커 연결, 처리량은 워커 metrics([decisions/0071](docs/decisions/0071-워커-생존은-BullMQ-워커-연결과-이름-처리량은-워커-metrics.md))
   - api 클라이언트·세션 코드는 점주 앱 사본이고 `src/copies.test.ts`가 코드가 같은지 본다([decisions/0075](docs/decisions/0075-네-번째-화면도-점주-사본과-사본-검사로.md))
   - 시연 팁: 네 화면(어드민·매장·현장·관제)은 localhost에서 쿠키(`sid`) 하나를 함께 쓴다 — 동시에 다른 계정으로 보려면 브라우저 프로필을 나눈다
   ```
6. 기능 표의 `| 현장 화면(보강 4) | … |` 줄 뒤에:
   ```
   | 운영 관제(보강 6) | 큐 요약(최근 15분 처리량·워커), 프로세스·의존 상태, 주기 작업, Outbox 요약·복구 sweep, 최근 업무 오류, 실패 job 다시 시도·지우기(data 가림), 감사 기록, 자동 새로고침 | `apps/console/src/`, `apps/api/src/ops/`, `apps/api/src/queue/worker-options.ts` |
   ```
7. 기록 색인 줄 "결정 69·트러블슈팅 32·실험 17" → "결정 76·트러블슈팅 32·실험 17"(Task 중 트러블슈팅이 생겼으면 실제 수 — `node scripts/docs-index.mjs` 출력).
8. 테스트 절 설명과 표(Step 1에서 센 실제 값으로):
   ```markdown
   (보강 6 운영 관제 뒤 실제로 돌려 센 값(2026-10-29). api는 실험 파일 제외 — 실험은 `EXPERIMENTS=1`에서만 돈다. 보강 5 뒤에는 api 83/571, 보강 4 뒤에는 api 82/568·admin 14/125, 보강 3 뒤에는 api 80/561·merchant 7/47, 보강 2 뒤에는 api 79/549, 보강 1 뒤에는 api 66/453, admin 12/109, device-sim 4/40이었다)

   | 앱 | 파일 | 테스트 |
   |---|---|---|
   | api(실험 제외) | 88 | 593 |
   | admin | 19 | 163 |
   | merchant | 7 | 47 |
   | field | 7 | 60 |
   | console | 8 | 48 |
   | partners | 6 | 53 |
   | device-sim | 5 | 46 |
   ```

- [ ] **Step 5: 회고**

`docs/retrospective.md` 끝(`  - 보강 5가 남긴 것: …` 줄 뒤)에 두 줄:

```markdown
- [x] **보강 6: 운영 관제 화면** — 관제·개발자용 별도 앱 `apps/console`([0074](decisions/0074-운영-관제-화면은-별도-앱-apps-console.md))과 `/ops` API([0070](decisions/0070-운영-관제-API는-ops-아래-그때그때-읽기와-관제만의-작업.md)): 큐 요약·프로세스 상태·주기 작업·Outbox·최근 업무 오류를 그때그때 읽고(새 표 없이 기존 기록 합침), 워커 생존은 BullMQ 워커 연결·처리량은 워커 metrics([0071](decisions/0071-워커-생존은-BullMQ-워커-연결과-이름-처리량은-워커-metrics.md)). 실패 job은 Redis에 남은 것만, data 가림, 다시 시도는 시도 수 0부터([0072](decisions/0072-실패-job은-Redis에-남은-것만-data는-가리고-다시-시도는-시도-수를-되돌린다.md)), 관제 작업은 MONITOR만·감사 기록 새 표([0073](decisions/0073-관제-작업-감사-기록은-새-표-ops_action_log.md)). 화면 앱이 넷이 되어 0062를 다시 봤고 사본 + 사본 검사를 유지([0075](decisions/0075-네-번째-화면도-점주-사본과-사본-검사로.md)), 10초 자동 새로고침([0076](decisions/0076-관제-화면-자동-새로고침은-10초-탭-숨김이면-멈춤.md)). 기록: devlog 2026-10-29 `# 보강 6: 운영 관제 화면`, [계획](plans/2026-10-29-ops-console.md)
  - 보강 6이 남긴 것: 알림·택배 추적 job의 실패는 job으로 다시 시도할 수 없음(업무 기록으로만 — 0072), 큐 멈춤·재개·일괄 다시 시도 없음, 이상 단말기 찾기 실행 기록 없음, 감사 기록과 작업이 한 트랜잭션이 아님(0073), 워커 생존은 Redis CLIENT LIST에 기댐(관리형 Redis면 다시 — 0071), 공통 코드 다섯 곳 전에 workspaces·공유 패키지를 따로 다시 잴 것(0075), 쿠키 하나를 네 화면이 함께 씀
```

- [ ] **Step 6: 색인·devlog·커밋**

```bash
node scripts/docs-index.mjs
node scripts/docs-index.mjs --check
```

devlog 항목(Task 4 항목 뒤):

```markdown
## HH:MM Task 5 마감 — 전체 검증, 개발 DB 마이그레이션, 실서버 확인, README·회고 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <Task 4 커밋 해시>
- 전체 검증: api `Test Files  <수> passed (<수>)`, `Tests  <수> passed (<수>)`, Duration <초>, `Connection is closed` <수>. console 8/48·build, admin 19/163·build, merchant 7/47·build, field 7/60·build, device-sim <수>·tsc 0, partners <수>
- 개발 DB: `db:migrate` 적용 Migration<시각>(ops_action_log), `db:migration:check` 최신 상태
- 실서버(테스트 DB, api :3200 `RUN_WORKERS=0`, 워커 `WORKER_NAME=opsx-worker` `RUN_SCHEDULERS=1`, 관제 :5276 프록시, 접두사 `opsx-live`): (스크립트 출력 요약 — 비밀번호 없이)
- 끄기: 세 PID를 taskkill, 포트 LISTENING 0, node PID는 시작 전과 같음. Redis `opsx-live*` 키 <수>개 하나씩 DEL. 테스트 DB 빈 DB로
- 컨트롤러 확인: (대기 / 본 것)
- README(구성·실행·역할·운영 관제 절·기능·기록 수·테스트 표), 회고(보강 6과 남긴 것)
- 다음: 컨트롤러 최종 리뷰·병합(push는 컨트롤러)
```

```bash
git add README.md docs
git status --short
git commit -m "$(cat <<'EOF'
docs(ops): 보강 6 마감 — 전체 검증·실서버 확인, README 운영 관제 절·테스트 수, 회고

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 제목 시각 = 커밋 시각인지 보고, 다르면 고쳐 `git commit --amend --no-edit`. 끝나면 안전 규칙의 netstat·tasklist를 다시 본다.

---

## 자체 점검

- 브리프 대응: 1(앱 구성 — 별도 앱 :5176(0074), 사본 전략 다시 보기(0075), 어드민 `apps.ts` 관제 주소 → Task 3). 2(API: 큐 요약(수·멈춤·처리량·가장 오래 기다린 job) → Task 1, 실패 job 목록(이유·시도·data 가림)·다시 시도·지우기(관제, 감사) → Task 2, 주기 작업 목록(패턴/every·tz·다음 실행) → Task 1, Outbox 요약 → Task 1·복구 sweep 수동 실행(`requeueStale` 재사용) → Task 2, 최근 업무 오류(새 표 없이 — 이상 찾기는 표가 없어 뺌) → Task 1, 프로세스·의존 상태(MySQL·Redis 지연, 워커 `getWorkers`, 버전·기동 시각) → Task 1, 접근 표·contracts·e2e → Task 1·2). 3(화면: 큐 대시보드 카드 + 표·자동 새로고침(탭 숨김이면 멈춤) → Task 3, 실패 job 목록·상세·다시 시도/지우기(확인창) → Task 4, 주기 작업 표·Outbox 카드 + 복구 버튼·최근 오류·상태 카드 → Task 3·4, KST·"N분 전" → `When`). 4(감사 기록 — 새 표 `ops_action_log`(0073) → Task 2, 화면 → Task 4). 5(api e2e — 실패 job을 실제 워커로 만들어 목록·다시 시도·역할 → Task 2, 화면 Vitest → Task 3·4, 화면 확인은 컨트롤러 → Task 5). 6(launch.json 두 곳 → Task 3).
- 이름 일치: 계약 `OpsQueueName`·`OpsQueueView`·`OpsQueuesView`·`OpsSchedulerView`·`OpsDependencyView`·`OpsWorkerView`·`OpsSystemView`·`OpsOutboxStatus`·`OpsOutboxView`·`OpsErrorSource`·`OpsErrorView`(Task 1), `OpsFailedJobView`·`OpsFailedJobsPage`·`OpsActionKind`·`OpsActionView`·`OpsJobActionResult`·`OpsRequeueResult`·`JOB_NOT_FAILED`(Task 2)를 Task 3·4 화면이 같은 이름으로. api `OPS_VIEW`·`WORKER_OBSERVABILITY`·`recentCount`·`workerNameOf`·`RECENT_MINUTES`·`SYNC_RUN_SCAN_WINDOW`·`OpsQueuesService.queue()`(Task 2)·`OpsAuditService.record/list`·`OPS_ACTIONS`·`redactJobData`·`shortReason`·`MASK`. 화면 `keys.*`(Task 3 한 번에), `useRefetchInterval`·`useAutoRefresh`·`setAutoRefresh`·`resetAutoRefreshForTest`·`REFRESH_MS`, `When`(DashboardPage에서 export, Task 4 화면이 import), `canOperate`(AuthGate), `Freshness`, `ERROR_SOURCE_LABEL`·`ACTION_LABEL`·`scheduleText`(Task 4), 테스트 `renderApp(route, { refreshMs })`·`MONITOR`·`ADMIN`·`dashboardApi`·`queue`·`queuesView`·`systemView`·`outboxView`·`minutesAgo`.
- 플레이스홀더 검사: 코드 블록은 모두 사전 검증 커밋에서 뽑은 실제 코드다(Task 1 `bdd9bb7`, 2 `0f1afee`, 3 `92e56a8`, 4 `a7c1511` — 임시 폴더 `consolecheck`, 기준 10a3f6c). 마이그레이션 파일 이름의 시각만 실행 때 다르다. 실행 때 채우는 것은 devlog의 `HH:MM`·해시·Duration·PID·키 수, README 기록 수(트러블슈팅이 생겼을 때)뿐이다.
- 안전: 개발 DB는 Task 2의 `db:migration:create`(읽기)와 Task 5의 `db:migrate`(표 하나)·`db:migration:check`. 실서버 쓰기는 테스트 DB. Redis는 `test-`·`opsx-live*` 키만 하나씩. 서버는 단독 node 명령·PID로 끄기. 비밀번호는 seed 파일에서 임시 파일로만.
