import { Module } from '@nestjs/common';
import { env } from '../config/env.js';
import { BridgevanClient } from './bridgevan.client.js';
import { VanReconciliationController } from './van-reconciliation.controller.js';
import { VanReconciliationService } from './van-reconciliation.service.js';

/** VAN 등록 대조(F9): 브릿지VAN 클라이언트, 실행·스테이징·비교 */
@Module({
  controllers: [VanReconciliationController],
  providers: [
    VanReconciliationService,
    { provide: BridgevanClient, useFactory: () => new BridgevanClient({ baseUrl: env.partnersUrl, timeoutMs: env.partnerTimeoutMs }) },
  ],
  exports: [VanReconciliationService],
})
export class VanModule {}
