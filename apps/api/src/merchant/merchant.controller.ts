import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { MerchantView } from '@terminal-ops/contracts';
import { OFFICE, Roles } from '../auth/access.js';
import { Role } from '../auth/role.js';
import { Operator } from '../common/operator.decorator.js';
import { toTerminalView } from '../terminal/terminal.views.js';
import { AllocateDto } from './dto/allocate.dto.js';
import { CancelAllocationDto } from './dto/cancel-allocation.dto.js';
import { MerchantService } from './merchant.service.js';

@Controller()
export class MerchantController {
  constructor(private readonly merchants: MerchantService) {}

  @Get('merchants')
  @Roles(...OFFICE)
  async list(): Promise<MerchantView[]> {
    return (await this.merchants.list()).map((m) => ({ code: m.code, name: m.name, address: m.address }));
  }

  @Post('terminals/:serialNo/allocations')
  @Roles(Role.OPERATOR)
  async allocate(@Param('serialNo') serialNo: string, @Body() dto: AllocateDto, @Operator() actor: string) {
    return toTerminalView(await this.merchants.allocate(serialNo, dto, actor));
  }

  @Post('terminals/:serialNo/allocation-cancellations')
  @Roles(Role.OPERATOR)
  async cancelAllocation(@Param('serialNo') serialNo: string, @Body() dto: CancelAllocationDto, @Operator() actor: string) {
    return toTerminalView(await this.merchants.cancelAllocation(serialNo, dto, actor));
  }
}
