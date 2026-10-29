# 0086. 시연 묶음은 따로 된 compose와 앱별 이미지로

- 날짜 / 관련 기능: 2026-10-29 / 보강 9, 통합 시연
- 상황: 시연에 프로세스가 열 개쯤 필요하다(MySQL·Redis·api·워커·가상 업체 서버·시뮬레이터·화면 일곱). 지금 `docker-compose.yml`은 개발용으로 MySQL·Redis만 띄우고 호스트 포트(3306·6379)를 연다 — 개발 DB(`terminal_ops`)와 테스트 DB가 그 안에 있다.
- 선택지(파일):
  1. **`docker-compose.demo.yml` 따로**(프로젝트 이름 `terminal-ops-demo`, 볼륨 따로) — 개발 DB를 건드리지 않고, 시연을 `down -v`로 통째로 지워도 개발 데이터가 남는다
  2. 같은 파일에 profile로 — 같은 MySQL 컨테이너를 써서 시연 데이터가 개발 DB에 섞이고, 개발 compose의 호스트 포트가 시연에도 열린다
- 선택지(화면): 앱마다 nginx 컨테이너 / **nginx 하나에 일곱 앱(호스트 이름별, decisions/0088)** / Vite preview(개발 서버 — 시연에 맞지 않다)
- 결정: 파일 1, 화면 nginx 하나.
  - 이미지 넷: `apps/api/Dockerfile`(migrate·api·worker·demo-seed가 명령만 바꿔 쓴다), `apps/partners/Dockerfile`, `apps/device-sim/Dockerfile`, `infra/docker/web.Dockerfile`(일곱 앱 빌드 + nginx). 모두 빌드 컨텍스트는 저장소 루트(`packages/contracts`를 `file:` 의존으로 읽는다), 두 단계(빌드 → 실행, devDependencies 뺌)
  - 기동 순서는 `depends_on` 조건으로: mysql healthy → migrate(마이그레이션 + 기준·시연 계정·시연 키) 완료 → api healthy·worker 시작 → demo-seed(decisions/0089). api는 HTTP와 주기 작업 등록, worker는 큐 처리(RUN_WORKERS·RUN_SCHEDULERS로 나눔, decisions/0015)
  - `NODE_ENV=production`을 두지 않는다 — 시연 계정·데이터가 들어가야 한다(0054의 운영 막기 그대로)
  - 프록시 뒤에서 빌드할 때: 빌드 인자 `HTTPS_PROXY`와 선택 비밀 `ca`(BuildKit `--secret id=ca`, `required=false`) — 넣지 않으면 그냥 빌드한다. 이 클라우드 컨테이너가 그렇게 빌드했다(devlog)
  - 시연에서 택배 수집이 빨리 보이게 `SWEEP_INTERVAL_MS=15000`만 바꾼다(나머지 env는 `.env` 그대로)
- 결과·대가: 처음 빌드는 화면 일곱의 `npm ci`·빌드로 몇 분 걸린다(걸린 시간은 재지 않았다). 이미지 크기 api 400MB·partners 247MB·device-sim 244MB·web 169MB(`docker images`). 화면끼리 건너가는 주소(웹 포트)는 빌드 때 박힌다 — 포트를 바꾸면 `WEB_PORT` 빌드 인자도 바꿔 다시 빌드한다. 개발 compose와 이름이 비슷해 헷갈릴 수 있다(README에 둘을 나눠 적는다).
- 다시 볼 조건: 운영 배포(이미지 저장소·HTTPS·비밀 관리 — 범위 밖), 시연을 다른 사람 서버에 올릴 때(0087).
