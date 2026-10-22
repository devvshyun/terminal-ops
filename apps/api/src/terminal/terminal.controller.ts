import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { RegisterTerminalDto } from './dto/register-terminal.dto.js';
import { ListTerminalsQuery } from './dto/list-terminals.query.js';
import { TransitionDto } from './dto/transition.dto.js';
import { TerminalService } from './terminal.service.js';
import { TransitionService } from './transition.service.js';
import { TransitionSource } from './terminal-status.js';
import { toHistoryView, toTerminalView } from './terminal.views.js';

@Controller('terminals')
export class TerminalController {
  constructor(
    private readonly terminals: TerminalService,
    private readonly transitions: TransitionService,
  ) {}

  @Post()
  async register(@Body() dto: RegisterTerminalDto, @Operator() actor: string) {
    return toTerminalView(await this.terminals.register(dto, actor));
  }

  @Get()
  async list(@Query() query: ListTerminalsQuery) {
    const result = await this.terminals.list(query);
    return { ...result, items: result.items.map(toTerminalView) };
  }

  @Get(':serialNo')
  async get(@Param('serialNo') serialNo: string) {
    return toTerminalView(await this.terminals.getBySerial(serialNo));
  }

  @Get(':serialNo/history')
  async history(@Param('serialNo') serialNo: string) {
    return (await this.terminals.history(serialNo)).map(toHistoryView);
  }

  @Post(':serialNo/transitions')
  @HttpCode(200)
  async transition(@Param('serialNo') serialNo: string, @Body() dto: TransitionDto, @Operator() actor: string) {
    const terminal = await this.transitions.transition({
      serialNo,
      to: dto.to,
      reason: dto.reason,
      actor,
      source: TransitionSource.MANUAL,
      expectedVersion: dto.expectedVersion,
    });
    return toTerminalView(terminal);
  }
}
