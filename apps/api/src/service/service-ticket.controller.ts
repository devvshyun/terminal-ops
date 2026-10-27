import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import type { BeforeIdPage, TicketView } from '@terminal-ops/contracts';
import { Operator } from '../common/operator.decorator.js';
import { ListTicketsQuery, OpenTicketDto, RemoteCheckDto, ReplaceDto } from './dto/service-ticket.dto.js';
import { ReplacementService } from './replacement.service.js';
import { ServiceTicketService } from './service-ticket.service.js';
import { toTicketView } from './service-ticket.views.js';

@Controller('service-tickets')
export class ServiceTicketController {
  constructor(
    private readonly tickets: ServiceTicketService,
    private readonly replacements: ReplacementService,
  ) {}

  @Post()
  async open(@Body() dto: OpenTicketDto, @Operator() actor: string) {
    return toTicketView(await this.tickets.open(dto, actor));
  }

  /** 접수 목록(최근 것부터, ?status=&serialNo=&beforeId=&limit=) */
  @Get()
  async list(@Query() query: ListTicketsQuery): Promise<BeforeIdPage<TicketView>> {
    const { items, nextBeforeId } = await this.tickets.list(query);
    return { items: items.map(toTicketView), nextBeforeId };
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

  @Post(':id/replacements')
  async replace(@Param('id', ParseIntPipe) id: number, @Body() dto: ReplaceDto, @Operator() actor: string) {
    return toTicketView(await this.replacements.replace(id, dto, actor));
  }

  @Post(':id/installations')
  @HttpCode(200)
  async install(@Param('id', ParseIntPipe) id: number, @Operator() actor: string) {
    return toTicketView(await this.replacements.install(id, actor));
  }
}
