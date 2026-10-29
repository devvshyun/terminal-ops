# terminal-ops — 결제단말기 운영 시스템(학습 프로젝트)

가상의 결제단말기 운영사 **단말온**이 단말기 수천 대의 일생(발주 → 입고·검수 → 재고 → 배정·출고 → 배송 → 설치·운영 → 고장·회수)을 관리하는 사내 시스템이다. Nest.js · MikroORM · MySQL · Redis(BullMQ)를 실제 쓰임새 안에서 익히려고 7일 동안 만들었다. 설계: [`../01_B_단말기생애주기_설계안.md`](../01_B_단말기생애주기_설계안.md)(저장소 밖, 같은 상위 폴더), 작업 규칙: [`CLAUDE.md`](CLAUDE.md).

등장하는 회사·API는 **모두 가상**이다. 실제 업체명·실제 API·전 직장 코드는 쓰지 않았다.

| 가상 업체 | 역할 | 일부러 넣은 골칫거리(설정으로 켜고 끔) |
|---|---|---|
| 세움전자 | 단말기 제조, 발주·납품 명세 | 덜 보내기, 명세에 없는 시리얼, 5xx |
| 번개택배 | 택배 추적 JSON | 같은 이벤트 중복, 429(Retry-After), 지연 |
| 느림보물류 | 택배 추적 XML(상태 코드 체계가 다름) | 느림, 5xx, 이벤트 순서 뒤섞임 |
| 브릿지VAN | VAN 등록 목록(커서 페이지) | 어긋난 등록, 스캔 도중 변경, 429·503 |
| 톡톡메신저 | 알림·리포트 웹훅, 파일 첨부 | 가끔 실패, 응답 지연 |

## 구성

```
terminal-ops/
├─ docker-compose.yml    MySQL 8.4, Redis 7.4
├─ apps/
│  ├─ api/               Nest.js 12 — HTTP API와 큐 워커(실행 모드로 분리: RUN_WORKERS, RUN_SCHEDULERS), 로그인·역할(보강 2)
│  ├─ admin/             React 19 + Vite 8 + TanStack Query 어드민(Vite 프록시 /api → api) — 운영 업무 전부·계정 관리·다른 화면 바로가기(보강 5)
│  ├─ merchant/          매장(가맹점주) 화면 — 휴대폰 폭, 어드민과 같은 스택·같은 판(Vite 프록시 /api → api, 보강 3)
│  ├─ field/             현장 작업자 화면 — 휴대폰·PDA 폭, 바코드 스캐너(키보드 웨지) 입력, 점주 앱과 같은 스택·같은 판(Vite 프록시 /api → api, 보강 4)
│  ├─ landing/           소개 페이지 — api 없이 뜨는 정적 페이지(Vite + GSAP), 숫자는 실험 기록과 같은지 테스트가 본다(decisions/0071)
│  ├─ partners/          가상 업체 서버(node:http, 포트 4010): 세움전자·번개택배·느림보물류·브릿지VAN·톡톡메신저
│  └─ device-sim/        단말기 시뮬레이터(하트비트, 펌웨어 업데이트 결과 보고)
├─ packages/
│  └─ contracts/         api·어드민·매장·현장 화면이 함께 보는 HTTP 계약(응답·요청 모양, 상태 값, 오류 코드, 로그인·계정·키 타입). 타입만, 각 앱이 file: 의존
├─ infra/                MySQL 초기화(테스트 DB), 미리보기 env
├─ scripts/              기록 색인 생성
└─ docs/                 기록(아래 "기록")
```

## 실행

Node 24, Docker Desktop(WSL2)이 필요하다. 명령은 Git Bash 기준.

