# Day 5 설계 — VAN 등록 대조, 이상 단말기 찾기, 주간 운영 리포트, 실행계획

- 날짜: 2026-10-26
- 범위: 설계안 8장 Day 5(F9 브릿지VAN 등록 대조, F4 이상 단말기 찾기, F11 주간 운영 리포트, 기록 핵심 "대조 쿼리와 인덱스, 실행계획") + Day 4 리뷰 이월(`docs/reviews/2026-10-23-day4-final-review.md` Minor: env NaN 검사, 중복 인덱스) + 실험 2개(0011 실행계획, 0012 VAN 대조)
- 구현 계획: `docs/plans/2026-10-26-day5-reports.md`
- 등장하는 회사(브릿지VAN, 톡톡메신저, 세움전자, 번개택배, 느림보물류)와 가맹점은 모두 가상이다.

## 1. 무엇을 왜

Day 4까지는 단말기 한 대 한 대의 일(전이, 출고, 하트비트, 배포)을 다뤘다. Day 5는 **전체를 훑어 어긋난 것을 찾는 일**이다. 세 기능 모두 "큰 집합을 SQL로 비교·집계하고, 결과를 한 번 알린다"는 같은 모양이고, 그래서 이날의 학습 주제는 인덱스와 실행계획이다.

1. **F9 VAN 등록 대조**: 단말기가 결제하려면 VAN(브릿지VAN)에 등록돼 있어야 한다. VAN이 들고 있는 등록 목록(수만 건, 커서 페이지)을 모두 받아 우리 DB(단말기 상태·가맹점)와 SQL 집합 비교로 맞춰 보고, 어긋난 후보는 **단건으로 다시 확인(재검증)** 해 스캔 도중 바뀐 것을 걸러 낸 뒤 확정한다.
2. **F4 이상 단말기 찾기**: "배송 완료 7일째 미설치", "회수 요청 14일째 미입고" 같은 규칙 6개. 핵심은 "**그 상태가 된 시각**"을 어떻게 구하느냐다. 이력 테이블을 매번 훑는 대신 `terminal.status_changed_at`을 전이 서비스가 상태와 같은 UPDATE에서 바꾸고 `(status, status_changed_at)` 복합 인덱스 범위 하나로 찾는다. 결과는 열린 이상 테이블로 남겨 새로 걸린 것만 알린다.
3. **F11 주간 운영 리포트**: 매주 월요일 09:00(KST) 지난주 수치를 DB에서 집계해 xlsx로 만들고 톡톡메신저에 첨부로 보낸다. 같은 주는 두 번 보내지 않는다.
4. **실험**: 단말기 10만·이력 약 100만에서 (a) 이력 서브쿼리 대 (b) 컬럼+인덱스, 중복 인덱스의 쓰기 비용, 대조·집계 쿼리의 실행계획(0011). 등록 5만·어긋남 2%에서 대조 소요와 쿼리 수, 스캔 도중 변경의 거짓 양성(0012).

Day 4 이월: 숫자 환경변수 검증(NaN이면 시작 실패), FK 열 단독 중복 인덱스 6개 정리.

## 2. 구성

```
apps/partners
  ├─ bridgevan (새)   GET /bridgevan/v1/terminals?cursor=&limit= (커서 페이지), ?serialNo= (재검증용), GET /bridgevan/v1/terminals/:tid
  │                   POST /__admin/bridgevan/registrations (심기, healTo), 설정 bridgevan.{maxLimit, delayMs, error5xxRate, force429Rate, retryAfterSec, mutateDuringScan}
  └─ toktok           POST /toktok/files (base64 JSON 올리기 → fileId), 웹훅 attachments, GET /__admin/toktok/files/:fileId

apps/api
  ├─ config           intFromEnv(정수·범위, 실패하면 시작 실패), 새 env: BRIDGEVAN_PAGE_SIZE, VAN_RUN_STALE_MS, VAN_REVERIFY_CONCURRENCY,
  │                   ANOMALY_*_DAYS, ANOMALY_BULK_EVENT_THRESHOLD, ANOMALY_SCAN_CRON, VAN_RECONCILE_CRON, WEEKLY_REPORT_CRON
  ├─ common           partnerBackoffMs·withPartnerRetry(한 job 안의 외부 호출 재시도, carrier 백오프와 같은 규칙)
  ├─ van (새)         BridgevanClient, VanReconciliationService(start·request·execute·collect·compare·reverify·finish·cleanup),
  │                   van-compare(classify), POST /van-reconciliations, GET /van-reconciliations/:id
  ├─ terminal         Terminal.statusChangedAt + (status, status_changed_at) 인덱스, TransitionService가 상태와 함께 갱신
  ├─ anomaly (새)     Anomaly(열린 이상 부분 unique), findAnomalies(규칙 SQL), AnomalyService.scan/list, GET /anomalies, POST /anomaly-scans
  ├─ report (새)      ReportProcessor(report 큐), kst-week, WeeklyReportQueries, weekly-report.xlsx, WeeklyReport(엔티티), WeeklyReportService,
  │                   POST /reports/weekly, GET /reports/weekly/:weekStart, GET /reports/weekly/:weekStart/file
  ├─ outbox           type 3개(van.reconciliation_completed, anomaly.detected, anomaly.detected_bulk)와 문구, ToktokClient.uploadFile·attachments
  ├─ queue            report 큐(device 큐와 나눔)
  └─ scheduler        JOB_SCHEDULERS가 every 또는 cron(pattern + tz Asia/Seoul): anomaly-scan-daily 02:00, van-reconcile-daily 03:00, weekly-report 월 09:00
```

