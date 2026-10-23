import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../src/device/active-set.service.js';
import { deviceKeys } from '../src/device/device-keys.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { captureQueries } from './helpers/query-log.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { prepareInService, SCENARIO_OP } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('하트비트 (F8, decisions/0027·0028)', () => {
  let t: TestApp;
  let redis: Redis;
  const keys = () => deviceKeys();
  const beat = (items: unknown[]) => t.http().post('/devices/heartbeats').send({ items });
  const idOf = async (serialNo: string) => String((await t.orm.em.fork().findOneOrFail(Terminal, { serialNo })).id);

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    await resetDatabase(t.orm);
    await prepareInService(t, 'HB-0001');
    await prepareInService(t, 'HB-0002');
    await t.http().post('/terminals').set(SCENARIO_OP).send({ serialNo: 'HB-0003', modelCode: 'SN-100' }); // RECEIVED
  });
  beforeEach(async () => {
    await deleteTestKeys(redis, 'hb:');
    await t.app.get(ActiveSetService).rebuild();
  });
  afterAll(async () => {
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('active는 MySQL의 IN_SERVICE 단말기(serialNo → id)로 다시 만들고, TTL이 없다', async () => {
    expect(await redis.hgetall(keys().active)).toEqual({ 'HB-0001': await idOf('HB-0001'), 'HB-0002': await idOf('HB-0002') });
    expect(await redis.pttl(keys().active)).toBe(-1);
    // 다시 만들면 바뀐 상태를 따라간다(남은 임시 키 없음)
    await t.orm.em.fork().nativeUpdate(Terminal, { serialNo: 'HB-0002' }, { status: TerminalStatus.RETURN_REQUESTED });
    expect(await t.app.get(ActiveSetService).rebuild()).toBe(1);
    expect(await redis.hkeys(keys().active)).toEqual(['HB-0001']);
    expect(await redis.keys(`${keys().active}:rebuild:*`)).toEqual([]);
    await t.orm.em.fork().nativeUpdate(Terminal, { serialNo: 'HB-0002' }, { status: TerminalStatus.IN_SERVICE });
  });

  it('묶음의 행마다 결과: 운영 중이면 OK, 아니면 IGNORED_NOT_IN_SERVICE, 형식이 틀리면 INVALID_FORMAT', async () => {
    const before = Date.now();
    const res = await beat([
      { serialNo: 'HB-0001', firmwareVersion: '1.0.0' },
      { serialNo: 'HB-0003', firmwareVersion: '1.0.0' },
      { serialNo: 'bad serial', firmwareVersion: '1.0.0' },
      { serialNo: 'HB-0002' },
      { serialNo: ' HB-0002 ', firmwareVersion: '1.0.1' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(2);
    expect(res.body.results.map((r: { serialNo: string; result: string }) => [r.serialNo, r.result])).toEqual([
      ['HB-0001', 'OK'],
      ['HB-0003', 'IGNORED_NOT_IN_SERVICE'],
      ['bad serial', 'INVALID_FORMAT'],
      ['HB-0002', 'INVALID_FORMAT'],
      ['HB-0002', 'OK'],
    ]);

    const seen = Number(await redis.zscore(keys().lastSeen, 'HB-0001'));
    expect(seen).toBeGreaterThanOrEqual(before);
    expect(seen).toBeLessThanOrEqual(Date.now());
    expect(await redis.hgetall(keys().firmware)).toEqual({ 'HB-0001': '1.0.0', 'HB-0002': '1.0.1' });
    expect(await redis.zscore(keys().lastSeen, 'HB-0003')).toBeNull();
  });

  it('하트비트는 MySQL에 아무 쿼리도 보내지 않는다(상태 전이가 아니다)', async () => {
    const log = captureQueries(t.orm);
    try {
      expect((await beat([{ serialNo: 'HB-0001', firmwareVersion: '1.0.0' }])).status).toBe(200);
    } finally {
      log.stop();
    }
    expect(log.queries).toEqual([]);
    expect((await t.http().get('/terminals/HB-0001/history')).body.at(-1).toStatus).toBe('IN_SERVICE');
  });

  it('묶음 모양이 틀리면 400(빈 배열, 500개 초과, 배열 아님, 객체가 아닌 항목, 모르는 필드)', async () => {
    expect((await beat([])).status).toBe(400);
    expect((await beat(Array.from({ length: 501 }, () => ({ serialNo: 'HB-0001', firmwareVersion: '1' })))).status).toBe(400);
    expect((await t.http().post('/devices/heartbeats').send({ items: 'x' })).status).toBe(400);
    expect((await beat(['HB-0001'])).status).toBe(400);
    expect((await t.http().post('/devices/heartbeats').send({ items: [{}], extra: 1 })).status).toBe(400);
  });
});
