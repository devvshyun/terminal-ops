# terminal-ops — 결제단말기 운영 시스템(학습 프로젝트)

가상의 결제단말기 운영사 **단말온**이 단말기 수천 대의 일생(발주 → 입고·검수 → 재고 → 배정·출고 → 배송 → 설치·운영 → 고장·회수)을 관리하는 사내 시스템이다. Nest.js · MikroORM · MySQL · Redis(BullMQ)를 실제 쓰임새 안에서 익히려고 7일 동안 만들었다. 설계: [`../01_B_단말기생애주기_설계안.md`](../01_B_단말기생애주기_설계안.md)(저장소 밖, 같은 상위 폴더), 작업 규칙: [`CLAUDE.md`](CLAUDE.md).

등장하는 회사·API는 **모두 가상**이다. 실제 업체명·실제 API·전 직장 코드는 쓰지 않았다.

| 가상 업체 | 역할 | 일부러 넣은 골칫거리(설정으로 켜고 끔) |
|---|---|---|
| 세움전자 | 단말기 제조, 발주·납품 명세 | 덜 보내기, 명세에 없는 시리얼, 5xx |
| 번개택배 | 택배 추적 JSON | 같은 이벤트 중복, 429(Retry-After), 지연 |
| 느림보물류 | 택배 추적 XML(상태 코드 체계가 다름) | 느림, 5xx, 이벤트 순서 뒤섞임 |
| 브릿지VAN | VAN 등록 목록(커서 페이지) | 어긋난 등록, 스캔 도중 변경, 429·503 |
| 톡톡메신저 | 알림·리포트 웹훅, 파일 첨부 | 가끔 실패, 응답 지연 |

## 구성

```
terminal-ops/
├─ docker-compose.yml    MySQL 8.4, Redis 7.4
├─ apps/
│  ├─ api/               Nest.js 12 — HTTP API와 큐 워커(실행 모드로 분리: RUN_WORKERS, RUN_SCHEDULERS)
│  ├─ admin/             React 19 + Vite 8 + TanStack Query 어드민(Vite 프록시 /api → api)
│  ├─ partners/          가상 업체 서버(node:http, 포트 4010): 세움전자·번개택배·느림보물류·브릿지VAN·톡톡메신저
│  └─ device-sim/        단말기 시뮬레이터(하트비트, 펌웨어 업데이트 결과 보고)
├─ infra/                MySQL 초기화(테스트 DB), 미리보기 env
├─ scripts/              기록 색인 생성
└─ docs/                 기록(아래 "기록")
```

## 실행

Node 24, Docker Desktop(WSL2)이 필요하다. 명령은 Git Bash 기준.

```bash
cp .env.example .env                 # 로컬 개발 전용 값
docker compose up -d --wait          # MySQL·Redis, healthcheck가 healthy가 될 때까지 기다린다(첫 실행은 MySQL 초기화에 수십 초)
for a in api admin partners device-sim; do (cd apps/$a && npm ci); done
cd apps/api && npm run db:migrate && npm run db:seed && cd ../..   # 개발 DB 스키마와 기준 데이터(모델·가맹점·검수 항목)

# 터미널 네 개(또는 백그라운드 — 끌 때는 PID로)
(cd apps/partners && npm run build && npm start)       # :4010
(cd apps/api && npm run build && npm start)            # :3000, 워커·주기 작업 포함(.env의 RUN_WORKERS·RUN_SCHEDULERS)
(cd apps/api && npm run start:worker)                  # 선택: 워커만 따로 — main api가 RUN_WORKERS=0일 때만. 둘 다 워커면 report 큐 한 번에 하나(decisions/0038) 가정이 깨진다
(cd apps/admin && npm run dev)                         # :5173 → 브라우저 http://localhost:5173
```

