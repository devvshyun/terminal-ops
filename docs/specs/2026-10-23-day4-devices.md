# Day 4 설계 — 단말기 시뮬레이터, 접속 상태(하트비트), 펌웨어 단계 배포

- 날짜: 2026-10-23
- 범위: 설계안 8장 Day 4(`device-sim/`, F8 접속 상태 + 펌웨어 단계 배포, 5,000대 하트비트 실험) + Day 3 리뷰 이월(`docs/reviews/2026-10-23-day3-final-review.md` Minor 1·2·4·5·6) + 실험 2개(0008 하트비트 5,000대, 0009 펌웨어 단계 배포)
- 구현 계획: `docs/plans/2026-10-23-day4-devices.md`
- 등장하는 회사(세움전자, 번개택배, 느림보물류, 톡톡메신저)와 가맹점은 모두 가상이다. 단말기 시뮬레이터도 가상 단말기만 흉내 낸다.

## 1. 무엇을 왜

Day 3까지는 단말기가 "물건"이었다. 입고·검수·출고·설치·회수의 상태가 MySQL에 있고, 모든 상태 변경은 전이 서비스 한 곳을 거쳤다. 설치된 단말기는 이제 "살아 있는 장치"다. 수천 대가 30초마다 "나 살아 있다(하트비트)"를 보내고, 운영자는 어느 단말기가 끊겼는지 알고 싶고, 펌웨어를 10% → 50% → 100%로 나눠 배포하다가 실패가 많으면 멈추고 싶다(F8).

1. 단말기 수천 대를 흉내 내는 별도 프로세스 `apps/device-sim`을 만든다(하트비트 송신, 업데이트 지시를 받으면 가짜 업데이트 후 결과 보고).
2. 하트비트를 받는다. **상태 전이가 아니다.** 쓰기가 많고 최신값만 의미 있으므로 Redis에만 쓴다(설계안 4장 Redis ②).
3. 마지막 하트비트가 오래된 단말기를 오프라인으로 판정하고, **바뀐 것만** MySQL에 남기고 알린다. 주기 스냅샷으로 Redis 값을 MySQL에 한꺼번에 반영한다.
4. 펌웨어를 단계별로 배포한다. 단계 대상은 결정적으로 고르고, 하트비트 응답에 업데이트 지시를 싣고, 결과 보고를 모아 다음 단계로 넘기거나 자동 중단한다.
5. 5,000대 하트비트에서 Redis 경로와 "하트비트마다 MySQL" 경로를 숫자로 비교하고(설계안 Day 4 학습 주제 "쓰기 줄이기"), 실패율이 오른 배포가 자동 중단되기까지의 시간과 영향 범위를 잰다.

Day 3 이월: 공용 Redis 연결, 교체 단말기 예약(고아 운송장 9 → 0 확인), `TICKET_NOT_REPLACING`, 기록 정정 2건.

## 2. 구성

```
apps/device-sim (새, node:http, 포트 4020 / 테스트 4021)
  ├─ 관리 API  GET/POST /__admin/config, POST /__admin/start|stop|reset, GET /__admin/stats, GET /__admin/devices/:serialNo, GET /__admin/health
  ├─ Fleet      주기마다 온라인 단말기를 batchSize씩 묶어 POST /devices/heartbeats (동시 요청 ≤ concurrency, keep-alive 에이전트)
  │             응답의 update → updateDelayMs(+jitter) 뒤 POST /devices/firmware-reports (firmwareFailRate, 시드 난수)
  └─ stats      보낸 하트비트·요청·오류·건너뛴 주기, 응답 시간 p50/p95/max, 업데이트 지시·보고 수

apps/api
  ├─ redis       (새) 공용 ioredis 연결(REDIS 토큰, error 리스너, onApplicationShutdown에서 quit), RedisLock(SET NX PX + 토큰 비교 해제)
  ├─ scan        ScanLock → RedisLock 사용(키·동작 그대로)
  ├─ service     교체 단말기 예약(409 REPLACEMENT_RESERVED), 설치 확인 TICKET_NOT_REPLACING
  ├─ device      (새) 하트비트 POST /devices/heartbeats, active(운영 중 단말기) 재구성·프로젝터, 오프라인 판정·스냅샷,
  │              GET /terminals/:serialNo/connectivity, DeviceConnectivity, OfferStore, DeviceProcessor(device 큐)
  ├─ firmware    (새) Firmware·FirmwareRollout·FirmwareRolloutTarget, POST /firmware, POST/GET /firmware-rollouts,
  │              pause·resume·abort, POST /devices/firmware-reports, 배포 판단(control)
  ├─ outbox      relay가 IN_SERVICE 진입·이탈 이벤트를 device 큐에 project job으로도 넣음(두 번째 소비자), 알림 문구 type별
  ├─ queue       device 큐
  └─ scheduler   active-rebuild, offline-detect, connectivity-snapshot, rollout-control 주기 작업
```

