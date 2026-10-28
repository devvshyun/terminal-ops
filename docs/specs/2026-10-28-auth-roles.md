# 보강 2 설계 — 로그인·역할·가맹점 범위·외부 업체 키·단말기 키

- 날짜: 2026-10-28
- 범위: 보강 2. 사람 로그인(계정·비밀번호 해시·서버 세션), 역할 다섯 개와 엔드포인트별 허용 표(기본 거부), 가맹점주 범위 제한, 외부 업체 API 키, 단말기 키, `X-Operator` 헤더 이전, 어드민 로그인 화면. 통합 시연(매장·현장·관제·개발자센터 화면)의 기반이다.
- 구현 계획: `docs/plans/2026-10-28-auth-roles.md`
- 브랜치: `auth-roles`(master 7487fe4에서)
- 등장하는 회사·가맹점·외부 업체는 모두 가상이다. 비밀번호·키는 모두 로컬 시연 전용 테스트 값이다.

## 1. 무엇을 왜

지금은 decisions/0001대로 인증이 없다. 쓰기 API 22곳이 `@Operator()`로 `X-Operator` 헤더의 이름을 그대로 믿어 이력의 작업자로 남기고, 읽기·단말기 API는 아무나 부를 수 있다. 0001의 "다시 볼 조건"(역할별 권한)이 왔다 — 앞으로 만들 화면(가맹점주, 현장 작업자, 관제, 외부 연동 개발자센터)은 사람마다 볼 수 있는 것과 할 수 있는 것이 다르다.

목표:

1. 사람은 아이디·비밀번호로 로그인하고, 서버가 누구인지 안다. 이력의 작업자는 그 사람의 로그인 아이디다(헤더를 믿지 않는다).
2. 역할(ADMIN·OPERATOR·MONITOR·FIELD·MERCHANT)마다 부를 수 있는 엔드포인트가 표로 정해져 있고, 표에 없는 것은 막힌다(기본 거부). 새 엔드포인트가 규칙 없이 생기면 테스트가 실패한다.
3. 가맹점주는 자기 가맹점 데이터만 본다 — 남의 단말기는 있는지도 모른다(404).
4. 외부 업체는 사람 세션이 아니라 업체별 API 키로, 키에 허락된 범위(scope)만 읽는다.
5. 단말기(시뮬레이터)는 단말기 키로 부른다. 실험 0008(5,000대)의 처리량을 깨지 않는다.
6. 기존 api 테스트 453개는 최소 수정으로 계속 통과한다.

## 2. 구성

```
apps/api/src/
├─ auth/            role.ts(Role enum), user-account.entity.ts, password.ts(scrypt)
│                   session.store.ts(Redis 세션), auth.service.ts(로그인·실패 제한), auth.controller.ts(/auth/login·logout·me)
│                   access.ts(@Public·@Roles·@DeviceAuth·@PartnerAuth, 역할 묶음), auth.guard.ts(APP_GUARD, 기본 거부)
│                   principal.ts(요청한 사람, @CurrentPrincipal), cookies.ts
│                   account.service.ts(계정 관리), partner-key.entity.ts·partner-key.service.ts(외부 업체 키)
├─ me/              /me/...(가맹점주 전용 — 단말기 목록·상세, A/S 접수·목록·설치 확인)
├─ merchant/merchant-scope.ts   MerchantScope(서비스에 넘기는 범위), 범위 밖 404
├─ admin/           /admin/accounts, /admin/partner-keys(ADMIN만)
├─ partner-api/     /partner/v1/...(외부 업체 키, scope별)
├─ common/operator.decorator.ts  @Operator() = 로그인 아이디(헤더를 읽지 않음)
├─ config/auth-test-headers.ts   테스트 전용 인증 헤더 스위치(NODE_ENV=test에서만)
└─ db/seed-accounts.ts           시연 계정 7개·시연 외부 업체 키(테스트 값)
packages/contracts/src/auth.ts   Role, LoginRequest, MeView, AccountView, PartnerKeyView … + 오류 코드 AuthErrorCode
apps/admin/src/      session.ts(내 정보 저장소), components/AuthGate·UserBar, pages/LoginPage, nav.ts(역할별 메뉴)
apps/device-sim/src/ config.ts(deviceKey), client.ts(X-Device-Key)
```

새 테이블: `user_account`(로그인 아이디 unique, 역할 enum, 가맹점 FK nullable, 사용 중지·마지막 로그인 시각), `partner_api_key`(이름, 접두사 unique, 키 SHA-256, scopes JSON, 만료·폐기·마지막 사용 시각). Redis 키: `<접두사>:sess:<토큰 SHA-256>`, `<접두사>:sess-of:<계정 id>`, `<접두사>:login-fail:<아이디>`.

## 3. 결정

번호는 브리프 순서로 미리 정했다(Task 순서와 쓰는 순서가 다를 수 있다).

| 번호 | 무엇 | 고른 것 | Task |
|---|---|---|---|
| 0050 | 세션 방식 | 서버 세션(Redis) + httpOnly·SameSite=Strict 쿠키. JWT는 로그아웃·강제 만료·역할 변경을 바로 반영하려면 결국 서버 상태가 필요 | 2 |
| 0051 | 비밀번호 해시·계정 테이블 | node:crypto scrypt(N=2^15, r=8, p=3), 의존성 0. `user_account` | 1 |
| 0052 | 역할과 엔드포인트 표 | 핸들러마다 `@Roles`/`@Public`/`@DeviceAuth`/`@PartnerAuth`, 없으면 403. 표 전체를 단위 테스트가 실제 메타데이터와 대조 | 2 |
| 0053 | 가맹점 범위 | `/me/...` 전용 엔드포인트 + 서비스의 `scope` 인자. 범위 밖 404 | 4 |
| 0054 | 외부 업체 키 | SHA-256 저장·접두사 평문, Bearer 또는 X-Api-Key, scope 2개, 호출 로그는 Bundle 7 | 5 |
| 0055 | 단말기 인증 | 공유 단말기 키 `X-Device-Key`(env). 단말기별 비밀은 시뮬레이터 묶음 구조와 맞지 않음. 실험 0017 | 3 |
| 0056 | `X-Operator` 이전과 테스트 전략 | actor = 로그인 아이디. 헤더는 테스트 전용 인증 길(`AUTH_TEST_HEADERS=1`, NODE_ENV=test에서만)로만 남김 | 2 |

