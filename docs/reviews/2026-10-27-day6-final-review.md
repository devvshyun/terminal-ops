# Day 6 최종 리뷰 (2026-10-27)

- 범위: `6085a2a..3b2077d` (day6-admin, 커밋 18개: docs 2, feat 8, fix 8). 110파일, +15,674 / −67(그중 계획 문서 6,834줄, admin package-lock 2,095줄)
- 판정: **수정 후 병합**. Critical은 없고 Important는 1건이다. 화면 한 줄과 테스트 하나로 고칠 수 있다. Task 9 리뷰 반영(review-fixes-t9)은 아직 적용되지 않았다. Minor 1로 옮겼다.

## 범위
- Day 5 이월 정리
  - Minor 5: 레이블 상수를 순수 파일 `anomaly-labels.ts`·`van-labels.ts`로 옮겼다. import 방향은 `module-deps.spec`로 검사한다(decisions/0037)
  - Minor 6: `POST /reports/weekly`를 report 큐 job과 202로 바꿨다. jobId로 같은 요청이 한 번만 들어가고, `queued`·`queuedAt`을 함께 준다(decisions/0038)
  - 날짜에 기대던 테스트를 고쳤다(troubleshooting/0026, 0027)
- 화면용 API
  - 단말기 상세 응답에 `allowedTransitions`·`actions`를 더했다. 전이 표(RULES)에서 `targetsFrom`으로 계산한다(decisions/0040)
  - `statusChangedAt`, 가맹점 필터, 목록 select-in(experiments/0013)
  - 새 조회: `GET /terminals/:serialNo/inspections`, `/terminal-models`, `/anomaly-rules`
  - beforeId 키셋 목록 5개: 발주, A/S, 배포, VAN 실행, SyncRun. 주간 리포트 목록은 `before`(주) 키셋이다
  - 목록 조건의 값 검증: `IsCalendarDate`, `MAX_SAFE_INTEGER`, `IsIn`(decisions/0039)
- `apps/admin`(React 19.3, Vite 8.3, TanStack Query 5.104, react-router 8.4)
  - 화면 13개: 단말기 목록·상세, 박스 스캔, A/S 목록·상세, 펌웨어 배포, 이상 단말기, VAN 목록·상세, 발주 입고 대조, 주간 리포트, 배치 실행 이력
  - Vite 프록시 `/api`, `X-Operator`(localStorage 저장, URL 인코딩), `RunningPoller`(2초, `cancelRefetch: false`)(decisions/0041)
- 미리보기: `infra/preview.env`(`RUN_SCHEDULERS=0`, `RUN_WORKERS=1`)를 커밋했다. 저장소 `.claude/launch.json`은 추적하지 않은 채로 남아 있다
- 기록: decisions 0037~0041, troubleshooting 0026·0027, experiments 0013, devlog 18개 항목과 6일차 요약, backlog 133 → 147줄

## 검증 결과 (리뷰어가 직접 실행)
- api `npx vitest run`(테스트 DB `terminal_ops_test`): `Test Files 62 passed (62)`, `Tests 430 passed (430)`, 223.36초, exit 0. 로그에 `Connection is closed` 0줄
- api `tsc --noEmit -p tsconfig.json`: exit 0
- admin `npx vitest run`: `Test Files 10 passed (10)`, `Tests 86 passed (86)`, 5.24초. `tsc --noEmit`은 exit 0
- admin `npx vite build`: 163 modules, `index-*.js 346.58 kB`(gzip 104.93 kB), `built in 103ms`, exit 0. `apps/admin/dist`가 다시 생겼지만 `.gitignore`의 `dist/`라 추적되지 않는다
- partners: `6 passed (6)` / `52 passed (52)`. device-sim: `4 passed (4)` / `40 passed (40)`
- 프로세스와 작업 트리
  - 실행 전후 node 프로세스는 같은 PID 3개(43936, 35448, 28868)다
  - 3000·4010·4011·5173에서 LISTENING 중인 것은 없다
  - `git status`는 `?? .claude/` 한 줄로 리뷰 전과 같다(이 리뷰 파일은 빼고 센 것이다. 커밋하지 않았다)
