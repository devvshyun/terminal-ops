# 7일 회고 (2026-10-22 ~ 2026-10-27)

가상의 결제단말기 운영사 "단말온"의 운영 시스템을 7일(Day 0 설치 제외 Day 1~7) 동안 설계 → 계획 → 서브에이전트 구현 → 리뷰로 만들었다. 이 문서는 무엇을 만들었고, 무엇이 잘 됐고, 무엇을 반복해서 틀렸고, 무엇이 남았는지를 기록 파일 링크와 함께 적는다. 추측은 추측이라고 적었다.

## 1. 날별로 만든 것

| 날 | 커밋 범위(설계안 8장) | 만든 것 | 테스트(그날 "N일차 요약" 시점) | 기록(누적 결정/트러블/실험, 그날 요약 시점) |
|---|---|---|---|---|
| 1 (10-22) | df483c7..4f55c7e | 골격, F1 등록·조회, F2 전이·이력(낙관적 락), F13 검수 | api 8/56 | 6 / 4 / 2 |
| 2 (10-22) | f055cd0..9b68167 | partners(번개·느림보·톡톡), F12 어댑터, F3 수집(BullMQ), F5 Outbox | api 16/114, partners 4/32 | 16 / 7 / 5 |
| 3 (10-23) | f5c7490..c000a4b | F6 박스 스캔, F10 발주·입고 대조, F7 A/S·교체 출고, F1 엑셀 | api 29/200, partners 5/40 | 25 / 15 / 7 |
| 4 (10-23) | aedaec0..4a24e02 | device-sim, F8 하트비트(Redis)·펌웨어 단계 배포 | api 40/264, device-sim 4/40 | 31 / 20 / 10 (병합 시 트러블 21)* |
| 5 (10-26) | 0b525c5..d36a1c4 | F9 VAN 대조, F4 이상 단말기, F11 주간 리포트, cron | api 56/391(최종 리뷰 반영 뒤 58/398), partners 6/52 | 36 / 24 / 12 (병합 시 트러블 25)* |
| 6 (10-27) | fffceff..3b2077d | React 어드민 화면 13개, 화면용 API | api 62/430, admin 10/86(최종 리뷰 반영 뒤 10/93) | 41 / 27 / 13 |
| 7 (10-27) | ac5d372..(이 회고가 든 마감 커밋) | 이월 정리, 대시보드 API + Redis 캐시 + 처음 화면, 실험 0014~0016, README·기록 색인·backlog 정리·회고 | api 65/446, admin 12/108, partners 6/53, device-sim 4/40 | 46 / 28 / 16 |

\* Day 4·5는 요약 뒤 최종 리뷰에서 트러블슈팅 0021·0025가 더해져, 그날 병합 커밋의 트러블슈팅은 각각 21·25다(`git ls-tree`로 센 값). 2장이 "리뷰가 실제 결함을 잡았다"의 예로 0021을 들지만 표의 Day 4 수에는 빠져 있다.

근거: 각 날 devlog의 "N일차 요약" — [2026-10-22.md](devlog/2026-10-22.md)("1일차 요약"·"2일차 요약"), [2026-10-23.md](devlog/2026-10-23.md)("3일차 요약"·"4일차 요약"), [2026-10-26.md](devlog/2026-10-26.md)("5일차 요약"), [2026-10-27.md](devlog/2026-10-27.md)("6일차 요약"·"7일차 요약"). 기록 전체 목록은 [index.md](index.md).

## 2. 잘 된 것