```bash
cp .env.example .env                 # 로컬 개발 전용 값. DEVICE_API_KEY는 자리표시자다 — 임의의 값(16자 이상, 공백 없는 ASCII)으로 바꿔 쓴다
                                     # (보강 2 뒤 .env가 이미 있으면 .env.example의 "# 보강 2" 아래 줄들을 덧붙인다 — DEVICE_API_KEY가 없으면 api가 뜨지 않는다)
docker compose up -d --wait          # MySQL·Redis, healthcheck가 healthy가 될 때까지 기다린다(첫 실행은 MySQL 초기화에 수십 초)
for a in api admin merchant field landing partners device-sim; do (cd apps/$a && npm ci); done   # api·admin·merchant·field는 packages/contracts를 링크한다(따로 설치하지 않는다)
cd apps/api && npm run db:migrate && npm run db:seed && cd ../..   # 개발 DB 스키마와 기준 데이터(모델·가맹점·검수 항목)와 시연 계정 7개·시연 외부 업체 키(NODE_ENV=production·SEED_DEMO=0이면 기준 데이터만)

# 필요한 것만 터미널마다 하나씩(또는 백그라운드 — 끌 때는 PID로)
(cd apps/partners && npm run build && npm start)       # :4010
(cd apps/api && npm run build && npm start)            # :3000, 워커·주기 작업 포함(.env의 RUN_WORKERS·RUN_SCHEDULERS)
(cd apps/api && npm run start:worker)                  # 선택: 워커만 따로 — main api가 RUN_WORKERS=0일 때만. 둘 다 워커면 report 큐 한 번에 하나(decisions/0038) 가정이 깨진다
(cd apps/admin && npm run dev)                         # :5173 → 브라우저 http://localhost:5173/login
(cd apps/merchant && npm run dev)                      # :5174 → 휴대폰 크기로 http://localhost:5174/login (가맹점 계정)
(cd apps/field && npm run dev)                         # :5175 → 휴대폰 크기로 http://localhost:5175/login (현장 작업자 계정 field)
(cd apps/landing && npm run dev)                       # :5176 → 소개 페이지(api 필요 없음)
(cd apps/device-sim && npm run build && node --env-file=../../.env dist/main.js)   # 선택: 단말기 시뮬레이터(:4020) — api와 같은 .env의 DEVICE_API_KEY를 X-Device-Key로 보낸다(api는 .env를 스스로 읽고, 시뮬레이터는 --env-file로)
```

- 워커 프로세스를 띄우는 실험(0005·0014)은 먼저 `cd apps/api && npm run build` — `dist/worker.js`를 자식 프로세스로 띄우므로, 빌드하지 않으면 멈추고("먼저 npm run build 하세요"), 소스만 고치고 빌드를 잊으면 옛 워커로 잰다(경고 없음).
- 테스트: 각 앱 폴더에서 `npm test`. api 테스트는 테스트 DB(`terminal_ops_test`)와 Redis 테스트 접두사(`test-`)만 쓰고, 가상 업체 서버를 테스트 포트(4011)에 직접 띄운다 — api 테스트를 두 개 동시에 돌리지 않는다. 실험은 `EXPERIMENTS=1 npx vitest run test/experiments/<파일> --silent=false`.
- 타입 검사: vitest는 타입을 보지 않는다. api `npm run typecheck`(또는 `npm run build`), admin·merchant·field `npm run build`(tsc 포함) — api·화면이 `packages/contracts`와 어긋나면 여기서 실패한다([decisions/0048](docs/decisions/0048-계약은-반환-타입-implements-enum-단언으로-강제한다.md)).
- 미리보기(화면 확인)는 `infra/preview.env`(주기 작업을 등록하지 않음)를 저장소 `.env` 뒤에 읽는다. 띄우기 전 점검(빌드, 남은 주기 작업 `npm run scheduler:clear`, 같은 접두사의 다른 워커)은 그 파일 주석에 있다.
- 주기 작업은 Redis에 남는다(BullMQ job scheduler). 지우려면 `cd apps/api && npm run scheduler:clear`(이 접두사의 주기 작업만 — Redis 전체를 비우지 않는다).

## 로그인과 역할(보강 2)

**여기 나오는 비밀번호·키는 저장소에 공개된 로컬 시연 전용 값이다. 다른 곳에 쓰지 않는다.**

사람은 로그인한다(Redis 서버 세션 + httpOnly·SameSite=Strict 쿠키 `sid`, [decisions/0050](docs/decisions/0050-로그인은-Redis-서버-세션과-httpOnly-쿠키로.md)). 엔드포인트마다 부를 수 있는 역할이 정해져 있고, 규칙이 없는 엔드포인트는 403이다(기본 거부, 표는 [decisions/0052](docs/decisions/0052-역할별-엔드포인트-표와-기본-거부.md)). 이력의 작업자는 로그인 아이디다([decisions/0056](docs/decisions/0056-작업자는-로그인-아이디-X-Operator는-테스트-전용.md)).

- **ADMIN**: 계정·역할·외부 업체 키 관리(`/admin/*`)와 읽기. 업무 쓰기는 하지 않는다
- **OPERATOR**: 운영자 — 어드민의 모든 업무 쓰기(등록·전이·배정·출고·A/S·배포 …)
- **MONITOR**: 관제·개발자 — 읽기와 관제 작업(이상 찾기·VAN 대조·주간 리포트 실행)
- **FIELD**: 현장 작업자 — 박스 스캔·검수와 그에 필요한 조회. 화면은 현장 화면 `apps/field`(:5175, 보강 4 — [decisions/0061](docs/decisions/0061-현장-화면은-별도-앱-apps-field.md)). 어드민의 박스 스캔·검수도 그대로 쓸 수 있다
- **MERCHANT**: 가맹점주 — `/me/*`로 자기 가맹점의 단말기·A/S만([decisions/0053](docs/decisions/0053-가맹점주-범위는-me-전용-엔드포인트와-서비스-scope.md)). 화면은 매장 화면 `apps/merchant`(:5174, 보강 3 — [decisions/0057](docs/decisions/0057-점주-화면은-별도-앱-apps-merchant.md)). 어드민은 안내와 로그아웃만