- 워커 프로세스를 띄우는 실험(0005·0014)은 먼저 `cd apps/api && npm run build` — `dist/worker.js`를 자식 프로세스로 띄우므로, 빌드하지 않으면 멈추고("먼저 npm run build 하세요"), 소스만 고치고 빌드를 잊으면 옛 워커로 잰다(경고 없음).
- 테스트: 각 앱 폴더에서 `npm test`. api 테스트는 테스트 DB(`terminal_ops_test`)와 Redis 테스트 접두사(`test-`)만 쓰고, 가상 업체 서버를 테스트 포트(4011)에 직접 띄운다 — api 테스트를 두 개 동시에 돌리지 않는다. 실험은 `EXPERIMENTS=1 npx vitest run test/experiments/<파일> --silent=false`.
- 미리보기(화면 확인)는 `infra/preview.env`(주기 작업을 등록하지 않음)를 저장소 `.env` 뒤에 읽는다. 띄우기 전 점검(빌드, 남은 주기 작업 `npm run scheduler:clear`, 같은 접두사의 다른 워커)은 그 파일 주석에 있다.
- 주기 작업은 Redis에 남는다(BullMQ job scheduler). 지우려면 `cd apps/api && npm run scheduler:clear`(이 접두사의 주기 작업만 — Redis 전체를 비우지 않는다).

## 기능

| ID | 기능 | 코드 |
|---|---|---|
| F1 | 단말기 등록·조회, 엑셀 일괄 등록 | `apps/api/src/terminal/`(`terminal.service.ts`, `bulk-registration.service.ts`, `terminal-import.service.ts`) |
| F2 | 상태 전이 + 이력(허용 전이 표, 낙관적 락) | `apps/api/src/terminal/transition.service.ts`, `transition-rules.ts` |
| F3 | 택배 추적 자동 수집(BullMQ, limiter, 재시도) | `apps/api/src/carrier-sync/` |
| F4 | 이상 단말기 찾기(규칙 6개, 매일 밤) | `apps/api/src/anomaly/` |
| F5 | 알림(Outbox, 최소 한 번 + 멱등키, 복구 sweep) | `apps/api/src/outbox/` |
| F6 | 박스 단위 일괄 스캔(scanId 멱등) | `apps/api/src/scan/` |
| F7 | A/S와 교체 출고(한 트랜잭션, 교체 단말기 예약) | `apps/api/src/service/` |
| F8 | 접속 상태(하트비트 Redis) + 펌웨어 단계 배포 | `apps/api/src/device/`, `apps/api/src/firmware/`, `apps/device-sim/` |
| F9 | VAN 등록 대조(스테이징 + SQL 비교 + 재검증) | `apps/api/src/van/` |
| F10 | 발주 대비 입고 대조 | `apps/api/src/purchase-order/` |
| F11 | 주간 운영 리포트(xlsx → 톡톡), 대시보드(Redis 캐시) | `apps/api/src/report/`, `apps/api/src/dashboard/` |
| F12 | 택배사 어댑터(JSON·XML → 같은 이벤트) | `apps/api/src/carrier/` |
| F13 | 검수 체크리스트와 불합격 통계 | `apps/api/src/inspection/` |
| 어드민 | 처음 화면(운영 현황), 단말기 목록·상세, 박스 스캔, A/S, 펌웨어 배포, 이상·VAN·입고 대조·주간 리포트, 배치 실행 이력 | `apps/admin/src/pages/` |

## 실험 결과

로컬 한 PC(Windows 11, Docker Desktop의 MySQL 8.4·Redis 7.4)에서 잰 값이다. 자세한 설정·원본 출력·한계는 각 기록에.

