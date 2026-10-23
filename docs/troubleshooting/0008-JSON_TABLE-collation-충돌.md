# 0008. JSON_TABLE 열과 테이블 열의 collation 충돌(ERROR 1267)

- 날짜 / 관련 기능: 2026-10-23 / F10
- 이 기록은 계획에서 미리 예약한 재현이다(계획 사전 검증에서 만난 오류를 Task 7에서 직접 다시 일으켜 확인).
- 증상: 대조 서비스의 missing 쿼리에서 JSON_TABLE 열 정의의 `collate utf8mb4_0900_ai_ci`만 빼고 `npx vitest run test/reconciliation.e2e.spec.ts`를 3번 돌렸다. 3번 모두 `Tests 1 failed | 4 passed (5)`. 실패는 늘 마감 경합 테스트(`AssertionError: expected 500 to be 200`)이고 서버 로그는
  `Error: Illegal mix of collations (utf8mb4_0900_ai_ci,IMPLICIT) and (utf8mb4_unicode_ci,IMPLICIT) for operation '='`.
  같은 쿼리를 쓰는 첫 테스트(대조)와 셋째 테스트(마감)는 통과했다.
- 가설:
  1. 테이블마다 collation이 다르다
  2. JSON_TABLE 열이 연결의 collation을 받아 테이블 열과 다르다
  3. (같은 쿼리가 어떤 테스트에서는 통과한 이유) 풀의 연결마다 collation이 다르다
- 확인:
  - `information_schema.columns`(테스트 DB): terminal.serial_no·status, purchase_order.po_no·status·ordered_by·closed_by, scan_batch.scan_id·kind·po_no·request_hash·actor 모두 `utf8mb4_0900_ai_ci` → 1 기각.
  - MySQL 클라이언트, 테스트 DB 읽기만(계획 명령 그대로):
    - `set collation_connection=utf8mb4_unicode_ci; select n.s from json_table("[\"A\"]", "$[*]" columns (s varchar(32) path "$")) n left join terminal t on t.serial_no = n.s;` → `ERROR 1267 (HY000) at line 1: Illegal mix of collations (utf8mb4_0900_ai_ci,IMPLICIT) and (utf8mb4_unicode_ci,IMPLICIT) for operation '='`
    - 같은 연결 설정에서 `select collation(n.s) …` → `utf8mb4_unicode_ci`(JSON_TABLE 열은 연결 collation을 따름) → 2 확인
    - 열에 `collate utf8mb4_0900_ai_ci`를 적은 EXPLAIN: `n | ALL | Table function: json_table; Using temporary`, `t | eq_ref | terminal_serial_no_unique | ref n.s | Using where; Not exists; Using index`
    - 서버 기본값: `@@collation_connection`·`@@collation_server`·`@@collation_database` 모두 `utf8mb4_0900_ai_ci`(클라이언트 기본 연결), docker-compose의 `--collation-server=utf8mb4_0900_ai_ci`
  - 앱 연결(임시 테스트, 지움): 새 앱에서 `select connection_id(), @@collation_connection` → `utf8mb4_unicode_ci`(mysql2 기본). 동시에 연 4개 연결 모두 `utf8mb4_unicode_ci`. 이 앱에서 collate 없는 missing 쿼리를 발주 1~4번에 돌리면 4번 모두 ERROR 1267.
  - 가설 3: reconcile에 임시 로그를 넣고 대조 테스트를 돌림.
    ```
    [probe] SE…5430001 RECEIVING [{"c":22062,"cc":"utf8mb4_0900_ai_ci"}]
    [probe] SE…6360001 ORDERED   [{"c":22062,"cc":"utf8mb4_0900_ai_ci"}]
    [probe] SE…6530001 CLOSED    [{"c":22062,"cc":"utf8mb4_0900_ai_ci"}]
    [probe] SE…7070001 CLOSED    [{"c":22063,"cc":"utf8mb4_unicode_ci"}]   ← 이것만 ERROR 1267
    ```
    통과한 세 번은 연결 22062, 실패한 마감 경합은 스캔이 연결 하나를 잡고 있어 새로 연 22063이었다. 그리고 `resetDatabase` 앞뒤로 같은 연결의 collation을 찍으니 `before {"c":22069,"cc":"utf8mb4_unicode_ci"}` → `after {"c":22069,"cc":"utf8mb4_0900_ai_ci"}`. MikroORM 스키마 SQL이 `set names utf8mb4;`로 시작해서다(`@mikro-orm/sql/dialects/mysql/MySqlSchemaHelper.js`). collate를 안 적으면 서버의 utf8mb4 기본 collation(0900_ai_ci)이 된다 → 3 확인.
