# 0014. 출고 때 이전 운송장 UPDATE가 gap 락을 잡아 다른 단말기 출고끼리 데드락

- 날짜 / 관련 기능: 2026-10-23 / F3(출고), F7(교체 출고) (Task 9 리뷰 지적)
- 증상: 리뷰어가 테스트 DB에서 SQL 두 세션으로 재현했다. 두 트랜잭션이 각각 운송장이 없는 다른 단말기(7, 8)에 대해 `UPDATE shipment SET status='SUPERSEDED' WHERE terminal_id=? AND status='IN_TRANSIT'`를 한 뒤 각자 `INSERT INTO shipment (...)`를 하면 한쪽이 `ER_LOCK_DEADLOCK`. 이 두 문장은 `ShipmentService.recordShipment`가 보내는 것과 같다(decisions/0018). 교체 출고(`POST /service-tickets/:id/replacements`)와 일반 출고(`POST /shipments`) 둘 다 이 함수를 쓴다. 데드락 예외는 따로 매핑되지 않아 500이고, 트랜잭션 밖에서 먼저 받은 운송장은 고아로 남는다.
- 가설:
  1. (리뷰어 분석) `WHERE terminal_id=?` UPDATE는 `shipment_terminal_id_index`로 훑는다. REPEATABLE READ에서 맞는 행이 없으면 다음 레코드 앞 gap에 락을 건다. 운송장이 없는 새 단말기(id가 큼)는 모두 같은 gap(인덱스 끝이면 supremum)에 떨어진다. gap 락끼리는 서로 막지 않아 둘 다 UPDATE를 통과하지만, 이어지는 INSERT의 insert intention 락은 상대의 gap 락에 막힌다. 서로 기다리니 순환이다.
  2. HTTP 경로에서는 UPDATE와 INSERT 사이가 짧아(INSERT는 커밋 직전 flush) 실제로는 잘 겹치지 않을 것이다 → 확인 1에서 기각.
- 확인:
  1. 실패하는 HTTP 테스트를 먼저 넣었다. 운송장이 한 번도 없는 단말기를 beforeAll 마지막에 등록해 id를 가장 크게 만들었다.
     - `test/replacement.e2e.spec.ts` '서로 다른 단말기의 교체 출고 2건을 동시에 하면 둘 다 201': 고장 단말기 RP-0006·0007, 교체 단말기 RP-0106·0107, `Promise.all`로 동시에.
     - `test/shipment.e2e.spec.ts` '서로 다른 단말기 동시 출고 2건: 둘 다 201': ALLOCATED인 SH-0006·0007을 동시에 `POST /shipments`.
     고치기 전 5회 실행(`npx vitest run test/replacement.e2e.spec.ts test/shipment.e2e.spec.ts`), 5회 모두 두 테스트가 다 실패했다. 멈추게 하는 spy 없이도 매번 났다.
     ```
     [다른 단말기 동시 교체] 응답=[201,500] 코드=[null,null]     ← 5회 모두 [201,500]
     [다른 단말기 동시 출고] 응답=[201,500]                      ← 5회 모두 [201,500]
     ERROR [ExceptionsHandler] DeadlockException: Deadlock found when trying to get lock; try restarting transaction
     ```
     고친 뒤 고치기 전 코드로 한 번 더 되돌려 돌린 결과: `응답=[500,201]`, `응답=[201,500]`, `Tests  2 failed | 12 passed (14)`.
  2. `SHOW ENGINE INNODB STATUS`(docker exec, root, 읽기만 함)의 LATEST DETECTED DEADLOCK(5회째 출고 테스트, 단말기 6·7):
     ```
     2026-10-23 12:39:32
     *** (1) TRANSACTION: TRANSACTION 884684, ACTIVE 0 sec inserting
     LOCK WAIT 7 lock struct(s), heap size 1128, 3 row lock(s), undo log entries 4
     insert into `shipment` (`terminal_id`, `carrier`, `tracking_no`, `status`, `created_at`) values (6, 'BUNGAE', 'BG17927267723320001', 'IN_TRANSIT', ...)
     *** (1) HOLDS THE LOCK(S):
     RECORD LOCKS ... index shipment_terminal_id_index of table `terminal_ops_test`.`shipment` trx id 884684 lock_mode X
     Record lock, heap no 1 PHYSICAL RECORD: n_fields 1; compact format; info bits 0
      0: len 8; hex 73757072656d756d; asc supremum;;
     *** (1) WAITING FOR THIS LOCK TO BE GRANTED:
     RECORD LOCKS ... index shipment_terminal_id_index ... trx id 884684 lock_mode X insert intention waiting
      0: len 8; hex 73757072656d756d; asc supremum;;
     *** (2) TRANSACTION: TRANSACTION 884685, ACTIVE 0 sec inserting
     insert into `shipment` (...) values (7, 'BUNGAE', 'BG17927267723320002', 'IN_TRANSIT', ...)
     *** (2) HOLDS THE LOCK(S):
     ... index shipment_terminal_id_index ... trx id 884685 lock_mode X ... supremum
     *** (2) WAITING FOR THIS LOCK TO BE GRANTED:
     ... index shipment_terminal_id_index ... trx id 884685 lock_mode X insert intention waiting ... supremum
     *** WE ROLL BACK TRANSACTION (2)
     ```
     둘 다 `shipment_terminal_id_index`의 supremum에 X(next-key) 락을 쥐고, 같은 자리에 insert intention을 기다린다. 가설 1 확인.
  3. `SHOW INDEX FROM shipment`: `shipment_terminal_id_index`(terminal_id 하나), `shipment_status_index`(status 하나), PK, tracking_no unique. (terminal_id, status) 복합 인덱스는 없다.
