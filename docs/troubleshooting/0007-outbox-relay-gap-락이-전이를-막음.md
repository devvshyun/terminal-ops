# 0007. outbox relay 트랜잭션이 열려 있는 동안 전이·등록이 멈춤(gap 락)

- 날짜 / 관련 기능: 2026-10-22 / F5 (Task 8 리뷰)
- 증상: 리뷰어 지적. relay는 REPEATABLE READ(MySQL 기본)에서 `SELECT ... WHERE status='PENDING' ... FOR UPDATE SKIP LOCKED LIMIT n`으로 행을 잡고, 행마다 Redis `queue.add`를 한 뒤 커밋한다. 리뷰어가 테스트 DB에서 재현: 세션 A가 RR로 `BEGIN; SELECT ... FOR UPDATE SKIP LOCKED; SLEEP(4)` 중일 때 세션 B의 `INSERT outbox_event(PENDING)`가 ERROR 1205(락 대기 타임아웃). A를 READ COMMITTED로 하면 B는 바로 들어간다.
  전이·등록은 같은 트랜잭션에서 outbox 행을 INSERT하므로, relay가 트랜잭션을 잡고 있는 동안 전이가 단말기 X 락을 쥔 채 멈춘다는 뜻이다.
- 가설:
  1. (리뷰어 분석) RR에서 잠금 읽기는 next-key 락(레코드 + 앞쪽 gap)을 건다. PENDING이 limit보다 적으면 인덱스 끝까지 훑으므로 `(status, id)` 인덱스의 마지막 PENDING 다음 레코드(또는 supremum)까지 잠긴다. 새 행 `('PENDING', 새 id)`는 항상 그 gap에 들어가므로 INSERT의 insert intention 락이 기다린다.
  2. SKIP LOCKED가 gap 락도 건너뛰게 해 줄 것이다 → 1이 맞다면 기각돼야 한다.
- 확인:
  1. mysql 두 세션 재현(테스트 DB `terminal_ops_test`, 둘 다 ROLLBACK). A: `SET SESSION TRANSACTION ISOLATION LEVEL ...; BEGIN; SELECT id, status FROM outbox_event WHERE status='PENDING' ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED; DO SLEEP(4); ROLLBACK;` B(1초 뒤, `innodb_lock_wait_timeout=2`): `BEGIN; INSERT INTO outbox_event(type,payload,status,attempts,created_at) VALUES ('repro','{}','PENDING',0,now()); ROLLBACK;` C(1.5초 뒤): `performance_schema.data_locks` 조회. 셋을 `docker exec -i terminal-ops-mysql ... < x.sql &`로 동시에 돌렸다. 이때 테이블은 비어 있었다(PENDING 0건).
     - A = REPEATABLE READ:
       ```
       B start 15:16:24.598
       ERROR 1205 (HY000) at line 5: Lock wait timeout exceeded; try restarting transaction
       data_locks:
       outbox_event | NULL                         | TABLE  | IX                 | GRANTED | NULL
       outbox_event | NULL                         | TABLE  | IX                 | GRANTED | NULL
       outbox_event | outbox_event_status_id_index | RECORD | X                  | GRANTED | supremum pseudo-record
       outbox_event | outbox_event_status_id_index | RECORD | X,INSERT_INTENTION | WAITING | supremum pseudo-record
       ```
     - A = READ COMMITTED:
       ```
       B start    15:16:28.820
       B inserted 15:16:28.821
       data_locks:
       outbox_event | NULL | TABLE | IX | GRANTED | NULL
       ```
     → RR에서는 A가 `(status, id)` 인덱스 supremum에 X(next-key) 락을 쥐고, B의 INSERT_INTENTION이 같은 자리에서 WAITING이다. SKIP LOCKED가 있어도 A 자신이 건 gap 락은 그대로 남는다. 가설 1 확인, 2 기각. RC에서는 행 락이 하나도 없다(잡은 행이 0건이므로).
     실험 뒤 `select count(*) from outbox_event where type='repro'` → 0.
  2. 실패하는 e2e 테스트(`test/outbox.e2e.spec.ts` 'relay 트랜잭션이 열려 있어도 등록·전이는 기다리지 않는다'): `vi.spyOn(queue, 'add')`로 relay의 첫 `add`에서 멈추게 하고(트랜잭션 열린 채), 그동안 HTTP로 등록(`POST /terminals`) 1건과 전이(`OB-2000` INSPECTED → IN_STOCK) 1건을 보낸다. 1초 안에 둘 다 끝나야 통과. 1초가 지나면 relay를 풀어 준다. 고치기 전:
     ```
     [relay 중 쓰기] 등록 201 1018ms, 전이 200 1016ms (relay가 add에서 멈춘 동안, 한도 1000ms)
     × relay 트랜잭션이 열려 있어도 등록·전이는 기다리지 않는다(gap 락, troubleshooting/0007)
     AssertionError: expected false to be true
     ```
     둘 다 relay를 풀어 준 순간(약 1초)에야 끝났다. 앱 경로에서도 같은 일이 일어난다는 근거.
