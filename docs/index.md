# 기록 색인

> 이 파일은 `node scripts/docs-index.mjs`가 만든다. 손으로 고치지 않는다(decisions/0046). 기록을 더한 뒤 다시 만들고, `--check`로 확인한다.

## 결정 기록 (59)

- [0001](decisions/0001-인증은-작업자-헤더로.md) 인증은 하지 않고, 작업자는 요청 헤더로 기록한다
- [0002](decisions/0002-esm-vitest-tsc-빌드.md) ESM + Vitest + tsc 빌드로 API를 만든다
- [0003](decisions/0003-전이-규칙은-TS-표로.md) 전이 규칙을 TS 표 + 순수 함수로 둔다
- [0004](decisions/0004-동시-수정은-낙관적-락과-expectedVersion.md) 동시 수정은 낙관적 락과 expectedVersion으로 막는다
- [0005](decisions/0005-엑셀-일괄-등록은-Day3로.md) 엑셀 일괄 등록은 Day 3으로 미룬다
- [0006](decisions/0006-검수는-상태-전이를-먼저-한다.md) 검수는 상태 전이를 먼저 하고 검수 기록은 그 뒤에 만든다
- [0007](decisions/0007-전이-출처-BATCH와-기본-허용-출처.md) 전이 출처 BATCH 추가, 기본 허용 출처는 MANUAL만
- [0008](decisions/0008-등록-이력도-전이-서비스가-남긴다.md) 등록 이력도 전이 서비스가 남긴다
- [0009](decisions/0009-가상-업체-서버는-node-http-별도-프로세스.md) 가상 업체 서버는 node:http 별도 프로세스로 만든다
- [0010](decisions/0010-택배사-어댑터와-오류-분류.md) 택배사는 어댑터로 감싸고 실패는 세 가지로 나눈다
- [0011](decisions/0011-배정은-mutate로-한-UPDATE에.md) 배정은 mutate로 한 UPDATE에 담는다
- [0012](decisions/0012-운송장-발급은-트랜잭션-밖에서.md) 운송장 발급은 트랜잭션 밖에서
- [0013](decisions/0013-BullMQ-큐-구성과-Redis를-쓰는-이유.md) BullMQ 큐 구성과 Redis를 쓰는 이유
- [0014](decisions/0014-배송-완료-반영-규칙과-재시도.md) 배송 완료 반영 규칙과 재시도
- [0015](decisions/0015-실행-모드-워커와-스케줄러.md) 실행 모드: 워커와 스케줄러
- [0016](decisions/0016-Outbox-최소-한-번과-멱등키.md) 알림은 Outbox로, 보장 수준은 최소 한 번 + 멱등키
- [0017](decisions/0017-전이-출처-확장과-배정-출고-전용-출처.md) 전이 출처를 늘리고 배정·출고는 전용 출처로만 한다
- [0018](decisions/0018-재출고-시-이전-운송장-SUPERSEDED.md) 재출고하면 이전 운송장을 SUPERSEDED로 바꾼다
- [0019](decisions/0019-일괄-처리는-행별-결과와-한-트랜잭션.md) 일괄 처리는 행별 결과와 한 트랜잭션
- [0020](decisions/0020-박스-스캔-멱등은-Redis-잠금과-ScanBatch.md) 박스 스캔 멱등은 Redis 잠금과 ScanBatch
- [0021](decisions/0021-입고는-명세-밖-시리얼을-거절한다.md) 입고는 명세 밖 시리얼을 거절한다
- [0022](decisions/0022-엑셀-일괄-등록은-exceljs와-메모리-업로드.md) 엑셀 일괄 등록은 exceljs와 메모리 업로드
- [0023](decisions/0023-교체-출고는-한-트랜잭션과-정해진-잠금-순서.md) 교체 출고는 한 트랜잭션과 정해진 잠금 순서(단말기 id 오름차순 → 접수)
- [0024](decisions/0024-outbox-relay는-addBulk로.md) outbox relay는 잡은 행을 addBulk 한 번으로 큐에 넣는다
- [0025](decisions/0025-DB-연결-collation을-테이블과-맞춘다.md) DB 연결 collation을 테이블과 맞춘다(utf8mb4_0900_ai_ci)
- [0026](decisions/0026-공용-Redis-연결과-교체-단말기-예약.md) 앱 공용 Redis 연결 하나와 교체 단말기 예약(Redis)
- [0027](decisions/0027-하트비트는-상태-전이가-아니다-Redis에만-쓴다.md) 하트비트는 상태 전이가 아니다, Redis에만 쓴다
- [0028](decisions/0028-운영-중-단말기-목록은-Outbox-소비자와-주기-재구성으로.md) 운영 중 단말기 목록은 Outbox 소비자와 주기 재구성으로
- [0029](decisions/0029-오프라인-판정과-스냅샷은-바뀐-것만-MySQL에.md) 오프라인 판정과 스냅샷은 바뀐 것만 MySQL에
- [0030](decisions/0030-펌웨어-단계-배포는-별도-테이블과-Redis-제안으로.md) 펌웨어 단계 배포는 별도 테이블과 Redis 제안으로
- [0031](decisions/0031-배포-판단은-배포-행-먼저-보고는-대상-행만.md) 배포 판단은 배포 행 먼저, 보고는 대상 행만
- [0032](decisions/0032-숫자-env-검증과-FK-중복-인덱스-정리.md) 숫자 env 검증과 FK 중복 인덱스 정리
- [0033](decisions/0033-VAN-등록-대조는-커서-수집-스테이징-SQL-비교-재검증.md) VAN 등록 대조는 커서 수집 → 스테이징 → SQL 비교 → 재검증으로 한다
- [0034](decisions/0034-이상-단말기는-status_changed_at과-열린-이상-테이블로.md) 이상 단말기는 status_changed_at 컬럼과 열린 이상 테이블로 찾는다
- [0035](decisions/0035-주간-리포트와-cron-주기-작업.md) 주간 리포트와 cron 주기 작업
- [0036](decisions/0036-주간-리포트-이력-기간-집계에-인덱스를-더하지-않는다.md) 주간 리포트 이력 기간 집계에 인덱스를 더하지 않는다
- [0037](decisions/0037-알림-리포트-레이블을-상수-파일로.md) 알림·리포트 레이블을 상수 파일로
- [0038](decisions/0038-주간-리포트-보내기는-report-큐-job과-202.md) 주간 리포트 보내기는 report 큐 job과 202
- [0039](decisions/0039-목록-페이지-방식과-연관-읽기.md) 목록 페이지 방식과 연관 읽기
- [0040](decisions/0040-화면이-할-수-있는-일은-서버가-전이-표에서-계산한다.md) 화면이 할 수 있는 일은 서버가 전이 표에서 계산한다
- [0041](decisions/0041-어드민-골격-Vite-프록시-작업자-헤더-도구.md) 어드민 골격 — Vite 프록시, 작업자 헤더, 프런트 도구
- [0042](decisions/0042-QUEUED-outbox-복구는-같은-jobId로-다시-넣기.md) QUEUED outbox 복구는 같은 jobId로 job을 다시 넣는다
- [0043](decisions/0043-데드락-1213은-409-DEADLOCK.md) 데드락(MySQL 1213)은 409 DEADLOCK으로 돌려준다
- [0044](decisions/0044-대시보드-집계와-Redis-캐시.md) 대시보드 집계는 Redis에 30초 캐시한다 — TTL만, 프로세스 안 single-flight
- [0045](decisions/0045-상태-조건-목록에-status-id-인덱스를-더하지-않는다.md) 상태 조건 단말기 목록에 (status, id) 인덱스를 더하지 않는다
- [0046](decisions/0046-기록-색인은-스크립트로-만든다.md) 기록 색인(docs/index.md)은 스크립트로 만들고 --check로 확인한다
- [0047](decisions/0047-공유-타입은-file-의존-타입-전용-TS-소스-패키지로.md) 공유 타입은 각 앱의 file: 의존으로 연결하는 타입 전용 TS 소스 패키지로 둔다
- [0048](decisions/0048-계약은-반환-타입-implements-enum-단언으로-강제한다.md) 계약은 반환 타입·implements·enum 단언·오류 코드 오버로드로 컴파일 때 강제한다
- [0049](decisions/0049-계약-범위는-응답-요청-본문-오류-코드까지.md) 계약 범위는 응답·쓰기 요청 본문·오류 코드까지, 쿼리 문자열과 런타임 검증은 넣지 않는다
- [0050](decisions/0050-로그인은-Redis-서버-세션과-httpOnly-쿠키로.md) 로그인은 Redis 서버 세션과 httpOnly 쿠키로 한다
- [0051](decisions/0051-비밀번호-해시는-node-scrypt-계정-테이블은-user-account.md) 비밀번호 해시는 node:crypto scrypt, 계정 테이블은 user_account
- [0052](decisions/0052-역할별-엔드포인트-표와-기본-거부.md) 역할별 엔드포인트 표와 기본 거부
- [0053](decisions/0053-가맹점주-범위는-me-전용-엔드포인트와-서비스-scope.md) 가맹점주 범위는 /me 전용 엔드포인트와 서비스 scope 인자로 강제한다
- [0054](decisions/0054-외부-업체-키는-해시-저장과-scope.md) 외부 업체 API 키는 해시로 저장하고 scope로 연다
- [0055](decisions/0055-단말기는-공유-단말기-키로.md) 단말기는 공유 단말기 키(X-Device-Key)로 부른다
- [0056](decisions/0056-작업자는-로그인-아이디-X-Operator는-테스트-전용.md) 작업자는 로그인 아이디, X-Operator는 테스트 전용 인증 길로만 남긴다
- [0057](decisions/0057-점주-화면은-별도-앱-apps-merchant.md) 점주 화면은 어드민 안이 아니라 별도 앱 apps/merchant로 만든다
- [0058](decisions/0058-화면-공통-코드는-공유-패키지가-아니라-복사로.md) 어드민·점주 화면의 공통 코드는 공유 패키지로 빼지 않고 복사한다
- [0059](decisions/0059-점주-화면용-me-보강은-점주용-모양과-보이는-상태로.md) 점주 화면용 /me 보강은 점주용 응답 모양과 "점주에게 보이는 상태"로 한다

