import { Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { ListAnomaliesQuery } from './dto/list-anomalies.query.js';
import { AnomalyService } from './anomaly.service.js';

/** 이상 단말기(F4). 찾기는 주기 작업(일 1회)이 하고, 운영자가 바로 돌릴 수도 있다. */
@Controller()
export class AnomalyController {
  constructor(private readonly anomalies: AnomalyService) {}

  @Get('anomalies')
  async list(@Query() query: ListAnomaliesQuery) {
    return this.anomalies.list(query);
  }

  /** 수동 찾기(동기). 다른 찾기가 돌고 있으면 409 ANOMALY_SCAN_RUNNING */
  @Post('anomaly-scans')
  @HttpCode(200)
  async scan(@Operator() _actor: string) {
    const { newMatches, ...summary } = await this.anomalies.scan();
    return { ...summary, newSerials: newMatches.slice(0, 100).map((m) => m.serialNo) };
  }
}
