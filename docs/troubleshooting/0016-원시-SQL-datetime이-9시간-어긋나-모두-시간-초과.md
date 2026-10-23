# 0016. 원시 SQL로 읽은 datetime이 9시간 어긋나 모든 대상이 바로 시간 초과

- 날짜 / 관련 기능: 2026-10-23 / F8 (Day 4 Task 7, 계획한 재현)
- 계획한 재현이다. 계획 전 사전 검증에서 이 문제를 이미 만났고, 계획이 "고치는 함수(`fromDbDatetime`) 없이 먼저 돌려 보고 기록한다"를 Task 7 Step 4로 넣어 두었다. 아래는 이번에 직접 다시 돌린 결과다.
- 증상: `rollout.service.ts`의 `offeredTargets`에서 `offeredAt: new Date(r.offered_at)`로 읽게 바꾸고 `npx vitest run test/firmware-control.e2e.spec.ts`를 돌렸다(20:07:54). 배포 판단이 보고를 기다려야 할 때 모든 대상을 TIMED_OUT으로 바꾸고 실패율 100%로 ABORTED가 됐다.
  ```
  × 모두 성공하면 단계를 넘기고(누적 비율만큼 대상 추가·알림), 마지막 단계가 끝나면 COMPLETED
  × 실패율이 기준을 넘고 결과가 minSamples 이상이면 자동 중단: 남은 제안을 모두 내린다
  × 제한 시간 안에 보고가 없으면 TIMED_OUT(실패로 셈)으로 바꾸고 그 제안을 내린다
  × 진행 중 배포: Redis에서 사라진 제안(커밋 뒤 걸기 전에 죽음 등)을 다음 판단이 다시 건다
  AssertionError: expected 'ABORTED' to be 'WAITING' // Object.is equality
  AssertionError: expected 'ABORTED' to be 'WAITING' // Object.is equality
  AssertionError: expected 'ADVANCED' to be 'WAITING' // Object.is equality
  AssertionError: expected 'ABORTED' to be 'WAITING' // Object.is equality
  Tests  4 failed | 5 passed (9)
  ```
  계획의 예상은 `3 failed | 3 passed (6)`였다. 이번에 더한 제안 맞추기 테스트 하나(배포 직후 판단이 WAITING이어야 함)가 같은 이유로 더 실패했다. `제한 시간 안에…`는 제한 시간 1초인데 "500ms 뒤" 판단에서 이미 다음 단계로 넘어갔다(기준 100%라 중단 대신 넘어감).
- 가설:
  1. stageTimeoutMs 기본값(10분)이 너무 짧다.
  2. offered_at을 잘못 읽는다(시간대).
  3. 테스트가 넘기는 now가 미래다.
- 확인:
  - 1 아님: 실패한 넷 중 셋은 기본값 10분, 하나는 1초인데 500ms 시점에 이미 지났다고 봤다. 10분이든 1초든 "막 만든 대상"이 지났다고 나온다.
  - 3 아님: 그 셋은 now를 넘기지 않는다(`control(id)`·`controlAll()`, 기본 `new Date()`).
  - 2 확인. MySQL(테스트 DB, 읽기만, 20:08:08 KST):
    ```
    $ docker exec terminal-ops-mysql mysql -N … terminal_ops_test -e "select offered_at, @@session.time_zone, @@global.time_zone, @@system_time_zone, now(3) from firmware_rollout_target order by id desc limit 1"
    2026-10-23 11:08:02.272	SYSTEM	SYSTEM	KST	2026-10-23 20:08:08.466
    ```
    저장값은 KST보다 9시간 이른 UTC다. 세션 시간대는 SYSTEM(KST)이라 `now(3)`는 KST다.
  - `em.execute` 결과를 잠깐 찍어 봤다(로그 줄은 확인 뒤 지움):
    ```
    [offered_at 원시] typeof=string 값="2026-10-23 11:08:18.389" new Date=2026-10-23T02:08:18.389Z 지금=2026-10-23T11:08:18.407Z
    ```
    값은 글자이고 시간대 표시가 없다. `new Date(글자)`는 이것을 지역 시간(KST)으로 읽어 UTC 02:08이 된다. 9시간 전이니 10분 제한 시간이 이미 지났다.
  - MikroORM 7.2.5 코드: `@mikro-orm/core` `Configuration` 기본값 `forceUtcTimezone: true`, `@mikro-orm/mysql/MySqlConnection.js` `mapOptions`가 `forceUtcTimezone`이면 `ret.timezone = 'Z'`, 그리고 항상 `ret.dateStrings = true`.
- 원인: MikroORM 7은 날짜를 UTC로 저장하고(mysql2 `timezone: 'Z'`), 원시 결과는 `dateStrings`라 시간대 표시 없는 글자로 준다. JS `new Date('2026-10-23 11:08:18.389')`는 지역 시간으로 해석한다. 엔티티로 읽으면 MikroORM이 UTC로 바꿔 주기 때문에 그동안 드러나지 않았다. 원시 SQL로 datetime을 읽어 계산에 쓴 곳은 이번 `offeredTargets`가 처음이다(Task 6에서는 읽기만 하고 쓰지 않았다).
- 해결: `common/db-datetime.ts`의 `fromDbDatetime`(글자의 공백을 `T`로, 끝에 `Z`를 붙여 UTC로 읽음. 이미 Date면 그대로). 단위 테스트 `test/unit/db-datetime.spec.ts`. 되돌린 뒤 firmware-control 9 passed, 단위 2 passed.
  - SQL 안에서 저장된 datetime을 `NOW()`와 비교하지 않는다. 세션 시간대가 SYSTEM이라 `NOW()`는 KST이고 저장값은 UTC다. 비교가 필요하면 JS에서 시각을 만들어 인자로 넘긴다.
- 배운 것: 드라이버 옵션(`timezone`, `dateStrings`)과 ORM 기본값이 정하는 "DB에 들어간 글자의 뜻"을 모르면, ORM을 거치지 않는 경로에서만 시간이 틀린다 → study/backlog.md.
