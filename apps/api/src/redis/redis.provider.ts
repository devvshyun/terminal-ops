import { Logger } from '@nestjs/common';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/** 앱 공용 ioredis 연결의 주입 토큰(decisions/0026). BullMQ는 자기 연결을 따로 쓴다. */
export const REDIS = 'APP_REDIS';

/**
 * 앱 공용 Redis 연결을 만든다. error 리스너를 꼭 단다 — 리스너가 없으면 ioredis가 연결 오류마다
 * `[ioredis] Unhandled error event`를 콘솔에 찍는다(Day 3 리뷰 Minor 2). 명령 하나는 1번만 다시 보낸다(요청이 오래 매달리지 않게).
 */
export function createAppRedis(logger = new Logger('Redis')): Redis {
  const redis = new Redis({ host: env.redis.host, port: env.redis.port, maxRetriesPerRequest: 1 });
  redis.on('error', (error: Error) => logger.warn(`Redis 연결 오류: ${error.message}`));
  return redis;
}