## 3. 데이터 모델

| 엔티티 | 핵심 컬럼 | 제약·인덱스 | 메모 |
|---|---|---|---|
| `DeviceConnectivity` | terminal_id(PK), online, last_seen_at datetime(3), firmware_version, changed_at datetime(3) | **FK 없음** | 접속 상태의 MySQL 스냅샷. 판정 job(바뀐 것만)과 스냅샷 job(주기)만 쓴다 |
| `Firmware` | model_id, version, created_by, created_at | unique(model_id, version) | |
| `FirmwareRollout` | firmware_id, stages json(누적 %), current_stage, status(RUNNING·PAUSED·COMPLETED·ABORTED), failure_threshold double, min_samples, stage_timeout_ms, stage_started_at datetime(3), created_by, created_at, finished_at, end_reason | status 인덱스 | 이 행이 배포의 잠금 단위. version 컬럼 없음(모든 변경을 FOR UPDATE 아래에서) |
| `FirmwareRolloutTarget` | rollout_id, terminal_id, stage, status(OFFERED·SUCCEEDED·FAILED·TIMED_OUT), offered_at, reported_at, reported_version | unique(rollout_id, terminal_id), (rollout_id, stage, status) | 단계 진입 때 INSERT. 갱신은 늘 PK로 |

단말기 상태 enum(`TerminalStatus`)과 전이 규칙·이력은 바꾸지 않는다. 마이그레이션 2개(device_connectivity, firmware 3테이블), 모두 create table이라 enum down() 소문자 문제(troubleshooting/0005)가 없다.

## 4. Redis 키 (접두사 = `env.queuePrefix`, 테스트 `test-…`, 개발 `terminal-ops`)

| 키 | 자료구조 | 내용 | 쓰는 곳 |
|---|---|---|---|
| `<p>:hb:lastseen` | ZSET | serialNo → 마지막 하트비트(ms, 서버 시계) | 하트비트(ZADD), 판정(ZRANGEBYSCORE, ZMSCORE), 스냅샷 |
| `<p>:hb:fw` | HASH | serialNo → 펌웨어 버전 | 하트비트, 보고 성공 |
| `<p>:hb:active` | HASH | serialNo → terminal.id (IN_SERVICE만) | 재구성(임시 키 → PERSIST → RENAME), 프로젝터(HSET/HDEL), 하트비트(HMGET) |
| `<p>:hb:offline` | SET | 오프라인으로 기록한 serialNo | 판정 |
| `<p>:hb:snapshot-at` | STRING | 마지막 스냅샷이 반영한 lastSeen 점수 | 스냅샷 |
| `<p>:fw:offers` | HASH | serialNo → `{"rolloutId":n,"version":"…"}` | 배포(HSET, 배포 id 비교 Lua 삭제), 하트비트(HMGET), 보고 |
| `<p>:scan-lock:<scanId>` | STRING | 박스 스캔 처리 중 잠금(기존) | ScanLock → RedisLock |
| `<p>:replacement-lock:<serialNo>` | STRING | 교체 단말기 예약 | ReplacementService |
| `<p>:job-lock:hb-detect`, `…:hb-snapshot` | STRING | 판정·스냅샷 한 번에 하나 | ConnectivityService |

