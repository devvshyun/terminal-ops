import { describe, expect, it } from 'vitest';
import { formatKst, kstToday } from './format';

describe('formatKst — api의 common/kst.ts와 같은 규칙', () => {
  it('UTC ISO를 KST 벽시계로(날·해가 바뀌는 경우, 밀리초는 버림)', () => {
    expect(formatKst('2026-10-23T00:00:00.000Z')).toBe('2026-10-23 09:00:00 KST');
    expect(formatKst('2026-12-31T15:00:05.900Z')).toBe('2027-01-01 00:00:05 KST');
  });

  it('없으면 -, 시각이 아니면 받은 글자 그대로', () => {
    expect(formatKst(null)).toBe('-');
    expect(formatKst(undefined)).toBe('-');
    expect(formatKst('T')).toBe('T');
  });

  it('오늘(KST) 날짜: UTC 15:00 이후는 다음 날', () => {
    expect(kstToday(new Date('2026-10-26T14:59:59.000Z'))).toBe('2026-10-26');
    expect(kstToday(new Date('2026-10-26T15:00:00.000Z'))).toBe('2026-10-27');
  });
});
