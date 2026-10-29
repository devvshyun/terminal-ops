import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { OpsOutboxStatus, OpsOutboxView, OpsRequeueResult } from '@terminal-ops/contracts';
import type { Principal } from '../auth/principal.js';
import { env } from '../config/env.js';
import { OutboxEvent, OutboxStatus } from '../outbox/outbox-event.entity.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { OpsAuditService } from './ops-audit.service.js';

/** 감사 기록에 남길 다시 넣은 id 수(그 뒤는 수만) */
const AUDIT_IDS = 50;

/**
 * Outbox 요약과 복구 sweep 수동 실행(보강 6, decisions/0070·0042·0073).
 * 상태별 수는 (status, id) 인덱스로 센다(상태마다 count 하나). 가장 오래된 PENDING·QUEUED는 그 상태의 가장 작은 id 행의 만든 시각.
 */
@Injectable()
export class OpsOutboxService {
  constructor(
    private readonly em: EntityManager,
    private readonly outbox: OutboxService,
    private readonly audit: OpsAuditService,
  ) {}

  async summary(now = new Date()): Promise<OpsOutboxView> {
    const em = this.em.fork();
    const statuses = Object.values(OutboxStatus);
    const counts = await Promise.all(statuses.map((status) => em.count(OutboxEvent, { status })));
    const oldest = (status: OutboxStatus) => em.findOne(OutboxEvent, { status }, { orderBy: { id: 'asc' }, fields: ['id', 'createdAt'] });
    const [pending, queued] = await Promise.all([oldest(OutboxStatus.PENDING), oldest(OutboxStatus.QUEUED)]);
    return {
      checkedAt: now.toISOString(),
      counts: Object.fromEntries(statuses.map((s, i) => [s, counts[i]])) as Record<OpsOutboxStatus, number>,
      oldestPendingAt: pending?.createdAt.toISOString() ?? null,
      oldestQueuedAt: queued?.createdAt.toISOString() ?? null,
      requeueAfterMs: env.outboxRequeueAfterMs,
    };
  }

  /** 주기 작업 outbox-requeue와 같은 일(OutboxService.requeueStale 그대로)을 지금 한 번. 다시 넣은 것이 없어도 감사 기록은 남긴다(눌렀다는 사실) */
  async requeue(who: Principal): Promise<OpsRequeueResult> {
    const { checked, requeued } = await this.outbox.requeueStale();
    const row = await this.audit.record(who, 'REQUEUE_OUTBOX', {
      detail: { checked, requeuedCount: requeued.length, requeued: requeued.slice(0, AUDIT_IDS) },
    });
    return { checked, requeued, actionId: row.id };
  }
}
