# 0010. 배송 완료 반영이 재출고로 바뀐 SUPERSEDED를 DELIVERED로 덮어씀(lost update)

- 날짜 / 관련 기능: 2026-10-23 / F3 (Task 1 리뷰)
- 증상: 리뷰어 지적. `CarrierSyncService.applyDelivered`는 트랜잭션 안에서 운송장과 단말기를 잠그지 않고 읽는다(REPEATABLE READ 스냅샷). 읽은 뒤에 같은 단말기의 재출고(ALLOCATED → SHIPPED, `recordShipment`가 옛 운송장을 SUPERSEDED로 바꿈)가 커밋되면, 스냅샷의 단말기는 SHIPPED가 아니라서(대개 ALLOCATED) 전이도 version 검사도 일어나지 않는다. 마지막 운송장 flush(`UPDATE shipment SET status='DELIVERED' ... WHERE id=?`)가 커밋된 SUPERSEDED를 그대로 덮어쓴다. 재출고가 아직 커밋 전이면 행 락을 기다렸다가 역시 덮어쓴다. decisions/0018의 "경합" 문단은 단말기 UPDATE의 version 검사가 막아 준다고 적었는데, 스냅샷의 단말기가 SHIPPED일 때만 맞는 말이다.
- 가설:
  1. (리뷰어 분석) 스냅샷의 단말기가 SHIPPED가 아니면 반영 트랜잭션은 단말기 UPDATE를 하지 않으므로 version 검사로 막히지 않고, 운송장 UPDATE는 `WHERE id=?`뿐이라 커밋된 SUPERSEDED를 덮어쓴다.
  2. 스냅샷의 단말기가 SHIPPED인 경우에는 재출고가 단말기 version을 올리므로 반영의 단말기 UPDATE가 OptimisticLockError로 막힌다(decisions/0018에 적은 경우).
- 확인:
  1. 실패하는 e2e 테스트(`test/carrier-sync.e2e.spec.ts` '반영이 읽은 뒤 재출고가 커밋돼도 옛 운송장의 SUPERSEDED를 덮어쓰지 않는다'). 준비: CS-0008 출고 → 운영자가 수동으로 DELIVERED → IN_SERVICE → RETURN_REQUESTED → RETURNING → RETURNED → IN_STOCK → 배정 API로 ALLOCATED(옛 운송장은 IN_TRANSIT 그대로). `vi.spyOn(EntityManager.prototype, 'findOneOrFail')`로 반영 트랜잭션의 첫 읽기(운송장 + 단말기 populate) 직후에 멈추게 했다.
     - 첫 시도: hook 안에서 바로 `POST /shipments`(재출고)를 보냈다. 실패는 했지만 결과가 이상했다. 단말기가 DELIVERED, SyncRun outcome DELIVERED, 새 운송장은 IN_TRANSIT. 재출고가 반영 트랜잭션 **안에서** 실행된 모양이다. 원인(추정, 코드로 확인하지 않음): MikroORM의 트랜잭션 컨텍스트는 AsyncLocalStorage에 있고, hook 안에서 supertest가 서버를 열어 요청을 보내면 요청 처리가 그 컨텍스트를 물려받아 전역 em이 반영 트랜잭션의 em으로 풀린다. 테스트를 고쳐 hook은 "읽었음" 신호만 보내고 기다리게 하고, 재출고는 테스트 본문에서 보낸 뒤 hook을 풀어 주게 했다.
     - 고친 테스트, 수정 전:
       ```
       × 반영이 읽은 뒤 재출고가 커밋돼도 옛 운송장의 SUPERSEDED를 덮어쓰지 않는다(lost update, troubleshooting/0010)
       AssertionError: expected { status: 'DELIVERED', …(1) } to deeply equal { status: 'SUPERSEDED', …(1) }
       -   "deliveredAt": null,
       -   "status": "SUPERSEDED",
       +   "deliveredAt": 2026-10-23T02:09:03.000Z,
       +   "status": "DELIVERED",
       ```
       테스트 DB 조회(`docker exec terminal-ops-mysql mysql ... terminal_ops_test`):
       ```
       id  status      delivered_at         tstatus  version
       1   DELIVERED   2026-10-23 02:09:03  SHIPPED  13
       2   IN_TRANSIT  NULL                 SHIPPED  13
       sync_run: shipment 1, attempt 1, NOOP, "단말기 상태가 ALLOCATED라 전이하지 않음"
       ```
       → 스냅샷의 단말기는 ALLOCATED, 재출고는 커밋돼 단말기 SHIPPED와 새 운송장 2가 생겼는데, 옛 운송장 1이 SUPERSEDED가 아니라 DELIVERED다. 가설 1 확인.
  2. 가설 2(스냅샷 단말기가 SHIPPED인 경우)와 "재출고가 아직 커밋 전이면 행 락을 기다렸다가 덮어쓴다"는 따로 재현하지 않았다. 코드로 본 근거만 있다: 전이의 UPDATE는 `version = ?` 조건이 붙고, 운송장 UPDATE는 잠금 대기 뒤 최신 행에 적용된다(InnoDB UPDATE는 현재 읽기).
