# 0018. relay에서 device 큐 addBulk가 실패하면 project job이 영영 안 들어간다

- 날짜 / 관련 기능: 2026-10-23 / F8, F5 (Day 4 Task 4 리뷰 지적)
- 증상: 리뷰에서 relay 코드를 읽다 나온 지적(실행 중 발견이 아니라 코드 읽기). relay는 한 트랜잭션(READ COMMITTED) 안에서 notify addBulk(`outbox` 큐) → project addBulk(`device` 큐) 순서로 넣는다. 두 번째가 실패하면 활성 집합(active)에서 그 단말기가 빠진 채 다음 재구성(최대 60초)까지 하트비트가 IGNORED가 된다는 지적.
  - 확인용 테스트(`active-set.e2e.spec.ts` 'device 큐 addBulk가 실패해도…'): AC-0101을 IN_SERVICE까지 만든 뒤 device 큐 `addBulk`를 한 번만 throw하게 spy → relay(reject) → 큐가 빌 때까지 기다림 → relay를 PENDING이 없을 때까지 반복 → active에 AC-0101이 있어야 한다.
  - 고치기 전 결과: `[project 유실] 실패한 relay 뒤 IN_SERVICE 진입 행 30 상태=SENT`, 그리고 `expected null to be '…'`(active에 없음) → `Tests 2 failed | 5 passed (7)`(다른 하나는 아래 serialNo 검사 테스트).
- 가설: 실패한 relay가 롤백돼도 notify job은 이미 Redis에 들어가 있다. notify 워커가 그 행을 보내고 SENT로 바꾸면 다음 relay는 PENDING만 잡으므로 그 행을 다시 보지 않는다 → project job을 넣을 기회가 없다.
- 확인: 위 로그의 "상태=SENT"가 그대로 보여 준다. relay가 롤백된 뒤 notify가 행을 SENT로 썼고, 다음 relay는 0건을 잡았다(active 비어 있음). 경합 경우(롤백 전에 notify가 먼저 집는 경우)는 재현하지 않았다. 그때도 notify의 UPDATE가 relay의 행 락을 기다렸다가 롤백 뒤 커밋되므로 결과는 같다고 본다(추정, decisions/0024 "남는 것"과 같은 경로).
- 원인: 두 소비자 중 **멱등이 아닌 쪽의 기록(SENT)이 행을 relay 대상에서 빼는데**, 그 쪽 job을 먼저 넣었다. notify가 행 상태를 바꾸는 소비자라는 점을 Task 4에서 따지지 않았다.
- 해결: 이 커밋. relay가 project(멱등, MySQL의 지금 상태를 다시 읽음)를 **먼저**, notify를 나중에 넣는다. notify addBulk가 실패하면 트랜잭션이 롤백돼 행은 PENDING이고 notify job은 없으니(부분 삽입이면 일부는 있음, decisions/0024) 다음 relay가 둘 다 다시 넣는다. 먼저 들어간 project job은 jobId(`project-<outbox id>`)가 같아 아직 있으면 무시되고, 이미 처리돼 지워졌으면 한 번 더 돈다 — 지금 상태를 다시 읽으므로 결과가 같다.
  - 고친 뒤: `[project 유실] … 상태=PENDING`, active에 AC-0101 있음. 3번 돌려 3번 같음. Day 3 notify 부분 실패 테스트(`outbox.e2e.spec.ts` 'addBulk가 일부만 넣고 실패하면…')는 고치지 않고 그대로 통과(그 행들은 IN_SERVICE 진입·이탈이 아니라 device addBulk를 부르지 않는다. 의미도 같다: notify 실패 → 롤백 → 같은 jobId로 다시).
  - 같이 고친 것(같은 리뷰의 Minor): ① project job의 serialNo가 글자가 아니면 `ActiveSetService.apply`가 `UnrecoverableError`(재시도 없음). 고치기 전에는 `apply([123])`가 그냥 성공했다(`promise resolved "undefined" instead of rejecting`) — 숫자로 조회해 아무것도 못 찾고 HDEL만 함. 테스트는 큐에 payload `{}`인 project job을 넣어 `failed`, `attemptsMade 1`을 본다. 검사는 소비자 쪽에 두었다. relay(`changesActiveSet`)에서 throw하면 그 행 하나 때문에 relay 전체가 계속 실패한다(독이 든 행). ② `SchedulerService`가 주입되지 않은 큐를 만나면 `Cannot read properties of undefined` 대신 `주기 작업 <id>: 주입되지 않은 큐: <큐>` 오류(`test/unit/scheduler-guard.spec.ts`).
- 배운 것: 한 트랜잭션에서 외부 시스템 여러 곳에 쓸 때(여기서는 두 큐), 실패해도 되돌릴 수 없는 쪽이 생긴다. 순서는 "부작용이 되돌아오지 않는(행 상태를 바꾸는) 소비자를 마지막에"로 정한다 → study/backlog.md에 추가.
