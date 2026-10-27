import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller.js';
import { DashboardQueries } from './dashboard.queries.js';
import { DashboardService } from './dashboard.service.js';

/** 어드민 처음 화면의 집계와 Redis 캐시(decisions/0044). Redis 연결은 전역 RedisModule의 것 */
@Module({
  controllers: [DashboardController],
  providers: [DashboardQueries, DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