시연 계정(`npm run db:seed`가 넣는다). 비밀번호는 표에 적지 않는다 — `apps/api/src/db/seed-accounts.ts`의 로컬 시연 전용 값을 본다.

| 아이디 | 역할 | 가맹점 |
|---|---|---|
| `admin` | ADMIN | |
| `operator` | OPERATOR | |
| `monitor` | MONITOR | |
| `field` | FIELD | |
| `merchant-gangnam` | MERCHANT | GANGNAM-KIMBAP |
| `merchant-yeoksam` | MERCHANT | YEOKSAM-CAFE |
| `merchant-pangyo` | MERCHANT | PANGYO-BUNSIK |

어드민은 `http://localhost:5173/login`. curl로는(저장소 루트, api :3000):

```bash
# 사람: 로그인 → 쿠키 파일 → 호출. 비밀번호는 seed-accounts.ts에서 읽어 넣는다(로그인은 JSON 본문만 — 아니면 415)
curl -s -c .cookies -H 'Content-Type: application/json' \
  -d '{"loginId":"operator","password":"<seed-accounts.ts의 operator 비밀번호>"}' http://localhost:3000/auth/login
curl -s -b .cookies http://localhost:3000/auth/me
curl -s -b .cookies 'http://localhost:3000/terminals?size=5'
curl -s -b .cookies -X POST http://localhost:3000/auth/logout; rm .cookies

# 외부 업체(가상): 시연 키(scope 두 개)를 Bearer로(또는 X-Api-Key 헤더)
curl -s -H "Authorization: Bearer $(grep -o "pk_demo0001_[^']*" apps/api/src/db/seed-accounts.ts)" \
  http://localhost:3000/partner/v1/merchants/GANGNAM-KIMBAP/terminals
```

- 외부 업체 키: 발급·폐기는 ADMIN의 `POST /admin/partner-keys`(원문은 그 응답에서 한 번만)·`POST /admin/partner-keys/:id/revoke`. DB에는 접두사와 SHA-256만([decisions/0054](docs/decisions/0054-외부-업체-키는-해시-저장과-scope.md)). 시연 키는 시드에 고정한 값이다.
- 단말기 키: `.env`의 `DEVICE_API_KEY`(16자 이상, 공백 없는 ASCII). `.env.example`의 자리표시자(`change-me…`)나 규칙에 맞지 않는 값이면 api와 device-sim 모두 시작할 때 멈춘다. 하트비트·펌웨어 보고는 `X-Device-Key`로 이 값을 보내야 한다(없거나 틀리면 401). device-sim이 같은 env를 읽는다([decisions/0055](docs/decisions/0055-단말기는-공유-단말기-키로.md)).
- 계정 관리는 어드민 "계정" 화면(ADMIN, 보강 5 — [decisions/0069](docs/decisions/0069-계정-화면은-어드민에-외부-업체-키-화면은-개발자센터로.md)). 외부 업체 키 화면은 아직 없다(개발자센터, 보강 7) — API만. 역할·가맹점·비밀번호를 바꾸거나 사용 중지하면 그 계정의 세션이 모두 끊긴다. 마지막 활성 ADMIN은 사용 중지·강등할 수 없다(409 `LAST_ADMIN`).
- 마이그레이션 `down`(`npm run db:migration:down`, 테스트 DB에서만 열려 있다)으로 보강 2의 두 마이그레이션을 되돌리면 `user_account`·`partner_api_key` 표가 지워져 **시연 계정·시연 키도 사라진다**. 개발 DB에서 다른 방법으로 되돌렸다면 다시 `db:migrate` 뒤 `db:seed`로 넣는다.
- 테스트는 `X-Operator`·`X-Test-Role` 헤더로 사람을 흉내 낸다 — `NODE_ENV=test`이고 `AUTH_TEST_HEADERS=1`일 때만 켜진다(운영 실행에서는 401).

## 매장 화면(보강 3)

가맹점주가 휴대폰으로 쓰는 화면이다. `http://localhost:5174/login`에 위 표의 `merchant-*` 계정으로 들어간다(직원 계정이면 안내와 로그아웃만).

- 시연 팁: localhost에서는 포트가 달라도 쿠키(`sid`)가 하나다. 어드민(:5173)과 매장 화면(:5174)을 동시에 다른 계정으로 보려면 브라우저 프로필(또는 시크릿 창)을 나눈다. 한쪽에서 로그인하면 다른 쪽 세션이 끝나 그 탭은 403/안내를 본다

