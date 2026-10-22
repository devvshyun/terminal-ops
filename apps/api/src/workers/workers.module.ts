import { Module } from '@nestjs/common';
import {
  BungaeTrackProcessor,
  CarrierSweepProcessor,
  NeurimboTrackProcessor,
} from '../carrier-sync/carrier-sync.processors.js';
import { CarrierSyncModule } from '../carrier-sync/carrier-sync.module.js';

/** 큐 job을 처리하는 프로세서들. RUN_WORKERS=1인 프로세스에만 넣는다(decisions/0015). */
@Module({
  imports: [CarrierSyncModule],
  providers: [BungaeTrackProcessor, NeurimboTrackProcessor, CarrierSweepProcessor],
})
export class WorkersModule {}