## 3. 데이터 모델

| 엔티티 | 핵심 컬럼 | 제약·인덱스 | 메모 |
|---|---|---|---|
| `Terminal`(변경) | + status_changed_at datetime(3) | (status, status_changed_at), status 단독 인덱스 삭제 | 전이 서비스가 상태와 같은 UPDATE에서 갱신, 이력 occurred_at과 같은 값. 마이그레이션이 이력으로 백필 |
| `VanReconciliationRun` | status(RUNNING·COMPLETED·FAILED), trigger, requested_by, started_at, finished_at, pages, fetched, retries, candidates, confirmed, resolved, counts json, phase_ms json, error | 생성 열 `running_key`(RUNNING이면 1, 아니면 NULL) + unique | 진행 중 실행은 하나. 오래 RUNNING이면(VAN_RUN_STALE_MS) 다음 시작이 FAILED로. MikroORM 부분 unique(`where: { status: 'RUNNING' }`)는 MySQL이 식에 `_utf8mb4`를 붙여 저장해 `db:migration:check`가 늘 달라 쓰지 않는다 |
| `VanRegistrationSnapshot` | PK (run_id, serial_no), tid, merchant_code, status, van_updated_at | PK뿐, **FK 없음** | 스테이징. 정리는 `delete … where run_id = ? limit 5000`(PK 범위) |
| `VanReconciliationItem` | run_id(FK), serial_no, kind, our_value, van_value, verified | run_id 인덱스(항목에 PK가 붙어 (run_id, id) 순서 페이지에 충분) | 후보마다 한 행. verified=false = 재검증에서 풀린 거짓 양성 |
| `Anomaly` | terminal_id(FK 없음), rule, detected_at, last_seen_at, resolved_at, detail json | 부분 unique `((case when resolved_at is null then terminal_id end), (case … rule end))`, (resolved_at, rule) | 열린 이상은 (단말기, 규칙)마다 하나, 닫힌 행은 이력 |
| `WeeklyReport` | week_start date unique, status(PENDING·GENERATED·SENT), file_name, file mediumblob(lazy), file_size, generated_at, sent_at, toktok_file_id, attempts, last_error | week_start unique | 같은 주 한 행, 재시도는 같은 행 갱신 |

중복 인덱스 정리(이월): `carrier_event_shipment_id_index`, `firmware_model_id_index`, `firmware_rollout_target_rollout_id_index`, `inspection_item_model_id_index`, `service_ticket_terminal_id_index`, `terminal_status_history_terminal_id_index` — 모두 FK 열 단독 인덱스이고 같은 열로 시작하는 unique·복합 인덱스가 있다. `@ManyToOne({ index: false })`로 MikroORM이 만들지 않게 하고, 마이그레이션은 `drop index`. MySQL은 덮는 인덱스가 있을 때만 FK 지원 인덱스 삭제를 허용한다(없으면 ERROR 1553, 사전 검증).

마이그레이션 5개(인덱스 정리, VAN 실행·스테이징, VAN 결과, 이상·status_changed_at, 주간 리포트). status_changed_at은 손으로 고친다: 생성된 그대로(`add … datetime(3) not null`)면 행이 있는 DB에서 ERROR 1292(`'0000-00-00'`, strict 모드)라 null 허용 추가 → 백필 → not null.

## 4. 흐름

