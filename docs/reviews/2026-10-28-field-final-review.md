# 보강 4(현장 작업자 화면) 최종 리뷰 (2026-10-28)

- 범위: `b996c92..149f94b`(field-worker, master `2cdd6c5`와의 merge-base는 `b996c92`). 커밋 9개: docs 2, feat 4, fix 3. 60파일, +8,980 / −10. 이 중 계획 문서가 3,596줄, `apps/field/package-lock.json`이 2,104줄이다
  - master에는 merge-base 뒤에 `2cdd6c5`(.gitignore 보강) 하나가 더 있다. 이 브랜치는 `.gitignore`를 건드리지 않는다. 브랜치가 바꾼 60개 파일 가운데 새 `.gitignore`에 걸리는 것도 없다(`git check-ignore --no-index` 0건)
- 판정: **병합 가능(기록 보탬 권장)**
  - Critical·Important는 없다
  - Minor는 5건이다. 기록 정합성 하나, 쿠키 공유를 회고에 반영하는 것 하나, 검수 저장 실패 문구 하나, 사본 검사 범위 하나, 작은 것들이다
  - Minor 1(컨트롤러 확인 기록, 0063 꼬리표 한 곳)과 Minor 2(회고 한 줄)는 한두 줄씩이라 병합 전에 같이 고치길 권한다
- 해시 안내(한 번만 적는다): 어제 GitHub에 올리기 전에 history를 다시 썼다(작성자 이메일, 지난 프로젝트 이름). 그래서 모든 커밋 해시가 바뀌었다. devlog·결정 기록·Task 리뷰가 적은 해시(`37df12a`, `2be90bf` … `025bf3a`)는 옛 해시다. 오류로 보지 않는다. 이 리뷰는 새 해시로 적는다
  - 대응: 2be90bf → c3b890a, 80e5f7f → f307bfc, 4d7cd3f → 76ff0b1, aa239df → ee5487d, 2defecc → 9333feb, b60cf6c → 3895e19, 3eff934 → 7444288, 025bf3a → d43a5b7. 분기점 37df12a는 지금의 b996c92다
- 이번 리뷰가 특히 본 것
  - Task별 리뷰를 거치지 않은 d43a5b7(리뷰 반영)과 149f94b(마감 문서)
  - 브랜치 전체에 걸친 것: 접근 표 71, contracts, 사본 검사의 튼튼함과 범위, 박스 스캔 멱등이 어드민과 같은지, 검수 저장 흐름(고친 것 포함), README 실행 절차, 기록(0061~0064, devlog 시각, 색인), 회고 이월, 세 앱 쿠키 공유

## 범위
- 계획(c3b890a): 스펙 `docs/specs/2026-10-28-field-worker.md`, 계획 `docs/plans/2026-10-28-field-worker.md`(Task 5개)
- 현장 앱 골격(f307bfc, ee5487d)
  - `apps/field`: React 19 + Vite + TanStack Query, `:5175`/`:4175`, `/api` 프록시(`FIELD_API_URL`)
  - 점주 앱 lock을 복사했다. `name` 두 줄만 다르다(decisions/0061)
  - 점주 사본 8개와 `copies.test.ts`(decisions/0062). AuthGate는 FIELD만 받는다. 화면 틀은 아래 탭 셋이다
- 현장 API(76ff0b1)
  - `GET /field/today`(FIELD만): `FieldService.today`, `common/kst.ts`의 `kstDayOf`
  - contracts `field.ts`의 `FieldTodayView`. 접근 표 70 → 71(decisions/0063)
- 박스 스캔(9333feb, 3895e19)
  - 키보드 웨지 입력(입력칸 + Enter = 폼 제출), 여러 줄 붙여 넣기, 줄마다 중복·형식 표시
  - scanId 멱등은 어드민 규칙 그대로. 선택 뒤 초점 돌리기, 잠긴 박스 안내, 마감된 발주 비우기(decisions/0064)
- 검수(7444288): 검수 대기(RECEIVED·RETURNED를 기존 목록 API로 두 번), 시리얼 스캔으로 찾기, 체크리스트(처음엔 아무것도 고르지 않음), 결과
- Task별 리뷰를 거치지 않은 두 커밋
  - d43a5b7: 검수 저장 실패를 화면 상태로 들기, `SerialFinder` 분리와 결과·대기 아님 화면 배치, 항목 0개 모델 안내, `useTerminal` staleTime 0, 무효화 범위 좁히기, 날짜 경계 e2e, GROUP BY, 사본 검사 JSX 규칙과 ScriptKind
  - 149f94b: README, devlog 마감과 "보강 4 요약", 회고 6장
