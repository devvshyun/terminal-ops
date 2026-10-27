import { Controller, Get, Query } from '@nestjs/common';
import { EntityManager, LoadStrategy } from '@mikro-orm/mysql';
import { beforeIdWhere, keysetPage } from '../common/keyset.js';
import { ListSyncRunsQuery } from './dto/list-sync-runs.query.js';
import { SyncRun } from './shipment.entities.js';

/** 택배 추적 수집 job의 실행 기록(F3). 어드민 배치 실행 이력 화면이 본다 */
@Controller('sync-runs')
export class SyncRunController {
  constructor(private readonly em: EntityManager) {}

  /** 최근 실행부터(?job=&outcome=&beforeId=&limit=, id 키셋 — decisions/0039) */
  @Get()
  async list(@Query() q: ListSyncRunsQuery) {
    const rows = await this.em.fork().find(
      SyncRun,
      { ...beforeIdWhere(q.beforeId), ...(q.job ? { job: q.job } : {}), ...(q.outcome ? { outcome: q.outcome } : {}) },
      { populate: ['shipment'], strategy: LoadStrategy.SELECT_IN, orderBy: { id: 'desc' }, limit: q.limit + 1 },
    );
    const { items, nextBeforeId } = keysetPage(rows, q.limit);
    return {
      items: items.map((r) => ({
        id: r.id,
        job: r.job,
        shipmentId: r.shipment?.id ?? null,
        trackingNo: r.shipment?.trackingNo ?? null,
        attempt: r.attempt,
        worker: r.worker,
        outcome: r.outcome,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        fetched: r.fetched,
        inserted: r.inserted,
        duplicated: r.duplicated,
        detail: r.detail ?? null,
      })),
      nextBeforeId,
    };
  }
}
