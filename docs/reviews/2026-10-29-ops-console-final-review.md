# 보강 6(운영 관제 화면) 최종 리뷰 (2026-10-29)

## 요약
- 범위: `master(10a3f6c)..ops-console(1c7e562)`. 커밋 8개(docs 2, feat 4, fix 2), 101파일, +11,516 / −34. 이 가운데 계획 문서가 4,992줄, `apps/console/package-lock.json`이 2,104줄이다
- 판정: **병합 가능. 다만 Important 1(최근 오류 글 가리기)을 먼저 고치길 권한다**
  - Critical: 없음
  - Important: 1건. 실패 job의 실패 이유는 전화번호·이메일을 가리는데, `GET /ops/errors`는 같은 출처의 글(업체 응답 본문 200자가 붙은 오류 글)을 가리지 않고 그대로 보낸다. 알림·택배 추적 실패는 실패 job 화면에 없고 이 목록에만 나오므로, 가리기가 정작 필요한 쪽을 비켜 갔다
  - Minor: 6건. 쓰기 앞의 확인 읽기에 시간 제한이 없음, 실패 job 화면의 쪽·큐 고르기 상태, 감사 기록 열 길이, contracts 타입 하나, 컨트롤러 확인 기록, 작은 것들
- 작성자: 커밋 8개 모두 author·committer가 `252961019+devvshyun@users.noreply.github.com`이다. diff에서 이메일 꼴은 `noreply@anthropic.com`(커밋 규칙)과 테스트 값 `owner.kim+a@example.co.kr`(예시 도메인)뿐이다
- 이번 리뷰가 특히 본 것: Task 사이의 연결(contracts ↔ api ↔ console, 리뷰 반영 8b3f9a4·4af88d3가 서로 맞는지), 보안(역할, 가리기, 오류 글 유출, 새 쓰기 엔드포인트의 CSRF), 정확성, 테스트 빈 곳, 기록 정합성(devlog 제목 = 커밋 시각, 이전 커밋 해시, 테스트 수), LF, 비밀 값·실제 회사 이름·대학 이메일

## 범위
- 계획(05fd111): 스펙 `docs/specs/2026-10-29-ops-console.md`, 계획 `docs/plans/2026-10-29-ops-console.md`(Task 5개)
- 관제 읽기 API(2c0836c): `GET /ops/queues·schedulers·system·outbox·errors`, 모든 `@Processor`에 `WORKER_OBSERVABILITY`(워커 이름, 분 단위 metrics), contracts `ops.ts`, enum 단언 둘, 접근 표 72 → 77
- 관제 앱 골격(97b1789): `apps/console`(:5176), 점주 사본 9개와 사본 검사, 로그인 문, 대시보드, 자동 새로고침, 어드민 `apps.ts` 관제 주소
- 관제 작업 API(6719187): 실패 job 목록·다시 시도·지우기, Outbox 복구 sweep, `ops_action_log`(마이그레이션 `Migration20261029040404`), `GET /ops/actions`, `JOB_NOT_FAILED`, 접근 표 77 → 82
- Task 1 리뷰 반영(8b3f9a4): `withTimeout`·`OpsQueuesService.read`(2초, 503), 프로세스 상태 오류 글은 이름·코드만, 주기 작업 한 번에 읽기
- 관제 화면(ff00c08): 실패 job·주기 작업·최근 오류·작업 기록, 복구 sweep 단추
- Task 2·3 리뷰 반영(4af88d3): 지우기 경쟁 기록, 차단 목록 넓힘, 실패 이유 속 번호·이메일 가림, 대시보드 칸마다 오류, 실패 job 큐 이름 대체
- 마감(1c7e562): README, devlog, 회고
- 기록: decisions 0070~0076(새로), 0052·0062·0067 보탬, devlog `2026-10-29.md`의 `# 보강 6: 운영 관제 화면`(8항목), 공부거리 5줄, `docs/index.md`. troubleshooting·experiments 새 번호는 없다(devlog 12:48 항목이 이유를 적었다: 계획 단계에서 찾은 것이라 실행 중 에러가 아님)

