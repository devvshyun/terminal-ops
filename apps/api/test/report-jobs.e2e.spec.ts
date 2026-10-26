import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { Anomaly, AnomalyRule } from '../src/anomaly/anomaly.entity.js';
import { AnomalyService } from '../src/anomaly/anomaly.service.js';
import { DAY_MS } from '../src/config/env-number.js';
import { OutboxEvent } from '../src/outbox/outbox-event.entity.js';
import { QUEUE } from '../src/queue/queue-names.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { TerminalStatus as S } from '../src/terminal/terminal-status.js';
import { VanReconciliationRun, VanRunStatus, VanRunTrigger } from '../src/van/van.entities.js';
import { partners } from './helpers/partners.js';
import { resetQueues, waitFor } from './helpers/queues.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { insertTerminals } from './helpers/terminals.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const daysAgo = (d: number) => new Date(Date.now() - d * DAY_MS);

describe('이상 단말기 알림과 report 큐 job (F4·F9, decisions/0034·0035)', () => {
  let t: TestApp;
  let svc: AnomalyService;
  let reportQueue: Queue;
  const em = () => t.orm.em.fork();
  const events = (type: string) => em().find(OutboxEvent, { type }, { orderBy: { id: 'asc' } });

  beforeAll(async () => {
    t = await createTestApp({ workers: true });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    svc = t.app.get(AnomalyService);
    reportQueue = t.app.get<Queue>(getQueueToken(QUEUE.REPORT));
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await deleteTestKeys(t.app.get<Redis>(REDIS));
    await t.app.close();
  });

  it('새 이상이 기준(20) 이하면 단말기마다 anomaly.detected, 계속 걸린 이상은 다시 알리지 않는다', async () => {
    await insertTerminals(t, [
      { serialNo: 'NT-01', status: S.DELIVERED, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(9) },
      { serialNo: 'NT-02', status: S.IN_SERVICE, merchantCode: null },
    ]);
    expect((await svc.scan()).detected).toBe(2);
    const rows = await events('anomaly.detected');
    expect(rows.map((e) => e.payload)).toEqual([
      { serialNo: 'NT-01', rule: 'DELIVERED_NOT_INSTALLED', days: 9, detectedAt: expect.any(String) },
      { serialNo: 'NT-02', rule: 'IN_SERVICE_NO_MERCHANT', detectedAt: expect.any(String) },
    ]);
    expect((await svc.scan()).continuing).toBe(2);
    expect(await events('anomaly.detected')).toHaveLength(2);
  });

  it('새 이상이 기준보다 많으면 묶음 한 행(anomaly.detected_bulk: 대수, 규칙별 수, 앞 100대)', async () => {
    await insertTerminals(
      t,
      Array.from({ length: 25 }, (_, i) => ({ serialNo: `NB-${String(i + 1).padStart(2, '0')}`, status: S.SHIPPED, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(12) })),
    );
    expect((await svc.scan()).detected).toBe(25);
    const bulk = await events('anomaly.detected_bulk');
    expect(bulk).toHaveLength(1);
    expect(bulk[0].payload).toMatchObject({ count: 25, byRule: { SHIPPED_TOO_LONG: 25 }, truncated: false });
    expect((bulk[0].payload.serials as string[]).slice(0, 2)).toEqual(['NB-01', 'NB-02']);
    expect(await events('anomaly.detected')).toHaveLength(2); // 단말기별 행은 늘지 않았다
  });

  it('report 큐 워커가 anomaly-scan·van-reconcile-scheduled job을 처리하고, 모르는 job은 재시도 없이 실패', async () => {
    await insertTerminals(t, [{ serialNo: 'NQ-01', status: S.ALLOCATED, merchantCode: 'GANGNAM-KIMBAP', statusChangedAt: daysAgo(5) }]);
    await reportQueue.add('anomaly-scan', {});
    await waitFor(async () => (await em().count(Anomaly, { rule: AnomalyRule.ALLOCATED_NO_SHIPMENT, resolvedAt: null })) === 1, { message: 'anomaly-scan job' });

    await partners.reset();
    // 계획은 빈 VAN([])이었다. fix 커밋(38b4d31)의 VAN 0건 안전장치 때문에(운영 중 NT-02가 있고 주기 실행은 확인 플래그가 없어 FAILED) 한 건을 심는다
    await partners.seedVan([{ tid: 'T-NT-02', serialNo: 'NT-02', merchantCode: 'GANGNAM-KIMBAP', status: 'ACTIVE' }]);
    await reportQueue.add('van-reconcile-scheduled', {});
    const run = await waitFor(
      async () => em().findOne(VanReconciliationRun, { trigger: VanRunTrigger.SCHEDULED, status: VanRunStatus.COMPLETED }),
      { message: '주기 VAN 대조' },
    );
    expect(run.requestedBy).toBe('system:van-reconcile');

    const bad = await reportQueue.add('nope', {}, { attempts: 3 });
    await waitFor(async () => (await bad.getState()) === 'failed', { message: '모르는 job 실패' });
    expect((await reportQueue.getJob(bad.id!))?.attemptsMade).toBe(1);
  });
});
