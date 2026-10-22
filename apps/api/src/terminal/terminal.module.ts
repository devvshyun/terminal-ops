import { Module } from '@nestjs/common';
import { TerminalController } from './terminal.controller.js';
import { TerminalService } from './terminal.service.js';
import { TransitionService } from './transition.service.js';

@Module({
  controllers: [TerminalController],
  providers: [TerminalService, TransitionService],
  exports: [TerminalService, TransitionService],
})
export class TerminalModule {}
