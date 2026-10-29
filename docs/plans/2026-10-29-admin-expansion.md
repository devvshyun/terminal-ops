# 보강 5 — 통합 어드민 확장 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **기록 규칙 필수**: 이 저장소의 `CLAUDE.md`를 먼저 읽는다. 모든 Task는 마지막에 `docs/devlog/2026-10-29.md`(`# 보강 5: 통합 어드민 확장` 아래, `## HH:MM 보강 5 계획 작성` 항목 뒤)에 항목을 덧붙이고(제목 시각 = 커밋 시각, 제목 끝에 `(커밋 = 이 항목이 든 커밋)`, 본문 첫 줄 `이전 커밋:`, 한 일·확인·막힌 것·결정·다음), Task에 적힌 결정 기록을 쓴 뒤 `node scripts/docs-index.mjs`로 색인을 다시 만들어 **코드와 같은 커밋**에 넣는다. 작업 중 날짜가 바뀌면 그날 날짜로 새 파일 `docs/devlog/YYYY-MM-DD.md`를 시작하고 첫 줄에 이전 파일을 링크한다. 예상과 다른 에러를 만나면 고치기 전에 `docs/troubleshooting/`에 기록을 시작한다(다음 번호 0033). 이 계획은 실험을 쓰지 않는다(다음 번호 0018). 결정 번호는 0066~0069를 쓴다.

**Goal:** 통합 시연 시나리오의 운영자·ADMIN 단계 중 화면이 없던 것을 운영자 어드민(`apps/admin`)에 채운다 — 단말기 등록(한 대·엑셀 일괄, 행별 결과·CSV), 펌웨어 등록·단계 배포 만들기, ADMIN 계정 관리(목록·만들기·역할 바꾸기·사용 중지), 다른 화면 바로가기(주소는 한 곳). 서버에는 `GET /firmware` 하나만 더한다.

**Architecture:** 화면은 이미 있는 API·DTO·검증·접근 표를 그대로 부른다(decisions/0066). 새 API는 배포 만들기의 버전 선택지용 `GET /firmware`(OFFICE, beforeId 키셋, 표 71 → 72) 하나이고, 화면이 보내는 요청 본문 셋과 엑셀 등록 응답에 contracts 타입을 둔다(DTO `implements`, 서비스 반환 타입). 어드민은 메뉴 "단말기 등록"(운영자)·"계정"(ADMIN)을 더하고, 펌웨어 등록·배포 만들기는 펌웨어 배포 화면의 접힌 폼으로(decisions/0068), 발주는 기존 "발주 입고 대조" 화면 그대로. 왼쪽 메뉴 아래 "다른 화면"은 `src/apps.ts` 한 곳의 목록과 Vite env(`VITE_*_URL`)로(decisions/0067). api 클라이언트는 `PATCH`와 `FormData` 본문을 받는다. 설계 스펙: `docs/specs/2026-10-29-admin-expansion.md`(시연 시나리오 점검표 포함).

**Tech Stack:** api Nest.js 12.2(ESM, NodeNext, vitest 5 + swc), MikroORM 7.2(MySQL 8.4), TypeScript 6.0.3. admin React 19.3 + Vite 8.3.4 + TanStack Query 5.104.2 + react-router 8.4, Vitest 5.0.4 + Testing Library(user-event 14.6.7 — `upload`로 파일 고르기) + jsdom. **새 외부 의존성 없음.**

---

## 프로세스·데이터 안전 규칙 (모든 Task에 적용)

- **프로세스는 PID로만 끈다.** `taskkill /IM node.exe`, `pkill node`처럼 이름으로 끄지 않는다. 서버는 `node …` 단독 명령으로 띄우고 `netstat -ano | grep ':<포트> .*LISTENING'`으로 찾은 Windows PID(그 node 프로세스 자신 — Git Bash 서브셸의 `$!`가 아니다)를 `taskkill //PID <PID> //F`로 끈다. 끄기 전에 `tasklist //FI "PID eq <PID>" //FO CSV //NH`로 node.exe인지 본다.
- **Redis를 통째로 지우지 않는다.** `FLUSHALL`·`FLUSHDB` 금지. api를 직접 띄우는 확인은 `QUEUE_PREFIX`를 따로 주고, 끝나면 `docker exec terminal-ops-redis redis-cli --scan --pattern '<접두사>*'`로 본 키만 하나씩 `DEL`한다.
- **테스트는 테스트 DB(`terminal_ops_test`)에서만.** 개발 DB(`terminal_ops`)는 읽기만 한다(이 계획에는 마이그레이션이 없다 — Task 6의 `db:migration:check`). 실서버 쓰기 확인은 테스트 DB로 띄운 api에서. 테스트 DB를 다시 만드는 명령(셸 없이 한 줄, root 비밀번호는 `.env`에서 변수로 읽고 **출력하지 않는다**):
  ```bash
  PW=$(grep '^MYSQL_ROOT_PASSWORD=' .env | cut -d= -f2- | tr -d '\r')
  MSYS_NO_PATHCONV=1 docker exec -e MYSQL_PWD="$PW" terminal-ops-mysql mysql -uroot -e "DROP DATABASE IF EXISTS terminal_ops_test; CREATE DATABASE terminal_ops_test"
  ```
  브랜치를 오가며 같은 테스트 DB를 쓰면 먼저 이 명령으로 다시 만든다(troubleshooting/0030). Task 6이 끝나면 빈 DB로 남긴다.
- **api 테스트를 두 개 동시에 돌리지 않는다**(globalSetup이 partners를 테스트 포트 4011에 띄운다). admin·merchant·field·device-sim·partners 테스트는 같이 돌려도 된다.
- **오래 도는 서버·백그라운드 명령을 남긴 채 끝내지 않는다.** 끝나면 `netstat -ano | grep -E ':(3000|3100|4010|4011|4012|5173|5174|5175|5176|4173) .*LISTENING'` 출력이 없고 `tasklist //FI "IMAGENAME eq node.exe" //FO CSV //NH`가 시작 전과 같은 PID만 보여야 한다.
- **긴 기록·코드 편집은 Write·Edit 도구로 한다**(troubleshooting/0024).
- **시연 계정 비밀번호는 `apps/api/src/db/seed-accounts.ts`에만 있다.** 명령에 넣을 때는 그 파일에서 변수로 읽고(Task 6 스크립트), devlog·리뷰 보고·화면 캡처 설명에 옮겨 적지 않는다. 실서버 확인에서 새로 만드는 계정의 비밀번호는 스크립트가 무작위로 만들고 출력하지 않는다.
- **localhost 쿠키는 포트를 가리지 않는다**(보강 3 기록): 어드민(:5173)·점주(:5174)·현장(:5175)이 `sid` 하나를 함께 쓴다. "다른 화면" 링크로 건너가 로그인하면 어드민 세션이 끝난다 — 화면에도 그 안내가 있다. 브라우저로 볼 때는 프로필을 나누거나 차례로 본다.

## 사전 검증으로 확인된 사실 (2026-10-29, 임시 폴더)

계획 작성 전에 저장소(브랜치 `admin-expansion`, master 54dc512)를 임시 폴더에 복제해 api·admin·merchant·field·partners·device-sim을 `npm ci`로 설치하고, 이 계획의 코드를 Task 순서대로 적용해 Task마다 커밋하며 돌렸다(테스트 DB `terminal_ops_test`, Redis는 테스트 접두사와 확인용 접두사 `adminx-live`만). 코드 블록은 모두 그 커밋에서 스크립트로 뽑았다(새 파일 = `git show <커밋>:<경로>`, 바꾼 파일 = `git diff <앞 커밋> <커밋> -- <경로>`). Task마다 "실패 확인" 출력은 앞 커밋에 그 Task의 테스트 파일만 얹어 돌린 원문이다.

- **테스트 수(실제로 돌려 센 값)**: api master 82/568 → Task 1 **83/571**(전체 331.96초, `Connection is closed` 0, typecheck 0). admin 14/125 → Task 2 **15/131** → Task 3 **17/141** → Task 4 **18/146** → Task 5 **19/152**(Task마다 tsc 0, build 성공). merchant 7/47·field 7/60 그대로(contracts가 늘어난 뒤 tsc 0·build 성공, 현장 사본 검사 그대로). device-sim 5/46(tsc 0)·partners 6/53 그대로.
- **기존 테스트에서 고친 곳은 없다** — 접근 표(`access-table.spec.ts`)에 한 줄(`'GET /firmware'`, 71 → 72), 어드민 테스트 도구(`test/render.tsx`)가 FormData 본문을 기록하게 한 줄, 쿼리 키 테스트에 단언 한 줄, 클라이언트·틀 테스트 파일에 테스트를 더했다. 관제 메뉴 수(9)·현장 작업자 메뉴(`단말기`, `박스 스캔`)는 그대로다(새 메뉴는 운영자·ADMIN만).
- **발주는 이미 화면이 있다**: "발주 입고 대조"(Day 6)에 발주하기(모델·수량)·목록·대조(명세 수·입고·빠진 것·명세 밖)·마감이 있고 어드민 테스트가 본다(`ReportsPages.test.tsx` "발주를 고르면 대조 …를 보여 주고, 확인하면 마감한다") → 범위 조정.
- **같은 컨트롤러의 메서드 이름 겹침**: 펌웨어 목록 핸들러를 처음에 `list`로 쓰자 `TS2393: Duplicate function implementation`(배포 목록 `list`가 이미 있다) → `listFirmware`(계획 코드에 반영됨).
- **비동기 선택지는 기다린 뒤 고른다**: 모델 목록이 오기 전에 `selectOptions`하면 `TestingLibraryElementError: Value "SN-100" not found in options` → `findByRole('option', …)`로 기다림(계획 테스트에 반영됨). `.csv` 파일 고르기 테스트는 user-event가 `accept`로 걸러 화면 검사까지 가지 않으므로 `userEvent.setup({ applyAccept: false })`.
- **배포 화면의 쓰기 폼은 닫힌 채로 시작한다**: 닫혀 있으면 `/terminal-models`·`/firmware`를 부르지 않아, 그 경로가 없는 기존 배포 화면 테스트(`ServiceAndRollouts.test.tsx`)의 가짜 api가 그대로 맞는다(Task 4 뒤 전체 146 통과).
- **Vite env가 apps.ts까지 온다**: 어드민 개발 서버를 `VITE_MERCHANT_APP_URL=http://merchant.demo:8081`로 띄우자 개발 서버가 내주는 `/src/apps.ts`에 그 주소가 들어 있었다(아래 실서버 출력 둘째 줄). 기본값(:5174·:5175)은 vitest가 본다.
- **실서버 확인(테스트 DB에 `migrate up` + `seed`, 가상 업체 서버 `PARTNERS_PORT=4012`, api `API_PORT=3200 PARTNERS_URL=http://localhost:4012 RUN_WORKERS=0 RUN_SCHEDULERS=0 QUEUE_PREFIX=adminx-live`, 어드민 개발 서버 `ADMIN_API_URL=http://localhost:3200 … --port 5176`, 모두 어드민 프록시로)**: index 200 `<title>단말온 운영 어드민</title>`, 로그인 없이 `/api/firmware` 401. 운영자 — 한 대 등록 201(RECEIVED)·같은 시리얼 409 DUPLICATE, 엑셀 5행 201(`CREATED 2, ALREADY_EXISTS 1, INVALID_FORMAT 1, UNKNOWN_MODEL 1`, 행 번호 2~6), .xlsx 아닌 파일 400 INVALID_FILE, 발주 201(세움전자 납품 명세 5대 — 대조 `ordered 5 noted 5 received 0`), 펌웨어 등록 201·같은 버전 409 DUPLICATE, `GET /firmware?modelCode=SN-100` 1건, 배포 만들기 201(RUNNING, 10/50/100)·같은 모델 409 ROLLOUT_ALREADY_ACTIVE·거꾸로 단계 400 INVALID_STAGES, 운영자의 `/admin/accounts` 403. ADMIN — 계정 7개, 만들기 201, 그 계정 로그인 200 → 역할 바꾸기 200 뒤 그 세션 401, 가맹점 없이 가맹점주로 400 MERCHANT_REQUIRED, 사용 중지 200 뒤 로그인 401, 마지막 ADMIN 강등 409 LAST_ADMIN, ADMIN의 `GET /firmware` 200·`POST /terminals` 403, 로그아웃 204 뒤 401. 세 서버를 PID로 끈 뒤 3200·4012·5176 LISTENING 0, node PID는 시작 전 넷 그대로. 확인용 Redis 키 8개(큐 meta 6, 역할 바꾸기의 세션 세대 1, 사용 중지 뒤 로그인 실패 1 — 세션은 로그아웃·역할 변경으로 지워짐)를 하나씩 DEL, 테스트 DB는 빈 DB로 다시 만들었다.
- **운영 중 단말기가 없으면 배포 1단계 대상은 0대다**: 시드만 넣은 테스트 DB에서 배포를 만들면 `stage1 targets 0`인 채 RUNNING. 시연에서 단계가 움직이는 것을 보이려면 그 모델의 운영 중 단말기(시나리오 앞 단계 또는 시뮬레이터 묶음의 시드)가 있어야 한다.
- **Windows curl은 Git Bash 경로를 파일 인자로 못 읽는다**: 확인 스크립트에서 `-F "file=@/c/…/live-import.xlsx"`가 응답 코드 000(curl이 파일을 못 엶 — `/mingw64/bin/curl`, 인자 앞이 `/`가 아니라 경로 변환도 안 된다) → `cygpath -m`으로 `C:/…` 꼴로(스크립트에 반영됨). 처음 돌린 결과로 테스트 DB에 행이 남아 api를 PID로 끄고 테스트 DB·확인용 키를 비운 뒤 처음부터 다시 돌렸다.

## 범위 조정 (브리프와 다르게 한 것과 이유)

- **발주 화면은 고치지 않는다** — 브리프는 "발주 생성 + 상세(납품 명세·입고 대조·마감)"를 채우라고 했지만, 기존 "발주 입고 대조"(Day 6, `/reports/purchase-orders`)에 발주하기(모델·수량)·발주 목록·고른 발주의 대조(명세 수·입고·빠진 것·명세 밖)·마감이 이미 있다(어드민 테스트 `ReportsPages.test.tsx` "발주 입고 대조"). 나누거나 이름을 바꾸면 기존 테스트·기록이 바뀐다 → 그대로(decisions/0068). 시나리오 점검표에 "있음"으로.
- **새 API는 `GET /firmware` 하나** — 배포 만들기의 버전을 손으로 적지 않게(decisions/0066). 가맹점 목록 화면은 만들지 않았다 — 배정·계정 만들기의 선택지(`GET /merchants`)로 충분하다.
- **외부 업체 키 화면은 만들지 않는다** — 브리프 권장대로 개발자센터(보강 7)로 넘기고, 계정 화면 아래 안내와 "다른 화면"의 개발자센터 자리(준비 중)만(decisions/0069).
- **계정 화면에 비밀번호·표시 이름 바꾸기는 넣지 않았다** — API(`PATCH`)는 있다. 시연 단계(만들기·역할·사용 중지)에 없다.
- **결과 CSV는 화면이 만든다** — 브리프 "결과 다운로드는 선택". 서버 API를 늘리지 않고 응답으로 `data:` URL을 만든다(decisions/0068).
- **다른 화면 바로가기는 왼쪽 메뉴 아래**(처음 화면이 아니라) — 현장 작업자의 처음 화면은 박스 스캔이라 처음 화면에 두면 일부 역할에 안 보인다. 메뉴(`nav[aria-label=메뉴]`)와 다른 `nav`라 메뉴 링크 수 테스트가 그대로다.
- **launch.json은 바꾸지 않는다** — 새 앱이 없다(어드민 `terminal-ops-admin` 항목 그대로).

## 파일 구조

```
terminal-ops/
├─ packages/contracts/src/requests.ts (RegisterTerminalRequest·RegisterFirmwareRequest·CreateRolloutRequest), operations.ts (TerminalImportRow·TerminalImportView)   (Task 1)
├─ apps/api/
│  ├─ src/firmware/firmware.controller.ts·firmware.service.ts·dto/firmware.dto.ts (GET /firmware, ListFirmwareQuery, implements)   (Task 1)
│  ├─ src/terminal/dto/register-terminal.dto.ts (implements), terminal-import.service.ts (반환 타입)   (Task 1)
│  └─ test/firmware-list.e2e.spec.ts (새), test/unit/access-table.spec.ts(한 줄)   (Task 1)
├─ apps/admin/src/
│  ├─ api/client.ts (PATCH·FormData), test/render.tsx (FormData 기록), apps.ts (새), components/AppLinks.tsx (새), components/Layout.tsx, styles.css   (Task 2)
│  ├─ lib/labels.ts (ROW_RESULT_LABEL), lib/csv.ts (새), pages/RegistrationPage.tsx (새), nav.ts·App.tsx   (Task 3)
│  ├─ pages/RolloutForms.tsx (새), pages/RolloutsPage.tsx, api/query-keys.ts (firmware), components/ErrorBox.tsx (안내 둘)   (Task 4)
│  ├─ pages/AccountsPage.tsx (새), api/query-keys.ts (accounts), components/ErrorBox.tsx (MERCHANT_REQUIRED), nav.ts·App.tsx   (Task 5)
│  └─ 테스트: api/client.test.tsx·apps.test.ts·components/Layout.test.tsx (Task 2), pages/RegistrationPage.test.tsx·lib/csv.test.ts (Task 3), pages/RolloutForms.test.tsx·api/query-keys.test.ts (Task 4), pages/AccountsPage.test.tsx (Task 5)
└─ docs/
   ├─ decisions/0066·0052 보탬 (Task 1), 0067·0041 보탬 (Task 2), 0068 (Task 3, Task 4 보탬), 0069 (Task 5)
   ├─ devlog/2026-10-29.md, index.md(스크립트), study/backlog.md
   └─ README.md, retrospective.md (Task 6)
```

## Task 순서

| Task | 내용 | 앱 | 기록 | 테스트 수(끝) | 추천 모델 |
|---|---|---|---|---|---|
| 1 | 펌웨어 목록 API `GET /firmware`(OFFICE, 키셋, 모델 거르기), contracts 요청 셋·엑셀 응답 타입, 접근 표 | contracts, api | decisions 0066, 0052 보탬 | api 83/571 | sonnet |
| 2 | 어드민 바탕 — api 클라이언트 PATCH·FormData, 다른 화면 바로가기(`apps.ts` + env, `AppLinks`, 쿠키 공유 안내) | admin | decisions 0067, 0041 보탬 | admin 15/131 | sonnet |
| 3 | 단말기 등록 화면 — 한 대·엑셀(파일 미리 확인, multipart), 행별 결과·실패한 행만·CSV, 메뉴(운영자) | admin | decisions 0068 | admin 17/141 | sonnet |
| 4 | 펌웨어 등록·배포 만들기 — 접힌 폼(운영자), 모델별 버전 선택, 단계 비율 읽기·단위 바꾸기, 확인, 409 안내 | admin | 0068 보탬 | admin 18/146 | opus(폼 검증·단위 변환·확인 흐름이 섞인 화면) |
| 5 | 계정 화면(ADMIN) — 목록·만들기·역할 바꾸기·사용 중지, LAST_ADMIN·자기 계정 안내, 외부 업체 키 안내 | admin | decisions 0069 | admin 19/152 | opus(세션 끊김·마지막 ADMIN·되돌리기 판단) |
| 6 | 마감 — 전체 검증, 실서버 확인(테스트 DB api + 가상 업체 + 어드민 프록시), README·회고·색인 | 전체·docs | 요약 | 최종 확인 | sonnet |

의존: 차례대로 한다. Task 3·4는 Task 1의 계약 타입(`TerminalImportView`, `RegisterTerminalRequest`, `RegisterFirmwareRequest`, `CreateRolloutRequest`)과 Task 2의 클라이언트(FormData·PATCH)·테스트 도구(FormData 기록)를 쓴다. 화면 테스트는 가짜 fetch라 api를 띄우지 않는다. 각 Task 끝의 테스트 수가 위 표와 다르면 멈추고 원인을 적는다.

## 커밋 규칙(보강 5)

범위는 `admin`으로 쓴다: `type(admin): 요약`. 기존 기능을 함께 바꾸면 그 ID를 붙인다(펌웨어 목록 API — `admin, F8`, 단말기 등록 화면 — `admin, F1`, 배포 만들기 — `admin, F8`, 계정 화면 — `admin, auth`). 본문에 `Refs: <기록 경로>`, 마지막 줄 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. git 작성자 설정은 바꾸지 않는다(decisions/0065). 이 규칙은 Task 1 devlog 항목에 한 줄로 적는다.

---

### Task 1: 펌웨어 목록 API `GET /firmware`, contracts 요청 셋·엑셀 응답 타입, 접근 표

**Files:**
- Modify: `packages/contracts/src/requests.ts`, `packages/contracts/src/operations.ts`
- Modify: `apps/api/src/firmware/firmware.controller.ts`, `apps/api/src/firmware/firmware.service.ts`, `apps/api/src/firmware/dto/firmware.dto.ts`, `apps/api/src/terminal/dto/register-terminal.dto.ts`, `apps/api/src/terminal/terminal-import.service.ts`
- Test: Create `apps/api/test/firmware-list.e2e.spec.ts`; Modify `apps/api/test/unit/access-table.spec.ts`
- Docs: Create `docs/decisions/0066-어드민-확장은-있는-API를-쓰고-새-API는-펌웨어-목록-하나.md`; Modify `docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md`, `docs/study/backlog.md`, `docs/index.md`, `docs/devlog/2026-10-29.md`

- [ ] **Step 1: 실패하는 테스트**

`apps/api/test/firmware-list.e2e.spec.ts`(쓰기는 테스트 헤더 운영자 `han`, 역할은 `X-Test-Role`):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'han' };

/**
 * 등록된 펌웨어 목록 GET /firmware(보강 5, decisions/0066). 어드민 배포 만들기 화면이 모델을 고르면 그 모델의 버전을 선택지로 보인다.
 * 최근 등록부터 beforeId 키셋(decisions/0039), 모델로 거르기, 역할은 배포 목록과 같은 사무실 역할(OFFICE).
 */
