# Day 5 최종 리뷰 (2026-10-26)

- 범위: `339f697..d36a1c4` (day5-reports, 커밋 20개: docs 2, feat 7, fix 9, exp 2). 112파일, +15,765 / −155
- 판정: **수정 후 병합**. Critical은 없고 Important 2건이 있다. 둘 다 몇 줄로 고칠 수 있다.

## 범위
- 이월 정리: `intFromEnv`로 숫자 env 16개 검증, FK 열에만 걸린 중복 인덱스 6개와 `terminal_status_index` 삭제(decisions/0032)
- partners: 가상 브릿지VAN(커서 목록·시리얼 조회·스캔 도중 변경), 톡톡 파일 올리기(base64 JSON)와 메시지 첨부
- F9 VAN 대조: 실행 행(생성 열 `running_key` unique), 커서 수집, 스테이징, SQL 두 문장 집합 비교, 단건 재검증, 결과·요약 Outbox를 한 트랜잭션으로 처리. 하트비트로 생존 판정, 안전장치 3종, `acknowledgeDrop`, 확인 불가 항목(decisions/0033)
- F4 이상 단말기: `terminal.status_changed_at`과 `(status, status_changed_at)` 인덱스, 규칙 6개, 열린 이상 부분 unique(함수 인덱스), 묶음 알림(decisions/0034)
- F11 주간 리포트: KST 주 경계, DB 집계 7쿼리, xlsx 시트 8장, `weekly_report`(mediumblob), Redis 잠금, 톡톡 첨부. 자동 재시도 5번, 직전 4주 이어 보내기, 영구 오류는 UnrecoverableError(decisions/0035, 0036)
- report 큐(concurrency 1)와 cron 주기 작업 3개(`pattern` + `tz: 'Asia/Seoul'`, `cronFromEnv` 검증)
- 기록: decisions 0032~0036, troubleshooting 0022~0024, experiments 0011·0012, 마이그레이션 8개(누적 22개), backlog 133줄

## 검증 결과 (리뷰어가 직접 실행)
- api `npx vitest run`: `Test Files 56 passed (56)`, `Tests 391 passed (391)`, 204.9초, exit 0. 로그에 `Connection is closed` 0줄
- api `npm run typecheck`: exit 0
- partners: `6 passed (6)` / `52 passed (52)`. partners typecheck exit 0
- device-sim: `4 passed (4)` / `40 passed (40)`
- 실행 전후 node 프로세스는 같은 PID 3개(43936, 35448, 28868)로, 테스트가 남긴 프로세스는 없다. `git status`는 깨끗하다
- 직접 하지 않은 것: `db:migration:check`, 빈 DB 마이그레이션 체인, 실서버 확인. 이 셋은 devlog 15:15 항목의 기록을 확인했다. 22개 up 체인과 check 결과 "최신 상태", smoke 출력이 남아 있다. **down 체인은 기록에도 검증이 없다**(Minor 3)
- devlog 제목 시각 18곳이 모두 커밋 시각과 같다(`git log --date=format:%H:%M`으로 하나씩 대조). 코드·기록에 적힌 decisions·troubleshooting·experiments 번호 참조 가운데 없는 파일을 가리키는 것은 0건

## Strengths
- **F9 설계가 실험으로 확인됐다.** SQL은 후보만 거르고 종류는 TS `classify` 한 곳에서 정한다. 재검증도 같은 함수를 쓴다. 실험 0012에서 정답 집합과 비교해 보니 재검증 전 거짓 양성 6건이 재검증 뒤 0건이 됐다. 놓친 949건은 다음 실행이 모두 찾았다. 쿼리 수와 업체 호출 수가 페이지 수·후보 수에 비례한다는 것도 코드와 숫자로 맞춰 봤다
- **동시성 처리가 꼼꼼하다.**
  - 실행 행 상태 변경은 모두 `status=RUNNING` 조건부 UPDATE다. 0행이면 `VanRunNotRunningError`를 던지고 결과를 롤백한다
  - `failStale`은 잠그지 않고 읽은 뒤 PK와 하트비트를 다시 조건으로 걸어 갱신한다
  - 이상 찾기 갱신은 PK `IN (…)`에 `force index (primary)`를 쓴다(0014의 gap 락 교훈). 겹친 찾기는 ON DUPLICATE KEY와 `greatest(last_seen_at)`로 처리한다
  - 주간 리포트는 `attempts = attempts + 1`처럼 SQL 증분으로 세고, 상태 갱신에 `status != SENT` 조건을 건다
