# 보강 6 설계 — 운영 관제 화면

- 날짜: 2026-10-29
- 범위: 보강 6. 관제(MONITOR)·개발자가 시스템 상태를 보는 화면 `apps/console`과 그 화면이 부르는 `/ops` API. 통합 시연 준비의 다섯 번째 묶음이다(보강 2 로그인·역할, 3 매장, 4 현장, 5 통합 어드민 다음). 시연 시나리오 점검표(보강 5 스펙 2장)의 22번 "큐·outbox·주기 작업·오류 보기"를 채운다.
- 구현 계획: `docs/plans/2026-10-29-ops-console.md`
- 브랜치: `ops-console`(master 10a3f6c에서)
- 등장하는 회사·가맹점은 모두 가상이다. 시연 계정의 비밀번호는 `apps/api/src/db/seed-accounts.ts`의 로컬 시연 전용 값이고 이 문서에 적지 않는다.

## 1. 무엇을 왜

지금 시스템에는 BullMQ 큐 여섯 개(`track-bungae`·`track-neurimbo`·`carrier-sweep`·`outbox`·`device`·`report`), 주기 작업 열 개(`JOB_SCHEDULERS`), Outbox(PENDING/QUEUED/SENT/FAILED, 멈춘 QUEUED 복구 sweep — decisions/0042), 업무 오류 기록(수집 기록 `sync_run`의 ERROR, VAN 대조 실행 FAILED, 주간 리포트 `lastError`, Outbox FAILED)이 있다. 실패를 보려면 Redis(`redis-cli`)와 DB를 직접 봐야 하고, 실패한 job을 다시 돌리는 길은 없다. 어드민의 "다른 화면"에는 운영 관제가 "준비 중"으로 있다(decisions/0067).

목표:

1. 관제·ADMIN이 한 화면에서 큐(상태별 수·멈춤·최근 15분 처리량·가장 오래 기다린 job·워커 수), 프로세스·의존 상태(api 버전·기동 시각, MySQL·Redis 응답 시간, 워커 프로세스), Outbox(상태별 수·가장 오래된 PENDING/QUEUED), 주기 작업(주기·등록 여부·다음 실행), 최근 업무 오류를 본다. 띄워 두면 10초마다 새로 읽고, 탭이 안 보이면 멈춘다.
2. 관제(MONITOR)가 Redis에 남은 실패 job을 보고(data는 가려서) 다시 시도하거나 지우고, 멈춘 QUEUED 복구 sweep을 지금 한 번 돌린다. 이 세 작업은 누가·언제·무엇을 했는지 감사 기록으로 남고 화면에서 본다.
3. 서버 규칙은 기존 방식 그대로 — 접근 표(기본 거부), contracts 타입(enum 단언 포함), e2e. 새 표는 감사 기록 하나(`ops_action_log`)뿐이다.
4. 기존 테스트는 고치지 않는다(접근 표에 줄 더하기, 어드민 `apps.ts`의 관제 주소를 채우면서 그 기대값 넷만 바꾼다).

## 2. 구성

```
apps/api/src/ops/                       운영 관제(보강 6)
├─ ops.controller.ts                    GET /ops/queues·schedulers·system·outbox·errors·queues/:name/failed·actions, POST …/retry·…/remove·outbox/requeue
├─ ops-queues.service.ts                큐 요약·주기 작업·프로세스 상태(BullMQ getJobCounts·getMetrics·getWorkers·getJobSchedulers, MySQL select 1, Redis PING)
├─ queue-metrics.ts                     BullMQ 분 단위 metrics → 최근 N분 수
├─ ops-outbox.service.ts                Outbox 요약, 복구 sweep 수동 실행(OutboxService.requeueStale 그대로)
├─ ops-errors.service.ts                최근 업무 오류 — 기존 네 표를 읽어 합침(새 표 없음)
├─ ops-jobs.service.ts, job-data.ts     실패 job 목록(data 가리기)·다시 시도(시도 수 되돌림)·지우기
├─ ops-audit.service.ts, ops-action-log.entity.ts   감사 기록(새 표 ops_action_log)
apps/api/src/queue/worker-options.ts    모든 @Processor에 name(WORKER_NAME)·metrics(분 단위, 하루치)
packages/contracts/src/ops.ts           Ops* 응답 타입, OpsQueueName·OpsOutboxStatus·OpsActionKind(api 값과 단언), 오류 코드 JOB_NOT_FAILED
apps/console/                           운영 관제 화면(:5176·미리보기 4176) — 점주 앱 사본 9개 + 사본 검사, 새로 쓴 화면
├─ src/pages/DashboardPage.tsx          상태 카드·큐 표·Outbox 카드·복구 sweep 단추(관제)
├─ src/pages/FailedJobsPage.tsx         큐 고르기·실패 job 20개씩·자세히(data)·다시 시도·지우기(확인창, 관제)
├─ src/pages/SchedulersPage.tsx, ErrorsPage.tsx, ActionsPage.tsx
├─ src/lib/refresh.ts                   자동 새로고침(10초, 끄기 단추, 탭 숨김이면 멈춤)
apps/admin/src/apps.ts                  "다른 화면"의 운영 관제 주소 기본값 http://localhost:5176
```