## 확인한 것 (리뷰어가 직접)
- 지시에 따라 테스트·DB·Redis는 건드리지 않았다. 컨트롤러가 개발 서버를 띄워 둔 상태라 프로세스도 띄우지 않았다. 코드와 git 상태도 바꾸지 않았다(이 파일만 새로 생긴다)
- 실행한 것: `git log`·`git diff`·`git ls-files --eol`, `node scripts/docs-index.mjs --check`(`docs/index.md 최신`, exit 0)
- 테스트 수: 실행하지 않고 새 테스트 파일의 `it`을 셌다
  - api 새 파일 여섯: ops-status 5, ops-outbox-errors 4, ops-jobs 4, queue-metrics 5, job-data 6, ops-timeout 5 = 29개. 571 + 29 = 600, 83 + 6 = 89. README 표·devlog 13:37과 같다
  - Task별 증가도 맞는다: Task 1 +13(5+3+5) → 584, Task 2 +9(4+4+1) → 593, Task 1 리뷰 +5 → 598, Task 2·3 리뷰 +2 → 600
  - console: App 8(`it.each` 4 포함), copies 14(`it.each` 9 포함), query-keys 2, ErrorBox 3, labels 2, Dashboard 9, FailedJobs 8, ListPages 6 = 52, 파일 8. README·devlog와 같다
- devlog 제목 시각: 8곳 모두 커밋 시각과 분까지 같다(12:48·13:00·13:04·13:11·13:20·13:23·13:29·13:37). 2c0836c(author 13:00:48, committer 13:00:57)와 ff00c08(13:23:32 / 13:23:38)은 초만 다르다
- 이전 커밋 해시: 8곳 모두 실제 부모와 같다. Task 3(97b1789)이 Task 2(6719187)보다 먼저 커밋된 순서도 devlog가 적었다. 13:29 항목은 "97b1789 단독으로는 console typecheck·build가 실패한다"를 바로잡기로 남겼다
- 접근 표: `access-table.spec.ts`의 `EXPECTED` +10줄, 0052 표의 `OPS_VIEW`·MONITOR 두 줄, 0052 보탬 "72 → 77 → 82", 0070 결과, 스펙 3장이 서로 같다
- LF: 바뀐 파일 91개 모두 인덱스가 `i/lf`다. diff에 `\r`는 0개다. 작업 폴더의 `w/crlf` 15개와 `w/mixed` 2개는 `core.autocrlf` 체크아웃이라 저장소와는 상관없다
- 비밀 값(값은 출력하지 않고 개수만 셈): seed의 시연 비밀번호 7개, 시연 외부 업체 키 1개, `.env`의 `DEVICE_API_KEY`·MySQL root 비밀번호가 브랜치 diff에 0번 나온다. `.claude/launch.json`은 diff에 없다(gitignore)
- 실제 회사·지난 프로젝트 이름: 설계 메모 `02_B_경력기반_추가기능.md`의 이름과 흔한 업체 이름 몇 개를 찾았다. 걸린 것은 "갱신한다"의 부분 문자열과 lock 파일 해시뿐이고, 실제 이름은 0건이다. 대학 도메인(`ac.kr`·`.edu`)도 0건이다

## Critical
없음.

## Important

### 1. 최근 오류(`GET /ops/errors`)의 오류 글을 가리지 않는다. 알림 실패는 이 목록에만 나온다
- 위치
  - `apps/api/src/ops/ops-errors.service.ts:12`: `clip`은 500자로 자르기만 한다
  - 같은 파일 `:41`·`:48`·`:55`·`:62`: 네 출처 모두 `clip`을 쓴다
  - 비교 대상 `apps/api/src/ops/job-data.ts:43`(`shortReason`)