- 원인: 반영 트랜잭션은 REPEATABLE READ 스냅샷으로 운송장 상태를 보고 판단하지만, 쓰기는 조건 없는 `UPDATE ... WHERE id=?`였다. 판단의 근거(IN_TRANSIT)가 쓰는 순간에도 맞는지 확인하지 않았다. 단말기 쪽은 version 검사가 있어서 가려졌을 뿐이다.
- 해결: 마지막 운송장 쓰기를 같은 트랜잭션 안의 조건부 UPDATE로 바꿨다. `tx.nativeUpdate(Shipment, { id, status: IN_TRANSIT }, { status: DELIVERED, deliveredAt, lastSyncedAt })`. 잠금 순서는 단말기 UPDATE(전이 안의 flush) → 운송장 UPDATE로 재출고와 같다. 바뀐 행이 0이면:
  - 단말기를 바꾸지 않았으면 NOOP(`운송장이 반영 중에 IN_TRANSIT가 아니게 됨(재출고 등)`).
  - 단말기를 이 트랜잭션에서 바꿨으면 예외를 던져 전부 되돌린다. job이 재시도되면 track의 처음 조회에서 IN_TRANSIT가 아닌 것을 보고 SKIPPED가 된다. 단말기 version 검사를 통과한 뒤라 실제로는 거의 생기지 않는 경우다(재출고가 끼면 단말기 UPDATE에서 먼저 막힌다).
  - 관리 중인 shipment 엔티티는 고치지 않는다. 고치면 커밋 flush에서 조건 없는 UPDATE가 다시 나가 같은 버그가 된다. 이 em은 반영 한 번만 쓰고 버리는 fork라 낡은 엔티티가 남아도 나중에 flush되지 않는다.
- 해결 후: 새 테스트 통과(outcome NOOP, 옛 운송장 SUPERSEDED·deliveredAt null, 단말기 SHIPPED, 새 운송장 IN_TRANSIT). carrier-sync 3회 모두 `9 passed`(5.80s, 5.77s, 5.81s). 전체 api 17개 파일 `128 passed`, `npm test` exit 0, `npm run typecheck` exit 0.
- 배운 것:
  - RR에서 잠그지 않은 읽기로 판단하고 조건 없이 쓰면 lost update다. 판단 조건을 UPDATE의 WHERE에 넣고 바뀐 행 수를 보면 읽기를 잠그지 않아도 된다.
  - 한 엔티티(단말기)에 version이 있다고 같은 트랜잭션의 다른 행까지 보호되지는 않는다.
  - spy hook 안에서 HTTP 요청을 보내면 트랜잭션 컨텍스트가 새어 들어갈 수 있다. 동시성 테스트의 "다른 요청"은 hook 밖에서 보낸다.
  - → study/backlog.md에 추가
