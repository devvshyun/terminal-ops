# 0015. 빈 테스트 DB에 마이그레이션 up을 하면 테스트 DB 이름의 스냅샷 파일이 생긴다

- 날짜 / 관련 기능: 2026-10-23 / Day 3 Task 12 (마이그레이션 체인 확인)
- 증상: Task 12 Step 2에서 테스트 DB를 지우고 다시 만든 뒤 `MYSQL_DATABASE=terminal_ops_test node dist/db/migrate.js up`(12개 Applied) → `check`(`최신 상태`)를 돌렸다. 그 뒤 `git status`에 계획에 없던 파일이 나왔다.
  ```
  ?? api/src/migrations/.snapshot-terminal_ops_test.json
  ```
  계획은 "`check`는 테스트 DB 이름의 스냅샷 파일이 없어 DB 스키마와 엔티티를 직접 비교한다"고 적었다. 파일이 생겼다면 `check`가 그 파일과 비교했을 수 있다.
- 가설:
  1. `check`(`migrator.checkSchema()`)가 스냅샷이 없으면 만들어 둔다.
  2. `up`이 마이그레이션을 적용한 뒤 DB를 읽어 스냅샷을 저장한다.
  3. 바로 뒤에 돌린 vitest(테스트 DB)가 만든다.
- 확인:
  - 파일 수정 시각 `13:10:08.33`. `up`·`check`는 13:10:0x, vitest 시작은 `13:10:14` → 가설 3 기각. 테스트 헬퍼·설정에는 `migrator`·`snapshot` 호출이 없다(grep).
  - 파일을 스크래치패드로 옮기고 `check`만 다시 실행 → `최신 상태`, 파일이 다시 생기지 않음 → 가설 1 기각. 이어서 `up`(적용할 것 없음, `적용: 없음`) → 파일이 생기지 않음.
  - `node_modules/@mikro-orm/migrations/Migrator.js` `runMigrations`: `if (result.length > 0 && this.options.snapshot && this.options.snapshotOnMigrate)`이면 DB를 introspect해서 스냅샷을 저장한다(기존 스냅샷과 의미상 같으면 그대로 둔다). `snapshotOnMigrate`는 core 기본값 `true`. 스냅샷 이름은 `.snapshot-<dbName>` → 가설 2 확인. 마이그레이션을 실제로 적용했을 때만 쓴다.
  - 생긴 파일과 개발 DB 스냅샷(`.snapshot-terminal_ops.json`, `db:migration:create`가 만든 것)을 DB 이름만 바꿔 비교하면 차이는 datetime 열 3곳의 `precision 3 / scale 0`(introspect) 대 `null`(엔티티)뿐이었다.
- 원인: MikroORM 7의 `snapshotOnMigrate`(기본 켜짐). 빈 테스트 DB에 12개를 적용했으니 그 DB를 읽은 스냅샷을 DB 이름으로 저장했다. 계획의 "스냅샷 파일이 없다"는 `up` 전에는 맞고 `up` 뒤에는 틀리다.
- 영향: `check`가 이 파일과 비교했어도 파일 내용이 방금 introspect한 테스트 DB 스키마라서 "DB 대 엔티티" 비교와 사실상 같다. 그래도 직접 확인했다: 파일을 치운 상태의 `check`(DB를 직접 읽음)도 `최신 상태`. 따라서 Step 2의 결론(마이그레이션 체인만으로 만든 스키마가 엔티티와 같다)은 그대로다.
- 해결: 파일은 커밋하지 않고 저장소 밖(스크래치패드)으로 옮겼다. 코드·설정 변경 없음.
- 다시 볼 조건: 이 확인을 또 하면 같은 파일이 생긴다. 반복되면 `.gitignore`에 `apps/api/src/migrations/.snapshot-terminal_ops_test.json`을 넣거나, 체인 확인 스크립트가 끝에 지우게 한다.
- 배운 것: 마이그레이션 스냅샷은 `create`만 쓰는 게 아니다. `up`도 DB 이름별로 쓴다 → study/backlog.md(마이그레이션 스냅샷 줄에 합침)
