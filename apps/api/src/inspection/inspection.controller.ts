import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import type { InspectionItemView, InspectResult } from '@terminal-ops/contracts';
import { Operator } from '../common/operator.decorator.js';
import { toTerminalView } from '../terminal/terminal.views.js';
import { InspectionItemsQuery } from './dto/inspection-items.query.js';
import { InspectionStatsQuery } from './dto/inspection-stats.query.js';
import { InspectDto } from './dto/inspect.dto.js';
import { InspectionService } from './inspection.service.js';

@Controller()
export class InspectionController {
  constructor(private readonly inspections: InspectionService) {}

  @Get('inspection-items')
  async items(@Query() query: InspectionItemsQuery): Promise<InspectionItemView[]> {
    const items = await this.inspections.itemsForModel(query.modelCode);
    return items.map((i) => ({ code: i.code, label: i.label, sortOrder: i.sortOrder }));
  }

  @Post('terminals/:serialNo/inspections')
  async inspect(@Param('serialNo') serialNo: string, @Body() dto: InspectDto, @Operator() actor: string): Promise<InspectResult> {
    const r = await this.inspections.inspect(serialNo, dto, actor);
    return { inspectionId: r.inspection.id, passed: r.passed, failedItems: r.failedItems, terminal: toTerminalView(r.terminal) };
  }

  /** 이 단말기의 검수 기록(최근 것부터). 항목 이름을 붙인다 */
  @Get('terminals/:serialNo/inspections')
  async history(@Param('serialNo') serialNo: string) {
    return this.inspections.history(serialNo);
  }

  @Get('inspections/stats')
  async stats(@Query() query: InspectionStatsQuery) {
    return this.inspections.failureStats(query.modelCode);
  }
}
