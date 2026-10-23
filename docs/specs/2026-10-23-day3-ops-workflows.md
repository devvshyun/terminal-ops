# Day 3 설계 — 발주·박스 일괄 입고·엑셀 등록·대조, A/S 교체 출고

- 날짜: 2026-10-23
- 범위: 설계안 8장 Day 3(F6 박스 일괄 스캔, F10 발주·입고 대조, F7 A/S·교체 출고) + Day 1에서 옮긴 엑셀 일괄 등록(decisions/0005) + Day 2 리뷰 이월(`docs/reviews/2026-10-22-day2-final-review.md`) + 실험 2개(0006 대량 처리, 0007 교체 단말기 경합)
- 구현 계획: `docs/plans/2026-10-23-day3-ops-workflows.md`
- 등장하는 회사(세움전자 = 단말기 공장, 번개택배, 느림보물류, 톡톡메신저)와 가맹점은 모두 가상이다.

## 1. 무엇을 왜

Day 2까지는 단말기를 한 대씩 등록하고 한 대씩 바꿨다. 실제 운영은 묶음으로 움직인다. 공장에 500대를 발주하면 박스 10개가 오고, 창고는 박스를 통째로 스캔한다. 가맹점 단말기가 고장 나면 "새 단말기 보내기 + 고장 단말기 회수"가 한 건의 일이다.

1. 공장(세움전자)에 발주하고 납품 명세(보낼 시리얼 목록)를 받는다(F10).
2. 박스 한 개의 시리얼 수백 개를 한 요청으로 입고한다. 행마다 결과를 돌려주고, 같은 박스를 두 번 찍어도 한 번만 반영한다(F6).
3. 엑셀 파일로도 같은 일괄 등록을 한다(F1 이월).
4. 발주 수량·명세·실제 입고를 비교해 빠진 것과 명세 밖의 것을 보여 준다(F10).
5. A/S 접수 → 원격 점검 → 교체 출고(두 단말기 + 운송장 + 접수를 한 트랜잭션) → 설치 확인(F7).

이 과정에서 "대량 flush와 N+1"(설계안 Day 3 학습 주제), "여러 행을 잠글 때의 순서", "외부 호출은 트랜잭션 밖"을 숫자와 테스트로 확인한다.

## 2. 구성

```
apps/partners
  └─ /seum/v1/purchase-orders            세움전자: 발주(JSON), 납품 명세. 골칫거리 shortfall·foreignSerials(시드 난수 자리)

apps/api
  ├─ terminal        + 전이 출처 ALLOCATION·SHIPMENT·SCAN·IMPORT·SERVICE, transitionMany(여러 대 한 번에)
  │                  + 일괄 등록 엔진(BulkRegistrationService), 엑셀 일괄 등록(POST /terminals/imports)
  ├─ merchant        + 배정 취소(POST /terminals/:serialNo/allocation-cancellations)
  ├─ shipment        + SUPERSEDED, recordShipment(이전 배송 중 운송장 정리)
  ├─ purchase-order  (새) PurchaseOrder, 세움 클라이언트, 발주·대조·마감
  ├─ scan            (새) 박스 스캔 POST /scans, ScanBatch, Redis 처리 중 잠금(ScanLock)
  ├─ service         (새) ServiceTicket, 접수·원격 점검·교체 출고·설치 확인
  ├─ outbox          relay를 addBulk로(실험 0006으로 결정)
  └─ scheduler       + scheduler:clear(주기 작업 삭제 스크립트)
```

## 3. 데이터 모델

