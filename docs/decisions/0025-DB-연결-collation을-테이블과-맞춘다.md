# 0025. DB 연결 collation을 테이블과 맞춘다(utf8mb4_0900_ai_ci)

- 날짜 / 관련 기능: 2026-10-23 / F10(계기), 전체 DB 연결
- 상황: troubleshooting/0008에서 JSON_TABLE 열이 연결 collation(mysql2 기본 `utf8mb4_unicode_ci`)을 따라 테이블 열(`utf8mb4_0900_ai_ci`)과 비교하면 ERROR 1267이 났다. Task 7에서는 쿼리 열 정의에 `collate`를 적어 막았고, 연결 자체는 그대로 뒀다. 그래서 테스트에서는 `schema.refresh()`를 거친 연결 하나만 0900_ai_ci이고 나머지는 unicode_ci라, 풀 연결마다 세션 collation이 달랐다. 리뷰에서 MikroORM 7의 맨 위 `charset`/`collate` 설정은 mysql2 연결에 전달되지 않고(스키마 생성·`set names`에만 쓰임), `driverOptions: { charset: 'UTF8MB4_0900_AI_CI' }`를 주면 `@@collation_connection`이 `utf8mb4_0900_ai_ci`가 된다는 것을 확인했다.
- 선택지:
  1. 그대로(쿼리마다 collate 명시): 새 원시 SQL을 쓸 때마다 같은 실수를 할 수 있다. 테스트 첫 연결만 다른 것도 남는다.
  2. **연결 collation을 설정으로 고정**: `driverOptions.charset`(mysql2가 연결할 때 보내는 collation, 대문자 이름) + 맨 위 `collate`(스키마 생성용). 모든 풀 연결이 테이블과 같아진다. 운영과 테스트 연결도 같아진다.
  3. 연결마다 `set names utf8mb4 collate …`를 보내는 훅(`onCreateConnection`): 2와 결과는 같지만 쿼리가 하나 더 나가고 코드가 길다.
- 결정: 2. `mikro-orm.config.ts`에 `driverOptions: { charset: 'UTF8MB4_0900_AI_CI' }`, `collate: 'utf8mb4_0900_ai_ci'`.
  - 쿼리의 JSON_TABLE 열 정의의 `collate utf8mb4_0900_ai_ci`는 남긴다(방어). 연결 설정을 거치지 않는 경로(MySQL 클라이언트로 같은 쿼리를 돌리기, 설정을 실수로 바꾸기)에서도 쿼리가 같은 뜻이고, 인덱스(eq_ref)를 쓰는 것이 쿼리만 보고도 보인다. 빼도 지금은 통과하는 것을 확인했다(아래).
- 확인:
  - 테스트 `test/connection-collation.e2e.spec.ts`: resetDatabase를 부르지 않는 앱에서 트랜잭션 4개를 동시에 열어 서로 다른 연결 4개의 `@@collation_connection`을 본다. 설정 전 `expected [ 'utf8mb4_unicode_ci', …(3) ] to deeply equal [ 'utf8mb4_0900_ai_ci', …(3) ]`(연결 id 4개 서로 다름), 설정 후 통과.
  - 되돌린 실험: 설정을 넣은 상태에서 대조 서비스의 JSON_TABLE 열 3곳(missing 1, unexpected 2)의 `collate`를 모두 빼고 `npx vitest run test/reconciliation.e2e.spec.ts` 3회 → 3회 모두 `Tests 5 passed (5)`(전에는 마감 경합 테스트가 500). 되돌림.
  - MySQL 클라이언트(테스트 DB, 읽기만): `set collation_connection=utf8mb4_0900_ai_ci`에서 collate 없는 JSON_TABLE 열로 EXPLAIN → `t | eq_ref | terminal_serial_no_unique | ref n.s`(collate를 적었을 때와 같음).
  - `db:migration:check` → `최신 상태`(맨 위 `collate`가 스키마 차이를 만들지 않음. 테이블이 이미 0900_ai_ci).
- 결과·대가: PAD 속성이 바뀐다. `utf8mb4_unicode_ci`는 PAD SPACE(`'a' = 'a '`가 참), `utf8mb4_0900_ai_ci`는 NO PAD(거짓). MySQL 클라이언트에서 `select 'a'='a '` → 0900_ai_ci 연결 0, unicode_ci 연결 1. 영향은 연결 collation을 쓰는 비교뿐이다: 글자 상수·바인드 값끼리의 비교, JSON_TABLE 열. 테이블 열과 바인드 값을 비교할 때는 원래 열의 collation(IMPLICIT)이 이기므로 전부터 0900_ai_ci(NO PAD)였다. 우리 원시 SQL(대조 3개, 검수 통계 1개)은 테이블 열과 값, 또는 collate를 적은 JSON_TABLE 열과 상수(`r.result = 'NOT_IN_DELIVERY_NOTE'`)의 비교라 바뀌는 것이 없고, 시리얼은 입구에서 공백을 다듬는다. 설정만 바꾼 상태에서 전체 테스트 27개 파일 184 passed(이전 183 + 이 테스트 1), 실패나 결과 차이 없음.
- 다시 볼 조건: 테이블 collation을 바꾸거나, MariaDB 등 다른 서버로 옮기거나, MikroORM이 맨 위 `collate`를 연결에 넘기게 바뀌면.
- 갱신(2026-10-23 Day 4): 이 결정 전에 만든 마이그레이션의 create table 13개(`grep`으로 셈. Day 1~2 테이블 11개, purchase_order `Migration20261023021402`, scan_batch `Migration20261023023713` 포함)는 `default character set utf8mb4`만 적고 collate를 적지 않아 서버 기본값(`--collation-server=utf8mb4_0900_ai_ci`, docker-compose.yml)에 기댄다. `Migration20261023032255`(service_ticket)부터는 `collate utf8mb4_0900_ai_ci`가 붙는다. 서버 기본값이 다른 MySQL에 체인을 적용하면 앞의 13개만 다른 collation이 될 수 있다(Day 3 리뷰 Minor 5). 지금은 고치지 않는다(같은 docker-compose로만 띄운다).
