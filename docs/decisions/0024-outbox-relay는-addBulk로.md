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
- 결과·대가: addBulk는 여러 job을 한 번에 넣는다(BullMQ가 MULTI로 묶는다고 알려져 있다, 소스로 확인하지 않음). 중간 실패 시 일부만 들어갈 수 있는지는 확인하지 않았다(추정: 그래도 행은 롤백돼 PENDING으로 남고, 다음 relay가 같은 jobId로 다시 넣으므로 중복은 생기지 않는다).
- 다시 볼 조건: limit을 크게 올려 addBulk 한 번의 크기가 커질 때, Redis가 원격이 되어 왕복 시간이 달라질 때.