### 4.1 VAN 등록 대조 (F9)
```
POST /van-reconciliations (X-Operator) → start: 멈춘 RUNNING 정리(PK 갱신) → INSERT run(RUNNING)  ← running_key unique 위반이면 409 VAN_RECONCILIATION_RUNNING
                                        → report 큐 add('van-reconcile', {runId}, jobId van-run-<id>)  → 202
report 큐 워커 execute(runId):
  collect   스테이징 지우기(재시작 대비) → 커서 페이지 반복: withPartnerRetry(list, 5번, 429는 Retry-After) → 페이지마다 INSERT … ON DUPLICATE KEY UPDATE(자동 커밋)
  compare   한 RR 읽기 전용 트랜잭션에서 두 문장:
            ① terminal(IN_SERVICE) ⟕ merchant ⟕ snapshot(run_id, serial_no) — VAN 없음·해지·정지·가맹점 다름
            ② snapshot(run_id, ACTIVE) ⟕ terminal(serial_no) ⟕ merchant — 우리가 운영 중 아님·없음
            종류는 classify(TS, 재검증과 같은 함수)
  reverify  후보 100개씩: VAN 시리얼 조회(동시 8, withPartnerRetry) + 우리 쪽 한 문장 → classify 다시 → 여전히 어긋나면 verified=true(지금 값), 풀렸으면 false(비교 때 값)
  finish    한 트랜잭션: UPDATE run(RUNNING → COMPLETED, 요약) → INSERT item(500행씩) → Outbox van.reconciliation_completed 1행
  cleanup   앞선 실행들의 스테이징을 run_id별 DELETE … LIMIT 5000 반복
  실패      어디서든 run을 FAILED(이유)로, job은 끝낸다(BullMQ 재시도 없음)
주기: van-reconcile-daily(cron 0 3 * * * Asia/Seoul) → runScheduled(진행 중이면 건너뜀)
```

어긋남 종류(대조 키 serial_no, 가맹점은 merchant.code):

| 종류 | 우리 | VAN |
|---|---|---|
| NOT_REGISTERED | IN_SERVICE | 없음 또는 CANCELLED |
| SUSPENDED_WHILE_IN_SERVICE | IN_SERVICE | SUSPENDED |
| MERCHANT_MISMATCH | IN_SERVICE(가맹점 없음 포함) | ACTIVE, 가맹점 다름 |
| REGISTERED_BUT_NOT_IN_SERVICE | IN_SERVICE 아님 또는 없음 | ACTIVE |

### 4.2 이상 단말기 찾기 (F4)
```
scan(now) — Redis 잠금 job-lock:anomaly-scan(없으면 409 ANOMALY_SCAN_RUNNING / 주기 job은 건너뜀)
  findAnomalies: 규칙마다 SQL 한 문장, 기준 시각은 앱에서 계산해 파라미터로(NOW() 쓰지 않음)
    상태 경과 4개: terminal where status in (…) and status_changed_at < ?   ← (status, status_changed_at) 범위
    가맹점 없음:   terminal where status='IN_SERVICE' and merchant_id is null
    장기 오프라인: device_connectivity(online=0, last_seen_at < ?) ⋈ terminal(IN_SERVICE)
  열린 이상 읽기(resolved_at is null) → (단말기, 규칙) 키로 비교
  한 트랜잭션: INSERT 새 이상 / UPDATE last_seen_at WHERE id IN (계속) / UPDATE resolved_at WHERE id IN (풀림) / Outbox(새 이상)
    새 이상 ≤ ANOMALY_BULK_EVENT_THRESHOLD(20) → anomaly.detected 단말기마다, 넘으면 anomaly.detected_bulk 1행(규칙별 수, 앞 100대)
주기: anomaly-scan-daily(cron 0 2 * * * Asia/Seoul)
조회: GET /anomalies?rule=&open=&afterId=&limit=, 수동: POST /anomaly-scans(동기 200)
```

| 규칙 | 조건(기본 기준일, env) |
|---|---|
| DELIVERED_NOT_INSTALLED | DELIVERED가 7일 넘음(ANOMALY_DELIVERED_DAYS) |
| RETURN_STALLED | RETURN_REQUESTED·RETURNING이 14일 넘음(ANOMALY_RETURN_STALLED_DAYS) |
| SHIPPED_TOO_LONG | SHIPPED가 10일 넘음(ANOMALY_SHIPPED_DAYS) |
| ALLOCATED_NO_SHIPMENT | ALLOCATED가 3일 넘음(ANOMALY_ALLOCATED_DAYS) — 출고하면 SHIPPED가 되므로 ALLOCATED = 출고 없음 |
| IN_SERVICE_NO_MERCHANT | IN_SERVICE인데 가맹점 없음 |
| OFFLINE_TOO_LONG | IN_SERVICE이고 device_connectivity 오프라인, 마지막 하트비트가 3일 넘음(ANOMALY_OFFLINE_DAYS) |