- **마이그레이션을 손으로 다듬었다.** NOT NULL 열은 null 허용 추가 → 백필 → not null 3단계로 넣었다. 새 복합 인덱스를 먼저 만들고 status 단독 인덱스를 지운다. 문자열 상수가 든 부분 unique는 `migration:check`가 계속 다르다고 해서 생성 열로 바꿨다
- **시간대 처리가 일관된다.** raw 결과는 `fromDbDatetime`으로 읽고, SQL에서 `NOW()`를 쓰지 않는다. KST 주 경계는 `getUTC*`만 쓴다. 기준일 ±1시간 경계 테스트가 있다(anomaly.e2e:194). cron은 시작할 때 다섯 칸과 tz 파싱을 검사한다
- **report 큐를 분리했다.** device 큐와 나눴고(experiments/0010 교훈), 주기 job 3개의 등록·template opts·tz를 e2e로 확인한다(scheduler.e2e:37-50). 재시도는 주간 리포트만 쓰고, 영구 오류는 `UnrecoverableError`로 바로 끝낸다
- **Day 4 이월을 반영했다.** env NaN 검증은 남은 `Number(process.env…)`가 0개다. 중복 인덱스는 실험 0011에서 쓰기 비용(이력 INSERT +29%)을 재고 삭제했다

## Issues

### Critical
없음.

### Important

**1. 이번 주나 미래 주를 수동으로 보내면 SENT로 굳어 월요일 주기 job이 그 주를 건너뛴다**
- 위치: `apps/api/src/report/weekly-report.controller.ts:245`, `apps/api/src/report/kst-week.ts:294-302`
- 문제:
  - `parseKstWeekStart`는 아무 월요일이나 받는다. 예를 들어 오늘(10-26) `POST /reports/weekly {"weekStart":"2026-10-26"}`를 보내면, 반나절 데이터만 든 리포트가 그 주 행에 `SENT`로 남는다
  - 11-02 09:00 주기 job은 `previousKstWeek` = 10-26 주를 `alreadySent: true`로 건너뛴다. 완전한 주간 리포트가 영영 나가지 않는다
  - 같은 주의 파일 다시 만들기 경로도 없다(GENERATED 파일 재사용, SENT면 아무것도 안 함). 미래 주는 전이·입출고가 0인 리포트가 SENT로 굳는다
- 수정:
  - `send()`(또는 컨트롤러 `weekOf`)에서 `week.to > now`이면 `BusinessError(422, 'WEEK_NOT_ENDED', …)`로 거절한다
  - 테스트 하나를 더한다: 이번 주 `weekStart` → 422, 행이 생기지 않음

**2. 주간 리포트의 온라인 수가 MySQL 스냅샷 지연 때문에 정상 단말기를 오프라인으로 센다**
- 위치: `apps/api/src/report/weekly-report.queries.ts:123-130`
- 문제:
  - `online = c.online = 1 and c.last_seen_at > now − HEARTBEAT_OFFLINE_AFTER_MS(90s)`로 센다
  - 그런데 `device_connectivity.last_seen_at`은 스냅샷 job(60초마다, decisions/0029)이 그때의 Redis lastSeen을 쓴 값이다. 단말기 하트비트 주기는 30초다
  - 그래서 정상 단말기도 MySQL 값이 최대 약 60 + 30 = 90초 낡을 수 있다. 엄격한 `>` 비교라 경계에서 오프라인으로 떨어진다. device 큐가 밀려 스냅샷이 늦으면(experiments/0010) 운영 중 단말기 거의 전부가 오프라인으로 집계될 수 있다
  - 조회 API는 Redis가 1순위라 이 문제가 드러나지 않는다. 리포트는 MySQL만 본다
  - 04737d6에서 부등호를 조회 API와 맞췄지만, 데이터 출처의 신선도가 다르다는 점은 남았다
