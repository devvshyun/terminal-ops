# 0006. globalSetup에서 던진 오류 메시지가 `code.charCodeAt is not a function`으로 가려짐

- 날짜 / 관련 기능: 2026-10-22 / F3(테스트 환경)
- 증상: 테스트용 partners 포트(4011)에 서버를 미리 띄우고 `npx vitest run test/unit/retry-policy.spec.ts`를 실행하면 exit 1로 끝나지만, globalSetup이 던진 "이미 서버가 떠 있습니다" 메시지는 출력에 없다. 대신 아래가 나온다.
  ```
  No test files found, exiting with code 1
  ...
  ⎯⎯⎯⎯⎯⎯⎯ Startup Error ⎯⎯⎯⎯⎯⎯⎯⎯
  TypeError: code.charCodeAt is not a function
      at extractInlineSourceMap (.../vite/dist/node/module-runner.js:366:57)
      ...
      at parseErrorStacktrace (.../vitest/dist/chunks/source-map.DdKI5IHB.js:1736:21)
      at printErrorInner (.../vitest/dist/chunks/index.1TqnEahn.js:3312:25)
  ```
- 가설: 1) 이번에 바꾼 global-setup.ts 순서 때문이다 2) vitest가 globalSetup 오류의 스택을 소스맵으로 바꾸다가 실패해 원래 오류 대신 그 실패를 찍는다
- 확인: HEAD(b558f60)의 global-setup.ts로 되돌려 같은 조건으로 실행해도 같은 `charCodeAt` 출력이 나왔다 → 가설 1 기각. 스택이 vitest의 `parseErrorStacktrace` → vite `extractInlineSourceMap`에서 끝나므로 가설 2 쪽이지만, 왜 `code`가 문자열이 아닌지는 확인하지 않았다(추측).
- 원인: 확인 못 함. 오류를 출력하는 단계의 문제이고, 동작(실행 중단, exit 1)은 맞다.
- 해결: 이번에는 고치지 않는다. 같은 조건에서 exit 1이 나고 Redis `test-*` 키가 남아 있는 것(포트 확인이 키 정리보다 먼저)은 직접 확인했다. 메시지가 안 보이면 `netstat -ano | grep :4011`로 포트를 먼저 본다.
- 배운 것: → study/backlog.md에 추가
