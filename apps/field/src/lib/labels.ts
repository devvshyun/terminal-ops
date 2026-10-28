import type { TerminalStatus } from '@terminal-ops/contracts';

/**
 * 단말기 상태 이름. 현장 작업자는 사내 직원이라 어드민 `lib/labels.ts`와 같은 말을 쓴다(점주 말 decisions/0060과 다름).
 * contracts 유니온이 키라 상태가 늘면 tsc가 빠진 이름을 알려 준다.
 */
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

/** 검수 대기 상태 — 전이 표에서 검수(INSPECTION)로 나갈 수 있는 상태(api transition-rules.ts: RECEIVED·RETURNED → INSPECTED·DEFECTIVE) */
export const INSPECTION_QUEUE_STATUSES = ['RECEIVED', 'RETURNED'] as const satisfies readonly TerminalStatus[];

/** 검수 대기 목록의 구분(새로 들어온 것 / 회수돼 돌아온 것) */
export const QUEUE_KIND_LABEL: Record<(typeof INSPECTION_QUEUE_STATUSES)[number], string> = {
  RECEIVED: '새 입고',
  RETURNED: '회수 입고',
};
