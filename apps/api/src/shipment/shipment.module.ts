import { Module } from '@nestjs/common';
import { CarrierModule } from '../carrier/carrier.module.js';
import { TerminalModule } from '../terminal/terminal.module.js';
import { ShipmentController } from './shipment.controller.js';
import { ShipmentService } from './shipment.service.js';

@Module({
  imports: [TerminalModule, CarrierModule],
  controllers: [ShipmentController],
  providers: [ShipmentService],
  exports: [ShipmentService],
})
export class ShipmentModule {}
