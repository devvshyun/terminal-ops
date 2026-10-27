import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { IsCalendarDate } from '../../common/calendar-date.js';

/** GET /reports/weekly 조건: 최근 주부터, before(그 주 월요일)보다 앞 주만 — 주 키셋(decisions/0039) */
export class ListWeeklyReportsQuery {
  @IsOptional()
  @IsCalendarDate({ message: 'before는 달력에 있는 날짜(YYYY-MM-DD)입니다.' })
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
