import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { BeforeIdPage, PurchaseOrderView } from '@terminal-ops/contracts';
import { Operator } from '../common/operator.decorator.js';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto.js';
import { ListPurchaseOrdersQuery } from './dto/list-purchase-orders.query.js';
import { PurchaseOrderService } from './purchase-order.service.js';
import { toPurchaseOrderView } from './purchase-order.views.js';

@Controller('purchase-orders')
export class PurchaseOrderController {
  constructor(private readonly orders: PurchaseOrderService) {}

  @Post()
  async create(@Body() dto: CreatePurchaseOrderDto, @Operator() actor: string) {
    return toPurchaseOrderView(await this.orders.create(dto, actor));
  }

  /** 발주 목록(최근 것부터, ?status=&beforeId=&limit=) */
  @Get()
  async list(@Query() query: ListPurchaseOrdersQuery): Promise<BeforeIdPage<PurchaseOrderView>> {
    const { items, nextBeforeId } = await this.orders.list(query);
    return { items: items.map(toPurchaseOrderView), nextBeforeId };
  }

  @Get(':poNo/reconciliation')
  async reconciliation(@Param('poNo') poNo: string) {
    return this.orders.reconcile(poNo);
  }

  @Post(':poNo/close')
  @HttpCode(200)
  async close(@Param('poNo') poNo: string, @Operator() actor: string) {
    return this.orders.close(poNo, actor);
  }

  @Get(':poNo')
  async get(@Param('poNo') poNo: string) {
    return toPurchaseOrderView(await this.orders.get(poNo));
  }
}
