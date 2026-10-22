import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import ormConfig from './mikro-orm.config.js';
import { HealthController } from './health/health.controller.js';

@Module({
  // forRoot가 요청마다 EntityManager를 fork하는 RequestContext 미들웨어를 자동 등록한다.
  imports: [MikroOrmModule.forRoot(ormConfig)],
  controllers: [HealthController],
  providers: [
    // main.ts의 useGlobalPipes는 테스트 앱에 적용되지 않는다. 모듈 provider로 등록해 테스트에서도 같게 동작시킨다.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    },
  ],
})
export class AppModule {}
