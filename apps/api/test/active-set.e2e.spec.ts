import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getQueueToken } from '@nestjs/bullmq';
import { UnrecoverableError, type Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../src/device/active-set.service.js';
import { deviceKeys } from '../src/device/device-keys.js';
import { OutboxEvent, OutboxStatus } from '../src/outbox/outbox-event.entity.js';
import { OutboxService, PROJECT_JOB_OPTIONS } from '../src/outbox/outbox.service.js';
import { QUEUE } from '../src/queue/queue-names.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { resetQueues, waitForQueuesIdle } from './helpers/queues.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { prepareInService, transitionTo } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('운영 중 단말기 목록(active) 유지 — Outbox 두 번째 소비자 + 주기 재구성 (decisions/0028)', () => {
  let t: TestApp;
  let redis: Redis;
  let outbox: OutboxService;
  const active = () => redis.hgetall(deviceKeys().active);

  /** PENDING을 모두 relay하고, notify·project job이 다 끝날 때까지 기다린다. */
  async function relayAll() {
    while ((await outbox.relay()).queued.length > 0);
    await waitForQueuesIdle(t.app);
  }

  beforeAll(async () => {
    t = await createTestApp({ workers: true });
    redis = t.app.get<Redis>(REDIS);
    outbox = t.app.get(OutboxService);
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    await deleteTestKeys(redis, 'hb:');
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('relay는 IN_SERVICE 진입·이탈 이벤트만 device 큐에 project job으로 넣는다(jobId project-<outbox id>)', async () => {
    await prepareInService(t, 'AC-0001'); // 등록 → … → IN_SERVICE, 이벤트 7개 중 IN_SERVICE 진입 1개
    const deviceQueue = t.app.get<Queue>(getQueueToken(QUEUE.DEVICE));
    const addBulk = vi.spyOn(deviceQueue, 'addBulk');
    try {
      await relayAll();
      const jobs = addBulk.mock.calls.flatMap((c) => c[0]);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ name: 'project', data: { serialNo: 'AC-0001' } });
      expect(jobs[0].opts?.jobId).toMatch(/^project-\d+$/);
    } finally {
      addBulk.mockRestore();
    }
    const id = (await t.orm.em.fork().findOneOrFail(Terminal, { serialNo: 'AC-0001' })).id;
    expect(await active()).toEqual({ 'AC-0001': String(id) });
  });

  it('IN_SERVICE에서 나가면(회수 요청) project job이 active에서 지운다', async () => {
    await transitionTo(t, 'AC-0001', 'RETURN_REQUESTED', 'pickup');
    await relayAll();
    expect(await active()).toEqual({});
  });

  it('project는 이벤트의 상태가 아니라 MySQL의 지금 상태를 본다(늦게 온 옛 이벤트가 결과를 되돌리지 않는다)', async () => {
    await prepareInService(t, 'AC-0002');
    await relayAll();
    await transitionTo(t, 'AC-0002', 'RETURN_REQUESTED', 'pickup');
    // 회수 요청 이벤트가 처리되기 전에 "IN_SERVICE 진입" 이벤트가 한 번 더(늦게) 처리된 상황
    await t.app.get(ActiveSetService).apply(['AC-0002']);
    expect(await redis.hexists(deviceKeys().active, 'AC-0002')).toBe(0);
    await relayAll();
    expect(await redis.hexists(deviceKeys().active, 'AC-0002')).toBe(0);
  });

  it('이벤트를 잃어도(Redis에서 지워져도) 주기 재구성이 MySQL 기준으로 되돌린다', async () => {
    await prepareInService(t, 'AC-0003');
    await relayAll();
    await redis.hdel(deviceKeys().active, 'AC-0003'); // 유실 흉내
    await redis.hset(deviceKeys().active, 'AC-9999', '9999'); // 없는 단말기
    await t.app.get<Queue>(getQueueToken(QUEUE.DEVICE)).add('rebuild-active', {});
    await waitForQueuesIdle(t.app);
    const id = (await t.orm.em.fork().findOneOrFail(Terminal, { serialNo: 'AC-0003' })).id;
    expect(await active()).toEqual({ 'AC-0003': String(id) });
    expect(await t.orm.em.fork().count(Terminal, { status: TerminalStatus.IN_SERVICE })).toBe(1);
  });

  it('IN_SERVICE 단말기가 하나도 없으면 재구성은 0을 돌려주고 active 키를 지운다', async () => {
    await t.orm.em.fork().nativeUpdate(Terminal, { status: TerminalStatus.IN_SERVICE }, { status: TerminalStatus.RETURN_REQUESTED });
    expect(await redis.exists(deviceKeys().active)).toBe(1); // 직전 테스트가 남긴 값
    expect(await t.app.get(ActiveSetService).rebuild()).toBe(0);
    expect(await redis.exists(deviceKeys().active)).toBe(0);
  });
  it('device 큐 addBulk가 실패해도(notify는 이미 들어감) 다음 relay가 project job을 넣는다(troubleshooting/0018)', async () => {
    await prepareInService(t, 'AC-0101');
    const deviceQueue = t.app.get<Queue>(getQueueToken(QUEUE.DEVICE));
    const spy = vi.spyOn(deviceQueue, 'addBulk').mockImplementationOnce(async () => {
      throw new Error('주입한 실패: device addBulk');
    });
    try {
      await expect(outbox.relay()).rejects.toThrow('주입한 실패');
      // 실패한 relay가 넣은 job(있다면)이 다 처리되게 둔다. 고치기 전에는 notify가 행을 SENT로 바꿔 버린다.
      await waitForQueuesIdle(t.app);
      const rows = await t.orm.em.fork().find(OutboxEvent, {}, { orderBy: { id: 'asc' } });
      const entering = rows.find((r) => r.payload.serialNo === 'AC-0101' && r.payload.toStatus === 'IN_SERVICE')!;
      console.log(`[project 유실] 실패한 relay 뒤 IN_SERVICE 진입 행 ${entering.id} 상태=${entering.status}`);
      await relayAll();
    } finally {
      spy.mockRestore();
    }
    const id = (await t.orm.em.fork().findOneOrFail(Terminal, { serialNo: 'AC-0101' })).id;
    expect(await redis.hget(deviceKeys().active, 'AC-0101')).toBe(String(id));
    const statuses = (await t.orm.em.fork().find(OutboxEvent, {}, { orderBy: { id: 'asc' } })).map((r) => r.status);
    expect(statuses.every((s) => s === OutboxStatus.SENT)).toBe(true);
  });

  it('project job의 serialNo가 글자가 아니면 재시도 없이 실패한다(UnrecoverableError)', async () => {
    await expect(t.app.get(ActiveSetService).apply([123 as unknown as string])).rejects.toBeInstanceOf(UnrecoverableError);
    const deviceQueue = t.app.get<Queue>(getQueueToken(QUEUE.DEVICE));
    const job = await deviceQueue.add('project', {}, { ...PROJECT_JOB_OPTIONS, removeOnFail: false, jobId: 'project-bad-payload' });
    await waitForQueuesIdle(t.app);
    const failed = await deviceQueue.getJob(job.id!);
    expect(await failed!.getState()).toBe('failed');
    expect(failed!.attemptsMade).toBe(1);
    expect(failed!.failedReason).toContain('serialNo');
  });
});
