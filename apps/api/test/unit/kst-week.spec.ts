import { describe, expect, it } from 'vitest';
import type { EntityManager } from '@mikro-orm/mysql';
import { WeeklyReportQueries } from '../../src/report/weekly-report.queries.js';
import { kstDate, kstWeekOf, parseKstWeekStart, previousKstWeek } from '../../src/report/kst-week.js';

const at = (iso: string) => new Date(iso);

describe('KST 주 경계 (decisions/0035, troubleshooting/0016 교훈)', () => {
  it('KST 월요일 00:00(= 일요일 15:00 UTC)부터 다음 월요일 00:00 전까지가 한 주', () => {
    // 2026-10-19는 월요일
    expect(kstWeekOf(at('2026-10-18T15:00:00.000Z'))).toEqual({
      weekStart: '2026-10-19',
      from: at('2026-10-18T15:00:00.000Z'),
      to: at('2026-10-25T15:00:00.000Z'),
    });
    // 그 1ms 전(KST 일요일 23:59:59.999)은 앞 주
    expect(kstWeekOf(at('2026-10-18T14:59:59.999Z')).weekStart).toBe('2026-10-12');
    // KST 일요일 23:59(UTC로는 같은 날 14:59)는 아직 그 주
    expect(kstWeekOf(at('2026-10-25T14:59:00.000Z')).weekStart).toBe('2026-10-19');
    // UTC 날짜로는 일요일이지만 KST로는 월요일 00:30
    expect(kstWeekOf(at('2026-10-25T15:30:00.000Z')).weekStart).toBe('2026-10-26');
  });

  it('월요일 09:00 KST(= 00:00 UTC)에 돌면 지난주를 고른다. 해·달이 바뀌는 주도 맞다', () => {
    expect(previousKstWeek(at('2026-10-26T00:00:00.000Z'))).toEqual({
      weekStart: '2026-10-19',
      from: at('2026-10-18T15:00:00.000Z'),
      to: at('2026-10-25T15:00:00.000Z'),
    });
    // 2027-01-04(월) 09:00 KST → 2026-12-28(월) 주
    expect(previousKstWeek(at('2027-01-04T00:00:00.000Z')).weekStart).toBe('2026-12-28');
    expect(kstDate(at('2026-12-31T15:00:00.000Z'))).toBe('2027-01-01');
  });

  it("'YYYY-MM-DD' 월요일만 받는다", () => {
    expect(parseKstWeekStart('2026-10-19')).toEqual(kstWeekOf(at('2026-10-20T03:00:00.000Z')));
    expect(parseKstWeekStart('2026-10-20')).toBeNull(); // 화요일
    expect(parseKstWeekStart('2026-02-30')).toBeNull();
    expect(parseKstWeekStart('2026-10-19T00:00')).toBeNull();
    expect(parseKstWeekStart('19-10-2026')).toBeNull();
  });
});

describe('WeeklyReportQueries.collect 주 입력 검증 (리뷰 반영)', () => {
  // DB에 가기 전에 던진다 — em을 쓰면 실패하도록 빈 객체를 넘긴다
  const queries = new WeeklyReportQueries({} as EntityManager);

  it('from·to가 날짜가 아니거나(NaN) to가 from보다 늦지 않으면 이유를 담아 던진다', async () => {
    const week = parseKstWeekStart('2026-10-19')!;
    await expect(queries.collect({ ...week, from: new Date(Number.NaN) })).rejects.toThrow('주간 리포트 주 2026-10-19: from이 올바른 시각이 아닙니다(Invalid Date)');
    await expect(queries.collect({ ...week, to: new Date('x') })).rejects.toThrow('주간 리포트 주 2026-10-19: to가 올바른 시각이 아닙니다(Invalid Date)');
    await expect(queries.collect({ ...week, to: week.from })).rejects.toThrow('주간 리포트 주 2026-10-19: to(2026-10-18T15:00:00.000Z)가 from(2026-10-18T15:00:00.000Z)보다 늦어야 합니다');
  });
});
