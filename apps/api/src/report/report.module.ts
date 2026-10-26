import { Module } from '@nestjs/common';
import { WeeklyReportQueries } from './weekly-report.queries.js';

/** 주간 운영 리포트(F11): 집계 쿼리 */
@Module({
  providers: [WeeklyReportQueries],
  exports: [WeeklyReportQueries],
})
export class ReportModule {}