- 기록 정합성
  - devlog 제목 시각 18곳이 커밋 18개의 시각(`--date=format:%H:%M`)과 모두 같다
  - 번호는 decisions 0037~0041, troubleshooting 0026~0027, experiments 0013으로 이어진다
  - 코드·테스트에 적힌 `decisions/0037~0041` 참조 57곳(파일·번호 쌍 52개)은 모두 있는 파일을 가리킨다. 다만 1곳은 주제가 틀렸다(Minor 2)
- API 계약과 admin 타입 대조. 서버 view 함수와 화면 interface를 필드 단위로 맞춰 봤다
  - view: Terminal, TerminalDetail, History, Connectivity, Inspection, Ticket, Rollout, PurchaseOrder, SyncRun, VanRun, VanItem, Anomaly, WeeklyReport, ScanResult. 이름·nullable이 어긋난 곳은 없다
  - enum 값 목록도 서버와 같다: 단말기 상태 12, 출처 8, 택배사 2, 수집 결과 5, A/S 4, 배포 4, 발주 3
  - 화면이 보내는 본문(`expectedVersion` 포함)과 `forbidNonWhitelisted` DTO 사이에도 넘치는 필드가 없다
- 직접 하지 않은 것
  - `db:migration:check`: 이번 Day는 마이그레이션이 없다. devlog 12:51에 `최신 상태`가 기록돼 있다
  - 실서버·브라우저 확인: 컨트롤러가 내장 브라우저로 개발 DB에서 확인했다(아래 Minor 9). partners·device-sim typecheck도 돌리지 않았다

## Strengths
- **화면이 규칙을 따로 갖지 않는다.** 상세 응답의 `allowedTransitions`는 `checkTransition`과 같은 RULES 표를 `targetsFrom`으로 읽는다. 모델 정책에 막힌 전이는 빼지 않고 `blockedReason`을 붙인다. `TerminalActions`는 그 목록과 `actions`만으로 버튼을 그린다. 서버는 요청마다 다시 검사하고 `expectedVersion`도 함께 보낸다. 반대로 레이블은 표시용 이름만 화면(`lib/labels.ts`)에 둔다. 규칙 이름·종류 이름은 서버(`ruleLabel`·`kindLabel`·`/anomaly-rules`)가 준다. 경계가 분명하다
- **202 주간 리포트 흐름이 처음부터 끝까지 맞는다.**
  - 요청 처리
    - `request()`는 `assertEnded`로 끝나지 않은 주를 거르고, 행을 만들기 전에 막는다
    - 이미 SENT면 job을 넣지 않고 200을 준다. 아니면 jobId `weekly-report-send-<주>`로 job을 넣는다
    - job은 `attempts: 1`, `removeOnComplete/Fail`이라 끝나면 지워진다. 그래서 같은 jobId를 다시 넣을 수 있다
  - 처리기
    - 409 `WEEKLY_REPORT_IN_PROGRESS`는 `skipped`로 끝낸다
    - 영구 오류는 `UnrecoverableError`로 끝낸다
  - 상태 조회
    - SENT면 Redis를 보지 않는다
    - 대기 중이면 `queuedAt`을 준다. 화면은 "N분째 대기"와 워커 확인 안내를 띄우고, 대기 중에는 지난 `lastError`를 숨긴다
  - 확인
    - `weekly-report-async.e2e`가 큐를 멈춘 상태에서 두 번 눌러 waiting이 1인지 본다. 실패 뒤 다시 누르면 같은 파일로 보내는지도 본다
    - devlog 실서버 확인에서 202 → active(attempts 1, queuedAt) → SENT → xlsx 200 12,969바이트까지 이어졌다