| 엔티티 | 핵심 컬럼 | 제약·인덱스 | 메모 |
|---|---|---|---|
| `TerminalStatusHistory` (변경) | source enum + ALLOCATION, SHIPMENT, SCAN, IMPORT, SERVICE | | 네이티브 enum ALTER. down()은 대문자로 손수 고침(troubleshooting/0005) |
| `Shipment` (변경) | status enum + SUPERSEDED | | 같은 단말기를 다시 출고하면 이전 IN_TRANSIT 운송장을 SUPERSEDED로 |
| `PurchaseOrder` | po_no, model_id, quantity, status(ORDERED·RECEIVING·CLOSED), delivery_note(json), ordered_by, created_at, closed_at, closed_by | po_no unique | 발주번호는 공장이 정한다. 명세는 입고를 시작할 때 받아 저장 |
| `Terminal` (변경) | + purchase_order_id (nullable) | FK → purchase_order | 박스 스캔으로 입고된 발주. 대조의 "입고 수" |
| `ScanBatch` | scan_id, kind(RECEIVE·RETURN_IN), po_no, request_hash, actor, results(json), created_at | scan_id unique, po_no 인덱스, **FK 없음** | 처리를 마친 박스 스캔 결과. 같은 scanId 재요청에 그대로 돌려준다 |
| `ServiceTicket` | terminal_id, merchant_id, symptom, status(OPEN·RESOLVED_REMOTELY·REPLACING·CLOSED), remote_note, replacement_terminal_id, outbound_shipment_id, opened_by, created_at, closed_at | (terminal_id, status) 인덱스 | |

## 4. 전이 출처 표 (decisions/0007 방식, `only` 없으면 MANUAL만)

| 전이 | 허용 출처 | 누가 |
|---|---|---|
| IN_STOCK → ALLOCATED | ALLOCATION | 배정 API, 교체 출고 |
| ALLOCATED → IN_STOCK | ALLOCATION | 배정 취소 API(가맹점 비우기) |
| ALLOCATED → SHIPPED | SHIPMENT | 출고 API, 교체 출고 |
| SHIPPED → DELIVERED | MANUAL, BATCH | 운영자, 택배 추적 수집 |
| DELIVERED → IN_SERVICE | MANUAL, SERVICE | 운영자, 교체 설치 확인 |
| IN_SERVICE → RETURN_REQUESTED | MANUAL, SERVICE | 운영자, 교체 출고(고장 단말기) |
| RETURNING → RETURNED | MANUAL, SCAN | 운영자, 회수 박스 스캔 |
| 등록(null → RECEIVED) | 규칙 없음, 출처만 기록 | MANUAL(단건), SCAN(박스), IMPORT(엑셀) |

일반 전이 API(`POST /terminals/:serialNo/transitions`, MANUAL)로는 가맹점 없는 배정·운송장 없는 출고를 만들 수 없다(Day 2 스펙 10장 이월).

## 5. 흐름

### 5.1 발주 `POST /purchase-orders { modelCode, quantity }`
모델 확인(없으면 404, 공장 호출 없음) → **트랜잭션 밖** 세움 발주(HTTP, 502 PARTNER_ERROR) → `INSERT purchase_order`. 저장이 실패하면 공장 쪽 발주가 고아로 남는다(decisions/0012와 같은 한계).

### 5.2 일괄 등록 엔진 (박스 RECEIVE, 엑셀 공통)
1. 형식·요청 안 중복을 메모리에서 거른다(INVALID_FORMAT, DUPLICATE_IN_REQUEST).
2. `SELECT terminal_model WHERE code IN (…)` 1번(UNKNOWN_MODEL).
3. `SELECT serial_no FROM terminal WHERE serial_no IN (…)` 1번(ALREADY_EXISTS). 행마다 findOne 하지 않는다.
4. 유효한 행을 **시리얼 순서로** 만든다(단말기 + `recordRegistration` 이력 + Outbox). flush 때 MikroORM이 테이블별 다중 행 INSERT로 묶는다(batchSize 300).
5. 다른 요청이 같은 시리얼을 먼저 넣어 unique 위반이 나면 트랜잭션 전체를 한 번 다시 한다(그때는 3에서 ALREADY_EXISTS).

