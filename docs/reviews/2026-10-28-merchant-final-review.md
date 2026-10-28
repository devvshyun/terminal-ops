# 보강 3(매장·가맹점주 화면) 최종 리뷰 (2026-10-28)

- 범위: `75c4ba7..76729dd`(merchant-portal). 커밋 10개: docs 2, feat 4, fix 4. 73파일, +9,426 / −56. 이 중 계획 문서가 4,025줄, `apps/merchant/package-lock.json`이 2,104줄이다
- 판정: **병합 가능(기록 보탬 권장)**
  - Critical·Important는 없다
  - Minor는 5건이다. 기록 정합성 둘, 두 앱이 쿠키를 함께 쓰는데 그것이 문서에 없는 것 하나, 사본 사이의 작은 차이 하나, 작은 것들이다
  - Minor 1(devlog 시각 하나와 컨트롤러 확인 기록)과 Minor 2(쿠키 공유 한 줄)는 한두 줄씩이라 병합 전에 같이 고치길 권한다
- 이번 리뷰가 특히 본 것
  - Task별 리뷰를 거치지 않은 fab607e·76729dd
  - 브랜치 전체에 걸친 것: `/me` 범위, 어드민 사본과의 차이, contracts, 접근 표, README, launch.json, 기록, 회고, 쿠키 공유

## 범위
- 계획(a4c0540): 스펙 `docs/specs/2026-10-28-merchant-portal.md`, 계획 `docs/plans/2026-10-28-merchant-portal.md`
- 점주 앱 골격(9dd85c9, 388a677)
  - `apps/merchant`: React 19 + Vite + TanStack Query, `:5174`, `/api` 프록시
  - 어드민과 같은 lock을 쓴다(decisions/0057)
  - api 클라이언트·세션·캐시 비우기·세션 확인 훅·KST 시각은 어드민에서 복사했다(decisions/0058)
- `/me` 보강(e18b24d, d814b5f)
  - `MerchantTerminalView`·`Detail`: 접속 요약, 이번 배정의 운송장·택배 이벤트·교체 접수 번호, 이번 배정부터의 이력
  - `MERCHANT_VISIBLE_STATUSES`: 배정부터 회수 완료까지
  - 새 엔드포인트 `GET /me/merchant`, `GET /me/service-tickets/:id`. 목록에 `serialNo` 조건
  - `MerchantTicketView`에 `remoteChecked`·`replacementStatus`를 더함
  - `ConnectivityService.getMany`, contracts `merchant.ts`·`CarrierEventCode`(decisions/0059)
- 점주 화면(24a6abf, 649892f, 2b3ab4a)
  - 홈, 단말기 상세, A/S 목록·접수·상세·설치 확인
  - 이름표 `Record<유니온, string>`, 단계 함수 `ticketSteps`·`shipmentSteps`(decisions/0060)
- Task별 리뷰를 거치지 않은 두 커밋
  - fab607e: 접수 실패 뒤 목록 다시 읽기, 숫자가 아닌 주소 처리, 설치 확인 오류 안내 지우기, fieldset `min-width: 0`
  - 76729dd: README, 어드민 가맹점주 안내 문구, devlog 마감과 "보강 3 요약", 회고 6장
- 기록
  - decisions 0057~0060(새로), 보탬은 0047·0052·0053
  - devlog `2026-10-28.md`의 `# 보강 3: 매장 화면`(11항목 + 요약)
  - 공부거리 4줄, `docs/index.md`

## 검증 결과 (리뷰어가 직접 실행)
- api: 테스트 DB를 `DROP/CREATE` 한 번으로 다시 만든 뒤 실행했다
  - `npx vitest run`: `Test Files 80 passed (80)`, `Tests 561 passed (561)`, 317.06초
  - `Connection is closed`는 0줄이다. `MaxListenersExceededWarning`은 7줄로, 보강 2 리뷰 때와 같은 수다(이월된 경고)
  - `npx tsc --noEmit -p tsconfig.json`: exit 0
  - 끝난 뒤 테스트 DB를 같은 명령으로 다시 비웠다
