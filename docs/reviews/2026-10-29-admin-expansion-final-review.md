# 보강 5(통합 어드민 확장) 최종 리뷰 (2026-10-29)

- 범위: `master(54dc512)..admin-expansion(c38f34e)`. merge-base가 master 끝과 같다(master에 뒤따른 커밋 없음). 커밋 8개: docs 2, feat 5, fix 1. 48파일, +4,915 / −136. 이 중 계획 문서가 2,884줄이고, 회고 204줄은 줄바꿈 변환 때문에 생긴 차이다(Minor 1)
- 판정: **병합 가능(기록 보탬 권장)**
  - Critical·Important는 없다
  - Minor는 5건이다. 회고 파일 줄바꿈 하나, 컨트롤러 확인 기록 하나, 결정 기록이 c6c2ffe를 따라가지 못한 것 하나, README 문구 하나, 작은 것들이다
  - Minor 1(회고 LF로 되돌리기)과 Minor 2(컨트롤러 확인 항목)는 병합 전에 같이 하길 권한다. 둘 다 기록만 고치면 된다
- 작성자: 브랜치 커밋 8개 모두 author·committer가 `252961019+devvshyun@users.noreply.github.com`이다(`git log --format='%ae | %ce' master..admin-expansion`). 커밋 본문에 나오는 다른 주소는 `Co-Authored-By`의 `noreply@anthropic.com`뿐이다
- 이번 리뷰가 특히 본 것
  - Task별 리뷰를 거치지 않은 c6c2ffe(리뷰 반영)와 c38f34e(마감)
  - 브랜치 전체에 걸친 것: 스펙 점검표가 이 묶음 뒤에도 맞는지, contracts와 접근 표 72, 계정 화면 보안(비밀번호가 남는지, LAST_ADMIN, 자기 계정 바꾸기), 다른 화면 주소의 스킴 검사, README 실행 절차, 기록(0066~0069, devlog 제목 = 커밋 시각, 색인), 회고 이월, 작성자 주소와 대학 이메일·지난 프로젝트 이름

## 범위
- 계획(08d0dc2): 스펙 `docs/specs/2026-10-29-admin-expansion.md`(2장 시연 시나리오 점검표), 계획 `docs/plans/2026-10-29-admin-expansion.md`(Task 6개)
- 펌웨어 목록 API(f1c31fa)
  - `GET /firmware?modelCode=&beforeId=&limit=`(OFFICE): 최근 등록부터 키셋, 없는 모델은 빈 목록
  - contracts `RegisterTerminalRequest`·`RegisterFirmwareRequest`·`CreateRolloutRequest`(DTO가 `implements`), `TerminalImportRow`·`TerminalImportView`(엑셀 등록 서비스 반환 타입)
  - 접근 표 71 → 72(decisions/0066, 0052 보탬)
- 어드민 바탕(c79a589): `api()`의 PATCH·FormData, `src/apps.ts` + `AppLinks`(다른 화면, decisions/0067), `Layout`의 `aside.side`
- 단말기 등록(b8b6886): `/registrations`(운영자), 한 대·엑셀, 행별 결과·실패한 행만·결과 CSV(`lib/csv.ts`, decisions/0068)
- 펌웨어 등록·배포 만들기(4e3991a): 배포 화면의 접힌 폼 둘(운영자), `parseStages`(0068 Task 4 보탬)
- 계정 화면(fe97eca): `/admin/accounts`(ADMIN), 목록·만들기·역할 바꾸기·사용 중지, 외부 업체 키는 개발자센터(보강 7) 안내(decisions/0069)
- Task별 리뷰를 거치지 않은 두 커밋
  - c6c2ffe: 주소 스킴 검사, 엑셀 파일째 거절 안내 넷, 등록 뒤 `dashboard` 무효화와 성공 문구 지우기, CSV 탭·CR, 배포 성공 뒤 버전 비우기, `parseStages` 숫자 꼴 검사, 계정 만들기 DUPLICATE 안내·비밀번호 변수 비우기·표시 이름 50자·코드 포인트 길이, contracts 주석
  - c38f34e: README, devlog 마감, 회고
