import { Module } from '@nestjs/common';
import {
  BungaeTrackProcessor,
  CarrierSweepProcessor,
  NeurimboTrackProcessor,
} from '../carrier-sync/carrier-sync.processors.js';
import { CarrierSyncModule } from '../carrier-sync/carrier-sync.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { OutboxProcessor } from '../outbox/outbox.processor.js';

/** 큐 job을 처리하는 프로세서들. RUN_WORKERS=1인 프로세스에만 넣는다(decisions/0015). */
@Module({
  imports: [CarrierSyncModule, OutboxModule],
  providers: [BungaeTrackProcessor, NeurimboTrackProcessor, CarrierSweepProcessor, OutboxProcessor],
})
export class WorkersModule {}
