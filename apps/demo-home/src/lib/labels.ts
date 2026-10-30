import type { RolloutStatus, ServiceTicketStatus, TerminalStatus } from '@terminal-ops/contracts';

/** 시연 홈에 보이는 상태 이름(어드민 이름표와 같은 말). Record라 contracts에 상태가 늘면 tsc가 알린다 */
export const TERMINAL_STATUS: Record<TerminalStatus, string> = {
  RECEIVED: '입고',
  INSPECTED: '검수 합격',
  DEFECTIVE: '불량',
  IN_STOCK: '재고',
  ALLOCATED: '배정',
  SHIPPED: '배송 중',
  DELIVERED: '배송 완료',
  IN_SERVICE: '운영 중',
  RETURN_REQUESTED: '회수 요청',
  RETURNING: '회수 중',
  RETURNED: '회수 입고',
  DISPOSED: '폐기',
};

export const TICKET_STATUS: Record<ServiceTicketStatus, string> = {
  OPEN: '접수',
  RESOLVED_REMOTELY: '원격 해결',
  REPLACING: '교체 진행 중',
  CLOSED: '끝',
};

export const ROLLOUT_STATUS: Record<RolloutStatus, string> = { RUNNING: '진행 중', PAUSED: '멈춤', COMPLETED: '완료', ABORTED: '중단' };

/** 상태 코드 색 묶음 */
export const codeClass = (status: number) => (status >= 500 || status === 0 ? 'code-5xx' : status >= 400 ? 'code-4xx' : 'code-2xx');

/** 퍼센트(0~1 → '50%') */
export const pct = (rate: number) => `${Math.round(rate * 100)}%`;