### 4.3 주간 운영 리포트 (F11)
```
POST /reports/weekly { weekStart?: 'YYYY-MM-DD'(KST 월요일) } 또는 주기 weekly-report(cron 0 9 * * 1 Asia/Seoul → 지난주)
send(week) — Redis 잠금 report-lock:weekly-<주>(없으면 409 WEEKLY_REPORT_IN_PROGRESS)
  행 확보(week_start unique, 동시 생성은 unique 위반 → 다시 읽기). SENT면 alreadySent(아무것도 안 함)
  파일 없으면: WeeklyReportQueries.collect(한 RR 읽기 전용 트랜잭션, 일곱 쿼리) → xlsx(시트 8장) → 행에 저장(GENERATED)
  attempts + 1 → 톡톡 파일 올리기(base64 JSON) → 메시지(멱등키 weekly-report-<주>, attachments [fileId]) — 각각 3번까지(withPartnerRetry)
  실패: last_error 남기고 던짐(HTTP 502 PARTNER_ERROR), 다시 보내면 저장한 같은 파일로
  성공: SENT, sent_at, toktok_file_id
GET /reports/weekly/:weekStart(상태), GET /reports/weekly/:weekStart/file(xlsx, filename*=UTF-8'')
```

시트: 요약, 상태·모델, 전이(지난주, 출처·도착 상태별), 입출고(지난주 신규 등록·출고·회수 입고, 모델별), 이상 단말기(열린 것, 최대 1,000행), 접속 상태(운영 중의 온라인·오프라인·기록 없음), 펌웨어 배포(그 주에 진행 중이었거나 끝난 것), VAN 대조(가장 최근 완료).

KST 주: 월요일 00:00 KST = 일요일 15:00 UTC. DB는 UTC로 저장하므로 `[from, to)`를 UTC 시각으로 넘긴다. `kstWeekOf`·`previousKstWeek`·`parseKstWeekStart`는 getUTC*만 쓴다(서버 시간대 무관).

### 4.4 잠금·쓰기 규칙 (Day 2~4 교훈)
- 외부 호출(VAN·톡톡)은 트랜잭션 밖. 수집은 페이지마다 자동 커밋, 결과 확정만 한 트랜잭션.
- 여러 행 갱신은 PK `IN (…)` + 상태 조건(이상 last_seen·resolved, 실행 행 FAILED 처리). 스테이징 삭제는 PK 앞부분(run_id) 범위 + LIMIT.
- 비교·리포트 집계는 RR 읽기 전용 트랜잭션 하나(같은 시점).
- 원시 SQL datetime은 `fromDbDatetime`, 기준 시각은 앱에서 계산해 파라미터로(troubleshooting/0016).
- 알림은 묶음 원칙: VAN 대조는 늘 요약 1행, 이상은 기준을 넘으면 1행(experiments/0010).
- 큐 나눔: VAN·이상·리포트는 report 큐(concurrency 1). device 큐(짧은 job)를 막지 않는다.
- 스테이징·이상 테이블에는 FK를 두지 않는다(수만 행 INSERT의 FK 검사 S 락, Outbox·device_connectivity와 같은 이유).

## 5. 실패 처리

| 상황 | 응답·동작 |
|---|---|
| 숫자 env가 정수가 아니거나 범위 밖 | 시작할 때 이름·값을 담아 던짐(서버·워커가 뜨지 않음) |
| VAN 대조 진행 중에 또 요청 | 409 VAN_RECONCILIATION_RUNNING(주기 실행은 건너뜀) |
| VAN 429·5xx | 그 호출만 5번까지(429 Retry-After, 그 밖 500ms·1s·2s·4s). 다 쓰면 실행 FAILED(이유) |
| VAN 응답 형식 오류 | PartnerPermanentError → 실행 FAILED |
| 워커가 죽어 실행이 RUNNING으로 남음 | 다음 시작이 VAN_RUN_STALE_MS(1시간) 넘은 것을 FAILED로 |
| 큐에 못 넣음 | 실행 FAILED 후 500 |
| 결과 목록 kind·verified·limit 틀림 | 400 |
| 이상 찾기 진행 중에 또 요청 | 409 ANOMALY_SCAN_RUNNING(주기 job은 건너뜀) |
| 열린 이상 중복 INSERT | unique 위반(마지막 안전망, 잠금이 먼저 막음) |
| 주간 리포트 weekStart가 KST 월요일 날짜가 아님 | 400 INVALID_WEEK_START |
| 같은 주를 동시에 보냄 | 409 WEEKLY_REPORT_IN_PROGRESS |
| 이미 보낸 주 | 200 alreadySent: true(톡톡 호출 없음) |
| 톡톡 실패(3번) | 502 PARTNER_ERROR, 행 GENERATED·last_error, 다시 보내면 같은 파일 |
| 파일이 아직 없는 주 내려받기 | 404 |
| 모르는 report job | UnrecoverableError(재시도 없음) |

