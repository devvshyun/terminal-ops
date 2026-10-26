import { Module } from '@nestjs/common';
import { AnomalyController } from './anomaly.controller.js';
import { AnomalyService } from './anomaly.service.js';

/** 이상 단말기 찾기(F4). 잠금은 전역 RedisModule의 RedisLock */
@Module({
  controllers: [AnomalyController],
  providers: [AnomalyService],
  exports: [AnomalyService],
})
export class AnomalyModule {}
