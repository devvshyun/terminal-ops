# 0022. 엑셀 일괄 등록은 exceljs와 메모리 업로드

- 날짜 / 관련 기능: 2026-10-23 / F1
- 상황: decisions/0005에서 Day 3로 미룬 엑셀 일괄 등록. 박스 스캔과 같은 규칙(행별 결과, 유효한 행만 한 트랜잭션, decisions/0019)이어야 한다. `POST /terminals/imports`(multipart `file`, X-Operator 필수), 응답은 `{ fileName, total, summary, results: [{ row, serialNo, result, message? }] }` 201이고 `row`는 엑셀 행 번호다.
- 선택지(라이브러리):
  1. **exceljs 4.4.0**: 읽기·쓰기 둘 다 되고 타입이 들어 있다. 테스트에서 파일도 만든다. CommonJS라 default import(`import ExcelJS from 'exceljs'`)만 된다. named import(`import { Workbook } from 'exceljs'`)는 실행하면 `undefined`였다(node ESM에서 확인: `typeof m.Workbook` → `undefined`). `npm audit`에 uuid moderate 2건.
  2. SheetJS(xlsx): 최신판이 npm 레지스트리 밖에서 배포돼 버전 고정·감사가 번거롭다.
  3. CSV만: 운영자가 엑셀에서 저장 형식을 바꿔야 하고, 숫자 셀·인코딩 문제를 운영자가 떠안는다.
- 선택지(업로드):
  1. **multer 메모리 저장소 + 크기 제한**: 디스크 정리가 필요 없고 2MB면 메모리 부담이 작다.
  2. 디스크에 저장한 뒤 스트리밍으로 읽기: 큰 파일엔 맞지만 임시 파일 정리가 생긴다.
- 결정: exceljs + 메모리.
  - 제한: 2MB(`limits.fileSize`, 넘으면 413), 파일 1개, 이름이 `.xlsx`로 끝나야 함, 데이터 5000행(넘으면 400 TOO_MANY_ROWS). zip이 아니면 400 INVALID_FILE.
  - 첫 시트의 1행 머리글에서 `serialNo`·`modelCode`를 이름으로 찾는다(순서·다른 열 무관, 없으면 400 MISSING_COLUMNS). 빈 행은 건너뛴다. 엔진 입구의 `normalizeRows`가 한 번 더 다듬는다(같은 결과).
  - (2026-10-23 fix) 셀은 `cell.text`가 아니라 형식별로 읽는다(`src/terminal/import-cells.ts`의 `readCellValue`, troubleshooting/0013). 리뷰에서 잰 `cell.text` 동작: 숫자 서식 `00000`의 123 → `"123"`(서식 무시), 날짜 → 로컬 문자열, 결과가 0인 수식 → `""`, 결과 없는 수식 → `""`, 큰 정수 → 정밀도 손실, 오류 → `"#N/A"`, 불리언 → `"true"`.
    - 받는 것: 글자 그대로, 리치 텍스트(조각을 이어 붙임), 하이퍼링크(글자), 수식(`cell.result`를 같은 규칙으로. 결과 0은 `"0"`), 숫자는 `Number.isSafeInteger`일 때만 `String(v)`.
    - 그 행만 INVALID_FORMAT(이유를 message에): 날짜·오류·불리언 셀, 소수·안전 범위를 넘는 정수, 결과 없는 수식, 정수 부분을 0으로 채우는 숫자 서식(`00000`, `"SN"000000` 등)의 숫자 셀. 셀을 못 읽은 행은 엔진에 넘기지 않고 결과만 끼워 넣는다(엔진에서도 형식 오류 행은 중복 판단에 안 들어가므로 결과가 같다).
    - **시리얼은 텍스트 셀로 입력해야 한다.** exceljs는 숫자 서식을 적용하지 않으므로 `00123`처럼 보이는 숫자 셀은 `123`으로 읽힌다. 조용히 0을 버리는 대신 0 채움 서식이면 "텍스트 셀로 입력하세요"로 거절한다. 서식 없는 숫자 셀(20261023)은 지금처럼 받는다.
    - 버린 방법: exceljs `cell.text`(위 동작), 서식을 직접 적용해 글자 만들기(엑셀 서식 문법 전체를 구현해야 하고 날짜·조건부 구역까지 맞추기 어렵다).
  - (2026-10-23 fix) 업로드 오류 코드: multer가 낸 413은 `code: FILE_TOO_LARGE`, multer 400(다른 필드 이름 LIMIT_UNEXPECTED_FILE, 파일 두 개 LIMIT_FILE_COUNT, 글자 필드 LIMIT_FIELD_COUNT, part 수 초과)은 `code: INVALID_FILE`. `SingleFileInterceptor`(`src/common/upload.interceptor.ts`)가 `FileInterceptor`를 상속해 multer 단계의 오류만 바꾼다(핸들러·작업자 헤더 400은 그대로). 제한에 `fields: 0`, `parts: 1`을 더했다. 전역 필터로 하지 않은 이유: 다른 400·413과 구분할 수 없어서.
  - `defParamCharset: 'utf8'`: 지우고 테스트를 돌리면 이력 사유가 `"엑셀 일괄 등록: 10ì ìê³ .xlsx"`로 깨져 첫 테스트가 실패했다(`Tests 1 failed | 5 passed (6)`). multer 기본이 latin1이라서다. 되돌리니 6 passed.
  - `xlsx.load`의 인자 타입이 exceljs 자체 `Buffer extends ArrayBuffer` 선언이라 Node `Buffer`를 넘기면 TS2345가 난다. `as unknown as ArrayBuffer`로 타입만 맞췄다. 실행은 Node Buffer를 그대로 읽는다(`node dist`에서 빌드된 `readImportRows`로 숫자 셀 행을 읽어 `[{"row":2,"serialNo":"12345678","modelCode":"SN-100"}]` 확인).
