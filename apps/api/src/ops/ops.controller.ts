import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type {
  BeforeIdPage,
  OpsActionView,
  OpsErrorView,
  OpsFailedJobsPage,
  OpsJobActionResult,
  OpsOutboxView,
  OpsQueuesView,
  OpsRequeueResult,
  OpsSchedulerView,
  OpsSystemView,
} from '@terminal-ops/contracts';
import { OPS_VIEW, Roles } from '../auth/access.js';
import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { Role } from '../auth/role.js';
import { BeforeIdQuery } from '../common/keyset.js';
import { OpsAuditService } from './ops-audit.service.js';
import { OpsErrorsService } from './ops-errors.service.js';
import { OpsJobsService } from './ops-jobs.service.js';
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

/** 실패 job 목록 쪽(최근 실패부터 start번째부터 limit개). 실패 job은 Redis 정렬 집합이라 offset으로 본다(키셋 id가 없다, decisions/0070) */
export class FailedJobsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  start: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

/**
 * 운영 관제 API(보강 6, decisions/0070). 관제 화면(apps/console)이 부른다. 보기는 관제·ADMIN(OPS_VIEW), 관제 작업은 관제(MONITOR)만.
 * 모두 그때그때 읽는다(캐시 없음) — 화면이 10초마다 다시 부르므로 한 번 읽기가 가벼워야 한다(큐마다 Redis 명령 몇 개, 표마다 인덱스 읽기 몇 번).
 * 관제 작업은 DELETE가 아니라 POST `/…/retry`·`/…/remove`다 — 둘 다 "실패 job에 하는 동작"이고 감사 기록을 남기는 명령이라 같은 모양으로 둔다.
 */
@Controller('ops')
export class OpsController {
  constructor(
    private readonly queues: OpsQueuesService,
    private readonly outbox: OpsOutboxService,
    private readonly errors: OpsErrorsService,
    private readonly jobs: OpsJobsService,
    private readonly audit: OpsAuditService,
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

  /** 이 큐에 남은 실패 job(최근 실패부터). 없는 큐 이름은 404 */
  @Get('queues/:name/failed')
  @Roles(...OPS_VIEW)
  failed(@Param('name') name: string, @Query() query: FailedJobsQuery): Promise<OpsFailedJobsPage> {
    return this.jobs.listFailed(name, query.start, query.limit);
  }

  /** 실패 job 다시 시도(관제만, 감사 기록). 없으면 404, 실패 상태가 아니면 409 JOB_NOT_FAILED */
  @Post('queues/:name/jobs/:id/retry')
  @Roles(Role.MONITOR)
  @HttpCode(200)
  retry(@Param('name') name: string, @Param('id') id: string, @CurrentPrincipal() who: Principal): Promise<OpsJobActionResult> {
    return this.jobs.retry(name, id, who);
  }

  /** 실패 job 지우기(관제만, 감사 기록, 되돌릴 수 없음) */
  @Post('queues/:name/jobs/:id/remove')
  @Roles(Role.MONITOR)
  @HttpCode(200)
  remove(@Param('name') name: string, @Param('id') id: string, @CurrentPrincipal() who: Principal): Promise<OpsJobActionResult> {
    return this.jobs.remove(name, id, who);
  }

  /** 멈춘 QUEUED 복구 sweep을 지금 한 번(관제만, 감사 기록, decisions/0042) */
  @Post('outbox/requeue')
  @Roles(Role.MONITOR)
  @HttpCode(200)
  requeueOutbox(@CurrentPrincipal() who: Principal): Promise<OpsRequeueResult> {
    return this.outbox.requeue(who);
  }

  /** 관제 작업 감사 기록(최근부터 beforeId 키셋) */
  @Get('actions')
  @Roles(...OPS_VIEW)
  actions(@Query() query: BeforeIdQuery): Promise<BeforeIdPage<OpsActionView>> {
    return this.audit.list(query);
  }
}
