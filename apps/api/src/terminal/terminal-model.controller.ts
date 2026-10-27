import { Controller, Get } from '@nestjs/common';
import { TerminalService } from './terminal.service.js';

@Controller('terminal-models')
export class TerminalModelController {
  constructor(private readonly terminals: TerminalService) {}

  /** 모델 목록. 화면의 모델 필터·선택지(SN-100 등) */
  @Get()
  async list() {
    return (await this.terminals.models()).map((m) => ({ code: m.code, name: m.name, requiresReinspection: m.requiresReinspection }));
  }
}