| # | 질문 | 숫자 | 결론 |
|---|---|---|---|
| [0001](docs/experiments/0001-같은-단말기-동시-전이.md) | 같은 단말기에 전이 20건이 동시에 오면 1건만 반영되나 | 고치기 전 HTTP 200 1·409 11·500 8(데드락). 단말기 UPDATE를 이력 INSERT보다 먼저 flush한 뒤 3회 모두 200 1·409 19 | 낙관적 락으로 성공은 늘 1건. 500은 flush 순서가 만든 InnoDB S→X 데드락 → UPDATE 먼저 |
| [0002](docs/experiments/0002-같은-단말기-동시-검수.md) | 같은 단말기 동시 검수 10건 | 검수 기록 먼저: 매번 201 1·500 9. 전이 먼저: 6회 모두 201 1·409 9, 500 0 | 같은 작업 단위의 INSERT가 UPDATE보다 먼저 나가는 문제가 검수에도 → 전이 먼저(decisions/0006) |
| [0003](docs/experiments/0003-번개택배-중복-이벤트.md) | 번개택배가 30% 확률로 이벤트를 두 번 보내면 두 번 반영되나 | 응답 안 중복 81개가 왔지만 3회 모두 carrier_event 120(운송장당 4), DELIVERED 단말기당 최대 1. 약 11.2초 | 중복 반영 0. 응답 안 → 저장된 키 → unique 3단 |
| [0004](docs/experiments/0004-번개택배-429-비율별-수집.md) | 429 10/30/50%에서 수집이 끝나나 | (10/30/50%는 설정한 확률 `force429Rate`. seed 4에서 실제 429 비율은 15/135 약 11%, 35/155 약 23%, 90/210 약 43%) 모두 30/30 완료. 조회 135/155/210 = 성공 120 + 429 수. 10%·30% 약 14.6~16.1초, 50% 약 21.3~22.3초 | 429 하나가 정확히 재시도 하나. 더 부르는 수는 1/(1−p)로 늘어 50%에서 급해진다 |
| [0005](docs/experiments/0005-워커-프로세스-2개.md) | 워커 2개가 같은 큐를 나누면 같은 운송장을 동시에 보거나 알림을 두 번 보내나 | SyncRun 60/60으로 나눔, 같은 운송장 겹침 0, DELIVERED 중복 0, outbox 180 = 톡톡 수신 180·중복 키 0. limiter 초당 10에서 약 11.8초, 500에서 약 2.5초 | jobId `track-<id>`가 같은 운송장 job을 하나로. BullMQ limiter는 큐 단위라 워커를 늘려도 호출 상한은 같다 |
| [0006](docs/experiments/0006-대량-처리.md) | N+1 대 일괄, 박스 500대·엑셀 5,000행, relay addBulk | 500행 N+1 쿼리 2,503·약 2.2초 대 일괄 12·약 0.3초(차이 대부분은 행마다 flush). 박스 500대 약 0.4초, 엑셀 1,000행 0.5~0.6초·5,000행 2.2~2.7초(RSS +31~42MB). relay 1회 최대 52~103ms → 15~34ms | 일괄 엔진 한 곳. relay는 addBulk(decisions/0024) |
| [0007](docs/experiments/0007-교체-단말기-동시-요청.md) | 같은 교체 단말기를 10건이 동시에 요청하면 | Day 3: 성공 1·422 9·데드락 0, 고아 운송장 매회 9장. Day 4(Redis 예약 뒤): 고아 0, 진 9건은 REPLACEMENT_RESERVED. 서로 다른 교체 단말기 10대는 201 10 | 트랜잭션 밖 사전 확인은 동시 요청을 못 거른다 → 교체 단말기 예약(decisions/0026) |
| [0008](docs/experiments/0008-하트비트-5000대.md) | 5,000대가 5초마다(초당 1,000건) 하트비트를 보내면 | Redis 경로 30,000/30,000, 묶음 p50 12~13ms·p95 32~34ms, MySQL 쓰기는 스냅샷 30문장뿐. 하트비트마다 MySQL이면 묶음 300·단건 30,000문장, 묶음 p95 64~96ms. 오프라인 판정 10.1~15.2초 | MySQL 쓰기는 하트비트 수가 아니라 스냅샷 횟수에 비례 → Redis 경로(decisions/0027) |
| [0009](docs/experiments/0009-펌웨어-단계-배포.md) | 1,000대 단계 배포, 실패율 30%면 언제 멈추나 | 실패율 0% 9.6~9.7초에 완료. 30%면 2.08~2.12초에 1단계에서 자동 중단, 영향은 1단계 100대 전부, 끝난 뒤 남은 제안 0 | 한 단계 대상은 같은 주기에 지시를 받아 단계 안 중단은 영향을 줄이지 못한다 — 손잡이는 첫 단계 비율 |
| [0010](docs/experiments/0010-device-큐-job-시간과-project-줄서기.md) | device 큐(concurrency 1) job이 active 갱신을 얼마나 막나 | 평소 판정 약 2ms, 스냅샷 약 0.5초, 대량 끊김 판정 1.3~1.5초. 더 큰 것은 relay 줄: 대량 끊김 Outbox 5,000행 → 약 100초 | 큐는 나누지 않고 대량 접속 변화를 묶음 알림 1행으로(decisions/0029) |
| [0011](docs/experiments/0011-실행계획-단말기-10만-이력-100만.md) | 단말기 10만·이력 100만에서 F4·주간 리포트 쿼리의 실행계획 | F4 status_changed_at 인덱스 8.2·9.8ms 대 이력 서브쿼리 102·220ms. 리포트 이력 집계 전체 훑기 165~192ms, 커버링 인덱스는 합 0.2초 줄이지만 이력 대량 INSERT +99%. 중복 인덱스는 INSERT +29%·+20MB | F4는 status_changed_at(decisions/0034), 리포트 이력에는 인덱스를 더하지 않음(decisions/0036) |
| [0012](docs/experiments/0012-VAN-대조-5만-건.md) | VAN 등록 5만 건 대조, 스캔 도중 변경 | 6.8~7.2초(수집 91%, 그중 약 4.2초는 개발 환경 전송 기다림으로 추정), 쿼리 343개, 업체 호출 = 페이지 + 후보. 재검증 전 거짓 양성 6 → 재검증 뒤 0, 지나간 자리의 새 어긋남 949건은 다음 실행이 모두 찾음 | 재검증이 필요하다. 놓친 어긋남은 최대 한 주기 늦게 잡힌다(decisions/0033) |
| [0013](docs/experiments/0013-단말기-목록-API-10만-대.md) | 단말기 10만 대에서 목록 API, joined 대 select-in | 조건 없음 1쪽 p50 91.2ms → 5.2ms(약 17.5배), 모델 36.1 → 3.6ms, 가맹점 21.1 → 3.5ms, 상태 21.7 → 3.3ms. 결과가 작은 조건만 2.1 대 2.9ms. offset 끝쪽 10.3ms | 연관은 select-in, 10만 대에서는 offset 유지(decisions/0039) |
| [0014](docs/experiments/0014-워커-강제-종료와-알림.md) | 알림을 처리하던 워커를 강제 종료하면 알림이 사라지나 | 알림 300건, 2회. 처리 중 SIGKILL: 유실 0, 중복 수신 5(죽을 때 처리 중이던 job 5 = concurrency 5), 죽임 → 모두 SENT 약 61.4초(대기분은 새 워커가 약 4.0초, 나머지는 stalled 복구 대기로 추정 — BullMQ 기본값 lockDuration·stalledInterval 30초 기준, 따로 재지 않음). job 유실 흉내(`drain`): 워커만으로는 3초 동안 0건, 복구 sweep 300/300 다시 넣은 뒤 약 4.2초에 모두, 중복 0. 죽인 직후 sweep은 살아 있는 job 210개를 건드리지 않음 | 유실 0, 단 at-least-once — 처리 중이던 것은 중복될 수 있어 메신저 멱등키가 거른다(decisions/0016). 큐에서 사라진 job은 복구 sweep이 메운다(decisions/0042) |
| [0015](docs/experiments/0015-대시보드-캐시-전후.md) | 대시보드 캐시 전후 p50/p95, 동시 50개의 MySQL 쿼리 수 | 단말기 10만·이력 약 100만, 2회. 요청 하나 캐시 없음 p50 169.1·172.5ms / p95 192.9·189.5ms 대 적중 p50 0.4ms(HTTP 2.0·1.9ms). 빈 캐시에 동시 50개: 캐시만이면 SELECT 350(캐시 없음과 같음)·전체 약 1.5초, single-flight면 SELECT 7·169~190ms | 캐시만으로는 캐시가 빈 순간의 동시 미스를 못 줄인다 → TTL 30초 캐시 + 프로세스 안 single-flight(decisions/0044) |
| [0016](docs/experiments/0016-상태-조건-목록-status-id-인덱스.md) | 상태 조건 목록에 (status, id) 인덱스가 필요한가 | 드문 상태(450·50대)는 기존 `(status, status_changed_at)` 인덱스로 450·50행 + 정렬, 흔한 상태(약 1만·5천 대)는 PK 역순 175·396행에서 멈춤. 인덱스가 있어도 계획이 바뀐 것은 IN_SERVICE 하나, p50은 어느 상태든 1.7~2.9ms로 차이 없음(IN_SERVICE 2.89 → 2.84ms). 쓰기 UPDATE +6.1%·INSERT +4.1%, 인덱스 +1.46MB | 사전 기준(p50 2배 이상 그리고 1ms 이상 감소)에 해당 없음 → 채택하지 않음(decisions/0045) |