- **숫자로 결정을 바꿨다.** 결정마다 실험이 붙었다: 하트비트를 Redis에 두는 이유([실험 0008](experiments/0008-하트비트-5000대.md): MySQL 쓰기가 하트비트 수가 아니라 스냅샷 횟수에 비례), 목록 select-in([0013](experiments/0013-단말기-목록-API-10만-대.md): 17.5배), 리포트 이력 인덱스를 더하지 않음([0011](experiments/0011-실행계획-단말기-10만-이력-100만.md): INSERT +99%), `(status, id)` 인덱스를 더하지 않음([0016](experiments/0016-상태-조건-목록-status-id-인덱스.md)). "넣을까?"를 재고 나서 넣지 않은 결정이 여럿이다.
- **데드락을 근거로 잡았다.** 1213을 만날 때마다 `SHOW ENGINE INNODB STATUS`·data_locks로 원인을 확인하고 순서를 고쳤다([troubleshooting/0004](troubleshooting/0004-동시-전이-데드락-500.md)·[0007](troubleshooting/0007-outbox-relay-gap-락이-전이를-막음.md)·[0011](troubleshooting/0011-일괄-등록-정렬을-빼면-반대-순서-요청끼리-데드락.md)·[0014](troubleshooting/0014-출고-이전-운송장-UPDATE의-gap-락으로-다른-단말기끼리-데드락.md)). 같은 규칙("부모 UPDATE 먼저, 여러 행은 정렬해서")을 다음 기능에 미리 적용했고, Day 7에는 남은 데드락을 500 대신 409로 돌려준다([decisions/0043](decisions/0043-데드락-1213은-409-DEADLOCK.md)).
- **멱등을 층으로 쌓았다.** 택배 이벤트 3단([실험 0003](experiments/0003-번개택배-중복-이벤트.md)), 박스 스캔 scanId([decisions/0020](decisions/0020-박스-스캔-멱등은-Redis-잠금과-ScanBatch.md)), Outbox 멱등키 + 복구 sweep([0016](decisions/0016-Outbox-최소-한-번과-멱등키.md)·[0042](decisions/0042-QUEUED-outbox-복구는-같은-jobId로-다시-넣기.md)), 주간 리포트 주 단위([0035](decisions/0035-주간-리포트와-cron-주기-작업.md)) — 실험 [0005](experiments/0005-워커-프로세스-2개.md)·[0014](experiments/0014-워커-강제-종료와-알림.md)로 "중복 0"과 "중복은 처리 중이던 것만"을 숫자로 확인했다.
- **서브에이전트 구현 + 리뷰 루프.** 구현은 Task 단위 서브에이전트, 매 Task 뒤 읽기 전용 리뷰, 하루 끝에 최종 리뷰([docs/reviews/](reviews/))를 두었다. 리뷰가 실제 결함을 여러 번 잡았다: 이미 목표 버전인 대상이 시간 초과로 세지는 거짓 자동 중단([troubleshooting/0021](troubleshooting/0021-이미-목표-버전인-대상이-시간-초과로-세져-같은-버전-재배포가-자동-중단됨.md), Day 4 최종 리뷰), VAN "대조 실행" 버튼이 영구히 꺼지는 문제(Day 6 Important 1), Day 7에는 실험 0015 ④의 해석 오류(아래 4장). 날마다 테스트가 계획 예상보다 많았던 것도 리뷰 반영 fix가 오류 경로·회귀 테스트를 더해서다(예: Day 6 admin 계획 34 → 요약 86 → 리뷰 반영 뒤 93, devlog 6일차 요약).
- **실험은 원본 출력을 붙였다.** 모든 실험 기록에 재현 명령·설정·로그 원문을 두고, 결론은 그 숫자에서만 끌어냈다. 그래서 리뷰가 원문과 결론을 대조해 틀린 해석을 찾을 수 있었다(0015 ④는 원문 숫자로 다시 계산해서 잡혔다). 원문이 없었다면 틀린 결론이 그대로 남았을 것이다.
- **안전 규칙이 지켜졌다(Day 3부터).** PID로만 끄기, FLUSH 금지, 테스트 DB만 — [Day 3 계획](plans/2026-10-23-day3-ops-workflows.md)부터 모든 계획 맨 위에 있고, 실험 0014의 강제 종료도 자기가 띄운 자식에만 보냈다([troubleshooting/0028](troubleshooting/0028-Windows에서-process-kill-SIGKILL로-끈-자식의-exit가-code-1-signal-null.md)). 실서버 확인은 끝날 때마다 netstat·tasklist로 남은 프로세스가 없는지 봤다.
- **기록이 찾을 수 있는 모양으로 남았다(Day 7).** 결정 46·트러블슈팅 28·실험 16을 스크립트가 색인으로 모으고 `--check`로 어긋남을 잡는다([decisions/0046](decisions/0046-기록-색인은-스크립트로-만든다.md)). README 실험 결과 표가 16개 실험의 결론을 한 화면에 모은다.