- 다른 앱 테스트와 tsc

  | 앱 | 테스트 | tsc |
  |---|---|---|
  | admin | `14 passed (14)` / `125 passed (125)` | exit 0 |
  | merchant | `6 passed (6)` / `45 passed (45)` | exit 0 |
  | device-sim | `5 passed (5)` / `46 passed (46)` | exit 0 |
  | partners | `6 passed (6)` / `53 passed (53)` | — |

- README 테스트 표(api 80/561, admin 14/125, merchant 6/45, partners 6/53, device-sim 5/46)와 위 결과가 같다. devlog 13:04 항목의 숫자와도 같다
- `node scripts/docs-index.mjs --check`: `docs/index.md 최신`(exit 0). 절 제목은 결정 60·트러블슈팅 32·실험 17로, README "결정 60·트러블슈팅 32·실험 17"과 같다
- 프로세스
  - 시작 전 node PID는 43936·35448·28868·26108이었다(리뷰어가 띄운 것 아님)
  - 리뷰어 실행은 api 테스트(background, 스스로 끝남)를 빼고 모두 foreground였다. 끝난 뒤 node PID는 시작 전과 같다
  - Redis는 건드리지 않았다. `git status`도 깨끗하다(이 리뷰 파일만 새로 생긴다)
- 기록 정합성
  - 번호: decisions 0057~0060이 이어지고, 빈 번호와 중복이 없다. troubleshooting·experiments는 새 번호가 없다(0033·0018은 비어 있음)
  - devlog 제목 시각: 11곳 중 10곳이 커밋 시각(`%ad`)과 같다. "12:58 Task 1 리뷰 반영"만 다르다(d814b5f는 12:56:06). Minor 1
  - 링크·경로: README·회고·devlog·decisions 0052~0060·스펙·공부거리의 마크다운 링크와 `apps/…`·`docs/…`·`packages/…` 경로 213개를 스크립트로 검사했다
    - 없는 것으로 잡힌 6개는 모두 일부러 쓴 표기다: 0058의 사전 검증용 `packages/web-common`, `0060-…` 같은 줄임, `.snapshot-…json` 설명
    - 실제로 깨진 링크는 0이다
  - 접근 표: `access-table.spec.ts`의 `EXPECTED` 70줄, 0052 MERCHANT 줄의 7개, 0052 "보강 3 보탬: 68 → 70"이 서로 같다
  - 비밀 값 노출(값은 출력하지 않고 위치만 셈)
    - seed 파일의 시연 비밀번호 7개: 이 브랜치가 바꾼 파일 어디에도 없다
    - 로컬 `.env`의 `DEVICE_API_KEY` 값: 이 브랜치가 바꾼 파일 어디에도 없다
    - README 매장 화면 절은 계정 표(`merchant-*`)만 가리키고 비밀번호를 적지 않는다
- 직접 하지 않은 것(지시에 따라)
  - 개발 DB 작업과 실서버 기동은 하지 않았다. devlog 13:04 항목의 기록과 대조만 했다: 테스트 DB 실서버 api `:3100`, 점주 `:5174` 프록시, 끈 PID, `merchant-live*` 6키를 하나씩 DEL
  - 화면 확인은 컨트롤러가 했다(개발 DB, 내장 브라우저 375×812)
    - 다른 포트에서 연 어드민의 직원 세션 쿠키로 들어가면 "직원 계정" 안내가 나온다. 로그아웃도 확인했다
    - merchant-gangnam으로 로그인하면 홈에 오고 있는 단말기 DEV-154758이 보인다: DELIVERED, 번개택배 운송장, 설치 안내
    - 상세에는 배송 단계와 "지난 일"(배정·출고·도착)이 보인다
    - 접수 화면은 "사용 중인 단말기 없음"을, A/S 목록은 빈 목록을 보여 준다
    - 모든 화면에 가로 스크롤이 없다(`scrollWidth` 375). 콘솔 오류와 api 오류 로그도 없다
    - 이 결과는 아직 devlog에 없다(Minor 1)

