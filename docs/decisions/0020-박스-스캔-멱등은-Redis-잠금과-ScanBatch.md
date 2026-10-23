# 0020. 박스 스캔 멱등은 Redis 잠금과 ScanBatch

- 날짜 / 관련 기능: 2026-10-23 / F6
- 상황: 스캐너는 응답을 못 받으면 같은 박스를 다시 보낸다. 같은 박스를 두 번 반영하면 안 된다(설계안 F6 "중복 스캔은 한 번만"). 처리 중에 두 번째 요청이 오는 경우와, 끝난 뒤 다시 오는 경우가 있다.
- 왜 Redis인가(CLAUDE.md 원칙): "지금 처리 중"은 짧게 살다 사라지는 정보이고, 프로세스가 죽으면 저절로 풀려야 한다(TTL). MySQL로 하면 잠금 행을 만들고 지우는 쓰기가 늘고, 죽은 프로세스의 행을 치울 방법이 따로 필요하다.
- 왜 MySQL(ScanBatch)도인가: 처리 결과는 영구히 남아야 하고(재요청에 같은 결과, 대조 리포트의 unexpected 출처), 반영과 **같은 트랜잭션**에 저장돼야 "반영됐는데 결과 기록이 없다"가 생기지 않는다. Redis만 쓰면 TTL·유실 뒤 같은 scanId가 다시 처리된다.
- 선택지:
  1. MySQL만: ScanBatch를 트랜잭션 첫 문장으로 INSERT해 unique 키로 줄 세우기. 두 번째 요청은 첫 트랜잭션이 끝날 때까지 커넥션을 쥐고 기다린다(큰 박스면 수 초).
  2. Redis만: 위 이유로 영구 결과가 없다.
  3. **Redis SET NX PX(처리 중) + MySQL ScanBatch(완료 결과, scan_id unique)**: 처리 중 중복은 즉시 409 SCAN_IN_PROGRESS, 끝난 뒤 중복은 200 replayed.
- 결정: 3. 잠금 키는 큐와 같은 접두사(`<QUEUE_PREFIX>:scan-lock:<scanId>`)라 테스트 키는 globalSetup이 지운다. 해제는 토큰 비교 Lua(남이 잡은 잠금을 지우지 않게). TTL(30초, `SCAN_LOCK_TTL_MS`)이 지나 둘 다 처리되면 `scan_batch.scan_id` unique가 늦은 쪽을 롤백시키고 먼저 끝난 결과를 준다.
- 같은 scanId, 다른 내용: 요청(kind, poNo, serials)의 SHA-256을 저장해 다르면 422 SCAN_ID_REUSED.
- 테스트: 첫 요청을 엔진 안에서 멈춘 채 같은 scanId → 409, 풀린 뒤 → 200 replayed, 이력 수 그대로.
- 결과·대가: 입고 트랜잭션은 `retryOnUniqueViolation`(unique 위반·데드락, 3번)으로 감싸 있다. TTL이 지나 늦은 쪽이 scan_batch unique에 걸리면 재시도에서도 같은 unique에 걸려 3번을 다 쓰고 나서야 저장된 결과를 준다. 드문 경우라 그대로 둔다.
- 다시 볼 조건: 한 박스 처리가 TTL(30초)에 가까워지면(행 수 상한을 올릴 때), 또는 Redis 장애 시 스캔을 막을지 통과시킬지 정해야 할 때.
