# 0022. insertMany는 엔티티 기본값을 쓰지 않아 새 NOT NULL 열에서 실패

- 날짜 / 관련 기능: 2026-10-26 / F4, F2 (Day 5 Task 5, 계획에서 미리 예상한 재현)
- 증상: `terminal.status_changed_at`(datetime(3) not null, 엔티티 초기값 `statusChangedAt = new Date()`)을 넣은 뒤 접속 상태 테스트가 실패했다.
  ```
  $ npx vitest run test/connectivity.e2e.spec.ts
   FAIL  test/connectivity.e2e.spec.ts > 접속 상태 — 오프라인 판정·스냅샷·조회 (F8, decisions/0029) > 대량 변화는 묶음 이벤트 하나로 (relay 줄서기 방지)
  NotNullConstraintViolationException: Field 'status_changed_at' doesn't have a default value
   ❯ MySqlDriver.nativeInsertMany node_modules/@mikro-orm/sql/AbstractSqlDriver.js:944:21
   ❯ SqlEntityManager.insertMany node_modules/@mikro-orm/core/EntityManager.js:1627:21
   ❯ test/connectivity.e2e.spec.ts:229:7
   Test Files  1 failed (1)
        Tests  10 passed | 2 skipped (12)
  ```
  묶음 이벤트 describe의 beforeAll이 `em.insertMany(Terminal, …)`로 단말기 120대(BK-0001…)를 넣다 실패해 그 안의 2개가 건너뛰어졌다.
- 가설:
  1. 마이그레이션이 아직 없어 테스트 DB에 열이 없거나 모양이 다르다.
  2. `insertMany`가 엔티티 필드 초기값(`= new Date()`)을 쓰지 않아 그 열을 INSERT에 넣지 않았다(DB 기본값도 없음).
- 확인:
  - 테스트 DB는 `resetDatabase`가 엔티티로 스키마를 만든다. 실행 뒤 열을 보면 이미 있다(가설 1 기각):
    ```
    $ docker exec terminal-ops-mysql mysql … terminal_ops_test -e "show columns from terminal like 'status_changed_at'"
    Field              Type         Null  Key  Default  Extra
    status_changed_at  datetime(3)  NO         NULL
    ```
  - 같은 파일의 다른 단말기(CN-0001~3, API 등록 → `em.create` + flush)는 값이 들어갔고, insertMany로 넣으려던 BK-는 0행이다:
    ```
    serial_no  status      status_changed_at
    CN-0001    IN_SERVICE  2026-10-26 03:44:09.094
    CN-0002    IN_SERVICE  2026-10-26 03:44:09.188
    CN-0003    IN_SERVICE  2026-10-26 03:44:09.285
    bk
    0
    ```
  - MikroORM 7.2.5 `EntityManager.insertMany`(node_modules/@mikro-orm/core/EntityManager.js 1596~1627행): 첫 항목이 엔티티면 ChangeSet을 만들지만, POJO면 `QueryHelper.processObjectParams` 뒤 `driver.nativeInsertMany`로 그대로 보낸다. 엔티티 인스턴스를 만들지 않으니 필드 초기값·`onCreate`가 없다. 그래서 기존 헬퍼들도 `version: 1, createdAt, updatedAt`을 직접 넣고 있었다(가설 2 확인).
- 원인: 테스트 헬퍼·실험이 `insertMany(Terminal, POJO[])`로 단말기를 넣는데, 새 NOT NULL 열 값을 넣지 않았다. 엔티티 기본값은 `em.create`·`new` 경로에서만 쓰인다.
- 해결: 직접 INSERT하는 네 곳에 `statusChangedAt`을 넣었다 — `test/helpers/terminals.ts`(`insertTerminals`, 인자 `statusChangedAt` 기본 지금), `test/helpers/device-fleet.ts`(`seedInService`), `test/connectivity.e2e.spec.ts`(묶음 이벤트 beforeAll), `test/experiments/device-jobs-timing.spec.ts`. 그 뒤 `npx vitest run test/connectivity.e2e.spec.ts test/status-changed-at.e2e.spec.ts` → 14 passed. 커밋은 Task 5 커밋(devlog 참조).
- DB 기본값(`default current_timestamp(3)`)으로 풀지 않은 이유: MySQL `current_timestamp`는 세션 시간대(SYSTEM = KST) 값이라 앱이 UTC로 쓰는 값과 9시간 다르다(troubleshooting/0016). 기본값이 조용히 틀린 시각을 넣는 것보다 값을 빼먹으면 바로 실패하는 편이 낫다.
- 배운 것: → study/backlog.md "ORM의 대량 INSERT(insertMany)가 엔티티 기본값·훅을 건너뛰는 이유"
