import { Module } from '@nestjs/common';
import { OpsController } from './ops.controller.js';
import { OpsErrorsService } from './ops-errors.service.js';
import { OpsOutboxService } from './ops-outbox.service.js';
import { OpsQueuesService } from './ops-queues.service.js';

/** 운영 관제(보강 6, decisions/0070). 큐는 전역 QueuesModule, Redis는 전역 RedisModule의 것을 쓴다 */
@Module({
  controllers: [OpsController],
  providers: [OpsQueuesService, OpsOutboxService, OpsErrorsService],
})
export class OpsModule {}
