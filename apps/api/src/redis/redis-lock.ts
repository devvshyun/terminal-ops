import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { REDIS } from './redis.provider.js';

/** 내 토큰일 때만 지운다. TTL이 지나 다른 요청이 잡은 잠금을 지우지 않기 위해서다. */
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * 짧게 쥐는 Redis 잠금(SET NX PX + 토큰 비교 해제, decisions/0020·0026). 박스 스캔 처리 중 잠금(ScanLock),
 * 교체 단말기 예약, 주기 작업의 한 번에 하나 실행에 쓴다. 프로세스가 죽어도 TTL이 지나면 풀린다.
 * 키는 큐와 같은 접두사(env.queuePrefix)를 붙여 테스트(test-…)와 개발(terminal-ops)을 나눈다.
 */
@Injectable()
export class RedisLock {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  keyOf(kind: string, id: string): string {
    return `${env.queuePrefix}:${kind}:${id}`;
  }

  /** 잡으면 토큰, 이미 누가 잡고 있으면 null */
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const ok = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? token : null;
  }

  /** 내 토큰이면 지우고 true. TTL이 지났거나 남의 잠금이면 false */
  async release(key: string, token: string): Promise<boolean> {
    return (await this.redis.eval(RELEASE_SCRIPT, 1, key, token)) === 1;
  }
}