- 기록
  - decisions 0061~0064(새로). 보탬은 0052(표 70 → 71)와 0058(세 벌째)
  - devlog `2026-10-28.md`의 `# 보강 4: 현장 작업자 화면`(9항목 + 요약)
  - 공부거리 5줄, `docs/index.md`

## 검증 결과 (리뷰어가 직접 실행)
- api: 테스트 DB를 `DROP/CREATE` 한 번으로 다시 만든 뒤 실행했다(`docker exec -e MYSQL_PWD=…`, 값은 `.env`에서 변수로만 읽었다)
  - `npx vitest run`: `Test Files 82 passed (82)`, `Tests 568 passed (568)`, 335.69초, exit 0
  - `Connection is closed`는 0줄이다. `MaxListenersExceededWarning`은 7줄로, 보강 2·3 리뷰 때와 같은 수다(이월된 경고)
  - `npx tsc --noEmit -p tsconfig.json`: exit 0
  - 끝난 뒤 테스트 DB를 같은 명령으로 다시 비웠다. `src/migrations`에는 기준 스냅샷 `.snapshot-terminal_ops.json`만 있다(테스트 DB 스냅샷 없음)
- 다른 앱 테스트와 tsc

  | 앱 | 테스트 | tsc |
  |---|---|---|
  | field | `7 passed (7)` / `57 passed (57)` | exit 0 |
  | merchant | `7 passed (7)` / `47 passed (47)` | exit 0 |
  | admin | `14 passed (14)` / `125 passed (125)` | exit 0 |
  | device-sim | `5 passed (5)` / `46 passed (46)` | exit 0 |
  | partners | `6 passed (6)` / `53 passed (53)` | exit 0 |

- README 테스트 표(api 82/568, admin 14/125, merchant 7/47, field 7/57, partners 6/53, device-sim 5/46)와 위 결과가 같다. devlog 14:21 항목의 숫자와도 같다
- `node scripts/docs-index.mjs --check`: `docs/index.md 최신`(exit 0). 절 제목은 결정 64·트러블슈팅 32·실험 17로, README "결정 64·트러블슈팅 32·실험 17"과 같다
- 프로세스
  - 시작 전 node PID는 43936·35448·28868·26108이었다(리뷰어가 띄운 것 아님)
  - 리뷰어 실행은 api 테스트(background, 스스로 끝남)를 빼고 모두 foreground였다. 끝난 뒤 node PID는 시작 전과 같다
  - Redis는 건드리지 않았다. `git status`도 깨끗하다(이 리뷰 파일만 새로 생긴다)
- 기록 정합성
  - 번호: decisions 0061~0064가 이어지고, 빈 번호와 중복이 없다. troubleshooting·experiments는 새 번호가 없다(0033·0018은 비어 있음). 브리프가 정한 다음 번호와 같다
  - devlog 제목 시각: 9곳 모두 커밋 시각과 분까지 같다(13:51·13:56·14:00·14:01·14:08·14:09·14:15·14:21)
    - 13:48 계획 항목만 author가 13:47:56, committer가 13:48:02다. 커밋 시각으로 보면 맞는다. 몇 초 차이라 문제로 보지 않는다
    - 13:51(Task 2) → 13:56(Task 1)의 순서 뒤바뀜은 devlog가 이유를 적었다(Task 2가 먼저 커밋됨)
  - 링크·경로: README·회고·devlog·0052·0058·0061~0064·스펙·공부거리의 마크다운 링크와 `apps/…`·`docs/…`·`packages/…` 경로를 스크립트로 검사했다
    - 없는 것으로 잡힌 8개는 모두 일부러 쓴 표기다: 버린 브랜치의 `packages/web-common`, `apps/merchant/src/…`·`0060-…` 같은 줄임, `.snapshot-…_test.json` 설명, `docs/decisions/0041` 줄임
    - 실제로 깨진 링크는 0이다
  - 접근 표: `access-table.spec.ts`의 `EXPECTED` 71줄, 0052 표의 `FIELD(보강 4, 0063) | GET /field/today` 줄, 0052 "보강 4 보탬: 70 → 71", 0063 "표 70 → 71"이 서로 같다
    - 현장 앱이 부르는 10개 경로(`/auth/login·logout·me`, `/field/today`, `/terminals`, `/terminals/:serialNo`, `/terminals/:serialNo/inspections` POST, `/inspection-items`, `/purchase-orders`, `/scans`)는 모두 표에서 FIELD에 열려 있다
  - 비밀 값 노출(값은 출력하지 않고 위치만 셈)
    - seed 파일의 시연 비밀번호 7개: 이 브랜치가 바꾼 파일 어디에도 없다
    - 로컬 `.env`의 `DEVICE_API_KEY` 값: 이 브랜치가 바꾼 파일 어디에도 없다
    - README 현장 화면 절은 계정 표의 `field`만 가리키고 비밀번호를 적지 않는다
