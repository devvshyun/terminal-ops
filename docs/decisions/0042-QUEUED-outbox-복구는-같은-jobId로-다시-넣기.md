# 0042. QUEUED outbox 복구는 같은 jobId로 job을 다시 넣는다

- 날짜 / 관련 기능: 2026-10-27 / F5 (Day 4 이월, decisions/0016 "알려진 한계")
- 상황: outbox 행은 relay가 notify job을 넣으면서 QUEUED가 된다. 그 job이 큐에서 사라지면 행은 QUEUED로 남고 relay(PENDING만 봄)도 notify도 다시 보지 않는다 — 알림 유실이다. 사라지는 길:
  1. 처리 중인 워커가 죽으면 BullMQ는 잠금(lockDuration 30초)이 풀린 뒤 stalled 검사(30초마다)로 job을 대기열로 되돌린다. **한 번은 BullMQ가 살린다.** 그런데 같은 job이 stalled 한도(`maxStalledCount` 1)를 넘으면 실패로 옮기고 `removeOnFail: true`라 지운다. 프로세서의 catch를 거치지 않아 FAILED도 쓰지 않는다.
  2. Redis에서 job 키가 사라진다(유실·잘못된 정리).
  3. 마지막 시도에서 catch 안의 `em.flush()`(FAILED 기록)가 실패한다.
- 선택지:
  1. QUEUED이고 오래된 행을 PENDING으로 되돌린다(0016이 적어 둔 안) — 장점: relay 한 길로 모인다. 단점: 행 UPDATE가 relay의 `FOR UPDATE SKIP LOCKED`와 같은 행을 다툰다. relay가 project job(active 갱신)까지 다시 넣는다. 아직 큐에 살아 있는 job이 있는 행도 되돌린다(jobId가 같아 중복은 아니지만 쓸데없는 쓰기).
  2. 행은 그대로 두고, 큐에 그 jobId의 job이 없을 때만 같은 jobId로 notify job을 다시 넣는다 — 장점: DB 쓰기 없음, 살아 있는 job(대기·처리 중·지연)은 건드리지 않음, 다시 넣은 수가 곧 "사라졌던 수"라 관찰이 된다. 단점: 행마다 Redis 조회 한 번(`getJobState`).
  3. `queued_at` 열을 더해 "QUEUED가 된 지 X분"으로 고른다 — 장점: 기준이 정확하다. 단점: 마이그레이션, relay가 한 열을 더 쓴다. 2에서는 job이 살아 있으면 어차피 건너뛰므로 created_at으로 넉넉히 거르는 것으로 충분하다.
  4. BullMQ 설정만 바꾼다(`removeOnFail: false`, `maxStalledCount` 늘리기) — 길 1만 줄이고 2·3은 그대로다.
- 결정: 2. `OutboxService.requeueStale()`이 `status = QUEUED and created_at < now − OUTBOX_REQUEUE_AFTER_MS(60초)`인 행을 id 순으로 100개 읽고(`(status, id)` 인덱스), `queue.getJobState('outbox-<id>') === 'unknown'`인 것만 `addBulk`로 다시 넣는다. 주기 작업 `outbox-requeue`(outbox 큐, `OUTBOX_REQUEUE_INTERVAL_MS` 60초, scheduler:clear가 같은 목록으로 지운다). 테스트: `test/outbox-requeue.e2e.spec.ts`(job 하나를 지우면 그 행만 다시 넣음, 두 번째 호출은 0, 오래되지 않은 행·QUEUED 아닌 행은 보지 않음).
- 결과·대가:
  - 사라진 알림은 최대 "만든 뒤 60초 + 주기 60초" 뒤에 다시 나간다. 다시 나간 알림이 이미 메신저에 닿았던 것이면(길 1에서 응답 전에 죽음) 중복이다 — 0016의 "최소 한 번 + 멱등키" 그대로.
  - 다시 넣을 때 project job(active 갱신)은 넣지 않는다. active는 주기 재구성(60초)이 맞춘다(decisions/0028).
  - 오래된 QUEUED 행이 100개를 넘게 살아 있는 job과 함께 쌓이면(긴 대기열) 그 뒤의 행은 다음 주기들로 밀린다.
  - FAILED 행은 다시 보내지 않는다(재시도를 다 쓴 것 — 운영자가 볼 일).
- 다시 볼 조건: 대기열이 길어 오래된 QUEUED가 늘 100개를 넘으면 `limit`을 키우거나 "마지막으로 본 id" 커서를 둔다. 실험 0014(Task 5)가 강제 종료·job 유실에서 숫자를 보탠다.
