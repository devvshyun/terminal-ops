# 보강 4 설계 — 현장 작업자 화면

- 날짜: 2026-10-28
- 범위: 보강 4. 창고·물류 현장 작업자(FIELD)가 휴대폰·PDA로 쓰는 화면 `apps/field`와, 그 화면에 필요한 API 한 개(`GET /field/today`). 통합 시연 준비의 세 번째 묶음이다(보강 2가 로그인·역할 표를, 보강 3이 점주 앱과 공통 코드 복사 규칙을 만들었다).
- 구현 계획: `docs/plans/2026-10-28-field-worker.md`
- 브랜치: `field-worker`(master 37df12a에서)
- 등장하는 회사·가맹점·제조사는 모두 가상이다. 시연 계정의 비밀번호는 `apps/api/src/db/seed-accounts.ts`의 로컬 시연 전용 값이고 이 문서에 적지 않는다.

## 1. 무엇을 왜

지금 현장 작업자는 운영자 어드민 안에서 박스 스캔(`/scan`)과 단말기 상세의 검수 폼을 쓴다. 메뉴는 "단말기, 박스 스캔"만 보인다(보강 2). 어드민은 넓은 표·사이드 메뉴·작은 버튼이라 창고에서 한 손에 단말기, 다른 손에 휴대폰(또는 PDA)을 든 사람이 쓰기 어렵다. 현장 작업자가 실제로 하는 일은 세 가지다.

1. 박스를 받는다 — 발주분 입고(RECEIVE, 열린 발주 고르기) 또는 회수 입고(RETURN_IN). 바코드 스캐너로 시리얼을 하나씩 찍고, 다 찍으면 박스째 보낸다. 응답을 못 받으면 같은 박스를 다시 보낸다(decisions/0020 멱등)
2. 검수한다 — 검수 대기(RECEIVED·RETURNED) 단말기를 하나 들고 시리얼을 찍어 찾고, 모델 체크리스트를 항목마다 합격/불합격(+ 메모)으로 저장한다
3. 오늘 얼마나 했는지 본다 — 박스 수, 입고·회수 입고 대수, 검수 수

목표:

1. 휴대폰 폭(375px)에서 한 손으로 쓴다: 누르는 것 48px 이상, 자주 누르는 큰 버튼 56~64px, 아래 탭 셋(홈·박스 스캔·검수), 글자 16px.
2. 바코드 스캐너는 키보드 웨지(글자를 치고 Enter)로 받는다. 입력칸에 처음부터 초점이 있고, Enter마다 목록에 쌓이고 입력칸이 비고 초점이 남는다. 중복·형식 오류는 그 줄에 바로 보인다. 손 입력·붙여 넣기도 같은 칸이다.
3. 박스 스캔의 멱등 규칙은 어드민 ScanPage와 같다(scanId 유지·다시 보내기·보낸 박스 잠금·결과 못 받은 박스를 버릴 때 확인).
4. 검수는 기존 API·전이 규칙 그대로. 검수할 수 있는지는 서버가 전이 표에서 계산한 `actions.inspect`로 본다(decisions/0040).
5. 서버에 새로 여는 것은 "오늘 내 작업" 하나다. 검수 대기 목록·단말기 찾기·발주 목록은 기존 STAFF API를 쓴다.
6. 공통 코드 세 벌째(어드민·점주·현장)에서 decisions/0058을 다시 본다 — 공유 패키지를 두 앱에 실제로 붙여 보고 복사 + 사본 검사 테스트와 비교해 정한다.
7. 기존 테스트(api 561, admin 125, merchant 47, device-sim 46, partners 53)는 고치지 않는다(접근 표에 한 줄 더하는 것만).

## 2. 구성

```
apps/field/                    새 앱(React 19 + Vite 8 + TanStack Query 5 + react-router 8 — 점주 앱 lock 복사 = 어드민과 같은 판)
├─ vite.config.ts              개발 서버 5175·미리보기 4175, /api → FIELD_API_URL(기본 :3000) 프록시
├─ src/api/client.ts, session.ts, query-client.ts, lib/format.ts, components/SessionCacheSync·LogoutButton, hooks/useSessionCheck, test/setup.ts
│                              점주 앱 사본 8개 — src/copies.test.ts가 주석을 뺀 코드가 같은지 본다(decisions/0062)
├─ src/api/queries.ts·query-keys.ts   오늘 요약·열린 발주·검수 대기·단말기·검수 항목('field' 묶음)
├─ src/components/             AuthGate(FIELD만), Shell(이름·로그아웃·아래 탭 셋), ErrorBox(현장 문구)
├─ src/lib/scan.ts             시리얼 나누기·줄 문제(중복·형식)·다시 보내기 판정·행 결과 문구
├─ src/lib/labels.ts           단말기 상태 이름(사내 말), 검수 대기 상태
└─ src/pages/                  Login, Home(오늘 내 작업), Scan, InspectionQueue, Inspect
apps/api/src/
├─ field/field.controller.ts·service.ts·module.ts   GET /field/today(FIELD)
└─ common/kst.ts               kstDayOf(KST 하루 경계)
packages/contracts/src/field.ts FieldTodayView
```

