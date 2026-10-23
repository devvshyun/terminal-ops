# 0029. 오프라인 판정과 스냅샷은 바뀐 것만 MySQL에

- 날짜 / 관련 기능: 2026-10-23 / F8, F5 (Day 4 Task 5)
- 상황: 접속 상태의 최신값은 Redis에 있다(decisions/0027). 운영자 화면·리포트·알림에는 "언제 끊겼나"와 Redis를 잃어도 남는 값이 필요하다. 하트비트마다 MySQL에 쓰지 않으면서, 무엇을 언제 MySQL에 쓸지 정해야 한다.
- 선택지(쓰는 때):
  1. 하트비트마다 쓰기. decisions/0027에서 버렸다(실험 0008이 잰다).
  2. **상태가 바뀔 때만(판정 job) + 주기 스냅샷.**
  3. 스냅샷만. 끊긴 순간이 스냅샷 주기 단위로 뭉개지고, 알림을 낼 곳이 없다.
- 결정: 2.
  - 판정 job은 바뀐 단말기만 한 트랜잭션에서 UPSERT하고 Outbox(`device.offline`/`device.online`)를 남긴다. 상태 전이 이력과는 다른 type이다.
  - 스냅샷은 지난 스냅샷 뒤 lastSeen이 바뀐 단말기만 쓴다. online은 덮어쓰지 않는다(online은 판정 job만 바꾼다).
- 온라인 복귀를 어디서 찾나:
  1. 하트비트 경로에서 오프라인 SET을 확인해 바로 MySQL·Outbox에 쓰기. 하트비트가 MySQL을 치게 된다.
  2. **판정 job**에서 오프라인 SET의 lastSeen을 ZMSCORE로 보기. 하트비트 경로는 Redis 전용으로 남고, 복귀 알림이 판정 주기만큼 늦다.
  - → 2.
- `device_connectivity`에 terminal FK를 두지 않는 이유: 수천 행 UPSERT가 단말기 행마다 FK 검사 S 락을 걸면, 같은 단말기의 전이(X 락)와 서로 기다린다. Outbox와 같은 이유다(decisions/0016). 대신 폐기된 단말기의 행은 정리되지 않고 남는다.
- UPSERT 방법: QueryBuilder `insert … on duplicate key update` 한 문장(500행씩)으로 쓴다. 엔티티가 필요 없기 때문이다. 행은 terminal_id 오름차순으로 넣는다(여러 행 잠금 순서, 판정과 스냅샷이 동시에 돌아도 같은 순서).
  - `em.upsertMany`를 쓰지 않은 근거(Task 5에서 직접 확인 후 되돌림): `upsertConnectivity`를 잠깐 `tx.upsertMany(DeviceConnectivity, rows, { onConflictFields: ['terminalId'], onConflictAction: 'merge', onConflictMergeFields: merge })`로 바꾸니 snapshot 테스트가 `expected [ Array(1) ] to have a length of +0 but got 1`로 실패했다. 쿼리 로그에서 INSERT와 `commit` 사이에 ``select `d0`.`online`, `d0`.`changed_at`, `d0`.`terminal_id`, `d0`.`last_seen_at`, `d0`.`firmware_version` from `device_connectivity` as `d0` where (`d0`.`terminal_id` = ? or `d0`.`terminal_id` = ?)``가 하나 더 보였다(MikroORM 7.2.5, 2행). 5,000행이면 OR 조건이 5,000개다.
  - QueryBuilder로 쓰면 `begin`, INSERT 한 문장, `commit`만 나간다.
- 동시 실행: 판정·스냅샷은 각자 Redis 잠금(`<prefix>:job-lock:hb-detect|hb-snapshot`, 30초)을 잡아 프로세스가 여럿이어도 하나만 돈다. 커밋 뒤 Redis에 반영하기 전에 죽으면 다음 판정이 같은 변화를 다시 쓴다. 알림이 중복될 수 있다(최소 한 번 + 멱등키, decisions/0016).
- 기준: 마지막 하트비트가 90초(단말기 주기 30초의 3배)보다 오래되면 오프라인. 판정은 10초, 스냅샷은 60초마다. 하트비트를 한 번도 보내지 않은 단말기는 판정 대상이 아니다(lastSeen 없음).
- 결과·대가:
  - 끊김 감지 지연 = 기준 - (마지막 하트비트 뒤 지난 시간) + 판정 주기. 실험 0008이 잰다.
  - 조회 API는 Redis 값으로 online을 계산하므로 판정 job보다 빨리 바뀐다. 둘이 잠깐 다를 수 있다.
  - 이 job들은 device 큐(concurrency 1)에서 project job과 줄을 함께 선다. 5,000대에서 잰 시간은 평소 판정 약 2ms, 스냅샷 전체 약 0.5초, 대량 끊김·복귀 판정 약 1.3~1.5초다(실험 0010). project가 그만큼 밀리는 것은 relay 주기 2초와 비교해 지금은 문제 삼지 않는다.
- 다시 볼 조건: 단말기가 늘어 판정 한 번의 ZRANGEBYSCORE·SMEMBERS가 무거워질 때(LIMIT으로 나누기), 스냅샷이 수 초가 되어 project가 눈에 띄게 밀릴 때(큐 나누기, 실험 0010), 오프라인 알림이 너무 많을 때(묶어서 한 알림).
