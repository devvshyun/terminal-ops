# 0016. 알림은 Outbox로, 보장 수준은 최소 한 번 + 멱등키

- 날짜 / 관련 기능: 2026-10-22 / F5
- 상황: 상태가 바뀌면 메신저로 알려야 한다(F5, "유실·중복 없이"). 전이 트랜잭션 안에서 메신저를 부르면 메신저가 느릴 때 락을 오래 잡고, 커밋 후에 부르면 그 사이 프로세스가 죽을 때 알림이 사라진다.
- 선택지:
  1. 커밋 후 바로 HTTP 호출: 단순하지만 유실된다.
  2. 커밋 후 바로 큐에 add: Redis add 전에 죽으면 유실된다(DB와 Redis는 한 트랜잭션이 아니다).
  3. Outbox: 같은 트랜잭션에 `outbox_event(PENDING)`를 기록하고, relay가 나중에 큐로 옮긴다. 커밋됐으면 알림 기록도 반드시 있다.
- 결정: 3.
- relay: `FOR UPDATE SKIP LOCKED`(MikroORM `LockMode.PESSIMISTIC_PARTIAL_WRITE`)로 PENDING을 최대 N건 잠그고 notify job(`jobId: outbox-<id>`)을 넣은 뒤 QUEUED로 바꾼다. relay 여러 개가 같은 행을 잡지 않는다(테스트로 확인: relay 4개가 5건씩 동시에 잡아 `[5,5,5,5]`, 겹침 없음, 3회 같음. 이 테스트는 겹치지 않는다는 것만 보여 준다. 다른 relay가 쥔 행을 기다리지 않고 건너뛰는 것(SKIP LOCKED의 실제 효과)은 'SKIP LOCKED' 테스트(`다른 relay가 행을 잡고 있으면 기다리지 않고 다음 행을 잡는다`)로 확인). Redis add 뒤 커밋 전에 죽으면 행은 PENDING으로 남아 다시 relay되지만, job이 아직 있으면 jobId가 같아 중복으로 들어가지 않는다.
- relay 트랜잭션은 **READ COMMITTED**로 연다(`em.transactional(cb, { isolationLevel: IsolationLevel.READ_COMMITTED })`, 2026-10-22 Task 8 리뷰). MySQL 기본(REPEATABLE READ)이면 PENDING이 limit보다 적을 때 잠금 읽기가 `(status, id)` 인덱스의 다음 레코드·supremum까지 next-key(gap) 락을 건다. 새 `('PENDING', 새 id)` 행이 들어갈 자리가 바로 거기라, relay가 Redis add를 하는 동안 모든 전이·등록 트랜잭션이 단말기 X 락을 쥔 채 멈췄다(재현·근거 troubleshooting/0007). READ COMMITTED에서는 잠금 읽기가 찾은 행에만 레코드 락을 걸고 gap 락을 걸지 않는다. relay가 하는 일은 "PENDING 행을 잡아 QUEUED로 바꾸기"뿐이라 팬텀(그사이 새로 생긴 PENDING)은 다음 relay가 가져가면 되고, 같은 트랜잭션 안에서 같은 조회를 반복하지 않으므로 RR의 반복 읽기 보장이 필요 없다. 버린 선택지: 트랜잭션 안에서 Redis add를 하지 않고 먼저 QUEUED로 커밋한 뒤 add — 커밋 뒤 add 전에 죽으면 job 없는 QUEUED가 생겨 아래 한계가 커진다. `addBulk`로 add 왕복을 줄이는 것은 이번에 하지 않았다(gap 락이 없어지면 relay가 쥔 것은 자기가 잡은 행뿐이라 급하지 않음).
- 보장 수준: **최소 한 번 + 멱등키**. 메신저가 받은 뒤 SENT를 쓰기 전에 죽으면 다시 보낸다. 메신저가 `idempotencyKey`로 걸러야 "한 번"이 된다. 정확히 한 번이라고 쓰지 않는다.
- FK를 두지 않은 이유: outbox INSERT가 단말기 행에 S 락을 걸지 않게(UPDATE 먼저 규칙과 무관해진다), 알림 기록이 단말기 삭제와 묶이지 않게.
- 결과·대가: 알림이 relay 간격만큼 늦다(기본 2초).
- 알려진 한계: **QUEUED에 영원히 남는 행**. 지금은 아무도 다시 보내지 않는다.
  1. Redis 유실로 job이 사라진 경우.
  2. 워커가 죽거나 멈춰 job이 `maxStalledCount`를 넘게 stalled 되면 BullMQ가 job을 실패로 옮기고, `removeOnFail: true`라 job이 지워진다. 프로세서의 catch를 거치지 않으므로 FAILED도 쓰지 않는다. (BullMQ 문서 기준. 직접 확인은 아직 안 했다)
  3. 마지막 시도에서 DB 오류가 나거나, catch 안의 `em.flush()`(FAILED·lastError 기록)가 실패하면 job은 실패로 끝나 지워지고 행은 QUEUED 그대로다.
  → 나중에 복구 sweep으로 고친다("QUEUED이고 X분보다 오래된 행 → PENDING"; jobId가 같아 job이 아직 살아 있으면 중복으로 들어가지 않는다). 워커 강제 종료 실험(Day 7)에서 실제로 남는지 관찰하고 X를 정한다.
- relay와 notify가 같은 `outbox` 큐·같은 워커 concurrency(5)를 나눠 쓴다. notify가 느리면(메신저 지연) relay job도 슬롯을 기다린다. 지금 규모에서는 문제 삼지 않고, 알림 지연을 재게 되면 큐를 나눈다.
- 다시 볼 조건: 알림 종류가 늘면 type별 채널·문구를 분리한다.
- 갱신(2026-10-23 Day 3): relay가 행마다 add하던 것을 addBulk 한 번으로 바꿨다 → decisions/0024, experiments/0006