## 3. API 변화

| 엔드포인트 | 변화 | 응답 |
|---|---|---|
| `GET /field/today` | 새로(FIELD만) | `FieldTodayView` — date(KST), scans{boxes, received, returned, rejected}, inspections{total, passed, failed} |
| `POST /scans`, `POST /terminals/:serialNo/inspections` | 그대로(OPERATOR·FIELD) | |
| `GET /terminals?status=RECEIVED·RETURNED&size=100`, `GET /terminals/:serialNo`, `GET /inspection-items`, `GET /purchase-orders?status=` | 그대로(STAFF) — 현장 화면이 읽는다 | |

- "오늘" = KST 0시부터 다음 0시 전, "나" = 로그인 아이디(actor, decisions/0056). 박스는 `scan_batch` 행 수(같은 scanId 다시 보내기는 한 번), 단말기 수는 그 박스들의 행 결과(CREATED·RETURNED·그 밖), 검수는 `inspection` 행 수.
- 엔드포인트 수 70 → 71(접근 표 테스트가 센다).

## 4. 화면

| 경로 | 내용 |
|---|---|
| `/login` | 아이디·비밀번호. FIELD가 아니면 로그인 뒤 "현장 작업자 계정용" 안내와 로그아웃만 |
| `/` 홈 | 오늘 내 작업(박스·입고·회수 입고·검수, 합격·불합격·거절 행), 큰 버튼 둘(박스 스캔·검수) |
| `/scan` | 발주분 입고 / 회수 입고 고르기, 열린 발주 고르기, 시리얼 입력칸(스캐너·손 입력·붙여 넣기), 쌓이는 목록(중복·형식 오류·빼기), 보내기 / 같은 박스 다시 보내기 / 새 박스, 줄마다 결과 |
| `/inspections` | 시리얼 스캔으로 찾기(바로 검수 화면으로), 검수 대기 목록(새 입고·회수 입고, 오래 기다린 것부터) |
| `/inspections/:serialNo` | 모델·상태, 항목마다 합격/불합격(처음엔 비어 있음, 모두 합격 버튼), 불합격이면 메모, 저장 → 결과(합격/불량)·다음 단말기 |

## 5. 결정(계획의 Task가 쓴다)

- 0061 현장 화면은 별도 앱 `apps/field`(어드민 FIELD 화면 개선이 아니라) — 기기·사용 자세·입력 장치·메뉴가 다르다. FIELD만. 판은 점주 앱 lock 그대로
- 0062 세 벌째 공통 코드는 복사 유지 + 사본 검사 테스트 — 사전 검증: 공유 패키지(`file:` + TS 소스)를 점주·현장 두 앱에 붙이면 앱마다 `resolve.dedupe` + tsconfig `paths` 넷 + lock 9줄 + 다시 내보내기 파일 여섯이 필요했고(그러면 tsc·vitest·build 통과), 어드민 사본은 모양이 달라 어차피 남는다
- 0063 현장 API는 "오늘 내 작업" 하나만 — 검수 대기는 기존 `/terminals?status=` 두 번, 단말기 찾기는 `/terminals/:serialNo`의 `actions.inspect`
- 0064 스캐너 입력은 키보드 웨지(입력칸 + Enter = 폼 제출), 여러 줄 붙여 넣기는 바로 목록으로, 카메라(BarcodeDetector)는 시연 브라우저에서 없어서 생략 — 검수는 항목마다 고르기(처음 비어 있음)
- 0052 표 보탬(70 → 71), 0058 보탬(다시 볼 조건 도달 → 0062)

## 6. 범위 밖

- 카메라 바코드(BarcodeDetector·외부 라이브러리) — 0064
- 오프라인(PWA)·스캐너 장치 설정(접미사 Tab 등) — Enter로 끝나는 스캐너만 가정
- 회수 단말기 받기 전용 화면 — 박스 스캔의 회수 입고로 충분하다(브리프 허용)
- 어드민의 FIELD 화면 정리 — 그대로 둔다(현장 작업자는 둘 다 쓸 수 있다)
- 브라우저 자동 테스트 — 휴대폰 폭은 컨트롤러가 내장 브라우저 375×812로 본다

## 7. 테스트

- api: `test/field.e2e.spec.ts`(4) — 빈 날, 오늘 내 일만(다시 보내기 한 번·남의 일·어제 일 빠짐), 역할(운영자·점주 403, 로그인 없음 401), 현장 화면이 쓰는 STAFF 조회. `test/unit/kst-day.spec.ts`(2). 접근 표 +1줄
- field Vitest + Testing Library(가짜 fetch): 로그인 문·화면 틀·오늘 요약·사용자 전환(7), 사본 검사(9), 쿼리 키(2), 스캔 규칙(4), 박스 스캔 — 키보드 웨지(`userEvent.keyboard('SN-0001{Enter}')`)·붙여 넣기·멱등(10), 검수 대기·검수(7)
- 실서버: 테스트 DB로 띄운 api와 현장 개발 서버 프록시로 로그인 → 오늘 → 스캔(다시 보내기) → 검수 → 오늘(계획 Task 5)