정리는 접두사 SCAN + UNLINK(`test/helpers/redis-keys.ts`, globalSetup의 `test-*`). FLUSH는 쓰지 않는다.

## 5. 흐름

### 5.1 교체 단말기 예약 (Day 3 이월)
```
SET <p>:replacement-lock:<교체 시리얼> <token> NX PX 30000   실패 → 409 REPLACEMENT_RESERVED (운송장 발급 없음)
  사전 확인(접수 OPEN, 교체 단말기 IN_STOCK·같은 모델)  ← 예약 뒤라, 앞선 요청이 끝났으면 여기서 422
  운송장 발급(트랜잭션 밖)
  한 트랜잭션(기존 그대로: 단말기 id 오름차순 → 접수)
finally 토큰 비교 해제(실패해도 결과는 그대로, TTL로 풀림)
```
TTL(`REPLACEMENT_LOCK_TTL_MS`)보다 오래 걸리면 다른 요청이 예약할 수 있고, 그 요청은 Day 3처럼 행 잠금에서 422 + 고아 운송장이 된다(드문 경우, 결정 기록).

### 5.2 하트비트 `POST /devices/heartbeats { items: [{ serialNo, firmwareVersion }] }` (1~500개)
```
행마다 형식 검사(INVALID_FORMAT)
왕복 ①  pipeline: HMGET active <시리얼…>, HMGET offers <시리얼…>
        active에 없으면 IGNORED_NOT_IN_SERVICE
왕복 ②  pipeline: ZADD lastseen now s1 now s2 …, HSET fw s1 v1 …
응답 200 { accepted, results: [{ serialNo, result, update? }] }
```
MySQL 쿼리 0, 전이 서비스·이력·Outbox 없음. 단건은 항목 1개짜리 묶음이다(별도 엔드포인트 없음).

### 5.3 active 유지 (Outbox 두 번째 소비자 + 주기 재구성)
- relay(READ COMMITTED, 기존)가 잡은 행 중 `terminal.status_changed`이면서 IN_SERVICE로 들어오거나 나가는 이벤트를 `device` 큐에 `project` job(jobId `project-<outbox id>`, addBulk)으로도 넣는다.
- `project`는 이벤트의 toStatus를 쓰지 않고 MySQL의 **지금** 상태를 다시 읽어 HSET/HDEL한다(순서 뒤바뀜에 안전). device 큐는 concurrency 1.
- `rebuild-active`(기본 60초): `select id, serial_no from terminal where status='IN_SERVICE'` → 임시 키(PEXPIRE 60초)에 HSET → MULTI(PERSIST, RENAME). RENAME은 TTL을 옮기므로 PERSIST가 먼저다.

### 5.4 오프라인 판정 `detect-offline`(기본 10초, 기준 `HEARTBEAT_OFFLINE_AFTER_MS` 90초)
```
Redis 잠금 job-lock:hb-detect (없으면 건너뜀)
stale = ZRANGEBYSCORE lastseen -inf (now-기준) WITHSCORES
recorded = SMEMBERS offline
pipeline: HMGET active stale, SMISMEMBER offline stale, HMGET active recorded, ZMSCORE lastseen recorded, HMGET fw (둘의 합)
  새 오프라인 = stale ∧ active ∧ 기록 안 됨
  온라인 복귀 = recorded ∧ active ∧ 점수 > now-기준
  운영 중 아님 = stale ∧ active 없음 → ZREM·HDEL(알림 없이 정리)
변화가 있으면 MySQL 한 트랜잭션: device_connectivity UPSERT(terminal_id 오름차순, 한 문장) + Outbox device.offline/device.online
커밋 뒤 Redis: SADD/SREM offline
```
온라인 복귀도 판정 job이 찾는다(하트비트 경로를 Redis 전용으로 두기 위해). 복귀 알림은 최대 판정 주기만큼 늦다.

