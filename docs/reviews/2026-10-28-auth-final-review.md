# 보강 2(로그인·권한) 최종 리뷰 (2026-10-28)

- 범위: `7487fe4..b98303a` (auth-roles, 커밋 12개: docs 2, feat 5, fix 5). 144파일, +10,778 / −434(그중 계획 문서 5,701줄)
- 판정: **병합 가능(기록 보탬 권장)**. Critical과 Important는 없다. Minor 7건은 기록 정합성 셋, 로컬 `.env` 키 하나, 마지막 ADMIN 판단의 남은 틈(이론상), down 미검증, 작은 것들이다. 병합 전에 Minor 1(devlog 시각)과 Minor 3(회고 6장)은 한 줄씩이라 같이 고치길 권한다
- 이번 리뷰가 특히 본 것: Task별 리뷰를 거치지 않은 마지막 세 커밋 ba1a775, 6fb4ac5, b98303a와 브랜치 전체에 걸친 것(인증 모델, 접근 규칙 누락, 계약, 마이그레이션, README, 기록)

## 범위
- 계정·비밀번호(eb44276): `user_account`, scrypt, 시연 계정 시드, 계약 `auth.ts`(decisions/0051)
- 세션·가드·역할 표(b854393, 1e3022a)
  - Redis 서버 세션, httpOnly·SameSite=Strict 쿠키 `sid`, 세대값·절대 만료 7일, JSON만 받는 로그인, 아이디별 실패 제한(정규화·원자 예약)(decisions/0050)
  - 전역 `AuthGuard` 기본 거부. 핸들러마다 `@Public`·`@Roles`·`@DeviceAuth`·`@PartnerAuth` 중 하나. 표 전수 검사 `access-table.spec.ts`(decisions/0052)
  - 작업자 = 로그인 아이디. `X-Operator`·`X-Test-Role`은 `NODE_ENV=test`에서만 켜지는 테스트 전용 길(decisions/0056)
- 어드민(bc1b1cc, c76401f): 로그인 화면, `AuthGate`·`RequireRole`, 역할별 메뉴·버튼, 사용자가 바뀌면 캐시 비우기, `OperatorBar` 삭제
- 단말기 키(af2e26e): `X-Device-Key` 공유 키, device-sim이 보냄, 실험 0017(decisions/0055)
- 가맹점주 범위(2076a45): `/me` 다섯 엔드포인트, 서비스 `scope` 인자, 범위 밖 404(decisions/0053)
- 계정 관리·외부 업체 키(e682c1b): `/admin/accounts`·`/admin/partner-keys`, `/partner/v1` 두 scope, 시연 키, 마지막 활성 ADMIN 보호(decisions/0054)
- 마지막 세 커밋
  - ba1a775: device-sim 가린 키 되돌림·ASCII 규칙, `.env.example` 자리표시자, `/me` 접수 응답 `MerchantTicketView`, 옛 세션 지우기 실패 허용, JSON 빈 본문 400 고정
  - 6fb4ac5: 키 접두사 겹침 재시도, `expiresAt` 엄격·미래만, 마지막 ADMIN 판단을 잠근 행으로, 운영에서 시연 시드 안 함(`demoSeedAllowed`)
  - b98303a: 어드민 `LAST_ADMIN` 안내, decisions/0001 대체 표시, README "로그인과 역할" 절, 색인, 회고, troubleshooting/0032, `.gitignore`
- 기록: decisions 0050~0056, troubleshooting 0030~0032, experiments 0017, devlog `2026-10-28.md` 12항목과 "보강 2 요약", 공부거리

## 검증 결과 (리뷰어가 직접 실행)
- api(테스트 DB를 `DROP/CREATE` 한 번으로 다시 만든 뒤)
  - `npx vitest run`: `Test Files 78 passed (78)`, `Tests 544 passed (544)`, 302.25초. `Connection is closed` 0줄, `MaxListenersExceededWarning` 7줄(Day 1부터 있던 경고, 회고 6장 이월)
  - `npx tsc --noEmit -p tsconfig.json`: exit 0
