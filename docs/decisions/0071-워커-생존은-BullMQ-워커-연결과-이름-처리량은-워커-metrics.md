# 0071. 워커가 살아 있나는 BullMQ 워커 연결과 이름으로, 처리량은 워커 metrics로

- 날짜 / 관련 기능: 2026-10-29 / 보강 6, 운영 관제
- 상황: 관제 화면에 "이 큐를 처리하는 워커가 있나"와 "최근 몇 분 동안 몇 개를 처리했나"가 있어야 한다. api는 워커를 같은 프로세스(RUN_WORKERS=1)나 따로 띄운 워커 프로세스(`dist/worker.js`)에서 돌린다(0015). 이 시스템의 job은 거의 다 끝나면 지워진다(`removeOnComplete`) — Redis의 completed 수로는 처리량을 셀 수 없다.
- 사전 검증(BullMQ 6.4.0, 테스트 접두사): 이름을 준 워커를 띄우면 `queue.getWorkers()`가 `[{ rawname: '<접두사>:<큐 base64>:w:<이름>', idle, … }]`를 주고, 워커를 닫으면 0이 된다. `metrics: { maxDataPoints }`를 준 워커는 job이 끝날 때마다 `getMetrics('completed'|'failed')`의 `meta.count`를 올린다 — 막 끝난 job 2개는 `data: []`, `meta: { count: 2, prevCount: 0 }`(마지막 갱신 분의 수는 아직 data에 없고 count − prevCount다). job을 지워도(`removeOnComplete`) 센다.
- 선택지(생존):
  1. **BullMQ 워커 연결(`getWorkers` — Redis `CLIENT LIST`의 연결 이름)** — 워커가 블로킹 연결을 쥐고 있는 동안만 보인다. 프로세스가 죽으면 연결이 끊겨 바로 사라진다. 코드는 `@Processor` 옵션에 `name` 한 줄
  2. 워커 하트비트 키(`ops:worker:<이름>`, N초마다 SET EX) — 관리형 Redis처럼 `CLIENT` 명령이 막혀도 된다. 대신 타이머·키 이름 규칙·만료를 직접 만들고, 이벤트 루프가 멈춘(살아 있지만 처리 못 하는) 워커도 하트비트가 끊길 때까지 산 것으로 보인다 — 1과 같은 한계에 코드가 는다
  3. 마지막 처리 시각(`getMetrics`의 prevTS)으로 추정 — 할 일이 없는 큐(밤의 report)는 오래 조용한 것이 정상이라 죽음과 구분이 안 된다
- 선택지(처리량): (a) **워커 metrics** — 워커 옵션 한 줄, Redis에 큐마다 분 단위 목록 두 개(1,440칸 = 하루) (b) 처리할 때마다 우리 카운터를 INCR — 프로세서마다 코드가 든다 (c) `sync_run`처럼 DB 기록 — 큐 하나(택배 추적)에만 있다
- 결정: 생존 1, 처리량 (a). 모든 `@Processor`에 `WORKER_OBSERVABILITY = { name: env.workerName, metrics: { maxDataPoints: 1440 } }`(`src/queue/worker-options.ts`)를 펼쳐 넣는다. 워커 이름은 이미 있는 `WORKER_NAME`(없으면 `pid-<pid>`, SyncRun에도 남는 값)이다. "최근 15분"은 `recentCount`(`src/ops/queue-metrics.ts`)가 metrics를 지금 시각으로 잘라 센다 — BullMQ는 job이 끝날 때만 metrics를 갱신해, 한동안 끝난 job이 없으면 data가 그때에 멈춰 있다(그대로 더하면 옛 수를 "최근"으로 센다). 기록이 한 번도 없으면 null(화면 '-').
  - api 버전은 `APP_VERSION` env(없으면 `dev`) — Docker로 띄울 때(보강 9) 넣는다. 기동 시각은 `process.uptime()`으로 계산한다(그 api 프로세스 것 — 따로 띄운 워커 프로세스의 기동 시각은 보이지 않는다)
- 결과·대가: CLIENT 명령을 막은 Redis(일부 관리형)에서는 BullMQ가 이름 없는 항목 하나를 줘 "이름 없는 워커 1"로 보인다 — 이 프로젝트의 Docker Redis는 된다. 연결이 살아 있어도 처리기가 멈춘 워커(무한 루프 등)는 산 것으로 보인다(처리량 0·대기 증가로 알아챈다). metrics는 큐마다 Redis 목록 두 개(각 최대 1,440칸)를 더 쓴다. 워커 옵션은 데코레이터 인자라 env를 모듈을 읽을 때 한 번 읽는다(테스트는 파일마다 새로 읽는다).
- 다시 볼 조건: 관리형 Redis로 옮기거나, 멈춘 워커를 자동으로 알아채야 하면 2(하트비트 + 처리 진행 시각). 처리량 그래프가 필요하면 metrics data를 그대로 내려준다.