### 5.5 스냅샷 `snapshot`(기본 60초)
`ZRANGEBYSCORE lastseen (<snapshot-at> +inf WITHSCORES` → active로 terminal_id, fw → `insert … on duplicate key update last_seen_at, firmware_version`(500행씩, terminal_id 오름차순, online은 덮어쓰지 않음) → snapshot-at = 읽은 최대 점수. 바뀐 단말기만 쓴다.

### 5.6 조회 `GET /terminals/:serialNo/connectivity`
단말기 없으면 404. Redis lastSeen이 있으면 `{ source: 'redis', online: lastSeen > now-기준, lastSeenAt, firmwareVersion }`, 없으면 MySQL 스냅샷(`source: 'snapshot'`), 둘 다 없으면 `source: 'none'`.

### 5.7 펌웨어 배포
- `POST /firmware { modelCode, version }`(X-Operator) → 201, 같은 (모델, 버전) 409 DUPLICATE.
- `POST /firmware-rollouts { modelCode, version, stages, failureThreshold, minSamples, stageTimeoutMs? }` →
  ```
  트랜잭션: SELECT terminal_model … FOR UPDATE          ← 같은 모델의 배포 만들기를 줄 세움
            진행 중(RUNNING·PAUSED) 배포가 있으면 409 ROLLOUT_ALREADY_ACTIVE
            INSERT firmware_rollout
            단계 진입: 모수 = 이미 대상 + 아직 대상 아닌 그 모델의 IN_SERVICE
                      ceil(모수 × 비율) - 이미 대상 만큼 CRC32(serial_no), id 순으로 INSERT target(OFFERED)
  커밋 뒤: HSET offers
  ```
- 하트비트 응답: offers에 있으면 그 행에 `update: { rolloutId, version }`.
- 보고 `POST /devices/firmware-reports { serialNo, rolloutId, success, version }` → 대상 id를 잠그지 않고 읽음 → `UPDATE … WHERE id=? AND status='OFFERED'`(PK, 배포 행을 잠그지 않음) → 0행이면 지금 상태(멱등) → 결과와 상관없이 그 배포의 제안 삭제, 성공이면 HSET fw. 대상이 아니면 404.
- pause(RUNNING → PAUSED, 제안 내림), resume(PAUSED → RUNNING, OFFERED의 offered_at을 지금으로 PK 갱신, 제안 다시 검), abort(→ ABORTED, 제안 내림, Outbox). 상태가 맞지 않으면 422 ROLLOUT_NOT_RUNNING·ROLLOUT_NOT_PAUSED·ROLLOUT_FINISHED.
- 제안 삭제는 Lua로 "그 배포의 제안일 때만" 지운다(늦은 삭제가 다른 배포의 제안을 지우지 않게).

### 5.8 배포 판단 `rollout-control`(기본 5초)
```
RUNNING 배포마다 한 트랜잭션:
  ① SELECT firmware_rollout … FOR UPDATE                    ← 잠금 순서: 배포 행 → 대상 행
  ② 지금 단계 OFFERED 중 offered_at + 제한 시간 ≤ now → UPDATE target SET TIMED_OUT WHERE id IN (…) AND status='OFFERED'(PK, id 순)
  ③ 실패율 = (FAILED + TIMED_OUT) / (SUCCEEDED + FAILED + TIMED_OUT)
     > 기준 이고 (결과 ≥ minSamples 또는 남은 OFFERED 0) → ABORTED + Outbox firmware.rollout_aborted
     남은 OFFERED > 0 → 기다림
     마지막 단계 → COMPLETED + Outbox firmware.rollout_completed
     아니면 다음 단계 진입(대상 INSERT) + Outbox firmware.stage_advanced
커밋 뒤: 제안 내림(시간 초과·중단), 새 단계 제안 걸기
```
- 보고는 대상 행 하나만 PK로 바꾸고 배포 행을 잠그지 않으므로, 판단 job이 배포 행을 쥐고 있어도 기다리지 않고 순환 대기가 없다.
- 판단 job이 여러 프로세스에서 동시에 돌아도 배포 행 잠금에서 줄을 서고, 뒤에 온 쪽은 바뀐 단계를 본다(Redis 잠금 불필요).
- 대상 행 INSERT의 FK 검사는 단말기 행에 S 락을 건다. 판단 트랜잭션은 단말기 행을 바꾸지 않아 S→X 승격이 없다.

