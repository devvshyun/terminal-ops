# 인계 — 로컬 세션에서 클라우드 세션으로 (2026-10-29)

이 문서는 로컬 PC에서 진행하던 작업을 클라우드 세션이 이어받도록 남긴다. 작업 규칙의 원문은 [CLAUDE.md](../CLAUDE.md), 기록 양식은 [docs/README.md](README.md), 전체 색인은 [docs/index.md](index.md)다.

## 1. 지금 상태
- master: 7일 계획(Day 1~7) + 보강 1~6이 병합돼 있다. 보강 목록과 남긴 것은 [회고 6장](retrospective.md)의 "7일 뒤 보강"에 있다.
  - 보강 1 공유 타입 패키지 `packages/contracts`(decisions/0047~0049)
  - 보강 2 로그인·권한(세션·역할 표·가맹점 범위·외부 업체 키·단말기 키, decisions/0050~0056)
  - 보강 3 매장 화면 `apps/merchant`(:5174, 0057~0060)
  - 보강 4 현장 화면 `apps/field`(:5175, 0061~0064)
  - 보강 5 통합 어드민 확장(단말기 등록·펌웨어·배포 만들기·계정·다른 화면 바로가기, 0066~0069)
  - 보강 6 운영 관제 화면 `apps/console`(:5176, 0070~0076): `/ops` 읽기(큐·주기 작업·프로세스 상태·Outbox·최근 오류, Redis 시간 제한 2초), 관제 작업(실패 job 다시 시도·지우기, Outbox 복구 sweep — MONITOR만, ADMIN은 보기만), 감사 기록 `ops_action_log`, job data 가리기
  - 공개 저장소에 올리기 전 이력 정리(0065)
- 테스트 수와 실행 방법은 [README](../README.md)의 "실행"·"테스트" 절.

