import { describe, expect, it } from 'vitest';
import { fromDbDatetime } from '../../src/common/db-datetime.js';

describe('fromDbDatetime', () => {
  it('원시 SQL의 datetime 글자는 UTC로 읽는다(서버 지역 시간이 아니라)', () => {
    expect(fromDbDatetime('2026-10-23 09:29:15.606').toISOString()).toBe('2026-10-23T09:29:15.606Z');
    expect(fromDbDatetime('2026-10-23 09:29:15').toISOString()).toBe('2026-10-23T09:29:15.000Z');
  });

  it('이미 Date면 그대로', () => {
    const d = new Date('2026-10-23T00:00:00Z');
    expect(fromDbDatetime(d)).toBe(d);
  });
});
