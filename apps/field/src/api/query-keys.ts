/**
 * 쿼리 키. 모두 'field'로 시작한다 — 현장 화면의 쓰기(박스 스캔·검수)는 오늘 요약·검수 대기·단말기·발주를 함께 바꾸므로
 * 쓰기 뒤에는 `keys.all`을 통째로 무효화한다(점주 앱과 같은 방식 — 화면이 몇 개 안 되고 다시 읽는 양이 작다).
 */
export const keys = {
  all: ['field'] as const,
  today: ['field', 'today'] as const,
  openOrders: ['field', 'open-orders'] as const,
  queue: ['field', 'queue'] as const,
  terminal: (serialNo: string) => ['field', 'terminal', serialNo] as const,
  items: (modelCode: string) => ['field', 'items', modelCode] as const,
};
