# 0005. enum 마이그레이션의 down()이 소문자로 생성됨

- 날짜 / 관련 기능: 2026-10-22 / F2
- 증상: `source` enum에 BATCH를 추가하고 `db:migration:create`를 돌리자 생성된 down()이 다음과 같았다. up()은 정상(`'MANUAL','INSPECTION','BATCH'`).
  ```
  this.addSql(`alter table \`terminal_status_history\` modify \`source\` enum('manual','inspection') not null;`);
  ```
- 가설: 1) 엔티티 enum 값이 소문자 2) 마이그레이션 스냅샷이 소문자로 저장
- 확인: 변경 전 스냅샷(`git show HEAD:apps/api/src/migrations/.snapshot-terminal_ops.json`)에서 `source` 컬럼이 `"type": "enum('manual','inspection')"`, `"enumItems": ["MANUAL","INSPECTION"]`였다. 엔티티 값은 대문자 → 가설 1 기각, 2 확인
- 원인: down()은 스냅샷의 이전 컬럼 `type` 문자열로 만들어진다(추정: MikroORM 7.2.5 동작, 소스는 확인하지 않음). 스냅샷의 `type`이 소문자로 저장돼 있었다.
- 해결: down()을 `enum('MANUAL','INSPECTION')`으로 직접 고쳤다. 소문자 enum으로 되돌리면 기존 값 `MANUAL`이 `manual`로 읽혀 앱의 enum 비교가 깨진다. 앞으로 enum을 바꾸는 마이그레이션은 down()을 꼭 확인한다.
- 참고: 새로 생성된 스냅샷의 `type`도 `enum('manual','inspection','batch')`(소문자)라 다음 enum 변경 때도 같은 일이 생길 것이다.
- 배운 것: → study/backlog.md에 추가
