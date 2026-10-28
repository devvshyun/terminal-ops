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
