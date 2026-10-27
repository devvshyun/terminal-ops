# 0048. 계약은 반환 타입·implements·enum 단언·오류 코드 오버로드로 컴파일 때 강제한다

- 날짜 / 관련 기능: 2026-10-27 / 보강 1, 전 기능 HTTP 응답, 어드민
- 상황: 계약(decisions/0047)이 있어도 api가 그 타입을 쓰지 않으면 어긋남은 그대로다. api의 응답은 view 함수·서비스·컨트롤러의 반환값을 TypeScript가 추론한 모양이고, 상태는 MikroORM 엔티티·class-validator가 쓰는 런타임 enum이며, 오류 코드는 `BusinessError(status, code: string, …)`의 문자열이다. vitest(swc)는 타입을 검사하지 않는다.
- 선택지:
  1. 응답: (a) 함수 반환 타입 `): TerminalView` / (b) `return { … } satisfies TerminalView` / (c) 런타임 검증(zod 등) — (a)는 함수 밖에서 보이는 타입이 곧 계약이라 다른 view(`{ ...toTerminalView(t), … }`)·테스트가 그 타입으로 이어진다. (b)도 남는·빠진 필드를 잡지만 함수의 타입은 추론값 그대로라 경계가 흐려진다. (c)는 런타임 비용과 새 의존성, 이 저장소처럼 서버·화면이 같이 바뀌는 곳에는 컴파일 시점 검사로 충분하다.
  2. 상태 값: (a) 엔티티 enum을 계약 유니온으로 바꿈 / (b) enum은 api에 두고 계약 유니온과 같은지 타입으로 단언 / (c) 계약에 `as const` 배열을 두고 api가 그것으로 enum을 만듦 — (a)는 `@Enum({ items: () => TerminalStatus })`·`@IsEnum`·`TerminalStatus.IN_STOCK` 사용처 수백 곳을 바꾸고 런타임 값이 필요해진다. (c)는 계약에 런타임 값이 생겨 0047의 방식이 안 된다. (b)는 api 코드를 그대로 두고 어긋남만 잡는다.
  3. 오류 코드: (a) `code: BusinessErrorCode` 하나 / (b) 상태별 오버로드 `(409, ConflictCode)`·`(422, RuleViolationCode)` — (b)는 "충돌인지 규칙 위반인지"까지 계약으로 묶는다.
  4. 요청 본문: (a) DTO 클래스를 계약으로 옮김 / (b) DTO는 api에 두고 계약 인터페이스를 `implements` — 검증 데코레이터(class-validator)는 서버 일이고 런타임 값이라 계약에 둘 수 없다. (b).
- 결정:
  - 응답을 만드는 함수(view 함수, 객체를 직접 만드는 서비스·컨트롤러 메서드)에 계약 반환 타입을 단다. 이미 계약 타입이 붙은 view를 그대로 돌려주는 컨트롤러 메서드에는 달지 않는다.
  - `src/common/contract-assertions.ts`가 `` `${Enum}` ``과 계약 유니온이 양방향으로 같은지 단언한다(`Assert<Same<Api, Contract>>`, 다르면 TS2344에 `onlyInApi`/`onlyInContract`와 그 값). 원래 유니온이던 `RowResultCode`·`RowResult`는 api가 계약 것을 그대로 쓴다.
  - `BusinessError` 생성자는 (b) 오버로드. 필터·400 응답 본문은 `satisfies ApiErrorBody`(PARTNER_ERROR는 `PartnerErrorBody`).
  - DTO는 `implements` 계약 요청 타입(Task 2에서 적용). 데코레이터가 붙은 프로퍼티의 타입은 바꾸지 않는다(swc가 별칭을 `design:type`에 `Object`로 내보낸다 — troubleshooting/0029). 어드민은 보내는 본문에 `satisfies`(Task 3에서 적용 완료).
  - 검수 400 본문(`missing`/`unknown`/`duplicated`, code 없음)은 `InspectionMismatchBody`로 따로 타입을 두고 `satisfies`한다.
  - (Task 3에서 적용 완료) 어드민은 계약 타입으로 응답을 읽고, 이름표는 `Record<유니온, string>`, `ApiError.code`는 `ErrorCode | null`.
  - 증명(api 쪽, Task 1·2에서 갖춤): `apps/api/test/unit/contract-drift.spec.ts` — 계약 파일 하나를 메모리에서 바꿔 TypeScript 컴파일러 API로 api 일부(단언 파일, 박스 스캔 서비스, 단말기 view, A/S DTO)를 검사하고, 기대한 파일에서 기대한 오류 코드(TS2344·TS2769·TS2353·TS2741·TS2420)가 나는지 본다. 바꾸지 않은 상태는 오류 0. 어드민 쪽 증명(이름표 `Record`·`ErrorCode` 비교)은 테스트가 아니라 Task 3의 수동 확인 출력과 `typecheck`이다.