- 홈: 오고 있는 단말기(운송장·택배 단계, A/S 교체품이면 접수 번호) → 진행 중 A/S(지금 단계) → 사용 중 단말기(연결·마지막 접속·펌웨어) → 회수(점주가 할 일)
- 단말기 상세(이번 배정부터의 지난 일), 고장 접수(증상 + 메모), A/S 진행 단계(접수 → 원격 점검 → 교체 출고 → 배송 중 → 설치 확인 → 완료)와 설치 확인
- 점주에게 보이는 단말기는 배정부터 회수 완료까지다 — 회수 뒤 본사로 돌아간(검수·재고) 단말기는 옛 가맹점에 보이지 않는다([decisions/0059](docs/decisions/0059-점주-화면용-me-보강은-점주용-모양과-보이는-상태로.md)). 점주 문구·단계는 화면이 상태 값에서 만든다([0060](docs/decisions/0060-점주-문구와-진행-단계는-화면이-상태에서-만든다.md)). api 클라이언트·세션 코드는 어드민 사본이다([0058](docs/decisions/0058-화면-공통-코드는-공유-패키지가-아니라-복사로.md))

## 현장 화면(보강 4)

창고·물류 현장 작업자가 휴대폰·PDA로 쓰는 화면이다. `http://localhost:5175/login`에 위 표의 `field` 계정으로 들어간다(다른 계정이면 안내와 로그아웃만).

- 홈: 오늘(KST) 내가 처리한 박스·입고·회수 입고·검수 수(`GET /field/today`, [decisions/0063](docs/decisions/0063-현장-API는-오늘-내-작업-하나만.md))와 큰 버튼 둘
- 박스 스캔: 발주분 입고(열린 발주 고르기)·회수 입고. 바코드 스캐너(키보드 웨지 — 시리얼 + Enter)나 손 입력·붙여 넣기로 목록에 쌓이고, 중복·형식 오류는 그 줄에 바로 보인다. 보낸 박스는 잠기고, 응답을 못 받으면 같은 박스 번호(scanId)로 다시 보낸다(어드민과 같은 멱등 규칙). 카메라 바코드는 없다([decisions/0064](docs/decisions/0064-현장-입력은-키보드-웨지-카메라는-생략.md))
- 검수: 검수 대기(새 입고·회수 입고, 오래 기다린 순), 시리얼 스캔으로 바로 찾기, 항목마다 합격/불합격(+ 불합격 메모), 저장 → 합격/불량
- 넓은 화면(1180px 이상)에서는 왼쪽에 "휴대폰·PDA용 — 어드민 박스 스캔 열기" 안내가 보인다. 어드민 주소는 `VITE_ADMIN_APP_URL`(없으면 `http://localhost:5173`, [decisions/0070](docs/decisions/0070-화면-디자인-토큰과-글꼴은-앱에-넣는다.md))
- api 클라이언트·세션 코드는 점주 앱 사본이고 `src/copies.test.ts`가 코드가 같은지 본다([decisions/0062](docs/decisions/0062-세-번째-화면도-복사와-사본-검사-테스트로.md))
- 시연 팁: 어드민(:5173)·매장(:5174)·현장(:5175)은 localhost에서 쿠키(`sid`) 하나를 함께 쓴다 — 동시에 다른 계정으로 보려면 브라우저 프로필을 나눈다

## 통합 어드민(보강 5)

시연 시나리오 중 운영자·ADMIN 단계를 어드민 화면으로 돌릴 수 있게 채웠다(외부 업체 키는 보강 7 개발자센터). 현장·점주·단말기 시뮬레이터·외부 업체 단계는 각자의 앱에서 한다(단계별 점검표는 [스펙](docs/specs/2026-10-29-admin-expansion.md) 2장).

- 단말기 등록(운영자): 한 대(시리얼·모델), 엑셀 일괄(.xlsx, 1행 머리글 `serialNo`·`modelCode`, 5,000행·2MB) → 행별 결과·실패한 행만·결과 CSV
- 펌웨어 배포(운영자 쓰기): "펌웨어 등록"(모델·버전), "새 배포 만들기"(모델 → 등록 버전, 단계 비율·실패 임계치·최소 표본·단계 시간 제한, 확인 뒤 시작). 버전 선택지는 `GET /firmware`([decisions/0066](docs/decisions/0066-어드민-확장은-있는-API를-쓰고-새-API는-펌웨어-목록-하나.md))
- 발주는 "발주 입고 대조" 화면 그대로(발주하기·대조·마감, [decisions/0068](docs/decisions/0068-운영자-쓰기-화면은-새-메뉴-하나와-기존-화면-안의-폼으로.md))
- 계정(ADMIN): 목록·만들기·역할 바꾸기·사용 중지([decisions/0069](docs/decisions/0069-계정-화면은-어드민에-외부-업체-키-화면은-개발자센터로.md))
- 왼쪽 아래 "다른 화면": 매장(:5174)·현장(:5175) 새 탭, 이후 화면(관제·개발자센터·업체 콘솔·시뮬레이터)은 준비 중. 주소는 `apps/admin/src/apps.ts` 한 곳 — 바꿀 때는 `VITE_MERCHANT_APP_URL`·`VITE_FIELD_APP_URL` 같은 env를 주고 어드민을 다시 띄운다([decisions/0067](docs/decisions/0067-다른-화면-바로가기-주소는-apps-ts-한-곳과-Vite-env로.md))