- admin `npx vitest run`: `Test Files 14 passed (14)`, `Tests 125 passed (125)`, 6.35초. `tsc --noEmit -p .` exit 0
- device-sim `npx vitest run`: `5 passed (5)` / `45 passed (45)`. tsc exit 0
- partners `npx vitest run`: `6 passed (6)` / `53 passed (53)`
- README 테스트 표(api 78/544, admin 14/125, device-sim 5/45, partners 6/53)와 위 결과가 같다
- `node scripts/docs-index.mjs --check`: `docs/index.md 최신`(exit 0)
- 프로세스: 시작 전 node PID 43936·35448·28868·26108(리뷰어가 띄운 것 아님). 리뷰어 실행은 모두 foreground로 끝났고 남은 node 프로세스는 시작 전과 같다. Redis는 건드리지 않았다(테스트가 자기 접두사 키를 지운다)
- 기록 정합성
  - 번호: decisions 56(0050~0056), troubleshooting 32(0030~0032), experiments 17(0017). 빈 번호·중복 없음. README "결정 56·트러블슈팅 32·실험 17"과 `docs/index.md` 절 제목 수가 같다
  - devlog 제목 시각 12곳 중 11곳이 커밋 시각(`%ad`, `%H:%M`)과 같다. c76401f(09:00:42)만 제목이 09:03이다(Minor 1)
  - README·회고·devlog·decisions 0001·0041·0050~0056·troubleshooting 0032·실험 0017의 마크다운 링크와 `apps/…` 경로 263개를 스크립트로 전수 검사했다. 없는 것 0
  - decisions/0052 표와 `access-table.spec.ts`의 `EXPECTED`가 줄 단위로 같다. 68개이고, 0052 "상황"의 "보강 2 끝 예상 68개"와도 같다
  - README 실험 0017 줄의 숫자(5,636 → 5,451/s −3.3%, 사전 4,023 → 3,824/s −4.9%, 묶음 −14.4%·−2.0%·+0.9% 평균 −5.4%)는 실험 기록 표와 같다
- 비밀 값 노출 검사(값은 출력하지 않고 위치만 셈)
  - 시연 비밀번호 7개와 시연 외부 업체 키: 추적 파일 중 `apps/api/src/db/seed-accounts.ts`와 `docs/plans/2026-10-28-auth-roles.md`에만 있다. README·decisions·devlog에는 없다. README는 비밀번호 대신 seed 파일을 가리키고, curl은 `grep -o`로 seed 파일에서 읽는다
  - 로컬 `.env`의 `DEVICE_API_KEY`: 계획 문서에 같은 값이 있다(Minor 2)
- 직접 하지 않은 것(지시에 따라)
  - 개발 DB 작업(migrate·seed·`db:migration:check`)과 실서버 기동. devlog 10:12 항목의 기록을 대조만 했다: 개발 DB에 두 마이그레이션 적용, 시드 멱등, 테스트 DB·개발 DB 실서버 curl 확인, 3100 포트 PID로 종료, `auth-live*` 12키 하나씩 DEL
  - 화면 확인: 컨트롤러가 개발 DB에서 내장 브라우저로 봤다
    - operator 로그인 → 처음 화면. 머리말에 표시 이름·역할, 메뉴 전체
    - 로그아웃 → `/login`
    - field 로그인 → `/scans`, 메뉴는 단말기·박스 스캔만
    - 콘솔은 로그인 전 `/auth/me` 401만, api 오류 로그 없음
    - 이 결과는 아직 devlog에 없다(Minor 1에 함께)

## Strengths
- **기본 거부가 구조와 테스트 두 겹으로 잠겨 있다.**
  - 가드는 핸들러 메타데이터만 읽는다. 규칙이 없으면 403, HTTP가 아닌 문맥은 `false`다
  - `access-table.spec.ts`는 `AppModule.forRoot({ workers: true, schedulers: true })`의 모듈 트리를 훑는다. 그래서 (a) 규칙 없는 핸들러 0, (b) 결정 기록의 표와 같음, (c) 훑기가 50개 넘게 찾음을 함께 본다
  - 리뷰어가 컨트롤러 22개, `main.ts`의 `app.use`·정적 파일을 따로 찾아봤다. 컨트롤러 밖으로 열린 경로는 없다