- 원인: 이전 운송장을 바꾸는 UPDATE가 보조 인덱스로 범위를 훑는 잠금 읽기라서, REPEATABLE READ에서 "찾은 행이 없음"도 gap 락으로 지켰다. 그 gap이 바로 자기 INSERT가 들어갈 자리이고, 운송장 없는 다른 단말기도 같은 gap을 쓴다. 단말기 행 잠금 순서(decisions/0023의 id 오름차순)와 상관없이 생긴다. 서로 다른 단말기라 단말기 행끼리는 부딪히지 않고, 공유 자원은 인덱스의 gap 하나다. troubleshooting/0007(relay가 outbox 끝 gap을 잡아 INSERT를 막음)과 같은 모양이다.
- 해결: `recordShipment`를 바꿨다(이 파일과 같은 커밋 `fix(F3): 출고 시 이전 운송장 SUPERSEDED를 PK 갱신으로 — gap 락 데드락 방지`).
  1. 잠그지 않는 읽기(`select id from shipment where terminal_id=? and status='IN_TRANSIT'`, QueryBuilder `execute('all')`라 identity map에 안 올라감)로 이전 배송 중 운송장 id를 찾는다.
  2. id가 있을 때만 `nativeUpdate(Shipment, { id: { $in: ids }, status: IN_TRANSIT }, { status: SUPERSEDED })`. PK로 찾은 행에만 레코드 락이 걸리고 gap 락은 없다. id가 없으면 UPDATE를 보내지 않는다(이번 데드락의 경우).
  3. INSERT는 그대로.
  - 잠그지 않아도 맞는 이유: 운송장을 저장하는 경로(출고·교체 출고)는 모두 먼저 같은 트랜잭션에서 그 단말기 행을 UPDATE한다(전이, version 검사, X 락). 그래서 같은 단말기의 출고끼리는 단말기 행에서 줄을 서고, 읽은 스냅숏 뒤에 같은 단말기 운송장이 커밋됐다면 그 트랜잭션이 단말기 version을 올렸으므로 이쪽 단말기 UPDATE가 OptimisticLockError로 먼저 실패한다. 즉 정확성은 "단말기 X 락이 같은 단말기 운송장 쓰기를 직렬화한다"에 기댄다. 운송장을 단말기 UPDATE 없이 쓰는 새 경로가 생기면 이 가정이 깨진다.
  - status 조건을 남긴 이유: 읽은 뒤 배송 완료 반영이 그 운송장을 DELIVERED로 커밋했으면 UPDATE(최신 커밋을 읽음)가 0행이 되어 덮어쓰지 않는다(troubleshooting/0010과 같은 lost update 방지).
  - 버린 대안: 이 트랜잭션들을 READ COMMITTED로 열기(RC는 대부분 gap 락을 걸지 않는다). 효과는 같겠지만 전이 서비스·교체 출고 트랜잭션 전체의 격리 수준이 바뀌어 다른 읽기의 뜻까지 바뀐다. PK 갱신은 바뀌는 범위가 이 함수 하나라 먼저 택했다. PK 갱신에 문제가 보이지 않아 RC는 시험하지 않았다.
- 해결 후:
  - 같은 두 파일 5회: 5회 모두 `Tests  14 passed (14)`, 매번 `[다른 단말기 동시 교체] 응답=[201,201]`, `[다른 단말기 동시 출고] 응답=[201,201]`.
  - `test/carrier-sync.e2e.spec.ts` 9 passed(SUPERSEDED·배송 완료 경합 테스트 포함), 전체 api `Test Files 29 passed`, `Tests 198 passed`(196 + 새 테스트 2), typecheck exit 0.
  - 참고: 이번 vitest는 통과한 테스트의 console.log를 보여 주지 않아 `--silent=false`로 돌려 로그를 봤다.
- 배운 것:
  - "없는 행"을 조건으로 UPDATE·DELETE·잠금 읽기하면 RR은 그 빈자리(gap)를 잠근다. 같은 자리에 곧 INSERT할 트랜잭션들이 이걸 하면 서로 막힌다. 행 잠금 순서를 정해도 막을 수 없다(자원이 행이 아니라 gap이다).
  - gap 락끼리는 서로 호환되므로 두 트랜잭션 모두 UPDATE는 통과하고, 막히는 것은 뒤의 INSERT다.
  - 고치는 방법: 잠그지 않고 읽은 뒤 PK로 갱신, 또는 그 트랜잭션만 READ COMMITTED.
  - → study/backlog.md에 추가
