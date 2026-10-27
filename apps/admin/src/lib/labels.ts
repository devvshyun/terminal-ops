/**
 * 화면에 보이는 이름만 둔다(규칙은 두지 않는다 — 가능한 전이는 서버가 준다, decisions/0040).
 * 키는 api enum 값(terminal-status.ts 등)이다. 모르는 값이 오면 값을 그대로 보여 준다(label()).
 */
export const TERMINAL_STATUS_LABEL: Record<string, string> = {
  RECEIVED: '입고',
  INSPECTED: '검수 합격',
  DEFECTIVE: '불량',
  IN_STOCK: '재고',
  ALLOCATED: '배정',
  SHIPPED: '출고(배송 중)',
  DELIVERED: '배송 완료',
  IN_SERVICE: '운영 중',
  RETURN_REQUESTED: '회수 요청',
  RETURNING: '회수 중',
  RETURNED: '회수 입고',
  DISPOSED: '폐기',
};

export const TERMINAL_STATUSES = Object.keys(TERMINAL_STATUS_LABEL);

export const SOURCE_LABEL: Record<string, string> = {
  MANUAL: '수동',
  INSPECTION: '검수',
  BATCH: '배치',
  ALLOCATION: '배정',
  SHIPMENT: '출고',
  SCAN: '박스 스캔',
  IMPORT: '엑셀 등록',
  SERVICE: 'A/S',
};

export const CARRIER_LABEL: Record<string, string> = {
  BUNGAE: '번개택배',
  NEURIMBO: '느림보물류',
};

/** 표에 쓸 이름. 모르는 값은 그대로 */
export function label(map: Record<string, string>, value: string | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return map[value] ?? value;
}
