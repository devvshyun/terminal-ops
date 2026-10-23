import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { OutboxEvent, OutboxStatus } from '../src/outbox/outbox-event.entity.js';
import { OutboxService } from '../src/outbox/outbox.service.js';
import { QUEUE } from '../src/queue/queue-names.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
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

  /**
   * 첫 번째 queue.addBulk 호출에서 멈추게 한다. relay 트랜잭션이 열린 채로 있는 상태를 만들려는 것. 그 뒤 호출은 그대로 통과한다.
   * entered: relay가 addBulk에 들어옴(= SELECT ... FOR UPDATE를 끝내고 락을 쥔 상태), release(): 이어서 진행.
   */
  function holdRelayEnqueue() {
    const queue = t.app.get<Queue>(getQueueToken(QUEUE.OUTBOX));
    const original = queue.addBulk.bind(queue);
    let release!: () => void;
    let markEntered!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((r) => (markEntered = r));
    let calls = 0;
    const spy = vi.spyOn(queue, 'addBulk').mockImplementation(async (...args: Parameters<Queue['addBulk']>) => {
      calls += 1;
      if (calls === 1) {
        markEntered();
        await released;
      }
      return original(...args);
    });
    return { entered, release, restore: () => spy.mockRestore() };
  }

  /** 요청이 끝날 때까지 걸린 시간을 잰다. */
  async function timed<T>(p: PromiseLike<T>): Promise<{ res: T; ms: number }> {
    const start = Date.now();
    const res = await p;
    return { res, ms: Date.now() - start };
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
    // 한 번에 5건씩 잡는 relay 4개를 동시에 돌린다. 겹치지 않는 것만 본다.
    // 주의: 겹침 없음만으로는 SKIP LOCKED를 증명하지 못한다. 그냥 FOR UPDATE여도 relay들이 차례로 기다렸다 돌면
    // [5,5,5,5]가 나올 수 있다(실제로 바꿔 돌려 보니 여기서는 데드락으로 실패했다, troubleshooting/0007).
    // SKIP LOCKED의 진짜 차이는 "기다리지 않는다"이고, 그건 아래 'SKIP LOCKED' 테스트가 본다.
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

  it('relay 트랜잭션이 열려 있어도 등록·전이는 기다리지 않는다(gap 락, troubleshooting/0007)', async () => {
    await drain();
    // PENDING 1건(limit 100보다 적다) → RR이면 relay의 잠금 읽기가 (status, id) 인덱스의 다음 레코드·supremum까지 next-key 락을 건다.
    await t.http().post('/terminals').set(OP).send({ serialNo: 'OB-2000', modelCode: 'SN-100' });
    const em = t.orm.em.fork();
    const terminal = await em.findOneOrFail(Terminal, { serialNo: 'OB-2000' });
    terminal.status = TerminalStatus.INSPECTED;
    await em.flush();

    const hold = holdRelayEnqueue();
    try {
      const relaying = outbox.relay();
      await hold.entered;
      const register = timed(t.http().post('/terminals').set(OP).send({ serialNo: 'OB-2001', modelCode: 'SN-100' }));
      const transition = timed(
        t.http().post('/terminals/OB-2000/transitions').set(OP).send({ to: 'IN_STOCK', reason: '입고', expectedVersion: terminal.version }),
      );
      const LIMIT_MS = 1000;
      let timer: NodeJS.Timeout | undefined;
      const doneInTime = await Promise.race([
        Promise.all([register, transition]).then(() => true),
        new Promise<boolean>((r) => {
          timer = setTimeout(() => r(false), LIMIT_MS);
        }),
      ]);
      clearTimeout(timer);
      hold.release();
      await relaying;
      const [reg, tr] = await Promise.all([register, transition]);
      console.log(`[relay 중 쓰기] 등록 ${reg.res.status} ${reg.ms}ms, 전이 ${tr.res.status} ${tr.ms}ms (relay가 addBulk에서 멈춘 동안, 한도 ${LIMIT_MS}ms)`);
      expect(doneInTime).toBe(true);
      expect(reg.res.status).toBe(201);
      expect(tr.res.status).toBe(200);
    } finally {
      hold.release();
      hold.restore();
    }
    await drain();
  });

  it('다른 relay가 행을 잡고 있으면 기다리지 않고 다음 행을 잡는다(SKIP LOCKED)', async () => {
    await drain();
    for (let i = 0; i < 10; i++) {
      await t.http().post('/terminals').set(OP).send({ serialNo: `OB-3${String(i).padStart(3, '0')}`, modelCode: 'SN-100' });
    }
    const hold = holdRelayEnqueue();
    try {
      let firstDone = false;
      const first = outbox.relay(5).then((r) => ((firstDone = true), r));
      await hold.entered; // 첫 relay가 5건을 잠그고 addBulk에서 멈춤
      const second = await timed(outbox.relay(5));
      const firstStillHolding = !firstDone;
      hold.release();
      const firstResult = await first;
      console.log(`[SKIP LOCKED] 둘째 relay ${second.ms}ms, 첫째=${JSON.stringify(firstResult.queued)} 둘째=${JSON.stringify(second.res.queued)}`);
      expect(firstStillHolding).toBe(true);
      expect(second.ms).toBeLessThan(1000);
      expect(firstResult.queued).toHaveLength(5);
      expect(second.res.queued).toHaveLength(5);
      expect(second.res.queued.filter((id) => firstResult.queued.includes(id))).toEqual([]);
    } finally {
      hold.release();
      hold.restore();
    }
    await waitForQueuesIdle(t.app);
  });

  it('relay는 잡은 행을 addBulk 한 번으로 큐에 넣는다(행마다 add하지 않는다, decisions/0024)', async () => {
    await drain();
    for (let i = 0; i < 5; i++) {
      await t.http().post('/terminals').set(OP).send({ serialNo: `OB-4${String(i).padStart(3, '0')}`, modelCode: 'SN-100' });
    }
    const queue = t.app.get<Queue>(getQueueToken(QUEUE.OUTBOX));
    const add = vi.spyOn(queue, 'add');
    const addBulk = vi.spyOn(queue, 'addBulk');
    try {
      const { queued } = await outbox.relay();
      expect(queued).toHaveLength(5);
      expect(addBulk).toHaveBeenCalledTimes(1);
      expect(addBulk.mock.calls[0][0].map((j) => j.opts?.jobId)).toEqual(queued.map((id) => `outbox-${id}`));
      expect(add).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
      addBulk.mockRestore();
    }
    await waitForQueuesIdle(t.app);
    expect(Object.values((await partners.toktok()).byKey).every((n) => n === 1)).toBe(true);
  });

  it('addBulk가 일부만 넣고 실패하면 행은 PENDING으로 남고, 다음 relay가 같은 jobId로 다시 넣어 한 번씩만 보낸다(decisions/0024)', async () => {
    await drain();
    for (let i = 0; i < 6; i++) {
      await t.http().post('/terminals').set(OP).send({ serialNo: `OB-5${String(i).padStart(3, '0')}`, modelCode: 'SN-100' });
    }
    await partners.reset();
    const queue = t.app.get<Queue>(getQueueToken(QUEUE.OUTBOX));
    const jobsInQueue = async () => (await queue.getJobs(['waiting'])).map((j) => j.id).sort();
    const pending = (await rows()).filter((r) => r.status === OutboxStatus.PENDING).map((r) => r.id);
    expect(pending).toHaveLength(6);

    // BullMQ 6.4.0 addBulk는 pipeline(MULTI 아님)이라 앞쪽 명령은 들어가고 뒤에서 실패할 수 있다. 그 모양을 흉내 낸다:
    // 진짜 addBulk로 앞 절반만 넣고 throw. 워커가 먼저 처리하지 않게 큐를 멈춰 둔다(들어간 job을 세려고. BullMQ 6은 멈춘 큐의 job도 waiting으로 센다).
    await queue.pause();
    const original = queue.addBulk.bind(queue);
    const spy = vi.spyOn(queue, 'addBulk').mockImplementationOnce(async (jobs) => {
      await original(jobs.slice(0, Math.ceil(jobs.length / 2)));
      throw new Error('주입한 실패: addBulk 중간');
    });
    try {
      await expect(outbox.relay()).rejects.toThrow('주입한 실패');
      const afterFail = await jobsInQueue();
      const statuses = await Promise.all(pending.map(statusOf));
      console.log(`[addBulk 부분 실패] 큐에 남은 job=${JSON.stringify(afterFail)} 행 상태=${JSON.stringify(statuses)}`);
      expect(statuses.every((s) => s === OutboxStatus.PENDING)).toBe(true); // relay 트랜잭션 롤백
      expect(afterFail).toEqual(pending.slice(0, 3).map((id) => `outbox-${id}`).sort()); // 앞 절반은 Redis에 남음

      const { queued } = await outbox.relay(); // 다음 relay: 같은 jobId 6개를 다시 넣는다
      expect(queued).toEqual(pending);
      const afterRetry = await jobsInQueue();
      console.log(`[addBulk 부분 실패] 다시 relay 뒤 job=${JSON.stringify(afterRetry)}`);
      expect(afterRetry).toEqual(pending.map((id) => `outbox-${id}`).sort()); // 이미 있던 3개는 중복으로 들어가지 않음
    } finally {
      spy.mockRestore();
      await queue.resume();
    }
    await waitForQueuesIdle(t.app);
    const toktok = await partners.toktok();
    expect(toktok.byKey).toEqual(Object.fromEntries(pending.map((id) => [`outbox-${id}`, 1])));
    expect(await Promise.all(pending.map(statusOf))).toEqual(pending.map(() => OutboxStatus.SENT));
  });
});
