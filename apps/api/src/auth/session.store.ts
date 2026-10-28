import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { execOrThrow } from '../redis/redis-exec.js';
import { REDIS } from '../redis/redis.provider.js';
import type { Principal } from './principal.js';

/** 세션을 만들 때 넘기는 사람 정보(요청마다 MySQL을 읽지 않으려고 역할까지 넣는다 — 바뀌면 세션을 끊는다) */
export type SessionPrincipal = Principal & { accountId: number };

/** Redis에 든 세션 = 사람 정보 + 만들 때의 계정 세대값(gen) + 만든 시각(절대 만료) */
export type SessionData = SessionPrincipal & { gen: number; createdAt: number };

/**
 * 세션 읽기(Lua, 명령 하나로 원자적). 세션 값을 읽고, 그 계정의 세대값이 세션의 gen과 다르거나(일괄 끊기 뒤) 만든 지 SESSION_MAX_AGE_MS가 지났으면
 * 세션을 지우고 nil. 아니면 유휴 TTL을 다시 늘린다(절대 만료까지 남은 시간보다 길게는 늘리지 않는다).
 * 세대값 키는 세션 값 안의 계정 id로 만들어 KEYS로 미리 넘길 수 없다 — 단일 Redis(클러스터 아님)라 스크립트 안에서 읽는다.
 * KEYS[1] 세션 키, ARGV[1] 세대값 키 앞부분, ARGV[2] 유휴 TTL, ARGV[3] 지금(ms), ARGV[4] 절대 만료(ms)
 */
const GET_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return false end
local ok, s = pcall(cjson.decode, raw)
if not ok or type(s) ~= 'table' or type(s.accountId) ~= 'number' or type(s.gen) ~= 'number' or type(s.createdAt) ~= 'number' then
  redis.call('DEL', KEYS[1])
  return false
end
local gen = tonumber(redis.call('GET', ARGV[1] .. string.format('%d', s.accountId)) or '0')
local remaining = tonumber(ARGV[4]) - (tonumber(ARGV[3]) - s.createdAt)
if gen ~= s.gen or remaining <= 0 then
  redis.call('DEL', KEYS[1])
  return false
end
redis.call('PEXPIRE', KEYS[1], math.floor(math.min(tonumber(ARGV[2]), remaining)))
return raw
`;

/**
 * 서버 세션(decisions/0050). 토큰(32바이트 무작위, 쿠키 값)의 SHA-256을 키로 Redis에 둔다 — Redis 내용이 새어도 쿠키를 만들 수 없다.
 * - `<접두사>:sess:<해시>`      STRING JSON(SessionData), PX = 유휴 TTL. 읽을 때마다 다시 늘린다(GET_SCRIPT)
 * - `<접두사>:sess-of:<계정 id>` SET 해시들 — 역할 변경·사용 중지·비밀번호 변경 때 그 계정의 세션을 한 번에 지운다.
 *   TTL을 붙이지 않는다: 계정 세션 중 가장 오래 사는 것보다 먼저 사라지면 일괄 끊기가 그 세션을 못 찾는다(세션마다 TTL이 늘어나 SET에 맞는 TTL이 없다).
 *   끝난 해시는 다음 로그인(create) 때 치운다
 * - `<접두사>:sess-gen:<계정 id>` 정수, 계정 세대값. 일괄 끊기가 INCR한다. 세션은 만들 때 읽은 세대값을 들고 있고, 읽을 때 다르면 무효다 —
 *   로그인 도중(계정을 읽은 뒤·세션을 만들기 전)이나 끊기 도중(색인을 읽은 뒤·지우기 전)에 생긴 옛 정보의 세션도 막는다.
 *   TTL을 붙이지 않는다: 만료돼 0으로 돌아가면 옛 세대(0)로 만든 세션이 다시 살아날 수 있다(계정마다 정수 하나)
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

  private genKeyPrefix() {
    return `${env.queuePrefix}:sess-gen:`;
  }

  private static hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  /** 계정의 지금 세대값(없으면 0). 로그인은 계정 행을 읽기 **전에** 이것을 읽어 create에 넘긴다 */
  async generation(accountId: number): Promise<number> {
    return Number((await this.redis.get(`${this.genKeyPrefix()}${accountId}`)) ?? 0);
  }

  /**
   * 새 세션을 만들고 토큰(쿠키 값)을 돌려준다. 이 계정의 끝난 세션 해시는 색인에서 치운다.
   * @param gen 계정 행을 읽기 전에 읽은 세대값(generation) — 그 사이 일괄 끊기가 있었으면 이 세션은 처음부터 무효
   */
  async create(principal: SessionPrincipal, gen: number): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const hash = SessionStore.hash(token);
    const data: SessionData = { ...principal, gen, createdAt: Date.now() };
    const index = this.indexKey(data.accountId);
    const old = await this.redis.smembers(index);
    const alive = old.length > 0 ? ((await execOrThrow(old.reduce((p, h) => p.exists(this.sessionKey(h)), this.redis.pipeline()))) as number[]) : [];
    const dead = old.filter((_, i) => alive[i] === 0);
    const tx = this.redis.multi().set(this.sessionKey(hash), JSON.stringify(data), 'PX', Math.min(env.sessionIdleTtlMs, env.sessionMaxAgeMs)).sadd(index, hash);
    if (dead.length > 0) tx.srem(index, ...dead);
    await execOrThrow(tx);
    return token;
  }

  /** 토큰의 세션. 없거나 끝났거나(유휴·절대 만료) 세대값이 바뀌었으면 null. 찾으면 유휴 TTL을 다시 늘린다(GET_SCRIPT 하나 — 원자적) */
  async get(token: string): Promise<SessionData | null> {
    const raw = (await this.redis.eval(
      GET_SCRIPT,
      1,
      this.sessionKey(SessionStore.hash(token)),
      this.genKeyPrefix(),
      env.sessionIdleTtlMs,
      Date.now(),
      env.sessionMaxAgeMs,
    )) as string | null;
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

  /**
   * 이 계정의 세션을 모두 끊는다(역할·가맹점·비밀번호를 바꾸거나 사용 중지할 때). 지운 세션 수.
   * 세대값을 **먼저** 올린다 — 그 뒤 색인을 읽고 지우는 사이에 옛 세대로 만들어진 세션도 읽을 때 무효가 된다.
   * 색인은 통째로 지우지 않고 읽은 해시만 뺀다(그 사이 새 세대로 만든 세션의 해시는 남긴다).
   */
  async destroyAllFor(accountId: number): Promise<number> {
    await this.redis.incr(`${this.genKeyPrefix()}${accountId}`);
    const index = this.indexKey(accountId);
    const hashes = await this.redis.smembers(index);
    if (hashes.length === 0) return 0;
    const [deleted] = (await execOrThrow(
      this.redis
        .multi()
        .del(...hashes.map((h) => this.sessionKey(h)))
        .srem(index, ...hashes),
    )) as number[];
    return deleted;
  }
}
