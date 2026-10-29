import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { CreatePartnerRequest, PartnerView } from '@terminal-ops/contracts';
import { fromDbDatetime } from '../common/db-datetime.js';
import { Partner } from './partner.entity.js';

interface KeyStats {
  partner_id: number;
  active_keys: string | number;
  total_keys: string | number;
  last_used_at: Date | string | null;
}

/** 원시 SQL의 datetime 글자는 UTC인데 시간대 표시가 없다 — `new Date(글자)`면 서버 지역 시간으로 읽힌다(최종 검토, common/db-datetime.ts) */
const iso = (value: Date | string | null) => (value === null ? null : fromDbDatetime(value).toISOString());

/** 외부 업체 목록·등록(보강 7, decisions/0081). ADMIN API가 부른다 */
@Injectable()
export class PartnerService {
  constructor(private readonly em: EntityManager) {}

  /** 코드 순. 키 수·마지막 사용은 키 표를 업체별로 한 번에 센다("살아 있다" = 폐기 안 됐고 만료 전 — 키 확인(verify)과 같은 기준, 시각은 api 시계) */
  async list(now = new Date()): Promise<PartnerView[]> {
    const em = this.em.fork();
    const [partners, stats] = await Promise.all([
      em.find(Partner, {}, { orderBy: { code: 'asc' } }),
      em.getConnection().execute<KeyStats[]>(
      `select partner_id,
              sum(revoked_at is null and (expires_at is null or expires_at > ?)) as active_keys,
              count(*) as total_keys,
              max(last_used_at) as last_used_at
         from partner_api_key group by partner_id`,
        [now],
      ),
    ]);
    const byPartner = new Map(stats.map((s) => [Number(s.partner_id), s]));
    return partners.map((p) => {
      const s = byPartner.get(p.id);
      return toPartnerView(p, { activeKeys: Number(s?.active_keys ?? 0), totalKeys: Number(s?.total_keys ?? 0), lastUsedAt: iso(s?.last_used_at ?? null) });
    });
  }

  /** 같은 코드는 unique 위반 → 409 DUPLICATE(전역 필터) */
  async create(input: CreatePartnerRequest, actor: string): Promise<PartnerView> {
    const em = this.em.fork();
    const row = em.create(Partner, { code: input.code, name: input.name, memo: input.memo ?? null, createdBy: actor });
    await em.flush();
    // 열이 초 단위(datetime)라 저장된 값은 밀리초가 반올림된다 — 다시 읽어 목록과 같은 값으로 응답한다(키 폐기와 같은 방식)
    return toPartnerView(await this.em.fork().findOneOrFail(Partner, row.id), { activeKeys: 0, totalKeys: 0, lastUsedAt: null });
  }
}

function toPartnerView(p: Partner, keys: Pick<PartnerView, 'activeKeys' | 'totalKeys' | 'lastUsedAt'>): PartnerView {
  return { id: p.id, code: p.code, name: p.name, memo: p.memo, ...keys, createdBy: p.createdBy, createdAt: p.createdAt.toISOString() };
}