- 수정(둘 중 하나):
  - (a) 판정 job이 Redis 기준으로 10초마다 맞추는 `c.online = 1`만 보고, 시각 조건은 빼거나 `hbOfflineAfterMs + connectivitySnapshotIntervalMs` 이상으로 넓힌다
  - (b) 리포트 생성 때 Redis 접속 상태를 읽는다
- 근거로 두면 좋은 테스트: last_seen_at = now − 80s, online = 1 → online으로 센다

### Minor

1. **VAN 하트비트 타이밍 검사가 Retry-After 상한을 빼고 계산한다**
   - 위치: `apps/api/src/van/van-limits.ts:8-10, 24`
   - 문제: 주석은 "Retry-After는 상한이 없어 넣지 않는다"고 하지만, `parseRetryAfter`는 `MAX_RETRY_AFTER_MS = 60_000`으로 자른다(`common/partner-http.ts:4,12`)
     - `beforeWait`는 간격이 아직 안 지났으면 하트비트를 보내지 않고 최대 60초를 잔다
     - 그래서 실제 하트비트 사이 최악값은 약 interval + 60s + 호출 시간(기본값으로 약 96초)이다. 그런데 검사는 52.5초짜리 STALE을 통과시킨다
     - 결과는 실행 중단(VanRunNotRunningError)뿐이라 데이터가 깨지지는 않는다
   - 수정: `need`에 `MAX_RETRY_AFTER_MS`를 더하고 주석을 고친다. 기본값 300s는 그대로 통과한다
2. **큐에서 기다리는 수동 VAN 실행이 멈춘 실행으로 FAILED 처리될 수 있다**
   - 위치: `apps/api/src/van/van-reconciliation.service.ts:163-171, 576-587`
   - 문제: `request()`가 만든 RUNNING 행의 `heartbeat_at`은 job이 report 큐(concurrency 1)에서 기다리는 동안 갱신되지 않는다
     - 앞에 긴 job이 있으면 5분을 넘길 수 있다. 예: 주간 리포트 최악 약 10.6분, 큰 VAN 실행
     - 그 사이 다음 `start()`가 이 행을 "멈춘 실행: 하트비트가 …없음"으로 FAILED 처리한다. 원래 job은 나중에 FAILED를 보고 건너뛴다
     - 안전하지만 이유 문구가 잘못됐고, 사용자 요청이 조용히 사라진다
   - 수정(둘 중 하나):
     - `failStale`에서 `pages = 0`(아직 시작 안 함)인 행은 `queue.getJob('van-run-'+id)`의 상태가 waiting/delayed면 건너뛴다
     - 또는 이 한계를 decisions/0033에 적는다
3. **`Migration20261026034551` down의 인덱스 순서가 up과 대칭이 아니다. down 체인 검증 기록도 없다**
   - 위치: `apps/api/src/migrations/Migration20261026034551.ts:27-29`
   - 문제:
     - up은 복합 인덱스를 먼저 만든 뒤 단독 인덱스를 지운다. down은 복합 인덱스를 먼저 지운다. 그 사이에 실패하면 status 인덱스가 하나도 없는 채로 남는다
     - devlog에는 22개 up 체인만 있다. down(특히 `024906`의 FK 인덱스 6개 다시 만들기, 생성 열·함수 인덱스 테이블 drop)은 돌려 본 기록이 없다
   - 수정: down을 `add index terminal_status_index` → `drop index terminal_status_status_changed_at_index` → `drop column` 순서로 바꾼다. Day 6 시작 때 테스트 DB에서 `down --to 0`·`up` 한 바퀴를 기록한다
4. **FAILED VAN 실행의 스테이징 행이 다음 COMPLETED까지 남는다**
   - 위치: `apps/api/src/van/van-reconciliation.service.ts:216-223`
   - 문제: 실패 경로는 `return`으로 정리를 건너뛴다. 안전장치가 며칠 연속 걸리면(예: VAN이 부분 응답 장애) 실행마다 최대 등록 수만큼(5만 행) 쌓인다. 디버깅용으로 남기는 것이라면 그 의도가 기록에 없다
   - 수정(둘 중 하나): 실패 경로에서도 `cleanupSnapshots(runId)`를 호출해 이번 실행 것만 남긴다. 또는 decisions/0033에 "FAILED 스냅샷은 다음 완료까지 보존"이라고 적는다