## 기능

| ID | 기능 | 코드 |
|---|---|---|
| F1 | 단말기 등록·조회, 엑셀 일괄 등록 | `apps/api/src/terminal/`(`terminal.service.ts`, `bulk-registration.service.ts`, `terminal-import.service.ts`) |
| F2 | 상태 전이 + 이력(허용 전이 표, 낙관적 락) | `apps/api/src/terminal/transition.service.ts`, `transition-rules.ts` |
| F3 | 택배 추적 자동 수집(BullMQ, limiter, 재시도) | `apps/api/src/carrier-sync/` |
| F4 | 이상 단말기 찾기(규칙 6개, 매일 밤) | `apps/api/src/anomaly/` |
| F5 | 알림(Outbox, 최소 한 번 + 멱등키, 복구 sweep) | `apps/api/src/outbox/` |
| F6 | 박스 단위 일괄 스캔(scanId 멱등) | `apps/api/src/scan/` |
| F7 | A/S와 교체 출고(한 트랜잭션, 교체 단말기 예약) | `apps/api/src/service/` |
| F8 | 접속 상태(하트비트 Redis) + 펌웨어 단계 배포 | `apps/api/src/device/`, `apps/api/src/firmware/`, `apps/device-sim/` |
| F9 | VAN 등록 대조(스테이징 + SQL 비교 + 재검증) | `apps/api/src/van/` |
| F10 | 발주 대비 입고 대조 | `apps/api/src/purchase-order/` |
| F11 | 주간 운영 리포트(xlsx → 톡톡), 대시보드(Redis 캐시) | `apps/api/src/report/`, `apps/api/src/dashboard/` |
| F12 | 택배사 어댑터(JSON·XML → 같은 이벤트) | `apps/api/src/carrier/` |
| F13 | 검수 체크리스트와 불합격 통계 | `apps/api/src/inspection/` |
| 어드민 | 처음 화면(운영 현황), 단말기 목록·상세, 단말기 등록(한 대·엑셀, 보강 5), 박스 스캔, A/S, 펌웨어 배포(등록·배포 만들기, 보강 5), 이상·VAN·입고 대조·주간 리포트, 배치 실행 이력, 계정(ADMIN, 보강 5), 다른 화면 바로가기 | `apps/admin/src/pages/`, `apps/admin/src/apps.ts` |
| 공유 타입(보강 1) | api 응답·요청 모양·상태 값·오류 코드를 한 곳에. api가 어기면 tsc 실패(view 반환 타입, DTO implements, enum ↔ 유니온 단언), 어드민은 그 타입을 import | `packages/contracts/`, `apps/api/src/common/contract-assertions.ts`, `apps/api/test/unit/contract-drift.spec.ts` |
| 로그인·권한(보강 2) | 서버 세션(Redis)·httpOnly 쿠키, 역할 다섯과 엔드포인트 표(기본 거부, 전수 검사 테스트), 가맹점주 /me 범위, 외부 업체 키·scope, 단말기 키 | `apps/api/src/auth/`, `src/me/`, `src/admin/`, `src/partner-api/`, `apps/admin/src/session.ts`·`components/AuthGate.tsx` |
| 매장 화면(보강 3) | 점주 홈(오고 있는 단말기·진행 중 A/S·사용 중 단말기 접속·회수), 단말기 상세, 고장 접수, A/S 진행 단계·설치 확인. `/me` 점주용 응답·보이는 상태·내 매장·접수 상세 | `apps/merchant/src/`, `apps/api/src/me/` |
| 현장 화면(보강 4) | 오늘 내 작업, 박스 스캔(스캐너 입력·중복·형식 표시·scanId 멱등·줄마다 결과), 검수 대기·시리얼 찾기·체크리스트. `GET /field/today` | `apps/field/src/`, `apps/api/src/field/` |

## 실험 결과

로컬 한 PC(Windows 11, Docker Desktop의 MySQL 8.4·Redis 7.4)에서 잰 값이다. 자세한 설정·원본 출력·한계는 각 기록에.

