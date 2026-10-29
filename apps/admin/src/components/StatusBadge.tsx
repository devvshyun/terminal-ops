import type { TerminalStatus } from '@terminal-ops/contracts';
import { label, STATUS_STAGE, TERMINAL_STATUS_LABEL } from '../lib/labels';

/** 단말기 상태 이름표 — 색은 생애주기 구간(decisions/0079). 글자는 운영자 말 그대로 */
export function StatusBadge({ status }: { status: TerminalStatus }) {
  return <span className={`badge stage-${STATUS_STAGE[status] ?? 'intake'}`}>{label(TERMINAL_STATUS_LABEL, status)}</span>;
}
