import { Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type { OpsErrorView, OpsOutboxView, OpsQueuesView, OpsSchedulerView, OpsSystemView } from '@terminal-ops/contracts';
import { OPS_VIEW, Roles } from '../auth/access.js';
import { OpsErrorsService } from './ops-errors.service.js';
import { OpsOutboxService } from './ops-outbox.service.js';
import { OpsQueuesService } from './ops-queues.service.js';

/** 최근 업무 오류 몇 건(합친 뒤 limit개) */
export class RecentErrorsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 30;
}

/**
 * 운영 관제 API(보강 6, decisions/0070). 관제 화면(apps/console)이 부른다. 보기는 관제·ADMIN(OPS_VIEW), 관제 작업은 관제(MONITOR)만.
 * 모두 그때그때 읽는다(캐시 없음) — 화면이 10초마다 다시 부르므로 한 번 읽기가 가벼워야 한다(큐마다 Redis 명령 몇 개, 표마다 인덱스 읽기 몇 번).
 */
@Controller('ops')
export class OpsController {
  constructor(
    private readonly queues: OpsQueuesService,
    private readonly outbox: OpsOutboxService,
    private readonly errors: OpsErrorsService,
  ) {}

  /** 큐마다 상태별 수·멈춤·가장 오래 기다린 job·최근 15분 처리량·워커 수 */
  @Get('queues')
  @Roles(...OPS_VIEW)
  queueSummary(): Promise<OpsQueuesView> {
    return this.queues.summary();
  }

  /** 주기 작업(코드 목록 + Redis 등록 상태·다음 실행 시각) */
  @Get('schedulers')
  @Roles(...OPS_VIEW)
  schedulers(): Promise<OpsSchedulerView[]> {
    return this.queues.schedulers();
  }

  /** api 프로세스 정보, MySQL·Redis 응답 시간, 큐를 처리하는 워커 */
  @Get('system')
  @Roles(...OPS_VIEW)
  system(): Promise<OpsSystemView> {
    return this.queues.system();
  }

  /** Outbox 상태별 수, 가장 오래된 PENDING·QUEUED */
  @Get('outbox')
  @Roles(...OPS_VIEW)
  outboxSummary(): Promise<OpsOutboxView> {
    return this.outbox.summary();
  }

  /** 최근 업무 오류(수집 실패·VAN 대조 실패·주간 리포트 보내기 실패·알림 실패) 한 목록, 최근부터 */
  @Get('errors')
  @Roles(...OPS_VIEW)
  recentErrors(@Query() query: RecentErrorsQuery): Promise<OpsErrorView[]> {
    return this.errors.recent(query.limit);
  }
}