- 직접 하지 않은 것(지시에 따라)
  - 개발 DB 작업과 실서버 기동은 하지 않았다. devlog 14:21 항목의 기록과 대조만 했다: 테스트 DB 실서버 api `:3100`(`QUEUE_PREFIX=field-live`), 현장 `:5175` 프록시, 끈 PID 22492·5572, `field-live*` 6키를 하나씩 DEL
  - 화면 확인은 컨트롤러가 했다(개발 DB, 내장 브라우저 375×812)
    - 같은 사이트의 점주 세션 쿠키로 들어가면 현장 앱의 "현장 작업자 계정용" 안내가 나온다. 쿠키 공유가 실제로 보인 것이다
    - 로그아웃 뒤 field로 로그인하면 홈 "오늘 내 작업"이 나온다(2026-10-28 KST, 모두 0)
    - 박스 스캔 화면은 시리얼 입력칸에 초점이 있다
    - 검수 화면은 찾기 칸에 초점이 있고 "검수 대기 2대"가 보인다
    - XL-131205-1을 열면 SN-100 체크리스트, "모두 합격", "남은 항목 4개"가 보인다. 저장은 하지 않았다
    - 모든 화면의 `scrollWidth`가 375다. 콘솔 오류와 api 오류 로그도 없다
    - XL-131205-1은 3일차 엑셀 입고(devlog 2026-10-23)로 이미 개발 DB에 있던 단말기다. 즉 이 확인에는 개발 DB 쓰기가 필요 없었다
    - 이 결과는 아직 devlog에 없다(Minor 1)

## Strengths
- **서버 변경이 작고 범위가 정확하다.** 새 엔드포인트는 `GET /field/today` 하나뿐이다
  - `@Roles(Role.FIELD)`와 `@Operator()`(로그인 아이디, 0056)로 "나"를 정한다. 조건 인자를 받지 않으므로 남의 실적을 볼 길이 없다
  - e2e가 운영자·가맹점주 403과 로그인 없음 401을 본다
  - 박스는 `scan_batch` 한 행 = 한 번 처리한 박스다. 그래서 같은 scanId로 다시 보낸 것(replayed)은 저절로 한 번만 센다. e2e와 실서버 기록("같은 scanId 200 replayed" 뒤 `boxes 1`)이 이를 뒷받침한다
  - `kstDayOf`는 `getUTC*`만 쓴다. 단위 테스트에 더해 d43a5b7이 `today(actor, now)`의 `now`를 고정해 KST 23:59 / 00:00 / 다음 날 00:00 경계를 e2e로 본다. 다른 작업자 아이디(`field-edge`)와 2031년 날짜를 써서 다른 테스트와 섞이지 않는다
  - GROUP BY로 바꾼 것은 `Boolean(g.passed)`·`Number(g.n)`으로 드라이버의 반환 모양(0/1, 문자열 수)을 흡수한다. 같은 e2e가 합격 1·불합격 1을 단언한다
- **contracts가 일관된다**
  - `FieldTodayView`는 api 반환 타입(컨트롤러·서비스 모두 `Promise<FieldTodayView>`)과 화면이 함께 본다
  - `rejected`의 범위가 계약 주석에 적혀 있다: 저장된 박스의 행만 세고, 요청 전체가 거절된 것은 세지 않는다. 0063과 화면 문구("거절된 줄")도 같은 말이다
  - field의 `@terminal-ops/contracts` import는 모두 `import type`이다(리뷰어 grep에서 예외 0)
  - `RESULT_LABEL: Record<RowResultCode, string>`, `TERMINAL_STATUS_LABEL: Record<TerminalStatus, string>`이라 값이 늘면 tsc가 빠진 이름을 알려 준다
