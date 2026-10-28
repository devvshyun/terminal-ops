import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import type { BeforeIdPage, TicketView } from '@terminal-ops/contracts';
import { OFFICE, Roles } from '../auth/access.js';
import { Role } from '../auth/role.js';
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
  @Roles(Role.OPERATOR)
  async open(@Body() dto: OpenTicketDto, @Operator() actor: string) {
    return toTicketView(await this.tickets.open(dto, actor));
  }

  /** 접수 목록(최근 것부터, ?status=&serialNo=&beforeId=&limit=) */
  @Get()
  @Roles(...OFFICE)
  async list(@Query() query: ListTicketsQuery): Promise<BeforeIdPage<TicketView>> {
    const { items, nextBeforeId } = await this.tickets.list(query);
    return { items: items.map(toTicketView), nextBeforeId };
  }

  @Get(':id')
  @Roles(...OFFICE)
  async get(@Param('id', ParseIntPipe) id: number) {
    return toTicketView(await this.tickets.get(id));
  }

  @Post(':id/remote-checks')
  @Roles(Role.OPERATOR)
  @HttpCode(200)
  // 원격 점검은 메모에 결과만 남긴다(작업자는 이력에 남기지 않지만 운영자만 할 수 있다)
  async remoteCheck(@Param('id', ParseIntPipe) id: number, @Body() dto: RemoteCheckDto, @Operator() _actor: string) {
    return toTicketView(await this.tickets.remoteCheck(id, dto));
  }

  @Post(':id/replacements')
  @Roles(Role.OPERATOR)
  async replace(@Param('id', ParseIntPipe) id: number, @Body() dto: ReplaceDto, @Operator() actor: string) {
    return toTicketView(await this.replacements.replace(id, dto, actor));
  }

  @Post(':id/installations')
  @Roles(Role.OPERATOR)
  @HttpCode(200)
  async install(@Param('id', ParseIntPipe) id: number, @Operator() actor: string) {
    return toTicketView(await this.replacements.install(id, actor));
  }
}
