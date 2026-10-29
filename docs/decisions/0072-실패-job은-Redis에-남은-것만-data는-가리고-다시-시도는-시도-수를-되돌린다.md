# 0072. 실패 job은 Redis에 남은 것만 보이고, data는 이름으로 가리고, 다시 시도는 시도 수를 되돌린다

- 날짜 / 관련 기능: 2026-10-29 / 보강 6, F3·F5·F9·F11, 운영 관제
- 상황: 관제 화면이 실패한 job을 보여 주고 다시 시도·지우기를 해야 한다. 세 가지를 정한다. (1) 무엇이 보이나: 이 시스템의 job 옵션은 큐마다 다르다 — 알림 notify·project(`removeOnFail: true`, 0016), 택배 추적(`removeOnFail: true`), 주간 리포트 수동 보내기(`removeOnFail: true`, 0038)는 실패하면 Redis에서 사라지고, 주기 작업 job(`removeOnFail: 100`)과 VAN 대조 job(`removeOnFail: 100`)만 남는다. (2) data를 그대로 보여도 되나. (3) 다시 시도의 의미.
- 사전 검증(BullMQ 6.4.0, 테스트 접두사 probe): `attempts: 2`로 두 번 실패한 job에 `job.retry('failed')`만 하면 시도 수가 이어진다 — 한 번만 더 돌고 실패로 끝났다(`attemptsMade` 2 → 3). `retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true })`면 두 번을 다시 다 돌았다(다시 실패 뒤 `attemptsMade` 2). 완료된 job을 `retry`하면 `Job 3 is not in the failed state. reprocessJob`, 이미 다시 시도해 키가 바뀐 job은 `Missing key for job 2. reprocessJob`으로 던진다. `retry` 직후 그 job 객체의 `failedReason`은 null로 비었다 — 감사 기록에 남길 값은 그 전에 읽는다. 지금 큐에 들어가는 data는 id·시리얼·주 시작일뿐이다(`{ shipmentId }`, `{ outboxId }`, `{ serialNo }`, `{ runId }`, `{ weekStart }`, `{}`).
- 선택지(보이는 범위):
  1. **Redis에 남은 실패만, 지워지는 job의 실패는 업무 기록으로**(Outbox FAILED·수집 기록 ERROR·주간 리포트 lastError — `GET /ops/errors`, 0070) — job 옵션을 바꾸지 않는다
  2. 모든 job을 `removeOnFail: { count: N }`으로 바꿔 Redis에 남기기 — 알림 복구 sweep(0042)이 "job이 없으면(unknown) 다시 넣기"에 기대고 있어 실패한 notify가 남으면 그 행을 다시 넣지 못한다. 수동 보내기는 같은 jobId를 다시 넣을 수 없게 된다(0038)
- 선택지(data):
  (a) 그대로 — 지금은 비밀이 없지만, 관제 화면은 "Redis에 든 것을 보여 주는 창"이 되기 쉬워 나중에 누가 data에 값을 더하면 그대로 샌다
  (b) **이름 차단 목록으로 가리고 자른다** — 키 이름에 `pass·secret·token·key·auth·cookie·session·phone·email·card·account·address`가 들어가면(대소문자 무시, 깊이 상관없이) `[가림]`, 글자 100자·목록 20개·깊이 4까지. 새 job을 더할 때 이 파일을 고치지 않아도 된다
  (c) 큐·job 이름마다 보일 키 허용 목록 — 가장 안전하지만 job을 더할 때마다 고쳐야 하고, 빠뜨리면 아무것도 안 보여 관제가 원인을 못 본다
- 선택지(다시 시도): 시도 수를 이어 가기 / **0으로 되돌리기**
- 결정: 범위 1, data (b), 다시 시도는 0으로 되돌린다 — 관제가 원인을 고친 뒤(업체 복구 등) 누르는 것이라 job의 재시도 규칙(attempts·backoff)이 처음부터 다시 적용돼야 한다. 다시 시도·지우기는 지금 `failed`인 job만 — 없으면 404, 다른 상태면 409 `JOB_NOT_FAILED`. 확인과 동작 사이에 다른 사람이 먼저 처리하면 BullMQ가 던지는데, 그때 상태를 다시 읽어 404·409로 바꾼다. 실패 이유는 500자까지(외부 업체 응답 본문이 길게 붙는다), 스택은 보내지 않는다.
  - 다시 시도가 안전한 이유: 남는 job은 주기 작업(같은 일을 다음 주기에도 한다)과 VAN 대조(`execute`가 RUNNING이 아닌 실행은 다시 하지 않는다 — `van-reconciliation.service.ts`)뿐이다
- 결과·대가: 알림·택배 추적 job의 실패는 실패 job 화면에 없다(최근 오류 화면에 업무 기록으로). 차단 목록이라 이름이 애매한 값(`note`에 전화번호를 넣는 등)은 못 거른다. `key`를 포함하는 이름(`idempotencyKey` 등)은 비밀이 아니어도 가려진다(지나치게 가리는 쪽).
- 다시 볼 조건: job data에 사람 정보가 들어가야 하면 (c) 허용 목록으로. 지워지는 job의 실패를 job 단위로 다시 시도해야 하면 그 큐만 `removeOnFail: { age }`로 남기고, 0042의 "unknown이면 다시 넣기" 조건을 "unknown 또는 failed"로 함께 바꾼다.