### 5.9 잠금·쓰기 규칙 요약 (Day 2~3 교훈 반영)
- 부모 행 X 락 먼저: 배포 만들기는 모델 행, 판단·멈춤·재개·중단은 배포 행.
- 여러 행 갱신은 PK `IN (…)` + 상태 조건(보조 인덱스 범위 UPDATE의 gap 락을 피함, troubleshooting/0014). 여러 행 UPSERT는 terminal_id 오름차순.
- 외부 저장소(Redis 제안·active·offline)는 트랜잭션 밖, 커밋 뒤에 맞춘다. 실패하면 다음 주기가 다시 맞춘다(최소 한 번).
- relay는 READ COMMITTED 그대로(troubleshooting/0007), 큐 넣기는 addBulk(pipeline, decisions/0024), jobId에 `:` 금지.
- 원시 SQL의 datetime은 UTC 글자로 온다(`fromDbDatetime`, troubleshooting/0016). SQL 안에서 NOW()와 비교하지 않는다.

## 6. 실패 처리

| 상황 | 응답·동작 |
|---|---|
| 같은 교체 단말기를 다른 요청이 처리 중 | 409 REPLACEMENT_RESERVED(운송장 없음) |
| 설치 확인인데 접수가 REPLACING이 아님 | 422 TICKET_NOT_REPLACING |
| 하트비트 행 형식 틀림 / 운영 중 아님 | 그 행만 INVALID_FORMAT / IGNORED_NOT_IN_SERVICE, 200 |
| 하트비트 묶음 모양 틀림(0개, 501개, 배열 아님) | 400 |
| Redis 연결 실패 | 하트비트·보고 500(Redis가 원본인 경로라 막는다). 판정·스냅샷 job은 실패, 다음 주기 |
| 판정·스냅샷을 다른 프로세스가 돌리는 중 | 건너뜀(skipped) |
| 판정 커밋 뒤 Redis 반영 전에 죽음 | 다음 판정이 같은 변화를 다시 씀(알림 중복 가능, 최소 한 번 + 멱등키) |
| 등록 안 된 펌웨어 / 모델 / 배포 / 대상 | 404 |
| 단계 비율이 커지지 않거나 마지막이 100 아님 | 400 INVALID_STAGES |
| 모델에 진행 중 배포가 있음 | 409 ROLLOUT_ALREADY_ACTIVE |
| 배포 상태가 맞지 않는 pause·resume·abort | 422 ROLLOUT_NOT_RUNNING·ROLLOUT_NOT_PAUSED·ROLLOUT_FINISHED |
| 이미 보고됐거나 시간 초과된 대상의 보고 | 200, 상태 그대로(`alreadyReported: true`), 제안은 내림 |

## 7. 실험

