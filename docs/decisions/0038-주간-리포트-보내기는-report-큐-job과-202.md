# 0038. 주간 리포트 보내기는 report 큐 job과 202

- 날짜 / 관련 기능: 2026-10-27 / F11, F4 (Day 5 최종 리뷰 Minor 6)
- 상황: `POST /reports/weekly`는 동기였다. 톡톡 호출 4단계 × 재시도·Retry-After로 최악 약 10.6분(`weeklyReportLockTtlMs`) HTTP 요청이 열려 있다. 어드민 화면(Vite 프록시 → api)에서 부르면 브라우저·프록시 타임아웃에 걸리고, 운영자는 결과를 모른 채 다시 누른다.
- 선택지:
  1. 동기 유지 + 타임아웃 늘림 — 화면이 수 분 멈춘다.
  2. **report 큐 job + 202, 상태는 GET(VAN 대조와 같은 모양)**
  3. 별도 "보내기 요청" 표 + 폴링 — 이미 주마다 한 행(`weekly_report`)이 상태를 들고 있어 겹친다.
  4. SSE·웹소켓으로 진행 알림 — 이번 범위에 과함.
- 결정: 2.
  - 요청(`WeeklyReportService.request`)은 검증(400 `INVALID_WEEK_START`·422 `WEEK_NOT_ENDED`)과 행 만들기까지 하고 job `weekly-report-send { weekStart }`를 넣는다. 이미 SENT면 job 없이 200 `{ alreadySent: true, queued: false }`, 넣었으면 202 `{ queued: true }`.
  - jobId `weekly-report-send-<주>`라 대기 중에 다시 눌러도 하나(BullMQ는 같은 jobId를 더 넣지 않는다 — `weekly-report-async.e2e`에서 큐를 멈추고 두 번 눌러 waiting 1로 확인).
  - job은 재시도 없음(`attempts: 1`) — 실패는 행의 `lastError`로 보이고 운영자가 다시 누르면 저장된 파일로 이어서 보낸다. 끝난 job은 지운다(`removeOnComplete`·`removeOnFail` — 남아 있으면 같은 jobId를 다시 넣을 수 없다).
  - 같은 주를 주기 job이 보내는 중이면(409 `WEEKLY_REPORT_IN_PROGRESS`) 처리기가 건너뛴다(그쪽이 끝낸다). 영구 오류는 `UnrecoverableError`, 일시 오류는 그대로 던진다(재시도 옵션이 없어 어느 쪽이든 한 번으로 끝난다).
  - `GET /reports/weekly/:weekStart`가 `queued`(job 상태 waiting·active·delayed·prioritized·waiting-children)를 줘서 화면이 그동안 다시 읽는다.
- 이상 찾기 `POST /anomaly-scans`는 동기 200 유지: 실험 0011에서 단말기 10만 기준 찾기 전체 1.2초(첫 실행)·0.8초. 202로 바꾸면 실행 상태를 둘 곳(표나 job 결과)이 새로 필요하다.
- 결과·대가: report 큐(concurrency 1)에 긴 VAN 대조가 있으면 보내기가 그 뒤에 선다(화면은 "대기열"). 응답 코드가 200(이미 보냄)·202(넣음) 둘이다. 기존 주간 리포트 e2e는 보내기 동작 자체를 서비스 `send`로 직접 보고(예전 HTTP 응답 모양으로 바꿔 기대값 유지), HTTP 경로(202 → job → SENT)는 `weekly-report-async.e2e.spec.ts`가 워커를 켜고 본다.
- 보탬(Task 1 리뷰 반영):
  - 워커가 없으면 job이 waiting에 남는다. 운영 전제는 api의 `RUN_WORKERS` 또는 따로 띄운 워커 프로세스다. 그래서 `GET /reports/weekly/:weekStart`가 대기·처리 중일 때 `queuedAt`(job을 넣은 시각 `job.timestamp`, ISO)을 준다 — 화면은 "N분째 대기"를 보여 주고, 대기 중에는 지난 실패의 `lastError`를 숨긴다(Task 8). POST 응답의 `queuedAt`은 null이다(화면은 POST 뒤 GET으로 다시 읽는다). 이미 SENT인 주는 GET이 Redis를 보지 않는다(SENT 뒤로는 job을 넣지 않으므로 `queued: false` 확정).
  - active(처리 중)일 때 다시 눌러도 같은 jobId라 BullMQ가 새 job을 넣지 않는다 — 그 요청은 202 `queued: true`로 끝나지만 실제로는 처리 중인 job 하나뿐이다. 그 job이 실패하면 다시 눌러야 한다. 허용 근거: 처리 중인 job이 같은 주를 같은 파일로 보내고 있어, 두 번째 job이 할 일이 없다(성공이면 alreadySent, 실패면 운영자가 lastError를 보고 다시 누른다).
  - 같은 주를 주기 job이 잠그고 있으면(409 `WEEKLY_REPORT_IN_PROGRESS`) 수동 job은 아무것도 보내지 않고 `skipped`로 성공 처리한다. 허용 근거: 잠근 쪽이 같은 주를 끝까지 보내고(실패하면 주기 job의 재시도), 결과는 같은 행(SENT·lastError)에 남아 화면이 GET으로 본다. 수동 job이 실패로 끝나면 보낸 적 없는 오류가 남아 오히려 헷갈린다.
- 다시 볼 조건: 이상 찾기가 수 초를 넘기면(단말기 수십만) 같은 모양으로 바꾼다. 여러 주를 한 번에 보내야 하면 요청 하나에 job 여러 개.
