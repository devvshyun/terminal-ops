# 보강 4 — 현장 작업자 화면 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **기록 규칙 필수**: 이 저장소의 `CLAUDE.md`를 먼저 읽는다. 모든 Task는 마지막에 `docs/devlog/2026-10-28.md`(`# 보강 4: 현장 작업자 화면` 아래, `## HH:MM 보강 4 계획 작성` 항목 뒤)에 항목을 덧붙이고(제목 시각 = 커밋 시각, 제목 끝에 `(커밋 = 이 항목이 든 커밋)`, 본문 첫 줄 `이전 커밋:`, 한 일·확인·막힌 것·결정·다음), Task에 적힌 결정 기록을 쓴 뒤 `node scripts/docs-index.mjs`로 색인을 다시 만들어 **코드와 같은 커밋**에 넣는다. 작업 중 날짜가 바뀌면 그날 날짜로 새 파일 `docs/devlog/YYYY-MM-DD.md`를 시작하고 첫 줄에 이전 파일을 링크한다. 예상과 다른 에러를 만나면 고치기 전에 `docs/troubleshooting/`에 기록을 시작한다(다음 번호 0033). 이 계획은 실험을 쓰지 않는다(다음 번호 0018). 결정 번호는 0061~0064를 쓴다.

**Goal:** 창고·물류 현장 작업자(FIELD)가 휴대폰·PDA로 쓰는 화면(`apps/field`)을 만든다 — 오늘 내 작업 요약, 박스 스캔(발주분 입고·회수 입고, 바코드 스캐너 키보드 웨지 입력, 중복·형식 오류 즉시 표시, scanId 유지·다시 보내기), 검수(검수 대기 목록, 시리얼 스캔으로 찾기, 모델 체크리스트 합격/불합격 + 메모). 서버에는 `GET /field/today` 하나만 더한다.

**Architecture:** api는 `FieldModule`(`GET /field/today`, FIELD만)이 그 사람(로그인 아이디)의 오늘(KST) `scan_batch`·`inspection`을 센다(표 70 → 71). 스캔·검수·검수 대기·단말기 찾기는 기존 API(OPERATOR·FIELD 쓰기, STAFF 조회)를 그대로 쓴다. 화면은 점주 앱과 같은 스택·같은 lock의 별도 Vite 앱(5175, `/api` 프록시 → 같은 출처 세션 쿠키). 공통 코드는 점주 앱 사본 8개 + 사본 검사 테스트(`copies.test.ts`, decisions/0062 — 공유 패키지를 두 앱에 붙여 본 사전 검증 결과로 정함). 박스 스캔의 멱등 규칙은 어드민 ScanPage와 같다. 설계 스펙: `docs/specs/2026-10-28-field-worker.md`.

**Tech Stack:** api Nest.js 12.2(ESM, NodeNext, vitest 5 + swc), MikroORM 7.2(MySQL 8.4), TypeScript 6.0.3. field(새 앱) React 19.3 + Vite 8.3.4 + TanStack Query 5.104.2 + react-router 8.4, Vitest 5.0.4 + Testing Library(user-event 14.6.7 — `keyboard('SN-0001{Enter}')`로 스캐너 흉내) + jsdom — **점주 앱 lock 복사(= 어드민과 같은 판)**. **새 외부 의존성 없음.**

---

## 프로세스·데이터 안전 규칙 (모든 Task에 적용)

- **프로세스는 PID로만 끈다.** `taskkill /IM node.exe`, `pkill node`처럼 이름으로 끄지 않는다. 서버는 `node …` 단독 명령으로 띄우고 `netstat -ano | grep ':<포트> .*LISTENING'`으로 찾은 Windows PID(그 node 프로세스 자신 — Git Bash 서브셸의 `$!`가 아니다)를 `taskkill //PID <PID> //F`로 끈다. 끄기 전에 `tasklist //FI "PID eq <PID>" //FO CSV //NH`로 node.exe인지 본다.
- **Redis를 통째로 지우지 않는다.** `FLUSHALL`·`FLUSHDB` 금지. api를 직접 띄우는 확인은 `QUEUE_PREFIX`를 따로 주고, 끝나면 `docker exec terminal-ops-redis redis-cli --scan --pattern '<접두사>*'`로 본 키만 하나씩 `DEL`한다.
- **테스트는 테스트 DB(`terminal_ops_test`)에서만.** 개발 DB(`terminal_ops`)는 읽기만 한다(이 계획에는 마이그레이션이 없다 — Task 5의 `db:migration:check`). 실서버 쓰기 확인은 테스트 DB로 띄운 api에서. 테스트 DB를 다시 만드는 명령(셸 없이 한 줄, root 비밀번호는 `.env`에서 변수로 읽고 **출력하지 않는다**):
  ```bash
  PW=$(grep '^MYSQL_ROOT_PASSWORD=' .env | cut -d= -f2- | tr -d '\r')
  MSYS_NO_PATHCONV=1 docker exec -e MYSQL_PWD="$PW" terminal-ops-mysql mysql -uroot -e "DROP DATABASE IF EXISTS terminal_ops_test; CREATE DATABASE terminal_ops_test"
  ```
  브랜치를 오가며 같은 테스트 DB를 쓰면 먼저 이 명령으로 다시 만든다(troubleshooting/0030). Task 5가 끝나면 빈 DB로 남긴다.
- **api 테스트를 두 개 동시에 돌리지 않는다**(globalSetup이 partners를 테스트 포트 4011에 띄운다). admin·merchant·field·device-sim·partners 테스트는 같이 돌려도 된다.
- **오래 도는 서버·백그라운드 명령을 남긴 채 끝내지 않는다.** 끝나면 `netstat -ano | grep -E ':(3000|3100|4010|4011|5173|5174|5175|4175) .*LISTENING'` 출력이 없고 `tasklist //FI "IMAGENAME eq node.exe" //FO CSV //NH`가 시작 전과 같은 PID만 보여야 한다.
- **긴 기록·코드 편집은 Write·Edit 도구로 한다**(troubleshooting/0024).
- **시연 계정 비밀번호는 `apps/api/src/db/seed-accounts.ts`에만 있다.** 명령에 넣을 때는 그 파일에서 변수로 읽고(Task 5 스크립트), devlog·리뷰 보고·화면 캡처 설명에 옮겨 적지 않는다.
- **localhost 쿠키는 포트를 가리지 않는다**(보강 3 기록): 어드민(:5173)·점주(:5174)·현장(:5175)이 `sid` 하나를 함께 쓴다. 브라우저로 볼 때 한 앱에서 로그인하면 다른 앱 세션이 끝난다 — 프로필을 나누거나 차례로 본다.

## 사전 검증으로 확인된 사실 (2026-10-28, 임시 폴더)

계획 작성 전에 저장소(브랜치 `field-worker`, master 37df12a)를 임시 폴더에 복제해 앱 다섯 개를 `npm ci`로 설치하고, 이 계획의 코드를 Task 순서대로 적용해 Task마다 커밋하며 돌렸다(테스트 DB `terminal_ops_test`, Redis는 테스트 접두사와 확인용 접두사 `fieldcheck-live`만). 코드 블록은 모두 그 커밋에서 스크립트로 뽑았다(새 파일 = `git show <커밋>:<경로>`, 바꾼 파일 = `git diff <앞 커밋> <커밋> -- <경로>`). Task마다 "실패하는 테스트" 단계의 출력도 그 커밋들로 다시 만들어 돌린 원문이다.

- **테스트 수(실제로 돌려 센 값)**: api master 80/561 → Task 1 **82/567**(전체 327.19초, `Connection is closed` 0, typecheck 0). field(새 앱) Task 2 **3/18** → Task 3 **5/32** → Task 4 **6/39**(tsc 0, build 성공). admin 14/125·merchant 7/47 그대로(contracts에 `field.ts`가 늘어난 뒤 tsc 0·build 성공). device-sim 5/46·partners 6/53 그대로.
- **기존 테스트에서 고친 곳은 없다** — 접근 표(`access-table.spec.ts`)에 한 줄(`'GET /field/today': 'FIELD'`)을 더한다(70 → 71).
- **현장 작업자는 기존 API로 스캔·검수·조회가 된다**: e2e에서 FIELD 계정이 실제 로그인 쿠키로 `POST /scans`(201, 같은 scanId 200 `replayed: true`, actor = 로그인 아이디), `POST /terminals/:serialNo/inspections`(201), `GET /terminals?status=RETURNED&size=100`, `GET /terminals/:serialNo`(`actions.inspect: true`), `GET /purchase-orders?status=RECEIVING`을 불렀다.
- **공유 런타임 패키지를 점주·현장 두 앱에 실제로 붙여 봤다**(버리는 브랜치, decisions/0062): `packages/web-common`(점주 사본 6모듈, 238줄) + 앱마다 `file:` 의존(lock +9줄)·다시 내보내기 6파일. 설정 없이 점주 앱 `TS2307: Cannot find module 'react'`·`'@tanstack/react-query'`·`'@terminal-ops/contracts'`, vitest `Failed to resolve import "react" from "../../packages/web-common/src/session.ts"`(7파일 실패), build `Rolldown failed to resolve import "react"`. 앱마다 `resolve.dedupe: ['react', 'react-dom', '@tanstack/react-query']` + tsconfig `paths` 넷이면 점주 tsc 0·47 통과·build 성공, 현장 tsc 0·18 통과·build 성공. `dedupe`만 빼면 tsc 0인데 vitest·build가 같은 `Failed to resolve import "react"`로 실패. `LogoutButton`은 앱마다 다른 `ErrorBox`를 불러 옮기지 못했다. → 복사 유지 + 사본 검사 테스트로 정했다.
- **사본 검사 테스트가 실제로 잡는다**: 점주 `api/client.ts`의 `LOGIN_PATH` 한 줄을 바꾸자 현장 `copies.test.ts`가 `× api/client.ts는 점주 앱 것과 코드가 같다`(되돌림).
- **Vite가 테스트의 ``new URL(`../../${app}/src/${path}`, import.meta.url)``을 자산 glob으로 바꾼다**: 처음 짠 사본 검사가 `Error: Denied ID …/apps/admin/src/App.tsx?url`로 파일 전체 실패 → `node:path` `resolve(dirname(fileURLToPath(import.meta.url)), '../..')`로(계획 코드에 반영됨).
- **한 줄 입력칸에 여러 줄을 붙여 넣으면 줄바꿈이 지워진다**(jsdom 테스트): `SN-0010 SN-0011\nSN-0012` → `['SN-0010', 'SN-0011SN-0012']`. → 공백·쉼표·줄바꿈이 든 붙여 넣기는 `onPaste`가 바로 목록에 더한다(계획 코드에 반영됨, decisions/0064).
- **시연 브라우저에 `BarcodeDetector`가 없다**: 내장 브라우저(`Chrome/152.0.7977.167`, Windows, `http://localhost:5176` — `isSecureContext: true`)에서 `'BarcodeDetector' in window` = `false`, `getUserMedia`는 있음. → 카메라 바코드 생략(decisions/0064). 같은 탭을 375×812로 바꿔 로그인 화면 `scrollWidth` 375(가로 스크롤 없음), 로그인 버튼 높이 56px.
- **점주 lock을 복사하면 같은 트리가 깔린다**: name 두 줄(2·7행)만 바꿔 `npm ci` → `added 113 packages`, `npm ls --depth=0`이 점주와 같은 17줄, `found 0 vulnerabilities`.
- **실서버 확인(테스트 DB에 `migrate up` + `seed`, api `API_PORT=3200 RUN_WORKERS=0 RUN_SCHEDULERS=0 QUEUE_PREFIX=fieldcheck-live`, 현장 개발 서버 `FIELD_API_URL=http://localhost:3200 … --port 5176`)**: index 200 `<title>단말온 현장</title>`, 프록시 health `{"status":"ok"}`, 로그인 없이 `/api/field/today` 401, 운영자(api 직접) 등록 201·운영자의 `/field/today` 403, **현장 작업자는 프록시로만**: 로그인 200(HttpOnly 쿠키 1줄), `/auth/me` FIELD, 오늘 요약 0, 검수 대기 `1 LIVE-F-0001`, 열린 발주 200, 회수 입고 박스 201(행 INVALID_STATE·NOT_FOUND), 같은 scanId 200 `"replayed":true`, 단말기 `"inspect":true`, 검수(PRINTER 불합격) 201 `DEFECTIVE`, 오늘 요약 `boxes 1, rejected 2, inspections total 1 failed 1`, 현장의 `/dashboard/summary`·`POST /terminals` 403, 로그아웃 204 뒤 401. 두 서버를 PID로 끈 뒤 3200·5176 LISTENING 0, node PID는 시작 전 넷 그대로. 확인용 Redis 키는 큐 meta 6개(세션은 로그아웃으로 지워짐) — 하나씩 DEL. 테스트 DB는 빈 DB로 다시 만들었다.

## 범위 조정 (브리프와 다르게 한 것과 이유)

- **검수 대기 전용 엔드포인트를 만들지 않았다** — 기존 `GET /terminals?status=`(STAFF)를 상태마다 한 번씩(RECEIVED·RETURNED, size 100) 불러 화면이 오래 기다린 순으로 합친다(어드민 ScanPage의 열린 발주와 같은 모양, decisions/0063). 새 API는 `GET /field/today` 하나.
- **현장 앱은 FIELD만** — 운영자·관제·ADMIN·가맹점주는 안내와 로그아웃만(운영자는 같은 일을 어드민에서 한다). `GET /field/today`도 FIELD만.
- **카메라 바코드는 넣지 않았다** — 시연 환경 브라우저(이 PC의 Chromium 계열 내장 브라우저)에서 `BarcodeDetector`가 없다(사전 검증, decisions/0064). 키보드 웨지 스캐너와 손 입력·붙여 넣기만.
- **회수 단말기 받기 전용 화면은 만들지 않았다** — 박스 스캔의 회수 입고(RETURN_IN)로 충분하다(브리프가 허용).
- **어드민의 FIELD 화면은 그대로 둔다** — 지우면 어드민 테스트가 바뀌고, 사무실 PC에서 쓸 수도 있다.
- **공통 코드는 복사 유지 + 사본 검사 테스트**(0058을 다시 봤다 — 공유 패키지를 두 앱에 실제로 붙여 보고 비용을 쟀다, decisions/0062).
- **launch.json**: 세션 루트(`C:\Devhyun\History\.claude\launch.json`)와 저장소 `.claude/launch.json`(gitignore) 둘 다에 `terminal-ops-field`를 더한다(Task 5). 커밋되는 것은 없다.

## 파일 구조

```
terminal-ops/
├─ packages/contracts/src/field.ts (새), index.ts                                          (Task 1)
├─ apps/api/
│  ├─ src/field/field.controller.ts·field.service.ts·field.module.ts (새), src/app.module.ts   (Task 1)
│  ├─ src/common/kst.ts (kstDayOf)                                                          (Task 1)
│  └─ test/field.e2e.spec.ts (새), test/unit/kst-day.spec.ts (새), test/unit/access-table.spec.ts(한 줄)   (Task 1)
├─ apps/field/ (새 앱)
│  ├─ package.json·package-lock.json(점주 복사 + 이름), tsconfig.json(점주 복사), vite.config.ts, index.html   (Task 2)
│  └─ src/
│     ├─ 점주 사본 8개: api/client.ts, session.ts, query-client.ts, lib/format.ts, components/SessionCacheSync·LogoutButton, hooks/useSessionCheck.ts, test/setup.ts   (Task 2)
│     ├─ main.tsx, App.tsx(Task 3·4 보탬), styles.css(Task 3·4 보탬)                       (Task 2)
│     ├─ api/query-keys.ts·queries.ts (Task 2, 3·4 보탬)
│     ├─ components/AuthGate·ErrorBox·Shell, pages/LoginPage·HomePage, test/render.tsx      (Task 2)
│     ├─ lib/scan.ts, pages/ScanPage.tsx                                                     (Task 3)
│     ├─ lib/labels.ts, pages/InspectionQueuePage.tsx·InspectPage.tsx                        (Task 4)
│     └─ 테스트: App.test.tsx·copies.test.ts·api/query-keys.test.ts (Task 2), lib/scan.test.ts·pages/ScanPage.test.tsx (Task 3), pages/InspectPages.test.tsx (Task 4)
└─ docs/
   ├─ decisions/0063 (Task 1), 0061·0062 (Task 2), 0064 (Task 3, Task 4 보탬), 0052·0058 보탬 (Task 1·2)
   ├─ devlog/2026-10-28.md, index.md(스크립트), study/backlog.md
   └─ README.md, retrospective.md (Task 5)
```

## Task 순서

| Task | 내용 | 앱 | 기록 | 테스트 수(끝) | 추천 모델 |
|---|---|---|---|---|---|
| 1 | 현장 API — `GET /field/today`(KST 하루, 내 박스·행 결과·검수), contracts `FieldTodayView`, 접근 표 | contracts, api | decisions 0063, 0052 보탬 | api 82/567 | sonnet |
| 2 | 현장 앱 골격 — 설치(점주 lock), Vite 5175 프록시, 점주 사본 8개 + 사본 검사, 로그인 문(FIELD만)·화면 틀·홈(오늘 내 작업) | field | decisions 0061·0062, 0058 보탬 | field 3/18 | sonnet |
| 3 | 박스 스캔 — 키보드 웨지 입력·붙여 넣기·중복·형식 표시·빼기, 열린 발주, scanId 멱등(어드민 규칙), 줄마다 결과 | field | decisions 0064 | field 5/32 | opus(멱등·초점·붙여 넣기 판단이 섞인 화면) |
| 4 | 검수 — 검수 대기(상태 둘 합침)·시리얼 스캔으로 찾기·체크리스트(합격/불합격 + 메모)·저장·결과 | field | 0064 보탬 | field 6/39 | sonnet |
| 5 | 마감 — 전체 검증, 실서버 확인(테스트 DB + 현장 프록시), launch.json, README·회고·색인 | 전체·docs | 요약 | 최종 확인 | sonnet |

의존: 차례대로 한다. Task 2~4의 화면은 Task 1의 계약 타입(`FieldTodayView`)을 쓴다(테스트는 가짜 fetch라 api를 띄우지 않는다). Task 2의 사본 검사는 점주 앱 파일을 읽으므로 `apps/merchant`가 있어야 한다(설치는 필요 없다). 각 Task 끝의 테스트 수가 위 표와 다르면 멈추고 원인을 적는다.

## 커밋 규칙(보강 4)

범위는 `field`로 쓴다: `type(field): 요약`. 기존 기능을 함께 바꾸면 그 ID를 붙인다(오늘 내 작업 API — `field, F6, F13`, 박스 스캔 화면 — `field, F6`, 검수 화면 — `field, F13`). 본문에 `Refs: <기록 경로>`, 마지막 줄 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. 이 규칙은 Task 1 devlog 항목에 한 줄로 적는다.

---

### Task 1: 현장 API — `GET /field/today`(오늘 내 작업), KST 하루, 접근 표

**Files:**
- Create: `packages/contracts/src/field.ts`; Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/field/field.service.ts`, `apps/api/src/field/field.controller.ts`, `apps/api/src/field/field.module.ts`; Modify: `apps/api/src/app.module.ts`, `apps/api/src/common/kst.ts`
- Test: Create `apps/api/test/field.e2e.spec.ts`, `apps/api/test/unit/kst-day.spec.ts`; Modify `apps/api/test/unit/access-table.spec.ts`
- Docs: Create `docs/decisions/0063-현장-API는-오늘-내-작업-하나만.md`; Modify `docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md`, `docs/study/backlog.md`, `docs/index.md`, `docs/devlog/2026-10-28.md`

- [ ] **Step 1: 계약 타입**

`packages/contracts/src/field.ts`:

```ts
/**
 * 현장 작업자 화면(보강 4, `apps/field`)이 받는 모양. 박스 스캔·검수 자체는 운영자 어드민과 같은 API(`POST /scans`,
 * `POST /terminals/:serialNo/inspections`)를 쓰고, 여기에는 현장 화면에만 있는 "오늘 내 작업" 요약만 있다(decisions/0063).
 */

/** GET /field/today — 로그인한 현장 작업자가 오늘(KST 0시부터) 한 일 */
export interface FieldTodayView {
  /** 오늘 KST 날짜 'YYYY-MM-DD' */
  date: string;
  scans: {
    /** 처리한 박스 수(같은 scanId로 다시 보낸 것은 한 번 — decisions/0020) */
    boxes: number;
    /** 발주분 입고로 등록된 단말기 수(행 결과 CREATED) */
    received: number;
    /** 회수 입고된 단말기 수(행 결과 RETURNED) */
    returned: number;
    /** 거절된 행 수(형식·중복·명세 밖·상태 등 — 그 밖의 행 결과) */
    rejected: number;
  };
  inspections: {
    total: number;
    passed: number;
    failed: number;
  };
}
```

`packages/contracts/src/index.ts`:

```diff
diff --git a/packages/contracts/src/index.ts b/packages/contracts/src/index.ts
index 717df46..77fd177 100644
--- a/packages/contracts/src/index.ts
+++ b/packages/contracts/src/index.ts
@@ -1,5 +1,5 @@
 /**
- * @terminal-ops/contracts — api와 어드민·매장 화면이 함께 보는 HTTP 계약(응답·요청 모양, 상태 값, 오류 코드).
+ * @terminal-ops/contracts — api와 어드민·매장·현장 화면이 함께 보는 HTTP 계약(응답·요청 모양, 상태 값, 오류 코드).
  * 타입만 있다(런타임 값 없음). 쓰는 쪽은 `import type`으로만 가져온다 — 빌드된 JS에 이 패키지 import가 남지 않는다(decisions/0047).
  * api는 응답을 만드는 함수의 반환 타입·DTO의 implements로 이 타입을 지키고(어긋나면 api tsc 실패), 어드민은 이 타입으로 응답을 읽는다(decisions/0048).
  */
@@ -12,3 +12,4 @@ export type * from './reports.js';
 export type * from './requests.js';
 export type * from './auth.js';
 export type * from './merchant.js';
+export type * from './field.js';
```

- [ ] **Step 2: 실패하는 테스트**

`apps/api/test/unit/kst-day.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { kstDayOf } from '../../src/common/kst.js';

const at = (iso: string) => new Date(iso);

describe('KST 하루 경계 (현장 작업자의 오늘, decisions/0063)', () => {
  it('KST 00:00(= 전날 15:00 UTC)부터 다음 날 00:00 전까지가 하루', () => {
    expect(kstDayOf(at('2026-10-28T03:00:00.000Z'))).toEqual({
      date: '2026-10-28',
      from: at('2026-10-27T15:00:00.000Z'),
      to: at('2026-10-28T15:00:00.000Z'),
    });
    // UTC로는 27일이지만 KST로는 28일 00:00
    expect(kstDayOf(at('2026-10-27T15:00:00.000Z')).date).toBe('2026-10-28');
    // 그 1ms 전(KST 27일 23:59:59.999)은 전날
    expect(kstDayOf(at('2026-10-27T14:59:59.999Z')).date).toBe('2026-10-27');
  });

  it('달·해가 바뀌는 날도 맞다', () => {
    expect(kstDayOf(at('2026-12-31T15:30:00.000Z'))).toEqual({
      date: '2027-01-01',
      from: at('2026-12-31T15:00:00.000Z'),
      to: at('2027-01-01T15:00:00.000Z'),
    });
  });
});
```

`apps/api/test/field.e2e.spec.ts`(현장 작업자는 실제 로그인 쿠키로 기존 스캔·검수 API를 부른다. 어제 일은 `kstDayOf(now).from` 1분 전 — datetime 열이 초 단위로 반올림해 1ms 전은 오늘로 올라갈 수 있다, troubleshooting/0031):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kstDayOf } from '../src/common/kst.js';
import { Inspection } from '../src/inspection/inspection.entities.js';
import { ScanBatch, ScanKind } from '../src/scan/scan-batch.entity.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { createAccount, login, withCookie } from './helpers/auth.js';
import { partners } from './helpers/partners.js';
import { orderPurchase, prepareInService, transitionTo } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const SN100 = ['POWER', 'NETWORK', 'CARD_READER', 'PRINTER'];
const allPass = SN100.map((itemCode) => ({ itemCode, passed: true }));
const oneFail = SN100.map((itemCode) => ({ itemCode, passed: itemCode !== 'PRINTER', ...(itemCode === 'PRINTER' ? { note: '용지 걸림' } : {}) }));

/**
 * 현장 작업자 화면용 API(보강 4, decisions/0063). 스캔·검수는 현장 작업자가 실제 로그인(쿠키)으로 기존 API를 부르고,
 * GET /field/today가 그 사람의 오늘(KST) 일만 세는지 본다. 날짜 경계는 단위 테스트(kst-day.spec.ts)가 본다 —
 * 여기서는 "지금"이 속한 날을 쓰므로 KST 자정에 걸쳐 돌면 어긋날 수 있다(드묾).
 */
describe('현장 작업자 오늘 내 작업 /field/today (보강 4)', () => {
  let t: TestApp;
  let field: string;
  let receive: { poNo: string; serials: string[] };

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await partners.reset();
    await createAccount(t, 'field-kim', 'FIELD');
    await createAccount(t, 'owner-gangnam', 'MERCHANT', 'GANGNAM-KIMBAP');
    field = await login(t, 'field-kim');
    receive = await orderPurchase(t, 3);
    // 회수 입고할 단말기: 운영 중 → 회수 요청 → 회수 중
    await prepareInService(t, 'FLD-RET-1');
    await transitionTo(t, 'FLD-RET-1', 'RETURN_REQUESTED', '회수 요청');
    await transitionTo(t, 'FLD-RET-1', 'RETURNING', '회수 출발');
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('아무것도 안 했으면 오늘 날짜와 0', async () => {
    const res = await withCookie(t, field).get('/field/today');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      date: kstDayOf(new Date()).date,
      scans: { boxes: 0, received: 0, returned: 0, rejected: 0 },
      inspections: { total: 0, passed: 0, failed: 0 },
    });
  });

  it('내가 오늘 처리한 박스·단말기·검수를 센다 — 같은 scanId 다시 보내기는 한 번, 남의 일·어제 일은 빠진다', async () => {
    const [a, b] = receive.serials;
    const box = { scanId: 'BOX-FIELD-0001', kind: 'RECEIVE', poNo: receive.poNo, serials: [a, b, 'bad'] };
    expect((await withCookie(t, field).post('/scans').send(box)).status).toBe(201);
    const again = await withCookie(t, field).post('/scans').send(box);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, actor: 'field-kim' });
    expect((await withCookie(t, field).post('/scans').send({ scanId: 'BOX-FIELD-0002', kind: 'RETURN_IN', serials: ['FLD-RET-1'] })).body.summary).toEqual({
      RETURNED: 1,
    });
    expect((await withCookie(t, field).post(`/terminals/${a}/inspections`).send({ results: allPass })).body).toMatchObject({ passed: true });
    expect((await withCookie(t, field).post(`/terminals/${b}/inspections`).send({ results: oneFail })).body).toMatchObject({
      passed: false,
      failedItems: ['PRINTER'],
    });

    // 남의 일: 운영자(테스트 헤더 tester)가 같은 발주의 나머지를 입고하고 검수
    const other = receive.serials[2];
    expect((await t.http().post('/scans').send({ scanId: 'BOX-OPER-0001', kind: 'RECEIVE', poNo: receive.poNo, serials: [other] })).status).toBe(201);
    expect((await t.http().post(`/terminals/${other}/inspections`).send({ results: allPass })).status).toBe(201);

    // 어제 일: 오늘 0시보다 1분 전(datetime 열이 초 단위로 반올림하므로 1ms 전은 오늘로 올라갈 수 있다 — troubleshooting/0031)
    const yesterday = new Date(kstDayOf(new Date()).from.getTime() - 60_000);
    const em = t.orm.em.fork();
    em.create(ScanBatch, {
      scanId: 'BOX-FIELD-OLD1',
      kind: ScanKind.RETURN_IN,
      requestHash: '0'.repeat(64),
      actor: 'field-kim',
      results: [{ serialNo: 'OLD-1', result: 'RETURNED' }],
      createdAt: yesterday,
    });
    em.create(Inspection, { terminal: await em.findOneOrFail(Terminal, { serialNo: a }), passed: true, actor: 'field-kim', inspectedAt: yesterday });
    await em.flush();

    const res = await withCookie(t, field).get('/field/today');
    expect(res.body).toEqual({
      date: kstDayOf(new Date()).date,
      scans: { boxes: 2, received: 2, returned: 1, rejected: 1 },
      inspections: { total: 2, passed: 1, failed: 1 },
    });
  });

  it('현장 작업자만 부른다 — 운영자·가맹점주 403, 로그인 없음 401', async () => {
    expect((await t.http().get('/field/today')).status).toBe(403);
    const owner = await login(t, 'owner-gangnam');
    expect((await withCookie(t, owner).get('/field/today')).status).toBe(403);
    expect((await t.http(null).get('/field/today')).status).toBe(401);
  });

  it('현장 작업자는 검수 대기 목록·단말기 조회·발주 목록을 읽을 수 있다(현장 화면이 쓰는 기존 API, STAFF)', async () => {
    const queue = await withCookie(t, field).get('/terminals').query({ status: 'RECEIVED', size: 100 });
    expect(queue.status).toBe(200);
    expect(queue.body.items.map((i: { serialNo: string }) => i.serialNo)).toEqual([]); // 셋 다 검수돼 대기 없음
    const returned = await withCookie(t, field).get('/terminals').query({ status: 'RETURNED', size: 100 });
    expect(returned.body.items.map((i: { serialNo: string }) => i.serialNo)).toEqual(['FLD-RET-1']);
    expect((await withCookie(t, field).get('/terminals/FLD-RET-1')).body).toMatchObject({ status: 'RETURNED', actions: { inspect: true } });
    expect((await withCookie(t, field).get('/purchase-orders').query({ status: 'RECEIVING', limit: 100 })).status).toBe(200);
  });
});
```

