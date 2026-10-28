# 보강 3 설계 — 매장(가맹점주) 화면

- 날짜: 2026-10-28
- 범위: 보강 3. 가맹점주(점주)가 휴대폰으로 쓰는 매장 화면 `apps/merchant`와, 그 화면에 필요한 `/me` API 보강. 통합 시연 준비의 두 번째 묶음이다(보강 2가 로그인·`/me` 범위를 만들었다).
- 구현 계획: `docs/plans/2026-10-28-merchant-portal.md`
- 브랜치: `merchant-portal`(master 75c4ba7에서)
- 등장하는 회사·가맹점·택배사는 모두 가상이다. 시연 계정의 비밀번호는 `apps/api/src/db/seed-accounts.ts`의 로컬 시연 전용 값이고 이 문서에 적지 않는다.

## 1. 무엇을 왜

보강 2로 MERCHANT 로그인과 `/me` API(단말기 목록·상세, A/S 목록·접수·설치 확인, 범위 밖 404 — decisions/0053)가 생겼지만, 가맹점주가 로그인하면 어드민은 안내와 로그아웃만 보여 준다. 점주가 실제로 묻는 것은 세 가지다.

1. 우리 가게 단말기는 지금 쓸 수 있나(사용 중인가, 연결돼 있나, 마지막 접속은 언제인가)
2. 오고 있는 단말기(새로 받는 것, A/S 교체품)는 지금 어디쯤인가(운송장, 택배 단계)
3. 고장 나면 어떻게 접수하고, 접수한 건은 어디까지 왔나(접수 → 원격 점검 → 교체 출고 → 배송 중 → 설치 확인 → 완료), 내가 할 일(설치 확인, 고장 단말기 회수 준비)은 무엇인가

목표:

1. 점주 전용 화면이 휴대폰 폭에서 그대로 쓰인다(누르는 것 44px 이상, 글자 16px, 아래 탭).
2. 점주에게 보이는 말은 운영자 용어가 아니다(RETURN_REQUESTED → "회수 준비 중"). 이름표는 contracts의 상태 유니온에 묶인 `Record`라 상태가 늘면 tsc가 알려 준다.
3. 화면에 필요한 데이터는 `/me` 범위 규칙(기본 거부, 범위 밖 404) 안에서만 나온다. 직원 아이디·내부 메모·이력의 사유처럼 점주에게 필요 없거나 내부용인 값은 응답에 없다.
4. 회수가 끝나 본사로 돌아간 단말기는 옛 가맹점에 보이지 않는다(사전 검증에서 지금은 보인다는 것을 확인했다).
5. 기존 테스트(api 549, admin 125, device-sim 46, partners 53)는 한 줄(`me.e2e`의 상세 응답 단언)만 바꾸고 그대로 통과한다.

## 2. 구성

```
apps/merchant/                 새 앱(React 19 + Vite 8 + TanStack Query 5 + react-router 8 — 어드민과 같은 lock)
├─ vite.config.ts              개발 서버 5174·미리보기 4174, /api → MERCHANT_API_URL(기본 :3000) 프록시
├─ src/api/client.ts           api()·ApiError(어드민 사본, decisions/0058), queries.ts(조회 훅), query-keys.ts('me' 묶음)
├─ src/session.ts, hooks/useSessionCheck.ts, components/SessionCacheSync.tsx   어드민 사본
├─ src/components/             AuthGate(MERCHANT만), Shell(매장 이름·로그아웃·아래 탭), ErrorBox(점주 문구), StepList, TerminalBits
├─ src/lib/                    format.ts(KST), labels.ts(점주 이름표), steps.ts(A/S·택배 단계), symptom.ts(증상 + 메모)
└─ src/pages/                  Login, Home, TerminalDetail, ServiceTickets, NewTicket, ServiceTicketDetail
apps/api/src/
├─ me/me.service.ts, me.views.ts   점주용 단말기 묶음(접속·운송장·이번 배정부터의 이력)
├─ me/me.controller.ts, me.dto.ts  GET /me/merchant, GET /me/service-tickets/:id, serialNo 조건, 상태 조건 제한
├─ merchant/merchant-scope.ts      MERCHANT_VISIBLE_STATUSES(배정 ~ 회수 완료)
├─ terminal/terminal.service.ts    scope면 보이는 상태만(목록·상세)
├─ device/connectivity.service.ts  getMany(여러 대 접속 한 번에), get은 getMany를 쓴다
└─ service/service-ticket.views.ts MerchantTicketView에 remoteChecked·replacementStatus
packages/contracts/src/merchant.ts MerchantTerminalView·Page·Detail·Event, MerchantConnectivity, MerchantShipmentView
packages/contracts/src/statuses.ts CarrierEventCode
```

## 3. API 변화(`/me`, 모두 MERCHANT만 — decisions/0052 표)