| # | 질문 | 숫자 | 결론 |
|---|---|---|---|
| [0001](docs/experiments/0001-같은-단말기-동시-전이.md) | 같은 단말기에 전이 20건이 동시에 오면 1건만 반영되나 | 고치기 전 HTTP 200 1·409 11·500 8(데드락). 단말기 UPDATE를 이력 INSERT보다 먼저 flush한 뒤 3회 모두 200 1·409 19 | 낙관적 락으로 성공은 늘 1건. 500은 flush 순서가 만든 InnoDB S→X 데드락 → UPDATE 먼저 |
| [0002](docs/experiments/0002-같은-단말기-동시-검수.md) | 같은 단말기 동시 검수 10건 | 검수 기록 먼저: 매번 201 1·500 9. 전이 먼저: 6회 모두 201 1·409 9, 500 0 | 같은 작업 단위의 INSERT가 UPDATE보다 먼저 나가는 문제가 검수에도 → 전이 먼저(decisions/0006) |
| [0003](docs/experiments/0003-번개택배-중복-이벤트.md) | 번개택배가 30% 확률로 이벤트를 두 번 보내면 두 번 반영되나 | 응답 안 중복 81개가 왔지만 3회 모두 carrier_event 120(운송장당 4), DELIVERED 단말기당 최대 1. 약 11.2초 | 중복 반영 0. 응답 안 → 저장된 키 → unique 3단 |
| [0004](docs/experiments/0004-번개택배-429-비율별-수집.md) | 429 10/30/50%에서 수집이 끝나나 | (10/30/50%는 설정한 확률 `force429Rate`. seed 4에서 실제 429 비율은 15/135 약 11%, 35/155 약 23%, 90/210 약 43%) 모두 30/30 완료. 조회 135/155/210 = 성공 120 + 429 수. 10%·30% 약 14.6~16.1초, 50% 약 21.3~22.3초 | 429 하나가 정확히 재시도 하나. 더 부르는 수는 1/(1−p)로 늘어 50%에서 급해진다 |
| [0005](docs/experiments/0005-워커-프로세스-2개.md) | 워커 2개가 같은 큐를 나누면 같은 운송장을 동시에 보거나 알림을 두 번 보내나 | SyncRun 60/60으로 나눔, 같은 운송장 겹침 0, DELIVERED 중복 0, outbox 180 = 톡톡 수신 180·중복 키 0. limiter 초당 10에서 약 11.8초, 500에서 약 2.5초 | jobId `track-<id>`가 같은 운송장 job을 하나로. BullMQ limiter는 큐 단위라 워커를 늘려도 호출 상한은 같다 |
| [0006](docs/experiments/0006-대량-처리.md) | N+1 대 일괄, 박스 500대·엑셀 5,000행, relay addBulk | 500행 N+1 쿼리 2,503·약 2.2초 대 일괄 12·약 0.3초(차이 대부분은 행마다 flush). 박스 500대 약 0.4초, 엑셀 1,000행 0.5~0.6초·5,000행 2.2~2.7초(RSS +31~42MB). relay 1회 최대 52~103ms → 15~34ms | 일괄 엔진 한 곳. relay는 addBulk(decisions/0024) |
| [0007](docs/experiments/0007-교체-단말기-동시-요청.md) | 같은 교체 단말기를 10건이 동시에 요청하면 | Day 3: 성공 1·422 9·데드락 0, 고아 운송장 매회 9장. Day 4(Redis 예약 뒤): 고아 0, 진 9건은 REPLACEMENT_RESERVED. 서로 다른 교체 단말기 10대는 201 10 | 트랜잭션 밖 사전 확인은 동시 요청을 못 거른다 → 교체 단말기 예약(decisions/0026) |
| [0008](docs/experiments/0008-하트비트-5000대.md) | 5,000대가 5초마다(초당 1,000건) 하트비트를 보내면 | Redis 경로 30,000/30,000, 묶음 p50 12~13ms·p95 32~34ms, MySQL 쓰기는 스냅샷 30문장뿐. 하트비트마다 MySQL이면 묶음 300·단건 30,000문장, 묶음 p95 64~96ms. 오프라인 판정 10.1~15.2초 | MySQL 쓰기는 하트비트 수가 아니라 스냅샷 횟수에 비례 → Redis 경로(decisions/0027) |
| [0009](docs/experiments/0009-펌웨어-단계-배포.md) | 1,000대 단계 배포, 실패율 30%면 언제 멈추나 | 실패율 0% 9.6~9.7초에 완료. 30%면 2.08~2.12초에 1단계에서 자동 중단, 영향은 1단계 100대 전부, 끝난 뒤 남은 제안 0 | 한 단계 대상은 같은 주기에 지시를 받아 단계 안 중단은 영향을 줄이지 못한다 — 손잡이는 첫 단계 비율 |
| [0010](docs/experiments/0010-device-큐-job-시간과-project-줄서기.md) | device 큐(concurrency 1) job이 active 갱신을 얼마나 막나 | 평소 판정 약 2ms, 스냅샷 약 0.5초, 대량 끊김 판정 1.3~1.5초. 더 큰 것은 relay 줄: 대량 끊김 Outbox 5,000행 → 약 100초 | 큐는 나누지 않고 대량 접속 변화를 묶음 알림 1행으로(decisions/0029) |
| [0011](docs/experiments/0011-실행계획-단말기-10만-이력-100만.md) | 단말기 10만·이력 100만에서 F4·주간 리포트 쿼리의 실행계획 | F4 status_changed_at 인덱스 8.2·9.8ms 대 이력 서브쿼리 102·220ms. 리포트 이력 집계 전체 훑기 165~192ms, 커버링 인덱스는 합 0.2초 줄이지만 이력 대량 INSERT +99%. 중복 인덱스는 INSERT +29%·+20MB | F4는 status_changed_at(decisions/0034), 리포트 이력에는 인덱스를 더하지 않음(decisions/0036) |
| [0012](docs/experiments/0012-VAN-대조-5만-건.md) | VAN 등록 5만 건 대조, 스캔 도중 변경 | 6.8~7.2초(수집 91%, 그중 약 4.2초는 개발 환경 전송 기다림으로 추정), 쿼리 343개, 업체 호출 = 페이지 + 후보. 재검증 전 거짓 양성 6 → 재검증 뒤 0, 지나간 자리의 새 어긋남 949건은 다음 실행이 모두 찾음 | 재검증이 필요하다. 놓친 어긋남은 최대 한 주기 늦게 잡힌다(decisions/0033) |
| [0013](docs/experiments/0013-단말기-목록-API-10만-대.md) | 단말기 10만 대에서 목록 API, joined 대 select-in | 조건 없음 1쪽 p50 91.2ms → 5.2ms(약 17.5배), 모델 36.1 → 3.6ms, 가맹점 21.1 → 3.5ms, 상태 21.7 → 3.3ms. 결과가 작은 조건만 2.1 대 2.9ms. offset 끝쪽 10.3ms | 연관은 select-in, 10만 대에서는 offset 유지(decisions/0039) |
| [0014](docs/experiments/0014-워커-강제-종료와-알림.md) | 알림을 처리하던 워커를 강제 종료하면 알림이 사라지나 | 알림 300건, 2회. 처리 중 SIGKILL: 유실 0, 중복 수신 5(죽을 때 처리 중이던 job 5 = concurrency 5), 죽임 → 모두 SENT 약 61.4초(대기분은 새 워커가 약 4.0초, 나머지는 stalled 복구 대기로 추정 — BullMQ 기본값 lockDuration·stalledInterval 30초 기준, 따로 재지 않음). job 유실 흉내(`drain`): 워커만으로는 3초 동안 0건, 복구 sweep 300/300 다시 넣은 뒤 약 4.2초에 모두, 중복 0. 죽인 직후 sweep은 살아 있는 job 210개를 건드리지 않음 | 유실 0, 단 at-least-once — 처리 중이던 것은 중복될 수 있어 메신저 멱등키가 거른다(decisions/0016). 큐에서 사라진 job은 복구 sweep이 메운다(decisions/0042) |
| [0015](docs/experiments/0015-대시보드-캐시-전후.md) | 대시보드 캐시 전후 p50/p95, 동시 50개의 MySQL 쿼리 수 | 단말기 10만·이력 약 100만, 2회. 요청 하나 캐시 없음 p50 169.1·172.5ms / p95 192.9·189.5ms 대 적중 p50 0.4ms(HTTP 2.0·1.9ms). 빈 캐시에 동시 50개: 캐시만이면 SELECT 350(캐시 없음과 같음)·전체 약 1.5초, single-flight면 SELECT 7·169~190ms | 캐시만으로는 캐시가 빈 순간의 동시 미스를 못 줄인다 → TTL 30초 캐시 + 프로세스 안 single-flight(decisions/0044) |
| [0016](docs/experiments/0016-상태-조건-목록-status-id-인덱스.md) | 상태 조건 목록에 (status, id) 인덱스가 필요한가 | 드문 상태(450·50대)는 기존 `(status, status_changed_at)` 인덱스로 450·50행 + 정렬, 흔한 상태(약 1만·5천 대)는 PK 역순 175·396행에서 멈춤. 인덱스가 있어도 계획이 바뀐 것은 IN_SERVICE 하나, p50은 어느 상태든 1.7~2.9ms로 차이 없음(IN_SERVICE 2.89 → 2.84ms). 쓰기 UPDATE +6.1%·INSERT +4.1%, 인덱스 +1.46MB | 사전 기준(p50 2배 이상 그리고 1ms 이상 감소)에 해당 없음 → 채택하지 않음(decisions/0045) |
| [0017](docs/experiments/0017-인증-뒤-하트비트-처리량.md) | 단말기 키 검사(인증)를 더한 뒤 하트비트 처리량 | 기본 부하(5,000대·5초·30초) 30,000/30,000·오류 0, p50·p95 차이 없음. 단건 최대(번갈아 3라운드) 5,636 → 5,451/s(−3.3%, 사전 검증 4,023 → 3,824/s −4.9%), p50 +0.1ms. 묶음 100 최대 평균 −5.4%(라운드별 −14.4%·−2.0%·+0.9%, 사전 검증은 차이 없음) | 감소는 기준(10%) 안 — 공유 단말기 키 유지(decisions/0055). 라운드 사이 흔들림(최대 약 20%)이 차이보다 크다 |