### 5.3 박스 스캔 `POST /scans { scanId, kind, poNo?, serials[≤500] }`
```
ScanBatch(scanId) 있음? → 같은 요청이면 200 replayed, 내용이 다르면 422 SCAN_ID_REUSED
Redis SET <prefix>:scan-lock:<scanId> <token> NX PX 30000 실패 → 409 SCAN_IN_PROGRESS
  (잠금 뒤 ScanBatch 다시 확인)
  RECEIVE:
    트랜잭션 밖: 발주 조회(404, CLOSED면 422), 명세가 없으면 세움에서 받아 저장
    트랜잭션: SELECT purchase_order … FOR UPDATE   ← 부모 행 X 락을 먼저(troubleshooting/0004)
              CLOSED면 422 PO_CLOSED
              명세에 없는 시리얼 → NOT_IN_DELIVERY_NOTE(등록 안 함)
              나머지 → 일괄 등록 엔진(source SCAN, terminal.purchase_order_id = 발주)
              purchase_order.status = RECEIVING, INSERT scan_batch
  RETURN_IN:
    트랜잭션: SELECT terminal WHERE serial_no IN (…) ORDER BY id
              transitionMany(RETURNING → RETURNED, SCAN): 규칙 통과 행만 바꿔 UPDATE 1번(CASE), 이력·Outbox
              INSERT scan_batch
finally Redis 잠금 해제(내 토큰일 때만, Lua)
```
- 같은 발주의 스캔끼리는 발주 행 잠금에서 줄을 선다. 마감(5.5)도 같은 잠금을 쓴다.
- RETURN_IN에서 그사이 version이 바뀐 행이 있으면 OptimisticLockError → 박스 전체 409, 같은 scanId로 다시 보내면 된다(저장된 결과가 없으므로 새로 처리).
- 잠금 TTL이 지나 같은 scanId가 둘 다 처리되면 `scan_batch.scan_id` unique가 늦게 온 쪽을 롤백시키고, 먼저 끝난 결과를 돌려준다.

### 5.4 엑셀 `POST /terminals/imports` (multipart `file`, .xlsx, 2MB, 데이터 5000행)
multer 메모리 저장소 → exceljs로 첫 시트 읽기(머리글 serialNo·modelCode를 이름으로, 빈 행 건너뜀, `cell.text` 앞뒤 공백 제거) → 엔진(source IMPORT) → 행 번호가 붙은 행별 결과. 파일 오류는 400(INVALID_FILE, MISSING_COLUMNS, TOO_MANY_ROWS), 크기 초과는 413.

### 5.5 대조 `GET /purchase-orders/:poNo/reconciliation`, 마감 `POST /purchase-orders/:poNo/close`
- 대조: 명세가 없으면 받아 온다. 숫자는 DB에서: `count(*) … where purchase_order_id`, missing = `JSON_TABLE(delivery_note)` LEFT JOIN terminal, unexpected = `JSON_TABLE(scan_batch.results)`에서 NOT_IN_DELIVERY_NOTE. JSON_TABLE 열에 `collate utf8mb4_0900_ai_ci`를 적는다(troubleshooting/0008).
- 마감: `SELECT purchase_order … FOR UPDATE` → CLOSED면 422 PO_ALREADY_CLOSED → CLOSED, closed_at, closed_by → 마감 시점의 대조 결과.