## Strengths
- **`/me` 범위가 일곱 엔드포인트 모두 "컨트롤러에서 scope를 만들어 서비스에 넘기는" 한 방식이다.** 리뷰어가 경로마다 따라가 봤다
  - `GET /me/merchant`: `merchantScopeOf(p)`의 `merchantId`로만 읽는다. 조건을 받지 않는다
  - `GET /me/terminals`: `TerminalService.list`
    - scope가 있으면 `merchant`가 `merchantCode` 조건보다 앞선다
    - 상태 조건이 없으면 `$in MERCHANT_VISIBLE_STATUSES`를 쓴다
    - `MeTerminalsQuery`의 `status`는 `@IsIn(visible)`이라, 보이지 않는 상태를 보내면 400이다
  - `GET /me/terminals/:serialNo`: `getBySerial`이 가맹점과 보이는 상태를 함께 본다. 이력은 마지막 ALLOCATED부터다. 접속은 이번 배정보다 앞선 값을 비운다
  - `GET /me/service-tickets`, `GET /me/service-tickets/:id`: 접수 행의 `merchant`(접수 때 고정)로 거른다
    - 그래서 단말기가 다른 가맹점으로 넘어가도 옛 접수는 옛 가맹점 것으로 남는다
    - `replacementStatus`는 REPLACING일 때만 나간다
  - `POST /me/service-tickets`: 잠근 행으로 가맹점과 보이는 상태를 본다(d814b5f). 재고로 돌아간 단말기는 422가 아니라 404라, 본사 재고 상태가 새지 않는다
  - `POST /me/service-tickets/:id/installations`: `tickets.get(id, scope)` 뒤에 잠근 접수로 판단한다
  - 운송장·택배 이벤트·교체 접수 번호에는 따로 범위 규칙이 없다. scope가 걸린 단말기 목록에서만 나온다. 0059가 고른 이유("범위 규칙을 한 번 더 정의하지 않는다")대로다
  - e2e `me-portal`이 새 두 엔드포인트의 남의 것 404, 직원 403, A → B → A 재배정, 재고 단말기 접수 404를 묶는다
- **응답 모양이 "펼치지 않고 하나씩 옮긴다"는 원칙을 지킨다.** `toMerchantTerminalView`·`toMerchantShipmentView`·`merchantEvents`에는 version·가맹점 코드·접속 출처·actor·reason이 없다. 계약 `merchant.ts`가 같은 모양을 타입으로 잠그고, `CarrierEventCode`는 `contract-assertions.ts`가 api enum과 단언한다
- **사전 검증이 결정을 바꿨고, 그 과정이 기록에 남았다.**
  - 0058: 공유 패키지 (a) 순수 함수는 된다. (b) React import가 풀리지 않는다(TS2307·Rolldown 메시지). (c) contracts import도 풀리지 않는다. 이를 확인하고 복사로 갔다
  - 0059: "회수 뒤 재고 단말기가 옛 가맹점에 보인다"를 e2e로 먼저 재현했다
- **사본과 원본의 차이가 의도된 것뿐이다**(아래 "어드민 사본 비교")
  - 로직은 같다: `api()`·401 처리·`LOGIN_PATH`·`setMe` 캐시 비우기 순서·재시도 판정
  - 빠진 것(version 충돌, 내려받기 주소, 역할 묶음)과 바뀐 것(`refetchOnWindowFocus`, `staleTime`)은 0057·0058과 머리 주석에 적혀 있다
  - `package.json`·`package-lock.json`은 `name` 두세 줄만 다르다. "같은 lock"이 사실이다
  - KST 형식 테스트의 기대값 다섯 개가 어드민과 글자까지 같다
- **contracts 사용이 일관된다.** merchant의 `@terminal-ops/contracts` import는 모두 `import type`이다. 이름표는 `Record<TerminalStatus | ServiceTicketStatus | Carrier | CarrierEventCode, string>`이라, 상태가 늘면 merchant tsc가 빠진 것을 알려 준다
- **fab607e가 작고 정확하다.** 테스트 4개를 먼저 써서 실패를 봤다(devlog의 실패 메시지)
  - 숫자가 아닌 id는 hook을 부르기 전에 갈라 다른 컴포넌트로 넘긴다. 훅 순서 규칙을 지킨다
  - `reset`을 `[status, replacementStatus]`에 묶었다. 그래서 같은 상태로 다시 읽으면 오류가 남고, 바뀌면 지워진다. 두 경우 모두 테스트가 있다
  - 접수 실패 뒤에는 `keys.terminals`만 무효화한다(접수 목록은 그대로다)