- 원인: relay가 MySQL 기본 격리 수준(REPEATABLE READ)에서 잠금 읽기를 했다. RR은 팬텀을 막으려고 훑은 범위의 gap까지 잠그는데, 그 범위가 바로 새 PENDING 행이 들어갈 자리다. relay는 그 상태로 Redis add(네트워크 왕복, 행마다 1번)를 하고 나서야 커밋하므로, 그동안 전이·등록 트랜잭션이 outbox INSERT에서 멈춘다. 전이는 이미 단말기 UPDATE로 X 락을 쥐고 있어서 같은 단말기의 다른 요청까지 줄줄이 기다린다. relay가 느려지면(Redis 지연) 전이가 50초(`innodb_lock_wait_timeout`) 뒤 1205로 실패할 수 있다.
- 해결: relay 트랜잭션을 `em.transactional(cb, { isolationLevel: IsolationLevel.READ_COMMITTED })`로 연다(MikroORM 7은 `set transaction isolation level read committed` → `begin`을 보낸다, `@mikro-orm/sql` AbstractSqlPlatform). RC에서는 잠금 읽기가 찾은 행에만 레코드 락을 건다. relay는 같은 조회를 트랜잭션 안에서 반복하지 않으므로 RR의 보장이 필요 없다. 결정 근거는 decisions/0016에 적음. `addBulk`는 이번에 하지 않았다.
- 해결 후:
  - 같은 테스트: `[relay 중 쓰기] 등록 201 11ms, 전이 200 12ms` 통과. 격리 수준만 되돌려 다시 돌리면 `등록 201 1026ms, 전이 200 1025ms`로 다시 실패(테스트가 이 버그를 잡는다는 확인). 되돌린 것은 원복했다.
  - SKIP LOCKED 테스트 보강: 기존 'relay 4개 동시' 테스트의 주석이 "SKIP LOCKED가 없으면 같은 행을 기다리거나 두 번 잡는다"였는데, 겹침 없음만으로는 SKIP LOCKED를 증명하지 못한다(차례로 기다렸다 돌아도 `[5,5,5,5]`가 될 수 있음). 새 테스트: 첫 relay(5건)를 add에서 멈춰 둔 채 둘째 relay(5건)를 돌려 기다리지 않고 다른 행을 잡는지 본다. 결과 `[SKIP LOCKED] 둘째 relay 9ms, 첫째=[27,28,29,30,31] 둘째=[32,33,34,35,36]`.
  - 덤으로 확인: lockMode를 잠깐 `PESSIMISTIC_WRITE`(SKIP LOCKED 없는 FOR UPDATE, RC)로 바꿔 돌렸더니 새 테스트는 둘째 relay가 기다려 30초 타임아웃, 기존 'relay 4개 동시' 테스트는 `DeadlockException`으로 실패했다. 리뷰어 말("그냥 FOR UPDATE여도 차례로 돌면 [5,5,5,5]")과 달리 여기서는 데드락이 났다. 원인은 따로 보지 않았다(추정: 보조 인덱스와 PK를 잠그는 순서). 주석은 "겹침 없음만으로는 증명 못 함, 기다리지 않음은 새 테스트가 본다"로 고쳤다. 원복 확인.
  - outbox 테스트 3회 모두 `8 passed`(7.58s, 7.51s, 7.61s). 각 회 `[relay 동시] [5,5,5,5]`, `[relay 중 쓰기]` 9~12ms, `[SKIP LOCKED]` 둘째 9~10ms.
  - 전체: api 16개 파일 `114 passed`(112 + 새 테스트 2), `npm test` exit 0, `npm run typecheck` exit 0.
- 배운 것:
  - SKIP LOCKED는 "남이 잡은 행을 건너뛴다"일 뿐, 내가 거는 gap 락을 없애 주지 않는다. RR에서 큐처럼 쓰는 테이블을 잠금 읽기로 훑으면 끝(supremum)까지 잠겨 INSERT가 막힌다.
  - `performance_schema.data_locks`로 `X,INSERT_INTENTION ... WAITING | supremum pseudo-record`처럼 누가 어디서 기다리는지 바로 보인다.
  - 격리 수준은 트랜잭션마다 고를 수 있다. 전역을 바꾸지 않고 필요한 트랜잭션만 RC로 연다.
  - "트랜잭션 안에서 네트워크 호출"은 Outbox를 고른 이유(decisions/0016 상황)에서 피하려던 바로 그 모양이다. relay 안의 Redis add도 같은 위험이 있었다.
  - 테스트로 동시성 버그를 재현할 때는 sleep 대신 spy로 "여기서 멈춰" 지점을 만들면 결과가 안정적이다(3회 같은 숫자).
  - → study/backlog.md에 추가