### 5.6 A/S
- 접수 `POST /service-tickets { serialNo, symptom }`: 트랜잭션에서 단말기 행 FOR UPDATE → IN_SERVICE·가맹점 있음 확인(422 TERMINAL_NOT_IN_SERVICE) → 열린 접수(OPEN·REPLACING) 있으면 409 TICKET_ALREADY_OPEN → INSERT. 단말기 상태는 그대로.
- 원격 점검 `POST /service-tickets/:id/remote-checks { resolved, note }`: 접수 FOR UPDATE, OPEN만. resolved면 RESOLVED_REMOTELY 종결.
- 교체 출고 `POST /service-tickets/:id/replacements { replacementSerialNo, carrier }`:
  ```
  트랜잭션 밖: 접수 OPEN, 교체 단말기 IN_STOCK·같은 모델 확인(실패면 택배사 호출 없음)
  트랜잭션 밖: 운송장 발급(HTTP)
  트랜잭션:  SELECT service_ticket … FOR UPDATE (OPEN 재확인)
            SELECT terminal WHERE id = min(고장, 교체) FOR UPDATE
            SELECT terminal WHERE id = max(고장, 교체) FOR UPDATE      ← 항상 id 오름차순(decisions/0023)
            교체: IN_STOCK → ALLOCATED(ALLOCATION, merchant = 접수 가맹점) → SHIPPED(SHIPMENT)
            고장: IN_SERVICE → RETURN_REQUESTED(SERVICE)
            이전 IN_TRANSIT 운송장 SUPERSEDED, INSERT shipment
            접수 REPLACING(교체 단말기, 운송장)
  ```
  하나라도 실패하면 전부 롤백. 발급된 운송장은 고아(decisions/0012).
- 설치 확인 `POST /service-tickets/:id/installations`: 접수 FOR UPDATE(REPLACING) → 교체 단말기 DELIVERED → IN_SERVICE(SERVICE) → 접수 CLOSED. 배송 완료 전이면 422.
- 고장 단말기 회수: RETURN_REQUESTED → RETURNING(일반 API) → RETURN_IN 박스 스캔 → RETURNED → 기존 검수.
- 배송 완료 반영(F3)은 운송장이 IN_TRANSIT일 때만 단말기를 바꾼다(SUPERSEDED·DELIVERED면 NOOP).

### 5.7 잠금 순서 요약 (이번에 지킨 규칙)
- 부모 행 X 락을 자식 INSERT(FK 검사 S 락)보다 먼저: 발주 → 단말기 INSERT, 단말기 → 접수 INSERT, 단말기 UPDATE → 운송장 INSERT.
- 여러 행: 같은 종류는 id(또는 시리얼) 오름차순. 교체 출고는 접수 → 단말기(id 오름차순). 일괄 INSERT는 시리얼 순서.
- 외부 호출(세움·택배사)은 트랜잭션 밖. Redis 잠금도 트랜잭션 밖에서 잡고 푼다.
- outbox relay는 READ COMMITTED 그대로, add 대신 addBulk 한 번(실험 0006).

## 6. 실패 처리

| 상황 | 응답 |
|---|---|
| 행 단위 문제(형식, 요청 안 중복, 모델 없음, 이미 있음, 명세 외, 없음, 상태 다름) | 그 행만 결과 코드, 나머지는 반영(201) |
| 같은 scanId 처리 중 | 409 SCAN_IN_PROGRESS |
| 같은 scanId, 다른 내용 | 422 SCAN_ID_REUSED |
| 마감된 발주에 입고 / 다시 마감 | 422 PO_CLOSED / 422 PO_ALREADY_CLOSED |
| 박스 안 version 충돌(RETURN_IN) | 409 VERSION_CONFLICT(박스 전체 롤백) |
| 일괄 등록 중 다른 요청과 시리얼 겹침 | 내부에서 1회 재시도 → ALREADY_EXISTS |
| 엑셀 파일 문제 / 2MB 초과 | 400 INVALID_FILE·MISSING_COLUMNS·TOO_MANY_ROWS / 413 |
| A/S 규칙 위반 | 422 TERMINAL_NOT_IN_SERVICE·TICKET_NOT_OPEN·REPLACEMENT_NOT_IN_STOCK·MODEL_MISMATCH, 409 TICKET_ALREADY_OPEN |
| 교체 출고 경합에서 진 쪽 | 422 INVALID_TRANSITION(잠금을 기다린 뒤 교체 단말기가 이미 SHIPPED) |
| 공장·택배사 오류 | 502 PARTNER_ERROR |