- 결과·대가: 계약을 바꾸면 api·어드민 tsc가 바로 실패해 같은 커밋에서 맞추게 된다. 대신 검사는 `npm run build`·`typecheck`(그리고 drift 테스트의 대표 경우)에서만 일어난다 — `npm test`만 돌리면 api·어드민의 다른 어긋남은 보이지 않는다. 반환 타입을 단 함수가 거짓말을 하면(예: raw SQL 결과를 `as`로 넣음) 잡지 못한다. swc(vitest)와 tsc 빌드의 데코레이터 메타데이터가 별칭 타입에서 달라진다(troubleshooting/0029) — 엔티티에는 `type`을 명시한다. 어드민은 서버가 계약 밖 오류 코드를 보내지 않는다고 믿는다(캐스트 한 곳).
  - 계약이 못 잡는 사례(타입이 거짓말을 하는 자리): `dashboard.service.ts`의 `JSON.parse(raw) as DashboardView`(Redis 캐시가 옛 모양이면 TTL 동안 그대로 나간다), `dashboard.queries.ts`의 `JSON.parse(van.counts)`(any), `AnomalyDetail`의 `days?: number`에 `Record<string, unknown>`을 대입하는 곳(값이 숫자인지는 보지 않는다).
- 다시 볼 조건: 계약 밖 응답이 실제로 나간 사고가 생기면 해당 경계에 런타임 검증을. 테스트만 돌리는 흐름(CI)이 생기면 `npm test` 앞에 `typecheck`를 묶는다.

### 보탬 (Task 3, 어드민)
- 어드민 `src/api/types.ts`(114줄)와 화면 안 로컬 타입 14개를 지우고 모두 `@terminal-ops/contracts`에서 `import type`. 상태 이름표(`TERMINAL_STATUS_LABEL`·`SOURCE_LABEL`·`CARRIER_LABEL`·`TICKET_STATUS_LABEL`·`ROLLOUT_STATUS_LABEL`)는 `Record<유니온, string>`, `ErrorBox`의 안내는 `Partial<Record<ErrorCode, string>>`, `ApiError.code`는 `ErrorCode | null`(서버를 믿는 캐스트 한 곳 — 응답 본문을 `Partial<ApiErrorBody>`로 읽음). 순서가 필요한 짧은 목록(`OUTCOMES`, `OPEN_PO_STATUSES`)은 `as const satisfies readonly 유니온[]` — 없는 값은 잡고 빠진 값은 못 잡는다.
- 보내는 본문은 `satisfies` 요청 타입. 단말기 작업 버튼의 `run()`이 `expectedVersion`을 붙이므로 부르는 곳은 `Omit<요청, 'expectedVersion'>`(`Unversioned<T>`)로 맞춘다. select 값(`e.target.value`)은 이름표 키에서 나오므로 `as Carrier` 캐스트 두 곳.
- 바꾸는 순간 tsc가 테스트 가짜 응답의 어긋남 네 곳을 잡았다. 둘은 서버에 없는 주간 리포트 상태 `'FAILED'`(→ `PENDING`·`GENERATED`), 둘은 상태를 `string`으로 받던 helper. 화면 코드의 어긋남은 없었다.
- 확인한 모습: 계약에서 `'SCAN_IN_PROGRESS'`를 빼면 `ScanPage.tsx`의 비교가 TS2367. 계약의 `'IN_STOCK'`을 바꾸면 `labels.ts`가 TS2353, 가짜 응답들이 TS2322(후자는 계획 사전 검증의 출력이고 이번 실행에서는 `SCAN_IN_PROGRESS`만 다시 확인). GET 쿼리(`query: { status: 'IN_STOCK' }`)는 잡히지 않는다(decisions/0049).
- 검사가 안 닿는 자리(Task 3 리뷰): 어드민 `test/render.tsx`의 `HandlerResult.body`가 `unknown`이라 인라인 가짜 응답은 계약으로 검사되지 않는다(`test/fixtures.ts`의 helper를 거친 것만 검사됨). `HandlerResult<T>` 제네릭은 핸들러가 경로 문자열 키의 `Record`에 모여 있어 경로별로 T를 정하기 어려워 적용하지 않고 회고로 넘겼다. 같은 이유로 `TerminalActions.tsx`·`ServiceTicketDetailPage.tsx`의 공통 mutation 경로는 `body: unknown`이므로, 규칙은 **부르는 쪽에서 본문 객체 리터럴에 `satisfies 요청타입`을 붙인다**(공통 경로 안에서는 검사하지 않는다). 판별 유니온으로 URL별 본문을 묶는 방법은 회고로 이월.