## 3. 안 된 것

- **계획 문서가 너무 크다.** 계획마다 수천 줄(Day 4 계획 7,970줄, `wc -l docs/plans/*.md` 합계 40,787줄)이고 사전 검증 결과를 그대로 옮긴다. 정확하지만 읽는 사람(구현 서브에이전트)이 필요한 곳을 찾기 어렵다 — 그래서 Task별 파일로 나눠 넘겼다.
- **화면 확인이 자동이 아니다.** 브라우저 테스트가 없어 화면 확인은 컨트롤러가 내장 브라우저로 했다(Day 6 최종 리뷰 Minor 9 — 결과 기록이 늦었다). Day 7 대시보드 화면도 같은 방식이다.
- **알려진 한계를 오래 들고 갔다.** QUEUED outbox 복구(Day 2에 적고 Day 7에 닫음), 1213 매핑(Day 1에 적고 Day 7에 닫음). 이월 목록이 날마다 길어졌다(6일차 요약 "남은 문제"). 테스트 로그의 `MaxListenersExceededWarning`은 Day 1 최종 리뷰 Minor 4부터 마지막 날까지 원인을 확정하지 않은 채 남았다(Day 7에 과거 로그로 Day 1부터 있던 것만 확인, devlog 2026-10-27 "Task 7 리뷰 반영").
- **운영 배포·인증이 없다.** `X-Operator`는 인증이 아니다([decisions/0001](decisions/0001-인증은-작업자-헤더로.md)). 화면은 Vite 개발 서버 프록시로만 돈다([decisions/0041](decisions/0041-어드민-골격-Vite-프록시-작업자-헤더-도구.md)).
- **실험이 대부분 한 번, 한 PC다.** 0016은 1회, 0014·0015는 2회. 숫자는 이 PC(Windows + Docker Desktop)의 값이고 운영 환경 숫자가 아니다 — 각 실험의 "한계" 절에 적었지만 반복 횟수 자체가 적다.

## 4. 반복된 실수

