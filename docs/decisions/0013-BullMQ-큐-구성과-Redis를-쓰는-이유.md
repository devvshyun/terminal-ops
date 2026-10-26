# 0013. BullMQ 큐 구성과 Redis를 쓰는 이유

- 날짜 / 관련 기능: 2026-10-22 / F3
- 상황: 배송 중 운송장을 주기적으로 조회해야 한다. 택배사마다 호출 한도가 다르고(번개 429), 워커를 여러 개 띄워도 같은 운송장을 동시에 두 번 조회하면 안 된다.
- 왜 Redis인가(MySQL이 아니라, CLAUDE.md 원칙): 작업 큐는 "꺼내기 + 잠금 + 재시도 예약 + 속도 제한"을 여러 프로세스가 동시에 한다. MySQL 테이블 큐(`SELECT … FOR UPDATE SKIP LOCKED` 폴링)로도 되지만 지연 재시도·속도 제한·완료 정리를 직접 만들어야 한다. BullMQ(Redis)는 이것을 원자적 Lua 스크립트로 제공하고, 데이터는 잃어도 다시 만들 수 있는 job뿐이다(원본 상태는 MySQL의 Shipment·OutboxEvent에 있다). Redis는 AOF·noeviction으로 띄웠다.
- 선택지(큐 구성):
  1. 큐 하나 + job 이름으로 택배사 구분: limiter가 큐 단위라 택배사별 한도를 따로 줄 수 없다.
  2. 택배사별 큐(`track-bungae`, `track-neurimbo`) + 주기 sweep 큐 + outbox 큐: 택배사마다 limiter·동시 처리 수를 따로 정한다. limiter는 Redis에 저장돼 워커 프로세스가 여러 개여도 큐 전체 합산 속도로 묶인다.
  3. BullMQ group limiter(Pro 기능): 쓰지 않는다.
- 결정: 2.
- jobId 규칙: `track-<shipmentId>`. 같은 jobId의 job이 있으면 add가 무시되어 같은 운송장이 동시에 두 번 처리되지 않는다. **`:`는 jobId에 쓸 수 없다**(add가 에러, 사전 검증). 완료·최종 실패 job이 남아 있으면 다음 sweep이 같은 jobId를 못 넣으므로 `removeOnComplete: true`, `removeOnFail: true`. 실패 기록은 SyncRun이 대신한다.
- 테스트 격리: 큐 접두사를 테스트 파일마다 다르게(`test-<pid>-<시각>`), 워커를 쓰는 파일은 `obliterate`, globalSetup이 `test-*`를 지운다. 개발 서버는 `terminal-ops`.
- 결과·대가: Redis가 없으면 API 테스트 전부가 돌지 않는다(큐 모듈이 기본 모듈). sweep 간격 동안은 배송 완료가 늦게 반영된다(기본 30초).
- 다시 볼 조건: 운송장이 수만 건이 되면 sweep 한 번에 전부 넣지 않고 last_synced_at 순으로 나눠 넣는다.
- 갱신(2026-10-26 Day 5): report 큐를 더했다(VAN 대조, Task 6의 이상 찾기, Task 8의 주간 리포트). concurrency 1, 실행 job은 attempts 1(재시도는 호출마다). device 큐에 무거운 집계를 넣지 않으려고 나눴다(experiments/0010).
