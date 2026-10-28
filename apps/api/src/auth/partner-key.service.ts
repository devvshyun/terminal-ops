import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { CreatedPartnerKeyView, PartnerKeyView, PartnerScope } from '@terminal-ops/contracts';
import { PartnerApiKey } from './partner-key.entity.js';

/** `pk_` + 소문자·숫자 8자 + `_` + base64url 43자(32바이트) */
const KEY_PATTERN = /^(pk_[a-z0-9]{8})_[A-Za-z0-9_-]{43}$/;
/** lastUsedAt을 이보다 자주 쓰지 않는다 */
const TOUCH_EVERY_MS = 60_000;

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

export function toPartnerKeyView(k: PartnerApiKey): PartnerKeyView {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    createdBy: k.createdBy,
    createdAt: k.createdAt.toISOString(),
  };
}

/** 외부 업체 키 발급·폐기·확인(decisions/0054). 발급·폐기는 ADMIN API, 확인은 AuthGuard가 부른다 */
@Injectable()
export class PartnerKeyService {
  constructor(private readonly em: EntityManager) {}

  /** 새 키. 원문(key)은 이 응답에만 있다 */
  async create(input: { name: string; scopes: PartnerScope[]; expiresAt?: Date | null }, actor: string, rawKey?: string): Promise<CreatedPartnerKeyView> {
    const key = rawKey ?? `pk_${randomBytes(6).toString('hex').slice(0, 8)}_${randomBytes(32).toString('base64url')}`;
    const match = KEY_PATTERN.exec(key);
    if (!match) throw new Error('외부 업체 키 모양이 아닙니다.');
    const em = this.em.fork();
    const row = em.create(PartnerApiKey, {
      name: input.name,
      prefix: match[1],
      keyHash: sha256Hex(key),
      scopes: [...new Set(input.scopes)],
      expiresAt: input.expiresAt ?? null,
      createdBy: actor,
    });
    await em.flush();
    return { ...toPartnerKeyView(row), key };
  }

  async list(): Promise<PartnerKeyView[]> {
    return (await this.em.fork().find(PartnerApiKey, {}, { orderBy: { id: 'desc' } })).map(toPartnerKeyView);
  }

  /** 폐기. 이미 폐기된 키는 그대로 돌려준다(처음 폐기 시각 유지) */
  async revoke(id: number): Promise<PartnerKeyView> {
    const em = this.em.fork();
    const row = await em.findOne(PartnerApiKey, id);
    if (!row) throw new NotFoundException(`외부 업체 키 ${id}이(가) 없습니다.`);
    row.revokedAt ??= new Date();
    await em.flush();
    // 열이 초 단위(datetime)라 저장된 값은 밀리초가 반올림된다 — 다시 읽어 저장된 값으로 응답한다(두 번째 폐기 응답과 같게)
    return toPartnerKeyView(await this.em.fork().findOneOrFail(PartnerApiKey, id));
  }

  /**
   * 요청에 온 키 원문을 확인한다. 모양이 틀리거나, 없거나, 해시가 다르거나, 폐기·만료됐으면 null.
   * 접두사로 한 행을 찾고 해시는 timingSafeEqual로 비교한다. 맞으면 lastUsedAt을 1분에 한 번만 갱신한다(조건부 UPDATE 한 문장).
   */
  async verify(raw: string | null, now = new Date()): Promise<PartnerApiKey | null> {
    const match = raw ? KEY_PATTERN.exec(raw) : null;
    if (!raw || !match) return null;
    const em = this.em.fork();
    const row = await em.findOne(PartnerApiKey, { prefix: match[1] });
    if (!row) return null;
    if (!timingSafeEqual(Buffer.from(sha256Hex(raw), 'hex'), Buffer.from(row.keyHash, 'hex'))) return null;
    if (row.revokedAt || (row.expiresAt && row.expiresAt <= now)) return null;
    if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= TOUCH_EVERY_MS) {
      await em.nativeUpdate(
        PartnerApiKey,
        { id: row.id, $or: [{ lastUsedAt: null }, { lastUsedAt: { $lte: new Date(now.getTime() - TOUCH_EVERY_MS) } }] },
        { lastUsedAt: now },
      );
    }
    return row;
  }
}