- 기록
  - decisions 0066~0069(새로). 보탬은 0041(PATCH·FormData)과 0052(표 71 → 72)
  - devlog `2026-10-29.md`의 `# 보강 5: 통합 어드민 확장`(8항목)
  - 공부거리 4줄, `docs/index.md`
  - troubleshooting·experiments는 새 번호가 없다(0033·0018은 비어 있음). devlog 09:18 항목이 이유를 적었다(계획 단계에서 찾은 것이라 실행 중 에러가 아님)

## 검증 결과 (리뷰어가 직접 실행)
- api: 테스트 DB를 `DROP/CREATE` 한 번으로 다시 만든 뒤 실행했다(`docker exec -e MYSQL_PWD=…`, 값은 `.env`에서 변수로만 읽었다)
  - `npx vitest run`: `Test Files 83 passed (83)`, `Tests 571 passed (571)`, 324.51초, exit 0
  - `Connection is closed`는 0줄이다. `MaxListenersExceededWarning`은 7줄로, 보강 2~4 리뷰 때와 같은 수다(이월된 경고). 로그의 `ERROR` 줄(VAN 대조 실패, "일부러 낸 오류")은 테스트가 일부러 만든 것이다
  - `npx tsc --noEmit -p tsconfig.json`: exit 0
  - 끝난 뒤 테스트 DB를 같은 명령으로 다시 비웠다. `src/migrations`에는 기준 스냅샷 `.snapshot-terminal_ops.json`만 있다(테스트 DB 스냅샷 없음)
- 다른 앱 테스트와 tsc

  | 앱 | 테스트 | tsc |
  |---|---|---|
  | admin | `19 passed (19)` / `163 passed (163)` | exit 0 |
  | merchant | `7 passed (7)` / `47 passed (47)` | exit 0 |
  | field | `7 passed (7)` / `60 passed (60)` | exit 0 |
  | device-sim | `5 passed (5)` / `46 passed (46)` | exit 0 |
  | partners | `6 passed (6)` / `53 passed (53)` | exit 0 |

- README 테스트 표(api 83/571, admin 19/163, merchant 7/47, field 7/60, partners 6/53, device-sim 5/46)와 위 결과가 같다. devlog 09:46 항목의 숫자와도 같다
- `node scripts/docs-index.mjs --check`: `docs/index.md 최신`(exit 0). 절 제목은 결정 69·트러블슈팅 32·실험 17로, README "결정 69·트러블슈팅 32·실험 17"과 같다
- 프로세스
  - 시작 전 node PID는 43936·35448·28868·26108이었다(리뷰어가 띄운 것 아님)
  - 리뷰어 실행은 api 테스트(background, 스스로 끝남)를 빼고 모두 foreground였다. partners 테스트는 api 테스트가 끝난 뒤 돌렸다(api 테스트가 가상 업체 서버를 띄우므로). 끝난 뒤 node PID는 시작 전과 같다
  - Redis는 건드리지 않았다. `git status`도 깨끗하다(이 리뷰 파일만 새로 생긴다)
