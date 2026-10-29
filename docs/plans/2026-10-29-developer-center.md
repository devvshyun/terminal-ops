# 보강 7 구현 계획 — 외부 연동 개발자센터

- 스펙: `docs/specs/2026-10-29-developer-center.md`
- 방식: Task마다 테스트를 먼저 쓰고 실패 출력을 devlog에 남긴 뒤 구현한다. Task가 끝나면 스스로 검토하고, 고칠 것은 다음 Task 첫 커밋에 넣는다.
- api 테스트는 테스트 DB `terminal_ops_test`만 쓰고 한 번에 하나만 돌린다.

## Task 1. 업체 표와 키의 업체 연결 (api·contracts)
- contracts `auth.ts`에 다음을 둔다.
  - 새 타입: `PartnerView`, `CreatePartnerRequest`, `PartnerCallView`
  - `PartnerKeyView`에 `partnerId`·`partnerCode`·`partnerName`
  - `CreatePartnerKeyRequest.partnerId`
- `Partner` 엔티티를 만들고, `PartnerApiKey.partner`(ManyToOne, 필수)를 둔다.
- 마이그레이션은 다음 순서로 한다. down은 열과 표를 지운다.
  1. partner 표를 만든다.
  2. 키 이름마다 업체를 하나씩 넣는다(code `P-<id>`).
  3. partner_id를 채운 뒤 NOT NULL과 FK를 건다.
- `PartnerService`(list, create)와 `GET·POST /admin/partners`를 만든다.
- partner-keys: create에 partnerId를 받고(없으면 404), list에 `?partnerId=`를 받는다. 기존 e2e는 업체를 먼저 만들도록 바꾼다(스펙 3장 "바뀜").
- 시드: 시연 업체 `DEMO`(데모 연동 업체(시연))와 그 아래 시연 키를 둔다.
- 테스트
  - e2e `partners.e2e.spec.ts`: 등록, 409, 400, 역할 403, 키 수, 마지막 사용
  - partner-api e2e 수정
  - 접근 표
  - 마이그레이션 up/down

## Task 2. 호출 로그 (api)
- `PartnerCall` 엔티티. 인덱스는 (partner_id, id)와 (key_id, id).
- `PartnerCallService.record`
  - 기다리지 않는다. 실패하면 Logger.warn만 하고 응답은 그대로 둔다.
  - path는 쿼리를 뺀 경로를 200자에서 자른다.
- AuthGuard의 partner 분기
  - 키 확인이 성공하면 `res.once('finish')`에 기록을 건다. 걸린 시간은 가드 시작부터 잰다.
  - scope 검사(403)보다 먼저 건다.
- `GET /admin/partner-calls`: beforeId 방식, partnerId와 keyId로 거른다.
- e2e `partner-calls.e2e.spec.ts`
  - 200, 403, 404는 남고 401은 남지 않는다.
  - 업체와 키로 거른다.
  - 쪽 나누기를 확인한다.
  - 기록이 실패해도 응답은 200이다(엔티티 매니저를 일부러 깨뜨린다).

## Task 3. 연동 문서 (api)
- `partner-api/openapi.ts`: 손으로 쓴 OpenAPI 3.1 객체.
- `GET /partner/v1/openapi.json`은 @Public이다.
- 어긋남 테스트
  - 단위: 컨트롤러 라우트 메타데이터(경로·메서드·scope)와 문서 paths·`x-scope`가 같은지.
  - e2e: 실제 응답 필드 키가 문서 schema properties와 같은지.

## Task 4. 개발자센터 앱 뼈대 (apps/developers)
- 점주 앱 사본 9개와 사본 검사 테스트를 둔다(관제 앱과 같은 목록).
- vite :5178·4178와 /api 프록시.
- 화면: Shell, 로그인, ADMIN 아님 안내.
- 디자인 토큰은 0077을 따른다(밝은 화면, 위 막대).
- 어드민 `apps.ts`의 개발자센터 기본 주소를 바꾸고 그 기대값을 고친다.

## Task 5. 개발자센터 화면 (apps/developers)
- 업체 목록과 등록.
- 업체 상세: 키 발급(원문 한 번, 복사), 폐기 확인, 최근 호출.
- 호출 로그.
- 연동 문서.
- Vitest를 먼저 쓴다.

## Task 6. 마감
- 전체 검증: 모든 앱 테스트와 빌드.
- 실서버에서 시연 단계 1~5를 확인하고 Playwright로 찍는다.
- 다음을 갱신한다: README(포트, 테스트 표, curl), handoff, 회고, devlog 요약, 문서 색인.
- 브랜치 최종 리뷰(`docs/reviews/`)를 쓰고, 고친 뒤 push한다.
