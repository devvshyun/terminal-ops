import { Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { toVanRunView, VanReconciliationService } from './van-reconciliation.service.js';

/** VAN 등록 대조(F9). 실행은 report 큐에서 비동기로 돈다 — 요청은 실행 행만 만들고 202로 끝난다. */
@Controller('van-reconciliations')
export class VanReconciliationController {
  constructor(private readonly runs: VanReconciliationService) {}

  /** 수동 실행. 진행 중인 실행이 있으면 409 VAN_RECONCILIATION_RUNNING */
  @Post()
  @HttpCode(202)
  async start(@Operator() actor: string) {
    return toVanRunView(await this.runs.request(actor));
  }

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    return toVanRunView(await this.runs.get(id));
  }
}