- 기록 정합성
  - 번호: decisions 0066~0069가 이어지고, 빈 번호와 중복이 없다. 브리프가 정한 다음 번호와 같다
  - devlog 제목 시각: 이 묶음의 8곳 모두 커밋 시각과 분까지 같다(09:18·09:26·09:26·09:29·09:31·09:34·09:38·09:46)
    - 09:18 계획 항목은 author 09:17:57, committer 09:18:10이다. 커밋 시각으로 보면 맞는다
    - Task 2(c79a589)는 반대로 author 09:26:56, committer 09:27:17이다. 제목 09:26은 author 시각과 같다. 몇 초 차이라 문제로 보지 않는다(보강 4 리뷰와 같은 판단)
    - Task 1과 Task 2가 같은 분(09:26)인 것은 devlog Task 2 "막힌 것"이 이유를 적었다(동시 작업, Task 1 커밋을 기다림)
  - 링크·경로: 브랜치가 바꾼 마크다운 파일의 링크와 `apps/…`·`docs/…`·`packages/…` 경로 465개를 스크립트로 검사했다
    - 없는 것으로 잡힌 11개는 모두 계획 문서의 코드 블록 안에 있다(README·회고에 붙일 글을 저장소 루트·`docs/` 기준으로 적은 것). 코드 블록 밖에서는 0개다
    - 실제로 깨진 링크는 0이다
  - 접근 표: `access-table.spec.ts`의 `EXPECTED` 72줄, 0052 표 OFFICE 칸의 `GET /firmware`(보강 5, 0066), 0052 "보강 5 보탬: 71 → 72", 0066 "71 → 72", 스펙 4장 "71 → 72"가 서로 같다
    - 어드민 새 화면이 부르는 경로(`/terminal-models`, `POST /terminals`, `POST /terminals/imports`, `GET·POST /firmware`, `POST /firmware-rollouts`, `GET·POST /admin/accounts`, `PATCH /admin/accounts/:id`, `/merchants`)는 모두 그 화면을 보는 역할에 표에서 열려 있다
  - 비밀 값 노출(값은 출력하지 않고 위치만 셈)
    - seed 파일의 시연 비밀번호 7개, 시연 외부 업체 키 1개: 브랜치 diff 어디에도 없다
    - 로컬 `.env`의 `DEVICE_API_KEY`·MySQL root 비밀번호: 브랜치 diff 어디에도 없다
    - 테스트의 `demo-pass-0001`은 계획에 있는 가짜 값이다(시연 계정 값 아님)
  - 작성자 주소와 지난 이력
    - 8개 커밋의 author·committer가 모두 noreply 주소다
    - diff에서 이메일 꼴을 모두 뽑으면 `noreply@anthropic.com`(계획 문서의 커밋 규칙) 뿐이다. 대학 도메인(`ac.kr`·`.edu`·학교 약칭)은 0건이다
    - 지난 프로젝트·전 직장 이름(설계 메모 `02_B_경력기반_추가기능.md`에 나오는 이름들)을 diff에서 찾았다. 0건이다
- 직접 하지 않은 것(지시에 따라)
  - 개발 DB 작업과 실서버 기동은 하지 않았다. devlog 09:46 항목의 기록과 대조만 했다: 테스트 DB 실서버 api `:3100`(`QUEUE_PREFIX=adminx-live`), 가상 업체 `:4012`, 어드민 `:5176` 프록시, 끈 PID 15632·29708·12144, `adminx-live*` 8키를 하나씩 DEL
  - 화면 확인은 컨트롤러가 했다(개발 DB, 내장 브라우저, 2026-10-29 09:47 KST 무렵)
    - 운영자 로그인 → 메뉴에 "단말기 등록"이 있다
    - 왼쪽 "다른 화면"에 매장·현장 링크, 관제·개발자센터·업체 콘솔·시뮬레이터 "준비 중", 쿠키 공유 안내가 보인다
    - `/registrations`에 한 대 등록(모델 선택)과 엑셀 올리기·안내가 보인다
    - `/firmware-rollouts`에 "펌웨어 등록"·"새 배포 만들기" 버튼이 있다. 연 배포 폼에 모델, 버전, 단계 비율(%), 실패 임계치(%), 최소 표본, 단계 시간 제한(분)이 있다
    - 로그아웃 → admin 로그인 → 메뉴에 "계정"이 있고 단말기 등록·박스 스캔은 없다
    - `/admin/accounts`에 시연 계정 7개, 역할 선택, 가맹점주 계정의 가맹점 선택, "사용 중지" 버튼, 현재 사용자 "나" 표시가 보인다
    - 콘솔에는 로그인 전의 예상된 401만 있다. api 오류 로그도 없다. 아무것도 저장하지 않았다
    - 이 결과는 아직 devlog에 없다(Minor 2)

