/**
 * 엑셀 셀 값을 형식(type)별로 글자로 읽는다(decisions/0022).
 * exceljs의 cell.text는 쓰지 않는다: 숫자 서식(00000)을 무시하고, 날짜는 로컬 문자열, 결과가 0인 수식은 빈 글자,
 * 큰 정수는 정밀도를 잃은 글자가 된다. 정확히 읽을 수 없는 셀은 ok: false와 이유(message)를 돌려주고, 그 행은 INVALID_FORMAT이 된다.
 */
export type CellRead = { ok: true; text: string } | { ok: false; text: string; message: string };

const TEXT_CELL = '텍스트 셀로 입력하세요.';

/**
 * @param value 셀 값(exceljs CellValue). 수식 셀은 결과를 `cell.result`로 넣어 준다 — exceljs의 `cell.value` 게터는
 *   결과가 0·false·''인 수식에서 result를 버린다(값이 falsy면 복사하지 않음).
 * @param numFmt 셀 숫자 서식. 앞자리 0을 채우는 서식(00000 등)의 숫자 셀은 서식이 적용되지 않아 0이 사라지므로 거절한다.
 */
export function readCellValue(value: unknown, numFmt?: string): CellRead {
  if (value === null || value === undefined) return { ok: true, text: '' };
  if (typeof value === 'string') return { ok: true, text: value };
  if (typeof value === 'number') return readNumber(value, numFmt);
  if (typeof value === 'boolean') return { ok: false, text: String(value), message: '불리언(TRUE/FALSE) 셀은 받지 않습니다.' };
  if (value instanceof Date) {
    const text = Number.isNaN(value.getTime()) ? '' : value.toISOString();
    return { ok: false, text, message: `날짜 셀은 받지 않습니다. ${TEXT_CELL}` };
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.error === 'string') return { ok: false, text: v.error, message: `오류 셀(${v.error})은 받지 않습니다.` };
    if (Array.isArray(v.richText)) return { ok: true, text: richText(v.richText) };
    // 수식은 호출하는 쪽(readImportRows)이 { formula: cell.formula, result: cell.result }로 넘긴다. 공유 수식도 cell.formula가
    // 풀어 쓴 수식을 주므로 sharedFormula 키는 따로 보지 않는다.
    // 결과가 빈 글자('')인 수식은 빈 글자로 읽는다. 시리얼 칸이면 엔진에서 INVALID_FORMAT(형식 규칙 문구)이 되고, 두 칸 모두 비면 빈 행으로 건너뛴다(decisions/0022).
    if ('formula' in v) {
      if (v.result === undefined || v.result === null) {
        const formula = typeof v.formula === 'string' ? v.formula : '';
        return { ok: false, text: `=${formula}`, message: '계산된 값이 없는 수식 셀입니다. 값으로 붙여 넣으세요.' };
      }
      return readCellValue(v.result, numFmt);
    }
    if ('hyperlink' in v) {
      const text = v.text;
      if (typeof text === 'string') return { ok: true, text };
      if (text && typeof text === 'object' && Array.isArray((text as { richText?: unknown }).richText)) {
        return { ok: true, text: richText((text as { richText: unknown[] }).richText) };
      }
      return { ok: true, text: '' };
    }
  }
  return { ok: false, text: '', message: '읽을 수 없는 셀 형식입니다.' };
}

function richText(parts: unknown[]): string {
  return parts.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('');
}

function readNumber(value: number, numFmt?: string): CellRead {
  const text = String(value);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, text, message: `정수가 아니거나 너무 큰 숫자 셀은 정확히 읽을 수 없습니다. ${TEXT_CELL}` };
  }
  if (numFmt && padsWithZeros(numFmt)) {
    return { ok: false, text, message: `앞자리 0을 채우는 숫자 서식 셀은 받지 않습니다(서식이 적용되지 않아 0이 사라집니다). ${TEXT_CELL}` };
  }
  return { ok: true, text };
}

/**
 * 숫자 서식이 정수 부분을 0으로 채우는가(예: 00000, "SN"000000, 000-0000).
 * 첫 구역(; 앞)에서 따옴표 글자·역슬래시 이스케이프·[] 조건을 지우고, 소수점 앞에 0이 두 개 이상 이어지면 그렇다고 본다.
 * 0 하나(0), 천 단위(#,##0), 소수 자리(0.00)는 채우지 않는다.
 * 이스케이프 글자를 지운 뒤에 보므로 `0\-0`처럼 0 사이에 글자 하나가 끼인 서식도 0이 이어진 것으로 보고 거절한다(더 많이 거절하는 쪽, 안전한 방향).
 */
export function padsWithZeros(numFmt: string): boolean {
  const section = numFmt.split(';')[0]
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[[^\]]*\]/g, '');
  const integerPart = section.split('.')[0];
  return /0{2,}/.test(integerPart.replace(/,/g, ''));
}