- **76729dd의 README 실행 절차가 코드와 맞다**
  - 설치 루프에 `merchant`가 들어 있다
  - `(cd apps/merchant && npm run dev)`의 `:5174`가 `vite.config.ts`의 `strictPort`와 같다
  - 타입 검사 안내 "merchant `npm run build`(tsc 포함)"이 `package.json`의 `build`와 같다
  - 매장 화면 절이 0057·0058·0059·0060을 모두 가리킨다
- **launch.json**: 세션 루트와 저장소 `.claude/launch.json` 둘 다 `terminal-ops-merchant`(:5174, 앱의 vite)가 있다. 저장소 쪽은 `.gitignore:6`에 걸려 커밋되지 않는다. 0057 "결과·대가"에 한 줄 적혀 있다

## Issues

### Critical
없음.

### Important
없음.

### Minor

1. **devlog 제목 시각 하나가 커밋과 다르고, 컨트롤러 화면 확인이 기록에 없다**
   - 위치: `docs/devlog/2026-10-28.md`의 "## 12:58 Task 1 리뷰 반영"(바로 다음이 "## 12:57 Task 4 리뷰 반영")과 13:04 항목의 "컨트롤러 확인: 대기"
   - 문제
     - d814b5f의 시각은 12:56:06이다(author·committer 같음). 나머지 10곳은 모두 맞는다. 지금은 12:58 → 12:57로 시각이 거꾸로 간다
     - 위 "직접 하지 않은 것"의 컨트롤러 확인이 devlog에 없다. 보강 2 리뷰 Minor 1과 같은 형태다
     - 13:04 항목은 "컨트롤러가 테스트 DB를 다시 migrate·seed"라고 넘겼다. 실제 확인은 개발 DB에서 했다. 개발 DB에 DEV-154758(배정·출고·도착)을 누가 어떻게 넣었는지도 기록에 없다. 개발 DB 쓰기 범위는 "migrate·seed·실서버 확인만"이라는 규칙이 있어 적어 둘 만하다
   - 수정
     - 제목을 `12:56`으로 고친다
     - 화면 확인 항목을 하나 덧붙인다(그 기록 커밋의 시각을 제목으로). 내용
       - "받아 적은 것"이라는 표시
       - 375×812, 직원 쿠키 안내 → 로그아웃 → merchant-gangnam 홈·상세·접수·A/S, `scrollWidth` 375, 콘솔·api 오류 없음
       - 개발 DB에 넣은 데이터(DEV-154758과 그것을 만든 방법)와 그 쓰기가 규칙 안인지