업무 규칙 오류는 `BusinessError(status, code, message)` 하나로 표현하고 예외 필터가 그대로 응답한다.

## 7. 실험

| 번호 | 질문 | 설정 | 볼 것 |
|---|---|---|---|
| 0006 | 대량 처리에서 N+1과 일괄의 차이, relay에 addBulk를 쓸까 | 박스 500, 엑셀 1,000행, outbox 1,000행(relay limit 100) | 쿼리 수(select·insert), 소요, relay 1회 최대 시간(행 락 유지 시간) |
| 0007 | 같은 교체 단말기를 N개 접수가 동시에 요청하면 | N=10, 3회, 잠금 순서 id-asc·faulty-first | 성공 1, 실패 사유, 500·데드락 0, 고아 운송장 수 |

둘 다 `EXPERIMENTS=1`일 때만 돈다. 0007의 `faulty-first`는 교체 단말기 id가 고장 단말기보다 작게 만들어 실제로 반대 순서가 되게 한다. 공유 행이 교체 단말기 하나뿐이면 순서를 바꿔도 순환 대기가 생기지 않는다는 예상을 확인하는 것이고, 데드락이 안 나오면 그 이유를 그대로 적는다.

## 8. 기록할 결정

- 0017 전이 출처 확장(ALLOCATION·SHIPMENT·SCAN·IMPORT·SERVICE)과 배정·출고 전용 출처, 배정 취소는 mutate로 가맹점 비우기
- 0018 재출고 시 이전 운송장 SUPERSEDED, 배송 완료는 IN_TRANSIT 운송장만 반영
- 0019 일괄 처리: 행별 결과(부분 반영), 조회 2번, 한 트랜잭션, 시리얼 순서 INSERT, unique 위반 1회 재시도, RETURN_IN 충돌은 박스 전체 409
- 0020 박스 스캔 멱등: Redis 처리 중 잠금 + MySQL ScanBatch(왜 둘 다인가), requestHash
- 0021 입고 정책: 명세 밖 시리얼은 거절, 발주 행 잠금 먼저, terminal.purchase_order_id로 입고 연결
- 0022 엑셀: exceljs 4.4.0, multer 메모리 저장소, 2MB·5000행·한글 파일 이름(defParamCharset utf8)
- 0023 교체 출고: 한 트랜잭션, 잠금 순서(접수 → 단말기 id 오름차순), 출처 선택
- 0024 outbox relay를 addBulk로(실험 0006 숫자로)
- 갱신: 0014(Retry-After 60초 상한), 0015(scheduler:clear)

## 9. 이번에 하지 않는 것

- 교체 출고 경합에서 진 요청도 운송장을 먼저 발급해 고아가 생긴다(실험 0007에서 수를 잰다). 교체 단말기를 먼저 "예약"하는 단계는 만들지 않는다 → Day 7 고아 정리와 함께.
- 명세에 섞여 온 다른 발주의 시리얼(foreignSerials)은 명세에 있으니 입고된다. 공장 번호 체계를 알아야 걸러낼 수 있어 하지 않는다(대조의 noted에 포함된다).
- 공장 발주의 멱등(같은 reference 재요청)과 고아 발주 정리.
- 일괄 처리 결과의 페이지 나누기·비동기 처리(큐). 지금은 한 요청 500행(스캔)·5000행(엑셀) 상한으로 막는다.
- A/S 접수 목록·검색 API, 원격 점검 이력 테이블(마지막 메모만 남긴다).
- HTTP 경로의 데드락(1213) 매핑, QUEUED outbox 복구 sweep(Day 7), Day 1 리뷰 Minor 2·4·5·6·7, 테스트 로그 MaxListenersExceededWarning(Day 2 Minor 6).