- 결과·대가:
  - uuid 권고: `npm audit` 출력은 `uuid <11.1.1 … Missing buffer bounds check in v3/v5/v6 when buf is provided`, `exceljs >=3.5.0 Depends on vulnerable versions of uuid`, 고치려면 `npm audit fix --force`가 `exceljs@3.4.0`(breaking)을 설치한다. exceljs(설치된 uuid 8.3.2)는 `lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`에서 조건부 서식 id를 만들 때 `uuidv4()`를 buf 없이 부르는 것만 확인했고(grep), 권고는 v3/v5/v6에 buf를 넘길 때라 우리 입력이 그 경로로 가지 않는다고 판단해 그대로 둔다. `audit fix --force`는 하지 않는다.
  - 파일 전체를 메모리에 올리고 한 트랜잭션으로 넣는다. 5000행 × 한 트랜잭션의 시간과 락 시간은 실험 0006에서 1,000행으로 잰다. 실험 0006에서 엑셀 5000행 가져오기(읽기 시간·RSS 포함)도 함께 재야 한다.
  - **메모리 한계(알려진 한계)**: 2MB 제한은 압축된 업로드 크기다. xlsx는 zip이라 풀면 훨씬 커지고, exceljs는 시트 전체를 DOM처럼 메모리에 만든 뒤에야 5000행 검사를 한다. 리뷰 측정: 20만 행 2.78MB xlsx(2MB는 넘지만 같은 경향) → 읽기 약 1.1초, RSS 약 780MB. 2MB 안에도 행이 많은 파일을 넣을 수 있어 요청 몇 개로 메모리가 크게 오른다. 내가 직접 잰 숫자는 아니다(리뷰어 측정).
    - 선택지: 1) exceljs 스트리밍 `WorkbookReader`로 행을 읽다가 5001행째에서 멈추기 2) 압축을 풀기 전에 zip 중앙 디렉터리에서 시트 XML의 풀린 크기를 보고 일정 크기 이상이면 거절 3) 그대로 두기.
    - 이번에는 3. 스트리밍 읽기는 공유 문자열·스타일 처리 방식이 달라 셀 읽기 규칙을 다시 맞춰야 해서 간단하지 않다. backlog에 올리고, 실험 0006에서 5000행 가져오기를 재서 정한다.
- 다시 볼 조건: exceljs 새 버전이 나오거나 uuid 권고 등급이 오르면. 2MB·5000행보다 큰 파일 요구가 생기면 디스크 저장 + 스트리밍 읽기, 일괄 처리 비동기화(스펙 9장에서 뺀 것)를 본다.
