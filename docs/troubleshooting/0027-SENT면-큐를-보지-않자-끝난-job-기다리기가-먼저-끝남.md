# 0027. SENT면 큐를 보지 않게 하자 "job 끝" 기다리기가 job보다 먼저 끝남

- 날짜 / 관련 기능: 2026-10-27 / F11 (테스트, Task 1 리뷰 반영)
- 증상: Task 1 리뷰 반영(GET `/reports/weekly/:weekStart`가 `status === SENT`면 Redis를 보지 않고 `queued: false`) 뒤 `weekly-report-async.e2e.spec.ts` 하나만 돌리면 `6 passed`인데, api 전체 실행(`npx vitest run`)에서는 둘이 실패했다.
  ```
  FAIL  test/weekly-report-async.e2e.spec.ts > … > POST는 행을 만들고 job을 넣어 바로 202 { queued: true }, 처리기가 보내면 GET이 SENT·queued false
  AssertionError: expected Job{ …(22) } to be undefined
  + Received:
  Job {
    "attemptsMade": 0,
    "attemptsStarted": 1,
  …
  FAIL  test/weekly-report-async.e2e.spec.ts > … > 이미 보낸 주는 job 없이 200 { alreadySent: true }
  AssertionError: expected { waiting: +0, active: 1, delayed: +0 } to deeply equal { Object (waiting, active, ...) }
   Test Files  1 failed | 60 passed (61)
        Tests  2 failed | 417 passed (419)
  ```
- 가설:
  1. 다른 테스트 파일이 남긴 report job이 섞였다.
  2. 테스트 도우미 `settled`가 job이 끝나기 전에 돌아온다 — 처리기가 행을 SENT로 쓴 뒤 job이 지워지기까지 틈이 있다.
- 확인:
  - 실패한 첫 테스트가 받은 Job은 `attemptsStarted: 1`, `attemptsMade: 0` — 바로 이 주(2026-10-19)의 job이 처리 중(active)이다. 둘째 테스트의 `active: 1`도 같은 job으로 본다(둘째 테스트는 새 job을 넣지 않는다 — 200 alreadySent). 가설 1은 다른 job이라는 근거가 없어 기각(같은 jobId를 getJob으로 받았다).
  - 코드 순서(확인): 처리기 `process()` 안에서 `WeeklyReportService.send()`가 `nativeUpdate(… SENT …)`를 끝낸 뒤 `get()`으로 다시 읽고 로그를 남기고 반환한다. BullMQ는 `process()`가 반환한 다음에 job을 완료로 옮기고 `removeOnComplete`로 지운다. 그 사이 GET은 행이 SENT라 큐를 보지 않고 `queued: false`를 주므로, `queued === false && status === 'SENT'`만 보던 `settled`가 돌아온다 → 가설 2.
  - 리뷰 반영 전에는 GET이 SENT여도 job 상태를 봐서 active면 `queued: true`였기 때문에 `settled`가 job이 지워질 때까지 기다렸다. 단독 실행에서 통과한 것은 틈이 짧아서로 본다(추측 — 단독 3번 모두 통과, 전체에서만 재현. 틈의 길이는 재지 않았다).
- 원인: API의 뜻이 바뀌었다 — `queued`는 이제 "행이 아직 보내지지 않았고 job이 남았다"이다. SENT 뒤 job이 마무리되는 몇 ms는 `queued: false`로 보인다(전체 실행처럼 부하가 크면 active로 남은 시간이 몇 ms를 넘었을 수 있다 — 길이는 재지 않았다). 화면에는 문제 없다(SENT는 끝난 상태다). 테스트가 "job이 지워졌다"까지 `queued`로 추론한 것이 틀렸다.
- 해결: `settled`가 행 조건에 더해 `reportQueue.getJob(jobId)`가 없어질 때까지 기다린다(`weekly-report-async.e2e.spec.ts`). 코드(SENT면 Redis 생략)는 그대로 둔다. 고친 뒤 단독 3번 `6 passed`, 전체 실행 결과는 devlog 2026-10-27의 리뷰 반영 항목.
- 배운 것: 상태 조회를 줄이는 지름길(SENT면 큐를 안 본다)은 "끝남"의 정의를 바꾼다. 테스트가 그 값으로 다른 자원(job 삭제)의 상태까지 추론하고 있었는지 본다.
