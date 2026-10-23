import { type DynamicModule, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import ormConfig from './mikro-orm.config.js';
import { HealthController } from './health/health.controller.js';
import { DomainExceptionFilter } from './common/domain-exception.filter.js';
import { TerminalModule } from './terminal/terminal.module.js';
import { InspectionModule } from './inspection/inspection.module.js';
import { MerchantModule } from './merchant/merchant.module.js';
import { ShipmentModule } from './shipment/shipment.module.js';
import { QueuesModule } from './queue/queues.module.js';
import { CarrierSyncModule } from './carrier-sync/carrier-sync.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { PurchaseOrderModule } from './purchase-order/purchase-order.module.js';
import { ScanModule } from './scan/scan.module.js';
import { WorkersModule } from './workers/workers.module.js';
import { SchedulerModule } from './scheduler/scheduler.module.js';

export interface AppOptions {
  /** 큐 job을 처리할지(RUN_WORKERS) */
  workers?: boolean;
  /** 주기 작업을 등록할지(RUN_SCHEDULERS) */
  schedulers?: boolean;
}

@Module({
  // forRoot가 요청마다 EntityManager를 fork하는 RequestContext 미들웨어를 자동 등록한다.
  imports: [
    MikroOrmModule.forRoot(ormConfig),
    QueuesModule,
    TerminalModule,
    InspectionModule,
    MerchantModule,
    ShipmentModule,
    CarrierSyncModule,
    OutboxModule,
    PurchaseOrderModule,
    ScanModule,
  ],
  controllers: [HealthController],
  providers: [
    // main.ts의 useGlobalPipes/Filters는 테스트 앱에 적용되지 않는다. 모듈 provider로 등록해 테스트에서도 같게 동작시킨다.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {
  /** 실행 모드에 따라 워커·스케줄러를 붙인다. `imports: [AppModule]`만 쓰면 둘 다 없다(decisions/0015). */
  static forRoot(options: AppOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [...(options.workers ? [WorkersModule] : []), ...(options.schedulers ? [SchedulerModule] : [])],
    };
  }
}
