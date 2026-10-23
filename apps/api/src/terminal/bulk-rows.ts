/** 시리얼 형식: 대문자·숫자·하이픈 4~32자. 단건 등록 DTO와 일괄 처리가 같은 규칙을 쓴다. */
export const SERIAL_NO_PATTERN = /^[A-Z0-9-]{4,32}$/;
export const SERIAL_NO_MESSAGE = 'serialNo는 대문자·숫자·하이픈 4~32자입니다.';

/**
 * 일괄 처리(박스 스캔·엑셀 등록)의 행별 결과 코드.
 * 성공: CREATED(신규 등록), RETURNED(회수 입고). 나머지는 그 행만 반영하지 않은 이유다(decisions/0019).
 */
export type RowResultCode =
  | 'CREATED'
  | 'RETURNED'
  | 'INVALID_FORMAT'
  | 'DUPLICATE_IN_REQUEST'
  | 'UNKNOWN_MODEL'
  | 'ALREADY_EXISTS'
  | 'NOT_IN_DELIVERY_NOTE'
  | 'NOT_FOUND'
  | 'INVALID_STATE';

export interface RowResult {
  serialNo: string;
  result: RowResultCode;
  message?: string;
}

/**
 * 엔진 입구에서 값을 문자열로 맞춘다: 문자열이 아니면 String()으로, 앞뒤 공백은 지우고, 없으면 빈 문자열.
 * 엑셀·JSON에서 숫자 12345678과 문자열 '12345678'이 섞여 와도 같은 시리얼로 본다(중복 판단과 DB 저장이 같은 값을 쓴다).
 * 빈 시리얼은 INVALID_FORMAT, 빈 모델 코드는 UNKNOWN_MODEL이 된다.
 */
export function normalizeRows(rows: readonly { serialNo?: unknown; modelCode?: unknown }[]): { serialNo: string; modelCode: string }[] {
  return rows.map((r) => ({ serialNo: normalizeValue(r.serialNo), modelCode: normalizeValue(r.modelCode) }));
}

/** 값 하나를 normalizeRows와 같은 규칙으로 맞춘다. 박스 스캔은 요청 입구에서 시리얼 목록 전체에 이것을 쓴다(troubleshooting/0012). */
export function normalizeValue(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * DB를 보지 않고 거를 수 있는 행을 고른다. 결과 배열은 입력과 같은 순서이고, 통과한 행은 null이다.
 * - 형식이 틀리면 INVALID_FORMAT
 * - 같은 요청에 같은 시리얼이 또 나오면 두 번째부터 DUPLICATE_IN_REQUEST(첫 번째만 처리한다). 첫 행이 뒤에서
 *   UNKNOWN_MODEL·ALREADY_EXISTS가 되어도 두 번째 행은 DUPLICATE_IN_REQUEST로 남는다(첫 행이 결정한다, decisions/0019).
 */
export function precheckSerials(serials: string[]): (RowResult | null)[] {
  const seen = new Set<string>();
  return serials.map((serialNo) => {
    if (!SERIAL_NO_PATTERN.test(serialNo)) return { serialNo, result: 'INVALID_FORMAT', message: SERIAL_NO_MESSAGE };
    if (seen.has(serialNo)) return { serialNo, result: 'DUPLICATE_IN_REQUEST', message: '같은 요청에 이미 있는 시리얼입니다.' };
    seen.add(serialNo);
    return null;
  });
}

/** 결과 코드별 개수 */
export function summarize(results: RowResult[]): Partial<Record<RowResultCode, number>> {
  const summary: Partial<Record<RowResultCode, number>> = {};
  for (const r of results) summary[r.result] = (summary[r.result] ?? 0) + 1;
  return summary;
}
