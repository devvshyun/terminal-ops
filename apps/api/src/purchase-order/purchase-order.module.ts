import { Module } from '@nestjs/common';
import { env } from '../config/env.js';
import { PurchaseOrderController } from './purchase-order.controller.js';
import { PurchaseOrderService } from './purchase-order.service.js';
import { SeumClient } from './seum.client.js';

@Module({
  controllers: [PurchaseOrderController],
  providers: [
    PurchaseOrderService,
    // 설정값(문자열·숫자)을 생성자로 받으므로 팩토리로 만든다(CarrierModule과 같은 방식).
    { provide: SeumClient, useFactory: () => new SeumClient({ baseUrl: env.partnersUrl, timeoutMs: env.partnerTimeoutMs }) },
  ],
  exports: [PurchaseOrderService, SeumClient],
})
export class PurchaseOrderModule {}