`apps/api/test/unit/access-table.spec.ts`(표에 한 줄):

```diff
diff --git a/apps/api/test/unit/access-table.spec.ts b/apps/api/test/unit/access-table.spec.ts
index d59144d..7176e00 100644
--- a/apps/api/test/unit/access-table.spec.ts
+++ b/apps/api/test/unit/access-table.spec.ts
@@ -83,6 +83,8 @@ const EXPECTED: Record<string, string> = {
   'POST /me/service-tickets': 'MERCHANT',
   'POST /me/service-tickets/:id/installations': 'MERCHANT',
 
+  // 현장 작업자 화면 전용(보강 4, decisions/0063)
+  'GET /field/today': 'FIELD',
   // 계정·외부 업체 키 관리(decisions/0054)
   'GET /admin/accounts': 'ADMIN',
   'POST /admin/accounts': 'ADMIN',
```

- [ ] **Step 3: 실패 확인**

```bash
# 저장소 루트에서 테스트 DB를 새로 만든다(안전 규칙의 두 줄 — 비밀번호는 출력하지 않는다)
cd apps/api && npx vitest run test/unit/kst-day.spec.ts test/unit/access-table.spec.ts test/field.e2e.spec.ts
```

Expected(사전 검증 원문 요약): `Test Files  3 failed (3)`, `Tests  7 failed | 2 passed (9)` —
- kst-day 두 개: `TypeError: kstDayOf is not a function`
- access-table: `AssertionError: expected { …(70) } to deeply equal { …(71) }`, `AssertionError: expected 70 to be 71`
- field.e2e: `AssertionError: expected 404 to be 200`, `TypeError: kstDayOf is not a function`, `AssertionError: expected 404 to be 403`(마지막 "현장 화면이 쓰는 기존 API" 테스트는 기존 API라 처음부터 통과)

- [ ] **Step 4: 구현**

`apps/api/src/common/kst.ts`(`kstDayOf` — kst-week.ts와 같은 방식으로 getUTC*만):

```diff
diff --git a/apps/api/src/common/kst.ts b/apps/api/src/common/kst.ts
index 05db087..98cbb30 100644
--- a/apps/api/src/common/kst.ts
+++ b/apps/api/src/common/kst.ts
@@ -14,6 +14,21 @@ export function kstDate(instant: Date): string {
   return `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())}`;
 }
 
+/** 하루: KST 00:00부터 다음 날 00:00 전까지. from·to는 그 순간의 UTC 시각(DB 비교용, [from, to)) */
+export interface KstDay {
+  /** KST 날짜 'YYYY-MM-DD' */
+  date: string;
+  from: Date;
+  to: Date;
+}
+
+/** instant가 속한 KST 하루(현장 작업자의 "오늘", decisions/0063). getUTC*만 써서 서버 시간대에 기대지 않는다(kst-week.ts와 같은 방식) */
+export function kstDayOf(instant: Date): KstDay {
+  const k = toKstWallClock(instant);
+  const from = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - KST_OFFSET_MS);
+  return { date: kstDate(instant), from, to: new Date(from.getTime() + 24 * 3_600_000) };
+}
+
 /**
  * 사람이 읽는 시각 'YYYY-MM-DD HH:mm:ss KST'(밀리초 버림). 알림 문구용 — payload는 UTC ISO 그대로 두고 문구만 바꾼다.
  * 시각으로 읽을 수 없는 값은 받은 그대로 글자로 돌려준다(문구 만들기가 알림 전체를 깨지 않게).
```

`apps/api/src/field/field.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { FieldTodayView } from '@terminal-ops/contracts';
import { kstDayOf } from '../common/kst.js';
import { Inspection } from '../inspection/inspection.entities.js';
import { ScanBatch } from '../scan/scan-batch.entity.js';

/**
 * 현장 작업자 화면의 "오늘 내 작업"(보강 4, decisions/0063). 이 사람(actor = 로그인 아이디, decisions/0056)이 오늘(KST) 처리한 박스와 검수를 센다.
 * 박스는 scan_batch 한 행 = 한 번 처리한 박스라 같은 scanId로 다시 보낸 것(replayed)은 저절로 한 번만 센다(decisions/0020).
 * 행 결과는 JSON 열이라 SQL로 펼치지 않고 그 사람의 오늘 박스만 읽어 여기서 더한다(하루 수십 박스, 박스당 500행 이하).
 */
@Injectable()
export class FieldService {
  constructor(private readonly em: EntityManager) {}

  async today(actor: string, now = new Date()): Promise<FieldTodayView> {
    const em = this.em.fork();
    const day = kstDayOf(now);
    const batches = await em.find(ScanBatch, { actor, createdAt: { $gte: day.from, $lt: day.to } }, { fields: ['results'] });
    const scans = { boxes: batches.length, received: 0, returned: 0, rejected: 0 };
    for (const row of batches.flatMap((b) => b.results)) {
      if (row.result === 'CREATED') scans.received += 1;
      else if (row.result === 'RETURNED') scans.returned += 1;
      else scans.rejected += 1;
    }
    const inspectedToday = { actor, inspectedAt: { $gte: day.from, $lt: day.to } };
    const [total, passed] = await Promise.all([em.count(Inspection, inspectedToday), em.count(Inspection, { ...inspectedToday, passed: true })]);
    return { date: day.date, scans, inspections: { total, passed, failed: total - passed } };
  }
}
```

`apps/api/src/field/field.controller.ts`:

```ts
import { Controller, Get } from '@nestjs/common';
import type { FieldTodayView } from '@terminal-ops/contracts';
import { Roles } from '../auth/access.js';
import { Role } from '../auth/role.js';
import { Operator } from '../common/operator.decorator.js';
import { FieldService } from './field.service.js';

/**
 * 현장 작업자 화면 전용(보강 4, decisions/0063). 스캔·검수는 기존 API(OPERATOR·FIELD)를 그대로 쓰고, 여기에는 현장 화면에만 필요한 것만 둔다.
 * 쓰는 화면이 현장 앱 하나라 FIELD만 연다(표 decisions/0052).
 */
@Controller('field')
export class FieldController {
  constructor(private readonly field: FieldService) {}

  /** 오늘(KST) 내가 처리한 박스·단말기·검수 수 */
  @Get('today')
  @Roles(Role.FIELD)
  async today(@Operator() actor: string): Promise<FieldTodayView> {
    return this.field.today(actor);
  }
}
```

`apps/api/src/field/field.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { FieldController } from './field.controller.js';
import { FieldService } from './field.service.js';

/** 현장 작업자 화면용 API `/field/...`(보강 4, decisions/0063) */
@Module({
  controllers: [FieldController],
  providers: [FieldService],
})
export class FieldModule {}
```

`apps/api/src/app.module.ts`:

```diff
diff --git a/apps/api/src/app.module.ts b/apps/api/src/app.module.ts
index 59c90f7..accb9e0 100644
--- a/apps/api/src/app.module.ts
+++ b/apps/api/src/app.module.ts
@@ -25,6 +25,7 @@ import { WorkersModule } from './workers/workers.module.js';
 import { SchedulerModule } from './scheduler/scheduler.module.js';
 import { AuthModule } from './auth/auth.module.js';
 import { MeModule } from './me/me.module.js';
+import { FieldModule } from './field/field.module.js';
 import { AdminModule } from './admin/admin.module.js';
 import { PartnerApiModule } from './partner-api/partner-api.module.js';
 
@@ -58,6 +59,7 @@ export interface AppOptions {
     ReportModule,
     DashboardModule,
     MeModule,
+    FieldModule,
     AdminModule,
     PartnerApiModule,
   ],
```

- [ ] **Step 5: 통과 확인과 전체 api**

```bash
cd apps/api
npx vitest run test/unit/kst-day.spec.ts test/unit/access-table.spec.ts test/field.e2e.spec.ts
npm run typecheck
# 테스트 DB를 새로 만든 뒤(안전 규칙) 전체 — 약 5분 반
npx vitest run > /tmp/field-t1-api.log 2>&1; grep -E "Test Files|Tests |Duration" /tmp/field-t1-api.log; grep -c "Connection is closed" /tmp/field-t1-api.log
```

Expected: 세 파일 `Test Files  3 passed (3)`, `Tests  9 passed (9)`. typecheck 출력 없음(exit 0). 전체 `Test Files  82 passed (82)`, `Tests  567 passed (567)`(사전 검증 Duration 327.19s), `Connection is closed` 0. 기존 테스트는 고치지 않았다(접근 표에 한 줄만).

- [ ] **Step 6: 기록**

`docs/decisions/0063-현장-API는-오늘-내-작업-하나만.md`:

````markdown
# 0063. 현장 화면용 API는 "오늘 내 작업" 하나만 새로 열고, 검수 대기·단말기 찾기는 기존 조회를 쓴다

- 날짜 / 관련 기능: 2026-10-28 / 보강 4, F6(박스 스캔), F13(검수)
- 상황: 현장 화면(decisions/0061)은 (1) 오늘 내가 처리한 박스·단말기·검수 수, (2) 검수 대기 단말기 목록(RECEIVED·RETURNED), (3) 시리얼로 단말기 찾기와 "지금 검수할 수 있나", (4) 열린 발주 목록, (5) 박스 스캔·검수 저장이 필요하다. (4)(5)는 어드민 ScanPage·검수 폼이 쓰는 API(`GET /purchase-orders?status=`, `POST /scans`, `POST /terminals/:serialNo/inspections` — FIELD 허용)가 그대로 맞다. 역할 표는 기본 거부다(decisions/0052).
- 선택지(오늘 내 작업):
  1. 화면이 센다(스캔 응답을 브라우저 저장소에 쌓기) — 새로 고치거나 다른 기기·어드민에서 한 일이 빠진다. 다시 보내기(replayed)를 두 번 셀 위험
  2. 기존 API로 센다 — 박스·검수를 "작업자·날짜"로 거르는 조회가 없다(`GET /scans/:scanId`는 한 건, 검수 기록은 단말기별)
  3. **새 엔드포인트 `GET /field/today`(FIELD만)** — 서버가 `scan_batch`(작업자·생성 시각)와 `inspection`(작업자·검수 시각)을 센다. 박스 한 행 = 한 번 처리한 박스라 같은 scanId 다시 보내기는 저절로 한 번(decisions/0020). 행 결과는 JSON 열이라 SQL로 펼치지 않고 그 사람의 오늘 박스만 읽어 더한다
- 선택지(검수 대기):
  1. 전용 엔드포인트(`GET /field/inspection-queue`, 오래 기다린 순) — 줄 세우기를 서버가 한다. 단점: 단말기 목록과 같은 일을 하는 조회가 하나 더(범위·쪽·응답 모양을 다시 정의), 표에 한 줄 더
  2. **기존 `GET /terminals?status=RECEIVED&size=100`과 `?status=RETURNED&size=100`(STAFF, FIELD 포함)을 화면이 합쳐 오래 기다린 순(`statusChangedAt` 오름차순)으로** — 어드민 ScanPage가 열린 발주를 상태별로 두 번 불러 합치는 것과 같은 모양. 단점: 상태별 100대를 넘으면 잘린다(화면이 "N대 중 M대만" 표시 — `total`로 안다), 요청 둘
- 선택지(찾기·검수 가능 여부): **기존 `GET /terminals/:serialNo`의 `actions.inspect`**(서버가 전이 표에서 계산, decisions/0040). 화면은 검수 대기 상태를 따로 판정하지 않는다(목록 조건의 상태 둘만 화면 상수 — 전이 표의 RECEIVED·RETURNED → INSPECTED·DEFECTIVE와 같다)
- 결정: 오늘 내 작업은 3, 검수 대기는 2, 찾기는 `actions.inspect`.
  - `FieldTodayView`(contracts `field.ts`): `date`(KST 'YYYY-MM-DD'), `scans { boxes, received(CREATED 행), returned(RETURNED 행), rejected(그 밖의 행) }`, `inspections { total, passed, failed }`
  - "오늘" = KST 0시부터 다음 0시 전(`common/kst.ts` `kstDayOf` — getUTC*만 써서 서버 시간대와 상관없다, kst-week와 같은 방식). "나" = 로그인 아이디(`@Operator()`, decisions/0056)
  - FIELD만 연다(쓰는 화면이 현장 앱 하나 — 운영자 어드민에는 이 요약이 없다). 표 70 → 71
  - 인덱스는 더하지 않는다: `scan_batch`·`inspection`에 (actor, 시각) 인덱스가 없어 표를 훑는다. 시연·학습 규모(수천 행)에서는 문제가 아니고 마이그레이션이 생기면 개발 DB 쓰기가 는다(decisions/0036·0045와 같은 판단 — 재지 않고 더하지 않는다)
- 결과·대가: 엔드포인트 하나(71). 검수 대기는 상태별 100대까지만 보인다(넘으면 화면이 알리고, 스캔으로 찾기는 그대로 된다). 오늘 요약은 화면이 열릴 때·창으로 돌아올 때·쓰기 뒤에 다시 읽는다(실시간 아님).
- 다시 볼 조건: 한 작업자가 하루 수백 박스를 넘기거나 `scan_batch`가 수십만 행이 되면 (actor, created_at) 인덱스를 재고 더한다. 검수 대기가 상태별 100대를 자주 넘으면 전용 엔드포인트(키셋, 오래된 순)로. 운영자도 "작업자별 오늘 실적"을 보게 되면 엔드포인트를 OFFICE용(작업자 조건)으로 따로.
````

`docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md` — 표의 `MERCHANT(0053, Task 4; 보강 3 0059)` 줄 바로 아래에 한 줄:

```markdown
  | FIELD(보강 4, 0063) | `GET /field/today` |
```

같은 파일 끝(마지막 줄 `- 보강 3 보탬(decisions/0059): …` 뒤)에 한 줄:

```markdown
- 보강 4 보탬(decisions/0063): 현장 화면용 `GET /field/today`(FIELD만)를 더해 엔드포인트 70 → 71(접근 표 테스트가 센 값). 현장 화면의 나머지 읽기(검수 대기 `GET /terminals?status=`, 단말기 상세, 검수 항목, 발주 목록)와 쓰기(`POST /scans`, `POST /terminals/:serialNo/inspections`)는 기존 규칙(STAFF, OPERATOR·FIELD) 그대로다.
```

`docs/study/backlog.md` 끝에 한 줄:

```markdown
- [ ] MikroORM `find(…, { fields: ['results'] })` 부분 로딩 — 부분 엔티티가 identity map에 남을 때 같은 요청에서 다시 읽으면 빠진 필드는? (apps/api/src/field/field.service.ts, decisions/0063)
```

devlog 항목(`## HH:MM 보강 4 계획 작성` 항목 뒤):

```markdown
## HH:MM Task 1 현장 API — GET /field/today(오늘 내 작업)·KST 하루·접근 표 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <계획 커밋 해시> (docs: 보강 4 계획 — 현장 작업자 화면)
- 한 일: contracts `FieldTodayView`(field.ts), api `FieldModule` — `GET /field/today`(FIELD만): 로그인 아이디의 오늘(KST 0시~) `scan_batch` 수와 행 결과(CREATED·RETURNED·그 밖), `inspection` 수(합격·불합격). `common/kst.ts` `kstDayOf`. 접근 표 70 → 71
- 확인: 새 테스트 7개 실패(`kstDayOf is not a function`, 404, 표 70/71) → 통과(3파일 9개). api 전체 `Test Files  82 passed (82)`, `Tests  567 passed (567)`, Duration <초>, `Connection is closed` <수>. typecheck 0
- 결정: decisions/0063(오늘 내 작업 하나만 새로, 검수 대기는 기존 `/terminals?status=` 두 번, 찾기는 `actions.inspect`, 인덱스 안 더함), 0052 표·보탬
- 커밋 규칙(보강 4): `type(field): 요약`, 기존 기능을 함께 바꾸면 `field, F6, F13` 식, 본문 `Refs:`, 마지막 줄 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 다음: Task 2 현장 앱 골격
```

```bash
node scripts/docs-index.mjs
```

- [ ] **Step 7: 커밋**

```bash
git add packages/contracts apps/api docs
git status --short   # node_modules·dist·.snapshot-terminal_ops_test.json이 없어야 한다
git commit -m "$(cat <<'EOF'
feat(field, F6, F13): 현장 화면용 오늘 내 작업 API — GET /field/today

Refs: docs/decisions/0063-현장-API는-오늘-내-작업-하나만.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 제목 시각 = 커밋 시각(`git log -1 --format=%cd --date=format:%H:%M`)인지 보고, 다르면 고쳐 `git commit --amend --no-edit`.

---


### Task 2: 현장 앱 골격 — 설치, Vite 프록시, 점주 사본 + 사본 검사, 로그인 문·화면 틀·오늘 내 작업

**Files:**
- Create(복사 + 이름만): `apps/field/package.json`, `apps/field/package-lock.json`, `apps/field/tsconfig.json`
- Create(점주 사본, 머리 주석만 현장용): `apps/field/src/api/client.ts`, `src/session.ts`, `src/query-client.ts`, `src/lib/format.ts`, `src/components/SessionCacheSync.tsx`, `src/components/LogoutButton.tsx`, `src/hooks/useSessionCheck.ts`, `src/test/setup.ts`
- Create: `apps/field/vite.config.ts`, `apps/field/index.html`, `src/main.tsx`, `src/App.tsx`, `src/styles.css`, `src/api/query-keys.ts`, `src/api/queries.ts`, `src/components/AuthGate.tsx`, `src/components/ErrorBox.tsx`, `src/components/Shell.tsx`, `src/pages/LoginPage.tsx`, `src/pages/HomePage.tsx`, `src/test/render.tsx`
- Test: Create `src/App.test.tsx`, `src/copies.test.ts`, `src/api/query-keys.test.ts`
- Docs: Create `docs/decisions/0061-현장-화면은-별도-앱-apps-field.md`, `docs/decisions/0062-세-번째-화면도-복사와-사본-검사-테스트로.md`; Modify `docs/decisions/0058-화면-공통-코드는-공유-패키지가-아니라-복사로.md`, `docs/study/backlog.md`, `docs/index.md`, `docs/devlog/2026-10-28.md`

- [ ] **Step 1: 점주 앱과 같은 판으로 설치, 사본 8개 복사**

```bash
mkdir -p apps/field/src/{api,components,hooks,lib,pages,test}
sed 's#"name": "@terminal-ops/merchant"#"name": "@terminal-ops/field"#' apps/merchant/package.json > apps/field/package.json
sed 's#"name": "@terminal-ops/merchant"#"name": "@terminal-ops/field"#g' apps/merchant/package-lock.json > apps/field/package-lock.json
cp apps/merchant/tsconfig.json apps/field/tsconfig.json
diff <(tr -d '\r' < apps/merchant/package-lock.json) <(tr -d '\r' < apps/field/package-lock.json)   # 2·7행 name 두 줄만 달라야 한다
(cd apps/field && npm ci && npm ls --depth=0)
for f in api/client.ts session.ts query-client.ts lib/format.ts components/SessionCacheSync.tsx components/LogoutButton.tsx hooks/useSessionCheck.ts test/setup.ts; do
  tr -d '\r' < apps/merchant/src/$f > apps/field/src/$f
done
```

Expected: diff는 `2c2`·`7c7` 두 곳(`@terminal-ops/merchant` → `@terminal-ops/field`)만. `added 113 packages`, `found 0 vulnerabilities`, `npm ls`가 점주·어드민과 같은 17줄(react 19.3.0, vite 8.3.4, vitest 5.0.4, @tanstack/react-query 5.104.2, react-router 8.4.0, `@terminal-ops/contracts@0.0.0 -> .\..\..\packages\contracts` …).

사본의 **머리 주석만** 현장용으로 고친다(Edit 도구, 코드는 한 글자도 바꾸지 않는다 — Step 2의 사본 검사가 주석을 뺀 코드를 비교한다). 아래가 사전 검증 커밋의 결과다(점주 파일 → 현장 파일):

```diff
diff --git a/apps/merchant/src/api/client.ts b/apps/field/src/api/client.ts
index 9c24625..1c3ccc5 100644
--- a/apps/merchant/src/api/client.ts
+++ b/apps/field/src/api/client.ts
@@ -2,8 +2,8 @@ import type { ApiErrorBody, ErrorCode } from '@terminal-ops/contracts';
 import { setMe } from '../session';
 
 /**
- * api 호출 한 곳. 어드민 `apps/admin/src/api/client.ts`를 옮겨 온 것이다(공유 패키지로 빼지 않은 이유: decisions/0058) —
- * 오류 모양·401 처리 규칙이 같아야 하므로 고칠 때는 두 파일을 같이 본다. 어드민에만 있던 것(파일 내려받기 주소, version 충돌 판정)은 뺐다.
+ * api 호출 한 곳. 점주 앱 `apps/merchant/src/api/client.ts`의 사본(decisions/0062) — 주석을 뺀 코드가 같아야 한다(`src/copies.test.ts`가 본다). 고칠 때는 두 앱을 같이 고친다.
+ * 점주 앱 것은 어드민 `apps/admin/src/api/client.ts`에서 어드민에만 있던 것(파일 내려받기 주소, version 충돌 판정)을 뺀 사본이다(decisions/0058).
  */
 
 /** 개발 서버 프록시가 Nest api로 넘기는 경로 앞부분(vite.config.ts) */
