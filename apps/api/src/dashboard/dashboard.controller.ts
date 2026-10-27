import { Controller, Get, Query } from '@nestjs/common';
import { IsIn, IsOptional } from 'class-validator';
import { DashboardService } from './dashboard.service.js';

export class DashboardQuery {
  /** 'true'면 캐시를 건너뛰고 다시 집계한다(화면의 새로고침 버튼) */
  @IsOptional()
  @IsIn(['true', 'false'])
  refresh?: string;
}

/** 어드민 처음 화면의 숫자(decisions/0044). 집계는 최대 DASHBOARD_CACHE_TTL_MS(기본 30초) 전 것일 수 있다 — cachedAt으로 알린다 */
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  summary(@Query() query: DashboardQuery) {
    return this.dashboard.summary({ refresh: query.refresh === 'true' });
  }
}
