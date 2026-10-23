# 0018. 재출고하면 이전 운송장을 SUPERSEDED로 바꾼다

- 날짜 / 관련 기능: 2026-10-23 / F3, F7
- 상황: Day 2 리뷰 Minor 1. 단말기가 회수 후 다시 출고되면 운송장이 여러 장이 된다. 옛 운송장의 DELIVERED 이벤트가 새 출고(SHIPPED)를 배송 완료로 바꿀 수 있다. F7 교체 출고부터 실제로 생긴다.
- 선택지:
  1. 배송 완료 반영 때 "그 단말기의 가장 최근 운송장인지" 조회해 비교: 반영마다 조회 1번, 기준(최근)이 시간에 의존.
  2. 출고할 때 같은 단말기의 이전 IN_TRANSIT 운송장을 `SUPERSEDED`로 바꾸고, 반영은 IN_TRANSIT 운송장만: 상태로 드러나고 sweep 대상에서도 빠진다.
- 결정: 2. `ShipmentService.recordShipment(tx, terminal, carrier, trackingNo)`가 단말기 UPDATE(전이) 뒤에 `UPDATE shipment SET status='SUPERSEDED' WHERE terminal_id=? AND status='IN_TRANSIT'` → INSERT. 반영(`applyDelivered`)은 `status !== IN_TRANSIT`면 NOOP(`운송장이 이미 SUPERSEDED`).
- 경합: 반영 트랜잭션은 운송장과 단말기를 잠그지 않고 읽는다(REPEATABLE READ 스냅샷). 읽은 뒤 재출고가 끼면 두 경우로 나뉜다.
  - 스냅샷의 단말기가 SHIPPED: 반영이 단말기를 전이하므로 그 UPDATE가 version 검사에 걸려(OptimisticLockError) 트랜잭션이 통째로 롤백되고 job이 재시도된다. 다음 시도는 처음 조회에서 운송장이 IN_TRANSIT가 아닌 것을 보고 건너뛴다(SKIPPED).
  - 스냅샷의 단말기가 SHIPPED가 아님(운영자가 먼저 수동으로 진행해 이미 ALLOCATED 등): 단말기 UPDATE가 없어 version 검사도 없다. 그래서 운송장 완료를 조건부 UPDATE(`WHERE id=? AND status='IN_TRANSIT'`)로 한다. 바뀐 행이 0이면 NOOP. 처음에는 조건 없는 flush라 커밋된 SUPERSEDED를 DELIVERED로 덮어썼다(lost update, troubleshooting/0010).
  - 조건부 UPDATE가 0행인데 이 트랜잭션에서 단말기를 이미 바꿨다면 예외로 전부 되돌린다(재시도 때 SKIPPED).
  재출고가 반영보다 먼저 커밋됐으면 반영 트랜잭션이 처음부터 SUPERSEDED를 읽고 NOOP이다. 운송장 행을 먼저 잠그면(FOR UPDATE) 재출고(단말기 → 운송장)와 잠금 순서가 반대가 되어 택하지 않았다. 조건부 UPDATE도 단말기 UPDATE 뒤에 보내 순서를 맞춘다. 테스트: 택배사 응답 직후 운송장을 SUPERSEDED로 바꾸는 spy(NOOP·단말기 SHIPPED 그대로), 반영의 첫 읽기 직후 멈춘 사이 실제 재출고를 커밋시키는 spy(옛 운송장 SUPERSEDED 유지, NOOP).
- 결과·대가: shipment status enum ALTER(`Migration20261023015811`).
- 다시 볼 조건: 운송장 하나에 단말기 여러 대(합포장)가 생기면 다시 설계.
