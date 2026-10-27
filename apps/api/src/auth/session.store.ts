import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { execOrThrow } from '../redis/redis-exec.js';
import { REDIS } from '../redis/redis.provider.js';
import type { Principal } from './principal.js';

/** 세션에 넣는 것 = 요청마다 필요한 사람 정보(요청마다 MySQL을 읽지 않으려고 역할까지 넣는다 — 바뀌면 세션을 끊는다) */
export type SessionData = Principal & { accountId: number };

/**
 * 서버 세션(decisions/0050). 토큰(32바이트 무작위, 쿠키 값)의 SHA-256을 키로 Redis에 둔다 — Redis 내용이 새어도 쿠키를 만들 수 없다.
 * - `<접두사>:sess:<해시>`      STRING JSON(SessionData), PX = 유휴 TTL. 읽을 때마다 GETEX로 다시 늘린다
 * - `<접두사>:sess-of:<계정 id>` SET 해시들 — 역할 변경·사용 중지·비밀번호 변경 때 그 계정의 세션을 한 번에 끊는다
 * MySQL이 아니라 Redis인 이유: 요청마다 읽고, 저절로 끝나야(TTL) 하고, 잃어도 다시 로그인하면 되는 값이다.
 */
@Injectable()
export class SessionStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private sessionKey(hash: string) {
    return `${env.queuePrefix}:sess:${hash}`;
  }

  private indexKey(accountId: number) {
    return `${env.queuePrefix}:sess-of:${accountId}`;
  }

  private static hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  /** 새 세션을 만들고 토큰(쿠키 값)을 돌려준다. 이 계정의 끝난 세션 해시는 색인에서 치운다 */
  async create(data: SessionData): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const hash = SessionStore.hash(token);
    const index = this.indexKey(data.accountId);
    const old = await this.redis.smembers(index);
    const alive = old.length > 0 ? ((await execOrThrow(old.reduce((p, h) => p.exists(this.sessionKey(h)), this.redis.pipeline()))) as number[]) : [];
    const dead = old.filter((_, i) => alive[i] === 0);
    const tx = this.redis.multi().set(this.sessionKey(hash), JSON.stringify(data), 'PX', env.sessionIdleTtlMs).sadd(index, hash);
    if (dead.length > 0) tx.srem(index, ...dead);
    await execOrThrow(tx);
    return token;
  }

  /** 토큰의 세션. 없거나 끝났으면 null. 찾으면 유휴 TTL을 다시 늘린다(GETEX — 읽기와 늘리기가 명령 하나) */
  async get(token: string): Promise<SessionData | null> {
    const raw = await this.redis.getex(this.sessionKey(SessionStore.hash(token)), 'PX', env.sessionIdleTtlMs);
    return raw ? (JSON.parse(raw) as SessionData) : null;
  }

  /** 로그아웃 */
  async destroy(token: string): Promise<void> {
    const hash = SessionStore.hash(token);
    const raw = await this.redis.get(this.sessionKey(hash));
    const tx = this.redis.multi().del(this.sessionKey(hash));
    if (raw) tx.srem(this.indexKey((JSON.parse(raw) as SessionData).accountId), hash);
    await execOrThrow(tx);
  }

  /** 이 계정의 세션을 모두 끊는다(역할·가맹점·비밀번호를 바꾸거나 사용 중지할 때). 끊은 세션 수 */
  async destroyAllFor(accountId: number): Promise<number> {
    const index = this.indexKey(accountId);
    const hashes = await this.redis.smembers(index);
    if (hashes.length === 0) return 0;
    const [deleted] = (await execOrThrow(this.redis.multi().del(...hashes.map((h) => this.sessionKey(h))).del(index))) as number[];
    return deleted;
  }
}
