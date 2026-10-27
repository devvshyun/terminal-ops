import type { Carrier, Role, TerminalStatus, TransitionSource } from '@terminal-ops/contracts';

/**
 * 화면에 보이는 이름만 둔다(규칙은 두지 않는다 — 가능한 전이는 서버가 준다, decisions/0040).
 * 키는 contracts의 상태 유니온이다 — 값이 하나라도 빠지거나 없는 값이 있으면 tsc가 막는다(decisions/0048). 모르는 값이 오면 값을 그대로 보여 준다(label()).
 */
/** 역할(api decisions/0052) */
export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: '관리자',
  OPERATOR: '운영자',
  MONITOR: '관제',
  FIELD: '현장 작업자',
  MERCHANT: '가맹점주',
};

export const TERMINAL_STATUS_LABEL: Record<TerminalStatus, string> = {
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

export const TERMINAL_STATUSES = Object.keys(TERMINAL_STATUS_LABEL) as TerminalStatus[];

export const SOURCE_LABEL: Record<TransitionSource, string> = {
  MANUAL: '수동',
  INSPECTION: '검수',
  BATCH: '배치',
  ALLOCATION: '배정',
  SHIPMENT: '출고',
  SCAN: '박스 스캔',
  IMPORT: '엑셀 등록',
  SERVICE: 'A/S',
};

export const CARRIER_LABEL: Record<Carrier, string> = {
  BUNGAE: '번개택배',
  NEURIMBO: '느림보물류',
};

/** 표에 쓸 이름. 모르는 값은 그대로 */
export function label(map: Record<string, string>, value: string | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return map[value] ?? value;
}
