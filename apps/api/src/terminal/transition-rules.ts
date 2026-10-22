import { TerminalStatus as S, TransitionSource } from './terminal-status.js';

export interface ModelPolicy {
  requiresReinspection: boolean;
}

interface TransitionRule {
  from: S;
  to: S;
  /** 이 전이를 일으킬 수 있는 경로. 없으면 INSPECTION을 뺀 모든 경로 */
  only?: TransitionSource[];
  /** 모델 정책 때문에 막히면 이유를 돌려준다 */
  blockedBy?: (policy: ModelPolicy) => string | undefined;
}

/** 단말기 상태 전이 표. 상태 변경 규칙은 여기 한 곳에만 둔다(decisions/0003). */
const RULES: TransitionRule[] = [
  { from: S.RECEIVED, to: S.INSPECTED, only: [TransitionSource.INSPECTION] },
  { from: S.RECEIVED, to: S.DEFECTIVE, only: [TransitionSource.INSPECTION] },
  { from: S.INSPECTED, to: S.IN_STOCK },
  { from: S.IN_STOCK, to: S.ALLOCATED },
  { from: S.ALLOCATED, to: S.IN_STOCK },
  { from: S.ALLOCATED, to: S.SHIPPED },
  { from: S.SHIPPED, to: S.DELIVERED },
  { from: S.DELIVERED, to: S.IN_SERVICE },
  { from: S.IN_SERVICE, to: S.RETURN_REQUESTED },
  { from: S.RETURN_REQUESTED, to: S.RETURNING },
  { from: S.RETURNING, to: S.RETURNED },
  { from: S.RETURNED, to: S.INSPECTED, only: [TransitionSource.INSPECTION] },
  { from: S.RETURNED, to: S.DEFECTIVE, only: [TransitionSource.INSPECTION] },
  {
    from: S.RETURNED,
    to: S.IN_STOCK,
    blockedBy: (p) => (p.requiresReinspection ? '재검수 필수 모델은 회수 후 검수를 거쳐야 재고로 돌릴 수 있습니다.' : undefined),
  },
  { from: S.DEFECTIVE, to: S.DISPOSED },
];

export type TransitionCheck = { ok: true } | { ok: false; reason: string };

export function checkTransition(from: S, to: S, source: TransitionSource, policy: ModelPolicy): TransitionCheck {
  const rule = RULES.find((r) => r.from === from && r.to === to);
  if (!rule) return { ok: false, reason: `허용되지 않은 전이입니다: ${from} → ${to}` };

  const allowed = rule.only ?? Object.values(TransitionSource).filter((s) => s !== TransitionSource.INSPECTION);
  if (!allowed.includes(source)) {
    return { ok: false, reason: `${from} → ${to} 는 ${allowed.join(', ')} 경로로만 바꿀 수 있습니다(요청 경로: ${source}).` };
  }

  const blocked = rule.blockedBy?.(policy);
  if (blocked) return { ok: false, reason: blocked };
  return { ok: true };
}