## Strengths
- **점검표가 묶음의 범위를 정하고, 이 묶음 뒤에도 맞다.** 23단계를 리뷰어가 화면 코드와 하나씩 대조했다
  - 4(발주하기)·7(대조·마감): `PurchaseOrdersPage`의 `POST /purchase-orders`·`/close`
  - 8·10: `TerminalActions`의 배정·출고·전이
  - 12(어드민 A/S도)·13: `ServiceTicketsPage` 접수, `ServiceTicketDetailPage`의 `remote-checks`·`replacements`·`installations`
  - 14: 점주 `ServiceTicketDetailPage` 설치 확인
  - 15: 현장 `ScanPage`의 `RETURN_IN`
  - 18·20·21: 배포 멈춤·재개·중단, VAN 대조, 주간 리포트 화면
  - 1·3·16·17·0은 이 브랜치의 화면이다. 컨트롤러 확인도 같은 것을 봤다
  - "운영자·ADMIN 단계 중 화면이 없는 것은 2(외부 업체 키)뿐"도 맞다. 나머지 빈칸(4a·9 진행·11·19·22·23)은 시연자·단말기·시스템 단계이고, 보강 6~9로 표시돼 있다
- **서버 변경이 작고 규칙을 다시 만들지 않는다**
  - 새 엔드포인트는 `GET /firmware` 하나다. 모델 코드를 먼저 찾아 FK로 거르고, 없는 모델은 빈 목록이다(거르기 조건이므로). `@MaxLength(20)`이 긴 코드를 400으로 막는다
  - e2e가 키셋 두 쪽, 모델 거르기, 없는 모델, 긴 코드 400, 관제·ADMIN 200, 현장 403(`FORBIDDEN`), 로그인 없음 401을 본다
  - 같은 컨트롤러의 `list` 이름 겹침(TS2393)은 계획 단계에서 `listFirmware`로 피했고, 공부거리에 남겼다
- **contracts로 화면과 서버가 묶였다**
  - 요청 본문 셋은 DTO가 `implements`하고, 엑셀 등록 응답은 서비스 반환 타입 `Promise<TerminalImportView>`에 걸었다. 어긋나면 api tsc가 실패한다(0048 방식)
  - 화면은 `satisfies CreateRolloutRequest` 등으로 보낸다. `ROW_RESULT_LABEL: Record<RowResultCode, string>`이라 결과 코드가 늘면 tsc가 알려 준다
  - `CreateAccountRequest.loginId` 주석을 서버(`LOGIN_ID_INPUT`, 대문자를 받아 소문자로 저장)에 맞게 고쳤다(c6c2ffe)
- **계정 화면의 보안 처리가 근거와 테스트를 갖췄다**
  - 비밀번호
    - 입력칸은 `type="password"`·`autoComplete="new-password"`이다
    - 성공하면 `created`(아이디·역할)만 남긴다. `create.reset()`과 `gcTime: 0`으로 비밀번호가 든 요청 변수를 mutation 캐시에서 비운다. 테스트가 mutation 캐시의 변수 직렬화에 그 값이 없음을 단언한다
    - 실패하면 입력을 지우지 않는다. 그동안은 변수도 남지만, 같은 값이 입력칸에 그대로 있으므로 더 드러나는 것은 없다. 화면을 떠나면 `gcTime: 0`으로 사라진다. Devtools도 없다
    - 길이는 `[...password].length`로 센다. 서버 `@Length`(validator.js가 서로게이트 쌍을 한 글자로 셈)와 같다. 이모지 9·10글자 경계 테스트가 있다
  - LAST_ADMIN: ErrorBox 안내("다른 ADMIN 계정을 먼저 만들거나 살린 뒤")가 있다. `onError`가 고르던 칸을 되돌리고, `onSettled`가 다시 읽는다. 줄 `key`에 역할·가맹점·사용 여부를 넣어 서버 값이 바뀌면 줄을 새로 그린다
  - 자기 계정: "나" 표시가 있다. 역할 저장·사용 중지 확인 글에 "지금 세션이 끊겨 다시 로그인"을 더한다. 테스트가 저장 → 다시 읽기 401 → `getMe()` null(로그인 화면)까지 따라간다
  - DUPLICATE는 "대소문자 구분 없음"을 알린다. 서버가 소문자로 저장하므로 `Admin`도 `admin`과 겹친다는 것이 맞다
