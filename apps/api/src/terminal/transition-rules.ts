import { TerminalStatus as S, TransitionSource } from './terminal-status.js';

export interface ModelPolicy {
  requiresReinspection: boolean;
}

interface TransitionRule {
  from: S;
  to: S;
  /** 이 전이를 일으킬 수 있는 경로. 없으면 MANUAL만 (decisions/0007) */
  only?: TransitionSource[];
  /** 모델 정책 때문에 막히면 이유를 돌려준다 */
  blockedBy?: (policy: ModelPolicy) => string | undefined;
}

/** `only`가 없는 규칙의 허용 출처. 새 출처를 추가해도 자동으로 넓어지지 않게 MANUAL만 둔다(decisions/0007). */
const DEFAULT_SOURCES: TransitionSource[] = [TransitionSource.MANUAL];

/** 단말기 상태 전이 표. 상태 변경 규칙은 여기 한 곳에만 둔다(decisions/0003). */
const RULES: TransitionRule[] = [
  { from: S.RECEIVED, to: S.INSPECTED, only: [TransitionSource.INSPECTION] },
  { from: S.RECEIVED, to: S.DEFECTIVE, only: [TransitionSource.INSPECTION] },
  { from: S.INSPECTED, to: S.IN_STOCK },
  // 배정·배정 취소는 가맹점을 함께 바꿔야 하므로 배정 API(ALLOCATION)로만 한다. 일반 전이 API로는 가맹점 없는 배정이 생긴다(decisions/0017).
  { from: S.IN_STOCK, to: S.ALLOCATED, only: [TransitionSource.ALLOCATION] },
  { from: S.ALLOCATED, to: S.IN_STOCK, only: [TransitionSource.ALLOCATION] },
  // 출고는 운송장과 함께여야 하므로 출고 API(SHIPMENT)로만 한다.
  { from: S.ALLOCATED, to: S.SHIPPED, only: [TransitionSource.SHIPMENT] },
  // 배송 완료는 택배 추적 수집(BATCH)이 자동으로, 또는 운영자가 수동으로 바꾼다.
  { from: S.SHIPPED, to: S.DELIVERED, only: [TransitionSource.MANUAL, TransitionSource.BATCH] },
  // 설치 확인: 운영자가 직접, 또는 A/S 교체 건의 설치 확인 API(SERVICE)가 바꾼다.
  { from: S.DELIVERED, to: S.IN_SERVICE, only: [TransitionSource.MANUAL, TransitionSource.SERVICE] },
  // 회수 요청: 운영자가 직접, 또는 A/S 교체 출고가 고장 단말기를 회수 요청으로 바꾼다.
  { from: S.IN_SERVICE, to: S.RETURN_REQUESTED, only: [TransitionSource.MANUAL, TransitionSource.SERVICE] },
  { from: S.RETURN_REQUESTED, to: S.RETURNING },
  // 회수 입고: 운영자가 직접, 또는 박스 스캔(RETURN_IN)이 일괄로 바꾼다.
  { from: S.RETURNING, to: S.RETURNED, only: [TransitionSource.MANUAL, TransitionSource.SCAN] },
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

  const allowed = rule.only ?? DEFAULT_SOURCES;
  if (!allowed.includes(source)) {
    return { ok: false, reason: `${from} → ${to} 는 ${allowed.join(', ')} 경로로만 바꿀 수 있습니다(요청 경로: ${source}).` };
  }

  const blocked = rule.blockedBy?.(policy);
  if (blocked) return { ok: false, reason: blocked };
  return { ok: true };
}