- **폴링을 설치된 소스로 확인했다.** `RunningPoller`는 refetch를 `cancelRefetch: false`로 부른다. 그래서 2초보다 늦은 응답을 다음 폴링이 버리지 않는다. 기본값이 true라는 근거는 query-core 5.104.2 `queryObserver.fetch` 소스 줄이다. 느린 응답 테스트는 먼저 실패하는 것을 확인했다. 언마운트하면 폴링이 멈추는 것도 테스트한다
- **쿼리 키를 대체로 화면끼리 공유한다.**
  - `['weekly-reports']`(주간 리포트·배치 이력), `['van-runs', {}]`(VAN·배치 이력), `['terminal', serial, 'detail']`(단말기 상세·A/S 상세 고장 단말기)은 같은 키에 같은 queryFn이다
  - 쓰기 뒤에는 응답으로 캐시를 고치지 않고 prefix 무효화로 다시 읽는다. 이 원칙은 decisions/0041 Task 5 보탬에 적혀 있다
- **`X-Operator` 인코딩이 양쪽에서 대칭이다.**
  - 클라이언트는 `encodeURIComponent`, 서버는 `decodeURIComponent` 후 trim한다. 디코드에 실패하면 400이다
  - 클라이언트 `operatorProblem`(1~50자, `system:` 금지)은 서버 `Operator` 데코레이터 규칙과 같다
  - 다른 탭의 변경은 `storage` 이벤트로 따라간다. 실서버 확인에서 김운영이 이력 3줄에 그대로 남았다
- **목록 API를 측정과 검증으로 다듬었다.**
  - 실험 0013: 10만 대 1쪽 p50이 joined 91.2ms, select-in 5.2ms다. 원인은 실행계획으로 확인했다
  - beforeId는 PK 범위 키셋이다. "모양만 맞는 값"(2026-13-45 → 500, `1e20`, 오타 outcome → 빈 200)은 먼저 실패하는 e2e를 쓴 뒤 400으로 막았다
- **박스 스캔이 멱등을 화면까지 이어 간다.**
  - scanId는 결과를 받을 때까지 유지한다. 오류 종류에 따라 같은 scanId로 다시 보낼지, 새로 만들지 가른다
  - 보낸 박스는 readOnly로 잠근다. 결과를 받지 못한 박스를 버릴 때는 confirm을 띄운다. 늦게 온 onError가 새 박스의 scanId를 지우지 않게 ref로 비교한다

## Issues

### Critical
없음.

### Important

**1. VAN 대조 화면이 끝나지 않는 RUNNING 행을 만나면 버튼이 영구히 꺼지고, 폴링도 멈추지 않는다**
- 위치: `apps/admin/src/pages/reports/VanRunsPage.tsx:39, 55, 61`, `apps/api/src/van/van-reconciliation.service.ts:150, 593-604`
- 문제:
  - 화면은 불러온 목록에 RUNNING이 하나라도 있으면 `running = true`로 본다. 그러면 "대조 실행"을 끄고 2초 폴링을 계속한다
  - 서버는 멈춘 실행(하트비트가 `VAN_RUN_HEARTBEAT_STALE_MS` 300초 넘게 없음)을 `start()` 안의 `failStale()`에서만 FAILED로 바꾼다. 다른 주기 정리는 없다. 결국 새 실행 요청이 들어와야 멈춘 행이 풀린다
  - 화면이 그 요청을 막고 있으니 다음 경우에 영구히 갇힌다
    - (a) 대조 도중 api·워커 프로세스를 다시 띄웠다(개발 중에 흔하다)
    - (b) `RUN_WORKERS=0`인 api로 요청해 job이 waiting에 남았다
  - 미리보기 구성은 `RUN_SCHEDULERS=0`이라 주기 VAN job이 대신 `start()`를 부르지도 않는다. 행은 RUNNING으로 남고 브라우저는 2초마다 목록 전체를 계속 다시 읽는다. 풀 방법은 curl로 `POST /van-reconciliations`를 보내는 것뿐이다
  - 이미 서버가 409 `VAN_RECONCILIATION_RUNNING`을 주고 ErrorBox에 안내 문구(0ee6843)도 있다. 그래서 화면 쪽 비활성은 없어도 되는 이중 가드다
- 수정(둘 중 하나):
  - (a) 권장: `disabled={start.isPending}`만 남긴다. 진행 중이면 서버의 409와 안내 문구를 그대로 보인다. 멈춘 행은 버튼을 누르면 `failStale`이 풀어 준다
  - (b) 비활성을 유지하려면 RUNNING 행의 `heartbeatAt`(이미 view에 있다)이 오래됐을 때 "하트비트 N분 없음 — 다시 실행하면 멈춘 실행으로 정리됩니다"를 보이고 버튼을 켠다. 이때 기준값이 화면에 필요하다