- **다른 화면 주소가 한 곳이고, 스킴을 거른다**
  - `pick()`이 `/^https?:\/\//i`만 받는다. `javascript:`·`data:`·스킴 없는 값·공백은 기본값(또는 null "준비 중")으로 간다. 테스트가 다섯 경우를 본다
  - 링크는 `target="_blank" rel="noreferrer"`(noopener 포함)다
  - `vite-env.d.ts`에 `VITE_*` 여섯 키를 선언했다. 0067의 "저장소 루트 `.env`를 읽지 않는 이유(api 비밀값을 화면 빌드가 보게 됨)"도 맞는 판단이다
- **입력 검증이 서버보다 엄하거나 같다.** 화면은 안내만 하고 최종 판단은 서버에 둔다
  - `parseStages`가 `/^\d+$/`로 `0x10`·`1e1`·`+10`·`10.5`를 거른다(c6c2ffe)
  - CSV 칸은 RFC 4180 따옴표에 더해, `= + - @`와 탭·CR로 시작하는 칸 앞에 `'`를 붙인다(수식 주입 방지)
  - 엑셀 파일째 거절 네 코드(`FILE_TOO_LARGE`·`INVALID_FILE`·`MISSING_COLUMNS`·`TOO_MANY_ROWS`)에 할 일 안내가 붙었다. 서버 상한(2MB·5,000행·머리글)과 같은 숫자다
- **기존 테스트를 고치지 않았다.** 바꾼 기존 테스트 파일은 넷이다. 모두 더하기만 했다(지운 줄 0)
  - `access-table.spec.ts`(+1줄), `query-keys.test.ts`(+1줄), `client.test.tsx`(새 it 둘), `Layout.test.tsx`(새 it 하나)
  - 테스트 도구 `render.tsx`는 FormData 기록 한 줄을 바꿨다
  - 회고의 "기존 테스트는 고치지 않았다"가 사실이다

## Issues

### Critical
없음.

### Important
없음.

### Minor

1. **회고 파일이 CRLF로, 그것도 git이 "텍스트 아님"으로 보는 채로 커밋됐다(c38f34e)**
   - 위치: `docs/retrospective.md`
   - 문제
     - master의 이 파일은 LF다. 브랜치 것은 모든 줄이 CRLF이고, 새로 더한 두 줄 앞에 `\r\r\n`(외톨이 CR)이 둘 있다
     - 외톨이 CR 때문에 git이 파일을 텍스트로 보지 않는다(`git ls-files --eol`이 `i/-text w/-text`). 그래서 `core.autocrlf=true`가 LF로 바꾸지 못하고 CRLF 그대로 들어갔다. 다른 파일은 모두 `i/lf`다
     - 결과: 실제로는 두 줄을 더했는데 diff는 103 + / 101 − 로 파일 전체가 바뀐 것처럼 나온다(`git diff -w`로 보면 더한 두 줄뿐이다). `git blame`이 이 커밋에 모든 줄을 돌린다. 다음 보강이 LF로 고치면 또 한 번 파일 전체 diff가 생긴다
   - 수정: 파일의 `\r`를 모두 지워 LF로 되돌리고 커밋한다. `git ls-files --eol docs/retrospective.md`가 `i/lf`, `git diff master -w --stat`과 `git diff master --stat`이 같은 줄 수(+2)인지 확인한다
