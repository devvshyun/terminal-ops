import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import ormConfig from './mikro-orm.config.js';
import { HealthController } from './health/health.controller.js';
import { DomainExceptionFilter } from './common/domain-exception.filter.js';
import { TerminalModule } from './terminal/terminal.module.js';
import { InspectionModule } from './inspection/inspection.module.js';
import { MerchantModule } from './merchant/merchant.module.js';
import { ShipmentModule } from './shipment/shipment.module.js';

@Module({
  // forRoot가 요청마다 EntityManager를 fork하는 RequestContext 미들웨어를 자동 등록한다.
  imports: [MikroOrmModule.forRoot(ormConfig), TerminalModule, InspectionModule, MerchantModule, ShipmentModule],
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
export class AppModule {}
