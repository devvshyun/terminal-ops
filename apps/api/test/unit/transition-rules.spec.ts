import { describe, expect, it } from 'vitest';
import { checkTransition } from '../../src/terminal/transition-rules.js';
import { TerminalStatus as S, TransitionSource as Src } from '../../src/terminal/terminal-status.js';

const normal = { requiresReinspection: false };
const strict = { requiresReinspection: true };

describe('checkTransition', () => {
  it.each([
    [S.INSPECTED, S.IN_STOCK],
    [S.IN_STOCK, S.ALLOCATED],
    [S.ALLOCATED, S.IN_STOCK],
    [S.ALLOCATED, S.SHIPPED],
    [S.SHIPPED, S.DELIVERED],
    [S.DELIVERED, S.IN_SERVICE],
    [S.IN_SERVICE, S.RETURN_REQUESTED],
    [S.RETURN_REQUESTED, S.RETURNING],
    [S.RETURNING, S.RETURNED],
    [S.RETURNED, S.IN_STOCK],
    [S.DEFECTIVE, S.DISPOSED],
  ])('수동 전이 %s → %s 허용', (from, to) => {
    expect(checkTransition(from, to, Src.MANUAL, normal)).toEqual({ ok: true });
  });

  it('정의되지 않은 전이는 거절하고 이유를 준다', () => {
    const r = checkTransition(S.RECEIVED, S.SHIPPED, Src.MANUAL, normal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('RECEIVED → SHIPPED');
  });

  it('같은 상태로의 전이는 거절', () => {
    expect(checkTransition(S.IN_STOCK, S.IN_STOCK, Src.MANUAL, normal).ok).toBe(false);
  });

  it.each([
    [S.RECEIVED, S.INSPECTED],
    [S.RECEIVED, S.DEFECTIVE],
    [S.RETURNED, S.INSPECTED],
    [S.RETURNED, S.DEFECTIVE],
  ])('%s → %s 는 검수로만 가능', (from, to) => {
    expect(checkTransition(from, to, Src.MANUAL, normal).ok).toBe(false);
    expect(checkTransition(from, to, Src.INSPECTION, normal)).toEqual({ ok: true });
  });

  it('검수는 검수 전용 전이 외에는 쓸 수 없다', () => {
    expect(checkTransition(S.INSPECTED, S.IN_STOCK, Src.INSPECTION, normal).ok).toBe(false);
  });

  it('재검수 필수 모델은 회수 후 바로 재고로 못 간다', () => {
    const r = checkTransition(S.RETURNED, S.IN_STOCK, Src.MANUAL, strict);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('재검수');
  });

  it('배송 완료는 수동과 배치 둘 다 가능', () => {
    expect(checkTransition(S.SHIPPED, S.DELIVERED, Src.MANUAL, normal)).toEqual({ ok: true });
    expect(checkTransition(S.SHIPPED, S.DELIVERED, Src.BATCH, normal)).toEqual({ ok: true });
  });

  it.each([
    [S.INSPECTED, S.IN_STOCK],
    [S.IN_STOCK, S.ALLOCATED],
    [S.ALLOCATED, S.SHIPPED],
    [S.DELIVERED, S.IN_SERVICE],
    [S.RETURNED, S.IN_STOCK],
    [S.DEFECTIVE, S.DISPOSED],
  ])('배치는 일반 전이 %s → %s 를 할 수 없다', (from, to) => {
    const r = checkTransition(from, to, Src.BATCH, normal);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('MANUAL 경로로만');
  });

  it('검수 전용 전이는 배치로도 안 된다', () => {
    expect(checkTransition(S.RECEIVED, S.INSPECTED, Src.BATCH, normal).ok).toBe(false);
  });

  it('폐기는 끝 상태다', () => {
    for (const to of Object.values(S)) {
      expect(checkTransition(S.DISPOSED, to, Src.MANUAL, normal).ok).toBe(false);
    }
  });
});
