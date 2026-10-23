import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/** 내 토큰일 때만 지운다. TTL이 지나 다른 요청이 잡은 잠금을 지우지 않기 위해서다. */
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * 같은 scanId의 "처리 중" 잠금(Redis SET NX PX, decisions/0020).
 * 처리를 마친 결과는 MySQL(ScanBatch)에 영구히 남고, 이 잠금은 처리하는 동안 같은 scanId가 또 들어오는 것만 막는다.
 * 프로세스가 죽어도 TTL이 지나면 풀린다. 키는 큐와 같은 접두사를 써서 테스트(test-…)와 개발(terminal-ops)을 나눈다.
 */
@Injectable()
export class ScanLock implements OnModuleDestroy {
  private readonly redis = new Redis({ host: env.redis.host, port: env.redis.port, maxRetriesPerRequest: 1 });

  keyOf(scanId: string): string {
    return `${env.queuePrefix}:scan-lock:${scanId}`;
  }

  /** 잡으면 토큰, 이미 누가 잡고 있으면 null */
  async acquire(scanId: string, ttlMs = env.scanLockTtlMs): Promise<string | null> {
    const token = randomUUID();
    const ok = await this.redis.set(this.keyOf(scanId), token, 'PX', ttlMs, 'NX');
    return ok === 'OK' ? token : null;
  }

  async release(scanId: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, this.keyOf(scanId), token);
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
