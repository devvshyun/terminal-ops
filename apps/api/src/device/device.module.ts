import { Module } from '@nestjs/common';
import { ActiveSetService } from './active-set.service.js';
import { DeviceController } from './device.controller.js';
import { HeartbeatService } from './heartbeat.service.js';

/** 접속 상태(F8): 하트비트, 운영 중 단말기 목록(active). 공용 Redis 연결(RedisModule)은 전역이다. */
@Module({
  controllers: [DeviceController],
  providers: [HeartbeatService, ActiveSetService],
  exports: [HeartbeatService, ActiveSetService],
})
export class DeviceModule {}
