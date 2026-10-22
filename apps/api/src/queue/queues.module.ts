import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { env } from '../config/env.js';
import { ALL_QUEUES } from './queue-names.js';

/** Redis 연결과 큐 등록. 어느 모듈에서든 @InjectQueue로 쓸 수 있게 전역으로 둔다. */
@Global()
@Module({
  imports: [
    BullModule.forRoot({ connection: { host: env.redis.host, port: env.redis.port }, prefix: env.queuePrefix }),
    BullModule.registerQueue(...ALL_QUEUES.map((name) => ({ name }))),
  ],
  exports: [BullModule],
})
export class QueuesModule {}
