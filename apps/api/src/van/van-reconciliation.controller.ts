import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import type { BeforeIdPage, VanRunDetail, VanRunView } from '@terminal-ops/contracts';
import { OFFICE, Roles } from '../auth/access.js';
import { Role } from '../auth/role.js';
import { BeforeIdQuery } from '../common/keyset.js';
import { Operator } from '../common/operator.decorator.js';
import { StartVanReconciliationDto } from './dto/start-van-reconciliation.dto.js';
import { VanItemsQuery } from './dto/van-items.query.js';
import { toVanRunView, VanReconciliationService } from './van-reconciliation.service.js';

/** VAN 등록 대조(F9). 실행은 report 큐에서 비동기로 돈다 — 요청은 실행 행만 만들고 202로 끝난다. */
@Controller('van-reconciliations')
export class VanReconciliationController {
  constructor(private readonly runs: VanReconciliationService) {}

  /** 수동 실행. 진행 중인 실행이 있으면 409 VAN_RECONCILIATION_RUNNING. 본문 { acknowledgeDrop: true }면 이 실행만 수집 급감 검사를 건너뛴다 */
  @Post()
  @Roles(Role.OPERATOR, Role.MONITOR)
  @HttpCode(202)
  async start(@Operator() actor: string, @Body() body: StartVanReconciliationDto) {
    return toVanRunView(await this.runs.request(actor, { acknowledgeDrop: body.acknowledgeDrop === true }));
  }

  /** 실행 목록(최근 것부터, ?beforeId=&limit=) */
  @Get()
  @Roles(...OFFICE)
  async list(@Query() query: BeforeIdQuery): Promise<BeforeIdPage<VanRunView>> {
    const { items, nextBeforeId } = await this.runs.list(query);
    return { items: items.map(toVanRunView), nextBeforeId };
  }

  /** 실행 요약 + 결과 한 페이지(?kind=&verified=&afterId=&limit=) */
  @Get(':id')
  @Roles(...OFFICE)
  async get(@Param('id', ParseIntPipe) id: number, @Query() query: VanItemsQuery): Promise<VanRunDetail> {
    const run = toVanRunView(await this.runs.get(id));
    return { ...run, ...(await this.runs.items(id, query)) };
  }
}