5. **Outbox가 도메인 모듈에 의존한다**
   - 위치: `apps/api/src/outbox/outbox.service.ts`의 import(`anomaly-rules`, `van-compare`)
   - 문제: 알림 문구 레이블 때문에 outbox가 anomaly·van 모듈을 import한다. `anomaly-rules.ts`는 env와 DB 쿼리 함수까지 가져온다. 순환은 아직 없지만 방향이 거꾸로다
   - 수정: 레이블 상수(`ANOMALY_RULE_LABEL`, `KIND_LABEL`)를 `*-labels.ts` 같은 순수 파일로 분리한다
6. **`POST /reports/weekly`가 동기로 최악 약 10.6분 걸린다**
   - 위치: `weekly-report.controller.ts:242-248`
   - 문제: 톡톡 재시도와 Retry-After를 다 쓰면 HTTP 요청이 그만큼 열려 있다. Day 6 어드민 화면에서 이 API를 부르면 프록시·브라우저 타임아웃에 걸린다
   - 수정: report 큐 job으로 보내고 202를 돌려주는 방식(VAN과 같은 패턴)을 Day 6에서 검토한다
7. **devlog 첫 항목 제목에 시각이 없다**
   - 위치: `docs/devlog/2026-10-26.md:5`
   - 문제: `## Day 5 계획 작성`에 시각이 없다. 대응 커밋은 0b525c5(11:48)다. 나머지 18곳은 커밋 시각과 같다
   - 수정: `## 11:48 Day 5 계획 작성`

## Day 6 이월 목록
- (이번 리뷰 Important를 병합 전에 고치지 않으면) 주 종료 전 수동 보내기 거절, 리포트 온라인 집계 출처
- Minor 1~7(위)
- Day 5 devlog의 남은 문제를 그대로 넘긴다
  - 주간 리포트: 메시지 at-least-once, 고아 파일, 프로세스가 죽으면 최대 약 10.6분 409, 4주 밖 미전송 주는 수동 처리
  - VAN: 시리얼 ASCII·유일 가정, 수집 시간 대부분이 개발 환경 전송 대기(troubleshooting/0023, 운영에서 같은지 모름)
  - 이상: 열린 이상이 수십만이면 목록 정렬 인덱스 검토, 백필한 `status_changed_at`과 이력이 어긋날 수 있음
- Day 4 이월 중 남은 것: 같은 버전 재배포 때 이미 목표 버전인 대상의 단계 지연, 하트비트 버전을 그대로 믿음(인증 없음), QUEUED outbox 복구 sweep, HTTP 1213 매핑
- Day 6 준비: CORS 또는 개발 서버 프록시, `X-Operator` 헤더 주입 방식, 프런트 도구·`apps/admin` 위치 결정 기록, 긴 동기 API(주간 리포트 보내기, 이상 찾기)를 화면에서 어떻게 부를지
- 개발 DB·Redis 상태: VAN 실행 #1 COMPLETED, 열린 이상 1건(AS-131205-R), 주간 리포트 2026-10-19 SENT, job scheduler는 지운 상태, 하트비트 키는 남아 있음

## Assessment
**수정 후 병합(Ready with fixes).**
- 테스트(api 391, partners 52, device-sim 40), typecheck, 기록 정합성(번호 연속·참조 무결성·devlog 시각)은 모두 통과했다. F9·F4·F11의 동시성·시간대·멱등 처리도 Day 1~4 교훈을 잘 반영했다
- 다만 Important 2건이 병합 뒤 실제 운영 데이터를 잘못 굳힐 수 있다. 1번은 주간 리포트가 영구히 누락되고, 2번은 리포트 접속 수치가 틀린다. 둘 다 작은 수정(가드 한 줄 + 테스트, 쿼리 조건 한 줄 + 테스트)이므로 고치고 재확인한 뒤 병합하길 권한다
- Minor는 Day 6 이월로 충분하다. 단 Minor 7(devlog 제목 시각)은 기록 규칙이라 병합 전에 함께 고치는 것이 좋다
