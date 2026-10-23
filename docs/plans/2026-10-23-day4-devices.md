# Day 4 — 단말기 시뮬레이터, 접속 상태(하트비트), 펌웨어 단계 배포 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **기록 규칙 필수**: 이 저장소의 `CLAUDE.md`를 먼저 읽는다. 모든 Task는 마지막에 `docs/devlog/2026-10-23.md`(Task 1이 `# Day 4` 구분선을 넣는다. 작업 중 날짜가 바뀌면 그날 날짜로 새 파일 `docs/devlog/YYYY-MM-DD.md`를 시작하고 첫 줄에 이전 파일을 링크한다)에 항목을 덧붙이고(Day 3 항목과 같은 형식: 제목 시각 = 커밋 시각, `이전 커밋:`, 한 일·확인·막힌 것·결정·다음), Task에 적힌 결정·트러블슈팅·실험 기록을 쓴 뒤 **코드와 같은 커밋**에 넣는다. 예상과 다른 에러를 만나면 고치기 전에 `docs/troubleshooting/`에 기록을 시작한다(이 계획이 0016을 Task 7에 예약했으므로 새로 생기면 0017부터).

**Goal:** 가상 단말기 수천 대를 흉내 내는 `apps/device-sim`을 만들고, 하트비트로 접속 상태(온라인·오프라인)를 관리하며(F8), 펌웨어를 단계별로 배포하다 실패율이 높으면 자동으로 멈춘다(F8). 5,000대 하트비트(Redis 대 MySQL 직접 쓰기)와 실패율 상승 시 자동 중단을 실험으로 남긴다. Day 3 리뷰 이월(공용 Redis 연결, 교체 단말기 예약 등)을 먼저 정리한다.

**Architecture:** 하트비트는 상태 전이가 아니다 — 전이 서비스·이력·Outbox를 거치지 않고 Redis(ZSET lastSeen, HASH firmware)에만 쓴다. 하트비트를 받을 단말기 목록(Redis HASH active)은 Outbox 두 번째 소비자(IN_SERVICE 진입·이탈 이벤트 → 지금 상태를 다시 읽어 반영)와 주기 재구성으로 맞춘다. 오프라인 판정 job은 바뀐 것만 MySQL(`device_connectivity`)·Outbox에 쓰고, 스냅샷 job이 Redis 값을 주기적으로 한꺼번에 MySQL에 반영한다. 펌웨어 배포는 별도 테이블(단말기 상태 enum 무변경)이고, 제안은 커밋 뒤 Redis HASH에 걸어 하트비트 응답의 빠른 길로 쓴다. 배포 판단 job은 배포 행 → 대상 행 순서로 잠그고, 보고 API는 대상 행 하나만 PK로 바꾼다. 설계 스펙: `docs/specs/2026-10-23-day4-devices.md`.

**Tech Stack:** Node 24, TypeScript 6.0, Nest.js 12.2 (ESM), MikroORM 7.2.5, MySQL 8.4, Redis 7.4 + ioredis 5.11.1, BullMQ 6.4.0, Vitest 5 + unplugin-swc, supertest. device-sim은 의존성 없는 node:http(개발 의존성 typescript·vitest·@types/node만).

---

## 프로세스·데이터 안전 규칙 (모든 Task에 적용)

- **프로세스는 PID로만 끈다.** 직접 띄운 프로세스의 PID(`$!`, `child.pid`)로 `kill <PID>`. `taskkill /IM node.exe`, `pkill node`처럼 이름으로 끄지 않는다(다른 세션·IDE의 node가 함께 죽는다). device-sim을 띄우는 테스트 헬퍼도 자기 자식 프로세스만 끈다.
- **Redis를 통째로 지우지 않는다.** `FLUSHALL`·`FLUSHDB` 금지. 테스트 키는 접두사 `test-`(globalSetup이 `test-*`만 지운다, 파일 안에서는 `test/helpers/redis-keys.ts`의 `deleteTestKeys`), 개발 서버는 `terminal-ops`. 주기 작업을 지울 때는 `npm run scheduler:clear`.
- **테스트는 테스트 DB(`terminal_ops_test`)에서만.** `resetDatabase`는 테스트 DB가 아니면 거절한다. 테스트 DB는 지우고 다시 만들어도 된다(아래 명령). 개발 DB(`terminal_ops`)에는 마이그레이션 적용(`npm run db:migrate`)과 시드, Task 11의 실서버 확인만 한다. 개발 DB를 지우거나 `schema refresh`하지 않는다.
  ```bash
  MSYS_NO_PATHCONV=1 docker exec terminal-ops-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "drop database terminal_ops_test; create database terminal_ops_test character set utf8mb4 collate utf8mb4_0900_ai_ci; grant all privileges on terminal_ops_test.* to '"'"'terminal_ops'"'"'@'"'"'%'"'"';"'
  ```
- 데드락 수(`information_schema.innodb_metrics`의 `lock_deadlocks`)는 앱 계정이 PROCESS 권한이 없어 읽지 못한다(`ERROR 1227`). 실험 명령에서 root로 테스트 밖에서 전후를 읽는다(읽기만).
- 실서버 확인·device-sim을 띄운 뒤에는 포트(3000·4010·4020, 테스트 4011·4021)에 리스너가 남지 않았는지 `netstat -ano | grep -E ':(3000|4010|4020|4011|4021) .*LISTENING'`으로 확인한다.

## 사전 검증으로 확인된 사실 (2026-10-23, 임시 폴더 스파이크)

계획 작성 전에 저장소(브랜치 `day4-devices`, master 1684872)를 임시 폴더에 복제해 이 계획의 코드를 Task 순서대로 적용하고, Task마다 `tsc --noEmit`과 vitest(api, partners, device-sim)를 돌려 통과를 확인했다(테스트 DB `terminal_ops_test`, Redis는 테스트 접두사만). 실험 0007 재실행과 실험 0008·0009는 한 번씩 끝까지 돌렸고(숫자는 여기 적지 않는다), 빈 테스트 DB에 마이그레이션 14개를 `up`한 뒤 `check`가 `최신 상태`인 것, 테스트 DB·다른 포트(3100·4110·4120)로 Task 11의 실서버 스크립트를 끝까지 돌린 것을 확인했다. 검증이 끝난 뒤 테스트 DB는 지우고 빈 DB로 다시 만들어 두었다.

- 테스트 수(누적, api 기본 실행): Day 3 끝 29개 파일 200 → Task 1 30/204 → Task 3 31/208 → Task 4 32/212 → Task 5 34/220 → Task 6 35/228 → Task 7 37/236 → Task 8 38/237 → Task 9 38/238(Task 2·10·11은 api 기본 실행 수가 그대로). device-sim: Task 2 3/12 → Task 8 4/19. partners: 5/40 그대로.
- **"Connection is closed" 로그(Day 3 리뷰 Minor 2)**: 고치기 전 코드에서 `npx vitest run test/health.e2e.spec.ts`를 6번 돌려 1번, `connection-collation`과 함께 3번 돌려 1번 `ERROR [Testing] Error: Connection is closed.`(ioredis `event_handler.js` close)가 나왔다. Redis를 쓰지 않는 앱(health)이 닫힐 때 나오므로 ScanLock의 전용 연결(앱마다 생성, error 리스너 없음, `onModuleDestroy`에서 quit)이 유력하다(추정, 스택에 우리 코드가 없어 확정 못 함). 공용 연결로 바꾼 뒤 같은 명령 8번, 전체 실행 7번에서 0번이었다. Task 1에서 직접 재현해 기록한다.
- **ioredis 5.11.1**: `pipeline()`·`multi()`의 `exec()`는 명령 하나가 실패해도 거절하지 않고 `[오류, 값]` 쌍 배열을 준다 → `execOrThrow`로 감싼다. `hmget`(없으면 null), `smismember`(0/1 배열, Redis 6.2+), `zmscore`(null 또는 글자), `zrangebyscore(key, min, max, 'WITHSCORES')`(멤버·점수가 번갈아 나오는 1차원 배열), `zadd(key, ...[점수, 멤버, …])`, `hset(key, 객체)`, `pipeline().length`(쌓인 명령 수)가 타입과 실행에서 모두 맞다. `eval` 안에서 `cjson.decode`를 쓸 수 있다(Redis 7.4).
- **RENAME은 원래 키의 TTL을 가져간다**: `pexpire tmp 60000` → `rename tmp dst` → `pttl dst` = 59996. 그래서 active 재구성은 임시 키에 TTL을 걸고(중간에 죽으면 사라지게) `MULTI: PERSIST tmp, RENAME tmp active`로 바꾼다.
- **MikroORM 7.2.5 `em.upsertMany`(MySQL)**: `insert … on duplicate key update`를 보낸 뒤 관리 엔티티를 만들려고 같은 행을 `select … where (terminal_id = ? or terminal_id = ? …)`로 다시 읽는다(쿼리 로그 확인, 5,000행이면 OR 5,000개). 엔티티가 필요 없어 `em.createQueryBuilder(E).insert(rows).onConflict('terminalId').merge([...]).execute()`로 바꿨고, 이것은 `insert … on duplicate key update \`last_seen_at\` = values(\`last_seen_at\`), …` 한 문장만 보낸다.
- **원시 SQL의 datetime은 UTC 글자**: MikroORM 7은 `forceUtcTimezone`(기본 true)으로 mysql2 `timezone: 'Z'`를 쓰고 `dateStrings: true`라, `em.execute`의 datetime 열은 `'2026-10-23 09:29:15.606'`처럼 시간대 없는 UTC 글자로 온다. `new Date(글자)`는 이를 지역 시간(KST)으로 읽어 9시간 이르게 된다(배포 판단에서 모든 대상이 바로 시간 초과). MySQL 세션 `time_zone`은 `SYSTEM`이라 SQL의 `now(3)`는 KST다(저장값과 비교하면 틀린다). → `fromDbDatetime`(Task 7). 엔티티로 읽은 값은 MikroORM이 맞게 바꾼다.
- `@Property({ type: 'datetime', length: 3 })` → 마이그레이션 `datetime(3)`, 밀리초까지 저장·복원된다.
- `em.createQueryBuilder(Terminal).select(['id', 'serialNo']).where(…).execute('all')`는 속성 이름(`serialNo`) 키로 돌려준다.
- `em.insertMany(Terminal, rows)`로 운영 중 단말기 5,000대를 INSERT 5번에 넣을 수 있다(테스트·실험 준비용).
- MikroORM 7 JSON 속성 조회 `em.find(OutboxEvent, { payload: { rolloutId } })`가 MySQL 8.4에서 동작한다.
- `SHOW GLOBAL STATUS`는 앱 계정으로 읽힌다(PROCESS 불필요). `INFO commandstats`는 `cmdstat_<명령>:calls=<n>` 줄을 준다.
- Node 24 `zlib.crc32('HB-0001')` = 3415314250 = MySQL `crc32('HB-0001')`. 테스트가 배포 대상 순서를 JS로 계산할 수 있다.
- Nest `app.close()`는 테스트에서도 `onApplicationShutdown`을 부른다. ioredis `quit()`은 서버의 OK에서 끝나고 상태는 잠시 `ready`이며, 소켓이 닫히면 `'end'` 이벤트 뒤 `end`가 된다(테스트는 `'end'`를 기다린다).
- 테스트 앱을 실제 포트로 열어 device-sim이 부를 수 있다: `await t.app.listen(0, '127.0.0.1')` → `t.app.getHttpServer().address().port`. supertest도 그대로 쓴다.
- device-sim의 keep-alive 에이전트(`maxSockets = concurrency`)로 요청 80번을 보내도 서버가 본 클라이언트 포트는 4개 이하였다(Windows 임시 포트 고갈 방지).
- relay가 `device` 큐에 addBulk를 한 번 더 해도 outbox 테스트의 멈춤 지점(첫 `outbox` addBulk)·부분 실패 테스트는 그대로 통과한다(다른 큐 인스턴스).
- `db:migration:create`로 만든 마이그레이션 2개는 모두 create table이라 down()이 drop table(troubleshooting/0005의 enum 소문자 문제 없음). create table 끝에 `collate utf8mb4_0900_ai_ci`가 붙는다(decisions/0025 뒤라서).
- 빈 테스트 DB에 `up`을 하면 `.snapshot-terminal_ops_test.json`이 또 생긴다(troubleshooting/0015). 커밋하지 않고 치운다.
- 개발 DB에는 이전 실서버 확인이 남긴 운영 중 SN-100 단말기가 있어, 실서버 확인의 배포를 SN-100으로 하면 시뮬레이터가 흉내 내지 않는 단말기가 대상에 섞인다 → Task 11은 SN-300으로, 짧은 제한 시간·기준 1(시간 초과로 멈추지 않음)으로 돈다.

## 범위 조정 (브리프와 다르게 한 것과 이유)

- **active는 SET이 아니라 HASH(serialNo → terminal.id)**: 스냅샷·오프라인 판정·실험용 MySQL 쓰기 경로가 terminal_id를 알아야 한다. SET이면 매번 `select id … where serial_no in (…)`이 필요하다. 하트비트의 확인은 `HMGET`(없으면 null)으로 같다(decisions/0028).
- **단건 하트비트 엔드포인트를 따로 만들지 않는다**: 단건 = 항목 1개짜리 묶음. 실험 0008의 "묶음 대 단건"은 같은 엔드포인트에 batchSize 100 대 1로 비교한다(요청당 비용이 질문이므로). `sentAt`도 받지 않는다 — lastSeen은 서버 시계로만 정한다(단말기 시계를 믿지 않음, decisions/0027).
- **온라인 복귀는 판정 job이 찾는다**(하트비트 경로가 아니라): 하트비트 경로를 Redis 전용으로 둔다. 복귀 알림은 판정 주기(기본 10초)만큼 늦다(decisions/0029).
- **`em.upsertMany` 대신 QueryBuilder UPSERT 한 문장**(사전 검증 사실). `device_connectivity`에는 terminal FK를 두지 않는다(수천 행 UPSERT가 단말기 행마다 S 락을 걸지 않게, Outbox와 같은 이유).
- **`firmware_rollout`에 version 컬럼을 두지 않는다**: 배포 행의 모든 변경(판단·멈춤·재개·중단)이 FOR UPDATE 아래에서 일어나 낙관적 락이 필요 없다.
- **실패율 정의**: 지금 단계의 (FAILED + TIMED_OUT) / (SUCCEEDED + FAILED + TIMED_OUT). 시간 초과도 실패로 센다(아무도 성공하지 않았는데 다음 단계로 가지 않게). 결과가 minSamples보다 적어도 단계가 다 끝났으면(남은 OFFERED 0) 기준을 적용한다(decisions/0031).
- **모델당 진행 중(RUNNING·PAUSED) 배포는 하나**: 같은 단말기에 제안이 둘 걸리지 않게. 만들 때 `terminal_model` 행을 FOR UPDATE로 잡아 줄 세운다(브리프에 없던 규칙, 409 ROLLOUT_ALREADY_ACTIVE).
- **알림 추가**: 브리프는 중단 알림만 적었지만, 단계 시작(`firmware.stage_advanced`)과 완료(`firmware.rollout_completed`)도 Outbox로 남긴다(운영자가 진행을 본다). 알림 문구는 type별로 나눈다(decisions/0016 "다시 볼 조건").
- **재개 시 offered_at을 지금으로 다시 잡는다**: 멈춘 동안을 제한 시간에 넣지 않으려고. 대상 행은 PK로 갱신.
- **보고 대상이 아니면 404**(브리프는 정하지 않음). 보고는 결과와 상관없이 그 배포의 제안을 내린다(실패 단말기에 같은 버전을 다시 권하지 않음, 재시도는 하지 않는 것으로 정함).
- **제안 삭제는 배포 id를 비교하는 Lua**: 중단된 배포의 늦은 삭제가 같은 단말기에 새로 생긴 다른 배포의 제안을 지우지 않게.
- **device-sim에 `updateJitterMs`와 "이미 그 버전이면 지시 무시"를 더했다**: 사전 검증에서 지터 없이 300ms 고정이면 한 단계의 보고가 한꺼번에 와서 판단 job이 단계가 다 끝난 뒤에야 판단했다(자동 중단 시점을 볼 수 없다). 또 성공 보고 직전에 offers를 읽은 하트비트 응답이 지시를 한 번 더 실어 와 같은 단말기가 두 번 업데이트하는 것을 봤다(결과는 멱등이라 같음) → 같은 버전이면 무시.
- **device-sim 결정은 새 번호가 아니라 decisions/0009 갱신**: partners와 같은 선택(node:http 별도 프로세스, 시드 난수, 관리 API)이라서. 새 선택(keep-alive·동시성 상한·건너뛴 주기 세기)은 그 갱신에 적는다. 그래서 결정 번호는 0026(이월)·0027(하트비트)·0028(active)·0029(판정·스냅샷)·0030(배포 모델)·0031(배포 판단)이다.
- **교체 예약은 사전 확인보다 먼저 잡는다**(브리프는 "운송장 발급 전"): 예약을 잡은 뒤 사전 확인을 해야, 앞선 요청이 다 끝난 뒤 온 요청이 예약은 잡더라도 사전 확인(REPLACEMENT_NOT_IN_STOCK)에서 멈춰 운송장을 받지 않는다.
- **decisions/0025 한 줄**: 브리프는 purchase_order·scan_batch만 적었지만 실제로는 service_ticket 이전 마이그레이션의 create table 12개 모두 collate를 적지 않았다(`grep`으로 확인). 그대로 적는다.
- **device 큐 하나(concurrency 1)**: active 갱신(project, rebuild-active), 판정, 스냅샷, 배포 판단을 한 큐·한 프로세서에 둔다. 한 워커 안에서 active 갱신이 겹치지 않게 하려는 것이고, 지금 규모에서 서로 막는 시간은 짧다(다시 볼 조건에 적는다).
- **실험 0008의 처리량은 "주어진 부하"에서의 값**: 5,000대 × 5초 주기 = 초당 1,000건을 보내고 그것을 다 받는지, 그때의 응답 시간·쓰기 횟수를 본다. 한계 처리량은 `EXP_INTERVAL_MS`를 줄여 따로 볼 수 있게 했다(결과에 적는다).
- 하지 않는 것(스펙 9장): 단말기 인증, 펌웨어 파일 배포, 이미 그 버전인 단말기 제외, 실패 단말기 재시도, 누적 실패율, 한 번도 안 보낸 단말기의 오프라인 판정, Redis 장애 우회, 같은 접수·다른 교체 단말기 동시 출고, Day 3 남은 문제들.

## 파일 구조

```
terminal-ops/
├─ .env.example                          REPLACEMENT_LOCK_TTL_MS, DEVICE_SIM_PORT, 주기 작업 간격들
├─ apps/device-sim/ (새)
│  ├─ package.json, tsconfig.json, tsconfig.build.json, vitest.config.ts
│  ├─ src/main.ts, server.ts(관리 API), fleet.ts(하트비트 루프·업데이트 흉내), client.ts(keep-alive), config.ts, stats.ts, http.ts, rng.ts
│  └─ test/helpers.ts(가짜 API), fleet.spec.ts, admin.spec.ts, stats.spec.ts, firmware.spec.ts
└─ apps/api/
   ├─ src/
   │  ├─ redis/ (새)                     redis.provider.ts(REDIS), redis.module.ts, redis-lock.ts, redis-exec.ts
   │  ├─ scan/scan-lock.ts               RedisLock 사용
   │  ├─ service/                         교체 예약, TICKET_NOT_REPLACING
   │  ├─ device/ (새)                    device-keys, heartbeat.service, active-set.service, connectivity.service, offer-store,
   │  │                                  device-connectivity.entity, device.controller, connectivity.controller, device.processor, device.module, dto/
   │  ├─ firmware/ (새)                  firmware.entities, firmware.service, rollout.service, firmware-report.service, 컨트롤러 2개, firmware.module, dto/
   │  ├─ outbox/                          relay의 project job, OUTBOX_TYPE 추가, textOf(type별)
   │  ├─ common/db-datetime.ts (새)      원시 SQL datetime → Date(UTC)
   │  ├─ queue/queue-names.ts             device 큐
   │  ├─ scheduler/                       주기 작업 목록(every 포함), SchedulerService(큐 3개)
   │  ├─ workers/workers.module.ts        DeviceProcessor, DeviceModule·FirmwareModule
   │  ├─ config/env.ts, app.module.ts, entities.ts
   │  └─ migrations/                      device_connectivity, firmware 3테이블
   └─ test/
      ├─ helpers/redis-keys.ts, device-fleet.ts, device-sim.ts, metrics.ts (새)
      ├─ redis, heartbeat, active-set, connectivity, firmware-rollout, firmware-control, device-sim .e2e.spec.ts (새)
      ├─ unit/outbox-text.spec.ts, unit/db-datetime.spec.ts (새)
      ├─ replacement.e2e.spec.ts, scheduler.e2e.spec.ts, experiments/replacement-race.spec.ts (변경)
      └─ experiments/heartbeat-load.spec.ts, firmware-rollout.spec.ts (새, EXPERIMENTS=1)
```

명령은 별도 표시가 없으면 `terminal-ops/apps/api`에서 실행한다. device-sim 명령은 `terminal-ops/apps/device-sim`, partners 명령은 `terminal-ops/apps/partners`에서. Docker 명령이 PATH에 없으면 `"/c/Program Files/Docker/Docker/resources/bin/docker.exe"`를 쓴다. MySQL·Redis 컨테이너가 떠 있어야 한다(`docker compose ps`).

기록 번호: decisions 0026~0031, troubleshooting 0016(Task 7 예약, Task 1의 "Connection is closed"가 바꾼 뒤에도 재현되면 0017), experiments 0008·0009. devlog는 `docs/devlog/2026-10-23.md`에 이어 쓴다.

코드 블록에 "전체"라고 적힌 파일은 그 내용으로 파일 전체를 바꾼다(기존 내용에 이번 변경을 반영한 결과다). 사전 검증 저장소의 Task별 상태에서 그대로 가져왔다.

devlog의 `이전 커밋:`은 그 Task를 시작할 때의 `git log -1 --format=%h`다.

---

### Task 1: Day 3 이월 — 공용 Redis 연결, 교체 단말기 예약, TICKET_NOT_REPLACING, 기록 정정 (F7, F6)

**Files:**
- Create: `apps/api/src/redis/redis.provider.ts`, `apps/api/src/redis/redis-lock.ts`, `apps/api/src/redis/redis.module.ts`
- Modify: `apps/api/src/scan/scan-lock.ts`, `apps/api/src/app.module.ts`, `apps/api/src/config/env.ts`, `apps/api/src/service/replacement.service.ts`, `apps/api/src/service/service-ticket.service.ts`, `.env.example`
- Test: `apps/api/test/helpers/redis-keys.ts`(새), `apps/api/test/redis.e2e.spec.ts`(새), `apps/api/test/replacement.e2e.spec.ts`, `apps/api/test/experiments/replacement-race.spec.ts`
- Record: `docs/devlog/2026-10-23.md`(`# Day 4` 구분선), `docs/decisions/0026-공용-Redis-연결과-교체-단말기-예약.md`, `docs/experiments/0007-교체-단말기-동시-요청.md`(Day 4 재실행 절), `docs/decisions/0025-…`(한 줄), `docs/experiments/0006-대량-처리.md`(기준 표시 정정), `docs/study/backlog.md`. 재현되면 `docs/troubleshooting/0017-…`

바꾸는 것 요약:
- 공용 Redis 연결 하나(`REDIS` 토큰): `error` 리스너, `onApplicationShutdown`에서 `quit()`(모든 `onModuleDestroy`가 끝난 뒤라 처리 중인 job이 닫힌 연결을 쓰지 않는다). `ScanLock`은 전용 연결을 버리고 일반화한 `RedisLock`(SET NX PX + 토큰 비교 Lua 해제)을 쓴다. 키(`<prefix>:scan-lock:<scanId>`)와 동작은 그대로다.
- 교체 출고: 맨 먼저 교체 단말기 시리얼로 `<prefix>:replacement-lock:<시리얼>`을 예약한다. 진 요청은 운송장 없이 409 `REPLACEMENT_RESERVED`. 예약을 잡은 뒤 사전 확인을 하므로, 앞선 요청이 끝난 뒤 온 요청은 422 `REPLACEMENT_NOT_IN_STOCK`으로 운송장을 받지 않는다. 끝나면(성공·실패 모두) 토큰 비교로 푼다. 해제 실패는 경고만(decisions/0020과 같은 처리). TTL `REPLACEMENT_LOCK_TTL_MS`(기본 30초).
- 설치 확인에서 접수가 REPLACING이 아니면 `TICKET_NOT_REPLACING`(Day 3 리뷰 Minor 4). `lockOpen`에 오류 코드 인자를 더한다.
- 기록 정정: decisions/0025 한 줄(Minor 5), devlog 3일차 요약·experiments/0006의 "3회 범위" 기준 표시(Minor 6).

- [ ] **Step 1: "Connection is closed"를 고치기 전에 재현해 둔다 (Day 3 리뷰 Minor 2)**

Run (Git Bash):
```bash
for i in 1 2 3 4 5 6 7 8; do npx vitest run test/health.e2e.spec.ts 2>&1 | grep -cE "Connection is closed" ; done
```
Expected: 대부분 `0`, 가끔 `2`(같은 오류가 Nest 로그와 스택으로 두 줄). 사전 검증에서는 6번 중 1번 나왔다(`ERROR [Testing] Error: Connection is closed.`, ioredis `built/redis/event_handler.js:214`). 몇 번 중 몇 번 나왔는지 devlog에 적는다. 한 번도 안 나오면 8번을 한 번 더 돌리고, 그래도 0이면 "재현 못 함"으로 적는다.

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/api/test/helpers/redis-keys.ts`(새):
```ts
import type { Redis } from 'ioredis';
import { env } from '../../src/config/env.js';

/**
 * 이 테스트 파일의 접두사(env.queuePrefix)로 시작하는 Redis 키를 SCAN + UNLINK로 지운다. FLUSH는 쓰지 않는다.
 * 안전장치: 테스트 접두사(test-)가 아니면 거절한다. 파일이 끝난 뒤 남은 키는 globalSetup이 `test-*`로 한 번 더 지운다.
 * @param sub 접두사 뒤에 붙일 부분(예: 'hb:' → `<prefix>:hb:*`만). 없으면 이 파일의 키 전부(큐 키 포함)
 */
export async function deleteTestKeys(redis: Redis, sub = ''): Promise<number> {
  if (!env.queuePrefix.startsWith('test-')) throw new Error(`테스트 접두사가 아닙니다: ${env.queuePrefix}`);
  let deleted = 0;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${env.queuePrefix}:${sub}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) deleted += await redis.unlink(...keys);
  } while (cursor !== '0');
  return deleted;
}
```

`apps/api/test/redis.e2e.spec.ts`(새):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisLock } from '../src/redis/redis-lock.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { ScanLock } from '../src/scan/scan-lock.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

describe('공용 Redis 연결과 RedisLock (decisions/0026)', () => {
  let t: TestApp;
  let redis: Redis;
  let lock: RedisLock;

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    lock = t.app.get(RedisLock);
  });
  afterAll(async () => {
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('잡은 동안은 다시 못 잡고, 남의 토큰으로는 못 풀고, 내 토큰으로 풀면 다시 잡힌다', async () => {
    const key = lock.keyOf('test-lock', 'A');
    const token = await lock.acquire(key, 5000);
    expect(token).toEqual(expect.any(String));
    expect(await lock.acquire(key, 5000)).toBeNull();
    expect(await lock.release(key, 'not-mine')).toBe(false);
    expect(await redis.get(key)).toBe(token);
    expect(await lock.release(key, token!)).toBe(true);
    expect(await redis.exists(key)).toBe(0);
    expect(await lock.acquire(key, 5000)).not.toBeNull();
  });

  it('TTL이 지나면 저절로 풀린다', async () => {
    const key = lock.keyOf('test-lock', 'B');
    expect(await lock.acquire(key, 50)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 120));
    expect(await lock.acquire(key, 50)).not.toBeNull();
  });

  it('스캔 잠금도 공용 연결에 같은 키 형식(<접두사>:scan-lock:<scanId>)으로 잡는다', async () => {
    const scanLock = t.app.get(ScanLock);
    const token = await scanLock.acquire('BOX-REDIS-0001', 5000);
    expect(scanLock.keyOf('BOX-REDIS-0001')).toMatch(/^test-.+:scan-lock:BOX-REDIS-0001$/);
    expect(await redis.get(scanLock.keyOf('BOX-REDIS-0001'))).toBe(token);
    await scanLock.release('BOX-REDIS-0001', token!);
    expect(await redis.exists(scanLock.keyOf('BOX-REDIS-0001'))).toBe(0);
  });

  it('공용 연결에는 error 리스너가 있고, 앱을 닫으면 연결도 닫힌다', async () => {
    const other = await createTestApp();
    const conn = other.app.get<Redis>(REDIS);
    expect(conn).not.toBe(redis); // 앱마다 하나
    expect(conn.listenerCount('error')).toBeGreaterThanOrEqual(1);
    expect(await conn.ping()).toBe('PONG');
    // quit()은 서버 응답(OK)에서 끝나고, 소켓이 닫히면 'end'가 온다. 닫는 훅이 없으면 여기서 시간 초과로 실패한다.
    const ended = new Promise((r) => conn.once('end', r));
    await other.app.close();
    await ended;
    expect(conn.status).toBe('end');
  });
});
```

`apps/api/test/replacement.e2e.spec.ts` 전체(두 번째 테스트에 예약 해제·TICKET_NOT_REPLACING 확인 추가, 네 번째 테스트를 "첫 요청이 예약을 쥔 채 운송장 발급에서 멈춘 사이 둘째 요청 → 409"로 바꿈):
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CarrierSyncService } from '../src/carrier-sync/carrier-sync.service.js';
import { CarrierAdapters } from '../src/carrier/carrier.adapters.js';
import { Carrier } from '../src/carrier/carrier.types.js';
import { Shipment, ShipmentStatus } from '../src/shipment/shipment.entities.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { partners } from './helpers/partners.js';
import { prepareInService, registerInStock, transitionTo } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'moon' };

describe('A/S 교체 출고·설치 확인 (F7)', () => {
  let t: TestApp;
  const em = () => t.orm.em.fork();
  const terminal = (serialNo: string) => em().findOneOrFail(Terminal, { serialNo }, { populate: ['merchant'] });
  const history = async (serialNo: string) => (await t.http().get(`/terminals/${serialNo}/history`)).body;
  const waybillCalls = async () => (await partners.stats()).calls['bungae.waybill'] ?? 0;
  const openTicket = async (serialNo: string) =>
    (await t.http().post('/service-tickets').set(OP).send({ serialNo, symptom: '카드 인식 불가' })).body.id as number;
  const replace = (id: number, replacementSerialNo: string) =>
    t.http().post(`/service-tickets/${id}/replacements`).set(OP).send({ replacementSerialNo, carrier: 'BUNGAE' });
  const install = (id: number) => t.http().post(`/service-tickets/${id}/installations`).set(OP);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await partners.reset();
    for (const s of ['RP-0001', 'RP-0002', 'RP-0003', 'RP-0004', 'RP-0005', 'RP-0006', 'RP-0007']) await prepareInService(t, s, 'PANGYO-BUNSIK');
    // RP-0106·0107은 마지막에 등록해 id가 가장 크다(운송장이 한 번도 없는 단말기, troubleshooting/0014).
    for (const s of ['RP-0101', 'RP-0102', 'RP-0103', 'RP-0105', 'RP-0106', 'RP-0107']) await registerInStock(t, s);
    // 다른 모델(SN-200) 재고: 검수 항목이 달라 시나리오 헬퍼 대신 상태를 직접 맞춘다.
    await t.http().post('/terminals').set(OP).send({ serialNo: 'RP-0201', modelCode: 'SN-200' });
    await em().nativeUpdate(Terminal, { serialNo: 'RP-0201' }, { status: TerminalStatus.IN_STOCK });
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('교체 출고 → 배송 완료 → 설치 확인 → 고장 단말기 회수 스캔까지 한 흐름', async () => {
    const id = await openTicket('RP-0001');
    const res = await replace(id, 'RP-0101');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id, status: 'REPLACING', replacementSerialNo: 'RP-0101' });
    expect(res.body.outboundTrackingNo).toMatch(/^BG\d+$/);

    // 교체 단말기: 재고 → 배정(가맹점 = 접수 가맹점) → 출고. 고장 단말기: 회수 요청. 모두 한 트랜잭션.
    const replacement = await terminal('RP-0101');
    expect(replacement.status).toBe(TerminalStatus.SHIPPED);
    expect(replacement.merchant?.code).toBe('PANGYO-BUNSIK');
    expect((await terminal('RP-0001')).status).toBe(TerminalStatus.RETURN_REQUESTED);
    expect((await history('RP-0101')).slice(-2)).toMatchObject([
      { fromStatus: 'IN_STOCK', toStatus: 'ALLOCATED', source: 'ALLOCATION', actor: 'moon', reason: `A/S 교체 배정: 접수 #${id}` },
      { fromStatus: 'ALLOCATED', toStatus: 'SHIPPED', source: 'SHIPMENT', reason: `A/S 교체 출고: BUNGAE ${res.body.outboundTrackingNo}` },
    ]);
    expect((await history('RP-0001')).at(-1)).toMatchObject({ toStatus: 'RETURN_REQUESTED', source: 'SERVICE', reason: `A/S 교체로 회수 요청: 접수 #${id}` });
    const shipment = await em().findOneOrFail(Shipment, res.body.outboundShipmentId, { populate: ['terminal'] });
    expect([shipment.terminal.serialNo, shipment.status]).toEqual(['RP-0101', ShipmentStatus.IN_TRANSIT]);

    // 배송 전 설치 확인은 422(SHIPPED → IN_SERVICE 규칙 없음), 접수는 REPLACING 그대로
    const early = await install(id);
    expect(early.status).toBe(422);
    expect((await t.http().get(`/service-tickets/${id}`)).body.status).toBe('REPLACING');

    // 택배 추적 수집이 배송 완료를 반영한다(기존 F3 흐름)
    await partners.configure({ bungae: { advancePerPoll: 4 } });
    expect(await t.app.get(CarrierSyncService).track(shipment.id, { queue: 'test', attempt: 1 })).toBe('DELIVERED');

    const done = await install(id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'CLOSED' });
    expect(done.body.closedAt).toEqual(expect.any(String));
    expect((await terminal('RP-0101')).status).toBe(TerminalStatus.IN_SERVICE);
    expect((await history('RP-0101')).at(-1)).toMatchObject({ toStatus: 'IN_SERVICE', source: 'SERVICE', reason: `A/S 교체 설치 확인: 접수 #${id}` });

    // 고장 단말기 회수: 수거 시작(수동) → 회수 박스 스캔
    await transitionTo(t, 'RP-0001', 'RETURNING', 'pickup');
    const scan = await t.http().post('/scans').set(OP).send({ scanId: 'AS-RETURN-0001', kind: 'RETURN_IN', serials: ['RP-0001'] });
    expect(scan.body.results).toEqual([{ serialNo: 'RP-0001', result: 'RETURNED' }]);
  });

  it('출고 전에 확인할 수 있는 실패는 택배사를 부르지 않는다(422·404)', async () => {
    const id = await openTicket('RP-0002');
    const notInStock = await replace(id, 'RP-0101'); // 앞 테스트에서 이미 설치됨
    expect(notInStock.status).toBe(422);
    expect(notInStock.body.code).toBe('REPLACEMENT_NOT_IN_STOCK');
    const otherModel = await replace(id, 'RP-0201');
    expect(otherModel.status).toBe(422);
    expect(otherModel.body.code).toBe('MODEL_MISMATCH');
    expect((await replace(id, 'RP-9999')).status).toBe(404);
    expect(await waybillCalls()).toBe(0);
    // 실패해도 교체 예약은 풀린다: 같은 교체 단말기로 다시 보내면 409(예약 중)가 아니라 같은 422(decisions/0026)
    expect((await replace(id, 'RP-0201')).body.code).toBe('MODEL_MISMATCH');
    // 교체 출고 전(OPEN) 설치 확인은 TICKET_NOT_REPLACING(Day 3 리뷰 Minor 4)
    const notReplacing = await install(id);
    expect(notReplacing.status).toBe(422);
    expect(notReplacing.body.code).toBe('TICKET_NOT_REPLACING');

    await t.http().post(`/service-tickets/${id}/remote-checks`).set(OP).send({ resolved: true, note: '해결' });
    const closed = await replace(id, 'RP-0102');
    expect(closed.status).toBe(422);
    expect(closed.body.code).toBe('TICKET_NOT_OPEN');
    expect(await waybillCalls()).toBe(0);
  });

  it('트랜잭션 안에서 하나라도 실패하면 두 단말기·운송장·접수가 모두 그대로(운송장은 고아로 남는다)', async () => {
    const id = await openTicket('RP-0003');
    // 운송장 발급 직후, 다른 작업이 고장 단말기를 먼저 회수 요청으로 바꾼 상황
    const adapter = t.app.get(CarrierAdapters).get(Carrier.BUNGAE);
    const original = adapter.createWaybill.bind(adapter);
    const spy = vi.spyOn(adapter, 'createWaybill').mockImplementationOnce(async (input) => {
      const trackingNo = await original(input);
      await em().nativeUpdate(Terminal, { serialNo: 'RP-0003' }, { status: TerminalStatus.RETURN_REQUESTED });
      return trackingNo;
    });
    try {
      const res = await replace(id, 'RP-0102');
      expect(res.status).toBe(422);
    } finally {
      spy.mockRestore();
    }
    const r = await terminal('RP-0102');
    expect([r.status, r.merchant]).toEqual([TerminalStatus.IN_STOCK, null]);
    expect(await em().count(Shipment, { terminal: { serialNo: 'RP-0102' } })).toBe(0);
    expect((await t.http().get(`/service-tickets/${id}`)).body).toMatchObject({ status: 'OPEN', replacementSerialNo: null });
    expect(await waybillCalls()).toBe(1); // 발급된 운송장 1장은 저장되지 않았다(decisions/0012 한계)
  });

  it('두 접수가 같은 교체 단말기를 동시에 요청하면 1건만 성공, 진 쪽은 운송장 없이 409 REPLACEMENT_RESERVED(decisions/0026)', async () => {
    const [a, b] = [await openTicket('RP-0004'), await openTicket('RP-0005')];
    // 첫 요청이 교체 예약을 쥔 채 운송장 발급에서 멈추게 한다
    const adapter = t.app.get(CarrierAdapters).get(Carrier.BUNGAE);
    const original = adapter.createWaybill.bind(adapter);
    let release!: () => void;
    let markEntered!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((r) => (markEntered = r));
    const spy = vi.spyOn(adapter, 'createWaybill').mockImplementationOnce(async (input) => {
      markEntered();
      await released;
      return original(input);
    });
    try {
      const first = replace(a, 'RP-0105').then((r) => r);
      await entered;
      const second = await replace(b, 'RP-0105');
      console.log(`[같은 교체 단말기 동시 요청] 둘째=${second.status} ${second.body.code} 운송장발급(첫째 대기 중)=${await waybillCalls()}`);
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('REPLACEMENT_RESERVED');
      release();
      expect((await first).status).toBe(201);
    } finally {
      release();
      spy.mockRestore();
    }
    expect(await waybillCalls()).toBe(1); // 진 쪽은 운송장을 발급받지 않았다(고아 0)
    expect(await em().count(Shipment, { terminal: { serialNo: 'RP-0105' } })).toBe(1);
    expect((await t.http().get(`/service-tickets/${b}`)).body.status).toBe('OPEN');

    // 끝나면 예약이 풀린다. 다시 요청하면 409가 아니라 사전 확인(이미 출고)에서 422, 운송장은 그대로 1장
    const again = await replace(b, 'RP-0105');
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('REPLACEMENT_NOT_IN_STOCK');
    expect(await waybillCalls()).toBe(1);
  });

  it('서로 다른 단말기의 교체 출고 2건을 동시에 하면 둘 다 201(운송장 gap 락 데드락 없음, troubleshooting/0014)', async () => {
    const [a, b] = [await openTicket('RP-0006'), await openTicket('RP-0007')];
    const results = await Promise.all([replace(a, 'RP-0106'), replace(b, 'RP-0107')]);
    console.log(`[다른 단말기 동시 교체] 응답=${JSON.stringify(results.map((r) => r.status))} 코드=${JSON.stringify(results.map((r) => r.body.code ?? null))}`);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(await em().count(Shipment, { terminal: { serialNo: { $in: ['RP-0106', 'RP-0107'] } }, status: ShipmentStatus.IN_TRANSIT })).toBe(2);
  });
});
```

`apps/api/test/experiments/replacement-race.spec.ts` 전체(허용 실패 사유에 `REPLACEMENT_RESERVED`, 고아 운송장 0 단언 추가):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Carrier } from '../../src/carrier/carrier.types.js';
import { BusinessError, InvalidTransitionError } from '../../src/common/domain-errors.js';
import { ReplacementService, type LockOrder } from '../../src/service/replacement.service.js';
import { ServiceTicket, ServiceTicketStatus } from '../../src/service/service-ticket.entity.js';
import { Shipment } from '../../src/shipment/shipment.entities.js';
import { TerminalStatusHistory } from '../../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus } from '../../src/terminal/terminal-status.js';
import { partners } from '../helpers/partners.js';
import { prepareInService, registerInStock } from '../helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

// experiments/0007. 실행: EXPERIMENTS=1 npx vitest run test/experiments/replacement-race.spec.ts --silent=false
const N = Number(process.env.EXP_N ?? 10);
const ROUNDS = Number(process.env.EXP_ROUNDS ?? 3);
const ORDERS: LockOrder[] = ['id-asc', 'faulty-first'];
const OP = { 'X-Operator': 'exp7' };

/** 실패 사유를 짧은 이름으로 */
function reasonOf(error: unknown): string {
  if (error instanceof BusinessError) return error.code;
  if (error instanceof InvalidTransitionError) return 'INVALID_TRANSITION';
  return error instanceof Error ? error.name : String(error);
}

describe(`실험 0007: 교체 출고 동시 요청 — 접수 ${N}건 (${ROUNDS}회)`, () => {
  let t: TestApp;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await partners.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  /** 운영 중 단말기 n대와 각 단말기의 열린 접수를 만든다. */
  async function openTickets(tag: string, n: number): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 1; i <= n; i++) {
      const serialNo = `${tag}-F${String(i).padStart(3, '0')}`;
      await prepareInService(t, serialNo);
      const res = await t.http().post('/service-tickets').set(OP).send({ serialNo, symptom: '고장' });
      expect(res.status).toBe(201);
      ids.push(res.body.id);
    }
    return ids;
  }

  async function countAfter(tag: string, ticketIds: number[], replSerialLike: string) {
    const em = t.orm.em.fork();
    return {
      shipments: await em.count(Shipment, { terminal: { serialNo: { $like: replSerialLike } } }),
      waybills: (await partners.stats()).calls['bungae.waybill'] ?? 0,
      replacing: await em.count(ServiceTicket, { id: { $in: ticketIds }, status: ServiceTicketStatus.REPLACING }),
      returnRequested: await em.count(TerminalStatusHistory, {
        terminal: { serialNo: { $like: `${tag}-F%` } },
        toStatus: TerminalStatus.RETURN_REQUESTED,
      }),
    };
  }

  for (const order of ORDERS) {
    it(`같은 교체 단말기, 잠금 순서 ${order}: 정확히 1건 성공, 나머지 409/422, 500·데드락 0, 고아 운송장 0`, async () => {
      const replacements = t.app.get(ReplacementService);
      for (let round = 1; round <= ROUNDS; round++) {
        seq += 1;
        const tag = `R7${String(seq).padStart(2, '0')}`;
        // 교체 단말기를 먼저 만들어 id가 고장 단말기들보다 작게 한다 → 'faulty-first'는 id 오름차순과 반대 순서로 잠근다.
        await registerInStock(t, `${tag}-REPL`);
        const ticketIds = await openTickets(tag, N);
        await partners.reset();

        const started = performance.now();
        const settled = await Promise.allSettled(
          ticketIds.map((id) => replacements.replace(id, { replacementSerialNo: `${tag}-REPL`, carrier: Carrier.BUNGAE }, 'exp7', { lockOrder: order })),
        );
        const elapsed = Math.round(performance.now() - started);

        const ok = settled.filter((s) => s.status === 'fulfilled').length;
        const reasons: Record<string, number> = {};
        for (const s of settled) if (s.status === 'rejected') reasons[reasonOf(s.reason)] = (reasons[reasonOf(s.reason)] ?? 0) + 1;
        const c = await countAfter(tag, ticketIds, `${tag}-REPL`);
        console.log(
          `[실험 0007/same/${order} #${round}] N=${N} 성공=${ok} 실패=${JSON.stringify(reasons)} 운송장발급=${c.waybills} 저장=${c.shipments} ` +
            `고아=${c.waybills - c.shipments} REPLACING=${c.replacing} 회수요청이력=${c.returnRequested} 소요=${elapsed}ms`,
        );

        expect(ok).toBe(1);
        // Day 4: 교체 예약(decisions/0026) 뒤로 진 쪽은 대부분 REPLACEMENT_RESERVED(운송장 발급 전), 이긴 쪽이 끝난 뒤 온 요청은
        // REPLACEMENT_NOT_IN_STOCK. 잠금을 기다린 뒤 걸리는 INVALID_TRANSITION은 예약 TTL이 지났을 때만 나온다.
        expect(
          Object.keys(reasons).every((k) => ['REPLACEMENT_RESERVED', 'INVALID_TRANSITION', 'REPLACEMENT_NOT_IN_STOCK', 'OptimisticLockError'].includes(k)),
        ).toBe(true);
        expect(c.shipments).toBe(1);
        expect(c.waybills - c.shipments).toBe(0); // 고아 운송장 0 (Day 3은 매회 9장, experiments/0007)
        expect(c.replacing).toBe(1);
        expect(c.returnRequested).toBe(1); // 진 쪽의 고장 단말기는 회수 요청으로 바뀌지 않았다(전부 롤백)
      }
    }, 300_000);
  }

  // troubleshooting/0014의 회귀 모양: 서로 다른 교체 단말기(운송장이 없고 id가 가장 큰 새 단말기)로 동시에 교체 출고.
  // 단말기 행은 겹치지 않는다. 예전 recordShipment(terminal_id 조건 UPDATE)는 여기서 gap 락 데드락 → 500이 났다.
  it(`서로 다른 교체 단말기 ${N}대(HTTP, 운영 순서 id-asc): 모두 201, 500·데드락 0`, async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      seq += 1;
      const tag = `R7${String(seq).padStart(2, '0')}`;
      const ticketIds = await openTickets(tag, N);
      // 고장 단말기들 뒤에 만들어 교체 단말기 id가 가장 크다 → shipment.terminal_id 인덱스의 끝(supremum) 쪽.
      const repls = Array.from({ length: N }, (_, i) => `${tag}-S${String(i + 1).padStart(3, '0')}`);
      for (const s of repls) await registerInStock(t, s);
      await partners.reset();

      const started = performance.now();
      const results = await Promise.all(
        ticketIds.map((id, i) =>
          t.http().post(`/service-tickets/${id}/replacements`).set(OP).send({ replacementSerialNo: repls[i], carrier: 'BUNGAE' }).then((r) => r),
        ),
      );
      const elapsed = Math.round(performance.now() - started);

      const statuses: Record<string, number> = {};
      for (const r of results) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      const codes = results.filter((r) => r.status !== 201).map((r) => r.body.code ?? r.body.message ?? null);
      const c = await countAfter(tag, ticketIds, `${tag}-S%`);
      console.log(
        `[실험 0007/distinct/id-asc #${round}] N=${N} 응답=${JSON.stringify(statuses)} 실패코드=${JSON.stringify(codes)} 운송장발급=${c.waybills} ` +
          `저장=${c.shipments} 고아=${c.waybills - c.shipments} REPLACING=${c.replacing} 회수요청이력=${c.returnRequested} 소요=${elapsed}ms`,
      );

      expect(statuses).toEqual({ 201: N });
      expect(c.shipments).toBe(N);
      expect(c.waybills - c.shipments).toBe(0);
      expect(c.replacing).toBe(N);
      expect(c.returnRequested).toBe(N);
    }
  }, 300_000);
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run test/redis.e2e.spec.ts test/replacement.e2e.spec.ts`
Expected: `Test Files  2 failed (2)`, `Tests  2 failed | 3 passed (5)`.
- `test/redis.e2e.spec.ts`: `Error: Cannot find module '../src/redis/redis-lock.js'`(파일 로드 실패)
- `출고 전에 확인할 수 있는 실패는…`: `expected 'TICKET_NOT_OPEN' to be 'TICKET_NOT_REPLACING'`
- `두 접수가 같은 교체 단말기를…`: `expected 201 to be 409`(예약이 없어 둘째 요청이 먼저 트랜잭션까지 가서 이긴다)

- [ ] **Step 4: 구현**

`apps/api/src/redis/redis.provider.ts`(새):
```ts
import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/** 앱 공용 ioredis 연결의 주입 토큰(decisions/0026). BullMQ는 자기 연결을 따로 쓴다. */
export const REDIS = 'APP_REDIS';

/**
 * 앱 공용 Redis 연결을 만든다. error 리스너를 꼭 단다 — 리스너가 없으면 ioredis가 연결 오류마다
 * `[ioredis] Unhandled error event`를 콘솔에 찍는다(Day 3 리뷰 Minor 2). 명령 하나는 1번만 다시 보낸다(요청이 오래 매달리지 않게).
 */
export function createAppRedis(logger = new Logger('Redis')): Redis {
  const redis = new Redis({ host: env.redis.host, port: env.redis.port, maxRetriesPerRequest: 1 });
  redis.on('error', (error: Error) => logger.warn(`Redis 연결 오류: ${error.message}`));
  return redis;
}
```

`apps/api/src/redis/redis-lock.ts`(새):
```ts
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { REDIS } from './redis.provider.js';

/** 내 토큰일 때만 지운다. TTL이 지나 다른 요청이 잡은 잠금을 지우지 않기 위해서다. */
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * 짧게 쥐는 Redis 잠금(SET NX PX + 토큰 비교 해제, decisions/0020·0026). 박스 스캔 처리 중 잠금(ScanLock),
 * 교체 단말기 예약, 주기 작업의 한 번에 하나 실행에 쓴다. 프로세스가 죽어도 TTL이 지나면 풀린다.
 * 키는 큐와 같은 접두사(env.queuePrefix)를 붙여 테스트(test-…)와 개발(terminal-ops)을 나눈다.
 */
@Injectable()
export class RedisLock {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  keyOf(kind: string, id: string): string {
    return `${env.queuePrefix}:${kind}:${id}`;
  }

  /** 잡으면 토큰, 이미 누가 잡고 있으면 null */
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const ok = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? token : null;
  }

  /** 내 토큰이면 지우고 true. TTL이 지났거나 남의 잠금이면 false */
  async release(key: string, token: string): Promise<boolean> {
    return (await this.redis.eval(RELEASE_SCRIPT, 1, key, token)) === 1;
  }
}
```

`apps/api/src/redis/redis.module.ts`(새):
```ts
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisLock } from './redis-lock.js';
import { createAppRedis, REDIS } from './redis.provider.js';

/**
 * 앱 공용 Redis 연결 하나(decisions/0026). 스캔 잠금·교체 예약·하트비트가 함께 쓴다.
 * 연결은 onApplicationShutdown에서 닫는다 — 모든 모듈의 onModuleDestroy(BullMQ 워커 종료 등)가 끝난 뒤라
 * 처리 중인 job이 닫힌 연결을 쓰지 않는다.
 */
@Global()
@Module({
  providers: [{ provide: REDIS, useFactory: () => createAppRedis() }, RedisLock],
  exports: [REDIS, RedisLock],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'end') return;
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
```

`apps/api/src/scan/scan-lock.ts` 전체(전용 연결과 `onModuleDestroy`를 없애고 RedisLock에 맡김. ScanModule은 그대로 — RedisModule이 전역이다):
```ts
import { Injectable } from '@nestjs/common';
import { env } from '../config/env.js';
import { RedisLock } from '../redis/redis-lock.js';

/**
 * 같은 scanId의 "처리 중" 잠금(Redis SET NX PX, decisions/0020).
 * 처리를 마친 결과는 MySQL(ScanBatch)에 영구히 남고, 이 잠금은 처리하는 동안 같은 scanId가 또 들어오는 것만 막는다.
 * 잠금 자체는 공용 Redis 연결의 RedisLock이 한다(decisions/0026). 키는 `<QUEUE_PREFIX>:scan-lock:<scanId>` 그대로다.
 */
@Injectable()
export class ScanLock {
  constructor(private readonly lock: RedisLock) {}

  keyOf(scanId: string): string {
    return this.lock.keyOf('scan-lock', scanId);
  }

  /** 잡으면 토큰, 이미 누가 잡고 있으면 null */
  acquire(scanId: string, ttlMs = env.scanLockTtlMs): Promise<string | null> {
    return this.lock.acquire(this.keyOf(scanId), ttlMs);
  }

  async release(scanId: string, token: string): Promise<void> {
    await this.lock.release(this.keyOf(scanId), token);
  }
}
```

`apps/api/src/app.module.ts` 전체(`RedisModule`을 `QueuesModule` 앞에):
```ts
import { type DynamicModule, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import ormConfig from './mikro-orm.config.js';
import { HealthController } from './health/health.controller.js';
import { DomainExceptionFilter } from './common/domain-exception.filter.js';
import { TerminalModule } from './terminal/terminal.module.js';
import { InspectionModule } from './inspection/inspection.module.js';
import { MerchantModule } from './merchant/merchant.module.js';
import { ShipmentModule } from './shipment/shipment.module.js';
import { QueuesModule } from './queue/queues.module.js';
import { RedisModule } from './redis/redis.module.js';
import { CarrierSyncModule } from './carrier-sync/carrier-sync.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { PurchaseOrderModule } from './purchase-order/purchase-order.module.js';
import { ScanModule } from './scan/scan.module.js';
import { ServiceModule } from './service/service.module.js';
import { WorkersModule } from './workers/workers.module.js';
import { SchedulerModule } from './scheduler/scheduler.module.js';

export interface AppOptions {
  /** 큐 job을 처리할지(RUN_WORKERS) */
  workers?: boolean;
  /** 주기 작업을 등록할지(RUN_SCHEDULERS) */
  schedulers?: boolean;
}

@Module({
  // forRoot가 요청마다 EntityManager를 fork하는 RequestContext 미들웨어를 자동 등록한다.
  imports: [
    MikroOrmModule.forRoot(ormConfig),
    RedisModule,
    QueuesModule,
    TerminalModule,
    InspectionModule,
    MerchantModule,
    ShipmentModule,
    CarrierSyncModule,
    OutboxModule,
    PurchaseOrderModule,
    ScanModule,
    ServiceModule,
  ],
  controllers: [HealthController],
  providers: [
    // main.ts의 useGlobalPipes/Filters는 테스트 앱에 적용되지 않는다. 모듈 provider로 등록해 테스트에서도 같게 동작시킨다.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {
  /** 실행 모드에 따라 워커·스케줄러를 붙인다. `imports: [AppModule]`만 쓰면 둘 다 없다(decisions/0015). */
  static forRoot(options: AppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [...(options.workers ? [WorkersModule] : []), ...(options.schedulers ? [SchedulerModule] : [])],
    };
  }
}
```

`apps/api/src/config/env.ts` 전체(`replacementLockTtlMs` 추가):
```ts
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 스크립트·테스트는 apps/api에서 실행한다. 저장소 루트의 .env를 읽는다(이미 있는 환경변수는 덮어쓰지 않는다).
const envFile = resolve(process.cwd(), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경변수 ${name}가 없습니다. 저장소 루트 .env를 확인하세요.`);
  return value;
}

function flag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  return value === undefined ? fallback : value === '1' || value === 'true';
}

const isTest = process.env.NODE_ENV === 'test';

export const env = {
  port: Number(process.env.API_PORT ?? 3000),
  mysql: {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: required('MYSQL_USER'),
    password: required('MYSQL_PASSWORD'),
    dbName: isTest ? required('MYSQL_TEST_DATABASE') : required('MYSQL_DATABASE'),
  },
  /** 가상 업체 서버(apps/partners) 주소 */
  partnersUrl: process.env.PARTNERS_URL ?? 'http://127.0.0.1:4010',
  /** 택배사·메신저 호출 타임아웃 */
  partnerTimeoutMs: Number(process.env.PARTNER_TIMEOUT_MS ?? 3000),
  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
  /**
   * BullMQ 키 접두사. 테스트는 파일마다 다른 접두사를 써서 다른 파일의 job을 보지 않는다
   * (vitest는 테스트 파일마다 모듈을 새로 읽으므로 이 값도 파일마다 새로 정해진다).
   */
  queuePrefix: process.env.QUEUE_PREFIX ?? (isTest ? `test-${process.pid}-${Date.now()}` : 'terminal-ops'),
  /** 이 프로세스가 큐 job을 처리할지 */
  runWorkers: flag('RUN_WORKERS', true),
  /** 이 프로세스가 주기 작업(수집 sweep, outbox relay)을 등록할지 */
  runSchedulers: flag('RUN_SCHEDULERS', !isTest),
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? 30_000),
  relayIntervalMs: Number(process.env.RELAY_INTERVAL_MS ?? 2_000),
  /** 우리 쪽 호출 속도 제한(초당). 택배사 한도보다 낮게 둔다. */
  bungaeRatePerSec: Number(process.env.BUNGAE_RATE_PER_SEC ?? 10),
  neurimboRatePerSec: Number(process.env.NEURIMBO_RATE_PER_SEC ?? 5),
  /** 알림을 보낼 톡톡메신저 채널 */
  toktokChannel: process.env.TOKTOK_CHANNEL ?? 'ops',
  /** 박스 스캔 처리 중 잠금(Redis) 유지 시간. 처리가 이보다 길면 잠금이 풀린다(decisions/0020) */
  scanLockTtlMs: Number(process.env.SCAN_LOCK_TTL_MS ?? 30_000),
  /** A/S 교체 단말기 예약(Redis) 유지 시간. 운송장 발급 + 교체 트랜잭션이 이보다 길면 예약이 풀린다(decisions/0026) */
  replacementLockTtlMs: Number(process.env.REPLACEMENT_LOCK_TTL_MS ?? 30_000),
  /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
  workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
};
```

`apps/api/src/service/service-ticket.service.ts` 전체(`lockOpen`에 `code` 인자):
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus } from '../terminal/terminal-status.js';
import type { OpenTicketDto, RemoteCheckDto } from './dto/service-ticket.dto.js';
import { OPEN_TICKET_STATUSES, ServiceTicket, ServiceTicketStatus } from './service-ticket.entity.js';

export const TICKET_POPULATE = ['terminal', 'merchant', 'replacementTerminal', 'outboundShipment'] as const;

/** A/S 접수·원격 점검(F7). 교체 출고·설치 확인은 ReplacementService. */
@Injectable()
export class ServiceTicketService {
  constructor(private readonly em: EntityManager) {}

  /**
   * 접수. 단말기 행을 FOR UPDATE로 먼저 잠그고(같은 단말기 접수끼리 줄 세우기) 열린 접수가 없을 때만 만든다.
   * 접수 INSERT의 FK 검사(S 락)보다 단말기 X 락이 먼저라 S→X 데드락이 없다(troubleshooting/0004).
   * 단말기 상태는 바꾸지 않는다(운영 중 그대로).
   */
  async open(dto: OpenTicketDto, actor: string): Promise<ServiceTicket> {
    const id = await this.em.fork().transactional(async (tx) => {
      const terminal = await tx.findOne(Terminal, { serialNo: dto.serialNo }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (!terminal) throw new NotFoundException(`단말기 ${dto.serialNo}이(가) 없습니다.`);
      if (terminal.status !== TerminalStatus.IN_SERVICE || !terminal.merchant) {
        throw new BusinessError(422, 'TERMINAL_NOT_IN_SERVICE', `운영 중(IN_SERVICE)인 단말기만 A/S 접수할 수 있습니다(현재: ${terminal.status}).`);
      }
      const already = await tx.count(ServiceTicket, { terminal, status: { $in: OPEN_TICKET_STATUSES } });
      if (already > 0) throw new BusinessError(409, 'TICKET_ALREADY_OPEN', `단말기 ${dto.serialNo}에 이미 열린 A/S 접수가 있습니다.`);
      const ticket = tx.create(ServiceTicket, { terminal, merchant: terminal.merchant, symptom: dto.symptom, openedBy: actor });
      await tx.flush();
      return ticket.id;
    });
    return this.get(id);
  }

  /** 원격 점검 결과. 해결이면 종결(RESOLVED_REMOTELY), 아니면 메모만 남기고 OPEN 그대로. */
  async remoteCheck(id: number, dto: RemoteCheckDto): Promise<ServiceTicket> {
    await this.em.fork().transactional(async (tx) => {
      const ticket = await this.lockOpen(tx, id, [ServiceTicketStatus.OPEN]);
      ticket.remoteNote = dto.note;
      if (dto.resolved) {
        ticket.status = ServiceTicketStatus.RESOLVED_REMOTELY;
        ticket.closedAt = new Date();
      }
    });
    return this.get(id);
  }

  async get(id: number): Promise<ServiceTicket> {
    const ticket = await this.em.fork().findOne(ServiceTicket, id, { populate: TICKET_POPULATE });
    if (!ticket) throw new NotFoundException(`A/S 접수 ${id}이(가) 없습니다.`);
    return ticket;
  }

  /**
   * 접수 행을 FOR UPDATE로 잠그고, 상태가 expected 중 하나인지 확인한다.
   * @param code 상태가 다를 때의 오류 코드. 설치 확인은 TICKET_NOT_REPLACING(Day 3 리뷰 Minor 4)
   */
  async lockOpen(tx: EntityManager, id: number, expected: ServiceTicketStatus[], code = 'TICKET_NOT_OPEN'): Promise<ServiceTicket> {
    const ticket = await tx.findOne(ServiceTicket, id, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!ticket) throw new NotFoundException(`A/S 접수 ${id}이(가) 없습니다.`);
    if (!expected.includes(ticket.status)) {
      throw new BusinessError(422, code, `A/S 접수 ${id}은(는) ${ticket.status} 상태라 이 작업을 할 수 없습니다(필요: ${expected.join(', ')}).`);
    }
    return ticket;
  }
}
```

`apps/api/src/service/replacement.service.ts` 전체(예약 → `replaceReserved`, 설치 확인 `TICKET_NOT_REPLACING`):
```ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { CarrierAdapters } from '../carrier/carrier.adapters.js';
import type { Carrier } from '../carrier/carrier.types.js';
import { BusinessError } from '../common/domain-errors.js';
import { env } from '../config/env.js';
import { Merchant } from '../merchant/merchant.entity.js';
import { RedisLock } from '../redis/redis-lock.js';
import { ShipmentService } from '../shipment/shipment.service.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import { TransitionService } from '../terminal/transition.service.js';
import { ServiceTicket, ServiceTicketStatus } from './service-ticket.entity.js';
import { ServiceTicketService } from './service-ticket.service.js';

/**
 * 두 단말기를 잠그는 순서. 운영 코드는 항상 'id-asc'(decisions/0023).
 * 'faulty-first'(고장 단말기 → 교체 단말기)는 실험 0007에서 순서를 바꿨을 때를 재 보려고만 둔다.
 */
export type LockOrder = 'id-asc' | 'faulty-first';

export interface ReplaceCommand {
  replacementSerialNo: string;
  carrier: Carrier;
}

/** A/S 교체 출고와 설치 확인(F7). "새 단말기 출고 + 고장 단말기 회수 요청"을 한 트랜잭션으로 처리한다. */
@Injectable()
export class ReplacementService {
  private readonly logger = new Logger(ReplacementService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly lock: RedisLock,
    private readonly tickets: ServiceTicketService,
    private readonly transitions: TransitionService,
    private readonly shipments: ShipmentService,
    private readonly adapters: CarrierAdapters,
  ) {}

  /**
   * ⓪ 교체 단말기 예약(Redis SET NX PX, decisions/0026). 같은 교체 단말기를 다른 요청이 처리 중이면 운송장 없이 409 REPLACEMENT_RESERVED.
   * ① 트랜잭션 밖 사전 확인: 접수 OPEN, 교체 단말기 IN_STOCK·같은 모델. 실패하면 택배사를 부르지 않는다.
   *    예약을 잡은 **뒤에** 확인한다. 앞서 끝난 요청이 이미 출고했으면 여기서 REPLACEMENT_NOT_IN_STOCK으로 걸러진다.
   * ② 트랜잭션 밖 운송장 발급(decisions/0012).
   * ③ 한 트랜잭션: 두 단말기를 id 오름차순으로 잠금(FOR UPDATE) → 접수 행 잠금(OPEN 재확인) → 교체 단말기 IN_STOCK → ALLOCATED(가맹점)
   *    → SHIPPED, 고장 단말기 IN_SERVICE → RETURN_REQUESTED, 운송장 저장, 접수 REPLACING.
   *    하나라도 실패하면 전부 롤백된다. ②의 운송장은 고아로 남는다(알려진 한계).
   * 예약은 끝나면(성공·실패 모두) 푼다. 처리가 TTL(REPLACEMENT_LOCK_TTL_MS)보다 길면 그사이 다른 요청이 예약할 수 있고,
   * 그 요청은 ③의 행 잠금에서 걸린다(Day 3과 같은 422 + 고아 운송장).
   */
  async replace(id: number, cmd: ReplaceCommand, actor: string, opts: { lockOrder?: LockOrder } = {}): Promise<ServiceTicket> {
    const key = this.lock.keyOf('replacement-lock', cmd.replacementSerialNo);
    const token = await this.lock.acquire(key, env.replacementLockTtlMs);
    if (!token) {
      throw new BusinessError(409, 'REPLACEMENT_RESERVED', `교체 단말기 ${cmd.replacementSerialNo}을(를) 다른 A/S 교체 출고가 처리하는 중입니다.`);
    }
    try {
      return await this.replaceReserved(id, cmd, actor, opts);
    } finally {
      // 반영은 이미 커밋됐을 수 있다. 해제 실패로 결과를 500으로 바꾸지 않는다(TTL이 지나면 풀린다, decisions/0020과 같은 처리).
      try {
        await this.lock.release(key, token);
      } catch (error) {
        this.logger.warn(`교체 예약 해제 실패(TTL이 지나면 풀린다) ${cmd.replacementSerialNo}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async replaceReserved(id: number, cmd: ReplaceCommand, actor: string, opts: { lockOrder?: LockOrder }): Promise<ServiceTicket> {
    const ticket = await this.tickets.get(id);
    if (ticket.status !== ServiceTicketStatus.OPEN) {
      throw new BusinessError(422, 'TICKET_NOT_OPEN', `A/S 접수 ${id}은(는) ${ticket.status} 상태라 교체 출고할 수 없습니다.`);
    }
    const replacement = await this.em.fork().findOne(Terminal, { serialNo: cmd.replacementSerialNo });
    if (!replacement) throw new NotFoundException(`단말기 ${cmd.replacementSerialNo}이(가) 없습니다.`);
    if (replacement.status !== TerminalStatus.IN_STOCK) {
      throw new BusinessError(422, 'REPLACEMENT_NOT_IN_STOCK', `교체 단말기는 재고(IN_STOCK)여야 합니다(현재: ${replacement.status}).`);
    }
    if (replacement.model.id !== ticket.terminal.model.id) {
      throw new BusinessError(422, 'MODEL_MISMATCH', '교체 단말기는 고장 단말기와 같은 모델이어야 합니다.');
    }

    const merchant = ticket.merchant;
    const trackingNo = await this.adapters.get(cmd.carrier).createWaybill({
      reference: `AS-${id}-${replacement.serialNo}`,
      receiverName: merchant.name,
      address: merchant.address,
    });

    const faultyId = ticket.terminal.id;
    await this.em.fork().transactional(async (tx) => {
      // 잠금 순서: 단말기 행 먼저, 접수 행은 그다음(decisions/0023). 접수 생성(open)이 단말기 행을 먼저 잠그므로 같은 순서를 지킨다.
      await this.lockTerminals(tx, faultyId, replacement.id, opts.lockOrder ?? 'id-asc');
      const locked = await this.tickets.lockOpen(tx, id, [ServiceTicketStatus.OPEN]);

      const assigned = tx.getReference(Merchant, merchant.id);
      await this.transitions.transition(
        {
          serialNo: replacement.serialNo,
          to: TerminalStatus.ALLOCATED,
          reason: `A/S 교체 배정: 접수 #${id}`,
          actor,
          source: TransitionSource.ALLOCATION,
          mutate: (t) => {
            t.merchant = assigned;
          },
        },
        tx,
      );
      const shipped = await this.transitions.transition(
        {
          serialNo: replacement.serialNo,
          to: TerminalStatus.SHIPPED,
          reason: `A/S 교체 출고: ${cmd.carrier} ${trackingNo}`,
          actor,
          source: TransitionSource.SHIPMENT,
        },
        tx,
      );
      await this.transitions.transition(
        {
          serialNo: ticket.terminal.serialNo,
          to: TerminalStatus.RETURN_REQUESTED,
          reason: `A/S 교체로 회수 요청: 접수 #${id}`,
          actor,
          source: TransitionSource.SERVICE,
        },
        tx,
      );
      const shipment = await this.shipments.recordShipment(tx, shipped, cmd.carrier, trackingNo);
      locked.status = ServiceTicketStatus.REPLACING;
      locked.replacementTerminal = shipped;
      locked.outboundShipment = shipment;
    });
    return this.tickets.get(id);
  }

  /**
   * 설치 확인: 교체 단말기 DELIVERED → IN_SERVICE(SERVICE), 접수 CLOSED. 배송 완료 전이면 422.
   * 잠금 순서는 교체 출고와 같다(단말기 → 접수, decisions/0023). 그래서 접수를 잠그지 않고 먼저 읽어 교체 단말기 id만 알아낸다.
   * REPLACING이 된 뒤에는 교체 단말기가 바뀌지 않으므로, 접수 잠금 뒤 상태만 다시 본다.
   */
  async install(id: number, actor: string): Promise<ServiceTicket> {
    const current = await this.tickets.get(id);
    if (current.status !== ServiceTicketStatus.REPLACING || !current.replacementTerminal) {
      throw new BusinessError(
        422,
        'TICKET_NOT_REPLACING',
        `A/S 접수 ${id}은(는) ${current.status} 상태라 설치 확인을 할 수 없습니다(필요: ${ServiceTicketStatus.REPLACING}).`,
      );
    }
    const replacementId = current.replacementTerminal.id;
    await this.em.fork().transactional(async (tx) => {
      const replacement = await tx.findOneOrFail(Terminal, replacementId, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const ticket = await this.tickets.lockOpen(tx, id, [ServiceTicketStatus.REPLACING], 'TICKET_NOT_REPLACING');
      await this.transitions.transition(
        {
          serialNo: replacement.serialNo,
          to: TerminalStatus.IN_SERVICE,
          reason: `A/S 교체 설치 확인: 접수 #${id}`,
          actor,
          source: TransitionSource.SERVICE,
        },
        tx,
      );
      ticket.status = ServiceTicketStatus.CLOSED;
      ticket.closedAt = new Date();
    });
    return this.tickets.get(id);
  }

  /**
   * 두 단말기 행을 FOR UPDATE로 한 행씩 잠근다. 여러 행을 잠그는 트랜잭션들이 늘 같은 순서(id 오름차순)로 잠가야
   * 서로 상대가 쥔 행을 기다리는 순환(데드락)이 생기지 않는다(decisions/0023, experiments/0007).
   */
  private async lockTerminals(tx: EntityManager, faultyId: number, replacementId: number, order: LockOrder): Promise<void> {
    const ids = order === 'id-asc' ? [faultyId, replacementId].sort((a, b) => a - b) : [faultyId, replacementId];
    for (const terminalId of ids) await tx.findOneOrFail(Terminal, terminalId, { lockMode: LockMode.PESSIMISTIC_WRITE });
  }
}
```

`.env.example`의 `SCAN_LOCK_TTL_MS=30000` 다음 줄에 추가:
```
# A/S 교체 단말기 예약(Redis) TTL(ms) — decisions/0026
REPLACEMENT_LOCK_TTL_MS=30000
```

- [ ] **Step 5: 통과 확인과 "Connection is closed" 다시 보기**

Run:
```bash
npx vitest run test/redis.e2e.spec.ts test/replacement.e2e.spec.ts test/scan.e2e.spec.ts
npx vitest run && npm run typecheck
for i in 1 2 3 4 5 6 7 8; do npx vitest run test/health.e2e.spec.ts 2>&1 | grep -cE "Connection is closed" ; done
```
Expected: 앞 세 파일 통과(스캔 테스트는 ScanLock의 키·해제 실패 처리가 그대로라 바꾸지 않아도 통과). 전체 `Test Files  30 passed (30)`, `Tests  204 passed (204)`, typecheck exit 0. health 반복은 8번 모두 `0`(사전 검증과 같음).
- 바꾼 뒤에도 나오면: 고치기 전에 `docs/troubleshooting/0017-테스트-종료-때-Connection-is-closed.md`를 시작한다(증상·나온 횟수·스택, 가설: ① 공용 Redis 연결 ② BullMQ 큐 연결 ③ MikroORM과 무관). `REDIS`를 `lazyConnect: true`로 바꿔 다시 8번 돌리는 식으로 가설을 하나씩 확인하고 결과를 그대로 적는다. 이 Task의 다른 결과는 그대로 커밋해도 된다.

- [ ] **Step 6: 실험 0007 다시 돌리기(고아 운송장 전후 비교)**

Run (Git Bash, `apps/api`):
```bash
DL() { MSYS_NO_PATHCONV=1 docker exec terminal-ops-mysql sh -c 'mysql -N -uroot -p"$MYSQL_ROOT_PASSWORD" -e "select count from information_schema.innodb_metrics where name=\"lock_deadlocks\""' 2>/dev/null; }
b=$(DL); EXPERIMENTS=1 npx vitest run test/experiments/replacement-race.spec.ts --silent=false 2>&1 | grep -E "\[실험 0007|Tests "; a=$(DL); echo "lock_deadlocks 전=$b 후=$a"
```
Expected: `Tests  3 passed (3)`. 같은 교체 단말기 6줄(`same/id-asc`·`same/faulty-first` × 3회) 모두 `성공=1`, 실패 사유는 `REPLACEMENT_RESERVED`(사전 검증에서는 9건 모두 이것) 또는 `REPLACEMENT_NOT_IN_STOCK`, `운송장발급=1 저장=1 고아=0`. 서로 다른 교체 단말기 3줄은 Day 3과 같이 `{"201":10}`·고아 0. lock_deadlocks는 전후 같음.

`docs/experiments/0007-교체-단말기-동시-요청.md` 끝에 절을 더한다:
```markdown
## Day 4 재실행 — 교체 단말기 예약 뒤 (2026-10-23, decisions/0026)

- 바뀐 것: 교체 출고가 맨 먼저 `<prefix>:replacement-lock:<교체 시리얼>`을 SET NX PX로 예약하고, 진 요청은 운송장 발급 전에 409 REPLACEMENT_RESERVED. 예약 뒤 사전 확인.
- 재현: (Step 6 명령 그대로)
- 결과: (출력 9줄 원문 + lock_deadlocks 전후)
- 전후 비교 표: | 변형 | Day 3 고아 운송장/회 | Day 4 고아 운송장/회 | Day 4 실패 사유 | 소요 |
- 결론: 같은 교체 단말기 10건 동시의 고아 운송장 (Day 3 잰 값 9장/회) → (잰 값). 잠금 순서 변형은 이제 트랜잭션까지 가는 요청이 1건뿐이라 의미가 없어졌다(두 순서 결과가 같은 이유). 서로 다른 교체 단말기는 예약 키가 달라 영향 없음(잰 값).
- 한계: 예약 TTL(30초)보다 오래 걸리는 처리는 재지 않았다. 같은 접수에 서로 다른 교체 단말기로 동시에 요청하면 예약 키가 달라 막지 못한다(스펙 9장).
```

- [ ] **Step 7: 기록 정정 (Day 3 리뷰 Minor 5·6)**

`docs/decisions/0025-DB-연결-collation을-테이블과-맞춘다.md` 끝에 한 줄:
```
- 갱신(2026-10-23 Day 4): 이 결정 전에 만든 마이그레이션의 create table 12개(Day 1~2 테이블, purchase_order `Migration20261023021402`, scan_batch `Migration20261023023713` 포함)는 `default character set utf8mb4`만 적고 collate를 적지 않아 서버 기본값(`--collation-server=utf8mb4_0900_ai_ci`, docker-compose.yml)에 기댄다. `Migration20261023032255`(service_ticket)부터는 `collate utf8mb4_0900_ai_ci`가 붙는다. 서버 기본값이 다른 MySQL에 체인을 적용하면 앞의 12개만 다른 collation이 될 수 있다(Day 3 리뷰 Minor 5). 지금은 고치지 않는다(같은 docker-compose로만 띄운다).
```

`docs/experiments/0006-대량-처리.md`:
- `### 표(3회 범위)` → `### 표(기본 순서 3회 범위. D의 "bulk 먼저" 두 줄은 순서 바꿈 2회 범위)`
- 보강 절 표 머리글 `| A 변형(500건) | 쿼리(select / insert) | 기본 순서 3회 | 뒤집은 순서 2회 |` → `| A 변형(500건) | 쿼리(select / insert) | 기본 순서 3회(전체 실행 2회 + 개발 중 1회) | 뒤집은 순서 2회 |`

`docs/devlog/2026-10-23.md`의 3일차 요약 "실험 결론" 첫 줄 앞부분 `- 0006 대량 처리(3회 범위): 500행 등록 N+1 2071 ~ 2210ms·쿼리 2503 대 일괄 엔진 307 ~ 347ms·쿼리 12.` → `- 0006 대량 처리(B·C·E는 3회 범위, A는 처음 3회 + 보강 5회(기본 순서 3회·뒤집은 순서 2회), D는 3회 + 순서 바꿈 2회를 합친 범위): 500행 등록 N+1 2071 ~ 2210ms·쿼리 2503 대 일괄 엔진 307 ~ 347ms·쿼리 12.`(뒤는 그대로)

- [ ] **Step 8: 기록과 커밋**

`docs/devlog/2026-10-23.md` 맨 아래(3일차 요약 뒤)에 덧붙인다. 파일에 `# Day 4`가 아직 없으면 구분선부터:
```markdown

---

# Day 4

> 2026-10-23. 이전: [3일차 요약](#3일차-요약). 스펙 `docs/specs/2026-10-23-day4-devices.md`, 계획 `docs/plans/2026-10-23-day4-devices.md`

## HH:MM Task 1 Day 3 이월: 공용 Redis 연결, 교체 단말기 예약, TICKET_NOT_REPLACING, 기록 정정 (F7, F6)
이전 커밋: (git log -1 --format=%h)
- 한 일: …
- 확인: 테스트 먼저 실패(redis.e2e 로드 실패, replacement 2 failed | 3 passed) → 30개 파일 204 passed, typecheck exit 0. "Connection is closed" 고치기 전 n/8 → 고친 뒤 n/8. 실험 0007 재실행: 고아 운송장 …
- 막힌 것: …
- 결정: decisions/0026, 0025 갱신 한 줄, experiments/0006·devlog 기준 표시 정정
- 다음: Task 2 device-sim
```

`docs/decisions/0026-공용-Redis-연결과-교체-단말기-예약.md`:
- 상황: Day 3 리뷰 Minor 1·2. ScanLock이 앱마다 전용 ioredis 연결을 만들고 error 리스너가 없었다. 테스트 첫 실행에서 출처 불명 `Connection is closed`(Step 1 재현 횟수). Day 4는 하트비트·제안·판정 잠금 등 Redis를 쓰는 곳이 늘어난다. 교체 출고 경합에서 진 요청 N-1건이 운송장을 발급받아 고아가 됐다(experiments/0007).
- 선택지(연결): 1) 기능마다 전용 연결 — 연결 수가 늘고 종료 처리가 흩어진다. 2) BullMQ 연결을 같이 쓰기 — BullMQ는 블로킹 명령을 쓰는 연결이 따로 있어 섞기 어렵고 생명주기가 BullMQ에 묶인다. 3) **앱 공용 연결 하나(`REDIS` 토큰, 전역 모듈)** — error 리스너·종료를 한 곳에서.
- 결정: 3. `maxRetriesPerRequest: 1`(요청이 오래 매달리지 않게). 종료는 `onApplicationShutdown`(모든 `onModuleDestroy` 뒤). 잠금은 `RedisLock(keyOf(kind, id), acquire(key, ttl), release(key, token))`으로 일반화하고 ScanLock은 감싸기만 한다.
- 선택지(예약): 1) 그대로(고아는 Day 7 정리) 2) **Redis 예약(SET NX PX, 토큰 비교 해제)** 3) MySQL에 예약 행/상태(RESERVED) — 단말기 상태가 하나 늘고 전이 규칙이 바뀐다.
- 결정: 2. 왜 Redis인가: "처리 중" 표시는 짧게 살고 프로세스가 죽으면 저절로 풀려야 한다(decisions/0020과 같은 이유). 예약은 사전 확인보다 **먼저**.
- TTL 만료 시 동작: 처리가 30초를 넘기면 다른 요청이 예약할 수 있고, 그 요청은 사전 확인을 통과하면 운송장을 발급받은 뒤 트랜잭션의 행 잠금에서 422(INVALID_TRANSITION)로 끝난다 → Day 3과 같은 고아 1장. 먼저 요청의 해제는 토큰이 달라 남의 예약을 지우지 않는다.
- 결과·대가: 같은 교체 단말기 동시 요청의 진 쪽 응답이 422에서 409(REPLACEMENT_RESERVED)로 바뀐다. 실험 0007 재실행 숫자(잰 값). 같은 접수에 서로 다른 교체 단말기로 동시에 요청하는 경우는 막지 못한다.
- 다시 볼 조건: 교체 처리가 TTL에 가까워질 때(택배사 지연), Redis 장애 시 교체 출고를 막을지 정해야 할 때.

`docs/study/backlog.md`에 추가:
```
- [ ] Nest 생명주기 훅 순서 — onModuleDestroy, beforeApplicationShutdown, onApplicationShutdown과 공용 자원(연결)을 닫는 자리 (redis/redis.module.ts, decisions/0026)
- [ ] ioredis 연결 상태(connecting·connect·ready·end)와 quit·disconnect, 'error' 리스너가 없을 때의 동작 (redis/redis.provider.ts)
```

커밋:
```bash
git add apps/api docs .env.example
git commit -m "fix(F7): 공용 Redis 연결과 교체 단말기 예약, 설치 확인 TICKET_NOT_REPLACING" -m "Refs: docs/decisions/0026-공용-Redis-연결과-교체-단말기-예약.md, docs/experiments/0007-교체-단말기-동시-요청.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 단말기 시뮬레이터 골격 — 관리 API, 시드 난수, keep-alive, 하트비트 루프, 통계 (F8, F12)

**Files:**
- Create: `apps/device-sim/package.json`, `apps/device-sim/tsconfig.json`, `apps/device-sim/tsconfig.build.json`, `apps/device-sim/vitest.config.ts`, `apps/device-sim/package-lock.json`(npm install이 만든다)
- Create: `apps/device-sim/src/rng.ts`, `config.ts`, `stats.ts`, `client.ts`, `fleet.ts`, `http.ts`, `server.ts`, `main.ts`
- Test: `apps/device-sim/test/helpers.ts`, `stats.spec.ts`, `fleet.spec.ts`, `admin.spec.ts`
- Modify: `.env.example`
- Record: devlog, `docs/decisions/0009-가상-업체-서버는-node-http-별도-프로세스.md`(갱신), `docs/study/backlog.md`

partners와 같은 방식(node:http 별도 프로세스, 메모리 상태, 관리 API, 시드 난수 mulberry32)이다. 이 Task는 하트비트만 보낸다(업데이트 지시 처리는 Task 8).
- 관리 API: `GET /__admin/health`, `GET|POST /__admin/config`(일부만 바꿈, 범위 검사 400, 돌던 중이면 보내던 주기를 끝내고 새 설정으로 다시 돈다), `POST /__admin/start|stop|reset`, `GET /__admin/stats`, `GET /__admin/devices/:serialNo`.
- 설정: targetUrl, serials 또는 serialPrefix·serialStart·count(`HB-0001` …), intervalMs, batchSize(1이면 단말기마다 요청 하나), concurrency(동시 요청 = keep-alive 소켓 상한), offlineSerials, offlineRate(시드로 고른 같은 단말기), firmwareVersion, requestTimeoutMs, seed.
- 주기마다 온라인 단말기를 batchSize씩 묶어 `POST /devices/heartbeats { items: [{ serialNo, firmwareVersion }] }`. 앞 주기가 안 끝났으면 그 주기는 건너뛰고 `skippedTicks`로 센다(밀린 주기를 몰아 보내지 않는다).
- stats: ticks, skippedTicks, requests, heartbeatsSent, heartbeatsAccepted(행별 결과 OK), heartbeatsRejected, errors(2xx 아님·연결 실패·시간 초과), latency p50·p95·max(가장 가까운 순위).

- [ ] **Step 1: 패키지 만들기**

`apps/device-sim/package.json`:
```json
{
  "name": "@terminal-ops/device-sim",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run"
  },
  "devDependencies": {
    "@types/node": "^24.19.2",
    "typescript": "~6.0.2",
    "vitest": "^5.0.5"
  }
}
```

`apps/device-sim/tsconfig.json`, `apps/device-sim/tsconfig.build.json`은 `apps/partners`의 두 파일을 그대로 복사한다(내용 같음).

`apps/device-sim/tsconfig.json`:
```json
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2023",
    "strict": true,
    "sourceMap": true,
    "outDir": "dist",
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`apps/device-sim/tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "rootDir": "src" },
  "include": ["src"]
}
```

`apps/device-sim/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.spec.ts'] },
});
```

Run (`apps/device-sim`): `npm install`
Expected: `found 0 vulnerabilities`, `package-lock.json` 생성(커밋한다). 사전 검증에서 typescript 6.0.3, vitest 5.0.5, @types/node 24.19.2가 깔렸다.

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/device-sim/test/helpers.ts`(가짜 우리 API와 시뮬레이터 관리 서버를 빈 포트에 띄운다):
```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readJson, sendJson } from '../src/http.js';
import { createSimServer } from '../src/server.js';

export interface ReceivedRequest {
  path: string;
  body: Record<string, unknown>;
  /** 요청이 온 소켓(클라이언트 포트). keep-alive면 같은 값이 되풀이된다 */
  remotePort: number;
}

type Handler = (req: ReceivedRequest, res: ServerResponse) => Promise<void> | void;

/** 하트비트는 모두 OK로 답한다(우리 API의 응답 모양). */
export const okHandler: Handler = (req, res) => {
  const items = (req.body.items ?? []) as { serialNo: string }[];
  sendJson(res, 200, { accepted: items.length, results: items.map((i) => ({ serialNo: i.serialNo, result: 'OK' })) });
};

/** 가짜 우리 API. 받은 요청을 모으고, 동시에 처리 중인 요청 수의 최댓값을 센다. */
export async function startFakeApi(handler: Handler = okHandler) {
  const received: ReceivedRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let current = handler;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const r = { path: req.url ?? '', body: (await readJson(req)) ?? {}, remotePort: req.socket.remotePort ?? 0 };
        received.push(r);
        await current(r, res);
      } finally {
        inFlight -= 1;
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    received,
    maxInFlight: () => maxInFlight,
    setHandler: (h: Handler) => (current = h),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export type FakeApi = Awaited<ReturnType<typeof startFakeApi>>;

/** 빈 포트에 시뮬레이터 관리 서버를 띄운다. */
export async function startSim() {
  const { server, fleet } = createSimServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    base,
    fleet,
    post,
    get: async (path: string) => (await fetch(`${base}${path}`)).json(),
    close: async () => {
      await fleet.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
```

`apps/device-sim/test/stats.spec.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { percentile, SimStats } from '../src/stats.js';

describe('응답 시간 통계', () => {
  it('백분위는 가장 가까운 순위 값이다', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBe(0);
  });

  it('기록한 응답 시간으로 p50·p95·max를 낸다', () => {
    const s = new SimStats();
    for (const ms of [30, 10, 20, 40]) s.recordLatency(ms);
    expect(s.view().latency).toEqual({ count: 4, p50: 20, p95: 40, max: 40 });
  });
});
```

`apps/device-sim/test/fleet.spec.ts`:
```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, serialsOf, type SimConfig } from '../src/config.js';
import { Fleet, pickSeeded } from '../src/fleet.js';
import { sendJson } from '../src/http.js';
import { okHandler, sleep, startFakeApi, type FakeApi } from './helpers.js';

describe('단말기 무리(Fleet)', () => {
  let api: FakeApi;
  let fleet: Fleet | undefined;
  const config = (patch: Partial<SimConfig>): SimConfig => ({ ...defaultConfig(), targetUrl: api.url, ...patch });

  beforeAll(async () => {
    api = await startFakeApi();
  });
  afterEach(async () => {
    await fleet?.close();
    fleet = undefined;
    api.received.length = 0;
    api.setHandler(okHandler);
  });
  afterAll(() => api.close());

  it('시리얼은 접두사·시작 번호·대수로 만든다(목록을 주면 그대로)', () => {
    expect(serialsOf({ ...defaultConfig(), serialPrefix: 'HB', serialStart: 9, count: 3 })).toEqual(['HB-0009', 'HB-0010', 'HB-0011']);
    expect(serialsOf({ ...defaultConfig(), serials: ['A-0001'] })).toEqual(['A-0001']);
  });

  it('한 주기에 온라인 단말기를 batchSize씩 묶어 보내고, 행별 결과를 센다', async () => {
    api.setHandler((req, res) => {
      const items = req.body.items as { serialNo: string }[];
      sendJson(res, 200, {
        results: items.map((i) => ({ serialNo: i.serialNo, result: i.serialNo === 'HB-0003' ? 'IGNORED_NOT_IN_SERVICE' : 'OK' })),
      });
    });
    fleet = new Fleet(config({ count: 5, batchSize: 2, firmwareVersion: '1.0.0' }));
    await fleet.tick();
    expect(api.received.map((r) => r.path)).toEqual(['/devices/heartbeats', '/devices/heartbeats', '/devices/heartbeats']);
    expect(api.received.map((r) => (r.body.items as unknown[]).length)).toEqual([2, 2, 1]);
    expect(api.received[0].body.items).toEqual([
      { serialNo: 'HB-0001', firmwareVersion: '1.0.0' },
      { serialNo: 'HB-0002', firmwareVersion: '1.0.0' },
    ]);
    expect(fleet.stats.view()).toMatchObject({ ticks: 1, requests: 3, heartbeatsSent: 5, heartbeatsAccepted: 4, heartbeatsRejected: 1, errors: 0 });
    expect(fleet.stats.view().latency.count).toBe(3);
  });

  it('오프라인 단말기는 보내지 않는다. offlineRate는 시드로 정해진 같은 단말기를 고른다', async () => {
    fleet = new Fleet(config({ count: 100, batchSize: 100, offlineSerials: ['HB-0001'], offlineRate: 0.1, seed: 7 }));
    const offline = [...fleet.devices.values()].filter((d) => d.offline).map((d) => d.serialNo);
    const picked = pickSeeded(serialsOf(fleet.config), 10, 7);
    expect(new Set(offline)).toEqual(new Set(['HB-0001', ...picked]));
    expect(pickSeeded(serialsOf(fleet.config), 10, 7)).toEqual(picked); // 같은 시드면 같은 단말기
    await fleet.tick();
    const sent = (api.received[0].body.items as { serialNo: string }[]).map((i) => i.serialNo);
    expect(sent).toHaveLength(100 - offline.length);
    expect(sent.some((s) => offline.includes(s))).toBe(false);
  });

  it('동시 요청은 concurrency를 넘지 않고, keep-alive라 소켓을 다시 쓴다', async () => {
    api.setHandler(async (req, res) => {
      await sleep(30);
      okHandler(req, res);
    });
    fleet = new Fleet(config({ count: 40, batchSize: 1, concurrency: 4 }));
    await fleet.tick();
    await fleet.tick();
    expect(api.received).toHaveLength(80);
    expect(api.maxInFlight()).toBeLessThanOrEqual(4);
    expect(new Set(api.received.map((r) => r.remotePort)).size).toBeLessThanOrEqual(4);
  });

  it('2xx가 아니거나 연결이 안 되면 errors로 센다', async () => {
    api.setHandler((_req, res) => sendJson(res, 500, { error: 'X' }));
    fleet = new Fleet(config({ count: 2, batchSize: 1 }));
    await fleet.tick();
    expect(fleet.stats.view()).toMatchObject({ requests: 2, errors: 2, heartbeatsAccepted: 0 });

    await fleet.close();
    fleet = new Fleet(config({ count: 1, targetUrl: 'http://127.0.0.1:1' }));
    await fleet.tick();
    expect(fleet.stats.view().errors).toBe(1);
  });

  it('start하면 주기마다 보내고, 앞 주기가 안 끝났으면 그 주기는 건너뛴다(skippedTicks)', async () => {
    api.setHandler(async (req, res) => {
      await sleep(120);
      okHandler(req, res);
    });
    fleet = new Fleet(config({ count: 1, intervalMs: 50 }));
    fleet.start();
    await sleep(300);
    await fleet.stop();
    const s = fleet.stats.view();
    expect(s.ticks).toBeGreaterThanOrEqual(2);
    expect(s.skippedTicks).toBeGreaterThanOrEqual(1);
    expect(fleet.running).toBe(false);
  });
});
```

`apps/device-sim/test/admin.spec.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sleep, startFakeApi, startSim, type FakeApi } from './helpers.js';

describe('시뮬레이터 관리 API', () => {
  let api: FakeApi;
  let sim: Awaited<ReturnType<typeof startSim>>;

  beforeAll(async () => {
    api = await startFakeApi();
    sim = await startSim();
  });
  beforeEach(async () => {
    await sim.post('/__admin/reset');
    api.received.length = 0;
  });
  afterAll(async () => {
    await sim.close();
    await api.close();
  });

  it('health', async () => {
    expect(await sim.get('/__admin/health')).toEqual({ status: 'ok' });
  });

  it('설정은 일부만 바꿀 수 있고, 범위를 벗어나거나 JSON이 깨지면 400', async () => {
    const res = await sim.post('/__admin/config', { targetUrl: api.url, count: 3, batchSize: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ targetUrl: api.url, count: 3, batchSize: 2, intervalMs: 30_000 });
    expect((await sim.post('/__admin/config', { batchSize: 0 })).status).toBe(400);
    expect((await sim.post('/__admin/config', { offlineRate: 2 })).status).toBe(400);
    const broken = await fetch(`${sim.base}/__admin/config`, { method: 'POST', body: '{"count":' });
    expect(broken.status).toBe(400);
  });

  it('start → 주기마다 보냄 → stop, stats에 보낸 수와 응답 시간', async () => {
    await sim.post('/__admin/config', { targetUrl: api.url, count: 3, batchSize: 3, intervalMs: 50 });
    await sim.post('/__admin/start');
    await sleep(180);
    expect((await (await sim.post('/__admin/stop')).json()).running).toBe(false);
    const stats = await sim.get('/__admin/stats');
    expect(stats.running).toBe(false);
    expect(stats.ticks).toBeGreaterThanOrEqual(2);
    expect(stats.heartbeatsSent).toBe(stats.ticks * 3);
    expect(stats.heartbeatsAccepted).toBe(stats.heartbeatsSent);
    expect(stats.latency.count).toBe(stats.requests);
    const after = api.received.length;
    await sleep(120);
    expect(api.received.length).toBe(after); // 멈춘 뒤에는 보내지 않는다
  });

  it('단말기 상태 조회(없으면 404)', async () => {
    await sim.post('/__admin/config', { count: 2, serialPrefix: 'DV', firmwareVersion: '2.0.0' });
    expect(await sim.get('/__admin/devices/DV-0002')).toEqual({ serialNo: 'DV-0002', firmwareVersion: '2.0.0', offline: false });
    expect((await fetch(`${sim.base}/__admin/devices/NONE`)).status).toBe(404);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run (`apps/device-sim`): `npx vitest run`
Expected: `Test Files  3 failed (3)`, 세 파일 모두 `Cannot find module '../src/…'`(파일 로드 실패, 테스트 0개 실행).

- [ ] **Step 4: 구현**

`apps/device-sim/src/rng.ts`는 `apps/partners/src/rng.ts`를 그대로 복사한다(앱끼리 공유 패키지가 없다):
```ts
/** 시드로 재현할 수 있는 난수(mulberry32). 같은 시드, 같은 호출 순서면 같은 값이 나온다. 0 이상 1 미만. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

`apps/device-sim/src/config.ts`:
```ts
/** 시뮬레이터 설정. 관리 API(POST /__admin/config)로 일부만 바꿀 수 있다(나머지는 그대로). */
export interface SimConfig {
  /** 하트비트를 보낼 API 주소(예: http://127.0.0.1:3000) */
  targetUrl: string;
  /** 단말기 시리얼 목록. 비어 있으면 serialPrefix·serialStart·count로 만든다(`HB-0001` …) */
  serials: string[];
  serialPrefix: string;
  serialStart: number;
  count: number;
  /** 하트비트 주기(ms). 한 주기에 온라인 단말기가 모두 한 번씩 보낸다 */
  intervalMs: number;
  /** 한 요청에 담는 하트비트 수. 1이면 단말기마다 요청 하나 */
  batchSize: number;
  /** 동시에 보내는 요청 수 상한. keep-alive 소켓 수 상한과 같다(Windows 임시 포트 고갈 방지) */
  concurrency: number;
  /** 하트비트를 보내지 않는 단말기 */
  offlineSerials: string[];
  /** 이 비율만큼 단말기를 시드 난수로 골라 오프라인으로 둔다(0~1). offlineSerials와 합쳐진다 */
  offlineRate: number;
  /** 단말기의 처음 펌웨어 버전 */
  firmwareVersion: string;
  /** 요청 하나의 제한 시간(ms) */
  requestTimeoutMs: number;
  seed: number;
}

export type SimConfigPatch = Partial<SimConfig>;

export function defaultConfig(): SimConfig {
  return {
    targetUrl: 'http://127.0.0.1:3000',
    serials: [],
    serialPrefix: 'HB',
    serialStart: 1,
    count: 10,
    intervalMs: 30_000,
    batchSize: 100,
    concurrency: 8,
    offlineSerials: [],
    offlineRate: 0,
    firmwareVersion: '1.0.0',
    requestTimeoutMs: 5000,
    seed: 42,
  };
}

/** 단말기 시리얼 목록 */
export function serialsOf(config: SimConfig): string[] {
  if (config.serials.length > 0) return [...config.serials];
  return Array.from({ length: config.count }, (_, i) => `${config.serialPrefix}-${String(config.serialStart + i).padStart(4, '0')}`);
}

/** 숫자 설정의 범위 검사. 틀리면 이유 문장, 맞으면 null */
export function invalidReason(config: SimConfig): string | null {
  const positive: (keyof SimConfig)[] = ['intervalMs', 'batchSize', 'concurrency', 'requestTimeoutMs'];
  for (const key of positive) {
    const v = config[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return `${key}는 1 이상의 정수여야 합니다.`;
  }
  for (const key of ['offlineRate'] as const) {
    if (!(config[key] >= 0 && config[key] <= 1)) return `${key}는 0~1이어야 합니다.`;
  }
  if (!Number.isInteger(config.count) || config.count < 0) return 'count는 0 이상의 정수여야 합니다.';
  return null;
}
```

`apps/device-sim/src/stats.ts`:
```ts
/** 정렬된 배열의 백분위 값(가장 가까운 순위). 비어 있으면 0 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** 응답 시간 표본 상한. 넘으면 오래된 것부터 버리지 않고 더 담지 않는다(실험 한 번에 충분한 양) */
const MAX_SAMPLES = 500_000;

export interface StatsView {
  /** 하트비트 주기 수(보낸 주기) */
  ticks: number;
  /** 앞 주기가 아직 끝나지 않아 건너뛴 주기 수. 0보다 크면 주기 안에 다 보내지 못한 것이다 */
  skippedTicks: number;
  /** 보낸 HTTP 요청 수 */
  requests: number;
  /** 보낸 하트비트 수(요청 안의 항목 수 합) */
  heartbeatsSent: number;
  /** 응답의 행별 결과가 OK인 수 */
  heartbeatsAccepted: number;
  /** 행별 결과가 OK가 아닌 수(IGNORED_NOT_IN_SERVICE 등) */
  heartbeatsRejected: number;
  /** 2xx가 아닌 응답·연결 실패·시간 초과 */
  errors: number;
  /** 요청 응답 시간(ms) */
  latency: { count: number; p50: number; p95: number; max: number };
  startedAt: string | null;
  lastTickAt: string | null;
}

export class SimStats {
  ticks = 0;
  skippedTicks = 0;
  requests = 0;
  heartbeatsSent = 0;
  heartbeatsAccepted = 0;
  heartbeatsRejected = 0;
  errors = 0;
  startedAt: string | null = null;
  lastTickAt: string | null = null;
  private latencies: number[] = [];

  recordLatency(ms: number): void {
    if (this.latencies.length < MAX_SAMPLES) this.latencies.push(ms);
  }

  view(): StatsView {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      ticks: this.ticks,
      skippedTicks: this.skippedTicks,
      requests: this.requests,
      heartbeatsSent: this.heartbeatsSent,
      heartbeatsAccepted: this.heartbeatsAccepted,
      heartbeatsRejected: this.heartbeatsRejected,
      errors: this.errors,
      latency: {
        count: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max: sorted.at(-1) ?? 0,
      },
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
    };
  }
}
```

`apps/device-sim/src/client.ts`(keep-alive 에이전트 하나, `maxSockets = concurrency`):
```ts
import { Agent, request } from 'node:http';

export interface ApiResponse {
  status: number;
  body: unknown;
  /** 요청을 보내고 본문을 다 받을 때까지(ms) */
  ms: number;
}

/**
 * 우리 API로 JSON을 보내는 HTTP 클라이언트. keep-alive 에이전트 하나를 쓰고 소켓 수를 maxSockets로 묶는다.
 * 요청마다 새 연결을 열면 5,000대 실험에서 Windows 임시 포트(TIME_WAIT)가 바닥날 수 있다.
 */
export class ApiClient {
  private readonly agent: Agent;

  constructor(
    private readonly baseUrl: string,
    maxSockets: number,
    private readonly timeoutMs: number,
  ) {
    this.agent = new Agent({ keepAlive: true, maxSockets, maxFreeSockets: maxSockets });
  }

  postJson(path: string, body: unknown): Promise<ApiResponse> {
    const url = new URL(path, this.baseUrl);
    const payload = Buffer.from(JSON.stringify(body));
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'POST',
          agent: this.agent,
          headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = text;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              // JSON이 아니면 글자 그대로 둔다
            }
            resolve({ status: res.statusCode ?? 0, body: parsed, ms: performance.now() - started });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`요청 시간 초과(${this.timeoutMs}ms)`)));
      req.on('error', reject);
      req.end(payload);
    });
  }

  close(): void {
    this.agent.destroy();
  }
}
```

`apps/device-sim/src/fleet.ts`:
```ts
import { ApiClient } from './client.js';
import { defaultConfig, serialsOf, type SimConfig } from './config.js';
import { createRng } from './rng.js';
import { SimStats } from './stats.js';

export interface Device {
  serialNo: string;
  firmwareVersion: string;
  /** 하트비트를 보내지 않는 단말기 */
  offline: boolean;
}

/** API 하트비트 응답의 행 하나(apps/api HeartbeatService) */
interface HeartbeatResult {
  serialNo: string;
  result: string;
}

/** 작업 목록을 동시에 n개까지만 돌린다. */
export async function runPool<T>(items: T[], n: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await work(item);
    }
  });
  await Promise.all(lanes);
}

/** 시드로 정해지는 순서로 섞어 앞에서 k개를 고른다(Fisher–Yates). 같은 시드·같은 목록이면 같은 결과 */
export function pickSeeded<T>(items: T[], k: number, seed: number): T[] {
  const rng = createRng(seed);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

/**
 * 단말기 무리. 주기마다 온라인 단말기의 하트비트를 batchSize씩 묶어 `POST /devices/heartbeats`로 보낸다
 * (동시 요청은 concurrency까지). 앞 주기가 끝나지 않았으면 그 주기는 건너뛰고 skippedTicks로 센다.
 */
export class Fleet {
  config: SimConfig = defaultConfig();
  stats = new SimStats();
  devices = new Map<string, Device>();
  private client: ApiClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inTick: Promise<void> | null = null;

  constructor(config: SimConfig = defaultConfig()) {
    this.configure(config);
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** 설정을 바꾸고 단말기 목록을 다시 만든다. 이미 있던 단말기의 펌웨어는 유지한다. */
  configure(config: SimConfig): void {
    this.config = config;
    const serials = serialsOf(config);
    const offline = new Set([...config.offlineSerials, ...pickSeeded(serials, Math.round(serials.length * config.offlineRate), config.seed)]);
    const next = new Map<string, Device>();
    for (const serialNo of serials) {
      const prev = this.devices.get(serialNo);
      next.set(serialNo, { serialNo, firmwareVersion: prev?.firmwareVersion ?? config.firmwareVersion, offline: offline.has(serialNo) });
    }
    this.devices = next;
    this.client?.close();
    this.client = new ApiClient(config.targetUrl, config.concurrency, config.requestTimeoutMs);
  }

  start(): void {
    if (this.timer) return;
    this.stats.startedAt ??= new Date().toISOString();
    this.timer = setInterval(() => void this.tickIfIdle(), this.config.intervalMs);
    void this.tickIfIdle();
  }

  /** 멈추고, 보내는 중인 주기가 끝날 때까지 기다린다. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inTick;
  }

  async reset(config: SimConfig = defaultConfig()): Promise<void> {
    await this.stop();
    this.devices.clear();
    this.stats = new SimStats();
    this.configure(config);
  }

  async close(): Promise<void> {
    await this.stop();
    this.client?.close();
  }

  private async tickIfIdle(): Promise<void> {
    if (this.inTick) {
      this.stats.skippedTicks += 1;
      return;
    }
    this.inTick = this.tick().finally(() => (this.inTick = null));
    await this.inTick;
  }

  /** 한 주기: 온라인 단말기를 batchSize씩 묶어 보낸다. */
  async tick(): Promise<void> {
    this.stats.ticks += 1;
    this.stats.lastTickAt = new Date().toISOString();
    const online = [...this.devices.values()].filter((d) => !d.offline);
    const batches: Device[][] = [];
    for (let i = 0; i < online.length; i += this.config.batchSize) batches.push(online.slice(i, i + this.config.batchSize));
    await runPool(batches, this.config.concurrency, (batch) => this.send(batch));
  }

  private async send(batch: Device[]): Promise<void> {
    const client = this.client!;
    this.stats.requests += 1;
    this.stats.heartbeatsSent += batch.length;
    try {
      const res = await client.postJson('/devices/heartbeats', {
        items: batch.map((d) => ({ serialNo: d.serialNo, firmwareVersion: d.firmwareVersion })),
      });
      this.stats.recordLatency(res.ms);
      if (res.status < 200 || res.status >= 300) {
        this.stats.errors += 1;
        return;
      }
      const results = (res.body as { results?: HeartbeatResult[] } | null)?.results ?? [];
      for (const r of results) {
        if (r.result === 'OK') this.stats.heartbeatsAccepted += 1;
        else this.stats.heartbeatsRejected += 1;
      }
    } catch {
      this.stats.errors += 1;
    }
  }
}
```

`apps/device-sim/src/http.ts`:
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 본문이 있는데 JSON 객체가 아닐 때 던진다. 서버가 400으로 바꿔 응답한다. */
export class BadJsonError extends Error {}

/** JSON 본문을 읽는다. 본문이 비었으면 undefined, 깨졌거나 객체가 아니면 BadJsonError */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BadJsonError('본문이 올바른 JSON이 아닙니다.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadJsonError('본문은 JSON 객체여야 합니다.');
  return value as Record<string, unknown>;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
```

`apps/device-sim/src/server.ts`:
```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { defaultConfig, invalidReason, type SimConfigPatch } from './config.js';
import { Fleet } from './fleet.js';
import { BadJsonError, readJson, sendJson } from './http.js';

async function route(fleet: Fleet, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://device-sim').pathname;
  const method = req.method ?? 'GET';
  let m: RegExpMatchArray | null;

  if (method === 'GET' && path === '/__admin/health') return sendJson(res, 200, { status: 'ok' });
  if (method === 'GET' && path === '/__admin/config') return sendJson(res, 200, fleet.config);
  if (method === 'POST' && path === '/__admin/config') {
    const patch = ((await readJson(req)) ?? {}) as SimConfigPatch;
    const next = { ...fleet.config, ...patch };
    const reason = invalidReason(next);
    if (reason) return sendJson(res, 400, { error: 'BAD_CONFIG', message: reason });
    // 보내는 중인 주기를 끝낸 뒤 바꾸고, 돌던 중이었으면 새 설정(주기 포함)으로 다시 돈다.
    const wasRunning = fleet.running;
    await fleet.stop();
    fleet.configure(next);
    if (wasRunning) fleet.start();
    return sendJson(res, 200, fleet.config);
  }
  if (method === 'POST' && path === '/__admin/start') {
    fleet.start();
    return sendJson(res, 200, { running: true });
  }
  if (method === 'POST' && path === '/__admin/stop') {
    await fleet.stop();
    return sendJson(res, 200, { running: false });
  }
  if (method === 'POST' && path === '/__admin/reset') {
    await fleet.reset(defaultConfig());
    return sendJson(res, 200, fleet.config);
  }
  if (method === 'GET' && path === '/__admin/stats') return sendJson(res, 200, { running: fleet.running, ...fleet.stats.view() });
  if (method === 'GET' && (m = path.match(/^\/__admin\/devices\/([^/]+)$/))) {
    const device = fleet.devices.get(decodeURIComponent(m[1]));
    return device ? sendJson(res, 200, device) : sendJson(res, 404, { error: 'NO_DEVICE' });
  }
  sendJson(res, 404, { error: 'NO_ROUTE', method, path });
}

/** 단말기 시뮬레이터. 관리 API로 설정·시작·정지하고 통계를 본다. 상태는 메모리에만 있다. */
export function createSimServer(fleet = new Fleet()): { server: Server; fleet: Fleet } {
  const server = createServer((req, res) => {
    route(fleet, req, res).catch((error: unknown) => {
      if (error instanceof BadJsonError && !res.headersSent) return sendJson(res, 400, { error: 'BAD_REQUEST', message: error.message });
      if (!res.headersSent) sendJson(res, 500, { error: 'INTERNAL', message: String(error) });
      else res.end();
    });
  });
  return { server, fleet };
}
```

`apps/device-sim/src/main.ts`:
```ts
import { createSimServer } from './server.js';

const port = Number(process.env.DEVICE_SIM_PORT ?? 4020);
const { server, fleet } = createSimServer();

server.listen(port, '127.0.0.1', () => {
  console.log(`device-sim listening on http://127.0.0.1:${port}`);
});

// 하트비트 루프를 멈추고(보내던 주기는 끝까지), keep-alive 연결을 끊고 끝낸다.
const shutdown = () => {
  void fleet.close().finally(() => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

`.env.example`의 `PARTNERS_PORT=4010` 다음 줄에 추가:
```
# Day 4: 단말기 시뮬레이터 관리 포트(테스트는 4021)
DEVICE_SIM_PORT=4020
```

- [ ] **Step 5: 통과 확인**

Run (`apps/device-sim`):
```bash
npx vitest run && npx vitest run && npm run typecheck && npm run build
```
Expected: 두 번 모두 `Test Files  3 passed (3)`, `Tests  12 passed (12)`(시간에 기대는 테스트 — 주기·건너뛴 주기·keep-alive — 가 흔들리지 않는지 두 번 본다), typecheck·build exit 0. api(`npx vitest run`)는 바뀌지 않아 30개 파일 204 passed.

- [ ] **Step 6: 기록과 커밋**

devlog에 `## HH:MM Task 2 단말기 시뮬레이터 골격 (F8, F12)` 항목(이전 커밋, 한 일, 확인: 실패 3 files → 3 files 12 passed ×2, 막힌 것, 결정: 0009 갱신, 다음: Task 3).

`docs/decisions/0009-가상-업체-서버는-node-http-별도-프로세스.md` 끝에:
```
- 갱신(2026-10-23 Day 4): 단말기 시뮬레이터 `apps/device-sim`도 같은 방식(node:http 별도 프로세스, 메모리 상태, 관리 API, 시드 난수)으로 만들었다. 의존성은 개발용(typescript·vitest·@types/node)뿐. 다른 점: ① 우리 API를 **부르는** 쪽이라 keep-alive 에이전트 하나로 소켓 수를 concurrency로 묶는다(5,000대가 요청마다 연결을 열면 Windows 임시 포트가 TIME_WAIT로 바닥날 수 있다) ② 앞 주기가 안 끝났으면 그 주기는 건너뛰고 skippedTicks로 센다(밀린 하트비트를 몰아 보내 부하를 부풀리지 않는다) ③ 오프라인 단말기는 시드로 섞어 고른다(같은 시드면 같은 단말기). 테스트에서는 실제 프로세스가 필요한 곳(연동 확인·실험)만 `test/helpers/device-sim.ts`로 띄우고 PID로 끈다(Task 8). 포트는 개발 4020, 테스트 4021.
```

`docs/study/backlog.md`에 추가:
```
- [ ] HTTP keep-alive와 Node http.Agent(maxSockets·maxFreeSockets), TIME_WAIT와 임시 포트 고갈 (apps/device-sim/src/client.ts)
- [ ] 백분위(p50·p95) 계산 방법 — 가장 가까운 순위 vs 보간, 표본 상한 (apps/device-sim/src/stats.ts)
```

커밋:
```bash
git add apps/device-sim .env.example docs
git commit -m "feat(F8): 단말기 시뮬레이터 골격(관리 API, keep-alive 하트비트 루프, 통계)" -m "Refs: docs/decisions/0009-가상-업체-서버는-node-http-별도-프로세스.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 하트비트 API — Redis에만 쓰기, 행별 결과, 운영 중 단말기 목록(active) 재구성 (F8)

**Files:**
- Create: `apps/api/src/redis/redis-exec.ts`, `apps/api/src/device/device-keys.ts`, `apps/api/src/device/dto/heartbeat.dto.ts`, `apps/api/src/device/heartbeat.service.ts`, `apps/api/src/device/active-set.service.ts`, `apps/api/src/device/device.controller.ts`, `apps/api/src/device/device.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Test: `apps/api/test/heartbeat.e2e.spec.ts`(새)
- Record: devlog, `docs/decisions/0027-하트비트는-상태-전이가-아니다-Redis에만-쓴다.md`, `docs/study/backlog.md`

결정 기록을 먼저 쓴다(Step 1). 하트비트·온라인/오프라인은 단말기 lifecycle 전이가 아니다. 전이 서비스·이력·Outbox를 거치지 않고, 단말기 상태 enum을 건드리지 않는다.
- `POST /devices/heartbeats { items: [{ serialNo, firmwareVersion }] }`(1~500개, 작업자 헤더 없음 — 단말기가 부른다) → 200 `{ accepted, results: [{ serialNo, result }] }`. result: `OK`, `IGNORED_NOT_IN_SERVICE`, `INVALID_FORMAT`(시리얼 형식, 펌웨어 버전 `[0-9A-Za-z.-]{1,20}`). 앞뒤 공백은 다듬는다(troubleshooting/0012와 같은 규칙).
- Redis 왕복 2번: ① `HMGET active` ② pipeline `ZADD lastseen <now> <serial> …` + `HSET fw`. MySQL 쿼리 0.
- active(HASH serialNo → terminal.id)는 이 Task에서 `rebuild()`(MySQL의 IN_SERVICE 전체 → 임시 키 → PERSIST·RENAME)만 만든다. 이벤트로 맞추는 프로젝터와 주기 작업은 Task 4.

- [ ] **Step 1: 결정 기록 먼저**

`docs/decisions/0027-하트비트는-상태-전이가-아니다-Redis에만-쓴다.md`:
- 상황: F8. 설치된 단말기 수천 대가 30초마다 하트비트를 보낸다(5,000대면 초당 약 170건). 운영자가 알고 싶은 것은 "지금 살아 있나, 마지막으로 언제 봤나, 펌웨어 버전"이고, 과거 하트비트 하나하나는 의미가 없다.
- 선택지(모델):
  1. 상태 전이로 다루기(IN_SERVICE ↔ OFFLINE 같은 상태 추가) — 하트비트마다 전이 서비스(행 잠금, version, 이력, Outbox)를 거친다. 이력이 하트비트로 뒤덮이고, 접속 끊김이 lifecycle(배송·회수)과 섞인다. enum ALTER도 필요.
  2. **파생 상태**: lifecycle과 별개로 "마지막 하트비트 시각·버전"만 유지하고, 온라인 여부는 시각으로 계산한다. 전이·이력·Outbox를 거치지 않는다.
- 선택지(저장소):
  1. 하트비트마다 MySQL UPSERT — 초당 수백 건의 행 쓰기(redo·binlog·잠금). 실험 0008에서 숫자로 비교한다(Task 9의 실험용 경로).
  2. **Redis ZSET(serialNo → 마지막 시각 ms) + HASH(serialNo → 버전)** — 쓰기는 메모리 명령 2개, 최신값만 남는다. ZSET이라 "기준보다 오래된 단말기"를 범위 조회(ZRANGEBYSCORE)로 한 번에 찾는다. MySQL에는 바뀐 것(Task 5 판정)과 주기 스냅샷만.
- 결정: 모델 2 + 저장소 2. 왜 MySQL이 아니라 Redis인가(CLAUDE.md 원칙): 쓰기가 많고 최신값만 의미 있으며 잃어도 다음 하트비트(30초)가 다시 채운다(설계안 4장 Redis ②).
- 세부: lastSeen은 **서버 시계**(단말기 시계를 믿지 않는다, `sentAt` 받지 않음). 단건 엔드포인트 없음(항목 1개짜리 묶음). 묶음 안의 행이 틀려도 묶음 전체를 400으로 버리지 않고 행별 결과(decisions/0019와 같은 생각). 작업자 헤더 대신 형식 검사, 단말기 인증은 미룸(decisions/0001과 같은 이유). Redis 왕복은 묶음당 2번.
- 결과·대가: Redis가 원본이라 Redis가 죽으면 하트비트가 500이다(우회하지 않음). Redis 데이터를 잃으면 lastSeen이 비고 다음 하트비트까지 접속 상태가 MySQL 스냅샷 값으로 보인다.
- 다시 볼 조건: 하트비트에 상태 정보(배터리·오류 코드)가 붙어 이력이 필요해지면, 단말기 수가 수십만이 되어 ZSET 하나가 커지면(키 나누기).

- [ ] **Step 2: 실패하는 테스트 작성**

`apps/api/test/heartbeat.e2e.spec.ts`(새):
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../src/device/active-set.service.js';
import { deviceKeys } from '../src/device/device-keys.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { captureQueries } from './helpers/query-log.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { prepareInService, SCENARIO_OP } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('하트비트 (F8, decisions/0027·0028)', () => {
  let t: TestApp;
  let redis: Redis;
  const keys = () => deviceKeys();
  const beat = (items: unknown[]) => t.http().post('/devices/heartbeats').send({ items });
  const idOf = async (serialNo: string) => String((await t.orm.em.fork().findOneOrFail(Terminal, { serialNo })).id);

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    await resetDatabase(t.orm);
    await prepareInService(t, 'HB-0001');
    await prepareInService(t, 'HB-0002');
    await t.http().post('/terminals').set(SCENARIO_OP).send({ serialNo: 'HB-0003', modelCode: 'SN-100' }); // RECEIVED
  });
  beforeEach(async () => {
    await deleteTestKeys(redis, 'hb:');
    await t.app.get(ActiveSetService).rebuild();
  });
  afterAll(async () => {
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('active는 MySQL의 IN_SERVICE 단말기(serialNo → id)로 다시 만들고, TTL이 없다', async () => {
    expect(await redis.hgetall(keys().active)).toEqual({ 'HB-0001': await idOf('HB-0001'), 'HB-0002': await idOf('HB-0002') });
    expect(await redis.pttl(keys().active)).toBe(-1);
    // 다시 만들면 바뀐 상태를 따라간다(남은 임시 키 없음)
    await t.orm.em.fork().nativeUpdate(Terminal, { serialNo: 'HB-0002' }, { status: TerminalStatus.RETURN_REQUESTED });
    expect(await t.app.get(ActiveSetService).rebuild()).toBe(1);
    expect(await redis.hkeys(keys().active)).toEqual(['HB-0001']);
    expect(await redis.keys(`${keys().active}:rebuild:*`)).toEqual([]);
    await t.orm.em.fork().nativeUpdate(Terminal, { serialNo: 'HB-0002' }, { status: TerminalStatus.IN_SERVICE });
  });

  it('묶음의 행마다 결과: 운영 중이면 OK, 아니면 IGNORED_NOT_IN_SERVICE, 형식이 틀리면 INVALID_FORMAT', async () => {
    const before = Date.now();
    const res = await beat([
      { serialNo: 'HB-0001', firmwareVersion: '1.0.0' },
      { serialNo: 'HB-0003', firmwareVersion: '1.0.0' },
      { serialNo: 'bad serial', firmwareVersion: '1.0.0' },
      { serialNo: 'HB-0002' },
      { serialNo: ' HB-0002 ', firmwareVersion: '1.0.1' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(2);
    expect(res.body.results.map((r: { serialNo: string; result: string }) => [r.serialNo, r.result])).toEqual([
      ['HB-0001', 'OK'],
      ['HB-0003', 'IGNORED_NOT_IN_SERVICE'],
      ['bad serial', 'INVALID_FORMAT'],
      ['HB-0002', 'INVALID_FORMAT'],
      ['HB-0002', 'OK'],
    ]);

    const seen = Number(await redis.zscore(keys().lastSeen, 'HB-0001'));
    expect(seen).toBeGreaterThanOrEqual(before);
    expect(seen).toBeLessThanOrEqual(Date.now());
    expect(await redis.hgetall(keys().firmware)).toEqual({ 'HB-0001': '1.0.0', 'HB-0002': '1.0.1' });
    expect(await redis.zscore(keys().lastSeen, 'HB-0003')).toBeNull();
  });

  it('하트비트는 MySQL에 아무 쿼리도 보내지 않는다(상태 전이가 아니다)', async () => {
    const log = captureQueries(t.orm);
    try {
      expect((await beat([{ serialNo: 'HB-0001', firmwareVersion: '1.0.0' }])).status).toBe(200);
    } finally {
      log.stop();
    }
    expect(log.queries).toEqual([]);
    expect((await t.http().get('/terminals/HB-0001/history')).body.at(-1).toStatus).toBe('IN_SERVICE');
  });

  it('묶음 모양이 틀리면 400(빈 배열, 500개 초과, 배열 아님, 객체가 아닌 항목, 모르는 필드)', async () => {
    expect((await beat([])).status).toBe(400);
    expect((await beat(Array.from({ length: 501 }, () => ({ serialNo: 'HB-0001', firmwareVersion: '1' })))).status).toBe(400);
    expect((await t.http().post('/devices/heartbeats').send({ items: 'x' })).status).toBe(400);
    expect((await beat(['HB-0001'])).status).toBe(400);
    expect((await t.http().post('/devices/heartbeats').send({ items: [{}], extra: 1 })).status).toBe(400);
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run test/heartbeat.e2e.spec.ts`
Expected: `Test Files  1 failed (1)`, `Tests  no tests` — `Error: Cannot find module '../src/device/active-set.service.js'`(파일 로드 실패).

- [ ] **Step 4: 구현**

`apps/api/src/redis/redis-exec.ts`(새):
```ts
import type { ChainableCommander } from 'ioredis';

/**
 * pipeline·multi를 보내고 결과 값 배열을 돌려준다. ioredis는 명령 하나가 실패해도 exec()를 거절하지 않고
 * 결과 배열에 [오류, 값]으로 담는다. 하나라도 실패했으면 그 오류를 던진다.
 */
export async function execOrThrow(batch: ChainableCommander): Promise<unknown[]> {
  const results = (await batch.exec()) ?? [];
  const failed = results.find(([error]) => error);
  if (failed) throw failed[0];
  return results.map(([, value]) => value);
}
```

`apps/api/src/device/device-keys.ts`(새, Day 4 키 전부를 한 곳에. offline·snapshotAt·offers는 Task 5·6에서 쓴다):
```ts
import { env } from '../config/env.js';

/**
 * 접속 상태(F8)의 Redis 키(decisions/0027). 큐와 같은 접두사를 붙여 테스트(test-…)와 개발(terminal-ops)을 나눈다.
 * - lastSeen  ZSET  serialNo → 마지막 하트비트 시각(ms, 서버 시계)
 * - firmware  HASH  serialNo → 마지막으로 보고한 펌웨어 버전
 * - active    HASH  serialNo → terminal.id (IN_SERVICE 단말기만. 하트비트를 받을지 가르는 기준, decisions/0028)
 * - offline   SET   serialNo (오프라인으로 기록해 둔 단말기, decisions/0029)
 * - snapshotAt STRING 마지막 스냅샷이 반영한 lastSeen 점수(ms)
 * - offers    HASH  serialNo → {"rolloutId":n,"version":"…"} (펌웨어 업데이트 제안, decisions/0030)
 */
export function deviceKeys() {
  const p = env.queuePrefix;
  return {
    lastSeen: `${p}:hb:lastseen`,
    firmware: `${p}:hb:fw`,
    active: `${p}:hb:active`,
    offline: `${p}:hb:offline`,
    snapshotAt: `${p}:hb:snapshot-at`,
    offers: `${p}:fw:offers`,
  };
}
```

`apps/api/src/device/dto/heartbeat.dto.ts`(새):
```ts
import { ArrayMaxSize, ArrayMinSize, IsArray, IsObject } from 'class-validator';

/** 한 요청에 담을 수 있는 하트비트 수 */
export const MAX_HEARTBEATS_PER_REQUEST = 500;

/**
 * 하트비트 묶음. 항목 하나가 틀려도 묶음 전체를 400으로 버리지 않도록, 항목 안의 필드는 서비스가 행마다 검사한다
 * (행별 결과 INVALID_FORMAT). 여기서는 묶음 모양(배열, 1~500개, 객체)만 본다.
 */
export class HeartbeatBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_HEARTBEATS_PER_REQUEST)
  @IsObject({ each: true })
  items!: Record<string, unknown>[];
}
```

`apps/api/src/device/heartbeat.service.ts`(새):
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { execOrThrow } from '../redis/redis-exec.js';
import { REDIS } from '../redis/redis.provider.js';
import { normalizeValue, SERIAL_NO_MESSAGE, SERIAL_NO_PATTERN } from '../terminal/bulk-rows.js';
import { deviceKeys } from './device-keys.js';

/** 펌웨어 버전 형식: 영문·숫자·점·하이픈 1~20자 */
export const FIRMWARE_VERSION_PATTERN = /^[0-9A-Za-z.-]{1,20}$/;

export type HeartbeatResultCode = 'OK' | 'IGNORED_NOT_IN_SERVICE' | 'INVALID_FORMAT';

export interface HeartbeatRowResult {
  serialNo: string;
  result: HeartbeatResultCode;
  message?: string;
}

export interface HeartbeatResponse {
  /** OK인 행 수 */
  accepted: number;
  /** 입력과 같은 순서의 행별 결과 */
  results: HeartbeatRowResult[];
}

/**
 * 단말기 하트비트(F8). 상태 전이가 아니다 — TransitionService·이력·Outbox를 거치지 않고, MySQL에도 쓰지 않는다(decisions/0027).
 * 쓰는 곳은 Redis뿐이다: 마지막 시각(ZSET lastSeen, 서버 시계)과 펌웨어 버전(HASH firmware).
 * 운영 중(IN_SERVICE) 단말기의 하트비트만 받는다. 그 판단도 MySQL 대신 Redis HASH active로 한다(decisions/0028).
 * 왕복은 묶음당 2번: ① active 조회 ② lastSeen·firmware 쓰기(pipeline).
 */
@Injectable()
export class HeartbeatService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async receive(items: Record<string, unknown>[], now = Date.now()): Promise<HeartbeatResponse> {
    const rows = items.map((item) => ({ serialNo: normalizeValue(item.serialNo), firmwareVersion: normalizeValue(item.firmwareVersion) }));
    const results: (HeartbeatRowResult | null)[] = rows.map((r) => {
      if (!SERIAL_NO_PATTERN.test(r.serialNo)) return { serialNo: r.serialNo, result: 'INVALID_FORMAT', message: SERIAL_NO_MESSAGE };
      if (!FIRMWARE_VERSION_PATTERN.test(r.firmwareVersion)) {
        return { serialNo: r.serialNo, result: 'INVALID_FORMAT', message: 'firmwareVersion은 영문·숫자·점·하이픈 1~20자입니다.' };
      }
      return null;
    });
    const valid = rows.flatMap((r, i) => (results[i] ? [] : [{ ...r, i }]));
    const keys = deviceKeys();

    const ids = valid.length > 0 ? await this.redis.hmget(keys.active, ...valid.map((r) => r.serialNo)) : [];
    const accepted = valid.filter((r, k) => {
      if (ids[k] !== null) return true;
      results[r.i] = { serialNo: r.serialNo, result: 'IGNORED_NOT_IN_SERVICE', message: '운영 중(IN_SERVICE)인 단말기의 하트비트만 받습니다.' };
      return false;
    });

    if (accepted.length > 0) {
      const write = this.redis.pipeline();
      write.zadd(keys.lastSeen, ...accepted.flatMap((r) => [now, r.serialNo]));
      write.hset(keys.firmware, Object.fromEntries(accepted.map((r) => [r.serialNo, r.firmwareVersion])));
      await execOrThrow(write);
    }
    for (const r of accepted) results[r.i] = { serialNo: r.serialNo, result: 'OK' };
    return { accepted: accepted.length, results: results as HeartbeatRowResult[] };
  }
}
```

`apps/api/src/device/active-set.service.ts`(새):
```ts
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { Redis } from 'ioredis';
import { execOrThrow } from '../redis/redis-exec.js';
import { REDIS } from '../redis/redis.provider.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus } from '../terminal/terminal-status.js';
import { deviceKeys } from './device-keys.js';

/** HSET 한 번에 넣는 필드 수 */
const CHUNK = 1000;

/**
 * 하트비트를 받을 단말기 목록(Redis HASH `hb:active`, serialNo → terminal.id). 원본은 MySQL의 단말기 상태(IN_SERVICE)이고,
 * 이 HASH는 하트비트마다 MySQL을 보지 않으려고 둔 사본이다(decisions/0027·0028).
 */
@Injectable()
export class ActiveSetService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly em: EntityManager,
  ) {}

  /**
   * MySQL의 IN_SERVICE 단말기로 HASH를 통째로 다시 만든다. 임시 키에 다 쓴 뒤 RENAME으로 한 번에 바꾼다 —
   * 만드는 동안 하트비트가 빈 목록을 보지 않는다. 임시 키에는 TTL을 걸어(중간에 죽으면 사라지게) RENAME 직전에 PERSIST한다
   * (RENAME은 원래 키의 TTL을 그대로 가져간다). @returns 단말기 수
   */
  async rebuild(): Promise<number> {
    const rows: { id: number; serialNo: string }[] = await this.em
      .fork()
      .createQueryBuilder(Terminal)
      .select(['id', 'serialNo'])
      .where({ status: TerminalStatus.IN_SERVICE })
      .execute('all');
    const { active } = deviceKeys();
    if (rows.length === 0) {
      await this.redis.del(active);
      return 0;
    }
    const tmp = `${active}:rebuild:${randomUUID()}`;
    const fill = this.redis.pipeline();
    for (let i = 0; i < rows.length; i += CHUNK) {
      fill.hset(tmp, Object.fromEntries(rows.slice(i, i + CHUNK).map((r) => [r.serialNo, String(r.id)])));
    }
    fill.pexpire(tmp, 60_000);
    await execOrThrow(fill);
    await execOrThrow(this.redis.multi().persist(tmp).rename(tmp, active));
    return rows.length;
  }
}
```

`apps/api/src/device/device.controller.ts`(새):
```ts
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { HeartbeatBatchDto } from './dto/heartbeat.dto.js';
import { HeartbeatService } from './heartbeat.service.js';

/**
 * 단말기가 부르는 API. 사람이 아니라 단말기라서 작업자 헤더(X-Operator)를 받지 않는다.
 * 단말기 인증도 이번에는 하지 않는다(가상 프로젝트, decisions/0001과 같은 이유로 미룸). 대신 형식을 검사한다.
 */
@Controller('devices')
export class DeviceController {
  constructor(private readonly heartbeats: HeartbeatService) {}

  /** 하트비트 묶음(1~500개). 항목마다 결과를 돌려준다. 단건은 항목 1개짜리 묶음으로 보낸다. */
  @Post('heartbeats')
  @HttpCode(200)
  async heartbeat(@Body() dto: HeartbeatBatchDto) {
    return this.heartbeats.receive(dto.items);
  }
}
```

`apps/api/src/device/device.module.ts`(새):
```ts
import { Module } from '@nestjs/common';
import { ActiveSetService } from './active-set.service.js';
import { DeviceController } from './device.controller.js';
import { HeartbeatService } from './heartbeat.service.js';

/** 접속 상태(F8): 하트비트, 운영 중 단말기 목록(active). 공용 Redis 연결(RedisModule)은 전역이다. */
@Module({
  controllers: [DeviceController],
  providers: [HeartbeatService, ActiveSetService],
  exports: [HeartbeatService, ActiveSetService],
})
export class DeviceModule {}
```

`apps/api/src/app.module.ts` 전체(`DeviceModule` 추가):
```ts
import { type DynamicModule, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import ormConfig from './mikro-orm.config.js';
import { HealthController } from './health/health.controller.js';
import { DomainExceptionFilter } from './common/domain-exception.filter.js';
import { TerminalModule } from './terminal/terminal.module.js';
import { InspectionModule } from './inspection/inspection.module.js';
import { MerchantModule } from './merchant/merchant.module.js';
import { ShipmentModule } from './shipment/shipment.module.js';
import { QueuesModule } from './queue/queues.module.js';
import { RedisModule } from './redis/redis.module.js';
import { CarrierSyncModule } from './carrier-sync/carrier-sync.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { PurchaseOrderModule } from './purchase-order/purchase-order.module.js';
import { ScanModule } from './scan/scan.module.js';
import { ServiceModule } from './service/service.module.js';
import { DeviceModule } from './device/device.module.js';
import { WorkersModule } from './workers/workers.module.js';
import { SchedulerModule } from './scheduler/scheduler.module.js';

export interface AppOptions {
  /** 큐 job을 처리할지(RUN_WORKERS) */
  workers?: boolean;
  /** 주기 작업을 등록할지(RUN_SCHEDULERS) */
  schedulers?: boolean;
}

@Module({
  // forRoot가 요청마다 EntityManager를 fork하는 RequestContext 미들웨어를 자동 등록한다.
  imports: [
    MikroOrmModule.forRoot(ormConfig),
    RedisModule,
    QueuesModule,
    TerminalModule,
    InspectionModule,
    MerchantModule,
    ShipmentModule,
    CarrierSyncModule,
    OutboxModule,
    PurchaseOrderModule,
    ScanModule,
    ServiceModule,
    DeviceModule,
  ],
  controllers: [HealthController],
  providers: [
    // main.ts의 useGlobalPipes/Filters는 테스트 앱에 적용되지 않는다. 모듈 provider로 등록해 테스트에서도 같게 동작시킨다.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {
  /** 실행 모드에 따라 워커·스케줄러를 붙인다. `imports: [AppModule]`만 쓰면 둘 다 없다(decisions/0015). */
  static forRoot(options: AppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [...(options.workers ? [WorkersModule] : []), ...(options.schedulers ? [SchedulerModule] : [])],
    };
  }
}
```

- [ ] **Step 5: 통과 확인**

Run: `npx vitest run test/heartbeat.e2e.spec.ts && npx vitest run && npm run typecheck`
Expected: 하트비트 `4 passed`. 전체 `Test Files  31 passed (31)`, `Tests  208 passed (208)`, typecheck exit 0.

- [ ] **Step 6: 기록과 커밋**

devlog에 `## HH:MM Task 3 하트비트 API — Redis에만, 행별 결과, active 재구성 (F8)` 항목(확인: 로드 실패 → 4 passed, 31/208, "하트비트 쿼리 0" 테스트, 결정: 0027).

`docs/study/backlog.md`에 추가:
```
- [ ] Redis ZSET(정렬 집합) — ZADD·ZRANGEBYSCORE·ZMSCORE와 점수로 시간 범위 찾기 (device/heartbeat.service.ts, decisions/0027)
- [ ] Redis pipeline과 MULTI의 차이, ioredis exec()가 명령별 오류를 결과 배열로 주는 방식 (redis/redis-exec.ts)
- [ ] RENAME으로 키를 원자적으로 바꾸기와 TTL이 함께 옮겨 가는 점(PERSIST) (device/active-set.service.ts)
```

커밋:
```bash
git add apps/api docs
git commit -m "feat(F8): 하트비트 API(Redis에만 쓰기, 행별 결과)와 운영 중 단말기 목록 재구성" -m "Refs: docs/decisions/0027-하트비트는-상태-전이가-아니다-Redis에만-쓴다.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: active 유지 — Outbox 두 번째 소비자(project job) + 주기 재구성, device 큐 (F8, F5)

**Files:**
- Modify: `apps/api/src/queue/queue-names.ts`, `apps/api/src/config/env.ts`, `apps/api/src/device/active-set.service.ts`, `apps/api/src/outbox/outbox.service.ts`, `apps/api/src/scheduler/job-schedulers.ts`, `apps/api/src/scheduler/scheduler.service.ts`, `apps/api/src/workers/workers.module.ts`, `.env.example`
- Create: `apps/api/src/device/device.processor.ts`
- Test: `apps/api/test/active-set.e2e.spec.ts`(새), `apps/api/test/scheduler.e2e.spec.ts`
- Record: devlog, `docs/decisions/0028-운영-중-단말기-목록은-Outbox-소비자와-주기-재구성으로.md`, `docs/decisions/0015-…`(갱신 한 줄), `docs/study/backlog.md`

- `device` 큐를 새로 둔다(concurrency 1). job: `project`(active 한 대 맞추기), `rebuild-active`(통째로 다시). Task 5·7이 `detect-offline`, `snapshot`, `rollout-control`을 더한다.
- relay(READ COMMITTED, decisions/0016)가 잡은 행 중 `terminal.status_changed`이면서 `toStatus` 또는 `fromStatus`가 IN_SERVICE인 것은 notify와 별도로 `device` 큐에 `project` job(`jobId: project-<outbox id>`, addBulk 한 번)도 넣는다. notify addBulk 뒤에 넣으므로 notify 쪽 부분 실패·멈춤 테스트(Day 3)는 그대로다.
- `ActiveSetService.apply(serials)`: 이벤트의 toStatus를 쓰지 않고 MySQL의 **지금** 상태를 다시 읽어 IN_SERVICE면 HSET, 아니면 HDEL. 순서가 뒤바뀌어 온 옛 이벤트가 결과를 되돌리지 않는다.
- 주기 작업 `active-rebuild`(기본 60초, `ACTIVE_REBUILD_INTERVAL_MS`). 주기 작업 목록에 `every`(주기)를 넣고 `SchedulerService`가 목록을 돌며 등록한다(큐 3개 주입).

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/active-set.e2e.spec.ts`(새, 워커를 켠 앱 — relay → project job이 실제로 처리된다):
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../src/device/active-set.service.js';
import { deviceKeys } from '../src/device/device-keys.js';
import { OutboxService } from '../src/outbox/outbox.service.js';
import { QUEUE } from '../src/queue/queue-names.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { resetQueues, waitForQueuesIdle } from './helpers/queues.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { prepareInService, transitionTo } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('운영 중 단말기 목록(active) 유지 — Outbox 두 번째 소비자 + 주기 재구성 (decisions/0028)', () => {
  let t: TestApp;
  let redis: Redis;
  let outbox: OutboxService;
  const active = () => redis.hgetall(deviceKeys().active);

  /** PENDING을 모두 relay하고, notify·project job이 다 끝날 때까지 기다린다. */
  async function relayAll() {
    while ((await outbox.relay()).queued.length > 0);
    await waitForQueuesIdle(t.app);
  }

  beforeAll(async () => {
    t = await createTestApp({ workers: true });
    redis = t.app.get<Redis>(REDIS);
    outbox = t.app.get(OutboxService);
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    await deleteTestKeys(redis, 'hb:');
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('relay는 IN_SERVICE 진입·이탈 이벤트만 device 큐에 project job으로 넣는다(jobId project-<outbox id>)', async () => {
    await prepareInService(t, 'AC-0001'); // 등록 → … → IN_SERVICE, 이벤트 7개 중 IN_SERVICE 진입 1개
    const deviceQueue = t.app.get<Queue>(getQueueToken(QUEUE.DEVICE));
    const addBulk = vi.spyOn(deviceQueue, 'addBulk');
    try {
      await relayAll();
      const jobs = addBulk.mock.calls.flatMap((c) => c[0]);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ name: 'project', data: { serialNo: 'AC-0001' } });
      expect(jobs[0].opts?.jobId).toMatch(/^project-\d+$/);
    } finally {
      addBulk.mockRestore();
    }
    const id = (await t.orm.em.fork().findOneOrFail(Terminal, { serialNo: 'AC-0001' })).id;
    expect(await active()).toEqual({ 'AC-0001': String(id) });
  });

  it('IN_SERVICE에서 나가면(회수 요청) project job이 active에서 지운다', async () => {
    await transitionTo(t, 'AC-0001', 'RETURN_REQUESTED', 'pickup');
    await relayAll();
    expect(await active()).toEqual({});
  });

  it('project는 이벤트의 상태가 아니라 MySQL의 지금 상태를 본다(늦게 온 옛 이벤트가 결과를 되돌리지 않는다)', async () => {
    await prepareInService(t, 'AC-0002');
    await relayAll();
    await transitionTo(t, 'AC-0002', 'RETURN_REQUESTED', 'pickup');
    // 회수 요청 이벤트가 처리되기 전에 "IN_SERVICE 진입" 이벤트가 한 번 더(늦게) 처리된 상황
    await t.app.get(ActiveSetService).apply(['AC-0002']);
    expect(await redis.hexists(deviceKeys().active, 'AC-0002')).toBe(0);
    await relayAll();
    expect(await redis.hexists(deviceKeys().active, 'AC-0002')).toBe(0);
  });

  it('이벤트를 잃어도(Redis에서 지워져도) 주기 재구성이 MySQL 기준으로 되돌린다', async () => {
    await prepareInService(t, 'AC-0003');
    await relayAll();
    await redis.hdel(deviceKeys().active, 'AC-0003'); // 유실 흉내
    await redis.hset(deviceKeys().active, 'AC-9999', '9999'); // 없는 단말기
    await t.app.get<Queue>(getQueueToken(QUEUE.DEVICE)).add('rebuild-active', {});
    await waitForQueuesIdle(t.app);
    const id = (await t.orm.em.fork().findOneOrFail(Terminal, { serialNo: 'AC-0003' })).id;
    expect(await active()).toEqual({ 'AC-0003': String(id) });
    expect(await t.orm.em.fork().count(Terminal, { status: TerminalStatus.IN_SERVICE })).toBe(1);
  });
});
```

`apps/api/test/scheduler.e2e.spec.ts` 전체(주기 작업 목록을 `JOB_SCHEDULERS`에서 읽어, 뒤 Task에서 작업이 늘어도 고칠 필요가 없게):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUE, type QueueName } from '../src/queue/queue-names.js';
import { clearJobSchedulers, JOB_SCHEDULERS } from '../src/scheduler/job-schedulers.js';
import { SchedulerService } from '../src/scheduler/scheduler.service.js';
import { resetQueues, waitForQueuesIdle } from './helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('주기 작업 삭제 (scheduler:clear, decisions/0015)', () => {
  let t: TestApp;
  const queueOf = (name: QueueName) => t.app.get<Queue>(getQueueToken(name));

  beforeAll(async () => {
    // 워커를 띄워 주기 job이 실제로 처리되게 한다(sweep·relay가 테스트 DB를 읽는다).
    t = await createTestApp({ workers: true });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it('등록된 주기 작업을 지우면 다음 주기 job이 더 생기지 않는다. 다시 지우면 지울 것이 없다', async () => {
    // 테스트 앱에는 스케줄러가 없으므로(schedulers: false) 직접 등록한다. 접두사가 test-라 개발 Redis 키는 건드리지 않는다.
    await new SchedulerService(queueOf(QUEUE.CARRIER_SWEEP), queueOf(QUEUE.OUTBOX), queueOf(QUEUE.DEVICE)).onApplicationBootstrap();
    const queues = [...new Set(JOB_SCHEDULERS.map((s) => s.queue))];
    for (const name of queues) {
      expect(await queueOf(name).getJobSchedulersCount()).toBe(JOB_SCHEDULERS.filter((s) => s.queue === name).length);
    }

    expect(await clearJobSchedulers(queueOf)).toEqual(JOB_SCHEDULERS.map((s) => s.id));
    for (const name of queues) {
      expect(await queueOf(name).getJobSchedulersCount()).toBe(0);
      expect(await queueOf(name).getJobCountByTypes('delayed')).toBe(0);
    }
    // 등록 때 바로 넣어진 첫 job(waiting)은 남아 있을 수 있다. 그것이 처리된 뒤에도 다음 주기 job(delayed)이 생기지 않아야
    // 큐가 빈다. scheduler가 남아 있으면 delayed job이 계속 있어 이 대기가 시간 초과로 실패한다.
    await waitForQueuesIdle(t.app, 5_000);
    expect(await clearJobSchedulers(queueOf)).toEqual([]);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/active-set.e2e.spec.ts test/scheduler.e2e.spec.ts`
Expected: `Tests  4 failed | 1 passed (5)`. 큐 테스트 3개와 scheduler 테스트는 `Error: Nest could not find BullQueue_default element`(아직 없는 `QUEUE.DEVICE`가 undefined), "지금 상태를 본다" 테스트는 `TypeError: t.app.get(...).apply is not a function`. ("IN_SERVICE에서 나가면" 테스트는 active가 처음부터 비어 있어 통과한다.)

- [ ] **Step 3: 구현**

`apps/api/src/queue/queue-names.ts` 전체:
```ts
/** BullMQ 큐 이름. 택배사마다 호출 한도가 달라 추적 큐를 따로 둔다(decisions/0013). */
export const QUEUE = {
  TRACK_BUNGAE: 'track-bungae',
  TRACK_NEURIMBO: 'track-neurimbo',
  CARRIER_SWEEP: 'carrier-sweep',
  OUTBOX: 'outbox',
  /** 접속 상태·펌웨어 배포의 주기 작업과 active 갱신(decisions/0028) */
  DEVICE: 'device',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export const ALL_QUEUES: QueueName[] = Object.values(QUEUE);
```

`apps/api/src/config/env.ts` 전체(`activeRebuildIntervalMs` 추가):
```ts
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 스크립트·테스트는 apps/api에서 실행한다. 저장소 루트의 .env를 읽는다(이미 있는 환경변수는 덮어쓰지 않는다).
const envFile = resolve(process.cwd(), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경변수 ${name}가 없습니다. 저장소 루트 .env를 확인하세요.`);
  return value;
}

function flag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  return value === undefined ? fallback : value === '1' || value === 'true';
}

const isTest = process.env.NODE_ENV === 'test';

export const env = {
  port: Number(process.env.API_PORT ?? 3000),
  mysql: {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: required('MYSQL_USER'),
    password: required('MYSQL_PASSWORD'),
    dbName: isTest ? required('MYSQL_TEST_DATABASE') : required('MYSQL_DATABASE'),
  },
  /** 가상 업체 서버(apps/partners) 주소 */
  partnersUrl: process.env.PARTNERS_URL ?? 'http://127.0.0.1:4010',
  /** 택배사·메신저 호출 타임아웃 */
  partnerTimeoutMs: Number(process.env.PARTNER_TIMEOUT_MS ?? 3000),
  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
  /**
   * BullMQ 키 접두사. 테스트는 파일마다 다른 접두사를 써서 다른 파일의 job을 보지 않는다
   * (vitest는 테스트 파일마다 모듈을 새로 읽으므로 이 값도 파일마다 새로 정해진다).
   */
  queuePrefix: process.env.QUEUE_PREFIX ?? (isTest ? `test-${process.pid}-${Date.now()}` : 'terminal-ops'),
  /** 이 프로세스가 큐 job을 처리할지 */
  runWorkers: flag('RUN_WORKERS', true),
  /** 이 프로세스가 주기 작업(수집 sweep, outbox relay)을 등록할지 */
  runSchedulers: flag('RUN_SCHEDULERS', !isTest),
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? 30_000),
  relayIntervalMs: Number(process.env.RELAY_INTERVAL_MS ?? 2_000),
  /** 운영 중 단말기 목록(Redis active)을 MySQL에서 통째로 다시 만드는 주기(decisions/0028) */
  activeRebuildIntervalMs: Number(process.env.ACTIVE_REBUILD_INTERVAL_MS ?? 60_000),
  /** 우리 쪽 호출 속도 제한(초당). 택배사 한도보다 낮게 둔다. */
  bungaeRatePerSec: Number(process.env.BUNGAE_RATE_PER_SEC ?? 10),
  neurimboRatePerSec: Number(process.env.NEURIMBO_RATE_PER_SEC ?? 5),
  /** 알림을 보낼 톡톡메신저 채널 */
  toktokChannel: process.env.TOKTOK_CHANNEL ?? 'ops',
  /** 박스 스캔 처리 중 잠금(Redis) 유지 시간. 처리가 이보다 길면 잠금이 풀린다(decisions/0020) */
  scanLockTtlMs: Number(process.env.SCAN_LOCK_TTL_MS ?? 30_000),
  /** A/S 교체 단말기 예약(Redis) 유지 시간. 운송장 발급 + 교체 트랜잭션이 이보다 길면 예약이 풀린다(decisions/0026) */
  replacementLockTtlMs: Number(process.env.REPLACEMENT_LOCK_TTL_MS ?? 30_000),
  /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
  workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
};
```

`apps/api/src/device/active-set.service.ts` 전체(`apply` 추가):
```ts
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { Redis } from 'ioredis';
import { execOrThrow } from '../redis/redis-exec.js';
import { REDIS } from '../redis/redis.provider.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus } from '../terminal/terminal-status.js';
import { deviceKeys } from './device-keys.js';

/** HSET 한 번에 넣는 필드 수 */
const CHUNK = 1000;

/**
 * 하트비트를 받을 단말기 목록(Redis HASH `hb:active`, serialNo → terminal.id). 원본은 MySQL의 단말기 상태(IN_SERVICE)이고,
 * 이 HASH는 하트비트마다 MySQL을 보지 않으려고 둔 사본이다(decisions/0027·0028).
 */
@Injectable()
export class ActiveSetService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly em: EntityManager,
  ) {}

  /**
   * MySQL의 IN_SERVICE 단말기로 HASH를 통째로 다시 만든다. 임시 키에 다 쓴 뒤 RENAME으로 한 번에 바꾼다 —
   * 만드는 동안 하트비트가 빈 목록을 보지 않는다. 임시 키에는 TTL을 걸어(중간에 죽으면 사라지게) RENAME 직전에 PERSIST한다
   * (RENAME은 원래 키의 TTL을 그대로 가져간다). @returns 단말기 수
   */
  async rebuild(): Promise<number> {
    const rows: { id: number; serialNo: string }[] = await this.em
      .fork()
      .createQueryBuilder(Terminal)
      .select(['id', 'serialNo'])
      .where({ status: TerminalStatus.IN_SERVICE })
      .execute('all');
    const { active } = deviceKeys();
    if (rows.length === 0) {
      await this.redis.del(active);
      return 0;
    }
    const tmp = `${active}:rebuild:${randomUUID()}`;
    const fill = this.redis.pipeline();
    for (let i = 0; i < rows.length; i += CHUNK) {
      fill.hset(tmp, Object.fromEntries(rows.slice(i, i + CHUNK).map((r) => [r.serialNo, String(r.id)])));
    }
    fill.pexpire(tmp, 60_000);
    await execOrThrow(fill);
    await execOrThrow(this.redis.multi().persist(tmp).rename(tmp, active));
    return rows.length;
  }

  /**
   * 몇 대만 MySQL의 **지금** 상태로 맞춘다(Outbox 이벤트 프로젝터가 부른다). 이벤트에 적힌 상태(toStatus)를 쓰지 않고
   * 다시 읽으므로, 같은 단말기의 이벤트가 늦게·뒤바뀐 순서로 와도 결과는 마지막 커밋 상태다. 없는 시리얼은 지운다.
   */
  async apply(serials: string[]): Promise<void> {
    if (serials.length === 0) return;
    const rows: { id: number; serialNo: string; status: TerminalStatus }[] = await this.em
      .fork()
      .createQueryBuilder(Terminal)
      .select(['id', 'serialNo', 'status'])
      .where({ serialNo: { $in: serials } })
      .execute('all');
    const inService = rows.filter((r) => r.status === TerminalStatus.IN_SERVICE);
    const gone = serials.filter((s) => !inService.some((r) => r.serialNo === s));
    const { active } = deviceKeys();
    const batch = this.redis.pipeline();
    if (inService.length > 0) batch.hset(active, Object.fromEntries(inService.map((r) => [r.serialNo, String(r.id)])));
    if (gone.length > 0) batch.hdel(active, ...gone);
    await execOrThrow(batch);
  }
}
```

`apps/api/src/outbox/outbox.service.ts` 전체(`PROJECT_JOB_OPTIONS`, `changesActiveSet`, device 큐 주입, relay에서 project addBulk):
```ts
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { UnrecoverableError, type JobsOptions, type Queue } from 'bullmq';
import { EntityManager, IsolationLevel, LockMode } from '@mikro-orm/mysql';
import { PartnerPermanentError } from '../common/partner-errors.js';
import { QUEUE } from '../queue/queue-names.js';
import { OUTBOX_TYPE, OutboxEvent, OutboxStatus } from './outbox-event.entity.js';
import { ToktokClient } from './toktok.client.js';

export interface NotifyJobData {
  outboxId: number;
}

export const NOTIFY_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 200 },
  removeOnComplete: true,
  removeOnFail: true,
};

/** active 갱신(project) job 옵션. 실패하면 몇 번 다시 하고, 그래도 안 되면 주기 재구성이 맞춘다(decisions/0028). */
export const PROJECT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 200 },
  removeOnComplete: true,
  removeOnFail: true,
};

export interface ProjectJobData {
  serialNo: string;
}

/** 운영 중 단말기 목록(Redis active)을 바꾸는 이벤트인가: IN_SERVICE로 들어오거나 IN_SERVICE에서 나가는 상태 변경 */
export function changesActiveSet(row: OutboxEvent): boolean {
  if (row.type !== OUTBOX_TYPE.TERMINAL_STATUS_CHANGED) return false;
  const p = row.payload as { fromStatus?: string | null; toStatus?: string };
  return p.toStatus === 'IN_SERVICE' || p.fromStatus === 'IN_SERVICE';
}

/** 메신저가 같은 알림을 한 번으로 볼 수 있게 보내는 키. outbox 행마다 하나 */
export function idempotencyKeyOf(id: number): string {
  return `outbox-${id}`;
}

function textOf(event: OutboxEvent): string {
  const p = event.payload as { serialNo?: string; fromStatus?: string | null; toStatus?: string; actor?: string; reason?: string };
  return `[단말온] ${p.serialNo}: ${p.fromStatus ?? '신규'} → ${p.toStatus} (${p.actor}) ${p.reason}`;
}

/**
 * Outbox(F5).
 * - relay: PENDING 행을 잠그고(다른 relay가 잡은 행은 건너뜀, SKIP LOCKED) notify job을 넣은 뒤 QUEUED로 바꾼다.
 *   READ COMMITTED로 돈다. 기본(REPEATABLE READ)이면 잠금 읽기가 (status, id) 인덱스의 gap까지 잠가
 *   새 PENDING 행 INSERT(= 전이·등록 트랜잭션)를 relay가 커밋할 때까지 막는다(troubleshooting/0007).
 * - notify: 톡톡메신저로 보내고 SENT로 바꾼다. 최종 실패면 FAILED.
 * 보장 수준은 "최소 한 번 + 멱등키"다(decisions/0016).
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly em: EntityManager,
    private readonly toktok: ToktokClient,
    @InjectQueue(QUEUE.OUTBOX) private readonly queue: Queue,
    @InjectQueue(QUEUE.DEVICE) private readonly deviceQueue: Queue,
  ) {}

  /**
   * @param opts.enqueue 'bulk'(기본): 잡은 행을 addBulk 한 번으로 넣는다(Redis 왕복 1번). 'each': 행마다 add(Day 2 방식).
   *   'each'는 실험 0006에서 비교하려고만 남긴다(decisions/0024).
   */
  async relay(limit = 100, opts: { enqueue?: 'bulk' | 'each' } = {}): Promise<{ queued: number[] }> {
    const queued = await this.em.fork().transactional(async (tx) => {
      const rows = await tx.find(
        OutboxEvent,
        { status: OutboxStatus.PENDING },
        { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, limit, orderBy: { id: 'asc' } },
      );
      // jobId가 같으면 BullMQ가 한 번만 받는다(addBulk도 같다). 커밋 전에 죽어 이 행이 다시 relay돼도 job이 남아 있으면 중복으로 들어가지 않는다.
      // addBulk는 MULTI가 아니라 pipeline이라 일부만 넣고 throw할 수 있다 → 이 트랜잭션이 롤백돼 행은 PENDING, 다음 relay가 같은 jobId로 다시 넣는다(decisions/0024).
      const jobs = rows.map((row) => ({
        name: 'notify',
        data: { outboxId: row.id },
        opts: { ...NOTIFY_JOB_OPTIONS, jobId: idempotencyKeyOf(row.id) },
      }));
      if (opts.enqueue === 'each') {
        for (const job of jobs) await this.queue.add(job.name, job.data, job.opts);
      } else if (jobs.length > 0) {
        await this.queue.addBulk(jobs);
      }
      // 두 번째 소비자: IN_SERVICE 진입·이탈 이벤트는 active 갱신 job도 넣는다(decisions/0028). jobId가 행마다 하나라
      // 이 트랜잭션이 롤백돼 다시 relay돼도 한 번만 들어간다(notify와 같은 규칙).
      const projections = rows.filter(changesActiveSet).map((row) => ({
        name: 'project',
        data: { serialNo: (row.payload as { serialNo: string }).serialNo } satisfies ProjectJobData,
        opts: { ...PROJECT_JOB_OPTIONS, jobId: `project-${row.id}` },
      }));
      if (projections.length > 0) await this.deviceQueue.addBulk(projections);
      for (const row of rows) row.status = OutboxStatus.QUEUED;
      return rows.map((r) => r.id);
    }, { isolationLevel: IsolationLevel.READ_COMMITTED });
    return { queued };
  }

  async notify(outboxId: number, { lastAttempt }: { lastAttempt: boolean }): Promise<'SENT' | 'SKIPPED'> {
    const em = this.em.fork();
    const row = await em.findOne(OutboxEvent, outboxId);
    if (!row || row.status === OutboxStatus.SENT || row.status === OutboxStatus.FAILED) return 'SKIPPED';

    row.attempts += 1;
    try {
      await this.toktok.send({ idempotencyKey: idempotencyKeyOf(row.id), text: textOf(row) });
    } catch (error) {
      const permanent = error instanceof PartnerPermanentError;
      row.lastError = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
      if (permanent || lastAttempt) row.status = OutboxStatus.FAILED;
      await em.flush();
      throw permanent ? new UnrecoverableError(row.lastError) : error;
    }
    // 여기서 죽으면(메신저는 받았는데 SENT를 못 씀) job이 다시 실행돼 한 번 더 보낸다 → 멱등키로 메신저가 걸러야 한다.
    row.status = OutboxStatus.SENT;
    row.sentAt = new Date();
    row.lastError = null;
    await em.flush();
    return 'SENT';
  }
}
```

`apps/api/src/device/device.processor.ts`(새):
```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import type { ProjectJobData } from '../outbox/outbox.service.js';
import { QUEUE } from '../queue/queue-names.js';
import { ActiveSetService } from './active-set.service.js';

/**
 * device 큐. concurrency 1: 한 워커 프로세스 안에서는 active 갱신이 한 번에 하나씩 돈다(읽고 쓰는 사이에 다른 갱신이 끼지 않게).
 * 워커 프로세스가 여럿이면 겹칠 수 있고, 그 틈은 주기 재구성이 메운다(decisions/0028).
 */
@Processor(QUEUE.DEVICE, { concurrency: 1 })
export class DeviceProcessor extends WorkerHost {
  constructor(private readonly activeSet: ActiveSetService) {
    super();
  }

  async process(job: Job) {
    switch (job.name) {
      case 'project':
        return this.activeSet.apply([(job.data as ProjectJobData).serialNo]);
      case 'rebuild-active':
        return this.activeSet.rebuild();
      default:
        throw new UnrecoverableError(`모르는 device job: ${job.name}`);
    }
  }
}
```

`apps/api/src/workers/workers.module.ts` 전체:
```ts
import { Module } from '@nestjs/common';
import {
  BungaeTrackProcessor,
  CarrierSweepProcessor,
  NeurimboTrackProcessor,
} from '../carrier-sync/carrier-sync.processors.js';
import { CarrierSyncModule } from '../carrier-sync/carrier-sync.module.js';
import { DeviceModule } from '../device/device.module.js';
import { DeviceProcessor } from '../device/device.processor.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { OutboxProcessor } from '../outbox/outbox.processor.js';

/** 큐 job을 처리하는 프로세서들. RUN_WORKERS=1인 프로세스에만 넣는다(decisions/0015). */
@Module({
  imports: [CarrierSyncModule, OutboxModule, DeviceModule],
  providers: [BungaeTrackProcessor, NeurimboTrackProcessor, CarrierSweepProcessor, OutboxProcessor, DeviceProcessor],
})
export class WorkersModule {}
```

`apps/api/src/scheduler/job-schedulers.ts` 전체:
```ts
import type { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { QUEUE, type QueueName } from '../queue/queue-names.js';

/** 주기 작업 목록. 등록(SchedulerService)과 삭제(scheduler:clear)가 같은 id를 쓴다. every는 등록할 때 읽는 주기(ms)다. */
export const JOB_SCHEDULERS = [
  { queue: QUEUE.CARRIER_SWEEP, id: 'carrier-sweep', jobName: 'sweep', every: () => env.sweepIntervalMs },
  { queue: QUEUE.OUTBOX, id: 'outbox-relay', jobName: 'relay', every: () => env.relayIntervalMs },
  { queue: QUEUE.DEVICE, id: 'active-rebuild', jobName: 'rebuild-active', every: () => env.activeRebuildIntervalMs },
] as const satisfies readonly { queue: QueueName; id: string; jobName: string; every: () => number }[];

/**
 * 주기 작업을 Redis에서 지운다. job scheduler는 등록한 프로세스가 끝나도 Redis에 남아 계속 job을 만든다
 * (Day 2 리뷰 Minor 2, decisions/0015). 다음 주기 job(delayed)도 함께 지워진다.
 * @returns 지운 scheduler id 목록(없던 것은 빠진다)
 */
export async function clearJobSchedulers(queueOf: (name: QueueName) => Queue): Promise<string[]> {
  const removed: string[] = [];
  for (const s of JOB_SCHEDULERS) {
    if (await queueOf(s.queue).removeJobScheduler(s.id)) removed.push(s.id);
  }
  return removed;
}
```

`apps/api/src/scheduler/scheduler.service.ts` 전체:
```ts
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { QUEUE, type QueueName } from '../queue/queue-names.js';
import { JOB_SCHEDULERS } from './job-schedulers.js';

/**
 * 주기 작업 등록. BullMQ job scheduler는 Redis에 한 개만 저장되므로(같은 id면 덮어씀)
 * 이 서비스가 여러 프로세스에서 떠도 주기 작업은 하나다. 지우려면 npm run scheduler:clear (decisions/0015).
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly queues: Partial<Record<QueueName, Queue>>;

  constructor(
    @InjectQueue(QUEUE.CARRIER_SWEEP) sweepQueue: Queue,
    @InjectQueue(QUEUE.OUTBOX) outboxQueue: Queue,
    @InjectQueue(QUEUE.DEVICE) deviceQueue: Queue,
  ) {
    this.queues = { [QUEUE.CARRIER_SWEEP]: sweepQueue, [QUEUE.OUTBOX]: outboxQueue, [QUEUE.DEVICE]: deviceQueue };
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const s of JOB_SCHEDULERS) {
      await this.queues[s.queue]!.upsertJobScheduler(
        s.id,
        { every: s.every() },
        { name: s.jobName, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
      );
    }
    this.logger.log(`주기 작업 등록: ${JOB_SCHEDULERS.map((s) => `${s.id} ${s.every()}ms`).join(', ')}`);
  }
}
```

`.env.example`의 `RELAY_INTERVAL_MS=2000` 다음 줄에 추가:
```
# Day 4 주기 작업(ms) — decisions/0028
ACTIVE_REBUILD_INTERVAL_MS=60000
```

- [ ] **Step 4: 통과 확인**

Run:
```bash
npx vitest run test/active-set.e2e.spec.ts test/scheduler.e2e.spec.ts test/outbox.e2e.spec.ts
npx vitest run && npm run typecheck
```
Expected: 앞 세 파일 15 passed(outbox 9개 그대로). 전체 `Test Files  32 passed (32)`, `Tests  212 passed (212)`, typecheck exit 0.

- [ ] **Step 5: 기록과 커밋**

devlog에 `## HH:MM Task 4 active 유지 — Outbox 두 번째 소비자 + 주기 재구성 (F8, F5)` 항목.

`docs/decisions/0028-운영-중-단말기-목록은-Outbox-소비자와-주기-재구성으로.md`:
- 상황: 하트비트는 운영 중(IN_SERVICE) 단말기만 받는다(회수·폐기된 단말기의 하트비트로 접속 상태가 생기면 안 된다). 하트비트마다 MySQL로 상태를 보면 decisions/0027의 의미가 없다. 그래서 Redis에 사본(active)을 두는데, 사본이 원본(terminal.status)과 어긋나지 않게 맞춰야 한다.
- 자료구조: SET 대신 **HASH(serialNo → terminal.id)** — 스냅샷·판정·실험용 MySQL 쓰기가 terminal_id를 알아야 해서 SET이면 매번 시리얼로 id를 조회해야 한다. 하트비트의 확인은 `HMGET`(없으면 null)로 같다.
- 선택지(맞추기):
  1. 주기 재구성만: 가장 단순. 설치 확인 뒤 최대 재구성 주기(60초) 동안 하트비트가 IGNORED가 된다.
  2. 전이 트랜잭션 안에서 Redis를 바로 고치기: 롤백되면 Redis만 바뀐 채 남고, 커밋 뒤에 고치면 그 사이 죽을 때 잃는다(decisions/0016에서 알림에 대해 본 문제와 같다).
  3. **Outbox 이벤트의 두 번째 소비자 + 주기 재구성**: 커밋된 전이만 relay가 보고, notify처럼 jobId 멱등으로 큐에 넣는다. 빠르게(relay 주기 2초) 맞추고, 재구성이 이벤트 유실·순서 뒤바뀜·워커 여러 개의 겹침을 메운다.
- 결정: 3. project job은 이벤트의 toStatus가 아니라 MySQL의 **지금 상태**를 다시 읽는다 — 같은 단말기의 이벤트가 늦게·뒤바뀐 순서로 처리돼도 결과는 마지막 커밋 상태다(멱등). device 큐는 concurrency 1이라 한 워커 안에서는 읽기와 쓰기 사이에 다른 갱신이 끼지 않는다.
- 왜 둘 다인가: 이벤트만 있으면 Redis 유실(재시작·장애), job 최종 실패, 워커 2개가 같은 단말기를 동시에 처리하는 틈(읽고 쓰는 사이 역전)을 메울 수 없다. 재구성만 있으면 반영이 최대 60초 늦다. 재구성은 임시 키 → PERSIST → RENAME이라 도중에도 하트비트가 빈 목록을 보지 않는다.
- 결과·대가: relay가 Redis 왕복을 한 번 더 한다(IN_SERVICE 진입·이탈 행이 있을 때만). 재구성이 읽은 스냅숏보다 늦게 커밋된 전이가 RENAME에 덮일 수 있고 다음 이벤트·재구성까지 어긋난다(창은 재구성 한 번의 시간). 재구성은 IN_SERVICE 전체를 읽는다(5,000대면 status 인덱스로 한 번).
- 다시 볼 조건: 운영 중 단말기가 수십만이 되어 재구성 한 번이 무거워질 때(증분으로), device 큐의 다른 job(판정·배포)이 길어져 project가 밀릴 때(큐 나누기).

`docs/decisions/0015-실행-모드-워커와-스케줄러.md` 끝에 한 줄:
```
- 갱신(2026-10-23 Day 4): 주기 작업 목록 `JOB_SCHEDULERS`에 주기(`every`)를 넣고, device 큐 작업(active-rebuild, Task 5·7에서 offline-detect·connectivity-snapshot·rollout-control)을 더했다. scheduler:clear는 목록 전체를 지운다.
```

`docs/study/backlog.md`에 추가:
```
- [ ] 이벤트 소비자가 여럿일 때 — 프로젝션(읽기 모델)을 이벤트 값이 아니라 원본을 다시 읽어 만드는 방식, 순서 보장 없이 멱등하게 (outbox.service.ts changesActiveSet, decisions/0028)
- [ ] 이벤트 기반 갱신 + 주기 재구성(anti-entropy)으로 사본 맞추기 (device/active-set.service.ts)
```

커밋:
```bash
git add apps/api docs .env.example
git commit -m "feat(F8): 운영 중 단말기 목록 유지 — Outbox 두 번째 소비자와 주기 재구성" -m "Refs: docs/decisions/0028-운영-중-단말기-목록은-Outbox-소비자와-주기-재구성으로.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: 오프라인 판정·접속 상태 스냅샷·조회 — 바뀐 것만 MySQL, device.offline/online 알림 (F8, F5)

**Files:**
- Create: `apps/api/src/device/device-connectivity.entity.ts`, `apps/api/src/device/connectivity.service.ts`, `apps/api/src/device/connectivity.controller.ts`, `apps/api/src/migrations/Migration<시각>.ts`(생성 명령)
- Modify: `apps/api/src/entities.ts`, `apps/api/src/config/env.ts`, `apps/api/src/outbox/outbox-event.entity.ts`, `apps/api/src/outbox/outbox.service.ts`, `apps/api/src/device/device.module.ts`, `apps/api/src/device/device.processor.ts`, `apps/api/src/scheduler/job-schedulers.ts`, `apps/api/src/migrations/.snapshot-terminal_ops.json`(생성 명령), `.env.example`
- Test: `apps/api/test/connectivity.e2e.spec.ts`(새), `apps/api/test/unit/outbox-text.spec.ts`(새)
- Record: devlog, `docs/decisions/0029-오프라인-판정과-스냅샷은-바뀐-것만-MySQL에.md`, `docs/decisions/0016-…`(갱신 한 줄), `docs/study/backlog.md`

- `DeviceConnectivity`(terminal_id PK, FK 없음, online, last_seen_at datetime(3), firmware_version, changed_at datetime(3)).
- `ConnectivityService.detect(now, 기준)`: Redis 잠금(`job-lock:hb-detect`) 아래에서 오래된 운영 중 단말기 → 오프라인, 오프라인으로 기록된 단말기 중 하트비트가 다시 온 것 → 온라인. **바뀐 것만** 한 트랜잭션에서 `device_connectivity` UPSERT(terminal_id 오름차순, 한 문장) + Outbox `device.offline`/`device.online`. 커밋 뒤 Redis `offline` SET을 맞춘다. 운영 중이 아닌 단말기의 오래된 기록은 알림 없이 지운다.
- `ConnectivityService.snapshot()`: 지난 스냅샷 뒤 lastSeen이 바뀐 단말기만 `last_seen_at`·`firmware_version`을 UPSERT(online은 덮어쓰지 않음, 500행씩).
- UPSERT는 `em.upsertMany`가 아니라 QueryBuilder `insert().onConflict('terminalId').merge([...])`로 한 문장(사전 검증: upsertMany는 같은 행을 다시 SELECT한다).
- `GET /terminals/:serialNo/connectivity` → Redis가 있으면 Redis(online = lastSeen이 기준 안), 없으면 MySQL 스냅샷, 둘 다 없으면 `source: 'none'`, 단말기가 없으면 404.
- 알림 문구 `textOf`를 export하고 type별로 나눈다. 주기 작업 `offline-detect`(10초), `connectivity-snapshot`(60초), 기준 `HEARTBEAT_OFFLINE_AFTER_MS`(90초 = 30초 주기의 3배).

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/connectivity.e2e.spec.ts`(새, 서비스를 `now`를 넘겨 직접 불러 시간을 정한다):
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../src/device/active-set.service.js';
import { ConnectivityService } from '../src/device/connectivity.service.js';
import { DeviceConnectivity } from '../src/device/device-connectivity.entity.js';
import { deviceKeys } from '../src/device/device-keys.js';
import { OutboxEvent } from '../src/outbox/outbox-event.entity.js';
import { RedisLock } from '../src/redis/redis-lock.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { captureQueries } from './helpers/query-log.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { prepareInService } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const AFTER = 90_000; // 오프라인 기준(ms)

describe('접속 상태 — 오프라인 판정·스냅샷·조회 (F8, decisions/0029)', () => {
  let t: TestApp;
  let redis: Redis;
  let conn: ConnectivityService;
  const k = () => deviceKeys();
  const em = () => t.orm.em.fork();
  const idOf = async (serialNo: string) => (await em().findOneOrFail(Terminal, { serialNo })).id;
  const rowOf = async (serialNo: string) => em().findOne(DeviceConnectivity, { terminalId: await idOf(serialNo) });
  const events = (type: string) => em().find(OutboxEvent, { type }, { orderBy: { id: 'asc' } });
  const beat = (serialNo: string, firmwareVersion = '1.0.0') => t.http().post('/devices/heartbeats').send({ items: [{ serialNo, firmwareVersion }] });

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    conn = t.app.get(ConnectivityService);
    await resetDatabase(t.orm);
    for (const s of ['CN-0001', 'CN-0002', 'CN-0003']) await prepareInService(t, s);
    await deleteTestKeys(redis, 'hb:');
    await t.app.get(ActiveSetService).rebuild();
  });
  beforeEach(async () => {
    await redis.del(k().lastSeen, k().firmware, k().offline, k().snapshotAt);
  });
  afterAll(async () => {
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('detect: 기준보다 오래된 운영 중 단말기만 오프라인으로, 바뀐 것만 MySQL(UPSERT)·Outbox(device.offline)에 쓴다', async () => {
    const now = Date.now();
    await redis.zadd(k().lastSeen, now - 120_000, 'CN-0001', now - 1_000, 'CN-0002');
    await redis.hset(k().firmware, { 'CN-0001': '1.0.0', 'CN-0002': '1.0.0' });

    expect(await conn.detect(now, AFTER)).toEqual({ offline: ['CN-0001'], online: [] });
    expect(await rowOf('CN-0001')).toMatchObject({ online: false, lastSeenAt: new Date(now - 120_000), firmwareVersion: '1.0.0', changedAt: new Date(now) });
    expect(await rowOf('CN-0002')).toBeNull();
    const offline = await events('device.offline');
    expect(offline.map((e) => e.payload.serialNo)).toEqual(['CN-0001']);
    expect(await redis.smembers(k().offline)).toEqual(['CN-0001']);

    // 다시 판정해도 이미 오프라인이라 아무것도 쓰지 않는다(쿼리 0)
    const log = captureQueries(t.orm);
    try {
      expect(await conn.detect(now + 1_000, AFTER)).toEqual({ offline: [], online: [] });
    } finally {
      log.stop();
    }
    expect(log.queries).toEqual([]);
    expect(await events('device.offline')).toHaveLength(1);
  });

  it('online 복귀: 오프라인으로 기록된 단말기의 하트비트가 다시 오면 다음 판정에서 온라인, device.online', async () => {
    const now = Date.now();
    await redis.zadd(k().lastSeen, now - 120_000, 'CN-0001');
    await conn.detect(now, AFTER);
    expect(await beat('CN-0001', '1.0.1').then((r) => r.body.accepted)).toBe(1);

    const back = await conn.detect(Date.now(), AFTER);
    expect(back).toEqual({ offline: [], online: ['CN-0001'] });
    expect(await rowOf('CN-0001')).toMatchObject({ online: true, firmwareVersion: '1.0.1' });
    expect((await events('device.online')).at(-1)?.payload.serialNo).toBe('CN-0001');
    expect(await redis.smembers(k().offline)).toEqual([]);
  });

  it('운영 중이 아닌 단말기의 오래된 기록은 알림 없이 지운다', async () => {
    const before = (await events('device.offline')).length;
    await redis.zadd(k().lastSeen, Date.now() - 120_000, 'CN-9999');
    await redis.hset(k().firmware, 'CN-9999', '1.0.0');
    expect(await conn.detect(Date.now(), AFTER)).toEqual({ offline: [], online: [] });
    expect(await redis.zscore(k().lastSeen, 'CN-9999')).toBeNull();
    expect(await redis.hget(k().firmware, 'CN-9999')).toBeNull();
    expect(await events('device.offline')).toHaveLength(before);
  });

  it('detect는 한 번에 하나만 돈다(다른 프로세스가 잠금을 쥐고 있으면 건너뜀)', async () => {
    const lock = t.app.get(RedisLock);
    const key = lock.keyOf('job-lock', 'hb-detect');
    const token = await lock.acquire(key, 5_000);
    try {
      expect(await conn.detect(Date.now(), AFTER)).toEqual({ offline: [], online: [], skipped: true });
    } finally {
      await lock.release(key, token!);
    }
  });

  it('snapshot: 지난 스냅샷 뒤 바뀐 lastSeen만 UPSERT 한 문장으로 쓰고, 이미 있는 행의 online은 건드리지 않는다', async () => {
    await em().nativeDelete(DeviceConnectivity, {});
    const id1 = await idOf('CN-0001');
    await em().insert(DeviceConnectivity, { terminalId: id1, online: false, lastSeenAt: new Date(0), changedAt: new Date(0) });
    await beat('CN-0001', '2.0.0');
    await beat('CN-0002', '1.0.0');

    const log = captureQueries(t.orm);
    let first;
    try {
      first = await conn.snapshot();
    } finally {
      log.stop();
    }
    console.log(`[스냅샷 쿼리] ${JSON.stringify(log.queries.map((q) => q.slice(0, 200)))}`);
    expect(first).toEqual({ written: 2 });
    expect(log.queries.filter((q) => /^insert/i.test(q))).toHaveLength(1);
    expect(log.queries.filter((q) => /^select/i.test(q))).toHaveLength(0);
    const scoreOf = async (s: string) => new Date(Number(await redis.zscore(k().lastSeen, s)));
    expect(await rowOf('CN-0001')).toMatchObject({ online: false, lastSeenAt: await scoreOf('CN-0001'), firmwareVersion: '2.0.0' });
    expect(await rowOf('CN-0002')).toMatchObject({ online: true, lastSeenAt: await scoreOf('CN-0002'), firmwareVersion: '1.0.0' });

    // 그 뒤로 하트비트가 없으면 쓸 것이 없다
    expect(await conn.snapshot()).toEqual({ written: 0 });
    await beat('CN-0003');
    expect(await conn.snapshot()).toEqual({ written: 1 });
  });

  it('GET /terminals/:serialNo/connectivity — Redis가 있으면 Redis, 없으면 MySQL 스냅샷, 둘 다 없으면 none, 없는 단말기 404', async () => {
    await beat('CN-0002', '1.2.3');
    const live = await t.http().get('/terminals/CN-0002/connectivity');
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ serialNo: 'CN-0002', source: 'redis', online: true, firmwareVersion: '1.2.3' });

    await em().nativeDelete(DeviceConnectivity, {});
    await em().insert(DeviceConnectivity, {
      terminalId: await idOf('CN-0003'),
      online: false,
      lastSeenAt: new Date('2026-10-23T00:00:00.123Z'),
      firmwareVersion: '0.9.0',
      changedAt: new Date('2026-10-23T00:01:00Z'),
    });
    expect((await t.http().get('/terminals/CN-0003/connectivity')).body).toEqual({
      serialNo: 'CN-0003',
      source: 'snapshot',
      online: false,
      lastSeenAt: '2026-10-23T00:00:00.123Z',
      firmwareVersion: '0.9.0',
    });
    expect((await t.http().get('/terminals/CN-0001/connectivity')).body).toMatchObject({ source: 'none', online: false, lastSeenAt: null });
    expect((await t.http().get('/terminals/NONE-0001/connectivity')).status).toBe(404);
  });
});
```

`apps/api/test/unit/outbox-text.spec.ts`(새):
```ts
import { describe, expect, it } from 'vitest';
import { textOf } from '../../src/outbox/outbox.service.js';

describe('알림 문구(textOf)', () => {
  it('상태 변경은 이전 → 다음 (작업자) 사유', () => {
    const text = textOf({
      type: 'terminal.status_changed',
      payload: { serialNo: 'A-0001', fromStatus: null, toStatus: 'RECEIVED', actor: 'kim', reason: '신규 등록' },
    });
    expect(text).toBe('[단말온] A-0001: 신규 → RECEIVED (kim) 신규 등록');
  });

  it('접속 상태는 오프라인·온라인 복귀와 마지막 하트비트 시각', () => {
    expect(textOf({ type: 'device.offline', payload: { serialNo: 'A-0001', lastSeenAt: '2026-10-23T00:00:00.000Z' } })).toBe(
      '[단말온] A-0001: 오프라인 (마지막 하트비트 2026-10-23T00:00:00.000Z)',
    );
    expect(textOf({ type: 'device.online', payload: { serialNo: 'A-0001', lastSeenAt: '2026-10-23T00:05:00.000Z' } })).toBe(
      '[단말온] A-0001: 온라인 복귀 (하트비트 2026-10-23T00:05:00.000Z)',
    );
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/connectivity.e2e.spec.ts test/unit/outbox-text.spec.ts`
Expected: `Test Files  2 failed (2)`. connectivity는 `../src/device/connectivity.service.js`·`device-connectivity.entity.js`를 찾지 못해 파일 로드 실패, outbox-text는 `TypeError: textOf is not a function`(아직 export하지 않음) 2건.

- [ ] **Step 3: 구현**

`apps/api/src/device/device-connectivity.entity.ts`(새):
```ts
import { OptionalProps } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * 단말기 접속 상태의 MySQL 스냅샷(F8). 원본(최신값)은 Redis(lastSeen·firmware)이고, 이 표는
 * ① 온라인↔오프라인이 바뀐 순간(오프라인 판정 job)과 ② 주기 스냅샷 job이 한꺼번에 쓴다. 하트비트마다 쓰지 않는다(decisions/0027·0029).
 * 상태 전이가 아니므로 terminal.status·이력과 무관하다.
 * terminal_id에 외래키를 두지 않는다 — 수천 행을 한 번에 UPSERT할 때 단말기 행마다 FK 검사 S 락을 걸지 않게(Outbox와 같은 이유).
 */
@Entity({ tableName: 'device_connectivity' })
export class DeviceConnectivity {
  [OptionalProps]?: 'firmwareVersion';

  /** terminal.id */
  @PrimaryKey({ autoincrement: false })
  terminalId!: number;

  @Property()
  online!: boolean;

  /** 마지막 하트비트(서버 시계, 밀리초까지) */
  @Property({ type: 'datetime', length: 3 })
  lastSeenAt!: Date;

  @Property({ type: 'varchar', length: 20, nullable: true })
  firmwareVersion: string | null = null;

  /** online 값이 마지막으로 바뀐 시각(오프라인 판정 job이 쓴다) */
  @Property({ type: 'datetime', length: 3 })
  changedAt!: Date;
}
```

`apps/api/src/entities.ts` 전체:
```ts
import { TerminalModel } from './terminal/terminal-model.entity.js';
import { Terminal } from './terminal/terminal.entity.js';
import { TerminalStatusHistory } from './terminal/terminal-status-history.entity.js';
import { InspectionItem } from './inspection/inspection-item.entity.js';
import { Inspection, InspectionResult } from './inspection/inspection.entities.js';
import { Merchant } from './merchant/merchant.entity.js';
import { CarrierEvent, Shipment, SyncRun } from './shipment/shipment.entities.js';
import { OutboxEvent } from './outbox/outbox-event.entity.js';
import { PurchaseOrder } from './purchase-order/purchase-order.entity.js';
import { ScanBatch } from './scan/scan-batch.entity.js';
import { ServiceTicket } from './service/service-ticket.entity.js';
import { DeviceConnectivity } from './device/device-connectivity.entity.js';

/** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch, ServiceTicket, DeviceConnectivity];
```

`apps/api/src/config/env.ts` 전체(`hbOfflineAfterMs`, `offlineDetectIntervalMs`, `connectivitySnapshotIntervalMs`):
```ts
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 스크립트·테스트는 apps/api에서 실행한다. 저장소 루트의 .env를 읽는다(이미 있는 환경변수는 덮어쓰지 않는다).
const envFile = resolve(process.cwd(), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경변수 ${name}가 없습니다. 저장소 루트 .env를 확인하세요.`);
  return value;
}

function flag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  return value === undefined ? fallback : value === '1' || value === 'true';
}

const isTest = process.env.NODE_ENV === 'test';

export const env = {
  port: Number(process.env.API_PORT ?? 3000),
  mysql: {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: required('MYSQL_USER'),
    password: required('MYSQL_PASSWORD'),
    dbName: isTest ? required('MYSQL_TEST_DATABASE') : required('MYSQL_DATABASE'),
  },
  /** 가상 업체 서버(apps/partners) 주소 */
  partnersUrl: process.env.PARTNERS_URL ?? 'http://127.0.0.1:4010',
  /** 택배사·메신저 호출 타임아웃 */
  partnerTimeoutMs: Number(process.env.PARTNER_TIMEOUT_MS ?? 3000),
  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
  /**
   * BullMQ 키 접두사. 테스트는 파일마다 다른 접두사를 써서 다른 파일의 job을 보지 않는다
   * (vitest는 테스트 파일마다 모듈을 새로 읽으므로 이 값도 파일마다 새로 정해진다).
   */
  queuePrefix: process.env.QUEUE_PREFIX ?? (isTest ? `test-${process.pid}-${Date.now()}` : 'terminal-ops'),
  /** 이 프로세스가 큐 job을 처리할지 */
  runWorkers: flag('RUN_WORKERS', true),
  /** 이 프로세스가 주기 작업(수집 sweep, outbox relay)을 등록할지 */
  runSchedulers: flag('RUN_SCHEDULERS', !isTest),
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? 30_000),
  relayIntervalMs: Number(process.env.RELAY_INTERVAL_MS ?? 2_000),
  /** 운영 중 단말기 목록(Redis active)을 MySQL에서 통째로 다시 만드는 주기(decisions/0028) */
  activeRebuildIntervalMs: Number(process.env.ACTIVE_REBUILD_INTERVAL_MS ?? 60_000),
  /** 마지막 하트비트가 이보다 오래되면 오프라인으로 본다(단말기 하트비트 주기 30초의 3배, decisions/0029) */
  hbOfflineAfterMs: Number(process.env.HEARTBEAT_OFFLINE_AFTER_MS ?? 90_000),
  /** 오프라인 판정 주기 */
  offlineDetectIntervalMs: Number(process.env.OFFLINE_DETECT_INTERVAL_MS ?? 10_000),
  /** 접속 상태 스냅샷(Redis → MySQL) 주기 */
  connectivitySnapshotIntervalMs: Number(process.env.CONNECTIVITY_SNAPSHOT_INTERVAL_MS ?? 60_000),
  /** 우리 쪽 호출 속도 제한(초당). 택배사 한도보다 낮게 둔다. */
  bungaeRatePerSec: Number(process.env.BUNGAE_RATE_PER_SEC ?? 10),
  neurimboRatePerSec: Number(process.env.NEURIMBO_RATE_PER_SEC ?? 5),
  /** 알림을 보낼 톡톡메신저 채널 */
  toktokChannel: process.env.TOKTOK_CHANNEL ?? 'ops',
  /** 박스 스캔 처리 중 잠금(Redis) 유지 시간. 처리가 이보다 길면 잠금이 풀린다(decisions/0020) */
  scanLockTtlMs: Number(process.env.SCAN_LOCK_TTL_MS ?? 30_000),
  /** A/S 교체 단말기 예약(Redis) 유지 시간. 운송장 발급 + 교체 트랜잭션이 이보다 길면 예약이 풀린다(decisions/0026) */
  replacementLockTtlMs: Number(process.env.REPLACEMENT_LOCK_TTL_MS ?? 30_000),
  /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
  workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
};
```

`apps/api/src/outbox/outbox-event.entity.ts` 전체(`OUTBOX_TYPE`에 device.offline·device.online):
```ts
import { OptionalProps } from '@mikro-orm/core';
import { Entity, Enum, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

export enum OutboxStatus {
  PENDING = 'PENDING', // 기록됨, 아직 큐에 안 넣음
  QUEUED = 'QUEUED', // 알림 job을 큐에 넣음
  SENT = 'SENT', // 메신저가 200을 줌
  FAILED = 'FAILED', // 재시도를 다 써도 실패
}

export const OUTBOX_TYPE = {
  TERMINAL_STATUS_CHANGED: 'terminal.status_changed',
  /** 접속 상태(F8). 상태 전이가 아니라 별도 type이다(decisions/0029) */
  DEVICE_OFFLINE: 'device.offline',
  DEVICE_ONLINE: 'device.online',
} as const;

/**
 * 보낼 알림. 상태 변경과 같은 트랜잭션에서 기록하고(유실 없음), relay가 나중에 큐로 옮긴다(decisions/0016).
 * 외래키를 두지 않는다 — 부모 행 락을 잡지 않고, 단말기를 지워도 알림 기록은 남게 하기 위해서다.
 */
@Entity({ tableName: 'outbox_event' })
@Index({ properties: ['status', 'id'] })
export class OutboxEvent {
  [OptionalProps]?: 'status' | 'attempts' | 'createdAt';

  @PrimaryKey()
  id!: number;

  @Property({ length: 50 })
  type!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Enum({ items: () => OutboxStatus })
  status: OutboxStatus = OutboxStatus.PENDING;

  /** 전송 시도 횟수 */
  @Property()
  attempts: number = 0;

  @Property({ length: 500, nullable: true })
  lastError?: string | null;

  @Property()
  createdAt: Date = new Date();

  // 유니온 타입(Date | null)은 데코레이터 메타데이터가 Object라 type을 꼭 적는다(varchar(255)가 되는 것을 막는다).
  @Property({ type: 'datetime', nullable: true })
  sentAt?: Date | null;
}
```

`apps/api/src/outbox/outbox.service.ts` 전체(`textOf` export, type별 문구):
```ts
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { UnrecoverableError, type JobsOptions, type Queue } from 'bullmq';
import { EntityManager, IsolationLevel, LockMode } from '@mikro-orm/mysql';
import { PartnerPermanentError } from '../common/partner-errors.js';
import { QUEUE } from '../queue/queue-names.js';
import { OUTBOX_TYPE, OutboxEvent, OutboxStatus } from './outbox-event.entity.js';
import { ToktokClient } from './toktok.client.js';

export interface NotifyJobData {
  outboxId: number;
}

export const NOTIFY_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 200 },
  removeOnComplete: true,
  removeOnFail: true,
};

/** active 갱신(project) job 옵션. 실패하면 몇 번 다시 하고, 그래도 안 되면 주기 재구성이 맞춘다(decisions/0028). */
export const PROJECT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 200 },
  removeOnComplete: true,
  removeOnFail: true,
};

export interface ProjectJobData {
  serialNo: string;
}

/** 운영 중 단말기 목록(Redis active)을 바꾸는 이벤트인가: IN_SERVICE로 들어오거나 IN_SERVICE에서 나가는 상태 변경 */
export function changesActiveSet(row: OutboxEvent): boolean {
  if (row.type !== OUTBOX_TYPE.TERMINAL_STATUS_CHANGED) return false;
  const p = row.payload as { fromStatus?: string | null; toStatus?: string };
  return p.toStatus === 'IN_SERVICE' || p.fromStatus === 'IN_SERVICE';
}

/** 메신저가 같은 알림을 한 번으로 볼 수 있게 보내는 키. outbox 행마다 하나 */
export function idempotencyKeyOf(id: number): string {
  return `outbox-${id}`;
}

/** 알림 문구. type마다 다르다(decisions/0016 "다시 볼 조건"). */
export function textOf(event: Pick<OutboxEvent, 'type' | 'payload'>): string {
  const p = event.payload as {
    serialNo?: string;
    fromStatus?: string | null;
    toStatus?: string;
    actor?: string;
    reason?: string;
    lastSeenAt?: string;
  };
  if (event.type === OUTBOX_TYPE.DEVICE_OFFLINE) return `[단말온] ${p.serialNo}: 오프라인 (마지막 하트비트 ${p.lastSeenAt})`;
  if (event.type === OUTBOX_TYPE.DEVICE_ONLINE) return `[단말온] ${p.serialNo}: 온라인 복귀 (하트비트 ${p.lastSeenAt})`;
  return `[단말온] ${p.serialNo}: ${p.fromStatus ?? '신규'} → ${p.toStatus} (${p.actor}) ${p.reason}`;
}

/**
 * Outbox(F5).
 * - relay: PENDING 행을 잠그고(다른 relay가 잡은 행은 건너뜀, SKIP LOCKED) notify job을 넣은 뒤 QUEUED로 바꾼다.
 *   READ COMMITTED로 돈다. 기본(REPEATABLE READ)이면 잠금 읽기가 (status, id) 인덱스의 gap까지 잠가
 *   새 PENDING 행 INSERT(= 전이·등록 트랜잭션)를 relay가 커밋할 때까지 막는다(troubleshooting/0007).
 * - notify: 톡톡메신저로 보내고 SENT로 바꾼다. 최종 실패면 FAILED.
 * 보장 수준은 "최소 한 번 + 멱등키"다(decisions/0016).
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly em: EntityManager,
    private readonly toktok: ToktokClient,
    @InjectQueue(QUEUE.OUTBOX) private readonly queue: Queue,
    @InjectQueue(QUEUE.DEVICE) private readonly deviceQueue: Queue,
  ) {}

  /**
   * @param opts.enqueue 'bulk'(기본): 잡은 행을 addBulk 한 번으로 넣는다(Redis 왕복 1번). 'each': 행마다 add(Day 2 방식).
   *   'each'는 실험 0006에서 비교하려고만 남긴다(decisions/0024).
   */
  async relay(limit = 100, opts: { enqueue?: 'bulk' | 'each' } = {}): Promise<{ queued: number[] }> {
    const queued = await this.em.fork().transactional(async (tx) => {
      const rows = await tx.find(
        OutboxEvent,
        { status: OutboxStatus.PENDING },
        { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, limit, orderBy: { id: 'asc' } },
      );
      // jobId가 같으면 BullMQ가 한 번만 받는다(addBulk도 같다). 커밋 전에 죽어 이 행이 다시 relay돼도 job이 남아 있으면 중복으로 들어가지 않는다.
      // addBulk는 MULTI가 아니라 pipeline이라 일부만 넣고 throw할 수 있다 → 이 트랜잭션이 롤백돼 행은 PENDING, 다음 relay가 같은 jobId로 다시 넣는다(decisions/0024).
      const jobs = rows.map((row) => ({
        name: 'notify',
        data: { outboxId: row.id },
        opts: { ...NOTIFY_JOB_OPTIONS, jobId: idempotencyKeyOf(row.id) },
      }));
      if (opts.enqueue === 'each') {
        for (const job of jobs) await this.queue.add(job.name, job.data, job.opts);
      } else if (jobs.length > 0) {
        await this.queue.addBulk(jobs);
      }
      // 두 번째 소비자: IN_SERVICE 진입·이탈 이벤트는 active 갱신 job도 넣는다(decisions/0028). jobId가 행마다 하나라
      // 이 트랜잭션이 롤백돼 다시 relay돼도 한 번만 들어간다(notify와 같은 규칙).
      const projections = rows.filter(changesActiveSet).map((row) => ({
        name: 'project',
        data: { serialNo: (row.payload as { serialNo: string }).serialNo } satisfies ProjectJobData,
        opts: { ...PROJECT_JOB_OPTIONS, jobId: `project-${row.id}` },
      }));
      if (projections.length > 0) await this.deviceQueue.addBulk(projections);
      for (const row of rows) row.status = OutboxStatus.QUEUED;
      return rows.map((r) => r.id);
    }, { isolationLevel: IsolationLevel.READ_COMMITTED });
    return { queued };
  }

  async notify(outboxId: number, { lastAttempt }: { lastAttempt: boolean }): Promise<'SENT' | 'SKIPPED'> {
    const em = this.em.fork();
    const row = await em.findOne(OutboxEvent, outboxId);
    if (!row || row.status === OutboxStatus.SENT || row.status === OutboxStatus.FAILED) return 'SKIPPED';

    row.attempts += 1;
    try {
      await this.toktok.send({ idempotencyKey: idempotencyKeyOf(row.id), text: textOf(row) });
    } catch (error) {
      const permanent = error instanceof PartnerPermanentError;
      row.lastError = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
      if (permanent || lastAttempt) row.status = OutboxStatus.FAILED;
      await em.flush();
      throw permanent ? new UnrecoverableError(row.lastError) : error;
    }
    // 여기서 죽으면(메신저는 받았는데 SENT를 못 씀) job이 다시 실행돼 한 번 더 보낸다 → 멱등키로 메신저가 걸러야 한다.
    row.status = OutboxStatus.SENT;
    row.sentAt = new Date();
    row.lastError = null;
    await em.flush();
    return 'SENT';
  }
}
```

`apps/api/src/device/connectivity.service.ts`(새):
```ts
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { OUTBOX_TYPE, OutboxEvent } from '../outbox/outbox-event.entity.js';
import { execOrThrow } from '../redis/redis-exec.js';
import { RedisLock } from '../redis/redis-lock.js';
import { REDIS } from '../redis/redis.provider.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { DeviceConnectivity } from './device-connectivity.entity.js';
import { deviceKeys } from './device-keys.js';

/** 주기 작업 잠금 유지 시간. 작업 하나가 이보다 오래 걸리면 다음 작업이 겹칠 수 있다 */
const JOB_LOCK_TTL_MS = 30_000;

export interface DetectResult {
  /** 이번에 오프라인이 된 단말기 */
  offline: string[];
  /** 이번에 온라인으로 돌아온 단말기 */
  online: string[];
  /** 다른 프로세스가 판정 중이라 건너뜀 */
  skipped?: boolean;
}

export interface ConnectivityView {
  serialNo: string;
  /** redis: 하트비트 최신값, snapshot: MySQL 스냅샷, none: 기록 없음 */
  source: 'redis' | 'snapshot' | 'none';
  online: boolean;
  lastSeenAt: string | null;
  firmwareVersion: string | null;
}

export type ConnectivityRow = Pick<DeviceConnectivity, 'terminalId' | 'online' | 'lastSeenAt' | 'firmwareVersion' | 'changedAt'>;

/** UPSERT 한 문장에 담는 행 수 */
const UPSERT_CHUNK = 500;

/**
 * device_connectivity UPSERT(`insert … on duplicate key update`). 행은 terminal_id 오름차순으로 넘긴다(여러 행 잠금 순서).
 * em.upsertMany를 쓰지 않는 이유: MikroORM 7.2.5는 MySQL에서 UPSERT 뒤에 관리 엔티티를 만들려고 같은 행을
 * `select … where terminal_id = ? or …`로 다시 읽는다(사전 검증, decisions/0029). 여기서는 엔티티가 필요 없어 QueryBuilder로 한 문장만 보낸다.
 * @param merge 이미 있는 행에서 덮어쓸 필드
 */
export async function upsertConnectivity(tx: EntityManager, rows: ConnectivityRow[], merge: (keyof ConnectivityRow)[]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    await tx.createQueryBuilder(DeviceConnectivity).insert(rows.slice(i, i + UPSERT_CHUNK)).onConflict('terminalId').merge(merge).execute();
  }
}

/** [멤버, 점수, 멤버, 점수 …] → [[멤버, 점수]] */
function pairs(flat: string[]): [string, number][] {
  const out: [string, number][] = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], Number(flat[i + 1])]);
  return out;
}

/**
 * 접속 상태 판정과 스냅샷(F8, decisions/0029).
 * - detect: lastSeen이 기준(HEARTBEAT_OFFLINE_AFTER_MS)보다 오래된 운영 중 단말기를 오프라인으로, 오프라인으로 기록된 단말기 중
 *   하트비트가 다시 온 것을 온라인으로 바꾼다. **바뀐 것만** MySQL(device_connectivity UPSERT + Outbox 알림)에 쓴다.
 * - snapshot: 지난 스냅샷 뒤 lastSeen이 바뀐 단말기의 lastSeen·펌웨어를 MySQL에 한꺼번에 쓴다.
 * 둘 다 Redis 잠금으로 프로세스가 여럿이어도 한 번에 하나만 돈다. MySQL 쓰기는 terminal_id 오름차순(여러 행 잠금 순서).
 */
@Injectable()
export class ConnectivityService {
  private readonly logger = new Logger(ConnectivityService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly lock: RedisLock,
    private readonly em: EntityManager,
  ) {}

  async detect(now = Date.now(), offlineAfterMs = env.hbOfflineAfterMs): Promise<DetectResult> {
    const result = await this.exclusive('hb-detect', () => this.detectLocked(now, offlineAfterMs));
    return result ?? { offline: [], online: [], skipped: true };
  }

  async snapshot(): Promise<{ written: number; skipped?: boolean }> {
    const result = await this.exclusive('hb-snapshot', () => this.snapshotLocked());
    return result ?? { written: 0, skipped: true };
  }

  /** 접속 상태 조회: Redis(최신값)가 있으면 그것, 없으면 MySQL 스냅샷 */
  async get(serialNo: string, now = Date.now()): Promise<ConnectivityView> {
    const em = this.em.fork();
    const terminal = await em.findOne(Terminal, { serialNo });
    if (!terminal) throw new NotFoundException(`단말기 ${serialNo}이(가) 없습니다.`);
    const k = deviceKeys();
    const [score, firmware] = (await execOrThrow(this.redis.pipeline().zscore(k.lastSeen, serialNo).hget(k.firmware, serialNo))) as [
      string | null,
      string | null,
    ];
    if (score !== null) {
      const lastSeen = Number(score);
      return {
        serialNo,
        source: 'redis',
        online: lastSeen > now - env.hbOfflineAfterMs,
        lastSeenAt: new Date(lastSeen).toISOString(),
        firmwareVersion: firmware,
      };
    }
    const row = await em.findOne(DeviceConnectivity, { terminalId: terminal.id });
    if (row) {
      return { serialNo, source: 'snapshot', online: row.online, lastSeenAt: row.lastSeenAt.toISOString(), firmwareVersion: row.firmwareVersion };
    }
    return { serialNo, source: 'none', online: false, lastSeenAt: null, firmwareVersion: null };
  }

  private async detectLocked(now: number, offlineAfterMs: number): Promise<DetectResult> {
    const k = deviceKeys();
    const cutoff = now - offlineAfterMs;
    const stale = pairs(await this.redis.zrangebyscore(k.lastSeen, '-inf', cutoff, 'WITHSCORES'));
    const recorded = await this.redis.smembers(k.offline);
    if (stale.length === 0 && recorded.length === 0) return { offline: [], online: [] };

    const look = this.redis.pipeline();
    if (stale.length > 0) {
      look.hmget(k.active, ...stale.map(([s]) => s));
      look.smismember(k.offline, ...stale.map(([s]) => s));
    }
    if (recorded.length > 0) {
      look.hmget(k.active, ...recorded);
      look.zmscore(k.lastSeen, ...recorded);
    }
    const all = [...new Set([...stale.map(([s]) => s), ...recorded])];
    look.hmget(k.firmware, ...all);
    const values = await execOrThrow(look);
    let at = 0;
    const [staleIds, staleRecorded] = stale.length > 0 ? [values[at++] as (string | null)[], values[at++] as number[]] : [[], []];
    const [recordedIds, recordedScores] =
      recorded.length > 0 ? [values[at++] as (string | null)[], values[at++] as (string | null)[]] : [[], []];
    const firmwareOf = new Map(all.map((s, i) => [s, (values[at] as (string | null)[])[i]]));

    type Change = { serialNo: string; terminalId: number; lastSeen: number; online: boolean };
    const changes: Change[] = [];
    const notActive: string[] = [];
    stale.forEach(([serialNo, lastSeen], i) => {
      if (staleIds[i] === null) notActive.push(serialNo);
      else if (!staleRecorded[i]) changes.push({ serialNo, terminalId: Number(staleIds[i]), lastSeen, online: false });
    });
    const dropped: string[] = [];
    recorded.forEach((serialNo, i) => {
      const score = recordedScores[i];
      if (recordedIds[i] === null) dropped.push(serialNo);
      else if (score !== null && Number(score) > cutoff) {
        changes.push({ serialNo, terminalId: Number(recordedIds[i]), lastSeen: Number(score), online: true });
      }
    });

    if (changes.length > 0) {
      changes.sort((a, b) => a.terminalId - b.terminalId);
      const changedAt = new Date(now);
      await this.em.fork().transactional(async (tx) => {
        await upsertConnectivity(
          tx,
          changes.map((c) => ({
            terminalId: c.terminalId,
            online: c.online,
            lastSeenAt: new Date(c.lastSeen),
            firmwareVersion: firmwareOf.get(c.serialNo) ?? null,
            changedAt,
          })),
          ['online', 'lastSeenAt', 'firmwareVersion', 'changedAt'],
        );
        for (const c of changes) {
          tx.create(OutboxEvent, {
            type: c.online ? OUTBOX_TYPE.DEVICE_ONLINE : OUTBOX_TYPE.DEVICE_OFFLINE,
            payload: { serialNo: c.serialNo, lastSeenAt: new Date(c.lastSeen).toISOString(), detectedAt: changedAt.toISOString() },
          });
        }
      });
    }

    // MySQL이 커밋된 뒤 Redis 기록을 맞춘다. 여기서 죽으면 다음 판정이 같은 변화를 다시 쓴다(알림 중복 가능, 최소 한 번).
    const offline = changes.filter((c) => !c.online).map((c) => c.serialNo);
    const online = changes.filter((c) => c.online).map((c) => c.serialNo);
    const after = this.redis.pipeline();
    if (offline.length > 0) after.sadd(k.offline, ...offline);
    if (online.length + dropped.length > 0) after.srem(k.offline, ...online, ...dropped);
    // 운영 중이 아닌 단말기의 오래된 기록은 알림 없이 지운다(회수·폐기된 단말기)
    if (notActive.length > 0) after.zrem(k.lastSeen, ...notActive).hdel(k.firmware, ...notActive);
    if (after.length > 0) await execOrThrow(after);
    if (changes.length > 0) this.logger.log(`접속 상태 변화: 오프라인 ${offline.length}, 온라인 ${online.length}`);
    return { offline, online };
  }

  private async snapshotLocked(): Promise<{ written: number }> {
    const k = deviceKeys();
    const from = Number((await this.redis.get(k.snapshotAt)) ?? 0);
    const changed = pairs(await this.redis.zrangebyscore(k.lastSeen, `(${from}`, '+inf', 'WITHSCORES'));
    if (changed.length === 0) return { written: 0 };
    const serials = changed.map(([s]) => s);
    const [ids, firmware] = (await execOrThrow(this.redis.pipeline().hmget(k.active, ...serials).hmget(k.firmware, ...serials))) as (
      | string
      | null
    )[][];
    const now = Date.now();
    const rows = changed
      .map(([, lastSeen], i) => ({ id: ids[i], lastSeen, firmware: firmware[i] }))
      .filter((r): r is { id: string; lastSeen: number; firmware: string | null } => r.id !== null)
      .map((r) => ({
        terminalId: Number(r.id),
        // 처음 쓰는 행만 이 값이 들어간다. 이미 있는 행의 online은 판정 job만 바꾼다(merge 대상에서 뺐다).
        online: r.lastSeen > now - env.hbOfflineAfterMs,
        lastSeenAt: new Date(r.lastSeen),
        firmwareVersion: r.firmware,
        changedAt: new Date(now),
      }))
      .sort((a, b) => a.terminalId - b.terminalId);
    if (rows.length > 0) {
      await this.em.fork().transactional((tx) => upsertConnectivity(tx, rows, ['lastSeenAt', 'firmwareVersion']));
    }
    await this.redis.set(k.snapshotAt, String(Math.max(...changed.map(([, s]) => s))));
    return { written: rows.length };
  }

  /** Redis 잠금을 잡고 fn을 돌린다. 이미 누가 돌리고 있으면 null */
  private async exclusive<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    const key = this.lock.keyOf('job-lock', name);
    const token = await this.lock.acquire(key, JOB_LOCK_TTL_MS);
    if (!token) return null;
    try {
      return await fn();
    } finally {
      await this.lock.release(key, token).catch((error: unknown) => this.logger.warn(`잠금 해제 실패 ${name}: ${String(error)}`));
    }
  }
}
```

`apps/api/src/device/connectivity.controller.ts`(새):
```ts
import { Controller, Get, Param } from '@nestjs/common';
import { ConnectivityService } from './connectivity.service.js';

@Controller('terminals')
export class ConnectivityController {
  constructor(private readonly connectivity: ConnectivityService) {}

  /** 접속 상태: Redis(최신 하트비트)가 있으면 그것, 없으면 MySQL 스냅샷(decisions/0029) */
  @Get(':serialNo/connectivity')
  async get(@Param('serialNo') serialNo: string) {
    return this.connectivity.get(serialNo);
  }
}
```

`apps/api/src/device/device.module.ts` 전체:
```ts
import { Module } from '@nestjs/common';
import { ActiveSetService } from './active-set.service.js';
import { ConnectivityController } from './connectivity.controller.js';
import { ConnectivityService } from './connectivity.service.js';
import { DeviceController } from './device.controller.js';
import { HeartbeatService } from './heartbeat.service.js';

/** 접속 상태(F8): 하트비트, 운영 중 단말기 목록(active), 오프라인 판정·스냅샷·조회. 공용 Redis 연결(RedisModule)은 전역이다. */
@Module({
  controllers: [DeviceController, ConnectivityController],
  providers: [HeartbeatService, ActiveSetService, ConnectivityService],
  exports: [HeartbeatService, ActiveSetService, ConnectivityService],
})
export class DeviceModule {}
```

`apps/api/src/device/device.processor.ts` 전체(`detect-offline`, `snapshot`):
```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import type { ProjectJobData } from '../outbox/outbox.service.js';
import { QUEUE } from '../queue/queue-names.js';
import { ActiveSetService } from './active-set.service.js';
import { ConnectivityService } from './connectivity.service.js';

/**
 * device 큐. concurrency 1: 한 워커 프로세스 안에서는 active 갱신이 한 번에 하나씩 돈다(읽고 쓰는 사이에 다른 갱신이 끼지 않게).
 * 워커 프로세스가 여럿이면 겹칠 수 있고, 그 틈은 주기 재구성이 메운다(decisions/0028).
 */
@Processor(QUEUE.DEVICE, { concurrency: 1 })
export class DeviceProcessor extends WorkerHost {
  constructor(
    private readonly activeSet: ActiveSetService,
    private readonly connectivity: ConnectivityService,
  ) {
    super();
  }

  async process(job: Job) {
    switch (job.name) {
      case 'project':
        return this.activeSet.apply([(job.data as ProjectJobData).serialNo]);
      case 'rebuild-active':
        return this.activeSet.rebuild();
      case 'detect-offline':
        return this.connectivity.detect();
      case 'snapshot':
        return this.connectivity.snapshot();
      default:
        throw new UnrecoverableError(`모르는 device job: ${job.name}`);
    }
  }
}
```

`apps/api/src/scheduler/job-schedulers.ts` 전체(`offline-detect`, `connectivity-snapshot`):
```ts
import type { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { QUEUE, type QueueName } from '../queue/queue-names.js';

/** 주기 작업 목록. 등록(SchedulerService)과 삭제(scheduler:clear)가 같은 id를 쓴다. every는 등록할 때 읽는 주기(ms)다. */
export const JOB_SCHEDULERS = [
  { queue: QUEUE.CARRIER_SWEEP, id: 'carrier-sweep', jobName: 'sweep', every: () => env.sweepIntervalMs },
  { queue: QUEUE.OUTBOX, id: 'outbox-relay', jobName: 'relay', every: () => env.relayIntervalMs },
  { queue: QUEUE.DEVICE, id: 'active-rebuild', jobName: 'rebuild-active', every: () => env.activeRebuildIntervalMs },
  { queue: QUEUE.DEVICE, id: 'offline-detect', jobName: 'detect-offline', every: () => env.offlineDetectIntervalMs },
  { queue: QUEUE.DEVICE, id: 'connectivity-snapshot', jobName: 'snapshot', every: () => env.connectivitySnapshotIntervalMs },
] as const satisfies readonly { queue: QueueName; id: string; jobName: string; every: () => number }[];

/**
 * 주기 작업을 Redis에서 지운다. job scheduler는 등록한 프로세스가 끝나도 Redis에 남아 계속 job을 만든다
 * (Day 2 리뷰 Minor 2, decisions/0015). 다음 주기 job(delayed)도 함께 지워진다.
 * @returns 지운 scheduler id 목록(없던 것은 빠진다)
 */
export async function clearJobSchedulers(queueOf: (name: QueueName) => Queue): Promise<string[]> {
  const removed: string[] = [];
  for (const s of JOB_SCHEDULERS) {
    if (await queueOf(s.queue).removeJobScheduler(s.id)) removed.push(s.id);
  }
  return removed;
}
```

`.env.example`의 `ACTIVE_REBUILD_INTERVAL_MS=60000` 다음 줄에 추가:
```
# 접속 상태 — decisions/0029
HEARTBEAT_OFFLINE_AFTER_MS=90000
OFFLINE_DETECT_INTERVAL_MS=10000
CONNECTIVITY_SNAPSHOT_INTERVAL_MS=60000
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/connectivity.e2e.spec.ts test/unit/outbox-text.spec.ts --silent=false 2>&1 | grep -E "스냅샷 쿼리|Tests "`
Expected: `Tests  8 passed (8)`. 로그는 `[스냅샷 쿼리] ["begin","insert into \`device_connectivity\` (\`terminal_id\`, … on duplicate key update \`last_seen_at\` = values(…","commit"]`(쿼리마다 200자에서 자름) — `begin`, INSERT 한 문장, `commit`만 있고 select가 없다.

**upsertMany 확인(되돌림)**: `upsertConnectivity`의 본문을 잠깐 `await tx.upsertMany(DeviceConnectivity, rows, { onConflictFields: ['terminalId'], onConflictAction: 'merge', onConflictMergeFields: merge })`로 바꾸고 같은 명령을 돌리면 snapshot 테스트가 `expected [ Array(1) ] to have a length of +0 but got 1`로 실패하고, 로그의 INSERT와 `commit` 사이에 `select \`d0\`.\`online\`, \`d0\`.\`changed_at\`, …`가 하나 더 보인다(사전 검증에서 자르지 않고 본 전체 문장: `… from \`device_connectivity\` as \`d0\` where (\`d0\`.\`terminal_id\` = ? or \`d0\`.\`terminal_id\` = ?)`). 확인 뒤 QueryBuilder로 되돌리고, 이 결과를 decisions/0029에 적는다.

Run: `npx vitest run && npm run typecheck`
Expected: `Test Files  34 passed (34)`, `Tests  220 passed (220)`, typecheck exit 0.

- [ ] **Step 5: 마이그레이션**

Run: `npm run db:migration:create`
Expected: `생성: Migration<시각>.ts`. up()은 다음 한 줄이어야 한다(down()은 `drop table if exists \`device_connectivity\`;`).
```ts
    this.addSql(`create table \`device_connectivity\` (\`terminal_id\` int unsigned not null, \`online\` tinyint(1) not null, \`last_seen_at\` datetime(3) not null, \`firmware_version\` varchar(20) null, \`changed_at\` datetime(3) not null, primary key (\`terminal_id\`)) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
```
그리고:
```bash
npm run db:migrate
npm run db:migration:check
```
Expected: `적용: Migration<시각>`, `최신 상태`

- [ ] **Step 6: 기록과 커밋**

devlog에 `## HH:MM Task 5 오프라인 판정·스냅샷·접속 상태 조회 (F8, F5)` 항목(upsertMany 되돌린 확인 결과, 마이그레이션 이름 포함).

`docs/decisions/0029-오프라인-판정과-스냅샷은-바뀐-것만-MySQL에.md`:
- 상황: 접속 상태의 최신값은 Redis(decisions/0027)다. 운영자 화면·리포트·알림에는 "언제 끊겼나"와 Redis를 잃어도 남는 값이 필요하다. 하트비트마다 MySQL에 쓰지 않으면서 무엇을 언제 MySQL에 쓸지 정해야 한다.
- 선택지(쓰는 때): 1) 하트비트마다(decisions/0027에서 버림, 실험 0008이 잰다) 2) **상태가 바뀔 때만(판정 job) + 주기 스냅샷** 3) 스냅샷만 — 끊긴 순간이 스냅샷 주기로 뭉개지고 알림을 낼 곳이 없다.
- 결정: 2. 판정 job은 바뀐 단말기만 한 트랜잭션에서 UPSERT + Outbox(`device.offline`/`device.online`, 상태 전이 이력과 별개 type). 스냅샷은 지난 스냅샷 뒤 lastSeen이 바뀐 단말기만, online은 덮어쓰지 않는다(online은 판정 job만 바꾼다).
- 온라인 복귀를 어디서 찾나: 1) 하트비트 경로(오프라인 SET을 확인해 바로 MySQL·Outbox) — 하트비트가 MySQL을 치게 된다. 2) **판정 job**(오프라인 SET의 lastSeen을 ZMSCORE로 보고) — 하트비트 경로는 Redis 전용으로 남고, 복귀 알림이 판정 주기만큼 늦다. → 2.
- `device_connectivity`에 terminal FK를 두지 않는 이유: 수천 행 UPSERT가 단말기 행마다 FK 검사 S 락을 걸면 같은 단말기의 전이(X 락)와 서로 기다린다. Outbox와 같은 이유(decisions/0016). 정리되지 않은 행(폐기된 단말기)은 남는다.
- UPSERT 방법: `em.upsertMany`는 MikroORM 7.2.5에서 INSERT 뒤 같은 행을 `select … where terminal_id = ? or …`로 다시 읽었다(Step 4 확인, 5,000행이면 OR 5,000개). 엔티티가 필요 없어 QueryBuilder `insert … on duplicate key update` 한 문장(500행씩)으로 쓴다. 행은 terminal_id 오름차순(여러 행 잠금 순서, 판정과 스냅샷이 동시에 돌아도 같은 순서).
- 동시 실행: 판정·스냅샷은 각자 Redis 잠금(`<prefix>:job-lock:hb-detect|hb-snapshot`, 30초)으로 프로세스가 여럿이어도 하나만 돈다. 커밋 뒤 Redis 반영 전에 죽으면 다음 판정이 같은 변화를 다시 쓴다(알림 중복 가능 → 최소 한 번 + 멱등키, decisions/0016).
- 기준: 마지막 하트비트가 90초(단말기 주기 30초의 3배)보다 오래되면 오프라인. 판정 10초, 스냅샷 60초. 한 번도 하트비트를 보내지 않은 단말기는 판정 대상이 아니다(lastSeen 없음).
- 결과·대가: 끊김 감지 지연 = 기준 - (마지막 하트비트 뒤 지난 시간) + 판정 주기(실험 0008이 잰다). 조회 API는 Redis 값으로 online을 계산하므로 판정 job보다 빨리 바뀐다(둘이 잠깐 다를 수 있다).
- 다시 볼 조건: 단말기 수가 커져 판정 한 번의 ZRANGEBYSCORE·SMEMBERS가 무거워지면(LIMIT으로 나누기), 오프라인 알림이 너무 많으면(묶어서 한 알림).

`docs/decisions/0016-Outbox-최소-한-번과-멱등키.md` 끝에 한 줄:
```
- 갱신(2026-10-23 Day 4): Outbox type이 늘었다(`device.offline`, `device.online`, Task 7에서 펌웨어 3종). 알림 문구는 `textOf`가 type별로 만든다("다시 볼 조건"의 type별 문구). relay는 IN_SERVICE 진입·이탈 이벤트를 device 큐에도 넣는다(decisions/0028).
```

`docs/study/backlog.md`에 추가:
```
- [ ] INSERT … ON DUPLICATE KEY UPDATE의 잠금(기존 행 X 락, 새 행 insert intention)과 여러 행 UPSERT의 순서 (device/connectivity.service.ts)
- [ ] ORM upsert가 MySQL에서 결과를 다시 SELECT하는 이유(RETURNING 없음) (decisions/0029)
- [ ] 장애 감지 기준(heartbeat timeout) 정하는 법 — 주기의 몇 배, 감지 지연과 오탐의 균형 (decisions/0029)
```

커밋:
```bash
git add apps/api docs .env.example
git commit -m "feat(F8): 오프라인 판정과 접속 상태 스냅샷·조회(바뀐 것만 MySQL, device.offline/online 알림)" -m "Refs: docs/decisions/0029-오프라인-판정과-스냅샷은-바뀐-것만-MySQL에.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 펌웨어 등록과 단계 배포 시작 — 대상 선정, Redis 제안, 하트비트 응답의 업데이트 지시, 멈춤·재개·중단 (F8)

**Files:**
- Create: `apps/api/src/firmware/firmware.entities.ts`, `apps/api/src/firmware/dto/firmware.dto.ts`, `apps/api/src/firmware/firmware.service.ts`, `apps/api/src/firmware/rollout.service.ts`, `apps/api/src/firmware/firmware.controller.ts`, `apps/api/src/firmware/firmware.module.ts`, `apps/api/src/device/offer-store.ts`, `apps/api/src/migrations/Migration<시각>.ts`(생성 명령)
- Modify: `apps/api/src/device/heartbeat.service.ts`, `apps/api/src/device/device.module.ts`, `apps/api/src/entities.ts`, `apps/api/src/app.module.ts`, `apps/api/src/outbox/outbox-event.entity.ts`, `apps/api/src/outbox/outbox.service.ts`, `apps/api/src/migrations/.snapshot-terminal_ops.json`(생성 명령)
- Test: `apps/api/test/helpers/device-fleet.ts`(새), `apps/api/test/firmware-rollout.e2e.spec.ts`(새), `apps/api/test/unit/outbox-text.spec.ts`
- Record: devlog, `docs/decisions/0030-펌웨어-단계-배포는-별도-테이블과-Redis-제안으로.md`, `docs/study/backlog.md`

- 테이블 3개(단말기 상태 enum은 그대로): `firmware`(모델·버전 unique), `firmware_rollout`(stages json 누적 %, current_stage, status, failure_threshold, min_samples, stage_timeout_ms, stage_started_at …), `firmware_rollout_target`(rollout·terminal unique, stage, status OFFERED·SUCCEEDED·FAILED·TIMED_OUT …).
- `POST /firmware`(201, 같은 모델·버전 409 DUPLICATE). `POST /firmware-rollouts`: 단계 검사(커지는 순서, 마지막 100 → 아니면 400 INVALID_STAGES) → 모델 행 FOR UPDATE → 진행 중 배포가 있으면 409 ROLLOUT_ALREADY_ACTIVE → 배포 INSERT → 첫 단계 대상 INSERT(그 모델의 IN_SERVICE, CRC32(시리얼) 순, 누적 비율) → **커밋 뒤** Redis `fw:offers`에 제안.
- 하트비트 응답: 첫 왕복(pipeline)에 `HMGET offers`를 더해, 제안이 있는 행에 `update: { rolloutId, version }`.
- `POST /firmware-rollouts/:id/pause|resume|abort`, `GET /firmware-rollouts/:id`(단계별 대상·결과 수). 제안 내리기는 배포 id를 비교하는 Lua.
- 단계를 넘기는 판단과 보고는 Task 7. 이 Task의 Outbox type에 펌웨어 3종을 미리 넣고(abort가 쓴다) 문구도 만든다.
- 테스트 준비용 `seedInService`: 운영 중 단말기를 API 없이 `em.insertMany`로 넣는다(이력·Outbox 없음, 테스트·실험 전용).

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/helpers/device-fleet.ts`(새):
```ts
import { crc32 } from 'node:zlib';
import { Merchant } from '../../src/merchant/merchant.entity.js';
import { Terminal } from '../../src/terminal/terminal.entity.js';
import { TerminalModel } from '../../src/terminal/terminal-model.entity.js';
import { TerminalStatus } from '../../src/terminal/terminal-status.js';
import type { TestApp } from './test-app.js';

/** 시리얼 `<prefix>-0001` … */
export function serialsOf(prefix: string, count: number, start = 1): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(start + i).padStart(4, '0')}`);
}

/**
 * 테스트·실험 준비용: 운영 중(IN_SERVICE) 단말기 count대를 API를 거치지 않고 INSERT 몇 번으로 넣는다.
 * 전이 서비스·이력·Outbox를 거치지 않는다 — 하트비트·펌웨어 배포 테스트에 "이미 설치된 단말기 수천 대"가 필요할 뿐이고,
 * 실제 API로 만들면 대당 요청 6번이라 5,000대에 수 분이 걸린다. 운영 코드에서는 쓰지 않는다.
 */
export async function seedInService(t: TestApp, prefix: string, count: number, modelCode = 'SN-100', start = 1): Promise<string[]> {
  const em = t.orm.em.fork();
  const model = await em.findOneOrFail(TerminalModel, { code: modelCode });
  const merchant = await em.findOneOrFail(Merchant, { code: 'GANGNAM-KIMBAP' });
  const serials = serialsOf(prefix, count, start);
  const now = new Date();
  for (let i = 0; i < serials.length; i += 1000) {
    await em.insertMany(
      Terminal,
      serials.slice(i, i + 1000).map((serialNo) => ({
        serialNo,
        model,
        merchant,
        status: TerminalStatus.IN_SERVICE,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }
  return serials;
}

/** 배포 대상 순서(시리얼 CRC32 오름차순, 같으면 id 순 — rollout.service.ts의 SQL과 같은 순서) */
export function rolloutOrder(serials: string[]): string[] {
  return [...serials].sort((a, b) => crc32(a) - crc32(b));
}
```

`apps/api/test/firmware-rollout.e2e.spec.ts`(새):
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../src/device/active-set.service.js';
import { deviceKeys } from '../src/device/device-keys.js';
import { OfferStore } from '../src/device/offer-store.js';
import { FirmwareRollout, FirmwareRolloutTarget, RolloutStatus } from '../src/firmware/firmware.entities.js';
import { OutboxEvent } from '../src/outbox/outbox-event.entity.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { rolloutOrder, seedInService } from './helpers/device-fleet.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { SCENARIO_OP } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'han' };
const ROLLOUT = { modelCode: 'SN-100', version: '2.0.0', stages: [10, 50, 100], failureThreshold: 0.2, minSamples: 2 };

describe('펌웨어 등록·단계 배포 시작·멈춤·재개·중단 (F8, decisions/0030)', () => {
  let t: TestApp;
  let redis: Redis;
  let serials: string[];
  const em = () => t.orm.em.fork();
  const offers = () => redis.hgetall(deviceKeys().offers);
  const beat = (items: string[]) =>
    t.http().post('/devices/heartbeats').send({ items: items.map((serialNo) => ({ serialNo, firmwareVersion: '1.0.0' })) });
  const createRollout = (body: Record<string, unknown> = {}) => t.http().post('/firmware-rollouts').set(OP).send({ ...ROLLOUT, ...body });
  const targetsOf = async (rolloutId: number) =>
    (await em().find(FirmwareRolloutTarget, { rollout: rolloutId }, { populate: ['terminal'], orderBy: { id: 'asc' } })).map((x) => x.terminal.serialNo);

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    await resetDatabase(t.orm);
    serials = await seedInService(t, 'FW', 20);
    await t.http().post('/terminals').set(SCENARIO_OP).send({ serialNo: 'FW-9001', modelCode: 'SN-100' }); // RECEIVED: 대상 아님
    await deleteTestKeys(redis, 'hb:');
    await t.app.get(ActiveSetService).rebuild();
  });
  beforeEach(async () => {
    await em().nativeUpdate(FirmwareRollout, { status: { $in: [RolloutStatus.RUNNING, RolloutStatus.PAUSED] } }, { status: RolloutStatus.ABORTED });
    await redis.del(deviceKeys().offers);
  });
  afterAll(async () => {
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('펌웨어 등록: 201, 같은 (모델, 버전)은 409 DUPLICATE, 없는 모델 404, 작업자 헤더 필수', async () => {
    const res = await t.http().post('/firmware').set(OP).send({ modelCode: 'SN-100', version: '2.0.0' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ modelCode: 'SN-100', version: '2.0.0', createdBy: 'han' });
    expect((await t.http().post('/firmware').set(OP).send({ modelCode: 'SN-100', version: '2.0.0' })).body.code).toBe('DUPLICATE');
    expect((await t.http().post('/firmware').set(OP).send({ modelCode: 'NONE', version: '2.0.0' })).status).toBe(404);
    expect((await t.http().post('/firmware').send({ modelCode: 'SN-100', version: '2.0.1' })).status).toBe(400);
    expect((await t.http().post('/firmware').set(OP).send({ modelCode: 'SN-200', version: '2.0.0' })).status).toBe(201);
  });

  it('배포 시작: 첫 단계(10%) 대상을 CRC32(시리얼) 순으로 고르고, Redis에 제안을 건다', async () => {
    const res = await createRollout();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ modelCode: 'SN-100', version: '2.0.0', status: 'RUNNING', currentStage: 0, createdBy: 'han' });
    expect(res.body.stageStats[0]).toEqual({ stage: 0, percent: 10, targets: 2, offered: 2, succeeded: 0, failed: 0, timedOut: 0 });
    const picked = rolloutOrder(serials).slice(0, 2); // 운영 중 20대의 10% = 2대, RECEIVED 단말기는 빠진다
    expect(await targetsOf(res.body.id)).toEqual(picked);
    const offer = JSON.stringify({ rolloutId: res.body.id, version: '2.0.0' });
    expect(await offers()).toEqual(Object.fromEntries(picked.map((s) => [s, offer])));
  });

  it('하트비트 응답: 제안이 있는 단말기의 행에만 update', async () => {
    const { body: rollout } = await createRollout();
    const [target] = rolloutOrder(serials);
    const other = serials.find((s) => !rolloutOrder(serials).slice(0, 2).includes(s))!;
    const res = await beat([target, other]);
    expect(res.body.results).toEqual([
      { serialNo: target, result: 'OK', update: { rolloutId: rollout.id, version: '2.0.0' } },
      { serialNo: other, result: 'OK' },
    ]);
  });

  it('모델마다 진행 중 배포는 하나: 동시에 두 번 만들어도 하나만 201, 나머지 409 ROLLOUT_ALREADY_ACTIVE', async () => {
    const results = await Promise.all([createRollout().then((r) => r), createRollout().then((r) => r)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('ROLLOUT_ALREADY_ACTIVE');
    expect(await em().count(FirmwareRollout, { status: RolloutStatus.RUNNING })).toBe(1);
  });

  it('멈춤 → 제안 내림, 재개 → 다시 검, 중단 → 제안 내리고 ABORTED·Outbox 알림, 끝난 배포는 422', async () => {
    const { body: rollout } = await createRollout();
    const picked = rolloutOrder(serials).slice(0, 2);

    const paused = await t.http().post(`/firmware-rollouts/${rollout.id}/pause`).set(OP);
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('PAUSED');
    expect(await offers()).toEqual({});
    expect((await beat([picked[0]])).body.results[0].update).toBeUndefined();
    expect((await t.http().post(`/firmware-rollouts/${rollout.id}/pause`).set(OP)).body.code).toBe('ROLLOUT_NOT_RUNNING');

    const resumed = await t.http().post(`/firmware-rollouts/${rollout.id}/resume`).set(OP);
    expect(resumed.body.status).toBe('RUNNING');
    expect(Object.keys(await offers()).sort()).toEqual([...picked].sort());

    const aborted = await t.http().post(`/firmware-rollouts/${rollout.id}/abort`).set(OP);
    expect(aborted.body).toMatchObject({ status: 'ABORTED', endReason: '운영자 중단: han' });
    expect(aborted.body.finishedAt).toEqual(expect.any(String));
    expect(await offers()).toEqual({});
    const events = await em().find(OutboxEvent, { type: 'firmware.rollout_aborted' });
    expect(events.at(-1)?.payload).toMatchObject({ rolloutId: rollout.id, version: '2.0.0', reason: '운영자 중단: han' });
    const again = await t.http().post(`/firmware-rollouts/${rollout.id}/resume`).set(OP);
    expect([again.status, again.body.code]).toEqual([422, 'ROLLOUT_NOT_PAUSED']);
    expect((await t.http().post(`/firmware-rollouts/${rollout.id}/abort`).set(OP)).body.code).toBe('ROLLOUT_FINISHED');
  });

  it('중단된 배포의 제안 내리기는 다른 배포의 제안을 지우지 않는다', async () => {
    const store = t.app.get(OfferStore);
    await store.publish(['FW-0001'], { rolloutId: 999, version: '9.9.9' });
    expect(await store.withdraw(1, ['FW-0001'])).toBe(0);
    expect(await store.lookup(['FW-0001'])).toEqual([{ rolloutId: 999, version: '9.9.9' }]);
    expect(await store.withdraw(999, ['FW-0001'])).toBe(1);
  });

  it('입력 검사: 단계가 커지지 않거나 마지막이 100이 아니면 400 INVALID_STAGES, 등록 안 된 펌웨어 404, 없는 배포 404', async () => {
    expect((await createRollout({ stages: [50, 10, 100] })).body.code).toBe('INVALID_STAGES');
    expect((await createRollout({ stages: [10, 50] })).body.code).toBe('INVALID_STAGES');
    expect((await createRollout({ failureThreshold: 2 })).status).toBe(400);
    expect((await createRollout({ version: '3.0.0' })).status).toBe(404);
    expect((await t.http().get('/firmware-rollouts/99999')).status).toBe(404);
  });
});
```

`apps/api/test/unit/outbox-text.spec.ts` 전체(펌웨어 문구 테스트 추가):
```ts
import { describe, expect, it } from 'vitest';
import { textOf } from '../../src/outbox/outbox.service.js';

describe('알림 문구(textOf)', () => {
  it('상태 변경은 이전 → 다음 (작업자) 사유', () => {
    const text = textOf({
      type: 'terminal.status_changed',
      payload: { serialNo: 'A-0001', fromStatus: null, toStatus: 'RECEIVED', actor: 'kim', reason: '신규 등록' },
    });
    expect(text).toBe('[단말온] A-0001: 신규 → RECEIVED (kim) 신규 등록');
  });

  it('접속 상태는 오프라인·온라인 복귀와 마지막 하트비트 시각', () => {
    expect(textOf({ type: 'device.offline', payload: { serialNo: 'A-0001', lastSeenAt: '2026-10-23T00:00:00.000Z' } })).toBe(
      '[단말온] A-0001: 오프라인 (마지막 하트비트 2026-10-23T00:00:00.000Z)',
    );
    expect(textOf({ type: 'device.online', payload: { serialNo: 'A-0001', lastSeenAt: '2026-10-23T00:05:00.000Z' } })).toBe(
      '[단말온] A-0001: 온라인 복귀 (하트비트 2026-10-23T00:05:00.000Z)',
    );
  });

  it('펌웨어 배포는 배포 번호·버전과 단계 시작(1부터 센 단계, 누적 비율)·완료·중단 사유', () => {
    expect(textOf({ type: 'firmware.stage_advanced', payload: { rolloutId: 3, version: '2.0.0', stage: 1, percent: 50 } })).toBe(
      '[단말온] 펌웨어 배포 #3 2.0.0: 2단계(50%) 시작',
    );
    expect(textOf({ type: 'firmware.rollout_completed', payload: { rolloutId: 3, version: '2.0.0' } })).toBe('[단말온] 펌웨어 배포 #3 2.0.0: 완료');
    expect(textOf({ type: 'firmware.rollout_aborted', payload: { rolloutId: 3, version: '2.0.0', reason: '운영자 중단: han' } })).toBe(
      '[단말온] 펌웨어 배포 #3 2.0.0: 중단 (운영자 중단: han)',
    );
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/firmware-rollout.e2e.spec.ts test/unit/outbox-text.spec.ts`
Expected: `Test Files  2 failed (2)`. firmware-rollout은 `../src/device/offer-store.js`·`../src/firmware/firmware.entities.js` 등을 찾지 못해 파일 로드 실패. outbox-text는 `Tests  1 failed | 2 passed`, 펌웨어 문구가 `expected '[단말온] undefined: 신규 → undefined (unde…' to be '[단말온] 펌웨어 배포 #3 2.0.0: 2단계(50%) 시작'`.

- [ ] **Step 3: 구현**

`apps/api/src/firmware/firmware.entities.ts`(새):
```ts
import { OptionalProps, type Rel } from '@mikro-orm/core';
import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/decorators/legacy';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalModel } from '../terminal/terminal-model.entity.js';

/** 등록된 펌웨어(모델별 버전). 단말기 상태 enum과 무관하다(decisions/0030). */
@Entity({ tableName: 'firmware' })
@Unique({ properties: ['model', 'version'] })
export class Firmware {
  [OptionalProps]?: 'createdAt';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => TerminalModel)
  model!: Rel<TerminalModel>;

  @Property({ length: 20 })
  version!: string;

  @Property({ length: 50 })
  createdBy!: string;

  @Property()
  createdAt: Date = new Date();
}

export enum RolloutStatus {
  RUNNING = 'RUNNING', // 단계 진행 중
  PAUSED = 'PAUSED', // 운영자가 멈춤(제안 내림, 단계 넘기지 않음)
  COMPLETED = 'COMPLETED', // 마지막 단계까지 끝
  ABORTED = 'ABORTED', // 실패율 초과로 자동 중단, 또는 운영자 중단
}

/** 아직 끝나지 않은 배포. 모델마다 하나만 있을 수 있다 */
export const ACTIVE_ROLLOUT_STATUSES = [RolloutStatus.RUNNING, RolloutStatus.PAUSED];

/**
 * 펌웨어 단계 배포(F8). stages는 단계별 **누적** 비율(%)이다(예 [10, 50, 100]).
 * 이 행이 배포의 잠금 단위다 — 단계 넘기기·중단·멈춤은 모두 이 행을 FOR UPDATE로 잡고 한다(decisions/0031).
 */
@Entity({ tableName: 'firmware_rollout' })
@Index({ properties: ['status'] })
export class FirmwareRollout {
  [OptionalProps]?: 'currentStage' | 'status' | 'stageStartedAt' | 'createdAt' | 'finishedAt' | 'endReason';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => Firmware)
  firmware!: Rel<Firmware>;

  @Property({ type: 'json' })
  stages!: number[];

  /** 지금 단계(stages의 위치, 0부터) */
  @Property()
  currentStage: number = 0;

  @Enum({ items: () => RolloutStatus })
  status: RolloutStatus = RolloutStatus.RUNNING;

  /** 이 비율을 넘게 실패하면 자동 중단(0~1, 예 0.2) */
  @Property({ type: 'double' })
  failureThreshold!: number;

  /** 결과가 이만큼 모이기 전에는 실패율로 중단하지 않는다(단계가 다 끝났으면 예외) */
  @Property()
  minSamples!: number;

  /** 단계 안에서 제안 뒤 이 시간이 지나도록 보고가 없으면 TIMED_OUT */
  @Property()
  stageTimeoutMs!: number;

  @Property({ type: 'datetime', length: 3 })
  stageStartedAt: Date = new Date();

  @Property({ length: 50 })
  createdBy!: string;

  @Property()
  createdAt: Date = new Date();

  @Property({ type: 'datetime', nullable: true })
  finishedAt: Date | null = null;

  /** 끝난 이유(자동 중단 사유, 운영자 중단 등) */
  @Property({ type: 'varchar', length: 200, nullable: true })
  endReason: string | null = null;
}

export enum TargetStatus {
  OFFERED = 'OFFERED', // 제안함, 보고 기다림
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  TIMED_OUT = 'TIMED_OUT', // 단계 시간 안에 보고가 없음
}

/** 배포 대상 단말기 한 대. 단계에 들어갈 때 만든다. */
@Entity({ tableName: 'firmware_rollout_target' })
@Unique({ properties: ['rollout', 'terminal'] })
@Index({ properties: ['rollout', 'stage', 'status'] })
export class FirmwareRolloutTarget {
  [OptionalProps]?: 'status' | 'offeredAt' | 'reportedAt' | 'reportedVersion';

  @PrimaryKey()
  id!: number;

  @ManyToOne(() => FirmwareRollout)
  rollout!: Rel<FirmwareRollout>;

  @ManyToOne(() => Terminal)
  terminal!: Rel<Terminal>;

  /** 이 단말기가 들어간 단계 */
  @Property()
  stage!: number;

  @Enum({ items: () => TargetStatus })
  status: TargetStatus = TargetStatus.OFFERED;

  @Property({ type: 'datetime', length: 3 })
  offeredAt: Date = new Date();

  @Property({ type: 'datetime', length: 3, nullable: true })
  reportedAt: Date | null = null;

  /** 단말기가 보고한 버전 */
  @Property({ type: 'varchar', length: 20, nullable: true })
  reportedVersion: string | null = null;
}
```

`apps/api/src/entities.ts` 전체:
```ts
import { TerminalModel } from './terminal/terminal-model.entity.js';
import { Terminal } from './terminal/terminal.entity.js';
import { TerminalStatusHistory } from './terminal/terminal-status-history.entity.js';
import { InspectionItem } from './inspection/inspection-item.entity.js';
import { Inspection, InspectionResult } from './inspection/inspection.entities.js';
import { Merchant } from './merchant/merchant.entity.js';
import { CarrierEvent, Shipment, SyncRun } from './shipment/shipment.entities.js';
import { OutboxEvent } from './outbox/outbox-event.entity.js';
import { PurchaseOrder } from './purchase-order/purchase-order.entity.js';
import { ScanBatch } from './scan/scan-batch.entity.js';
import { ServiceTicket } from './service/service-ticket.entity.js';
import { DeviceConnectivity } from './device/device-connectivity.entity.js';
import { Firmware, FirmwareRollout, FirmwareRolloutTarget } from './firmware/firmware.entities.js';

/** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch, ServiceTicket, DeviceConnectivity, Firmware, FirmwareRollout, FirmwareRolloutTarget];
```

`apps/api/src/outbox/outbox-event.entity.ts` 전체(펌웨어 type 3개):
```ts
import { OptionalProps } from '@mikro-orm/core';
import { Entity, Enum, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

export enum OutboxStatus {
  PENDING = 'PENDING', // 기록됨, 아직 큐에 안 넣음
  QUEUED = 'QUEUED', // 알림 job을 큐에 넣음
  SENT = 'SENT', // 메신저가 200을 줌
  FAILED = 'FAILED', // 재시도를 다 써도 실패
}

export const OUTBOX_TYPE = {
  TERMINAL_STATUS_CHANGED: 'terminal.status_changed',
  /** 접속 상태(F8). 상태 전이가 아니라 별도 type이다(decisions/0029) */
  DEVICE_OFFLINE: 'device.offline',
  DEVICE_ONLINE: 'device.online',
  /** 펌웨어 배포(F8, decisions/0030·0031) */
  FIRMWARE_STAGE_ADVANCED: 'firmware.stage_advanced',
  FIRMWARE_ROLLOUT_COMPLETED: 'firmware.rollout_completed',
  FIRMWARE_ROLLOUT_ABORTED: 'firmware.rollout_aborted',
} as const;

/**
 * 보낼 알림. 상태 변경과 같은 트랜잭션에서 기록하고(유실 없음), relay가 나중에 큐로 옮긴다(decisions/0016).
 * 외래키를 두지 않는다 — 부모 행 락을 잡지 않고, 단말기를 지워도 알림 기록은 남게 하기 위해서다.
 */
@Entity({ tableName: 'outbox_event' })
@Index({ properties: ['status', 'id'] })
export class OutboxEvent {
  [OptionalProps]?: 'status' | 'attempts' | 'createdAt';

  @PrimaryKey()
  id!: number;

  @Property({ length: 50 })
  type!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Enum({ items: () => OutboxStatus })
  status: OutboxStatus = OutboxStatus.PENDING;

  /** 전송 시도 횟수 */
  @Property()
  attempts: number = 0;

  @Property({ length: 500, nullable: true })
  lastError?: string | null;

  @Property()
  createdAt: Date = new Date();

  // 유니온 타입(Date | null)은 데코레이터 메타데이터가 Object라 type을 꼭 적는다(varchar(255)가 되는 것을 막는다).
  @Property({ type: 'datetime', nullable: true })
  sentAt?: Date | null;
}
```

`apps/api/src/outbox/outbox.service.ts` 전체(펌웨어 문구. 단계는 1부터 세어 보여 준다):
```ts
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { UnrecoverableError, type JobsOptions, type Queue } from 'bullmq';
import { EntityManager, IsolationLevel, LockMode } from '@mikro-orm/mysql';
import { PartnerPermanentError } from '../common/partner-errors.js';
import { QUEUE } from '../queue/queue-names.js';
import { OUTBOX_TYPE, OutboxEvent, OutboxStatus } from './outbox-event.entity.js';
import { ToktokClient } from './toktok.client.js';

export interface NotifyJobData {
  outboxId: number;
}

export const NOTIFY_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 200 },
  removeOnComplete: true,
  removeOnFail: true,
};

/** active 갱신(project) job 옵션. 실패하면 몇 번 다시 하고, 그래도 안 되면 주기 재구성이 맞춘다(decisions/0028). */
export const PROJECT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 200 },
  removeOnComplete: true,
  removeOnFail: true,
};

export interface ProjectJobData {
  serialNo: string;
}

/** 운영 중 단말기 목록(Redis active)을 바꾸는 이벤트인가: IN_SERVICE로 들어오거나 IN_SERVICE에서 나가는 상태 변경 */
export function changesActiveSet(row: OutboxEvent): boolean {
  if (row.type !== OUTBOX_TYPE.TERMINAL_STATUS_CHANGED) return false;
  const p = row.payload as { fromStatus?: string | null; toStatus?: string };
  return p.toStatus === 'IN_SERVICE' || p.fromStatus === 'IN_SERVICE';
}

/** 메신저가 같은 알림을 한 번으로 볼 수 있게 보내는 키. outbox 행마다 하나 */
export function idempotencyKeyOf(id: number): string {
  return `outbox-${id}`;
}

/** 알림 문구. type마다 다르다(decisions/0016 "다시 볼 조건"). */
export function textOf(event: Pick<OutboxEvent, 'type' | 'payload'>): string {
  const p = event.payload as {
    serialNo?: string;
    fromStatus?: string | null;
    toStatus?: string;
    actor?: string;
    reason?: string;
    lastSeenAt?: string;
    rolloutId?: number;
    version?: string;
    stage?: number;
    percent?: number;
  };
  if (event.type === OUTBOX_TYPE.DEVICE_OFFLINE) return `[단말온] ${p.serialNo}: 오프라인 (마지막 하트비트 ${p.lastSeenAt})`;
  if (event.type === OUTBOX_TYPE.DEVICE_ONLINE) return `[단말온] ${p.serialNo}: 온라인 복귀 (하트비트 ${p.lastSeenAt})`;
  if (event.type === OUTBOX_TYPE.FIRMWARE_STAGE_ADVANCED) {
    return `[단말온] 펌웨어 배포 #${p.rolloutId} ${p.version}: ${(p.stage ?? 0) + 1}단계(${p.percent}%) 시작`;
  }
  if (event.type === OUTBOX_TYPE.FIRMWARE_ROLLOUT_COMPLETED) return `[단말온] 펌웨어 배포 #${p.rolloutId} ${p.version}: 완료`;
  if (event.type === OUTBOX_TYPE.FIRMWARE_ROLLOUT_ABORTED) return `[단말온] 펌웨어 배포 #${p.rolloutId} ${p.version}: 중단 (${p.reason})`;
  return `[단말온] ${p.serialNo}: ${p.fromStatus ?? '신규'} → ${p.toStatus} (${p.actor}) ${p.reason}`;
}

/**
 * Outbox(F5).
 * - relay: PENDING 행을 잠그고(다른 relay가 잡은 행은 건너뜀, SKIP LOCKED) notify job을 넣은 뒤 QUEUED로 바꾼다.
 *   READ COMMITTED로 돈다. 기본(REPEATABLE READ)이면 잠금 읽기가 (status, id) 인덱스의 gap까지 잠가
 *   새 PENDING 행 INSERT(= 전이·등록 트랜잭션)를 relay가 커밋할 때까지 막는다(troubleshooting/0007).
 * - notify: 톡톡메신저로 보내고 SENT로 바꾼다. 최종 실패면 FAILED.
 * 보장 수준은 "최소 한 번 + 멱등키"다(decisions/0016).
 */
@Injectable()
export class OutboxService {
  constructor(
    private readonly em: EntityManager,
    private readonly toktok: ToktokClient,
    @InjectQueue(QUEUE.OUTBOX) private readonly queue: Queue,
    @InjectQueue(QUEUE.DEVICE) private readonly deviceQueue: Queue,
  ) {}

  /**
   * @param opts.enqueue 'bulk'(기본): 잡은 행을 addBulk 한 번으로 넣는다(Redis 왕복 1번). 'each': 행마다 add(Day 2 방식).
   *   'each'는 실험 0006에서 비교하려고만 남긴다(decisions/0024).
   */
  async relay(limit = 100, opts: { enqueue?: 'bulk' | 'each' } = {}): Promise<{ queued: number[] }> {
    const queued = await this.em.fork().transactional(async (tx) => {
      const rows = await tx.find(
        OutboxEvent,
        { status: OutboxStatus.PENDING },
        { lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, limit, orderBy: { id: 'asc' } },
      );
      // jobId가 같으면 BullMQ가 한 번만 받는다(addBulk도 같다). 커밋 전에 죽어 이 행이 다시 relay돼도 job이 남아 있으면 중복으로 들어가지 않는다.
      // addBulk는 MULTI가 아니라 pipeline이라 일부만 넣고 throw할 수 있다 → 이 트랜잭션이 롤백돼 행은 PENDING, 다음 relay가 같은 jobId로 다시 넣는다(decisions/0024).
      const jobs = rows.map((row) => ({
        name: 'notify',
        data: { outboxId: row.id },
        opts: { ...NOTIFY_JOB_OPTIONS, jobId: idempotencyKeyOf(row.id) },
      }));
      if (opts.enqueue === 'each') {
        for (const job of jobs) await this.queue.add(job.name, job.data, job.opts);
      } else if (jobs.length > 0) {
        await this.queue.addBulk(jobs);
      }
      // 두 번째 소비자: IN_SERVICE 진입·이탈 이벤트는 active 갱신 job도 넣는다(decisions/0028). jobId가 행마다 하나라
      // 이 트랜잭션이 롤백돼 다시 relay돼도 한 번만 들어간다(notify와 같은 규칙).
      const projections = rows.filter(changesActiveSet).map((row) => ({
        name: 'project',
        data: { serialNo: (row.payload as { serialNo: string }).serialNo } satisfies ProjectJobData,
        opts: { ...PROJECT_JOB_OPTIONS, jobId: `project-${row.id}` },
      }));
      if (projections.length > 0) await this.deviceQueue.addBulk(projections);
      for (const row of rows) row.status = OutboxStatus.QUEUED;
      return rows.map((r) => r.id);
    }, { isolationLevel: IsolationLevel.READ_COMMITTED });
    return { queued };
  }

  async notify(outboxId: number, { lastAttempt }: { lastAttempt: boolean }): Promise<'SENT' | 'SKIPPED'> {
    const em = this.em.fork();
    const row = await em.findOne(OutboxEvent, outboxId);
    if (!row || row.status === OutboxStatus.SENT || row.status === OutboxStatus.FAILED) return 'SKIPPED';

    row.attempts += 1;
    try {
      await this.toktok.send({ idempotencyKey: idempotencyKeyOf(row.id), text: textOf(row) });
    } catch (error) {
      const permanent = error instanceof PartnerPermanentError;
      row.lastError = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
      if (permanent || lastAttempt) row.status = OutboxStatus.FAILED;
      await em.flush();
      throw permanent ? new UnrecoverableError(row.lastError) : error;
    }
    // 여기서 죽으면(메신저는 받았는데 SENT를 못 씀) job이 다시 실행돼 한 번 더 보낸다 → 멱등키로 메신저가 걸러야 한다.
    row.status = OutboxStatus.SENT;
    row.sentAt = new Date();
    row.lastError = null;
    await em.flush();
    return 'SENT';
  }
}
```

`apps/api/src/device/offer-store.ts`(새):
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { execOrThrow } from '../redis/redis-exec.js';
import { REDIS } from '../redis/redis.provider.js';
import { deviceKeys } from './device-keys.js';

/** 하트비트 응답에 실어 보내는 업데이트 지시 */
export interface FirmwareOffer {
  rolloutId: number;
  version: string;
}

/** 한 번에 HSET·HDEL하는 필드 수 */
const CHUNK = 1000;

/**
 * 그 배포의 제안일 때만 지운다. 중단된 배포의 제안을 늦게 지우다가, 그사이 같은 단말기에 생긴 다른 배포의 제안을 지우지 않게.
 * KEYS[1] = offers HASH, ARGV[1] = rolloutId, ARGV[2..] = serialNo
 */
const WITHDRAW_SCRIPT = `
local removed = 0
for i = 2, #ARGV do
  local v = redis.call('hget', KEYS[1], ARGV[i])
  if v and cjson.decode(v).rolloutId == tonumber(ARGV[1]) then
    removed = removed + redis.call('hdel', KEYS[1], ARGV[i])
  end
end
return removed`;

/**
 * 펌웨어 업데이트 제안(Redis HASH `fw:offers`, serialNo → {rolloutId, version}). 하트비트가 MySQL을 보지 않고
 * "이 단말기에 업데이트가 있나"를 알게 하는 사본이다. 원본은 MySQL의 firmware_rollout_target(OFFERED)이다(decisions/0030).
 */
@Injectable()
export class OfferStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async publish(serials: string[], offer: FirmwareOffer): Promise<void> {
    if (serials.length === 0) return;
    const value = JSON.stringify(offer);
    const batch = this.redis.pipeline();
    for (let i = 0; i < serials.length; i += CHUNK) {
      batch.hset(deviceKeys().offers, Object.fromEntries(serials.slice(i, i + CHUNK).map((s) => [s, value])));
    }
    await execOrThrow(batch);
  }

  /** 그 배포의 제안만 지운다. @returns 지운 수 */
  async withdraw(rolloutId: number, serials: string[]): Promise<number> {
    let removed = 0;
    for (let i = 0; i < serials.length; i += CHUNK) {
      removed += Number(await this.redis.eval(WITHDRAW_SCRIPT, 1, deviceKeys().offers, rolloutId, ...serials.slice(i, i + CHUNK)));
    }
    return removed;
  }

  /** 시리얼마다 제안(없으면 null) */
  async lookup(serials: string[]): Promise<(FirmwareOffer | null)[]> {
    if (serials.length === 0) return [];
    const raw = await this.redis.hmget(deviceKeys().offers, ...serials);
    return raw.map((v) => (v ? (JSON.parse(v) as FirmwareOffer) : null));
  }

  /** 제안이 걸린 단말기 수(실험·테스트용) */
  count(): Promise<number> {
    return this.redis.hlen(deviceKeys().offers);
  }
}
```

`apps/api/src/device/heartbeat.service.ts` 전체(첫 왕복에 offers, 응답에 update):
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { execOrThrow } from '../redis/redis-exec.js';
import { REDIS } from '../redis/redis.provider.js';
import { normalizeValue, SERIAL_NO_MESSAGE, SERIAL_NO_PATTERN } from '../terminal/bulk-rows.js';
import { deviceKeys } from './device-keys.js';
import type { FirmwareOffer } from './offer-store.js';

/** 펌웨어 버전 형식: 영문·숫자·점·하이픈 1~20자 */
export const FIRMWARE_VERSION_PATTERN = /^[0-9A-Za-z.-]{1,20}$/;

export type HeartbeatResultCode = 'OK' | 'IGNORED_NOT_IN_SERVICE' | 'INVALID_FORMAT';

export interface HeartbeatRowResult {
  serialNo: string;
  result: HeartbeatResultCode;
  message?: string;
  /** 이 단말기에 펌웨어 업데이트 제안이 있으면(decisions/0030) */
  update?: FirmwareOffer;
}

export interface HeartbeatResponse {
  /** OK인 행 수 */
  accepted: number;
  /** 입력과 같은 순서의 행별 결과 */
  results: HeartbeatRowResult[];
}

/**
 * 단말기 하트비트(F8). 상태 전이가 아니다 — TransitionService·이력·Outbox를 거치지 않고, MySQL에도 쓰지 않는다(decisions/0027).
 * 쓰는 곳은 Redis뿐이다: 마지막 시각(ZSET lastSeen, 서버 시계)과 펌웨어 버전(HASH firmware).
 * 운영 중(IN_SERVICE) 단말기의 하트비트만 받는다. 그 판단도 MySQL 대신 Redis HASH active로 한다(decisions/0028).
 * 업데이트 제안(HASH offers)이 있으면 응답의 그 행에 update로 싣는다(decisions/0030).
 * 왕복은 묶음당 2번: ① active·offers 조회(pipeline) ② lastSeen·firmware 쓰기(pipeline).
 */
@Injectable()
export class HeartbeatService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async receive(items: Record<string, unknown>[], now = Date.now()): Promise<HeartbeatResponse> {
    const rows = items.map((item) => ({ serialNo: normalizeValue(item.serialNo), firmwareVersion: normalizeValue(item.firmwareVersion) }));
    const results: (HeartbeatRowResult | null)[] = rows.map((r) => {
      if (!SERIAL_NO_PATTERN.test(r.serialNo)) return { serialNo: r.serialNo, result: 'INVALID_FORMAT', message: SERIAL_NO_MESSAGE };
      if (!FIRMWARE_VERSION_PATTERN.test(r.firmwareVersion)) {
        return { serialNo: r.serialNo, result: 'INVALID_FORMAT', message: 'firmwareVersion은 영문·숫자·점·하이픈 1~20자입니다.' };
      }
      return null;
    });
    const valid = rows.flatMap((r, i) => (results[i] ? [] : [{ ...r, i }]));
    const keys = deviceKeys();

    const serials = valid.map((r) => r.serialNo);
    const [ids, offers] =
      valid.length > 0
        ? ((await execOrThrow(this.redis.pipeline().hmget(keys.active, ...serials).hmget(keys.offers, ...serials))) as (string | null)[][])
        : [[], []];
    const accepted = valid
      .map((r, k) => ({ ...r, offer: offers[k] }))
      .filter((r, k) => {
        if (ids[k] !== null) return true;
        results[r.i] = { serialNo: r.serialNo, result: 'IGNORED_NOT_IN_SERVICE', message: '운영 중(IN_SERVICE)인 단말기의 하트비트만 받습니다.' };
        return false;
      });

    if (accepted.length > 0) {
      const write = this.redis.pipeline();
      write.zadd(keys.lastSeen, ...accepted.flatMap((r) => [now, r.serialNo]));
      write.hset(keys.firmware, Object.fromEntries(accepted.map((r) => [r.serialNo, r.firmwareVersion])));
      await execOrThrow(write);
    }
    for (const r of accepted) {
      results[r.i] = r.offer ? { serialNo: r.serialNo, result: 'OK', update: JSON.parse(r.offer) as FirmwareOffer } : { serialNo: r.serialNo, result: 'OK' };
    }
    return { accepted: accepted.length, results: results as HeartbeatRowResult[] };
  }
}
```

`apps/api/src/device/device.module.ts` 전체(`OfferStore` 추가·export):
```ts
import { Module } from '@nestjs/common';
import { ActiveSetService } from './active-set.service.js';
import { ConnectivityController } from './connectivity.controller.js';
import { ConnectivityService } from './connectivity.service.js';
import { DeviceController } from './device.controller.js';
import { HeartbeatService } from './heartbeat.service.js';
import { OfferStore } from './offer-store.js';

/** 접속 상태(F8): 하트비트, 운영 중 단말기 목록(active), 오프라인 판정·스냅샷·조회. 공용 Redis 연결(RedisModule)은 전역이다. */
@Module({
  controllers: [DeviceController, ConnectivityController],
  providers: [HeartbeatService, ActiveSetService, ConnectivityService, OfferStore],
  exports: [HeartbeatService, ActiveSetService, ConnectivityService, OfferStore],
})
export class DeviceModule {}
```

`apps/api/src/firmware/dto/firmware.dto.ts`(새):
```ts
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { FIRMWARE_VERSION_PATTERN } from '../../device/heartbeat.service.js';

const VERSION_MESSAGE = 'version은 영문·숫자·점·하이픈 1~20자입니다.';

export class RegisterFirmwareDto {
  @IsString()
  modelCode!: string;

  @Matches(FIRMWARE_VERSION_PATTERN, { message: VERSION_MESSAGE })
  version!: string;
}

export class CreateRolloutDto {
  @IsString()
  modelCode!: string;

  @Matches(FIRMWARE_VERSION_PATTERN, { message: VERSION_MESSAGE })
  version!: string;

  /** 단계별 누적 비율(%). 커지는 순서, 마지막은 100 (서비스가 확인) */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(100, { each: true })
  stages!: number[];

  @IsNumber()
  @Min(0)
  @Max(1)
  failureThreshold!: number;

  @IsInt()
  @Min(1)
  minSamples!: number;

  /** 단계 안에서 보고를 기다리는 시간(ms). 기본 10분 */
  @IsOptional()
  @IsInt()
  @Min(1)
  stageTimeoutMs?: number;
}
```

`apps/api/src/firmware/firmware.service.ts`(새):
```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { TerminalModel } from '../terminal/terminal-model.entity.js';
import type { RegisterFirmwareDto } from './dto/firmware.dto.js';
import { Firmware } from './firmware.entities.js';

/** 펌웨어 등록. (모델, 버전)이 이미 있으면 unique 위반 → 409 DUPLICATE(기존 예외 필터). */
@Injectable()
export class FirmwareService {
  constructor(private readonly em: EntityManager) {}

  async register(dto: RegisterFirmwareDto, actor: string): Promise<Firmware> {
    const em = this.em.fork();
    const model = await em.findOne(TerminalModel, { code: dto.modelCode });
    if (!model) throw new NotFoundException(`단말기 모델 ${dto.modelCode}이(가) 없습니다.`);
    const firmware = em.create(Firmware, { model, version: dto.version, createdBy: actor });
    await em.flush();
    return firmware;
  }
}

export function toFirmwareView(f: Firmware) {
  return { id: f.id, modelCode: f.model.code, version: f.version, createdBy: f.createdBy, createdAt: f.createdAt.toISOString() };
}
```

`apps/api/src/firmware/rollout.service.ts`(새, 이 Task는 만들기·멈춤·재개·중단·조회. 판단은 Task 7에서 더한다):
```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { OfferStore } from '../device/offer-store.js';
import { OUTBOX_TYPE, OutboxEvent } from '../outbox/outbox-event.entity.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalModel } from '../terminal/terminal-model.entity.js';
import type { CreateRolloutDto } from './dto/firmware.dto.js';
import { ACTIVE_ROLLOUT_STATUSES, Firmware, FirmwareRollout, FirmwareRolloutTarget, RolloutStatus, TargetStatus } from './firmware.entities.js';

/** 단계 제한 시간 기본값(10분) */
export const DEFAULT_STAGE_TIMEOUT_MS = 10 * 60_000;

export interface StageStats {
  stage: number;
  percent: number;
  targets: number;
  offered: number;
  succeeded: number;
  failed: number;
  timedOut: number;
}

/** 단계 비율은 1~100, 커지는 순서, 마지막은 100 */
export function checkStages(stages: number[]): string | null {
  if (stages.some((p, i) => i > 0 && p <= stages[i - 1])) return 'stages는 커지는 순서여야 합니다(누적 비율).';
  if (stages.at(-1) !== 100) return 'stages의 마지막은 100이어야 합니다.';
  return null;
}

/**
 * 펌웨어 단계 배포(F8, decisions/0030). 단계에 들어갈 때 대상 단말기를 고르고(해당 모델의 운영 중 단말기, 시리얼 CRC32 순 —
 * 같은 단말기 목록이면 늘 같은 순서) 대상 행을 만든 뒤, **커밋 뒤에** Redis에 제안을 건다(하트비트 응답의 빠른 길).
 * 배포 행이 잠금 단위다: 만들기는 모델 행, 나머지(멈춤·재개·중단, 단계 넘기기)는 배포 행을 FOR UPDATE로 먼저 잡는다(decisions/0031).
 */
@Injectable()
export class RolloutService {
  constructor(
    private readonly em: EntityManager,
    private readonly offers: OfferStore,
  ) {}

  async create(dto: CreateRolloutDto, actor: string): Promise<FirmwareRollout> {
    const invalid = checkStages(dto.stages);
    if (invalid) throw new BadRequestException({ statusCode: 400, code: 'INVALID_STAGES', message: invalid });
    const firmware = await this.em.fork().findOne(Firmware, { model: { code: dto.modelCode }, version: dto.version }, { populate: ['model'] });
    if (!firmware) throw new NotFoundException(`펌웨어 ${dto.modelCode} ${dto.version}이(가) 등록되지 않았습니다.`);

    const { id, offered } = await this.em.fork().transactional(async (tx) => {
      // 모델 행을 먼저 잠가 같은 모델의 배포 만들기를 줄 세운다. 잠근 뒤에 센 "진행 중 배포"라야 동시에 둘이 생기지 않는다.
      await tx.findOneOrFail(TerminalModel, firmware.model.id, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const active = await tx.count(FirmwareRollout, { firmware: { model: firmware.model.id }, status: { $in: ACTIVE_ROLLOUT_STATUSES } });
      if (active > 0) throw new BusinessError(409, 'ROLLOUT_ALREADY_ACTIVE', `모델 ${dto.modelCode}에 진행 중인 펌웨어 배포가 있습니다.`);
      const rollout = tx.create(FirmwareRollout, {
        firmware: tx.getReference(Firmware, firmware.id),
        stages: dto.stages,
        failureThreshold: dto.failureThreshold,
        minSamples: dto.minSamples,
        stageTimeoutMs: dto.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS,
        createdBy: actor,
      });
      await tx.flush();
      return { id: rollout.id, offered: await this.enterStage(tx, rollout, firmware.model.id, 0, new Date()) };
    });
    await this.offers.publish(offered, { rolloutId: id, version: firmware.version });
    return this.get(id);
  }

  /** 멈춤: 단계를 넘기지 않고, 하트비트 제안을 내린다. 이미 받은 단말기의 보고는 그대로 받는다. */
  async pause(id: number): Promise<FirmwareRollout> {
    const serials = await this.em.fork().transactional(async (tx) => {
      const rollout = await this.lockRollout(tx, id);
      if (rollout.status !== RolloutStatus.RUNNING) throw this.wrongStatus(rollout, 'ROLLOUT_NOT_RUNNING');
      rollout.status = RolloutStatus.PAUSED;
      return (await this.offeredTargets(tx, id)).map((t) => t.serialNo);
    });
    await this.offers.withdraw(id, serials);
    return this.get(id);
  }

  /** 재개: 아직 보고하지 않은 대상의 제안 시각을 지금으로 다시 잡고(멈춘 동안은 제한 시간에 넣지 않는다) 제안을 다시 건다. */
  async resume(id: number): Promise<FirmwareRollout> {
    const { serials, version } = await this.em.fork().transactional(async (tx) => {
      const rollout = await this.lockRollout(tx, id);
      if (rollout.status !== RolloutStatus.PAUSED) throw this.wrongStatus(rollout, 'ROLLOUT_NOT_PAUSED');
      const now = new Date();
      rollout.status = RolloutStatus.RUNNING;
      rollout.stageStartedAt = now;
      const offered = await this.offeredTargets(tx, id);
      // 대상 행은 PK로 갱신한다(보조 인덱스 범위 UPDATE의 gap 락을 피한다, troubleshooting/0014)
      if (offered.length > 0) {
        await tx.nativeUpdate(FirmwareRolloutTarget, { id: { $in: offered.map((t) => t.id) }, status: TargetStatus.OFFERED }, { offeredAt: now });
      }
      return { serials: offered.map((t) => t.serialNo), version: rollout.firmware.version };
    });
    await this.offers.publish(serials, { rolloutId: id, version });
    return this.get(id);
  }

  /** 운영자 중단 */
  async abort(id: number, actor: string): Promise<FirmwareRollout> {
    const serials = await this.em.fork().transactional(async (tx) => {
      const rollout = await this.lockRollout(tx, id);
      if (!ACTIVE_ROLLOUT_STATUSES.includes(rollout.status)) throw this.wrongStatus(rollout, 'ROLLOUT_FINISHED');
      this.finish(tx, rollout, RolloutStatus.ABORTED, `운영자 중단: ${actor}`);
      return (await this.offeredTargets(tx, id)).map((t) => t.serialNo);
    });
    await this.offers.withdraw(id, serials);
    return this.get(id);
  }

  async get(id: number): Promise<FirmwareRollout> {
    const rollout = await this.em.fork().findOne(FirmwareRollout, id, { populate: ['firmware.model'] });
    if (!rollout) throw new NotFoundException(`펌웨어 배포 ${id}이(가) 없습니다.`);
    return rollout;
  }

  /** 단계별 대상 수와 결과 수 */
  async stageStats(rollout: FirmwareRollout, em: EntityManager = this.em.fork()): Promise<StageStats[]> {
    const rows: { stage: number; status: TargetStatus; c: number | string }[] = await em.execute(
      'select stage, status, count(*) as c from firmware_rollout_target where rollout_id = ? group by stage, status',
      [rollout.id],
    );
    return rollout.stages.map((percent, stage) => {
      const of = (status: TargetStatus) => Number(rows.find((r) => r.stage === stage && r.status === status)?.c ?? 0);
      const s = { offered: of(TargetStatus.OFFERED), succeeded: of(TargetStatus.SUCCEEDED), failed: of(TargetStatus.FAILED), timedOut: of(TargetStatus.TIMED_OUT) };
      return { stage, percent, targets: s.offered + s.succeeded + s.failed + s.timedOut, ...s };
    });
  }

  /**
   * 단계에 들어간다: 이 모델의 운영 중 단말기 중 아직 대상이 아닌 것을 CRC32(시리얼) 순으로 골라, 누적 비율에 모자란 만큼 대상 행을 만든다.
   * 모수는 (이미 대상 + 아직 대상 아닌 운영 중 단말기)다. 대상 행 INSERT의 FK 검사는 단말기 행에 S 락을 거는데, 이 트랜잭션은
   * 단말기 행을 바꾸지 않으므로 S→X 승격이 없다. @returns 새로 제안할 시리얼(커밋 뒤 Redis에 건다)
   */
  private async enterStage(tx: EntityManager, rollout: FirmwareRollout, modelId: number, stage: number, now: Date): Promise<string[]> {
    const [{ targeted }] = await tx.execute<{ targeted: number | string }[]>(
      'select count(*) as targeted from firmware_rollout_target where rollout_id = ?',
      [rollout.id],
    );
    const candidates = await tx.execute<{ id: number; serial_no: string }[]>(
      `select t.id, t.serial_no from terminal t
        where t.model_id = ? and t.status = 'IN_SERVICE'
          and not exists (select 1 from firmware_rollout_target r where r.rollout_id = ? and r.terminal_id = t.id)
        order by crc32(t.serial_no), t.id`,
      [modelId, rollout.id],
    );
    const already = Number(targeted);
    const want = Math.ceil(((already + candidates.length) * rollout.stages[stage]) / 100) - already;
    const picked = candidates.slice(0, Math.max(0, want));
    for (const c of picked) {
      tx.create(FirmwareRolloutTarget, { rollout, terminal: tx.getReference(Terminal, c.id), stage, offeredAt: now });
    }
    rollout.currentStage = stage;
    rollout.stageStartedAt = now;
    await tx.flush();
    return picked.map((c) => c.serial_no);
  }

  /** 배포를 끝낸다(완료·중단). 알림은 같은 트랜잭션의 Outbox로 */
  private finish(tx: EntityManager, rollout: FirmwareRollout, status: RolloutStatus.COMPLETED | RolloutStatus.ABORTED, reason: string): void {
    rollout.status = status;
    rollout.finishedAt = new Date();
    rollout.endReason = reason;
    tx.create(OutboxEvent, {
      type: status === RolloutStatus.COMPLETED ? OUTBOX_TYPE.FIRMWARE_ROLLOUT_COMPLETED : OUTBOX_TYPE.FIRMWARE_ROLLOUT_ABORTED,
      payload: { rolloutId: rollout.id, version: rollout.firmware.version, stage: rollout.currentStage, reason },
    });
  }

  private async lockRollout(tx: EntityManager, id: number): Promise<FirmwareRollout> {
    const rollout = await tx.findOne(FirmwareRollout, id, { lockMode: LockMode.PESSIMISTIC_WRITE, populate: ['firmware'] });
    if (!rollout) throw new NotFoundException(`펌웨어 배포 ${id}이(가) 없습니다.`);
    return rollout;
  }

  /** 아직 보고가 없는 대상(id 순). 잠그지 않고 읽는다 — 대상 행은 PK로만 갱신한다 */
  private async offeredTargets(tx: EntityManager, rolloutId: number): Promise<{ id: number; serialNo: string; offeredAt: Date }[]> {
    const rows = await tx.execute<{ id: number; serial_no: string; offered_at: Date }[]>(
      `select r.id, t.serial_no, r.offered_at from firmware_rollout_target r join terminal t on t.id = r.terminal_id
        where r.rollout_id = ? and r.status = 'OFFERED' order by r.id`,
      [rolloutId],
    );
    return rows.map((r) => ({ id: r.id, serialNo: r.serial_no, offeredAt: new Date(r.offered_at) }));
  }

  private wrongStatus(rollout: FirmwareRollout, code: string): BusinessError {
    return new BusinessError(422, code, `펌웨어 배포 ${rollout.id}은(는) ${rollout.status} 상태라 이 작업을 할 수 없습니다.`);
  }
}

export function toRolloutView(rollout: FirmwareRollout, stats: StageStats[]) {
  return {
    id: rollout.id,
    modelCode: rollout.firmware.model.code,
    version: rollout.firmware.version,
    status: rollout.status,
    stages: rollout.stages,
    currentStage: rollout.currentStage,
    failureThreshold: rollout.failureThreshold,
    minSamples: rollout.minSamples,
    stageTimeoutMs: rollout.stageTimeoutMs,
    stageStartedAt: rollout.stageStartedAt.toISOString(),
    createdBy: rollout.createdBy,
    createdAt: rollout.createdAt.toISOString(),
    finishedAt: rollout.finishedAt?.toISOString() ?? null,
    endReason: rollout.endReason,
    stageStats: stats,
  };
}
```

`apps/api/src/firmware/firmware.controller.ts`(새):
```ts
import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { CreateRolloutDto, RegisterFirmwareDto } from './dto/firmware.dto.js';
import { FirmwareService, toFirmwareView } from './firmware.service.js';
import { RolloutService, toRolloutView } from './rollout.service.js';
import type { FirmwareRollout } from './firmware.entities.js';

/** 펌웨어 등록과 단계 배포 관리(운영자). 쓰기는 작업자 헤더가 필요하다(decisions/0001). */
@Controller()
export class FirmwareController {
  constructor(
    private readonly firmware: FirmwareService,
    private readonly rollouts: RolloutService,
  ) {}

  @Post('firmware')
  async register(@Body() dto: RegisterFirmwareDto, @Operator() actor: string) {
    return toFirmwareView(await this.firmware.register(dto, actor));
  }

  @Post('firmware-rollouts')
  async create(@Body() dto: CreateRolloutDto, @Operator() actor: string) {
    return this.view(await this.rollouts.create(dto, actor));
  }

  @Get('firmware-rollouts/:id')
  async get(@Param('id', ParseIntPipe) id: number) {
    return this.view(await this.rollouts.get(id));
  }

  @Post('firmware-rollouts/:id/pause')
  @HttpCode(200)
  async pause(@Param('id', ParseIntPipe) id: number, @Operator() _actor: string) {
    return this.view(await this.rollouts.pause(id));
  }

  @Post('firmware-rollouts/:id/resume')
  @HttpCode(200)
  async resume(@Param('id', ParseIntPipe) id: number, @Operator() _actor: string) {
    return this.view(await this.rollouts.resume(id));
  }

  @Post('firmware-rollouts/:id/abort')
  @HttpCode(200)
  async abort(@Param('id', ParseIntPipe) id: number, @Operator() actor: string) {
    return this.view(await this.rollouts.abort(id, actor));
  }

  private async view(rollout: FirmwareRollout) {
    return toRolloutView(rollout, await this.rollouts.stageStats(rollout));
  }
}
```

`apps/api/src/firmware/firmware.module.ts`(새):
```ts
import { Module } from '@nestjs/common';
import { DeviceModule } from '../device/device.module.js';
import { FirmwareController } from './firmware.controller.js';
import { FirmwareService } from './firmware.service.js';
import { RolloutService } from './rollout.service.js';

/** 펌웨어 등록·단계 배포(F8). 제안은 DeviceModule의 OfferStore(Redis)로 건다. */
@Module({
  imports: [DeviceModule],
  controllers: [FirmwareController],
  providers: [FirmwareService, RolloutService],
  exports: [RolloutService],
})
export class FirmwareModule {}
```

`apps/api/src/app.module.ts` 전체(`FirmwareModule` 추가):
```ts
import { type DynamicModule, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import ormConfig from './mikro-orm.config.js';
import { HealthController } from './health/health.controller.js';
import { DomainExceptionFilter } from './common/domain-exception.filter.js';
import { TerminalModule } from './terminal/terminal.module.js';
import { InspectionModule } from './inspection/inspection.module.js';
import { MerchantModule } from './merchant/merchant.module.js';
import { ShipmentModule } from './shipment/shipment.module.js';
import { QueuesModule } from './queue/queues.module.js';
import { RedisModule } from './redis/redis.module.js';
import { CarrierSyncModule } from './carrier-sync/carrier-sync.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { PurchaseOrderModule } from './purchase-order/purchase-order.module.js';
import { ScanModule } from './scan/scan.module.js';
import { ServiceModule } from './service/service.module.js';
import { DeviceModule } from './device/device.module.js';
import { FirmwareModule } from './firmware/firmware.module.js';
import { WorkersModule } from './workers/workers.module.js';
import { SchedulerModule } from './scheduler/scheduler.module.js';

export interface AppOptions {
  /** 큐 job을 처리할지(RUN_WORKERS) */
  workers?: boolean;
  /** 주기 작업을 등록할지(RUN_SCHEDULERS) */
  schedulers?: boolean;
}

@Module({
  // forRoot가 요청마다 EntityManager를 fork하는 RequestContext 미들웨어를 자동 등록한다.
  imports: [
    MikroOrmModule.forRoot(ormConfig),
    RedisModule,
    QueuesModule,
    TerminalModule,
    InspectionModule,
    MerchantModule,
    ShipmentModule,
    CarrierSyncModule,
    OutboxModule,
    PurchaseOrderModule,
    ScanModule,
    ServiceModule,
    DeviceModule,
    FirmwareModule,
  ],
  controllers: [HealthController],
  providers: [
    // main.ts의 useGlobalPipes/Filters는 테스트 앱에 적용되지 않는다. 모듈 provider로 등록해 테스트에서도 같게 동작시킨다.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {
  /** 실행 모드에 따라 워커·스케줄러를 붙인다. `imports: [AppModule]`만 쓰면 둘 다 없다(decisions/0015). */
  static forRoot(options: AppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [...(options.workers ? [WorkersModule] : []), ...(options.schedulers ? [SchedulerModule] : [])],
    };
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx vitest run test/firmware-rollout.e2e.spec.ts test/heartbeat.e2e.spec.ts test/unit/outbox-text.spec.ts && npx vitest run && npm run typecheck`
Expected: 세 파일 `13 passed`(동시 만들기 테스트는 매번 `[201, 409]`). 전체 `Test Files  35 passed (35)`, `Tests  228 passed (228)`, typecheck exit 0.

- [ ] **Step 5: 마이그레이션**

Run: `npm run db:migration:create`
Expected: `생성: Migration<시각>.ts`. up()은 `create table \`firmware\``(+ `firmware_model_id_index`, unique `firmware_model_id_version_unique`), `create table \`firmware_rollout\``(`stages json`, `status enum('RUNNING','PAUSED','COMPLETED','ABORTED') not null default 'RUNNING'`, `failure_threshold double`, `stage_started_at datetime(3)`, + `firmware_rollout_firmware_id_index`, `firmware_rollout_status_index`), `create table \`firmware_rollout_target\``(`status enum('OFFERED','SUCCEEDED','FAILED','TIMED_OUT') not null default 'OFFERED'`, `offered_at datetime(3)`, `reported_at datetime(3) null`, + 인덱스 `rollout_id`, `terminal_id`, `(rollout_id, stage, status)`, unique `(rollout_id, terminal_id)`)와 외래키 4개(firmware→terminal_model, rollout→firmware, target→rollout, target→terminal). 세 create table 모두 끝에 `collate utf8mb4_0900_ai_ci`. down()은 외래키 2개를 지우고 세 테이블을 drop한다(enum ALTER가 없어 손볼 곳 없음).
```bash
npm run db:migrate
npm run db:migration:check
```
Expected: `적용: Migration<시각>`, `최신 상태`

- [ ] **Step 6: 기록과 커밋**

devlog에 `## HH:MM Task 6 펌웨어 등록과 단계 배포 시작 — 대상 선정, Redis 제안, 하트비트 업데이트 지시 (F8)` 항목.

`docs/decisions/0030-펌웨어-단계-배포는-별도-테이블과-Redis-제안으로.md`:
- 상황: F8 "펌웨어 10% → 50% → 100% 단계 배포, 실패율이 높으면 자동 중단". 단말기는 하트비트로만 서버와 이야기한다(서버가 단말기를 부르지 않는다). 설계안 SN-300은 펌웨어가 잦다.
- 선택지(모델):
  1. 단말기 상태 enum에 UPDATING 등 추가 — 펌웨어 업데이트는 lifecycle이 아니고(설치된 채로 진행), enum ALTER·전이 규칙이 커진다(Day 3 리뷰 Day 4 준비 메모).
  2. **별도 테이블 3개**(firmware, firmware_rollout, firmware_rollout_target) — 배포 진행과 단말기별 결과를 따로 가진다. enum은 그대로.
- 대상 선정: 그 모델의 IN_SERVICE 단말기를 `crc32(serial_no), id` 순으로, 단계마다 **누적** 비율만큼(모수 = 이미 대상 + 아직 대상 아닌 운영 중 단말기, `ceil`). 같은 단말기 목록이면 늘 같은 순서(재현·테스트 가능, Node `zlib.crc32`와 같은 값), 시리얼 앞부분(발주번호)에 몰리지 않는다. 무작위(RAND)는 재현이 안 되고, id 순은 오래된 단말기에 몰린다.
- 제안 전달: 1) 하트비트마다 MySQL에서 OFFERED 대상 조회 — decisions/0027을 깬다. 2) **Redis HASH `fw:offers`(serialNo → {rolloutId, version}) 사본** — 하트비트 첫 왕복에 HMGET 하나 더. 원본은 대상 행(OFFERED). 사본은 **커밋 뒤** 건다(롤백된 배포의 제안이 남지 않게). 걸기 전에 죽으면 그 단계 대상은 제한 시간 뒤 TIMED_OUT(Task 7)이 된다.
- 제안 내리기: 배포 id가 같을 때만 지우는 Lua(`cjson.decode`). 중단된 배포의 늦은 삭제가 같은 단말기에 새로 생긴 다른 배포의 제안을 지우지 않게.
- 모델당 진행 중(RUNNING·PAUSED) 배포 하나: 만들 때 `terminal_model` 행을 FOR UPDATE로 먼저 잡고 센다(잠근 뒤에 센 수라야 동시에 둘이 생기지 않는다 — decisions/0023의 "열린 접수는 하나"와 같은 방식). 테스트: 동시 2건 → [201, 409].
- 멈춤·재개·중단: 배포 행 FOR UPDATE. 멈춤은 제안을 내리고(보고는 계속 받는다), 재개는 OFFERED의 offered_at을 지금으로 PK 갱신(멈춘 시간을 제한 시간에 넣지 않음)하고 제안을 다시 건다. 중단은 ABORTED + Outbox. version 컬럼은 두지 않는다(모든 변경이 FOR UPDATE 아래).
- 결과·대가: 대상 행 INSERT의 FK 검사가 단말기 행 수백 개에 S 락을 건다(이 트랜잭션은 단말기 행을 바꾸지 않아 S→X 승격 없음). 이미 그 버전인 단말기도 대상이 된다(단말기가 업데이트 없이 성공 보고하면 된다, 지금은 빼지 않음). 재개와 보고가 겹치면 이미 보고한 단말기에 제안이 다시 걸릴 수 있다 — 그 단말기가 다시 보고하면 보고 API가 제안을 내린다(Task 7, 멱등).
- 다시 볼 조건: 여러 모델을 한 번에 배포해야 할 때, 대상이 수만 대가 되어 단계 진입 INSERT가 무거워질 때, 특정 가맹점·지역부터 배포해야 할 때(선정 규칙 교체).

`docs/study/backlog.md`에 추가:
```
- [ ] 결정적 표본 고르기 — 해시(CRC32) 순서로 비율만큼, 단계 배포(카나리)에서 같은 단말기가 계속 앞 단계에 오는 장단점 (firmware/rollout.service.ts, decisions/0030)
- [ ] Redis Lua의 cjson, EVAL 안에서 조건부 삭제(비교 후 삭제) (device/offer-store.ts)
```

커밋:
```bash
git add apps/api docs
git commit -m "feat(F8): 펌웨어 등록과 단계 배포 시작(대상 선정, Redis 제안, 하트비트 업데이트 지시, 멈춤·재개·중단)" -m "Refs: docs/decisions/0030-펌웨어-단계-배포는-별도-테이블과-Redis-제안으로.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 결과 보고와 배포 판단 — 단계 넘기기·자동 중단·시간 초과, 잠금 순서 (F8)

**Files:**
- Create: `apps/api/src/common/db-datetime.ts`, `apps/api/src/firmware/firmware-report.service.ts`, `apps/api/src/firmware/firmware-report.controller.ts`
- Modify: `apps/api/src/firmware/rollout.service.ts`, `apps/api/src/firmware/dto/firmware.dto.ts`, `apps/api/src/firmware/firmware.module.ts`, `apps/api/src/device/device.processor.ts`, `apps/api/src/workers/workers.module.ts`, `apps/api/src/scheduler/job-schedulers.ts`, `apps/api/src/config/env.ts`, `.env.example`
- Test: `apps/api/test/firmware-control.e2e.spec.ts`(새), `apps/api/test/unit/db-datetime.spec.ts`(새)
- Record: devlog, `docs/decisions/0031-배포-판단은-배포-행-먼저-보고는-대상-행만.md`, `docs/troubleshooting/0016-원시-SQL-datetime이-9시간-어긋나-모두-시간-초과.md`(계획한 재현), `docs/study/backlog.md`

- 보고 `POST /devices/firmware-reports { serialNo, rolloutId, success, version }`(작업자 헤더 없음): 대상 id를 잠그지 않고 읽고 `UPDATE … WHERE id=? AND status='OFFERED'`(PK). 0행이면 지금 상태를 돌려준다(`alreadyReported: true`, 멱등). 결과와 상관없이 그 배포의 제안을 내리고, 새로 성공이면 Redis fw를 바꾼다. 대상이 아니면 404. **배포 행은 잠그지 않는다.**
- `RolloutService.control(id, now)`: ① 배포 행 FOR UPDATE ② 지금 단계 OFFERED 중 제한 시간이 지난 것 → TIMED_OUT(PK `IN`, 상태 조건) ③ 실패율(시간 초과 포함) > 기준이고 (결과 ≥ minSamples 또는 남은 OFFERED 0) → ABORTED + Outbox + 남은 제안 모두 내림 / 남은 OFFERED 있음 → WAITING / 마지막 단계 → COMPLETED + Outbox / 아니면 다음 단계 대상 INSERT + `firmware.stage_advanced` + 커밋 뒤 제안. `controlAll(now)`는 RUNNING마다 따로 트랜잭션. 주기 작업 `rollout-control`(5초).
- 원시 SQL로 읽은 `offered_at`은 UTC 글자다 → `fromDbDatetime`. Step 4에서 이 함수 없이 먼저 돌려 보고(계획한 재현) troubleshooting/0016으로 남긴다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/api/test/firmware-control.e2e.spec.ts`(새):
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LockMode } from '@mikro-orm/mysql';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../src/device/active-set.service.js';
import { deviceKeys } from '../src/device/device-keys.js';
import { FirmwareRollout, FirmwareRolloutTarget, RolloutStatus, TargetStatus } from '../src/firmware/firmware.entities.js';
import { RolloutService } from '../src/firmware/rollout.service.js';
import { OutboxEvent } from '../src/outbox/outbox-event.entity.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { rolloutOrder, seedInService } from './helpers/device-fleet.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'han' };

describe('펌웨어 결과 보고와 배포 판단 — 단계 넘기기·자동 중단·시간 초과 (F8, decisions/0031)', () => {
  let t: TestApp;
  let redis: Redis;
  let rollouts: RolloutService;
  let serials: string[];
  let version = 0;
  const em = () => t.orm.em.fork();
  const offers = () => redis.hgetall(deviceKeys().offers);
  const report = (serialNo: string, rolloutId: number, success: boolean, v = 'x') =>
    t.http().post('/devices/firmware-reports').send({ serialNo, rolloutId, success, version: v });
  /** 새 버전을 등록하고 배포를 시작한다 */
  async function start(body: Record<string, unknown>) {
    version += 1;
    const v = `3.0.${version}`;
    await t.http().post('/firmware').set(OP).send({ modelCode: 'SN-100', version: v });
    const res = await t.http().post('/firmware-rollouts').set(OP).send({ modelCode: 'SN-100', version: v, failureThreshold: 0.2, minSamples: 3, ...body });
    expect(res.status).toBe(201);
    return { id: res.body.id as number, version: v };
  }
  /** 지금 제안이 걸린 단말기들이 보고한다. fail(시리얼)이 참이면 실패 */
  async function reportOffered(rolloutId: number, v: string, fail: (serialNo: string) => boolean = () => false) {
    const offered = Object.keys(await offers());
    for (const s of offered) expect((await report(s, rolloutId, !fail(s), v)).status).toBe(200);
    return offered;
  }

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    rollouts = t.app.get(RolloutService);
    await resetDatabase(t.orm);
    serials = await seedInService(t, 'FC', 20);
    await deleteTestKeys(redis, 'hb:');
    await t.app.get(ActiveSetService).rebuild();
  });
  beforeEach(async () => {
    await em().nativeUpdate(FirmwareRollout, { status: { $in: [RolloutStatus.RUNNING, RolloutStatus.PAUSED] } }, { status: RolloutStatus.ABORTED });
    await redis.del(deviceKeys().offers, deviceKeys().firmware);
  });
  afterAll(async () => {
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('보고: 대상 행만 SUCCEEDED로, 제안을 내리고 Redis 펌웨어를 바꾼다. 다시 보고해도 그대로(멱등). 대상이 아니면 404', async () => {
    const { id, version: v } = await start({ stages: [10, 100] });
    const [first] = rolloutOrder(serials);
    const ok = await report(first, id, true, v);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ serialNo: first, rolloutId: id, status: 'SUCCEEDED', alreadyReported: false });
    expect((await offers())[first]).toBeUndefined();
    expect(await redis.hget(deviceKeys().firmware, first)).toBe(v);
    const target = await em().findOneOrFail(FirmwareRolloutTarget, { rollout: id, terminal: { serialNo: first } });
    expect(target).toMatchObject({ status: TargetStatus.SUCCEEDED, reportedVersion: v });
    expect(target.reportedAt).toBeInstanceOf(Date);

    const again = await report(first, id, false, v);
    expect(again.body).toEqual({ serialNo: first, rolloutId: id, status: 'SUCCEEDED', alreadyReported: true });
    const notTarget = rolloutOrder(serials).at(-1)!;
    expect((await report(notTarget, id, true, v)).status).toBe(404);
    expect((await t.http().post('/devices/firmware-reports').send({ serialNo: first, rolloutId: id, success: 'yes', version: v })).status).toBe(400);
  });

  it('모두 성공하면 단계를 넘기고(누적 비율만큼 대상 추가·알림), 마지막 단계가 끝나면 COMPLETED', async () => {
    const { id, version: v } = await start({ stages: [10, 50, 100] });
    expect((await rollouts.control(id)).action).toBe('WAITING'); // 아직 보고 없음
    expect(await reportOffered(id, v)).toHaveLength(2);

    expect(await rollouts.control(id)).toEqual({ rolloutId: id, action: 'ADVANCED', stage: 1, timedOut: 0 });
    expect(Object.keys(await offers())).toHaveLength(8); // 50% = 10대, 이미 2대
    expect(Object.keys(await offers()).sort()).toEqual(rolloutOrder(serials).slice(2, 10).sort());
    await reportOffered(id, v);
    expect((await rollouts.control(id)).action).toBe('ADVANCED');
    await reportOffered(id, v);
    expect((await rollouts.control(id)).action).toBe('COMPLETED');

    const view = (await t.http().get(`/firmware-rollouts/${id}`)).body;
    expect(view).toMatchObject({ status: 'COMPLETED', currentStage: 2, endReason: '마지막 단계 완료' });
    expect(view.stageStats.map((s: { targets: number; succeeded: number }) => [s.targets, s.succeeded])).toEqual([
      [2, 2],
      [8, 8],
      [10, 10],
    ]);
    expect(await offers()).toEqual({});
    const types = (await em().find(OutboxEvent, { type: { $like: 'firmware.%' }, payload: { rolloutId: id } }, { orderBy: { id: 'asc' } })).map((e) => e.type);
    expect(types).toEqual(['firmware.stage_advanced', 'firmware.stage_advanced', 'firmware.rollout_completed']);
    expect((await rollouts.control(id)).action).toBe('NONE');
  });

  it('실패율이 기준을 넘고 결과가 minSamples 이상이면 자동 중단: 남은 제안을 모두 내린다', async () => {
    const { id, version: v } = await start({ stages: [50, 100], failureThreshold: 0.2, minSamples: 3 });
    const offered = Object.keys(await offers());
    expect(offered).toHaveLength(10);
    // 2건 실패: 결과 2 < minSamples 3이라 아직 기다린다
    await report(offered[0], id, false, v);
    await report(offered[1], id, false, v);
    expect((await rollouts.control(id)).action).toBe('WAITING');
    await report(offered[2], id, true, v);
    const r = await rollouts.control(id);
    expect(r.action).toBe('ABORTED');

    const rollout = await em().findOneOrFail(FirmwareRollout, id);
    expect(rollout.status).toBe(RolloutStatus.ABORTED);
    expect(rollout.endReason).toBe('자동 중단: 1단계 실패율 66.7% (2/3) > 기준 20%');
    expect(await offers()).toEqual({}); // 보고하지 않은 7대의 제안도 내림
    const beat = await t.http().post('/devices/heartbeats').send({ items: [{ serialNo: offered[5], firmwareVersion: '1.0.0' }] });
    expect(beat.body.results[0].update).toBeUndefined();
    expect((await em().find(OutboxEvent, { type: 'firmware.rollout_aborted', payload: { rolloutId: id } })).length).toBe(1);
  });

  it('제한 시간 안에 보고가 없으면 TIMED_OUT(실패로 셈)으로 바꾸고 그 제안을 내린다', async () => {
    const { id } = await start({ stages: [10, 100], failureThreshold: 1, stageTimeoutMs: 1_000 });
    const offered = Object.keys(await offers());
    expect((await rollouts.control(id, new Date(Date.now() + 500))).action).toBe('WAITING');
    const r = await rollouts.control(id, new Date(Date.now() + 2_000));
    expect(r).toEqual({ rolloutId: id, action: 'ADVANCED', stage: 1, timedOut: 2 }); // 기준 100%라 중단하지 않고 넘어간다
    const timedOut = await em().find(FirmwareRolloutTarget, { rollout: id, status: TargetStatus.TIMED_OUT }, { populate: ['terminal'] });
    expect(timedOut.map((x) => x.terminal.serialNo).sort()).toEqual([...offered].sort());
    const now = Object.keys(await offers());
    expect(now).toHaveLength(18);
    expect(now.some((s) => offered.includes(s))).toBe(false);
  });

  it('보고는 배포 행을 잠그지 않는다: 배포 행 FOR UPDATE를 쥔 트랜잭션이 있어도 바로 끝난다', async () => {
    const { id, version: v } = await start({ stages: [10, 100] });
    const [first] = Object.keys(await offers());
    const holder = t.orm.em.fork();
    await holder.begin();
    try {
      await holder.findOneOrFail(FirmwareRollout, id, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const started = Date.now();
      const res = await report(first, id, true, v);
      const ms = Date.now() - started;
      console.log(`[보고 중 배포 행 잠금] ${res.status} ${ms}ms`);
      expect(res.status).toBe(200);
      expect(ms).toBeLessThan(1_000);
    } finally {
      await holder.rollback();
    }
  });

  it('멈춘 배포는 판단하지 않는다(NONE), controlAll은 RUNNING만 돈다', async () => {
    const { id } = await start({ stages: [10, 100] });
    await t.http().post(`/firmware-rollouts/${id}/pause`).set(OP);
    expect((await rollouts.control(id)).action).toBe('NONE');
    expect((await rollouts.controlAll()).map((r) => r.rolloutId)).not.toContain(id);
  });
});
```

`apps/api/test/unit/db-datetime.spec.ts`(새):
```ts
import { describe, expect, it } from 'vitest';
import { fromDbDatetime } from '../../src/common/db-datetime.js';

describe('fromDbDatetime', () => {
  it('원시 SQL의 datetime 글자는 UTC로 읽는다(서버 지역 시간이 아니라)', () => {
    expect(fromDbDatetime('2026-10-23 09:29:15.606').toISOString()).toBe('2026-10-23T09:29:15.606Z');
    expect(fromDbDatetime('2026-10-23 09:29:15').toISOString()).toBe('2026-10-23T09:29:15.000Z');
  });

  it('이미 Date면 그대로', () => {
    const d = new Date('2026-10-23T00:00:00Z');
    expect(fromDbDatetime(d)).toBe(d);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run test/firmware-control.e2e.spec.ts test/unit/db-datetime.spec.ts`
Expected: `Test Files  2 failed (2)`. db-datetime은 `../../src/common/db-datetime.js`를 찾지 못해 로드 실패. firmware-control은 `Tests  6 failed (6)`: 보고 테스트 2개 `expected 404 to be 200`(라우트 없음), 나머지 `TypeError: rollouts.control is not a function`.

- [ ] **Step 3: 구현**

`apps/api/src/common/db-datetime.ts`(새):
```ts
/**
 * 원시 SQL(em.execute) 결과의 datetime 글자를 Date로 바꾼다.
 * MikroORM 7은 forceUtcTimezone(기본 켜짐)으로 날짜를 **UTC**로 쓰고, 원시 결과는 dateStrings라 'YYYY-MM-DD HH:mm:ss.SSS'
 * 글자(시간대 표시 없음)로 돌려준다. `new Date(글자)`는 이것을 서버 지역 시간(KST)으로 읽어 9시간 어긋난다(사전 검증).
 * 엔티티로 읽는 값은 MikroORM이 바꿔 주므로 이 함수가 필요 없다. SQL 안에서 NOW()와 비교하지 않는 것도 같은 이유다(세션 시간대 SYSTEM).
 */
export function fromDbDatetime(value: string | Date): Date {
  if (value instanceof Date) return value;
  return new Date(`${value.replace(' ', 'T')}Z`);
}
```

`apps/api/src/firmware/dto/firmware.dto.ts` 전체(`FirmwareReportDto` 추가):
```ts
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { FIRMWARE_VERSION_PATTERN } from '../../device/heartbeat.service.js';
import { SERIAL_NO_MESSAGE, SERIAL_NO_PATTERN } from '../../terminal/bulk-rows.js';

const VERSION_MESSAGE = 'version은 영문·숫자·점·하이픈 1~20자입니다.';

export class RegisterFirmwareDto {
  @IsString()
  modelCode!: string;

  @Matches(FIRMWARE_VERSION_PATTERN, { message: VERSION_MESSAGE })
  version!: string;
}

export class CreateRolloutDto {
  @IsString()
  modelCode!: string;

  @Matches(FIRMWARE_VERSION_PATTERN, { message: VERSION_MESSAGE })
  version!: string;

  /** 단계별 누적 비율(%). 커지는 순서, 마지막은 100 (서비스가 확인) */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(100, { each: true })
  stages!: number[];

  @IsNumber()
  @Min(0)
  @Max(1)
  failureThreshold!: number;

  @IsInt()
  @Min(1)
  minSamples!: number;

  /** 단계 안에서 보고를 기다리는 시간(ms). 기본 10분 */
  @IsOptional()
  @IsInt()
  @Min(1)
  stageTimeoutMs?: number;
}

/** 단말기의 업데이트 결과 보고 */
export class FirmwareReportDto {
  @Matches(SERIAL_NO_PATTERN, { message: SERIAL_NO_MESSAGE })
  serialNo!: string;

  @IsInt()
  @Min(1)
  rolloutId!: number;

  @IsBoolean()
  success!: boolean;

  @Matches(FIRMWARE_VERSION_PATTERN, { message: VERSION_MESSAGE })
  version!: string;
}
```

`apps/api/src/firmware/firmware-report.service.ts`(새):
```ts
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { Redis } from 'ioredis';
import { deviceKeys } from '../device/device-keys.js';
import { OfferStore } from '../device/offer-store.js';
import { REDIS } from '../redis/redis.provider.js';
import type { FirmwareReportDto } from './dto/firmware.dto.js';
import { FirmwareRolloutTarget, TargetStatus } from './firmware.entities.js';

export interface ReportResult {
  serialNo: string;
  rolloutId: number;
  /** 보고 뒤 대상 상태 */
  status: TargetStatus;
  /** 이미 보고됐거나 시간 초과였던 대상이라 바꾸지 않았다 */
  alreadyReported: boolean;
}

/**
 * 단말기의 펌웨어 업데이트 결과 보고(F8). 대상 행 하나만 PK + 상태 조건(OFFERED)으로 갱신한다 — 배포 행은 잠그지 않는다
 * (배포 판단 job이 배포 행 → 대상 행 순서로 잠그므로, 보고가 배포 행을 기다리거나 순환 대기를 만들지 않는다, decisions/0031).
 * 이미 보고됐거나 TIMED_OUT이면 그대로 두고 지금 상태를 돌려준다(멱등, 단말기 재전송 안전).
 * 제안은 결과와 상관없이 내린다(실패한 단말기에 같은 버전을 다시 권하지 않는다). 성공이면 Redis 펌웨어 버전도 바로 바꾼다.
 */
@Injectable()
export class FirmwareReportService {
  constructor(
    private readonly em: EntityManager,
    private readonly offers: OfferStore,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async report(dto: FirmwareReportDto): Promise<ReportResult> {
    const em = this.em.fork();
    const [target] = await em.execute<{ id: number; status: TargetStatus }[]>(
      `select r.id, r.status from firmware_rollout_target r join terminal t on t.id = r.terminal_id
        where r.rollout_id = ? and t.serial_no = ?`,
      [dto.rolloutId, dto.serialNo],
    );
    if (!target) throw new NotFoundException(`배포 ${dto.rolloutId}에 단말기 ${dto.serialNo}이(가) 대상으로 없습니다.`);

    const status = dto.success ? TargetStatus.SUCCEEDED : TargetStatus.FAILED;
    const changed = await em.nativeUpdate(
      FirmwareRolloutTarget,
      { id: target.id, status: TargetStatus.OFFERED },
      { status, reportedAt: new Date(), reportedVersion: dto.version },
    );
    await this.offers.withdraw(dto.rolloutId, [dto.serialNo]);
    if (changed > 0 && dto.success) await this.redis.hset(deviceKeys().firmware, dto.serialNo, dto.version);
    return { serialNo: dto.serialNo, rolloutId: dto.rolloutId, status: changed > 0 ? status : target.status, alreadyReported: changed === 0 };
  }
}
```

`apps/api/src/firmware/firmware-report.controller.ts`(새):
```ts
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { FirmwareReportDto } from './dto/firmware.dto.js';
import { FirmwareReportService } from './firmware-report.service.js';

/** 단말기가 부르는 API(하트비트와 같이 작업자 헤더 없음) */
@Controller('devices')
export class FirmwareReportController {
  constructor(private readonly reports: FirmwareReportService) {}

  @Post('firmware-reports')
  @HttpCode(200)
  async report(@Body() dto: FirmwareReportDto) {
    return this.reports.report(dto);
  }
}
```

`apps/api/src/firmware/firmware.module.ts` 전체:
```ts
import { Module } from '@nestjs/common';
import { DeviceModule } from '../device/device.module.js';
import { FirmwareReportController } from './firmware-report.controller.js';
import { FirmwareReportService } from './firmware-report.service.js';
import { FirmwareController } from './firmware.controller.js';
import { FirmwareService } from './firmware.service.js';
import { RolloutService } from './rollout.service.js';

/** 펌웨어 등록·단계 배포(F8). 제안은 DeviceModule의 OfferStore(Redis)로 건다. */
@Module({
  imports: [DeviceModule],
  controllers: [FirmwareController, FirmwareReportController],
  providers: [FirmwareService, RolloutService, FirmwareReportService],
  exports: [RolloutService],
})
export class FirmwareModule {}
```

`apps/api/src/firmware/rollout.service.ts` 전체(`ControlResult`, `controlAll`, `control`, `offeredTargets`에 stage와 `fromDbDatetime`):
```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { fromDbDatetime } from '../common/db-datetime.js';
import { BusinessError } from '../common/domain-errors.js';
import { OfferStore } from '../device/offer-store.js';
import { OUTBOX_TYPE, OutboxEvent } from '../outbox/outbox-event.entity.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalModel } from '../terminal/terminal-model.entity.js';
import type { CreateRolloutDto } from './dto/firmware.dto.js';
import { ACTIVE_ROLLOUT_STATUSES, Firmware, FirmwareRollout, FirmwareRolloutTarget, RolloutStatus, TargetStatus } from './firmware.entities.js';

/** 단계 제한 시간 기본값(10분) */
export const DEFAULT_STAGE_TIMEOUT_MS = 10 * 60_000;

export type ControlAction = 'NONE' | 'WAITING' | 'ADVANCED' | 'COMPLETED' | 'ABORTED';

export interface ControlResult {
  rolloutId: number;
  action: ControlAction;
  /** 판단한 단계(넘어갔으면 새 단계) */
  stage: number;
  /** 이번에 제한 시간이 지나 TIMED_OUT으로 바꾼 대상 수 */
  timedOut: number;
}

export interface StageStats {
  stage: number;
  percent: number;
  targets: number;
  offered: number;
  succeeded: number;
  failed: number;
  timedOut: number;
}

/** 단계 비율은 1~100, 커지는 순서, 마지막은 100 */
export function checkStages(stages: number[]): string | null {
  if (stages.some((p, i) => i > 0 && p <= stages[i - 1])) return 'stages는 커지는 순서여야 합니다(누적 비율).';
  if (stages.at(-1) !== 100) return 'stages의 마지막은 100이어야 합니다.';
  return null;
}

/**
 * 펌웨어 단계 배포(F8, decisions/0030). 단계에 들어갈 때 대상 단말기를 고르고(해당 모델의 운영 중 단말기, 시리얼 CRC32 순 —
 * 같은 단말기 목록이면 늘 같은 순서) 대상 행을 만든 뒤, **커밋 뒤에** Redis에 제안을 건다(하트비트 응답의 빠른 길).
 * 배포 행이 잠금 단위다: 만들기는 모델 행, 나머지(멈춤·재개·중단, 단계 넘기기)는 배포 행을 FOR UPDATE로 먼저 잡는다(decisions/0031).
 */
@Injectable()
export class RolloutService {
  constructor(
    private readonly em: EntityManager,
    private readonly offers: OfferStore,
  ) {}

  async create(dto: CreateRolloutDto, actor: string): Promise<FirmwareRollout> {
    const invalid = checkStages(dto.stages);
    if (invalid) throw new BadRequestException({ statusCode: 400, code: 'INVALID_STAGES', message: invalid });
    const firmware = await this.em.fork().findOne(Firmware, { model: { code: dto.modelCode }, version: dto.version }, { populate: ['model'] });
    if (!firmware) throw new NotFoundException(`펌웨어 ${dto.modelCode} ${dto.version}이(가) 등록되지 않았습니다.`);

    const { id, offered } = await this.em.fork().transactional(async (tx) => {
      // 모델 행을 먼저 잠가 같은 모델의 배포 만들기를 줄 세운다. 잠근 뒤에 센 "진행 중 배포"라야 동시에 둘이 생기지 않는다.
      await tx.findOneOrFail(TerminalModel, firmware.model.id, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const active = await tx.count(FirmwareRollout, { firmware: { model: firmware.model.id }, status: { $in: ACTIVE_ROLLOUT_STATUSES } });
      if (active > 0) throw new BusinessError(409, 'ROLLOUT_ALREADY_ACTIVE', `모델 ${dto.modelCode}에 진행 중인 펌웨어 배포가 있습니다.`);
      const rollout = tx.create(FirmwareRollout, {
        firmware: tx.getReference(Firmware, firmware.id),
        stages: dto.stages,
        failureThreshold: dto.failureThreshold,
        minSamples: dto.minSamples,
        stageTimeoutMs: dto.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS,
        createdBy: actor,
      });
      await tx.flush();
      return { id: rollout.id, offered: await this.enterStage(tx, rollout, firmware.model.id, 0, new Date()) };
    });
    await this.offers.publish(offered, { rolloutId: id, version: firmware.version });
    return this.get(id);
  }

  /** 멈춤: 단계를 넘기지 않고, 하트비트 제안을 내린다. 이미 받은 단말기의 보고는 그대로 받는다. */
  async pause(id: number): Promise<FirmwareRollout> {
    const serials = await this.em.fork().transactional(async (tx) => {
      const rollout = await this.lockRollout(tx, id);
      if (rollout.status !== RolloutStatus.RUNNING) throw this.wrongStatus(rollout, 'ROLLOUT_NOT_RUNNING');
      rollout.status = RolloutStatus.PAUSED;
      return (await this.offeredTargets(tx, id)).map((t) => t.serialNo);
    });
    await this.offers.withdraw(id, serials);
    return this.get(id);
  }

  /** 재개: 아직 보고하지 않은 대상의 제안 시각을 지금으로 다시 잡고(멈춘 동안은 제한 시간에 넣지 않는다) 제안을 다시 건다. */
  async resume(id: number): Promise<FirmwareRollout> {
    const { serials, version } = await this.em.fork().transactional(async (tx) => {
      const rollout = await this.lockRollout(tx, id);
      if (rollout.status !== RolloutStatus.PAUSED) throw this.wrongStatus(rollout, 'ROLLOUT_NOT_PAUSED');
      const now = new Date();
      rollout.status = RolloutStatus.RUNNING;
      rollout.stageStartedAt = now;
      const offered = await this.offeredTargets(tx, id);
      // 대상 행은 PK로 갱신한다(보조 인덱스 범위 UPDATE의 gap 락을 피한다, troubleshooting/0014)
      if (offered.length > 0) {
        await tx.nativeUpdate(FirmwareRolloutTarget, { id: { $in: offered.map((t) => t.id) }, status: TargetStatus.OFFERED }, { offeredAt: now });
      }
      return { serials: offered.map((t) => t.serialNo), version: rollout.firmware.version };
    });
    await this.offers.publish(serials, { rolloutId: id, version });
    return this.get(id);
  }

  /** 운영자 중단 */
  async abort(id: number, actor: string): Promise<FirmwareRollout> {
    const serials = await this.em.fork().transactional(async (tx) => {
      const rollout = await this.lockRollout(tx, id);
      if (!ACTIVE_ROLLOUT_STATUSES.includes(rollout.status)) throw this.wrongStatus(rollout, 'ROLLOUT_FINISHED');
      this.finish(tx, rollout, RolloutStatus.ABORTED, `운영자 중단: ${actor}`);
      return (await this.offeredTargets(tx, id)).map((t) => t.serialNo);
    });
    await this.offers.withdraw(id, serials);
    return this.get(id);
  }

  /** 진행 중(RUNNING)인 배포마다 control. 배포마다 따로 트랜잭션이다. 주기 작업(rollout-control)이 부른다. */
  async controlAll(now = new Date()): Promise<ControlResult[]> {
    const running = await this.em.fork().find(FirmwareRollout, { status: RolloutStatus.RUNNING }, { fields: ['id'], orderBy: { id: 'asc' } });
    const results: ControlResult[] = [];
    for (const r of running) results.push(await this.control(r.id, now));
    return results;
  }

  /**
   * 배포 한 건을 한 번 판단한다(decisions/0031). 잠금 순서: ① 배포 행 FOR UPDATE ② 대상 행(PK로 갱신·새로 INSERT).
   * 보고 API는 대상 행 하나만 PK로 바꾸고 배포 행은 잠그지 않는다 — 보고는 배포 행을 기다리지 않고, 순환 대기가 생기지 않는다.
   * 여러 프로세스가 동시에 불러도 배포 행 잠금에서 줄을 서고, 뒤에 온 쪽은 앞쪽이 바꾼 상태(새 단계 등)를 보고 판단한다.
   * 1. 지금 단계의 OFFERED 중 제한 시간이 지난 것 → TIMED_OUT(id 순, PK 갱신)
   * 2. 실패율 = (FAILED + TIMED_OUT) / (SUCCEEDED + FAILED + TIMED_OUT). 기준을 넘고, 결과가 minSamples 이상이거나 단계가 다 끝났으면
   *    → ABORTED(Outbox 알림), 남은 제안을 모두 내린다.
   * 3. 남은 OFFERED가 없으면 다음 단계(대상 INSERT, 알림) 또는 마지막 단계면 COMPLETED(알림).
   * Redis 제안 걸기·내리기는 커밋 뒤에 한다(트랜잭션 안에서 외부 저장소를 기다리지 않는다).
   */
  async control(id: number, now = new Date()): Promise<ControlResult> {
    const { result, publish, withdraw, version } = await this.em.fork().transactional(async (tx) => {
      const rollout = await this.lockRollout(tx, id);
      const version = rollout.firmware.version;
      const base = { rolloutId: id, stage: rollout.currentStage, timedOut: 0 };
      if (rollout.status !== RolloutStatus.RUNNING) return { result: { ...base, action: 'NONE' as const }, publish: [], withdraw: [], version };

      const offered = (await this.offeredTargets(tx, id)).filter((t) => t.stage === rollout.currentStage);
      const expired = offered.filter((t) => t.offeredAt.getTime() + rollout.stageTimeoutMs <= now.getTime());
      if (expired.length > 0) {
        await tx.nativeUpdate(FirmwareRolloutTarget, { id: { $in: expired.map((t) => t.id) }, status: TargetStatus.OFFERED }, { status: TargetStatus.TIMED_OUT });
      }
      const s = (await this.stageStats(rollout, tx))[rollout.currentStage];
      const failures = s.failed + s.timedOut;
      const decided = s.succeeded + failures;
      const timedOut = { ...base, timedOut: expired.length };
      const expiredSerials = expired.map((t) => t.serialNo);

      if (decided > 0 && failures / decided > rollout.failureThreshold && (decided >= rollout.minSamples || s.offered === 0)) {
        const pct = (n: number) => Math.round(n * 1000) / 10;
        this.finish(
          tx,
          rollout,
          RolloutStatus.ABORTED,
          `자동 중단: ${rollout.currentStage + 1}단계 실패율 ${pct(failures / decided)}% (${failures}/${decided}) > 기준 ${pct(rollout.failureThreshold)}%`,
        );
        const remaining = (await this.offeredTargets(tx, id)).map((t) => t.serialNo);
        return { result: { ...timedOut, action: 'ABORTED' as const }, publish: [], withdraw: [...expiredSerials, ...remaining], version };
      }
      if (s.offered > 0) return { result: { ...timedOut, action: 'WAITING' as const }, publish: [], withdraw: expiredSerials, version };
      if (rollout.currentStage === rollout.stages.length - 1) {
        this.finish(tx, rollout, RolloutStatus.COMPLETED, '마지막 단계 완료');
        return { result: { ...timedOut, action: 'COMPLETED' as const }, publish: [], withdraw: expiredSerials, version };
      }
      const next = rollout.currentStage + 1;
      const fresh = await this.enterStage(tx, rollout, rollout.firmware.model.id, next, now);
      tx.create(OutboxEvent, {
        type: OUTBOX_TYPE.FIRMWARE_STAGE_ADVANCED,
        payload: { rolloutId: id, version, stage: next, percent: rollout.stages[next], targets: fresh.length },
      });
      return { result: { ...timedOut, stage: next, action: 'ADVANCED' as const }, publish: fresh, withdraw: expiredSerials, version };
    });
    if (withdraw.length > 0) await this.offers.withdraw(id, withdraw);
    if (publish.length > 0) await this.offers.publish(publish, { rolloutId: id, version });
    return result;
  }

  async get(id: number): Promise<FirmwareRollout> {
    const rollout = await this.em.fork().findOne(FirmwareRollout, id, { populate: ['firmware.model'] });
    if (!rollout) throw new NotFoundException(`펌웨어 배포 ${id}이(가) 없습니다.`);
    return rollout;
  }

  /** 단계별 대상 수와 결과 수 */
  async stageStats(rollout: FirmwareRollout, em: EntityManager = this.em.fork()): Promise<StageStats[]> {
    const rows: { stage: number; status: TargetStatus; c: number | string }[] = await em.execute(
      'select stage, status, count(*) as c from firmware_rollout_target where rollout_id = ? group by stage, status',
      [rollout.id],
    );
    return rollout.stages.map((percent, stage) => {
      const of = (status: TargetStatus) => Number(rows.find((r) => r.stage === stage && r.status === status)?.c ?? 0);
      const s = { offered: of(TargetStatus.OFFERED), succeeded: of(TargetStatus.SUCCEEDED), failed: of(TargetStatus.FAILED), timedOut: of(TargetStatus.TIMED_OUT) };
      return { stage, percent, targets: s.offered + s.succeeded + s.failed + s.timedOut, ...s };
    });
  }

  /**
   * 단계에 들어간다: 이 모델의 운영 중 단말기 중 아직 대상이 아닌 것을 CRC32(시리얼) 순으로 골라, 누적 비율에 모자란 만큼 대상 행을 만든다.
   * 모수는 (이미 대상 + 아직 대상 아닌 운영 중 단말기)다. 대상 행 INSERT의 FK 검사는 단말기 행에 S 락을 거는데, 이 트랜잭션은
   * 단말기 행을 바꾸지 않으므로 S→X 승격이 없다. @returns 새로 제안할 시리얼(커밋 뒤 Redis에 건다)
   */
  private async enterStage(tx: EntityManager, rollout: FirmwareRollout, modelId: number, stage: number, now: Date): Promise<string[]> {
    const [{ targeted }] = await tx.execute<{ targeted: number | string }[]>(
      'select count(*) as targeted from firmware_rollout_target where rollout_id = ?',
      [rollout.id],
    );
    const candidates = await tx.execute<{ id: number; serial_no: string }[]>(
      `select t.id, t.serial_no from terminal t
        where t.model_id = ? and t.status = 'IN_SERVICE'
          and not exists (select 1 from firmware_rollout_target r where r.rollout_id = ? and r.terminal_id = t.id)
        order by crc32(t.serial_no), t.id`,
      [modelId, rollout.id],
    );
    const already = Number(targeted);
    const want = Math.ceil(((already + candidates.length) * rollout.stages[stage]) / 100) - already;
    const picked = candidates.slice(0, Math.max(0, want));
    for (const c of picked) {
      tx.create(FirmwareRolloutTarget, { rollout, terminal: tx.getReference(Terminal, c.id), stage, offeredAt: now });
    }
    rollout.currentStage = stage;
    rollout.stageStartedAt = now;
    await tx.flush();
    return picked.map((c) => c.serial_no);
  }

  /** 배포를 끝낸다(완료·중단). 알림은 같은 트랜잭션의 Outbox로 */
  private finish(tx: EntityManager, rollout: FirmwareRollout, status: RolloutStatus.COMPLETED | RolloutStatus.ABORTED, reason: string): void {
    rollout.status = status;
    rollout.finishedAt = new Date();
    rollout.endReason = reason;
    tx.create(OutboxEvent, {
      type: status === RolloutStatus.COMPLETED ? OUTBOX_TYPE.FIRMWARE_ROLLOUT_COMPLETED : OUTBOX_TYPE.FIRMWARE_ROLLOUT_ABORTED,
      payload: { rolloutId: rollout.id, version: rollout.firmware.version, stage: rollout.currentStage, reason },
    });
  }

  private async lockRollout(tx: EntityManager, id: number): Promise<FirmwareRollout> {
    const rollout = await tx.findOne(FirmwareRollout, id, { lockMode: LockMode.PESSIMISTIC_WRITE, populate: ['firmware'] });
    if (!rollout) throw new NotFoundException(`펌웨어 배포 ${id}이(가) 없습니다.`);
    return rollout;
  }

  /** 아직 보고가 없는 대상(id 순). 잠그지 않고 읽는다 — 대상 행은 PK로만 갱신한다 */
  private async offeredTargets(tx: EntityManager, rolloutId: number): Promise<{ id: number; serialNo: string; stage: number; offeredAt: Date }[]> {
    const rows = await tx.execute<{ id: number; serial_no: string; stage: number; offered_at: string }[]>(
      `select r.id, t.serial_no, r.stage, r.offered_at from firmware_rollout_target r join terminal t on t.id = r.terminal_id
        where r.rollout_id = ? and r.status = 'OFFERED' order by r.id`,
      [rolloutId],
    );
    return rows.map((r) => ({ id: r.id, serialNo: r.serial_no, stage: r.stage, offeredAt: fromDbDatetime(r.offered_at) }));
  }

  private wrongStatus(rollout: FirmwareRollout, code: string): BusinessError {
    return new BusinessError(422, code, `펌웨어 배포 ${rollout.id}은(는) ${rollout.status} 상태라 이 작업을 할 수 없습니다.`);
  }
}

export function toRolloutView(rollout: FirmwareRollout, stats: StageStats[]) {
  return {
    id: rollout.id,
    modelCode: rollout.firmware.model.code,
    version: rollout.firmware.version,
    status: rollout.status,
    stages: rollout.stages,
    currentStage: rollout.currentStage,
    failureThreshold: rollout.failureThreshold,
    minSamples: rollout.minSamples,
    stageTimeoutMs: rollout.stageTimeoutMs,
    stageStartedAt: rollout.stageStartedAt.toISOString(),
    createdBy: rollout.createdBy,
    createdAt: rollout.createdAt.toISOString(),
    finishedAt: rollout.finishedAt?.toISOString() ?? null,
    endReason: rollout.endReason,
    stageStats: stats,
  };
}
```

`apps/api/src/config/env.ts` 전체(`rolloutControlIntervalMs`):
```ts
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 스크립트·테스트는 apps/api에서 실행한다. 저장소 루트의 .env를 읽는다(이미 있는 환경변수는 덮어쓰지 않는다).
const envFile = resolve(process.cwd(), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경변수 ${name}가 없습니다. 저장소 루트 .env를 확인하세요.`);
  return value;
}

function flag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  return value === undefined ? fallback : value === '1' || value === 'true';
}

const isTest = process.env.NODE_ENV === 'test';

export const env = {
  port: Number(process.env.API_PORT ?? 3000),
  mysql: {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: required('MYSQL_USER'),
    password: required('MYSQL_PASSWORD'),
    dbName: isTest ? required('MYSQL_TEST_DATABASE') : required('MYSQL_DATABASE'),
  },
  /** 가상 업체 서버(apps/partners) 주소 */
  partnersUrl: process.env.PARTNERS_URL ?? 'http://127.0.0.1:4010',
  /** 택배사·메신저 호출 타임아웃 */
  partnerTimeoutMs: Number(process.env.PARTNER_TIMEOUT_MS ?? 3000),
  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
  /**
   * BullMQ 키 접두사. 테스트는 파일마다 다른 접두사를 써서 다른 파일의 job을 보지 않는다
   * (vitest는 테스트 파일마다 모듈을 새로 읽으므로 이 값도 파일마다 새로 정해진다).
   */
  queuePrefix: process.env.QUEUE_PREFIX ?? (isTest ? `test-${process.pid}-${Date.now()}` : 'terminal-ops'),
  /** 이 프로세스가 큐 job을 처리할지 */
  runWorkers: flag('RUN_WORKERS', true),
  /** 이 프로세스가 주기 작업(수집 sweep, outbox relay)을 등록할지 */
  runSchedulers: flag('RUN_SCHEDULERS', !isTest),
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? 30_000),
  relayIntervalMs: Number(process.env.RELAY_INTERVAL_MS ?? 2_000),
  /** 운영 중 단말기 목록(Redis active)을 MySQL에서 통째로 다시 만드는 주기(decisions/0028) */
  activeRebuildIntervalMs: Number(process.env.ACTIVE_REBUILD_INTERVAL_MS ?? 60_000),
  /** 마지막 하트비트가 이보다 오래되면 오프라인으로 본다(단말기 하트비트 주기 30초의 3배, decisions/0029) */
  hbOfflineAfterMs: Number(process.env.HEARTBEAT_OFFLINE_AFTER_MS ?? 90_000),
  /** 오프라인 판정 주기 */
  offlineDetectIntervalMs: Number(process.env.OFFLINE_DETECT_INTERVAL_MS ?? 10_000),
  /** 접속 상태 스냅샷(Redis → MySQL) 주기 */
  connectivitySnapshotIntervalMs: Number(process.env.CONNECTIVITY_SNAPSHOT_INTERVAL_MS ?? 60_000),
  /** 펌웨어 배포 판단(단계 넘기기·자동 중단·시간 초과) 주기(decisions/0031) */
  rolloutControlIntervalMs: Number(process.env.ROLLOUT_CONTROL_INTERVAL_MS ?? 5_000),
  /** 우리 쪽 호출 속도 제한(초당). 택배사 한도보다 낮게 둔다. */
  bungaeRatePerSec: Number(process.env.BUNGAE_RATE_PER_SEC ?? 10),
  neurimboRatePerSec: Number(process.env.NEURIMBO_RATE_PER_SEC ?? 5),
  /** 알림을 보낼 톡톡메신저 채널 */
  toktokChannel: process.env.TOKTOK_CHANNEL ?? 'ops',
  /** 박스 스캔 처리 중 잠금(Redis) 유지 시간. 처리가 이보다 길면 잠금이 풀린다(decisions/0020) */
  scanLockTtlMs: Number(process.env.SCAN_LOCK_TTL_MS ?? 30_000),
  /** A/S 교체 단말기 예약(Redis) 유지 시간. 운송장 발급 + 교체 트랜잭션이 이보다 길면 예약이 풀린다(decisions/0026) */
  replacementLockTtlMs: Number(process.env.REPLACEMENT_LOCK_TTL_MS ?? 30_000),
  /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
  workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
};
```

`apps/api/src/scheduler/job-schedulers.ts` 전체(`rollout-control`):
```ts
import type { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { QUEUE, type QueueName } from '../queue/queue-names.js';

/** 주기 작업 목록. 등록(SchedulerService)과 삭제(scheduler:clear)가 같은 id를 쓴다. every는 등록할 때 읽는 주기(ms)다. */
export const JOB_SCHEDULERS = [
  { queue: QUEUE.CARRIER_SWEEP, id: 'carrier-sweep', jobName: 'sweep', every: () => env.sweepIntervalMs },
  { queue: QUEUE.OUTBOX, id: 'outbox-relay', jobName: 'relay', every: () => env.relayIntervalMs },
  { queue: QUEUE.DEVICE, id: 'active-rebuild', jobName: 'rebuild-active', every: () => env.activeRebuildIntervalMs },
  { queue: QUEUE.DEVICE, id: 'offline-detect', jobName: 'detect-offline', every: () => env.offlineDetectIntervalMs },
  { queue: QUEUE.DEVICE, id: 'connectivity-snapshot', jobName: 'snapshot', every: () => env.connectivitySnapshotIntervalMs },
  { queue: QUEUE.DEVICE, id: 'rollout-control', jobName: 'rollout-control', every: () => env.rolloutControlIntervalMs },
] as const satisfies readonly { queue: QueueName; id: string; jobName: string; every: () => number }[];

/**
 * 주기 작업을 Redis에서 지운다. job scheduler는 등록한 프로세스가 끝나도 Redis에 남아 계속 job을 만든다
 * (Day 2 리뷰 Minor 2, decisions/0015). 다음 주기 job(delayed)도 함께 지워진다.
 * @returns 지운 scheduler id 목록(없던 것은 빠진다)
 */
export async function clearJobSchedulers(queueOf: (name: QueueName) => Queue): Promise<string[]> {
  const removed: string[] = [];
  for (const s of JOB_SCHEDULERS) {
    if (await queueOf(s.queue).removeJobScheduler(s.id)) removed.push(s.id);
  }
  return removed;
}
```

`apps/api/src/device/device.processor.ts` 전체(`rollout-control` → `controlAll`):
```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { RolloutService } from '../firmware/rollout.service.js';
import type { ProjectJobData } from '../outbox/outbox.service.js';
import { QUEUE } from '../queue/queue-names.js';
import { ActiveSetService } from './active-set.service.js';
import { ConnectivityService } from './connectivity.service.js';

/**
 * device 큐. concurrency 1: 한 워커 프로세스 안에서는 active 갱신이 한 번에 하나씩 돈다(읽고 쓰는 사이에 다른 갱신이 끼지 않게).
 * 워커 프로세스가 여럿이면 겹칠 수 있고, 그 틈은 주기 재구성이 메운다(decisions/0028).
 */
@Processor(QUEUE.DEVICE, { concurrency: 1 })
export class DeviceProcessor extends WorkerHost {
  constructor(
    private readonly activeSet: ActiveSetService,
    private readonly connectivity: ConnectivityService,
    private readonly rollouts: RolloutService,
  ) {
    super();
  }

  async process(job: Job) {
    switch (job.name) {
      case 'project':
        return this.activeSet.apply([(job.data as ProjectJobData).serialNo]);
      case 'rebuild-active':
        return this.activeSet.rebuild();
      case 'detect-offline':
        return this.connectivity.detect();
      case 'snapshot':
        return this.connectivity.snapshot();
      case 'rollout-control':
        return this.rollouts.controlAll();
      default:
        throw new UnrecoverableError(`모르는 device job: ${job.name}`);
    }
  }
}
```

`apps/api/src/workers/workers.module.ts` 전체(`FirmwareModule` import):
```ts
import { Module } from '@nestjs/common';
import {
  BungaeTrackProcessor,
  CarrierSweepProcessor,
  NeurimboTrackProcessor,
} from '../carrier-sync/carrier-sync.processors.js';
import { CarrierSyncModule } from '../carrier-sync/carrier-sync.module.js';
import { DeviceModule } from '../device/device.module.js';
import { DeviceProcessor } from '../device/device.processor.js';
import { FirmwareModule } from '../firmware/firmware.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { OutboxProcessor } from '../outbox/outbox.processor.js';

/** 큐 job을 처리하는 프로세서들. RUN_WORKERS=1인 프로세스에만 넣는다(decisions/0015). */
@Module({
  imports: [CarrierSyncModule, OutboxModule, DeviceModule, FirmwareModule],
  providers: [BungaeTrackProcessor, NeurimboTrackProcessor, CarrierSweepProcessor, OutboxProcessor, DeviceProcessor],
})
export class WorkersModule {}
```

`.env.example`의 `CONNECTIVITY_SNAPSHOT_INTERVAL_MS=60000` 다음 줄에 추가:
```
# 펌웨어 배포 판단 주기 — decisions/0031
ROLLOUT_CONTROL_INTERVAL_MS=5000
```

- [ ] **Step 4: 원시 SQL datetime 재현 (troubleshooting/0016, 계획한 재현)**

`rollout.service.ts`의 `offeredTargets` 마지막 줄 `offeredAt: fromDbDatetime(r.offered_at)`을 잠깐 `offeredAt: new Date(r.offered_at)`로 바꾸고 돌린다.

Run: `npx vitest run test/firmware-control.e2e.spec.ts`
Expected(사전 검증): `Tests  3 failed | 3 passed (6)`. `모두 성공하면…`·`실패율이…`: `expected 'ABORTED' to be 'WAITING'`(보고 전인데 모든 대상이 TIMED_OUT → 실패율 100%로 중단), `제한 시간 안에…`: `expected 'ADVANCED' to be 'WAITING'`.

원인을 확인한다(읽기만, 테스트 DB):
```bash
MSYS_NO_PATHCONV=1 docker exec terminal-ops-mysql sh -c 'mysql -N -uterminal_ops -p"$MYSQL_PASSWORD" terminal_ops_test -e "select offered_at, @@session.time_zone, now(3) from firmware_rollout_target order by id desc limit 1"' 2>/dev/null
```
Expected: `offered_at`이 지금 KST 시각보다 9시간 이른 값(UTC로 저장), `time_zone`은 `SYSTEM`, `now(3)`는 KST. `em.execute`는 이 값을 `'YYYY-MM-DD HH:mm:ss.SSS'` 글자로 주고(MikroORM `dateStrings: true`), `new Date(글자)`는 지역 시간(KST)으로 읽어 9시간 과거가 된다. 확인 뒤 `fromDbDatetime(r.offered_at)`으로 되돌린다.

`docs/troubleshooting/0016-원시-SQL-datetime이-9시간-어긋나-모두-시간-초과.md`:
- 증상: 배포 판단이 보고를 기다려야 할 때 모든 대상을 TIMED_OUT으로 바꾸고 실패율 100%로 ABORTED(테스트 출력 그대로).
- 가설: 1) stageTimeoutMs 기본값이 너무 짧다 2) offered_at을 잘못 읽는다(시간대) 3) 테스트의 now가 미래다.
- 확인: 위 MySQL 출력(UTC 저장, 세션 SYSTEM), `em.execute` 결과의 `typeof offered_at === 'string'`, MikroORM 7 `Configuration`의 `forceUtcTimezone: true`, `MySqlConnection.mapOptions`의 `timezone = 'Z'`·`dateStrings = true` → 가설 2 확인.
- 원인: MikroORM 7은 날짜를 UTC로 쓰고, 원시 결과는 시간대 표시 없는 글자로 준다. `new Date('2026-10-23 09:29:15.606')`는 지역 시간으로 해석된다. 엔티티로 읽으면 MikroORM이 맞게 바꿔서 그동안 드러나지 않았다.
- 해결: `common/db-datetime.ts`의 `fromDbDatetime`(글자 뒤에 `Z`), 단위 테스트. SQL 안에서 저장된 datetime을 `NOW()`와 비교하지 않는다(세션 시간대가 SYSTEM).
- 배운 것 → backlog

- [ ] **Step 5: 통과 확인**

Run:
```bash
npx vitest run test/firmware-control.e2e.spec.ts test/unit/db-datetime.spec.ts --silent=false 2>&1 | grep -E "보고 중 배포 행 잠금|Tests "
npx vitest run && npm run typecheck
```
Expected: `Tests  8 passed (8)`, `[보고 중 배포 행 잠금] 200 <ms>ms`(1초 미만, 사전 검증 10ms 안팎). 전체 `Test Files  37 passed (37)`, `Tests  236 passed (236)`, typecheck exit 0. (마이그레이션 없음 — `npm run db:migration:check` → `최신 상태`)

- [ ] **Step 6: 기록과 커밋**

devlog에 `## HH:MM Task 7 결과 보고와 배포 판단 — 단계 넘기기·자동 중단·시간 초과 (F8)` 항목(재현 결과, troubleshooting/0016).

`docs/decisions/0031-배포-판단은-배포-행-먼저-보고는-대상-행만.md`:
- 상황: 배포 판단(단계 넘기기·자동 중단·시간 초과)과 단말기 수백 대의 보고가 동시에 일어난다. 판단은 "지금 단계의 통계"를 보고 배포 행과 대상 행을 함께 바꾸고, 보고는 대상 행 하나를 바꾼다. 판단이 여러 프로세스에서 동시에 돌 수도 있다.
- 선택지(잠금):
  1. 보고도 배포 행을 FOR UPDATE — 통계가 정확하지만 보고 수백 건이 배포 행 하나에서 줄을 서고, 판단이 대상 행을 바꾸는 동안 서로 반대 순서(대상 → 배포 / 배포 → 대상)로 기다려 순환이 생길 수 있다.
  2. **판단: 배포 행 FOR UPDATE → 대상 행(PK 갱신·INSERT). 보고: 대상 행 하나만 PK + 상태 조건 UPDATE(배포 행을 잠그지 않음)** — 보고는 배포 행을 기다리지 않는다. 보고가 쥐는 자원은 대상 행 하나라 판단(배포 행 + 여러 대상 행)과 순환 대기를 만들 수 없다.
  3. 판단도 잠금 없이 낙관적 락(version) — 충돌하면 다시 해야 하고, 판단이 여러 프로세스에서 같은 단계를 두 번 넘길 위험을 다시 확인해야 한다.
- 결정: 2. 판단끼리는 배포 행 잠금에서 줄을 서고, 뒤에 온 쪽은 앞쪽이 바꾼 단계(새 대상은 OFFERED, 결과 0)를 보고 기다린다 → 주기 작업에 Redis 잠금이 필요 없다. 테스트: 배포 행 FOR UPDATE를 쥔 트랜잭션이 있어도 보고 200(1초 미만).
- 대상 행 여러 개 갱신(TIMED_OUT, 재개의 offered_at)은 잠그지 않고 id를 읽은 뒤 `id IN (…) AND status='OFFERED'`(PK, id 순). `WHERE rollout_id=? AND stage=? AND status='OFFERED'` 같은 보조 인덱스 범위 UPDATE는 RR에서 gap 락을 건다(troubleshooting/0014). 상태 조건 덕분에 그사이 보고된 행은 덮어쓰지 않는다.
- 판단이 읽는 통계는 배포 행을 잠근 뒤 첫 일반 SELECT로 정해지는 스냅숏이다(FOR UPDATE는 스냅숏을 만들지 않는다). 그 뒤 커밋된 보고는 다음 판단이 본다.
- 실패율: 지금 단계의 (FAILED + TIMED_OUT) / (SUCCEEDED + FAILED + TIMED_OUT). 시간 초과도 실패로 센다(아무도 성공하지 않았는데 다음 단계로 가지 않게). 자동 중단은 기준 초과이면서 결과가 minSamples 이상일 때, 또는 단계가 다 끝났을 때(작은 단계). 중단하면 남은 OFFERED는 그대로 두고(늦은 보고를 받는다 — 영향 범위를 세려고) 제안만 모두 내린다.
- Redis 제안 걸기·내리기는 커밋 뒤(트랜잭션 안에서 외부 저장소를 기다리지 않는다). 그 사이 죽으면: 새 단계 제안이 없으면 대상은 제한 시간 뒤 TIMED_OUT, 내리지 못한 제안은 단말기가 보고할 때 보고 API가 내린다.
- 결과·대가: 판단 주기(5초) + 보고 지연만큼 단계 전환이 늦다(실험 0009). 실패율은 단계마다 새로 센다(앞 단계의 실패는 다음 단계 판단에 들어가지 않는다).
- 다시 볼 조건: 보고가 초당 수천 건이 되어 판단의 통계 쿼리(`group by stage, status`)가 무거워질 때(카운터 테이블), 단계 사이에 운영자 승인이 필요해질 때.

`docs/study/backlog.md`에 추가:
```
- [ ] 잠금 범위 나누기 — 집계(부모 행)와 개별 결과(자식 행)의 잠금을 분리해 순환 대기를 없애는 방법 (decisions/0031)
- [ ] InnoDB에서 FOR UPDATE와 일반 SELECT의 스냅숏(read view)이 만들어지는 시점 (firmware/rollout.service.ts control)
- [ ] MySQL datetime과 시간대 — UTC 저장, 세션 time_zone, 드라이버 timezone·dateStrings (troubleshooting/0016)
```

커밋:
```bash
git add apps/api docs .env.example
git commit -m "feat(F8): 펌웨어 결과 보고와 배포 판단(단계 넘기기·자동 중단·시간 초과)" -m "Refs: docs/decisions/0031-배포-판단은-배포-행-먼저-보고는-대상-행만.md, docs/troubleshooting/0016-원시-SQL-datetime이-9시간-어긋나-모두-시간-초과.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: 시뮬레이터의 펌웨어 업데이트 흉내와 실제 프로세스 연동 확인 (F8, F12)

**Files:**
- Modify: `apps/device-sim/src/config.ts`, `apps/device-sim/src/stats.ts`, `apps/device-sim/src/fleet.ts`
- Test: `apps/device-sim/test/firmware.spec.ts`(새), `apps/device-sim/test/admin.spec.ts`
- Create(api 테스트): `apps/api/test/helpers/device-sim.ts`, `apps/api/test/device-sim.e2e.spec.ts`
- Record: devlog, `docs/decisions/0009-…`(갱신에 한 줄 더), `docs/study/backlog.md`

- 하트비트 응답 행에 `update: { rolloutId, version }`이 있으면: 이미 업데이트 중이거나 이미 그 버전이면 무시, 아니면 `updateDelayMs + 0~updateJitterMs`(시드 난수) 뒤 `firmwareFailRate` 확률(시드 난수, 0이면 난수를 쓰지 않음)로 성공·실패를 정해 `POST /devices/firmware-reports`. 2xx면 성공은 펌웨어를 새 버전으로 바꾸고 `reportsSucceeded`, 실패는 `reportsFailed`. 2xx가 아니거나 연결 실패면 `reportErrors`(다음 지시에 다시 업데이트한다).
- `updateJitterMs`: 사전 검증에서 지터 없이 300ms 고정이면 한 단계의 보고가 한꺼번에 와서 판단 job이 단계가 다 끝난 뒤에야 판단했다(실험 0009에서 자동 중단 시점을 볼 수 없다).
- "이미 그 버전이면 무시": 성공 보고 직전에 offers를 읽은 하트비트 응답이 지시를 한 번 더 싣고 와, 같은 단말기가 두 번 업데이트하는 것을 사전 검증에서 봤다(보고는 멱등이라 결과는 같았다).
- 테스트 헬퍼 `startDeviceSim()`: device-sim을 빌드해(tsc) 자식 프로세스로 띄우고(테스트 포트 4021, 이미 떠 있으면 거절), 끝나면 그 PID만 끈다. 대부분의 e2e는 API를 직접 부르고, 이 연동 테스트 하나와 실험(Task 9·10)만 실제 프로세스를 쓴다.

- [ ] **Step 1: 실패하는 테스트 작성**

`apps/device-sim/test/firmware.spec.ts`(새):
```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, type SimConfig } from '../src/config.js';
import { Fleet } from '../src/fleet.js';
import { sendJson } from '../src/http.js';
import { okHandler, sleep, startFakeApi, type FakeApi } from './helpers.js';

/** HB-0001에만 업데이트 지시(배포 7, 버전 2.0.0)를 싣는 하트비트 응답. 보고는 200 */
const offeringHandler: Parameters<FakeApi['setHandler']>[0] = (req, res) => {
  if (req.path === '/devices/firmware-reports') return sendJson(res, 200, { status: 'SUCCEEDED' });
  const items = req.body.items as { serialNo: string }[];
  sendJson(res, 200, {
    results: items.map((i) => ({ serialNo: i.serialNo, result: 'OK', ...(i.serialNo === 'HB-0001' ? { update: { rolloutId: 7, version: '2.0.0' } } : {}) })),
  });
};

describe('펌웨어 업데이트 흉내', () => {
  let api: FakeApi;
  let fleet: Fleet | undefined;
  const config = (patch: Partial<SimConfig>): SimConfig => ({ ...defaultConfig(), targetUrl: api.url, count: 2, batchSize: 2, ...patch });
  const reports = () => api.received.filter((r) => r.path === '/devices/firmware-reports').map((r) => r.body);
  const heartbeats = () => api.received.filter((r) => r.path === '/devices/heartbeats');

  beforeAll(async () => {
    api = await startFakeApi(offeringHandler);
  });
  afterEach(async () => {
    await fleet?.close();
    fleet = undefined;
    api.received.length = 0;
    api.setHandler(offeringHandler);
  });
  afterAll(() => api.close());

  it('지시를 받으면 updateDelayMs 뒤 성공을 보고하고, 다음 하트비트부터 새 버전을 보낸다', async () => {
    fleet = new Fleet(config({ updateDelayMs: 50 }));
    await fleet.tick();
    expect(fleet.devices.get('HB-0001')!.updating).toBe(true);
    expect(reports()).toEqual([]); // 아직 업데이트 중
    await fleet.settleUpdates();
    expect(reports()).toEqual([{ serialNo: 'HB-0001', rolloutId: 7, success: true, version: '2.0.0' }]);
    expect(fleet.devices.get('HB-0001')).toMatchObject({ firmwareVersion: '2.0.0', updating: false });
    expect(fleet.stats.view()).toMatchObject({ updateOffers: 1, reportsSucceeded: 1, reportsFailed: 0, reportErrors: 0 });

    api.setHandler(okHandler);
    await fleet.tick();
    expect(heartbeats().at(-1)!.body.items).toEqual([
      { serialNo: 'HB-0001', firmwareVersion: '2.0.0' },
      { serialNo: 'HB-0002', firmwareVersion: '1.0.0' },
    ]);
  });

  it('이미 그 버전이면 지시를 무시한다', async () => {
    fleet = new Fleet(config({ updateDelayMs: 0, firmwareVersion: '2.0.0' }));
    await fleet.tick();
    await fleet.settleUpdates();
    expect(reports()).toEqual([]);
    expect(fleet.stats.view().updateOffers).toBe(0);
  });

  it('firmwareFailRate 1이면 실패를 보고하고 버전은 그대로', async () => {
    fleet = new Fleet(config({ updateDelayMs: 0, firmwareFailRate: 1 }));
    await fleet.tick();
    await fleet.settleUpdates();
    expect(reports()).toEqual([{ serialNo: 'HB-0001', rolloutId: 7, success: false, version: '2.0.0' }]);
    expect(fleet.devices.get('HB-0001')!.firmwareVersion).toBe('1.0.0');
    expect(fleet.stats.view()).toMatchObject({ reportsSucceeded: 0, reportsFailed: 1 });
  });

  it('업데이트 중에 같은 지시가 또 와도 한 번만 한다', async () => {
    fleet = new Fleet(config({ updateDelayMs: 100 }));
    await fleet.tick();
    await fleet.tick();
    await fleet.settleUpdates();
    expect(reports()).toHaveLength(1);
    expect(fleet.stats.view().updateOffers).toBe(1);
  });

  it('실패율은 시드로 재현된다(같은 시드면 같은 단말기가 실패)', async () => {
    const run = async () => {
      api.setHandler((req, res) => {
        if (req.path === '/devices/firmware-reports') return sendJson(res, 200, {});
        const items = req.body.items as { serialNo: string }[];
        sendJson(res, 200, { results: items.map((i) => ({ serialNo: i.serialNo, result: 'OK', update: { rolloutId: 1, version: '2.0.0' } })) });
      });
      api.received.length = 0;
      const f = new Fleet(config({ count: 50, batchSize: 50, updateDelayMs: 0, firmwareFailRate: 0.3, seed: 11 }));
      await f.tick();
      await f.settleUpdates();
      await f.close();
      return reports()
        .filter((r) => r.success === false)
        .map((r) => r.serialNo)
        .sort();
    };
    const first = await run();
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(50);
    expect(await run()).toEqual(first);
  });

  it('updateJitterMs가 있으면 보고 시각이 퍼진다', async () => {
    const reportedAt: number[] = [];
    api.setHandler((req, res) => {
      if (req.path === '/devices/firmware-reports') {
        reportedAt.push(Date.now());
        return sendJson(res, 200, {});
      }
      const items = req.body.items as { serialNo: string }[];
      sendJson(res, 200, { results: items.map((i) => ({ serialNo: i.serialNo, result: 'OK', update: { rolloutId: 1, version: '2.0.0' } })) });
    });
    fleet = new Fleet(config({ count: 20, batchSize: 20, updateDelayMs: 0, updateJitterMs: 300 }));
    await fleet.tick();
    await fleet.settleUpdates();
    expect(reportedAt).toHaveLength(20);
    expect(Math.max(...reportedAt) - Math.min(...reportedAt)).toBeGreaterThan(100);
  });

  it('보고가 2xx가 아니면 reportErrors, 다음 지시에 다시 업데이트한다', async () => {
    api.setHandler((req, res) => (req.path === '/devices/firmware-reports' ? sendJson(res, 503, {}) : offeringHandler(req, res)));
    fleet = new Fleet(config({ updateDelayMs: 0 }));
    await fleet.tick();
    await fleet.settleUpdates();
    expect(fleet.stats.view().reportErrors).toBe(1);
    expect(fleet.devices.get('HB-0001')).toMatchObject({ firmwareVersion: '1.0.0', updating: false });
    await sleep(10);
    await fleet.tick();
    await fleet.settleUpdates();
    expect(fleet.stats.view().updateOffers).toBe(2);
  });
});
```

`apps/device-sim/test/admin.spec.ts` 전체(범위 검사 3개 추가, 단말기 상태에 `updating`):
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sleep, startFakeApi, startSim, type FakeApi } from './helpers.js';

describe('시뮬레이터 관리 API', () => {
  let api: FakeApi;
  let sim: Awaited<ReturnType<typeof startSim>>;

  beforeAll(async () => {
    api = await startFakeApi();
    sim = await startSim();
  });
  beforeEach(async () => {
    await sim.post('/__admin/reset');
    api.received.length = 0;
  });
  afterAll(async () => {
    await sim.close();
    await api.close();
  });

  it('health', async () => {
    expect(await sim.get('/__admin/health')).toEqual({ status: 'ok' });
  });

  it('설정은 일부만 바꿀 수 있고, 범위를 벗어나거나 JSON이 깨지면 400', async () => {
    const res = await sim.post('/__admin/config', { targetUrl: api.url, count: 3, batchSize: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ targetUrl: api.url, count: 3, batchSize: 2, intervalMs: 30_000 });
    expect((await sim.post('/__admin/config', { batchSize: 0 })).status).toBe(400);
    expect((await sim.post('/__admin/config', { offlineRate: 2 })).status).toBe(400);
    expect((await sim.post('/__admin/config', { firmwareFailRate: -0.1 })).status).toBe(400);
    expect((await sim.post('/__admin/config', { updateDelayMs: -1 })).status).toBe(400);
    expect((await sim.post('/__admin/config', { updateJitterMs: 1.5 })).status).toBe(400);
    const broken = await fetch(`${sim.base}/__admin/config`, { method: 'POST', body: '{"count":' });
    expect(broken.status).toBe(400);
  });

  it('start → 주기마다 보냄 → stop, stats에 보낸 수와 응답 시간', async () => {
    await sim.post('/__admin/config', { targetUrl: api.url, count: 3, batchSize: 3, intervalMs: 50 });
    await sim.post('/__admin/start');
    await sleep(180);
    expect((await (await sim.post('/__admin/stop')).json()).running).toBe(false);
    const stats = await sim.get('/__admin/stats');
    expect(stats.running).toBe(false);
    expect(stats.ticks).toBeGreaterThanOrEqual(2);
    expect(stats.heartbeatsSent).toBe(stats.ticks * 3);
    expect(stats.heartbeatsAccepted).toBe(stats.heartbeatsSent);
    expect(stats.latency.count).toBe(stats.requests);
    const after = api.received.length;
    await sleep(120);
    expect(api.received.length).toBe(after); // 멈춘 뒤에는 보내지 않는다
  });

  it('단말기 상태 조회(없으면 404)', async () => {
    await sim.post('/__admin/config', { count: 2, serialPrefix: 'DV', firmwareVersion: '2.0.0' });
    expect(await sim.get('/__admin/devices/DV-0002')).toEqual({ serialNo: 'DV-0002', firmwareVersion: '2.0.0', offline: false, updating: false });
    expect((await fetch(`${sim.base}/__admin/devices/NONE`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run (`apps/device-sim`): `npx vitest run`
Expected: `Tests  9 failed | 10 passed (19)`. firmware.spec 7개(`expected undefined to be true`, `TypeError: fleet.settleUpdates is not a function` 등), admin 2개(`expected 200 to be 400` — 새 설정 키 검사 없음, 단말기 상태에 `updating` 없음).

- [ ] **Step 3: 구현**

`apps/device-sim/src/config.ts` 전체(`firmwareFailRate`, `updateDelayMs`, `updateJitterMs`와 범위 검사):
```ts
/** 시뮬레이터 설정. 관리 API(POST /__admin/config)로 일부만 바꿀 수 있다(나머지는 그대로). */
export interface SimConfig {
  /** 하트비트를 보낼 API 주소(예: http://127.0.0.1:3000) */
  targetUrl: string;
  /** 단말기 시리얼 목록. 비어 있으면 serialPrefix·serialStart·count로 만든다(`HB-0001` …) */
  serials: string[];
  serialPrefix: string;
  serialStart: number;
  count: number;
  /** 하트비트 주기(ms). 한 주기에 온라인 단말기가 모두 한 번씩 보낸다 */
  intervalMs: number;
  /** 한 요청에 담는 하트비트 수. 1이면 단말기마다 요청 하나 */
  batchSize: number;
  /** 동시에 보내는 요청 수 상한. keep-alive 소켓 수 상한과 같다(Windows 임시 포트 고갈 방지) */
  concurrency: number;
  /** 하트비트를 보내지 않는 단말기 */
  offlineSerials: string[];
  /** 이 비율만큼 단말기를 시드 난수로 골라 오프라인으로 둔다(0~1). offlineSerials와 합쳐진다 */
  offlineRate: number;
  /** 단말기의 처음 펌웨어 버전 */
  firmwareVersion: string;
  /** 업데이트 지시를 받았을 때 실패로 보고할 확률(0~1, 시드 난수) */
  firmwareFailRate: number;
  /** 업데이트(가짜 다운로드·설치)에 걸리는 시간(ms). 지나면 결과를 보고한다 */
  updateDelayMs: number;
  /** 업데이트 시간에 더하는 무작위 시간의 상한(ms, 시드 난수). 0이면 모두 같은 시간에 끝난다 */
  updateJitterMs: number;
  /** 요청 하나의 제한 시간(ms) */
  requestTimeoutMs: number;
  seed: number;
}

export type SimConfigPatch = Partial<SimConfig>;

export function defaultConfig(): SimConfig {
  return {
    targetUrl: 'http://127.0.0.1:3000',
    serials: [],
    serialPrefix: 'HB',
    serialStart: 1,
    count: 10,
    intervalMs: 30_000,
    batchSize: 100,
    concurrency: 8,
    offlineSerials: [],
    offlineRate: 0,
    firmwareVersion: '1.0.0',
    firmwareFailRate: 0,
    updateDelayMs: 1000,
    updateJitterMs: 0,
    requestTimeoutMs: 5000,
    seed: 42,
  };
}

/** 단말기 시리얼 목록 */
export function serialsOf(config: SimConfig): string[] {
  if (config.serials.length > 0) return [...config.serials];
  return Array.from({ length: config.count }, (_, i) => `${config.serialPrefix}-${String(config.serialStart + i).padStart(4, '0')}`);
}

/** 숫자 설정의 범위 검사. 틀리면 이유 문장, 맞으면 null */
export function invalidReason(config: SimConfig): string | null {
  const positive: (keyof SimConfig)[] = ['intervalMs', 'batchSize', 'concurrency', 'requestTimeoutMs'];
  for (const key of positive) {
    const v = config[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return `${key}는 1 이상의 정수여야 합니다.`;
  }
  for (const key of ['updateDelayMs', 'updateJitterMs'] as const) {
    if (!Number.isInteger(config[key]) || config[key] < 0) return `${key}는 0 이상의 정수여야 합니다.`;
  }
  for (const key of ['offlineRate', 'firmwareFailRate'] as const) {
    if (!(config[key] >= 0 && config[key] <= 1)) return `${key}는 0~1이어야 합니다.`;
  }
  if (!Number.isInteger(config.count) || config.count < 0) return 'count는 0 이상의 정수여야 합니다.';
  return null;
}
```

`apps/device-sim/src/stats.ts` 전체(`updateOffers`, `reportsSucceeded`, `reportsFailed`, `reportErrors`):
```ts
/** 정렬된 배열의 백분위 값(가장 가까운 순위). 비어 있으면 0 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** 응답 시간 표본 상한. 넘으면 오래된 것부터 버리지 않고 더 담지 않는다(실험 한 번에 충분한 양) */
const MAX_SAMPLES = 500_000;

export interface StatsView {
  /** 하트비트 주기 수(보낸 주기) */
  ticks: number;
  /** 앞 주기가 아직 끝나지 않아 건너뛴 주기 수. 0보다 크면 주기 안에 다 보내지 못한 것이다 */
  skippedTicks: number;
  /** 보낸 HTTP 요청 수 */
  requests: number;
  /** 보낸 하트비트 수(요청 안의 항목 수 합) */
  heartbeatsSent: number;
  /** 응답의 행별 결과가 OK인 수 */
  heartbeatsAccepted: number;
  /** 행별 결과가 OK가 아닌 수(IGNORED_NOT_IN_SERVICE 등) */
  heartbeatsRejected: number;
  /** 2xx가 아닌 응답·연결 실패·시간 초과 */
  errors: number;
  /** 요청 응답 시간(ms) */
  latency: { count: number; p50: number; p95: number; max: number };
  /** 받아서 시작한 업데이트 지시 수(업데이트 중에 같은 지시가 또 와도 한 번) */
  updateOffers: number;
  /** 성공으로 보고한 수 / 실패로 보고한 수(API가 2xx로 받은 것만) */
  reportsSucceeded: number;
  reportsFailed: number;
  /** 보고 요청이 2xx가 아니거나 연결이 안 된 수 */
  reportErrors: number;
  startedAt: string | null;
  lastTickAt: string | null;
}

export class SimStats {
  ticks = 0;
  skippedTicks = 0;
  requests = 0;
  heartbeatsSent = 0;
  heartbeatsAccepted = 0;
  heartbeatsRejected = 0;
  errors = 0;
  updateOffers = 0;
  reportsSucceeded = 0;
  reportsFailed = 0;
  reportErrors = 0;
  startedAt: string | null = null;
  lastTickAt: string | null = null;
  private latencies: number[] = [];

  recordLatency(ms: number): void {
    if (this.latencies.length < MAX_SAMPLES) this.latencies.push(ms);
  }

  view(): StatsView {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      ticks: this.ticks,
      skippedTicks: this.skippedTicks,
      requests: this.requests,
      heartbeatsSent: this.heartbeatsSent,
      heartbeatsAccepted: this.heartbeatsAccepted,
      heartbeatsRejected: this.heartbeatsRejected,
      errors: this.errors,
      latency: {
        count: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max: sorted.at(-1) ?? 0,
      },
      updateOffers: this.updateOffers,
      reportsSucceeded: this.reportsSucceeded,
      reportsFailed: this.reportsFailed,
      reportErrors: this.reportErrors,
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
    };
  }
}
```

`apps/device-sim/src/fleet.ts` 전체(`updating`, `startUpdate`, `report`, `settleUpdates`, `close`가 대기 중인 업데이트를 버림, `reset`이 `close` 사용):
```ts
import { ApiClient } from './client.js';
import { defaultConfig, serialsOf, type SimConfig } from './config.js';
import { createRng } from './rng.js';
import { SimStats } from './stats.js';

export interface Device {
  serialNo: string;
  firmwareVersion: string;
  /** 하트비트를 보내지 않는 단말기 */
  offline: boolean;
  /** 펌웨어 업데이트 중(결과를 보고하기 전) */
  updating: boolean;
}

/** API 하트비트 응답의 업데이트 지시(apps/api HeartbeatService) */
interface UpdateOffer {
  rolloutId: number;
  version: string;
}

/** API 하트비트 응답의 행 하나 */
interface HeartbeatResult {
  serialNo: string;
  result: string;
  update?: UpdateOffer;
}

/** 작업 목록을 동시에 n개까지만 돌린다. */
export async function runPool<T>(items: T[], n: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await work(item);
    }
  });
  await Promise.all(lanes);
}

/** 시드로 정해지는 순서로 섞어 앞에서 k개를 고른다(Fisher–Yates). 같은 시드·같은 목록이면 같은 결과 */
export function pickSeeded<T>(items: T[], k: number, seed: number): T[] {
  const rng = createRng(seed);
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

/**
 * 단말기 무리. 주기마다 온라인 단말기의 하트비트를 batchSize씩 묶어 `POST /devices/heartbeats`로 보낸다
 * (동시 요청은 concurrency까지). 앞 주기가 끝나지 않았으면 그 주기는 건너뛰고 skippedTicks로 센다.
 * 응답에 업데이트 지시가 있으면 updateDelayMs(+ 무작위 0~updateJitterMs) 뒤 결과(firmwareFailRate 확률로 실패)를
 * `POST /devices/firmware-reports`로 보고한다.
 */
export class Fleet {
  config: SimConfig = defaultConfig();
  stats = new SimStats();
  devices = new Map<string, Device>();
  private client: ApiClient | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inTick: Promise<void> | null = null;
  private rng = createRng(this.config.seed);
  /** 진행 중인 업데이트(대기 타이머 + 보고 요청) */
  private updates = new Set<Promise<void>>();
  private updateTimers = new Set<NodeJS.Timeout>();

  constructor(config: SimConfig = defaultConfig()) {
    this.configure(config);
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** 설정을 바꾸고 단말기 목록을 다시 만든다. 이미 있던 단말기의 펌웨어는 유지한다. 난수는 seed로 다시 시작한다. */
  configure(config: SimConfig): void {
    this.config = config;
    this.rng = createRng(config.seed);
    const serials = serialsOf(config);
    const offline = new Set([...config.offlineSerials, ...pickSeeded(serials, Math.round(serials.length * config.offlineRate), config.seed)]);
    const next = new Map<string, Device>();
    for (const serialNo of serials) {
      const prev = this.devices.get(serialNo);
      next.set(serialNo, {
        serialNo,
        firmwareVersion: prev?.firmwareVersion ?? config.firmwareVersion,
        offline: offline.has(serialNo),
        updating: prev?.updating ?? false,
      });
    }
    this.devices = next;
    this.client?.close();
    this.client = new ApiClient(config.targetUrl, config.concurrency, config.requestTimeoutMs);
  }

  start(): void {
    if (this.timer) return;
    this.stats.startedAt ??= new Date().toISOString();
    this.timer = setInterval(() => void this.tickIfIdle(), this.config.intervalMs);
    void this.tickIfIdle();
  }

  /** 하트비트를 멈추고, 보내는 중인 주기가 끝날 때까지 기다린다. 진행 중인 업데이트는 계속된다. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inTick;
  }

  /** 진행 중인 업데이트 보고가 모두 끝날 때까지 기다린다(테스트용) */
  async settleUpdates(): Promise<void> {
    while (this.updates.size > 0) await Promise.all([...this.updates]);
  }

  async reset(config: SimConfig = defaultConfig()): Promise<void> {
    await this.close();
    this.devices.clear();
    this.stats = new SimStats();
    this.configure(config);
  }

  /** 멈추고, 보고를 기다리던 업데이트는 버린다. */
  async close(): Promise<void> {
    await this.stop();
    for (const timer of this.updateTimers) clearTimeout(timer);
    this.updateTimers.clear();
    this.updates.clear();
    for (const d of this.devices.values()) d.updating = false;
    this.client?.close();
  }

  private async tickIfIdle(): Promise<void> {
    if (this.inTick) {
      this.stats.skippedTicks += 1;
      return;
    }
    this.inTick = this.tick().finally(() => (this.inTick = null));
    await this.inTick;
  }

  /** 한 주기: 온라인 단말기를 batchSize씩 묶어 보낸다. */
  async tick(): Promise<void> {
    this.stats.ticks += 1;
    this.stats.lastTickAt = new Date().toISOString();
    const online = [...this.devices.values()].filter((d) => !d.offline);
    const batches: Device[][] = [];
    for (let i = 0; i < online.length; i += this.config.batchSize) batches.push(online.slice(i, i + this.config.batchSize));
    await runPool(batches, this.config.concurrency, (batch) => this.send(batch));
  }

  private async send(batch: Device[]): Promise<void> {
    const client = this.client!;
    this.stats.requests += 1;
    this.stats.heartbeatsSent += batch.length;
    try {
      const res = await client.postJson('/devices/heartbeats', {
        items: batch.map((d) => ({ serialNo: d.serialNo, firmwareVersion: d.firmwareVersion })),
      });
      this.stats.recordLatency(res.ms);
      if (res.status < 200 || res.status >= 300) {
        this.stats.errors += 1;
        return;
      }
      const results = (res.body as { results?: HeartbeatResult[] } | null)?.results ?? [];
      for (const r of results) {
        if (r.result === 'OK') this.stats.heartbeatsAccepted += 1;
        else this.stats.heartbeatsRejected += 1;
        if (r.update) this.startUpdate(r.serialNo, r.update);
      }
    } catch {
      this.stats.errors += 1;
    }
  }

  /**
   * 업데이트 지시: 이미 업데이트 중이거나 이미 그 버전이면 무시한다(성공 보고 직전에 읽힌 하트비트 응답이 지시를 한 번 더 싣고 올 수 있다).
   * updateDelayMs(+ 0~updateJitterMs) 뒤 결과를 정해 보고한다.
   */
  private startUpdate(serialNo: string, offer: UpdateOffer): void {
    const device = this.devices.get(serialNo);
    if (!device || device.updating || device.firmwareVersion === offer.version) return;
    device.updating = true;
    this.stats.updateOffers += 1;
    const client = this.client!;
    const jitter = this.config.updateJitterMs > 0 ? Math.floor(this.rng() * this.config.updateJitterMs) : 0;
    const work = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.updateTimers.delete(timer);
        // 실패율 0이면 난수를 쓰지 않는다(다른 난수 순서를 흔들지 않게, partners와 같은 규칙)
        const success = !(this.config.firmwareFailRate > 0 && this.rng() < this.config.firmwareFailRate);
        void this.report(client, device, offer, success).finally(resolve);
      }, this.config.updateDelayMs + jitter);
      this.updateTimers.add(timer);
    });
    this.updates.add(work);
    void work.finally(() => this.updates.delete(work));
  }

  private async report(client: ApiClient, device: Device, offer: UpdateOffer, success: boolean): Promise<void> {
    try {
      const res = await client.postJson('/devices/firmware-reports', {
        serialNo: device.serialNo,
        rolloutId: offer.rolloutId,
        success,
        version: offer.version,
      });
      if (res.status < 200 || res.status >= 300) {
        this.stats.reportErrors += 1;
        return;
      }
      if (success) {
        this.stats.reportsSucceeded += 1;
        device.firmwareVersion = offer.version;
      } else {
        this.stats.reportsFailed += 1;
      }
    } catch {
      this.stats.reportErrors += 1;
    } finally {
      device.updating = false;
    }
  }
}
```

- [ ] **Step 4: 시뮬레이터 통과 확인**

Run (`apps/device-sim`): `npx vitest run && npx vitest run && npm run typecheck && npm run build`
Expected: 두 번 모두 `Test Files  4 passed (4)`, `Tests  19 passed (19)`, typecheck·build exit 0.

- [ ] **Step 5: API 쪽 실제 프로세스 연동 테스트**

`apps/api/test/helpers/device-sim.ts`(새):
```ts
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/** 테스트용 단말기 시뮬레이터 관리 포트(개발용 4020과 겹치지 않게) */
export const TEST_DEVICE_SIM_PORT = 4021;

const simDir = resolve(process.cwd(), '../device-sim');

/** device-sim 관리 API의 stats(apps/device-sim/src/stats.ts StatsView + running) */
export interface DeviceSimStats {
  running: boolean;
  ticks: number;
  skippedTicks: number;
  requests: number;
  heartbeatsSent: number;
  heartbeatsAccepted: number;
  heartbeatsRejected: number;
  errors: number;
  latency: { count: number; p50: number; p95: number; max: number };
  updateOffers: number;
  reportsSucceeded: number;
  reportsFailed: number;
  reportErrors: number;
}

async function isUp(base: string): Promise<boolean> {
  try {
    return (await fetch(`${base}/__admin/health`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
}

/**
 * 단말기 시뮬레이터(apps/device-sim)를 빌드해 자식 프로세스로 띄운다(partners의 globalSetup과 같은 방식).
 * 대부분의 e2e는 API를 직접 부르고, 실제 프로세스가 필요한 곳(연동 확인·실험)만 이것을 쓴다. 끌 때는 이 PID만 끈다.
 */
export async function startDeviceSim(port = TEST_DEVICE_SIM_PORT) {
  const base = `http://127.0.0.1:${port}`;
  if (await isUp(base)) throw new Error(`${base}에 이미 서버가 떠 있습니다. 테스트용 device-sim 포트를 비우고 다시 실행하세요.`);
  const tsc = createRequire(resolve(simDir, 'package.json')).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', resolve(simDir, 'tsconfig.build.json')], { stdio: 'inherit' });
  const child = spawn(process.execPath, [resolve(simDir, 'dist/main.js')], {
    env: { ...process.env, DEVICE_SIM_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const deadline = Date.now() + 10_000;
  while (!(await isUp(base))) {
    if (child.exitCode !== null) throw new Error(`device-sim이 시작하자마자 종료됐습니다(exit ${child.exitCode}).`);
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('device-sim이 10초 안에 뜨지 않았습니다.');
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`device-sim ${method} ${path} → ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  return {
    base,
    pid: child.pid,
    configure: (patch: Record<string, unknown>) => call<Record<string, unknown>>('POST', '/__admin/config', patch),
    start: () => call<unknown>('POST', '/__admin/start'),
    stop: () => call<unknown>('POST', '/__admin/stop'),
    reset: () => call<unknown>('POST', '/__admin/reset'),
    stats: () => call<DeviceSimStats>('GET', '/__admin/stats'),
    device: (serialNo: string) => call<{ serialNo: string; firmwareVersion: string; offline: boolean; updating: boolean }>('GET', `/__admin/devices/${serialNo}`),
    /** 자식 프로세스(이 PID)만 끈다 */
    close: async () => {
      if (child.exitCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    },
  };
}

export type DeviceSim = Awaited<ReturnType<typeof startDeviceSim>>;
```

`apps/api/test/device-sim.e2e.spec.ts`(새, 앱을 실제 포트로 열고 시뮬레이터가 그 주소로 보낸다):
```ts
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../src/device/active-set.service.js';
import { deviceKeys } from '../src/device/device-keys.js';
import { RolloutService } from '../src/firmware/rollout.service.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { seedInService } from './helpers/device-fleet.js';
import { startDeviceSim, type DeviceSim } from './helpers/device-sim.js';
import { waitFor } from './helpers/queues.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'han' };

describe('단말기 시뮬레이터 ↔ API — 실제 프로세스 연동 (F8)', () => {
  let t: TestApp;
  let redis: Redis;
  let sim: DeviceSim;
  let apiUrl: string;

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    await resetDatabase(t.orm);
    await seedInService(t, 'DS', 5);
    await deleteTestKeys(redis, 'hb:');
    await t.app.get(ActiveSetService).rebuild();
    await t.app.listen(0, '127.0.0.1');
    apiUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
    sim = await startDeviceSim();
  }, 60_000);
  afterAll(async () => {
    await sim?.close();
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('하트비트가 Redis에 남고, 100% 배포 제안을 시뮬레이터가 받아 성공을 보고하면 판단 job이 COMPLETED', async () => {
    await sim.configure({ targetUrl: apiUrl, serialPrefix: 'DS', count: 5, intervalMs: 200, batchSize: 5, updateDelayMs: 50, firmwareVersion: '1.0.0' });
    await sim.start();
    await waitFor(async () => (await redis.zcard(deviceKeys().lastSeen)) === 5, { message: '하트비트 5대' });

    await t.http().post('/firmware').set(OP).send({ modelCode: 'SN-100', version: '2.0.0' });
    const created = await t.http().post('/firmware-rollouts').set(OP).send({ modelCode: 'SN-100', version: '2.0.0', stages: [100], failureThreshold: 0.2, minSamples: 1 });
    expect(created.status).toBe(201);
    await waitFor(async () => (await sim.stats()).reportsSucceeded === 5, { message: '성공 보고 5건' });
    expect((await t.app.get(RolloutService).control(created.body.id)).action).toBe('COMPLETED');
    await waitFor(async () => Object.values(await redis.hgetall(deviceKeys().firmware)).every((v) => v === '2.0.0'), { message: '펌웨어 2.0.0' });
    expect((await sim.device('DS-0003')).firmwareVersion).toBe('2.0.0');

    await sim.stop();
    const stats = await sim.stats();
    console.log(`[device-sim 연동] ${JSON.stringify({ ...stats, latency: undefined })}`);
    expect(stats).toMatchObject({ errors: 0, heartbeatsRejected: 0, updateOffers: 5, reportsFailed: 0, reportErrors: 0 });
    expect(stats.heartbeatsAccepted).toBe(stats.heartbeatsSent);
  });
});
```

Run (`apps/api`):
```bash
npx vitest run test/device-sim.e2e.spec.ts --silent=false 2>&1 | grep -E "device-sim 연동|Tests "
netstat -ano | grep -E ':4021 .*LISTENING'
npx vitest run && npm run typecheck
```
Expected: `Tests  1 passed (1)`, `[device-sim 연동] {"running":false,…,"heartbeatsRejected":0,"errors":0,"updateOffers":5,"reportsSucceeded":5,"reportsFailed":0,"reportErrors":0,…}`. netstat 결과 없음(자식 프로세스가 꺼짐). 전체 `Test Files  38 passed (38)`, `Tests  237 passed (237)`, typecheck exit 0. (이 테스트 파일은 하트비트를 실제로 몇 주기 기다리고 tsc 빌드를 하므로 몇 초 걸린다.)

- [ ] **Step 6: 기록과 커밋**

devlog에 `## HH:MM Task 8 시뮬레이터 펌웨어 업데이트 흉내와 실제 프로세스 연동 (F8, F12)` 항목.

`docs/decisions/0009-…`의 Day 4 갱신 줄 뒤에 한 줄:
```
- 갱신(Task 8): 업데이트 지시를 받으면 updateDelayMs + 0~updateJitterMs(시드 난수) 뒤 firmwareFailRate로 결과를 정해 보고한다. 지터는 보고가 한꺼번에 몰리지 않게(자동 중단 시점을 보려고), "이미 그 버전이면 무시"는 성공 보고와 겹친 하트비트 응답이 지시를 한 번 더 실어 오는 경합 때문이다(사전 검증에서 관찰, 보고는 멱등). 실패율 0이면 난수를 쓰지 않는다(partners와 같은 규칙).
```

`docs/study/backlog.md`에 추가:
```
- [ ] 시뮬레이션에서 지연 분포(고정·균등·지수)가 결과(감지 시점)를 바꾸는 방식 (apps/device-sim/src/fleet.ts updateJitterMs)
```

커밋:
```bash
git add apps/device-sim apps/api docs
git commit -m "feat(F8): 시뮬레이터 펌웨어 업데이트 흉내와 API 실제 프로세스 연동 테스트" -m "Refs: docs/decisions/0009-가상-업체-서버는-node-http-별도-프로세스.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: 실험 0008 — 하트비트 5,000대: Redis 대 MySQL 직접 쓰기, 묶음 대 단건, 오프라인 판정 시간 (F8)

**Files:**
- Modify: `apps/api/src/device/heartbeat.service.ts`(실험용 쓰기 경로), `apps/api/src/config/env.ts`
- Test: `apps/api/test/heartbeat.e2e.spec.ts`(실험용 경로 테스트 1개), `apps/api/test/helpers/metrics.ts`(새), `apps/api/test/experiments/heartbeat-load.spec.ts`(새, EXPERIMENTS=1)
- Record: devlog, `docs/experiments/0008-하트비트-5000대.md`, `docs/decisions/0027-…`(갱신), `docs/study/backlog.md`

질문:
1. 5,000대가 5초마다 보낼 때(초당 1,000건) Redis 경로는 다 받는가, 응답 p50·p95는? MySQL에는 무엇이 몇 번 쓰이나(스냅샷만)?
2. "하트비트마다 MySQL `device_connectivity` UPSERT" 경로(실험용, `writeMode = 'mysql'`)와 비교하면 쓰기 문장 수·바뀐 행 수·응답 시간·데드락은?
3. 묶음 100 대 단건(묶음 1): 요청 수·Redis 명령 수·응답 시간은?
4. 하트비트를 끊은 1%(50대)가 오프라인으로 판정되기까지 걸린 시간은(기준 = 주기 × 3, 판정 1초마다)? 살아 있는 단말기가 잘못 판정되지 않는가?

예상: Redis 경로의 MySQL 쓰기는 스냅샷 횟수 × ⌈5,000/500⌉ 문장뿐이고, MySQL 경로는 요청마다 한 문장(단건이면 하트비트 수만큼). 단건은 요청·Redis 명령이 묶음의 약 100배. 판정 시간은 "기준 - (끊기 직전 마지막 하트비트 뒤 지난 시간) + 판정 주기" 범위, 즉 기준 - 주기 ~ 기준 + 판정 주기.

- [ ] **Step 1: 실험용 쓰기 경로 테스트(실패 먼저)**

`apps/api/test/heartbeat.e2e.spec.ts` 전체(`실험용 쓰기 경로(writeMode mysql)` 테스트 추가):
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../src/device/active-set.service.js';
import { DeviceConnectivity } from '../src/device/device-connectivity.entity.js';
import { deviceKeys } from '../src/device/device-keys.js';
import { HeartbeatService } from '../src/device/heartbeat.service.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { captureQueries } from './helpers/query-log.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { prepareInService, SCENARIO_OP } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('하트비트 (F8, decisions/0027·0028)', () => {
  let t: TestApp;
  let redis: Redis;
  const keys = () => deviceKeys();
  const beat = (items: unknown[]) => t.http().post('/devices/heartbeats').send({ items });
  const idOf = async (serialNo: string) => String((await t.orm.em.fork().findOneOrFail(Terminal, { serialNo })).id);

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    await resetDatabase(t.orm);
    await prepareInService(t, 'HB-0001');
    await prepareInService(t, 'HB-0002');
    await t.http().post('/terminals').set(SCENARIO_OP).send({ serialNo: 'HB-0003', modelCode: 'SN-100' }); // RECEIVED
  });
  beforeEach(async () => {
    await deleteTestKeys(redis, 'hb:');
    await t.app.get(ActiveSetService).rebuild();
  });
  afterAll(async () => {
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('active는 MySQL의 IN_SERVICE 단말기(serialNo → id)로 다시 만들고, TTL이 없다', async () => {
    expect(await redis.hgetall(keys().active)).toEqual({ 'HB-0001': await idOf('HB-0001'), 'HB-0002': await idOf('HB-0002') });
    expect(await redis.pttl(keys().active)).toBe(-1);
    // 다시 만들면 바뀐 상태를 따라간다(남은 임시 키 없음)
    await t.orm.em.fork().nativeUpdate(Terminal, { serialNo: 'HB-0002' }, { status: TerminalStatus.RETURN_REQUESTED });
    expect(await t.app.get(ActiveSetService).rebuild()).toBe(1);
    expect(await redis.hkeys(keys().active)).toEqual(['HB-0001']);
    expect(await redis.keys(`${keys().active}:rebuild:*`)).toEqual([]);
    await t.orm.em.fork().nativeUpdate(Terminal, { serialNo: 'HB-0002' }, { status: TerminalStatus.IN_SERVICE });
  });

  it('묶음의 행마다 결과: 운영 중이면 OK, 아니면 IGNORED_NOT_IN_SERVICE, 형식이 틀리면 INVALID_FORMAT', async () => {
    const before = Date.now();
    const res = await beat([
      { serialNo: 'HB-0001', firmwareVersion: '1.0.0' },
      { serialNo: 'HB-0003', firmwareVersion: '1.0.0' },
      { serialNo: 'bad serial', firmwareVersion: '1.0.0' },
      { serialNo: 'HB-0002' },
      { serialNo: ' HB-0002 ', firmwareVersion: '1.0.1' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(2);
    expect(res.body.results.map((r: { serialNo: string; result: string }) => [r.serialNo, r.result])).toEqual([
      ['HB-0001', 'OK'],
      ['HB-0003', 'IGNORED_NOT_IN_SERVICE'],
      ['bad serial', 'INVALID_FORMAT'],
      ['HB-0002', 'INVALID_FORMAT'],
      ['HB-0002', 'OK'],
    ]);

    const seen = Number(await redis.zscore(keys().lastSeen, 'HB-0001'));
    expect(seen).toBeGreaterThanOrEqual(before);
    expect(seen).toBeLessThanOrEqual(Date.now());
    expect(await redis.hgetall(keys().firmware)).toEqual({ 'HB-0001': '1.0.0', 'HB-0002': '1.0.1' });
    expect(await redis.zscore(keys().lastSeen, 'HB-0003')).toBeNull();
  });

  it('하트비트는 MySQL에 아무 쿼리도 보내지 않는다(상태 전이가 아니다)', async () => {
    const log = captureQueries(t.orm);
    try {
      expect((await beat([{ serialNo: 'HB-0001', firmwareVersion: '1.0.0' }])).status).toBe(200);
    } finally {
      log.stop();
    }
    expect(log.queries).toEqual([]);
    expect((await t.http().get('/terminals/HB-0001/history')).body.at(-1).toStatus).toBe('IN_SERVICE');
  });

  it('실험용 쓰기 경로(writeMode mysql): Redis 대신 device_connectivity에 바로 UPSERT한다(문장 1개)', async () => {
    const heartbeats = t.app.get(HeartbeatService);
    heartbeats.writeMode = 'mysql';
    const log = captureQueries(t.orm);
    try {
      const res = await beat([
        { serialNo: 'HB-0002', firmwareVersion: '1.0.2' },
        { serialNo: 'HB-0001', firmwareVersion: '1.0.1' },
      ]);
      expect(res.body.accepted).toBe(2);
    } finally {
      log.stop();
      heartbeats.writeMode = 'redis';
    }
    expect(log.queries).toHaveLength(1);
    expect(log.queries[0]).toMatch(/^insert into `device_connectivity`.* on duplicate key update/);
    expect(await redis.zcard(keys().lastSeen)).toBe(0);
    const rows = await t.orm.em.fork().find(DeviceConnectivity, {}, { orderBy: { terminalId: 'asc' } });
    expect(rows.map((r) => [r.terminalId, r.online, r.firmwareVersion])).toEqual([
      [Number(await idOf('HB-0001')), true, '1.0.1'],
      [Number(await idOf('HB-0002')), true, '1.0.2'],
    ]);
  });

  it('묶음 모양이 틀리면 400(빈 배열, 500개 초과, 배열 아님, 객체가 아닌 항목, 모르는 필드)', async () => {
    expect((await beat([])).status).toBe(400);
    expect((await beat(Array.from({ length: 501 }, () => ({ serialNo: 'HB-0001', firmwareVersion: '1' })))).status).toBe(400);
    expect((await t.http().post('/devices/heartbeats').send({ items: 'x' })).status).toBe(400);
    expect((await beat(['HB-0001'])).status).toBe(400);
    expect((await t.http().post('/devices/heartbeats').send({ items: [{}], extra: 1 })).status).toBe(400);
  });
});
```

Run: `npx vitest run test/heartbeat.e2e.spec.ts`
Expected: `Tests  1 failed | 4 passed (5)` — `expected [] to have a length of 1 but got +0`(writeMode가 없어 Redis에 썼다).

- [ ] **Step 2: 실험용 경로 구현**

`apps/api/src/config/env.ts` 전체(`heartbeatWriteMode`, 기본 `redis`):
```ts
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// 스크립트·테스트는 apps/api에서 실행한다. 저장소 루트의 .env를 읽는다(이미 있는 환경변수는 덮어쓰지 않는다).
const envFile = resolve(process.cwd(), '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경변수 ${name}가 없습니다. 저장소 루트 .env를 확인하세요.`);
  return value;
}

function flag(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  return value === undefined ? fallback : value === '1' || value === 'true';
}

const isTest = process.env.NODE_ENV === 'test';

export const env = {
  port: Number(process.env.API_PORT ?? 3000),
  mysql: {
    host: process.env.MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: required('MYSQL_USER'),
    password: required('MYSQL_PASSWORD'),
    dbName: isTest ? required('MYSQL_TEST_DATABASE') : required('MYSQL_DATABASE'),
  },
  /** 가상 업체 서버(apps/partners) 주소 */
  partnersUrl: process.env.PARTNERS_URL ?? 'http://127.0.0.1:4010',
  /** 택배사·메신저 호출 타임아웃 */
  partnerTimeoutMs: Number(process.env.PARTNER_TIMEOUT_MS ?? 3000),
  redis: {
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
  /**
   * BullMQ 키 접두사. 테스트는 파일마다 다른 접두사를 써서 다른 파일의 job을 보지 않는다
   * (vitest는 테스트 파일마다 모듈을 새로 읽으므로 이 값도 파일마다 새로 정해진다).
   */
  queuePrefix: process.env.QUEUE_PREFIX ?? (isTest ? `test-${process.pid}-${Date.now()}` : 'terminal-ops'),
  /** 이 프로세스가 큐 job을 처리할지 */
  runWorkers: flag('RUN_WORKERS', true),
  /** 이 프로세스가 주기 작업(수집 sweep, outbox relay)을 등록할지 */
  runSchedulers: flag('RUN_SCHEDULERS', !isTest),
  sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS ?? 30_000),
  relayIntervalMs: Number(process.env.RELAY_INTERVAL_MS ?? 2_000),
  /** 운영 중 단말기 목록(Redis active)을 MySQL에서 통째로 다시 만드는 주기(decisions/0028) */
  activeRebuildIntervalMs: Number(process.env.ACTIVE_REBUILD_INTERVAL_MS ?? 60_000),
  /** 하트비트 쓰기 경로. 'mysql'은 실험 0008 비교용(decisions/0027), 운영은 'redis' */
  heartbeatWriteMode: (process.env.HEARTBEAT_WRITE_MODE === 'mysql' ? 'mysql' : 'redis') as 'redis' | 'mysql',
  /** 마지막 하트비트가 이보다 오래되면 오프라인으로 본다(단말기 하트비트 주기 30초의 3배, decisions/0029) */
  hbOfflineAfterMs: Number(process.env.HEARTBEAT_OFFLINE_AFTER_MS ?? 90_000),
  /** 오프라인 판정 주기 */
  offlineDetectIntervalMs: Number(process.env.OFFLINE_DETECT_INTERVAL_MS ?? 10_000),
  /** 접속 상태 스냅샷(Redis → MySQL) 주기 */
  connectivitySnapshotIntervalMs: Number(process.env.CONNECTIVITY_SNAPSHOT_INTERVAL_MS ?? 60_000),
  /** 펌웨어 배포 판단(단계 넘기기·자동 중단·시간 초과) 주기(decisions/0031) */
  rolloutControlIntervalMs: Number(process.env.ROLLOUT_CONTROL_INTERVAL_MS ?? 5_000),
  /** 우리 쪽 호출 속도 제한(초당). 택배사 한도보다 낮게 둔다. */
  bungaeRatePerSec: Number(process.env.BUNGAE_RATE_PER_SEC ?? 10),
  neurimboRatePerSec: Number(process.env.NEURIMBO_RATE_PER_SEC ?? 5),
  /** 알림을 보낼 톡톡메신저 채널 */
  toktokChannel: process.env.TOKTOK_CHANNEL ?? 'ops',
  /** 박스 스캔 처리 중 잠금(Redis) 유지 시간. 처리가 이보다 길면 잠금이 풀린다(decisions/0020) */
  scanLockTtlMs: Number(process.env.SCAN_LOCK_TTL_MS ?? 30_000),
  /** A/S 교체 단말기 예약(Redis) 유지 시간. 운송장 발급 + 교체 트랜잭션이 이보다 길면 예약이 풀린다(decisions/0026) */
  replacementLockTtlMs: Number(process.env.REPLACEMENT_LOCK_TTL_MS ?? 30_000),
  /** SyncRun에 남길 작업 프로세스 이름(워커 2개 실험에서 구분용) */
  workerName: process.env.WORKER_NAME ?? `pid-${process.pid}`,
};
```

`apps/api/src/device/heartbeat.service.ts` 전체(`writeMode`, EntityManager 주입, mysql이면 `upsertConnectivity` 한 문장. active·offers 확인은 그대로 Redis):
```ts
import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { execOrThrow } from '../redis/redis-exec.js';
import { REDIS } from '../redis/redis.provider.js';
import { normalizeValue, SERIAL_NO_MESSAGE, SERIAL_NO_PATTERN } from '../terminal/bulk-rows.js';
import { upsertConnectivity } from './connectivity.service.js';
import { deviceKeys } from './device-keys.js';
import type { FirmwareOffer } from './offer-store.js';

/** 펌웨어 버전 형식: 영문·숫자·점·하이픈 1~20자 */
export const FIRMWARE_VERSION_PATTERN = /^[0-9A-Za-z.-]{1,20}$/;

export type HeartbeatResultCode = 'OK' | 'IGNORED_NOT_IN_SERVICE' | 'INVALID_FORMAT';

export interface HeartbeatRowResult {
  serialNo: string;
  result: HeartbeatResultCode;
  message?: string;
  /** 이 단말기에 펌웨어 업데이트 제안이 있으면(decisions/0030) */
  update?: FirmwareOffer;
}

export interface HeartbeatResponse {
  /** OK인 행 수 */
  accepted: number;
  /** 입력과 같은 순서의 행별 결과 */
  results: HeartbeatRowResult[];
}

/**
 * 단말기 하트비트(F8). 상태 전이가 아니다 — TransitionService·이력·Outbox를 거치지 않고, MySQL에도 쓰지 않는다(decisions/0027).
 * 쓰는 곳은 Redis뿐이다: 마지막 시각(ZSET lastSeen, 서버 시계)과 펌웨어 버전(HASH firmware).
 * 운영 중(IN_SERVICE) 단말기의 하트비트만 받는다. 그 판단도 MySQL 대신 Redis HASH active로 한다(decisions/0028).
 * 업데이트 제안(HASH offers)이 있으면 응답의 그 행에 update로 싣는다(decisions/0030).
 * 왕복은 묶음당 2번: ① active·offers 조회(pipeline) ② lastSeen·firmware 쓰기(pipeline).
 */
@Injectable()
export class HeartbeatService {
  /**
   * 실험 0008 전용 비교 경로(decisions/0027). 'mysql'이면 lastSeen·firmware를 Redis 대신 하트비트 묶음마다
   * device_connectivity에 바로 UPSERT한다(active·offers 확인은 그대로 Redis). 운영 기본은 'redis'(HEARTBEAT_WRITE_MODE).
   */
  writeMode: 'redis' | 'mysql' = env.heartbeatWriteMode;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly em: EntityManager,
  ) {}

  async receive(items: Record<string, unknown>[], now = Date.now()): Promise<HeartbeatResponse> {
    const rows = items.map((item) => ({ serialNo: normalizeValue(item.serialNo), firmwareVersion: normalizeValue(item.firmwareVersion) }));
    const results: (HeartbeatRowResult | null)[] = rows.map((r) => {
      if (!SERIAL_NO_PATTERN.test(r.serialNo)) return { serialNo: r.serialNo, result: 'INVALID_FORMAT', message: SERIAL_NO_MESSAGE };
      if (!FIRMWARE_VERSION_PATTERN.test(r.firmwareVersion)) {
        return { serialNo: r.serialNo, result: 'INVALID_FORMAT', message: 'firmwareVersion은 영문·숫자·점·하이픈 1~20자입니다.' };
      }
      return null;
    });
    const valid = rows.flatMap((r, i) => (results[i] ? [] : [{ ...r, i }]));
    const keys = deviceKeys();

    const serials = valid.map((r) => r.serialNo);
    const [ids, offers] =
      valid.length > 0
        ? ((await execOrThrow(this.redis.pipeline().hmget(keys.active, ...serials).hmget(keys.offers, ...serials))) as (string | null)[][])
        : [[], []];
    const accepted = valid
      .map((r, k) => ({ ...r, terminalId: ids[k], offer: offers[k] }))
      .filter((r) => {
        if (r.terminalId !== null) return true;
        results[r.i] = { serialNo: r.serialNo, result: 'IGNORED_NOT_IN_SERVICE', message: '운영 중(IN_SERVICE)인 단말기의 하트비트만 받습니다.' };
        return false;
      });

    if (accepted.length > 0 && this.writeMode === 'mysql') {
      const at = new Date(now);
      const rows = accepted
        .map((r) => ({ terminalId: Number(r.terminalId), online: true, lastSeenAt: at, firmwareVersion: r.firmwareVersion, changedAt: at }))
        .sort((a, b) => a.terminalId - b.terminalId);
      await upsertConnectivity(this.em.fork(), rows, ['online', 'lastSeenAt', 'firmwareVersion']);
    } else if (accepted.length > 0) {
      const write = this.redis.pipeline();
      write.zadd(keys.lastSeen, ...accepted.flatMap((r) => [now, r.serialNo]));
      write.hset(keys.firmware, Object.fromEntries(accepted.map((r) => [r.serialNo, r.firmwareVersion])));
      await execOrThrow(write);
    }
    for (const r of accepted) {
      results[r.i] = r.offer ? { serialNo: r.serialNo, result: 'OK', update: JSON.parse(r.offer) as FirmwareOffer } : { serialNo: r.serialNo, result: 'OK' };
    }
    return { accepted: accepted.length, results: results as HeartbeatRowResult[] };
  }
}
```

Run: `npx vitest run test/heartbeat.e2e.spec.ts && npx vitest run && npm run typecheck`
Expected: `5 passed`. 전체 `Test Files  38 passed (38)`, `Tests  238 passed (238)`(실험 파일은 기본 실행에서 빠진다), typecheck exit 0.

- [ ] **Step 3: 측정 헬퍼와 실험 스펙**

`apps/api/test/helpers/metrics.ts`(새):
```ts
import type { Redis } from 'ioredis';
import type { TestApp } from './test-app.js';

/** 실험에서 보는 MySQL 서버 전체 카운터. 앱 계정으로 읽을 수 있다(SHOW GLOBAL STATUS, PROCESS 권한 불필요) */
const MYSQL_COUNTERS = ['Com_insert', 'Com_update', 'Com_select', 'Innodb_rows_inserted', 'Innodb_rows_updated', 'Innodb_row_lock_waits'];

/** MySQL 서버 전체 카운터(다른 연결의 쿼리도 섞인다 — 실험 중에는 다른 작업을 돌리지 않는다) */
export async function mysqlCounters(t: TestApp): Promise<Record<string, number>> {
  const rows = await t.orm.em
    .fork()
    .execute<{ Variable_name: string; Value: string }[]>(
      `show global status where Variable_name in (${MYSQL_COUNTERS.map((c) => `'${c}'`).join(', ')})`,
    );
  return Object.fromEntries(rows.map((r) => [r.Variable_name, Number(r.Value)]));
}

/** Redis 명령별 누적 호출 수(INFO commandstats). 서버 전체 값이다 */
export async function redisCommandCalls(redis: Redis): Promise<Record<string, number>> {
  const text = await redis.info('commandstats');
  const out: Record<string, number> = {};
  for (const m of text.matchAll(/^cmdstat_([^:]+):calls=(\d+)/gm)) out[m[1]] = Number(m[2]);
  return out;
}

/** 두 카운터의 차이(0은 뺀다) */
export function delta(after: Record<string, number>, before: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(after)) {
    const d = v - (before[k] ?? 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}

export const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
```

`apps/api/test/experiments/heartbeat-load.spec.ts`(새):
```ts
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../../src/device/active-set.service.js';
import { ConnectivityService } from '../../src/device/connectivity.service.js';
import { DeviceConnectivity } from '../../src/device/device-connectivity.entity.js';
import { deviceKeys } from '../../src/device/device-keys.js';
import { HeartbeatService } from '../../src/device/heartbeat.service.js';
import { OutboxEvent } from '../../src/outbox/outbox-event.entity.js';
import { REDIS } from '../../src/redis/redis.provider.js';
import { seedInService } from '../helpers/device-fleet.js';
import { startDeviceSim, type DeviceSim } from '../helpers/device-sim.js';
import { delta, mysqlCounters, redisCommandCalls, sum } from '../helpers/metrics.js';
import { captureQueries } from '../helpers/query-log.js';
import { deleteTestKeys } from '../helpers/redis-keys.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

// experiments/0008. 실행: EXPERIMENTS=1 npx vitest run test/experiments/heartbeat-load.spec.ts --silent=false
// 변형 하나만: EXP_VARIANTS=mysql-single … (데드락 수를 변형별로 나눠 재려면 변형마다 따로 실행한다)
const N = Number(process.env.EXP_N ?? 5000);
const INTERVAL = Number(process.env.EXP_INTERVAL_MS ?? 5000);
const DURATION = Number(process.env.EXP_DURATION_MS ?? 30_000);
const CONCURRENCY = Number(process.env.EXP_CONCURRENCY ?? 16);
const SNAPSHOT_EVERY = Number(process.env.EXP_SNAPSHOT_MS ?? 10_000);
const OFFLINE_AFTER = Number(process.env.EXP_OFFLINE_AFTER_MS ?? INTERVAL * 3);
const DETECT_EVERY = Number(process.env.EXP_DETECT_MS ?? 1000);
const OFFLINE_RATE = Number(process.env.EXP_OFFLINE_RATE ?? 0.01);
const VARIANTS = (process.env.EXP_VARIANTS ?? 'redis-batch,redis-single,mysql-batch,mysql-single,offline').split(',');
const LOAD = ['redis-batch', 'redis-single', 'mysql-batch', 'mysql-single'] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe(`실험 0008: 하트비트 ${N}대 — Redis 대 MySQL 직접 쓰기, 묶음 대 단건, 오프라인 판정`, () => {
  let t: TestApp;
  let redis: Redis;
  let sim: DeviceSim;
  let apiUrl: string;
  let heartbeats: HeartbeatService;
  let conn: ConnectivityService;

  async function clearState() {
    const k = deviceKeys();
    await redis.del(k.lastSeen, k.firmware, k.offline, k.snapshotAt);
    await t.orm.em.fork().nativeDelete(DeviceConnectivity, {});
  }

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    heartbeats = t.app.get(HeartbeatService);
    conn = t.app.get(ConnectivityService);
    await resetDatabase(t.orm);
    await seedInService(t, 'HL', N);
    await deleteTestKeys(redis, 'hb:');
    expect(await t.app.get(ActiveSetService).rebuild()).toBe(N);
    await t.app.listen(0, '127.0.0.1');
    apiUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
    sim = await startDeviceSim();
  }, 120_000);
  afterAll(async () => {
    heartbeats.writeMode = 'redis';
    await sim?.close();
    await deleteTestKeys(redis);
    await t.app.close();
  });

  for (const variant of LOAD) {
    it.runIf(VARIANTS.includes(variant))(`${variant}: ${DURATION / 1000}초 동안 주기 ${INTERVAL}ms`, async () => {
      const [mode, shape] = variant.split('-') as ['redis' | 'mysql', 'batch' | 'single'];
      await clearState();
      heartbeats.writeMode = mode;
      await sim.reset();
      await sim.configure({ targetUrl: apiUrl, serialPrefix: 'HL', count: N, intervalMs: INTERVAL, batchSize: shape === 'batch' ? 100 : 1, concurrency: CONCURRENCY });

      const m0 = await mysqlCounters(t);
      const r0 = await redisCommandCalls(redis);
      const log = captureQueries(t.orm);
      const started = performance.now();
      let snapshots = 0;
      const timer = mode === 'redis' ? setInterval(() => void conn.snapshot().then(() => (snapshots += 1)), SNAPSHOT_EVERY) : null;
      try {
        await sim.start();
        await sleep(DURATION);
        await sim.stop();
      } finally {
        if (timer) clearInterval(timer);
      }
      if (mode === 'redis') {
        await conn.snapshot(); // 마지막 주기 뒤 남은 변화
        snapshots += 1;
      }
      const seconds = (performance.now() - started) / 1000;
      log.stop();
      const m = delta(await mysqlCounters(t), m0);
      const r = delta(await redisCommandCalls(redis), r0);
      const s = await sim.stats();
      const writes = log.queries.filter((q) => /^(insert|update)/i.test(q)).length;
      const rowsInDb = await t.orm.em.fork().count(DeviceConnectivity, {});
      console.log(
        `[실험 0008/${variant}] N=${N} 주기=${INTERVAL}ms 시간=${seconds.toFixed(1)}s 요청=${s.requests} 하트비트=${s.heartbeatsSent} ` +
          `받음=${s.heartbeatsAccepted} 오류=${s.errors} 건너뛴주기=${s.skippedTicks} 처리량=${Math.round(s.heartbeatsAccepted / seconds)}/s ` +
          `p50=${s.latency.p50.toFixed(1)}ms p95=${s.latency.p95.toFixed(1)}ms max=${s.latency.max.toFixed(1)}ms`,
      );
      console.log(
        `[실험 0008/${variant}] MySQL 앱쓰기문장=${writes} 스냅샷=${snapshots}회 device_connectivity행=${rowsInDb} 서버=${JSON.stringify(m)} | ` +
          `Redis 명령합=${sum(r)} ${JSON.stringify(r)}`,
      );

      expect(s.errors).toBe(0);
      expect(s.heartbeatsAccepted).toBe(s.heartbeatsSent);
      expect(rowsInDb).toBe(N);
      if (mode === 'redis') expect(await redis.zcard(deviceKeys().lastSeen)).toBe(N);
      else expect(await redis.zcard(deviceKeys().lastSeen)).toBe(0);
    }, DURATION + 120_000);
  }

  it.runIf(VARIANTS.includes('offline'))(`offline: 하트비트를 끊은 단말기(${OFFLINE_RATE * 100}%)가 오프라인으로 판정되기까지`, async () => {
    await clearState();
    heartbeats.writeMode = 'redis';
    await sim.reset();
    await sim.configure({ targetUrl: apiUrl, serialPrefix: 'HL', count: N, intervalMs: INTERVAL, batchSize: 100, concurrency: CONCURRENCY });
    await sim.start();
    await sleep(INTERVAL * 2);
    expect((await conn.detect(Date.now(), OFFLINE_AFTER)).offline).toEqual([]);

    const silent = Math.round(N * OFFLINE_RATE);
    const cut = Date.now();
    await sim.configure({ offlineRate: OFFLINE_RATE }); // 이 순간부터 silent대가 보내지 않는다(시드로 고른 단말기)
    const detectedAt = new Map<string, number>();
    let online = 0;
    const deadline = cut + OFFLINE_AFTER + INTERVAL * 3;
    while (detectedAt.size < silent && Date.now() < deadline) {
      await sleep(DETECT_EVERY);
      const r = await conn.detect(Date.now(), OFFLINE_AFTER);
      for (const s of r.offline) detectedAt.set(s, Date.now() - cut);
      online += r.online.length;
    }
    // 판정이 끝난 뒤 한 주기 더 돌려, 살아 있는 단말기가 잘못 오프라인이 되지 않는지 본다
    await sleep(INTERVAL);
    const after = await conn.detect(Date.now(), OFFLINE_AFTER);
    await sim.stop();
    const times = [...detectedAt.values()].sort((a, b) => a - b);
    const events = await t.orm.em.fork().count(OutboxEvent, { type: 'device.offline' });
    console.log(
      `[실험 0008/offline] N=${N} 주기=${INTERVAL}ms 끊은단말기=${silent} 기준=${OFFLINE_AFTER}ms 판정주기=${DETECT_EVERY}ms ` +
        `판정됨=${detectedAt.size} 첫판정=${times[0]}ms 마지막판정=${times.at(-1)}ms (끊은 시각부터) 온라인복귀=${online} ` +
        `추가오프라인=${after.offline.length} device.offline이벤트=${events}`,
    );
    expect(detectedAt.size).toBe(silent);
    expect(online).toBe(0);
    expect(after.offline).toEqual([]);
    expect(times[0]).toBeGreaterThanOrEqual(OFFLINE_AFTER - INTERVAL);
  }, OFFLINE_AFTER + INTERVAL * 8 + 60_000);
});
```

Run: `npx vitest run 2>&1 | grep -E "Test Files|Tests "`
Expected: `38 passed`, `238 passed`(실험 파일 제외 확인).

- [ ] **Step 4: 실험 실행 (변형마다 따로 — 데드락 수를 변형별로 나누려고)**

Run (Git Bash, `apps/api`):
```bash
DL() { MSYS_NO_PATHCONV=1 docker exec terminal-ops-mysql sh -c 'mysql -N -uroot -p"$MYSQL_ROOT_PASSWORD" -e "select count from information_schema.innodb_metrics where name=\"lock_deadlocks\""' 2>/dev/null; }
for v in redis-batch redis-single mysql-batch mysql-single offline; do
  b=$(DL); EXP_VARIANTS=$v EXPERIMENTS=1 npx vitest run test/experiments/heartbeat-load.spec.ts --silent=false 2>&1 | grep -E "\[실험 0008|Tests "; a=$(DL); echo "$v lock_deadlocks 전=$b 후=$a"
done
```
Expected: 변형마다 `Tests  1 passed | 4 skipped (5)`(사전 검증: 5개 변형 모두 통과, 한 번에 돌렸을 때 약 3분). 부하 변형은 두 줄씩:
- `[실험 0008/<변형>] N=5000 주기=5000ms 시간=…s 요청=… 하트비트=… 받음=… 오류=0 건너뛴주기=… 처리량=…/s p50=…ms p95=…ms max=…ms`
- `[실험 0008/<변형>] MySQL 앱쓰기문장=… 스냅샷=…회 device_connectivity행=5000 서버={…} | Redis 명령합=… {…}`
- 단언: 오류 0, 받음 = 하트비트, device_connectivity 5,000행, redis 변형은 lastSeen 5,000개·mysql 변형은 0개.
- offline: `[실험 0008/offline] N=5000 주기=5000ms 끊은단말기=50 기준=15000ms 판정주기=1000ms 판정됨=50 첫판정=…ms 마지막판정=…ms … 온라인복귀=0 추가오프라인=0 device.offline이벤트=50`
- 건너뛴 주기가 0이 아니면(주기 안에 다 못 보냄) 그대로 적고, `EXP_CONCURRENCY`를 바꿔 한 번 더 잰다.
- 끝나면 `netstat -ano | grep -E ':4021 .*LISTENING'` 결과 없음.

(선택) 한계 처리량: `EXP_INTERVAL_MS=1000 EXP_DURATION_MS=20000 EXP_VARIANTS=redis-batch,mysql-batch`로 한 번 더 돌려 건너뛴 주기·p95가 어떻게 바뀌는지 본다(초당 5,000건 부하).

- [ ] **Step 5: 기록과 커밋**

`docs/experiments/0008-하트비트-5000대.md`:
- 질문·예상: 위 그대로
- 설정: N=5,000(`EXP_N`, seedInService로 IN_SERVICE 단말기 INSERT), 주기 5초(`EXP_INTERVAL_MS`), 30초(`EXP_DURATION_MS`), 동시 요청 16(`EXP_CONCURRENCY`, keep-alive 소켓 16), 묶음 100/1, redis 변형의 스냅샷 10초마다(`EXP_SNAPSHOT_MS`, 운영 기본 60초보다 짧게 — 30초 안에 몇 번 일어나게) + 끝에 1번, 오프라인 1%(`EXP_OFFLINE_RATE`), 기준 15초(주기 × 3), 판정 1초. API는 테스트 앱 한 프로세스(워커·스케줄러 꺼짐, `t.app.listen`), device-sim은 별도 프로세스. 로컬 한 PC, Docker MySQL 8.4·Redis 7.4.
- 측정 방법: 처리량 = 받은 하트비트 / 걸린 초(주어진 부하), 응답 시간은 시뮬레이터가 잰 요청 단위 p50·p95·max, MySQL 쓰기 = 앱이 보낸 insert·update 문장 수(query-log) + `SHOW GLOBAL STATUS`의 `Com_insert`·`Innodb_rows_inserted`·`Innodb_rows_updated` 차이(서버 전체 값), Redis = `INFO commandstats` 호출 수 차이(서버 전체 값), 데드락 = root로 `lock_deadlocks` 전후(변형마다).
- 재현: Step 4 명령
- 결과: 원문 줄 전부 + 표(변형, 요청, 처리량, p50, p95, 앱 쓰기 문장, Innodb_rows_inserted/updated, Redis 명령 합, lock_deadlocks 증가)
- 결론: 질문 1~4에 잰 숫자로. 특히 "하트비트마다 MySQL"이 쓰기 문장을 몇 배 늘리는지, 묶음이 요청·명령 수를 얼마나 줄이는지, 판정 시간이 예상 범위에 드는지. Redis 경로에서 MySQL 쓰기가 스냅샷 주기에만 비례하는 것.
- 한계: 한 PC(네트워크 왕복 거의 없음), 주어진 부하(초당 1,000건)라 처리량은 한계가 아니다, 서버 전체 카운터라 다른 연결이 섞일 수 있다(실험 중 다른 작업 없음), MySQL 경로도 active·offers 확인은 Redis로 했다(완전히 Redis 없는 경로는 아님), 스냅샷 주기를 운영보다 짧게 잡았다.

`docs/decisions/0027-…` 끝에 한 줄:
```
- 갱신(Task 9): 실험 0008 — Redis 경로 MySQL 쓰기 (잰 값) 대 하트비트마다 MySQL (잰 값), p95 (잰 값). 운영 기본은 redis 그대로. 실험용 `HEARTBEAT_WRITE_MODE=mysql`(HeartbeatService.writeMode)은 비교용으로만 남긴다(decisions/0024의 enqueue 'each'와 같은 처리).
```

devlog에 `## HH:MM Task 9 실험 0008 하트비트 5,000대 (F8)` 항목(숫자는 표 요약 한두 줄).

`docs/study/backlog.md`에 추가:
```
- [ ] 쓰기 줄이기 패턴 — write-behind(모아서 쓰기), 바뀐 것만 쓰기, 묶음 요청 (experiments/0008)
- [ ] InnoDB 행 쓰기 비용(redo log, binlog, 버퍼 풀)과 Com_* / Innodb_rows_* 카운터 읽는 법 (test/helpers/metrics.ts)
```

커밋:
```bash
git add apps/api docs
git commit -m "exp(F8): 0008 하트비트 5,000대 — Redis 대 MySQL 직접 쓰기, 묶음 대 단건, 오프라인 판정 시간" -m "Refs: docs/experiments/0008-하트비트-5000대.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: 실험 0009 — 펌웨어 단계 배포: 실패율 0% 완료 시간, 30% 자동 중단까지 시간과 영향 범위 (F8)

**Files:**
- Test: `apps/api/test/experiments/firmware-rollout.spec.ts`(새, EXPERIMENTS=1)
- Record: devlog, `docs/experiments/0009-펌웨어-단계-배포.md`, `docs/decisions/0031-…`(갱신 한 줄), `docs/study/backlog.md`

질문:
1. 1,000대, 단계 10% → 50% → 100%, 실패율 0%면 단계가 언제 넘어가고 몇 초에 끝나나?
2. 실패율 30%(기준 20%, 최소 표본 20)면 시작부터 자동 중단까지 몇 초인가? 그때 결과가 몇 건 모였고(실패/결과), 끝까지 몇 대가 영향(설치 성공·실패)을 받았나?
3. 중단 뒤 제안이 정말 사라지나(offers 0, 끝난 뒤 시뮬레이터가 새 지시를 받지 않음)?

예상: 1은 단계마다 "하트비트 주기(지시 받기) + 업데이트 시간(300ms + 0~2초) + 판단 주기"쯤이라 세 단계 합 수 초~10초. 2는 첫 단계(100대) 안에서 결과가 20건을 넘는 첫 판단에서 멈춘다(실패율 30% 근처). 그 뒤에도 이미 업데이트 중이던 단말기는 보고를 마치므로 영향은 첫 단계 100대 이내. 다음 단계 대상은 만들어지지 않는다.

- [ ] **Step 1: 실험 스펙**

`apps/api/test/experiments/firmware-rollout.spec.ts`:
```ts
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../../src/device/active-set.service.js';
import { deviceKeys } from '../../src/device/device-keys.js';
import { OfferStore } from '../../src/device/offer-store.js';
import { FirmwareRollout, FirmwareRolloutTarget, TargetStatus } from '../../src/firmware/firmware.entities.js';
import { RolloutService, type ControlAction } from '../../src/firmware/rollout.service.js';
import { REDIS } from '../../src/redis/redis.provider.js';
import { seedInService } from '../helpers/device-fleet.js';
import { startDeviceSim, type DeviceSim } from '../helpers/device-sim.js';
import { deleteTestKeys } from '../helpers/redis-keys.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

// experiments/0009. 실행: EXPERIMENTS=1 npx vitest run test/experiments/firmware-rollout.spec.ts --silent=false
const N = Number(process.env.EXP_N ?? 1000);
const INTERVAL = Number(process.env.EXP_INTERVAL_MS ?? 1000);
const UPDATE_DELAY = Number(process.env.EXP_UPDATE_DELAY_MS ?? 300);
const UPDATE_JITTER = Number(process.env.EXP_UPDATE_JITTER_MS ?? 2000);
const CONTROL_EVERY = Number(process.env.EXP_CONTROL_MS ?? 500);
const STAGES = (process.env.EXP_STAGES ?? '10,50,100').split(',').map(Number);
const THRESHOLD = Number(process.env.EXP_THRESHOLD ?? 0.2);
const MIN_SAMPLES = Number(process.env.EXP_MIN_SAMPLES ?? 20);
const STAGE_TIMEOUT = Number(process.env.EXP_STAGE_TIMEOUT_MS ?? 30_000);
const FAIL_RATES = (process.env.EXP_FAIL_RATES ?? '0,0.3').split(',').map(Number);
const OP = { 'X-Operator': 'exp9' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe(`실험 0009: 펌웨어 단계 배포 ${N}대 — 단계 ${STAGES.join('→')}%, 기준 실패율 ${THRESHOLD * 100}%`, () => {
  let t: TestApp;
  let redis: Redis;
  let sim: DeviceSim;
  let apiUrl: string;
  let rollouts: RolloutService;
  let round = 0;

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    rollouts = t.app.get(RolloutService);
    await resetDatabase(t.orm);
    await seedInService(t, 'RO', N);
    await deleteTestKeys(redis, 'hb:');
    await t.app.get(ActiveSetService).rebuild();
    await t.app.listen(0, '127.0.0.1');
    apiUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
    sim = await startDeviceSim();
  }, 120_000);
  afterAll(async () => {
    await sim?.close();
    await deleteTestKeys(redis);
    await t.app.close();
  });

  for (const failRate of FAIL_RATES) {
    it(`실패율 ${failRate * 100}%`, async () => {
      round += 1;
      const version = `9.0.${round}`;
      await redis.del(deviceKeys().offers);
      await sim.reset();
      await sim.configure({
        targetUrl: apiUrl,
        serialPrefix: 'RO',
        count: N,
        intervalMs: INTERVAL,
        batchSize: 100,
        concurrency: 8,
        updateDelayMs: UPDATE_DELAY,
        updateJitterMs: UPDATE_JITTER,
        firmwareFailRate: failRate,
        seed: 42 + round,
      });
      await sim.start();
      await t.http().post('/firmware').set(OP).send({ modelCode: 'SN-100', version });

      const started = Date.now();
      const created = await t
        .http()
        .post('/firmware-rollouts')
        .set(OP)
        .send({ modelCode: 'SN-100', version, stages: STAGES, failureThreshold: THRESHOLD, minSamples: MIN_SAMPLES, stageTimeoutMs: STAGE_TIMEOUT });
      expect(created.status).toBe(201);
      const id = created.body.id as number;

      // 판단 job을 CONTROL_EVERY마다 돌리며 단계가 바뀐 시각을 적는다
      const timeline: { at: number; action: ControlAction; stage: number; timedOut: number }[] = [];
      let final: ControlAction = 'WAITING';
      const deadline = started + STAGE_TIMEOUT * STAGES.length + 60_000;
      while (Date.now() < deadline) {
        await sleep(CONTROL_EVERY);
        const r = await rollouts.control(id);
        if (r.action !== 'WAITING') timeline.push({ at: Date.now() - started, action: r.action, stage: r.stage, timedOut: r.timedOut });
        if (r.action === 'COMPLETED' || r.action === 'ABORTED') {
          final = r.action;
          break;
        }
      }
      const endedAt = Date.now() - started;
      await sleep(100); // 끝나기 직전에 offers를 읽은 하트비트 응답이 도착할 틈
      const offersAtEnd = await t.app.get(OfferStore).count();
      const simAtEnd = await sim.stats();

      // 끝난 뒤 업데이트 중이던 단말기가 보고를 마칠 시간을 준다(영향 범위의 최종값). 그동안 새 지시가 생기면 안 된다.
      await sleep(UPDATE_DELAY + UPDATE_JITTER + INTERVAL * 2);
      const simAfter = await sim.stats();
      await sim.stop();
      const em = t.orm.em.fork();
      const rollout = await em.findOneOrFail(FirmwareRollout, id);
      const count = (status: TargetStatus) => em.count(FirmwareRolloutTarget, { rollout: id, status });
      const targets = await em.count(FirmwareRolloutTarget, { rollout: id });
      const [succeeded, failed, timedOut, offered] = await Promise.all([
        count(TargetStatus.SUCCEEDED),
        count(TargetStatus.FAILED),
        count(TargetStatus.TIMED_OUT),
        count(TargetStatus.OFFERED),
      ]);
      const stats = (await t.http().get(`/firmware-rollouts/${id}`)).body.stageStats;

      console.log(
        `[실험 0009/fail${failRate * 100}] N=${N} 결과=${final} 끝난시각=${endedAt}ms 이유=${rollout.endReason} ` +
          `타임라인=${JSON.stringify(timeline)}`,
      );
      console.log(
        `[실험 0009/fail${failRate * 100}] 대상=${targets} 성공=${succeeded} 실패=${failed} 시간초과=${timedOut} 보고없음=${offered} ` +
          `끝날때제안=${offersAtEnd} 지시받음(끝날때→뒤)=${simAtEnd.updateOffers}→${simAfter.updateOffers} ` +
          `보고(성공/실패)=${simAfter.reportsSucceeded}/${simAfter.reportsFailed} 보고오류=${simAfter.reportErrors} 하트비트오류=${simAfter.errors} ` +
          `단계별=${JSON.stringify(stats.map((s: { stage: number; targets: number; succeeded: number; failed: number }) => [s.stage, s.targets, s.succeeded, s.failed]))}`,
      );

      expect(offersAtEnd).toBe(0);
      expect(simAfter.updateOffers).toBe(simAtEnd.updateOffers); // 끝난 뒤 새 지시 없음
      expect(simAfter.errors + simAfter.reportErrors).toBe(0);
      if (failRate === 0) {
        expect(final).toBe('COMPLETED');
        expect(succeeded).toBe(N);
      } else {
        expect(final).toBe('ABORTED');
        expect(targets).toBeLessThan(N);
      }
    }, STAGE_TIMEOUT * STAGES.length + 120_000);
  }
});
```

Run: `npx vitest run 2>&1 | grep -E "Test Files|Tests "`
Expected: `38 passed`, `238 passed`(실험 파일 제외 확인).

- [ ] **Step 2: 실험 실행**

Run (Git Bash, `apps/api`):
```bash
DL() { MSYS_NO_PATHCONV=1 docker exec terminal-ops-mysql sh -c 'mysql -N -uroot -p"$MYSQL_ROOT_PASSWORD" -e "select count from information_schema.innodb_metrics where name=\"lock_deadlocks\""' 2>/dev/null; }
b=$(DL); EXPERIMENTS=1 npx vitest run test/experiments/firmware-rollout.spec.ts --silent=false 2>&1 | grep -E "\[실험 0009|Tests "; a=$(DL); echo "lock_deadlocks 전=$b 후=$a"
```
Expected: `Tests  2 passed (2)`, 실패율마다 두 줄.
- `[실험 0009/fail0] N=1000 결과=COMPLETED 끝난시각=…ms 이유=마지막 단계 완료 타임라인=[{"at":…,"action":"ADVANCED","stage":1,…},{"at":…,"action":"ADVANCED","stage":2,…},{"at":…,"action":"COMPLETED",…}]` / `대상=1000 성공=1000 실패=0 … 끝날때제안=0 지시받음(끝날때→뒤)=1000→1000 … 단계별=[[0,100,100,0],[1,400,400,0],[2,500,500,0]]`
- `[실험 0009/fail30] N=1000 결과=ABORTED 끝난시각=…ms 이유=자동 중단: 1단계 실패율 …% (…/…) > 기준 20% 타임라인=[{"at":…,"action":"ABORTED","stage":0,…}]` / `대상=100 성공=… 실패=… 끝날때제안=0 지시받음(끝날때→뒤)=n→n …`
- lock_deadlocks 전후 같음(보고 수백 건과 판단이 겹쳐도 순환 대기가 없다는 decisions/0031의 예상). 늘었으면 `SHOW ENGINE INNODB STATUS\G`의 LATEST DETECTED DEADLOCK을 바로 떠서 트러블슈팅으로 남긴다.
- 끝나면 `netstat -ano | grep -E ':4021 .*LISTENING'` 결과 없음.
- 사전 검증에서 두 실패율 모두 끝까지 돌았다. 한 번 더 돌려(같은 시드) 숫자가 크게 다르지 않은지 본다(지터·하트비트 주기 위상 때문에 수백 ms는 달라질 수 있다).

(선택) 최소 표본·지터를 바꿔 본다: `EXP_MIN_SAMPLES=5`(더 일찍 멈추나, 표본이 작아 실패율이 흔들리나), `EXP_UPDATE_JITTER_MS=0`(보고가 몰리면 판단이 단계가 끝난 뒤에야 일어나는지).

- [ ] **Step 3: 기록과 커밋**

`docs/experiments/0009-펌웨어-단계-배포.md`:
- 질문·예상: 위 그대로
- 설정: N=1,000(SN-100, seedInService), 단계 10·50·100(`EXP_STAGES`), 기준 0.2(`EXP_THRESHOLD`), 최소 표본 20(`EXP_MIN_SAMPLES`), 단계 제한 30초(`EXP_STAGE_TIMEOUT_MS`), 하트비트 1초·묶음 100·동시 8, 업데이트 300ms + 0~2,000ms(`EXP_UPDATE_DELAY_MS`, `EXP_UPDATE_JITTER_MS`), 판단 0.5초마다 `RolloutService.control` 직접 호출(`EXP_CONTROL_MS`), 실패율 0·0.3(`EXP_FAIL_RATES`), 시드 43·44. API는 테스트 앱 한 프로세스, device-sim 별도 프로세스.
- 재현: Step 2 명령
- 결과: 원문 4줄(+ 다시 돌린 4줄) + 표(실패율, 결과, 끝난 시각, 단계 전환 시각, 대상, 성공, 실패, 시간 초과, 끝날 때 제안, 끝난 뒤 새 지시, lock_deadlocks 증가)
- 결론: 질문 1~3에 잰 숫자로. 자동 중단 시점의 결과 수가 최소 표본보다 몇 건 많았나(판단 주기 사이에 모인 보고), 중단 뒤에도 업데이트 중이던 단말기가 보고를 마쳐 영향이 늘어난 수(중단 시점 결과 → 최종 결과), 다음 단계 대상이 0인 것.
- 한계: 실패가 단말기마다 독립(같은 모델·같은 원인 실패의 몰림은 흉내 내지 않음), 실패를 바로 보고(단말기가 꺼져서 보고 못 하는 경우는 TIMED_OUT으로만, 이번에는 0), 판단을 0.5초로 짧게 돌렸다(운영 기본 5초면 중단이 그만큼 늦다), 한 PC.

`docs/decisions/0031-…` 끝에 한 줄:
```
- 갱신(Task 10): 실험 0009 — 실패율 0% 1,000대 3단계 완료 (잰 값)초, 30%는 (잰 값)초에 1단계에서 자동 중단(결과 (잰 값)건 중 실패 (잰 값)), 끝까지 영향 (잰 값)대, 중단 뒤 제안 0·새 지시 0, lock_deadlocks 증가 (잰 값).
```

devlog에 `## HH:MM Task 10 실험 0009 펌웨어 단계 배포 (F8)` 항목.

`docs/study/backlog.md`에 추가:
```
- [ ] 카나리·단계 배포의 중단 기준 — 최소 표본, 신뢰구간, 기준을 넘는 순간 vs 단계 끝 (experiments/0009, decisions/0031)
```

커밋:
```bash
git add apps/api docs
git commit -m "exp(F8): 0009 펌웨어 단계 배포 — 실패율 0% 완료 시간, 30% 자동 중단과 영향 범위" -m "Refs: docs/experiments/0009-펌웨어-단계-배포.md" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: 4일차 마감 — 전체 검증, 마이그레이션 체인, 실서버 확인(partners + device-sim + API 워커·스케줄러), 기록 정리

**Files:**
- Record: `docs/devlog/2026-10-23.md`(4일차 요약), `docs/study/backlog.md`
- Modify: `../01_B_단말기생애주기_설계안.md`(저장소 밖, 커밋 대상 아님)

- [ ] **Step 1: 전체 검증**

Run (`apps/partners`): `npx vitest run && npm run typecheck && npm run build`
Run (`apps/device-sim`): `npx vitest run && npm run typecheck && npm run build`
Run (`apps/api`):
```bash
npx vitest run
npm run typecheck
npm run build
npm run db:migration:check
```
Expected: partners 5개 파일 `40 passed`, device-sim 4개 파일 `19 passed`, api 38개 파일 `238 passed`(개수를 기록, 리뷰 수정이 있었으면 더 많다), 모두 typecheck·build exit 0, `최신 상태`. api 전체 실행 로그에 `Connection is closed`가 있는지 `grep -c`로 세어 적는다(Task 1의 확인).

- [ ] **Step 2: 빈 테스트 DB에 마이그레이션 체인 전체 적용**

테스트 DB를 지우고 다시 만든 뒤(맨 위 "프로세스·데이터 안전 규칙"의 명령) 마이그레이션만으로 스키마를 만든다.
```bash
npm run build
MYSQL_DATABASE=terminal_ops_test node dist/db/migrate.js up
mv src/migrations/.snapshot-terminal_ops_test.json "$TEMP/"   # troubleshooting/0015: up이 테스트 DB 이름의 스냅샷을 만든다. 커밋하지 않는다
MYSQL_DATABASE=terminal_ops_test node dist/db/migrate.js check
git status --short
```
Expected: `Migration20261022035842`부터 Day 4의 두 마이그레이션까지 14개가 차례로 `Applied`, `check` → `최신 상태`, `git status`에 스냅샷 파일 없음. 테이블 19개(마이그레이션 기록 테이블 포함). 그다음 `npx vitest run`을 한 번 더 돌려(테스트가 스키마를 다시 만든다) `38 passed / 238 passed`.

- [ ] **Step 3: 실서버 확인 (partners + device-sim + API·워커·스케줄러 한 프로세스, 개발 DB)**

개발 DB에는 Task 5·6 마이그레이션이 적용돼 있어야 한다(`npm run db:migrate && npm run db:seed`). 세 앱을 빌드해 둔다(`apps/partners`·`apps/device-sim`·`apps/api`에서 `npm run build`).

아래 스크립트를 스크래치패드(또는 `apps/api`, 커밋하지 않음)에 `smoke-day4.sh`로 두고 `apps/api`에서 Git Bash로 `bash <경로>/smoke-day4.sh`. 주기 작업은 짧게(sweep·relay·판정·판단 1초, 스냅샷 2초, 재구성 5초, 오프라인 기준 4초) 띄운다. 배포는 SN-300으로 한다(개발 DB에는 이전 실서버 확인이 남긴 운영 중 SN-100 단말기가 있어 시뮬레이터가 흉내 내지 않는 단말기가 대상에 섞인다). 같은 이유로 제한 시간 5초·기준 1(시간 초과로 멈추지 않음)로 둔다 — 이전에 이 스크립트로 만든 SN-300 단말기가 있으면 그것들은 TIMED_OUT으로 끝난다.
```bash
# Day 4 실서버 확인. apps/api에서 Git Bash로 실행: bash smoke-day4.sh
# 포트는 AP(API)·PP(partners)·SP(device-sim)로 바꿀 수 있다(기본 3000·4010·4020).
AP=${AP:-3000}; PP=${PP:-4010}; SP=${SP:-4020}
B=localhost:$AP; H='Content-Type: application/json'; O='X-Operator: manual'; S=$(date +%H%M%S)
SIM=127.0.0.1:$SP

PARTNERS_PORT=$PP node ../partners/dist/main.js > smoke-partners.log 2>&1 & P1=$!
DEVICE_SIM_PORT=$SP node ../device-sim/dist/main.js > smoke-sim.log 2>&1 & P2=$!
API_PORT=$AP PARTNERS_URL=http://127.0.0.1:$PP SWEEP_INTERVAL_MS=1000 RELAY_INTERVAL_MS=1000 ACTIVE_REBUILD_INTERVAL_MS=5000 \
  OFFLINE_DETECT_INTERVAL_MS=1000 HEARTBEAT_OFFLINE_AFTER_MS=4000 CONNECTIVITY_SNAPSHOT_INTERVAL_MS=2000 ROLLOUT_CONTROL_INTERVAL_MS=1000 \
  node dist/main.js > smoke-api.log 2>&1 & P3=$!
echo "PIDS partners=$P1 sim=$P2 api=$P3"
until curl -s -o /dev/null $B/health; do sleep 0.5; done
echo "S=$S"

echo '--- 1. 운영 중(IN_SERVICE) SN-300 단말기 3대 → Outbox relay → project job이 active에 올림'
SN300='{"results":[{"itemCode":"POWER","passed":true},{"itemCode":"NETWORK","passed":true},{"itemCode":"TOUCHSCREEN","passed":true}]}'
for X in 1 2 3; do
  N=D4-$S-$X
  curl -s -X POST $B/terminals -H "$H" -H "$O" -d "{\"serialNo\":\"$N\",\"modelCode\":\"SN-300\"}" -o /dev/null
  curl -s -X POST $B/terminals/$N/inspections -H "$H" -H "$O" -d "$SN300" -o /dev/null
  curl -s -X POST $B/terminals/$N/transitions -H "$H" -H "$O" -d '{"to":"IN_STOCK","reason":"stock-in","expectedVersion":2}' -o /dev/null
  curl -s -X POST $B/terminals/$N/allocations -H "$H" -H "$O" -d '{"merchantCode":"YEOKSAM-CAFE","expectedVersion":3}' -o /dev/null
  curl -s -X POST $B/shipments -H "$H" -H "$O" -d "{\"serialNo\":\"$N\",\"carrier\":\"BUNGAE\",\"expectedVersion\":4}" -o /dev/null
  curl -s -X POST $B/terminals/$N/transitions -H "$H" -H "$O" -d '{"to":"DELIVERED","reason":"delivered","expectedVersion":5}' -o /dev/null
  curl -s -X POST $B/terminals/$N/transitions -H "$H" -H "$O" -d '{"to":"IN_SERVICE","reason":"installed","expectedVersion":6}' -o /dev/null
done
curl -s $B/terminals/D4-$S-3; echo
sleep 3

echo '--- 2. device-sim 하트비트(1초 주기) → 접속 상태'
curl -s -X POST $SIM/__admin/config -H "$H" -d "{\"targetUrl\":\"http://127.0.0.1:$AP\",\"serials\":[\"D4-$S-1\",\"D4-$S-2\",\"D4-$S-3\",\"D4-$S-9\"],\"intervalMs\":1000,\"batchSize\":4,\"updateDelayMs\":300}" -o /dev/null
curl -s -X POST $SIM/__admin/start; echo
sleep 3
curl -s $B/terminals/D4-$S-1/connectivity; echo

echo '--- 3. 펌웨어 단계 배포 50% → 100% (판단 job 1초 주기)'
V=4.$S
curl -s -X POST $B/firmware -H "$H" -H "$O" -d "{\"modelCode\":\"SN-300\",\"version\":\"$V\"}"; echo
RO=$(curl -s -X POST $B/firmware-rollouts -H "$H" -H "$O" -d "{\"modelCode\":\"SN-300\",\"version\":\"$V\",\"stages\":[50,100],\"failureThreshold\":1,\"minSamples\":1,\"stageTimeoutMs\":5000}")
echo $RO
RID=$(echo $RO | sed 's/^{"id":\([0-9]*\).*/\1/')
sleep 8
curl -s $B/firmware-rollouts/$RID; echo
curl -s $SIM/__admin/devices/D4-$S-2; echo

echo '--- 4. 하트비트를 끊으면 오프라인(기준 4초, 판정 1초 주기), 다시 보내면 온라인'
curl -s -X POST $SIM/__admin/config -H "$H" -d "{\"offlineSerials\":[\"D4-$S-3\"]}" -o /dev/null
sleep 7
curl -s $B/terminals/D4-$S-3/connectivity; echo
curl -s -X POST $SIM/__admin/config -H "$H" -d '{"offlineSerials":[]}' -o /dev/null
sleep 4
curl -s $B/terminals/D4-$S-3/connectivity; echo
curl -s -X POST $SIM/__admin/stop -o /dev/null
curl -s $SIM/__admin/stats; echo

echo '--- 5. 알림(톡톡메신저)'
sleep 3
curl -s 127.0.0.1:$PP/__admin/toktok/messages | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s).messages.map(x=>x.text);
console.log(m.filter(t=>/D4-$S|펌웨어 배포/.test(t)&&!/→/.test(t)).join('\n'));});"

kill $P3 $P2 $P1
```

(시리얼 `D4-<시각>-9`는 등록하지 않은 단말기다 — 하트비트가 `IGNORED_NOT_IN_SERVICE`로 세지는지 보려고 넣었다. 사유는 영문으로 쓴다: Git Bash `curl -d`의 한글이 깨지는 것을 Day 2에서 봤다.)

Expected(사전 검증에서 테스트 DB·포트 3100/4110/4120으로 같은 흐름을 확인했다):
- 1: `D4-<S>-3`이 `IN_SERVICE`, version 7
- 2: `{"running":true}`, 접속 상태 `source: redis`, `online: true`, `firmwareVersion: 1.0.0`
- 3: 펌웨어 201, 배포 응답 `status: RUNNING`, 첫 단계 `targets: 2`(SN-300 운영 중 3대의 50%, 이전 실행이 남긴 SN-300이 있으면 더 많다). 8초 뒤 `status: COMPLETED`, `endReason: 마지막 단계 완료`, 단계별 성공 2·1. 시뮬레이터 단말기 `firmwareVersion`이 새 버전
- 4: 끊은 뒤 `online: false`(lastSeenAt이 멈춤), 다시 보낸 뒤 `online: true`. 시뮬레이터 stats `errors: 0`, `updateOffers: 3`, `reportsSucceeded: 3`, `heartbeatsRejected` = ticks(등록 안 한 `-9`)
- 5: 톡톡 메시지에 `펌웨어 배포 #<id> …: 2단계(100%) 시작`, `…: 완료`, `D4-<S>-3: 오프라인 (마지막 하트비트 …)`, `D4-<S>-3: 온라인 복귀 (하트비트 …)`
- `smoke-api.log`에 `주기 작업 등록: carrier-sweep 1000ms, outbox-relay 1000ms, active-rebuild 5000ms, offline-detect 1000ms, connectivity-snapshot 2000ms, rollout-control 1000ms`, `terminal-ops api listening on http://localhost:3000 (workers=true, schedulers=true, queuePrefix=terminal-ops)`. 세 로그에 error·exception·warn 0줄(`grep -icE "error|exception|warn" smoke-*.log`)

출력을 devlog에 붙인다. 끝나면 스크립트가 띄운 세 프로세스가 PID로 꺼졌는지 확인한다: `netstat -ano | grep -E ':(3000|4010|4020) .*LISTENING'` 결과 없음. 로그 파일을 지운다(`rm smoke-api.log smoke-partners.log smoke-sim.log`).

- [ ] **Step 4: 개발 Redis의 주기 작업 정리**

Run: `npm run scheduler:clear`
Expected: `주기 작업 삭제(접두사 terminal-ops): carrier-sweep, outbox-relay, active-rebuild, offline-detect, connectivity-snapshot, rollout-control`. 하트비트 키(`terminal-ops:hb:*`, `terminal-ops:fw:offers`)는 남겨 둔다(실서버 확인 데이터, 다음 실행의 재구성·판정이 맞춘다). 지우고 싶으면 `redis-cli --scan --pattern 'terminal-ops:hb:*'`로 본 뒤 UNLINK로만 지운다(FLUSH 금지).

- [ ] **Step 5: 하루 요약과 공부거리 정리**

devlog 맨 아래에 `## 4일차 요약`을 쓴다(3일차 요약과 같은 항목).
- 만든 API·앱: `apps/device-sim`(관리 API), `POST /devices/heartbeats`, `GET /terminals/:serialNo/connectivity`, `POST /firmware`, `POST/GET /firmware-rollouts`, `POST /firmware-rollouts/:id/{pause,resume,abort}`, `POST /devices/firmware-reports`, 주기 작업 4개(active-rebuild, offline-detect, connectivity-snapshot, rollout-control), 이월(공용 Redis·교체 예약·TICKET_NOT_REPLACING)
- 테스트 수: api, partners, device-sim(실제 값)
- 커밋 목록(`git log --oneline master..`)
- 실험 0007(재실행)·0008·0009 결론 한 줄씩(잰 숫자로)
- 락·동시성·Redis 관련 발견: 보고와 판단의 잠금 분리, PK 갱신, upsertMany 재조회, 원시 datetime(troubleshooting/0016), RENAME과 TTL
- 계획과 달라진 점, 남은 문제(스펙 9장 + 새로 생긴 것), 내일(Day 5) 시작 전에 필요한 것(설계안 8장 Day 5 행을 먼저 읽는다)

`docs/study/backlog.md`의 중복 항목을 합친다. 설계안 `../01_B_단말기생애주기_설계안.md` 8장 Day 4 행 끝에 `✅ 완료(커밋 범위)`를 표시한다(저장소 밖이라 커밋하지 않는다).

- [ ] **Step 6: 커밋**

```bash
git add docs
git commit -m "docs: 4일차 마감 기록" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-Review 결과

- 브리프 0(이월):
  - 공용 Redis 공급자(ioredis 하나, error 리스너, 종료 시 quit, env 재사용) + ScanLock 이전 → Task 1(`redis/`, `scan-lock.ts`). 종료는 `onModuleDestroy`가 아니라 `onApplicationShutdown`(이유는 decisions/0026). "Connection is closed" 재현·전후 비교 → Task 1 Step 1·5, 바꾼 뒤에도 나오면 troubleshooting/0017
  - 교체 출고 예약 잠금(SET NX PX, 토큰 비교 해제, 진 요청 409 REPLACEMENT_RESERVED, 운송장 없음) + 실험 0007 재실행 전후 비교 + TTL 만료 동작 결정 → Task 1 / decisions/0026, experiments/0007
  - TICKET_NOT_REPLACING(e2e 수정) → Task 1
  - decisions/0025 한 줄(실제로는 12개 테이블), devlog 3일차 요약·experiments/0006 기준 표시 → Task 1 Step 7
- 브리프 1(device-sim): node:http 관리 API(config·stats·health + start·stop·reset·devices), 시드 RNG, keep-alive 에이전트, 하트비트 루프(배치·단건, 동시성 상한, 건너뛴 주기), offlineSerials·offlineRate, firmwareFailRate·지연(+지터), stats(하트비트·오류·p50/p95·지시·보고) → Task 2·8. 자체 vitest 4파일 19개. API e2e는 연동 1개(Task 8)와 실험만 실제 프로세스
- 브리프 2(접속 상태): 결정 먼저(0027, Task 3 Step 1), 배치 API·행별 결과·형식 검증·인증 없음 → Task 3. Redis만 쓰기(ZSET lastSeen, HASH fw) → Task 3. active 유지(Outbox 두 번째 소비자 + 주기 재구성, 왜 둘 다) → Task 4 / 0028(SET 대신 HASH는 범위 조정). 오프라인 판정 job(ZRANGEBYSCORE, 바뀐 것만 UPSERT, device.offline/online, 복귀 감지 위치 결정) → Task 5 / 0029. 조회(Redis 우선, MySQL 스냅샷) → Task 5. 주기 스냅샷(쓰기 횟수 측정 대상) → Task 5, 실험 0008. 테스트 키 접두사·SCAN+UNLINK 헬퍼 → Task 1(`redis-keys.ts`), 이후 모든 Redis 테스트
- 브리프 3(펌웨어): 별도 테이블 3개(enum 무변경), 대상 선정(serial 해시, 누적 비율), 단계 진입 시 대상 INSERT + offers HASH, 하트비트 응답 update → Task 6 / 0030. 결과 보고(멱등, 성공 시 fw 갱신·offer 제거) → Task 7. 배포 제어 job(FOR UPDATE, 통계, 자동 중단 + offer 제거 + Outbox, 단계 넘기기, timeout, COMPLETED), 잠금 순서(배포 행 → 대상 행), 보고는 대상 행만(데드락 없음) → Task 7 / 0031. 관리 API(등록, 생성, pause·resume·abort, GET 단계별 통계) → Task 6
- 브리프 4(실험): 0008(5,000대, 배치 100/단건, Redis vs MySQL 직접 경로 플래그, 처리량·p50/p95·MySQL 쓰기(앱 문장 + SHOW GLOBAL STATUS)·Redis 명령(INFO commandstats)·lock_deadlocks, 오프라인 판정 시간) → Task 9. 0009(1,000대, 0% 완료 시간·단계 전환, 30% 자동 중단 시간·영향 대수, 중단 뒤 offer 제거와 하트비트 update 없음) → Task 10. 둘 다 `EXPERIMENTS=1`, `--silent=false`
- 진행: 브랜치 day4-devices, devlog `# Day 4` 구분선(Task 1, 날짜가 바뀌면 새 파일), 번호 decisions 0026~0031, troubleshooting 0016(Task 7 계획한 재현)·0017(조건부), experiments 0008·0009. 안전 규칙(PID로만 종료, FLUSH 금지, 테스트 DB만, 개발 DB는 migrate·seed·실서버 확인) → 맨 위 절. 교훈(부모 먼저 잠금, PK 갱신으로 gap 락 피하기, relay RC, 여러 행 정렬, 외부 호출·Redis는 트랜잭션 밖, 연결 collation, jobId `:` 금지, addBulk pipeline) → 스펙 5.9, Task 4·5·6·7
- 브리프와 다르게 한 것: "범위 조정" 절에 이유와 함께 적었다(active HASH, 단건 엔드포인트·sentAt 없음, 복귀 감지 위치, QB UPSERT, FK 없음, version 컬럼 없음, 실패율 정의, 모델당 배포 하나, 알림 추가, 재개 offered_at, 보고 404·제안 내림, 배포 id 비교 삭제, 시뮬레이터 지터·같은 버전 무시, device-sim은 0009 갱신, 예약을 사전 확인보다 먼저, 0025는 12개 테이블, device 큐 하나, 처리량은 주어진 부하).
- 플레이스홀더 점검: 모든 코드 단계에 전체 코드가 있다(사전 검증 저장소의 Task별 상태에서 그대로 가져왔다). 마이그레이션 파일 이름(`Migration<시각>`), 커밋 해시, 기록 파일의 잰 숫자만 실행해서 채운다(숫자는 잰 값만 쓰는 규칙).
- 타입·이름 일관성:
  - `REDIS`, `createAppRedis`, `RedisModule`, `RedisLock.keyOf(kind, id)/acquire(key, ttlMs)/release(key, token)`, `execOrThrow(batch)`, `ScanLock.keyOf/acquire/release`(그대로)
  - `env.replacementLockTtlMs`, `activeRebuildIntervalMs`, `heartbeatWriteMode`, `hbOfflineAfterMs`, `offlineDetectIntervalMs`, `connectivitySnapshotIntervalMs`, `rolloutControlIntervalMs`
  - `ReplacementService.replace(id, cmd, actor, { lockOrder })` → `replaceReserved`, `ServiceTicketService.lockOpen(tx, id, expected, code = 'TICKET_NOT_OPEN')`
  - `deviceKeys()` → `{ lastSeen, firmware, active, offline, snapshotAt, offers }`
  - `HeartbeatService.receive(items, now?)`, `writeMode`, `FIRMWARE_VERSION_PATTERN`, `HeartbeatRowResult { serialNo, result, message?, update? }`, `MAX_HEARTBEATS_PER_REQUEST`
  - `ActiveSetService.rebuild()/apply(serials)`, `changesActiveSet(row)`, `PROJECT_JOB_OPTIONS`, `ProjectJobData`, `QUEUE.DEVICE`
  - `ConnectivityService.detect(now?, offlineAfterMs?)/snapshot()/get(serialNo, now?)`, `upsertConnectivity(tx, rows, merge)`, `ConnectivityRow`, `DeviceConnectivity { terminalId, online, lastSeenAt, firmwareVersion, changedAt }`
  - `OfferStore.publish(serials, offer)/withdraw(rolloutId, serials)/lookup(serials)/count()`, `FirmwareOffer { rolloutId, version }`
  - `Firmware`, `FirmwareRollout`, `FirmwareRolloutTarget`, `RolloutStatus`, `TargetStatus`, `ACTIVE_ROLLOUT_STATUSES`, `RolloutService.create/pause/resume/abort/get/stageStats/control/controlAll`, `ControlResult { rolloutId, action, stage, timedOut }`, `checkStages`, `toRolloutView`, `FirmwareService.register`, `toFirmwareView`, `FirmwareReportService.report(dto)` → `{ serialNo, rolloutId, status, alreadyReported }`
  - `OUTBOX_TYPE.{DEVICE_OFFLINE, DEVICE_ONLINE, FIRMWARE_STAGE_ADVANCED, FIRMWARE_ROLLOUT_COMPLETED, FIRMWARE_ROLLOUT_ABORTED}`, `textOf(event)`
  - `JOB_SCHEDULERS[].every`, `SchedulerService(sweepQueue, outboxQueue, deviceQueue)`, device job 이름 `project`, `rebuild-active`, `detect-offline`, `snapshot`, `rollout-control`
  - `fromDbDatetime(value)`
  - BusinessError 코드: REPLACEMENT_RESERVED(409), TICKET_NOT_REPLACING(422), ROLLOUT_ALREADY_ACTIVE(409), ROLLOUT_NOT_RUNNING·ROLLOUT_NOT_PAUSED·ROLLOUT_FINISHED(422), 400 INVALID_STAGES
  - device-sim: `SimConfig`(… `firmwareFailRate`, `updateDelayMs`, `updateJitterMs`), `Fleet.configure/start/stop/reset/close/tick/settleUpdates`, `runPool`, `pickSeeded`, `SimStats.view()`, `ApiClient.postJson/close`, `createSimServer`
  - 테스트 헬퍼: `deleteTestKeys(redis, sub?)`, `seedInService(t, prefix, count, modelCode?, start?)`, `serialsOf`, `rolloutOrder`, `startDeviceSim(port?)` → `{ base, pid, configure, start, stop, reset, stats, device, close }`, `TEST_DEVICE_SIM_PORT`, `mysqlCounters`, `redisCommandCalls`, `delta`, `sum`
- 사전 검증: Task 1~10을 이 순서로 적용해 Task마다 typecheck·테스트 통과를 확인했다(api 204 → 208 → 212 → 220 → 228 → 236 → 237 → 238, device-sim 12 → 19, partners 40). Task별 "실패 확인"의 실패 내용은 그 Task 직전 코드에 그 Task의 테스트를 넣어 돌려 본 것이다(Task 3·6·7의 새 모듈 테스트는 로드 실패로 적었다). 실험 0007 재실행·0008·0009를 끝까지 한 번씩, 빈 테스트 DB 마이그레이션 체인 14개, 실서버 흐름(테스트 DB·포트 3100/4110/4120)을 확인했다(숫자는 적지 않는다).