- 근거로 두면 좋은 테스트: RUNNING 행(heartbeatAt 10분 전)이 있는 목록에서 "대조 실행"이 켜져 있다. 누르면 POST가 한 번 나간다

### Minor

1. **Task 9 리뷰 반영(review-fixes-t9)이 아직 적용되지 않았다**
   - `ServiceTicketDetailPage.tsx:145` "최근 {n}대만 표시" → "최근 등록 순 {n}대만"(목록은 id 내림차순)
   - `BatchHistoryPage.tsx:119-153` VAN 탭에 RUNNING이 있어도 `RunningPoller`가 없다. 주간 리포트 탭(`:155`)도 `queued` 배지만 있고 폴링·새로고침 버튼이 없다
     - 두 탭 모두 주간 리포트·VAN 화면과 캐시 키를 공유한다. 그래서 거기서 넘어오면 낡은 "대기열"이 그대로 보인다
     - 고칠 때 Important 1의 비활성 조건을 따라 하지 않는다
   - `BatchHistoryPage.tsx:183` 행 링크가 `/reports/weekly`로만 가서, 어느 주인지 이어지지 않는다. 주를 쿼리로 넘기거나 링크를 뺀다
   - `BatchHistoryPage.tsx:49, 61-62` 탭을 바꾸면 `setParams({ tab })`가 주소를 통째로 바꾼다. 수집 탭 필터(지역 상태)도 언마운트로 초기화된다. 의도라면 decisions/0041 Task 9 보탬에 한 줄 적는다. 아니면 단말기 목록처럼 `?job=&outcome=`를 주소에 둔다
   - `BatchHistoryPage.tsx:156-161`과 `WeeklyReportsPage.tsx:63-68`의 `useInfiniteQuery`는 키·queryFn·pageParam이 같다. `api/lists.ts`에 `useWeeklyReports()`로 모은다. 키가 한쪽만 바뀌면 같은 키에 다른 queryFn이 붙는 위험을 없앤다
2. **결정 기록 참조가 틀렸다**
   - 위치: `apps/admin/src/api/client.ts:52`
   - 문제: `X-Operator(URL 인코딩, decisions/0001·0037)`라고 적혀 있다. 0037은 레이블 상수 분리이고, 작업자 헤더는 0041이다. 계획 단계 번호가 남은 것으로 보인다
   - 수정: `decisions/0001·0041`
3. **SyncRun 클래스 문서 주석이 상수 위로 밀렸다**
   - 위치: `apps/api/src/shipment/shipment.entities.ts:79-81`
   - 문제: abd1964에서 `SYNC_RUN_OUTCOMES`를 클래스 주석과 `@Entity` 사이에 넣었다. 그래서 `/** 수집 job 실행 1회의 기록 … */`이 상수의 JSDoc이 됐다. 문서 주석이 두 개 연달아 붙어 있다
   - 수정: 상수를 주석 위로 옮기거나, 클래스 주석을 `@Entity` 바로 위로 내린다
4. **쿼리 키 prefix가 단수·복수로 갈려 무효화를 빠뜨리기 쉽다**
   - 위치: `ScanPage.tsx:89-92`, `ServiceTicketDetailPage.tsx:41-45`
   - 문제:
     - 키가 `terminal`/`terminals`, `purchase-order`/`purchase-orders`, `service-ticket`/`service-tickets`, `van-run`/`van-runs`로 갈린다
     - 입고 스캔 성공은 `['purchase-orders']`만 무효화한다. 발주 대조 `['purchase-order', poNo, 'reconciliation']`은 무효화되지 않는다
     - A/S 교체 출고·설치 확인은 `['terminals']`만 무효화한다. 고장·교체 단말기 상세 `['terminal', serial]`은 그대로다
     - 지금은 staleTime 5초와 마운트 때 다시 읽기 덕분에 화면에 드러나지 않는다. 같은 화면에 오래 머물거나 staleTime을 늘리면 드러난다
   - 수정: `api/query-keys.ts`에 키 팩토리(`keys.terminal(serial)`, `keys.purchaseOrders.all` 등)를 두고 위 두 곳을 무효화 목록에 넣는다