- **박스 스캔 멱등이 어드민과 같다.** 리뷰어가 두 `ScanPage`를 나란히 놓고 대조했다
  - `retryable`은 식까지 같다(연결 실패·5xx·409 `SCAN_IN_PROGRESS`/`VERSION_CONFLICT`)
  - `newScanId`(`BOX-` + UUID), 처음 보낼 때 scanId 만들기, ref 비교로 늦은 오류 막기, `locked = scanId !== null`, 보내기 버튼 끄는 조건 다섯, 결과 못 받은 박스의 `window.confirm` 모두 같다
  - 현장 쪽에만 더한 것은 세 가지다. 모두 현장 입력 방식에서 나온 것이고 멱등 규칙을 바꾸지 않는다
    - 선택 뒤 초점 돌리기(select type-ahead가 발주를 바꾸는 사고 방지)
    - 잠긴 박스의 Enter 안내
    - 잠기지 않은 박스에서만 마감 발주 비우기(잠긴 박스는 다시 보낼 내용이 같아야 하므로 건드리지 않음)
  - 테스트도 같은 갈래를 덮는다: 409 처리 중·5xx·409 되돌림 세 경우의 "같은 scanId·같은 내용 다시 보내기 → replayed", 4xx 뒤 새 scanId, 확인창
- **사본 검사가 정규식 → 파서 토큰 → JSX 규칙으로 단계마다 근거를 남기며 튼튼해졌다**
  - 문자열·템플릿·정규식 리터럴 안의 `//` 사각지대를 단위 테스트 넷으로 잠갔다. `ts.createScanner`로는 안 되는 이유는 직접 돌려 보고 적었다
  - JSX 글자는 React의 공백 규칙대로 비교한다. 그래서 `{a} {b}`의 같은 줄 공백(화면에 보이는 차이)은 잡고, 줄바꿈·들여쓰기(보이지 않는 차이)는 넘긴다
  - `.ts`를 TSX로 읽으면 `<T>x` 단언이 JSX가 되는 문제를 확장자별 ScriptKind로 막고 테스트했다
  - 한계(ASI 자리의 줄 나눔)를 0062에 정직하게 적었다
  - devlog에 "점주 파일 한 줄을 바꾸자 실패 → 되돌림"을 두 번(`client.ts`, `LogoutButton.tsx` JSX 글자) 적었다
- **0062의 사전 검증이 결정을 데이터로 받친다.** 공유 패키지를 두 앱에 실제로 붙여 비용을 쟀다
  - 앱마다 `dedupe` 1줄·`paths` 4줄·lock 9줄·다시 내보내기 6파일이 든다. `LogoutButton`은 옮기지 못했다
  - `dedupe`를 빼면 tsc는 통과하고 vitest·build에서 깨진다는 것을 확인했다
  - "세 벌 → 어드민 + 공유 한 벌"이라는 점도 확인했다
  - 0058의 "다시 볼 조건"에 실제로 닿은 시점에 다시 봤다
- **d43a5b7의 검수 저장 흐름 고침이 원인에 맞다.** 아래 "따로 본 것"에서 줄 단위로 적었다. 실패 오류가 체크리스트와 함께 사라지던 것을 상태를 끌어올려 고쳤다. 스캐너가 어느 화면에서든 다음 단말기로 갈 수 있게 `SerialFinder` 하나로 모았다
- **README 실행 절차가 코드와 맞다**
  - 설치 루프에 `field`가 있다
  - `(cd apps/field && npm run dev)`의 `:5175`가 `vite.config.ts`의 `strictPort`와 같다
  - 타입 검사 안내 "admin·merchant·field `npm run build`(tsc 포함)"이 `package.json`의 `build`와 같다
  - 현장 화면 절이 0061~0064를 모두 가리킨다. FIELD 역할 설명에 "어드민의 박스 스캔·검수도 그대로"가 있어 0061 결정과 같다
- **launch.json**: 세션 루트와 저장소 `.claude/launch.json` 둘 다 `terminal-ops-field`(:5175, 앱의 vite)가 있다. 저장소 쪽은 `.gitignore:6`에 걸려 커밋되지 않는다
- **기존 테스트를 고치지 않았다.** 브랜치가 바꾼 테스트 파일은 `apps/field` 밖에서는 `access-table.spec.ts`(+3줄)와 새 `field.e2e`·`kst-day` 뿐이다. 회고의 "기존 테스트는 고치지 않았다(접근 표 한 줄)"가 사실이다

## Issues

### Critical
없음.

### Important
없음.

### Minor

