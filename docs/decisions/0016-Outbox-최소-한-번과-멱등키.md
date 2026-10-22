# 0016. 알림은 Outbox로, 보장 수준은 최소 한 번 + 멱등키

- 날짜 / 관련 기능: 2026-10-22 / F5
- 상황: 상태가 바뀌면 메신저로 알려야 한다(F5, "유실·중복 없이"). 전이 트랜잭션 안에서 메신저를 부르면 메신저가 느릴 때 락을 오래 잡고, 커밋 후에 부르면 그 사이 프로세스가 죽을 때 알림이 사라진다.
- 선택지:
  1. 커밋 후 바로 HTTP 호출: 단순하지만 유실된다.
  2. 커밋 후 바로 큐에 add: Redis add 전에 죽으면 유실된다(DB와 Redis는 한 트랜잭션이 아니다).
  3. Outbox: 같은 트랜잭션에 `outbox_event(PENDING)`를 기록하고, relay가 나중에 큐로 옮긴다. 커밋됐으면 알림 기록도 반드시 있다.
- 결정: 3.
- relay: `FOR UPDATE SKIP LOCKED`(MikroORM `LockMode.PESSIMISTIC_PARTIAL_WRITE`)로 PENDING을 최대 N건 잠그고 notify job(`jobId: outbox-<id>`)을 넣은 뒤 QUEUED로 바꾼다. relay 여러 개가 같은 행을 잡지 않는다(테스트로 확인: relay 4개가 5건씩 동시에 잡아 `[5,5,5,5]`, 겹침 없음, 3회 같음). Redis add 뒤 커밋 전에 죽으면 행은 PENDING으로 남아 다시 relay되지만, job이 아직 있으면 jobId가 같아 중복으로 들어가지 않는다.
- 보장 수준: **최소 한 번 + 멱등키**. 메신저가 받은 뒤 SENT를 쓰기 전에 죽으면 다시 보낸다. 메신저가 `idempotencyKey`로 걸러야 "한 번"이 된다. 정확히 한 번이라고 쓰지 않는다.
- FK를 두지 않은 이유: outbox INSERT가 단말기 행에 S 락을 걸지 않게(UPDATE 먼저 규칙과 무관해진다), 알림 기록이 단말기 삭제와 묶이지 않게.
- 결과·대가: 알림이 relay 간격만큼 늦다(기본 2초). QUEUED인데 job이 사라진 행(Redis 유실)은 지금은 다시 보내지 않는다 → 워커 강제 종료 실험(Day 7)에서 복구 sweep을 정한다.
- 다시 볼 조건: 알림 종류가 늘면 type별 채널·문구를 분리한다.
