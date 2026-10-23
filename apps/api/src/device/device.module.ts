import { Module } from '@nestjs/common';
import { ActiveSetService } from './active-set.service.js';
import { ConnectivityController } from './connectivity.controller.js';
import { ConnectivityService } from './connectivity.service.js';
import { DeviceController } from './device.controller.js';
import { HeartbeatService } from './heartbeat.service.js';

/** 접속 상태(F8): 하트비트, 운영 중 단말기 목록(active), 오프라인 판정·스냅샷·조회. 공용 Redis 연결(RedisModule)은 전역이다. */
@Module({
  controllers: [DeviceController, ConnectivityController],
  providers: [HeartbeatService, ActiveSetService, ConnectivityService],
  exports: [HeartbeatService, ActiveSetService, ConnectivityService],
})
export class DeviceModule {}
