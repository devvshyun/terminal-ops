# 0030. 다른 브랜치가 쓴 테스트 DB에서 schema.refresh가 merchant를 못 지운다

- 날짜 / 관련 기능: 2026-10-28 / 보강 2(user_account), 테스트 도구
- 증상: 보강 2 계획 사전 검증에서 `auth-roles`(Task 2까지)로 api 테스트를 돌린 뒤, 같은 테스트 DB로 master(7487fe4)의 실험 0008을 돌리자 `resetDatabase`에서 멈췄다:
  ```
  DriverException: Cannot drop table 'merchant' referenced by a foreign key constraint 'user_account_merchant_id_foreign' on table 'user_account'.
   ❯ SqlSchemaGenerator.drop node_modules/@mikro-orm/sql/schema/SqlSchemaGenerator.js:117:9
   ❯ SqlSchemaGenerator.refresh node_modules/@mikro-orm/core/utils/AbstractSchemaGenerator.js:35:13
   ❯ resetDatabase test/helpers/test-app.ts:36:3
  ```
  `Tests  5 skipped (5)`(beforeAll에서 실패).
- 가설: 1) `merchant` 테이블에 데이터가 남아 지우지 못한다 2) `schema.refresh`는 지금 코드의 엔티티가 아는 테이블만 지우고, 모르는 `user_account`의 FK가 `merchant`를 붙잡는다
- 확인: master 코드의 `ENTITIES`에는 `UserAccount`가 없다(보강 2에서 더함). 오류는 데이터가 아니라 FK 제약 이름(`user_account_merchant_id_foreign`)을 말한다 → 가설 1 기각, 2 확인. 테스트 DB를 지우고 다시 만든 뒤(`DROP DATABASE IF EXISTS terminal_ops_test; CREATE DATABASE terminal_ops_test`) 같은 명령이 통과했다(`Tests  2 passed | 3 skipped (5)`).
- 원인: `orm.schema.refresh()`는 메타데이터(엔티티 목록) 기준으로 drop → create 한다. 다른 브랜치가 만든 테이블은 모르니 지우지 않고, 그 테이블의 FK가 아는 테이블(`merchant`)의 drop을 막는다.
- 해결: 브랜치를 오가며 테스트할 때는 먼저 테스트 DB를 다시 만든다(계획 안전 규칙의 명령). 코드는 바꾸지 않았다 — `resetDatabase`가 DB 전체를 지우게 하면 테스트 DB 이름 확인 말고 안전장치가 하나 더 줄어든다.
- 배운 것: → study/backlog.md "MikroORM schema.refresh는 메타데이터에 있는 테이블만 다룬다"