- 문제
  - 4af88d3는 "업체 오류 글에 수신자 번호·이메일이 섞일 수 있다"며 실패 job의 `failedReason`과 감사 기록 detail에서 전화번호·이메일 모양을 `[가림]`으로 바꿨다(0072 보탬)
  - 그런데 같은 글이 MySQL에도 남는다
    - 알림: `OutboxService.notify`가 `row.lastError = "${error.name}: ${error.message}"`를 쓰고, 그 값으로 `UnrecoverableError`를 던진다(`outbox.service.ts:214-217`). 즉 job의 failedReason과 Outbox `lastError`는 같은 글이다
    - 업체 오류 메시지에는 응답 본문 200자가 붙는다(`partner-http.ts`의 `` `${label} 응답 ${res.status}: ${body.slice(0, 200)}` ``)
  - 0072 범위 1에 따라 알림 notify·택배 추적 job은 `removeOnFail: true`라서 실패 job 화면에 나오지 않는다. 그 실패는 최근 오류 화면에서만 본다. 결국 가리기가 꼭 필요한 글이 바로 가리지 않는 쪽으로 나간다
  - 기록도 실제보다 넓게 말한다. 회고 "보강 6이 남긴 것"의 "실패 이유는 전화번호·이메일 모양만 가림"과 devlog 13:29의 "실패 이유는 가림(문서로만 두지 않음)"을 읽으면 최근 오류도 가린다고 이해하게 된다
  - 보는 사람이 관제·ADMIN뿐이고 지금 가상 업체 응답에는 개인정보가 없다. 그래서 Critical은 아니다. 다만 4af88d3가 막으려던 경로와 같은 경로다
- 수정
  - `job-data.ts`의 가리기를 `maskPii(text)`(EMAIL → PHONE 치환)로 떼어 내보낸다. `shortReason`과 `ops-errors.service.ts`의 `clip`이 둘 다 이 함수를 지난 뒤 자르게 한다(먼저 자르면 번호 반쪽이 남는다는 4af88d3의 순서 그대로)
  - 테스트: `ops-outbox-errors.e2e.spec.ts`의 "최근 업무 오류" it에 `lastError: 'PartnerPermanentError: 톡톡메신저 400 수신자 010-1234-5678'` 같은 행을 하나 더하고, 응답 message에 `[가림]`이 있고 번호가 없는지 단언한다
  - 기록: 0072 보탬에 "최근 오류의 네 출처 글도 같은 함수"를 한 줄 더하고, contracts `OpsErrorView.message` 주석(`packages/contracts/src/ops.ts:125`)에 "전화번호·이메일 모양은 가림"을 적는다

## Minor

### 1. 다시 시도·지우기·복구 sweep 앞의 확인 읽기에 시간 제한이 없다
- 위치: `apps/api/src/ops/ops-jobs.service.ts:88-95`(`failedJob`의 `getJob`·`getState`), `apps/api/src/ops/ops-outbox.service.ts:42`(`requeueStale` 안의 `getJobState`)
- 문제: 0071 보탬은 쓰기에 시간 제한을 걸지 않은 이유로 "제한 뒤에 작업이 끝나면 감사 기록 없이 바뀐다"를 든다. 쓰기 자체는 맞는 판단이다. 하지만 쓰기 앞의 확인 읽기는 아직 아무것도 바꾸지 않았다. Redis가 느리거나 죽으면 BullMQ 연결(ioredis 기본 `maxRetriesPerRequest` 20)에서 몇 분 기다린다. 그동안 화면 단추는 `isPending`으로 막혀 있다
- 수정: `failedJob`의 두 읽기를 `this.queues.read(…, 'job 확인')`으로 감싼다. 걸리면 503이 나고 아무것도 바뀌지 않는다. 복구 sweep은 `requeueStale` 안에서 읽기와 `addBulk`가 섞여 있어 그대로 두고, 0071 보탬에 "복구 sweep은 Redis가 죽으면 매달릴 수 있다"를 한 줄 적는다

