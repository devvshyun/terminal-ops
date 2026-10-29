import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { BeforeIdPage, OpsActionView, OpsQueueName, Role } from '@terminal-ops/contracts';
import type { Principal } from '../auth/principal.js';
import { beforeIdWhere, keysetPage } from '../common/keyset.js';
import { OpsActionLog, type OpsAction } from './ops-action-log.entity.js';

export function toOpsActionView(row: OpsActionLog): OpsActionView {
  return {
    id: row.id,
    action: row.action,
    actor: row.actor,
    // 기록 행은 그때의 역할 문자열이다 — 나중에 역할 값이 바뀌면 옛 행에는 지금 Role에 없는 값이 남을 수 있다(최종 리뷰 Minor 4)
    actorRole: row.actorRole as Role,
    queue: row.queue as OpsQueueName | null,
    jobId: row.jobId,
    jobName: row.jobName,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 열 길이로 자른다(ops-action-log.entity.ts·마이그레이션의 varchar 길이와 같게). null·undefined는 null */
const clip = (value: string | null | undefined, length: number) => (value == null ? null : value.slice(0, length));

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
    // Redis 작업이 끝난 뒤 INSERT하므로, 열 길이를 넘는 값(BullMQ job 이름·id에는 길이 제한이 없다)으로 INSERT가 거절되면
    // "작업은 됐는데 기록이 없고 500"이 된다 — 열 길이로 잘라 넣는다(최종 리뷰 Minor 3, decisions/0073 보탬)
    const row = em.create(OpsActionLog, {
      action,
      actor: clip(who.loginId, 50)!,
      actorRole: clip(who.role, 20)!,
      queue: clip(target.queue, 30),
      jobId: clip(target.jobId, 200),
      jobName: clip(target.jobName, 50),
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
