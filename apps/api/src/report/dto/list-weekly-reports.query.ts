import { Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

/** GET /reports/weekly 조건: 최근 주부터, before(그 주 월요일)보다 앞 주만 — 주 키셋(decisions/0039) */
export class ListWeeklyReportsQuery {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'before는 YYYY-MM-DD입니다.' })
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
