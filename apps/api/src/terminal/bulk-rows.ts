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
 * DB를 보지 않고 거를 수 있는 행을 고른다. 결과 배열은 입력과 같은 순서이고, 통과한 행은 null이다.
 * - 형식이 틀리면 INVALID_FORMAT
 * - 같은 요청에 같은 시리얼이 또 나오면 두 번째부터 DUPLICATE_IN_REQUEST(첫 번째만 처리한다)
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
