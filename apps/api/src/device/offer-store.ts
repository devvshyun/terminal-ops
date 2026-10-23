import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { execOrThrow } from '../redis/redis-exec.js';
import { REDIS } from '../redis/redis.provider.js';
import { deviceKeys } from './device-keys.js';

/** 하트비트 응답에 실어 보내는 업데이트 지시 */
export interface FirmwareOffer {
  rolloutId: number;
  version: string;
}

/** 한 번에 HSET·HDEL하는 필드 수 */
const CHUNK = 1000;

/**
 * 그 배포의 제안일 때만 지운다. 중단된 배포의 제안을 늦게 지우다가, 그사이 같은 단말기에 생긴 다른 배포의 제안을 지우지 않게.
 * 깨진 값(JSON 아님·객체 아님)은 건너뛴다(pcall) — 하나 때문에 묶음 전체가 오류가 나지 않게(byRollout과 같은 규칙, 값은 남는다).
 * KEYS[1] = offers HASH, ARGV[1] = rolloutId, ARGV[2..] = serialNo
 */
const WITHDRAW_SCRIPT = `
local removed = 0
for i = 2, #ARGV do
  local v = redis.call('hget', KEYS[1], ARGV[i])
  if v then
    local ok, o = pcall(cjson.decode, v)
    if ok and type(o) == 'table' and o.rolloutId == tonumber(ARGV[1]) then
      removed = removed + redis.call('hdel', KEYS[1], ARGV[i])
    end
  end
end
return removed`;

/**
 * 펌웨어 업데이트 제안(Redis HASH `fw:offers`, serialNo → {rolloutId, version}). 하트비트가 MySQL을 보지 않고
 * "이 단말기에 업데이트가 있나"를 알게 하는 사본이다. 원본은 MySQL의 firmware_rollout_target(OFFERED)이다(decisions/0030).
 */
@Injectable()
export class OfferStore {
  private readonly logger = new Logger(OfferStore.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async publish(serials: string[], offer: FirmwareOffer): Promise<void> {
    if (serials.length === 0) return;
    const value = JSON.stringify(offer);
    const batch = this.redis.pipeline();
    for (let i = 0; i < serials.length; i += CHUNK) {
      batch.hset(deviceKeys().offers, Object.fromEntries(serials.slice(i, i + CHUNK).map((s) => [s, value])));
    }
    await execOrThrow(batch);
  }

  /** 그 배포의 제안만 지운다. @returns 지운 수 */
  async withdraw(rolloutId: number, serials: string[]): Promise<number> {
    let removed = 0;
    for (let i = 0; i < serials.length; i += CHUNK) {
      removed += Number(await this.redis.eval(WITHDRAW_SCRIPT, 1, deviceKeys().offers, rolloutId, ...serials.slice(i, i + CHUNK)));
    }
    return removed;
  }

  /** 시리얼마다 제안(없으면 null) */
  async lookup(serials: string[]): Promise<(FirmwareOffer | null)[]> {
    if (serials.length === 0) return [];
    const raw = await this.redis.hmget(deviceKeys().offers, ...serials);
    return raw.map((v) => (v ? (JSON.parse(v) as FirmwareOffer) : null));
  }

  /** 지금 걸린 제안 전체를 배포 id별 시리얼로(HSCAN, 판단 job의 제안 맞추기용) */
  async byRollout(): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>();
    let cursor = '0';
    do {
      const [next, flat] = await this.redis.hscan(deviceKeys().offers, cursor, 'COUNT', CHUNK);
      for (let i = 0; i < flat.length; i += 2) {
        const rolloutId = parseRolloutId(flat[i + 1]);
        if (rolloutId === null) {
          // 깨진 값 하나 때문에 맞추기 전체가 멈추지 않게 건너뛴다(값은 남는다. 이 저장소는 JSON.stringify로만 쓴다)
          this.logger.warn(`제안 값이 깨져 건너뜀: ${flat[i]} = ${flat[i + 1].slice(0, 100)}`);
          continue;
        }
        const serials = out.get(rolloutId) ?? [];
        serials.push(flat[i]);
        out.set(rolloutId, serials);
      }
      cursor = next;
    } while (cursor !== '0');
    return out;
  }

  /** 제안이 걸린 단말기 수(실험·테스트용) */
  count(): Promise<number> {
    return this.redis.hlen(deviceKeys().offers);
  }
}

/** 제안 값의 rolloutId. JSON이 아니거나 rolloutId가 정수가 아니면 null */
function parseRolloutId(raw: string): number | null {
  try {
    const { rolloutId } = JSON.parse(raw) as Partial<FirmwareOffer>;
    return Number.isInteger(rolloutId) ? (rolloutId as number) : null;
  } catch {
    return null;
  }
}
