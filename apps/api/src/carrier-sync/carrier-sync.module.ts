import { Module } from '@nestjs/common';
import { CarrierModule } from '../carrier/carrier.module.js';
import { TerminalModule } from '../terminal/terminal.module.js';
import { CarrierSyncService } from './carrier-sync.service.js';

@Module({
  imports: [CarrierModule, TerminalModule],
  providers: [CarrierSyncService],
  exports: [CarrierSyncService],
})
export class CarrierSyncModule {}
