import { Module } from '@nestjs/common';
import { ServiceTicketController } from './service-ticket.controller.js';
import { ServiceTicketService } from './service-ticket.service.js';

@Module({
  controllers: [ServiceTicketController],
  providers: [ServiceTicketService],
})
export class ServiceModule {}