| 실수 | 몇 번 | 근거 | 지금의 대책 |
|---|---|---|---|
| Bash heredoc 안 파이썬·JSON 편집이 따옴표·백틱에서 깨짐 | Day 5에 기록, Day 7 계획 사전 검증에서 또 한 번(`unexpected EOF while looking for matching`) | [troubleshooting/0024](troubleshooting/0024-Bash-heredoc-안-파이썬-편집이-따옴표-오류로-돌지-않음.md), [Day 7 계획](plans/2026-10-27-day7-wrapup.md) "프로세스·데이터 안전 규칙" | 긴 글·코드는 Write·Edit 도구로 |
| 실제 지금 시각과 고정 시각을 섞은 테스트가 날짜가 지나 실패 | Day 6에 발견(master에서 이미 실패하고 있었다) | [troubleshooting/0026](troubleshooting/0026-실제-시각과-고정-시각이-섞인-테스트가-날짜가-지나-실패.md), [0027](troubleshooting/0027-SENT면-큐를-보지-않자-끝난-job-기다리기가-먼저-끝남.md) | "지금"에서 계산하거나 기준 시각을 인자로(Day 7 테스트 전부 — `requeueStale({ now })`, `ageText(iso, now)`) |
| 계획·기록에 적은 숫자가 실제와 다름 | 날마다 테스트 수(계획 예상 < 실제), Day 6 결정 참조 번호 착오(0037 → 0041), Day 7 devlog "페이지 14곳"(실제 13곳), Day 7 계획 api 440·admin 105(리뷰 반영 뒤 446·108), 실험 0016 시작 시각 1초 착오 | devlog 각 요약 "계획 예상보다 많은 것은…", Day 6 최종 리뷰 Minor 2, devlog 2026-10-27 "Day 7 리뷰 Minor 반영"·"Task 7 리뷰 반영" | 계획의 수는 사전 검증에서 실제로 돌려 센 값만 적고, 기록의 수는 `git show --stat`·로그 원문에서 옮긴다. 그래도 리뷰 반영으로 바뀌므로 마감 때 다시 센다 |
| 프로세스를 이미지 이름으로 끔(다른 세션·IDE의 node까지 죽음) | 초기에 한 번(Day 3 계획 이전, 대화로만 보고됨(저장소 기록 없음)). **저장소에 이 사고의 기록이 없다** — devlog·트러블슈팅 어디에도 경위가 없고, Day 3 계획 맨 위의 안전 규칙으로만 흔적이 남았다. 사고를 트러블슈팅으로 남기지 않은 것 자체가 기록 규칙 위반이다 | [Day 3 계획](plans/2026-10-23-day3-ops-workflows.md) "프로세스는 PID로만 끈다"(이후 모든 계획 맨 위) | PID로만, 끝나면 netstat·tasklist로 시작 전 PID와 비교 |
| 빈 표·작은 표의 EXPLAIN을 믿음 | Day 5·6 | [Day 6 계획](plans/2026-10-27-day6-admin.md) "빈 표의 EXPLAIN은 믿지 않는다", 5일차 요약 | 행을 넣고 analyze 뒤에 본다, 큰 계획은 10만 시드로 |
| 실험 코드가 비교하려는 것과 다른 것을 잼 | Day 2(0005 직렬 의심), Day 3(0006 두 변수 동시), Day 7 사전 검증(0015 single-flight 섞임, 0016 no-op UPDATE) | [experiments/0005](experiments/0005-워커-프로세스-2개.md) "추가", [0006](experiments/0006-대량-처리.md) "보강", [Day 7 계획](plans/2026-10-27-day7-wrapup.md) "사전 검증으로 확인된 사실" | 변형마다 무엇이 다른지 한 줄로 적고, 결과가 너무 좋거나 나쁘면 의심한다 |
| 실험 결과를 잘못 해석함 — 숫자는 맞는데 결론이 틀림 | Day 7 실험 0015 ④: 요청별 시간이 묶음마다 다른 시작점에서 잰 값인데 같은 기준으로 비교해 "일반 집계가 더 늦게 끝났지만 캐시를 덮지 않았다(방어 규칙이 일했다)"고 썼다. 리뷰가 ④ 시작 기준으로 다시 계산해 두 회차 모두 일반이 먼저 끝났음(방어 규칙은 이 실험에서 발동하지 않음)을 찾았다 | [experiments/0015](experiments/0015-대시보드-캐시-전후.md) 결론(정정), [decisions/0044](decisions/0044-대시보드-집계와-Redis-캐시.md), devlog 2026-10-27 "Day 7 리뷰 Minor 반영"(e8fdf60) | 시간을 비교할 때는 기준 시점을 먼저 적는다. 실험이 확인한 것과 테스트가 확인한 것을 나눠 쓴다(방어 규칙은 e2e 테스트로만 검증됨) |
| 측정하지 않은 것을 측정한 것처럼 씀 | Day 7: 0014의 "61초 대부분이 lockDuration + stalledInterval", 0045의 "경계 근처도 1~2ms 안쪽" | devlog 2026-10-27 "Day 7 리뷰 Minor 반영"·"Task 7 리뷰 반영" | 추정에는 "(추정, 무엇에서 유추)"를 붙인다 |

## 5. 면접에서 말할 거리 (질문 → 근거)

