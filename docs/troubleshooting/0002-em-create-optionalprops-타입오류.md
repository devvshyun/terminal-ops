# 0002. em.create에서 TS2345 "Property 'version' is missing"

- 날짜 / 관련 기능: 2026-10-22 / 계획 단계 스파이크 (F1 엔티티에 영향)
- 증상: `em.create(Terminal, { serialNo })`에서 TS2345 "Property 'version' is missing" 컴파일 오류.
- 가설: 1) 엔티티 속성 선언 방식 문제 2) MikroORM 7의 `em.create` 타입이 `!`로 선언한 속성을 필수로 요구한다
- 확인: 스파이크에서 기본값이 있는 속성(`status`, `version`)을 `[OptionalProps]`에 넣자 오류가 사라졌다 → 가설 2 확인. 런타임 테스트는 오류와 상관없이 통과했다.
- 원인: MikroORM 7의 `em.create`는 `!`로 선언한 속성을 필수 입력으로 본다.
- 해결: 기본값이 있는 속성을 `[OptionalProps]?: 'status' | 'version'`에 넣는다(엔티티 작성 Task에서 적용).
- 배운 것: swc는 타입을 검사하지 않아 테스트가 통과해도 타입 오류가 있을 수 있다. **`npm run typecheck`를 테스트와 따로 돌려야 한다.** → study/backlog.md
