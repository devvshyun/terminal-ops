import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/mysql';
import type { ApiErrorBody, CreatedPartnerKeyView, PartnerKeyView, PartnerScope } from '@terminal-ops/contracts';
import { Partner } from '../partner/partner.entity.js';
import { PartnerApiKey } from './partner-key.entity.js';

/** `pk_` + 소문자·숫자 8자 + `_` + base64url 43자(32바이트) */
const KEY_PATTERN = /^(pk_[a-z0-9]{8})_[A-Za-z0-9_-]{43}$/;
/** lastUsedAt을 이보다 자주 쓰지 않는다 */
const TOUCH_EVERY_MS = 60_000;

/** 새 키 원문. 접두사는 8자(16진 4바이트 = 약 43억 가지)라 겹칠 수 있다 — create가 겹치면 다시 만든다 */
export const newPartnerKey = () => `pk_${randomBytes(4).toString('hex')}_${randomBytes(32).toString('base64url')}`;
/** 접두사가 겹쳐(unique 위반) 다시 만드는 횟수 */
const CREATE_ATTEMPTS = 5;

export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

export function toPartnerKeyView(k: PartnerApiKey): PartnerKeyView {
  return {
    id: k.id,
    partnerId: k.partner.id,
    partnerCode: k.partner.code,
    partnerName: k.partner.name,
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

  /** 키 원문 만들기. 테스트가 접두사 겹침을 일부러 만들 수 있게 필드로 둔다 */
  generateKey: () => string = newPartnerKey;

  /**
   * 새 키. 원문(key)은 이 응답에만 있다. 만료 시각은 지금보다 뒤여야 한다(지난 시각이면 400 — 만들자마자 쓸 수 없는 키).
   * 접두사가 이미 있는 키와 겹치면(unique 위반) 새 원문으로 다시 넣는다(최대 CREATE_ATTEMPTS번) — 409 DUPLICATE를 내보내지 않는다(Task 5 보안 리뷰).
   * rawKey를 주면(시연 키 시드) 다시 만들지 않는다.
   */
  async create(input: { partnerId: number; name: string; scopes: PartnerScope[]; expiresAt?: Date | null }, actor: string, rawKey?: string): Promise<CreatedPartnerKeyView> {
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException({ statusCode: 400, message: 'expiresAt은 지금보다 뒤여야 합니다.' } satisfies ApiErrorBody);
    }
    const partner = await this.em.fork().findOne(Partner, input.partnerId);
    if (!partner) throw new NotFoundException(`외부 업체 ${input.partnerId}이(가) 없습니다.`);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.insert({ ...input, partner }, actor, rawKey ?? this.generateKey());
      } catch (error) {
        if (rawKey !== undefined || !(error instanceof UniqueConstraintViolationException) || attempt >= CREATE_ATTEMPTS) throw error;
      }
    }
  }

  private async insert(input: { partner: Partner; name: string; scopes: PartnerScope[]; expiresAt?: Date | null }, actor: string, key: string): Promise<CreatedPartnerKeyView> {
    const match = KEY_PATTERN.exec(key);
    if (!match) throw new Error('외부 업체 키 모양이 아닙니다.');
    const em = this.em.fork();
    const row = em.create(PartnerApiKey, {
      partner: em.getReference(Partner, input.partner.id),
      name: input.name,
      prefix: match[1],
      keyHash: sha256Hex(key),
      scopes: [...new Set(input.scopes)],
      expiresAt: input.expiresAt ?? null,
      createdBy: actor,
    });
    await em.flush();
    row.partner = input.partner; // 응답에 업체 코드·이름(참조만 있으면 비어 있다)
    return { ...toPartnerKeyView(row), key };
  }

  /** 최근 발급부터. partnerId를 주면 그 업체 키만 */
  async list(filter: { partnerId?: number } = {}): Promise<PartnerKeyView[]> {
    const where = filter.partnerId ? { partner: filter.partnerId } : {};
    return (await this.em.fork().find(PartnerApiKey, where, { orderBy: { id: 'desc' }, populate: ['partner'] })).map(toPartnerKeyView);
  }

  /** 폐기. 이미 폐기된 키는 그대로 돌려준다(처음 폐기 시각 유지) */
  async revoke(id: number): Promise<PartnerKeyView> {
    const em = this.em.fork();
    const row = await em.findOne(PartnerApiKey, id);
    if (!row) throw new NotFoundException(`외부 업체 키 ${id}이(가) 없습니다.`);
    row.revokedAt ??= new Date();
    await em.flush();
    // 열이 초 단위(datetime)라 저장된 값은 밀리초가 반올림된다 — 다시 읽어 저장된 값으로 응답한다(두 번째 폐기 응답과 같게)
    return toPartnerKeyView(await this.em.fork().findOneOrFail(PartnerApiKey, id, { populate: ['partner'] }));
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
