# 보강 9 구현 계획 — Docker 통합과 시연

- 스펙: `docs/specs/2026-10-29-docker-demo.md`
- 방식: 테스트를 먼저 쓰고 구현 전에 돌린다. 고친 코드를 되돌려 테스트가 실패하는지 본다.

## Task 1. 컨테이너 안에서 듣기
- partners·device-sim이 `PARTNERS_HOST`·`DEVICE_SIM_HOST`(기본 127.0.0.1 그대로)로 듣는 주소를 바꾼다. 컨테이너에서는 0.0.0.0

## Task 2. 시연 데이터 스크립트 `apps/api/src/db/seed-scenario.ts`
- api 주소·가상 업체·시뮬레이터 주소를 env로. 시연 계정으로 로그인(쿠키), 실제 API만 쓴다
- 이미 있으면(DM-0001) 건너뜀
- e2e `test/seed-scenario.e2e.spec.ts`: 테스트 앱을 포트로 띄우고 스크립트 함수를 돌린다

## Task 3. 이미지와 compose
- `apps/api/Dockerfile`(빌드 → 실행, 컨텍스트 저장소 루트), `apps/partners/Dockerfile`, `apps/device-sim/Dockerfile`, `infra/docker/web.Dockerfile` + `infra/docker/nginx.conf`
- 프록시 뒤에서 빌드할 때: 빌드 인자 `HTTPS_PROXY`, 선택 비밀 `ca`(npm이 믿을 CA). 넣지 않으면 그냥 빌드
- `docker-compose.demo.yml`, `.dockerignore`

## Task 4. 리허설과 마감
- 이 컨테이너에서 띄우고 Playwright로 시나리오 순서대로 — `docs/demo.md`(시나리오), 리허설 결과는 devlog
- README·인계·회고·최종 검토, push, PR