| 질문 | 답의 요지 | 근거 |
|---|---|---|
| 동시 수정을 어떻게 막았나 | version 낙관적 락 + expectedVersion을 규칙보다 먼저, 데드락은 flush 순서로, 남은 데드락은 409 | [decisions/0004](decisions/0004-동시-수정은-낙관적-락과-expectedVersion.md)·[0043](decisions/0043-데드락-1213은-409-DEADLOCK.md), [experiments/0001](experiments/0001-같은-단말기-동시-전이.md)·[0002](experiments/0002-같은-단말기-동시-검수.md), [troubleshooting/0004](troubleshooting/0004-동시-전이-데드락-500.md) |
| 외부 API가 같은 이벤트를 두 번 보내면 | 응답 안 → 저장된 키 → unique 3단, 숫자로 0 | [experiments/0003](experiments/0003-번개택배-중복-이벤트.md), [decisions/0014](decisions/0014-배송-완료-반영-규칙과-재시도.md) |
| 알림을 잃지 않으려면 | Outbox(같은 트랜잭션) + relay SKIP LOCKED·READ COMMITTED + 멱등키 + QUEUED 복구 sweep. 워커 강제 종료 실험에서 유실 0, 중복은 죽을 때 처리 중이던 5건만 | [decisions/0016](decisions/0016-Outbox-최소-한-번과-멱등키.md)·[0042](decisions/0042-QUEUED-outbox-복구는-같은-jobId로-다시-넣기.md), [troubleshooting/0007](troubleshooting/0007-outbox-relay-gap-락이-전이를-막음.md), [experiments/0005](experiments/0005-워커-프로세스-2개.md)·[0014](experiments/0014-워커-강제-종료와-알림.md) |
| Redis를 왜 썼나(아무 데나 쓰지 않았다는 근거) | 하트비트(쓰기 많고 최신값만), 스캔·교체 예약 잠금, 큐, 대시보드 캐시 — 각각 결정 기록과 숫자 | [decisions/0013](decisions/0013-BullMQ-큐-구성과-Redis를-쓰는-이유.md)·[0020](decisions/0020-박스-스캔-멱등은-Redis-잠금과-ScanBatch.md)·[0026](decisions/0026-공용-Redis-연결과-교체-단말기-예약.md)·[0027](decisions/0027-하트비트는-상태-전이가-아니다-Redis에만-쓴다.md)·[0044](decisions/0044-대시보드-집계와-Redis-캐시.md), [experiments/0008](experiments/0008-하트비트-5000대.md)·[0015](experiments/0015-대시보드-캐시-전후.md) |
| 인덱스를 어떻게 정했나 | 10만·100만 시드에서 실행계획과 쓰기 비용을 함께 재고, 채택 기준을 실험 전에 정했다. 넣지 않은 것도 있다 | [experiments/0011](experiments/0011-실행계획-단말기-10만-이력-100만.md)·[0013](experiments/0013-단말기-목록-API-10만-대.md)·[0016](experiments/0016-상태-조건-목록-status-id-인덱스.md), [decisions/0034](decisions/0034-이상-단말기는-status_changed_at과-열린-이상-테이블로.md)·[0036](decisions/0036-주간-리포트-이력-기간-집계에-인덱스를-더하지-않는다.md)·[0045](decisions/0045-상태-조건-목록에-status-id-인덱스를-더하지-않는다.md) |
| 대량 처리 성능 | N+1 대 일괄의 차이 대부분이 행마다 flush였다는 분해 | [experiments/0006](experiments/0006-대량-처리.md), [decisions/0019](decisions/0019-일괄-처리는-행별-결과와-한-트랜잭션.md) |
| 큐 작업의 재시도·순서 | 429는 Retry-After, 영구 오류는 UnrecoverableError, relay는 되돌릴 수 없는 부작용을 마지막에 | [decisions/0014](decisions/0014-배송-완료-반영-규칙과-재시도.md), [troubleshooting/0018](troubleshooting/0018-device-큐-addBulk-실패-시-project-job-유실.md), [experiments/0004](experiments/0004-번개택배-429-비율별-수집.md) |
| 화면이 서버 규칙을 어떻게 아나 | 서버가 전이 표에서 가능한 전이·작업을 계산해 준다 | [decisions/0040](decisions/0040-화면이-할-수-있는-일은-서버가-전이-표에서-계산한다.md) |
| 캐시 무효화 | TTL만 + 집계 시각 표시 + single-flight. 빈 캐시에 동시 50개가 SELECT 350 → 7, 적중 p50 169ms → 0.4ms | [decisions/0044](decisions/0044-대시보드-집계와-Redis-캐시.md), [experiments/0015](experiments/0015-대시보드-캐시-전후.md) |
| 틀린 적은? | 실험 0015 ④를 잘못 해석했고 리뷰가 원문 숫자로 잡았다. 원문을 남겨 둔 덕이다 | 4장, [experiments/0015](experiments/0015-대시보드-캐시-전후.md) |