- 원인: JSON_TABLE이 만드는 열은 연결의 collation을 따른다. mysql2 기본 연결 collation은 `utf8mb4_unicode_ci`, 테이블 열은 `utf8mb4_0900_ai_ci`. 둘 다 IMPLICIT라 MySQL이 고르지 못한다. 테스트에서는 `schema.refresh()`를 거친 연결 하나만 0900_ai_ci라서, 그 연결로 나간 쿼리는 우연히 통과했다(계획에 "데이터·실행 계획에 따라 다른 것으로 추정"이라 적혀 있던 부분은 이것으로 확인됨. 실행 계획 때문이 아니라 연결 때문).
- 해결: JSON_TABLE 열 정의에 `collate utf8mb4_0900_ai_ci`(Task 7 커밋). 비교 쪽에 `COLLATE`를 붙이는 방법도 있지만 열 정의에 두면 EXPLAIN에서 serial_no unique 인덱스(eq_ref)를 그대로 쓴다. 연결 collation 자체를 바꾸는 것(MikroORM 연결 설정)은 모든 쿼리에 영향이 있어 이번엔 하지 않았다. 되돌린 뒤 대조 테스트 3회 모두 `5 passed`.
- 남은 위험: 테스트의 첫 연결이 운영과 다른 collation이라, 다른 collation 문제도 테스트에서 가려질 수 있다. 운영 서버는 `set names`를 보내지 않으므로 모든 연결이 unicode_ci다. 테스트 연결을 운영과 맞추는 것(예: resetDatabase 뒤 연결을 다시 열기, 또는 연결 collation을 설정으로 고정)은 결정이 필요해 이번에는 하지 않고 backlog에 둔다.
- 배운 것: → study/backlog.md

## 해결 후: 연결 collation 고정(근본 해결, 2026-10-23 fix 커밋)

- 리뷰 지적: MikroORM 7의 맨 위 `charset`/`collate`는 mysql2 연결에 전달되지 않는다(스키마 생성과 `set names`에만 쓰임). mysql2 연결 collation은 `driverOptions.charset`(대문자 collation 이름)으로 정해진다.
- `mikro-orm.config.ts`에 `driverOptions: { charset: 'UTF8MB4_0900_AI_CI' }`, `collate: 'utf8mb4_0900_ai_ci'` → decisions/0025.
- 확인: 새 테스트 `test/connection-collation.e2e.spec.ts`(resetDatabase 없이 동시 트랜잭션 4개, 연결 id 4개 서로 다름). 설정 전 4개 모두 `utf8mb4_unicode_ci`로 실패, 설정 후 모두 `utf8mb4_0900_ai_ci`로 통과.
- 되돌린 실험: 설정을 넣은 채 JSON_TABLE 열 3곳의 `collate`를 빼고 대조 테스트 3회 → 3회 모두 `Tests 5 passed (5)`. 이제 새 풀 연결도 테이블과 같아 ERROR 1267이 나지 않는다. 열의 `collate`는 방어로 되돌려 두었다(쿼리가 연결 설정에 기대지 않게, 이유는 decisions/0025).
- "남은 위험"에 적은 "테스트 첫 연결만 운영과 다르다"는 이것으로 없어졌다. 이제 운영·테스트의 모든 연결이 0900_ai_ci다.
- PAD SPACE(unicode_ci) → NO PAD(0900_ai_ci) 변화: 글자 상수·바인드 값끼리 비교할 때만 영향이 있고 우리 쿼리에는 없다. 전체 테스트에 차이 없음(decisions/0025).