5. **미리보기 구성(`infra/preview.env` + launch.json, 개발 DB·워커 켬)의 위험이 주석에 다 드러나 있지 않다**
   - 위치: `infra/preview.env:1-5`, `.claude/launch.json`(추적 안 함)
   - (a) `RUN_SCHEDULERS=0`은 "새로 등록하지 않는다"는 뜻일 뿐이다. 개발 Redis에 이미 있는 job scheduler(월 09:00 주간 리포트, VAN 대조, 이상 찾기, outbox relay 등)는 지우지 않는다. `RUN_WORKERS=1`이라 그 job들이 미리보기 중에 실행된다
     - 지금은 Day 5에 scheduler를 지워 둬서 문제가 없다(devlog 12:51)
     - 하지만 그 사이 저장소 `.env`(`RUN_SCHEDULERS=1`)로 api를 한 번이라도 띄우면 다시 생긴다. 그러면 미리보기에서 VAN 대조·주간 리포트가 실제로 돌 수 있다
   - (b) 개발 Redis에 남은 대기 job(택배 추적, device, report)도 미리보기가 뜨자마자 처리된다. 개발 DB 상태가 바뀐다
   - (c) api는 `apps/api/dist/main.js`를 실행한다. launch.json에는 빌드 단계가 없다. 소스를 고치고 `npm run build`를 잊으면 옛 코드로 화면을 확인하게 된다. 이번에는 dist(12:47)가 마지막 api 커밋(12:47)과 같아 괜찮았다
   - (d) 같은 접두사(`terminal-ops`)로 다른 api·워커가 떠 있으면 report 큐 처리자가 둘이 된다. 그러면 "concurrency 1" 전제가 깨진다. VAN은 `running_key` unique, 주간 리포트는 Redis 잠금이라 데이터는 안전하다. 다만 순서 가정(decisions/0038 "VAN 뒤에 선다")이 틀린다
   - (e) launch.json이 세션 루트와 저장소 두 곳에 같은 내용으로 있다. 한쪽만 고치면 서로 어긋난다
   - 수정: `preview.env` 주석에 "띄우기 전에 `npm run build`(api·partners), 필요하면 `npm run scheduler:clear`, 다른 api·워커를 끈다"를 적는다. devlog에도 미리보기 전 점검 한 줄을 둔다
6. **추적되지 않은 `.claude/`는 커밋하지 말고 ignore한다**
   - 위치: 저장소 루트 `.claude/launch.json`, `.gitignore`
   - 근거:
     - 내용이 이 PC의 절대 경로(`C:/Devhyun/...`)라 다른 곳에서는 쓸 수 없다
     - 개발 DB에 워커를 켜는 구성이라 공유 기본값으로 두기에 위험하다(Minor 5)
     - 계획도 "저장소에는 `infra/preview.env`만 커밋"으로 정했다
     - 그런데 `.gitignore`에 빠져 있어 `git status`에 계속 뜨고, `git add -A` 한 번에 들어간다
   - 수정: `.gitignore`에 `.claude/launch.json`과 `.claude/settings.local.json`을 더한다. 디렉터리 전체는 막지 않는다. 나중에 팀 공유용 `.claude/settings.json`·명령을 커밋할 여지를 남기기 위해서다
     - 실행 구성의 "무엇을 어떤 env로 띄우나"는 이미 devlog 12:51과 preview.env에 있다
     - 이식 가능한 예시가 필요하면 `infra/launch.example.json`(상대 경로, 주석 대신 README 한 줄)로 둔다