- **인증 길 넷이 서로 섞이지 않는다.** 사람(세션 쿠키), 테스트 헤더(쿠키가 없을 때만, `NODE_ENV=test`가 아니면 서버가 뜨지 않음), 단말기(SHA-256 + `timingSafeEqual`), 외부 업체(접두사로 한 행 + 해시 비교)다
  - 끝난 쿠키에 헤더를 붙여도 401이다
  - 사람 세션으로 `/partner/v1`을, 키로 사내 API를, 단말기 키로 사람 API를 부를 수 없다. 모두 e2e로 묶여 있다
- **세션 무효화가 경합까지 고려됐다.** 세대값을 먼저 `INCR`하고 색인을 지운다. 로그인은 계정 행보다 세대값을 먼저 읽는다. 세션 읽기는 Lua 하나로 세대·절대 만료·TTL 연장을 한다. 그리고 `destroyAllFor`는 DB 커밋 뒤에 부른다. 남는 틈("처리 중 요청 1건")도 0050에 적었다
- **가맹점주 범위가 "엔드포인트를 나누고 서비스에 scope를 넘기는" 한 방식으로 일관된다.**
  - 범위 밖은 없는 것과 같은 404 메시지다
  - A/S 접수는 잠근 단말기 행의 가맹점으로 확인한다
  - ba1a775가 응답 쪽 노출(직원 로그인 아이디, 내부 메모)까지 막았다. `toMerchantTicketView`가 필드를 하나씩 옮겨, `TicketView`에 필드가 늘어도 저절로 나가지 않는다. 계약 `MerchantTicketView`는 `Omit<TicketView, 'openedBy' | 'remoteNote'>`로 타입에서도 막는다
  - 직원 아이디를 가린 이유("로그인 아이디는 실패 제한의 단위라 남이 알면 잠글 수 있다")도 0053에 적었다
- **6fb4ac5의 마지막 ADMIN 수정이 정확하고, 실패 경위가 정직하다.**
  - REPEATABLE READ에서 `refresh`도 스냅샷이고 `FOR UPDATE`만 지금 값이라는 원인을 짚었다. 판단을 잠근 목록 하나로 옮겼다
  - 첫 재현 시도(MONITOR→ADMIN)가 통과했던 것도 devlog에 그대로 적었다
  - 재현 테스트는 `findOne` 직후 다른 연결이 커밋하게 만든다. 고치기 전 `[409, 'LAST_ADMIN']`을 실제로 봤다
- **시연 값 처리가 일관된다.**
  - 운영(`NODE_ENV=production`)에서는 시연 계정·키를 넣지 않고, 켜는 플래그도 두지 않았다(단위 테스트)
  - README는 비밀번호를 적지 않고 seed 파일을 가리킨다
  - `.env.example`의 단말기 키는 자리표시자다. 무작위 값을 만드는 한 줄도 있다
- **확인한 것과 추측을 끝까지 나눴다.** JSON 빈 본문을 보자
  - 리뷰는 415를 예상했다. 실제는 `Content-Length: 0`이 있으면 400, 길이 헤더가 없으면(curl) 415였다
  - 처음 0050에는 "추측"으로 적었다. 마감 실서버 확인 뒤 사실로 고쳤다
  - troubleshooting/0032도 "3(시드)은 확인 못 함", "`up`이 스냅샷을 쓰는 시점은 소스로 확인하지 않음"을 남겼다
- **기존 테스트 453개를 다섯 줄 수정으로 살렸다.** 테스트 길이 가드 안을 지나므로, 역할 판단과 기본 거부는 운영 길과 같은 코드를 탄다(`overrideGuard`를 버린 이유가 0056에 있다)

## Issues

### Critical
없음.

### Important
없음.

### Minor

1. **devlog 제목 시각 하나가 커밋과 다르고, 컨트롤러 화면 확인이 기록에 없다**
   - 위치: `docs/devlog/2026-10-28.md:65` "## 09:03 어드민 로그인 리뷰 반영"
   - 문제
     - 커밋 c76401f의 시각은 09:00:42다(author·committer 같음). 다른 11곳은 모두 맞는다
     - 위 "직접 하지 않은 것"의 컨트롤러 화면 확인(operator·field 로그인, 메뉴, 로그아웃, 콘솔)이 devlog에 없다. 10:12 항목의 실서버 확인은 curl뿐이다. Day 6·7 최종 리뷰 Minor와 같은 형태다
   - 수정
     - 제목을 `09:00`으로 고친다
     - 화면 확인 항목을 하나 덧붙인다(그 기록 커밋 시각으로 제목). 내용은 "받아 적은 것"이라는 표시, 확인한 화면과 역할, 콘솔 401만, 개발 DB 쓰기는 로그인의 `last_login_at`뿐이다
