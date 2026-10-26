import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module.js';
import { WeeklyReportController } from './weekly-report.controller.js';
import { WeeklyReportQueries } from './weekly-report.queries.js';
import { WeeklyReportService } from './weekly-report.service.js';

/** 주간 운영 리포트(F11): 집계 쿼리, xlsx, 톡톡메신저 첨부 보내기(ToktokClient는 OutboxModule의 것) */
@Module({
  imports: [OutboxModule],
  controllers: [WeeklyReportController],
  providers: [WeeklyReportQueries, WeeklyReportService],
  exports: [WeeklyReportQueries, WeeklyReportService],
})
export class ReportModule {}