2. **컨트롤러 화면 확인이 기록에 없다**
   - 위치: `docs/devlog/2026-10-29.md` 09:46 항목의 "컨트롤러 확인: 대기"
   - 문제: 위 "직접 하지 않은 것"의 컨트롤러 확인이 devlog에 없다. 보강 2~4 리뷰의 Minor 1과 같은 형태다
   - 수정: 화면 확인 항목을 하나 덧붙인다(그 기록 커밋의 시각을 제목으로). 내용
     - "받아 적은 것"이라는 표시, 개발 DB·내장 브라우저·09:47 무렵
     - 운영자: 메뉴 "단말기 등록", 다른 화면(매장·현장 링크, 넷 준비 중, 쿠키 안내), `/registrations`(한 대·엑셀 안내), `/firmware-rollouts`(두 버튼, 배포 폼 여섯 칸)
     - admin: 메뉴 "계정"(단말기 등록·박스 스캔 없음), 계정 7개, 역할·가맹점 선택, 사용 중지, "나"
     - 콘솔은 로그인 전 401만, api 오류 없음, **아무것도 저장하지 않음**
     - 09:46 항목의 "대기"를 이 항목으로 가리키게 한다
3. **결정 기록이 c6c2ffe를 따라가지 못했다**
   - (a) decisions/0068은 CSV 수식 머리 글자를 `= + - @`로만 적는다. c6c2ffe 뒤 코드는 탭·CR로 시작하는 칸도 막는다(`/^[=+\-@\t\r]/`)
   - (b) 0067에 스킴 검사가 없다. c6c2ffe 본문의 `Refs`는 0067을 가리키지만 0067 파일은 바뀌지 않았다. devlog는 "새 결정 없음(0067 동작을 좁힌 것)"이라 한다. 그러면 0067에 "http·https 주소만 받는다 — 아니면 기본값(c6c2ffe)" 한 줄이 있어야 다음 사람이 이 제약을 안다
   - (c) 0068 "결과·대가"의 "5,000행이면 수백 KB의 `data:` URL"은 실제보다 작다. 한글은 `encodeURIComponent`로 한 글자가 9바이트(`%EC%9D%B4` 꼴)가 되기 때문이다. 리뷰어가 `csvCell`·`toCsv`·`csvDataUrl`과 같은 식으로 5,000행을 재 봤다
     - 모두 `CREATED`(이유 없음): 328,998자(0.31MB)
     - 모두 `UNKNOWN_MODEL`(한글 이유): 1,063,998자(1.01MB)
     - 모두 `INVALID_FORMAT`(32자 시리얼 + 서버 이유 문구): 1,273,998자(1.21MB)
     - Chrome의 URL 길이 상한(2MB)에는 아직 들어간다. 다만 엑셀 칸에 긴 엉터리 값(형식 오류 행은 시리얼 칸 글자를 그대로 돌려준다)이 많으면 넘을 수 있다. 넘으면 내려받기가 조용히 실패한다
     - 또 `href`가 렌더마다 다시 만들어진다. "실패한 행만" 체크를 바꿀 때마다 5,000행 CSV를 다시 인코딩한다
     - 수정(선택): 0068에 잰 값을 적고 "넘으면 Blob URL"을 다시 볼 조건에 둔다. 코드를 고친다면 `useMemo`로 결과가 바뀔 때만 만들거나, 클릭할 때 `URL.createObjectURL`로 만들고 바로 `revokeObjectURL` 한다(공부거리에 이미 그 줄이 있다)
4. **README 통합 어드민 절 첫 문장이 스펙보다 넓게 말한다**
   - 위치: `README.md` "통합 어드민(보강 5)"의 "시연 시나리오를 어드민 화면만으로 끝까지 돌릴 수 있게"
   - 문제: 스펙 점검표로는 박스 스캔·검수·회수 입고(현장), 고장 접수·설치 확인(매장), 하트비트·단말기 업데이트(`device-sim` 명령줄), 골칫거리 켜기·택배 진행(가상 업체)이 어드민 밖이다. 스펙의 결론도 "운영자·ADMIN 단계 중 화면이 없는 것은 외부 업체 키뿐"이다
   - 수정: "시연 시나리오의 운영자·ADMIN 단계를 화면으로 돌릴 수 있게(외부 업체 키 제외, 단계별 점검표는 스펙 2장)" 정도로 바꾼다
