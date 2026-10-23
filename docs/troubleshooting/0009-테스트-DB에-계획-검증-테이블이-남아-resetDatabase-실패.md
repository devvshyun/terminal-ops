# 0009. 테스트 DB에 계획 사전 검증 테이블이 남아 resetDatabase 실패

- 날짜 / 관련 기능: 2026-10-23 / Day 3 Task 1 (테스트 환경)
- 번호: 계획이 0008을 Task 7(JSON_TABLE collation)에 예약했으므로 계획에 없던 이 문제는 0009로 적는다.
- 증상: Task 1 Step 2(실패 확인)에서 단위 테스트는 예상대로 실패했지만, e2e 파일 5개가 테스트 하나 돌기 전에 `beforeAll`에서 모두 실패했다(`Tests 5 failed | 44 passed | 35 skipped`).
  ```
  DriverException: Cannot drop table 'shipment' referenced by a foreign key constraint 'service_ticket_outbound_shipment_id_foreign' on table 'service_ticket'.
   ❯ resetDatabase test/helpers/test-app.ts:36:3
       36|   await orm.schema.refresh();
  ```
  계획은 Step 2에서 e2e도 개별 테스트 단위로 실패(404, source 불일치 등)할 것으로 예상했다.
- 가설:
  1. 테스트 DB에 지금 코드의 엔티티에 없는 테이블(`service_ticket`)이 있어, `schema.refresh()`의 drop 단계가 자기가 아는 테이블(`shipment`)만 지우려다 남의 FK에 걸린다.
  2. 다른 세션이 같은 테스트 DB를 동시에 쓰고 있다.
- 확인:
  - `show tables from terminal_ops_test` + `information_schema.tables.create_time`:
    ```
    mikro_orm_migrations 10:39:16
    merchant, outbox_event, purchase_order, scan_batch, terminal_model 10:51:41
    service_ticket 10:51:42
    shipment, terminal 10:56:06
    ```
    `purchase_order`, `scan_batch`, `service_ticket`은 Day 3 Task 3 이후에 생길 테이블이다. `mikro_orm_migrations`에도 `Migration20261023010815` ~ `Migration20261023013013`(아직 저장소에 없는 Day 3 마이그레이션 5개)이 10:39에 적용돼 있었다 → 계획 작성 때의 사전 검증(복제본에서 Task 12까지 적용, 같은 테스트 DB 사용)이 남긴 것.
  - `information_schema.processlist`: 내 조회 연결 말고 테스트 DB를 쓰는 연결 없음 → 가설 2 기각.
  - drop이 일부만 진행돼 `carrier_event`, `sync_run`, `terminal_status_history` 등은 이미 없고 `shipment`·`terminal`은 이번 실행이 다시 만든 상태였다. 가설 1 확인.
- 원인: MikroORM `schema.refresh()`는 현재 메타데이터에 있는 테이블만 drop/create한다. 모르는 테이블이 남아 있고 그 테이블이 아는 테이블을 FK로 참조하면 drop이 실패한다. 사전 검증이 끝난 뒤 테스트 DB를 비우지 않았다.
- 해결: 계획의 안전 규칙에 적힌 명령으로 테스트 DB(`terminal_ops_test`)만 지우고 다시 만들었다(개발 DB는 건드리지 않음). 코드 변경 없음.
  ```bash
  MSYS_NO_PATHCONV=1 docker exec terminal-ops-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "drop database terminal_ops_test; create database terminal_ops_test character set utf8mb4 collate utf8mb4_0900_ai_ci; grant all privileges on terminal_ops_test.* to '"'"'terminal_ops'"'"'@'"'"'%'"'"';"'
  ```
  다시 돌린 Step 2는 계획의 예상대로 개별 테스트가 실패했다(devlog Task 1 항목).
- 배운 것: 앞선 브랜치나 스파이크가 같은 테스트 DB를 쓰면 `refresh()`만으로는 깨끗해지지 않는다. 사전 검증을 마치면 테스트 DB를 다시 만들어 둔다.
