# 0018. 재출고하면 이전 운송장을 SUPERSEDED로 바꾼다

- 날짜 / 관련 기능: 2026-10-23 / F3, F7
- 상황: Day 2 리뷰 Minor 1. 단말기가 회수 후 다시 출고되면 운송장이 여러 장이 된다. 옛 운송장의 DELIVERED 이벤트가 새 출고(SHIPPED)를 배송 완료로 바꿀 수 있다. F7 교체 출고부터 실제로 생긴다.
- 선택지:
  1. 배송 완료 반영 때 "그 단말기의 가장 최근 운송장인지" 조회해 비교: 반영마다 조회 1번, 기준(최근)이 시간에 의존.
  2. 출고할 때 같은 단말기의 이전 IN_TRANSIT 운송장을 `SUPERSEDED`로 바꾸고, 반영은 IN_TRANSIT 운송장만: 상태로 드러나고 sweep 대상에서도 빠진다.
- 결정: 2. `ShipmentService.recordShipment(tx, terminal, carrier, trackingNo)`가 단말기 UPDATE(전이) 뒤에 `UPDATE shipment SET status='SUPERSEDED' WHERE terminal_id=? AND status='IN_TRANSIT'` → INSERT. 반영(`applyDelivered`)은 `status !== IN_TRANSIT`면 NOOP(`운송장이 이미 SUPERSEDED`).
- 바꿈(2026-10-23, Task 9 리뷰): 위 `WHERE terminal_id=? AND status='IN_TRANSIT'` UPDATE는 REPEATABLE READ에서 terminal_id 인덱스에 gap 락을 걸어, 운송장이 없는 서로 다른 단말기의 출고·교체 출고끼리 INSERT에서 데드락(500 + 고아 운송장)이 났다(troubleshooting/0014). 지금은 ① 잠그지 않는 읽기로 그 단말기의 IN_TRANSIT 운송장 id를 찾고 ② id가 있을 때만 `UPDATE ... WHERE id IN (…) AND status='IN_TRANSIT'`(PK 갱신, gap 락 없음) → ③ INSERT. 잠그지 않고 읽어도 되는 이유는 운송장을 쓰는 모든 경로가 먼저 단말기 행을 UPDATE(X 락·version 검사)해 같은 단말기의 출고가 단말기 행에서 줄을 서기 때문이다. 스냅숏 뒤에 같은 단말기 운송장이 커밋됐다면 단말기 version이 바뀌어 이쪽 단말기 UPDATE가 먼저 실패한다. status 조건은 그사이 DELIVERED로 커밋된 운송장을 덮어쓰지 않으려고 남겼다. 이 가정 때문에 "운송장은 단말기 UPDATE 뒤에만 쓴다"가 규칙이 된다. 다른 선택지였던 READ COMMITTED 트랜잭션은 전이 트랜잭션 전체의 읽기 뜻이 바뀌어 택하지 않았다.
  - 확인(2026-10-23, 리뷰 지적 "PK IN 갱신은 gap 락이 없다"가 InnoDB 규칙에서 나온 말일 뿐 확인하지 않았다): 테스트 DB(`terminal_ops_test`, REPEATABLE READ)에서 직접 봤다. 운송장 2행(id 1·2)을 넣고 ① `begin; update shipment set status='SUPERSEDED' where id in (1) and status='IN_TRANSIT'` 뒤 `performance_schema.data_locks` → `PRIMARY RECORD X,REC_NOT_GAP 1`과 테이블 `IX`뿐(EXPLAIN `range | PRIMARY`). ② 비교로 예전 문장 `where terminal_id=3 and status='IN_TRANSIT'`(운송장 없는 단말기) → `shipment_terminal_id_index RECORD X supremum pseudo-record`(gap을 포함한 next-key 락, troubleshooting/0014와 같은 모양). ③ 두 세션: A가 `id in (2)` 갱신을 쥔 채 5초 잠자는 동안 B(`innodb_lock_wait_timeout=3`)가 다른 단말기 3의 운송장 INSERT → 기다리지 않고 바로 성공(같은 시각 12:59:58.163에 시작·완료, A는 13:00:02에 롤백). 확인 뒤 넣은 행은 지움. 한계: 갱신할 id가 있을 때만 봤다(코드는 id가 없으면 UPDATE를 보내지 않는다). data_locks는 보조 인덱스의 암묵적 락을 따로 보여 주지 않을 수 있다(추정). 스크립트는 남기지 않았고 명령은 위가 전부다.
- 경합: 반영 트랜잭션은 운송장과 단말기를 잠그지 않고 읽는다(REPEATABLE READ 스냅샷). 읽은 뒤 재출고가 끼면 두 경우로 나뉜다.
  - 스냅샷의 단말기가 SHIPPED: 반영이 단말기를 전이하므로 그 UPDATE가 version 검사에 걸려(OptimisticLockError) 트랜잭션이 통째로 롤백되고 job이 재시도된다. 다음 시도는 처음 조회에서 운송장이 IN_TRANSIT가 아닌 것을 보고 건너뛴다(SKIPPED).
  - 스냅샷의 단말기가 SHIPPED가 아님(운영자가 먼저 수동으로 진행해 이미 ALLOCATED 등): 단말기 UPDATE가 없어 version 검사도 없다. 그래서 운송장 완료를 조건부 UPDATE(`WHERE id=? AND status='IN_TRANSIT'`)로 한다. 바뀐 행이 0이면 NOOP. 처음에는 조건 없는 flush라 커밋된 SUPERSEDED를 DELIVERED로 덮어썼다(lost update, troubleshooting/0010).
  - 조건부 UPDATE가 0행인데 이 트랜잭션에서 단말기를 이미 바꿨다면 예외로 전부 되돌린다(재시도 때 SKIPPED). 이 분기는 방어용이라 테스트로 닿지 않는다(보통 단말기 version 검사가 먼저 실패한다).
  재출고가 반영보다 먼저 커밋됐으면 반영 트랜잭션이 처음부터 SUPERSEDED를 읽고 NOOP이다. 운송장 행을 먼저 잠그면(FOR UPDATE) 재출고(단말기 → 운송장)와 잠금 순서가 반대가 되어 택하지 않았다. 조건부 UPDATE도 단말기 UPDATE 뒤에 보내 순서를 맞춘다. 테스트: 택배사 응답 직후 운송장을 SUPERSEDED로 바꾸는 spy(NOOP·단말기 SHIPPED 그대로), 반영의 첫 읽기 직후 멈춘 사이 실제 재출고를 커밋시키는 spy(옛 운송장 SUPERSEDED 유지, NOOP).
- 결과·대가: shipment status enum ALTER(`Migration20261023015811`).
- 다시 볼 조건: 운송장 하나에 단말기 여러 대(합포장)가 생기면 다시 설계.
