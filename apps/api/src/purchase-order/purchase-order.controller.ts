import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Operator } from '../common/operator.decorator.js';
import { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto.js';
import { PurchaseOrderService } from './purchase-order.service.js';
import { toPurchaseOrderView } from './purchase-order.views.js';

@Controller('purchase-orders')
export class PurchaseOrderController {
  constructor(private readonly orders: PurchaseOrderService) {}

  @Post()
  async create(@Body() dto: CreatePurchaseOrderDto, @Operator() actor: string) {
    return toPurchaseOrderView(await this.orders.create(dto, actor));
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