### 클라우드 세션이 이어서 한 것(2026-10-29)
- 디자인 1(현장·매장·소개 페이지)은 보강 6과 합쳐 PR [devvshyun/terminal-ops#1](https://github.com/devvshyun/terminal-ops/pull/1)로 master에 병합했다(번호는 위 안내대로 0077·0078로 바꿈, 작성자는 사용자 결정으로 그대로).
- 디자인 2(어드민·관제, 0079)와 **보강 7 개발자센터**(`apps/developers` :5178, 0080~0083)는 지정 브랜치 `claude/stoic-tesla-rm7xpo`에서 PR [devvshyun/terminal-ops#2](https://github.com/devvshyun/terminal-ops/pull/2)로 master에 병합됐다. 최종 검토는 [reviews/2026-10-29-developer-center-final-review.md](reviews/2026-10-29-developer-center-final-review.md).
- **보강 8 시연 도구**(`apps/sandbox` :5179, 0084·0085)도 같은 브랜치에 이어 쌓았다(PR #2, 병합됨). 최종 검토는 [reviews/2026-10-29-sandbox-final-review.md](reviews/2026-10-29-sandbox-final-review.md).
- **보강 9 시연 묶음**: `docker compose -f docker-compose.demo.yml up -d --build` 하나로 모두 뜨고 시연 데이터까지 들어간다. 화면은 `*.localhost:8080`(앱마다 쿠키 따로), 시나리오는 [demo.md](demo.md). 최종 검토는 [reviews/2026-10-29-docker-demo-final-review.md](reviews/2026-10-29-docker-demo-final-review.md).
- **시연 리허설 반영(2026-10-30)**: 로컬 컨트롤러가 Windows에서 14단계를 모두 돌린 결과로 `docs/demo.md`(8단계 DM-0004, 429 켜기를 7번 출고 바로 앞 6번으로, 시연 데이터 표, Chrome·Edge 권장), 시연 데이터 요약(troubleshooting/0036), api 버전 빌드 인자(0090)를 고쳤다. 기록은 [devlog 2026-10-30](devlog/2026-10-30.md).
- 2026-10-30 시연 데이터 "지난 일"(decisions/0091): 띄운 직후 처음 화면의 장기 오프라인·배송 완료 후 미설치·열린 이상·진행 중 배포가 0이 아니게 — DM-0021·0022 두 대만 시각을 옮기고 찾기를 한 번, SN-200 배포 하나를 멈춰 둔다. 시연 문서 [demo.md](demo.md) 1장 표.
- **보강 10 시연 홈**(`apps/demo-home`, `demo.localhost:8080`·개발 :5180, 0092): 시나리오 7막을 단계마다 설명 + 실행 + 결과로. 스펙 [specs/2026-10-30-demo-home.md](specs/2026-10-30-demo-home.md)
- **보강 11 녹화 재생본**(GitHub Pages, 0093·0094): 시연 홈을 서버 없이 — 녹화기 `apps/demo-home/scripts/record.cjs`, 재생본 `npm run build:replay`, 배포 `.github/workflows/pages.yml`(처음 한 번 Settings → Pages → Source "GitHub Actions"). 화면·API를 바꾸면 녹화본을 다시 찍는다. 과정 [making/2026-10-30-demo-replay.md](making/2026-10-30-demo-replay.md)
- 클라우드 컨테이너는 재시작되면 dockerd가 꺼진다 — `dockerd`를 띄우고 `docker start terminal-ops-mysql terminal-ops-redis`. Docker Hub가 429를 주면 `mirror.gcr.io`에서 받아 이름을 붙였다.

### 클라우드 디자인 브랜치를 합칠 때(먼저 할 일)
- 클라우드 세션의 `claude/stoic-tesla-rm7xpo`(디자인: 현장·매장 화면, 소개 페이지 `apps/landing`)는 보강 5 병합 커밋 `10a3f6c`에서 갈라졌고, 그 뒤 master에 보강 6이 들어왔다. 이 로컬 세션은 그 브랜치를 합치지 않았다.
- 번호가 겹친다: 그 브랜치의 decisions 0070(화면 디자인 토큰)·0071(소개 페이지)이 master의 보강 6 decisions 0070~0076과 같은 번호다. master를 받아 합칠 때 그쪽 두 기록을 **0077·0078**로 바꾸고, 그 번호를 가리키는 링크(devlog·backlog·index)도 고친 뒤 `node scripts/docs-index.mjs`. troubleshooting 0033·experiments 0018은 master에서 아직 안 써서 그대로 둬도 된다.
- `docs/devlog/2026-10-29.md`·`docs/index.md`·`docs/study/backlog.md`는 양쪽이 모두 뒤에 덧붙였으니 충돌이 나면 두 쪽 항목을 시각 순으로 모두 남긴다.
- 그 브랜치의 커밋 작성자는 `Claude <noreply@anthropic.com>`이다. 사용자 작성자 규칙(0065: GitHub noreply)과 다르니, 사용자에게 그대로 둘지 물어본다.

## 2. 남은 일 — 통합 시연 준비(사용자 목표)
사용자가 원하는 시연: 페르소나별 프로그램을 모두 준비해 시나리오대로 한 번에 시연. 시나리오 점검표는 [보강 5 스펙 2장](specs/2026-10-29-admin-expansion.md).
1. ~~보강 7 외부 연동 개발자센터~~ — 했다(위 "클라우드 세션이 이어서 한 것", PR #2).
2. ~~보강 8 가상 업체 콘솔 + 단말기 시뮬레이터 화면~~ — 했다(PR #2). 원래 적은 범위: `apps/partners`(세움·번개·느림보·브릿지VAN·톡톡)가 받은 요청·보낸 메시지를 보고 장애(429·지연·5xx)를 켜고 끄는 화면, `apps/device-sim`의 하트비트·오프라인·펌웨어 실패를 버튼으로 조작하는 화면. 두 서버에는 지금 관리 API(`/__admin/*`)만 있다.
3. ~~보강 9 Docker 통합과 시연~~ — 했다(`docker-compose.demo.yml`, `docs/demo.md`, 0086~0089). 원래 적은 범위: 모든 앱의 Dockerfile + compose(지금 compose는 MySQL·Redis만), 기동 때 마이그레이션·시연 시드 자동, 시연용 시드 데이터(시나리오가 바로 굴러가는 단말기·발주·A/S·배포·이상·VAN 어긋남·지난주 리포트), 시연 시나리오 문서, 처음부터 끝까지 리허설. 같은 사이트 쿠키 공유(0057·0061)는 Docker에서 앱마다 다른 호스트명을 쓰면 풀린다 — 결정 기록.
4. 보강 6에서 남긴 것: 실패 job 지우기의 경합(다시 시도 직후 다른 관제가 지우면 다시 넣은 job이 지워짐, 0072·0073에 대가로 기록), 실패 이유 글은 전화번호·이메일 모양만 가림, 로컬에서는 :5173~5179 앱이 `sid` 쿠키 하나를 함께 씀(한 곳에서 로그아웃하면 모두 로그아웃, 0074 — Docker 묶음에서 호스트 이름을 나누면 풀림). 상세는 [보강 6 최종 리뷰](reviews/2026-10-29-ops-console-final-review.md).
5. 회고 6장의 이월(선택): CSRF 토큰, 다른 탭 사용자 변경 감지, `MaxListenersExceededWarning`, 회수 뒤 `terminal.merchant` 등.

## 3. 일하는 방식(지금까지)
- 묶음마다 브랜치 → 브리프 → 계획 작성(스펙 `docs/specs/`, 계획 `docs/plans/`, 계획 코드를 저장소 복사본에 실제로 적용해 테스트·빌드로 사전 검증) → Task별 구현(TDD: 실패 출력을 devlog에) → Task별 리뷰 → 리뷰 수정은 다음 Task 첫 커밋에 → 마감 Task(전체 검증·실서버 확인·README·회고·devlog 요약) → 화면 확인 → 브랜치 최종 리뷰(`docs/reviews/`) → 수정 → master 병합 → push.
- 기록 규칙(CLAUDE.md): devlog `docs/devlog/YYYY-MM-DD.md`, 제목 시각 = 커밋 시각(자기 해시는 "커밋 = 이 항목이 든 커밋", 다음 항목이 "이전 커밋"으로 적는다), 결정·트러블슈팅·실험은 다음 번호로, 색인은 `node scripts/docs-index.mjs`(검사 `--check`).
- 커밋: `type(Fn|auth|admin|merchant|field|ops|…): 요약`, 트레일러 `Co-Authored-By`. 작성자는 GitHub noreply 주소(0065) — 개인 이메일·지난 프로젝트·실제 업체 이름을 넣지 않는다. 등장하는 회사는 모두 가상.
- 테스트 수는 실제로 돌려 센 값만 적는다. 화면은 휴대폰 앱이면 375×812로 확인.

## 4. 안전 규칙
- 프로세스는 PID로만 끈다(이미지 이름으로 일괄 종료 금지). Redis FLUSH 금지(접두사 키만 지운다). api 테스트는 테스트 DB `terminal_ops_test`와 테스트 접두사만 쓰고, 두 개를 동시에 돌리지 않는다. 개발 DB는 migrate·seed·실서버 확인만.
- 시연 계정 비밀번호·외부 업체 시연 키는 `apps/api/src/db/seed-accounts.ts`에만 있다(로컬 시연 전용, 운영에서는 시드가 넣지 않음). 문서·로그·응답에 옮기지 않는다. 실제 비밀 값(.env의 `DEVICE_API_KEY` 등)은 커밋하지 않는다(.gitignore).
- 커밋되는 파일은 LF(autocrlf). CR이 섞이면 diff가 통째로 바뀐다(보강 5 최종 리뷰 Minor 1).

## 5. 환경 메모
- Node 24, MySQL 8.4·Redis 7.4(docker compose), 포트: api 3000, partners 4010, device-sim 4020, admin 5173, merchant 5174, field 5175, console 5176(미리보기 4176), landing 5177(4177), developers 5178(4178), sandbox 5179(4179), demo-home 5180(4180), 테스트용 partners 4011.
- 로컬 PC 전용 사정(클라우드에는 해당 없을 수 있음): Windows Git Bash에서 heredoc 따옴표가 깨짐(troubleshooting/0024), python3 호출이 멈춤, `.claude/launch.json`은 이 PC 절대 경로라 커밋하지 않음.
- 클라우드 환경에 Docker가 없으면 MySQL·Redis 기반 api 테스트를 돌릴 수 없다 — 그 경우 화면(Vitest)·타입 검사 위주로 하고, 서버 쪽 변경은 테스트 실행 여부를 devlog에 정직하게 적는다.