### 2. 실패 job 화면에서 큐 고르기와 쪽이 엇갈린다
- 위치: `apps/console/src/pages/FailedJobsPage.tsx:81`(`start` 상태), `:91`(`selected` 계산), `:148`(빈 목록 문구)
- 문제
  - (a) 주소에 `?queue=`가 없으면 `selected`가 "실패가 있는 첫 큐"로 계산된다. 그 큐의 마지막 실패 job을 다시 시도하거나 지우면, 무효화 뒤 고른 큐가 말없이 다른 큐(또는 `names[0]`)로 바뀐다. 알림 문구는 앞 큐 이름을 말하는데 표는 다른 큐를 보인다. 이때 `start`도 0으로 돌아가지 않는다
  - (b) 둘째 쪽(start 20)에서 마지막 하나를 지우면 total이 20이 되고 items는 빈 배열이 된다. 그러면 "이 큐에 남은 실패 job이 없습니다"가 나오지만 앞쪽에는 20개가 남아 있다
  - (c) 메뉴 "실패 job"(NavLink `/failed`)을 다시 누르면 컴포넌트는 남고 `?queue=`만 빠진다. `start`는 그대로 남는다
- 수정: 작업이 성공하면 `setParams({ queue: job.queue })`로 큐를 주소에 고정한다. `start`를 큐 이름 key의 상태로 두거나 `selected`가 바뀔 때 0으로 돌린다. `page.items.length === 0 && page.start > 0`이면 앞 쪽으로 옮기거나 "앞 쪽으로" 단추를 보인다. 테스트는 (a)·(b) 하나씩 더하면 된다

### 3. 감사 기록 열 길이와 BullMQ 값 길이가 맞물리지 않는다
- 위치: `apps/api/src/ops/ops-action-log.entity.ts:40`(`jobName` varchar 50), `Migration20261029040404.ts`
- 문제: BullMQ job 이름에는 길이 제한이 없다. 다시 시도·지우기는 Redis 작업이 끝난 뒤 INSERT하므로(0073), 50자를 넘는 이름의 job이면 strict 모드 MySQL이 INSERT를 거절한다. 그러면 작업은 됐는데 기록이 없고 응답은 500이 된다. 지금 코드의 job 이름은 모두 짧아서 실제로 일어나지는 않는다
- 수정: `audit.record`에서 `jobName`·`jobId`를 열 길이로 자르거나(`slice(0, 50)`·`slice(0, 200)`), 0073 결과·대가에 "열 길이를 넘는 이름은 기록 실패"를 적는다. 자르는 쪽이 한 줄이라 더 낫다

### 4. contracts `OpsActionView.actorRole`이 `string`이다
- 위치: `packages/contracts/src/ops.ts:165`
- 문제: 같은 파일의 `action`·`queue`는 유니온 타입인데 `actorRole`만 `string`이다. 화면은 `a.actorRole`을 그대로 찍어서 지금은 문제가 없다. 다만 Shell의 `ROLE_LABEL`처럼 역할 이름표를 붙이면 타입 검사가 도와주지 못한다
- 수정: `actorRole: Role`(contracts `auth.ts`의 Role)로 바꾸고, `toOpsActionView`에서 `row.actorRole as Role`로 넘긴다. 기록 행은 그때의 역할 문자열이라, 역할 값이 나중에 바뀔 수 있다는 점을 주석에 남긴다

### 5. 컨트롤러 화면 확인이 아직 기록에 없다
- 위치: `docs/devlog/2026-10-29.md:200`의 "컨트롤러 확인: 대기"
- 문제: 보강 2~5 리뷰 때와 같은 형태다. 내장 브라우저 확인은 이 리뷰 뒤 컨트롤러가 한다
- 수정: 확인한 뒤 "받아 적은 것" 항목을 하나 덧붙인다(그 기록 커밋의 시각을 제목으로). 담을 것
  - 관제 로그인, 대시보드 카드·큐 표·Outbox, 실패 job 화면, 주기 작업, 최근 오류, 작업 기록
  - ADMIN으로 들어가면 단추 대신 안내가 보이는지
  - 콘솔·api 오류 로그
  - 무엇을 저장했는지(다시 시도·지우기·sweep을 눌렀다면 작업 기록 번호)
  - 13:37 항목의 "대기"가 이 항목을 가리키게 한다

