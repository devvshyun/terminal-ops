# 0002. ESM + Vitest + tsc 빌드로 API를 만든다

- 날짜 / 관련 기능: 2026-10-22 / 전체 (API 골격)
- 상황: Nest 12와 MikroORM 7은 ESM 전용 패키지다. Nest CLI는 Node 24.15 이상이 필요한데 이 PC는 24.13.1이다.
- 선택지:
  1. CommonJS + Jest — 익숙한 조합이다 / `require(esm)`에 기대야 하고, Jest가 ESM 패키지를 불러오는 데 제약이 있다
  2. ESM + Vitest + tsc 빌드 — Nest가 ESM 프로젝트의 기본으로 권장한다 / import 경로에 `.js`를 붙여야 한다
  3. Node를 올린 뒤 Nest CLI 사용 — `nest generate`를 쓸 수 있다 / 설치 작업이 늘어나고 이점이 적다
- 결정: 2. 테스트는 Vitest + unplugin-swc(데코레이터 메타데이터 때문), 빌드는 `tsc -p tsconfig.build.json`.
- 결과·대가: `nest generate`를 못 쓰니 파일을 직접 만든다. 상대 import에 `.js` 확장자를 쓴다.
- 다시 볼 조건: Node를 24.15 이상으로 올리면 CLI 사용을 검토한다.
