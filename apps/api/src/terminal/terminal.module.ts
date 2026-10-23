import { Module } from '@nestjs/common';
import { BulkRegistrationService } from './bulk-registration.service.js';
import { TerminalController } from './terminal.controller.js';
import { TerminalService } from './terminal.service.js';
import { TransitionService } from './transition.service.js';

@Module({
  controllers: [TerminalController],
  providers: [TerminalService, TransitionService, BulkRegistrationService],
  exports: [TerminalService, TransitionService, BulkRegistrationService],
})
export class TerminalModule {}
