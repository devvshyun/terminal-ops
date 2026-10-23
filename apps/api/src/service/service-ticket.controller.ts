import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { OpenTicketDto, RemoteCheckDto } from './dto/service-ticket.dto.js';
import { ServiceTicketService } from './service-ticket.service.js';
import { toTicketView } from './service-ticket.views.js';

@Controller('service-tickets')
export class ServiceTicketController {
  constructor(private readonly tickets: ServiceTicketService) {}

  @Post()
  async open(@Body() dto: OpenTicketDto, @Operator() actor: string) {
    return toTicketView(await this.tickets.open(dto, actor));
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    return toTicketView(await this.tickets.get(id));
  }

  @Post(':id/remote-checks')
  @HttpCode(200)
  // 작업자 헤더는 모든 쓰기 API에 받는다(decisions/0001). 원격 점검은 메모에 결과만 남긴다.
  async remoteCheck(@Param('id', ParseIntPipe) id: number, @Body() dto: RemoteCheckDto, @Operator() _actor: string) {
    return toTicketView(await this.tickets.remoteCheck(id, dto));
  }
}
