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
  - **로그인 아이디 규칙은 로그인과 같다**: `^[A-Za-z0-9._-]{3,50}$`(`LOGIN_ID_INPUT` 공유)만 받고 소문자로 저장한다. 처음 계획은 소문자만 받았는데, 로그인(0050)이 대문자를 받아 소문자로 접는 규칙으로 바뀌어 "대문자를 받아 소문자로 저장"이 일관된다(대소문자만 다른 아이디는 collation이 같게 보므로 409 `DUPLICATE`). ASCII 밖(악센트·전각)·공백은 400.
  - **마지막 활성 ADMIN 보호**(계획에 없던 것, 409 `LAST_ADMIN`): 활성 ADMIN을 사용 중지하거나 다른 역할로 바꾸려는데 그 사람 말고 활성 ADMIN이 없으면 막는다. 버린 선택지: (a) 막지 않고 "시드나 SQL로 되살린다"(처음 계획의 대가 항목) — 실수 한 번에 계정·키 관리 길이 막히고, 되살리려면 DB 접근이 필요하다. (b) 자기 자신만 막기 — 둘이 서로를 내리면 둘 다 없어진다. 동시 요청을 위해 트랜잭션 안에서 활성 ADMIN 행을 id 순으로 `SELECT … FOR UPDATE`로 잠그고, 잠근 뒤 대상 행을 다시 읽어 판단한다(잠금을 빼면 e2e에서 둘 다 200이 된다 — `expected [ 200, 200 ] to deeply equal [ 200, 409 ]`). 이미 사용 중지된 ADMIN을 내리는 것, 마지막이 아닌 ADMIN을 내리는 것, 표시 이름만 바꾸는 것은 막지 않는다. 계약 `ConflictCode`에 `LAST_ADMIN`을 더했다.
  - 세션 끊기는 DB 커밋 뒤에(0050 "`destroyAllFor`는 반드시 DB 커밋 뒤에").
- 결과·대가: 호출 한도(rate limit)·IP 허용 목록·키 회전 자동화는 없다. 시연 키가 저장소에 공개돼 있다(로컬 시연 전용). ADMIN 계정을 SQL로 직접 지우거나 시드를 안 돌린 빈 DB에서는 첫 ADMIN이 없다(시드가 `admin`을 만든다). 마지막 활성 ADMIN 보호는 API 경로만 막는다.
- 다시 볼 조건: 외부 업체가 실제로 붙을 때(호출 로그·한도·IP 제한·가맹점 제한), 키가 수천 개가 되어 목록이 커질 때(페이지).