1. **컨트롤러 화면 확인이 기록에 없고, 0063의 리뷰 꼬리표 하나가 틀렸다**
   - 위치: `docs/devlog/2026-10-28.md` 14:21 항목의 "컨트롤러 확인: 대기", `docs/decisions/0063-…:14`의 "(Task 5 리뷰 반영)"
   - 문제
     - 위 "직접 하지 않은 것"의 컨트롤러 확인이 devlog에 없다. 보강 2·3 리뷰 Minor 1과 같은 형태다
     - 0063의 "거절된 줄" 문구 변경은 Task 1(현장 API) 리뷰에서 나왔다. devlog 14:15 항목("(Task 1 리뷰) … 화면 문구를 '거절된 줄 N'으로")과 Task 1 리뷰 반영 메모가 그렇게 적는다. 이 브랜치의 Task 5는 마감이고 리뷰 반영이 없다
   - 수정
     - 화면 확인 항목을 하나 덧붙인다(그 기록 커밋의 시각을 제목으로). 내용
       - "받아 적은 것"이라는 표시
       - 375×812, 점주 쿠키로 현장 안내 → 로그아웃 → field 홈(0)·스캔 초점·검수 찾기 초점·"검수 대기 2대"·XL-131205-1 체크리스트(저장 안 함), `scrollWidth` 375, 콘솔·api 오류 없음
       - 개발 DB에 새로 쓴 것은 없음(XL-131205-1은 3일차 데이터)
     - 0063의 "(Task 5 리뷰 반영)"을 "(Task 1 리뷰 반영)"으로 고친다
2. **세 앱이 쿠키 하나를 쓰는 것이 README·0061에는 있지만 회고 이월에는 두 앱으로 남아 있다**
   - 위치: `docs/retrospective.md:99`(보강 3이 남긴 것: "어드민·점주 앱이 localhost에서 쿠키 하나를 씀"), `:101`(보강 4가 남긴 것)
   - 문제
     - README 현장 화면 절의 시연 팁과 0061 "결과·대가"는 `:5173`·`:5174`·`:5175` 세 앱을 적었다. 컨트롤러 확인(점주 쿠키로 현장 앱에 들어가면 안내가 나옴)도 이 동작을 보여 준다
     - 그런데 회고 이월은 여전히 두 앱만 말한다. "보강 4가 남긴 것"에는 쿠키 줄이 없다
     - 현장 앱도 403 뒤에 사용자 바뀜을 알아채지 못한다. 다른 탭에서 점주로 로그인하면 현장 탭은 `/field/today` 403을 ErrorBox로 보인다. 로그인 화면으로 가지 않는다. 같은 이월이 이제 세 앱에 걸린다
   - 수정: "보강 4가 남긴 것"에 "어드민·점주·현장 세 앱이 localhost에서 쿠키 하나(0061) — 403 뒤 `/auth/me` 다시 읽기는 세 앱 모두(선택)" 한 줄을 더한다. 보강 3 줄은 그대로 두어도 된다(그때의 사실)
3. **검수 저장 실패 문구가 두 경우에 사실과 어긋날 수 있다(d43a5b7)**
   - 위치: `apps/field/src/pages/InspectPage.tsx`의 "대기 아님" 분기와 `SaveFailed`
   - 문제
     - (a) "그새 다른 사람이 검수했을 수 있습니다"가 저장을 시도하지 않은 경우에도 늘 나온다. 재고(IN_STOCK) 단말기를 바로 스캔해도 이 문장이 보인다. 테스트도 SN-STOCK에서 이 문장을 단언한다. 저장 실패 뒤가 아니면 맞지 않는 말이다
     - (b) 연결 실패·5xx는 서버가 이미 커밋했을 수 있다. 검수 POST는 scanId 같은 멱등 키가 없다. 이때 `onSettled`가 다시 읽으면 단말기는 "검수 합격"으로 보인다. 그런데 화면은 "방금 저장하지 못했습니다: …" + "다른 사람이 검수했을 수 있습니다"를 보인다. 실제로는 **자기 저장이 된 것**일 수 있는데, 작업자가 "안 됐다"고 믿고 같은 단말기를 다른 기기로 다시 보려 할 수 있다
     - 데이터는 깨지지 않는다. 두 번째 저장은 서버 전이 규칙이 422로 막는다. 문구만의 문제다
   - 수정(선택, 두세 줄)
     - "그새 다른 사람이…" 문장은 `saveError`가 있을 때만 붙인다
     - `saveError`가 `ApiError`가 아니거나 5xx면 "결과를 받지 못했습니다 — 지금 상태가 검수 합격·불량이면 저장된 것입니다(검수 기록에서 확인)"처럼 쓴다. 422면 지금 문구 그대로 둔다
   - 함께 볼 작은 것: `apps/field/src/api/query-keys.ts` 머리 주석은 여전히 "쓰기 뒤에는 `keys.all`을 통째로 무효화한다"고 한다. d43a5b7 뒤 검수 저장은 셋(오늘·대기·그 단말기)만 무효화한다(0064 ⑤). 주석에 "(검수 저장은 셋만 — 0064)"를 붙인다
