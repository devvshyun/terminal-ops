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
  - (fix, 2026-10-23) 한 번 판정에서 한 방향(오프라인 또는 온라인)으로 바뀐 단말기가 기준(`CONNECTIVITY_BULK_EVENT_THRESHOLD`, 기본 50)보다 많으면 단말기별 행 대신 묶음 한 행(`device.offline_bulk`/`device.online_bulk`, payload `{ count, serials(앞 100대), truncated, detectedAt }`)을 남긴다. 기준 이하는 지금처럼 단말기별. `device_connectivity`와 Redis `offline` SET은 묶음이어도 단말기별로 맞춘다.
    - 이유: 5,000대가 한꺼번에 끊기면 Outbox 5,000행이 생기고, relay는 2초에 100행씩 옮기므로 줄이 약 100초다. 그 뒤에 들어온 `terminal.status_changed` 알림과 project job(active 갱신)도 그만큼 밀린다(실험 0010 ③'). 묶으면 1행, relay 1번이다.
    - 버린 것: relay limit을 키우기(한 트랜잭션이 잡는 행·addBulk가 커지고, 알림 5,000건이 메신저로 가는 것은 같다), 접속 알림만 다른 Outbox로(테이블·relay가 하나 더 생김).
    - 대가: 묶음 알림에는 단말기별 마지막 하트비트 시각이 없다. 앞 100대만 시리얼이 있고 나머지는 대수만 있다(필요하면 `device_connectivity.changed_at`으로 찾는다).
  - (fix) 운영에서 빠진(active에 없는) 단말기의 lastSeen이 오래되면, Redis 기록을 지우면서 같은 트랜잭션에서 그 단말기의 `device_connectivity` 행이 online=true면 알림 없이 online=false·changed_at=판정 시각으로 바꾼다. 전에는 행이 online=true로 남아 Redis 기록이 지워진 뒤 GET이 스냅샷 대체값으로 계속 "온라인"을 보였다. 시리얼 → id는 `terminal`을 잠그지 않는 SELECT로 찾고, UPDATE는 `online = true`인 행만 terminal_id 오름차순.
  - (fix) GET의 스냅샷 대체값도 `online = 행.online && lastSeenAt > 지금 - 기준`으로 계산한다(방어). 판정 job이 늦거나 놓친 행이 있어도 오래된 lastSeen을 온라인이라 하지 않는다.
- 온라인 복귀를 어디서 찾나:
  1. 하트비트 경로에서 오프라인 SET을 확인해 바로 MySQL·Outbox에 쓰기. 하트비트가 MySQL을 치게 된다.
  2. **판정 job**에서 오프라인 SET의 lastSeen을 ZMSCORE로 보기. 하트비트 경로는 Redis 전용으로 남고, 복귀 알림이 판정 주기만큼 늦다.
  - → 2.
- `device_connectivity`에 terminal FK를 두지 않는 이유: 수천 행 UPSERT가 단말기 행마다 FK 검사 S 락을 걸면, 같은 단말기의 전이(X 락)와 서로 기다린다. Outbox와 같은 이유다(decisions/0016). 대신 폐기된 단말기의 행은 정리되지 않고 남는다.
- UPSERT 방법: QueryBuilder `insert … on duplicate key update` 한 문장(500행씩)으로 쓴다. (fix) `last_seen_at`은 `greatest(last_seen_at, values(last_seen_at))`로 합친다. 스냅샷이 Redis를 읽은 뒤 판정 job이 더 새 값을 먼저 커밋하면, 늦게 커밋한 스냅샷의 더 오래된 값이 덮어 lastSeen이 뒤로 갔다. QueryBuilder `merge`에 필드 배열 대신 `{ 필드: raw(식) }`를 넘기면 그대로 들어간다(실제로 보낸 SQL: ``on duplicate key update `last_seen_at` = greatest(`last_seen_at`, values(`last_seen_at`)), `firmware_version` = values(`firmware_version`)``). MySQL 8.4에서 `VALUES()`는 deprecated지만 동작한다. firmware_version은 여전히 마지막 커밋이 이긴다(같은 경쟁에서 펌웨어가 한 스냅샷 동안 이전 값일 수 있다). 엔티티가 필요 없기 때문이다. 행은 terminal_id 오름차순으로 넣는다(여러 행 잠금 순서, 판정과 스냅샷이 동시에 돌아도 같은 순서).
  - `em.upsertMany`를 쓰지 않은 근거(Task 5에서 직접 확인 후 되돌림): `upsertConnectivity`를 잠깐 `tx.upsertMany(DeviceConnectivity, rows, { onConflictFields: ['terminalId'], onConflictAction: 'merge', onConflictMergeFields: merge })`로 바꾸니 snapshot 테스트가 `expected [ Array(1) ] to have a length of +0 but got 1`로 실패했다. 쿼리 로그에서 INSERT와 `commit` 사이에 ``select `d0`.`online`, `d0`.`changed_at`, `d0`.`terminal_id`, `d0`.`last_seen_at`, `d0`.`firmware_version` from `device_connectivity` as `d0` where (`d0`.`terminal_id` = ? or `d0`.`terminal_id` = ?)``가 하나 더 보였다(MikroORM 7.2.5, 2행). 5,000행이면 OR 조건이 5,000개다.
  - QueryBuilder로 쓰면 `begin`, INSERT 한 문장, `commit`만 나간다.
- 동시 실행: 판정·스냅샷은 각자 Redis 잠금(`<prefix>:job-lock:hb-detect|hb-snapshot`, 30초)을 잡아 프로세스가 여럿이어도 하나만 돈다. 커밋 뒤 Redis에 반영하기 전에 죽으면 다음 판정이 같은 변화를 다시 쓴다.
  - (정정) 이때 생기는 중복 알림은 멱등키로 걸러지지 않는다. 다시 쓴 판정이 **새 Outbox 행**을 만들고, 멱등키는 행마다(`outbox-<id>`) 다르므로 메신저는 두 건을 받는다. 멱등키가 막는 것은 같은 행을 두 번 보내는 경우(notify 재시도)뿐이다(decisions/0016). 전에는 "최소 한 번 + 멱등키"로 적어 걸러지는 것처럼 읽혔다.
  - 하트비트 ZADD와 판정이 겹치면 오프라인→온라인 알림 한 쌍이 나갈 수 있다. 판정이 ZRANGEBYSCORE로 오래된 단말기를 읽은 직후 그 단말기의 하트비트가 들어오면, 판정은 오프라인으로 쓰고 다음 판정(10초 뒤)이 온라인 복귀로 쓴다. 마지막 하트비트가 90초를 막 넘긴 순간에 하트비트가 와야 하므로 드물다(정상 단말기는 30초마다 보내 90초를 넘기지 않는다). 막으려면 판정을 Lua 하나로 묶어야 해서 지금은 받아들인다.
- 기준: 마지막 하트비트가 90초(단말기 주기 30초의 3배)보다 오래되면 오프라인. 판정은 10초, 스냅샷은 60초마다. 하트비트를 한 번도 보내지 않은 단말기는 판정 대상이 아니다(lastSeen 없음).
- 결과·대가:
  - 끊김 감지 지연 = 기준 - (마지막 하트비트 뒤 지난 시간) + 판정 주기. 실험 0008이 잰다.
  - 조회 API는 Redis 값으로 online을 계산하므로 판정 job보다 빨리 바뀐다. 둘이 잠깐 다를 수 있다.
  - 이 job들은 device 큐(concurrency 1)에서 project job과 줄을 함께 선다. 5,000대에서 잰 시간은 평소 판정 약 2ms, 스냅샷 전체 약 0.5초, 대량 끊김·복귀 판정 약 1.3~1.5초다(실험 0010). project가 그만큼 밀리는 것은 relay 주기 2초와 비교해 지금은 문제 삼지 않는다.
  - (fix 뒤 정정) 실험 0010을 다시 재 보니 큰 지연은 device 큐가 아니라 **relay 줄**이었다. 묶음 전에는 대량 끊김 한 번에 Outbox 5,000행 → relay 50번(약 100초)이었고, 묶은 뒤 1행 → relay 1번이다. 판정 함수 시간도 약 1.4초 → 약 0.56초로 줄었다(Outbox 5,000행 INSERT가 빠짐).
- 다시 볼 조건: 단말기가 늘어 판정 한 번의 ZRANGEBYSCORE·SMEMBERS가 무거워질 때(LIMIT으로 나누기), 스냅샷이 수 초가 되어 project가 눈에 띄게 밀릴 때(큐 나누기, 실험 0010), 기준 근처(50대 안팎)의 끊김이 자주 반복되어 단말기별 알림이 여전히 많을 때(기준 낮추기, 또는 시간 창으로 묶기).