## 6. 실험

| 번호 | 질문 | 설정 | 볼 것 |
|---|---|---|---|
| 0011 | ① "그 상태가 된 시각"을 이력 서브쿼리로 구하는 것과 컬럼+인덱스는 얼마나 다른가 ② FK 열 단독 중복 인덱스의 쓰기 비용 ③ 대조·집계 쿼리의 실행계획 | 단말기 10만(SQL INSERT…SELECT), 이력 단말기마다 1~19행(약 100만), 검수 2만·결과 8만, 접속 상태·VAN 스테이징(운영 중 전부) | 규칙 2개 × (a)·(b)·(b 인덱스 무시) 5번 중앙값·EXPLAIN ANALYZE, 찾기 전체 시간, INSERT…SELECT 10만 행 × 인덱스 있음·없음 3번·Index_length, Day 1 검수 통계·VAN 비교 2문장·리포트 전이 집계·열린 이상 목록의 EXPLAIN ANALYZE |
| 0012 | 등록 5만·어긋남 2%에서 대조가 얼마나 걸리고 쿼리를 몇 개 쓰나, 스캔 도중 변경 때 재검증이 거짓 양성을 몇 개 거르고 무엇을 놓치나 | 운영 중 5만, VAN 등록 5만+α, 4종류 어긋남 돌려 심기(절반 healTo), 페이지 500, 재검증 동시 8, 변경 10건/페이지 | A 기본·B 변경·C 다음 실행: 단계별 ms, 페이지·VAN 호출·단건 조회, 후보·확정·풀림, 쿼리 수(종류별), 바뀐·고쳐진 수 |

둘 다 `EXPERIMENTS=1`, `--silent=false`. 숫자는 실제로 잰 값만 기록한다.

## 7. 기록할 결정

- 0032 숫자 env 검증(intFromEnv)과 FK 열 단독 중복 인덱스 정리(index: false, MySQL 1553, 쓰기 비용은 0011)
- 0033 VAN 등록 대조: 커서(키셋) 페이지(offset의 중복·누락), 대조 키(시리얼, 가맹점 코드), MySQL 스테이징 + SQL 집합 비교(메모리 대조·JSON_TABLE과 비교), 재검증, 한 job 안의 재시도, report 큐, 진행 중 실행 하나(생성 열 unique), 스테이징 정리, 결과 키셋 페이지
- 0034 이상 단말기: status_changed_at 컬럼 대 이력 서브쿼리(0011 숫자), 백필, 열린 이상 부분 unique(MikroORM where 함수 인덱스 대 생성 컬럼 대 앱이 채우는 열), FK 없음, 알림 묶음, 규칙 정의
- 0035 주간 리포트: cron + tz(BullMQ 6 job scheduler), KST 주 경계, DB 집계, xlsx(exceljs 쓰기), 톡톡 첨부 방식(base64 JSON 대 multipart), 파일 저장(DB blob 대 디스크), 멱등(week_start unique + 상태 + 멱등키)
- 갱신: 0013(report 큐), 0015(cron 주기 작업 3개), 0016(Outbox type 3개), 0009(브릿지VAN·톡톡 파일), 0014(partnerBackoffMs 공유)

## 8. 이번에 하지 않는 것

- VAN에 등록·해지 요청 보내기(대조만 하고 고치지 않는다), 어긋남 자동 해소, VAN 쪽 tid를 우리 테이블에 저장.
- 대조 스캔 도중 변경의 "놓침"을 같은 실행에서 잡기(다음 실행이 잡는다, 0012가 잰다). 스냅샷 일관성 보장(VAN API가 스냅샷을 주지 않는 가정).
- 이상 규칙을 운영자가 화면에서 바꾸기(env와 배포), 이상 담당자 지정·확인 처리, 이상 해소 알림.
- 리포트 시트 서식(차트, 조건부 서식), 리포트 이메일, 여러 채널. 대용량 리포트 스트리밍 쓰기.
- 실행계획을 운영 DB 크기에서 다시 재기(0011은 로컬 한 PC, 합성 데이터).
- Day 4 남은 문제(단말기 인증, 같은 버전 재배포 지연 등)와 Day 3 남은 문제(QUEUED outbox 복구 sweep 등).