## 트러블슈팅 (32)

- [0001](troubleshooting/0001-설치-직후-WSL2-미동작.md) 설치 직후 WSL2·Docker가 동작하지 않음
- [0002](troubleshooting/0002-em-create-optionalprops-타입오류.md) em.create에서 TS2345 "Property 'version' is missing"
- [0003](troubleshooting/0003-test-app-orm-readonly-타입오류.md) test-app.ts에서 MikroORM 타입이 readonly 배열이라 TS2322
- [0004](troubleshooting/0004-동시-전이-데드락-500.md) 같은 단말기 동시 전이에서 데드락이 나고 500으로 응답
- [0005](troubleshooting/0005-enum-마이그레이션-down-소문자.md) enum 마이그레이션의 down()이 소문자로 생성됨
- [0006](troubleshooting/0006-globalSetup-오류-메시지가-charCodeAt-오류로-가려짐.md) globalSetup에서 던진 오류 메시지가 `code.charCodeAt is not a function`으로 가려짐
- [0007](troubleshooting/0007-outbox-relay-gap-락이-전이를-막음.md) outbox relay 트랜잭션이 열려 있는 동안 전이·등록이 멈춤(gap 락)
- [0008](troubleshooting/0008-JSON_TABLE-collation-충돌.md) JSON_TABLE 열과 테이블 열의 collation 충돌(ERROR 1267)
- [0009](troubleshooting/0009-테스트-DB에-계획-검증-테이블이-남아-resetDatabase-실패.md) 테스트 DB에 계획 사전 검증 테이블이 남아 resetDatabase 실패
- [0010](troubleshooting/0010-배송-완료-반영이-SUPERSEDED를-덮어씀.md) 배송 완료 반영이 재출고로 바뀐 SUPERSEDED를 DELIVERED로 덮어씀(lost update)
- [0011](troubleshooting/0011-일괄-등록-정렬을-빼면-반대-순서-요청끼리-데드락.md) 일괄 등록에서 시리얼 정렬을 빼면 반대 순서로 겹친 요청끼리 데드락
- [0012](troubleshooting/0012-공백-붙은-시리얼이-명세-검사를-건너뜀.md) 공백 붙은 시리얼이 납품 명세 검사를 건너뛰고 등록됨
- [0013](troubleshooting/0013-엑셀-cell-text가-서식-수식-결과-0을-틀리게-읽음.md) 엑셀 셀을 cell.text로 읽어 0 채움 서식·수식 결과 0·날짜가 틀리게 들어감
- [0014](troubleshooting/0014-출고-이전-운송장-UPDATE의-gap-락으로-다른-단말기끼리-데드락.md) 출고 때 이전 운송장 UPDATE가 gap 락을 잡아 다른 단말기 출고끼리 데드락
- [0015](troubleshooting/0015-빈-테스트-DB에-up하면-테스트-DB-이름의-스냅샷-파일이-생김.md) 빈 테스트 DB에 마이그레이션 up을 하면 테스트 DB 이름의 스냅샷 파일이 생긴다
- [0016](troubleshooting/0016-원시-SQL-datetime이-9시간-어긋나-모두-시간-초과.md) 원시 SQL로 읽은 datetime이 9시간 어긋나 모든 대상이 바로 시간 초과
- [0017](troubleshooting/0017-device-sim-stop이-주기를-못-끊고-실패-응답-시간이-빠짐.md) device-sim: stop이 주기를 못 끊고, 실패한 요청의 응답 시간이 통계에서 빠진다
- [0018](troubleshooting/0018-device-큐-addBulk-실패-시-project-job-유실.md) relay에서 device 큐 addBulk가 실패하면 project job이 영영 안 들어간다
- [0019](troubleshooting/0019-배포-판단이-스냅숏-뒤-보고를-놓치고-제안을-되살림.md) 배포 판단이 스냅숏 뒤에 커밋된 보고를 놓치고, 보고한 단말기의 제안을 되살린다
- [0020](troubleshooting/0020-업데이트-중-설정을-바꾸면-단말기가-updating인-채로-남음.md) device-sim에서 업데이트 중에 설정을 바꾸면 단말기가 updating인 채로 남는다
- [0021](troubleshooting/0021-이미-목표-버전인-대상이-시간-초과로-세져-같은-버전-재배포가-자동-중단됨.md) 이미 목표 버전인 대상이 시간 초과로 세져 같은 버전 재배포가 자동 중단됨
- [0022](troubleshooting/0022-insertMany는-엔티티-기본값을-쓰지-않아-새-NOT-NULL-열에서-실패.md) insertMany는 엔티티 기본값을 쓰지 않아 새 NOT NULL 열에서 실패
- [0023](troubleshooting/0023-16KB가-넘는-SQL-문장은-왕복이-약-43ms-늘어난다.md) 16KB가 넘는 SQL 문장은 왕복이 약 43ms 늘어난다(호스트 → Docker MySQL)
- [0024](troubleshooting/0024-Bash-heredoc-안-파이썬-편집이-따옴표-오류로-돌지-않음.md) Bash heredoc 안의 파이썬 편집 스크립트가 따옴표 오류로 돌지 않음(도구 사용 문제)
- [0025](troubleshooting/0025-enum을-좁히는-down이-테스트-DB-데이터에-막혀-반쪽만-되돌려짐.md) enum을 좁히는 down이 테스트 DB 데이터에 막혀 반쪽만 되돌려짐
- [0026](troubleshooting/0026-실제-시각과-고정-시각이-섞인-테스트가-날짜가-지나-실패.md) 실제 시각과 고정 시각이 섞인 테스트가 날짜가 지나 실패
- [0027](troubleshooting/0027-SENT면-큐를-보지-않자-끝난-job-기다리기가-먼저-끝남.md) SENT면 큐를 보지 않게 하자 "job 끝" 기다리기가 job보다 먼저 끝남
- [0028](troubleshooting/0028-Windows에서-process-kill-SIGKILL로-끈-자식의-exit가-code-1-signal-null.md) Windows에서 process.kill(pid, 'SIGKILL')로 끈 자식의 exit가 code 1·signal null
- [0029](troubleshooting/0029-swc는-계약의-타입-별칭을-design-type에-Object로-내보낸다.md) swc(vitest)는 타입 별칭(유니온)을 design:type에 Object로 내보낸다 (tsc 빌드는 String)
- [0030](troubleshooting/0030-다른-브랜치가-쓴-테스트-DB에서-schema-refresh가-merchant를-못-지운다.md) 다른 브랜치가 쓴 테스트 DB에서 schema.refresh가 merchant를 못 지운다
- [0031](troubleshooting/0031-초-단위-datetime-열은-밀리초를-반올림해-응답과-다시-읽은-값이-다르다.md) 초 단위 datetime 열은 밀리초를 반올림해 응답과 다시 읽은 값이 다르다
- [0032](troubleshooting/0032-테스트-DB로-마이그레이션을-적용하면-DB-이름의-스냅샷-파일이-생긴다.md) 테스트 DB로 마이그레이션을 적용하면 DB 이름의 스냅샷 파일이 생긴다