describe('등록된 펌웨어 목록 /firmware (보강 5)', () => {
  let t: TestApp;
  const ids = (body: { items: { id: number }[] }) => body.items.map((i) => i.id);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    for (const [modelCode, version] of [
      ['SN-100', '1.1.0'],
      ['SN-300', '3.0.0'],
      ['SN-100', '1.2.0'],
      ['SN-100', '1.3.0-rc1'],
    ]) {
      expect((await t.http().post('/firmware').set(OP).send({ modelCode, version })).status).toBe(201);
    }
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('최근 등록부터 limit개와 nextBeforeId, 다음 쪽은 beforeId로', async () => {
    const first = await t.http().get('/firmware').query({ limit: 3 });
    expect(first.status).toBe(200);
    expect(first.body.items.map((f: { version: string }) => f.version)).toEqual(['1.3.0-rc1', '1.2.0', '3.0.0']);
    expect(first.body.items[0]).toEqual({
      id: expect.any(Number),
      modelCode: 'SN-100',
      version: '1.3.0-rc1',
      createdBy: 'han',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(first.body.nextBeforeId).toBe(first.body.items[2].id);
    const next = await t.http().get('/firmware').query({ limit: 3, beforeId: first.body.nextBeforeId });
    expect(next.body.items.map((f: { version: string }) => f.version)).toEqual(['1.1.0']);
    expect(next.body.nextBeforeId).toBeNull();
    expect(ids(next.body).every((id) => id < first.body.nextBeforeId)).toBe(true);
  });

  it('모델로 거른다 — 없는 모델은 빈 목록(404가 아니다), 길이를 넘는 모델 코드는 400', async () => {
    const sn100 = await t.http().get('/firmware').query({ modelCode: 'SN-100' });
    expect(sn100.body.items.map((f: { version: string }) => f.version)).toEqual(['1.3.0-rc1', '1.2.0', '1.1.0']);
    expect((await t.http().get('/firmware').query({ modelCode: 'SN-300' })).body.items.map((f: { version: string }) => f.version)).toEqual(['3.0.0']);
    expect((await t.http().get('/firmware').query({ modelCode: 'SN-999' })).body).toEqual({ items: [], nextBeforeId: null });
    expect((await t.http().get('/firmware').query({ modelCode: 'X'.repeat(21) })).status).toBe(400);
  });

  it('역할: 사무실 역할(관제·ADMIN)은 읽고, 현장 작업자는 403, 로그인 없으면 401', async () => {
    expect((await t.http({ 'X-Operator': 'mon', 'X-Test-Role': 'MONITOR' }).get('/firmware')).status).toBe(200);
    expect((await t.http({ 'X-Operator': 'adm', 'X-Test-Role': 'ADMIN' }).get('/firmware')).status).toBe(200);
    const field = await t.http({ 'X-Operator': 'fld', 'X-Test-Role': 'FIELD' }).get('/firmware');
    expect(field.status).toBe(403);
    expect(field.body.code).toBe('FORBIDDEN');
    expect((await t.http(null).get('/firmware')).status).toBe(401);
  });
});
```

`apps/api/test/unit/access-table.spec.ts`(표에 한 줄):

```diff
diff --git a/apps/api/test/unit/access-table.spec.ts b/apps/api/test/unit/access-table.spec.ts
index 6bf5138..4913847 100644
--- a/apps/api/test/unit/access-table.spec.ts
+++ b/apps/api/test/unit/access-table.spec.ts
@@ -38,6 +38,7 @@ const EXPECTED: Record<string, string> = {
   'GET /sync-runs': 'ADMIN,MONITOR,OPERATOR',
   'GET /service-tickets': 'ADMIN,MONITOR,OPERATOR',
   'GET /service-tickets/:id': 'ADMIN,MONITOR,OPERATOR',
+  'GET /firmware': 'ADMIN,MONITOR,OPERATOR',
   'GET /firmware-rollouts': 'ADMIN,MONITOR,OPERATOR',
   'GET /firmware-rollouts/:id': 'ADMIN,MONITOR,OPERATOR',
   'GET /anomaly-rules': 'ADMIN,MONITOR,OPERATOR',
```

- [ ] **Step 2: 실패 확인**

```bash
# 저장소 루트에서 테스트 DB를 새로 만든다(안전 규칙의 두 줄 — 비밀번호는 출력하지 않는다)
cd apps/api && npx vitest run test/unit/access-table.spec.ts test/firmware-list.e2e.spec.ts
```

Expected(사전 검증 원문 요약): `Test Files  2 failed (2)`, `Tests  5 failed | 1 passed (6)` —
- firmware-list 셋: `AssertionError: expected 404 to be 200`(둘), `TypeError: Cannot read properties of undefined (reading 'map')`
- access-table 둘: `AssertionError: expected { …(71) } to deeply equal { …(72) }`, `AssertionError: expected 71 to be 72`

- [ ] **Step 3: 계약 타입**

`packages/contracts/src/requests.ts`(화면이 보내는 요청 본문 셋 — 지금까지 어드민이 부르지 않아 모양이 없었다):

```diff
diff --git a/packages/contracts/src/requests.ts b/packages/contracts/src/requests.ts
index 4109d9f..be19d44 100644
--- a/packages/contracts/src/requests.ts
+++ b/packages/contracts/src/requests.ts
@@ -44,6 +44,34 @@ export interface InspectRequest {
   results: InspectionResultInput[];
 }
 
+/** POST /terminals — 단말기 한 대 등록(입고 상태로). 엑셀 일괄 등록은 multipart `file`(본문 모양 없음, 응답 TerminalImportView) */
+export interface RegisterTerminalRequest {
+  /** 대문자·숫자·하이픈 4~32자 */
+  serialNo: string;
+  modelCode: string;
+}
+
+/** POST /firmware — (모델, 버전)이 이미 있으면 409 DUPLICATE */
+export interface RegisterFirmwareRequest {
+  modelCode: string;
+  /** 영문·숫자·점·하이픈 1~20자 */
+  version: string;
+}
+
+/** POST /firmware-rollouts — 등록된 펌웨어의 단계 배포. 같은 모델에 진행 중(RUNNING·PAUSED) 배포가 있으면 409 ROLLOUT_ALREADY_ACTIVE */
+export interface CreateRolloutRequest {
+  modelCode: string;
+  version: string;
+  /** 단계별 누적 비율(%) 1~10개, 커지는 순서, 마지막은 100(어기면 400 INVALID_STAGES) */
+  stages: number[];
+  /** 0~1. 단계 실패율이 이 값을 넘으면 자동 중단 */
+  failureThreshold: number;
+  /** 실패율을 판단하기 전에 모을 최소 보고 수(1 이상) */
+  minSamples: number;
+  /** 단계 안에서 보고를 기다리는 시간(ms, 1~86,400,000). 없으면 10분 */
+  stageTimeoutMs?: number;
+}
+
 /** POST /purchase-orders */
 export interface CreatePurchaseOrderRequest {
   modelCode: string;
```

`packages/contracts/src/operations.ts`(엑셀 일괄 등록 응답 — api `terminal-import.service.ts`가 이미 주는 모양 그대로):

```diff
diff --git a/packages/contracts/src/operations.ts b/packages/contracts/src/operations.ts
index e31b5b4..dbab383 100644
--- a/packages/contracts/src/operations.ts
+++ b/packages/contracts/src/operations.ts
@@ -81,7 +81,22 @@ export interface MerchantTicketView extends Omit<TicketView, 'openedBy' | 'remot
   replacementStatus: TerminalStatus | null;
 }
 
-/** 펌웨어(api toFirmwareView, POST /firmware) */
+/** 엑셀 일괄 등록 결과 한 줄(POST /terminals/imports). row = 엑셀 행 번호(머리글이 1행) */
+export interface TerminalImportRow extends RowResult {
+  row: number;
+}
+
+/** POST /terminals/imports 응답 — 행 순서 그대로(decisions/0019·0022) */
+export interface TerminalImportView {
+  fileName: string;
+  /** 읽은 데이터 행 수(빈 행 제외) */
+  total: number;
+  /** 결과 코드별 행 수(0인 코드는 빠진다) */
+  summary: Partial<Record<RowResultCode, number>>;
+  results: TerminalImportRow[];
+}
+
+/** 펌웨어(api toFirmwareView, POST /firmware, GET /firmware) */
 export interface FirmwareView {
   id: number;
   modelCode: string;
```

- [ ] **Step 4: 구현**

`apps/api/src/firmware/dto/firmware.dto.ts`(DTO 둘이 contracts를 `implements`, 목록 조건 `ListFirmwareQuery`):

```diff
diff --git a/apps/api/src/firmware/dto/firmware.dto.ts b/apps/api/src/firmware/dto/firmware.dto.ts
index eba8057..f14fabb 100644
--- a/apps/api/src/firmware/dto/firmware.dto.ts
+++ b/apps/api/src/firmware/dto/firmware.dto.ts
@@ -1,4 +1,5 @@
-import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
+import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
+import type { CreateRolloutRequest, RegisterFirmwareRequest } from '@terminal-ops/contracts';
 import { BeforeIdQuery } from '../../common/keyset.js';
 import { FIRMWARE_VERSION_PATTERN } from '../../device/heartbeat.service.js';
 import { SERIAL_NO_MESSAGE, SERIAL_NO_PATTERN } from '../../terminal/bulk-rows.js';
@@ -9,7 +10,7 @@ const VERSION_MESSAGE = 'version은 영문·숫자·점·하이픈 1~20자입니
 /** 단계 제한 시간 상한(하루). firmware_rollout.stage_timeout_ms는 int(최대 2,147,483,647ms ≈ 24.8일) */
 export const MAX_STAGE_TIMEOUT_MS = 24 * 60 * 60_000;
 
-export class RegisterFirmwareDto {
+export class RegisterFirmwareDto implements RegisterFirmwareRequest {
   @IsString()
   modelCode!: string;
 
@@ -17,7 +18,15 @@ export class RegisterFirmwareDto {
   version!: string;
 }
 
-export class CreateRolloutDto {
+/** GET /firmware 조건(최근 등록부터, decisions/0039). 모델로 거른다 — 배포 만들기 화면의 버전 선택지(decisions/0066) */
+export class ListFirmwareQuery extends BeforeIdQuery {
+  @IsOptional()
+  @IsString()
+  @MaxLength(20)
+  modelCode?: string;
+}
+
+export class CreateRolloutDto implements CreateRolloutRequest {
   @IsString()
   modelCode!: string;
 
```

`apps/api/src/firmware/firmware.service.ts`(`list` — 모델 코드로 모델 행을 먼저 찾고, 없으면 빈 목록. 최근 등록부터 `limit + 1`개로 다음 쪽 판단, decisions/0039):

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LoadStrategy } from '@mikro-orm/mysql';
import type { FirmwareView } from '@terminal-ops/contracts';
import { beforeIdWhere, keysetPage } from '../common/keyset.js';
import { TerminalModel } from '../terminal/terminal-model.entity.js';
import type { RegisterFirmwareDto } from './dto/firmware.dto.js';
import { Firmware } from './firmware.entities.js';

/** 펌웨어 등록. (모델, 버전)이 이미 있으면 unique 위반 → 409 DUPLICATE(기존 예외 필터). */
@Injectable()
export class FirmwareService {
  constructor(private readonly em: EntityManager) {}

  async register(dto: RegisterFirmwareDto, actor: string): Promise<Firmware> {
    const em = this.em.fork();
    const model = await em.findOne(TerminalModel, { code: dto.modelCode });
    if (!model) throw new NotFoundException(`단말기 모델 ${dto.modelCode}이(가) 없습니다.`);
    const firmware = em.create(Firmware, { model, version: dto.version, createdBy: actor });
    await em.flush();
    return firmware;
  }

  /**
   * 등록된 펌웨어(최근 등록부터, ?modelCode=&beforeId=&limit=). 배포 만들기 화면의 버전 선택지(decisions/0066).
   * 모델 조건은 모델 코드로 받아 모델 행을 먼저 찾는다 — 없는 모델이면 빈 목록(404가 아니다: 거르기 조건이라서).
   */
  async list(q: { modelCode?: string; beforeId?: number; limit: number }): Promise<{ items: Firmware[]; nextBeforeId: number | null }> {
    const em = this.em.fork();
    let modelWhere = {};
    if (q.modelCode) {
      const model = await em.findOne(TerminalModel, { code: q.modelCode });
      if (!model) return { items: [], nextBeforeId: null };
      modelWhere = { model: model.id };
    }
    const rows = await em.find(
      Firmware,
      { ...beforeIdWhere(q.beforeId), ...modelWhere },
      { populate: ['model'], strategy: LoadStrategy.SELECT_IN, orderBy: { id: 'desc' }, limit: q.limit + 1 },
    );
    return keysetPage(rows, q.limit);
  }
}

export function toFirmwareView(f: Firmware): FirmwareView {
  return { id: f.id, modelCode: f.model.code, version: f.version, createdBy: f.createdBy, createdAt: f.createdAt.toISOString() };
}
```

`apps/api/src/firmware/firmware.controller.ts`(메서드 이름은 `listFirmware` — 같은 클래스에 배포 목록 `list`가 이미 있어 `list`로 쓰면 `TS2393: Duplicate function implementation`, 사전 검증에서 만남):

```diff
diff --git a/apps/api/src/firmware/firmware.controller.ts b/apps/api/src/firmware/firmware.controller.ts
index d601c5e..543abc6 100644
--- a/apps/api/src/firmware/firmware.controller.ts
+++ b/apps/api/src/firmware/firmware.controller.ts
@@ -1,9 +1,9 @@
 import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
-import type { BeforeIdPage, RolloutView } from '@terminal-ops/contracts';
+import type { BeforeIdPage, FirmwareView, RolloutView } from '@terminal-ops/contracts';
 import { OFFICE, Roles } from '../auth/access.js';
 import { Role } from '../auth/role.js';
 import { Operator } from '../common/operator.decorator.js';
-import { CreateRolloutDto, ListRolloutsQuery, RegisterFirmwareDto } from './dto/firmware.dto.js';
+import { CreateRolloutDto, ListFirmwareQuery, ListRolloutsQuery, RegisterFirmwareDto } from './dto/firmware.dto.js';
 import { FirmwareService, toFirmwareView } from './firmware.service.js';
 import { RolloutService, toRolloutView } from './rollout.service.js';
 import type { FirmwareRollout } from './firmware.entities.js';
@@ -22,6 +22,14 @@ export class FirmwareController {
     return toFirmwareView(await this.firmware.register(dto, actor));
   }
 
+  /** 등록된 펌웨어(최근 것부터, ?modelCode=&beforeId=&limit=). 배포 목록과 같은 사무실 역할이 본다(decisions/0066) */
+  @Get('firmware')
+  @Roles(...OFFICE)
+  async listFirmware(@Query() query: ListFirmwareQuery): Promise<BeforeIdPage<FirmwareView>> {
+    const { items, nextBeforeId } = await this.firmware.list(query);
+    return { items: items.map(toFirmwareView), nextBeforeId };
+  }
+
   @Post('firmware-rollouts')
   @Roles(Role.OPERATOR)
   async create(@Body() dto: CreateRolloutDto, @Operator() actor: string) {
```

`apps/api/src/terminal/dto/register-terminal.dto.ts`:

```diff
diff --git a/apps/api/src/terminal/dto/register-terminal.dto.ts b/apps/api/src/terminal/dto/register-terminal.dto.ts
index 5310e6b..e48b283 100644
--- a/apps/api/src/terminal/dto/register-terminal.dto.ts
+++ b/apps/api/src/terminal/dto/register-terminal.dto.ts
@@ -1,7 +1,8 @@
 import { IsString, Matches } from 'class-validator';
+import type { RegisterTerminalRequest } from '@terminal-ops/contracts';
 import { SERIAL_NO_MESSAGE, SERIAL_NO_PATTERN } from '../bulk-rows.js';
 
-export class RegisterTerminalDto {
+export class RegisterTerminalDto implements RegisterTerminalRequest {
   @Matches(SERIAL_NO_PATTERN, { message: SERIAL_NO_MESSAGE })
   serialNo!: string;
 
```

`apps/api/src/terminal/terminal-import.service.ts`(반환 타입을 계약에 건다 — 어긋나면 tsc 실패, decisions/0048):

```diff
diff --git a/apps/api/src/terminal/terminal-import.service.ts b/apps/api/src/terminal/terminal-import.service.ts
index 8ed823e..04003fd 100644
--- a/apps/api/src/terminal/terminal-import.service.ts
+++ b/apps/api/src/terminal/terminal-import.service.ts
@@ -1,6 +1,6 @@
 import { BadRequestException, Injectable } from '@nestjs/common';
 import ExcelJS from 'exceljs';
-import type { ApiErrorBody, InputErrorCode } from '@terminal-ops/contracts';
+import type { ApiErrorBody, InputErrorCode, TerminalImportView } from '@terminal-ops/contracts';
 import { BulkRegistrationService, type BulkRegisterRow } from './bulk-registration.service.js';
 import { summarize, type RowResult } from './bulk-rows.js';
 import { readCellValue } from './import-cells.js';
@@ -76,7 +76,7 @@ export async function readImportRows(buffer: Buffer): Promise<ImportRow[]> {
 export class TerminalImportService {
   constructor(private readonly bulk: BulkRegistrationService) {}
 
-  async import(file: UploadedSpreadsheet | undefined, actor: string) {
+  async import(file: UploadedSpreadsheet | undefined, actor: string): Promise<TerminalImportView> {
     if (!file) throw invalid('INVALID_FILE', 'file 필드로 .xlsx 파일을 보내세요.');
     if (!file.originalname.toLowerCase().endsWith('.xlsx')) throw invalid('INVALID_FILE', '.xlsx 파일만 받습니다.');
     const rows = await readImportRows(file.buffer);
```

- [ ] **Step 5: 통과 확인과 전체 api**

```bash
cd apps/api
npx vitest run test/unit/access-table.spec.ts test/firmware-list.e2e.spec.ts test/unit/contract-drift.spec.ts
npm run typecheck
# 테스트 DB를 새로 만든 뒤(안전 규칙) 전체 — 약 5분 반
npx vitest run > /tmp/adminx-t1-api.log 2>&1; grep -E "Test Files|Tests |Duration" /tmp/adminx-t1-api.log; grep -c "Connection is closed" /tmp/adminx-t1-api.log
```

Expected: 세 파일 `Test Files  3 passed (3)`, `Tests  13 passed (13)`. typecheck 출력 없음(exit 0). 전체 `Test Files  83 passed (83)`·`Tests  571 passed (571)`(사전 검증 Duration 331.96s), `Connection is closed` 0. 기존 테스트는 고치지 않았다(접근 표에 한 줄만). contracts만 늘었으므로 admin·merchant·field `npm run build`(tsc 포함)도 그대로 통과한다(사전 검증).

- [ ] **Step 6: 기록**

`docs/decisions/0066-어드민-확장은-있는-API를-쓰고-새-API는-펌웨어-목록-하나.md`:

````markdown
# 0066. 어드민 확장은 있는 API를 그대로 쓰고, 새 API는 펌웨어 목록 하나

- 날짜 / 관련 기능: 2026-10-29 / 보강 5, F1·F8·F10, 어드민
- 상황: 통합 시연 시나리오를 어드민 화면만으로 끝까지 돌려야 한다. 화면이 없는 운영자·ADMIN 단계는 단말기 등록(한 대·엑셀), 펌웨어 등록, 단계 배포 만들기, 계정 관리다(스펙의 시나리오 점검표). 이 쓰기 API는 모두 이미 있다(`POST /terminals`, `POST /terminals/imports`, `POST /firmware`, `POST /firmware-rollouts`, `/admin/accounts`) — 검증·접근 표·e2e도 있다. 화면이 새로 필요로 하는 것은 "배포 만들기에서 고를 펌웨어 버전"뿐이다. 등록된 펌웨어를 읽는 API가 없다(배포 목록 `GET /firmware-rollouts`는 배포를 만든 버전만 보인다). 또 요청 본문 셋(`POST /terminals`·`/firmware`·`/firmware-rollouts`)과 엑셀 등록 응답은 contracts에 모양이 없어(보강 1 때 어드민이 부르지 않던 것) 화면이 타입 없이 보내게 된다.
- 선택지:
  1. 버전을 손으로 적는 칸 — API를 늘리지 않는다. 틀린 버전은 404(`펌웨어 … 등록되지 않았습니다`)로 늦게 안다. 시연 중 오타에 약하다
  2. **`GET /firmware?modelCode=&beforeId=&limit=`(사무실 역할) — 최근 등록부터 키셋(decisions/0039)** — 엔드포인트 하나·접근 표 한 줄. 화면은 모델을 고르면 그 모델 버전만 선택지로
  3. `GET /terminal-models/:code/firmware` — 모델 아래 경로가 읽기 좋지만, 목록 API 모양(`BeforeIdPage`, `?beforeId=`)을 다른 목록과 같게 두려면 결국 같은 쿼리 DTO가 필요하다. 모델 컨트롤러가 펌웨어 모듈을 알게 된다
- 결정: 2. 역할은 `GET /firmware-rollouts`와 같은 OFFICE(ADMIN·OPERATOR·MONITOR) — 배포 현황을 보는 사람이 그 버전 목록도 본다. 없는 모델 코드는 404가 아니라 빈 목록(거르기 조건). 모델 조건은 모델 행을 먼저 찾아 FK 열(`model_id`)로 거른다(조인 없이 — 실행계획은 재지 않았다. 펌웨어 표는 모델당 몇 행이라 작다). 함께, 화면이 보내는 요청 본문 셋에 contracts 타입(`RegisterTerminalRequest`·`RegisterFirmwareRequest`·`CreateRolloutRequest`)을 두고 DTO가 `implements`한다. 엑셀 등록 응답은 `TerminalImportView`(행 번호가 붙은 `RowResult`)로, 서비스 반환 타입에 건다(decisions/0048 방식 — 어긋나면 api tsc 실패).
- 결과·대가: 엔드포인트 71 → 72(접근 표 테스트가 센 값, decisions/0052 보탬). 펌웨어 목록은 화면에서 한 번에 100개까지만 본다(모델 하나의 버전 수로 충분하다고 본다 — 넘으면 "더 보기"를 붙인다). 계정·발주·단말기 등록 쪽에는 새 API가 없다 — 가맹점 목록(`GET /merchants`)도 이미 있다.
- 다시 볼 조건: 펌웨어 버전이 모델당 수백 개가 되거나, 펌웨어에 파일·변경 내역이 붙어 상세 화면이 필요해지면 `GET /firmware/:id`와 "더 보기"를 더한다.
````

`docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md` — 표의 `OFFICE` 줄에서 `` `GET /firmware-rollouts`, `` 바로 앞에 `` `GET /firmware`(보강 5, 0066), ``를 넣는다(Edit 도구). 같은 파일 끝(마지막 줄 `- 보강 4 보탬(decisions/0063): …` 뒤)에 한 줄:

```markdown
- 보강 5 보탬(decisions/0066): 어드민 배포 만들기의 버전 선택지용 `GET /firmware`(OFFICE — 배포 목록과 같은 사람)를 더해 엔드포인트 71 → 72(접근 표 테스트가 센 값). 어드민의 나머지 새 화면(단말기 등록·엑셀, 펌웨어 등록, 배포 만들기, 계정)은 기존 엔드포인트와 규칙(OPERATOR, ADMIN) 그대로다.
```

`docs/study/backlog.md` 끝에 한 줄:

```markdown
- [ ] TypeScript 클래스 메서드 이름 겹침(TS2393)과 Nest 라우트 — 같은 컨트롤러에 `list`가 둘이면? 데코레이터 메타데이터는 어느 쪽에 남나 (apps/api/src/firmware/firmware.controller.ts, decisions/0066)
```

devlog — `docs/devlog/2026-10-29.md`의 `## HH:MM 보강 5 계획 작성` 항목 뒤에:

```markdown
## HH:MM Task 1 펌웨어 목록 API GET /firmware·contracts 요청 셋·접근 표 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <계획 커밋 해시> (docs: 보강 5 계획 — 통합 어드민 확장)
- 한 일: api `GET /firmware?modelCode=&beforeId=&limit=`(OFFICE) — 최근 등록부터 키셋, 없는 모델은 빈 목록. contracts `RegisterTerminalRequest`·`RegisterFirmwareRequest`·`CreateRolloutRequest`(DTO implements), `TerminalImportRow`·`TerminalImportView`(엑셀 등록 서비스 반환 타입). 접근 표 71 → 72
- 확인: 새 테스트 5개 실패(404, 표 71/72) → 통과(3파일 13개). api 전체 `Test Files  <수> passed (<수>)`, `Tests  <수> passed (<수>)`, Duration <초>, `Connection is closed` <수>. typecheck 0
- 결정: decisions/0066(새 API는 펌웨어 목록 하나, 계약 보강), 0052 표·보탬
- 커밋 규칙(보강 5): `type(admin): 요약`, 기존 기능을 함께 바꾸면 `admin, F8` 식, 본문 `Refs:`, 마지막 줄 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 다음: Task 2 어드민 바탕(클라이언트 PATCH·FormData, 다른 화면 바로가기)
```

```bash
node scripts/docs-index.mjs
```

- [ ] **Step 7: 커밋**

```bash
git add packages/contracts apps/api docs
git status --short   # node_modules·dist·.snapshot-terminal_ops_test.json이 없어야 한다
git commit -m "$(cat <<'EOF'
feat(admin, F8): 배포 만들기 버전 선택지용 펌웨어 목록 API — GET /firmware, 요청 계약 보강

Refs: docs/decisions/0066-어드민-확장은-있는-API를-쓰고-새-API는-펌웨어-목록-하나.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 제목 시각 = 커밋 시각(`git log -1 --format=%cd --date=format:%H:%M`)인지 보고, 다르면 고쳐 `git commit --amend --no-edit`.

---

### Task 2: 어드민 바탕 — api 클라이언트 PATCH·FormData, 다른 화면 바로가기

**Files:**
- Modify: `apps/admin/src/api/client.ts`, `apps/admin/src/components/Layout.tsx`, `apps/admin/src/styles.css`, `apps/admin/src/test/render.tsx`
- Create: `apps/admin/src/apps.ts`, `apps/admin/src/components/AppLinks.tsx`
- Test: Create `apps/admin/src/apps.test.ts`; Modify `apps/admin/src/api/client.test.tsx`, `apps/admin/src/components/Layout.test.tsx`
- Docs: Create `docs/decisions/0067-다른-화면-바로가기-주소는-apps-ts-한-곳과-Vite-env로.md`; Modify `docs/decisions/0041-어드민-골격-Vite-프록시-작업자-헤더-도구.md`, `docs/study/backlog.md`, `docs/index.md`, `docs/devlog/2026-10-29.md`

- [ ] **Step 1: 실패하는 테스트**

`apps/admin/src/test/render.tsx`(가짜 fetch가 FormData 본문을 그대로 기록 — 파일 올리기 테스트가 `call.body.get('file')`로 본다):

```diff
diff --git a/apps/admin/src/test/render.tsx b/apps/admin/src/test/render.tsx
index e845882..1b4d143 100644
--- a/apps/admin/src/test/render.tsx
+++ b/apps/admin/src/test/render.tsx
@@ -38,7 +38,8 @@ export function mockApi(handlers: Record<string, Handler>) {
       method: init?.method ?? 'GET',
       path: url.pathname.replace(/^\/api/, ''),
       query: url.searchParams,
-      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
+      // JSON 본문은 읽어 두고, 파일 올리기(FormData)는 그대로 둔다 — 테스트가 call.body.get('file')로 본다(보강 5)
+      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body instanceof FormData ? init.body : undefined,
       headers: (init?.headers ?? {}) as Record<string, string>,
     };
     calls.push(call);
```

`apps/admin/src/api/client.test.tsx`(두 개 더함):

```diff
diff --git a/apps/admin/src/api/client.test.tsx b/apps/admin/src/api/client.test.tsx
index 88abd7b..3011254 100644
--- a/apps/admin/src/api/client.test.tsx
+++ b/apps/admin/src/api/client.test.tsx
@@ -63,6 +63,22 @@ describe('api 클라이언트 (decisions/0041)', () => {
     expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch');
   });
 
+  it('PATCH도 JSON 본문으로 보낸다(계정 바꾸기, 보강 5)', async () => {
+    const { calls } = mockApi({ 'PATCH /admin/accounts/:id': () => ({ body: { id: 3, role: 'MONITOR' } }) });
+    expect(await api('/admin/accounts/3', { method: 'PATCH', body: { role: 'MONITOR' } })).toEqual({ id: 3, role: 'MONITOR' });
+    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/admin/accounts/3', body: { role: 'MONITOR' } });
+    expect(calls[0].headers['Content-Type']).toBe('application/json');
+  });
+
+  it('FormData(파일 올리기)는 그대로 보내고 Content-Type을 붙이지 않는다 — 브라우저가 multipart 경계와 함께 붙인다(보강 5)', async () => {
+    const { calls } = mockApi({ 'POST /terminals/imports': () => ({ status: 201, body: { total: 0 } }) });
+    const form = new FormData();
+    form.append('file', new File(['x'], 'a.xlsx'));
+    await api('/terminals/imports', { method: 'POST', body: form });
+    expect(calls[0].body).toBe(form);
+    expect(calls[0].headers).toEqual({ Accept: 'application/json' });
+  });
+
   it('204(본문 없음)는 null', async () => {
     vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
     expect(await api('/anything', { method: 'POST', body: {} })).toBeNull();
```

`apps/admin/src/apps.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { otherApps } from './apps';

const urls = (env: Record<string, unknown>) => Object.fromEntries(otherApps(env).map((a) => [a.key, a.url]));

describe('다른 화면 주소 — 한 곳(apps.ts)과 env (보강 5, decisions/0067)', () => {
  it('env가 없으면 로컬 개발 서버 주소, 아직 없는 화면은 null', () => {
    expect(urls({})).toEqual({
      merchant: 'http://localhost:5174',
      field: 'http://localhost:5175',
      ops: null,
      developers: null,
      partners: null,
      simulator: null,
    });
  });

  it('VITE_*_URL이 있으면 그 주소(앞뒤 공백은 지운다), 빈 값은 없는 것과 같다', () => {
    expect(
      urls({
        VITE_MERCHANT_APP_URL: ' http://merchant.demo:8081 ',
        VITE_FIELD_APP_URL: '',
        VITE_DEVELOPERS_APP_URL: 'http://developers.demo:8083',
      }),
    ).toMatchObject({ merchant: 'http://merchant.demo:8081', field: 'http://localhost:5175', developers: 'http://developers.demo:8083', ops: null });
  });

  it('테스트 실행(vitest)의 import.meta.env를 기본으로 읽는다 — VITE_ 주소를 주지 않았으면 기본 주소', () => {
    expect(otherApps().find((a) => a.key === 'merchant')?.url).toBe('http://localhost:5174');
  });
});
```

`apps/admin/src/components/Layout.test.tsx`(하나 더함 — 메뉴 링크 수 9는 그대로여야 한다):

```diff
diff --git a/apps/admin/src/components/Layout.test.tsx b/apps/admin/src/components/Layout.test.tsx
index 61a98b9..83fa38b 100644
--- a/apps/admin/src/components/Layout.test.tsx
+++ b/apps/admin/src/components/Layout.test.tsx
@@ -46,6 +46,18 @@ describe('틀 — 로그인한 사람과 역할별 메뉴 (decisions/0041, api d
     expect(within(nav).getAllByRole('link')).toHaveLength(9);
   });
 
+  it('왼쪽 아래 "다른 화면": 매장·현장은 새 탭 링크, 아직 없는 화면 넷은 준비 중(링크 아님). 메뉴 링크 수에는 들지 않는다(보강 5)', async () => {
+    mockApi(HOME);
+    loginAs('관제1', 'MONITOR');
+    renderPage(<App />, { path: '/*' });
+    const others = await screen.findByRole('navigation', { name: '다른 화면' });
+    expect(within(others).getByRole('link', { name: '매장 화면' })).toHaveAttribute('href', 'http://localhost:5174');
+    expect(within(others).getByRole('link', { name: '현장 화면' })).toHaveAttribute('target', '_blank');
+    expect(within(others).getAllByRole('link')).toHaveLength(2);
+    for (const name of ['운영 관제', '개발자센터', '가상 업체 콘솔', '단말기 시뮬레이터']) expect(within(others).getByText(`${name}(준비 중)`)).toBeInTheDocument();
+    expect(within(screen.getByRole('navigation', { name: '메뉴' })).getAllByRole('link')).toHaveLength(9);
+  });
+
   it('쓰기 버튼: 로그인 정보가 없으면 꺼지고, 운영자면 켜지고, 역할이 아니면 보이지 않는다', () => {
     const { unmount } = renderPage(<WriteButton>바꾸기</WriteButton>);
     expect(screen.getByRole('button', { name: '바꾸기' })).toBeDisabled();
```

- [ ] **Step 2: 실패 확인**

```bash
cd apps/admin && npx vitest run src/api/client.test.tsx src/apps.test.ts src/components/Layout.test.tsx
```

Expected(사전 검증 원문 요약): `Test Files  3 failed (3)`, `Tests  2 failed | 15 passed (17)` —
- apps.test: `Error: Failed to resolve import "./apps" from "src/apps.test.ts". Does the file exist?`
- client: `AssertionError: expected {} to be FormData{ …(1) }`(지금 클라이언트는 FormData를 `JSON.stringify`해 `{}`로 보낸다). PATCH 테스트는 타입만 다르고 실행은 지금도 통과한다
- Layout: `TestingLibraryElementError: Unable to find role="navigation" and name "다른 화면"`

- [ ] **Step 3: 구현**

`apps/admin/src/api/client.ts`:

```diff
diff --git a/apps/admin/src/api/client.ts b/apps/admin/src/api/client.ts
index 170b09c..99a5140 100644
--- a/apps/admin/src/api/client.ts
+++ b/apps/admin/src/api/client.ts
@@ -26,7 +26,9 @@ export class ApiError extends Error {
 export type Query = Record<string, string | number | boolean | null | undefined>;
 
 export interface RequestOptions {
-  method?: 'GET' | 'POST';
+  /** PATCH는 계정 바꾸기(PATCH /admin/accounts/:id, 보강 5) */
+  method?: 'GET' | 'POST' | 'PATCH';
+  /** 보통은 JSON으로 보낸다. FormData(엑셀 파일 올리기)면 그대로 보내고 Content-Type은 브라우저가 경계(boundary)와 함께 붙인다(보강 5) */
   body?: unknown;
   query?: Query;
 }
@@ -58,11 +60,12 @@ const LOGIN_PATH = '/auth/login';
  */
 export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
   const headers: Record<string, string> = { Accept: 'application/json' };
-  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
+  const isForm = options.body instanceof FormData;
+  if (options.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
   const res = await fetch(`${API_BASE}${path}${toQueryString(options.query)}`, {
     method: options.method ?? 'GET',
     headers,
-    body: options.body === undefined ? undefined : JSON.stringify(options.body),
+    body: options.body === undefined ? undefined : isForm ? (options.body as FormData) : JSON.stringify(options.body),
   });
   const text = await res.text();
   let body: unknown = null;
```

`apps/admin/src/apps.ts`(다른 화면 목록과 주소 — 이 파일 한 곳, decisions/0067):

```ts
/**
 * 다른 화면(앱) 바로가기 — 주소는 이 파일 한 곳에 둔다(보강 5, decisions/0067).
 * 주소는 Vite env(`VITE_*_URL`, 개발 서버·빌드가 읽는다)로 바꾸고, 없으면 로컬 개발 서버 주소를 쓴다.
 * Docker로 띄울 때(이후 보강) 주소가 바뀌면 env만 주면 된다. 아직 없는 화면은 기본 주소가 null — 링크 대신 "준비 중"으로 보인다.
 * 새 화면이 생기면 그 보강이 여기 기본 주소 한 줄을 채운다.
 */
export interface OtherApp {
  key: string;
  label: string;
  /** 누가 쓰는 화면인가 */
  who: string;
  /** null이면 아직 없는 화면 */
  url: string | null;
}

type Env = Record<string, unknown>;

export function otherApps(env: Env = import.meta.env): OtherApp[] {
  const pick = (name: string, fallback: string | null) => {
    const value = env[name];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
  };
  return [
    { key: 'merchant', label: '매장 화면', who: '가맹점주', url: pick('VITE_MERCHANT_APP_URL', 'http://localhost:5174') },
    { key: 'field', label: '현장 화면', who: '현장 작업자', url: pick('VITE_FIELD_APP_URL', 'http://localhost:5175') },
    { key: 'ops', label: '운영 관제', who: '관제·개발자', url: pick('VITE_OPS_APP_URL', null) },
    { key: 'developers', label: '개발자센터', who: '외부 업체 연동(키 발급·폐기)', url: pick('VITE_DEVELOPERS_APP_URL', null) },
    { key: 'partners', label: '가상 업체 콘솔', who: '세움전자·번개택배·느림보물류·브릿지VAN·톡톡메신저', url: pick('VITE_PARTNERS_CONSOLE_URL', null) },
    { key: 'simulator', label: '단말기 시뮬레이터', who: '하트비트·펌웨어 보고', url: pick('VITE_SIMULATOR_APP_URL', null) },
  ];
}
```

`apps/admin/src/components/AppLinks.tsx`:

```tsx
import { otherApps, type OtherApp } from '../apps';

/**
 * 왼쪽 아래 "다른 화면" — 시연 때 어드민에서 다른 앱으로 건너간다(보강 5, decisions/0067). 주소는 apps.ts 한 곳.
 * 새 탭으로 연다. localhost에서는 포트가 달라도 로그인 쿠키(sid)가 하나라, 다른 화면에서 로그인하면 이 화면의 세션이 끝난다(보강 3 기록).
 */
export function AppLinks({ apps = otherApps() }: { apps?: OtherApp[] }) {
  return (
    <nav className="other-apps" aria-label="다른 화면">
      <h2>다른 화면</h2>
      <ul className="plain">
        {apps.map((app) => (
          <li key={app.key}>
            {app.url ? (
              <a href={app.url} target="_blank" rel="noreferrer">
                {app.label}
              </a>
            ) : (
              <span className="muted">{app.label}(준비 중)</span>
            )}
            <div className="hint">{app.who}</div>
          </li>
        ))}
      </ul>
      <p className="hint">같은 브라우저에서 다른 화면에 로그인하면 이 화면의 로그인이 끝납니다(쿠키 공유). 다른 계정으로 동시에 보려면 브라우저 프로필을 나누세요.</p>
    </nav>
  );
}
```

`apps/admin/src/components/Layout.tsx`(왼쪽을 `aside.side` 안의 메뉴 `nav` + 다른 화면 `nav`로 — 다른 화면 링크가 메뉴 링크 수에 들지 않게):

```diff
diff --git a/apps/admin/src/components/Layout.tsx b/apps/admin/src/components/Layout.tsx
index d3f33e8..8ac31be 100644
--- a/apps/admin/src/components/Layout.tsx
+++ b/apps/admin/src/components/Layout.tsx
@@ -1,9 +1,10 @@
 import { NavLink, Outlet } from 'react-router';
 import { NAV } from '../nav';
 import { hasRole, useMe } from '../session';
+import { AppLinks } from './AppLinks';
 import { UserBar } from './UserBar';
 
-/** 공통 틀: 위쪽 제목·로그인한 사람, 왼쪽 메뉴(역할에 맞는 것만), 오른쪽 화면 */
+/** 공통 틀: 위쪽 제목·로그인한 사람, 왼쪽 메뉴(역할에 맞는 것만)와 다른 화면 바로가기(보강 5), 오른쪽 화면 */
 export function Layout() {
   const me = useMe();
   return (
@@ -12,13 +13,16 @@ export function Layout() {
         <h1>단말온 운영 어드민</h1>
         <UserBar />
       </header>
-      <nav className="side" aria-label="메뉴">
-        {NAV.filter((item) => hasRole(me, item.roles)).map((item) => (
-          <NavLink key={item.to} to={item.to} end={item.to === '/'}>
-            {item.label}
-          </NavLink>
-        ))}
-      </nav>
+      <aside className="side">
+        <nav className="menu" aria-label="메뉴">
+          {NAV.filter((item) => hasRole(me, item.roles)).map((item) => (
+            <NavLink key={item.to} to={item.to} end={item.to === '/'}>
+              {item.label}
+            </NavLink>
+          ))}
+        </nav>
+        <AppLinks />
+      </aside>
       <main className="content">
         <Outlet />
       </main>
```

`apps/admin/src/styles.css`:

```diff
diff --git a/apps/admin/src/styles.css b/apps/admin/src/styles.css
index a4f261b..c960bd0 100644
--- a/apps/admin/src/styles.css
+++ b/apps/admin/src/styles.css
@@ -51,9 +51,37 @@ body {
   flex-direction: column;
   padding: 8px;
   border-right: 1px solid var(--line);
+  gap: 16px;
+}
+
+.side .menu {
+  display: flex;
+  flex-direction: column;
   gap: 2px;
 }
 
+/* 다른 화면 바로가기(보강 5) */
+.other-apps {
+  border-top: 1px solid var(--line);
+  padding-top: 8px;
+}
+
+.other-apps h2 {
+  font-size: 12px;
+  color: var(--muted);
+  margin: 0 8px 4px;
+}
+
+.other-apps li {
+  margin: 0 0 6px;
+}
+
+.other-apps li > span,
+.other-apps .hint {
+  padding: 0 8px;
+  font-size: 12px;
+}
+
 .side a {
   padding: 6px 8px;
   border-radius: 4px;
```

- [ ] **Step 4: 통과 확인과 전체 admin**

```bash
cd apps/admin
npx vitest run src/api/client.test.tsx src/apps.test.ts src/components/Layout.test.tsx
npx vitest run 2>&1 | tail -4
npm run build && rm -rf dist
```

Expected: 세 파일 `Test Files  3 passed (3)`, `Tests  17 passed (17)`. 전체 `Test Files  15 passed (15)`, `Tests  131 passed (131)`(125 + 클라이언트 2 + 주소 3 + 틀 1). build 성공(tsc 0).

- [ ] **Step 5: 기록**

`docs/decisions/0067-다른-화면-바로가기-주소는-apps-ts-한-곳과-Vite-env로.md`:

````markdown
# 0067. 다른 화면 바로가기 주소는 어드민 `apps.ts` 한 곳과 Vite env로

- 날짜 / 관련 기능: 2026-10-29 / 보강 5, 어드민(통합 입구)
- 상황: 시연에서는 어드민에서 시작해 매장 화면(:5174)·현장 화면(:5175)으로 건너가고, 이후 보강에서 운영 관제·개발자센터(보강 7)·가상 업체 콘솔·단말기 시뮬레이터 화면이 생긴다. Docker 묶음에서는 이 주소들이 바뀐다(포트·호스트). 주소가 화면 여기저기에 박히면 바뀔 때 여러 곳을 고쳐야 한다.
- 선택지:
  1. 화면에 주소를 바로 적는다 — 가장 짧지만 바뀔 때 찾아 고쳐야 한다
  2. **어드민 `src/apps.ts` 한 곳에 목록(이름·쓰는 사람·주소)을 두고, 주소는 Vite env(`VITE_MERCHANT_APP_URL` 등)로 바꾸며 없으면 로컬 개발 서버 주소** — 바뀔 때 env만 준다. 아직 없는 화면은 기본 주소 null("준비 중")로 자리만 둔다
  3. api가 주소 목록을 주는 엔드포인트(`GET /apps`) — 실행 중에 바꿀 수 있지만 엔드포인트·접근 표·계약이 늘고, 어드민이 api 없이 뜨면 바로가기도 없다. 주소는 배포 설정이지 업무 데이터가 아니다
  4. 저장소 `.env` 하나 — Vite는 앱 폴더의 `.env`와 `VITE_` 프로세스 env를 읽고 저장소 루트 `.env`는 읽지 않는다(`envDir`를 바꾸면 api 비밀값이 든 파일을 화면 빌드가 보게 된다)
- 결정: 2. `otherApps(env = import.meta.env)`가 목록을 만들고 왼쪽 메뉴 아래 "다른 화면"(`AppLinks`)이 새 탭 링크로 보인다. env를 인자로 받아 테스트가 바꿔 넣는다. 화면에는 "같은 브라우저에서 다른 화면에 로그인하면 이 화면의 로그인이 끝난다(쿠키 공유)" 안내를 함께 둔다(보강 3 기록 — localhost는 포트가 달라도 쿠키 `sid`가 하나).
- 결과·대가: Vite env는 개발 서버를 띄울 때·빌드할 때 들어간다 — 주소를 바꾸면 다시 띄우거나 다시 빌드해야 한다(실행 중 변경 없음). 새 화면을 만드는 보강은 이 파일에 기본 주소 한 줄을 채운다.
- 다시 볼 조건: 같은 빌드를 여러 환경에 그대로 올려야 하면(빌드 한 번, 주소는 실행 때) 3 또는 정적 `config.json`을 받아 읽는 방식으로.
````

`docs/decisions/0041-어드민-골격-Vite-프록시-작업자-헤더-도구.md` 끝에 한 줄:

```markdown
- 보강 5 보탬(decisions/0067·0068): `api()`가 `PATCH`(계정 바꾸기)와 `FormData` 본문(엑셀 올리기 — Content-Type은 붙이지 않고 브라우저가 multipart 경계와 함께 붙인다)을 받는다. 테스트의 가짜 fetch(`test/render.tsx`)는 FormData 본문을 그대로 기록한다. 왼쪽은 `aside.side` 안에 메뉴 `nav`와 "다른 화면" `nav`(주소는 `src/apps.ts` 한 곳)로 나뉜다. 이 클라이언트를 옮긴 매장·현장 사본(decisions/0058·0062)은 PATCH·FormData가 필요 없어 그대로 둔다.
```

`docs/study/backlog.md` 끝에 한 줄:

```markdown
- [ ] Vite env 읽기 규칙 — `envDir`·`.env.[mode]`·`VITE_` 접두사, 프로세스 env와 파일 env의 우선순위, 빌드 때 상수로 박히는 것 (apps/admin/src/apps.ts, decisions/0067)
```

devlog 항목(Task 1 항목 뒤):

```markdown
## HH:MM Task 2 어드민 바탕 — api 클라이언트 PATCH·FormData, 다른 화면 바로가기 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <Task 1 커밋 해시>
- 한 일: `api()`에 PATCH·FormData 본문, 가짜 fetch가 FormData 기록. `src/apps.ts`(`otherApps(env)` — 매장 :5174·현장 :5175 기본 주소, `VITE_*_URL`로 바꿈, 관제·개발자센터·업체 콘솔·시뮬레이터는 null), 왼쪽 메뉴 아래 `AppLinks`(새 탭, 준비 중, 쿠키 공유 안내)
- 확인: 새 테스트 실패(`./apps` 없음, FormData가 `{}`로, "다른 화면" nav 없음) → 통과. admin 전체 `Test Files  15 passed (15)`, `Tests  131 passed (131)`, build 성공
- 결정: decisions/0067(주소는 apps.ts 한 곳 + Vite env), 0041 보탬
- 다음: Task 3 단말기 등록 화면
```

```bash
node scripts/docs-index.mjs
```

- [ ] **Step 6: 커밋**

```bash
git add apps/admin docs
git status --short   # node_modules·dist가 없어야 한다
git commit -m "$(cat <<'EOF'
feat(admin): 다른 화면 바로가기(주소는 apps.ts 한 곳·Vite env)와 api 클라이언트 PATCH·FormData

Refs: docs/decisions/0067-다른-화면-바로가기-주소는-apps-ts-한-곳과-Vite-env로.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 제목 시각 = 커밋 시각인지 보고, 다르면 고쳐 `git commit --amend --no-edit`.

---

### Task 3: 단말기 등록 화면 — 한 대·엑셀 일괄, 행별 결과·실패한 행만·CSV

**Files:**
- Create: `apps/admin/src/pages/RegistrationPage.tsx`, `apps/admin/src/lib/csv.ts`
- Modify: `apps/admin/src/lib/labels.ts`, `apps/admin/src/nav.ts`, `apps/admin/src/App.tsx`
- Test: Create `apps/admin/src/pages/RegistrationPage.test.tsx`, `apps/admin/src/lib/csv.test.ts`
- Docs: Create `docs/decisions/0068-운영자-쓰기-화면은-새-메뉴-하나와-기존-화면-안의-폼으로.md`; Modify `docs/study/backlog.md`, `docs/index.md`, `docs/devlog/2026-10-29.md`

- [ ] **Step 1: 실패하는 테스트**

`apps/admin/src/lib/csv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { csvCell, csvDataUrl, toCsv } from './csv';

describe('CSV (보강 5 엑셀 등록 결과 내려받기)', () => {
  it('쉼표·따옴표·줄바꿈이 있는 칸만 따옴표로 감싸고, 안의 따옴표는 두 번', () => {
    expect(csvCell('SN-0001')).toBe('SN-0001');
    expect(csvCell(12)).toBe('12');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('그는 "예"라고')).toBe('"그는 ""예""라고"');
    expect(csvCell('줄\n바꿈')).toBe('"줄\n바꿈"');
    expect(toCsv([['a', 1], ['b,c', 2]])).toBe('a,1\r\n"b,c",2');
  });

  it('엑셀이 수식으로 읽는 머리 글자(= + - @)는 앞에 작은따옴표를 붙인다', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@a')).toBe("'@a");
  });

  it('내려받기 주소는 BOM을 붙인 UTF-8 data URL', () => {
    expect(decodeURIComponent(csvDataUrl('가,나').replace('data:text/csv;charset=utf-8,', ''))).toBe('﻿가,나');
  });
});
```

`apps/admin/src/pages/RegistrationPage.test.tsx`(모델 선택지는 비동기로 오므로 `findByRole('option', …)`로 기다린 뒤 고른다 — 바로 `selectOptions`하면 `Value "SN-100" not found in options`, 사전 검증에서 만남. `.csv` 파일 고르기는 `userEvent.setup({ applyAccept: false })` — 기본값이면 `accept`에 맞지 않는 파일을 user-event가 걸러 화면 검사까지 가지 않는다):

```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { TerminalImportView } from '@terminal-ops/contracts';
import { App } from '../App';
import { loginAs, mockApi, renderPage, type Call } from '../test/render';
import { fileProblem, RegistrationPage } from './RegistrationPage';

const MODELS = { 'GET /terminal-models': () => ({ body: [{ code: 'SN-100', name: '유선 카운터형', requiresReinspection: false }] }) };

const importBody: TerminalImportView = {
  fileName: '입고-1028.xlsx',
  total: 3,
  summary: { CREATED: 1, ALREADY_EXISTS: 1, INVALID_FORMAT: 1 },
  results: [
    { row: 2, serialNo: 'XL-0001', result: 'CREATED' },
    { row: 3, serialNo: 'XL-0002', result: 'ALREADY_EXISTS', message: '이미 등록된 시리얼입니다.' },
    { row: 4, serialNo: 'bad', result: 'INVALID_FORMAT', message: 'serialNo는 대문자·숫자·하이픈 4~32자입니다.' },
  ],
};

const xlsx = (name = '입고-1028.xlsx', size = 10) => new File([new Uint8Array(size)], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

describe('단말기 등록 — 한 대 (F1, 보강 5)', () => {
  it('시리얼 형식이 틀리면 안내하고 등록 버튼이 꺼진다. 맞으면 POST /terminals로 보내고 등록된 단말기 링크를 보인다', async () => {
    const { calls } = mockApi({
      ...MODELS,
      'POST /terminals': (c: Call) => ({
        status: 201,
        body: { ...(c.body as object), modelName: '유선 카운터형', merchantCode: null, merchantName: null, status: 'RECEIVED', statusChangedAt: '2026-10-29T01:00:00.000Z', version: 1, createdAt: '2026-10-29T01:00:00.000Z', updatedAt: '2026-10-29T01:00:00.000Z' },
      }),
    });
    loginAs();
    renderPage(<RegistrationPage />);
    const form = screen.getByRole('form', { name: '한 대 등록' });
    await within(form).findByRole('option', { name: 'SN-100 유선 카운터형' }); // 모델 목록이 온 뒤에 고른다
    await userEvent.selectOptions(within(form).getByLabelText('모델'), 'SN-100');
    await userEvent.type(within(form).getByLabelText('시리얼'), 'sn-1');
    expect(within(form).getByText('시리얼은 대문자·숫자·하이픈 4~32자입니다.')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: '등록' })).toBeDisabled();

    await userEvent.clear(within(form).getByLabelText('시리얼'));
    await userEvent.type(within(form).getByLabelText('시리얼'), 'NEW-0001');
    await userEvent.click(within(form).getByRole('button', { name: '등록' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('NEW-0001 등록됨 · 입고');
    expect(within(form).getByRole('link', { name: 'NEW-0001' })).toHaveAttribute('href', '/terminals/NEW-0001');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ serialNo: 'NEW-0001', modelCode: 'SN-100' });
    expect(within(form).getByLabelText('시리얼')).toHaveValue('');
  });

  it('이미 있는 시리얼(409 DUPLICATE)은 서버 메시지와 안내를 보인다', async () => {
    mockApi({ ...MODELS, 'POST /terminals': () => ({ status: 409, body: { statusCode: 409, code: 'DUPLICATE', message: '이미 있는 값입니다(serial_no).' } }) });
    loginAs();
    renderPage(<RegistrationPage />);
    const form = screen.getByRole('form', { name: '한 대 등록' });
    await within(form).findByRole('option', { name: 'SN-100 유선 카운터형' }); // 모델 목록이 온 뒤에 고른다
    await userEvent.selectOptions(within(form).getByLabelText('모델'), 'SN-100');
    await userEvent.type(within(form).getByLabelText('시리얼'), 'DUP-0001');
    await userEvent.click(within(form).getByRole('button', { name: '등록' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('DUPLICATE');
  });
});

describe('단말기 등록 — 엑셀 일괄 (F1, 보강 5)', () => {
  it('파일 문제: .xlsx가 아니거나 2MB를 넘으면 올리기 전에 알린다', () => {
    expect(fileProblem(null)).toBeNull();
    expect(fileProblem(xlsx())).toBeNull();
    expect(fileProblem(xlsx('목록.csv'))).toBe('.xlsx 파일만 올릴 수 있습니다.');
    expect(fileProblem(xlsx('큰.XLSX', 2 * 1024 * 1024 + 1))).toBe('파일이 2MB를 넘습니다. 나눠서 올리세요.');
  });

  it('.xlsx가 아니면 올리기가 꺼지고 요청하지 않는다', async () => {
    const { calls } = mockApi(MODELS);
    loginAs();
    renderPage(<RegistrationPage />);
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(screen.getByLabelText('엑셀 파일'), xlsx('목록.csv'));
    expect(screen.getByText('.xlsx 파일만 올릴 수 있습니다.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '올리기' })).toBeDisabled();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('올리면 파일을 multipart file 필드로 보내고, 행별 결과·요약·실패한 행만·CSV 내려받기를 보인다', async () => {
    const { calls } = mockApi({ ...MODELS, 'POST /terminals/imports': () => ({ status: 201, body: importBody }) });
    loginAs();
    renderPage(<RegistrationPage />);
    const file = xlsx();
    await userEvent.upload(screen.getByLabelText('엑셀 파일'), file);
    await userEvent.click(screen.getByRole('button', { name: '올리기' }));

    const result = await screen.findByLabelText('등록 결과');
    expect(result).toHaveTextContent('입고-1028.xlsx · 3행 · 등록됨 1, 이미 등록됨 1, 형식 오류 1');
    const sent = calls.find((c) => c.path === '/terminals/imports')!;
    expect(sent.body).toBeInstanceOf(FormData);
    expect((sent.body as FormData).get('file')).toBe(file);
    expect(within(result).getAllByRole('row')).toHaveLength(4); // 머리글 + 3행

    await userEvent.click(within(result).getByLabelText('실패한 행만'));
    const rows = within(result).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      '3XL-0002이미 등록됨이미 등록된 시리얼입니다.',
      '4bad형식 오류serialNo는 대문자·숫자·하이픈 4~32자입니다.',
    ]);

    const link = within(result).getByRole('link', { name: '결과 내려받기(CSV)' });
    expect(link).toHaveAttribute('download', '입고-1028-결과.csv');
    const csv = decodeURIComponent(link.getAttribute('href')!.replace('data:text/csv;charset=utf-8,', ''));
    expect(csv.split('\r\n')).toEqual([
      '﻿row,serialNo,result,결과,이유',
      '2,XL-0001,CREATED,등록됨,',
      '3,XL-0002,ALREADY_EXISTS,이미 등록됨,이미 등록된 시리얼입니다.',
      '4,bad,INVALID_FORMAT,형식 오류,serialNo는 대문자·숫자·하이픈 4~32자입니다.',
    ]);
  });

  it('파일째 거절(400 MISSING_COLUMNS)이면 서버 메시지를 보이고 결과 표는 없다', async () => {
    mockApi({
      ...MODELS,
      'POST /terminals/imports': () => ({ status: 400, body: { statusCode: 400, code: 'MISSING_COLUMNS', message: '1행 머리글에 serialNo, modelCode 열이 있어야 합니다.' } }),
    });
    loginAs();
    renderPage(<RegistrationPage />);
    await userEvent.upload(screen.getByLabelText('엑셀 파일'), xlsx());
    await userEvent.click(screen.getByRole('button', { name: '올리기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1행 머리글에 serialNo, modelCode 열이 있어야 합니다.');
    expect(screen.queryByLabelText('등록 결과')).not.toBeInTheDocument();
  });
});

describe('단말기 등록 화면 — 역할 (보강 5)', () => {
  it('운영자 메뉴에 "단말기 등록"이 있고, 관제가 주소로 열면 권한 안내만(모델 목록도 부르지 않는다)', async () => {
    const { calls } = mockApi({ ...MODELS, 'GET /terminals': () => ({ body: { items: [], total: 0, page: 1, size: 20 } }) });
    loginAs('u', 'OPERATOR');
    const op = renderPage(<App />, { path: '/*', route: '/terminals' });
    expect(await within(screen.getByRole('navigation', { name: '메뉴' })).findByRole('link', { name: '단말기 등록' })).toHaveAttribute('href', '/registrations');
    op.unmount();

    loginAs('m', 'MONITOR');
    const before = calls.length;
    renderPage(<App />, { path: '/*', route: '/registrations' });
    expect(await screen.findByRole('alert')).toHaveTextContent('이 화면을 볼 권한이 없습니다');
    expect(within(screen.getByRole('navigation', { name: '메뉴' })).queryByRole('link', { name: '단말기 등록' })).not.toBeInTheDocument();
    await waitFor(() => expect(calls.slice(before).some((c) => c.path === '/terminal-models')).toBe(false));
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd apps/admin && npx vitest run src/pages/RegistrationPage.test.tsx src/lib/csv.test.ts
```

Expected(사전 검증 원문 요약): `Test Files  2 failed (2)`, `Tests  no tests` — `Error: Failed to resolve import "./csv" from "src/lib/csv.test.ts". Does the file exist?`, `Error: Failed to resolve import "./RegistrationPage" from "src/pages/RegistrationPage.test.tsx". Does the file exist?`

- [ ] **Step 3: 구현**

`apps/admin/src/lib/labels.ts`(행 결과 이름 — 키가 contracts `RowResultCode`와 하나라도 다르면 tsc가 막는다):

```diff
diff --git a/apps/admin/src/lib/labels.ts b/apps/admin/src/lib/labels.ts
index ef574d8..fbce816 100644
--- a/apps/admin/src/lib/labels.ts
+++ b/apps/admin/src/lib/labels.ts
@@ -1,4 +1,4 @@
-import type { Carrier, Role, TerminalStatus, TransitionSource } from '@terminal-ops/contracts';
+import type { Carrier, Role, RowResultCode, TerminalStatus, TransitionSource } from '@terminal-ops/contracts';
 
 /**
  * 화면에 보이는 이름만 둔다(규칙은 두지 않는다 — 가능한 전이는 서버가 준다, decisions/0040).
@@ -41,6 +41,19 @@ export const SOURCE_LABEL: Record<TransitionSource, string> = {
   SERVICE: 'A/S',
 };
 
+/** 일괄 등록(엑셀)의 행 결과(보강 5). 박스 스캔 화면은 코드를 그대로 보인다 */
+export const ROW_RESULT_LABEL: Record<RowResultCode, string> = {
+  CREATED: '등록됨',
+  RETURNED: '회수 입고됨',
+  INVALID_FORMAT: '형식 오류',
+  DUPLICATE_IN_REQUEST: '파일 안 중복',
+  UNKNOWN_MODEL: '모르는 모델',
+  ALREADY_EXISTS: '이미 등록됨',
+  NOT_IN_DELIVERY_NOTE: '납품 명세에 없음',
+  NOT_FOUND: '없는 단말기',
+  INVALID_STATE: '지금 상태로는 안 됨',
+};
+
 export const CARRIER_LABEL: Record<Carrier, string> = {
   BUNGAE: '번개택배',
   NEURIMBO: '느림보물류',
```

`apps/admin/src/lib/csv.ts`:

```ts
import type { TerminalImportView } from '@terminal-ops/contracts';
import { ROW_RESULT_LABEL } from './labels';

/** CSV 칸 하나: 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싸고 안의 따옴표는 두 번(RFC 4180). 엑셀이 수식으로 읽는 머리 글자(= + - @)는 앞에 '를 붙인다 */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: (string | number)[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/** 엑셀 일괄 등록 결과를 CSV로(행·시리얼·결과 코드·결과·이유). 화면이 내려받기 링크로 준다(보강 5) */
export function importResultCsv(view: TerminalImportView): string {
  return toCsv([
    ['row', 'serialNo', 'result', '결과', '이유'],
    ...view.results.map((r) => [r.row, r.serialNo, r.result, ROW_RESULT_LABEL[r.result] ?? r.result, r.message ?? '']),
  ]);
}

/**
 * 내려받기 링크 주소(data: URL). 앞에 BOM을 붙여 엑셀이 UTF-8 한글을 바로 읽게 한다.
 * Blob URL(URL.createObjectURL)은 해제 시점을 따로 관리해야 해서, 수천 행 정도인 이 결과는 data: URL로 충분하다
 */
export function csvDataUrl(csv: string): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(`﻿${csv}`)}`;
}
```

`apps/admin/src/pages/RegistrationPage.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import type { RegisterTerminalRequest, RowResultCode, TerminalImportView, TerminalModelView, TerminalView } from '@terminal-ops/contracts';
import { ErrorBox } from '../components/ErrorBox';
import { csvDataUrl, importResultCsv } from '../lib/csv';
import { label, ROW_RESULT_LABEL, TERMINAL_STATUS_LABEL } from '../lib/labels';

/** 서버 규칙과 같은 시리얼 형식(api terminal/bulk-rows.ts SERIAL_NO_PATTERN) — 화면은 미리 알려 줄 뿐, 최종 판단은 서버 */
export const SERIAL_NO_PATTERN = /^[A-Z0-9-]{4,32}$/;
/** 서버 상한(api terminal.controller.ts의 파일 크기 2MB) */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

const SUCCESS = new Set<RowResultCode>(['CREATED']);

/** 올리기 전에 화면이 거를 수 있는 파일 문제(서버도 같은 것을 400 INVALID_FILE·413 FILE_TOO_LARGE로 막는다) */
export function fileProblem(file: File | null): string | null {
  if (!file) return null;
  if (!file.name.toLowerCase().endsWith('.xlsx')) return '.xlsx 파일만 올릴 수 있습니다.';
  if (file.size > MAX_IMPORT_BYTES) return '파일이 2MB를 넘습니다. 나눠서 올리세요.';
  return null;
}

/**
 * 단말기 등록(F1, 보강 5): 한 대 등록과 엑셀 일괄 등록. 둘 다 입고(RECEIVED) 상태로 들어간다.
 * 엑셀은 1행 머리글에 serialNo·modelCode 열(순서·다른 열 무관), 5,000행까지(api decisions/0022). 결과는 행 순서대로 — 실패한 행만 고쳐 다시 올린다.
 */
export function RegistrationPage() {
  const client = useQueryClient();
  const models = useQuery({ queryKey: keys.terminalModels, queryFn: () => api<TerminalModelView[]>('/terminal-models'), staleTime: Infinity });

  const [serialNo, setSerialNo] = useState('');
  const [modelCode, setModelCode] = useState('');
  const serialOk = SERIAL_NO_PATTERN.test(serialNo);
  const register = useMutation({
    mutationFn: (body: RegisterTerminalRequest) => api<TerminalView>('/terminals', { method: 'POST', body }),
    onSuccess: async () => {
      setSerialNo('');
      await client.invalidateQueries({ queryKey: keys.terminals.all });
    },
  });
  const submitOne = (event: FormEvent) => {
    event.preventDefault();
    if (serialOk && modelCode) register.mutate({ serialNo, modelCode } satisfies RegisterTerminalRequest);
  };

  const [file, setFile] = useState<File | null>(null);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const problem = fileProblem(file);
  const upload = useMutation({
    mutationFn: (f: File) => {
      const form = new FormData();
      form.append('file', f);
      return api<TerminalImportView>('/terminals/imports', { method: 'POST', body: form });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: keys.terminals.all });
    },
  });
  const result = upload.data;
  const rows = result ? result.results.filter((r) => !onlyFailed || !SUCCESS.has(r.result)) : [];

  return (
    <section>
      <h2>단말기 등록</h2>

      <form className="panel" aria-label="한 대 등록" onSubmit={submitOne}>
        <h3>한 대 등록</h3>
        <div className="row">
          <input aria-label="시리얼" placeholder="시리얼(예 SN1-000123)" value={serialNo} onChange={(e) => setSerialNo(e.target.value.trim())} />
          <select aria-label="모델" value={modelCode} onChange={(e) => setModelCode(e.target.value)}>
            <option value="">모델 선택</option>
            {models.data?.map((m) => (
              <option key={m.code} value={m.code}>
                {m.code} {m.name}
              </option>
            ))}
          </select>
          <button type="submit" className="primary" disabled={!serialOk || !modelCode || register.isPending}>
            등록
          </button>
        </div>
        {serialNo && !serialOk ? <p className="field-error">시리얼은 대문자·숫자·하이픈 4~32자입니다.</p> : null}
        <ErrorBox error={register.error} />
        {register.data ? (
          <p className="ok" role="status">
            <Link to={`/terminals/${encodeURIComponent(register.data.serialNo)}`}>{register.data.serialNo}</Link> 등록됨 ·{' '}
            {label(TERMINAL_STATUS_LABEL, register.data.status)}
          </p>
        ) : null}
      </form>

      <div className="panel" aria-label="엑셀 일괄 등록">
        <h3>엑셀 일괄 등록</h3>
        <p className="hint">.xlsx 첫 시트, 1행 머리글에 serialNo·modelCode 열. 5,000행·2MB까지. 성공한 행만 등록되고 실패한 행은 이유와 함께 돌려받습니다.</p>
        <div className="row">
          <input
            aria-label="엑셀 파일"
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              upload.reset();
            }}
          />
          <button type="button" className="primary" disabled={!file || problem !== null || upload.isPending} onClick={() => file && upload.mutate(file)}>
            {upload.isPending ? '올리는 중…' : '올리기'}
          </button>
        </div>
        {problem ? <p className="field-error">{problem}</p> : null}
        <ErrorBox error={upload.error} />
        {result ? (
          <div aria-label="등록 결과">
            <p>
              <strong>{result.fileName}</strong> · {result.total}행 ·{' '}
              {Object.entries(result.summary)
                .map(([code, n]) => `${label(ROW_RESULT_LABEL, code)} ${n}`)
                .join(', ')}
            </p>
            <div className="row">
              <label>
                <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} /> 실패한 행만
              </label>
              <a href={csvDataUrl(importResultCsv(result))} download={`${result.fileName.replace(/\.xlsx$/i, '')}-결과.csv`}>
                결과 내려받기(CSV)
              </a>
            </div>
            <table>
              <thead>
                <tr>
                  <th scope="col">행</th>
                  <th scope="col">시리얼</th>
                  <th scope="col">결과</th>
                  <th scope="col">이유</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.row}>
                    <td>{r.row}</td>
                    <td>{r.serialNo}</td>
                    <td className={SUCCESS.has(r.result) ? 'ok' : 'bad'}>{label(ROW_RESULT_LABEL, r.result)}</td>
                    <td>{r.message ?? ''}</td>
                  </tr>
                ))}
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="muted">
                      {onlyFailed ? '실패한 행이 없습니다.' : '데이터 행이 없습니다.'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </section>
  );
}
```

`apps/admin/src/nav.ts`(운영자만):

```diff
diff --git a/apps/admin/src/nav.ts b/apps/admin/src/nav.ts
index 6271932..ab6a507 100644
--- a/apps/admin/src/nav.ts
+++ b/apps/admin/src/nav.ts
@@ -8,6 +8,7 @@ import { OFFICE, STAFF } from './session';
 export const NAV: { to: string; label: string; roles: readonly Role[] }[] = [
   { to: '/', label: '처음', roles: OFFICE },
   { to: '/terminals', label: '단말기', roles: STAFF },
+  { to: '/registrations', label: '단말기 등록', roles: ['OPERATOR'] },
   { to: '/scans', label: '박스 스캔', roles: ['OPERATOR', 'FIELD'] },
   { to: '/service-tickets', label: 'A/S', roles: OFFICE },
   { to: '/firmware-rollouts', label: '펌웨어 배포', roles: OFFICE },
```

`apps/admin/src/App.tsx`:

```diff
diff --git a/apps/admin/src/App.tsx b/apps/admin/src/App.tsx
index cf000e3..9068aa9 100644
--- a/apps/admin/src/App.tsx
+++ b/apps/admin/src/App.tsx
@@ -13,6 +13,7 @@ import { VanRunDetailPage } from './pages/reports/VanRunDetailPage';
 import { VanRunsPage } from './pages/reports/VanRunsPage';
 import { WeeklyReportsPage } from './pages/reports/WeeklyReportsPage';
 import { HomePage } from './pages/HomePage';
+import { RegistrationPage } from './pages/RegistrationPage';
 import { RolloutsPage } from './pages/RolloutsPage';
 import { ScanPage } from './pages/ScanPage';
 import { ServiceTicketDetailPage } from './pages/ServiceTicketDetailPage';
@@ -45,6 +46,7 @@ export function App() {
           <Route index element={<Home />} />
           <Route path="terminals" element={guard('/terminals', <TerminalListPage />)} />
           <Route path="terminals/:serialNo" element={guard('/terminals', <TerminalDetailPage />)} />
+          <Route path="registrations" element={guard('/registrations', <RegistrationPage />)} />
           <Route path="scans" element={guard('/scans', <ScanPage />)} />
           <Route path="service-tickets" element={guard('/service-tickets', <ServiceTicketsPage />)} />
           <Route path="service-tickets/:id" element={guard('/service-tickets', <ServiceTicketDetailPage />)} />
```

- [ ] **Step 4: 통과 확인과 전체 admin**

```bash
cd apps/admin
npx vitest run src/pages/RegistrationPage.test.tsx src/lib/csv.test.ts
npx vitest run 2>&1 | tail -4
npm run build && rm -rf dist
```

Expected: 두 파일 `Test Files  2 passed (2)`, `Tests  10 passed (10)`. 전체 `Test Files  17 passed (17)`, `Tests  141 passed (141)`. build 성공. 관제의 메뉴 수(Layout 테스트 9)와 현장 작업자 메뉴(LoginPage 테스트 `['단말기', '박스 스캔']`)는 그대로다(새 메뉴는 운영자만).

- [ ] **Step 5: 기록**

`docs/decisions/0068-운영자-쓰기-화면은-새-메뉴-하나와-기존-화면-안의-폼으로.md`(아래 `## Task 4 보탬` 절은 Task 4가 더한다 — 지금은 그 위까지만):

````markdown
# 0068. 운영자 쓰기 화면은 새 메뉴 하나(단말기 등록)와 기존 화면 안의 폼으로

- 날짜 / 관련 기능: 2026-10-29 / 보강 5, F1·F8·F10, 어드민
- 상황: 화면이 없던 운영자 쓰기는 단말기 한 대 등록, 엑셀 일괄 등록, 펌웨어 등록, 단계 배포 만들기다. 발주는 이미 "발주 입고 대조" 화면(Day 6)에 발주하기(모델·수량)·발주 목록·고른 발주의 대조(명세 수·입고·빠진 것·명세 밖)·마감이 다 있다. 새 화면을 어디에 둘지, 발주 화면을 나눌지 정해야 한다.
- 선택지:
  1. 기능마다 새 메뉴(단말기 등록·발주·펌웨어) — 메뉴가 셋 늘고, 발주는 "발주"와 "입고 대조"가 같은 데이터를 두 화면에서 보인다
  2. **단말기 등록만 새 메뉴(`/registrations`, 운영자만), 발주는 기존 화면 그대로, 펌웨어 등록·배포 만들기는 펌웨어 배포 화면 위의 접힌 폼(운영자만)** — 쓰기가 그 결과를 보는 화면 옆에 있다. 메뉴는 하나만 는다
  3. 단말기 등록을 단말기 목록 화면 안에 — 목록은 STAFF(현장 작업자 포함) 화면이라 운영자 전용 폼·업로드가 섞이고, 목록 조건이 주소(`?status=`)에 있어 폼 상태와 얽힌다
- 결정: 2.
  - 단말기 등록: 한 대(시리얼·모델, 서버와 같은 형식 규칙을 미리 안내) + 엑셀(.xlsx·2MB를 올리기 전에 보고, `FormData`의 `file` 필드로). 결과는 행 번호·시리얼·결과(이름 + 코드)·이유 표, "실패한 행만", 결과 CSV 내려받기. CSV는 서버가 아니라 화면이 응답으로 만든다(새 API 없음, BOM을 붙인 `data:` URL — 엑셀이 한글을 바로 읽는다. 엑셀이 수식으로 읽는 머리 글자 `= + - @`는 앞에 `'`).
  - 발주: 화면을 나누지 않는다(발주 생성·대조·마감이 한 화면에 이미 있다). 메뉴 이름·경로도 그대로 둔다 — 바꾸면 기존 테스트·기록의 이름이 바뀐다.
- 결과·대가: 엑셀 결과 CSV는 화면 메모리에서 만든다 — 5,000행이면 수백 KB의 `data:` URL이 된다(브라우저가 감당하는 크기). 단말기 등록 화면은 운영자만이라 관제·ADMIN은 메뉴에서 보이지 않는다(주소로 열면 권한 안내, RequireRole).
- 다시 볼 조건: 결과 파일을 나중에 다시 받아야 하거나(감사), 행이 수만 개가 되면 서버가 결과 파일을 저장해 내려주는 방식으로.
````

`docs/study/backlog.md` 끝에 한 줄:

```markdown
- [ ] CSV 수식 주입(= + - @로 시작하는 칸)과 엑셀이 UTF-8 CSV를 읽는 방법(BOM), `data:` URL과 Blob URL(`createObjectURL`·`revokeObjectURL`)의 차이 (apps/admin/src/lib/csv.ts, decisions/0068)
```

devlog 항목(Task 2 항목 뒤):

```markdown
## HH:MM Task 3 단말기 등록 화면 — 한 대·엑셀, 행별 결과·CSV (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <Task 2 커밋 해시>
- 한 일: `/registrations`(운영자 메뉴 "단말기 등록") — 한 대(시리얼 형식 미리 안내, POST /terminals, 등록된 단말기 링크), 엑셀(.xlsx·2MB 미리 확인, FormData `file`로 POST /terminals/imports, 파일 이름·행 수·결과 요약, 행별 표, 실패한 행만, 결과 CSV 내려받기). `lib/csv.ts`(따옴표·수식 머리 글자·BOM data URL), `ROW_RESULT_LABEL`
- 확인: 새 테스트 실패(`./csv`·`./RegistrationPage` 없음) → 통과(2파일 10개). admin 전체 `Test Files  17 passed (17)`, `Tests  141 passed (141)`, build 성공
- 결정: decisions/0068(단말기 등록만 새 메뉴, 발주는 기존 화면 그대로, 결과 CSV는 화면이 만든다)
- 다음: Task 4 펌웨어 등록·배포 만들기
```

```bash
node scripts/docs-index.mjs
```

- [ ] **Step 6: 커밋**

```bash
git add apps/admin docs
git status --short
git commit -m "$(cat <<'EOF'
feat(admin, F1): 단말기 등록 화면 — 한 대·엑셀 일괄, 행별 결과·실패한 행만·결과 CSV

Refs: docs/decisions/0068-운영자-쓰기-화면은-새-메뉴-하나와-기존-화면-안의-폼으로.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 제목 시각 = 커밋 시각인지 보고, 다르면 고쳐 `git commit --amend --no-edit`.

---

### Task 4: 펌웨어 등록·배포 만들기 — 펌웨어 배포 화면의 접힌 폼(운영자)

**Files:**
- Create: `apps/admin/src/pages/RolloutForms.tsx`
- Modify: `apps/admin/src/pages/RolloutsPage.tsx`, `apps/admin/src/api/query-keys.ts`, `apps/admin/src/components/ErrorBox.tsx`
- Test: Create `apps/admin/src/pages/RolloutForms.test.tsx`; Modify `apps/admin/src/api/query-keys.test.ts`
- Docs: Modify `docs/decisions/0068-운영자-쓰기-화면은-새-메뉴-하나와-기존-화면-안의-폼으로.md`, `docs/index.md`, `docs/devlog/2026-10-29.md`

- [ ] **Step 1: 실패하는 테스트**

`apps/admin/src/pages/RolloutForms.test.tsx`(펌웨어 목록 가짜 api는 `?modelCode=SN-100`일 때만 두 버전, 다른 모델은 빈 목록. 확인 창은 `vi.spyOn(window, 'confirm')`):

```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FirmwareView, RolloutView } from '@terminal-ops/contracts';
import { loginAs, mockApi, renderPage, type Call } from '../test/render';
import { parseStages } from './RolloutForms';
import { RolloutsPage } from './RolloutsPage';

const MODELS = {
  'GET /terminal-models': () => ({
    body: [
      { code: 'SN-100', name: '유선 카운터형', requiresReinspection: false },
      { code: 'SN-300', name: '테이블오더 태블릿형', requiresReinspection: false },
    ],
  }),
};
const fw = (id: number, modelCode: string, version: string): FirmwareView => ({ id, modelCode, version, createdBy: 'kim', createdAt: '2026-10-29T01:00:00.000Z' });
const FIRMWARE = {
  'GET /firmware': (c: Call) => ({
    body: { items: c.query.get('modelCode') === 'SN-100' ? [fw(3, 'SN-100', '2.1.0'), fw(1, 'SN-100', '2.0.0')] : [], nextBeforeId: null },
  }),
};
const created = (over: Partial<RolloutView> = {}): RolloutView => ({
  id: 9,
  modelCode: 'SN-100',
  version: '2.1.0',
  status: 'RUNNING',
  stages: [10, 50, 100],
  currentStage: 0,
  failureThreshold: 0.3,
  minSamples: 3,
  stageTimeoutMs: 900_000,
  stageStartedAt: '2026-10-29T01:00:00.000Z',
  createdBy: 'kim',
  createdAt: '2026-10-29T01:00:00.000Z',
  finishedAt: null,
  endReason: null,
  stageStats: [
    { stage: 0, percent: 10, targets: 2, offered: 2, succeeded: 0, failed: 0, timedOut: 0 },
    { stage: 1, percent: 50, targets: 0, offered: 0, succeeded: 0, failed: 0, timedOut: 0 },
    { stage: 2, percent: 100, targets: 0, offered: 0, succeeded: 0, failed: 0, timedOut: 0 },
  ],
  ...over,
});
const EMPTY_LIST = { 'GET /firmware-rollouts': () => ({ body: { items: [], nextBeforeId: null } }) };

describe('단계 비율 읽기 parseStages (보강 5)', () => {
  it('쉼표·공백으로 나눈 누적 비율. 서버 규칙(1~10개, 1~100 정수, 커지는 순서, 마지막 100)을 미리 본다', () => {
    expect(parseStages('10, 50, 100')).toEqual({ stages: [10, 50, 100] });
    expect(parseStages(' 100 ')).toEqual({ stages: [100] });
    expect(parseStages('')).toEqual({ error: '단계 비율을 쉼표로 적으세요(예 10, 50, 100).' });
    expect(parseStages('50, 10, 100')).toEqual({ error: '단계 비율은 커지는 순서여야 합니다(누적 비율).' });
    expect(parseStages('10, 50')).toEqual({ error: '마지막 단계는 100이어야 합니다.' });
    expect(parseStages('0, 100')).toEqual({ error: '단계 비율은 1~100 사이 정수입니다.' });
    expect(parseStages('10.5, 100')).toEqual({ error: '단계 비율은 1~100 사이 정수입니다.' });
    expect(parseStages('1,2,3,4,5,6,7,8,9,10,100')).toEqual({ error: '단계는 10개까지입니다.' });
  });
});

describe('펌웨어 등록·배포 만들기 (F8, 보강 5)', () => {
  it('운영자가 아니면(관제) 등록·만들기 버튼이 없고 모델·펌웨어 목록을 부르지 않는다', async () => {
    const { calls } = mockApi(EMPTY_LIST);
    loginAs('m', 'MONITOR');
    renderPage(<RolloutsPage />);
    await waitFor(() => expect(calls.some((c) => c.path === '/firmware-rollouts')).toBe(true));
    expect(screen.queryByRole('button', { name: '펌웨어 등록' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '새 배포 만들기' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/terminal-models' || c.path === '/firmware')).toBe(false);
  });

  it('펌웨어 등록: 버전 형식이 틀리면 꺼지고, 맞으면 POST /firmware로 보낸다. 같은 버전은 409 DUPLICATE 안내', async () => {
    let dup = false;
    const { calls } = mockApi({
      ...EMPTY_LIST,
      ...MODELS,
      'POST /firmware': (c) => (dup ? { status: 409, body: { statusCode: 409, code: 'DUPLICATE', message: '이미 있는 값입니다.' } } : { status: 201, body: fw(5, 'SN-100', (c.body as { version: string }).version) }),
    });
    loginAs();
    renderPage(<RolloutsPage />);
    await userEvent.click(screen.getByRole('button', { name: '펌웨어 등록' }));
    const form = screen.getByRole('form', { name: '펌웨어 등록' });
    await within(form).findByRole('option', { name: 'SN-100 유선 카운터형' });
    await userEvent.selectOptions(within(form).getByLabelText('펌웨어 모델'), 'SN-100');
    await userEvent.type(within(form).getByLabelText('버전'), '2.2.0_beta');
    expect(within(form).getByText('버전은 영문·숫자·점·하이픈 1~20자입니다.')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: '등록' })).toBeDisabled();

    await userEvent.clear(within(form).getByLabelText('버전'));
    await userEvent.type(within(form).getByLabelText('버전'), '2.2.0');
    await userEvent.click(within(form).getByRole('button', { name: '등록' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('SN-100 2.2.0 등록됨');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ modelCode: 'SN-100', version: '2.2.0' });

    dup = true;
    await userEvent.type(within(form).getByLabelText('버전'), '2.2.0');
    await userEvent.click(within(form).getByRole('button', { name: '등록' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('이미 있는 값입니다');
  });

  it('배포 만들기: 모델을 고르면 그 모델의 등록 버전만 선택지. 확인을 받고 POST, 단계·임계치(%)·최소 표본·시간 제한(분)을 서버 단위로 바꿔 보낸다', async () => {
    const { calls } = mockApi({ ...EMPTY_LIST, ...MODELS, ...FIRMWARE, 'POST /firmware-rollouts': () => ({ status: 201, body: created() }) });
    loginAs();
    renderPage(<RolloutsPage />);
    await userEvent.click(screen.getByRole('button', { name: '새 배포 만들기' }));
    const form = screen.getByRole('form', { name: '배포 만들기' });
    expect(within(form).getByLabelText('배포 버전')).toBeDisabled();
    await within(form).findByRole('option', { name: 'SN-100 유선 카운터형' });
    await userEvent.selectOptions(within(form).getByLabelText('배포 모델'), 'SN-100');
    await within(form).findByRole('option', { name: '2.1.0' });
    expect(within(within(form).getByLabelText('배포 버전')).getAllByRole('option').map((o) => o.textContent)).toEqual(['버전 선택', '2.1.0', '2.0.0']);
    const asked = calls.find((c) => c.path === '/firmware')!;
    expect([asked.query.get('modelCode'), asked.query.get('limit')]).toEqual(['SN-100', '100']);
    await userEvent.selectOptions(within(form).getByLabelText('배포 버전'), '2.1.0');

    await userEvent.clear(within(form).getByLabelText('단계 비율'));
    await userEvent.type(within(form).getByLabelText('단계 비율'), '50, 10, 100');
    expect(within(form).getByText('단계 비율은 커지는 순서여야 합니다(누적 비율).')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: '배포 시작' })).toBeDisabled();
    await userEvent.clear(within(form).getByLabelText('단계 비율'));
    await userEvent.type(within(form).getByLabelText('단계 비율'), '10, 50, 100');
    await userEvent.clear(within(form).getByLabelText('실패 임계치'));
    await userEvent.type(within(form).getByLabelText('실패 임계치'), '30');
    await userEvent.clear(within(form).getByLabelText('최소 표본'));
    await userEvent.type(within(form).getByLabelText('최소 표본'), '3');
    await userEvent.clear(within(form).getByLabelText('단계 시간 제한'));
    await userEvent.type(within(form).getByLabelText('단계 시간 제한'), '15');

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await userEvent.click(within(form).getByRole('button', { name: '배포 시작' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false); // 취소하면 보내지 않는다
    expect(confirm.mock.calls[0][0]).toContain('1단계(10%) 대상 단말기에 바로 업데이트 제안이 나갑니다');
    const listReads = calls.filter((c) => c.path === '/firmware-rollouts').length;
    await userEvent.click(within(form).getByRole('button', { name: '배포 시작' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('배포 #9 SN-100 2.1.0 시작 · 1단계 대상 2대');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      modelCode: 'SN-100',
      version: '2.1.0',
      stages: [10, 50, 100],
      failureThreshold: 0.3,
      minSamples: 3,
      stageTimeoutMs: 900_000,
    });
    await waitFor(() => expect(calls.filter((c) => c.path === '/firmware-rollouts' && c.method === 'GET').length).toBeGreaterThan(listReads));
  });

  it('등록된 펌웨어가 없는 모델은 안내하고 버전 선택이 꺼진다. 진행 중 배포가 있으면(409 ROLLOUT_ALREADY_ACTIVE) 안내', async () => {
    mockApi({
      ...EMPTY_LIST,
      ...MODELS,
      ...FIRMWARE,
      'POST /firmware-rollouts': () => ({ status: 409, body: { statusCode: 409, code: 'ROLLOUT_ALREADY_ACTIVE', message: '모델 SN-100에 진행 중인 펌웨어 배포가 있습니다.' } }),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    loginAs();
    renderPage(<RolloutsPage />);
    await userEvent.click(screen.getByRole('button', { name: '새 배포 만들기' }));
    const form = screen.getByRole('form', { name: '배포 만들기' });
    await within(form).findByRole('option', { name: 'SN-300 테이블오더 태블릿형' });
    await userEvent.selectOptions(within(form).getByLabelText('배포 모델'), 'SN-300');
    expect(await within(form).findByText('이 모델에 등록된 펌웨어가 없습니다. 먼저 펌웨어를 등록하세요.')).toBeInTheDocument();
    expect(within(form).getByLabelText('배포 버전')).toBeDisabled();

    await userEvent.selectOptions(within(form).getByLabelText('배포 모델'), 'SN-100');
    await within(form).findByRole('option', { name: '2.1.0' });
    await userEvent.selectOptions(within(form).getByLabelText('배포 버전'), '2.1.0');
    await userEvent.click(within(form).getByRole('button', { name: '배포 시작' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('이 모델에 진행 중이거나 멈춘 배포가 있습니다');
  });
});
```

`apps/admin/src/api/query-keys.test.ts`(한 줄):

```diff
diff --git a/apps/admin/src/api/query-keys.test.ts b/apps/admin/src/api/query-keys.test.ts
index 286d2cc..d879843 100644
--- a/apps/admin/src/api/query-keys.test.ts
+++ b/apps/admin/src/api/query-keys.test.ts
@@ -20,6 +20,7 @@ describe('쿼리 키 팩토리 (Day 6 최종 리뷰 Minor 4, decisions/0041 Day
     expect(startsWith(keys.serviceTicket.one(7), keys.serviceTicket.all)).toBe(true);
     expect(startsWith(keys.anomalies.list('OFFLINE_TOO_LONG', 'true'), keys.anomalies.all)).toBe(true);
     expect(startsWith(keys.vanRun.items(3, '', ''), keys.vanRun.all)).toBe(true);
+    expect(startsWith(keys.firmware.byModel('SN-100'), keys.firmware.all)).toBe(true);
   });
 
   it('목록 묶음(복수)과 한 건 묶음(단수)의 첫 칸이 서로 다르다 — 한쪽 무효화가 다른 쪽을 대신하지 않는다는 것을 이름으로 드러낸다', () => {
```

- [ ] **Step 2: 실패 확인**

```bash
cd apps/admin && npx vitest run src/pages/RolloutForms.test.tsx src/api/query-keys.test.ts
```

Expected(사전 검증 원문 요약): `Test Files  2 failed (2)`, `Tests  1 failed | 2 passed (3)` — `Error: Failed to resolve import "./RolloutForms" from "src/pages/RolloutForms.test.tsx". Does the file exist?`, query-keys `TypeError: Cannot read properties of undefined (reading 'byModel')`

- [ ] **Step 3: 구현**

`apps/admin/src/api/query-keys.ts`:

```diff
diff --git a/apps/admin/src/api/query-keys.ts b/apps/admin/src/api/query-keys.ts
index ca0f4d0..bf4d111 100644
--- a/apps/admin/src/api/query-keys.ts
+++ b/apps/admin/src/api/query-keys.ts
@@ -44,6 +44,11 @@ export const keys = {
     one: (id: number) => ['service-ticket', id] as const,
   },
   rollouts: { all: ['firmware-rollouts'] as const },
+  /** 등록된 펌웨어(배포 만들기의 버전 선택지, 보강 5). 펌웨어를 등록하면 all로 */
+  firmware: {
+    all: ['firmware'] as const,
+    byModel: (modelCode: string) => ['firmware', modelCode] as const,
+  },
   anomalies: {
     all: ['anomalies'] as const,
     list: (rule: string, open: string) => ['anomalies', rule, open] as const,
```

`apps/admin/src/components/ErrorBox.tsx`(안내 둘):

```diff
diff --git a/apps/admin/src/components/ErrorBox.tsx b/apps/admin/src/components/ErrorBox.tsx
index 49c8559..0d1d11d 100644
--- a/apps/admin/src/components/ErrorBox.tsx
+++ b/apps/admin/src/components/ErrorBox.tsx
@@ -10,6 +10,8 @@ const HINT: Partial<Record<ErrorCode, string>> = {
   PARTNER_ERROR: '외부 업체(가상) 응답이 실패했습니다. 잠시 뒤 다시 시도하세요.',
   VAN_RECONCILIATION_RUNNING: '이미 진행 중인 작업이 있습니다. 끝난 뒤 다시 실행하세요.',
   ANOMALY_SCAN_RUNNING: '이미 진행 중인 작업이 있습니다. 끝난 뒤 다시 실행하세요.',
+  ROLLOUT_ALREADY_ACTIVE: '이 모델에 진행 중이거나 멈춘 배포가 있습니다. 그 배포를 끝내거나 중단한 뒤 만드세요.',
+  INVALID_STAGES: '단계 비율은 커지는 순서이고 마지막이 100이어야 합니다.',
   FORBIDDEN: '이 작업을 할 권한이 없습니다(역할 확인).',
   UNAUTHENTICATED: '로그인이 끝났습니다. 다시 로그인하세요.',
   LOGIN_FAILED: '아이디 또는 비밀번호가 맞지 않습니다.',
```

`apps/admin/src/pages/RolloutForms.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import type { BeforeIdPage, CreateRolloutRequest, FirmwareView, RegisterFirmwareRequest, RolloutView, TerminalModelView } from '@terminal-ops/contracts';
import { ErrorBox } from '../components/ErrorBox';
import { formatKst } from '../lib/format';

/** 서버 규칙과 같은 버전 형식(api device/heartbeat.service.ts FIRMWARE_VERSION_PATTERN) */
export const FIRMWARE_VERSION_PATTERN = /^[0-9A-Za-z.-]{1,20}$/;
/** 서버 상한(api firmware.dto.ts MAX_STAGE_TIMEOUT_MS = 하루) */
export const MAX_STAGE_TIMEOUT_MINUTES = 24 * 60;

/**
 * "10, 50, 100" → [10, 50, 100]. 서버 규칙(1~10개, 1~100 정수, 커지는 순서, 마지막 100 — api rollout.service.ts checkStages·CreateRolloutDto)을
 * 미리 본다. 틀리면 이유 글자. 화면 검사는 안내일 뿐 최종 판단은 서버(400 INVALID_STAGES)
 */
export function parseStages(text: string): { stages: number[] } | { error: string } {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return { error: '단계 비율을 쉼표로 적으세요(예 10, 50, 100).' };
  if (parts.length > 10) return { error: '단계는 10개까지입니다.' };
  const stages = parts.map(Number);
  if (stages.some((p) => !Number.isInteger(p) || p < 1 || p > 100)) return { error: '단계 비율은 1~100 사이 정수입니다.' };
  if (stages.some((p, i) => i > 0 && p <= stages[i - 1])) return { error: '단계 비율은 커지는 순서여야 합니다(누적 비율).' };
  if (stages.at(-1) !== 100) return { error: '마지막 단계는 100이어야 합니다.' };
  return { stages };
}

function useModels(enabled: boolean) {
  return useQuery({ queryKey: keys.terminalModels, queryFn: () => api<TerminalModelView[]>('/terminal-models'), staleTime: Infinity, enabled });
}

function ModelSelect({ label, value, onChange, models }: { label: string; value: string; onChange: (v: string) => void; models: TerminalModelView[] | undefined }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">모델 선택</option>
      {models?.map((m) => (
        <option key={m.code} value={m.code}>
          {m.code} {m.name}
        </option>
      ))}
    </select>
  );
}

/** 펌웨어 등록(모델·버전). 같은 (모델, 버전)이 있으면 409 DUPLICATE */
export function FirmwareRegisterForm() {
  const client = useQueryClient();
  const models = useModels(true);
  const [modelCode, setModelCode] = useState('');
  const [version, setVersion] = useState('');
  const versionOk = FIRMWARE_VERSION_PATTERN.test(version);
  const register = useMutation({
    mutationFn: (body: RegisterFirmwareRequest) => api<FirmwareView>('/firmware', { method: 'POST', body }),
    onSuccess: async () => {
      setVersion('');
      await client.invalidateQueries({ queryKey: keys.firmware.all });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (modelCode && versionOk) register.mutate({ modelCode, version } satisfies RegisterFirmwareRequest);
  };
  return (
    <form className="panel" aria-label="펌웨어 등록" onSubmit={submit}>
      <h3>펌웨어 등록</h3>
      <div className="row">
        <ModelSelect label="펌웨어 모델" value={modelCode} onChange={setModelCode} models={models.data} />
        <input aria-label="버전" placeholder="버전(예 2.1.0)" value={version} onChange={(e) => setVersion(e.target.value.trim())} />
        <button type="submit" className="primary" disabled={!modelCode || !versionOk || register.isPending}>
          등록
        </button>
      </div>
      {version && !versionOk ? <p className="field-error">버전은 영문·숫자·점·하이픈 1~20자입니다.</p> : null}
      <ErrorBox error={models.error ?? register.error} />
      {register.data ? (
        <p className="ok" role="status">
          {register.data.modelCode} {register.data.version} 등록됨 · {formatKst(register.data.createdAt)}
        </p>
      ) : null}
    </form>
  );
}

/**
 * 단계 배포 만들기(F8, decisions/0030). 만들자마자 1단계 대상(운영 중 단말기 중 첫 비율만큼)에 제안이 나가므로 확인을 받는다.
 * 버전은 그 모델에 등록된 펌웨어에서 고른다(GET /firmware?modelCode=, decisions/0066). 같은 모델에 진행 중·멈춤 배포가 있으면 409 ROLLOUT_ALREADY_ACTIVE
 */
export function RolloutCreateForm() {
  const client = useQueryClient();
  const models = useModels(true);
  const [modelCode, setModelCode] = useState('');
  const [version, setVersion] = useState('');
  const [stagesText, setStagesText] = useState('10, 50, 100');
  const [thresholdPct, setThresholdPct] = useState('20');
  const [minSamples, setMinSamples] = useState('5');
  const [timeoutMin, setTimeoutMin] = useState('10');

  const firmware = useQuery({
    queryKey: keys.firmware.byModel(modelCode),
    queryFn: () => api<BeforeIdPage<FirmwareView>>('/firmware', { query: { modelCode, limit: 100 } }),
    enabled: modelCode !== '',
  });

  const parsed = parseStages(stagesText);
  const threshold = Number(thresholdPct);
  const samples = Number(minSamples);
  const minutes = Number(timeoutMin);
  const problems = [
    'error' in parsed ? parsed.error : null,
    thresholdPct === '' || !(threshold >= 0 && threshold <= 100) ? '실패 임계치는 0~100%입니다.' : null,
    !Number.isInteger(samples) || samples < 1 ? '최소 표본은 1 이상 정수입니다.' : null,
    !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_STAGE_TIMEOUT_MINUTES ? `단계 시간 제한은 1~${MAX_STAGE_TIMEOUT_MINUTES}분 정수입니다.` : null,
  ].filter((p): p is string => p !== null);

  const create = useMutation({
    mutationFn: (body: CreateRolloutRequest) => api<RolloutView>('/firmware-rollouts', { method: 'POST', body }),
    // 실패(409 ROLLOUT_ALREADY_ACTIVE 등)도 목록이 낡았다는 뜻일 수 있어 성공·실패 모두 다시 읽는다
    onSettled:() => client.invalidateQueries({ queryKey: keys.rollouts.all }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!modelCode || !version || problems.length > 0 || 'error' in parsed) return;
    const body = {
      modelCode,
      version,
      stages: parsed.stages,
      failureThreshold: threshold / 100,
      minSamples: samples,
      stageTimeoutMs: minutes * 60_000,
    } satisfies CreateRolloutRequest;
    if (!window.confirm(`${modelCode} ${version} 배포를 시작할까요? 1단계(${parsed.stages[0]}%) 대상 단말기에 바로 업데이트 제안이 나갑니다.`)) return;
    create.mutate(body);
  };

  const versions = firmware.data?.items ?? [];
  return (
    <form className="panel" aria-label="배포 만들기" onSubmit={submit}>
      <h3>배포 만들기</h3>
      <div className="row">
        <ModelSelect
          label="배포 모델"
          value={modelCode}
          onChange={(v) => {
            setModelCode(v);
            setVersion('');
          }}
          models={models.data}
        />
        <select aria-label="배포 버전" value={version} disabled={!modelCode || versions.length === 0} onChange={(e) => setVersion(e.target.value)}>
          <option value="">버전 선택</option>
          {versions.map((f) => (
            <option key={f.id} value={f.version}>
              {f.version}
            </option>
          ))}
        </select>
      </div>
      {modelCode && firmware.data && versions.length === 0 ? <p className="hint">이 모델에 등록된 펌웨어가 없습니다. 먼저 펌웨어를 등록하세요.</p> : null}
      <div className="row">
        <label>
          단계 비율(%) <input aria-label="단계 비율" value={stagesText} onChange={(e) => setStagesText(e.target.value)} />
        </label>
        <label>
          실패 임계치(%) <input aria-label="실패 임계치" type="number" min={0} max={100} value={thresholdPct} onChange={(e) => setThresholdPct(e.target.value)} />
        </label>
        <label>
          최소 표본 <input aria-label="최소 표본" type="number" min={1} value={minSamples} onChange={(e) => setMinSamples(e.target.value)} />
        </label>
        <label>
          단계 시간 제한(분) <input aria-label="단계 시간 제한" type="number" min={1} max={MAX_STAGE_TIMEOUT_MINUTES} value={timeoutMin} onChange={(e) => setTimeoutMin(e.target.value)} />
        </label>
      </div>
      {problems.map((p) => (
        <p key={p} className="field-error">
          {p}
        </p>
      ))}
      <p className="hint">단계마다 보고가 최소 표본 이상 모이면 실패율을 보고, 임계치를 넘으면 자동 중단합니다. 시간 제한 안에 보고하지 않은 단말기는 시간 초과로 셉니다.</p>
      <button type="submit" className="primary" disabled={!modelCode || !version || problems.length > 0 || create.isPending}>
        배포 시작
      </button>
      <ErrorBox error={models.error ?? firmware.error ?? create.error} />
      {create.data ? (
        <p className="ok" role="status">
          배포 #{create.data.id} {create.data.modelCode} {create.data.version} 시작 · 1단계 대상 {create.data.stageStats[0]?.targets ?? 0}대
        </p>
      ) : null}
    </form>
  );
}
```

`apps/admin/src/pages/RolloutsPage.tsx`(운영자에게만 버튼 둘, 누르면 그 폼만 연다 — 닫혀 있으면 모델·펌웨어 목록을 부르지 않아 기존 배포 화면 테스트 `ServiceAndRollouts.test.tsx`의 가짜 api가 그대로 맞는다):

```diff
diff --git a/apps/admin/src/pages/RolloutsPage.tsx b/apps/admin/src/pages/RolloutsPage.tsx
index 96bb13f..3f1d651 100644
--- a/apps/admin/src/pages/RolloutsPage.tsx
+++ b/apps/admin/src/pages/RolloutsPage.tsx
@@ -8,6 +8,8 @@ import { WriteButton } from '../components/WriteButton';
 import { formatKst } from '../lib/format';
 import { label } from '../lib/labels';
 import { keys } from '../api/query-keys';
+import { hasRole, useMe } from '../session';
+import { FirmwareRegisterForm, RolloutCreateForm } from './RolloutForms';
 import type { RolloutStatus, RolloutView } from '@terminal-ops/contracts';
 
 /** 배포 상태 이름. 키가 contracts RolloutStatus와 하나라도 다르면 tsc가 막는다 */
@@ -18,9 +20,12 @@ const ROLLOUT_STATUS_LABEL: Record<RolloutStatus, string> = {
   ABORTED: '중단',
 };
 
-/** 펌웨어 단계 배포 현황(F8): 배포마다 단계별 대상·성공·실패·시간 초과, 멈춤·재개·중단 */
+/** 펌웨어 단계 배포 현황(F8): 배포마다 단계별 대상·성공·실패·시간 초과, 멈춤·재개·중단. 운영자는 펌웨어 등록·배포 만들기도(보강 5) */
 export function RolloutsPage() {
   const client = useQueryClient();
+  const canWrite = hasRole(useMe(), ['OPERATOR']);
+  /** 열어 둔 쓰기 폼(보강 5). 닫혀 있으면 모델·펌웨어 목록을 부르지 않는다 */
+  const [open, setOpen] = useState<'firmware' | 'rollout' | null>(null);
   const [status, setStatus] = useState('');
   const list = useBeforeIdList<RolloutView>(keys.rollouts.all, '/firmware-rollouts', { status });
   const control = useMutation({
@@ -36,6 +41,18 @@ export function RolloutsPage() {
   return (
     <section>
       <h2>펌웨어 배포</h2>
+      {canWrite ? (
+        <div className="actions">
+          <button type="button" aria-expanded={open === 'firmware'} onClick={() => setOpen(open === 'firmware' ? null : 'firmware')}>
+            펌웨어 등록
+          </button>
+          <button type="button" aria-expanded={open === 'rollout'} onClick={() => setOpen(open === 'rollout' ? null : 'rollout')}>
+            새 배포 만들기
+          </button>
+        </div>
+      ) : null}
+      {open === 'firmware' ? <FirmwareRegisterForm /> : null}
+      {open === 'rollout' ? <RolloutCreateForm /> : null}
       <div className="filters">
         <select aria-label="배포 상태" value={status} onChange={(e) => setStatus(e.target.value)}>
           <option value="">상태 전체</option>
```

- [ ] **Step 4: 통과 확인과 전체 admin**

```bash
cd apps/admin
npx vitest run src/pages/RolloutForms.test.tsx src/api/query-keys.test.ts src/pages/ServiceAndRollouts.test.tsx
npx vitest run 2>&1 | tail -4
npm run build && rm -rf dist
```

Expected: 세 파일 모두 통과(RolloutForms 5, query-keys 3, 기존 A/S·배포 그대로). 전체 `Test Files  18 passed (18)`, `Tests  146 passed (146)`. build 성공.

- [ ] **Step 5: 기록**

`docs/decisions/0068-운영자-쓰기-화면은-새-메뉴-하나와-기존-화면-안의-폼으로.md` 끝에 그대로 덧붙인다:

```markdown
## Task 4 보탬 — 펌웨어 등록·배포 만들기 폼

- 펌웨어 배포 화면 위에 "펌웨어 등록"·"새 배포 만들기" 버튼(운영자만)이 폼을 연다. 닫혀 있으면 모델·펌웨어 목록을 부르지 않는다 — 관제·ADMIN은 목록만 보고, 기존 배포 화면 테스트(가짜 api에 `/terminal-models`가 없다)도 그대로 통과한다.
- 배포 만들기: 모델을 고르면 그 모델의 등록 버전만 선택지(`GET /firmware?modelCode=&limit=100`, decisions/0066). 단계 비율은 "10, 50, 100" 글자로 받아 서버 규칙(1~10개, 1~100 정수, 커지는 순서, 마지막 100)을 미리 알린다. 실패 임계치는 %로 받아 0~1로, 단계 시간 제한은 분(1~1,440)으로 받아 ms로 바꿔 보낸다. 만들자마자 1단계 대상에 업데이트 제안이 나가므로 확인을 받는다. 409 `ROLLOUT_ALREADY_ACTIVE`·400 `INVALID_STAGES` 안내를 ErrorBox에 더한다.
```

devlog 항목(Task 3 항목 뒤):

```markdown
## HH:MM Task 4 펌웨어 등록·배포 만들기 — 배포 화면의 접힌 폼 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <Task 3 커밋 해시>
- 한 일: 펌웨어 배포 화면에 "펌웨어 등록"·"새 배포 만들기"(운영자만, 접힌 폼). 펌웨어 등록(모델·버전 형식 미리 안내, 409 DUPLICATE). 배포 만들기(모델 → 그 모델 등록 버전만 `GET /firmware?modelCode=&limit=100`, 단계 비율 "10, 50, 100" 읽기 `parseStages`, 임계치 % → 0~1, 시간 제한 분 → ms, 확인 뒤 POST, 1단계 대상 수 표시, 409 ROLLOUT_ALREADY_ACTIVE·400 INVALID_STAGES 안내). 쿼리 키 `firmware`
- 확인: 새 테스트 실패(`./RolloutForms` 없음, `keys.firmware` 없음) → 통과. admin 전체 `Test Files  18 passed (18)`, `Tests  146 passed (146)`, build 성공. 기존 배포 화면 테스트 그대로
- 결정: decisions/0068 Task 4 보탬
- 다음: Task 5 계정 화면
```

```bash
node scripts/docs-index.mjs
```

- [ ] **Step 6: 커밋**

```bash
git add apps/admin docs
git status --short
git commit -m "$(cat <<'EOF'
feat(admin, F8): 펌웨어 등록·단계 배포 만들기 폼 — 모델별 등록 버전, 단계 비율·임계치·표본·시간 제한

Refs: docs/decisions/0068-운영자-쓰기-화면은-새-메뉴-하나와-기존-화면-안의-폼으로.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 제목 시각 = 커밋 시각인지 보고, 다르면 고쳐 `git commit --amend --no-edit`.

---

### Task 5: 계정 화면(ADMIN) — 목록·만들기·역할 바꾸기·사용 중지, 외부 업체 키 안내

**Files:**
- Create: `apps/admin/src/pages/AccountsPage.tsx`
- Modify: `apps/admin/src/nav.ts`, `apps/admin/src/App.tsx`, `apps/admin/src/api/query-keys.ts`, `apps/admin/src/components/ErrorBox.tsx`
- Test: Create `apps/admin/src/pages/AccountsPage.test.tsx`
- Docs: Create `docs/decisions/0069-계정-화면은-어드민에-외부-업체-키-화면은-개발자센터로.md`; Modify `docs/study/backlog.md`, `docs/index.md`, `docs/devlog/2026-10-29.md`

- [ ] **Step 1: 실패하는 테스트**

`apps/admin/src/pages/AccountsPage.test.tsx`(가짜 서버가 PATCH의 준 값만 바꿔 목록에 반영한다. 마지막 ADMIN 테스트는 PATCH를 409로 바꿔 끼운다):

```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AccountView } from '@terminal-ops/contracts';
import { App } from '../App';
import { dashboardBody } from '../test/fixtures';
import { loginAs, mockApi, renderPage, type Call } from '../test/render';
import { AccountsPage } from './AccountsPage';

const account = (id: number, loginId: string, over: Partial<AccountView> = {}): AccountView => ({
  id,
  loginId,
  displayName: `${loginId} 이름`,
  role: 'OPERATOR',
  merchantCode: null,
  disabled: false,
  createdAt: '2026-10-28T00:00:00.000Z',
  lastLoginAt: null,
  ...over,
});

const MERCHANTS = {
  'GET /merchants': () => ({
    body: [
      { code: 'GANGNAM-KIMBAP', name: '강남김밥', address: '서울 강남구' },
      { code: 'YEOKSAM-CAFE', name: '역삼카페', address: '서울 강남구' },
    ],
  }),
};

/** 서버 흉내: 목록은 accounts 배열, PATCH는 준 것만 바꾼다 */
function accountsApi(initial: AccountView[], patch?: (c: Call) => { status?: number; body?: unknown } | undefined) {
  const accounts = [...initial];
  return mockApi({
    ...MERCHANTS,
    'GET /admin/accounts': () => ({ body: accounts }),
    'PATCH /admin/accounts/:id': (c) => {
      const custom = patch?.(c);
      if (custom) return custom;
      const id = Number(c.path.split('/').at(-1));
      const i = accounts.findIndex((a) => a.id === id);
      accounts[i] = { ...accounts[i], ...(c.body as Partial<AccountView>) };
      return { body: accounts[i] };
    },
    'POST /admin/accounts': (c) => {
      const body = c.body as { loginId: string; displayName: string; role: AccountView['role']; merchantCode: string | null };
      const created = account(accounts.length + 1, body.loginId, { displayName: body.displayName, role: body.role, merchantCode: body.merchantCode });
      accounts.push(created);
      return { status: 201, body: created };
    },
  });
}

const row = (loginId: string) => screen.getByRole('row', { name: `계정 ${loginId}` });

describe('계정 화면 (ADMIN, 보강 5)', () => {
  it('목록: 아이디·이름·역할·상태·마지막 로그인, 내 계정 표시, 외부 업체 키는 개발자센터 안내', async () => {
    accountsApi([account(1, 'admin', { role: 'ADMIN', lastLoginAt: '2026-10-29T00:00:00.000Z' }), account(2, 'gone', { disabled: true })]);
    loginAs('admin', 'ADMIN');
    renderPage(<AccountsPage />);
    expect(await screen.findByRole('row', { name: '계정 admin' })).toHaveTextContent('admin나admin 이름');
    expect(within(row('admin')).getByLabelText('역할')).toHaveValue('ADMIN');
    expect(row('admin')).toHaveTextContent('2026-10-29 09:00:00 KST');
    expect(row('gone')).toHaveTextContent('사용 중지');
    expect(within(row('gone')).getByRole('button', { name: '다시 사용' })).toBeInTheDocument();
    expect(screen.getByLabelText('외부 업체 키')).toHaveTextContent('개발자센터 화면(보강 7)');
  });

  it('만들기: 아이디 형식·비밀번호 길이를 미리 알리고, 가맹점주는 가맹점을 골라야 만든다. 보낸 뒤 목록을 다시 읽는다', async () => {
    const { calls } = accountsApi([account(1, 'admin', { role: 'ADMIN' })]);
    loginAs('admin', 'ADMIN');
    renderPage(<AccountsPage />);
    const form = screen.getByRole('form', { name: '계정 만들기' });
    await userEvent.type(within(form).getByLabelText('새 아이디'), 'a!');
    await userEvent.type(within(form).getByLabelText('처음 비밀번호'), 'short');
    expect(within(form).getByText('아이디는 영문·숫자·`.`·`-`·`_` 3~50자입니다.')).toBeInTheDocument();
    expect(within(form).getByText('비밀번호는 10~200자입니다.')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: '만들기' })).toBeDisabled();

    await userEvent.clear(within(form).getByLabelText('새 아이디'));
    await userEvent.type(within(form).getByLabelText('새 아이디'), 'owner-yeoksam');
    await userEvent.type(within(form).getByLabelText('표시 이름'), '역삼 점주');
    await userEvent.clear(within(form).getByLabelText('처음 비밀번호'));
    await userEvent.type(within(form).getByLabelText('처음 비밀번호'), 'demo-pass-0001');
    await userEvent.selectOptions(within(form).getByLabelText('새 역할'), 'MERCHANT');
    expect(within(form).getByText('가맹점주 계정은 가맹점을 골라야 합니다.')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: '만들기' })).toBeDisabled();
    await within(form).findByRole('option', { name: '역삼카페 (YEOKSAM-CAFE)' });
    await userEvent.selectOptions(within(form).getByLabelText('새 가맹점'), 'YEOKSAM-CAFE');
    const reads = calls.filter((c) => c.path === '/admin/accounts' && c.method === 'GET').length;
    await userEvent.click(within(form).getByRole('button', { name: '만들기' }));

    expect(await within(form).findByRole('status')).toHaveTextContent('owner-yeoksam 만듦 · 가맹점주');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      loginId: 'owner-yeoksam',
      displayName: '역삼 점주',
      password: 'demo-pass-0001',
      role: 'MERCHANT',
      merchantCode: 'YEOKSAM-CAFE',
    });
    expect(await screen.findByRole('row', { name: '계정 owner-yeoksam' })).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/admin/accounts' && c.method === 'GET').length).toBeGreaterThan(reads);
    expect(within(form).getByLabelText('처음 비밀번호')).toHaveValue('');
  });

  it('역할 바꾸기: 고르면 "역할 저장"이 보이고, 확인을 받고 PATCH. 가맹점주로 바꾸면 가맹점도 함께, 다른 역할은 merchantCode null', async () => {
    const { calls } = accountsApi([account(1, 'admin', { role: 'ADMIN' }), account(2, 'kim')]);
    loginAs('admin', 'ADMIN');
    renderPage(<AccountsPage />);
    await screen.findByRole('row', { name: '계정 kim' });
    expect(within(row('kim')).queryByRole('button', { name: '역할 저장' })).not.toBeInTheDocument();

    await userEvent.selectOptions(within(row('kim')).getByLabelText('역할'), 'MONITOR');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValue(true);
    await userEvent.click(within(row('kim')).getByRole('button', { name: '역할 저장' }));
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(confirm.mock.calls[0][0]).toContain('kim의 역할을 관제(으)로 바꿀까요? 그 계정의 로그인이 모두 끊깁니다.');
    await userEvent.click(within(row('kim')).getByRole('button', { name: '역할 저장' }));
    await waitFor(() => expect(within(row('kim')).getByLabelText('역할')).toHaveValue('MONITOR'));
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => [c.path, c.body])).toEqual([['/admin/accounts/2', { role: 'MONITOR', merchantCode: null }]]);
    await waitFor(() => expect(within(row('kim')).queryByRole('button', { name: '역할 저장' })).not.toBeInTheDocument());

    await userEvent.selectOptions(within(row('kim')).getByLabelText('역할'), 'MERCHANT');
    expect(within(row('kim')).getByRole('button', { name: '역할 저장' })).toBeDisabled(); // 가맹점을 고르기 전
    await within(row('kim')).findByRole('option', { name: '강남김밥 (GANGNAM-KIMBAP)' });
    await userEvent.selectOptions(within(row('kim')).getByLabelText('가맹점'), 'GANGNAM-KIMBAP');
    await userEvent.click(within(row('kim')).getByRole('button', { name: '역할 저장' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'PATCH')[1].body).toEqual({ role: 'MERCHANT', merchantCode: 'GANGNAM-KIMBAP' });
  });

  it('사용 중지는 확인을 받고 {disabled: true}, 다시 사용은 바로 {disabled: false}. 내 계정이면 확인 글에 다시 로그인 안내', async () => {
    const { calls } = accountsApi([account(1, 'admin', { role: 'ADMIN' }), account(2, 'kim')]);
    loginAs('admin', 'ADMIN');
    renderPage(<AccountsPage />);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await userEvent.click(within(await screen.findByRole('row', { name: '계정 kim' })).getByRole('button', { name: '사용 중지' }));
    expect(await within(row('kim')).findByRole('button', { name: '다시 사용' })).toBeInTheDocument();
    expect(row('kim')).toHaveTextContent('사용 중지');
    await userEvent.click(within(row('kim')).getByRole('button', { name: '다시 사용' }));
    expect(await within(row('kim')).findByRole('button', { name: '사용 중지' })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ disabled: true }, { disabled: false }]);
    expect(confirm).toHaveBeenCalledTimes(1);

    confirm.mockReturnValueOnce(false);
    await userEvent.click(within(row('admin')).getByRole('button', { name: '사용 중지' }));
    expect(confirm.mock.calls[1][0]).toContain('내 계정입니다 — 저장하면 지금 세션이 끊겨 다시 로그인해야 합니다.');
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
  });

  it('마지막 활성 ADMIN을 내리면 409 LAST_ADMIN 안내를 보이고 고르던 역할을 서버 값으로 되돌린다', async () => {
    accountsApi([account(1, 'admin', { role: 'ADMIN' })], () => ({
      status: 409,
      body: { statusCode: 409, code: 'LAST_ADMIN', message: '마지막 활성 ADMIN은 사용 중지하거나 다른 역할로 바꿀 수 없습니다. 다른 ADMIN을 먼저 만드세요.' },
    }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    loginAs('admin', 'ADMIN');
    renderPage(<AccountsPage />);
    await userEvent.selectOptions(within(await screen.findByRole('row', { name: '계정 admin' })).getByLabelText('역할'), 'OPERATOR');
    await userEvent.click(within(row('admin')).getByRole('button', { name: '역할 저장' }));
    expect(await within(row('admin')).findByRole('alert')).toHaveTextContent('마지막 활성 ADMIN입니다. 다른 ADMIN 계정을 먼저 만들거나 살린 뒤 바꾸세요.');
    expect(within(row('admin')).getByLabelText('역할')).toHaveValue('ADMIN');
  });

  it('ADMIN 메뉴에 "계정"이 있고, 운영자가 주소로 열면 권한 안내만(계정 목록을 부르지 않는다)', async () => {
    const { calls } = mockApi({ 'GET /health': () => ({ body: { status: 'ok' } }), 'GET /dashboard/summary': () => ({ body: dashboardBody() }) });
    loginAs('admin', 'ADMIN');
    const admin = renderPage(<App />, { path: '/*' });
    expect(await within(screen.getByRole('navigation', { name: '메뉴' })).findByRole('link', { name: '계정' })).toHaveAttribute('href', '/admin/accounts');
    admin.unmount();

    loginAs('op', 'OPERATOR');
    renderPage(<App />, { path: '/*', route: '/admin/accounts' });
    expect(await screen.findByRole('alert')).toHaveTextContent('이 화면을 볼 권한이 없습니다');
    expect(within(screen.getByRole('navigation', { name: '메뉴' })).queryByRole('link', { name: '계정' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/admin/accounts')).toBe(false);
  });
});
```

- [ ] **Step 2: 실패 확인**

```bash
cd apps/admin && npx vitest run src/pages/AccountsPage.test.tsx
```

Expected(사전 검증 원문): `Test Files  1 failed (1)`, `Tests  no tests` — `Error: Failed to resolve import "./AccountsPage" from "src/pages/AccountsPage.test.tsx". Does the file exist?`

- [ ] **Step 3: 구현**

`apps/admin/src/api/query-keys.ts`:

```diff
diff --git a/apps/admin/src/api/query-keys.ts b/apps/admin/src/api/query-keys.ts
index bf4d111..b09fbe2 100644
--- a/apps/admin/src/api/query-keys.ts
+++ b/apps/admin/src/api/query-keys.ts
@@ -59,6 +59,8 @@ export const keys = {
     items: (id: number, kind: string, verified: string) => ['van-run', id, kind, verified] as const,
   },
   syncRuns: { all: ['sync-runs'] as const },
+  /** 계정 목록(ADMIN, 보강 5) */
+  accounts: { all: ['accounts'] as const },
   weeklyReports: { all: ['weekly-reports'] as const },
 };
 
```

`apps/admin/src/components/ErrorBox.tsx`(계정 화면이 생겨 주석을 고치고, MERCHANT_REQUIRED 안내를 더한다):

```diff
diff --git a/apps/admin/src/components/ErrorBox.tsx b/apps/admin/src/components/ErrorBox.tsx
index 0d1d11d..380b822 100644
--- a/apps/admin/src/components/ErrorBox.tsx
+++ b/apps/admin/src/components/ErrorBox.tsx
@@ -16,8 +16,9 @@ const HINT: Partial<Record<ErrorCode, string>> = {
   UNAUTHENTICATED: '로그인이 끝났습니다. 다시 로그인하세요.',
   LOGIN_FAILED: '아이디 또는 비밀번호가 맞지 않습니다.',
   LOGIN_LOCKED: '로그인 실패가 많아 잠시 막혔습니다. 잠시 뒤 다시 시도하세요.',
-  // 계정 관리 화면은 Bundle 7 — 지금은 API(PATCH /admin/accounts/:id)에서만 나지만, 화면이 생겨도 안내가 비지 않게 미리 둔다
+  // 계정 화면(보강 5, pages/AccountsPage.tsx)
   LAST_ADMIN: '마지막 활성 ADMIN입니다. 다른 ADMIN 계정을 먼저 만들거나 살린 뒤 바꾸세요.',
+  MERCHANT_REQUIRED: '가맹점주 계정에는 가맹점을 꼭 고르고, 다른 역할에는 가맹점을 주지 않습니다.',
 };
 
 export function describeError(error: unknown): { title: string; detail: string; code: ErrorCode | null } {
```

`apps/admin/src/pages/AccountsPage.tsx`(줄의 `key`에 역할·가맹점·사용 여부를 넣어, 서버 값이 바뀌면 줄을 새로 그려 고르던 칸이 서버 값으로 맞는다. 실패하면 `onError`가 고르던 칸을 되돌린다):

```tsx
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import type { AccountView, CreateAccountRequest, MerchantView, Role, UpdateAccountRequest } from '@terminal-ops/contracts';
import { ErrorBox } from '../components/ErrorBox';
import { formatKst } from '../lib/format';
import { ROLE_LABEL } from '../lib/labels';
import { useMe } from '../session';

/** 서버 규칙과 같은 아이디 형식(api auth/dto/login.dto.ts LOGIN_ID_INPUT — 대문자는 서버가 소문자로 저장) */
export const LOGIN_ID_PATTERN = /^[A-Za-z0-9._-]{3,50}$/;
const ROLES = Object.keys(ROLE_LABEL) as Role[];

function MerchantSelect({ label, value, onChange, merchants }: { label: string; value: string; onChange: (v: string) => void; merchants: MerchantView[] | undefined }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">가맹점 선택</option>
      {merchants?.map((m) => (
        <option key={m.code} value={m.code}>
          {m.name} ({m.code})
        </option>
      ))}
    </select>
  );
}

/** 새 계정. 역할이 가맹점주면 가맹점이 꼭 있어야 한다(없으면 서버 400 MERCHANT_REQUIRED) */
function CreateAccountForm({ merchants }: { merchants: MerchantView[] | undefined }) {
  const client = useQueryClient();
  const [loginId, setLoginId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('OPERATOR');
  const [merchantCode, setMerchantCode] = useState('');
  const problems = [
    loginId && !LOGIN_ID_PATTERN.test(loginId) ? '아이디는 영문·숫자·`.`·`-`·`_` 3~50자입니다.' : null,
    password && (password.length < 10 || password.length > 200) ? '비밀번호는 10~200자입니다.' : null,
    role === 'MERCHANT' && !merchantCode ? '가맹점주 계정은 가맹점을 골라야 합니다.' : null,
  ].filter((p): p is string => p !== null);
  const ready = LOGIN_ID_PATTERN.test(loginId) && displayName.trim() !== '' && password.length >= 10 && problems.length === 0;
  const create = useMutation({
    mutationFn: (body: CreateAccountRequest) => api<AccountView>('/admin/accounts', { method: 'POST', body }),
    onSuccess: async () => {
      setLoginId('');
      setDisplayName('');
      setPassword('');
      await client.invalidateQueries({ queryKey: keys.accounts.all });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    create.mutate({ loginId, displayName: displayName.trim(), password, role, merchantCode: role === 'MERCHANT' ? merchantCode : null } satisfies CreateAccountRequest);
  };
  return (
    <form className="panel" aria-label="계정 만들기" onSubmit={submit}>
      <h3>계정 만들기</h3>
      <div className="row">
        <input aria-label="새 아이디" placeholder="아이디" autoComplete="off" value={loginId} onChange={(e) => setLoginId(e.target.value.trim())} />
        <input aria-label="표시 이름" placeholder="표시 이름" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <input aria-label="처음 비밀번호" placeholder="처음 비밀번호(10자 이상)" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <select aria-label="새 역할" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        {role === 'MERCHANT' ? <MerchantSelect label="새 가맹점" value={merchantCode} onChange={setMerchantCode} merchants={merchants} /> : null}
        <button type="submit" className="primary" disabled={!ready || create.isPending}>
          만들기
        </button>
      </div>
      {problems.map((p) => (
        <p key={p} className="field-error">
          {p}
        </p>
      ))}
      <ErrorBox error={create.error} />
      {create.data ? (
        <p className="ok" role="status">
          {create.data.loginId} 만듦 · {ROLE_LABEL[create.data.role]}
        </p>
      ) : null}
    </form>
  );
}

/**
 * 계정 한 줄: 역할(가맹점주면 가맹점) 바꾸기, 사용 중지·다시 사용. 바꾸면 그 계정의 세션이 모두 끊긴다(api decisions/0050) —
 * 자기 계정이면 이 화면도 곧 로그인으로 돌아간다(확인을 받는다). 마지막 활성 ADMIN을 내리거나 중지하면 409 LAST_ADMIN.
 */
function AccountRow({ account, me, merchants }: { account: AccountView; me: string | undefined; merchants: MerchantView[] | undefined }) {
  const client = useQueryClient();
  const [role, setRole] = useState<Role>(account.role);
  const [merchantCode, setMerchantCode] = useState(account.merchantCode ?? '');
  const isMe = account.loginId === me;
  const update = useMutation({
    mutationFn: (body: UpdateAccountRequest) => api<AccountView>(`/admin/accounts/${account.id}`, { method: 'PATCH', body }),
    // 실패(409 LAST_ADMIN 등)도 화면이 낡았을 수 있어 다시 읽는다. 다시 읽은 값으로 고르던 칸도 되돌린다
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: keys.accounts.all });
    },
    onError: () => {
      setRole(account.role);
      setMerchantCode(account.merchantCode ?? '');
    },
  });
  const changed = role !== account.role || (role === 'MERCHANT' && merchantCode !== (account.merchantCode ?? ''));
  const selfWarning = isMe ? '\n내 계정입니다 — 저장하면 지금 세션이 끊겨 다시 로그인해야 합니다.' : '';
  const saveRole = () => {
    if (!window.confirm(`${account.loginId}의 역할을 ${ROLE_LABEL[role]}(으)로 바꿀까요? 그 계정의 로그인이 모두 끊깁니다.${selfWarning}`)) return;
    update.mutate({ role, merchantCode: role === 'MERCHANT' ? merchantCode : null } satisfies UpdateAccountRequest);
  };
  const toggleDisabled = () => {
    if (!account.disabled && !window.confirm(`${account.loginId}을(를) 사용 중지할까요? 그 계정의 로그인이 모두 끊기고 다시 로그인할 수 없습니다.${selfWarning}`)) return;
    update.mutate({ disabled: !account.disabled } satisfies UpdateAccountRequest);
  };
  return (
    <tr aria-label={`계정 ${account.loginId}`}>
      <td>
        {account.loginId}
        {isMe ? <span className="badge">나</span> : null}
      </td>
      <td>{account.displayName}</td>
      <td>
        <div className="row">
          <select aria-label="역할" value={role} disabled={update.isPending} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
          {role === 'MERCHANT' ? <MerchantSelect label="가맹점" value={merchantCode} onChange={setMerchantCode} merchants={merchants} /> : null}
          {changed ? (
            <button type="button" disabled={update.isPending || (role === 'MERCHANT' && !merchantCode)} onClick={saveRole}>
              역할 저장
            </button>
          ) : null}
        </div>
        <ErrorBox error={update.error} />
      </td>
      <td className={account.disabled ? 'bad' : undefined}>{account.disabled ? '사용 중지' : '사용 중'}</td>
      <td>{formatKst(account.lastLoginAt)}</td>
      <td>
        <button type="button" className={account.disabled ? undefined : 'danger'} disabled={update.isPending} onClick={toggleDisabled}>
          {account.disabled ? '다시 사용' : '사용 중지'}
        </button>
      </td>
    </tr>
  );
}

/**
 * 계정·역할 관리(ADMIN, 보강 5 — api는 보강 2의 /admin/accounts, decisions/0052). 목록·만들기·역할 바꾸기·사용 중지.
 * 외부 업체 키 발급·폐기는 개발자센터 화면(보강 7)이 맡는다(decisions/0069) — 여기서는 안내만.
 */
export function AccountsPage() {
  const me = useMe();
  const accounts = useQuery({ queryKey: keys.accounts.all, queryFn: () => api<AccountView[]>('/admin/accounts') });
  const merchants = useQuery({ queryKey: keys.merchants, queryFn: () => api<MerchantView[]>('/merchants'), staleTime: Infinity });
  return (
    <section>
      <h2>계정</h2>
      <p className="hint">
        역할·가맹점·사용 여부를 바꾸면 그 계정의 로그인이 모두 끊겨 다시 로그인해야 새 권한이 적용됩니다. 마지막 활성 관리자(ADMIN)는 내리거나 중지할 수 없습니다.
      </p>
      <CreateAccountForm merchants={merchants.data} />
      <ErrorBox error={accounts.error ?? merchants.error} />
      {accounts.data ? (
        <table>
          <thead>
            <tr>
              <th scope="col">아이디</th>
              <th scope="col">이름</th>
              <th scope="col">역할</th>
              <th scope="col">상태</th>
              <th scope="col">마지막 로그인</th>
              <th scope="col">사용</th>
            </tr>
          </thead>
          <tbody>
            {accounts.data.map((a) => (
              // 역할·가맹점이 서버에서 바뀌면 줄을 새로 그려 고르던 칸을 서버 값으로 맞춘다
              <AccountRow key={`${a.id}-${a.role}-${a.merchantCode ?? ''}-${a.disabled}`} account={a} me={me?.loginId} merchants={merchants.data} />
            ))}
          </tbody>
        </table>
      ) : accounts.isPending ? (
        <p className="muted">불러오는 중</p>
      ) : null}
      <div className="panel" aria-label="외부 업체 키">
        <h3>외부 업체 키</h3>
        <p className="muted">외부 업체(가상) API 키 발급·폐기는 개발자센터 화면(보강 7)에서 합니다. 그 전까지는 API(`POST /admin/partner-keys`, `POST /admin/partner-keys/:id/revoke`)로 합니다.</p>
      </div>
    </section>
  );
}
```

`apps/admin/src/nav.ts`(ADMIN만):

```diff
diff --git a/apps/admin/src/nav.ts b/apps/admin/src/nav.ts
index ab6a507..d5c9f8f 100644
--- a/apps/admin/src/nav.ts
+++ b/apps/admin/src/nav.ts
@@ -17,4 +17,5 @@ export const NAV: { to: string; label: string; roles: readonly Role[] }[] = [
   { to: '/reports/purchase-orders', label: '발주 입고 대조', roles: OFFICE },
   { to: '/reports/weekly', label: '주간 리포트', roles: OFFICE },
   { to: '/batch-runs', label: '배치 실행 이력', roles: OFFICE },
+  { to: '/admin/accounts', label: '계정', roles: ['ADMIN'] },
 ];
```

`apps/admin/src/App.tsx`:

```diff
diff --git a/apps/admin/src/App.tsx b/apps/admin/src/App.tsx
index 9068aa9..e7acc25 100644
--- a/apps/admin/src/App.tsx
+++ b/apps/admin/src/App.tsx
@@ -6,6 +6,7 @@ import { RequireRole } from './components/RequireRole';
 import { SessionCacheSync } from './components/SessionCacheSync';
 import { LoginPage } from './pages/LoginPage';
 import { useMe } from './session';
+import { AccountsPage } from './pages/AccountsPage';
 import { BatchHistoryPage } from './pages/BatchHistoryPage';
 import { AnomaliesPage } from './pages/reports/AnomaliesPage';
 import { PurchaseOrdersPage } from './pages/reports/PurchaseOrdersPage';
@@ -57,6 +58,7 @@ export function App() {
           <Route path="reports/purchase-orders" element={guard('/reports/purchase-orders', <PurchaseOrdersPage />)} />
           <Route path="reports/weekly" element={guard('/reports/weekly', <WeeklyReportsPage />)} />
           <Route path="batch-runs" element={guard('/batch-runs', <BatchHistoryPage />)} />
+          <Route path="admin/accounts" element={guard('/admin/accounts', <AccountsPage />)} />
           <Route path="*" element={<p>없는 화면입니다.</p>} />
         </Route>
       </Routes>
```

- [ ] **Step 4: 통과 확인과 전체 admin·merchant·field**

```bash
cd apps/admin
npx vitest run src/pages/AccountsPage.test.tsx
npx vitest run 2>&1 | tail -4
npm run build && rm -rf dist
(cd ../merchant && npx vitest run 2>&1 | tail -4 && npm run build && rm -rf dist)
(cd ../field && npx vitest run 2>&1 | tail -4 && npm run build && rm -rf dist)
```

Expected: `Tests  6 passed (6)`. admin 전체 `Test Files  19 passed (19)`, `Tests  152 passed (152)`, build 성공. merchant `7 passed`·`47 passed`, field `7 passed`·`60 passed`, 둘 다 build 성공(contracts가 늘어도 tsc 0, 사본 검사 그대로 — 어드민 클라이언트는 사본 검사 대상이 아니다).

- [ ] **Step 5: 기록**

`docs/decisions/0069-계정-화면은-어드민에-외부-업체-키-화면은-개발자센터로.md`:

````markdown
# 0069. 계정 화면은 어드민에, 외부 업체 키 화면은 개발자센터(보강 7)로

- 날짜 / 관련 기능: 2026-10-29 / 보강 5, 로그인·역할(보강 2), 어드민
- 상황: 보강 2가 ADMIN용 계정 API(`GET·POST /admin/accounts`, `PATCH /admin/accounts/:id`)와 외부 업체 키 API(`GET·POST /admin/partner-keys`, `POST /admin/partner-keys/:id/revoke`)를 만들었지만 화면이 없다. 둘 다 ADMIN만 부른다. 시연에서 ADMIN이 해야 할 일은 계정을 만들고 역할을 바꾸고 사용 중지하는 것이다. 외부 업체 키는 연동 문서·호출 로그와 함께 "외부 연동 개발자센터"(보강 7)에서 보이기로 했다.
- 선택지:
  1. **계정 화면만 어드민에(`/admin/accounts`, ADMIN 메뉴 "계정"), 키는 개발자센터로 넘기고 어드민에는 안내만** — 키 발급(원문을 한 번만 보이기)·scope·만료·폐기와 연동 문서를 한 곳에서 만든다
  2. 둘 다 어드민에 — 지금 바로 키를 화면으로 다룰 수 있지만, 보강 7이 같은 화면을 다시 만들거나 옮겨야 한다(두 벌)
  3. 계정도 별도 관리 앱 — 앱이 하나 더 는다. ADMIN 화면이 계정 하나뿐이라 앱을 나눌 이유가 없다
- 결정: 1. 계정 화면은 목록(아이디·이름·역할·상태·마지막 로그인, 내 계정 표시)·만들기(아이디 형식·비밀번호 10~200자·가맹점주면 가맹점 필수를 미리 안내)·역할 바꾸기(가맹점주면 가맹점 함께, 다른 역할이면 `merchantCode: null`)·사용 중지/다시 사용. 바꾸면 그 계정의 세션이 모두 끊기므로(decisions/0050) 확인을 받고, 내 계정이면 "다시 로그인해야 한다"를 확인 글에 더한다. 409 `LAST_ADMIN`·400 `MERCHANT_REQUIRED`는 안내를 보이고 고르던 칸을 서버 값으로 되돌린다. 비밀번호 바꾸기·표시 이름 바꾸기 화면은 넣지 않았다(API는 있다 — 시연 단계에 없다). 외부 업체 키는 계정 화면 아래에 "개발자센터 화면(보강 7)에서, 그 전까지는 API로" 안내를 두고, 왼쪽 "다른 화면"에 개발자센터 자리를 "준비 중"으로 둔다(decisions/0067).
- 결과·대가: 보강 7 전까지 키는 curl로만 다룬다(README의 예). ADMIN 메뉴가 하나 는다(운영자·관제 메뉴 수는 그대로).
- 다시 볼 조건: 보강 7이 미뤄지거나 시연 순서에 "키 발급"이 어드민 단계로 들어오면 2(목록·발급·폐기만).
````

`docs/study/backlog.md` 끝에 한 줄:

```markdown
- [ ] React `key`로 줄 상태 초기화 — 서버 값이 바뀌면 key를 바꿔 다시 마운트하는 방법과 `useEffect`로 맞추는 방법의 차이 (apps/admin/src/pages/AccountsPage.tsx, decisions/0069)
```

devlog 항목(Task 4 항목 뒤):

```markdown
## HH:MM Task 5 계정 화면 — 목록·만들기·역할 바꾸기·사용 중지 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <Task 4 커밋 해시>
- 한 일: `/admin/accounts`(ADMIN 메뉴 "계정") — 목록(내 계정 표시, 마지막 로그인), 만들기(아이디 형식·비밀번호 10~200자·가맹점주면 가맹점 미리 안내), 역할 바꾸기(가맹점주면 가맹점 함께, 다른 역할은 merchantCode null, 확인), 사용 중지(확인)·다시 사용, 자기 계정이면 "다시 로그인" 안내, 409 LAST_ADMIN·400 MERCHANT_REQUIRED 안내 뒤 고르던 칸 되돌리기, 외부 업체 키는 개발자센터(보강 7) 안내
- 확인: 새 테스트 실패(`./AccountsPage` 없음) → 통과(6). admin 전체 `Test Files  19 passed (19)`, `Tests  152 passed (152)`, build 성공. merchant 7/47·field 7/60 그대로, build 성공
- 결정: decisions/0069(계정은 어드민, 키는 개발자센터로)
- 다음: Task 6 마감(전체 검증·실서버 확인·README)
```

```bash
node scripts/docs-index.mjs
```

- [ ] **Step 6: 커밋**

```bash
git add apps/admin docs
git status --short
git commit -m "$(cat <<'EOF'
feat(admin, auth): 계정 화면 — 목록·만들기·역할 바꾸기·사용 중지, 외부 업체 키는 개발자센터로

Refs: docs/decisions/0069-계정-화면은-어드민에-외부-업체-키-화면은-개발자센터로.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 제목 시각 = 커밋 시각인지 보고, 다르면 고쳐 `git commit --amend --no-edit`.

---

### Task 6: 마감 — 전체 검증, 실서버 확인, README·회고·색인

**Files:**
- Modify: `README.md`, `docs/retrospective.md`, `docs/index.md`, `docs/devlog/2026-10-29.md`
- 저장소 밖(커밋 안 함): 실서버 확인 스크립트·엑셀 파일(세션 scratchpad)

- [ ] **Step 1: 전체 검증**

```bash
# 시작 전 node PID를 적어 둔다
tasklist //FI "IMAGENAME eq node.exe" //FO CSV //NH
# 테스트 DB를 새로 만든 뒤(안전 규칙)
(cd apps/api && npx tsc --noEmit -p tsconfig.json && npm run build && npx vitest run > /tmp/adminx-final-api.log 2>&1; grep -E "Test Files|Tests |Duration" /tmp/adminx-final-api.log; grep -c "Connection is closed" /tmp/adminx-final-api.log)
(cd apps/admin && npx vitest run 2>&1 | tail -4 && npm run build && rm -rf dist)
(cd apps/merchant && npx vitest run 2>&1 | tail -4 && npm run build && rm -rf dist)
(cd apps/field && npx vitest run 2>&1 | tail -4 && npm run build && rm -rf dist)
(cd apps/device-sim && npx tsc --noEmit -p tsconfig.json && npx vitest run 2>&1 | tail -4)
(cd apps/partners && npx vitest run 2>&1 | tail -4)
(cd apps/api && npm run db:migration:check)   # 개발 DB 읽기 — 이 계획은 마이그레이션이 없다
```

Expected(사전 검증 값): api `Test Files  83 passed (83)`·`Tests  571 passed (571)`(사전 검증 Duration 331.96s), `Connection is closed` 0. admin `19 passed`·`152 passed`, build 성공. merchant `7 passed`·`47 passed`, field `7 passed`·`60 passed`, 둘 다 build 성공. device-sim `5`·`46`, tsc 0. partners `6`·`53`. `db:migration:check` → `최신 상태`(exit 0). `git status --short --ignored apps/api/src/migrations`에 `.snapshot-terminal_ops_test.json`이 없어야 한다(있으면 지운다 — troubleshooting/0032).

- [ ] **Step 2: 실서버 확인 — 테스트 DB api + 가상 업체 서버 + 어드민 개발 서버 프록시**

포트가 비어 있는지 먼저 본다: `netstat -ano | grep -E ':(3100|4012|5176) .*LISTENING'` → 출력 없음. 발주는 api가 세움전자(가상 업체 서버)를 부르므로 가상 업체 서버도 띄운다(기본 4010 대신 4012 — 테스트 포트 4011과도 다르게).

테스트 DB(Step 1 뒤 표가 있다)를 다시 만들고 스키마·기준 데이터·시연 계정을 넣는다(쓰기는 테스트 DB만):

```bash
# 테스트 DB를 새로 만든 뒤(안전 규칙)
cd apps/api
MYSQL_DATABASE=terminal_ops_test node --env-file=../../.env dist/db/migrate.js up | tail -1
MYSQL_DATABASE=terminal_ops_test node --env-file=../../.env dist/db/seed.js
rm -f src/migrations/.snapshot-terminal_ops_test.json   # 테스트 DB 이름의 스냅샷(troubleshooting/0032)
cd ../..
(cd apps/partners && npm run build)
```

서버 세 개를 각각 **단독 `node` 명령**으로 백그라운드에 띄운다(셸 목록으로 묶지 않는다 — PID가 서브셸이 된다). 명령줄 env가 `--env-file`의 같은 이름보다 앞선다:

```bash
# (1) 저장소 루트에서 — 가상 업체 서버
PARTNERS_PORT=4012 node --env-file=.env apps/partners/dist/main.js
# (2) 저장소 루트에서 — api(테스트 DB, 워커·주기 작업 끔, 큐 접두사 따로)
API_PORT=3100 PARTNERS_URL=http://localhost:4012 MYSQL_DATABASE=terminal_ops_test RUN_WORKERS=0 RUN_SCHEDULERS=0 QUEUE_PREFIX=adminx-live node --env-file=.env apps/api/dist/main.js
# (3) apps/admin 폴더에서 — 어드민 개발 서버(5176), 매장 화면 주소를 env로 바꿔 apps.ts 한 곳 + env가 먹는지 본다
ADMIN_API_URL=http://localhost:3100 VITE_MERCHANT_APP_URL=http://merchant.demo:8081 node node_modules/vite/bin/vite.js --port 5176
```

`netstat -ano | grep -E ':(3100|4012|5176) .*LISTENING'`으로 셋 다 뜬 것과 PID를 본다(vite는 `[::1]:5176`). 아래 두 파일을 저장소 **밖** 임시 폴더(예: 세션 scratchpad)에 Write로 만든다 — 엑셀 만들기(api의 exceljs를 빌려 쓴다):

```js
// 실서버 확인용 엑셀 파일 만들기: node adminx-xlsx.mjs <api 폴더> <출력 .xlsx>
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(resolve(process.argv[2], 'package.json'));
const ExcelJS = require('exceljs');
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('입고');
ws.addRow(['serialNo', 'modelCode']);
ws.addRow(['LIVE-X-0101', 'SN-100']);
ws.addRow(['LIVE-X-0102', 'SN-300']);
ws.addRow(['LIVE-X-0001', 'SN-100']); // 단건 등록과 겹침 → ALREADY_EXISTS
ws.addRow(['live-bad', 'SN-100']); // 형식 오류
ws.addRow(['LIVE-X-0103', 'SN-999']); // 모르는 모델
await wb.xlsx.writeFile(process.argv[3]);
console.log('written', process.argv[3]);
```

확인 스크립트(비밀번호는 seed 파일에서 변수로만 읽고 출력하지 않는다. 새 계정 비밀번호는 무작위):

```bash
#!/bin/bash
# 통합 어드민 확장 실서버 확인(테스트 DB api + 가상 업체 서버 + 어드민 개발 서버 프록시). 저장소 루트에서 실행.
# 인자: 어드민 개발 서버 포트, 엑셀 파일 경로(기본 5176, 없으면 엑셀 단계 건너뜀). 비밀번호는 seed 파일에서 변수로만 읽고 출력하지 않는다.
WEB_PORT=${1:-5176}; XLSX=$2
SEED=apps/api/src/db/seed-accounts.ts
pw() { node -e "const s=require('fs').readFileSync(process.argv[1],'utf8');const m=s.match(new RegExp(\"loginId: '\"+process.argv[2]+\"'[^}]*password: '([^']+)'\"));process.stdout.write(m[1])" "$SEED" "$1"; }
OP_PW=$(pw operator); AD_PW=$(pw admin)
NEW_PW=$(node -e "process.stdout.write('live-'+require('crypto').randomBytes(8).toString('hex'))")
J=$(mktemp -d)
WEB=http://localhost:$WEB_PORT/api
login() { curl -s -c "$2" -o /dev/null -w "%{http_code}" -H 'Content-Type: application/json' -d "{\"loginId\":\"$1\",\"password\":\"$3\"}" "$WEB/auth/login"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
pick() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(String((new Function('j','return '+process.argv[1]))(j)))})" "$1"; }

echo "index.html: $(code http://localhost:$WEB_PORT/) $(curl -s http://localhost:$WEB_PORT/ | grep -o '<title>[^<]*</title>')"
echo "apps.ts env (VITE_MERCHANT_APP_URL): $(curl -s http://localhost:$WEB_PORT/src/apps.ts | grep -o 'http://merchant.demo:8081' | head -1)"
echo "proxy /api/health: $(curl -s $WEB/health)"
echo "no login /api/firmware: $(code $WEB/firmware)"

# 운영자: 단말기 등록(한 대 + 엑셀) → 발주 → 펌웨어 등록 → 배포 만들기
O=(-b $J/op -H 'Content-Type: application/json')
echo "operator login: $(login operator $J/op "$OP_PW")"
echo "register LIVE-X-0001: $(curl -s -w ' %{http_code}' "${O[@]}" -d '{"serialNo":"LIVE-X-0001","modelCode":"SN-100"}' $WEB/terminals | grep -o '"serialNo":"[^"]*"\|"status":"[A-Z_]*"\| [0-9]*$' | tr '\n' ' ')"
echo "register again (409): $(curl -s -w ' %{http_code}' "${O[@]}" -d '{"serialNo":"LIVE-X-0001","modelCode":"SN-100"}' $WEB/terminals | grep -o '"code":"[A-Z_]*"\| [0-9]*$' | tr '\n' ' ')"
if [ -n "$XLSX" ]; then
  # Windows curl은 `file=@/c/…` 같은 Git Bash 경로를 못 읽는다(인자 앞이 /가 아니라 경로 변환도 안 된다) — C:/… 꼴로
  XLSX_WIN=$(cygpath -m "$XLSX" 2>/dev/null || echo "$XLSX")
  R=$(curl -s -w ' %{http_code}' -b $J/op -F "file=@$XLSX_WIN;filename=live-import.xlsx" $WEB/terminals/imports)
  echo "import xlsx: ${R##* } $(echo "${R% *}" | pick 'j.fileName+" total "+j.total+" "+JSON.stringify(j.summary)+" rows "+j.results.map(r=>r.row+":"+r.result).join(",")')"
fi
echo "import not xlsx (400): $(curl -s -w ' %{http_code}' -b $J/op -F "file=@$SEED;filename=a.csv" $WEB/terminals/imports | grep -o '"code":"[A-Z_]*"\| [0-9]*$' | tr '\n' ' ')"
PO=$(curl -s "${O[@]}" -d '{"modelCode":"SN-100","quantity":5}' $WEB/purchase-orders)
PO_NO=$(echo "$PO" | pick 'j.poNo')
echo "purchase order: $(echo "$PO" | pick 'j.poNo+" "+j.modelCode+" x"+j.quantity+" "+j.status+" by "+j.orderedBy')"
echo "reconciliation: $(curl -s -b $J/op $WEB/purchase-orders/$PO_NO/reconciliation | pick '"ordered "+j.ordered+" noted "+j.noted+" received "+j.received')"
echo "firmware register SN-100 9.9.0: $(curl -s -w ' %{http_code}' "${O[@]}" -d '{"modelCode":"SN-100","version":"9.9.0"}' $WEB/firmware | grep -o '"version":"[^"]*"\|"createdBy":"[^"]*"\| [0-9]*$' | tr '\n' ' ')"
echo "firmware register again (409): $(curl -s -w ' %{http_code}' "${O[@]}" -d '{"modelCode":"SN-100","version":"9.9.0"}' $WEB/firmware | grep -o '"code":"[A-Z_]*"\| [0-9]*$' | tr '\n' ' ')"
echo "firmware list SN-100: $(curl -s -b $J/op "$WEB/firmware?modelCode=SN-100&limit=100" | pick 'j.items.map(f=>f.modelCode+" "+f.version).join(",")+" next "+j.nextBeforeId')"
RO='{"modelCode":"SN-100","version":"9.9.0","stages":[10,50,100],"failureThreshold":0.2,"minSamples":5,"stageTimeoutMs":600000}'
R=$(curl -s -w ' %{http_code}' "${O[@]}" -d "$RO" $WEB/firmware-rollouts)
echo "rollout create: ${R##* } $(echo "${R% *}" | pick '"#"+j.id+" "+j.modelCode+" "+j.version+" "+j.status+" stages "+j.stages.join("/")+" stage1 targets "+j.stageStats[0].targets')"
echo "rollout create again (409): $(curl -s -w ' %{http_code}' "${O[@]}" -d "$RO" $WEB/firmware-rollouts | grep -o '"code":"[A-Z_]*"\| [0-9]*$' | tr '\n' ' ')"
echo "rollout bad stages (400): $(curl -s -w ' %{http_code}' "${O[@]}" -d '{"modelCode":"SN-300","version":"9.9.0","stages":[50,10,100],"failureThreshold":0.2,"minSamples":5}' $WEB/firmware-rollouts | grep -o '"code":"[A-Z_]*"\| [0-9]*$' | tr '\n' ' ')"
echo "operator /admin/accounts (403): $(code -b $J/op $WEB/admin/accounts)"

# ADMIN: 계정 목록 → 만들기 → 역할 바꾸기 → 사용 중지 → 그 계정 로그인 실패
A=(-b $J/ad -H 'Content-Type: application/json')
echo "admin login: $(login admin $J/ad "$AD_PW")"
echo "accounts: $(curl -s -b $J/ad $WEB/admin/accounts | pick 'j.map(a=>a.loginId+":"+a.role).join(",")')"
NEW=$(curl -s -w ' %{http_code}' "${A[@]}" -d "{\"loginId\":\"live-mon\",\"displayName\":\"실서버 확인 관제\",\"password\":\"$NEW_PW\",\"role\":\"MONITOR\"}" $WEB/admin/accounts)
ID=$(echo "${NEW% *}" | pick 'j.id')
echo "create live-mon: ${NEW##* } $(echo "${NEW% *}" | pick 'j.loginId+" "+j.role+" disabled "+j.disabled')"
echo "live-mon login: $(login live-mon $J/lm "$NEW_PW")"
echo "role -> OPERATOR: $(curl -s -w ' %{http_code}' "${A[@]}" -X PATCH -d '{"role":"OPERATOR","merchantCode":null}' $WEB/admin/accounts/$ID | grep -o '"role":"[A-Z]*"\| [0-9]*$' | tr '\n' ' ')"
echo "live-mon session after role change: $(code -b $J/lm $WEB/auth/me)"
echo "role -> MERCHANT without merchant (400): $(curl -s -w ' %{http_code}' "${A[@]}" -X PATCH -d '{"role":"MERCHANT"}' $WEB/admin/accounts/$ID | grep -o '"code":"[A-Z_]*"\| [0-9]*$' | tr '\n' ' ')"
echo "disable: $(curl -s -w ' %{http_code}' "${A[@]}" -X PATCH -d '{"disabled":true}' $WEB/admin/accounts/$ID | grep -o '"disabled":[a-z]*\| [0-9]*$' | tr '\n' ' ')"
echo "live-mon login after disable: $(login live-mon $J/lm2 "$NEW_PW")"
echo "demote last admin (409): $(curl -s -w ' %{http_code}' "${A[@]}" -X PATCH -d '{"role":"OPERATOR"}' $WEB/admin/accounts/1 | grep -o '"code":"[A-Z_]*"\| [0-9]*$' | tr '\n' ' ')"
echo "admin GET /firmware: $(code -b $J/ad $WEB/firmware)  admin POST /terminals (403): $(code "${A[@]}" -d '{"serialNo":"LIVE-X-0009","modelCode":"SN-100"}' $WEB/terminals)"
echo "logout operator: $(code -X POST -b $J/op $WEB/auth/logout) admin: $(code -X POST -b $J/ad $WEB/auth/logout) then /admin/accounts $(code -b $J/ad $WEB/admin/accounts)"
rm -rf $J
```

저장소 루트에서 `node <경로>/adminx-xlsx.mjs apps/api <경로>/live-import.xlsx` 뒤 `bash <경로>/adminx-live.sh 5176 <경로>/live-import.xlsx`로 돌린다.

Expected(사전 검증 원문, api 포트 3200·시각만 다름):

```text
index.html: 200 <title>단말온 운영 어드민</title>
apps.ts env (VITE_MERCHANT_APP_URL): http://merchant.demo:8081
proxy /api/health: {"status":"ok"}
no login /api/firmware: 401
operator login: 200
register LIVE-X-0001: "serialNo":"LIVE-X-0001" "status":"RECEIVED"  201 
register again (409): "code":"DUPLICATE"  409 
import xlsx: 201 live-import.xlsx total 5 {"CREATED":2,"ALREADY_EXISTS":1,"INVALID_FORMAT":1,"UNKNOWN_MODEL":1} rows 2:CREATED,3:CREATED,4:ALREADY_EXISTS,5:INVALID_FORMAT,6:UNKNOWN_MODEL
import not xlsx (400): "code":"INVALID_FILE"  400 
purchase order: SE17932328003280002 SN-100 x5 ORDERED by operator
reconciliation: ordered 5 noted 5 received 0
firmware register SN-100 9.9.0: "version":"9.9.0" "createdBy":"operator"  201 
firmware register again (409): "code":"DUPLICATE"  409 
firmware list SN-100: SN-100 9.9.0 next null
rollout create: 201 #1 SN-100 9.9.0 RUNNING stages 10/50/100 stage1 targets 0
rollout create again (409): "code":"ROLLOUT_ALREADY_ACTIVE"  409 
rollout bad stages (400): "code":"INVALID_STAGES"  400 
operator /admin/accounts (403): 403
admin login: 200
accounts: admin:ADMIN,operator:OPERATOR,monitor:MONITOR,field:FIELD,merchant-gangnam:MERCHANT,merchant-yeoksam:MERCHANT,merchant-pangyo:MERCHANT
create live-mon: 201 live-mon MONITOR disabled false
live-mon login: 200
role -> OPERATOR: "role":"OPERATOR"  200 
live-mon session after role change: 401
role -> MERCHANT without merchant (400): "code":"MERCHANT_REQUIRED"  400 
disable: "disabled":true  200 
live-mon login after disable: 401
demote last admin (409): "code":"LAST_ADMIN"  409 
admin GET /firmware: 200  admin POST /terminals (403): 403
logout operator: 204 admin: 204 then /admin/accounts 401
```

**컨트롤러 확인 요청**(devlog에 "컨트롤러 확인 대기"로 적는다): 서버가 떠 있는 동안 컨트롤러가 내장 브라우저로 `http://localhost:5176/login`을 열어 `operator`로 단말기 등록(한 대·엑셀 — 위 엑셀 파일)·펌웨어 등록·새 배포 만들기, `admin`으로 계정(만들기·역할 바꾸기·사용 중지)과 왼쪽 "다른 화면"(매장 링크가 `http://merchant.demo:8081`)을 본다. 매장·현장 링크를 눌러 로그인하면 쿠키를 함께 써서 어드민 세션이 끝난다(안전 규칙). 컨트롤러가 다 봤다고 하면 다음으로.

끄기와 정리:

```bash
netstat -ano | grep -E ':(3100|4012|5176) .*LISTENING'     # PID 세 개
tasklist //FI "PID eq <PID>" //FO CSV //NH                  # 셋 다 node.exe인지
taskkill //PID <api PID> //F; taskkill //PID <partners PID> //F; taskkill //PID <vite PID> //F
netstat -ano | grep -E ':(3100|4012|5176) .*LISTENING'     # 출력 없음
tasklist //FI "IMAGENAME eq node.exe" //FO CSV //NH          # 시작 전과 같은 PID만
MSYS_NO_PATHCONV=1 docker exec terminal-ops-redis redis-cli --scan --pattern 'adminx-live*'   # 본 키만 하나씩 DEL
# MSYS_NO_PATHCONV=1 docker exec terminal-ops-redis redis-cli DEL <키>   (키마다 — 사전 검증에서는 8개 — 큐 meta 6, `sess-gen:<계정 id>` 1, `login-fail:live-mon` 1)
# 마지막으로 테스트 DB를 빈 DB로 다시 만든다(안전 규칙), 임시 엑셀·스크립트는 지운다
```

- [ ] **Step 3: README**

`README.md`에서 아래를 바꾼다(Edit 도구, 각 줄 그대로 찾아 바꾼다).

1. 구성의 admin 줄:
   ```
   │  ├─ admin/             React 19 + Vite 8 + TanStack Query 어드민(Vite 프록시 /api → api) — 운영 업무 전부·계정 관리·다른 화면 바로가기(보강 5)
   ```
2. "로그인과 역할"의 `- 계정 관리(`/admin/accounts`)·키 관리 화면은 아직 없다(Bundle 7) — API만. …` 줄 앞부분을:
   ```
   - 계정 관리는 어드민 "계정" 화면(ADMIN, 보강 5 — [decisions/0069](docs/decisions/0069-계정-화면은-어드민에-외부-업체-키-화면은-개발자센터로.md)). 외부 업체 키 화면은 아직 없다(개발자센터, 보강 7) — API만. 역할·가맹점·비밀번호를 바꾸거나 사용 중지하면 그 계정의 세션이 모두 끊긴다. 마지막 활성 ADMIN은 사용 중지·강등할 수 없다(409 `LAST_ADMIN`).
   ```
3. "현장 화면(보강 4)" 절 끝(마지막 `- 시연 팁: …` 줄 뒤, `## 기능` 앞)에 절 하나:
   ```markdown
   ## 통합 어드민(보강 5)

   시연 시나리오를 어드민 화면만으로 끝까지 돌릴 수 있게 운영자·ADMIN 화면을 채웠다(단계별 점검표는 [스펙](docs/specs/2026-10-29-admin-expansion.md) 2장).

   - 단말기 등록(운영자): 한 대(시리얼·모델), 엑셀 일괄(.xlsx, 1행 머리글 `serialNo`·`modelCode`, 5,000행·2MB) → 행별 결과·실패한 행만·결과 CSV
   - 펌웨어 배포(운영자 쓰기): "펌웨어 등록"(모델·버전), "새 배포 만들기"(모델 → 등록 버전, 단계 비율·실패 임계치·최소 표본·단계 시간 제한, 확인 뒤 시작). 버전 선택지는 `GET /firmware`([decisions/0066](docs/decisions/0066-어드민-확장은-있는-API를-쓰고-새-API는-펌웨어-목록-하나.md))
   - 발주는 "발주 입고 대조" 화면 그대로(발주하기·대조·마감, [decisions/0068](docs/decisions/0068-운영자-쓰기-화면은-새-메뉴-하나와-기존-화면-안의-폼으로.md))
   - 계정(ADMIN): 목록·만들기·역할 바꾸기·사용 중지([decisions/0069](docs/decisions/0069-계정-화면은-어드민에-외부-업체-키-화면은-개발자센터로.md))
   - 왼쪽 아래 "다른 화면": 매장(:5174)·현장(:5175) 새 탭, 이후 화면(관제·개발자센터·업체 콘솔·시뮬레이터)은 준비 중. 주소는 `apps/admin/src/apps.ts` 한 곳 — 바꿀 때는 `VITE_MERCHANT_APP_URL`·`VITE_FIELD_APP_URL` 같은 env를 주고 어드민을 다시 띄운다([decisions/0067](docs/decisions/0067-다른-화면-바로가기-주소는-apps-ts-한-곳과-Vite-env로.md))
   ```
4. 기능 표의 `| 어드민 | …` 줄:
   ```
   | 어드민 | 처음 화면(운영 현황), 단말기 목록·상세, 단말기 등록(한 대·엑셀, 보강 5), 박스 스캔, A/S, 펌웨어 배포(등록·배포 만들기, 보강 5), 이상·VAN·입고 대조·주간 리포트, 배치 실행 이력, 계정(ADMIN, 보강 5), 다른 화면 바로가기 | `apps/admin/src/pages/`, `apps/admin/src/apps.ts` |
   ```
5. 기록 색인 줄 "결정 65·트러블슈팅 32·실험 17" → "결정 69·트러블슈팅 32·실험 17"(Task 중 트러블슈팅이 생겼으면 실제 수 — `node scripts/docs-index.mjs` 출력).
6. 테스트 절 설명과 표(Step 1에서 센 실제 값으로):
   ```markdown
   (보강 5 통합 어드민 확장 뒤 실제로 돌려 센 값(2026-10-29). api는 실험 파일 제외 — 실험은 `EXPERIMENTS=1`에서만 돈다. 보강 4 뒤에는 api 82/568·admin 14/125, 보강 3 뒤에는 api 80/561·merchant 7/47, 보강 2 뒤에는 api 79/549, 보강 1 뒤에는 api 66/453, admin 12/109, device-sim 4/40이었다)

   | 앱 | 파일 | 테스트 |
   |---|---|---|
   | api(실험 제외) | 83 | 571 |
   | admin | 19 | 152 |
   | merchant | 7 | 47 |
   | field | 7 | 60 |
   | partners | 6 | 53 |
   | device-sim | 5 | 46 |
   ```

- [ ] **Step 4: 회고**

`docs/retrospective.md` "7일 뒤 보강"의 마지막 줄(`  - 보강 4가 남긴 것: …`) 뒤에 두 줄:

```markdown
- [x] **보강 5: 통합 어드민 확장** — 시연 시나리오 점검표(단계 → 앱·화면 → 있나 → 채우는 묶음)를 먼저 만들고, 운영자·ADMIN 단계 중 화면이 없던 것을 어드민에 채웠다: 단말기 등록(한 대·엑셀, 행별 결과·CSV — 화면이 만든다), 펌웨어 등록·배포 만들기(배포 화면의 접힌 폼), 계정(목록·만들기·역할·사용 중지)([0068](decisions/0068-운영자-쓰기-화면은-새-메뉴-하나와-기존-화면-안의-폼으로.md)·[0069](decisions/0069-계정-화면은-어드민에-외부-업체-키-화면은-개발자센터로.md)). 발주는 기존 화면에 이미 다 있어 그대로. 새 API는 버전 선택지용 `GET /firmware` 하나([0066](decisions/0066-어드민-확장은-있는-API를-쓰고-새-API는-펌웨어-목록-하나.md)), 다른 화면 주소는 `apps.ts` 한 곳 + Vite env([0067](decisions/0067-다른-화면-바로가기-주소는-apps-ts-한-곳과-Vite-env로.md)). 기존 테스트는 고치지 않았다(접근 표 한 줄, 테스트 도구·쿼리 키 테스트에 한 줄씩). 기록: devlog 2026-10-29 `# 보강 5: 통합 어드민 확장`, [계획](plans/2026-10-29-admin-expansion.md)
  - 보강 5가 남긴 것: 외부 업체 키 화면 없음(보강 7 개발자센터), 비밀번호·표시 이름 바꾸기 화면 없음(API는 있음), 다른 화면 주소는 Vite env라 바꾸면 다시 띄우거나 다시 빌드해야 함(같은 빌드를 여러 환경에 올리려면 실행 때 읽는 설정), 엑셀 결과 CSV는 화면 메모리의 `data:` URL(다시 받을 수 없음), 펌웨어 버전 선택지는 모델당 최근 100개, 계정 화면에서 자기 역할을 바꾸면 곧 401로 로그인 화면(확인 글로만 알림), 다른 탭에서 사용자가 바뀐 것을 알아채지 못하는 한계(0041)는 그대로
```

- [ ] **Step 5: 색인·devlog·커밋**

```bash
node scripts/docs-index.mjs
node scripts/docs-index.mjs --check
```

devlog 항목(Task 5 항목 뒤):

```markdown
## HH:MM Task 6 마감 — 전체 검증, 실서버 확인, README·회고 (커밋 = 이 항목이 든 커밋)
- 이전 커밋: <Task 5 커밋 해시>
- 전체 검증: api `Test Files  <수> passed (<수>)`, `Tests  <수> passed (<수>)`, Duration <초>, `Connection is closed` <수>. admin 19/152·build, merchant 7/47·build, field 7/60·build, device-sim 5/46·tsc 0, partners 6/53. 개발 DB `db:migration:check` 최신 상태
- 실서버(테스트 DB, api :3100 `QUEUE_PREFIX=adminx-live`, 가상 업체 :4012, 어드민 :5176 프록시): (스크립트 출력 요약 — 비밀번호 없이)
- 끄기: 세 PID를 taskkill, 포트 LISTENING 0, node PID는 시작 전과 같음. Redis `adminx-live*` 키 <수>개 하나씩 DEL. 테스트 DB 빈 DB로
- 컨트롤러 확인: (대기 / 본 것)
- README(구성·로그인과 역할·통합 어드민 절·기능·기록 수·테스트 표), 회고(보강 5와 남긴 것)
- 다음: 컨트롤러 최종 리뷰·병합(push는 컨트롤러)
```

```bash
git add README.md docs
git status --short
git commit -m "$(cat <<'EOF'
docs(admin): 보강 5 마감 — 전체 검증·실서버 확인, README 통합 어드민 절·테스트 수, 회고

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

devlog 제목 시각 = 커밋 시각인지 보고, 다르면 고쳐 `git commit --amend --no-edit`. 끝나면 안전 규칙의 netstat·tasklist를 다시 본다.

---

## 자체 점검

- 브리프 대응: 1(시나리오 점검표 — 스펙 2장, 6~8·7·9 표시) → 스펙. 2(운영자 화면: 단말기 한 대 + 엑셀(파일 업로드·행별 결과·결과 다운로드) → Task 3, 발주 생성 + 상세 — 기존 화면에 다 있어 합친 상태 그대로(0068) → 범위 조정, 펌웨어 등록 + 단계 배포 생성(단계 비율·실패 임계치·최소 표본·단계 시간 제한) → Task 4, 빠진 운영자 쓰기 — 점검표상 없음, 가맹점 목록 화면은 만들지 않음 → 범위 조정) . 3(ADMIN 계정 목록·생성·역할 변경·사용 중지·LAST_ADMIN 409 안내 → Task 5, 키는 개발자센터로 넘기고 안내·링크 자리만 → Task 5·Task 2(0069·0067)). 4(통합 입구 — "다른 화면", 주소는 env + 한 곳 → Task 2(0067)). 5(서버 규칙 재사용, 새 API는 contracts·접근 표·e2e → Task 1(0066), 메뉴·RequireRole 확장 → Task 3·5). 6(Vitest + Testing Library, api e2e, 화면은 컨트롤러 → Task 1~6).
- 이름 일치: 계약 `RegisterTerminalRequest`·`TerminalImportView`(Task 1)를 Task 3이, `RegisterFirmwareRequest`·`CreateRolloutRequest`(Task 1)를 Task 4가, `FirmwareView`·`BeforeIdPage`(기존)를 Task 4가 같은 이름으로. `otherApps`·`OtherApp`·`AppLinks`(Task 2). `ROW_RESULT_LABEL`(Task 3 labels.ts)을 `lib/csv.ts`·`RegistrationPage`가. `fileProblem`·`SERIAL_NO_PATTERN`·`MAX_IMPORT_BYTES`(Task 3). `parseStages`·`FIRMWARE_VERSION_PATTERN`·`MAX_STAGE_TIMEOUT_MINUTES`·`FirmwareRegisterForm`·`RolloutCreateForm`(Task 4). `keys.firmware.all`·`keys.firmware.byModel`(Task 4), `keys.accounts.all`(Task 5), 기존 `keys.terminalModels`·`keys.merchants`·`keys.terminals.all`·`keys.rollouts.all`. `LOGIN_ID_PATTERN`·`AccountsPage`(Task 5). api `ListFirmwareQuery`·`FirmwareService.list`·`FirmwareController.listFirmware`(Task 1).
- 플레이스홀더 검사: 코드 블록은 모두 사전 검증 커밋에서 뽑은 실제 코드다(Task 1 `ed097d5`, 2 `2d1e4a7`, 3 `1f0cd28`, 4 `fb07a30`, 5 `3ab5ff0` — 임시 폴더 `adminxcheck`, 기준 54dc512). 실행 때 채우는 것은 devlog의 `HH:MM`·해시·Duration·PID·키 수, README 기록 수(트러블슈팅이 생겼을 때)뿐이다.
- 안전: 개발 DB는 Task 6의 `db:migration:check`(읽기)뿐. 실서버 쓰기는 테스트 DB. Redis는 `adminx-live*` 키만 하나씩. 서버는 단독 node 명령·PID로 끄기. 비밀번호는 seed 파일에서 변수로만, 새 계정 비밀번호는 무작위·출력 안 함.
