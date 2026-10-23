import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisLock } from './redis-lock.js';
import { createAppRedis, REDIS } from './redis.provider.js';

/**
 * 앱 공용 Redis 연결 하나(decisions/0026). 스캔 잠금·교체 예약·하트비트가 함께 쓴다.
 * 연결은 onApplicationShutdown에서 닫는다 — 모든 모듈의 onModuleDestroy(BullMQ 워커 종료 등)가 끝난 뒤라
 * 처리 중인 job이 닫힌 연결을 쓰지 않는다.
 */
@Global()
@Module({
  providers: [{ provide: REDIS, useFactory: () => createAppRedis() }, RedisLock],
  exports: [REDIS, RedisLock],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'end') return;
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}