2. **어드민과 매장 화면이 localhost에서 세션 쿠키 하나를 함께 쓰는데, 문서에 없다**
   - 위치: `apps/api/src/auth/auth.controller.ts:48`(`sid`, `path: '/'`, host 단위), `auth.service.ts:93-97`(로그인하면 요청에 있던 옛 세션을 지움), README "매장 화면(보강 3)", decisions/0057
   - 문제
     - 쿠키는 포트를 구분하지 않는다. 그래서 `:5173`과 `:5174`가 같은 `sid`를 본다. 컨트롤러가 본 "직원 계정 안내"가 바로 이 동작이다
     - 같은 브라우저에서 매장 화면에 점주로 로그인하면, 그 요청에 실린 어드민 직원 세션이 서버에서 지워지고 쿠키가 점주 것으로 바뀐다. 반대 방향도 같다
     - 열려 있던 어드민 탭은 `me`를 그대로 기억한다. 401이 아니라 403(`FORBIDDEN`, "권한이 없습니다(역할 확인)")을 받으므로 로그인 화면으로 가지 않는다. 매장 탭도 직원 쿠키를 받으면 `/me/*`가 403이고 "가맹점 계정으로 로그인해야…"를 보여 준다
     - 보안 문제는 아니다. 한 브라우저는 한 사용자이고, 서버의 역할 판단과 `/me` scope는 그대로다. 운영 배포처럼 호스트가 다르면 생기지 않는다. 그래서 **받아들일 만한 동작**이다
     - 다만 시연에서 "어드민과 점주 화면을 한 브라우저에 나란히 띄우기"를 하면 한쪽이 로그아웃되거나 403이 된다. 그런데 0057(같은 출처·SameSite만 언급)·README·회고 어디에도 이 동작이 없다
     - 회고 이월 "다른 탭에서 사용자가 바뀌면 어드민 탭이 알아채지 못함"이 이제 두 앱 사이에서도 일어난다
   - 수정
     - README 매장 화면 절에 한 줄을 더한다: "localhost에서는 포트가 달라도 쿠키가 같다. 어드민과 매장 화면을 동시에 다른 계정으로 쓰려면 다른 브라우저 프로필(또는 시크릿 창)을 쓴다. 한쪽에서 로그인하면 다른 쪽 세션은 끝난다"
     - 0057 "결과·대가"에도 같은 줄을 더한다
     - 회고 "보강 3이 남긴 것"에 "두 앱이 한 쿠키를 씀 — 403을 받으면 `/auth/me`를 다시 확인해 사용자 변경을 알아채기(선택)"를 더한다
     - (선택) 두 앱의 `api()`가 403을 받으면 `/auth/me`를 한 번 다시 읽어 `setMe`를 갱신한다. 그러면 사용자 바뀜을 알아챈다. 보강 2 이월(포커스 재확인)과 함께 하면 된다
3. **0053 본문 한 줄이 낡았다**
   - 위치: `docs/decisions/0053-…scope.md:15` "`me.e2e`가 다섯 엔드포인트 모두 남의 것 404·목록 범위를 본다"
   - 문제: 엔드포인트는 이제 일곱 개다. 새 두 개의 범위 검사는 `me.e2e`가 아니라 `me-portal.e2e`에 있다. 같은 문서 20행의 보강 3 보탬이 사실을 바로잡지만, 15행은 그대로다
   - 수정: 15행 끝에 "(보강 3의 두 엔드포인트는 `me-portal.e2e`)"를 붙인다
4. **사본 사이의 작은 차이(선택)**
   - (a) 어드민 `api/query-keys.test.ts`(`import.meta.glob`으로 소스를 읽어 키 글자를 직접 쓰는 곳을 잡는다)는 복사하지 않았다
     - 지금 merchant 소스에 `queryKey: [` 리터럴은 없다(리뷰어 grep)
     - 다만 키가 모두 `'me'`로 시작하고 쓰기 뒤에는 `keys.all`을 통째로 무효화한다. 리터럴 키가 하나 생기면 무효화에서 빠질 수 있다. 이 테스트를 옮겨 오거나 0058 "사본 목록"에 "가져오지 않은 것"으로 적는다
   - (b) 두 앱의 줄 끝이 다르다. 작업 트리에서 어드민은 CRLF, merchant는 LF다(index는 둘 다 LF, `core.autocrlf=true`). 그래서 `diff`로 사본을 비교하면 파일 전체가 다르게 나온다. 0058이 "고칠 때 두 파일을 같이 본다"고 했으므로, 비교 방법(`diff --strip-trailing-cr` 또는 `git diff --no-index`)을 머리 주석이나 0058에 한 줄 적어 두면 좋다
   - (c) 어드민 `client.ts`의 "서버가 contracts 밖의 코드를 주지 않는다는 전제(decisions/0048)" 주석이 merchant 사본에서 빠졌다. `as ErrorCode` 캐스트의 근거라 같이 두는 편이 낫다
