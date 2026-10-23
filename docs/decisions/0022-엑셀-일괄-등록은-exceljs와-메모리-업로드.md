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
  - 첫 시트의 1행 머리글에서 `serialNo`·`modelCode`를 이름으로 찾는다(순서·다른 열 무관, 없으면 400 MISSING_COLUMNS). 빈 행은 건너뛰고, 셀은 보이는 글자(`cell.text`)를 앞뒤 공백 없이 쓴다. 숫자로 저장된 시리얼(20261023)도 글자 그대로 받는다. 엔진 입구의 `normalizeRows`가 한 번 더 다듬는다(같은 결과).
  - `defParamCharset: 'utf8'`: 지우고 테스트를 돌리면 이력 사유가 `"엑셀 일괄 등록: 10ì ìê³ .xlsx"`로 깨져 첫 테스트가 실패했다(`Tests 1 failed | 5 passed (6)`). multer 기본이 latin1이라서다. 되돌리니 6 passed.
  - `xlsx.load`의 인자 타입이 exceljs 자체 `Buffer extends ArrayBuffer` 선언이라 Node `Buffer`를 넘기면 TS2345가 난다. `as unknown as ArrayBuffer`로 타입만 맞췄다. 실행은 Node Buffer를 그대로 읽는다(`node dist`에서 빌드된 `readImportRows`로 숫자 셀 행을 읽어 `[{"row":2,"serialNo":"12345678","modelCode":"SN-100"}]` 확인).
- 결과·대가:
  - uuid 권고: `npm audit` 출력은 `uuid <11.1.1 … Missing buffer bounds check in v3/v5/v6 when buf is provided`, `exceljs >=3.5.0 Depends on vulnerable versions of uuid`, 고치려면 `npm audit fix --force`가 `exceljs@3.4.0`(breaking)을 설치한다. exceljs(설치된 uuid 8.3.2)는 `lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`에서 조건부 서식 id를 만들 때 `uuidv4()`를 buf 없이 부르는 것만 확인했고(grep), 권고는 v3/v5/v6에 buf를 넘길 때라 우리 입력이 그 경로로 가지 않는다고 판단해 그대로 둔다. `audit fix --force`는 하지 않는다.
  - 파일 전체를 메모리에 올리고 한 트랜잭션으로 넣는다. 5000행 × 한 트랜잭션의 시간과 락 시간은 실험 0006에서 1,000행으로 잰다.
- 다시 볼 조건: exceljs 새 버전이 나오거나 uuid 권고 등급이 오르면. 2MB·5000행보다 큰 파일 요구가 생기면 디스크 저장 + 스트리밍 읽기, 일괄 처리 비동기화(스펙 9장에서 뺀 것)를 본다.
