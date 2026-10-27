# 보강 1 설계 — 공유 타입 패키지 `packages/contracts`

- 날짜: 2026-10-27
- 범위: 7일 마감 뒤 보강 1. api 응답·요청 모양, 상태 값 목록, 오류 코드를 한 패키지(`packages/contracts`)에 두고, api가 그 모양을 지키지 않으면 컴파일이 실패하게 한다. 어드민은 그 타입을 import한다.
- 구현 계획: `docs/plans/2026-10-27-shared-contracts.md`
- 브랜치: `shared-contracts`(master 5d6a870에서)
- 등장하는 회사와 가맹점은 모두 가상이다.

## 1. 무엇을 왜

api 응답 타입과 어드민 타입이 따로 있다.

- api: `*.views.ts`의 `toXxxView` 함수, 서비스·컨트롤러가 직접 만드는 객체(이상 목록, VAN 결과, 발주 대조, 대시보드 등). 반환 타입은 대부분 추론에 맡긴다.
- 어드민: `apps/admin/src/api/types.ts`(114줄, 첫 줄 주석이 "서버의 *.views.ts·toXxxView와 같게 둔다")와 화면 파일 안의 로컬 인터페이스 15개(`SyncRunView`, `AnomalyView`, `PurchaseOrderView` 두 벌, `VanRunView`, `RolloutView`, `TicketView` …).

둘이 같은지는 사람이 대조했다. Day 6·7 리뷰에서 실제로 필드를 한 줄씩 맞춰 봤고, 상태 값은 문자열(`status: string`)로 받아 화면이 모르는 값이 와도 컴파일러가 알려 주지 않았다. 오류 코드도 마찬가지로 `code: string`이라 화면의 `error.code === 'SCAN_IN_PROGRESS'`가 서버의 실제 코드와 같은지 보장하지 않는다.

목표는 세 가지다.

1. 응답·요청 모양, 상태 값, 오류 코드를 **한 곳**에 둔다.
2. api가 그 모양을 지키지 않으면 **api의 tsc(build·typecheck)가 실패**한다. 엔티티의 런타임 enum과 계약의 문자열 유니온이 다르면 역시 실패한다.
3. 어드민은 그 타입을 import한다. 상태 이름표(`TERMINAL_STATUS_LABEL` 등)는 계약의 유니온을 키로 가져서, 값이 늘거나 줄면 어드민 tsc도 실패한다.

채용 공고의 "반복되는 문제를 패턴화하고 재사용 가능한 모듈로" 항목과 맞닿는다. 반복되던 문제(사람 대조)를 컴파일러가 하게 한다.

## 2. 구성

```
terminal-ops/
├─ packages/contracts/ (새)            타입만 있는 패키지. 런타임 값 없음. 의존성 없음
│  ├─ package.json                     "@terminal-ops/contracts", exports "." → { types: ./src/index.ts }
│  ├─ tsconfig.json                    편집기용(검사는 쓰는 쪽 tsc가 한다)
│  └─ src/
│     ├─ index.ts                      export type * from …
│     ├─ statuses.ts                   상태·종류 유니온 14개 + RowResultCode
│     ├─ errors.ts                     ConflictCode(409)·RuleViolationCode(422)·FilterErrorCode·InputErrorCode, ApiErrorBody
│     ├─ common.ts                     BeforeIdPage·AfterIdPage·OffsetPage, RowResult
│     ├─ terminal.ts                   단말기·상세·이력·접속·검수·가맹점·모델·운송장
│     ├─ operations.ts                 박스 스캔·발주·발주 대조·A/S·펌웨어·배포
│     ├─ reports.ts                    이상·VAN·주간 리포트·택배 수집 실행·대시보드·health
│     └─ requests.ts                   쓰기 요청 본문 13가지
├─ apps/api
│  ├─ package.json                     "@terminal-ops/contracts": "file:../../packages/contracts"
│  ├─ src/common/contract-assertions.ts (새)  런타임 enum ↔ 계약 유니온 양방향 같음 단언(타입만)
│  ├─ src/common/domain-errors.ts      BusinessError(409, ConflictCode) / (422, RuleViolationCode) 오버로드
│  ├─ src/**/*.views.ts, 서비스·컨트롤러   응답을 만드는 함수에 계약 반환 타입
│  ├─ src/**/dto/*.ts                  DTO가 계약 요청 타입을 implements
│  └─ test/unit/contract-drift.spec.ts (새)  계약을 메모리에서 바꿔 컴파일러 API로 api가 실패하는지
└─ apps/admin
   ├─ package.json                     같은 file: 의존
   ├─ src/api/types.ts                 지움 → @terminal-ops/contracts
   ├─ src/pages/** 로컬 타입 14개        지움 → @terminal-ops/contracts
   ├─ src/lib/labels.ts 등              Record<계약 유니온, string>
   └─ src/api/client.ts·ErrorBox.tsx    ApiError.code: ErrorCode | null
```

