# 0003. test-app.ts에서 MikroORM 타입이 readonly 배열이라 TS2322

- 날짜 / 관련 기능: 2026-10-22 / Task 2 (테스트 헬퍼)
- 증상: 테스트는 3 passed인데 `npm run typecheck`가 실패했다.
  `test/helpers/test-app.ts(20,17): error TS2322: Type 'MySqlMikroORM<..., readonly (string | EntityClass ...)[]>' is not assignable to type 'MySqlMikroORM<..., (string | EntityClass ...)[]>'` (`'~entities'`가 readonly라서 mutable 배열에 못 넣는다는 내용)
- 가설: 1) `app.get(MikroORM)`이 설정에서 추론한 readonly 엔티티 배열 타입을 돌려준다 2) 런타임 문제다
- 확인: 런타임은 vitest 통과(swc는 타입을 검사하지 않음 → troubleshooting/0002와 같은 계열). `const orm: MikroORM = app.get(MikroORM);`로 타입을 명시하자 typecheck가 통과했다 → 가설 1 맞음
- 원인: `defineConfig`로 만든 설정에서 엔티티 목록이 readonly 배열로 추론되고, `TestApp.orm`의 `MikroORM`(기본 제네릭)과 맞지 않았다.
- 해결: 변수에 `MikroORM` 타입을 명시했다. 계획의 코드에서 이 한 줄만 바꿨다(이 커밋).
- 배운 것: 계획 코드를 그대로 옮겨도 typecheck에서 걸릴 수 있다. 테스트 통과만 믿지 않는다. → study/backlog.md
