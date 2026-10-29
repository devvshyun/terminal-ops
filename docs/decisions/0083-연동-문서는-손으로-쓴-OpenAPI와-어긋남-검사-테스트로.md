# 0083. 연동 문서는 손으로 쓴 OpenAPI와 어긋남 검사 테스트로

- 날짜 / 관련 기능: 2026-10-29 / 보강 7, 외부 연동(decisions/0054)
- 상황: 외부 업체가 키를 받기 전에 읽을 문서가 필요하다. 외부용 경로는 둘(`GET /partner/v1/terminals/:serialNo`, `GET /partner/v1/merchants/:merchantCode/terminals`), 응답 모양은 contracts의 TypeScript 인터페이스(`PartnerTerminalView`, `OffsetPage`)가 정한다 — 런타임에 남는 타입 정보가 없다(decisions/0047).
- 선택지:
  1. `@nestjs/swagger`로 자동 생성 — 응답 모양을 알려면 DTO 클래스에 `@ApiProperty`를 달아야 한다. contracts는 인터페이스라 같은 모양을 클래스로 한 벌 더 쓰게 되고(두 벌), 그 클래스가 contracts와 같은지는 또 따로 지켜야 한다. CLI 플러그인은 swc 빌드(0029)와 따로 설정해야 한다. 의존성 하나와 데코레이터가 사내 API에도 퍼질 수 있다
  2. **손으로 쓴 OpenAPI 3.1 객체 + 어긋남 테스트** — `apps/api/src/partner-api/openapi.ts` 한 파일. 테스트가 (a) 컨트롤러 라우트 메타데이터(경로·메서드·`@PartnerAuth` scope)와 문서 `paths`·`x-scope`가 같은지, (b) 실제 응답의 키가 문서 schema의 properties·required와 같은지, (c) 상태 enum이 api `TerminalStatus`와 같은지 본다
  3. 문서 없이 README의 curl 예만 — 외부 업체가 읽을 응답 필드·오류 표가 없다
- 결정: 2. `GET /partner/v1/openapi.json`(로그인·키 없이, 접근 표 `public`)으로 내놓고 개발자센터 문서 화면이 이것을 그린다. 문서를 내놓는 핸들러는 `PartnerDocsController`로 따로 둔다(비교 대상인 `PartnerApiController`에 섞지 않게). 보안 방식 두 개(Bearer, `X-Api-Key`), 오류는 `Error` schema 하나와 400·401·403·404 응답.
- 확인한 것: 테스트가 실제 어긋남을 하나 찾았다 — 404·400 본문에 Nest가 붙이는 `error`("Not Found")가 문서에 없었다(`{"message":"단말기 NOPE이(가) 없습니다.","error":"Not Found","statusCode":404}: expected false to be true`). 문서에 더했다. 문서의 `x-scope` 하나를 일부러 바꾸면 단위 테스트가 실패하는 것을 확인했다(`Tests  1 failed | 2 passed (3)`, 되돌리면 통과).
- 결과·대가: 쿼리 매개변수(page·size 범위)·설명 글은 테스트가 보지 않는다 — DTO(`PartnerPageQuery`)를 바꾸면 문서를 손으로 고쳐야 한다. 응답 값의 타입(문자열·정수)은 보지 않고 키 이름만 본다. 외부용 경로가 열 개쯤 되면 손으로 쓰는 비용이 커진다.
- 다시 볼 조건: 외부용 경로가 늘거나 요청 본문(POST)이 생길 때(1로, contracts를 클래스로 바꿀지와 함께), 외부 업체가 SDK 생성을 원할 때(문서 정확도 검사를 schema 검증기로).
