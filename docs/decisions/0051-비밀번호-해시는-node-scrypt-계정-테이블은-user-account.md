# 0051. 비밀번호 해시는 node:crypto scrypt, 계정 테이블은 user_account

- 날짜 / 관련 기능: 2026-10-28 / 보강 2(로그인), decisions/0050·0052
- 상황: 사람 로그인을 위해 계정과 비밀번호를 저장해야 한다. 역할은 다섯(ADMIN·OPERATOR·MONITOR·FIELD·MERCHANT)이고 가맹점주는 가맹점 하나에 묶인다. 학습·로컬 시연용이지만 비밀번호 원문이나 빠른 해시(SHA-256 등)로 두지는 않는다.
- 선택지(해시):
  1. `bcrypt` 패키지 — 장점: 널리 쓰임. 단점: 네이티브 빌드(Windows node-gyp), 72바이트 넘는 비밀번호를 잘라 쓴다, 새 의존성
  2. `bcryptjs` — 장점: 순수 JS. 단점: 같은 비용에서 느리고 해시 계산이 이벤트 루프를 붙잡는다, 새 의존성
  3. `argon2` 패키지(argon2id) — 장점: OWASP 첫 권고. 단점: 네이티브 바이너리 의존성, 이 프로젝트의 "새 의존성 없이" 흐름(보강 1)과 맞지 않음
  4. **node:crypto `scrypt`** — 장점: 의존성 0, libuv 스레드풀에서 돌아 이벤트 루프를 막지 않는다, OWASP 비밀번호 저장 권고표에 scrypt 비용 조합이 있다. 단점: argon2id보다 한 단계 아래 권고, 비용 매개변수를 직접 관리
- 측정(이 PC, `crypto.scryptSync` 5회 평균): N=2^14·r=8·p=1 26ms, N=2^15·p=1 51ms, **N=2^15·p=3 142ms**, N=2^16·p=1 109ms. N=2^15는 메모리 128·N·r = 32MiB로 node 기본 `maxmem`(32MiB) 경계라 `maxmem` 64MiB를 준다.
- 결정: 4. N=2^15·r=8·p=3(OWASP 표의 한 줄), 소금 16바이트, 키 64바이트. 저장 형식 `scrypt$N$r$p$salt$hash`(base64) — 비용을 올려도 옛 해시를 그 값으로 확인한다. 비교는 `timingSafeEqual`. 없는 아이디로 로그인해도 가짜 해시 하나만큼 시간을 쓴다(응답 시간으로 아이디 유무를 알아내지 못하게).
- 선택지(테이블 이름): `operator_account`(가맹점주도 들어가 이름이 틀린다), `account`(너무 넓다), `user`(다른 DB에서 예약어) → **`user_account`**. 열: `login_id`(unique, 영문 소문자·숫자·`.`·`-`·`_` 3~50자 — 이력 actor로 남으므로 바꾸지 않는다), `display_name`, `password_hash`, `role`(enum), `merchant_id`(FK, nullable), `disabled_at`, `last_login_at`, 시각들.
- "MERCHANT ⇔ 가맹점 있음"은 서비스(AccountService, Task 5)가 지킨다. DB CHECK 제약은 두지 않았다 — 테스트의 `schema.refresh`(엔티티 기준)와 마이그레이션 두 곳에 같은 제약을 손으로 맞춰야 한다.
- 시연 계정: 역할마다 하나 + 가맹점주는 시드 가맹점 세 곳에 하나씩, 모두 7개. 비밀번호는 `src/db/seed-accounts.ts`에 고정한 테스트 값(README "로컬 시연 전용 값"). 테스트(`resetDatabase`)는 이 계정을 넣지 않는다 — 해시 7번(약 1초)을 파일마다 쓰지 않게, 필요한 테스트가 직접 만든다.
- 결과·대가: 로그인 한 번에 약 140ms·32MiB. 동시 로그인이 libuv 스레드풀(기본 4)을 다투면 줄을 선다 — 로그인 실패 제한(0050)이 무차별 대입은 막는다. 저장소에 공개된 시연 비밀번호는 로컬 시연 밖에서 쓰면 안 된다.
- 다시 볼 조건: 실제 서비스로 내보낼 때(argon2id, 비밀번호 정책, 재해시), 동시 로그인이 많아질 때(`UV_THREADPOOL_SIZE`), 계정 행을 손으로 고치는 일이 생기면(DB CHECK).