### 설계안 7장 "실험으로 남길 숫자"와의 대응

| 설계안 7장 | 확인할 것 | 어디서 확인했나 |
|---|---|---|
| 번개택배 중복 이벤트 N건 주입 | 중복 반영 0건 | 실험 0003(30%, 3회 모두 0) |
| 429 비율 10%/30%/50% | 수집 완료율, 완료까지 걸린 시간 | 실험 0004 |
| 운영자와 배치가 같은 단말기를 동시에 변경 | 충돌 감지 건수, 잘못된 최종 상태 0건 | 실험 0001(A: HTTP 20건 → 409 19, B: 시스템 작업 직접 호출 — 낙관적 락·규칙 위반으로 실패, 최종 상태 하나) |
| 같은 박스를 두 번 스캔 | 두 번째는 처리 없이 같은 결과 반환 | 실험 기록 없음 — e2e 테스트 `apps/api/test/scan.e2e.spec.ts` "같은 scanId를 다시 보내면 처리하지 않고 저장된 결과를 200으로 준다"·"처리 중에 같은 scanId가 또 오면 409 SCAN_IN_PROGRESS"(decisions/0020) |
| 교체 출고 중 한쪽 실패 | 두 단말기·A/S 건 모두 원래대로 | 실험 기록 없음 — e2e 테스트 `apps/api/test/replacement.e2e.spec.ts` "트랜잭션 안에서 하나라도 실패하면 두 단말기·운송장·접수가 모두 그대로"(운송장은 고아로 남는다, decisions/0023). 동시 요청은 실험 0007 |
| 시뮬레이터 단말기 5,000대 하트비트 | Redis 처리량, MySQL 쓰기 횟수(직접 쓸 때와 비교) | 실험 0008 |
| 펌웨어 배포 중 실패율 상승 | 자동 중단까지 걸린 시간 | 실험 0009 |
| 워커 강제 종료 | 알림 유실 0건 | 실험 0014(+ 워커 2개 실험 0005) |
| 대시보드 캐시 전후 | p50/p95 | 실험 0015 |

