import { describe, expect, it } from 'vitest';
import { agoText, formatKst, formatKstShort } from './format';

describe('KST 시각 (어드민 lib/format.test.ts와 같은 값)', () => {
  it('UTC ISO를 KST로, 밀리초는 버린다', () => {
    expect(formatKst('2026-10-23T00:00:00.000Z')).toBe('2026-10-23 09:00:00 KST');
    expect(formatKst('2026-12-31T15:00:05.900Z')).toBe('2027-01-01 00:00:05 KST');
    expect(formatKst(null)).toBe('-');
    expect(formatKst(undefined)).toBe('-');
    expect(formatKst('T')).toBe('T');
  });

  it('짧은 KST는 월-일 시:분', () => {
    expect(formatKstShort('2026-10-27T15:30:45Z')).toBe('10-28 00:30');
    expect(formatKstShort(undefined)).toBe('-');
  });

  it('얼마나 전인가 — 분·시간·일, 미래는 방금 전', () => {
    const now = new Date('2026-10-28T03:00:00Z');
    expect(agoText('2026-10-28T02:59:30Z', now)).toBe('방금 전');
    expect(agoText('2026-10-28T02:15:00Z', now)).toBe('45분 전');
    expect(agoText('2026-10-27T22:00:00Z', now)).toBe('5시간 전');
    expect(agoText('2026-10-25T03:00:00Z', now)).toBe('3일 전');
    expect(agoText('2026-10-28T03:05:00Z', now)).toBe('방금 전');
  });
});
