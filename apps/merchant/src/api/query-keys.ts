/**
 * 쿼리 키. 모두 'me'로 시작한다 — 점주 화면의 쓰기(고장 접수·설치 확인)는 단말기 상태·배송·A/S를 함께 바꾸므로
 * 쓰기 뒤에는 `keys.all`을 통째로 무효화한다(화면이 몇 개 안 되고 한 매장 데이터라 다시 읽는 양이 작다).
 */
export const keys = {
  all: ['me'] as const,
  merchant: ['me', 'merchant'] as const,
  terminals: ['me', 'terminals'] as const,
  terminal: (serialNo: string) => ['me', 'terminal', serialNo] as const,
  tickets: (serialNo?: string) => ['me', 'tickets', serialNo ?? ''] as const,
  ticket: (id: number) => ['me', 'ticket', id] as const,
};
