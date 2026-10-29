import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { OpsOutboxStatus, OpsOutboxView } from '@terminal-ops/contracts';
import { env } from '../config/env.js';
import { OutboxEvent, OutboxStatus } from '../outbox/outbox-event.entity.js';

/**
 * Outbox 요약(보강 6, decisions/0070·0042).
 * 상태별 수는 (status, id) 인덱스로 센다(상태마다 count 하나). 가장 오래된 PENDING·QUEUED는 그 상태의 가장 작은 id 행의 만든 시각.
 */
@Injectable()
export class OpsOutboxService {
  constructor(private readonly em: EntityManager) {}

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
}