## 6. 다음에 할 것 (남은 이월)

devlog 2026-10-27 "최종 리뷰 반영 정리"의 "Day 7로 넘긴 것"과 [Day 7 스펙](specs/2026-10-27-day7-wrapup.md) 8장에서, Day 7에 닫은 것(쿼리 키 팩토리·무효화, 배포 목록 N+1, 단말기 목록 상한, QUEUED outbox 복구, 1213 매핑, 대시보드 캐시 실험, `(status, id)` 인덱스, README 결과 표, 실험 0013 표현)을 뺀 것.

- 화면 운영 배포(정적 파일 + 역프록시), 로그인·권한, 브라우저 자동 테스트
- 단말기·엑셀·펌웨어 등록과 배포 생성 화면, 이상 찾기 실행 기록 표
- 검수 기록 목록 페이지 조건, 주간 리포트 목록 filesort(52행/년이라 둠)
- 주간 리포트: at-least-once·고아 파일·프로세스가 죽은 뒤 잠금 약 10.6분·4주 밖 미전송 주
- VAN: 시리얼 ASCII·유일 가정, 개발 환경 전송 대기([troubleshooting/0023](troubleshooting/0023-16KB가-넘는-SQL-문장은-왕복이-약-43ms-늘어난다.md)), `failStale`의 큐 대기 행(Day 5 Minor 2·Day 6 Minor 7)
- 이상: 열린 이상이 수십만일 때 정렬 인덱스, `status_changed_at` 백필이 이력과 어긋날 수 있음
- 데이터가 든 DB의 마이그레이션 down 한 바퀴
- Day 4 남은 것: 같은 버전 재배포 때 단계 지연, 하트비트 버전을 그대로 믿음
- Day 7에서 새로 생긴 것: 락 대기 타임아웃(1205) 응답([decisions/0043](decisions/0043-데드락-1213은-409-DEADLOCK.md)), 대시보드 다중 프로세스 잠금([0044](decisions/0044-대시보드-집계와-Redis-캐시.md) 다시 볼 조건), QUEUED 복구의 limit 100 커서([0042](decisions/0042-QUEUED-outbox-복구는-같은-jobId로-다시-넣기.md)), `(status, id)` 옵티마이저 경계·`force index` 계획 미측정([실험 0016](experiments/0016-상태-조건-목록-status-id-인덱스.md) 한계), stalled 복구 약 61초의 분해 미측정([실험 0014](experiments/0014-워커-강제-종료와-알림.md))
- 테스트 로그 `MaxListenersExceededWarning`(Day 1 최종 리뷰 Minor 4) 원인 확정(`--trace-warnings`)
- Day 7 최종 리뷰가 남긴 것([리뷰](reviews/2026-10-27-day7-final-review.md) Minor 3·8b)
  - 주기 작업 경로(scheduler → processor → `requeueStale()`)를 지나는 테스트가 없다. e2e·실험 0014는 `requeueStale({ staleMs: 0, … })`을 직접 부르고 `scheduler.e2e`는 등록 개수만 센다. job 이름 `requeue`가 processor 분기에 닿는지, 기본값(60초·limit 100)으로 도는지는 검증되지 않았다
  - `scripts/docs-index.mjs`가 번호 중복(같은 0042 두 파일)과 빈 번호를 잡지 않는다. `--check`가 "최신"이어도 번호 충돌은 지나간다
  - (반영함) 첫 조회 중 새로고침 실패, `.env.example` 세 개, README 빌드 전제, 표 기준 표시는 리뷰 반영 커밋에서 고쳤다