7. **Day 5 Minor 2(큐에서 기다리는 수동 VAN 실행이 "멈춘 실행"으로 FAILED)를 Day 6에서 다시 보지 않았다**
   - 위치: `docs/decisions/0033…md:104-109`, `docs/decisions/0038…md:17`
   - 문제:
     - 0033은 "Day 6 어드민에서 수동 실행을 부를 때 다시 본다(Minor 6과 함께)"고 적었다
     - Day 6은 report 큐(concurrency 1)에 수동 주간 리포트 job(최악 약 10.6분)을 더했다. 수동 VAN 실행이 그 뒤에서 5분 넘게 기다릴 가능성이 Day 5보다 커졌다
     - 0038의 결과·대가에는 반대 방향("VAN 뒤에 보내기가 선다")만 있다
     - 다행히 Important 1의 화면 비활성 때문에 어드민에서는 그사이 두 번째 `start()`가 나가지 않는다. 그러면 Important 1을 고치면 이 경로가 다시 열린다
   - 수정: 0038 결과·대가에 "주간 리포트 보내기 job 뒤에 선 수동 VAN 실행은 5분이 지나면 다음 `start()`에 FAILED될 수 있다(0033 Minor 2)"를 더한다. 0033 갱신 절에는 재검토 결과(유지 또는 `pages = 0` 행 건너뛰기)를 한 줄 적는다
8. **작업자 입력칸이 다른 탭의 변경을 따라가지 않는다**
   - 위치: `apps/admin/src/components/OperatorBar.tsx:7`
   - 문제:
     - `draft`는 첫 렌더의 `operator`로만 초기화된다. 다른 탭에서 이름을 바꾸면 `지금: 새 이름` 표시는 바뀐다. 입력칸은 옛 이름 그대로다
     - 이 상태에서 "저장"을 누르면 옛 이름으로 되돌아간다
     - 탭 동기화(a4193c3)가 막으려던 "이력의 작업자가 어긋남"이 입력칸에서 다시 생긴다
   - 수정: `operator`가 바뀌면 `draft`를 맞춘다. `useEffect(() => setDraft(operator), [operator])` 또는 `key={operator}`. 테스트에서 storage 이벤트를 보낸 뒤 입력칸 값을 확인한다
9. **브라우저 확인 결과가 기록에 아직 없다**
   - 위치: `docs/devlog/2026-10-27.md` 12:51 항목 "화면 확인(Step 4): 컨트롤러 확인 대기", "내일 시작 전에 필요한 것"
   - 문제: 컨트롤러는 개발 DB에서 다음을 확인했다
     - 단말기 목록·상세, MANUAL INSPECTED→IN_STOCK(작업자 김운영이 이력에 남음)
     - 주간 리포트 목록, 배치 이력 VAN 탭, 이상 단말기, 스캔 화면
     - 콘솔 오류와 api 오류 로그는 0건
     
     이 결과와 개발 DB에 새로 남은 상태(전이한 단말기 시리얼)가 기록에 없다
   - 수정: devlog에 결과를 덧붙인다(그 기록 커밋 시각으로 제목). "개발 DB에 남은 것" 목록도 갱신한다
10. **배포 목록의 단계 통계를 배포마다 차례로 읽는다**
    - 위치: `apps/api/src/firmware/rollout.service.ts:341`
    - 문제: `for … await this.stageStats(rollout, em)`라 limit 100이면 쿼리 101번이 직렬로 나간다. 화면 기본 20이면 21번이다. 주석에 "배포마다 한 쿼리(limit 상한 100)"라고 의도는 적혀 있다. 하지만 decisions/0039 다시 볼 조건에는 빠져 있다
    - 수정: 지금 규모(배포 수십 건)면 둔다. 0039 다시 볼 조건에 "배포 목록 N+1"을 한 줄 더한다. 나중에 `rollout_id IN (…) group by` 한 쿼리로 바꾼다
11. **단말기 목록의 `page`·`q`에 상한이 없다**
    - 위치: `apps/api/src/terminal/dto/list-terminals.query.ts:22, 24-28`
    - 문제: backlog에 적어 둔 그대로다. beforeId에는 `MAX_SAFE_INTEGER` 상한을 걸었지만(abd1964) `page`에는 같은 이유의 상한이 없다. 그래서 `page=1e20`이면 offset 계산이 정밀도를 잃는다(리뷰어가 요청을 보내 확인하지는 않았다)
    - 수정: `@Max(Math.floor(Number.MAX_SAFE_INTEGER / 100))` 정도와 `q`에 `@MaxLength(32)`. 테스트는 beforeId 상한 테스트를 그대로 본뜬다