2. **로컬 `.env`의 `DEVICE_API_KEY`가 저장소에 공개된 값 그대로다**
   - 위치: 로컬 `.env`(추적 안 됨), `docs/plans/2026-10-28-auth-roles.md`, e682c1b까지의 `.env.example`
   - 문제
     - ba1a775가 `.env.example`을 자리표시자로 바꿨다. 하지만 devlog 09:56은 "로컬 `.env`도 그대로"라고 적었다
     - 그 값은 계획 문서와 git 기록(옛 `.env.example`)에 남아 있다. 리뷰어가 값을 출력하지 않고 위치만 셌다
     - 로컬 시연 전용 값이라 위험은 작다. 다만 "자리표시자 — 바꿔 쓴다"는 README 안내를 이 PC가 따르지 않는다
     - 자리표시자 자체(32자 ASCII)도 `requiredSecret`을 통과한다. 그래서 바꾸지 않고 복사만 해도 공개된 키로 뜬다
   - 수정
     - 로컬 `.env`의 값을 무작위 값으로 바꾼다. device-sim은 `--env-file`로 같은 값을 읽으므로 따로 할 일이 없다
     - (선택) `env.ts`가 자리표시자와 같은 값이면 시작할 때 던진다. 그러면 README의 "바꿔 쓴다"가 강제된다
     - 계획 문서의 값은 지난 기록이라 두되, devlog에 "계획·옛 예시 파일의 값은 폐기"를 한 줄 적는다
3. **회고가 로그인·권한을 아직 "없다"·"이월"로 적고 있다**
   - 위치: `docs/retrospective.md:36` "운영 배포·인증이 없다", `:71`(6장 첫 줄 "로그인·권한"), `:96`(같은 6장의 `[x] 보강 2`)
   - 문제
     - 3장과 6장 첫 줄은 7일 시점 그대로다. 같은 6장 아래에 `[x] 보강 2: 로그인·권한`이 있어 한 문서 안에서 어긋난다
     - 3장 문장은 7일 회고의 사실이라 지우지 않아도 된다
   - 수정: 71행을 "화면 운영 배포(정적 파일 + 역프록시), 브라우저 자동 테스트(로그인·권한은 보강 2 — 아래)"로 바꾼다. 36행 끝에 "→ 인증은 보강 2(decisions/0050)"를 붙인다
4. **마지막 ADMIN 판단에 남은 틈과 옛 설명(이론상, 재현하지 않음)**
   - 위치: `apps/api/src/auth/account.service.ts:72-80`(`current.role === Role.ADMIN`일 때만 잠금), `:74-75` 주석, decisions/0054 본문 "잠근 뒤 대상 행을 다시 읽어 판단한다"
   - 문제
     - 잠글지 말지를 첫 일반 읽기(스냅샷)의 역할로 정한다. 그래서 스냅샷에서는 대상이 ADMIN이 아니었는데 그 사이 ADMIN이 된 경우, 잠그지도 판단하지도 않는다
     - 예: 활성 ADMIN이 A 하나다. ① 요청 D가 X(OPERATOR)를 읽는다 ② 다른 요청이 X를 ADMIN으로 올리고 커밋한다 ③ A가 자기를 강등한다. X가 활성 ADMIN이라 허용된다 ④ D가 X를 `{ disabled: true }`로 저장한다. 결과는 활성 ADMIN 0이다
     - 세 요청이 몇 ms 안에 겹쳐야 하고 ADMIN만 할 수 있는 일이라 실제 가능성은 매우 낮다
     - 주석 "잠근 뒤에 대상 행을 다시 읽어(refresh) 기다리는 동안 바뀐 상태로 판단한다"와 0054 본문의 같은 문장은 6fb4ac5 뒤로 틀린 설명이다. `refresh`도 스냅샷이고, 판단은 잠근 목록으로 한다(0054 "보강 2 마감 보탬"이 바로잡지만 본문은 그대로다)
   - 수정
     - 대상 행을 먼저 `FOR UPDATE`로 읽는다(그러면 잠금 읽기라 지금 값). 또는 대상 역할과 상관없이 활성 ADMIN을 늘 잠근다(계정 수십 개, 짧은 트랜잭션)
     - 주석과 0054 본문의 그 문장을 "판단은 잠근 목록으로(보탬 참조)"로 고친다
