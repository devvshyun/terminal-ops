# 0025. enum을 좁히는 down이 테스트 DB 데이터에 막혀 반쪽만 되돌려짐

- 날짜 / 관련 기능: 2026-10-26 / Day 5 최종 리뷰 Minor 3 (마이그레이션 down 체인 확인), F2·F3
- 증상: 리뷰가 "down 체인은 돌려 본 기록이 없다"고 해서 테스트 DB에서 처음으로 `MYSQL_DATABASE=terminal_ops_test node dist/db/migrate.js down 0`(이번에 더한 `down` 명령)을 돌렸다. 22개 중 14개(`Migration20261026050214` ~ `Migration20261023021402`)는 `Reverted`, 15번째 `Migration20261023015811`에서 멈췄다.
  ```
  code: 'WARN_DATA_TRUNCATED', errno: 1265, sqlState: '01000',
  sqlMessage: "Data truncated for column 'source' at row 1",
  sql: "alter table `terminal_status_history` modify `source` enum('MANUAL','INSPECTION','BATCH') not null;"
  ```
- 가설:
  1. 테스트가 남긴 행(이 DB는 테스트가 refresh하고 데이터를 남긴다)의 `source`가 좁힌 enum 밖 값이다.
  2. down SQL 자체가 틀렸다(enum 글자 대소문자 — troubleshooting/0005 같은 일).
  3. 실패한 마이그레이션은 트랜잭션이라 통째로 되돌려졌다(상태는 깨끗하다).
- 확인:
  - `select source, count(*) from terminal_status_history group by source` → `IMPORT 1, SHIPMENT 2, SCAN 2`(단말기 5대). 모두 down이 남기는 `('MANUAL','INSPECTION','BATCH')` 밖 → 가설 1 확인. down SQL의 글자는 대문자로 맞다 → 가설 2 기각. 이 마이그레이션 주석에도 "새 출처 이력이 있으면 strict 모드에서 실패한다. 되돌리기 전에 그 행을 처리한다"고 이미 적혀 있었다.
  - 실패 뒤 `mikro_orm_migrations`는 8행(015811이 아직 "적용됨")인데 `shipment.status`의 `column_type`은 `enum('IN_TRANSIT','DELIVERED')` — 같은 down의 **첫째 ALTER(shipment)는 이미 반영**됐다 → 가설 3 기각. MySQL DDL은 암묵 커밋이라 MikroORM의 마이그레이션 트랜잭션(`MigrationRunner.run`의 `transactional`)이 되돌리지 못한다. 기록과 스키마가 어긋난 반쪽 상태로, 이 상태에서 `up`을 하면 015811은 건너뛰어 SUPERSEDED가 없는 채로 남는다.
- 원인: enum을 좁히는 down(`Migration20261023015811`, `Migration20261022053251`)이 데이터와 상관없이 ALTER를 바로 보냈다. 좁힌 enum 밖 값이 있으면 strict 모드가 실패시키고, 그 마이그레이션의 앞선 DDL은 이미 커밋돼 있다.
- 해결:
  - `src/db/migration-guards.ts` `assertEnumNarrowable` — down이 ALTER를 쌓기 전에 `select count(*) … where col not in (남길 값)`을 표·열마다 하고, 하나라도 있으면 표·열·행 수를 담아 던진다(아무 DDL도 보내지 않음). 행을 바꾸거나 지우지는 않는다 — 어떤 값으로 바꿀지는 사람이 정할 일이다. 두 마이그레이션의 down을 `async`로 바꿔 쓴다. 이 파일은 `src/migrations` 밖에 둔다(마이그레이터가 `dist/migrations`의 모든 .js를 마이그레이션으로 읽음).
  - 단위 테스트 `test/unit/migration-down-guard.spec.ts`(가짜 드라이버로 count를 돌려줌) 먼저 실패: `TypeError: You must provide a Promise to expect() when using .rejects, not 'undefined'`(down이 동기라 던지지 않음) ×3, `expected '' to match /not in …/` → 4 passed.
  - 테스트 DB 실측: 반쪽 상태를 손으로 되돌린 뒤(`alter table shipment modify status enum('IN_TRANSIT','DELIVERED','SUPERSEDED') …` — up의 그 문장) 같은 데이터로 다시 `down 0` → `Error: Migration20261023015811 down을 할 수 없습니다: terminal_status_history.source에 (MANUAL, INSPECTION, BATCH) 밖의 값 5행. 되돌리기 전에 그 행을 처리하세요(아무 ALTER도 보내지 않았습니다).`, 그 뒤 `shipment.status`는 SUPERSEDED를 그대로 갖고 마이그레이션 기록 8행 — 어긋나지 않음.
  - 한 바퀴 확인은 빈 DB에서: 테스트 DB를 지우고 다시 만든 뒤 `up`(22 Applied) → `down 0`(22 Reverted, 남은 테이블 `mikro_orm_migrations` 하나·행 0) → `up`(22 Applied) → 생긴 `.snapshot-terminal_ops_test.json`을 스크래치패드로 옮기고 `check` → `최신 상태`(0015). 각 단계 exit 0.
  - `migrate.ts`에 `down <0|이름>` 명령과 `db:migration:down` 스크립트를 더했다. dbName이 `MYSQL_TEST_DATABASE`가 아니면 거절한다(개발 DB에서 `node dist/db/migrate.js down 0` → `down은 테스트 DB(MYSQL_TEST_DATABASE)에서만 실행합니다(현재: terminal_ops).`, exit 1로 확인).
- 남은 것: 다른 down들도 데이터가 있으면 정보를 잃는다(열·테이블 drop) — 그건 down의 본성이라 두고, 이번 검사는 "실패해서 반쪽이 되는" enum 좁히기만 다룬다. 데이터가 든 DB의 down 한 바퀴는 하지 않았다(테스트 DB 데이터는 테스트마다 달라 기대값이 없음).
- 배운 것: MySQL DDL 암묵 커밋 → 마이그레이션 "트랜잭션"이 DDL 여러 개를 묶어 주지 않는다 → study/backlog.md
