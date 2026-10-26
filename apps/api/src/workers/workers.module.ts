import { Module } from '@nestjs/common';
import {
  BungaeTrackProcessor,
  CarrierSweepProcessor,
  NeurimboTrackProcessor,
} from '../carrier-sync/carrier-sync.processors.js';
import { CarrierSyncModule } from '../carrier-sync/carrier-sync.module.js';
import { DeviceModule } from '../device/device.module.js';
import { DeviceProcessor } from '../device/device.processor.js';
import { FirmwareModule } from '../firmware/firmware.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { OutboxProcessor } from '../outbox/outbox.processor.js';
import { ReportProcessor } from '../report/report.processor.js';
import { VanModule } from '../van/van.module.js';

/** 큐 job을 처리하는 프로세서들. RUN_WORKERS=1인 프로세스에만 넣는다(decisions/0015). */
@Module({
  imports: [CarrierSyncModule, OutboxModule, DeviceModule, FirmwareModule, VanModule],
  providers: [BungaeTrackProcessor, NeurimboTrackProcessor, CarrierSweepProcessor, OutboxProcessor, DeviceProcessor, ReportProcessor],
})
export class WorkersModule {}
