import { Module } from '@nestjs/common';
import { TerminalModule } from '../terminal/terminal.module.js';
import { InspectionController } from './inspection.controller.js';
import { InspectionService } from './inspection.service.js';

@Module({
  imports: [TerminalModule],
  controllers: [InspectionController],
  providers: [InspectionService],
})
export class InspectionModule {}
