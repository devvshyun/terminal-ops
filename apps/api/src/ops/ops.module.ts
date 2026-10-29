import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module.js';
import { OpsAuditService } from './ops-audit.service.js';
import { OpsController } from './ops.controller.js';
import { OpsErrorsService } from './ops-errors.service.js';
import { OpsJobsService } from './ops-jobs.service.js';
import { OpsOutboxService } from './ops-outbox.service.js';
import { OpsQueuesService } from './ops-queues.service.js';

/** 운영 관제(보강 6, decisions/0070). 큐는 전역 QueuesModule, Redis는 전역 RedisModule의 것을 쓴다. 복구 sweep은 OutboxService.requeueStale 그대로(decisions/0042) */
@Module({
  imports: [OutboxModule],
  controllers: [OpsController],
  providers: [OpsQueuesService, OpsOutboxService, OpsErrorsService, OpsJobsService, OpsAuditService],
})
export class OpsModule {}
