import type { Terminal } from './terminal.entity.js';
import type { TerminalStatusHistory } from './terminal-status-history.entity.js';
import { TerminalStatus, TransitionSource } from './terminal-status.js';
import { targetsFrom } from './transition-rules.js';

/** 엔티티를 그대로 내보내지 않고 응답 형태를 여기서 고정한다. model과 merchant가 populate돼 있어야 한다. */
export function toTerminalView(t: Terminal) {
  return {
    serialNo: t.serialNo,
    modelCode: t.model.code,
    merchantCode: t.merchant?.code ?? null,
    status: t.status,
    /** 지금 상태가 된 시각(decisions/0034) */
    statusChangedAt: t.statusChangedAt.toISOString(),
    version: t.version,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/**
 * 단말기 상세(어드민 화면). 지금 상태에서 할 수 있는 일을 서버가 전이 표에서 계산해 준다(decisions/0040).
 * - allowedTransitions: 일반 전이 API(POST /terminals/:serialNo/transitions, MANUAL)로 갈 수 있는 상태. 모델 정책에 막힌 것은 blockedReason
 * - actions: 전용 API로만 하는 일 — 배정·배정 취소(ALLOCATION), 출고(SHIPMENT), 검수(INSPECTION)
 */
export function toTerminalDetailView(t: Terminal) {
  const policy = { requiresReinspection: t.model.requiresReinspection };
  const can = (source: TransitionSource, to: TerminalStatus) =>
    targetsFrom(t.status, source, policy).some((x) => x.to === to && x.blockedReason === null);
  return {
    ...toTerminalView(t),
    modelName: t.model.name,
    merchantName: t.merchant?.name ?? null,
    allowedTransitions: targetsFrom(t.status, TransitionSource.MANUAL, policy),
    actions: {
      allocate: can(TransitionSource.ALLOCATION, TerminalStatus.ALLOCATED),
      cancelAllocation: can(TransitionSource.ALLOCATION, TerminalStatus.IN_STOCK),
      ship: can(TransitionSource.SHIPMENT, TerminalStatus.SHIPPED),
      inspect: targetsFrom(t.status, TransitionSource.INSPECTION, policy).length > 0,
    },
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