## Day 7 이월 목록
- (병합 전에 고치지 않으면) Important 1: VAN 대조 버튼 비활성 조건
- Minor 1~11(위). 병합 전에 하길 권하는 것
  - Minor 2(참조 번호), 3(주석 위치), 6(`.gitignore`), 9(브라우저 확인 기록): 기록·저장소 위생
  - Minor 1: Task 9 리뷰 반영. 원래 "최종 리뷰 수정과 함께" 하기로 했다
- 6일차 요약의 "남은 문제"를 그대로 넘긴다
  - 화면 운영 배포(정적 파일 + 역프록시)와 인증·권한이 없다
  - 브라우저 자동 테스트가 없다
  - 단말기·엑셀·펌웨어 등록과 배포 생성 화면이 없다
  - 이상 찾기 실행 기록 표가 없다
  - 상태·큐 조건 목록이 인덱스 없이 PK 역순으로 거른다
  - 검수 기록 목록에 페이지 조건이 없다
  - 주간 리포트 목록이 filesort다
  - 실험 0013 "왕복 2→4번" 표현이 남아 있다
- Day 5 이월 중 남은 것
  - 주간 리포트: at-least-once, 고아 파일, 프로세스가 죽은 뒤 잠금 약 10.6분, 4주 밖 미전송 주
  - VAN: 시리얼 ASCII·유일 가정, 개발 환경 전송 대기
  - 이상: 열린 이상이 수십만일 때 정렬 인덱스, `status_changed_at` 백필이 이력과 어긋날 수 있음
  - 데이터가 든 DB의 down 한 바퀴
- Day 4 이월 중 남은 것: 같은 버전 재배포 때 단계 지연, 하트비트 버전을 그대로 믿음, QUEUED outbox 복구 sweep, HTTP 1213 매핑
- Day 7 준비
  - 대시보드 집계 캐시 실험(Redis 캐시 대 MySQL 직접 — 쓰면 결정 기록)
  - 상태 조건 목록의 `(status, id)` 인덱스 효과
  - README 결과 표는 실험 0001~0013에서 가져온다
  - 미리보기를 쓰기 전 점검: build, scheduler 확인, 다른 워커 없음(Minor 5)
- 개발 DB·Redis 상태
  - Day 5 상태에 더해 단말기 `D6-124905-1`(IN_STOCK), 주간 리포트 2026-10-12 SENT
  - 컨트롤러 브라우저 확인에서 INSPECTED→IN_STOCK한 단말기 1대(시리얼은 devlog에 적을 것)
  - job scheduler는 없는 상태(미리보기·실서버 확인 모두 `RUN_SCHEDULERS=0`)

## Assessment
**수정 후 병합(Ready with fixes).**
- 통과한 것: 테스트(api 430, admin 86, partners 52, device-sim 40), 양쪽 typecheck, admin 빌드, 기록 정합성(번호 연속, devlog 시각 18곳, 참조 무결성)
- 맞춰 본 것
  - 서버 view와 화면 타입, enum 목록, 요청 DTO가 모든 화면에서 맞는다
  - `X-Operator` 인코딩·검증 규칙이 양쪽에서 같다
  - 202 주간 리포트 흐름은 e2e와 실서버 기록 양쪽으로 끝까지 확인됐다
  - Day 5 이월 Minor 5·6은 코드·결정 기록·테스트로 닫혔다
- Important 1은 데이터를 깨뜨리지 않는다. 하지만 개발 중 흔한 사건(실행 도중 api 재시작)만으로 VAN 대조 화면을 영구히 막는다. 미리보기 구성(`RUN_SCHEDULERS=0`)에서는 화면만으로 풀 길이 없다. 비활성 조건 한 줄과 테스트 하나로 고치고 재확인한 뒤 병합하길 권한다
- Minor 2·3·6·9는 몇 분이면 끝나는 기록·위생 정리라 병합 전에 함께 하는 것이 좋다. Minor 1(Task 9 리뷰 반영)도 원래 이 수정과 함께 하기로 했다. 나머지는 Day 7 이월로 충분하다
