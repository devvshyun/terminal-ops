import { describe, expect, it } from 'vitest';
import { checkTransition, targetsFrom } from '../../src/terminal/transition-rules.js';
import { TerminalStatus as S, TransitionSource as Src } from '../../src/terminal/terminal-status.js';

const normal = { requiresReinspection: false };
const strict = { requiresReinspection: true };

describe('checkTransition', () => {
  it.each([
    [S.INSPECTED, S.IN_STOCK],
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

  // 전용 출처 표(decisions/0007, 0017): 표에 적은 출처만 허용하고 나머지 출처는 모두 거절한다.
  it.each([
    [S.IN_STOCK, S.ALLOCATED, [Src.ALLOCATION]],
    [S.ALLOCATED, S.IN_STOCK, [Src.ALLOCATION]],
    [S.ALLOCATED, S.SHIPPED, [Src.SHIPMENT]],
    [S.SHIPPED, S.DELIVERED, [Src.MANUAL, Src.BATCH]],
    [S.DELIVERED, S.IN_SERVICE, [Src.MANUAL, Src.SERVICE]],
    [S.IN_SERVICE, S.RETURN_REQUESTED, [Src.MANUAL, Src.SERVICE]],
    [S.RETURNING, S.RETURNED, [Src.MANUAL, Src.SCAN]],
  ])('%s → %s 는 %j 출처만 허용', (from, to, allowed) => {
    for (const source of Object.values(Src)) {
      expect(checkTransition(from, to, source, normal).ok, source).toBe(allowed.includes(source));
    }
  });

  it('일반 전이 API(MANUAL)로는 배정·배정 취소·출고를 할 수 없다', () => {
    for (const [from, to] of [
      [S.IN_STOCK, S.ALLOCATED],
      [S.ALLOCATED, S.IN_STOCK],
      [S.ALLOCATED, S.SHIPPED],
    ] as const) {
      const r = checkTransition(from, to, Src.MANUAL, normal);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain('경로로만');
    }
  });

  it.each([Src.BATCH, Src.SCAN, Src.IMPORT, Src.SERVICE, Src.ALLOCATION, Src.SHIPMENT])(
    '%s 는 only가 없는 일반 전이를 할 수 없다(기본 허용은 MANUAL)',
    (source) => {
      for (const [from, to] of [
        [S.INSPECTED, S.IN_STOCK],
        [S.RETURN_REQUESTED, S.RETURNING],
        [S.RETURNED, S.IN_STOCK],
        [S.DEFECTIVE, S.DISPOSED],
      ] as const) {
        const r = checkTransition(from, to, source, normal);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain('MANUAL 경로로만');
      }
    },
  );

  it('검수 전용 전이는 배치로도 안 된다', () => {
    expect(checkTransition(S.RECEIVED, S.INSPECTED, Src.BATCH, normal).ok).toBe(false);
  });

  it('폐기는 끝 상태다', () => {
    for (const to of Object.values(S)) {
      expect(checkTransition(S.DISPOSED, to, Src.MANUAL, normal).ok).toBe(false);
    }
  });
});

describe('targetsFrom — 화면이 그리는 전이 버튼 (decisions/0040)', () => {
  it('MANUAL로 갈 수 있는 상태만 준다(배정·출고·검수 전용 전이는 빠진다)', () => {
    expect(targetsFrom(S.SHIPPED, Src.MANUAL, normal)).toEqual([{ to: S.DELIVERED, blockedReason: null }]);
    expect(targetsFrom(S.IN_STOCK, Src.MANUAL, normal)).toEqual([]);
    expect(targetsFrom(S.RECEIVED, Src.MANUAL, normal)).toEqual([]);
    expect(targetsFrom(S.IN_STOCK, Src.ALLOCATION, normal)).toEqual([{ to: S.ALLOCATED, blockedReason: null }]);
    expect(targetsFrom(S.DISPOSED, Src.MANUAL, normal)).toEqual([]);
  });

  it('모델 정책에 막힌 전이는 빼지 않고 이유와 함께 준다(재검수 필수 모델의 회수 → 재고)', () => {
    expect(targetsFrom(S.RETURNED, Src.MANUAL, normal)).toEqual([{ to: S.IN_STOCK, blockedReason: null }]);
    expect(targetsFrom(S.RETURNED, Src.MANUAL, strict)).toEqual([{ to: S.IN_STOCK, blockedReason: expect.stringContaining('재검수') }]);
  });

  it('모든 상태·경로·정책에서 targetsFrom과 checkTransition이 같은 답을 한다(규칙 표 하나)', () => {
    for (const policy of [normal, strict]) {
      for (const source of Object.values(Src)) {
        for (const from of Object.values(S)) {
          const targets = targetsFrom(from, source, policy);
          for (const to of Object.values(S)) {
            const target = targets.find((x) => x.to === to);
            const check = checkTransition(from, to, source, policy);
            expect(check.ok, `${from} -> ${to} (${source})`).toBe(target !== undefined && target.blockedReason === null);
            if (target?.blockedReason) expect(check).toEqual({ ok: false, reason: target.blockedReason });
          }
        }
      }
    }
  });
});