### 설계안 7장 "실험으로 남길 숫자"와의 대응

| 설계안 7장 | 확인할 것 | 어디서 확인했나 |
|---|---|---|
| 번개택배 중복 이벤트 N건 주입 | 중복 반영 0건 | 실험 0003(30%, 3회 모두 0) |
| 429 비율 10%/30%/50% | 수집 완료율, 완료까지 걸린 시간 | 실험 0004 |
| 운영자와 배치가 같은 단말기를 동시에 변경 | 충돌 감지 건수, 잘못된 최종 상태 0건 | 실험 0001(A: HTTP 20건 → 409 19, B: 시스템 작업 직접 호출 — 낙관적 락·규칙 위반으로 실패, 최종 상태 하나) |
| 같은 박스를 두 번 스캔 | 두 번째는 처리 없이 같은 결과 반환 | 실험 기록 없음 — e2e 테스트 `apps/api/test/scan.e2e.spec.ts` "같은 scanId를 다시 보내면 처리하지 않고 저장된 결과를 200으로 준다"·"처리 중에 같은 scanId가 또 오면 409 SCAN_IN_PROGRESS"(decisions/0020) |
| 교체 출고 중 한쪽 실패 | 두 단말기·A/S 건 모두 원래대로 | 실험 기록 없음 — e2e 테스트 `apps/api/test/replacement.e2e.spec.ts` "트랜잭션 안에서 하나라도 실패하면 두 단말기·운송장·접수가 모두 그대로"(운송장은 고아로 남는다, decisions/0023). 동시 요청은 실험 0007 |
| 시뮬레이터 단말기 5,000대 하트비트 | Redis 처리량, MySQL 쓰기 횟수(직접 쓸 때와 비교) | 실험 0008 |
| 펌웨어 배포 중 실패율 상승 | 자동 중단까지 걸린 시간 | 실험 0009 |
| 워커 강제 종료 | 알림 유실 0건 | 실험 0014(+ 워커 2개 실험 0005) |
| 대시보드 캐시 전후 | p50/p95 | 실험 0015 |

