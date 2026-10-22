import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { toTerminalView } from '../terminal/terminal.views.js';
import { InspectionItemsQuery } from './dto/inspection-items.query.js';
import { InspectDto } from './dto/inspect.dto.js';
import { InspectionService } from './inspection.service.js';

@Controller()
export class InspectionController {
  constructor(private readonly inspections: InspectionService) {}

  @Get('inspection-items')
  async items(@Query() query: InspectionItemsQuery) {
    const items = await this.inspections.itemsForModel(query.modelCode);
    return items.map((i) => ({ code: i.code, label: i.label, sortOrder: i.sortOrder }));
  }

  @Post('terminals/:serialNo/inspections')
  async inspect(@Param('serialNo') serialNo: string, @Body() dto: InspectDto, @Operator() actor: string) {
    const r = await this.inspections.inspect(serialNo, dto, actor);
    return { inspectionId: r.inspection.id, passed: r.passed, failedItems: r.failedItems, terminal: toTerminalView(r.terminal) };
  }

  @Get('inspections/stats')
  async stats(@Query('modelCode') modelCode?: string) {
    return this.inspections.failureStats(modelCode);
  }
}
