# 0026. 앱 공용 Redis 연결 하나와 교체 단말기 예약(Redis)

- 날짜 / 관련 기능: 2026-10-23 / F7, F6 (Day 4 Task 1, Day 3 리뷰 Minor 1·2)
- 상황:
  - ScanLock이 앱마다 전용 ioredis 연결을 만들고 error 리스너가 없었다(`onModuleDestroy`에서 quit). 테스트에서 출처를 알 수 없는 `ERROR [Testing] Error: Connection is closed.`(ioredis `built/redis/event_handler.js:214`, 스택에 우리 코드 없음)가 가끔 나왔다. 이번에 고치기 전 `npx vitest run test/health.e2e.spec.ts`를 8번 돌려 4번, 스택을 보려고 3번 더 돌려 3번 나왔다(11번 중 7번). Redis를 쓰지 않는 health 테스트 앱이 닫힐 때 나온다.
  - Day 4는 하트비트·펌웨어 제안·주기 작업 잠금 등 Redis를 쓰는 곳이 늘어난다.
  - 교체 출고 경합에서 진 요청 N-1건이 사전 확인(트랜잭션 밖)을 통과해 운송장을 발급받은 뒤 트랜잭션에서 422로 끝나 운송장이 고아가 됐다(experiments/0007, 10건 동시면 매회 9장).
- 선택지(연결):
  1. 기능마다 전용 연결 — 연결 수가 늘고 error 리스너·종료 처리가 기능마다 흩어진다.
  2. BullMQ 연결을 같이 쓰기 — BullMQ는 블로킹 명령을 쓰는 연결이 따로 있어 섞기 어렵고, 생명주기가 BullMQ에 묶인다.
  3. **앱 공용 연결 하나(`REDIS` 토큰, 전역 모듈 `RedisModule`)** — error 리스너와 종료를 한 곳에서 한다.
- 결정(연결): 3.
  - `maxRetriesPerRequest: 1`(요청이 Redis 장애에 오래 매달리지 않게).
  - 종료는 `onApplicationShutdown`에서 `quit()`(실패하면 `disconnect()`). 모든 모듈의 `onModuleDestroy`(BullMQ 워커 종료 등)가 끝난 뒤라 처리 중인 job이 닫힌 연결을 쓰지 않는다.
  - 잠금은 `RedisLock`(`keyOf(kind, id)` = `<QUEUE_PREFIX>:<kind>:<id>`, `acquire(key, ttl)` = SET NX PX, `release(key, token)` = 토큰 비교 Lua)으로 일반화하고, ScanLock은 감싸기만 한다. 스캔 잠금 키·동작은 그대로다.
  - 바꾼 뒤 같은 health 명령 8번에서 0번(아래 확인). 원인을 ScanLock 전용 연결로 확정하지는 못했다(스택에 우리 코드가 없다). "바꾸니 사라졌다"까지가 확인한 사실이다.
- 선택지(교체 예약):
  1. 그대로 두기(고아는 Day 7에 정리) — 고아 운송장이 경합 수만큼 계속 생긴다.
  2. **Redis 예약(SET NX PX, 토큰 비교 해제)** — 운송장 발급 전에 진 요청을 돌려보낸다.
  3. MySQL에 예약 행 또는 단말기 상태(RESERVED) — 단말기 상태가 하나 늘고 전이 규칙·이력이 바뀐다. 예약은 처리 중 표시일 뿐인데 영구 상태로 남는다.
- 결정(교체 예약): 2.
  - 왜 Redis인가: "처리 중" 표시는 짧게 살고 프로세스가 죽으면 저절로 풀려야 한다(decisions/0020 스캔 잠금과 같은 이유). 결과(출고·접수 상태)는 여전히 MySQL 트랜잭션이 정한다.
  - 키 `<QUEUE_PREFIX>:replacement-lock:<교체 시리얼>`, TTL `REPLACEMENT_LOCK_TTL_MS`(기본 30초). 진 요청은 409 `REPLACEMENT_RESERVED`.
  - 예약은 사전 확인보다 **먼저** 잡는다. 앞선 요청이 다 끝난 뒤 온 요청은 예약은 잡아도 사전 확인에서 422 `REPLACEMENT_NOT_IN_STOCK`으로 멈춰 운송장을 받지 않는다.
  - 끝나면(성공·실패 모두) 토큰 비교로 푼다. 해제 실패는 경고 로그만 남긴다(반영은 이미 커밋됐을 수 있어 결과를 500으로 바꾸지 않는다, decisions/0020과 같은 처리).
  - TTL 만료 시 동작: 처리가 30초를 넘기면 다른 요청이 예약할 수 있고, 그 요청은 사전 확인을 통과하면 운송장을 발급받은 뒤 트랜잭션의 행 잠금에서 422(INVALID_TRANSITION)로 끝난다 → Day 3과 같은 고아 1장. 먼저 요청의 해제는 토큰이 달라 남의 예약을 지우지 않는다.
  - 같이 고친 것: 설치 확인에서 접수가 REPLACING이 아니면 `TICKET_NOT_OPEN` 대신 `TICKET_NOT_REPLACING`(Day 3 리뷰 Minor 4). `ServiceTicketService.lockOpen`에 오류 코드 인자를 더했다.
- 확인:
  - 테스트 먼저 실패: `test/redis.e2e.spec.ts` 로드 실패(`Cannot find module '../src/redis/redis-lock.js'`), `replacement.e2e` `expected 'TICKET_NOT_OPEN' to be 'TICKET_NOT_REPLACING'`, `expected 201 to be 409`(예약이 없어 둘째 요청이 먼저 트랜잭션까지 가서 이김) → `2 failed | 3 passed (5)`.
  - 고친 뒤: redis·replacement·scan 3개 파일 20 passed, 전체 30개 파일 204 passed, typecheck exit 0.
  - 실험 0007 재실행(experiments/0007 "Day 4 재실행"): 같은 교체 단말기 10건 동시, 두 잠금 순서 × 3회 모두 성공 1·`REPLACEMENT_RESERVED` 9·운송장 발급 1·고아 0(Day 3 매회 9). 서로 다른 교체 단말기 10대는 그대로 10건 201·고아 0. lock_deadlocks 148 → 148.
- 결과·대가:
  - 같은 교체 단말기 동시 요청의 진 쪽 응답이 422에서 409(REPLACEMENT_RESERVED)로 바뀐다.
  - 교체 출고 한 건마다 Redis 왕복 2번(SET, 해제 Lua)이 늘고, Redis가 죽으면 교체 출고가 실패한다(예약을 못 잡으면 예외).
  - 같은 접수에 서로 다른 교체 단말기로 동시에 요청하는 경우는 예약 키가 달라 막지 못한다(추정, 재지 않음: 트랜잭션의 접수 행 잠금 뒤 OPEN 재확인에서 하나가 422 TICKET_NOT_OPEN, 고아 1장).
- 다시 볼 조건: 교체 처리가 TTL에 가까워질 때(택배사 지연), Redis 장애 때 교체 출고를 막을지 우회할지 정해야 할 때.