4. **사본 검사 범위에 빈틈이 몇 개 있다(선택)**
   - (a) `COPIES` 목록 밖의 사본
     - `main.tsx`는 점주 앱과 글자까지 같은데(diff 0줄) 검사 목록에 없다
     - `test/render.tsx`의 `mockApi`(경로 패턴·호출 기록 규칙)는 점주 것과 기준 URL·계정 고정값만 다른 사실상의 사본이다. 그런데 검사도 머리 주석 표시도 없다
     - 지금은 어긋남이 없다. 다만 목록이 손으로 관리되므로 사본이 하나 늘 때 빠뜨리기 쉽다
     - 제안: `main.tsx`를 `COPIES`에 넣는다. 또는 "머리 주석에 `의 사본(decisions/0062)`이 있는 현장 파일 = `COPIES`"를 단언하는 테스트 한 줄을 더한다(`import.meta.glob ?raw`, query-keys 테스트와 같은 방법)
   - (b) 점주 쪽에서는 사본이 있는 줄 모른다
     - 점주 `client.ts`·`session.ts` 등의 머리 주석은 아직 "어드민을 옮겨 온 것"만 말한다. 점주 파일을 고치는 사람은 현장 테스트를 돌리기 전까지 현장 사본을 모른다(0062가 "대가"로 적은 그대로다)
     - 점주 사본 머리 주석에 "현장 앱 `apps/field/src/…`에 사본 — 같이 고친다(0062)" 한 줄을 더하면 대가가 줄어든다. 주석은 검사 밖이라 테스트 영향이 없다
   - (c) 박스 스캔 규칙은 어드민과 현장에 두 벌이다
     - `retryable`·`newScanId`·`SERIAL_PATTERN`은 어드민 `ScanPage.tsx`와 현장 `lib/scan.ts`에 두 벌 있다. 0062의 검사는 점주 ↔ 현장만 본다
     - 멱등 규칙은 이 프로젝트의 핵심이라 어긋나면 비용이 크다. 0064 "결과·대가"나 회고 이월에 "스캔 멱등 판정은 어드민·현장 두 벌(검사 없음)"을 적어 둔다. 또는 `retryable` 함수 본문만 두 파일에서 뽑아 토큰 비교하는 테스트를 더한다
5. **작은 것들(선택)**
   - (a) README 실행 블록의 "터미널 네 개" 주석은 이제 화면 셋을 포함해 더 많다. "필요한 것만" 정도로 바꾼다
   - (b) 점주 앱 AuthGate 안내는 "사내 직원 계정은 운영 어드민을 쓰세요"다. FIELD는 어드민도 쓸 수 있으니 틀린 말은 아니다. 다만 현장 화면을 알려 주지 않는다. 어드민 AuthGate가 점주를 매장 화면으로 보내는 것과 맞추려면 "현장 작업자는 현장 화면(:5175)"을 더한다
   - (c) 실제 휴대폰·PDA로 열 때의 조건이 이월에 없다
     - vite에 `server.host`가 없어 지금은 같은 PC의 localhost에서만 열린다
     - `--host`로 LAN 주소(`http://192.168…`)에서 열면 보안 문맥이 아니다. 그러면 `crypto.randomUUID`가 없어 **보내기에서 `newScanId`가 TypeError**가 난다(어드민도 같은 코드)
     - 시연 범위(localhost 375×812)에서는 생기지 않는다. 다만 "현장 기기"가 목표인 앱이라 회고 "보강 4가 남긴 것"에 "실기기는 HTTPS(또는 localhost 터널)가 필요 — scanId 생성이 보안 문맥 API"를 한 줄 적어 두면 좋다

