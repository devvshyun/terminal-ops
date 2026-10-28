import { Module } from '@nestjs/common';
import { ServiceModule } from '../service/service.module.js';
import { TerminalModule } from '../terminal/terminal.module.js';
import { MeController } from './me.controller.js';

/** 가맹점주 전용 API `/me/...`(decisions/0053) */
@Module({
  imports: [TerminalModule, ServiceModule],
  controllers: [MeController],
})
export class MeModule {}