decisions/0001은 "대체됨 → 0050"으로 표시한다.

### 3.1 역할 표(요약 — 전체는 decisions/0052)

| 묶음 | 역할 | 엔드포인트 |
|---|---|---|
| 공개 | — | `GET /health`, `POST /auth/login` |
| 누구나 | 5개 모두 | `GET /auth/me`, `POST /auth/logout` |
| STAFF 조회 | ADMIN·OPERATOR·MONITOR·FIELD | 단말기 목록·상세·이력·검수 기록, 모델, 검수 항목, 발주 목록·상세, 스캔 결과 |
| OFFICE 조회 | ADMIN·OPERATOR·MONITOR | 그 밖의 조회 전부(대시보드, 리포트, A/S, 배포, 이상, VAN, 접속 상태, 가맹점 …) |
| 관제 작업 | OPERATOR·MONITOR | 이상 찾기, VAN 대조 시작, 주간 리포트 보내기 |
| 현장 작업 | OPERATOR·FIELD | 박스 스캔, 검수 |
| 업무 쓰기 | OPERATOR | 나머지 쓰기 전부(등록·전이·배정·출고·발주·A/S·펌웨어) |
| 가맹점 | MERCHANT | `/me/...` 다섯 개 |
| 관리 | ADMIN | `/admin/accounts`, `/admin/partner-keys` |
| 단말기 | 단말기 키 | `POST /devices/heartbeats`, `POST /devices/firmware-reports` |
| 외부 업체 | 키 + scope | `GET /partner/v1/terminals/:serialNo`, `GET /partner/v1/merchants/:code/terminals` |

ADMIN은 업무 데이터를 읽기만 한다(계정·키 관리 역할과 업무 쓰기를 나눈다).

## 4. 어드민

로그인 화면(`/login`), 위쪽에 표시 이름·아이디·역할과 로그아웃(`OperatorBar`·`operator.ts` 삭제), 역할에 맞는 메뉴만, 쓰기 버튼은 역할이 아니면 숨김(서버가 최종 판단 — 403이면 "권한이 없습니다" 안내), 어떤 요청이든 401이면 로그인 화면으로(돌아올 주소 기억). 현장 작업자의 처음 화면은 박스 스캔, 가맹점주는 안내와 로그아웃만(가맹점 화면은 Bundle 3). 세션 토큰은 화면 JS가 읽지 못한다(httpOnly) — 화면은 `GET /auth/me` 결과만 기억한다.

## 5. 검증

- api: 단위(비밀번호 해시, 테스트 헤더 스위치·쿠키, 접근 표 전수 대조) + e2e(로그인·세션·역할, 단말기 키, 가맹점 범위, 계정 관리, 외부 업체 키). 기존 테스트는 테스트 도우미가 기본 사람(`tester`, OPERATOR)과 단말기 키를 붙여 그대로 돈다 — 고친 곳은 "작업자 헤더 없으면 400"을 확인하던 다섯 줄(→ 401)뿐.
- 숫자(사전 검증에서 실제로 돌려 셈): api 66/453 → 75/512, admin 12/109 → 12/111, device-sim 4/40 → 5/43, partners 6/53 그대로.
- 실서버(테스트 DB, 포트 3100): 로그인 → 쿠키 → 보호된 호출 200 → 역할 밖 403 → 가맹점 범위(남의 단말기 404) → 로그아웃 뒤 401 → 단말기 키·외부 업체 키를 curl로.
- 실험 0017: 하트비트 처리량을 인증 전후로 번갈아 잼(단건 최대 처리량 −4.9%, 묶음 100은 차이 없음).

## 6. 위험과 대가

- 테스트와 운영의 인증 길이 다르다: 기존 테스트는 테스트 전용 헤더로 사람을 정한다. 실제 쿠키 길은 새 e2e(로그인·역할·가맹점·계정·키)가 덮는다. 스위치는 NODE_ENV=test가 아니면 켤 수 없다(켜려 하면 서버가 뜨지 않음).
- 세션에 역할을 넣어 요청마다 MySQL을 읽지 않는다 — 역할을 바꾸면 그 계정의 세션을 모두 끊어 다시 로그인하게 한다(계정 API가 한다). 계정 행을 직접 고치면 세션은 그대로다.
- 아이디별 로그인 실패 제한은 남이 일부러 틀려 그 계정을 15분 잠글 수 있다(IP별 제한 없음).
- 단말기 키는 하나라 새면 모든 단말기를 사칭할 수 있고 단말기별로 막을 수 없다.
- CSRF는 SameSite=Strict에만 기댄다(CSRF 토큰 없음). localhost의 다른 포트는 같은 사이트로 본다 — 로컬 시연 범위에서 받아들인다.
- HTTPS가 아니다(쿠키 Secure는 env로 켬). 비밀번호·키는 저장소에 공개된 테스트 값이다.
- 테스트 DB를 다른 브랜치와 같이 쓰면 master 쪽 `schema.refresh`가 `merchant`를 지우지 못한다(새 FK) — 테스트 DB를 다시 만든다(troubleshooting/0030).
