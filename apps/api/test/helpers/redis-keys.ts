import type { Redis } from 'ioredis';
import { env } from '../../src/config/env.js';

/**
 * 이 테스트 파일의 접두사(env.queuePrefix)로 시작하는 Redis 키를 SCAN + UNLINK로 지운다. FLUSH는 쓰지 않는다.
 * 안전장치: 테스트 접두사(test-)가 아니면 거절한다. 파일이 끝난 뒤 남은 키는 globalSetup이 `test-*`로 한 번 더 지운다.
 * @param sub 접두사 뒤에 붙일 부분(예: 'hb:' → `<prefix>:hb:*`만). 없으면 이 파일의 키 전부(큐 키 포함)
 */
export async function deleteTestKeys(redis: Redis, sub = ''): Promise<number> {
  if (!env.queuePrefix.startsWith('test-')) throw new Error(`테스트 접두사가 아닙니다: ${env.queuePrefix}`);
  let deleted = 0;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${env.queuePrefix}:${sub}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) deleted += await redis.unlink(...keys);
  } while (cursor !== '0');
  return deleted;
}
