import { Injectable } from '@nestjs/common';
import { env } from '../config/env.js';
import { RedisLock } from '../redis/redis-lock.js';

/**
 * 같은 scanId의 "처리 중" 잠금(Redis SET NX PX, decisions/0020).
 * 처리를 마친 결과는 MySQL(ScanBatch)에 영구히 남고, 이 잠금은 처리하는 동안 같은 scanId가 또 들어오는 것만 막는다.
 * 잠금 자체는 공용 Redis 연결의 RedisLock이 한다(decisions/0026). 키는 `<QUEUE_PREFIX>:scan-lock:<scanId>` 그대로다.
 */
@Injectable()
export class ScanLock {
  constructor(private readonly lock: RedisLock) {}

  keyOf(scanId: string): string {
    return this.lock.keyOf('scan-lock', scanId);
  }

  /** 잡으면 토큰, 이미 누가 잡고 있으면 null */
  acquire(scanId: string, ttlMs = env.scanLockTtlMs): Promise<string | null> {
    return this.lock.acquire(this.keyOf(scanId), ttlMs);
  }

  async release(scanId: string, token: string): Promise<void> {
    await this.lock.release(this.keyOf(scanId), token);
  }
}
