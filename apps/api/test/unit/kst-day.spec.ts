import { describe, expect, it } from 'vitest';
import { kstDayOf } from '../../src/common/kst.js';

const at = (iso: string) => new Date(iso);

describe('KST 하루 경계 (현장 작업자의 오늘, decisions/0063)', () => {
  it('KST 00:00(= 전날 15:00 UTC)부터 다음 날 00:00 전까지가 하루', () => {
    expect(kstDayOf(at('2026-10-28T03:00:00.000Z'))).toEqual({
      date: '2026-10-28',
      from: at('2026-10-27T15:00:00.000Z'),
      to: at('2026-10-28T15:00:00.000Z'),
    });
    // UTC로는 27일이지만 KST로는 28일 00:00
    expect(kstDayOf(at('2026-10-27T15:00:00.000Z')).date).toBe('2026-10-28');
    // 그 1ms 전(KST 27일 23:59:59.999)은 전날
    expect(kstDayOf(at('2026-10-27T14:59:59.999Z')).date).toBe('2026-10-27');
  });

  it('달·해가 바뀌는 날도 맞다', () => {
    expect(kstDayOf(at('2026-12-31T15:30:00.000Z'))).toEqual({
      date: '2027-01-01',
      from: at('2026-12-31T15:00:00.000Z'),
      to: at('2027-01-01T15:00:00.000Z'),
    });
  });
});