5. **작은 것들(선택)**
   - (a) 계정 화면 아래 "외부 업체 키" 안내는 JSX 글자 안에 백틱을 썼다(`` `POST /admin/partner-keys` ``). 화면에는 백틱이 그대로 보인다. `<code>`로 감싸거나 백틱을 뺀다
   - (b) 표시 이름 `maxLength={50}`은 브라우저가 UTF-16 단위로 센다. 서버·화면 검사는 코드 포인트로 센다. 그래서 이모지가 섞인 이름은 서버가 받는 길이보다 먼저 막힌다. 더 엄한 쪽이라 문제는 없다. 그 탓에 "표시 이름은 1~50자입니다." 문구는 입력으로는 나올 수 없다. 남겨도 된다
   - (c) 회고 "보강 5가 남긴 것"에 CSV `data:` URL 크기(Minor 3c)를 한 구절 더하면 이월이 완전해진다

## Task별 리뷰를 거치지 않은 두 커밋 따로 본 것
- c6c2ffe
  - `apps.ts`: 위 Strengths. `trim()` 뒤에 검사하므로 앞뒤 공백 값도 맞게 처리한다. 대문자 스킴(`HTTPS://`)은 받는다. 브라우저가 그대로 연다
  - `ErrorBox` 안내 넷: 문구의 숫자(2MB·5,000행)와 열 이름이 서버 `terminal-import.service.ts`·컨트롤러 상한과 같다. 테스트가 `it.each`로 네 코드의 `<strong>` 안내를 본다
  - `RegistrationPage`
    - 성공 뒤 `keys.terminals.all`과 `keys.dashboard`를 함께 무효화한다(처음 화면 현황 수가 바로 맞는다). 테스트가 `invalidateQueries` 호출 인자를 단언한다
    - 새 시리얼을 치면 `register.reset()`으로 앞 결과를 지운다. `onSuccess`의 `setSerialNo('')`는 `onChange`를 부르지 않으므로 성공 문구는 남는다. 테스트가 이 순서를 본다
  - `csv.ts`: 위 Minor 3(a). 탭 시작 칸은 따옴표 없이 `'\t…`, CR 시작 칸은 따옴표로 감싼 `"'\r…"`. 단언 둘이 맞다
  - `RolloutForms`
    - 성공 뒤 `setVersion('')`로 같은 배포를 다시 누르지 못하게 한다. 성공 문구는 `create.data`라 남는다. 실패는 버전을 두어 고쳐 다시 보낼 수 있다
    - `onSettled` 무효화는 그대로다
  - `AccountsPage`: 위 Strengths. `create.reset()`을 `onSuccess` 안에서 부르는 것은 TanStack v5에서 observer의 현재 mutation만 떼는 동작이다. 같은 콜백 안의 `setLoginId('')` 등은 그대로 돈다. 테스트가 성공 문구(`created`)와 비워진 변수를 함께 단언한다
  - `vite-env.d.ts`: 새 파일이다. `/// <reference types="vite/client" />`도 있어 기존 `import.meta.env` 타입을 깨지 않는다(admin tsc 0)
  - devlog 09:38 항목
    - 시각이 맞다. 152 → 163(+11)이 테스트 파일 차이와 같다: apps 1, 등록 2 + `it.each` 4, csv는 같은 it 안 단언, 배포는 같은 it 안 단언, 계정 4
    - 옛 해시 `bfd5da3` → `f1c31fa` 정정도 적혀 있다