## 기록

이 프로젝트의 산출물은 코드와 기록이다(규칙 `CLAUDE.md`, 양식 `docs/README.md`).

- 기록 색인(제목 목록): [`docs/index.md`](docs/index.md) — 결정 46·트러블슈팅 28·실험 16 (`node scripts/docs-index.mjs`로 만든다)
- 개발일지: [`docs/devlog/`](docs/devlog/)(날짜별, 날마다 "N일차 요약"), 설계 스펙 [`docs/specs/`](docs/specs/), 구현 계획 [`docs/plans/`](docs/plans/), 날마다의 최종 리뷰 [`docs/reviews/`](docs/reviews/)
- 7일 회고: [`docs/retrospective.md`](docs/retrospective.md) — 날별로 만든 것, 잘 된 것·안 된 것, 반복된 실수, 면접에서 말할 거리, 남은 이월
- 공부거리: [`docs/study/backlog.md`](docs/study/backlog.md)

## 테스트

(Day 7, 실험 0016과 리뷰 반영 뒤 실제로 돌려 센 값. api는 실험 파일 제외 — 실험은 `EXPERIMENTS=1`에서만 돈다)

| 앱 | 파일 | 테스트 |
|---|---|---|
| api(실험 제외) | 65 | 446 |
| admin | 12 | 108 |
| partners | 6 | 53 |
| device-sim | 4 | 40 |
