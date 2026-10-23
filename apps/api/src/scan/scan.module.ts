import { Module } from '@nestjs/common';
import { PurchaseOrderModule } from '../purchase-order/purchase-order.module.js';
import { TerminalModule } from '../terminal/terminal.module.js';
import { ScanController } from './scan.controller.js';
import { ScanLock } from './scan-lock.js';
import { ScanService } from './scan.service.js';

@Module({
  imports: [TerminalModule, PurchaseOrderModule],
  controllers: [ScanController],
  providers: [ScanService, ScanLock],
})
export class ScanModule {}
