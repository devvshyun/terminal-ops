import { describe, expect, it } from 'vitest';
import { ageText, formatKst, kstToday } from './format';

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

describe('ageText — 대시보드의 "N초 전 기준" (api decisions/0044)', () => {
  const now = new Date('2026-10-27T05:00:00.000Z');
  it('1분 안은 초, 그 뒤는 분(내림). 미래(시계 차이)는 0초', () => {
    expect(ageText('2026-10-27T04:59:58.400Z', now)).toBe('1초 전');
    expect(ageText('2026-10-27T04:59:00.001Z', now)).toBe('59초 전');
    expect(ageText('2026-10-27T04:59:00.000Z', now)).toBe('1분 전');
    expect(ageText('2026-10-27T04:57:30.000Z', now)).toBe('2분 전');
    expect(ageText('2026-10-27T05:00:03.000Z', now)).toBe('0초 전');
  });

  it('시각이 아니면 빈 글자', () => {
    expect(ageText('T', now)).toBe('');
  });
});