## 3. API

| 엔드포인트 | 누가 | 응답 |
|---|---|---|
| `GET /ops/queues` | 관제·ADMIN | `OpsQueuesView` — 큐마다 waiting·active·delayed·prioritized·failed·completed, paused, oldestWaitingAt, completedRecent·failedRecent(최근 15분, 기록 없으면 null), workers |
| `GET /ops/schedulers` | 관제·ADMIN | `OpsSchedulerView[]` — 코드 목록 순서 + Redis에만 있는 것(defined false), every 또는 pattern·tz, registered, nextRunAt |
| `GET /ops/system` | 관제·ADMIN | `OpsSystemView` — api(version·startedAt·node·queuePrefix·runWorkers·runSchedulers), mysql·redis(ok·latencyMs·error), workers(queue·name·idleSeconds) |
| `GET /ops/outbox` | 관제·ADMIN | `OpsOutboxView` — 상태별 수, oldestPendingAt·oldestQueuedAt, requeueAfterMs |
| `GET /ops/errors?limit=` | 관제·ADMIN | `OpsErrorView[]` — SYNC_RUN·VAN_RUN·WEEKLY_REPORT·OUTBOX를 시각 순으로(기본 30, 최대 100) |
| `GET /ops/queues/:name/failed?start=&limit=` | 관제·ADMIN | `OpsFailedJobsPage` — 최근 실패부터, data는 이름으로 가리고 자름, 없는 큐 404 |
| `POST /ops/queues/:name/jobs/:id/retry` | 관제 | `OpsJobActionResult` — 시도 수를 0으로 되돌려 다시 대기열로, 감사 기록. 없음 404, 실패 상태 아님 409 `JOB_NOT_FAILED` |
| `POST /ops/queues/:name/jobs/:id/remove` | 관제 | `OpsJobActionResult` — Redis에서 지움, 감사 기록. 404·409 같음 |
| `POST /ops/outbox/requeue` | 관제 | `OpsRequeueResult` — 주기 작업 outbox-requeue와 같은 일을 지금 한 번(checked·requeued), 감사 기록 |
| `GET /ops/actions?beforeId=&limit=` | 관제·ADMIN | `BeforeIdPage<OpsActionView>` — 감사 기록 최근부터 |

엔드포인트 수 72 → 82(접근 표 테스트가 센다). 운영자·현장 작업자·가맹점주는 모두 403. 모두 그때그때 읽는다(캐시 없음).

## 4. 화면 (`apps/console`, :5176)

| 경로 | 내용 |
|---|---|
| `/login` | 관제·ADMIN 로그인(같은 `POST /auth/login`). 다른 역할이면 안내와 로그아웃만 |
| `/` 대시보드 | 상태 카드(api·MySQL·Redis·워커 프로세스 — 워커 0이면 경고), 큐 표(남은 실패 수 → 실패 job 링크, 워커 0·최근 실패 빨강, 멈춤 표시), Outbox 카드(상태별·가장 오래된 PENDING/QUEUED "N분 전"), 관제만 "멈춘 QUEUED 복구 sweep 지금 실행"(확인창) |
| `/failed?queue=` 실패 job | 큐 고르기(기본: 실패가 있는 첫 큐), 20개씩(이전·다음), 자세히(data·넣은 시각), 관제만 다시 시도·지우기(확인창), 409·404면 안내 + 목록 다시 읽기 |
| `/schedulers` 주기 작업 | id·큐/job·주기("2초마다"·cron + 시간대)·등록 여부·다음 실행, 코드에 없음 표시 |
| `/errors` 최근 오류 | 시각·출처·무엇·오류 글 30건 |
| `/actions` 작업 기록 | 시각·누가(아이디·역할)·작업·대상·그때 사정, 더 보기 |

위 막대: 앱 이름·메뉴 다섯·"자동 새로고침 10초 · 켜짐/꺼짐" 단추·내 이름·로그아웃. 각 화면 위 "마지막 갱신 … KST". 다시 읽다 실패하면 마지막 값을 두고 오류를 함께 보인다.

