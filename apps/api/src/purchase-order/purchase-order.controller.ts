import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { BeforeIdPage, PurchaseOrderView } from '@terminal-ops/contracts';
import { OFFICE, Roles, STAFF } from '../auth/access.js';
import { Role } from '../auth/role.js';
import { Operator } from '../common/operator.decorator.js';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto.js';
import { ListPurchaseOrdersQuery } from './dto/list-purchase-orders.query.js';
import { PurchaseOrderService } from './purchase-order.service.js';
import { toPurchaseOrderView } from './purchase-order.views.js';

@Controller('purchase-orders')
export class PurchaseOrderController {
  constructor(private readonly orders: PurchaseOrderService) {}

  @Post()
  @Roles(Role.OPERATOR)
  async create(@Body() dto: CreatePurchaseOrderDto, @Operator() actor: string) {
    return toPurchaseOrderView(await this.orders.create(dto, actor));
  }

  /** 발주 목록(최근 것부터, ?status=&beforeId=&limit=). 현장 작업자도 입고 박스의 발주를 고른다 */
  @Get()
  @Roles(...STAFF)
  async list(@Query() query: ListPurchaseOrdersQuery): Promise<BeforeIdPage<PurchaseOrderView>> {
    const { items, nextBeforeId } = await this.orders.list(query);
    return { items: items.map(toPurchaseOrderView), nextBeforeId };
  }

  @Get(':poNo/reconciliation')
  @Roles(...OFFICE)
  async reconciliation(@Param('poNo') poNo: string) {
    return this.orders.reconcile(poNo);
  }

  @Post(':poNo/close')
  @Roles(Role.OPERATOR)
  @HttpCode(200)
  async close(@Param('poNo') poNo: string, @Operator() actor: string) {
    return this.orders.close(poNo, actor);
  }

  @Get(':poNo')
  @Roles(...STAFF)
  async get(@Param('poNo') poNo: string) {
    return toPurchaseOrderView(await this.orders.get(poNo));
  }
}