5. **작은 것들(선택)**
   - (a) fab607e의 `useEffect(reset, [status, replacementStatus])`는 설치 확인 요청이 진행 중일 때 같은 접수가 다시 읽히는 경우를 다루지 않는다
     - 예: 창 포커스로 다시 읽어 상태가 바뀜(`refetchOnWindowFocus`가 켜져 있다)
     - 그러면 `reset()`이 pending 상태를 지우고 버튼이 다시 켜진다. 두 번째 누름은 서버가 422 `TICKET_NOT_REPLACING`으로 막는다
     - 수 ms 창이라 실제로 일어날 일은 거의 없다. `if (!install.isPending) reset()` 한 줄이면 막힌다
   - (b) 숫자 판정 `Number.isInteger(Number(id))`는 `1e3`·아주 큰 수(`1e20`)도 통과시킨다. 서버 `ParseIntPipe`가 받아 404나 400으로 끝나므로 해가 없다. `/^\d+$/` 검사가 의도("숫자가 아닌 주소")에 더 가깝다
   - (c) 홈의 "진행 중 A/S"는 최근 50건에서 거른다. 0060에 가정으로 적혀 있으니 그대로 둔다(기록 확인용 메모)

## Task별 리뷰를 거치지 않은 두 커밋 따로 본 것
- fab607e
  - `NewTicketPage`의 `onError`: 422(사용 중이 아니게 됨)와 404(단말기가 사라짐) 모두 단말기 목록을 다시 읽는다. 테스트가 `GET /me/terminals` 두 번을 센다. 409 `TICKET_ALREADY_OPEN`에도 다시 읽지만 해가 없다
  - `ServiceTicketDetailPage`를 바깥과 `TicketDetail`로 나눈 것: 바깥 컴포넌트에는 `useParams`만 있고, 그 뒤에 조건부 return이 온다. 훅 규칙을 지킨다. 숫자가 아니면 요청이 0번인 것을 테스트가 본다
  - `reset` 효과는 Minor 5(a)
  - `fieldset { min-width: 0 }`: fieldset의 기본 `min-width: min-content` 때문에 휴대폰 폭에서 넘치는 것을 막는다. jsdom이 레이아웃을 재지 않아 자동 테스트는 없다. 컨트롤러 확인(`scrollWidth` 375)이 그 확인이다
  - devlog 12:57 항목: 시각이 맞고, 실패 → 통과 숫자(41 → 45)가 README와 같다
- 76729dd
  - README 차이를 줄 단위로 봤다. 구성도, 설치 루프, 실행 줄(:5174), 타입 검사, MERCHANT 역할 설명, 매장 화면 절, 기능 표, 색인 수 60, 테스트 표(merchant 행 추가, 앞 값 79/549 표기)가 모두 코드·실행 결과와 맞다
  - 어드민 `AuthGate` 문구 "매장 화면(개발 서버 :5174)을 쓰세요": 어드민 테스트 125개가 통과한다. 이 문구를 단언하는 테스트는 없다(원래 문구도 없었다)
  - devlog 13:04 항목: 시각이 맞고, 실서버 확인의 기대값·끈 PID·DEL 키 수가 적혀 있다. 컨트롤러 확인은 "대기"로 남아 있다(Minor 1)
  - "보강 3 요약"의 커밋 목록 10개는 `git log --oneline 75c4ba7..HEAD`와 같다
  - 회고 6장
    - 보강 2 줄의 "가맹점 화면 없음(Bundle 3)"이 "(→ 보강 3에서 만듦)"으로 바뀌었다
    - `[x] 보강 3` 항목과 "보강 3이 남긴 것"이 새로 생겼다
    - 보강 2 리뷰의 Minor 3(6장 첫 줄 "로그인·권한")은 이미 "(로그인·권한은 보강 2 — 아래)"로 고쳐져 있다

