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
  // 가맹점주 화면(`/me`, MeModule)이 같은 서비스를 범위와 함께 쓴다(decisions/0053)
  exports: [ServiceTicketService, ReplacementService],
})
export class ServiceModule {}