## 3. 결정

### 3.1 연결 방식 (decisions/0047)

| 선택지 | 사전 검증 결과 | 판단 |
|---|---|---|
| (a) 루트 npm workspaces | 루트 `npm install` 25초, 빌드는 됨. 그러나 앱별 package-lock 네 개를 루트 하나로 합치며 잠긴 버전 707개 중 43개가 바뀜(`@nestjs/common` 12.2.0 → 12.3.2, `@swc/core` 1.16.18 → 1.16.20 등). 설치 명령·README가 바뀌고 vitest가 앱마다 다른 판(admin 5.0.4 고정, api ^5.0.5)이라 일부가 앱 안에 따로 깔림 | 버림 — 타입 공유를 하려다 의존성 판 올림이 함께 들어온다 |
| (b) 각 앱 `file:../../packages/contracts` + **TS 소스** exports | api build(rootDir src) 성공·TS6059 없음, `dist`에 계약 import 0곳, `node dist/main.js`로 떠서 `/terminals` 응답, api vitest, admin tsc·vitest·vite build, `npm ci` 새로 설치 모두 됨. lock 변화는 앱마다 9줄 | **고름** |
| (b') 같은 file: 의존 + 손으로 쓴 `.d.ts` | 어긋남은 잡지만, 계약 파일 안의 오타(`version: Foo`)를 아무도 잡지 못함(api tsc exit 0) — 두 앱 모두 `skipLibCheck: true`라 `.d.ts`를 검사하지 않고 그 자리가 `any`가 된다 | 버림 |
| (c) tsconfig `paths`(패키지 아님) | api typecheck·build 모두 TS6059 `is not under 'rootDir'` | 버림 |
| (d) OpenAPI(@nestjs/swagger) → openapi-typescript | 설치 가능(@nestjs/swagger 12.0.5가 Nest 12 지원). 그러나 응답이 함수가 만드는 평범한 객체라 엔드포인트마다 응답 클래스와 데코레이터를 새로 써야 하고, 그 클래스와 실제 반환값이 같은지는 여전히 아무도 검사하지 않는다. 의존성 2개와 생성 단계가 는다 | 버림(설치·생성은 시도하지 않음, 이유로 판단) |

(b)를 TS 소스로 두면 쓰는 쪽 tsc가 계약 파일까지 검사한다(오타 `Foo` → api·admin 모두 `TS2304 Cannot find name 'Foo'`). `node_modules`를 거쳐 찾은 파일이라 api의 rootDir 검사에도 걸리지 않고 빌드 결과(`dist`)에도 나오지 않는다.

계약에 런타임 값이 없으므로 api 런타임(node)·vitest(swc)·Vite는 이 패키지를 읽지 않는다 — 모든 import를 `import type`으로 쓴다. 값(예: `as const` 배열)을 넣고 싶어지면 (b)로는 부족하다(JS 산출물·런타임 해석이 필요). 그때 다시 본다.

### 3.2 강제 방법 (decisions/0048)

- **응답**: 응답 객체를 만드는 함수(view 함수, 객체를 직접 만드는 서비스·컨트롤러 메서드)에 계약 반환 타입을 단다(`): TerminalView`). 객체 리터럴의 남는 속성 검사로 계약에 없는 필드는 TS2353, 계약에 있는데 안 채운 필드는 TS2741, 타입이 다르면 TS2322. 이미 계약 타입이 붙은 view를 그대로 돌려주는 컨트롤러 메서드에는 따로 달지 않는다. `satisfies`가 아니라 반환 타입을 고른 이유: 함수 밖에서 보이는 타입 자체가 계약이 되어 다른 곳(테스트, 다른 view)이 그 타입으로 이어진다.
- **상태 값**: 엔티티·class-validator가 쓰는 런타임 enum은 api에 남긴다. `src/common/contract-assertions.ts`가 `` `${TerminalStatus}` ``(enum 값의 문자열 유니온)과 계약 유니온이 양방향으로 같은지 타입으로 단언한다. 다르면 TS2344, 메시지에 `onlyInApi: "DISPOSED"`처럼 한쪽에만 있는 값이 나온다. `RowResultCode`처럼 api에서도 원래 유니온이던 것은 계약 것을 그대로 쓴다.
- **오류 코드**: `BusinessError`의 생성자를 오버로드한다 — `(409, ConflictCode, …)`, `(422, RuleViolationCode, …)`. 계약에 없는 코드나 상태 코드와 맞지 않는 묶음은 TS2769. 필터·400 응답 본문은 `satisfies ApiErrorBody`.
- **요청 본문**: class-validator DTO는 api에 남기고(검증 규칙은 서버 일) 계약 인터페이스를 `implements`한다. 계약에서 필드가 바뀌면 TS2420. 어드민은 보내는 본문에 `satisfies`.
- **어드민**: 계약 타입으로 응답을 읽는다(`api<TerminalDetail>(…)`). 이름표는 `Record<TerminalStatus, string>`이라 값이 빠지거나 남으면 실패. `ApiError.code: ErrorCode | null`이라 `=== 'SCAN_IN_PROGRESS'` 같은 비교가 계약 밖이면 TS2367.
- **증명**: `apps/api/test/unit/contract-drift.spec.ts`가 계약 파일 하나를 **메모리에서만** 바꿔(필드 이름 변경, 필드 추가, 상태 값 빼기·더하기, 오류 코드 빼기, 요청 필드 변경) TypeScript 컴파일러 API로 api 일부를 검사하고 기대한 오류 코드가 기대한 파일에서 나는지 본다. vitest는 swc로 돌아 타입을 검사하지 않으므로, 이 테스트가 "단언이 실제로 tsc를 멈춘다"를 테스트 실행 안에서 보여 준다.

### 3.3 범위 (decisions/0049)

- **넣는다**: 어드민이 실제로 쓰는 응답 전부(단말기 목록·상세·이력·접속·검수 기록·검수 항목·가맹점·모델, 박스 스캔, 발주·발주 대조·마감, A/S, 펌웨어 배포·단계 통계, 이상 단말기·규칙·찾기 결과, VAN 실행·결과, 주간 리포트, 택배 수집 실행, 대시보드, health), view 함수가 있는 나머지(운송장 `toShipmentView`, 펌웨어 `toFirmwareView`, 검수 결과), 쓰기 요청 본문 13가지, 오류 응답 본문과 코드 전부(BusinessError 20개, 필터 5개, 입력 7개), 목록 페이지 세 모양.
- **넣지 않는다**: GET 쿼리 문자열(어드민 `Query`는 자유 형식으로 둔다 — 예: `?status=IN_STOCK`은 검사되지 않음), 어드민이 부르지 않는 응답(엑셀 등록 결과, 검수 불합격 통계, 단말기 하트비트·펌웨어 보고 — 단말기 시뮬레이터가 쓰는 쪽), 런타임 응답 검증(zod 등 — 서버와 화면이 같은 저장소라 컴파일 시점 검사로 충분, 새 의존성), 어드민 런타임 테스트 추가(어드민의 계약 검사는 `npm run build`의 tsc가 한다).
- 엔티티 하나의 타입만 좁힌다: `SyncRun.outcome: string` → `SyncRunOutcome`(값 목록 `SYNC_RUN_OUTCOMES`에서). 데코레이터 메타데이터는 그대로 `String`이라 스키마·마이그레이션이 바뀌지 않는다(빌드 결과 `__metadata("design:type", String)` 확인).

## 4. 어드민에서 사라지는 것

- `src/api/types.ts` 전체.
- 화면 안 로컬 타입: `BatchHistoryPage`의 `SyncRunView`, `AnomaliesPage`의 `AnomalyRuleView`·`AnomalyView`·`ScanSummary`, `PurchaseOrdersPage`의 `PurchaseOrderView`·`Reconciliation`, `ScanPage`의 `PurchaseOrderView`(부분)·`ScanResultView`, `VanRunsPage`의 `VanRunView`, `VanRunDetailPage`의 `VanItemView`·`RunWithItems`, `RolloutsPage`의 `StageStats`·`RolloutView`, `ServiceTicketsPage`의 `TicketView`, `WeeklyReportsPage`의 `WeeklyReportView` 다시 내보내기.
- 사전 검증에서 이 교체가 **실제 어긋남 하나**를 찾았다: 배치 실행 이력 테스트의 가짜 응답이 주간 리포트 상태 `'FAILED'`를 썼는데 서버의 상태는 `PENDING | GENERATED | SENT`뿐이다(실패한 시도는 `lastError`만 남고 상태는 그대로). 화면 코드는 이 값에 기대지 않아 테스트는 통과하고 있었다 → 가짜 응답을 `PENDING`·`GENERATED`로 고친다.

## 5. 검증

- api: `npm run typecheck`, `npm run build`(dist에 `@terminal-ops/contracts` 문자열 0곳), vitest 전체(65/446 → 66/453), `node dist/main.js`가 테스트 DB·다른 포트·주기 작업 끔으로 떠서 GET 응답을 준다.
- admin: `npm run build`(tsc + vite build), vitest(12/109 그대로).
- 어긋남 증명: (1) contract-drift 테스트 7개, (2) 실제 저장소에서 계약 필드 하나를 바꾸고 `npm run build`가 TS2353으로 실패하는 출력을 devlog에 남긴 뒤 되돌린다.
- 새로 설치: 두 앱에서 `rm -rf node_modules && npm ci` 뒤 `node_modules/@terminal-ops/contracts`가 `packages/contracts`를 가리키는지.

## 6. 위험과 대가

- 계약을 바꾸면 api와 어드민을 같은 커밋에서 맞춰야 한다(그것이 목적이지만, 한쪽만 고친 중간 커밋은 빌드가 깨진다).
- `npm ci`가 `packages/contracts`를 링크로 가리킨다. 저장소를 앱 폴더만 떼어 쓰면 설치가 실패한다(이 프로젝트는 한 저장소라 문제 없음).
- 계약은 컴파일 시점 검사뿐이다. 서버가 계약 밖 값을 런타임에 보내는 경로(예: raw SQL 결과를 그대로 넣는 곳)는 그 함수의 타입이 정직할 때만 잡힌다. 어드민의 `ApiError.code`는 서버를 믿고 `ErrorCode`로 본다(캐스트 한 곳).
- vitest는 타입을 검사하지 않는다. 계약 어긋남은 `npm run build`/`typecheck`(그리고 contract-drift 테스트의 대표 경우)에서만 드러난다.