## 실험 (17)

- [0001](experiments/0001-같은-단말기-동시-전이.md) 같은 단말기 동시 전이
- [0002](experiments/0002-같은-단말기-동시-검수.md) 같은 단말기 동시 검수
- [0003](experiments/0003-번개택배-중복-이벤트.md) 번개택배 중복 이벤트
- [0004](experiments/0004-번개택배-429-비율별-수집.md) 번개택배 429 비율별 수집
- [0005](experiments/0005-워커-프로세스-2개.md) 워커 프로세스 2개
- [0006](experiments/0006-대량-처리.md) 대량 처리 — N+1 대 일괄, 박스 500대, 엑셀 1,000행·5,000행, outbox relay addBulk
- [0007](experiments/0007-교체-단말기-동시-요청.md) 교체 출고 동시 요청 — 같은 교체 단말기, 잠금 순서, 서로 다른 교체 단말기
- [0008](experiments/0008-하트비트-5000대.md) 하트비트 5,000대 — Redis 대 MySQL 직접 쓰기, 묶음 대 단건, 오프라인 판정 시간
- [0009](experiments/0009-펌웨어-단계-배포.md) 펌웨어 단계 배포 — 실패율 0% 완료 시간, 30% 자동 중단까지 시간과 영향 범위
- [0010](experiments/0010-device-큐-job-시간과-project-줄서기.md) device 큐 job(오프라인 판정·스냅샷) 시간 — project job이 뒤에 줄서는 시간
- [0011](experiments/0011-실행계획-단말기-10만-이력-100만.md) 실행계획 — 단말기 10만·이력 약 100만
- [0012](experiments/0012-VAN-대조-5만-건.md) VAN 등록 대조 — 등록 5만, 어긋남 2%, 스캔 도중 변경
- [0013](experiments/0013-단말기-목록-API-10만-대.md) 단말기 목록 API — 단말기 10만 대, joined 대 select-in
- [0014](experiments/0014-워커-강제-종료와-알림.md) 워커 강제 종료와 알림(유실·중복), job 유실과 복구 sweep
- [0015](experiments/0015-대시보드-캐시-전후.md) 대시보드 캐시 전후 — p50/p95, 동시 요청의 MySQL 쿼리 수
- [0016](experiments/0016-상태-조건-목록-status-id-인덱스.md) 상태 조건 단말기 목록의 (status, id) 인덱스 — 계획, 읽은 행, 시간, 쓰기 비용
- [0017](experiments/0017-인증-뒤-하트비트-처리량.md) 인증(전역 가드 + 단말기 키) 뒤 하트비트 처리량
