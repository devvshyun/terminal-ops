import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service.js';

/** 주기 작업 등록. RUN_SCHEDULERS=1인 프로세스에만 넣는다(decisions/0015). */
@Module({
  providers: [SchedulerService],
})
export class SchedulerModule {}
