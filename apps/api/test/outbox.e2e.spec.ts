import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxEvent, OutboxStatus } from '../src/outbox/outbox-event.entity.js';
import { OutboxService } from '../src/outbox/outbox.service.js';
import { partners } from './helpers/partners.js';
import { resetQueues, waitFor, waitForQueuesIdle } from './helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'seo' };

describe('알림 Outbox (F5)', () => {
  let t: TestApp;
  let outbox: OutboxService;

  const rows = () => t.orm.em.fork().find(OutboxEvent, {}, { orderBy: { id: 'asc' } });
  const statusOf = async (id: number) => (await t.orm.em.fork().findOneOrFail(OutboxEvent, id)).status;

  /** PENDING을 모두 SENT·FAILED로 만든다(테스트 사이 정리). */
  async function drain() {
    await outbox.relay();
    await waitForQueuesIdle(t.app);
  }

  beforeAll(async () => {
    t = await createTestApp({ workers: true });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    outbox = t.app.get(OutboxService);
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it('등록·전이는 같은 트랜잭션에서 알림을 PENDING으로 남긴다', async () => {
    await t.http().post('/terminals').set(OP).send({ serialNo: 'OB-0001', modelCode: 'SN-100' });
    const [registered] = await rows();
    expect(registered).toMatchObject({ type: 'terminal.status_changed', status: OutboxStatus.PENDING, attempts: 0 });
    expect(registered.payload).toMatchObject({ serialNo: 'OB-0001', fromStatus: null, toStatus: 'RECEIVED', actor: 'seo' });
  });

  it('거절된 전이(422)는 알림도 남기지 않는다(같이 롤백)', async () => {
    const before = (await rows()).length;
    const res = await t.http().post('/terminals/OB-0001/transitions').set(OP).send({ to: 'DISPOSED', reason: '폐기', expectedVersion: 1 });
    expect(res.status).toBe(422);
    expect(await rows()).toHaveLength(before);
  });

  it('relay → notify: 톡톡에 한 번 보내고 SENT', async () => {
    const { queued } = await outbox.relay();
    expect(queued).toHaveLength(1);
    expect(await statusOf(queued[0])).not.toBe(OutboxStatus.PENDING);
    await waitFor(async () => (await statusOf(queued[0])) === OutboxStatus.SENT, { message: 'SENT' });

    const toktok = await partners.toktok();
    expect(toktok.byKey).toEqual({ [`outbox-${queued[0]}`]: 1 });
    expect(toktok.messages[0].text).toBe('[단말온] OB-0001: 신규 → RECEIVED (seo) 신규 등록');
    expect((await outbox.relay()).queued).toHaveLength(0);
  });

  it('메신저가 계속 실패하면 재시도를 다 쓰고 FAILED, 마지막 오류를 남긴다', async () => {
    await partners.configure({ toktok: { failRate: 1 } });
    await t.http().post('/terminals').set(OP).send({ serialNo: 'OB-0002', modelCode: 'SN-100' });
    const { queued } = await outbox.relay();
    await waitFor(async () => (await statusOf(queued[0])) === OutboxStatus.FAILED, { timeoutMs: 15_000, message: 'FAILED' });
    const row = await t.orm.em.fork().findOneOrFail(OutboxEvent, queued[0]);
    expect(row.attempts).toBe(5);
    expect(row.lastError).toContain('PartnerTransientError');
    expect((await partners.toktok()).total).toBe(0);
  });

  it('한 번 실패해도 재시도로 보내면 SENT, 수신은 1번', async () => {
    await drain();
    await t.http().post('/terminals').set(OP).send({ serialNo: 'OB-0003', modelCode: 'SN-100' });
    await partners.configure({ toktok: { failRate: 1 } });
    const { queued } = await outbox.relay();
    await waitFor(async () => (await t.orm.em.fork().findOneOrFail(OutboxEvent, queued[0])).attempts >= 1, { message: '첫 시도' });
    await partners.configure({ toktok: { failRate: 0 } });
    await waitFor(async () => (await statusOf(queued[0])) === OutboxStatus.SENT, { message: 'SENT' });
    expect((await partners.toktok()).byKey[`outbox-${queued[0]}`]).toBe(1);
  });

  it('relay 여러 개가 동시에 돌아도 같은 행을 두 번 잡지 않는다(SKIP LOCKED)', async () => {
    await drain();
    for (let i = 0; i < 20; i++) {
      await t.http().post('/terminals').set(OP).send({ serialNo: `OB-1${String(i).padStart(3, '0')}`, modelCode: 'SN-100' });
    }
    // 한 번에 5건씩 잡는 relay 4개를 동시에 돌린다. SKIP LOCKED가 없으면 같은 행을 기다리거나 두 번 잡는다.
    const results = await Promise.all([1, 2, 3, 4].map(() => outbox.relay(5)));
    const all = results.flatMap((r) => r.queued);
    console.log(`[relay 동시] 각 relay가 잡은 수=${JSON.stringify(results.map((r) => r.queued.length))}`);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(20);

    await waitForQueuesIdle(t.app);
    const toktok = await partners.toktok();
    expect(Object.values(toktok.byKey).every((n) => n === 1)).toBe(true);
    expect(toktok.total).toBe(20);
  });
});