## 기록

이 프로젝트의 산출물은 코드와 기록이다(규칙 `CLAUDE.md`, 양식 `docs/README.md`).

- 기록 색인(제목 목록): [`docs/index.md`](docs/index.md) — 결정 69·트러블슈팅 32·실험 17 (`node scripts/docs-index.mjs`로 만든다)
- 개발일지: [`docs/devlog/`](docs/devlog/)(날짜별, 날마다 "N일차 요약"), 설계 스펙 [`docs/specs/`](docs/specs/), 구현 계획 [`docs/plans/`](docs/plans/), 날마다의 최종 리뷰 [`docs/reviews/`](docs/reviews/)
- 7일 회고: [`docs/retrospective.md`](docs/retrospective.md) — 날별로 만든 것, 잘 된 것·안 된 것, 반복된 실수, 면접에서 말할 거리, 남은 이월과 그 뒤 보강
- 공부거리: [`docs/study/backlog.md`](docs/study/backlog.md)

## 테스트

(보강 5 통합 어드민 확장 뒤 실제로 돌려 센 값(2026-10-29). api는 실험 파일 제외 — 실험은 `EXPERIMENTS=1`에서만 돈다. 보강 4 뒤에는 api 82/568·admin 14/125, 보강 3 뒤에는 api 80/561·merchant 7/47, 보강 2 뒤에는 api 79/549, 보강 1 뒤에는 api 66/453, admin 12/109, device-sim 4/40이었다)

| 앱 | 파일 | 테스트 |
|---|---|---|
| api(실험 제외) | 83 | 571 |
| admin | 19 | 163 |
| merchant | 7 | 47 |
| field | 7 | 60 |
| partners | 6 | 53 |
| device-sim | 5 | 46 |