```

```diff
diff --git a/apps/merchant/src/session.ts b/apps/field/src/session.ts
index ba99914..276edfe 100644
--- a/apps/merchant/src/session.ts
+++ b/apps/field/src/session.ts
@@ -2,7 +2,7 @@ import { useSyncExternalStore } from 'react';
 import type { MeView } from '@terminal-ops/contracts';
 
 /**
- * 지금 로그인한 사람(GET /auth/me 결과만, 어드민 session.ts와 같은 규칙 — decisions/0058). 세션 자체는 서버의 httpOnly 쿠키다.
+ * 지금 로그인한 사람(GET /auth/me 결과만). 점주 앱 `apps/merchant/src/session.ts`의 사본(decisions/0062) — 주석을 뺀 코드가 같아야 한다(`src/copies.test.ts`가 본다). 고칠 때는 두 앱을 같이 고친다. 세션 자체는 서버의 httpOnly 쿠키다.
  * - undefined: 아직 모름(AuthGate가 /auth/me를 부른다)
  * - null: 로그인 안 함(또는 세션이 끝남 — api()가 401을 받으면 null로 바꾼다)
  * 저장소(localStorage)에 남기지 않는다 — 새로 열면 서버에 다시 묻는다.
@@ -35,7 +35,7 @@ export function setLoggedOut(): void {
   endedByLogout = true;
 }
 
-/** 아이디가 달라지면(null 포함) 구독자에게 알리기 전에 캐시부터 비운다 — 앞사람의 매장 데이터가 다음 사람에게 보이지 않게 */
+/** 아이디가 달라지면(null 포함) 구독자에게 알리기 전에 캐시부터 비운다 — 앞사람의 작업 데이터가 다음 사람에게 보이지 않게 */
 export function setMe(me: MeView | null): void {
   if (current !== undefined && (current?.loginId ?? null) !== (me?.loginId ?? null)) onUserChange?.();
   if (me) endedByLogout = false;
```

```diff
diff --git a/apps/merchant/src/query-client.ts b/apps/field/src/query-client.ts
index ca21f77..e809c1f 100644
--- a/apps/merchant/src/query-client.ts
+++ b/apps/field/src/query-client.ts
@@ -1,14 +1,14 @@
 import { QueryClient } from '@tanstack/react-query';
 import { ApiError } from './api/client';
 
-/** 조회 재시도 판정: 4xx는 다시 해도 같아서 안 하고, 연결 실패·5xx는 한 번만(어드민과 같은 규칙) */
+/** 조회 재시도 판정: 4xx는 다시 해도 같아서 안 하고, 연결 실패·5xx는 한 번만. 점주 앱 `apps/merchant/src/query-client.ts`의 사본(decisions/0062) — 주석을 뺀 코드가 같아야 한다(`src/copies.test.ts`가 본다). 고칠 때는 두 앱을 같이 고친다 */
 export function shouldRetry(count: number, error: unknown): boolean {
   return !(error instanceof ApiError && error.status < 500) && count < 1;
 }
 
 /**
- * 서버 상태 캐시(TanStack Query). 휴대폰은 앱을 오가며 쓰므로 어드민과 달리 창으로 돌아올 때 다시 읽는다(refetchOnWindowFocus 기본값) —
- * 점주가 다른 앱에서 돌아왔을 때 배송·A/S 단계가 바뀌어 있을 수 있다. staleTime 30초라 금방 다시 와도 매번 읽지는 않는다.
+ * 서버 상태 캐시(TanStack Query). 점주 앱과 같게 창으로 돌아올 때 다시 읽는다(refetchOnWindowFocus 기본값) — 현장 작업자는 휴대폰·PDA에서
+ * 다른 앱(메신저 등)을 오가고, 그사이 다른 작업자가 발주·검수 대기를 바꿨을 수 있다. staleTime 30초라 금방 다시 와도 매번 읽지는 않는다.
  */
 export function createQueryClient(): QueryClient {
   return new QueryClient({
```

```diff
diff --git a/apps/merchant/src/lib/format.ts b/apps/field/src/lib/format.ts
index 7586d62..8b0d00d 100644
--- a/apps/merchant/src/lib/format.ts
+++ b/apps/field/src/lib/format.ts
@@ -1,4 +1,4 @@
-/** 한국 시간(KST)은 UTC+9, 일광 절약 시간 없음. api common/kst.ts·어드민 lib/format.ts와 같은 규칙(같은 테스트 값으로 맞춘다, decisions/0058) */
+/** 한국 시간(KST)은 UTC+9, 일광 절약 시간 없음. 점주 앱 `apps/merchant/src/lib/format.ts`의 사본(decisions/0062) — 주석을 뺀 코드가 같아야 한다(`src/copies.test.ts`가 본다). 고칠 때는 두 앱을 같이 고친다(테스트는 점주 앱 `lib/format.test.ts` — api common/kst.ts·어드민과 같은 값) */
 const KST_OFFSET_MS = 9 * 3_600_000;
 
 const pad = (n: number) => String(n).padStart(2, '0');
```

```diff
diff --git a/apps/merchant/src/components/SessionCacheSync.tsx b/apps/field/src/components/SessionCacheSync.tsx
index ff92371..295bca0 100644
--- a/apps/merchant/src/components/SessionCacheSync.tsx
+++ b/apps/field/src/components/SessionCacheSync.tsx
@@ -2,7 +2,7 @@ import { useLayoutEffect } from 'react';
 import { useQueryClient } from '@tanstack/react-query';
 import { registerUserChangeHandler } from '../session';
 
-/** 로그인한 사람이 바뀌면(로그인·로그아웃·401) 서버 상태 캐시를 모두 비운다 — 어드민 SessionCacheSync와 같다(앞 점주의 매장 데이터가 남지 않게) */
+/** 로그인한 사람이 바뀌면(로그인·로그아웃·401) 서버 상태 캐시를 모두 비운다(앞사람의 작업 데이터가 남지 않게). 점주 앱 `apps/merchant/src/components/SessionCacheSync.tsx`의 사본(decisions/0062) — 주석을 뺀 코드가 같아야 한다(`src/copies.test.ts`가 본다). 고칠 때는 두 앱을 같이 고친다 */
 export function SessionCacheSync() {
   const client = useQueryClient();
   useLayoutEffect(() => {
```

```diff
diff --git a/apps/merchant/src/components/LogoutButton.tsx b/apps/field/src/components/LogoutButton.tsx
index 651daf3..8beba72 100644
--- a/apps/merchant/src/components/LogoutButton.tsx
+++ b/apps/field/src/components/LogoutButton.tsx
@@ -3,7 +3,7 @@ import { api, ApiError } from '../api/client';
 import { setLoggedOut } from '../session';
 import { describeError } from './ErrorBox';
 
-/** 로그아웃: 서버 세션을 끊은 뒤 화면 쪽 로그인 정보를 비운다(캐시는 SessionCacheSync가 비운다). 어드민 UserBar와 같은 규칙 */
+/** 로그아웃: 서버 세션을 끊은 뒤 화면 쪽 로그인 정보를 비운다(캐시는 SessionCacheSync가 비운다). 점주 앱 `apps/merchant/src/components/LogoutButton.tsx`의 사본(decisions/0062) — 주석을 뺀 코드가 같아야 한다(`src/copies.test.ts`가 본다). 고칠 때는 두 앱을 같이 고친다 */
 export function LogoutButton() {
   const [busy, setBusy] = useState(false);
   const [error, setError] = useState<unknown>(null);
```

```diff
diff --git a/apps/merchant/src/hooks/useSessionCheck.ts b/apps/field/src/hooks/useSessionCheck.ts
index fcc03b2..5a5cd28 100644
--- a/apps/merchant/src/hooks/useSessionCheck.ts
+++ b/apps/field/src/hooks/useSessionCheck.ts
@@ -3,7 +3,7 @@ import type { MeView } from '@terminal-ops/contracts';
 import { api, ApiError } from '../api/client';
 import { setMe, useMe } from '../session';
 
-/** 내 정보를 아직 모르면 GET /auth/me로 서버 세션을 확인해 채운다. 401이면 로그인 안 한 것(null). 어드민과 같다 */
+/** 내 정보를 아직 모르면 GET /auth/me로 서버 세션을 확인해 채운다. 401이면 로그인 안 한 것(null). 점주 앱 `apps/merchant/src/hooks/useSessionCheck.ts`의 사본(decisions/0062) — 주석을 뺀 코드가 같아야 한다(`src/copies.test.ts`가 본다). 고칠 때는 두 앱을 같이 고친다 */
 export function useSessionCheck() {
   const me = useMe();
   const [error, setError] = useState<unknown>(null);
```

```diff
diff --git a/apps/merchant/src/test/setup.ts b/apps/field/src/test/setup.ts
index 4a1a254..f2597a7 100644
--- a/apps/merchant/src/test/setup.ts
+++ b/apps/field/src/test/setup.ts
@@ -3,7 +3,8 @@ import { cleanup } from '@testing-library/react';
 import { afterEach, vi } from 'vitest';
 import { resetSessionForTest } from '../session';
 
-// globals를 켜지 않아 Testing Library가 자동으로 정리하지 않는다. 테스트마다 화면·fetch 가짜·로그인 정보를 비운다(어드민과 같다)
+// globals를 켜지 않아 Testing Library가 자동으로 정리하지 않는다. 테스트마다 화면·fetch 가짜·로그인 정보를 비운다.
+// 점주 앱 `apps/merchant/src/test/setup.ts`의 사본(decisions/0062) — 주석을 뺀 코드가 같아야 한다(`src/copies.test.ts`가 본다). 고칠 때는 두 앱을 같이 고친다
 afterEach(() => {
   cleanup();
   vi.unstubAllGlobals();
```

(diff의 `-`가 점주 파일, `+`가 현장 파일이다.)

- [ ] **Step 2: 테스트 도구와 실패하는 테스트**

`apps/field/vite.config.ts`(테스트 설정도 여기):

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 현장 작업자 화면(보강 4, decisions/0061). 어드민·점주 앱과 같은 방식으로 개발 서버가 /api를 Nest api로 넘긴다(앞의 /api는 떼고) —
 * 같은 출처라 api에 CORS를 열지 않고 세션 쿠키(sid, SameSite=Strict)가 그대로 붙는다(api decisions/0041·0050).
 * FIELD_API_URL로 api 주소를 바꾼다(기본 http://localhost:3000). 포트는 점주 앱(5174·4174) 옆 5175·4175.
 */
const apiProxy = {
  '/api': {
    target: process.env.FIELD_API_URL ?? 'http://localhost:3000',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5175, strictPort: true, proxy: apiProxy },
  preview: { port: 4175, strictPort: true, proxy: apiProxy },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

`apps/field/src/test/render.tsx`(점주 `test/render.tsx`의 `mockApi`·`renderPage`·`renderApp`과 같은 규칙, 끝의 사람만 현장 작업자):

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
 * 가짜 api(어드민·점주 test/render.tsx의 mockApi와 같은 규칙). 키는 'GET /field/today'처럼 메서드와 경로(쿼리 제외). 경로의 `:x`는 아무 한 마디와 맞는다.
 * 없는 경로를 부르면 404 — 테스트가 빠뜨린 요청이 바로 보이게. 부른 요청은 calls에 쌓인다.
 */
export function mockApi(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const patterns = Object.entries(handlers).map(([key, handler]) => {
    const [method, path] = key.split(' ');
    return { method, regex: new RegExp(`^${path.replace(/:[^/]+/g, '[^/]+')}$`), handler };
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://field.test');
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/api/, ''),
      query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const found = patterns.find((p) => p.method === call.method && p.regex.test(call.path));
    const result = found ? ((await found.handler(call)) ?? {}) : { status: 404, body: { statusCode: 404, message: `가짜 api에 없음: ${call.method} ${call.path}` } };
    // 주의: 204·205 같은 "본문 없음" 상태에 본문(body)을 주면 Response 생성자가 던진다 — 204는 body를 비워 둔다
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

/** 현장 작업자(시연 계정과 같은 아이디) */
export const WORKER: MeView = { loginId: 'field', displayName: '현장 작업자', role: 'FIELD', merchantCode: null };

/** 로그인한 것으로 둔다(서버 세션 대신 화면의 내 정보만) */
export function loginAs(me: MeView = WORKER) {
  setMe(me);
}
```

`apps/field/src/copies.test.ts`(사본 검사, decisions/0062 — 다른 앱 파일 경로는 `node:path`로. `new URL(템플릿 문자열, import.meta.url)`로 만들면 Vite가 자산 glob으로 바꿔 `Denied ID …?url`로 파일 전체가 실패한다):

```ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 점주 앱에서 옮겨 온 사본(decisions/0062). 주석은 앱마다 다르게 쓰되 코드는 같아야 한다 — 한쪽만 고치면 여기서 실패한다.
 * 사본의 동작 테스트(api 클라이언트·KST 형식 등)는 점주 앱에 한 벌만 있다. 이 테스트가 "코드가 같다"를 지켜 그 테스트가 이 앱에도 맞게 한다.
 */
const COPIES = [
  'api/client.ts',
  'session.ts',
  'query-client.ts',
  'lib/format.ts',
  'components/SessionCacheSync.tsx',
  'components/LogoutButton.tsx',
  'hooks/useSessionCheck.ts',
  'test/setup.ts',
];

/** 주석(블록 주석, 줄 전체 주석, 코드 뒤 ` // …`)·빈 줄·줄 끝 공백과 줄바꿈 차이(CRLF)를 뺀 코드 */
export function codeOnly(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, '').replace(/\s+\/\/ .*$/, '').trimEnd())
    .filter((line) => line.trim() !== '')
    .join('\n');
}

/**
 * apps 폴더. 다른 앱 파일 경로를 `new URL(템플릿 문자열, import.meta.url)`로 만들면 Vite가 그 모양을 자산 import(`?url` glob)로 바꿔
 * 다른 앱 파일까지 불러오려다 `Denied ID …?url`로 실패한다(사전 검증) — 경로는 node:path로 만든다.
 */
const APPS = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (app: 'field' | 'merchant', path: string) => readFileSync(resolve(APPS, app, 'src', path), 'utf8');

describe('점주 앱 사본 (decisions/0062)', () => {
  it('codeOnly는 주석만 빼고 코드 차이는 남긴다', () => {
    const a = '/** 머리 */\nconst x = 1; // 뒤 주석\n// 줄 주석\n\nconst url = "http://a";\r\n';
    expect(codeOnly(a)).toBe('const x = 1;\nconst url = "http://a";');
    expect(codeOnly('const x = 2;')).not.toBe(codeOnly(a).split('\n')[0]);
  });

  it.each(COPIES)('%s는 점주 앱 것과 코드가 같다', (path) => {
    expect(codeOnly(read('field', path))).toBe(codeOnly(read('merchant', path)));
  });
});
```

`apps/field/src/api/query-keys.test.ts`(점주 앱과 같은 소스 검사. 키 목록은 Task 3·4가 늘린다):

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
  it('모든 키가 keys.all로 시작한다(쓰기 뒤 keys.all 무효화가 닿는다)', () => {
    const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) => prefix.every((p, i) => key[i] === p);
    for (const key of [keys.today]) {
      expect(startsWith(key, keys.all)).toBe(true);
    }
  });

  it('화면·컴포넌트는 키 글자를 직접 쓰지 않고 이 파일의 keys만 쓴다', () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(10); // glob이 실제로 소스를 읽었는지
    const offenders = files.filter((f) => /queryKey:\s*\[/.test(sources[f]));
    expect(offenders).toEqual([]);
  });
});
```

`apps/field/src/App.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { FieldTodayView, MeView } from '@terminal-ops/contracts';
import { api } from './api/client';
import { getMe } from './session';
import { mockApi, renderApp, WORKER } from './test/render';

const UNAUTH = { status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } };

const today = (over: Partial<FieldTodayView['scans']> = {}, inspections: FieldTodayView['inspections'] = { total: 0, passed: 0, failed: 0 }): FieldTodayView => ({
  date: '2026-10-28',
  scans: { boxes: 0, received: 0, returned: 0, rejected: 0, ...over },
  inspections,
});

describe('로그인 문과 화면 틀 (보강 4, decisions/0061)', () => {
  it('로그인 안 했으면(/auth/me 401) 로그인 화면으로 간다', async () => {
    mockApi({ 'GET /auth/me': () => UNAUTH });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: '단말온 현장' })).toBeInTheDocument();
  });

  it('로그인하면 처음 화면(오늘 내 작업)으로 가고 아래에 메뉴 셋이 보인다', async () => {
    const { calls } = mockApi({
      'GET /auth/me': () => UNAUTH,
      'POST /auth/login': () => ({ body: WORKER }),
      'GET /field/today': () => ({ body: today() }),
    });
    renderApp('/');
    await userEvent.type(await screen.findByLabelText('아이디'), ' field ');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByRole('heading', { name: '오늘 내 작업' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({ loginId: 'field', password: 'pw' });
    const nav = screen.getByRole('navigation', { name: '메뉴' });
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['홈', '박스 스캔', '검수']);
  });

  it('오늘 요약은 서버가 센 수를 그대로 보여 주고, 큰 버튼 둘로 스캔·검수에 간다', async () => {
    mockApi({
      'GET /auth/me': () => ({ body: WORKER }),
      'GET /field/today': () => ({ body: today({ boxes: 3, received: 40, returned: 2, rejected: 1 }, { total: 5, passed: 4, failed: 1 }) }),
    });
    renderApp('/');
    expect(await screen.findByText('3개')).toBeInTheDocument();
    expect(screen.getByText('40대')).toBeInTheDocument();
    expect(screen.getByText('2대')).toBeInTheDocument();
    expect(screen.getByText('5대')).toBeInTheDocument();
    expect(screen.getByText(/검수 합격 4 · 불합격 1 · 스캔 거절 1행/)).toBeInTheDocument();
    expect(screen.getByText('2026-10-28 (KST 0시부터)')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: '박스 스캔' }).map((a) => a.getAttribute('href'))).toEqual(['/scan', '/scan']);
  });

  it.each([
    ['운영자', { loginId: 'operator', displayName: '운영자', role: 'OPERATOR', merchantCode: null }],
    ['가맹점주', { loginId: 'merchant-gangnam', displayName: '점주', role: 'MERCHANT', merchantCode: 'GANGNAM-KIMBAP' }],
  ] as [string, MeView][])('%s 계정이면 안내와 로그아웃만 — 현장 API를 부르지 않는다', async (_name, me) => {
    const { calls } = mockApi({ 'GET /auth/me': () => ({ body: me }), 'POST /auth/logout': () => ({ status: 204 }) });
    renderApp('/');
    expect(await screen.findByText(/현장 작업자 계정용입니다/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith('/field'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(await screen.findByRole('heading', { name: '단말온 현장' })).toBeInTheDocument();
    expect(getMe()).toBeNull();
  });

  it('화면 요청이 401이면(세션 끝남) 로그인 화면으로', async () => {
    mockApi({ 'GET /auth/me': () => ({ body: WORKER }), 'GET /field/today': () => UNAUTH });
    renderApp('/');
    await waitFor(() => expect(screen.getByRole('heading', { name: '단말온 현장' })).toBeInTheDocument());
  });
});

/** 사용자 전환 안전장치(점주 앱 App.test와 같은 규칙) — 구현은 사본(session·SessionCacheSync)이라 처음부터 통과한다(회귀 방지) */
describe('사용자 전환 (회귀 방지)', () => {
  it('작업자 A의 오늘 요약이 세션 401 뒤 작업자 B 로그인에서 B 것으로 바뀐다', async () => {
    let who: 'A' | 'B' = 'A';
    let expired = false;
    mockApi({
      'GET /auth/me': () => ({ body: WORKER }),
      'GET /field/today': () => (expired ? UNAUTH : { body: today({ boxes: who === 'A' ? 7 : 2 }) }),
      'POST /auth/login': () => ({ body: { ...WORKER, loginId: 'field-b', displayName: '작업자 B' } }),
    });
    renderApp('/');
    expect(await screen.findByText('7개')).toBeInTheDocument();
    expired = true;
    await expect(api('/field/today')).rejects.toThrow();
    await userEvent.type(await screen.findByLabelText('아이디'), 'field-b');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'pw');
    who = 'B';
    expired = false;
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByText('2개')).toBeInTheDocument();
    expect(screen.queryByText('7개')).not.toBeInTheDocument();
    expect(screen.getByText('작업자 B')).toBeInTheDocument();
  });
});
```

```bash
cd apps/field && npx vitest run
```

Expected(사전 검증 원문): `FAIL  src/App.test.tsx` — `Error: Failed to resolve import "../App" from "src/test/render.tsx". Does the file exist?`, `FAIL  src/api/query-keys.test.ts` — `Error: Failed to resolve import "./query-keys" from "src/api/query-keys.test.ts". Does the file exist?`, `Test Files  2 failed | 1 passed (3)`, `Tests  9 passed (9)`(사본 검사는 Step 1의 사본으로 이미 통과한다 — 코드가 같은지 보는 테스트라서. 머리 주석 대신 코드를 건드렸다면 여기서 실패한다).

- [ ] **Step 3: 구현**

`apps/field/index.html`:

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#1a7f37" />
    <title>단말온 현장</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`apps/field/src/main.tsx`(점주와 같다):

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

`apps/field/src/App.tsx`:

```tsx
import { Route, Routes } from 'react-router';
import { AuthGate } from './components/AuthGate';
import { SessionCacheSync } from './components/SessionCacheSync';
import { Shell } from './components/Shell';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';

/** 화면 경로. /login 말고는 모두 현장 작업자 계정으로 로그인해야 보인다(AuthGate) */
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
          <Route index element={<HomePage />} />
          <Route path="*" element={<p>없는 화면입니다.</p>} />
        </Route>
      </Routes>
    </>
  );
}
```

`apps/field/src/api/query-keys.ts`:

```ts
/**
 * 쿼리 키. 모두 'field'로 시작한다 — 현장 화면의 쓰기(박스 스캔·검수)는 오늘 요약·검수 대기·단말기·발주를 함께 바꾸므로
 * 쓰기 뒤에는 `keys.all`을 통째로 무효화한다(점주 앱과 같은 방식 — 화면이 몇 개 안 되고 다시 읽는 양이 작다).
 */
export const keys = {
  all: ['field'] as const,
  today: ['field', 'today'] as const,
};
```

`apps/field/src/api/queries.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import type { FieldTodayView } from '@terminal-ops/contracts';
import { api } from './client';
import { keys } from './query-keys';

/** 오늘(KST) 내가 한 일(GET /field/today, decisions/0063) */
export function useToday() {
  return useQuery({ queryKey: keys.today, queryFn: () => api<FieldTodayView>('/field/today') });
}
```

`apps/field/src/components/AuthGate.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useSessionCheck } from '../hooks/useSessionCheck';
import { wasLoggedOutOnPurpose } from '../session';
import { ErrorBox } from './ErrorBox';
import { LogoutButton } from './LogoutButton';

/**
 * 로그인해야 보이는 화면들의 문. 처음에는 GET /auth/me로 서버 세션을 확인하고, 로그인 안 했으면 로그인 화면으로(돌아올 주소와 함께).
 * 현장 작업자 계정(FIELD)만 쓴다 — 다른 계정이면 안내와 로그아웃만(decisions/0061). 운영자는 같은 스캔·검수를 어드민에서 한다.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { me, error } = useSessionCheck();
  const location = useLocation();

  if (me === undefined) return error ? <ErrorBox error={error} /> : <p className="page">로그인 확인 중…</p>;
  if (me === null) {
    const state = wasLoggedOutOnPurpose() ? undefined : { from: `${location.pathname}${location.search}` };
    return <Navigate to="/login" replace state={state} />;
  }
  if (me.role !== 'FIELD') {
    return (
      <div className="page narrow">
        <p>이 화면은 현장 작업자 계정용입니다. 운영자·관제는 운영 어드민을, 가맹점주는 매장 화면을 쓰세요.</p>
        <LogoutButton />
      </div>
    );
  }
  return <>{children}</>;
}
```

`apps/field/src/components/ErrorBox.tsx`(사본이 아니라 현장 문구로 새로 씀 — `describeError`는 `LogoutButton` 사본이 부르므로 이름·모양을 점주 것과 같게):

```tsx
import type { ErrorCode } from '@terminal-ops/contracts';
import { ApiError } from '../api/client';

/**
 * 현장 작업자에게 보이는 안내. 점주 앱 ErrorBox와 모양은 같고 문구가 현장 일(박스·검수)에 맞춘 것이다(사본이 아니라 새로 씀 — decisions/0062).
 * 서버 메시지는 작은 글씨로 아래에 둔다(사무실에 물을 때 그대로 읽어 줄 수 있게).
 */
const HINT: Partial<Record<ErrorCode, string>> = {
  SCAN_IN_PROGRESS: '서버가 이 박스를 아직 처리하고 있습니다. 잠시 뒤 같은 박스를 다시 보내세요.',
  SCAN_ID_REUSED: '이 박스 번호로 다른 내용이 이미 처리됐습니다. 새 박스로 다시 시작하세요.',
  PO_CLOSED: '마감된 발주입니다. 다른 발주를 고르세요.',
  PO_NOT_ALLOWED: '회수 입고에는 발주를 고르지 않습니다.',
  VERSION_CONFLICT: '다른 작업과 겹쳤습니다. 처리된 것은 없습니다 — 다시 시도하세요.',
  INVALID_TRANSITION: '지금 상태에서는 할 수 없습니다. 이미 처리됐는지 확인하세요.',
  DEADLOCK: '잠시 뒤 다시 시도하세요.',
  FORBIDDEN: '현장 작업자 계정으로 로그인해야 쓸 수 있습니다.',
  UNAUTHENTICATED: '로그인이 끝났습니다. 다시 로그인하세요.',
  LOGIN_FAILED: '아이디 또는 비밀번호가 맞지 않습니다.',
  LOGIN_LOCKED: '로그인 실패가 많아 잠시 막혔습니다. 잠시 뒤 다시 시도하세요.',
};

export function describeError(error: unknown): { title: string; detail: string; code: ErrorCode | null } {
  if (error instanceof ApiError) {
    const hint = (error.code && HINT[error.code]) ?? (error.status === 400 ? '입력한 내용을 확인하세요.' : error.status === 404 ? '찾는 단말기·자료가 없습니다.' : null);
    return { title: hint ?? `요청이 실패했습니다(HTTP ${error.status}). 잠시 뒤 다시 시도하세요.`, detail: error.message, code: error.code };
  }
  return { title: '서버에 연결하지 못했습니다. 연결을 확인하고 다시 시도하세요.', detail: error instanceof Error ? error.message : String(error), code: null };
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

`apps/field/src/components/Shell.tsx`:

```tsx
import { NavLink, Outlet } from 'react-router';
import { useMe } from '../session';
import { LogoutButton } from './LogoutButton';

/**
 * 휴대폰·PDA 화면 틀: 위에 내 이름과 로그아웃, 가운데 화면, 아래에 탭 셋(홈·박스 스캔·검수 — 엄지가 닿는 곳).
 * 넓은 화면에서도 가운데 한 줄(최대 560px).
 */
export function Shell() {
  const me = useMe();
  return (
    <div className="shell">
      <header className="top">
        <div>
          <strong className="app-name">단말온 현장</strong>
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
        <NavLink to="/scan">박스 스캔</NavLink>
        <NavLink to="/inspections">검수</NavLink>
      </nav>
    </div>
  );
}
```

`apps/field/src/pages/LoginPage.tsx`(점주 LoginPage에서 제목·설명·주석만 다르다):

```tsx
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import type { LoginRequest, MeView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { ErrorBox } from '../components/ErrorBox';
import { useSessionCheck } from '../hooks/useSessionCheck';
import { setMe } from '../session';

/** 현장 작업자 로그인(api decisions/0050, 같은 POST /auth/login). 성공하면 서버가 httpOnly 세션 쿠키를 주고, 화면은 응답(내 정보)만 기억한다 */
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
      <h1>단말온 현장</h1>
      <p className="muted">박스 입고·회수 입고 스캔과 검수를 합니다.</p>
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

`apps/field/src/pages/HomePage.tsx`:

```tsx
import { Link } from 'react-router';
import { useToday } from '../api/queries';
import { ErrorBox } from '../components/ErrorBox';

/**
 * 처음 화면: 오늘(KST) 내가 한 일과 큰 버튼 둘(박스 스캔·검수). 숫자는 서버가 센다(GET /field/today, decisions/0063) —
 * 화면이 세면 새로 고치거나 다른 기기에서 한 일이 빠진다.
 */
export function HomePage() {
  const today = useToday();
  const t = today.data;
  return (
    <section>
      <h1>오늘 내 작업</h1>
      <ErrorBox error={today.error} />
      {t ? (
        <>
          <p className="muted">{t.date} (KST 0시부터)</p>
          <dl className="stats">
            <div>
              <dt>처리한 박스</dt>
              <dd>{t.scans.boxes}개</dd>
            </div>
            <div>
              <dt>입고</dt>
              <dd>{t.scans.received}대</dd>
            </div>
            <div>
              <dt>회수 입고</dt>
              <dd>{t.scans.returned}대</dd>
            </div>
            <div>
              <dt>검수</dt>
              <dd>{t.inspections.total}대</dd>
            </div>
          </dl>
          <p className="muted">
            검수 합격 {t.inspections.passed} · 불합격 {t.inspections.failed}
            {t.scans.rejected > 0 ? ` · 스캔 거절 ${t.scans.rejected}행` : ''}
          </p>
        </>
      ) : today.isPending ? (
        <p className="muted">불러오는 중…</p>
      ) : null}
      <div className="big-actions">
        <Link className="big-button" to="/scan">
          박스 스캔
        </Link>
        <Link className="big-button" to="/inspections">
          검수
        </Link>
      </div>
    </section>
  );
}
```

`apps/field/src/styles.css`(Task 3·4가 끝에 덧붙인다):

```css
/*
 * 현장 화면 전역 CSS 한 장(어드민·점주 앱과 같은 방식, decisions/0041·0061). 휴대폰·PDA 폭(360~430px)이 기준이고, 넓은 화면에서는 가운데 한 줄(최대 560px).
 * 장갑 낀 손·한 손 조작: 누르는 것은 높이 48px 이상, 자주 누르는 큰 버튼은 64px. 글자는 16px(입력칸이 16px보다 작으면 iOS가 확대한다).
 */
:root {
  --fg: #1f2328;
  --muted: #656d76;
  --line: #d0d7de;
  --bg: #f6f8fa;
  --card: #ffffff;
  --accent: #1a7f37;
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
  padding-bottom: 72px; /* 아래 탭 높이 */
}

.top {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  flex-wrap: wrap; /* 로그아웃 오류(.logout-error)가 한 줄을 통째로 쓰게 */
  justify-content: space-between;
  gap: 8px;
  padding: 8px 16px;
  background: var(--card);
  border-bottom: 1px solid var(--line);
}

.top .app-name {
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
  min-height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  text-decoration: none;
  font-weight: 700;
}

.tabs a.active {
  color: var(--accent);
  box-shadow: inset 0 4px 0 var(--accent);
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

/* 오늘 요약: 두 칸씩, 숫자를 크게 */
dl.stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin: 8px 0;
}

dl.stats div {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 12px;
}

dl.stats dt {
  color: var(--muted);
  font-size: 14px;
}

dl.stats dd {
  margin: 0;
  font-size: 28px;
  font-weight: 700;
}

.big-actions {
  display: grid;
  gap: 12px;
  margin-top: 24px;
}

.big-button {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 64px;
  border-radius: 12px;
  background: var(--accent);
  color: #fff;
  font-size: 20px;
  font-weight: 700;
  text-decoration: none;
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
  min-height: 48px;
  margin-top: 4px;
  padding: 10px 12px;
  font: inherit;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--card);
}

button {
  min-height: 48px;
  padding: 8px 16px;
  font: inherit;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--card);
  cursor: pointer;
}

button.primary {
  width: 100%;
  min-height: 56px;
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
  font-weight: 700;
}

button.link {
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

.logout-error {
  flex-basis: 100%;
  margin: 0;
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

fieldset {
  min-width: 0;
  margin: 0 0 12px;
}

legend {
  font-weight: 600;
}
```

- [ ] **Step 4: 통과 확인과 빌드**

```bash
cd apps/field && npx vitest run && npm run build && rm -rf dist
```

Expected: `Test Files  3 passed (3)`, `Tests  18 passed (18)`(App 7, 사본 9, 쿼리 키 2). build: tsc 0, `✓ built`, `dist/index.html`·css·js 세 파일.

사본 검사가 실제로 잡는지 한 번 본다(되돌림 필수):

```bash
sed -i 's#const LOGIN_PATH = ./auth/login.;#const LOGIN_PATH = "/auth/login2";#' apps/merchant/src/api/client.ts
(cd apps/field && npx vitest run src/copies.test.ts 2>&1 | grep -E "×|Tests ")
git checkout apps/merchant/src/api/client.ts
git status --short apps/merchant   # 출력 없음
```

Expected: `× api/client.ts는 점주 앱 것과 코드가 같다`, `Tests  1 failed | 8 passed (9)`. 되돌린 뒤 점주 앱은 그대로.

- [ ] **Step 5: 기록**

`docs/decisions/0061-현장-화면은-별도-앱-apps-field.md`:

````markdown
# 0061. 현장 작업자 화면은 어드민 FIELD 화면을 고치지 않고 별도 앱 apps/field로 만든다

- 날짜 / 관련 기능: 2026-10-28 / 보강 4(현장 작업자 화면), F6(박스 스캔), F13(검수)
- 상황: 현장 작업자(FIELD)는 지금 운영자 어드민 안에서 박스 스캔(`/scan`)과 단말기 상세의 검수 폼을 쓴다(보강 2, 메뉴 "단말기, 박스 스캔"). 창고에서는 한 손에 단말기나 박스, 다른 손에 휴대폰·PDA를 들고 바코드 스캐너로 시리얼을 찍는다. 어드민은 넓은 표·사이드 메뉴·작은 버튼(36px 안팎)·여러 줄 글 상자(`textarea`) 입력이라 한 손으로 쓰기 어렵고, 검수 폼은 단말기 목록에서 상세로 들어가야 나온다. 보강 3은 점주 화면을 별도 앱으로 만들었다(decisions/0057).
- 선택지:
  1. 어드민의 FIELD 화면을 고친다(FIELD일 때만 큰 버튼·휴대폰 레이아웃, 검수 대기 화면 추가) — 장점: 앱이 늘지 않는다. 단점: 0057이 버린 이유가 그대로다 — 어드민 CSS 한 장(decisions/0041)에 휴대폰 레이아웃이 역할별로 섞이고, `AuthGate`·메뉴 표·`WriteButton`이 역할마다 갈라진다. 어드민 ScanPage는 운영자도 쓰므로(OPERATOR·FIELD) 화면 하나를 두 사용 자세에 맞춰야 한다. 운영자 화면을 고칠 때 현장 화면 테스트가 함께 깨질 수 있다
  2. **별도 앱 `apps/field`(점주 앱과 같은 판·같은 방식)** — 장점: 휴대폰 우선으로 처음부터 짠다(아래 탭 셋, 입력칸 하나 + Enter, 48~64px 버튼). Vite 개발 서버 프록시로 같은 출처라 세션 쿠키가 그대로 붙고 CORS를 열지 않는다(0041·0057과 같은 이유). 시연에서 "본사·점주·현장" 화면이 따로 보인다. 단점: 앱이 여섯(`npm ci` 여섯 번), 공통 코드가 세 벌째(decisions/0062)
  3. PWA·네이티브(스캐너 SDK) — 오프라인·장치 연동이 필요할 때의 길. 지금은 시연·학습 범위를 넘는다
- 결정: 2.
  - 포트: 개발 서버 5175, 미리보기 4175(점주 5174·4174 옆, `strictPort`). api 주소는 `FIELD_API_URL`(기본 `http://localhost:3000`)
  - 의존성 판: 점주 앱 `package.json`·`package-lock.json`을 복사해 `name`만 `@terminal-ops/field`로(lock은 2·7행 두 줄) `npm ci` — 사전 검증에서 `added 113 packages`, `npm ls --depth=0`이 점주·어드민과 같은 17줄. 새 판을 고르지 않으니 출시일 2주 규칙(0041)도 그대로
  - 로그인은 같은 `POST /auth/login`. 이 앱은 FIELD만 쓴다 — 운영자·관제·ADMIN·가맹점주면 안내와 로그아웃만(운영자는 같은 스캔·검수를 어드민에서 한다). 서버의 새 API(`GET /field/today`)도 FIELD만(decisions/0063)
  - 화면: 홈(오늘 내 작업 + 큰 버튼 둘), 박스 스캔, 검수 대기·검수. 아래 탭 셋(홈·박스 스캔·검수, 64px), 위에 내 이름·로그아웃. 휴대폰 폭이 기준이고 넓은 화면에서는 가운데 한 줄(최대 560px). 색은 점주 앱(파랑)과 구분되게 초록
  - 창으로 돌아올 때 다시 읽는다(점주 앱과 같은 사본 `query-client.ts`, staleTime 30초) — 현장 작업자는 다른 앱을 오가고, 그사이 다른 작업자가 발주·검수 대기를 바꿨을 수 있다
  - 어드민의 FIELD 화면(박스 스캔·검수 폼)은 그대로 둔다 — 현장 작업자가 사무실 PC에서 쓸 수도 있고, 지우면 어드민 테스트가 바뀐다
- 결과·대가: 앱 여섯. README 설치 줄·테스트 표·launch.json에 한 줄씩. localhost에서는 어드민(:5173)·점주(:5174)·현장(:5175)이 `sid` 쿠키 하나를 함께 쓴다(쿠키는 포트를 구분하지 않는다) — 한쪽에서 로그인하면 다른 쪽 세션이 끝난다(0057과 같은 대가, 시연은 브라우저 프로필을 나눈다). 운영 배포(정적 파일 + 역프록시)는 범위 밖.
- 다시 볼 조건: 창고에 네트워크가 끊기는 구역이 있어 오프라인 스캔이 필요해지면(PWA + 보낼 박스 대기열 — scanId가 있어 나중에 보내도 멱등이다), 스캐너 장치 SDK·카메라 스캔이 필요해지면(decisions/0064).
````

`docs/decisions/0062-세-번째-화면도-복사와-사본-검사-테스트로.md`:

````markdown
# 0062. 세 번째 화면 앱에서도 공통 코드는 복사하고, 사본 검사 테스트로 어긋남을 막는다

- 날짜 / 관련 기능: 2026-10-28 / 보강 4, 어드민·점주·현장 화면
- 상황: 현장 앱(decisions/0061)에도 api 클라이언트·세션 저장소·사람이 바뀌면 캐시 비우기·세션 확인 훅·조회 재시도 판정·KST 형식·로그아웃 버튼이 필요하다. decisions/0058은 점주 앱 때 이것을 복사로 정하면서 "화면 앱이 셋이 되면 다시 본다"고 적었다 — 지금이 그때다. 0058의 사전 검증은 공유 패키지를 **어드민 한 앱**에만 붙여 봤다. 이번에는 같은 코드를 쓰는 **두 앱(점주·현장)**에 실제로 붙여 비용을 쟀다.
- 사전 검증(임시 복제본의 버리는 브랜치, 현장 앱 골격 커밋 위):
  - `packages/web-common`(`exports` = TS 소스 `./src/index.ts`, 의존성 없음)에 점주 앱 사본 여섯 개(`session.ts`, `api/client.ts`, `query-client.ts`, `lib/format.ts`, `SessionCacheSync.tsx`, `useSessionCheck.ts` — 주석 포함 238줄)를 옮겼다. `LogoutButton.tsx`는 옮기지 못했다 — 앱마다 다른 `ErrorBox`의 `describeError`를 부른다(옮기려면 인자로 받게 고쳐야 한다)
  - 두 앱에서 `npm install --save-exact @terminal-ops/web-common@file:../../packages/web-common` → 앱마다 `added 1 package`, `package.json` +1줄, lock +9줄(점주·현장 lock이 "어드민 lock + 이름 두 줄"이던 성질이 깨진다)
  - 두 앱이 그 여섯 모듈을 import하는 곳이 29곳이라, import를 고치는 대신 앱의 원래 파일을 한 줄 다시 내보내기(`export * from '@terminal-ops/web-common';`)로 바꿨다(앱마다 6파일)
  - 설정 없이: 점주 앱 `tsc` — `TS2307: Cannot find module 'react'`·`'@tanstack/react-query'`·`'@terminal-ops/contracts'`(공유 패키지 폴더 위로 `node_modules`가 없다 — 0058 (b)(c)와 같다), vitest `Failed to resolve import "react" from "../../packages/web-common/src/session.ts"`(7파일 모두 실패), build `Rolldown failed to resolve import "react"`
  - 앱마다 `vite.config.ts`에 `resolve: { dedupe: ['react', 'react-dom', '@tanstack/react-query'] }` 한 줄 + `tsconfig.json`에 `paths` 넷(`react`, `react/*`, `@tanstack/react-query`, `@terminal-ops/contracts` → 앱의 `node_modules`) → 점주 tsc 0·`Tests 47 passed`·build 성공, 현장 tsc 0·`Tests 18 passed`(골격 시점)·build 성공. `@tanstack/react-query`를 dedupe에 넣지 않으면 공유 코드의 `useQueryClient`가 앱의 `QueryClientProvider`와 다른 사본을 볼 수 있다
  - `paths`만 두고 `dedupe`를 빼면 tsc는 0인데 vitest·build가 위와 같은 `Failed to resolve import "react"`로 실패한다 — 빠뜨리면 조용히 React가 두 벌 되는 것이 아니라 시끄럽게 깨진다(저장소 루트 `node_modules`가 비어 있어서. 루트에 설치가 생기면 달라진다)
  - 어드민 사본은 모양이 다르다(version 충돌 판정·파일 내려받기 주소·역할 묶음, decisions/0058) — 공유 패키지로 가도 어드민 쪽은 남는다. 즉 "세 벌 → 한 벌"이 아니라 "세 벌 → 어드민 + 공유 한 벌"
- 선택지:
  1. 공유 패키지(`file:` + TS 소스, 위 설정) — 장점: 점주·현장 코드가 한 곳(238줄). 단점: 앱마다 `dedupe` 1줄·`paths` 4줄·의존 1줄·lock 9줄·다시 내보내기 6파일, 공유 코드가 새 바깥 모듈(예: `react-router`)을 import할 때마다 두 앱의 `paths`·`dedupe`를 같이 고쳐야 한다(잊으면 tsc는 통과하고 vitest·build에서 깨진다). 공유 코드의 테스트는 패키지에 실행기가 없어 어차피 한 앱에 둔다. 점주 앱(테스트 47개)을 이번 보강에서 고쳐야 한다
  2. 루트 npm workspaces / 빌드 산출물 패키지 — 0058이 적은 대로(lock 판 올림 43/707, 빌드 단계) 이번 범위를 넘는다. 이번에는 해 보지 않았다
  3. **복사 + 사본 검사 테스트** — 현장 앱은 점주 앱 사본 8개(위 7개 + `test/setup.ts`)를 그대로 가져오고, `src/copies.test.ts`가 두 앱의 같은 경로 파일을 읽어 주석(블록 주석·줄 주석·코드 뒤 ` // …`)·빈 줄·줄 끝 공백·CRLF를 뺀 코드가 같은지 본다. 장점: 설정·lock 변화 없음, 점주 앱을 건드리지 않음, 한쪽만 고치면 테스트가 실패한다(사전 검증: 점주 `api/client.ts`의 한 줄을 바꾸자 `× api/client.ts는 점주 앱 것과 코드가 같다`). 사본의 동작 테스트(api 클라이언트·KST 형식)는 점주 앱에 한 벌만 두고, 이 테스트가 "코드가 같다"를 지켜 그 테스트가 현장 앱에도 맞게 한다. 단점: 고칠 때 두 파일을 고친다(테스트가 알려 준다), 사본 줄 수만큼 저장소가 커진다(현장 쪽 8파일 285줄)
- 결정: 3. 1의 비용(앱마다 설정 다섯 줄과 lock 변화, 바깥 import가 늘 때마다 두 앱 설정 고치기, 점주 앱 변경)이 얻는 것(238줄 한 곳)보다 크고, 3의 사본 검사가 "모르는 사이에 어긋남"이라는 복사의 가장 큰 위험을 막는다. 0058의 "같은 버그를 두 사본에서 고치는 일이 두 번 생기면" 조건은 아직 없다.
  - 사본 머리 주석: "점주 앱 `apps/merchant/src/…`의 사본(decisions/0062) — 주석을 뺀 코드가 같아야 한다(`src/copies.test.ts`가 본다). 고칠 때는 두 앱을 같이 고친다". 주석은 앱 말에 맞게 고쳐도 된다(검사에서 빠진다)
  - 검사는 현장 앱에만 둔다 — 점주 앱만 고치고 점주 테스트만 돌리면 그 자리에서는 모른다. 전체 검증(README의 앱별 `npm test`)에서 잡힌다(대가)
  - 오류 안내(`ErrorBox`)·화면 틀·로그인 문은 복사하지 않고 현장 문구로 새로 쓴다(0058·0060과 같은 방향)
  - 사전 검증에서 찾은 것: 테스트에서 다른 앱 파일 경로를 `new URL(템플릿 문자열, import.meta.url)`로 만들면 Vite가 그 모양을 자산 import(`?url` glob)로 바꿔 다른 앱 파일까지 불러오려다 `Error: Denied ID …/apps/admin/src/App.tsx?url`로 파일 전체가 실패한다 → `node:path`의 `resolve(dirname(fileURLToPath(import.meta.url)), '../..')`로 만든다(공부거리 한 줄)
- 결과·대가: 같은 규칙의 코드가 어드민·점주·현장 세 곳(점주·현장은 테스트로 묶임, 어드민은 0058처럼 머리 주석과 같은 테스트 값으로만). 점주 사본을 고치면 현장 사본도 고쳐야 현장 테스트가 통과한다.
- 다시 볼 조건: 화면 앱이 넷이 되거나, 공유 코드가 바깥 모듈을 더 많이 쓰게 되거나(사본이 커지면 검사로도 고치는 수고가 커진다), 같은 버그를 두 사본에서 고치는 일이 두 번 생기면 — 그때는 1(위 설정이 이미 확인됐다) 또는 workspaces(lock 판 올림은 따로 한 커밋). 어드민 사본까지 묶으려면 어드민 쪽 차이(버전 충돌 판정 등)를 인자로 빼는 리팩터가 먼저다.
````

`docs/decisions/0058-화면-공통-코드는-공유-패키지가-아니라-복사로.md` 끝에 한 줄:

```markdown
- 보강 4 보탬(decisions/0062): 화면 앱이 셋(현장 앱 `apps/field`)이 되어 "다시 볼 조건"에 닿았다. 공유 패키지를 점주·현장 두 앱에 실제로 붙여 비용(앱마다 `resolve.dedupe`·`paths` 넷·lock 9줄·다시 내보내기 6파일, 어드민 사본은 그대로 남음)을 재고, 복사 유지 + 사본 검사 테스트(`apps/field/src/copies.test.ts`, 주석을 뺀 코드가 점주 사본과 같은지)로 정했다. 현장 사본은 어드민이 아니라 점주 앱 것을 옮긴다(어드민 전용 부분이 이미 빠진 사본).
```

`docs/study/backlog.md` 끝에 한 줄:

```markdown
- [ ] Vite가 `new URL(템플릿 문자열, import.meta.url)`을 자산 import(`?url` glob)로 바꾸는 규칙과 `server.fs.allow` — 테스트에서 다른 앱 파일을 읽으려다 `Denied ID …?url` (apps/field/src/copies.test.ts, decisions/0062)
```

devlog 항목:

```markdown
## HH:MM Task 2 현장 앱 골격 — 설치·Vite 5175 프록시·점주 사본과 사본 검사·로그인 문·화면 틀·오늘 내 작업 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <Task 1 커밋 해시> (feat(field, F6, F13): 현장 화면용 오늘 내 작업 API)
- 한 일: `apps/field`(점주 lock 복사 — name 두 줄만 다름, added 113), Vite 5175·4175 `/api` 프록시(`FIELD_API_URL`), 점주 사본 8개(머리 주석만 현장용) + `copies.test.ts`, AuthGate(FIELD만), Shell(아래 탭 홈·박스 스캔·검수), ErrorBox(현장 문구), 로그인, 홈(오늘 내 작업 — `GET /field/today`)
- 확인: 처음 실패(`Failed to resolve import "../App"`·`"./query-keys"`) → `Test Files  3 passed`, `Tests  18 passed`, build 성공. 사본 검사: 점주 client.ts 한 줄을 바꾸자 `× api/client.ts는 점주 앱 것과 코드가 같다`(되돌림)
- 결정: decisions/0061(별도 앱, FIELD만), 0062(세 벌째도 복사 + 사본 검사 — 공유 패키지 사전 검증 근거), 0058 보탬
- 다음: Task 3 박스 스캔
```

```bash
node scripts/docs-index.mjs
```

- [ ] **Step 6: 커밋**

```bash
git add apps/field docs
git status --short   # apps/field/node_modules·dist가 없어야 한다(.gitignore)
git commit -m "$(cat <<'EOF'
feat(field): 현장 앱 골격 — 로그인 문·화면 틀·오늘 내 작업, 점주 사본과 사본 검사

Refs: docs/decisions/0061-현장-화면은-별도-앱-apps-field.md, docs/decisions/0062-세-번째-화면도-복사와-사본-검사-테스트로.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 제목 시각 = 커밋 시각인지 보고, 다르면 고쳐 amend.

---


### Task 3: 박스 스캔 — 스캐너(키보드 웨지) 입력, 중복·형식 표시, scanId 멱등, 줄마다 결과

**Files:**
- Create: `apps/field/src/lib/scan.ts`, `apps/field/src/pages/ScanPage.tsx`
- Modify: `apps/field/src/App.tsx`, `src/api/query-keys.ts`, `src/api/queries.ts`, `src/styles.css`
- Test: Create `src/lib/scan.test.ts`, `src/pages/ScanPage.test.tsx`; Modify `src/api/query-keys.test.ts`
- Docs: Create `docs/decisions/0064-현장-입력은-키보드-웨지-카메라는-생략.md`; Modify `docs/study/backlog.md`, `docs/index.md`, `docs/devlog/2026-10-28.md`

어드민 `apps/admin/src/pages/ScanPage.tsx`와 그 테스트(`ScanPage.test.tsx`)를 먼저 읽는다 — 멱등 규칙(scanId 유지·다시 보내기 판정·보낸 박스 잠금·결과 못 받은 박스 확인·ref 비교)이 같다(decisions/0020과 그 리뷰 반영, 어드민 decisions/0041 Task 6·Task 6 리뷰).

- [ ] **Step 1: 실패하는 테스트**

`apps/field/src/lib/scan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { lineProblem, newScanId, retryable, splitSerials } from './scan';

describe('박스 스캔 규칙 (decisions/0064, 어드민 ScanPage와 같은 멱등 규칙)', () => {
  it('스캐너 한 줄·붙여 넣은 글을 시리얼로(줄·쉼표·공백, 빈 것 제외, 순서 유지)', () => {
    expect(splitSerials(' A-0001 ')).toEqual(['A-0001']);
    expect(splitSerials('A-0001\n\n A-0002 ,A-0003\r\nA-0001')).toEqual(['A-0001', 'A-0002', 'A-0003', 'A-0001']);
    expect(splitSerials('   ')).toEqual([]);
  });

  it('줄마다 문제: 앞에 같은 것이 있으면 중복(처음 것은 괜찮다), 대문자·숫자·하이픈 4~32자가 아니면 형식', () => {
    const list = ['AB-0001', 'ab-0002', 'AB-0001', 'X1', 'Y'.repeat(33), 'OK-1'];
    expect(list.map((_, i) => lineProblem(list, i))).toEqual([null, 'FORMAT', 'DUPLICATE', 'FORMAT', 'FORMAT', null]);
  });

  it('다시 보내기(같은 scanId) 판정: 연결 실패·5xx·처리 중·박스 되돌림은 다시, 입력 오류는 고쳐서 새 scanId', () => {
    expect(retryable(new TypeError('Failed to fetch'))).toBe(true);
    expect(retryable(new ApiError(503, null, 'x', null))).toBe(true);
    expect(retryable(new ApiError(409, 'SCAN_IN_PROGRESS', 'x', null))).toBe(true);
    expect(retryable(new ApiError(409, 'VERSION_CONFLICT', 'x', null))).toBe(true);
    expect(retryable(new ApiError(400, null, 'x', null))).toBe(false);
    expect(retryable(new ApiError(422, 'SCAN_ID_REUSED', 'x', null))).toBe(false);
    expect(retryable(new ApiError(422, 'PO_CLOSED', 'x', null))).toBe(false);
  });

  it('scanId는 서버 규칙(영문·숫자·_·- 8~64자)에 맞고 매번 다르다', () => {
    const a = newScanId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(newScanId()).not.toBe(a);
  });
});
```

`apps/field/src/pages/ScanPage.test.tsx`(스캐너 흉내 = 초점이 있는 칸에 `userEvent.keyboard('SN-0001{Enter}')` — 클릭 없이. 여러 개 붙여 넣기는 `userEvent.paste`):

```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CreateScanRequest, ScanView } from '@terminal-ops/contracts';
import { keys } from '../api/query-keys';
import { loginAs, mockApi, renderPage, type Call } from '../test/render';
import { ScanPage } from './ScanPage';

const orderRows = [
  { id: 3, poNo: 'SE0003', modelCode: 'SN-100', quantity: 50, status: 'RECEIVING' },
  { id: 4, poNo: 'SE0004', modelCode: 'SN-200', quantity: 10, status: 'ORDERED' },
];
/** ?status=가 있으면 그 상태만(서버 GET /purchase-orders와 같게) */
const orders = {
  'GET /purchase-orders': (c: Call) => ({ body: { items: orderRows.filter((p) => p.status === c.query.get('status')), nextBeforeId: null } }),
};
const bodyOf = (c: Call) => c.body as CreateScanRequest;
const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');
/** 서버처럼: 첫 줄은 CREATED(회수면 RETURNED), 나머지는 명세 밖. 화면은 summary 대신 행 결과로 센다 */
const result = (body: CreateScanRequest, replayed: boolean): ScanView => {
  const ok = body.kind === 'RECEIVE' ? 'CREATED' : 'RETURNED';
  const results = body.serials.map((serialNo, i) =>
    i === 0 ? { serialNo, result: ok } : { serialNo, result: 'NOT_IN_DELIVERY_NOTE' as const, message: '납품 명세에 없는 시리얼입니다.' },
  );
  return { scanId: body.scanId, kind: body.kind, poNo: body.poNo ?? null, actor: 'field', replayed, createdAt: '2026-10-28T01:00:00.000Z', summary: {}, results } as ScanView;
};
const rows = () => within(screen.getByRole('list', { name: '박스 목록' })).queryAllByRole('listitem');

/** 바코드 스캐너(키보드 웨지): 초점이 있는 칸에 글자를 치고 Enter. 클릭 없이 keyboard만 쓴다 — 처음부터 입력칸에 초점이 있어야 한다 */
const scanBarcode = (serial: string) => userEvent.keyboard(`${serial}{Enter}`);

describe('박스 스캔 — 스캐너 입력 (보강 4, decisions/0064)', () => {
  it('스캐너가 찍을 때마다(글자 + Enter) 목록에 쌓이고 입력칸이 비며 초점이 그대로다. 중복·형식 오류는 그 줄에 표시', async () => {
    mockApi(orders);
    loginAs();
    renderPage(<ScanPage />);
    const field = screen.getByLabelText(/시리얼/);
    expect(field).toHaveFocus();
    await scanBarcode('SN-0001');
    await scanBarcode('SN-0002');
    await scanBarcode('SN-0001');
    await scanBarcode('bad');
    expect(rows().map((r) => r.textContent)).toEqual(['SN-0001빼기', 'SN-0002빼기', 'SN-0001중복빼기', 'bad형식 오류빼기']);
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
    expect(screen.getByText('4개')).toBeInTheDocument();
    expect(screen.getByText(/중복 1/)).toBeInTheDocument();
    expect(screen.getByText(/형식 오류 1/)).toBeInTheDocument();
  });

  it('손으로 쳐서 추가 버튼, 여러 개를 한 번에 붙여 넣기, 빈 Enter는 무시, 잘못 찍은 줄은 빼기', async () => {
    mockApi(orders);
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.type(screen.getByLabelText(/시리얼/), 'SN-0009');
    await userEvent.click(screen.getByRole('button', { name: '추가' }));
    await userEvent.click(screen.getByLabelText(/시리얼/));
    await userEvent.paste('SN-0010 SN-0011\nSN-0012');
    await userEvent.keyboard('{Enter}{Enter}');
    expect(rows().map((r) => r.querySelector('.serial')?.textContent)).toEqual(['SN-0009', 'SN-0010', 'SN-0011', 'SN-0012']);
    await userEvent.click(screen.getByRole('button', { name: 'SN-0010 빼기' }));
    expect(rows().map((r) => r.querySelector('.serial')?.textContent)).toEqual(['SN-0009', 'SN-0011', 'SN-0012']);
  });

  it('501개면 보내기가 꺼지고 안내, 발주분 입고는 발주를 고르기 전까지 꺼진다', async () => {
    mockApi(orders);
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByLabelText(/시리얼/));
    await userEvent.paste(Array.from({ length: 501 }, (_, i) => `SN-${String(i).padStart(4, '0')}`).join('\n'));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByText(/한 박스는 500개까지입니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'SN-0500 빼기' }));
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled(); // 발주를 아직 안 골랐다
    await screen.findByRole('option', { name: /SE0003/ });
    await userEvent.selectOptions(screen.getByLabelText('발주'), 'SE0003');
    expect(screen.getByRole('button', { name: '보내기' })).toBeEnabled();
  });
});

describe('박스 스캔 — 보내기와 멱등 (decisions/0020, 어드민 ScanPage와 같은 규칙)', () => {
  it('발주분 입고: 열린 발주(ORDERED·RECEIVING)를 고르고 처음 보낼 때 scanId를 만든다. 결과는 줄마다, 보낸 박스는 고칠 수 없고, 현장 조회를 모두 다시 읽는다', async () => {
    const { calls } = mockApi({ ...orders, 'POST /scans': (c) => ({ status: 201, body: result(bodyOf(c), false) }) });
    loginAs();
    const { client } = renderPage(<ScanPage />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await screen.findByRole('option', { name: /SE0003/ });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['발주 선택', 'SE0004 SN-200 10대', 'SE0003 SN-100 50대']);
    expect(calls.filter((c) => c.path === '/purchase-orders').map((c) => c.query.get('status'))).toEqual(['ORDERED', 'RECEIVING']);
    await userEvent.selectOptions(screen.getByLabelText('발주'), 'SE0003');
    await userEvent.click(screen.getByLabelText(/시리얼/));
    await scanBarcode('SN-0001');
    await scanBarcode('SN-0002');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));

    expect(await screen.findByRole('status')).toHaveTextContent('발주 SE0003 입고: 성공 1 · 거절 1');
    expect(rows().map((r) => r.textContent)).toEqual(['SN-0001입고됨', 'SN-0002납품 명세에 없음납품 명세에 없는 시리얼입니다.']);
    const body = bodyOf(posts(calls)[0]);
    expect(body).toEqual({ scanId: expect.stringMatching(/^BOX-[0-9a-f-]{36}$/), kind: 'RECEIVE', poNo: 'SE0003', serials: ['SN-0001', 'SN-0002'] });
    expect(screen.getByLabelText('scanId')).toHaveTextContent(body.scanId);
    expect(screen.getByLabelText(/시리얼/)).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: /빼기/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '보내기' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '회수 입고' })).toBeDisabled();
    await scanBarcode('SN-0003'); // 보낸 뒤 스캐너가 또 찍어도 목록이 바뀌지 않는다
    expect(rows()).toHaveLength(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.all });
  });

  it('회수 입고는 발주 없이 보낸다(poNo를 보내면 서버가 400 PO_NOT_ALLOWED)', async () => {
    const { calls } = mockApi({ ...orders, 'POST /scans': (c) => ({ status: 201, body: result(bodyOf(c), false) }) });
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByRole('button', { name: '회수 입고' }));
    expect(screen.queryByLabelText('발주')).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/시리얼/));
    await scanBarcode('RT-0001');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByText('회수 입고됨')).toBeInTheDocument();
    expect(bodyOf(posts(calls)[0])).toEqual({ scanId: expect.any(String), kind: 'RETURN_IN', serials: ['RT-0001'] });
  });

  it.each([
    ['처리 중 409', { status: 409, body: { statusCode: 409, code: 'SCAN_IN_PROGRESS', message: '처리 중' } }],
    ['5xx', { status: 503, body: { statusCode: 503, message: '잠시 뒤' } }],
    ['박스 되돌림 409', { status: 409, body: { statusCode: 409, code: 'VERSION_CONFLICT', message: '겹침' } }],
  ])('응답을 못 받으면(%s) 같은 scanId로 다시 보낸다 — 두 번째는 저장된 결과(replayed)', async (_name, first) => {
    let n = 0;
    const { calls } = mockApi({
      ...orders,
      'POST /scans': (c) => (++n === 1 ? first : { status: 200, body: result(bodyOf(c), true) }),
    });
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByRole('button', { name: '회수 입고' }));
    await userEvent.click(screen.getByLabelText(/시리얼/));
    await scanBarcode('RT-0001');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByLabelText(/시리얼/)).toHaveAttribute('readonly'); // 다시 보낼 박스는 그대로 잠겨 있다
    await userEvent.click(screen.getByRole('button', { name: '같은 박스 다시 보내기' }));
    expect(await screen.findByRole('status')).toHaveTextContent('이미 처리된 박스 — 저장된 결과입니다.');
    const [a, b] = posts(calls).map(bodyOf);
    expect(b).toEqual(a); // scanId·내용 모두 같다
  });

  it('입력 오류(4xx)면 scanId를 버린다 — 박스를 고칠 수 있고, 고친 뒤 보내면 새 scanId', async () => {
    let n = 0;
    const { calls } = mockApi({
      ...orders,
      'POST /scans': (c) =>
        ++n === 1 ? { status: 422, body: { statusCode: 422, code: 'PO_CLOSED', message: '마감된 발주' } } : { status: 201, body: result(bodyOf(c), false) },
    });
    loginAs();
    renderPage(<ScanPage />);
    await screen.findByRole('option', { name: /SE0003/ });
    await userEvent.selectOptions(screen.getByLabelText('발주'), 'SE0003');
    await userEvent.click(screen.getByLabelText(/시리얼/));
    await scanBarcode('SN-0001');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('마감된 발주입니다. 다른 발주를 고르세요.');
    expect(screen.queryByLabelText('scanId')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/시리얼/)).not.toHaveAttribute('readonly');
    await userEvent.selectOptions(screen.getByLabelText('발주'), 'SE0004');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByRole('status');
    const [a, b] = posts(calls).map(bodyOf);
    expect(b.scanId).not.toBe(a.scanId);
    expect(b.poNo).toBe('SE0004');
  });

  it('결과를 못 받은 박스를 버릴 때는 확인을 받는다. 결과를 받은 뒤 새 박스는 확인 없이 비우고 다음 박스는 새 scanId', async () => {
    let n = 0;
    const { calls } = mockApi({
      ...orders,
      'POST /scans': (c) => (++n === 1 ? { status: 503, body: { statusCode: 503, message: '잠시 뒤' } } : { status: 201, body: result(bodyOf(c), false) }),
    });
    const confirm = vi.spyOn(window, 'confirm');
    loginAs();
    renderPage(<ScanPage />);
    await userEvent.click(screen.getByRole('button', { name: '회수 입고' }));
    await userEvent.click(screen.getByLabelText(/시리얼/));
    await scanBarcode('RT-0001');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByRole('alert');
    const first = bodyOf(posts(calls)[0]).scanId;

    confirm.mockReturnValueOnce(false);
    await userEvent.click(screen.getByRole('button', { name: '새 박스' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('결과를 받지 못한 박스입니다'));
    expect(screen.getByLabelText('scanId')).toHaveTextContent(first); // 취소하면 그대로

    confirm.mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: '새 박스' }));
    expect(screen.queryByLabelText('scanId')).not.toBeInTheDocument();
    expect(rows()).toHaveLength(0);
    expect(screen.getByLabelText(/시리얼/)).toHaveFocus(); // 새 박스 → 바로 스캔

    await scanBarcode('RT-0002');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await screen.findByRole('status');
    confirm.mockClear();
    await userEvent.click(screen.getByRole('button', { name: '새 박스' }));
    expect(confirm).not.toHaveBeenCalled();
    await scanBarcode('RT-0003');
    await userEvent.click(screen.getByRole('button', { name: '보내기' }));
    await waitFor(() => expect(posts(calls)).toHaveLength(3));
    const ids = posts(calls).map((c) => bodyOf(c).scanId);
    expect(new Set(ids).size).toBe(3);
  });
});
```

`apps/field/src/api/query-keys.test.ts`(키 목록에 `keys.openOrders`):

```diff
diff --git a/apps/field/src/api/query-keys.test.ts b/apps/field/src/api/query-keys.test.ts
index 678a243..ef76d7f 100644
--- a/apps/field/src/api/query-keys.test.ts
+++ b/apps/field/src/api/query-keys.test.ts
@@ -11,7 +11,7 @@ const sources = import.meta.glob(['../**/*.tsx', '../**/*.ts', '!../**/*.test.ts
 describe('쿼리 키 팩토리', () => {
   it('모든 키가 keys.all로 시작한다(쓰기 뒤 keys.all 무효화가 닿는다)', () => {
     const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) => prefix.every((p, i) => key[i] === p);
-    for (const key of [keys.today]) {
+    for (const key of [keys.today, keys.openOrders]) {
       expect(startsWith(key, keys.all)).toBe(true);
     }
   });
```

```bash
cd apps/field && npx vitest run
```

Expected(사전 검증 원문): `FAIL  src/lib/scan.test.ts` — `Error: Failed to resolve import "./scan" from "src/lib/scan.test.ts". Does the file exist?`, `FAIL  src/pages/ScanPage.test.tsx` — `Error: Failed to resolve import "./ScanPage" from "src/pages/ScanPage.test.tsx". Does the file exist?`, `FAIL  src/api/query-keys.test.ts > 쿼리 키 팩토리 > 모든 키가 keys.all로 시작한다` — `TypeError: Cannot read properties of undefined (reading '0')`, `Test Files  3 failed | 2 passed (5)`, `Tests  1 failed | 17 passed (18)`.

- [ ] **Step 2: 구현**

`apps/field/src/lib/scan.ts`:

```ts
import type { RowResultCode } from '@terminal-ops/contracts';
import { ApiError } from '../api/client';

/**
 * 박스 스캔 규칙(보강 4, decisions/0064). 멱등 규칙은 어드민 `apps/admin/src/pages/ScanPage.tsx`와 같다(decisions/0020과 그 리뷰 반영, 어드민 decisions/0041 Task 6):
 * scanId는 처음 보낼 때 만들고 결과를 받거나 박스를 버릴 때까지 지킨다. 다시 보낼지 고칠지는 오류 종류로 가른다(`retryable`).
 */

/** 시리얼 형식 — api `terminal/bulk-rows.ts` SERIAL_NO_PATTERN과 같은 식. 화면은 미리 알려 주기만 하고 판정은 서버 행 결과(INVALID_FORMAT)다 */
export const SERIAL_PATTERN = /^[A-Z0-9-]{4,32}$/;

/** 한 박스 최대 행 수(api CreateScanDto `@ArrayMaxSize(500)`) */
export const MAX_BOX = 500;

/** 박스마다 만드는 멱등 키(서버 규칙: 영문·숫자·_·- 8~64자) */
export function newScanId(): string {
  return `BOX-${crypto.randomUUID()}`;
}

/** 한 번에 들어온 글(스캐너 한 줄 또는 붙여 넣기)을 시리얼로: 줄·쉼표·공백으로 나누고 빈 것은 뺀다(순서 유지 — 서버가 행별 결과를 같은 순서로 준다) */
export function splitSerials(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 목록 한 줄의 문제. 앞에 같은 시리얼이 있으면 중복(서버도 뒤의 것을 DUPLICATE_IN_REQUEST로 거절한다), 형식이 틀리면 형식 */
export type LineProblem = 'DUPLICATE' | 'FORMAT' | null;

export function lineProblem(serials: readonly string[], index: number): LineProblem {
  const serial = serials[index];
  if (serials.indexOf(serial) < index) return 'DUPLICATE';
  if (!SERIAL_PATTERN.test(serial)) return 'FORMAT';
  return null;
}

/**
 * 이 오류면 같은 박스를 같은 scanId로 다시 보내면 된다: 처리 중(409 SCAN_IN_PROGRESS)·연결 실패·5xx, 그리고 회수 박스가 다른 작업과 겹쳐
 * 통째로 되돌려진 409 VERSION_CONFLICT(서버가 결과를 저장하지 않았으니 같은 내용을 다시 보내면 처음부터 처리한다). 그 밖(입력 오류 등)은 박스를 고쳐 새 scanId로.
 */
export function retryable(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500 || (error.status === 409 && (error.code === 'SCAN_IN_PROGRESS' || error.code === 'VERSION_CONFLICT'));
}

/** 행 결과의 현장 문구(서버 코드는 옆에 작게 — 사무실에 물을 때) */
export const RESULT_LABEL: Record<RowResultCode, string> = {
  CREATED: '입고됨',
  RETURNED: '회수 입고됨',
  INVALID_FORMAT: '형식 오류',
  DUPLICATE_IN_REQUEST: '박스 안 중복',
  UNKNOWN_MODEL: '모르는 모델',
  ALREADY_EXISTS: '이미 등록됨',
  NOT_IN_DELIVERY_NOTE: '납품 명세에 없음',
  NOT_FOUND: '없는 단말기',
  INVALID_STATE: '지금 상태로는 안 됨',
};

export const SUCCESS: ReadonlySet<RowResultCode> = new Set<RowResultCode>(['CREATED', 'RETURNED']);
```

`apps/field/src/api/query-keys.ts`:

```diff
diff --git a/apps/field/src/api/query-keys.ts b/apps/field/src/api/query-keys.ts
index efc07cd..f00ec46 100644
--- a/apps/field/src/api/query-keys.ts
+++ b/apps/field/src/api/query-keys.ts
@@ -5,4 +5,5 @@
 export const keys = {
   all: ['field'] as const,
   today: ['field', 'today'] as const,
+  openOrders: ['field', 'open-orders'] as const,
 };
```

`apps/field/src/api/queries.ts`(열린 발주 — 어드민 ScanPage와 같이 상태별로 따로 불러 합친다):

```diff
diff --git a/apps/field/src/api/queries.ts b/apps/field/src/api/queries.ts
index 118dab6..14223db 100644
--- a/apps/field/src/api/queries.ts
+++ b/apps/field/src/api/queries.ts
@@ -1,5 +1,5 @@
 import { useQuery } from '@tanstack/react-query';
-import type { FieldTodayView } from '@terminal-ops/contracts';
+import type { BeforeIdPage, FieldTodayView, PurchaseOrderStatus, PurchaseOrderView } from '@terminal-ops/contracts';
 import { api } from './client';
 import { keys } from './query-keys';
 
@@ -7,3 +7,20 @@ import { keys } from './query-keys';
 export function useToday() {
   return useQuery({ queryKey: keys.today, queryFn: () => api<FieldTodayView>('/field/today') });
 }
+
+/** 열린 발주 상태. 상태별로 따로 불러 합친다 — 최근 100개를 받아 거르면 마감된 발주가 쌓였을 때 오래된 열린 발주가 잘린다(어드민 ScanPage와 같은 이유) */
+const OPEN_PO_STATUSES = ['ORDERED', 'RECEIVING'] as const satisfies readonly PurchaseOrderStatus[];
+
+/** 발주분 입고에서 고를 열린 발주(최근 발주부터). 상태별 100개를 넘으면 잘린다 */
+export function useOpenOrders(enabled: boolean) {
+  return useQuery({
+    queryKey: keys.openOrders,
+    queryFn: async () => {
+      const pages = await Promise.all(
+        OPEN_PO_STATUSES.map((status) => api<BeforeIdPage<PurchaseOrderView>>('/purchase-orders', { query: { status, limit: 100 } })),
+      );
+      return pages.flatMap((p) => p.items).sort((a, b) => b.id - a.id);
+    },
+    enabled,
+  });
+}
```

`apps/field/src/pages/ScanPage.tsx`:

```tsx
import { useRef, useState, type ClipboardEvent, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateScanRequest, ScanKind, ScanView } from '@terminal-ops/contracts';
import { api, ApiError } from '../api/client';
import { useOpenOrders } from '../api/queries';
import { keys } from '../api/query-keys';
import { ErrorBox } from '../components/ErrorBox';
import { lineProblem, MAX_BOX, newScanId, RESULT_LABEL, retryable, splitSerials, SUCCESS } from '../lib/scan';

const PROBLEM_LABEL = { DUPLICATE: '중복', FORMAT: '형식 오류' } as const;

/**
 * 박스 스캔(F6, 보강 4 decisions/0064). 박스 하나 = 요청 하나.
 * - 입력: 바코드 스캐너(키보드 웨지 — 시리얼을 글자로 치고 Enter)와 손 입력이 같은 칸이다. Enter마다 목록 끝에 쌓이고 입력칸은 비고 초점은 그대로라
 *   다음 바코드를 바로 찍는다. 여러 개를 붙여 넣으면 바로 목록에 쌓인다. 중복·형식 오류는 그 줄에 바로 표시한다(서버도 같은 이유로 행을 거절한다).
 * - 멱등: scanId는 처음 보낼 때 만들고 결과를 받거나 박스를 버릴 때까지 같은 값을 쓴다. 보낸 박스는 고칠 수 없다(같은 scanId에 다른 내용 → 422).
 *   어드민 ScanPage와 같은 규칙(decisions/0020·0041 Task 6).
 */
export function ScanPage() {
  const client = useQueryClient();
  const [kind, setKind] = useState<ScanKind>('RECEIVE');
  const [poNo, setPoNo] = useState('');
  const [serials, setSerials] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [scanId, setScanId] = useState<string | null>(null);
  /** 지금 박스의 scanId(늦게 온 응답이 그새 바뀐 박스의 scanId를 지우지 않게 비교용) */
  const currentScanId = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const changeScanId = (id: string | null) => {
    currentScanId.current = id;
    setScanId(id);
  };

  const orders = useOpenOrders(kind === 'RECEIVE');
  const scan = useMutation({
    mutationFn: (body: CreateScanRequest) => api<ScanView>('/scans', { method: 'POST', body }),
    // 스캔은 단말기 상태·발주 입고 수·검수 대기·오늘 요약을 바꾼다 — 현장 화면의 모든 조회를 다시 읽는다
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.all }),
    onError: (error, body) => {
      // 내용을 고쳐야 하는 오류: 다음 보내기는 새 scanId. 그새 다른 박스로 넘어갔으면 그 박스의 scanId는 건드리지 않는다
      if (!retryable(error) && currentScanId.current === body.scanId) changeScanId(null);
    },
  });

  const locked = scanId !== null; // 보냈거나 보내는 중인 박스는 고치지 않는다
  const result = scan.data;
  const problems = serials.map((_, i) => lineProblem(serials, i));
  const duplicates = problems.filter((p) => p === 'DUPLICATE').length;
  const badFormat = problems.filter((p) => p === 'FORMAT').length;

  const append = (added: string[]) => {
    if (locked || added.length === 0) return;
    setSerials((list) => [...list, ...added]);
    setDraft('');
  };
  const add = (event: FormEvent) => {
    event.preventDefault(); // 스캐너의 Enter = 이 폼 제출. 입력칸은 비우고 초점은 그대로(다음 바코드)
    append(splitSerials(draft));
  };
  /** 여러 개를 붙여 넣으면 바로 목록으로 — 한 줄 입력칸은 붙여 넣은 줄바꿈을 지워 시리얼이 한 덩어리로 붙는다(사전 검증) */
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData('text');
    if (!/[\s,]/.test(text.trim())) return; // 시리얼 하나는 보통 붙여 넣기(그 뒤 Enter)
    event.preventDefault();
    append(splitSerials(draft + text));
  };
  const remove = (index: number) => setSerials((list) => list.filter((_, i) => i !== index));
  const send = () => {
    const id = scanId ?? newScanId();
    changeScanId(id);
    scan.mutate({ scanId: id, kind, ...(kind === 'RECEIVE' ? { poNo } : {}), serials });
  };
  const nextBox = () => {
    // 보냈는데 결과를 못 받은 박스: 서버가 처리했을 수도 있다. 버리면 같은 scanId로 확인할 방법이 없어진다
    if (scanId !== null && result === undefined && !window.confirm('결과를 받지 못한 박스입니다. 버리시겠습니까? 서버가 이미 처리했을 수 있습니다 — 같은 박스 다시 보내기를 누르면 저장된 결과를 받습니다.')) {
      return;
    }
    changeScanId(null);
    setSerials([]);
    setDraft('');
    scan.reset();
    input.current?.focus();
  };
  const succeeded = result?.results.filter((r) => SUCCESS.has(r.result)).length ?? 0;
  const conflict = scan.error instanceof ApiError && scan.error.code === 'VERSION_CONFLICT';

  return (
    <section>
      <h1>박스 스캔</h1>
      <div className="segmented" role="group" aria-label="스캔 종류">
        <button type="button" aria-pressed={kind === 'RECEIVE'} disabled={locked} onClick={() => setKind('RECEIVE')}>
          발주분 입고
        </button>
        <button type="button" aria-pressed={kind === 'RETURN_IN'} disabled={locked} onClick={() => setKind('RETURN_IN')}>
          회수 입고
        </button>
      </div>
      {kind === 'RECEIVE' ? (
        <label>
          발주
          <select value={poNo} disabled={locked} onChange={(e) => setPoNo(e.target.value)}>
            <option value="">발주 선택</option>
            {orders.data?.map((p) => (
              <option key={p.poNo} value={p.poNo}>
                {p.poNo} {p.modelCode} {p.quantity}대
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <ErrorBox error={orders.error} />

      <form className="scan-input" onSubmit={add}>
        <label>
          시리얼 (스캐너로 찍거나 입력 후 Enter)
          <input
            ref={input}
            autoFocus
            value={draft}
            readOnly={locked}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="enter"
            onChange={(e) => setDraft(e.target.value)}
            onPaste={paste}
          />
        </label>
        <button type="submit" disabled={locked || !draft.trim()}>
          추가
        </button>
      </form>

      <p className="box-count" aria-live="polite">
        <strong>{serials.length}개</strong>
        {duplicates > 0 ? <span className="bad"> · 중복 {duplicates}</span> : null}
        {badFormat > 0 ? <span className="bad"> · 형식 오류 {badFormat}</span> : null}
        {serials.length > MAX_BOX ? <span className="bad"> · 한 박스는 {MAX_BOX}개까지입니다</span> : null}
      </p>

      <ol className="box-list" aria-label="박스 목록">
        {serials.map((serial, i) => {
          const row = result?.results[i];
          const problem = problems[i];
          return (
            <li key={`${serial}-${i}`}>
              <span className="serial">{serial}</span>
              {row ? (
                <span className={SUCCESS.has(row.result) ? 'badge ok' : 'badge danger'} title={row.message}>
                  {RESULT_LABEL[row.result]}
                </span>
              ) : problem ? (
                <span className="badge danger">{PROBLEM_LABEL[problem]}</span>
              ) : null}
              {!locked ? (
                <button type="button" className="link" aria-label={`${serial} 빼기`} onClick={() => remove(i)}>
                  빼기
                </button>
              ) : null}
              {row?.message ? <small className="row-message">{row.message}</small> : null}
            </li>
          );
        })}
      </ol>

      <ErrorBox error={scan.error} />
      {conflict ? <p className="muted">다른 작업과 겹쳐 이 박스 전체가 되돌려졌습니다(처리된 것 없음). 같은 박스를 다시 보내세요.</p> : null}
      {result ? (
        <div className="notice" role="status">
          {result.replayed ? <strong>이미 처리된 박스 — 저장된 결과입니다. </strong> : null}
          {result.kind === 'RECEIVE' ? `발주 ${result.poNo} 입고` : '회수 입고'}: 성공 {succeeded} · 거절 {result.results.length - succeeded}
        </div>
      ) : null}
      {scanId ? (
        <p className="muted small">
          박스 번호 <code aria-label="scanId">{scanId}</code>
        </p>
      ) : null}

      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={serials.length === 0 || serials.length > MAX_BOX || (kind === 'RECEIVE' && !poNo) || scan.isPending || result !== undefined}
          onClick={send}
        >
          {scanId && scan.isError ? '같은 박스 다시 보내기' : '보내기'}
        </button>
        <button type="button" disabled={scan.isPending} onClick={nextBox}>
          새 박스
        </button>
      </div>
    </section>
  );
}
```

`apps/field/src/App.tsx`:

```diff
diff --git a/apps/field/src/App.tsx b/apps/field/src/App.tsx
index f734ff7..7498f9f 100644
--- a/apps/field/src/App.tsx
+++ b/apps/field/src/App.tsx
@@ -4,6 +4,7 @@ import { SessionCacheSync } from './components/SessionCacheSync';
 import { Shell } from './components/Shell';
 import { HomePage } from './pages/HomePage';
 import { LoginPage } from './pages/LoginPage';
+import { ScanPage } from './pages/ScanPage';
 
 /** 화면 경로. /login 말고는 모두 현장 작업자 계정으로 로그인해야 보인다(AuthGate) */
 export function App() {
@@ -20,6 +21,7 @@ export function App() {
           }
         >
           <Route index element={<HomePage />} />
+          <Route path="scan" element={<ScanPage />} />
           <Route path="*" element={<p>없는 화면입니다.</p>} />
         </Route>
       </Routes>
```

`apps/field/src/styles.css` 끝에 덧붙인다:

```diff
diff --git a/apps/field/src/styles.css b/apps/field/src/styles.css
index 1a5fbc1..b574720 100644
--- a/apps/field/src/styles.css
+++ b/apps/field/src/styles.css
@@ -241,3 +241,100 @@ fieldset {
 legend {
   font-weight: 600;
 }
+
+/* 박스 스캔(Task 3): 둘 중 하나 고르기, 입력칸 + 추가, 쌓이는 목록, 아래 버튼 둘 */
+.segmented {
+  display: grid;
+  grid-template-columns: 1fr 1fr;
+  gap: 8px;
+  margin-bottom: 12px;
+}
+
+.segmented button {
+  min-height: 56px;
+  font-weight: 700;
+}
+
+.segmented button[aria-pressed='true'] {
+  background: var(--accent);
+  border-color: var(--accent);
+  color: #fff;
+}
+
+.scan-input {
+  display: flex;
+  align-items: flex-end;
+  gap: 8px;
+}
+
+.scan-input label {
+  flex: 1;
+  margin-bottom: 0;
+}
+
+.box-count {
+  margin: 12px 0 4px;
+}
+
+.bad {
+  color: var(--danger);
+}
+
+.box-list {
+  margin: 0 0 12px;
+  padding-left: 2.5em;
+}
+
+.box-list li {
+  display: flex;
+  flex-wrap: wrap;
+  align-items: center;
+  gap: 8px;
+  min-height: 48px;
+  border-bottom: 1px solid var(--line);
+}
+
+.box-list .serial {
+  flex: 1;
+  font-family: ui-monospace, Consolas, monospace;
+  word-break: break-all;
+}
+
+.box-list .row-message {
+  flex-basis: 100%;
+  color: var(--muted);
+  padding-bottom: 6px;
+}
+
+.badge {
+  display: inline-block;
+  padding: 2px 8px;
+  border-radius: 999px;
+  font-size: 13px;
+  font-weight: 600;
+  background: var(--bg);
+  border: 1px solid var(--line);
+  white-space: nowrap;
+}
+
+.badge.ok {
+  color: var(--ok);
+  border-color: var(--ok);
+}
+
+.badge.danger {
+  color: var(--danger);
+  border-color: var(--danger);
+}
+
+.small {
+  font-size: 13px;
+  word-break: break-all;
+}
+
+.actions {
+  display: grid;
+  grid-template-columns: 2fr 1fr;
+  gap: 8px;
+  margin-top: 12px;
+}
```

- [ ] **Step 3: 통과 확인과 빌드**

```bash
cd apps/field && npx vitest run && npm run build && rm -rf dist
```

Expected: `Test Files  5 passed (5)`, `Tests  32 passed (32)`(스캔 규칙 4, 박스 스캔 10 더함). build tsc 0·성공.

사전 검증에서 처음 짠 화면은 붙여 넣기를 입력칸에 그대로 넣고 Enter를 기다렸다 — 그러면 한 줄 입력칸이 줄바꿈을 지워 `['SN-0009', 'SN-0010', 'SN-0011SN-0012']`처럼 붙었다(테스트 `expected [ 'SN-0009', 'SN-0010', …(1) ] to deeply equal [ 'SN-0009', 'SN-0010', …(2) ]`). 그래서 `onPaste`가 있다(decisions/0064). 열린 발주 테스트는 `findByRole('option', { name: /SE0003/ })`로 목록이 온 뒤에 고른다(`findAllByRole('option')`은 "발주 선택" 하나만 있을 때 바로 돌아온다).

- [ ] **Step 4: 기록**

`docs/decisions/0064-현장-입력은-키보드-웨지-카메라는-생략.md`(아래 "## Task 4 보탬" 절은 Task 4가 쓴다 — 지금은 그 앞까지만):

````markdown
# 0064. 현장 입력은 키보드 웨지 스캐너(입력칸 + Enter)로 받고, 카메라 바코드는 넣지 않는다

- 날짜 / 관련 기능: 2026-10-28 / 보강 4, F6(박스 스캔), F13(검수)
- 상황: 현장 작업자는 바코드 스캐너로 시리얼을 찍는다. 흔한 USB·블루투스 스캐너와 PDA 내장 스캐너는 "키보드 웨지" — 읽은 글자를 키보드처럼 치고 끝에 Enter를 보낸다. 휴대폰만 있으면 카메라로 찍고 싶을 수 있다(브라우저 `BarcodeDetector`). 어드민 ScanPage는 여러 줄 글 상자(`textarea`)에 붙여 넣는 방식이라, 스캐너가 Enter를 칠 때마다 줄만 바뀌고 무엇이 몇 개 들어갔는지·중복인지가 보내기 전까지 줄 단위로 보이지 않는다.
- 선택지(입력):
  1. 어드민처럼 `textarea` — 장점: 사본. 단점: 한 줄씩 쌓이는 확인(중복·형식)이 없고, 잘못 찍은 하나를 빼려면 글을 고쳐야 한다. 휴대폰에서 여러 줄 칸은 키보드가 화면을 덮는다
  2. **한 줄 입력칸 + `<form onSubmit>`** — 스캐너의 Enter = 폼 제출 → 시리얼을 목록 끝에 더하고 입력칸을 비운다. 초점은 입력칸에 그대로라 다음 바코드를 바로 찍는다. 처음 화면에 들어올 때 입력칸에 초점(`autoFocus`), "새 박스" 뒤에도 초점을 돌려 준다. 목록은 줄마다 번호·시리얼·문제(중복·형식 오류)·빼기
  3. 전역 `keydown` 듣기(입력칸 없이 빠른 키 입력을 스캐너로 판단) — 손 입력과 구분하려면 글자 사이 시간을 재야 하고(장치마다 다르다), 화면의 다른 입력칸과 부딪힌다
- 선택지(카메라):
  1. `BarcodeDetector`(브라우저 내장) — 사전 검증: 시연 환경 브라우저(이 PC의 내장 브라우저, `Chrome/152.0.7977.167` Windows, `localhost`라 `isSecureContext: true`)에서 `'BarcodeDetector' in window`가 `false`였다(`getUserMedia`는 있음). 지원하는 곳(안드로이드 Chrome 등)에서만 보이는 버튼으로 둘 수는 있지만, 시연 환경에서 확인할 수 없는 코드가 된다
  2. 자바스크립트 바코드 라이브러리(ZXing 계열) — 새 의존성·번들 크기·카메라 권한 흐름이 생긴다. 학습 범위(스캔 멱등·검수 규칙)와 거리가 멀다
  3. **넣지 않는다** — 브리프의 "안 되면 생략하고 기록"
- 결정: 입력은 2, 카메라는 3.
  - Enter 한 번에 들어온 글은 줄·쉼표·공백으로 나눠 여러 개로 더한다(`splitSerials`). 빈 Enter는 무시
  - **여러 개 붙여 넣기는 입력칸을 거치지 않고 바로 목록으로**(`onPaste`): 한 줄 입력칸(`<input>`)은 붙여 넣은 글의 줄바꿈을 지워(HTML 값 정리 규칙 "strip newlines") 시리얼이 한 덩어리로 붙을 수 있다 — 사전 검증의 jsdom 테스트에서 `SN-0010 SN-0011\nSN-0012`를 붙여 넣고 Enter하자 3개가 아니라 2개(`SN-0010`, `SN-0011SN-0012`)가 됐다(실제 브라우저마다 줄바꿈을 지우거나 공백으로 바꾼다 — 재지 않음, 어느 쪽이든 아래 처리로 같아진다). 붙여 넣은 글에 공백·쉼표·줄바꿈이 있으면 기본 동작을 막고 나눠서 더한다. 시리얼 하나는 보통 붙여 넣기(그 뒤 Enter)
  - 줄 문제: 앞에 같은 시리얼이 있으면 "중복"(서버도 뒤의 것을 `DUPLICATE_IN_REQUEST`로 거절한다 — 처음 것은 괜찮다), 서버 형식(`^[A-Z0-9-]{4,32}$`, api `SERIAL_NO_PATTERN`과 같은 식)이 아니면 "형식 오류". 화면은 미리 알려 주기만 하고 막지 않는다 — 판정은 서버 행 결과다(decisions/0040과 같은 방향: 서버 규칙을 화면이 대신하지 않는다). 위에 "N개 · 중복 x · 형식 오류 y"
  - 대문자로 바꾸지 않는다(스캐너가 읽은 값을 바꾸지 않는다). 손 입력을 위해 `autoCapitalize="characters"`(휴대폰 키보드가 대문자로 시작)
  - 멱등은 어드민 ScanPage와 같다(decisions/0020·0041 Task 6): scanId는 처음 보낼 때 만들고 결과를 받거나 박스를 버릴 때까지 같은 값, 처리 중 409·5xx·연결 실패·409 VERSION_CONFLICT는 같은 scanId로 "같은 박스 다시 보내기", 그 밖의 4xx는 scanId를 버리고 박스를 고친다, 보낸 박스는 잠근다(입력칸 `readOnly`·빼기 없음·종류 버튼 끔 — 스캐너가 또 찍어도 목록이 바뀌지 않는다), 결과를 못 받은 박스를 "새 박스"로 버릴 때 `window.confirm`. 늦게 온 오류는 지금 박스의 scanId일 때만 지운다(ref 비교)
  - 결과는 줄마다 현장 문구(`RESULT_LABEL` — CREATED "입고됨", NOT_IN_DELIVERY_NOTE "납품 명세에 없음" …)와 서버 메시지. 성공·거절 수는 응답 `summary`가 아니라 행 결과에서 센다(같은 값이지만 화면이 그리는 줄과 같은 근거)
  - 쓰기 뒤에는 현장 조회를 모두 다시 읽는다(`keys.all` — 오늘 요약·검수 대기·발주가 함께 바뀐다)
- 결과·대가: 스캐너가 Enter 대신 Tab을 접미사로 보내게 설정된 장치는 맞지 않는다(장치 설정을 Enter로). 카메라만 있는 휴대폰으로는 손 입력·붙여 넣기만 된다. 서버 형식 규칙이 화면에 한 번 더 있다(바뀌면 둘 다 — 화면은 표시만이라 어긋나도 서버 행 결과가 맞다).
- 다시 볼 조건: 시연·운영 기기가 안드로이드 Chrome처럼 `BarcodeDetector`가 있는 브라우저가 되면(지원할 때만 보이는 "카메라로 찍기" — 찍은 값을 같은 `append`로), 스캐너 없이 휴대폰만 쓰는 현장이 생기면(라이브러리 비교).
````

`docs/study/backlog.md` 끝에 두 줄:

```markdown
- [ ] HTML `<input>` 값 정리(줄바꿈 지우기)와 붙여 넣기 이벤트(`clipboardData.getData('text')`, `preventDefault`) — 여러 줄 붙여 넣기가 한 덩어리가 됨 (apps/field/src/pages/ScanPage.tsx, decisions/0064)
- [ ] 바코드 스캐너 키보드 웨지의 접미사(Enter·Tab)·접두사 설정과 브라우저 `BarcodeDetector` 지원 범위(안드로이드 Chrome 등) (decisions/0064)
```

devlog 항목:

```markdown
## HH:MM Task 3 박스 스캔 — 키보드 웨지 입력·붙여 넣기·중복·형식 표시·scanId 멱등·줄마다 결과 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <Task 2 커밋 해시> (feat(field): 현장 앱 골격)
- 한 일: `lib/scan.ts`(시리얼 나누기·줄 문제·다시 보내기 판정·행 결과 문구), `ScanPage`(발주분 입고/회수 입고, 열린 발주 ORDERED·RECEIVING 합침, 입력칸 + Enter = 폼 제출로 목록에 쌓기, 여러 개 붙여 넣기는 바로 목록, 줄마다 중복·형식 오류·빼기, scanId 유지·같은 박스 다시 보내기·보낸 박스 잠금·결과 못 받은 박스 확인, 줄마다 결과, 쓰기 뒤 `keys.all` 무효화)
- 확인: 처음 실패(`Failed to resolve import "./scan"`·`"./ScanPage"`, 쿼리 키) → `Test Files  5 passed`, `Tests  32 passed`, build 성공
- 결정: decisions/0064(키보드 웨지 입력, 카메라 생략 — 시연 브라우저에 `BarcodeDetector` 없음, 멱등은 어드민 규칙 그대로)
- 다음: Task 4 검수
```

```bash
node scripts/docs-index.mjs
```

- [ ] **Step 5: 커밋**

```bash
git add apps/field docs
git commit -m "$(cat <<'EOF'
feat(field, F6): 현장 박스 스캔 — 스캐너 입력·중복·형식 표시·scanId 멱등·줄마다 결과

Refs: docs/decisions/0064-현장-입력은-키보드-웨지-카메라는-생략.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 제목 시각 = 커밋 시각인지 보고, 다르면 고쳐 amend.

---


### Task 4: 검수 — 검수 대기·시리얼 스캔으로 찾기·체크리스트(합격/불합격 + 메모)·저장·결과

**Files:**
- Create: `apps/field/src/lib/labels.ts`, `src/pages/InspectionQueuePage.tsx`, `src/pages/InspectPage.tsx`
- Modify: `apps/field/src/App.tsx`, `src/api/query-keys.ts`, `src/api/queries.ts`, `src/styles.css`
- Test: Create `src/pages/InspectPages.test.tsx`; Modify `src/api/query-keys.test.ts`
- Docs: Modify `docs/decisions/0064-현장-입력은-키보드-웨지-카메라는-생략.md`(Task 4 보탬), `docs/index.md`, `docs/devlog/2026-10-28.md`

- [ ] **Step 1: 실패하는 테스트**

`apps/field/src/pages/InspectPages.test.tsx`(앱 전체를 그린다 — 대기 → 스캔으로 찾기 → 검수 → 다음 단말기가 한 흐름):

```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { InspectRequest, TerminalDetail, TerminalStatus, TerminalView } from '@terminal-ops/contracts';
import { keys } from '../api/query-keys';
import { loginAs, mockApi, renderApp, type Call } from '../test/render';

const view = (serialNo: string, status: TerminalStatus, statusChangedAt: string): TerminalView => ({
  serialNo,
  modelCode: 'SN-100',
  merchantCode: null,
  status,
  statusChangedAt,
  version: 1,
  createdAt: statusChangedAt,
  updatedAt: statusChangedAt,
});
const detail = (serialNo: string, status: TerminalStatus = 'RECEIVED'): TerminalDetail => ({
  ...view(serialNo, status, '2026-10-28T00:00:00.000Z'),
  modelName: '단말온 S100',
  merchantName: null,
  allowedTransitions: [],
  actions: { allocate: false, cancelAllocation: false, ship: false, inspect: status === 'RECEIVED' || status === 'RETURNED' },
});
const ITEMS = [
  { code: 'POWER', label: '전원', sortOrder: 1 },
  { code: 'NETWORK', label: '통신', sortOrder: 2 },
  { code: 'CARD_READER', label: '카드 리더', sortOrder: 3 },
  { code: 'PRINTER', label: '프린터', sortOrder: 4 },
];
/** 검수 대기 목록: 상태별로 다른 단말기(서버 GET /terminals?status=와 같게 그 상태만) */
const queue = (byStatus: Partial<Record<TerminalStatus, TerminalView[]>>, totals: Partial<Record<TerminalStatus, number>> = {}) => ({
  'GET /terminals': (c: Call) => {
    const status = c.query.get('status') as TerminalStatus;
    const items = byStatus[status] ?? [];
    return { body: { items, total: totals[status] ?? items.length, page: 1, size: Number(c.query.get('size')) } };
  },
});
const today = { 'GET /field/today': () => ({ body: { date: '2026-10-28', scans: { boxes: 0, received: 0, returned: 0, rejected: 0 }, inspections: { total: 0, passed: 0, failed: 0 } } }) };

describe('검수 대기 (보강 4)', () => {
  it('새 입고·회수 입고를 상태마다 불러 합치고 오래 기다린 것부터 보인다', async () => {
    const { calls } = mockApi(
      queue({
        RECEIVED: [view('SN-NEW-2', 'RECEIVED', '2026-10-28T02:00:00.000Z'), view('SN-NEW-1', 'RECEIVED', '2026-10-28T01:00:00.000Z')],
        RETURNED: [view('SN-RET-1', 'RETURNED', '2026-10-27T23:00:00.000Z')],
      }),
    );
    loginAs();
    renderApp('/inspections');
    expect(await screen.findByRole('heading', { name: '검수 대기 3대' })).toBeInTheDocument();
    const links = within(screen.getByRole('list')).getAllByRole('link');
    expect(links.map((a) => a.querySelector('.serial')?.textContent)).toEqual(['SN-RET-1', 'SN-NEW-1', 'SN-NEW-2']);
    expect(links[0]).toHaveTextContent('회수 입고');
    expect(links[0]).toHaveTextContent('SN-100 · 10-28 08:00부터');
    expect(links[1]).toHaveTextContent('새 입고');
    expect(links[0]).toHaveAttribute('href', '/inspections/SN-RET-1');
    expect(calls.filter((c) => c.path === '/terminals').map((c) => c.query.toString())).toEqual(['status=RECEIVED&size=100', 'status=RETURNED&size=100']);
  });

  it('상태별 100대를 넘으면 잘렸다고 알린다. 없으면 없다고', async () => {
    mockApi(queue({ RECEIVED: [view('SN-1', 'RECEIVED', '2026-10-28T01:00:00.000Z')] }, { RECEIVED: 130 }));
    loginAs();
    const first = renderApp('/inspections');
    expect(await screen.findByText('130대 중 오래 기다린 순으로 1대만 보입니다(상태별 최근 100대).')).toBeInTheDocument();
    first.unmount();
    mockApi(queue({}));
    renderApp('/inspections');
    expect(await screen.findByText('검수할 단말기가 없습니다.')).toBeInTheDocument();
  });

  it('손에 든 단말기를 스캔하면(글자 + Enter) 그 단말기 검수 화면으로 간다', async () => {
    const { calls } = mockApi({ ...queue({}), 'GET /terminals/:serialNo': () => ({ body: detail('SN-HAND-1') }), 'GET /inspection-items': () => ({ body: ITEMS }) });
    loginAs();
    renderApp('/inspections');
    await screen.findByText('검수할 단말기가 없습니다.');
    expect(screen.getByLabelText('시리얼 스캔으로 찾기')).toHaveFocus();
    await userEvent.keyboard(' SN-HAND-1 {Enter}');
    expect(await screen.findByRole('heading', { name: 'SN-HAND-1' })).toBeInTheDocument();
    expect(await screen.findByRole('group', { name: '전원' })).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/terminals/SN-HAND-1')).toBe(true);
    expect(calls.find((c) => c.path === '/inspection-items')?.query.get('modelCode')).toBe('SN-100');
  });
});

describe('단말기 검수 (보강 4)', () => {
  it('항목마다 합격/불합격을 다 골라야 저장된다. 불합격 항목만 메모를 보내고, 결과(불량)와 다음 단말기 버튼을 보인다', async () => {
    const { calls } = mockApi({
      ...today,
      ...queue({}),
      'GET /terminals/:serialNo': () => ({ body: detail('SN-0001') }),
      'GET /inspection-items': () => ({ body: ITEMS }),
      'POST /terminals/:serialNo/inspections': () => ({
        status: 201,
        body: { inspectionId: 9, passed: false, failedItems: ['PRINTER'], terminal: view('SN-0001', 'DEFECTIVE', '2026-10-28T03:00:00.000Z') },
      }),
    });
    loginAs();
    const { client } = renderApp('/inspections/SN-0001');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    expect(await screen.findByText('단말온 S100(SN-100) · 입고')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '남은 항목 4개' })).toBeDisabled();
    for (const label of ['전원', '통신', '카드 리더']) {
      await userEvent.click(within(screen.getByRole('group', { name: label })).getByRole('button', { name: '합격' }));
    }
    await userEvent.click(within(screen.getByRole('group', { name: '프린터' })).getByRole('button', { name: '불합격' }));
    expect(within(screen.getByRole('group', { name: '프린터' })).getByRole('button', { name: '불합격' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.type(screen.getByLabelText('프린터 메모'), ' 용지 걸림 ');
    expect(screen.queryByLabelText('전원 메모')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '검수 결과 저장' }));

    expect(await screen.findByRole('status')).toHaveTextContent('불합격 — 불량으로 바뀜불합격 항목: 프린터');
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/terminals/SN-0001/inspections');
    expect(post?.body).toEqual({
      results: [
        { itemCode: 'POWER', passed: true },
        { itemCode: 'NETWORK', passed: true },
        { itemCode: 'CARD_READER', passed: true },
        { itemCode: 'PRINTER', passed: false, note: '용지 걸림' },
      ],
    } satisfies InspectRequest);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.all });
    await userEvent.click(screen.getByRole('link', { name: '다음 단말기' }));
    expect(await screen.findByLabelText('시리얼 스캔으로 찾기')).toHaveFocus(); // 다음 단말기를 바로 스캔
  });

  it('모두 합격 한 번으로 고르고 저장하면 합격. 합격 항목의 메모는 보내지 않는다', async () => {
    const { calls } = mockApi({
      ...today,
      ...queue({}),
      'GET /terminals/:serialNo': () => ({ body: detail('SN-0002', 'RETURNED') }),
      'GET /inspection-items': () => ({ body: ITEMS }),
      'POST /terminals/:serialNo/inspections': () => ({ status: 201, body: { inspectionId: 10, passed: true, failedItems: [], terminal: view('SN-0002', 'INSPECTED', '2026-10-28T03:00:00.000Z') } }),
    });
    loginAs();
    renderApp('/inspections/SN-0002');
    await userEvent.click(within(await screen.findByRole('group', { name: '프린터' })).getByRole('button', { name: '불합격' }));
    await userEvent.type(screen.getByLabelText('프린터 메모'), '다시 보니 괜찮음');
    await userEvent.click(screen.getByRole('button', { name: '모두 합격' }));
    expect(screen.queryByLabelText('프린터 메모')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '검수 결과 저장' }));
    expect(await screen.findByRole('status')).toHaveTextContent('합격 — 검수 완료');
    expect((calls.find((c) => c.method === 'POST')?.body as InspectRequest).results.every((r) => r.passed && r.note === undefined)).toBe(true);
  });

  it('검수 대기가 아닌 단말기는 안내만(항목을 부르지 않는다), 없는 시리얼은 찾는 단말기가 없다고', async () => {
    const { calls } = mockApi({
      'GET /terminals/:serialNo': (c) =>
        c.path.endsWith('SN-STOCK') ? { body: detail('SN-STOCK', 'IN_STOCK') } : { status: 404, body: { statusCode: 404, message: '단말기 NOPE이(가) 없습니다.' } },
    });
    loginAs();
    const first = renderApp('/inspections/SN-STOCK');
    expect(await screen.findByText('검수 대기 단말기가 아닙니다(지금 상태: 재고). 다른 단말기를 스캔하세요.')).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/inspection-items')).toBe(false);
    first.unmount();
    renderApp('/inspections/NOPE');
    expect(await screen.findByRole('alert')).toHaveTextContent('찾는 단말기·자료가 없습니다.');
  });

  it('저장이 실패하면(그새 다른 사람이 검수 — 422) 단말기를 다시 읽어 검수 대기가 아니라는 안내와 지금 상태를 보인다', async () => {
    let state: TerminalStatus = 'RECEIVED';
    const { calls } = mockApi({
      ...today,
      ...queue({}),
      'GET /terminals/:serialNo': () => ({ body: detail('SN-0003', state) }),
      'GET /inspection-items': () => ({ body: ITEMS }),
      'POST /terminals/:serialNo/inspections': () => {
        state = 'INSPECTED';
        return { status: 422, body: { statusCode: 422, code: 'INVALID_TRANSITION', message: '허용되지 않은 전이입니다: INSPECTED → INSPECTED' } };
      },
    });
    loginAs();
    renderApp('/inspections/SN-0003');
    await userEvent.click(await screen.findByRole('button', { name: '모두 합격' }));
    await userEvent.click(screen.getByRole('button', { name: '검수 결과 저장' }));
    expect(await screen.findByText('검수 대기 단말기가 아닙니다(지금 상태: 검수 합격). 다른 단말기를 스캔하세요.')).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((c) => c.path === '/terminals/SN-0003')).toHaveLength(2));
  });
});
```

`apps/field/src/api/query-keys.test.ts`(키 목록에 검수 키 셋):

```diff
diff --git a/apps/field/src/api/query-keys.test.ts b/apps/field/src/api/query-keys.test.ts
index ef76d7f..c8f3f24 100644
--- a/apps/field/src/api/query-keys.test.ts
+++ b/apps/field/src/api/query-keys.test.ts
@@ -11,7 +11,7 @@ const sources = import.meta.glob(['../**/*.tsx', '../**/*.ts', '!../**/*.test.ts
 describe('쿼리 키 팩토리', () => {
   it('모든 키가 keys.all로 시작한다(쓰기 뒤 keys.all 무효화가 닿는다)', () => {
     const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) => prefix.every((p, i) => key[i] === p);
-    for (const key of [keys.today, keys.openOrders]) {
+    for (const key of [keys.today, keys.openOrders, keys.queue, keys.terminal('SN-1'), keys.items('SN-100')]) {
       expect(startsWith(key, keys.all)).toBe(true);
     }
   });
```

```bash
cd apps/field && npx vitest run
```

Expected(사전 검증 원문 요약): `Test Files  2 failed | 4 passed (6)`, `Tests  8 failed | 31 passed (39)` — `TypeError: keys.terminal is not a function`(쿼리 키), `Unable to find role="heading" and name "검수 대기 3대"`, `Unable to find an element with the text: 130대 중 오래 기다린 순으로 1대만 보입니다(상태별 최근 100대).`, `…검수할 단말기가 없습니다.`, `…단말온 S100(SN-100) · 입고`, `Unable to find role="group" and name "프린터"`, `…검수 대기 단말기가 아닙니다(지금 상태: 재고). 다른 단말기를 스캔하세요.`, `Unable to find role="button" and name "모두 합격"`(경로가 아직 없어 "없는 화면입니다."가 그려진다).

- [ ] **Step 2: 구현**

`apps/field/src/lib/labels.ts`:

```ts
import type { TerminalStatus } from '@terminal-ops/contracts';

/**
 * 단말기 상태 이름. 현장 작업자는 사내 직원이라 어드민 `lib/labels.ts`와 같은 말을 쓴다(점주 말 decisions/0060과 다름).
 * contracts 유니온이 키라 상태가 늘면 tsc가 빠진 이름을 알려 준다.
 */
export const TERMINAL_STATUS_LABEL: Record<TerminalStatus, string> = {
  RECEIVED: '입고',
  INSPECTED: '검수 합격',
  DEFECTIVE: '불량',
  IN_STOCK: '재고',
  ALLOCATED: '배정',
  SHIPPED: '출고(배송 중)',
  DELIVERED: '배송 완료',
  IN_SERVICE: '운영 중',
  RETURN_REQUESTED: '회수 요청',
  RETURNING: '회수 중',
  RETURNED: '회수 입고',
  DISPOSED: '폐기',
};

/** 검수 대기 상태 — 전이 표에서 검수(INSPECTION)로 나갈 수 있는 상태(api transition-rules.ts: RECEIVED·RETURNED → INSPECTED·DEFECTIVE) */
export const INSPECTION_QUEUE_STATUSES = ['RECEIVED', 'RETURNED'] as const satisfies readonly TerminalStatus[];

/** 검수 대기 목록의 구분(새로 들어온 것 / 회수돼 돌아온 것) */
export const QUEUE_KIND_LABEL: Record<(typeof INSPECTION_QUEUE_STATUSES)[number], string> = {
  RECEIVED: '새 입고',
  RETURNED: '회수 입고',
};
```

`apps/field/src/api/query-keys.ts`:

```diff
diff --git a/apps/field/src/api/query-keys.ts b/apps/field/src/api/query-keys.ts
index f00ec46..0388b93 100644
--- a/apps/field/src/api/query-keys.ts
+++ b/apps/field/src/api/query-keys.ts
@@ -6,4 +6,7 @@ export const keys = {
   all: ['field'] as const,
   today: ['field', 'today'] as const,
   openOrders: ['field', 'open-orders'] as const,
+  queue: ['field', 'queue'] as const,
+  terminal: (serialNo: string) => ['field', 'terminal', serialNo] as const,
+  items: (modelCode: string) => ['field', 'items', modelCode] as const,
 };
```

`apps/field/src/api/queries.ts`(검수 대기 — 상태마다 `GET /terminals?status=&size=100`, 오래 기다린 순. 단말기 한 대, 검수 항목):

```diff
diff --git a/apps/field/src/api/queries.ts b/apps/field/src/api/queries.ts
index 14223db..8f3e30a 100644
--- a/apps/field/src/api/queries.ts
+++ b/apps/field/src/api/queries.ts
@@ -1,5 +1,6 @@
 import { useQuery } from '@tanstack/react-query';
-import type { BeforeIdPage, FieldTodayView, PurchaseOrderStatus, PurchaseOrderView } from '@terminal-ops/contracts';
+import type { BeforeIdPage, FieldTodayView, InspectionItemView, PurchaseOrderStatus, PurchaseOrderView, TerminalDetail, TerminalPage, TerminalView } from '@terminal-ops/contracts';
+import { INSPECTION_QUEUE_STATUSES } from '../lib/labels';
 import { api } from './client';
 import { keys } from './query-keys';
 
@@ -24,3 +25,39 @@ export function useOpenOrders(enabled: boolean) {
     enabled,
   });
 }
+
+/** 검수 대기 한 묶음: 오래 기다린 것부터(지금 상태가 된 시각 오름차순). total은 상태별 전체 수의 합 — 상태별 100대까지만 받는다 */
+export interface InspectionQueue {
+  items: TerminalView[];
+  total: number;
+}
+
+/**
+ * 검수 대기(RECEIVED·RETURNED). 기존 단말기 목록 API를 상태마다 한 번씩 부른다(decisions/0063 — 전용 엔드포인트를 만들지 않음).
+ * 목록 API는 최근 등록 순이라 합친 뒤 오래 기다린 것부터 다시 줄 세운다.
+ */
+export function useInspectionQueue() {
+  return useQuery({
+    queryKey: keys.queue,
+    queryFn: async (): Promise<InspectionQueue> => {
+      const pages = await Promise.all(INSPECTION_QUEUE_STATUSES.map((status) => api<TerminalPage>('/terminals', { query: { status, size: 100 } })));
+      const items = pages.flatMap((p) => p.items).sort((a, b) => a.statusChangedAt.localeCompare(b.statusChangedAt) || a.serialNo.localeCompare(b.serialNo));
+      return { items, total: pages.reduce((n, p) => n + p.total, 0) };
+    },
+  });
+}
+
+/** 단말기 한 대(검수할 수 있는지는 서버가 계산한 actions.inspect — decisions/0040) */
+export function useTerminal(serialNo: string) {
+  return useQuery({ queryKey: keys.terminal(serialNo), queryFn: () => api<TerminalDetail>(`/terminals/${encodeURIComponent(serialNo)}`) });
+}
+
+/** 모델별 검수 항목(바뀌는 일이 드물어 staleTime 무한) */
+export function useInspectionItems(modelCode: string | undefined) {
+  return useQuery({
+    queryKey: keys.items(modelCode ?? ''),
+    queryFn: () => api<InspectionItemView[]>('/inspection-items', { query: { modelCode } }),
+    enabled: modelCode !== undefined,
+    staleTime: Infinity,
+  });
+}
```

`apps/field/src/pages/InspectionQueuePage.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useInspectionQueue } from '../api/queries';
import { ErrorBox } from '../components/ErrorBox';
import { formatKstShort } from '../lib/format';
import { QUEUE_KIND_LABEL } from '../lib/labels';

/**
 * 검수 대기(보강 4). 위: 시리얼을 스캔(키보드 웨지 + Enter)하면 그 단말기 검수 화면으로 바로 간다 — 손에 든 단말기부터 검수한다.
 * 아래: 기다리는 단말기(새 입고·회수 입고, 오래 기다린 것부터). 목록에 없어도 스캔으로 찾을 수 있다(검수할 수 있는지는 서버가 정한다).
 */
export function InspectionQueuePage() {
  const navigate = useNavigate();
  const queue = useInspectionQueue();
  const [draft, setDraft] = useState('');
  const find = (event: FormEvent) => {
    event.preventDefault();
    const serial = draft.trim();
    if (serial) navigate(`/inspections/${encodeURIComponent(serial)}`);
  };
  const shown = queue.data?.items.length ?? 0;
  return (
    <section>
      <h1>검수</h1>
      <form className="scan-input" onSubmit={find}>
        <label>
          시리얼 스캔으로 찾기
          <input
            autoFocus
            value={draft}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="go"
            onChange={(e) => setDraft(e.target.value)}
          />
        </label>
        <button type="submit" disabled={!draft.trim()}>
          찾기
        </button>
      </form>

      <h2>검수 대기 {queue.data ? `${queue.data.total}대` : ''}</h2>
      <ErrorBox error={queue.error} />
      {queue.data && queue.data.total > shown ? <p className="muted">{queue.data.total}대 중 오래 기다린 순으로 {shown}대만 보입니다(상태별 최근 100대).</p> : null}
      {queue.data && shown === 0 ? <p className="muted">검수할 단말기가 없습니다.</p> : null}
      <ul className="queue">
        {queue.data?.items.map((t) => (
          <li key={t.serialNo}>
            <Link className="queue-item" to={`/inspections/${encodeURIComponent(t.serialNo)}`}>
              <span className="serial">{t.serialNo}</span>
              <span className="badge">{QUEUE_KIND_LABEL[t.status as keyof typeof QUEUE_KIND_LABEL] ?? t.status}</span>
              <small className="muted">
                {t.modelCode} · {formatKstShort(t.statusChangedAt)}부터
              </small>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

`apps/field/src/pages/InspectPage.tsx`(저장 결과는 화면 상태로 따로 — 저장 뒤 다시 읽은 단말기는 더 이상 검수 대기가 아니라 체크리스트가 사라진다):

```tsx
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { InspectionItemView, InspectionResultInput, InspectRequest, InspectResult, TerminalDetail } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { useInspectionItems, useTerminal } from '../api/queries';
import { keys } from '../api/query-keys';
import { ErrorBox } from '../components/ErrorBox';
import { TERMINAL_STATUS_LABEL } from '../lib/labels';

/** 시리얼이 바뀌면(다음 단말기) 고른 값·메모를 처음으로 — key로 다시 그린다 */
export function InspectPage() {
  const serialNo = useParams().serialNo ?? '';
  return <Inspect key={serialNo} serialNo={serialNo} />;
}

/** 메모 최대 길이(api InspectionResultDto note `@Length(0, 200)`) */
const NOTE_MAX = 200;

/**
 * 단말기 한 대 검수(F13, 보강 4). 모델 체크리스트 항목마다 합격/불합격을 고르고(처음엔 비어 있다 — 안 보고 저장하지 않게), 불합격이면 메모.
 * 검수할 수 있는지는 서버가 전이 표에서 계산한 `actions.inspect`로 본다(decisions/0040). 저장은 기존 API — 하나라도 불합격이면 서버가 DEFECTIVE로 바꾼다.
 */
function Inspect({ serialNo }: { serialNo: string }) {
  const terminal = useTerminal(serialNo);
  const items = useInspectionItems(terminal.data?.actions.inspect ? terminal.data.modelCode : undefined);
  /** 저장 결과. 저장 뒤 다시 읽은 단말기는 더 이상 검수 대기가 아니므로(INSPECTED·DEFECTIVE) 결과는 여기 따로 들고 있는다 */
  const [saved, setSaved] = useState<{ result: InspectResult; labels: string[] } | null>(null);

  if (saved) return <Saved serialNo={serialNo} {...saved} />;

  return (
    <section>
      <p>
        <Link to="/inspections">← 검수 대기</Link>
      </p>
      <h1 className="serial-title">{serialNo}</h1>
      <ErrorBox error={terminal.error} />
      {terminal.data ? <TerminalHead terminal={terminal.data} /> : terminal.isPending ? <p className="muted">불러오는 중…</p> : null}
      {terminal.data && !terminal.data.actions.inspect ? (
        <p className="notice">검수 대기 단말기가 아닙니다(지금 상태: {TERMINAL_STATUS_LABEL[terminal.data.status]}). 다른 단말기를 스캔하세요.</p>
      ) : null}
      <ErrorBox error={items.error} />
      {terminal.data?.actions.inspect && items.data ? <Checklist serialNo={serialNo} items={items.data} onSaved={setSaved} /> : null}
    </section>
  );
}

function TerminalHead({ terminal }: { terminal: TerminalDetail }) {
  return (
    <p className="muted">
      {terminal.modelName}({terminal.modelCode}) · {TERMINAL_STATUS_LABEL[terminal.status]}
    </p>
  );
}

function Checklist({
  serialNo,
  items,
  onSaved,
}: {
  serialNo: string;
  items: InspectionItemView[];
  onSaved: (saved: { result: InspectResult; labels: string[] }) => void;
}) {
  const client = useQueryClient();
  const [passed, setPassed] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const inspect = useMutation({
    mutationFn: (results: InspectionResultInput[]) =>
      api<InspectResult>(`/terminals/${encodeURIComponent(serialNo)}/inspections`, { method: 'POST', body: { results } satisfies InspectRequest }),
    onSuccess: (result) => onSaved({ result, labels: items.filter((item) => result.failedItems.includes(item.code)).map((item) => item.label) }),
    // 성공·실패 모두 다시 읽는다: 성공이면 대기·오늘 요약이 바뀌고, 실패(422 등)는 대개 "그새 다른 사람이 검수했다 = 화면이 낡았다"
    onSettled: () => void client.invalidateQueries({ queryKey: keys.all }),
  });

  const done = items.every((item) => passed[item.code] !== undefined);
  const save = () =>
    inspect.mutate(
      items.map((item) => {
        const note = passed[item.code] ? '' : (notes[item.code] ?? '').trim();
        return { itemCode: item.code, passed: passed[item.code], ...(note ? { note } : {}) };
      }),
    );

  return (
    <div>
      <button type="button" onClick={() => setPassed(Object.fromEntries(items.map((item) => [item.code, true])))} disabled={inspect.isPending}>
        모두 합격
      </button>
      <ul className="checklist">
        {items.map((item) => (
          <li key={item.code}>
            <div className="check-row" role="group" aria-label={item.label}>
              <span className="check-label">{item.label}</span>
              <div className="segmented">
                <button type="button" className="pass" aria-pressed={passed[item.code] === true} onClick={() => setPassed({ ...passed, [item.code]: true })}>
                  합격
                </button>
                <button type="button" className="fail" aria-pressed={passed[item.code] === false} onClick={() => setPassed({ ...passed, [item.code]: false })}>
                  불합격
                </button>
              </div>
            </div>
            {passed[item.code] === false ? (
              <input
                aria-label={`${item.label} 메모`}
                placeholder="불합격 이유(선택)"
                maxLength={NOTE_MAX}
                value={notes[item.code] ?? ''}
                onChange={(e) => setNotes({ ...notes, [item.code]: e.target.value })}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <ErrorBox error={inspect.error} />
      <button type="button" className="primary" disabled={!done || inspect.isPending} onClick={save}>
        {done ? '검수 결과 저장' : `남은 항목 ${items.filter((item) => passed[item.code] === undefined).length}개`}
      </button>
    </div>
  );
}

function Saved({ serialNo, result, labels }: { serialNo: string; result: InspectResult; labels: string[] }) {
  return (
    <section>
      <h1 className="serial-title">{serialNo}</h1>
      <div className={result.passed ? 'result ok' : 'result danger'} role="status">
        <strong>{result.passed ? '합격 — 검수 완료' : '불합격 — 불량으로 바뀜'}</strong>
        {labels.length ? <p>불합격 항목: {labels.join(', ')}</p> : null}
      </div>
      <Link className="big-button" to="/inspections">
        다음 단말기
      </Link>
    </section>
  );
}
```

`apps/field/src/App.tsx`:

```diff
diff --git a/apps/field/src/App.tsx b/apps/field/src/App.tsx
index 7498f9f..40c17b0 100644
--- a/apps/field/src/App.tsx
+++ b/apps/field/src/App.tsx
@@ -3,6 +3,8 @@ import { AuthGate } from './components/AuthGate';
 import { SessionCacheSync } from './components/SessionCacheSync';
 import { Shell } from './components/Shell';
 import { HomePage } from './pages/HomePage';
+import { InspectionQueuePage } from './pages/InspectionQueuePage';
+import { InspectPage } from './pages/InspectPage';
 import { LoginPage } from './pages/LoginPage';
 import { ScanPage } from './pages/ScanPage';
 
@@ -22,6 +24,8 @@ export function App() {
         >
           <Route index element={<HomePage />} />
           <Route path="scan" element={<ScanPage />} />
+          <Route path="inspections" element={<InspectionQueuePage />} />
+          <Route path="inspections/:serialNo" element={<InspectPage />} />
           <Route path="*" element={<p>없는 화면입니다.</p>} />
         </Route>
       </Routes>
```

`apps/field/src/styles.css` 끝에 덧붙인다:

```diff
diff --git a/apps/field/src/styles.css b/apps/field/src/styles.css
index b574720..a96d22a 100644
--- a/apps/field/src/styles.css
+++ b/apps/field/src/styles.css
@@ -338,3 +338,88 @@ legend {
   gap: 8px;
   margin-top: 12px;
 }
+
+/* 검수(Task 4): 대기 목록, 항목마다 합격/불합격, 결과 */
+ul.queue,
+ul.checklist {
+  list-style: none;
+  margin: 0;
+  padding: 0;
+}
+
+.queue-item {
+  display: flex;
+  flex-wrap: wrap;
+  align-items: center;
+  gap: 4px 8px;
+  min-height: 56px;
+  padding: 8px 12px;
+  margin-bottom: 8px;
+  background: var(--card);
+  border: 1px solid var(--line);
+  border-radius: 12px;
+  color: inherit;
+  text-decoration: none;
+}
+
+.queue-item .serial {
+  flex: 1;
+  font-family: ui-monospace, Consolas, monospace;
+  font-weight: 700;
+  word-break: break-all;
+}
+
+.queue-item small {
+  flex-basis: 100%;
+}
+
+.serial-title {
+  font-family: ui-monospace, Consolas, monospace;
+  word-break: break-all;
+}
+
+.checklist li {
+  padding: 8px 0;
+  border-bottom: 1px solid var(--line);
+}
+
+.check-row {
+  display: flex;
+  flex-wrap: wrap;
+  align-items: center;
+  gap: 8px;
+}
+
+.check-label {
+  flex: 1 1 120px;
+  font-weight: 600;
+}
+
+.check-row .segmented {
+  flex: 1 1 200px;
+  margin: 0;
+}
+
+.segmented button.fail[aria-pressed='true'] {
+  background: var(--danger);
+  border-color: var(--danger);
+}
+
+.result {
+  margin: 12px 0;
+  padding: 16px;
+  border-radius: 12px;
+  border: 2px solid var(--line);
+  background: var(--card);
+  font-size: 18px;
+}
+
+.result.ok {
+  border-color: var(--ok);
+  color: var(--ok);
+}
+
+.result.danger {
+  border-color: var(--danger);
+  color: var(--danger);
+}
```

- [ ] **Step 3: 통과 확인과 빌드, 다른 앱**

```bash
(cd apps/field && npx vitest run && npm run build && rm -rf dist)
(cd apps/merchant && npx vitest run 2>&1 | tail -4)   # 사본의 원본 — 그대로
```

Expected: field `Test Files  6 passed (6)`, `Tests  39 passed (39)`(검수 7 더함), build 성공. merchant `7 passed`·`47 passed`.

- [ ] **Step 4: 기록**

`docs/decisions/0064-현장-입력은-키보드-웨지-카메라는-생략.md` 끝에 절 하나:

````markdown
## Task 4 보탬 (검수 입력)

- 검수 대기 화면 위에 "시리얼 스캔으로 찾기" 입력칸(처음 초점) — 손에 든 단말기를 찍으면(Enter) `/inspections/:serialNo`로 간다. 목록에 없어도(100대 밖) 찾는다. 검수할 수 있는지는 서버의 `actions.inspect`(decisions/0040, 0063)
- 체크리스트는 항목마다 합격/불합격 두 버튼(`aria-pressed`)이고 **처음엔 아무것도 고르지 않은 상태** — 다 골라야 저장 버튼이 켜진다("남은 항목 N개"). 버린 것: 어드민처럼 모두 합격으로 시작하고 불합격만 표시(보지 않고 저장해도 합격이 된다 — 현장은 빨리 누르다 놓치기 쉽다). 대신 "모두 합격" 버튼 하나로 빠르게 고른다(누른 사람이 고른 것)
- 메모는 불합격을 고른 항목에만 보인다(200자, api `note` 길이). 합격으로 바꾸면 그 항목 메모는 보내지 않는다
- 저장이 성공하면 결과(합격 — 검수 완료 / 불합격 — 불량으로 바뀜 + 불합격 항목)와 "다음 단말기"(검수 대기로, 찾기 칸에 초점). 저장 뒤 다시 읽은 단말기는 더 이상 검수 대기가 아니므로 결과는 화면 상태로 따로 든다. 실패하면(대개 그새 다른 사람이 검수 — 422) 단말기를 다시 읽어 "검수 대기 단말기가 아닙니다(지금 상태: …)"를 보인다(어드민 decisions/0041 Task 7 리뷰와 같은 방향)
- 시리얼이 바뀌면(다음 단말기) 고른 값을 처음으로 — 화면을 `key={serialNo}`로 다시 그린다
````

devlog 항목:

```markdown
## HH:MM Task 4 검수 — 검수 대기·시리얼 스캔으로 찾기·체크리스트·저장·결과 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <Task 3 커밋 해시> (feat(field, F6): 현장 박스 스캔)
- 한 일: 검수 대기(`GET /terminals?status=RECEIVED·RETURNED&size=100`을 합쳐 오래 기다린 순, 100대 넘으면 알림), 시리얼 스캔으로 찾기(Enter → `/inspections/:serialNo`), 검수 화면(`actions.inspect`로 가능 여부, 항목마다 합격/불합격 — 처음엔 비어 있음·모두 합격 버튼, 불합격이면 메모 200자, 저장 → 합격/불량 결과·다음 단말기, 실패면 다시 읽어 지금 상태), `lib/labels.ts`
- 확인: 처음 실패 8개(경로 없음·`keys.terminal is not a function`) → `Test Files  6 passed`, `Tests  39 passed`, build 성공. merchant 7/47 그대로
- 결정: decisions/0064 Task 4 보탬(체크리스트는 처음 비어 있음, 메모는 불합격만, 결과는 따로 들기)
- 다음: Task 5 마감
```

```bash
node scripts/docs-index.mjs
```

- [ ] **Step 5: 커밋**

```bash
git add apps/field docs
git commit -m "$(cat <<'EOF'
feat(field, F13): 현장 검수 — 검수 대기·시리얼 스캔으로 찾기·체크리스트·결과

Refs: docs/decisions/0064-현장-입력은-키보드-웨지-카메라는-생략.md, docs/decisions/0063-현장-API는-오늘-내-작업-하나만.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 제목 시각 = 커밋 시각인지 보고, 다르면 고쳐 amend.

---


### Task 5: 마감 — 전체 검증, 실서버 확인, launch.json, README·회고·색인

**Files:**
- Modify: `README.md`, `docs/retrospective.md`, `docs/index.md`, `docs/devlog/2026-10-28.md`
- 저장소 밖(커밋 안 함): `C:\Devhyun\History\.claude\launch.json`, 저장소 `.claude/launch.json`(gitignore)

- [ ] **Step 1: 전체 검증**

```bash
# 시작 전 node PID를 적어 둔다
tasklist //FI "IMAGENAME eq node.exe" //FO CSV //NH
# 테스트 DB를 새로 만든 뒤(안전 규칙)
(cd apps/api && npx tsc --noEmit -p tsconfig.json && npm run build && npx vitest run > /tmp/field-final-api.log 2>&1; grep -E "Test Files|Tests |Duration" /tmp/field-final-api.log; grep -c "Connection is closed" /tmp/field-final-api.log)
(cd apps/admin && npx vitest run 2>&1 | tail -4 && npm run build && rm -rf dist)
(cd apps/merchant && npx vitest run 2>&1 | tail -4 && npm run build && rm -rf dist)
(cd apps/field && npx vitest run 2>&1 | tail -4 && npm run build && rm -rf dist)
(cd apps/device-sim && npx tsc --noEmit -p tsconfig.json && npx vitest run 2>&1 | tail -4)
(cd apps/partners && npx vitest run 2>&1 | tail -4)
(cd apps/api && npm run db:migration:check)   # 개발 DB 읽기 — 이 계획은 마이그레이션이 없다
```

Expected(사전 검증 값): api `Test Files  82 passed (82)`·`Tests  567 passed (567)`(Duration 327.19s), `Connection is closed` 0. admin `14 passed`·`125 passed`, build 성공(contracts에 `field.ts`가 늘어도 tsc 0). merchant `7 passed`·`47 passed`, build 성공. field `6 passed`·`39 passed`, build 성공. device-sim `5`·`46`, tsc 0. partners `6`·`53`. `db:migration:check` → `최신 상태`(exit 0). `git status --short --ignored apps/api/src/migrations`에 `.snapshot-terminal_ops_test.json`이 없어야 한다(있으면 지운다 — troubleshooting/0032).

- [ ] **Step 2: 실서버 확인 — 테스트 DB로 띄운 api + 현장 개발 서버 프록시**

포트가 비어 있는지 먼저 본다: `netstat -ano | grep -E ':(3100|5175) .*LISTENING'` → 출력 없음.

테스트 DB(Step 1 뒤 표가 있다)를 다시 만들고 스키마·기준 데이터·시연 계정을 넣는다(쓰기는 테스트 DB만):

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
API_PORT=3100 MYSQL_DATABASE=terminal_ops_test RUN_WORKERS=0 RUN_SCHEDULERS=0 QUEUE_PREFIX=field-live node --env-file=.env apps/api/dist/main.js
# (2) apps/field 폴더에서
FIELD_API_URL=http://localhost:3100 node node_modules/vite/bin/vite.js
```

`netstat -ano | grep -E ':(3100|5175) .*LISTENING'`으로 둘 다 뜬 것과 PID를 본다(vite는 `[::1]:5175`). 아래 스크립트를 저장소 **밖** 임시 파일(예: 세션 scratchpad의 `field-live.sh`)에 Write로 만들고 저장소 루트에서 `bash <경로>/field-live.sh 3100 5175`로 돌린다. 비밀번호는 seed 파일에서 변수로만 읽고 출력하지 않는다. 박스 스캔은 회수 입고로 한다 — 발주분 입고는 가상 업체 서버(세움전자 납품 명세)가, 회수 중 단말기를 만드는 출고는 택배 업체가 필요해 이 확인에서는 띄우지 않는다(행별 거절도 "박스 처리·다시 보내기·오늘 요약"을 보기에 충분하다. 입고·회수 입고 성공 행은 e2e `field.e2e.spec.ts`가 본다).

```bash
#!/bin/bash
# 현장 화면 실서버 확인(테스트 DB api + 현장 개발 서버 프록시). 저장소 루트에서 실행. 인자: api 포트, 현장 개발 서버 포트(기본 3100 5175)
API_PORT=${1:-3100}; WEB_PORT=${2:-5175}
SEED=apps/api/src/db/seed-accounts.ts
pw() { node -e "const s=require('fs').readFileSync(process.argv[1],'utf8');const m=s.match(new RegExp(\"loginId: '\"+process.argv[2]+\"'[^}]*password: '([^']+)'\"));process.stdout.write(m[1])" "$SEED" "$1"; }
OP_PW=$(pw operator); F_PW=$(pw field)
J=$(mktemp -d)
API=http://localhost:$API_PORT; WEB=http://localhost:$WEB_PORT/api
login() { curl -s -c "$2" -o /dev/null -w "%{http_code}" -H 'Content-Type: application/json' -d "{\"loginId\":\"$1\",\"password\":\"$3\"}" "$4/auth/login"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "index.html: $(code http://localhost:$WEB_PORT/) $(curl -s http://localhost:$WEB_PORT/ | grep -o '<title>[^<]*</title>')"
echo "proxy /api/health: $(curl -s $WEB/health)"
echo "no login /api/field/today: $(curl -s -w ' %{http_code}' $WEB/field/today)"

# 운영자(api 직접)로 검수 대기 단말기 하나(RECEIVED)를 만든다(테스트 DB 쓰기)
echo "operator login: $(login operator $J/op "$OP_PW" $API)"
H=(-b $J/op -H 'Content-Type: application/json')
echo "register LIVE-F-0001: $(code "${H[@]}" -d '{"serialNo":"LIVE-F-0001","modelCode":"SN-100"}' $API/terminals)"
echo "operator /field/today (403): $(code -b $J/op $API/field/today)"

# 현장 작업자는 현장 개발 서버의 프록시로만
F=(-b $J/f -H 'Content-Type: application/json')
echo "field login via proxy: $(login field $J/f "$F_PW" $WEB)"
echo "httpOnly cookie lines: $(grep -c 'HttpOnly_' $J/f)"
echo "auth/me: $(curl -s -b $J/f $WEB/auth/me)"
echo "field/today (before): $(curl -s -b $J/f $WEB/field/today)"
echo "queue RECEIVED: $(curl -s -b $J/f "$WEB/terminals?status=RECEIVED&size=100" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.total+' '+j.items.map(i=>i.serialNo).join(','))})")"
echo "open orders ORDERED: $(code -b $J/f "$WEB/purchase-orders?status=ORDERED&limit=100")"
# 회수 입고 박스: 회수 중이 아닌 단말기·없는 단말기 → 행별 거절(박스는 처리됨), 같은 scanId 다시 보내기 → 200 replayed
BOX='{"scanId":"BOX-LIVE-F-0001","kind":"RETURN_IN","serials":["LIVE-F-0001","NOPE-0001"]}'
echo "scan RETURN_IN: $(curl -s -w ' %{http_code}' "${F[@]}" -d "$BOX" $WEB/scans)"
R=$(curl -s -w ' %{http_code}' "${F[@]}" -d "$BOX" $WEB/scans)
echo "scan again (same scanId): $(echo "$R" | grep -o '"replayed":[a-z]*') ${R##* }"
echo "terminal LIVE-F-0001 actions: $(curl -s -b $J/f $WEB/terminals/LIVE-F-0001 | grep -o '"actions":{[^}]*}')"
echo "inspection-items SN-100: $(curl -s -b $J/f "$WEB/inspection-items?modelCode=SN-100" | grep -o '"code":"[A-Z_]*"' | tr '\n' ' ')"
echo "inspect (PRINTER fail): $(curl -s -w ' %{http_code}' "${F[@]}" -d '{"results":[{"itemCode":"POWER","passed":true},{"itemCode":"NETWORK","passed":true},{"itemCode":"CARD_READER","passed":true},{"itemCode":"PRINTER","passed":false,"note":"용지 걸림"}]}' $WEB/terminals/LIVE-F-0001/inspections | grep -o '"passed":[a-z]*,"failedItems":\[[^]]*\]\|"status":"[A-Z_]*"\| [0-9]*$' | tr '\n' ' ')"
echo "field/today (after): $(curl -s -b $J/f $WEB/field/today)"
echo "field /dashboard/summary (403): $(code -b $J/f $WEB/dashboard/summary)"
echo "field POST /terminals (403): $(code "${F[@]}" -d '{"serialNo":"LIVE-F-0002","modelCode":"SN-100"}' $WEB/terminals)"
echo "logout: $(code -X POST -b $J/f $WEB/auth/logout) then /field/today $(code -b $J/f $WEB/field/today)"
curl -s -o /dev/null -X POST -b $J/op $API/auth/logout
rm -rf $J
```

Expected(사전 검증 원문, 포트 3200·5176·시각만 다름):

```text
index.html: 200 <title>단말온 현장</title>
proxy /api/health: {"status":"ok"}
no login /api/field/today: {"statusCode":401,"code":"UNAUTHENTICATED","message":"로그인이 필요합니다(세션이 없거나 끝났습니다)."} 401
operator login: 200
register LIVE-F-0001: 201
operator /field/today (403): 403
field login via proxy: 200
httpOnly cookie lines: 1
auth/me: {"loginId":"field","displayName":"현장 작업자(시연)","role":"FIELD","merchantCode":null}
field/today (before): {"date":"2026-10-28","scans":{"boxes":0,"received":0,"returned":0,"rejected":0},"inspections":{"total":0,"passed":0,"failed":0}}
queue RECEIVED: 1 LIVE-F-0001
open orders ORDERED: 200
scan RETURN_IN: {"scanId":"BOX-LIVE-F-0001","kind":"RETURN_IN","poNo":null,"actor":"field","replayed":false,"createdAt":"2026-10-28T04:40:41.525Z","summary":{"INVALID_STATE":1,"NOT_FOUND":1},"results":[{"serialNo":"LIVE-F-0001","result":"INVALID_STATE","message":"허용되지 않은 전이입니다: RECEIVED → RETURNED"},{"serialNo":"NOPE-0001","result":"NOT_FOUND","message":"등록되지 않은 시리얼입니다."}]} 201
scan again (same scanId): "replayed":true 200
terminal LIVE-F-0001 actions: "actions":{"allocate":false,"cancelAllocation":false,"ship":false,"inspect":true}
inspection-items SN-100: "code":"POWER" "code":"NETWORK" "code":"CARD_READER" "code":"PRINTER" 
inspect (PRINTER fail): "passed":false,"failedItems":["PRINTER"] "status":"DEFECTIVE"  201 
field/today (after): {"date":"2026-10-28","scans":{"boxes":1,"received":0,"returned":0,"rejected":2},"inspections":{"total":1,"passed":0,"failed":1}}
field /dashboard/summary (403): 403
field POST /terminals (403): 403
logout: 204 then /field/today 401
```

**컨트롤러 확인 요청**(devlog에 "컨트롤러 확인 대기"로 적는다): 두 서버가 떠 있는 동안 컨트롤러가 내장 브라우저로 `http://localhost:5175/login`을 열어 휴대폰 크기(375×812)에서 `field`로 로그인 → 홈(오늘 내 작업) → 박스 스캔(회수 입고, 입력칸에 시리얼을 치고 Enter — 목록에 쌓이고 초점이 남는지, 중복·형식 오류 표시) → 검수(대기 목록, 시리얼 찾기, 체크리스트)를 본다. 다른 앱(:5173·:5174)과 쿠키를 함께 쓰므로 그 탭들의 세션은 끝난다(안전 규칙). 사전 검증에서는 로그인 화면만 375 폭으로 봤다(`scrollWidth` 375, 로그인 버튼 높이 56px, 같은 브라우저에서 `'BarcodeDetector' in window` = `false`). 컨트롤러가 다 봤다고 하면 다음으로.

끄기와 정리:

```bash
netstat -ano | grep -E ':(3100|5175) .*LISTENING'          # PID 두 개
tasklist //FI "PID eq <api PID>" //FO CSV //NH              # node.exe인지
tasklist //FI "PID eq <vite PID>" //FO CSV //NH
taskkill //PID <api PID> //F; taskkill //PID <vite PID> //F
netstat -ano | grep -E ':(3100|5175) .*LISTENING'          # 출력 없음
tasklist //FI "IMAGENAME eq node.exe" //FO CSV //NH          # 시작 전과 같은 PID만
MSYS_NO_PATHCONV=1 docker exec terminal-ops-redis redis-cli --scan --pattern 'field-live*'   # 본 키만 하나씩 DEL
# MSYS_NO_PATHCONV=1 docker exec terminal-ops-redis redis-cli DEL <키>   (키마다, 사전 검증에서는 큐 meta 6개 — 세션은 로그아웃으로 지워졌다)
# 마지막으로 테스트 DB를 빈 DB로 다시 만든다(안전 규칙)
```

- [ ] **Step 3: launch.json(커밋 안 함)**

세션 루트 `C:\Devhyun\History\.claude\launch.json`과 저장소 `.claude/launch.json` **둘 다** `configurations` 끝(`terminal-ops-merchant` 뒤)에 같은 항목을 더한다(Edit 도구, JSON 쉼표 주의):

```json
    {
      "name": "terminal-ops-field",
      "runtimeExecutable": "node",
      "runtimeArgs": [
        "C:/Devhyun/History/ToyProject/terminal-ops/apps/field/node_modules/vite/bin/vite.js",
        "C:/Devhyun/History/ToyProject/terminal-ops/apps/field"
      ],
      "port": 5175
    }
```

`node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" <파일>`로 두 파일 모두 JSON이 맞는지 본다. `git status --short`에 `.claude/`가 나오지 않아야 한다(gitignore).

- [ ] **Step 4: README**

`README.md`에서 아래를 바꾼다(Edit 도구, 각 줄 그대로 찾아 바꾼다).

1. 구성 — `merchant/` 줄 아래에 한 줄을 더하고, contracts 줄의 "api·어드민·매장 화면이"를 "api·어드민·매장·현장 화면이"로:
   ```
   │  ├─ field/             현장 작업자 화면 — 휴대폰·PDA 폭, 바코드 스캐너(키보드 웨지) 입력, 점주 앱과 같은 스택·같은 판(Vite 프록시 /api → api, 보강 4)
   ```
2. 설치 줄:
   ```
   for a in api admin merchant field partners device-sim; do (cd apps/$a && npm ci); done   # api·admin·merchant·field는 packages/contracts를 링크한다(따로 설치하지 않는다)
   ```
3. 실행 블록의 `(cd apps/merchant && npm run dev)` 줄 아래에:
   ```
   (cd apps/field && npm run dev)                         # :5175 → 휴대폰 크기로 http://localhost:5175/login (현장 작업자 계정 field)
   ```
4. 타입 검사 줄의 "admin·merchant `npm run build`(tsc 포함)"를 "admin·merchant·field `npm run build`(tsc 포함)"로.
5. "로그인과 역할"의 FIELD 줄을:
   ```
   - **FIELD**: 현장 작업자 — 박스 스캔·검수와 그에 필요한 조회. 화면은 현장 화면 `apps/field`(:5175, 보강 4 — [decisions/0061](docs/decisions/0061-현장-화면은-별도-앱-apps-field.md)). 어드민의 박스 스캔·검수도 그대로 쓸 수 있다
   ```
6. "매장 화면(보강 3)" 절 끝(마지막 `- 점주에게 보이는 단말기는 …` 줄 뒤, `## 기능` 앞)에 절 하나:
   ```markdown
   ## 현장 화면(보강 4)

   창고·물류 현장 작업자가 휴대폰·PDA로 쓰는 화면이다. `http://localhost:5175/login`에 위 표의 `field` 계정으로 들어간다(다른 계정이면 안내와 로그아웃만).

   - 홈: 오늘(KST) 내가 처리한 박스·입고·회수 입고·검수 수(`GET /field/today`, [decisions/0063](docs/decisions/0063-현장-API는-오늘-내-작업-하나만.md))와 큰 버튼 둘
   - 박스 스캔: 발주분 입고(열린 발주 고르기)·회수 입고. 바코드 스캐너(키보드 웨지 — 시리얼 + Enter)나 손 입력·붙여 넣기로 목록에 쌓이고, 중복·형식 오류는 그 줄에 바로 보인다. 보낸 박스는 잠기고, 응답을 못 받으면 같은 박스 번호(scanId)로 다시 보낸다(어드민과 같은 멱등 규칙). 카메라 바코드는 없다([decisions/0064](docs/decisions/0064-현장-입력은-키보드-웨지-카메라는-생략.md))
   - 검수: 검수 대기(새 입고·회수 입고, 오래 기다린 순), 시리얼 스캔으로 바로 찾기, 항목마다 합격/불합격(+ 불합격 메모), 저장 → 합격/불량
   - api 클라이언트·세션 코드는 점주 앱 사본이고 `src/copies.test.ts`가 코드가 같은지 본다([decisions/0062](docs/decisions/0062-세-번째-화면도-복사와-사본-검사-테스트로.md))
   - 시연 팁: 어드민(:5173)·매장(:5174)·현장(:5175)은 localhost에서 쿠키(`sid`) 하나를 함께 쓴다 — 동시에 다른 계정으로 보려면 브라우저 프로필을 나눈다
   ```
7. 기능 표의 `| 매장 화면(보강 3) | …` 줄 아래에:
   ```
   | 현장 화면(보강 4) | 오늘 내 작업, 박스 스캔(스캐너 입력·중복·형식 표시·scanId 멱등·줄마다 결과), 검수 대기·시리얼 찾기·체크리스트. `GET /field/today` | `apps/field/src/`, `apps/api/src/field/` |
   ```
8. 기록 색인 줄 "결정 60·트러블슈팅 32·실험 17" → "결정 64·트러블슈팅 32·실험 17"(Task 중 트러블슈팅이 생겼으면 실제 수 — `node scripts/docs-index.mjs` 출력).
9. 테스트 절 설명과 표(Step 1에서 센 실제 값으로):
   ```markdown
   (보강 4 현장 화면 뒤 실제로 돌려 센 값(2026-10-28). api는 실험 파일 제외 — 실험은 `EXPERIMENTS=1`에서만 돈다. 보강 3 뒤에는 api 80/561·merchant 7/47, 보강 2 뒤에는 api 79/549, 보강 1 뒤에는 api 66/453, admin 12/109, device-sim 4/40이었다)

   | 앱 | 파일 | 테스트 |
   |---|---|---|
   | api(실험 제외) | 82 | 567 |
   | admin | 14 | 125 |
   | merchant | 7 | 47 |
   | field | 6 | 39 |
   | partners | 6 | 53 |
   | device-sim | 5 | 46 |
   ```

- [ ] **Step 5: 회고**

`docs/retrospective.md` 6장 "7일 뒤 보강"의 보강 3 항목(두 줄 — `- [x] **보강 3: …`와 그 아래 `  - 보강 3이 남긴 것: …`) 뒤에:

```markdown
- [x] **보강 4: 현장 작업자 화면** — 창고 현장 작업자가 휴대폰·PDA로 쓰는 별도 앱 `apps/field`([0061](decisions/0061-현장-화면은-별도-앱-apps-field.md), 점주 앱 lock 복사). 화면 앱이 셋이 되어 0058을 다시 봤다 — 공유 패키지를 두 앱에 실제로 붙여 비용(앱마다 dedupe·paths·lock·다시 내보내기, 어드민 사본은 남음)을 재고 복사 유지 + 사본 검사 테스트로([0062](decisions/0062-세-번째-화면도-복사와-사본-검사-테스트로.md)). 서버는 `GET /field/today` 하나만 새로, 검수 대기는 기존 단말기 목록 두 번([0063](decisions/0063-현장-API는-오늘-내-작업-하나만.md)). 스캐너는 키보드 웨지(입력칸 + Enter), 여러 줄 붙여 넣기는 바로 목록으로(한 줄 입력칸이 줄바꿈을 지움 — 사전 검증), 카메라는 시연 브라우저에 `BarcodeDetector`가 없어 생략, 멱등은 어드민 규칙 그대로([0064](decisions/0064-현장-입력은-키보드-웨지-카메라는-생략.md)). 기존 테스트는 고치지 않았다(접근 표 한 줄). 기록: devlog 2026-10-28 `# 보강 4: 현장 작업자 화면`, [계획](plans/2026-10-28-field-worker.md)
  - 보강 4가 남긴 것: 카메라 바코드 없음(지원 브라우저가 시연 기기가 되면), 오프라인 스캔 없음(PWA + 보낼 박스 대기열 — scanId가 있어 늦게 보내도 멱등), 공통 코드 세 곳(점주·현장은 사본 검사, 어드민은 주석·같은 테스트 값만 — 넷째 앱이나 같은 버그 두 번이면 workspaces), 검수 대기는 상태별 100대까지, `scan_batch`·`inspection`에 (actor, 시각) 인덱스 없음(하루 수백 박스가 되면 재고 더함), 스캐너 접미사가 Tab인 장치는 맞지 않음, 실서버 확인에서 발주분 입고 성공 행은 가상 업체 서버 없이 못 봄(e2e가 봄), 로그인 뒤 화면의 휴대폰 폭은 컨트롤러 눈 확인
```

같은 장 보강 3 "남긴 것" 줄의 `공통 코드 두 벌(같은 버그를 두 번 고치면 workspaces)`를 `공통 코드 두 벌(같은 버그를 두 번 고치면 workspaces — 보강 4에서 세 벌째, 0062)`로.

- [ ] **Step 6: 색인·devlog 마감**

`node scripts/docs-index.mjs --check` → `docs/index.md 최신`(아니면 `node scripts/docs-index.mjs`).

devlog 끝에 항목과 요약:

```markdown
## HH:MM Task 5 보강 4 마감 — 전체 검증, 실서버 확인, launch.json, README·회고 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <Task 4 커밋 해시> (feat(field, F13): 현장 검수)
- 시작 전 node PID: <목록>(이 작업이 띄운 것 아님). 끝난 뒤에도 같은 PID
- 전체 검증: api `Test Files  82 passed (82)`, `Tests  567 passed (567)`, Duration <초>, `Connection is closed` <수>. admin 14/125·build, merchant 7/47·build, field 6/39·build, device-sim 5/46·tsc 0, partners 6/53. 개발 DB `db:migration:check` 최신 상태
- 실서버(테스트 DB, api :3100 `QUEUE_PREFIX=field-live`, 현장 :5175 프록시): (스크립트 출력 요약 — 비밀번호 없이)
- 끔: api PID <…>·vite PID <…>(node.exe 확인 뒤), 3100·5175 LISTENING 0. `field-live*` 키 <N>개 하나씩 DEL. 테스트 DB 빈 DB로
- launch.json: 세션 루트·저장소 `.claude` 둘 다 `terminal-ops-field`(:5175), JSON 확인(커밋 안 함)
- README(구성·설치·실행·타입 검사·FIELD·현장 화면 절·기능 표·색인 수·테스트 표), 회고 6장 보강 4
- 컨트롤러 확인: (대기 / 컨트롤러가 본 것)
- 다음: 컨트롤러 확인. 병합·push 안 함

## 보강 4 요약

**한 일**: 현장 작업자 화면 `apps/field`(오늘 내 작업, 박스 스캔 — 스캐너 입력·중복·형식 표시·scanId 멱등, 검수 대기·시리얼 찾기·체크리스트, 휴대폰 폭), `GET /field/today`.

**커밋**(오래된 것부터 — `git log --oneline 37df12a..HEAD`)
- (해시) docs: 보강 4 계획 — 현장 작업자 화면
- (해시) feat(field, F6, F13): 현장 화면용 오늘 내 작업 API
- (해시) feat(field): 현장 앱 골격
- (해시) feat(field, F6): 현장 박스 스캔
- (해시) feat(field, F13): 현장 검수
- (이 항목이 든 커밋) docs(field): 보강 4 마감

**결정**(decisions/0061~0064)
- 0061 별도 앱(점주 lock, FIELD만), 0062 세 벌째도 복사 + 사본 검사(공유 패키지 두 앱 사전 검증), 0063 새 API는 오늘 내 작업 하나, 0064 키보드 웨지·붙여 넣기·카메라 생략·검수 체크리스트

**숫자**: api 80/561 → 82/567, field 0 → 6/39, admin 14/125·merchant 7/47·device-sim 5/46·partners 6/53 그대로

**찾은 것**: 한 줄 입력칸에 여러 줄을 붙여 넣으면 줄바꿈이 지워져 시리얼이 붙는다(0064), Vite가 `new URL(템플릿, import.meta.url)`을 자산 glob으로 바꿔 다른 앱 파일 읽기가 `Denied ID`로 깨진다(0062), 공유 패키지는 `dedupe`를 빼면 tsc는 통과하고 vitest·build에서 깨진다(0062)

**남은 것**: [retrospective.md 6장 "7일 뒤 보강"](../retrospective.md) 보강 4 항목
```

- [ ] **Step 7: 커밋**

```bash
git add README.md docs
git status --short   # .claude/·node_modules·dist가 없어야 한다
git commit -m "$(cat <<'EOF'
docs(field): 보강 4 마감 — 전체 검증·실서버 확인·README·회고

Refs: docs/decisions/0061-현장-화면은-별도-앱-apps-field.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 시각 = 커밋 시각 확인(다르면 고쳐 amend). 끝나면 안전 규칙의 netstat·tasklist를 다시 본다.

---

## 자체 점검

- 브리프 대응: 1(새 앱 vs 어드민 FIELD 개선 → 0061, 세 벌째 공통 코드 — 공유 패키지 + `resolve.dedupe`/`paths`를 두 앱에 실제로 해 보고 비용 비교 → 0062, 사본 검사 테스트) → Task 2. 2(로그인·오늘 요약(서버 집계 `/field/today`) → Task 1·2. 박스 스캔: RECEIVE(열린 발주)·RETURN_IN, 키보드 웨지·직접 입력, 즉시 목록·중복·형식 표시, scanId 유지·재전송(어드민 규칙), 행별 결과, 카메라는 시연 브라우저에서 확인 후 생략·기록 → Task 3(0064). 검수: 대기 목록(RECEIVED·RETURNED), 시리얼 스캔으로 찾기, 모델별 체크리스트 합격/불합격 + 메모, 저장, 기존 API·전이 규칙 → Task 4. 회수 받기는 RETURN_IN으로 충분해 생략) → 범위 조정. 3(API는 필요한 것만 — `/field/today`, 검수 대기는 기존 `/terminals?status=` 두 번, 역할 규칙·접근 표·contracts) → Task 1(0063). 4(Vitest + Testing Library 키보드 웨지 흉내, api e2e, 375×812는 컨트롤러) → Task 1~5. 5(launch.json 두 곳) → Task 5 Step 3.
- 이름 일치: 계약 `FieldTodayView`(Task 1)를 Task 2 `queries.ts`·`App.test.tsx`가 같은 이름으로. `keys.all`·`keys.today`(Task 2), `keys.openOrders`(Task 3), `keys.queue`·`keys.terminal`·`keys.items`(Task 4) — `query-keys.test.ts`의 목록이 Task마다 같이 는다. `useToday`(Task 2)·`useOpenOrders`(Task 3)·`useInspectionQueue`·`useTerminal`·`useInspectionItems`(Task 4). `describeError`(Task 2 ErrorBox)를 `LogoutButton` 사본이 부른다. `SUCCESS`·`RESULT_LABEL`·`retryable`·`lineProblem`·`splitSerials`·`newScanId`·`MAX_BOX`(Task 3 `lib/scan.ts`). `TERMINAL_STATUS_LABEL`·`INSPECTION_QUEUE_STATUSES`·`QUEUE_KIND_LABEL`(Task 4 `lib/labels.ts`).
- 플레이스홀더 검사: 코드 블록은 모두 사전 검증 커밋에서 뽑은 실제 코드다(Task 1 `fb6c5e9`, 2 `32d4f75`, 3 `d527eb1`, 4 `a906f24` — 임시 폴더 `fieldcheck`, 기준 37df12a). 실행 때 채우는 것은 devlog의 `HH:MM`·해시·Duration·PID·키 수, README 색인 수(트러블슈팅이 생겼을 때)뿐이다.
- 안전: 개발 DB는 Task 5의 `db:migration:check`(읽기)뿐. 실서버 쓰기는 테스트 DB. Redis는 `field-live*` 키만 하나씩. 서버는 단독 node 명령·PID로 끄기. 비밀번호는 seed 파일에서 변수로만.
