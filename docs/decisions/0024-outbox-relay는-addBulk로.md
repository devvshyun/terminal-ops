# 0024. outbox relay는 잡은 행을 addBulk 한 번으로 큐에 넣는다

- 날짜 / 관련 기능: 2026-10-23 / F5 (Day 3 Task 10, Day 2 리뷰 Minor 3)
- 상황: relay는 PENDING 행을 `FOR UPDATE SKIP LOCKED`로 잡은 채(READ COMMITTED, troubleshooting/0007) 행마다 Redis `queue.add`를 했다. 행 락을 쥐는 시간이 "행 수 × Redis 왕복"이다. Day 3 일괄 등록·박스 스캔으로 한 요청에 수백 행의 Outbox가 생긴다.
- 선택지:
  1. 그대로 행마다 add: 단순하다. 락 시간이 행 수에 비례한다.
  2. **addBulk 한 번**: Redis 왕복 1번. jobId 중복 무시는 add와 같다(계획 사전 검증: 이미 있는 `outbox-1`을 다시 addBulk하면 waiting 수가 늘지 않음).
  3. 먼저 QUEUED로 커밋하고 트랜잭션 밖에서 add: 락 시간은 0이지만 커밋 뒤 add 전에 죽으면 job 없는 QUEUED가 남는다(decisions/0016에서 버린 선택지).
- 결정: 2. 실험 0006 D(outbox 1,000행, limit 100, 10회 relay, 기본 순서 3회 + 순서 바꿈 2회): relay 1회 최대 시간 each 52 ~ 103ms → addBulk 15 ~ 34ms, 전체 each 510 ~ 567ms → addBulk 120 ~ 158ms. 순서를 바꿔도 addBulk가 짧았다. 넣은 job 수는 둘 다 1,000.
  - 비교용으로 `relay(limit, { enqueue: 'each' })`를 남긴다. 운영 경로(스케줄러·워커)는 쓰지 않는다.
  - 잡은 행이 0이면 addBulk를 부르지 않는다.
  - 테스트: `test/outbox.e2e.spec.ts` 'relay는 잡은 행을 addBulk 한 번으로…'(add 0번, addBulk 1번, jobId가 잡은 순서 그대로). gap 락·SKIP LOCKED 테스트는 멈춤 지점을 addBulk로 옮겼다. 고치기 전 `3 failed | 6 passed`(addBulk 0번, 멈춤 지점에 닿지 않아 30초 타임아웃 2개) → 고친 뒤 9 passed, `[relay 중 쓰기] 등록 201 10ms, 전이 200 12ms`, `[SKIP LOCKED] 둘째 relay 7ms`.
- 결과·대가: addBulk는 여러 job을 Redis 왕복 한 번에 넣지만 **원자적이지 않다**.
  - 정정(2026-10-23, 리뷰 지적): 처음에 "BullMQ가 MULTI로 묶는다고 알려져 있다(확인하지 않음)"고 적었는데 틀렸다. BullMQ 6.4.0 `RedisQueueBackend.addJobs`(`node_modules/bullmq/dist/cjs/classes/redis-queue-backend.js` 483~500행)는 `client.pipeline()`에 job마다 추가 명령을 쌓고 `exec()`한 뒤, 결과 중 하나라도 오류가 있으면 throw한다. pipeline은 명령을 한 번에 보낼 뿐 MULTI/EXEC가 아니라서, 앞쪽 job은 들어가고 뒤쪽에서 실패할 수 있다(부분 삽입). 바로 아래 주석의 "flow 전체를 원자적으로 넣는다(MULTI)"는 `addBulk`가 아니라 flow 쪽 이야기다.
  - 그래도 안전한 이유(테스트로 확인): ① addBulk가 throw하면 relay 트랜잭션이 롤백돼 잡은 행이 모두 PENDING으로 남는다. ② 다음 relay가 같은 행을 같은 jobId(`outbox-{id}`)로 다시 넣고, 이미 들어간 job은 BullMQ가 jobId로 무시한다. ③ notify는 SENT·FAILED 행을 건너뛰고 메신저는 멱등키로 거른다(decisions/0016).
  - 테스트 `outbox.e2e.spec.ts` 'addBulk가 일부만 넣고 실패하면…': 큐를 멈추고, 진짜 addBulk로 앞 절반(6건 중 3건)만 넣은 뒤 throw하는 spy(실제 pipeline 오류를 일으킨 것은 아니고 그 결과 모양을 흉내 냄). 결과 3회 같음: `[addBulk 부분 실패] 큐에 남은 job=["outbox-42","outbox-43","outbox-44"] 행 상태=["PENDING",…×6]` → 다시 relay 뒤 job 6개(각 jobId 한 번) → 큐를 다시 돌리면 톡톡 수신이 키마다 1, 행 6개 모두 SENT. relay에서 jobId를 빼고 돌리면 `expected [ '1', '2', '3' ] to deeply equal [ 'outbox-1', … ]`로 실패하는 것도 확인(원복함).
  - 남는 것(추정, 재지 않음): 부분 삽입된 job을 워커가 relay 롤백 전에 집으면 notify가 아직 PENDING인 행을 보낸다. notify의 flush는 relay가 쥔 행 락을 기다렸다가 롤백 뒤 SENT로 쓰고, 그 행은 PENDING이 아니라 다음 relay가 잡지 않는다. 보내는 횟수는 여전히 최소 한 번 + 멱등키 범위 안이다.
- 다시 볼 조건: limit을 크게 올려 addBulk 한 번의 크기가 커질 때, Redis가 원격이 되어 왕복 시간이 달라질 때.
