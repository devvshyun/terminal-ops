import { Body, Controller, Get, Param, Post } from '@nestjs/common';
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

  @Get(':poNo')
  async get(@Param('poNo') poNo: string) {
    return toPurchaseOrderView(await this.orders.get(poNo));
  }
}