## Task별 리뷰를 거치지 않은 두 커밋 따로 본 것
- d43a5b7
  - `InspectPage`
    - `saveError`를 `Inspect`(시리얼별 `key`로 다시 그려지는 바깥)에 둔다. 그래서 다음 시리얼로 가면 저절로 비워진다. 같은 화면에서 다시 읽어 체크리스트가 사라져도 남는다
    - 순서: `onError`(상태 설정) → `onSettled`(무효화) → 다시 읽기 → 대기 아님 분기 → `SaveFailed`. useMutation 옵션 콜백이라 언마운트와 상관없이 돈다
    - 테스트가 `role="alert"`의 제목·서버 메시지와 찾기 칸 초점을 함께 단언한다
    - 문구는 Minor 3
  - `SerialFinder`: 대기 목록 위에 있던 폼을 그대로 옮겼다(diff상 제거 = 추가). 대기 아님 화면과 `Saved`에도 두었다. 화면마다 `autoFocus`가 하나뿐이라 초점이 겹치지 않는다. 결과 화면 → 스캔 → 다음 단말기 → 저장 → 스캔의 연쇄를 테스트 하나가 끝까지 따라간다
  - 항목 0개 모델: 빈 `results`를 보내지 않게 저장 버튼을 숨긴다. 서버의 빈 배열 처리에 기대지 않는다
  - `useTerminal`의 `staleTime: 0`: 검수 가능 여부를 30초 캐시로 판단하지 않게 했다. `refetchOnWindowFocus`와 함께, 다른 사람이 그새 검수했으면 체크리스트가 사라진다. 그때 고른 값은 잃는데, 저장할 수 없는 값이라 맞는 동작이다
  - 무효화 좁히기: `keys.today`·`keys.queue`·`keys.terminal(serialNo)`. 검수는 발주를 바꾸지 않으므로 `openOrders`를 빼도 맞다. 검수 항목(staleTime 무한)을 다시 읽지 않는다. 테스트가 `keys.all`이 불리지 않음을 단언한다. 머리 주석은 Minor 3
  - `field.service.ts` GROUP BY와 날짜 경계 e2e: 위 Strengths
  - `copies.test.ts`: `jsxTextValue`는 React의 `cleanJSXElementLiteralChild` 규칙(첫 줄은 앞 공백 유지·마지막 줄은 뒤 공백 유지·빈 줄 버림·한 칸으로 잇기)과 같다. 탭을 공백으로 바꾸는 것도 같다. 네 가지 경우의 단언이 있다
  - `ScanPage`: 주석 두 줄뿐이다(늦은 오류 방어를 테스트하지 않는 이유)
  - `ScanPage.test`: 공백 없는 시리얼 하나를 붙여 넣으면 `onPaste`가 기본 동작을 막지 않고 Enter로 더해지는 경로를 잠갔다(0064의 "시리얼 하나는 보통 붙여 넣기"와 같다)
  - devlog 14:15 항목: 시각이 맞고, 실패 → 통과 숫자(51 → 57)와 내역(+2 사본 검사, +3 검수, +1 붙여 넣기)이 테스트 파일과 같다. 줄바꿈(작업 폴더 CRLF·커밋 LF)을 맞춘 일과 here-doc 사고도 적혀 있다
- 149f94b
  - README 차이를 줄 단위로 봤다. 모두 코드·실행 결과와 맞다
    - 구성도의 `field/`, contracts 설명의 "현장"
    - 설치 루프, 실행 줄(:5175), 타입 검사
    - FIELD 역할 설명, 현장 화면 절(0061~0064 링크, 시연 팁의 세 앱 쿠키)
    - 기능 표의 현장 행, 색인 수 64
    - 테스트 표(field 행 추가, "보강 3 뒤 api 80/561·merchant 7/47" 앞 값 표기)
  - devlog 14:21 항목
    - 시각이 맞다. 전체 검증 숫자가 리뷰어 실행과 같다
    - 실서버 확인의 기대값·끈 PID·포트 LISTENING 0·DEL 키 수가 적혀 있다. `db:migration:check`와 테스트 DB 스냅샷 없음도 적혀 있다
    - 컨트롤러 확인은 "대기"로 남아 있다(Minor 1)
  - "보강 4 요약"의 커밋 목록 9개는 history 재작성 전 해시로 `git log --oneline 37df12a..HEAD`였다. 새 해시로는 `b996c92..149f94b`의 9개와 순서·제목이 같다
  - 회고 6장
    - 보강 3 줄의 "공통 코드 두 벌"에 "— 보강 4에서 세 벌째, 0062"가 붙었다
    - `[x] 보강 4` 항목과 "보강 4가 남긴 것"이 새로 생겼다. 카메라, 오프라인, 세 곳 공통 코드, ASI 한계, 100대 상한, 인덱스, Tab 접미사·IME, 발주분 입고 실서버 미확인, 휴대폰 폭 눈 확인이다
    - 세 앱 쿠키는 빠졌다(Minor 2)

