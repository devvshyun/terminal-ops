import { Module } from '@nestjs/common';
import { DeviceModule } from '../device/device.module.js';
import { ServiceModule } from '../service/service.module.js';
import { TerminalModule } from '../terminal/terminal.module.js';
import { MeController } from './me.controller.js';
import { MeService } from './me.service.js';

/** 가맹점주 전용 API `/me/...`(decisions/0053, 점주 화면용 보강은 0059) */
@Module({
  imports: [TerminalModule, ServiceModule, DeviceModule],
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}
