import { IsOptional, Matches } from 'class-validator';
import type { SendWeeklyReportRequest } from '@terminal-ops/contracts';

export class SendWeeklyReportDto implements SendWeeklyReportRequest {
  /** 그 주 월요일(KST) 'YYYY-MM-DD'. 없으면 지난주 */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'weekStart는 YYYY-MM-DD(KST 월요일)입니다.' })
  weekStart?: string;
}