## 점주 사본 비교 (`diff --strip-trailing-cr`, 리뷰어가 같은 경로 파일마다 실행)
| 파일 | 차이 |
|---|---|
| `api/client.ts`, `session.ts`, `query-client.ts`, `lib/format.ts`, `components/SessionCacheSync.tsx`, `components/LogoutButton.tsx`, `hooks/useSessionCheck.ts`, `test/setup.ts` | 머리 주석만 다르다(2~6줄). `copies.test.ts`가 토큰으로 같은지 본다. 통과 |
| `main.tsx` | 차이 0줄. 검사 목록에는 없다(Minor 4a) |
| `test/render.tsx` | 기준 URL(`field.test`), 고정 계정(`WORKER`), 주석. `mockApi` 규칙은 같다. 검사 밖(Minor 4a) |
| `components/AuthGate.tsx` | 역할 조건(`!== 'FIELD'`)과 안내 문구 |
| `pages/LoginPage.tsx` | 제목·설명 문구 |
| `api/query-keys.test.ts` | 키 목록과 파일 수 하한(10). 검사 방법은 같다. 이번에는 사본 사이에 빠진 테스트가 없다(보강 3 리뷰 Minor 4a가 반영된 상태) |
| `api/query-keys.ts`, `api/queries.ts`, `components/ErrorBox.tsx`, `components/Shell.tsx`, `lib/labels.ts`, `pages/HomePage.tsx`, `styles.css`, `App.tsx` | 현장용으로 새로 썼다(0062 "복사하지 않고 현장 문구로") |
| `package.json`, `package-lock.json` | `name`만 다르다(lock 2·7행) |

## 남은 이월 목록
회고 6장의 "보강 4가 남긴 것"(`docs/retrospective.md:101`)이 이월을 담고 있다. 이 리뷰가 보탤 것은 아래뿐이다.
- 이 리뷰의 Minor 2(세 앱 쿠키 — 회고 한 줄, 선택으로 403 뒤 재확인), 3(검수 실패 문구), 4(사본 목록 자동 대조·점주 쪽 표시·어드민 ↔ 현장 스캔 규칙), 5(c)(실기기 보안 문맥)
- 회고 6장 그대로 남는 것
  - 카메라 바코드 없음, 오프라인 스캔 없음, 검수 대기 상태별 100대, `scan_batch`·`inspection` (actor, 시각) 인덱스 없음
  - 스캐너 Tab 접미사·한글 IME, 발주분 입고 성공 행은 실서버에서 못 봄(e2e가 봄), 로그인 뒤 휴대폰 폭은 눈 확인
  - 보강 2·3에서 넘어온 것: CSRF 토큰(localhost 다른 포트는 같은 사이트), 다른 탭 사용자 변경 감지, 회수 뒤 `terminal.merchant` 등
  - 이월된 경고 `MaxListenersExceededWarning` 7줄(api 테스트)
- 상태
  - 테스트 DB는 리뷰어가 마지막에 `DROP/CREATE`로 비워 두었다
  - 개발 DB와 Redis는 이 리뷰가 읽거나 쓰지 않았다
  - 컨트롤러 확인은 개발 DB에서 읽기만 했다(저장 안 함)

## Assessment
**병합 가능(Ready to merge). 병합 전에 Minor 1(컨트롤러 확인 항목, 0063 꼬리표)과 Minor 2(회고 한 줄)를 하길 권한다. Minor 3의 문구 두세 줄도 작으니 같이 하면 좋다. 나머지는 이월 목록으로 충분하다.**
- 통과한 것
  - 리뷰어 실행: api 82/568, field 7/57, merchant 7/47, admin 14/125, device-sim 5/46, partners 6/53. 여섯 앱 tsc 0. 색인 `--check` 최신
  - 구현자 기록(149f94b): 같은 숫자, 테스트 DB 실서버 프록시 확인
  - 컨트롤러: 개발 DB에서 375×812 화면 확인
- 맞춰 본 것
  - 접근 표 71줄 = 0052 표 = 0052·0063 보탬 "70 → 71"
  - 현장 앱이 부르는 10개 경로가 모두 FIELD 허용이다
  - decisions 0061~0064 연속, 색인·README 수 64
  - 링크·경로(실제로 깨진 것 0)
  - devlog 시각 9/9
  - README 테스트 표와 실행 절차
  - 비밀 값은 바뀐 파일에 없다
- 현장 화면은 서버 규칙을 다시 만들지 않는다
  - 검수 가능 여부는 `actions.inspect`, 줄 판정은 서버 행 결과, 멱등은 scanId(어드민과 같은 규칙), "오늘"은 서버의 KST 하루와 로그인 아이디다
  - 남은 것은 문구 한 곳(저장 실패), 기록 몇 줄, 사본 검사의 범위를 넓히는 선택 사항이다. 데이터나 권한을 깨는 것은 없다
