import type { Terminal } from './terminal.entity.js';
import type { TerminalStatusHistory } from './terminal-status-history.entity.js';

/** 엔티티를 그대로 내보내지 않고 응답 형태를 여기서 고정한다. model이 populate돼 있어야 한다. */
export function toTerminalView(t: Terminal) {
  return {
    serialNo: t.serialNo,
    modelCode: t.model.code,
    status: t.status,
    version: t.version,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function toHistoryView(h: TerminalStatusHistory) {
  return {
    fromStatus: h.fromStatus ?? null,
    toStatus: h.toStatus,
    source: h.source,
    actor: h.actor,
    reason: h.reason,
    occurredAt: h.occurredAt.toISOString(),
  };
}
