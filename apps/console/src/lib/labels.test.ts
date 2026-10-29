import { describe, expect, it } from 'vitest';
import { scheduleText } from './labels';

describe('주기 글자', () => {
  it('간격은 딱 떨어지는 가장 큰 단위로, 안 떨어지면 ms', () => {
    expect(scheduleText({ every: 2_000, pattern: null, tz: null })).toBe('2초마다');
    expect(scheduleText({ every: 60_000, pattern: null, tz: null })).toBe('1분마다');
    expect(scheduleText({ every: 7_200_000, pattern: null, tz: null })).toBe('2시간마다');
    expect(scheduleText({ every: 1_500, pattern: null, tz: null })).toBe('1500ms마다');
  });

  it('cron은 식과 시간대', () => {
    expect(scheduleText({ every: null, pattern: '0 9 * * 1', tz: 'Asia/Seoul' })).toBe('cron 0 9 * * 1 (Asia/Seoul)');
    expect(scheduleText({ every: null, pattern: '0 2 * * *', tz: null })).toBe('cron 0 2 * * * (서버 시간대)');
  });
});
