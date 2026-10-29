# 보강 9 설계 — Docker 통합과 시연

- 날짜: 2026-10-29
- 범위: 보강 9(통합 시연 준비 마지막 묶음). 모든 앱을 명령 하나로 띄우는 시연용 compose, 기동 때 마이그레이션·시드, 시연 데이터, 시연 시나리오 문서, 처음부터 끝까지 리허설
- 구현 계획: `docs/plans/2026-10-29-docker-demo.md`
- 등장하는 회사·가맹점은 모두 가상이다. 시연 비밀번호·키는 `apps/api/src/db/seed-accounts.ts`에만 있다

## 1. 무엇을 왜

지금 시연하려면 MySQL·Redis(compose) + api·워커 + 가상 업체 서버 + 시뮬레이터 + 화면 일곱 개를 터미널마다 띄우고, 시연 데이터(운영 중 단말기·배송 중·A/S·VAN 어긋남)는 손으로 만든다. 화면 앱들이 localhost 포트만 달라 쿠키 `sid` 하나를 함께 써서, 한 화면에서 점주로 로그인하면 어드민도 점주가 된다(decisions/0074).

목표:
1. `cp .env.example .env`(DEVICE_API_KEY만 바꿈) → `docker compose -f docker-compose.demo.yml up -d --build` 하나로 모두 뜬다
2. 기동 때 마이그레이션·기준 데이터·시연 계정이 자동, 이어서 시연 데이터가 실제 API로 만들어진다(다시 띄워도 두 번 넣지 않는다)
3. 화면은 호스트 이름마다(`admin.localhost:8080` …) — 앱마다 쿠키가 따로다
4. 바깥에는 웹 8080 하나만, 127.0.0.1에만 연다
5. 시연 시나리오 문서(누가·어느 화면에서·무엇을 누르면·무엇이 보이나)와 리허설 기록

하지 않는 것: 운영 배포(HTTPS·비밀 관리·이미지 저장소), 데이터 나이 먹이기(7일 지난 배송 같은 이상 단말기 — 시각을 고치지 않는다, decisions/0089 결과·대가).

## 2. 구성

| 서비스 | 이미지 | 하는 일 | 바깥 포트 |
|---|---|---|---|
| mysql, redis | mysql:8.4, redis:7.4 | 개발 compose와 같은 설정, 볼륨은 따로 | 없음 |
| partners | `apps/partners/Dockerfile` | 가상 업체 서버 :4010 | 없음 |
| device-sim | `apps/device-sim/Dockerfile` | 시뮬레이터 :4020(시연 데이터가 설정·시작) | 없음 |
| migrate | api 이미지 | `migrate up` + `seed`(기준·시연 계정·시연 키) 한 번 | 없음 |
| api | api 이미지 | HTTP :3000, 주기 작업 등록(RUN_WORKERS=0) | 없음 |
| worker | api 이미지 | 큐 워커(`dist/worker.js`) | 없음 |
| demo-seed | api 이미지 | 시연 데이터(HTTP 시나리오) 한 번, 이미 있으면 건너뜀 | 없음 |
| web | `infra/docker/web.Dockerfile` | 화면 일곱 빌드 + nginx, 호스트 이름별 정적 파일, `/api` → api, 시연 도구 `/api/partners`·`/api/sim` | `127.0.0.1:8080` |

| 주소 | 화면 |
|---|---|
| `http://localhost:8080` | 소개 페이지 |
| `http://admin.localhost:8080` | 어드민 |
| `http://merchant.localhost:8080` | 매장 |
| `http://field.localhost:8080` | 현장 |
| `http://console.localhost:8080` | 운영 관제 |
| `http://developers.localhost:8080` | 개발자센터 |
| `http://sandbox.localhost:8080` | 시연 도구 |

## 3. 시연 데이터(demo-seed)
- 운영 중 단말기 12대(`DM-0001`~`0012`, 가맹점 셋에 4대씩) — 시뮬레이터가 이 시리얼로 하트비트를 보낸다(시작해 둔다)
- 재고 3, 입고(검수 전) 2, 배정 1, 배송 중 2(번개·느림보 — 워커의 택배 수집이 시간이 지나며 배송 완료로 바꾼다)
- A/S: 접수 1(강남김밥), 원격 점검 뒤 교체 출고 1(역삼카페)
- 발주: 세움전자 SN-100 10대(덜 보내기 2 켜고 낸 뒤 되돌림) — 입고 대조에서 부족이 보인다
- 펌웨어 SN-100 1.1.0 등록(배포는 시연 중에 만든다)
- 브릿지VAN 등록: 운영 중 12대 중 10대 + 가맹점이 다른 1대 → VAN 대조 실행 → 어긋남 둘(미등록 1·가맹점 다름 1)
- 지난주 주간 리포트 보내기 → 톡톡메신저에 메시지·첨부
- 외부 업체 "한올POS(가상)"와 키 하나(원문은 출력하지 않는다)

## 4. 검증
- 단위·e2e: 시연 데이터 스크립트가 테스트 api(e2e 앱)에 대해 끝까지 돌고, 두 번째 실행은 건너뛴다
- 이 컨테이너에서 `docker compose -f docker-compose.demo.yml up -d --build` → 모든 서비스 healthy·완료 → Playwright로 시나리오 문서 순서대로 리허설(호스트 이름별 로그인이 서로 안 섞이는지 포함)
