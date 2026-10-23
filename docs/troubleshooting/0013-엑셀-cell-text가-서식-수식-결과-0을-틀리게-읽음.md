# 0013. 엑셀 셀을 cell.text로 읽어 0 채움 서식·수식 결과 0·날짜가 틀리게 들어감

- 날짜 / 관련 기능: 2026-10-23 / F1
- 증상: Task 6 리뷰에서 exceljs `cell.text` 동작을 잰 결과(리뷰어 측정): 숫자 서식 `00000`의 123 → `"123"`, 날짜 → 로컬 문자열, 결과가 0인 수식 → `""`, 결과 없는 수식 → `""`, 큰 정수 → 정밀도 손실, 오류 셀 → `"#N/A"`, 불리언 → `"true"`. `00123`으로 보이는 시리얼이 `123`으로 들어가거나, 결과 0인 수식 행이 빈 시리얼(INVALID_FORMAT, 이유는 형식 규칙 문구)이 된다.
- 가설: 1) `cell.text`는 서식을 적용하지 않는 단순 toString이다 2) 수식 결과 0은 파일에 `<v>0</v>`가 없어서 비어 있다
- 확인:
  - 테스트를 먼저 썼다(`test/unit/import-rows.spec.ts`, 파일을 exceljs로 만들어 `readImportRows`로 읽음). 고치기 전 코드: 6행(결과 0 수식) `"0"` 기대 → `""`, 8행(`00000` 서식 123) `INVALID` 기대 → `OK`. e2e 날짜 셀 행은 message가 `serialNo는 대문자·숫자·하이픈 4~32자입니다.`(날짜 문자열이 형식 검사에서 떨어졌을 뿐 이유가 안 보임).
  - 가설 2 기각: jszip으로 만든 파일의 시트 XML을 보니 `<c r="A2"><f>1-1</f><v>0</v></c>`로 결과 0이 들어 있다. 다시 읽은 `cell.value`는 `{"formula":"1-1"}`(result 없음), `cell.result`는 `0`.
  - 원인 코드: exceljs `lib/doc/cell.js` FormulaValue `_copyModel`이 `if (value) copy[name] = value`로 복사해 falsy인 result(0·false·'')를 버린다. `cell.value` 게터가 이 복사본을 준다. `toString()`도 `this.model.result ? … : ''`라 0이 빈 글자가 된다. `cell.result` 게터는 모델 값을 그대로 준다.
  - 가설 1 확인: `00000` 서식 셀의 `cell.text`는 `"123"`, `cell.numFmt`는 `"00000"`(서식 정보는 남아 있다).
- 원인: 셀 형식과 상관없이 `cell.text`(exceljs의 단순 문자열화)를 썼다. exceljs는 숫자 서식을 적용하지 않고, 수식 값 복사에서 falsy 결과를 버린다.
- 해결: (fix 커밋) `readCellValue`(`src/terminal/import-cells.ts`)로 형식별로 읽는다. 수식은 `cell.result`를 넘긴다. 정확히 못 읽는 셀(날짜·오류·불리언·큰 정수·소수·결과 없는 수식·0 채움 서식 숫자)은 그 행만 INVALID_FORMAT과 이유 message. 0 채움 서식 판단은 서식 첫 구역의 정수 부분에 0이 두 개 이상 이어지는지(따옴표 글자·이스케이프·[] 조건 제외). 고친 뒤 단위 6 + 파일 읽기 1 + e2e 1 통과. decisions/0022 갱신.
- 남은 것: 결과가 `false`인 수식은 불리언이라 어차피 거절한다. 공유 수식(sharedFormula)도 `cell.type`이 Formula라 `cell.result`로 읽는다(테스트는 안 함).
- 배운 것: → study/backlog.md
