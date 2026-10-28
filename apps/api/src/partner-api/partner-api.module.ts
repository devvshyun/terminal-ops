import { Module } from '@nestjs/common';
import { TerminalModule } from '../terminal/terminal.module.js';
import { PartnerApiController } from './partner-api.controller.js';

/** 외부 업체용 API `/partner/v1/...`(decisions/0054) */
@Module({
  imports: [TerminalModule],
  controllers: [PartnerApiController],
})
export class PartnerApiModule {}
