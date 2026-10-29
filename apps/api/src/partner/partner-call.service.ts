import { Injectable, Logger } from '@nestjs/common';
import { EntityManager, LoadStrategy } from '@mikro-orm/mysql';
import type { BeforeIdPage, PartnerCallView } from '@terminal-ops/contracts';
import { PartnerApiKey } from '../auth/partner-key.entity.js';
import { beforeIdWhere, keysetPage } from '../common/keyset.js';
import { PartnerCall } from './partner-call.entity.js';
import { Partner } from './partner.entity.js';

export interface PartnerCallEntry {
  partnerId: number;
  keyId: number;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

/** 외부용 API 호출 기록(보강 7, decisions/0082) */
@Injectable()
export class PartnerCallService {
  private readonly logger = new Logger(PartnerCallService.name);

  constructor(private readonly em: EntityManager) {}

  /**
   * 기다리지 않고 쓴다 — 응답은 이미 나갔고, 기록이 실패해도(DB 끊김 등) 외부 업체 응답에는 영향이 없다. 실패는 경고 로그 한 줄.
   * 대가: 그 호출은 기록에서 빠진다(다시 넣지 않는다).
   */
  record(entry: PartnerCallEntry): void {
    this.insert(entry).catch((error: unknown) => this.logger.warn(`호출 기록 실패(${entry.method} ${entry.path} ${entry.status}): ${String(error)}`));
  }

  /** 테스트가 실패를 일부러 만들 수 있게 따로 둔다 */
  async insert(entry: PartnerCallEntry): Promise<void> {
    const em = this.em.fork();
    em.create(PartnerCall, {
      partner: em.getReference(Partner, entry.partnerId),
      key: em.getReference(PartnerApiKey, entry.keyId),
      method: entry.method.slice(0, 10),
      path: entry.path.slice(0, 200),
      status: entry.status,
      durationMs: Math.max(0, Math.round(entry.durationMs)),
    });
    await em.flush();
  }

  /** 최근부터(id 내림차순) beforeId 키셋. 업체 코드·키 접두사는 select-in으로(0039 — joined면 PK 역순 읽기를 버릴 수 있다) */
  async list(query: { partnerId?: number; keyId?: number; beforeId?: number; limit: number }): Promise<BeforeIdPage<PartnerCallView>> {
    const where = {
      ...beforeIdWhere(query.beforeId),
      ...(query.partnerId ? { partner: query.partnerId } : {}),
      ...(query.keyId ? { key: query.keyId } : {}),
    };
    const rows = await this.em.fork().find(PartnerCall, where, { orderBy: { id: 'desc' }, limit: query.limit + 1, populate: ['partner', 'key'], strategy: LoadStrategy.SELECT_IN });
    const page = keysetPage(rows, query.limit);
    return { items: page.items.map(toPartnerCallView), nextBeforeId: page.nextBeforeId };
  }
}

function toPartnerCallView(c: PartnerCall): PartnerCallView {
  return {
    id: c.id,
    partnerId: c.partner.id,
    partnerCode: c.partner.code,
    keyId: c.key.id,
    keyPrefix: c.key.prefix,
    method: c.method,
    path: c.path,
    status: c.status,
    durationMs: c.durationMs,
    createdAt: c.createdAt.toISOString(),
  };
}