5. **새 마이그레이션 두 개의 down을 한 번도 돌리지 않았다**
   - 위치: `apps/api/src/migrations/Migration20261027162424.ts`, `Migration20261028004119.ts`
   - 문제
     - devlog·계획에 `migration:down`·`migrate.js down` 기록이 없다
     - down은 `drop table if exists` 한 줄씩이라 위험은 작다. 다만 devlog 2026-10-26·27에는 새 마이그레이션의 down을 돌린 기록이 있다. 회고 6장에도 "데이터가 든 DB의 down 한 바퀴"가 이월로 있다
     - 개발 DB에는 이제 시연 계정이 있다. down을 돌리면 계정이 사라진다는 것도 어디에도 적혀 있지 않다
   - 수정
     - 테스트 DB에서 up → down 2번 → up을 돌리고 `check`로 확인한다. 스냅샷 파일이 생기면 troubleshooting/0032대로 지운다
     - devlog에 결과를 적고, 0051 또는 0054 "결과·대가"에 "down은 계정·키를 지운다(시드로 다시)"를 한 줄 더한다
6. **api는 `DEVICE_API_KEY`의 글자를 검사하지 않는다**
   - 위치: `apps/api/src/config/env.ts`의 `requiredSecret('DEVICE_API_KEY', 16)`, `.env.example` 주석 "공백 없는 ASCII", `apps/device-sim/src/config.ts:94`
   - 문제
     - device-sim 관리 API는 ba1a775부터 `/^[\x21-\x7e]*$/`만 받는다. api는 길이만 본다
     - 한글·공백이 든 키로 api는 뜬다. 그런데 device-sim은 시작할 때 환경변수 기본값을 검사하지 않는다. `invalidReason`은 `POST /__admin/config`가 설정을 합칠 때만 부른다(`server.ts:32`). 그때는 키와 상관없는 설정을 바꿔도 키 때문에 400이 난다
     - 그래서 Node가 헤더 값을 거부하거나, 하트비트가 모두 401이 되는 원인을 시작 시점에 알 수 없다
   - 수정: `requiredSecret`에 같은 패턴을 더해 시작할 때 던진다. device-sim도 시작할 때 `deviceKey`를 같은 규칙으로 검사한다
7. **작은 것들(선택)**
   - (a) `access-table.spec.ts`는 `METHOD path`를 `Map` 키로 쓴다. 두 핸들러가 같은 경로에 붙으면(라우팅 충돌) 하나로 합쳐져 테스트가 못 본다. `table.has(key)`면 실패시키는 한 줄이면 된다
   - (b) `admin-last-admin.e2e.spec.ts`의 새 테스트는 `SqlEntityManager.prototype.findOne`을 바꾼다. 그래서 그 사이 앱 안의 모든 `findOne`이 지나간다. `finally`에서 되돌리고 파일 병렬이 꺼져 있어(`fileParallelism: false`) 지금은 안전하다. 병렬을 켜면 다시 볼 자리라는 주석 한 줄을 권한다
   - (c) 계획 문서에 시연 비밀번호·키 원문이 있다. README "비밀번호는 seed 파일에서"와 같은 출처가 하나 더 있는 셈이다. 시드 값을 바꾸면 계획이 낡는다. 지난 기록이라 고칠 필요는 없다. 다만 Minor 2를 고칠 때 "원문의 기준은 seed 파일" 한 줄을 같이 적으면 좋다

## 마지막 세 커밋 따로 본 것
- ba1a775
  - `withoutMaskedKey`는 정확히 `(설정됨)`일 때만 뺀다. 그 문자열은 새 ASCII 규칙에 걸려 키로 저장될 수 없으므로 충돌이 없다
  - `SessionCacheSync` 주석(비우는 순간 나가 있던 응답은 버려짐)은 의도와 맞다
  - `TerminalActions`의 `enabled` 단순화는 OPERATOR ⊂ OFFICE라 동작이 같다
  - 옛 세션 지우기 실패는 경고만 남긴다. 토큰은 로그에 적지 않는다
