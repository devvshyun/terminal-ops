import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import type { CreatedShipmentView } from '@terminal-ops/contracts';
import { OFFICE, Roles } from '../auth/access.js';
import { Role } from '../auth/role.js';
import { Operator } from '../common/operator.decorator.js';
import { toTerminalView } from '../terminal/terminal.views.js';
import { CreateShipmentDto } from './dto/create-shipment.dto.js';
import { ShipmentService } from './shipment.service.js';
import { toShipmentView } from './shipment.views.js';

@Controller('shipments')
export class ShipmentController {
  constructor(private readonly shipments: ShipmentService) {}

  @Post()
  @Roles(Role.OPERATOR)
  async create(@Body() dto: CreateShipmentDto, @Operator() actor: string): Promise<CreatedShipmentView> {
    const { shipment, terminal } = await this.shipments.create(dto, actor);
    return { ...toShipmentView(shipment), terminal: toTerminalView(terminal) };
  }

  @Get(':id')
  @Roles(...OFFICE)
  async get(@Param('id', ParseIntPipe) id: number) {
    const { shipment, events } = await this.shipments.get(id);
    return toShipmentView(shipment, events);
  }
}
