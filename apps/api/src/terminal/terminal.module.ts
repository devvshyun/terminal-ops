import { Module } from '@nestjs/common';
import { BulkRegistrationService } from './bulk-registration.service.js';
import { TerminalController } from './terminal.controller.js';
import { TerminalModelController } from './terminal-model.controller.js';
import { TerminalImportService } from './terminal-import.service.js';
import { TerminalService } from './terminal.service.js';
import { TransitionService } from './transition.service.js';

@Module({
  controllers: [TerminalController, TerminalModelController],
  providers: [TerminalService, TransitionService, BulkRegistrationService, TerminalImportService],
  exports: [TerminalService, TransitionService, BulkRegistrationService],
})
export class TerminalModule {}