- c38f34e
  - README 차이를 줄 단위로 봤다
    - 구성도의 admin 설명, 로그인과 역할 절의 계정 화면 줄(0069 링크, 키 화면은 보강 7), 새 "통합 어드민(보강 5)" 절(0066~0069 링크와 env 이름), 기능 표의 어드민 행, 색인 수 69, 테스트 표(admin 19/163, api 83/571, "보강 4 뒤 api 82/568·admin 14/125" 앞 값 표기)
    - 모두 코드·실행 결과와 맞다. 단 첫 문장은 Minor 4
    - 실행 블록은 바뀌지 않았다. 어드민은 그대로 `(cd apps/admin && npm run dev)`(:5173)이다. 다른 화면 주소를 바꾸는 방법(`VITE_*` env를 주고 다시 띄우기)은 새 절에 있다. Vite가 `VITE_` 접두사의 프로세스 env를 읽으므로 맞는 안내다. devlog 실서버 확인에서 env로 준 주소가 `/src/apps.ts`에 들어간 것도 봤다
  - devlog 09:46 항목
    - 시각이 맞다. 전체 검증 숫자가 리뷰어 실행과 같다
    - 실서버 확인의 기대값, 끈 PID, 포트 LISTENING 0, DEL 키 수(8)가 적혀 있다. `db:migration:check`와 테스트 DB 스냅샷 없음도 적혀 있다
    - "비밀번호는 출력하지 않았다"가 있다
    - 컨트롤러 확인은 "대기"로 남아 있다(Minor 2)
  - 회고
    - `[x] 보강 5` 항목과 "보강 5가 남긴 것"이 새로 생겼다. 키 화면, 비밀번호·이름 바꾸기 화면, env 다시 띄우기, CSV 다시 받기 불가, 펌웨어 100개, 자기 역할 변경 401, 다른 탭 감지(0041)다
    - 내용은 맞다. 파일 줄바꿈은 Minor 1

## 남은 이월 목록
회고 6장의 "보강 5가 남긴 것"이 이월을 담고 있다. 이 리뷰가 보탤 것은 아래뿐이다.
- 이 리뷰의 Minor 3(c)(CSV `data:` URL 크기·렌더마다 다시 만들기), 5(a)(백틱)
- 회고 그대로 남는 것
  - 외부 업체 키 화면(보강 7), 비밀번호·표시 이름 바꾸기 화면, Vite env는 빌드 때 고정, 펌웨어 버전 선택지 100개, 자기 역할 변경 뒤 401로 로그인 화면
  - 보강 2~4에서 넘어온 것: 세 앱 쿠키 공유와 403 뒤 `/auth/me` 다시 읽기, 다른 탭 사용자 변경 감지, CSRF 토큰, 실기기 보안 문맥, 스캔 멱등 판정 두 벌 등
  - 이월된 경고 `MaxListenersExceededWarning` 7줄(api 테스트)
- 상태
  - 테스트 DB는 리뷰어가 마지막에 `DROP/CREATE`로 비워 두었다
  - 개발 DB와 Redis는 이 리뷰가 읽거나 쓰지 않았다
  - 컨트롤러 확인은 개발 DB에서 읽기만 했다(저장 안 함)

## Assessment
**병합 가능(Ready to merge). 병합 전에 Minor 1(회고 LF로 되돌리기)과 Minor 2(컨트롤러 확인 항목)를 하길 권한다. Minor 3(a)(b)와 Minor 4도 한 줄씩이라 같이 하면 좋다. 나머지는 이월 목록으로 충분하다.**
- 통과한 것
  - 리뷰어 실행: api 83/571, admin 19/163, merchant 7/47, field 7/60, device-sim 5/46, partners 6/53. 여섯 앱 tsc 0. 색인 `--check` 최신
  - 구현자 기록(c38f34e): 같은 숫자, 테스트 DB 실서버 프록시 확인
  - 컨트롤러: 개발 DB에서 운영자·admin 화면 확인
- 맞춰 본 것
  - 스펙 점검표 23단계와 화면 코드
  - 접근 표 72줄 = 0052 표 = 0052·0066·스펙 "71 → 72"
  - decisions 0066~0069 연속, 색인·README 수 69
  - 링크·경로(실제로 깨진 것 0), devlog 시각 8/8
  - README 테스트 표와 실행 절차
  - 비밀 값은 diff에 없다
  - 작성자 8/8 noreply, 대학 이메일·지난 프로젝트 이름 0건
- 어드민 새 화면은 서버 규칙을 다시 만들지 않는다
  - 형식·길이·단계 규칙은 미리 알려 주기만 하고, 판단은 서버 응답(행별 결과, 409·400 코드)에 둔다
  - 남은 것은 기록 몇 줄(회고 줄바꿈, 컨트롤러 확인, 0067·0068 보탬, README 한 문장)과 CSV 크기라는 선택 사항이다. 데이터나 권한을 깨는 것은 없다