| 엔드포인트 | 변화 | 응답 |
|---|---|---|
| `GET /me/merchant` | 새로 | `MerchantView`(code·name·address) |
| `GET /me/terminals` | 응답 모양을 점주용으로, 보이는 상태만, `status`는 보이는 상태만(그 밖 400) | `MerchantTerminalPage` |
| `GET /me/terminals/:serialNo` | 점주용 상세 + 이번 배정부터의 상태 변화, 보이지 않는 상태면 404 | `MerchantTerminalDetail` |
| `GET /me/service-tickets` | `serialNo` 조건 | `BeforeIdPage<MerchantTicketView>` |
| `GET /me/service-tickets/:id` | 새로(남의 것 404) | `MerchantTicketView` |
| `POST /me/service-tickets`, `POST /me/service-tickets/:id/installations` | 응답에 `remoteChecked`·`replacementStatus`가 더해짐 | `MerchantTicketView` |

- `MerchantTerminalView`: serialNo, modelCode, modelName, status, statusChangedAt, `connectivity`(운영 중만 — online, lastSeenAt, firmwareVersion), `shipment`(배송 중·배송 완료만 — carrier, trackingNo, status, createdAt, deliveredAt, ticketId, events[code, occurredAt]). version·가맹점 코드·접속 출처는 없다.
- 상세 `events`: 마지막 ALLOCATED부터의 {status, occurredAt}(actor·reason 없음, 보이는 상태만).
- 엔드포인트 수 68 → 70(접근 표 테스트가 센다).

## 4. 화면

| 경로 | 내용 |
|---|---|
| `/login` | 아이디·비밀번호. 직원 계정이면 로그인 뒤 "가맹점 계정용" 안내와 로그아웃만 |
| `/` 홈 | 오고 있는 단말기(배송 단계·교체 A/S 번호) → 진행 중 A/S(지금 단계) → 사용 중 단말기(연결·마지막 접속·펌웨어) → 회수(점주가 할 일) |
| `/terminals/:serialNo` | 상태, 연결(끊기면 점검 안내), 배송 단계, 회수 안내, 고장 접수 링크(사용 중 + 열린 A/S 없음), 이 단말기의 A/S, 지난 일(최근 것 위) |
| `/service-tickets` | 최근 50건, 진행 중이면 지금 단계, 위에 고장 접수 |
| `/service-tickets/new?serialNo=` | 사용 중 단말기 고르기, 증상 여섯 중 하나 + 메모 → `"증상: 메모"` |
| `/service-tickets/:id` | 진행 단계, 교체 단말기, 설치 확인(교체 단말기 도착 때만, 한 번 더 묻는다) |

## 5. 결정(계획의 Task가 쓴다)

- 0057 점주 화면은 별도 앱 `apps/merchant`(어드민 안 경로가 아니라) — 사용자·기기·CSS·메뉴가 다르다. 판은 어드민 lock 그대로
- 0058 공통 코드는 공유 패키지가 아니라 복사 — 사전 검증: `file:` + TS 소스는 순수 함수만 설정 없이 되고, React·contracts를 import하는 모듈은 앱마다 `resolve.dedupe`·tsconfig `paths`가 필요했다
- 0059 `/me` 보강은 점주용 응답 모양과 "점주에게 보이는 상태"(배정 ~ 회수 완료)
- 0060 점주 문구·A/S·택배 단계는 화면이 상태 값에서 만든다(이름표 `Record`, 순수 함수 + 테스트)
- 0052 표·0053·0047 보탬

## 6. 범위 밖

- 점주 알림(문자·톡), 푸시, 오프라인(PWA)
- 회수 택배(반품 운송장) — 지금 회수는 상태 전이만 있다
- 회수 뒤 `terminal.merchant`를 비우는 규칙 — 화면에서만 가린다(decisions/0059)
- 점주 계정 관리·비밀번호 바꾸기(Bundle 7), 운영 배포(정적 파일 + 역프록시)
- 브라우저 자동 테스트 — 휴대폰 폭 확인은 컨트롤러가 내장 브라우저 크기 바꾸기로 본다

## 7. 테스트

- api e2e `me-portal.e2e.spec.ts`(9): 내 매장, 점주용 모양, 접속(Redis·스냅샷·없음·운영 중 아님), 배송 이벤트 순서, 교체 접수 번호·원격 점검·교체 상태·접수 상세 범위, serialNo 조건, 이번 배정부터의 이력, 회수 뒤 본사로 돌아간 단말기 숨김·재배정, 보이지 않는 상태 조건 400. 접근 표 +2줄
- merchant Vitest + Testing Library(가짜 fetch): 로그인 문·화면 틀(5), api 클라이언트(3), KST(3), 단계(7), 홈·단말기 상세(6), A/S(8)
- 실서버: 테스트 DB로 띄운 api와 점주 개발 서버 프록시로 로그인 → `/me` curl(계획 Task 5)
