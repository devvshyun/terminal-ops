import { Module } from '@nestjs/common';
import { CarrierModule } from '../carrier/carrier.module.js';
import { TerminalModule } from '../terminal/terminal.module.js';
import { ShipmentController } from './shipment.controller.js';
import { ShipmentService } from './shipment.service.js';
import { SyncRunController } from './sync-run.controller.js';

@Module({
  imports: [TerminalModule, CarrierModule],
  controllers: [ShipmentController, SyncRunController],
  providers: [ShipmentService],
  exports: [ShipmentService],
})
export class ShipmentModule {}
