import { Module } from '@nestjs/common';
import { CarrierModule } from '../carrier/carrier.module.js';
import { ShipmentModule } from '../shipment/shipment.module.js';
import { TerminalModule } from '../terminal/terminal.module.js';
import { ReplacementService } from './replacement.service.js';
import { ServiceTicketController } from './service-ticket.controller.js';
import { ServiceTicketService } from './service-ticket.service.js';

@Module({
  imports: [TerminalModule, ShipmentModule, CarrierModule],
  controllers: [ServiceTicketController],
  providers: [ServiceTicketService, ReplacementService],
})
export class ServiceModule {}
