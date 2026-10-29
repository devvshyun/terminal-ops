# 보강 7 설계 — 외부 연동 개발자센터

- 날짜: 2026-10-29
- 범위: 보강 7. 외부 업체(가상)를 등록하고, API 키를 발급·폐기하고, 연동 문서와 호출 로그를 보는 화면 `apps/developers`와 그 화면이 부르는 API. 통합 시연 준비의 여섯 번째 묶음(보강 6 운영 관제 다음).
- 구현 계획: `docs/plans/2026-10-29-developer-center.md`
- 브랜치: `claude/stoic-tesla-rm7xpo`(디자인 2 PR [devvshyun/terminal-ops#2](https://github.com/devvshyun/terminal-ops/pull/2) 위)
- 등장하는 회사는 모두 가상이다. 시연 키 원문은 `apps/api/src/db/seed-accounts.ts`에만 있고 이 문서에 적지 않는다.

## 1. 무엇을 왜

보강 2가 외부 업체 키 API(`GET·POST /admin/partner-keys`, `POST /admin/partner-keys/:id/revoke`, decisions/0054)와 외부용 읽기 API 두 개(`/partner/v1/...`)를 만들었다. 화면이 없어 키는 curl로만 다루고, 키에는 업체 이름이 글자로만 있어 "이 업체의 키"를 모아 볼 수 없다. 호출 로그는 0054가 이 묶음으로 미뤘다 — 지금은 `last_used_at`이 "쓰고 있나"만 답한다. 어드민 "다른 화면"에 개발자센터가 "준비 중"으로 있다(decisions/0067·0069).

목표:

1. ADMIN이 외부 업체를 등록하고(코드·이름·메모), 업체마다 키를 발급(원문은 한 번만 보이고 복사)·폐기한다.
2. 외부용 API를 부른 기록(업체·키·메서드·경로·상태 코드·걸린 시간)이 남고, 업체별·키별로 최근부터 본다. 401(키 없음·틀림)은 어느 업체인지 모르므로 남기지 않는다. 403(scope 밖)·404·200·5xx는 남긴다.
3. 외부 업체가 읽을 연동 문서(OpenAPI 3.1)를 api가 내놓고(`GET /partner/v1/openapi.json`, 로그인 없이), 개발자센터가 그것으로 문서 화면을 그린다. 문서와 코드가 어긋나면 테스트가 실패한다.
4. 서버 규칙은 기존 방식 그대로 — 접근 표(기본 거부), contracts 타입, e2e. 새 표는 `partner`·`partner_api_call` 둘.

하지 않는 것: 업체가 직접 로그인하는 화면(decisions/0080), 호출 한도·IP 허용 목록·가맹점 제한(0054 다시 볼 조건 그대로), 호출 로그 보관 기간 정리 작업(decisions/0082 결과·대가).

## 2. 구성

```
apps/api/src/partner/                   외부 업체(보강 7)
├─ partner.entity.ts                    partner 표(code unique, name, memo, createdBy, createdAt)
├─ partner.service.ts                   목록(키 수·마지막 사용)·등록
├─ partner-call.entity.ts               partner_api_call 표(partner, key, method, path, status, durationMs, createdAt)
├─ partner-call.service.ts              한 줄 쓰기(응답이 끝난 뒤, 기다리지 않음)·목록(beforeId)
apps/api/src/auth/auth.guard.ts         partner 경로: 키 확인 뒤 res 'finish'에 호출 기록을 건다
apps/api/src/auth/partner-key.*         키에 partner 연결(필수). 목록에 업체 코드·이름
apps/api/src/partner-api/openapi.ts     손으로 쓴 OpenAPI 문서, GET /partner/v1/openapi.json
apps/api/src/admin/admin.controllers.ts GET·POST /admin/partners, GET /admin/partner-calls, partner-keys에 partnerId
apps/api/src/migrations/                partner·partner_api_call, partner_api_key.partner_id(기존 키는 이름마다 업체를 만들어 채움)
packages/contracts/src/auth.ts          PartnerView·CreatePartnerRequest·PartnerCallView, PartnerKeyView·CreatePartnerKeyRequest에 업체
apps/developers/                        개발자센터 화면(:5178·미리보기 4178) — 점주 앱 사본 + 사본 검사(0062), 새로 쓴 화면
apps/admin/src/apps.ts                  개발자센터 주소 기본값 http://localhost:5178
```

## 3. API

| 엔드포인트 | 누가 | 응답 |
|---|---|---|
| `GET /admin/partners` | ADMIN | `PartnerView[]` — id·code·name·memo·createdBy·createdAt, 키 수(살아 있는 것·전체), 마지막 사용 시각(키들의 lastUsedAt 중 가장 늦은 것) |
| `POST /admin/partners` | ADMIN | `PartnerView`. code `^[A-Z0-9-]{2,20}$`, name 1~50자, memo 0~200자. 같은 code 409 `DUPLICATE` |
| `GET /admin/partner-keys?partnerId=` | ADMIN | `PartnerKeyView[]` — 기존 필드 + partnerId·partnerCode·partnerName. partnerId를 주면 그 업체만 |
| `POST /admin/partner-keys` | ADMIN | **바뀜**: `partnerId`가 필수(없는 업체 404). `name`은 키 이름표("운영 서버" 같은) |
| `POST /admin/partner-keys/:id/revoke` | ADMIN | 그대로 |
| `GET /admin/partner-calls?partnerId=&keyId=&beforeId=&limit=` | ADMIN | `BeforeIdPage<PartnerCallView>` — 최근부터, 기본 50·최대 100 |
| `GET /partner/v1/openapi.json` | 누구나 | OpenAPI 3.1 문서(외부용 경로 두 개, 인증 두 방식, 응답 모양, 401·403·404) |

엔드포인트 수는 접근 표 테스트가 센다(4개 늘어난다). 운영자·관제·현장·가맹점주는 `/admin/*`에서 403.

## 4. 화면 (`apps/developers`, :5178)

| 경로 | 내용 |
|---|---|
| `/login` | 로그인(관제 앱과 같은 모양). ADMIN이 아니면 로그인 뒤 "개발자센터는 ADMIN만" 안내와 로그아웃 |
| `/` (업체) | 업체 목록(코드·이름·살아 있는 키·마지막 사용) + 업체 등록 폼 |
| `/partners/:id` | 업체 한 곳: 키 목록(접두사·이름표·scope·만료·마지막 사용·상태), 키 발급 폼(scope 고르기·만료), 발급하면 원문을 한 번만 보이는 상자(복사 단추, "다시 볼 수 없다"), 폐기(확인창). 아래에 이 업체의 최근 호출 |
| `/calls` | 호출 로그 전체(업체 고르기, 50개씩 더 보기). 상태 코드는 2xx 초록·4xx 노랑·5xx 빨강 |
| `/docs` | 연동 문서: openapi.json으로 그린 경로별 설명·scope·응답 필드·오류, curl 예(키 자리는 `<키>`) |

## 5. 시연 단계

1. ADMIN으로 개발자센터에 로그인 → 업체 "한올POS(가상)" 등록
2. 키 발급(두 scope) → 원문 복사
3. 문서 화면의 curl로 `/partner/v1/terminals/:serialNo` 호출 → 200
4. 호출 로그에 그 호출이 보인다. scope 하나만 준 키로 다른 경로를 부르면 403이 남는다
5. 키 폐기 → 같은 curl이 401(로그에는 남지 않는다 — 어느 업체인지 모른다)

## 6. 검증

- api: 새 e2e(업체 등록·중복·역할, 키의 업체 필수·필터, 호출 기록 200·403·404 남고 401은 안 남음, 목록 페이지, openapi 문서와 실제 라우트·응답 필드 일치), 접근 표 테스트, 마이그레이션 up/down(기존 키 채움)
- 화면: Vitest(업체 등록, 키 발급 원문 한 번, 폐기 확인, 호출 로그, 문서 화면, ADMIN 아님 안내), 사본 검사, build
- 실서버: 시연 단계 1~5를 실제 api·화면으로