### 6. 작은 것들(선택)
- (a) `apps/console/src/pages/ActionsPage.tsx:21`: `useInfiniteQuery`에 `refetchInterval`을 걸면, 10초마다 지금까지 펼친 모든 쪽을 차례로 다시 읽는다. "더 보기"를 여러 번 누른 채 띄워 두면 요청이 쪽 수만큼 는다. 하루 몇 건이라 지금은 괜찮다. 0076 결과·대가에 한 구절 적거나, 작업 기록만 간격을 길게 둔다
- (b) 스펙 7장의 console 테스트 수(대시보드 5, 실패 job 7 등)는 계획 때 값이다. 실제는 Dashboard 9·FailedJobs 8·ErrorBox 3이다. 스펙은 계획 때 문서라 그대로 두어도 되지만, 숫자를 고칠 곳은 README·devlog라는 것만 확인해 둔다(둘은 맞다)
- (c) CSRF: 새 POST 셋은 본문이 없다. 막는 것은 기존 방식 그대로 `SameSite=Strict` 세션 쿠키다. 다른 사이트에서 시작한 요청에는 쿠키가 붙지 않으므로 기존 쓰기 엔드포인트와 같은 수준이다. 다만 localhost의 다른 포트(가상 업체 :4010, 시뮬레이터 :4020 등)는 같은 사이트다. 이 한계는 회고 이월 "CSRF 토큰"에 이미 있다. 관제 작업은 되돌릴 수 없는 지우기가 들어 있어서, CSRF 토큰(또는 `Origin` 검사)을 다룰 때 우선 대상으로 이 셋을 적어 두면 좋다

## 잘된 점
- **역할이 서버·화면·테스트 세 곳에서 같다**
  - 서버: `OPS_VIEW = ADMIN·MONITOR`가 보기, `Role.MONITOR`만 작업이다. 기본 거부 접근 표가 10줄을 센다
  - 화면: `AuthGate`가 MONITOR·ADMIN만 들이고, `canOperate`가 MONITOR에게만 단추를 보인다. ADMIN에게는 안내가 나온다
  - 테스트: e2e가 ADMIN·운영자의 retry·remove·requeue 403, 운영자·현장의 보기 403, 로그인 없음 401을 본다. 화면 테스트도 ADMIN에게 단추가 없음을 본다
- **오류 글 유출을 막았다**
  - 프로세스 상태의 의존 오류는 `errorLabel`이 이름·코드만 보낸다. 호스트·포트가 든 메시지는 나가지 않는다
  - 503 문구에는 시간 제한 값만 있다
  - 경쟁 끝의 알 수 없는 오류는 Nest 기본 500("Internal server error")이다
  - 404 메시지에는 요청이 보낸 큐·job 이름만 들어간다. React가 글자로 그리므로 주입될 곳이 없다
  - 실패 job은 스택 없이 실패 이유 500자만 보낸다. data는 차단 목록으로 가리고 깊이·길이·개수를 자른다
- **BullMQ 동작을 미리 재 보고 코드에 근거를 남겼다**
  - `retry`의 시도 수 이어짐 → `resetAttemptsMade`·`resetAttemptsStarted`
  - `retry` 직후 `failedReason`이 비는 것 → 기록할 값을 먼저 읽는다
  - metrics의 "마지막 갱신 분은 data에 없음" → `recentCount`가 지금 시각으로 창을 자른다(단위 테스트 5개)
  - `waiting` 목록의 순서 → `asc=true`
  - 확인과 작업 사이의 경쟁은 상태를 다시 읽어 404·409로 바꾼다. 막지 못하는 지우기 경쟁은 주석·0072·0073·회고에 같은 말로 남겼다
