import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { execOrThrow } from '../redis/redis-exec.js';
import { REDIS } from '../redis/redis.provider.js';
import { normalizeValue, SERIAL_NO_MESSAGE, SERIAL_NO_PATTERN } from '../terminal/bulk-rows.js';
import { deviceKeys } from './device-keys.js';
import type { FirmwareOffer } from './offer-store.js';

/** 펌웨어 버전 형식: 영문·숫자·점·하이픈 1~20자 */
export const FIRMWARE_VERSION_PATTERN = /^[0-9A-Za-z.-]{1,20}$/;

export type HeartbeatResultCode = 'OK' | 'IGNORED_NOT_IN_SERVICE' | 'INVALID_FORMAT';

export interface HeartbeatRowResult {
  serialNo: string;
  result: HeartbeatResultCode;
  message?: string;
  /** 이 단말기에 펌웨어 업데이트 제안이 있으면(decisions/0030) */
  update?: FirmwareOffer;
}

export interface HeartbeatResponse {
  /** OK인 행 수 */
  accepted: number;
  /** 입력과 같은 순서의 행별 결과 */
  results: HeartbeatRowResult[];
}

/**
 * 단말기 하트비트(F8). 상태 전이가 아니다 — TransitionService·이력·Outbox를 거치지 않고, MySQL에도 쓰지 않는다(decisions/0027).
 * 쓰는 곳은 Redis뿐이다: 마지막 시각(ZSET lastSeen, 서버 시계)과 펌웨어 버전(HASH firmware).
 * 운영 중(IN_SERVICE) 단말기의 하트비트만 받는다. 그 판단도 MySQL 대신 Redis HASH active로 한다(decisions/0028).
 * 업데이트 제안(HASH offers)이 있으면 응답의 그 행에 update로 싣는다(decisions/0030). 보낸 버전이 이미 제안 버전이면 싣지 않는다.
 * 왕복은 묶음당 2번: ① active·offers 조회(pipeline) ② lastSeen·firmware 쓰기(pipeline).
 */
@Injectable()
export class HeartbeatService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async receive(items: Record<string, unknown>[], now = Date.now()): Promise<HeartbeatResponse> {
    const rows = items.map((item) => ({ serialNo: normalizeValue(item.serialNo), firmwareVersion: normalizeValue(item.firmwareVersion) }));
    const results: (HeartbeatRowResult | null)[] = rows.map((r) => {
      if (!SERIAL_NO_PATTERN.test(r.serialNo)) return { serialNo: r.serialNo, result: 'INVALID_FORMAT', message: SERIAL_NO_MESSAGE };
      if (!FIRMWARE_VERSION_PATTERN.test(r.firmwareVersion)) {
        return { serialNo: r.serialNo, result: 'INVALID_FORMAT', message: 'firmwareVersion은 영문·숫자·점·하이픈 1~20자입니다.' };
      }
      return null;
    });
    const valid = rows.flatMap((r, i) => (results[i] ? [] : [{ ...r, i }]));
    const keys = deviceKeys();

    const serials = valid.map((r) => r.serialNo);
    const [ids, offers] =
      valid.length > 0
        ? ((await execOrThrow(this.redis.pipeline().hmget(keys.active, ...serials).hmget(keys.offers, ...serials))) as (string | null)[][])
        : [[], []];
    const accepted = valid
      .map((r, k) => ({ ...r, offer: offers[k] }))
      .filter((r, k) => {
        if (ids[k] !== null) return true;
        results[r.i] = { serialNo: r.serialNo, result: 'IGNORED_NOT_IN_SERVICE', message: '운영 중(IN_SERVICE)인 단말기의 하트비트만 받습니다.' };
        return false;
      });

    if (accepted.length > 0) {
      const write = this.redis.pipeline();
      write.zadd(keys.lastSeen, ...accepted.flatMap((r) => [now, r.serialNo]));
      write.hset(keys.firmware, Object.fromEntries(accepted.map((r) => [r.serialNo, r.firmwareVersion])));
      await execOrThrow(write);
    }
    for (const r of accepted) {
      const offer = r.offer ? (JSON.parse(r.offer) as FirmwareOffer) : null;
      // 이미 그 버전이면 업데이트 지시를 싣지 않는다(설치 뒤 보고 전 하트비트, 보고가 늦거나 빠진 경우)
      results[r.i] = offer && offer.version !== r.firmwareVersion ? { serialNo: r.serialNo, result: 'OK', update: offer } : { serialNo: r.serialNo, result: 'OK' };
    }
    return { accepted: accepted.length, results: results as HeartbeatRowResult[] };
  }
}