| 번호 | 질문 | 설정 | 볼 것 |
|---|---|---|---|
| 0008 | 하트비트 5,000대에서 Redis 경로와 "하트비트마다 MySQL" 경로의 쓰기 횟수·응답 시간 차이, 묶음 100 대 단건, 오프라인 판정까지 걸린 시간 | device-sim 5,000대, 주기 5초, 30초, 동시 요청 16, 변형 redis/mysql × batch/single, 스냅샷 10초 | 처리량(받은 하트비트/초), p50/p95, 앱이 보낸 쓰기 문장 수, SHOW GLOBAL STATUS(Com_insert, Innodb_rows_*), INFO commandstats, lock_deadlocks(밖에서 root), 끊은 1%가 판정되기까지 ms |
| 0009 | 단계 배포가 실패율 0%면 몇 초에 끝나고, 30%(기준 20%)면 언제 멈추며 그때까지 몇 대가 영향받나, 멈춘 뒤 제안이 정말 사라지나 | 1,000대, 단계 10·50·100, 최소 표본 20, 업데이트 300ms + 0~2초, 판단 0.5초 | 단계 전환 시각, 완료·중단 시각, 대상·성공·실패 수, 끝날 때 offers 수, 끝난 뒤 시뮬레이터가 받은 새 지시 수 |

둘 다 `EXPERIMENTS=1`, `--silent=false`로 로그를 본다. 데드락 수는 테스트 밖에서 root로 `information_schema.innodb_metrics`(앱 계정은 PROCESS 권한 없음).

## 8. 기록할 결정

- 0026 공용 Redis 연결(REDIS, error 리스너, onApplicationShutdown quit)과 RedisLock 일반화, 교체 단말기 예약(예약 뒤 사전 확인, TTL 만료 시 동작)
- 0027 하트비트·접속 상태는 상태 전이가 아니다 — Redis에만 쓰는 파생 상태, 왜 MySQL이 아니라 Redis인가(ZSET·HASH), 단건 엔드포인트 없음, 서버 시계, 실험용 쓰기 경로
- 0028 운영 중 단말기 목록(active): HASH(serialNo → id), Outbox 두 번째 소비자(지금 상태 다시 읽기) + 주기 재구성, 왜 둘 다인가
- 0029 오프라인 판정·스냅샷: 바뀐 것만 MySQL, 복귀 감지는 주기 job, device_connectivity에 FK 없음, upsertMany 대신 QueryBuilder 한 문장, Redis 잠금
- 0030 펌웨어 단계 배포 모델: 별도 테이블(enum 무변경), 대상 선정(CRC32, 누적 비율), 제안은 Redis 사본, 모델당 진행 중 하나(모델 행 잠금), 제안 삭제는 배포 id 비교
- 0031 배포 판단: 잠금 순서(배포 행 → 대상 행, 보고는 대상 행만), 실패율 정의(TIMED_OUT 포함, 지금 단계), 자동 중단 조건, PK 갱신
- 갱신: 0009(device-sim도 같은 방식), 0015(주기 작업 4개 추가), 0016(알림 type별 문구), 0025(collate 없는 이전 테이블 12개)

## 9. 이번에 하지 않는 것

- 단말기 인증(하트비트·보고 서명). 지금은 형식 검사만(decisions/0001과 같은 이유).
- 펌웨어 파일 배포(다운로드 URL, 해시 검증), 이미 그 버전인 단말기를 대상에서 빼기, 실패한 단말기 재시도, 여러 모델 동시 배포 묶음.
- 단계를 넘어선 누적 실패율, 시간대별 배포 창, 운영자 승인 후 다음 단계.
- 한 번도 하트비트를 보내지 않은 단말기의 오프라인 판정(lastSeen이 없어 판정 대상이 아님), 회수·폐기된 단말기의 device_connectivity 행 정리.
- Redis 장애 시 하트비트를 MySQL로 우회하기(지금은 500), lastSeen 유실 뒤 복구(재구성은 active만 한다).
- 같은 접수에 서로 다른 교체 단말기로 동시에 교체 출고할 때의 고아 운송장(예약 키가 교체 단말기 기준이라 막지 못함).
- Day 3 남은 문제: QUEUED outbox 복구 sweep, HTTP 1213 매핑, 영구 오류 운송장 재조회, 공장 발주 멱등, 엑셀 메모리, Day 1 리뷰 Minor 2·4·5·6·7, MaxListenersExceededWarning(Day 2 Minor 6).