- **Redis가 느리거나 죽어도 화면이 정직하다(8b3f9a4 → ff00c08 연결)**
  - 서버: 읽기는 2초 뒤 503을 낸다. 프로세스 상태는 redis `ok:false`와 빈 워커 목록으로 답한다
  - 화면: 그때 워커 수를 0이 아니라 "?"·"읽지 못함"으로 보인다. 마지막 값은 남기고 오류를 칸마다 보인다. 큐 요약을 못 읽으면 `Record<OpsQueueName, …>`로 둔 큐 이름 여섯으로 고르기를 채운다(큐가 늘면 tsc가 알린다)
  - 쓰기에 시간 제한을 걸지 않은 이유(감사 기록 없이 바뀌는 것)도 적었다. 앞 읽기는 Minor 1
- **contracts가 세 쪽을 묶는다**
  - `QueueName`·`OutboxStatus`·`OPS_ACTIONS`를 contracts 유니온과 단언한다(어긋나면 api tsc 실패)
  - 서비스 반환 타입이 contracts 타입이다. 화면 `ERROR_SOURCE_LABEL`·`ACTION_LABEL`·`OPS_QUEUE_NAMES`도 `Record<유니온, …>`이다
  - `contract-assertions.ts`가 "OutboxStatus는 내부 enum"이라던 주석을 실제에 맞게 고쳤다
- **읽기 비용을 의식했다**
  - 주간 리포트는 `exclude: ['file']`로 파일 열을 읽지 않는다
  - `sync_run`은 PK 범위 1만 행으로 묶었다(인덱스를 더하지 않은 이유도 0070에 있다)
  - Outbox는 `(status, id)` 인덱스로 센다
  - `CLIENT LIST` 비용, SENT가 계속 자라는 것도 0070 보탬에 적었다
- **기록이 정확하다**
  - devlog 제목 8/8이 커밋 시각과 같고, 이전 커밋 해시도 8/8 맞다
  - 테스트 수가 Task별 증가까지 맞는다(api 571 → 584 → 593 → 598 → 600, console 33 → 48 → 50 → 52). README·devlog·회고가 같은 숫자를 쓴다
  - 97b1789 단독 빌드 실패를 역사를 고치지 않고 바로잡기로 남겼다
  - 색인 `--check` 최신, 결정 수 76과 README가 같다
  - LF, 비밀 값, 작성자 주소, 실제 회사 이름 모두 깨끗하다
- **기존 테스트를 거의 건드리지 않았다.** 접근 표 +10줄, 어드민 관제 주소 기대값만 바뀌었다. 점주 사본 9개는 머리 주석 한 줄씩만 바뀌었다(사본 검사는 주석을 뺀 코드를 비교한다)

## 병합 판단
**병합 가능. 병합 전에 Important 1(최근 오류 글을 실패 이유와 같은 함수로 가리기, e2e 단언 하나, 0072·contracts 주석)을 고치길 권한다.** 코드 몇 줄과 테스트 하나라 작다. Minor 5(컨트롤러 확인 기록)는 컨트롤러 확인 뒤 같이 하면 된다. Minor 1~4는 한두 줄씩이라 같이 하면 좋고, 미뤄도 데이터나 권한을 깨지는 않는다. 6은 이월 목록으로 충분하다.
- 맞춰 본 것
  - 접근 표 82 = 0052 표·보탬 = 0070 = 스펙
  - contracts 단언 셋
  - devlog 시각·해시 8/8
  - 테스트 수(README = devlog = 새 `it` 개수)
  - 색인 `--check`
  - LF(인덱스 전부 `i/lf`)
  - 비밀 값 0, 작성자 8/8 noreply, 대학 이메일·실제 회사 이름 0
- 직접 하지 않은 것(지시에 따라): api·console 테스트와 tsc 실행, 개발·테스트 DB와 Redis 접근, 실서버 기동. 숫자는 devlog 13:37 항목과 새 테스트 파일을 맞대 확인했다
- 남는 이월(회고 "보강 6이 남긴 것"에 더할 것)
  - 이 리뷰의 Minor 1(쓰기 앞 읽기 시간 제한)
  - Minor 2(실패 job 화면 쪽·큐 상태)
  - Minor 6(a)(작업 기록 무한 쪽 다시 읽기)
  - Minor 6(c)(관제 작업을 CSRF 토큰 우선 대상으로)
