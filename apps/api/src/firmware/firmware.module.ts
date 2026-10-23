import { Module } from '@nestjs/common';
import { DeviceModule } from '../device/device.module.js';
import { FirmwareReportController } from './firmware-report.controller.js';
import { FirmwareReportService } from './firmware-report.service.js';
import { FirmwareController } from './firmware.controller.js';
import { FirmwareService } from './firmware.service.js';
import { RolloutService } from './rollout.service.js';

/** 펌웨어 등록·단계 배포(F8). 제안은 DeviceModule의 OfferStore(Redis)로 건다. */
@Module({
  imports: [DeviceModule],
  controllers: [FirmwareController, FirmwareReportController],
  providers: [FirmwareService, RolloutService, FirmwareReportService],
  exports: [RolloutService],
})
export class FirmwareModule {}
