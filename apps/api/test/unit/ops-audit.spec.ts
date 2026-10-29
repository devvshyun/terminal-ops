import { describe, expect, it } from 'vitest';
import type { EntityManager } from '@mikro-orm/mysql';
import { Role } from '../../src/auth/role.js';
import { OpsAuditService } from '../../src/ops/ops-audit.service.js';

/**
 * 감사 기록은 Redis 작업이 끝난 뒤 INSERT한다(decisions/0073). BullMQ job 이름·id에는 길이 제한이 없어,
 * 열 길이를 넘는 값이면 strict 모드 MySQL이 INSERT를 거절해 "작업은 됐는데 기록이 없고 500"이 된다 — 열 길이로 잘라 넣는다(최종 리뷰 Minor 3).
 */
describe('감사 기록 열 길이 (최종 리뷰 Minor 3)', () => {
  it('jobName 50·jobId 200·queue 30·actor 50자로 자른다(actorRole도 20자로 — 지금 역할 값은 모두 짧다. 짧은 값과 null은 그대로)', async () => {
    const created: Record<string, unknown>[] = [];
    const em = { fork: () => ({ create: (_cls: unknown, data: Record<string, unknown>) => (created.push(data), data), flush: async () => {} }) } as unknown as EntityManager;
    const audit = new OpsAuditService(em);
    await audit.record({ loginId: 'm'.repeat(60), role: Role.MONITOR }, 'RETRY_JOB', { queue: 'q'.repeat(40), jobId: 'i'.repeat(250), jobName: 'n'.repeat(80), detail: { a: 1 } });
    await audit.record({ loginId: 'mon', role: Role.MONITOR }, 'REQUEUE_OUTBOX', { detail: { checked: 0 } });
    expect(created[0]).toMatchObject({ actor: 'm'.repeat(50), queue: 'q'.repeat(30), jobId: 'i'.repeat(200), jobName: 'n'.repeat(50), detail: { a: 1 } });
    expect(created[1]).toMatchObject({ actor: 'mon', actorRole: 'MONITOR', queue: null, jobId: null, jobName: null });
  });
});