## 어드민 사본 비교 (`diff --strip-trailing-cr`, 리뷰어가 파일마다 실행)
| 파일 | 차이 |
|---|---|
| `api/client.ts` | 머리 주석(출처·0058), 빠진 것: `isVersionConflict`, `downloadUrl`, contracts 전제 주석(Minor 4c). `api()`·401·`LOGIN_PATH`·`messageOf`·`toQueryString` 로직은 같다 |
| `session.ts` | 빠진 것: `hasRole`·`STAFF`·`OFFICE`. 주석만 짧아졌다. `setMe`는 "아이디가 바뀌면 알리기 전에 캐시부터 비운다"는 같은 순서다 |
| `components/SessionCacheSync.tsx`, `hooks/useSessionCheck.ts` | 주석만 다르다 |
| `query-client.ts` | 재시도 판정은 같다. `refetchOnWindowFocus` 기본값(켜짐), `staleTime` 30초(어드민 5초)는 0057에 이유가 있다 |
| `lib/format.ts` | `formatKst`는 같다. `kstToday`·`ageText` 대신 `formatKstShort`·`agoText`. 테스트 기대값 5개가 같다 |
| `components/AuthGate.tsx` | 역할 조건이 반대(`!== 'MERCHANT'`), `UserBar` 대신 `LogoutButton`(UserBar의 로그아웃을 옮긴 것) |
| `components/ErrorBox.tsx` | 모양은 같고 문구는 점주용으로 새로 썼다(0060). `INVALID_TRANSITION`을 "교체 단말기가 아직 도착 처리되지 않아…"로 좁혔는데, 점주가 부를 수 있는 쓰기 중 이 코드가 나는 곳은 설치 확인(전이)뿐이라 맞다 |
| `test/setup.ts` | `localStorage.clear()` 대신 `vi.useRealTimers()` |
| `api/query-keys.ts` | 새로 썼다(`'me'` 한 묶음). 원본의 소스 검사 테스트는 복사하지 않았다(Minor 4a) |
| `package.json`, `package-lock.json` | `name`만 다르다 |
| `vite.config.ts` | 포트 5174·4174, `MERCHANT_API_URL` |

## 남은 이월 목록
회고 6장의 "보강 3이 남긴 것"(`docs/retrospective.md:99`)이 이월을 담고 있다. 이 리뷰가 보탤 것은 아래뿐이다.
- 이 리뷰의 Minor 2(두 앱이 한 쿠키를 씀 — 문서화, 선택으로 403 뒤 사용자 재확인), 4(사본 비교 방법·키 검사 테스트), 5(a)(pending 중 reset)
- 회고 6장 그대로 남는 것
  - 회수 뒤에도 `terminal.merchant`가 옛 가맹점이다(화면만 가림, partner API `merchant-terminals`는 옛 가맹점으로 본다)
  - 반품 운송장 없음, 공통 코드 두 벌, 점주 알림 없음, 증상이 글 안에 섞임, 휴대폰 화면 자동 테스트 없음, 한 매장 100대 상한
  - 보강 2에서 넘어온 것: CSRF 토큰(localhost 다른 포트는 같은 사이트), 다른 탭 사용자 변경 감지 등
- 상태
  - 테스트 DB는 리뷰어가 마지막에 `DROP/CREATE`로 비워 두었다
  - 개발 DB와 Redis는 이 리뷰가 읽거나 쓰지 않았다
  - 개발 DB에는 컨트롤러 확인용 DEV-154758이 있다(기록은 Minor 1)

## Assessment
**병합 가능(Ready to merge). 병합 전에 Minor 1(시각 한 곳, 컨트롤러 확인 항목)과 Minor 2(쿠키 공유 한 줄)를 하길 권한다. 나머지는 이월 목록으로 충분하다.**
- 통과한 것
  - 리뷰어 실행: api 80/561, admin 14/125, merchant 6/45, device-sim 5/46, partners 6/53. api·admin·merchant·device-sim tsc 0. 색인 `--check` 최신
  - 구현자 기록(76729dd): 같은 숫자, 테스트 DB 실서버 프록시 확인
  - 컨트롤러: 개발 DB에서 375×812 화면 확인
- 맞춰 본 것
  - 접근 표 70줄 = 0052 표 = 0052 보탬 "68 → 70"
  - decisions 0057~0060 연속, 색인·README 수 60
  - 링크·경로 213개(실제로 깨진 것 0)
  - devlog 시각 10/11(Minor 1)
  - README 테스트 표와 실행 절차
  - 비밀 값은 바뀐 파일에 없다
- 점주 범위는 서로 맞물린다
  - 세션 → `merchantScopeOf` → 서비스 scope(단말기: 가맹점 + 보이는 상태, 접수: 접수 행의 가맹점) → 404
  - 운송장·이벤트·접속은 scope가 걸린 단말기에서만 나온다
  - 응답은 필드를 하나씩 옮긴 점주용 모양이다
  - 남은 것은 문서화(쿠키 공유)와 기록 몇 줄이다. 데이터나 범위를 깨는 것은 없다