- 6fb4ac5
  - 접두사가 겹치면 매번 `em.fork()`로 새로 넣는다. 시드 고정 키(`rawKey`)는 다시 만들지 않는다. 다섯 번 실패하면 그대로 던진다(500)
  - 만료 검사는 `@IsDateString({ strict: true })` 뒤 서비스에서 `<= now`다
  - `demoSeedAllowed`는 seed.ts 한 곳에서만 부른다. 마지막 ADMIN 판단은 위 Minor 4
- b98303a
  - README "로그인과 역할" 절을 따라가 봤다. 역할 설명은 0052 표와 맞고, 계정 표의 아이디 7개는 `DEMO_ACCOUNTS`와 같다
  - curl은 JSON 본문·쿠키 파일·로그아웃 뒤 쿠키 파일 삭제까지 있다. 외부 업체 키는 seed 파일에서 `grep -o`로 읽는다
  - 실행 절차의 `DEVICE_API_KEY` 안내(자리표시자, 옛 `.env`에 덧붙이기, 없으면 api가 안 뜸)와 device-sim `--env-file`은 코드와 맞는다
  - `.gitignore` 한 줄은 troubleshooting/0032의 해결과 같다. `ErrorBox`의 `LAST_ADMIN` 안내는 테스트가 있다

## 남은 이월 목록
회고 6장의 "보강 2가 남긴 것"(`docs/retrospective.md:97`)이 이월을 담고 있다. 이 리뷰가 보탤 것은 아래뿐이다.
- 이 리뷰의 Minor 2(로컬 키 교체·자리표시자 거부), 4(대상 행 잠금 읽기), 5(down 한 바퀴), 6(키 글자 검사), 7(표 키 중복·prototype 스파이 주석)
- 회고 6장 그대로 남는 것
  - CSRF 토큰 없음(SameSite만, `localhost` 다른 포트는 같은 사이트), HTTPS·IP별 실패 제한 없음
  - 단말기 키 하나(단말기별 폐기 불가)
  - 외부 업체 호출 로그·한도·키별 가맹점 범위 없음(열거 가능)
  - 계정·키 관리 화면(Bundle 7), 가맹점 화면(Bundle 3)
  - 계정 행을 SQL로 고치면 세션의 역할이 그대로임, 다른 탭의 사용자 변경 감지
  - 세션 읽기 Lua EVALSHA, `user_account.role` 인덱스
- 개발 DB·Redis 상태: 개발 DB에는 두 마이그레이션, 시연 계정 7개, 시연 키 1개가 있다(devlog 10:12). 실서버 확인의 `auth-live*` 키는 지웠다고 적혀 있다. 이 리뷰는 개발 DB와 Redis를 읽거나 쓰지 않았다. 테스트 DB는 api 테스트가 남긴 상태다

## Assessment
**병합 가능(Ready to merge). Minor 1·3(기록 몇 줄)을 먼저 하고, Minor 2(로컬 키 교체)는 병합과 상관없이 바로 하길 권한다.**
- 통과한 것
  - 리뷰어 실행: api 544, admin 125, device-sim 45, partners 53, api·admin·device-sim typecheck, 색인 `--check`
  - 구현자 기록(b98303a): api 78/544, 실서버 curl 확인(테스트 DB·개발 DB)
  - 컨트롤러: 개발 DB 브라우저 확인
- 맞춰 본 것
  - 접근 표 68줄 = 0052 표
  - 번호 연속, 링크·경로 263개
  - devlog 시각 11/12(Minor 1)
  - README 실험·테스트 숫자
  - 비밀 값은 seed 파일과 계획 문서 밖에 없다(계획의 단말기 키는 Minor 2)
- 인증 모델은 서로 맞물린다
  - 사람: 쿠키 → Redis 세션(세대값·절대 만료) → 역할 표 → `@Operator()` actor
  - 가맹점주: 같은 세션 → `/me` → 서비스 scope → 404
  - 외부 업체: 접두사·해시 → scope
  - 단말기: 공유 키
  - 계정 변경: 커밋 → `destroyAllFor`
  - 남은 틈은 이론상의 마지막 ADMIN 경합(Minor 4)과 시작 시점 검사(Minor 2·6)다. 모두 데이터를 깨뜨리지 않는 범위다
