# 0038. Redis가 꺼져 있으면 vitest가 `code.charCodeAt is not a function`으로 시작하지 못한다

- 날짜 / 관련 기능: 2026-10-30 / 시연 데이터 지난 일(decisions/0091) 작업 중, api 테스트
- 증상: 새 클라우드 컨테이너에서 `npx vitest run test/unit/scenario-past.spec.ts`(DB를 쓰지 않는 단위 테스트)가 테스트를 하나도 돌리지 않고 멈췄다.
  ```
  ⎯⎯⎯⎯⎯⎯⎯ Startup Error ⎯⎯⎯⎯⎯⎯⎯⎯
  TypeError: code.charCodeAt is not a function
      at extractInlineSourceMap (…/vite/dist/node/module-runner.js:366:57)
  ```
- 가설: 1) 새 테스트 파일의 문법·import 문제 2) `.env`가 없어 env 읽기 실패 3) `globalSetup`(test/global-setup.ts)이 MySQL·Redis에 붙지 못해 실패했는데, 그 오류의 스택을 그리던 vite가 다시 실패해 원래 오류를 가렸다
- 확인:
  - `.env`를 만들고 `docker compose up -d --wait`(MySQL·Redis) 뒤에는 같은 명령이 `Tests  7 passed (7)` → 1 기각
  - 그 상태에서 `env -u MYSQL_USER npx vitest run …` → 통과(단위 테스트는 MySQL env 없이 돈다) → 2는 이 증상의 원인이 아님
  - `docker stop terminal-ops-redis` 뒤 다시 → `[ioredis] Unhandled error event: Error: connect ECONNREFUSED 127.0.0.1:6379` 다음 줄에 같은 `Startup Error … code.charCodeAt` → 3 확인(Redis)
  - `docker stop terminal-ops-mysql`(Redis는 켬) 뒤 → 통과 → globalSetup의 MySQL은 이 증상과 무관
- 원인: globalSetup이 테스트 접두사 키를 지우려고 Redis에 붙는다. 붙지 못한 오류가 vitest의 시작 오류로 올라가고, 그 스택 위치를 소스맵으로 바꾸던 vite module-runner가 문자열이 아닌 값을 받아 TypeError를 던져 원래 오류(ECONNREFUSED)는 위의 ioredis 한 줄로만 남는다. (vite 쪽에서 왜 문자열이 아닌지는 확인하지 않았다 — 추측)
- 해결: 코드 변경 없음. 테스트 전에 `docker compose up -d --wait`. 이 오류를 보면 위의 `[ioredis]` 줄부터 본다
- 배운 것: → study/backlog.md(vitest globalSetup 오류와 소스맵 스택 변환)
