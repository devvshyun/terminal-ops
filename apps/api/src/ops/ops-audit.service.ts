import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { BeforeIdPage, OpsActionView, OpsQueueName } from '@terminal-ops/contracts';
import type { Principal } from '../auth/principal.js';
import { beforeIdWhere, keysetPage } from '../common/keyset.js';
import { OpsActionLog, type OpsAction } from './ops-action-log.entity.js';

export function toOpsActionView(row: OpsActionLog): OpsActionView {
  return {
    id: row.id,
    action: row.action,
    actor: row.actor,
    actorRole: row.actorRole,
    queue: row.queue as OpsQueueName | null,
    jobId: row.jobId,
    jobName: row.jobName,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 관제 작업 감사 기록(보강 6, decisions/0073). 작업이 성공한 뒤 한 행 — 이 서비스는 쌓기와 읽기만 한다 */
@Injectable()
export class OpsAuditService {
  constructor(private readonly em: EntityManager) {}

  async record(
    who: Pick<Principal, 'loginId' | 'role'>,
    action: OpsAction,
    target: { queue?: string | null; jobId?: string | null; jobName?: string | null; detail?: Record<string, unknown> | null } = {},
  ): Promise<OpsActionLog> {
    const em = this.em.fork();
    const row = em.create(OpsActionLog, {
      action,
      actor: who.loginId,
      actorRole: who.role,
      queue: target.queue ?? null,
      jobId: target.jobId ?? null,
      jobName: target.jobName ?? null,
      detail: target.detail ?? null,
    });
    await em.flush();
    return row;
  }

  /** 최근부터(id 내림차순) beforeId 키셋(decisions/0039) */
  async list(query: { beforeId?: number; limit: number }): Promise<BeforeIdPage<OpsActionView>> {
    const rows = await this.em.fork().find(OpsActionLog, beforeIdWhere(query.beforeId), { orderBy: { id: 'desc' }, limit: query.limit + 1 });
    const page = keysetPage(rows, query.limit);
    return { items: page.items.map(toOpsActionView), nextBeforeId: page.nextBeforeId };
  }
}