## 5. 결정(계획의 Task가 쓴다)

- 0070 운영 관제 API 모양 — `/ops` 아래, 보기 관제·ADMIN(OPS_VIEW)·작업 관제만, 그때그때 읽기(캐시 없음), 실패 목록은 offset(start·limit), 관제 작업은 POST, 최근 오류는 새 표 없이 기존 네 기록을 합침(수집 기록은 최근 1만 행 안에서)
- 0071 워커가 살아 있나는 BullMQ 워커 연결(`getWorkers` — Redis CLIENT LIST)과 연결 이름(`WORKER_NAME`), 처리량은 워커 metrics(분 단위, 하루치)
- 0072 실패 job은 Redis에 남은 것만 보이고, data는 이름 차단 목록으로 가리고 자르며, 다시 시도는 시도 수를 0으로 되돌린다
- 0073 관제 작업 감사 기록은 새 표 `ops_action_log`(성공한 작업만, 쌓기만)
- 0074 운영 관제 화면은 별도 앱 `apps/console`(어드민 안 MONITOR 메뉴가 아니라)
- 0075 네 번째 화면 앱도 점주 앱 사본 + 사본 검사(공유 패키지·workspaces는 따로 한 묶음으로)
- 0076 자동 새로고침은 10초, 탭이 안 보이면 멈추고, 위 막대 단추로 끈다(저장 안 함)
- 0052 보탬(72 → 77 → 82), 0062 보탬(네 번째 사본), 0067 보탬(관제 주소)

## 6. 범위 밖

- 큐 멈춤·재개, 실패 job 한꺼번에 다시 시도·지우기, job 로그 보기 — 하나씩 다시 시도·지우기만(시연에 충분)
- 끝나면 지우는 job(`removeOnFail: true` — 알림·택배 추적·주간 리포트 수동 보내기)의 실패를 Redis에 남기기 — 업무 기록(최근 오류)으로 본다(0072)
- 이상 단말기 찾기 실행 기록(표가 없다 — Redis 잠금만), 지표 시계열 그래프·알림(임계치 넘으면 메신저) — 지금은 표와 "N분 전"만
- 워커 하트비트 키(0071에서 버림), 앱 버전 자동 채우기(APP_VERSION env를 Docker 묶음 보강 9가 넣는다)
- 쿠키 공유(localhost 포트가 달라도 `sid` 하나) — 기존 앱과 같은 한계, 화면 안내만
- 브라우저 자동 테스트 — 화면 확인은 컨트롤러가 내장 브라우저로

## 7. 테스트

- api(계획 Task 1·2): `test/ops-status.e2e.spec.ts`(5) — 큐 요약(멈춘 큐·waiting 2·delayed·워커), 최근 15분 metrics(지워진 job도 셈·실패), 주기 작업(미등록·Redis 값·코드에 없는 것), 프로세스 상태, 역할. `test/ops-outbox-errors.e2e.spec.ts`(3 → 4) — Outbox 요약, 최근 오류 순서, 역할, 복구 sweep(관제만·같은 jobId·감사). `test/ops-jobs.e2e.spec.ts`(4) — 실제 워커로 실패를 만들어 목록·가리기·쪽, 다시 시도(관제만·시도 수 되돌림·409·404), 지우기, 감사 기록. 단위 `queue-metrics.spec.ts`(5), `job-data.spec.ts`(4). 접근 표 +10줄
- console Vitest + Testing Library(가짜 fetch): 사본 검사(14), 오류 안내(2), 쿼리 키(2), 로그인 문·틀(8), 대시보드(5)·자동 새로고침(2), 주기 글자(2), 실패 job(7), 주기 작업·최근 오류·작업 기록·복구 sweep(6)
- admin: `apps.test.ts`·`Layout.test.tsx`의 관제 주소 기대값(수는 그대로)
- 실서버(계획 Task 5): 테스트 DB에 migrate·seed, api(:3200, `RUN_WORKERS=0`) + 워커 프로세스(`WORKER_NAME=opsx-worker`, `RUN_SCHEDULERS=1`) + 관제 개발 서버(:5276) — 모두 `QUEUE_PREFIX=opsx-live` — 관제 로그인 → 큐 요약·프로세스·주기 작업·Outbox·최근 오류 → report 큐에 실패 job 하나 넣기 → 실패 목록(가림) → 다시 시도 → 지우기 → 복구 sweep → 작업 기록 → 로그아웃
