import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { HealthController } from './health/health.controller.js';

@Module({
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
