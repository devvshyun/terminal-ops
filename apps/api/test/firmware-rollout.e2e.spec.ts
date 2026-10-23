import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../src/device/active-set.service.js';
import { deviceKeys } from '../src/device/device-keys.js';
import { OfferStore } from '../src/device/offer-store.js';
import { FirmwareRollout, FirmwareRolloutTarget, RolloutStatus } from '../src/firmware/firmware.entities.js';
import { OutboxEvent } from '../src/outbox/outbox-event.entity.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { rolloutOrder, seedInService } from './helpers/device-fleet.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { SCENARIO_OP } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'han' };
const ROLLOUT = { modelCode: 'SN-100', version: '2.0.0', stages: [10, 50, 100], failureThreshold: 0.2, minSamples: 2 };

describe('펌웨어 등록·단계 배포 시작·멈춤·재개·중단 (F8, decisions/0030)', () => {
  let t: TestApp;
  let redis: Redis;
  let serials: string[];
  const em = () => t.orm.em.fork();
  const offers = () => redis.hgetall(deviceKeys().offers);
  const beat = (items: string[]) =>
    t.http().post('/devices/heartbeats').send({ items: items.map((serialNo) => ({ serialNo, firmwareVersion: '1.0.0' })) });
  const createRollout = (body: Record<string, unknown> = {}) => t.http().post('/firmware-rollouts').set(OP).send({ ...ROLLOUT, ...body });
  const targetsOf = async (rolloutId: number) =>
    (await em().find(FirmwareRolloutTarget, { rollout: rolloutId }, { populate: ['terminal'], orderBy: { id: 'asc' } })).map((x) => x.terminal.serialNo);

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    await resetDatabase(t.orm);
    serials = await seedInService(t, 'FW', 20);
    await t.http().post('/terminals').set(SCENARIO_OP).send({ serialNo: 'FW-9001', modelCode: 'SN-100' }); // RECEIVED: 대상 아님
    await deleteTestKeys(redis, 'hb:');
    await t.app.get(ActiveSetService).rebuild();
  });
  beforeEach(async () => {
    await em().nativeUpdate(FirmwareRollout, { status: { $in: [RolloutStatus.RUNNING, RolloutStatus.PAUSED] } }, { status: RolloutStatus.ABORTED });
    await redis.del(deviceKeys().offers);
  });
  afterAll(async () => {
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('펌웨어 등록: 201, 같은 (모델, 버전)은 409 DUPLICATE, 없는 모델 404, 작업자 헤더 필수', async () => {
    const res = await t.http().post('/firmware').set(OP).send({ modelCode: 'SN-100', version: '2.0.0' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ modelCode: 'SN-100', version: '2.0.0', createdBy: 'han' });
    expect((await t.http().post('/firmware').set(OP).send({ modelCode: 'SN-100', version: '2.0.0' })).body.code).toBe('DUPLICATE');
    expect((await t.http().post('/firmware').set(OP).send({ modelCode: 'NONE', version: '2.0.0' })).status).toBe(404);
    expect((await t.http().post('/firmware').send({ modelCode: 'SN-100', version: '2.0.1' })).status).toBe(400);
    expect((await t.http().post('/firmware').set(OP).send({ modelCode: 'SN-200', version: '2.0.0' })).status).toBe(201);
  });

  it('배포 시작: 첫 단계(10%) 대상을 CRC32(시리얼) 순으로 고르고, Redis에 제안을 건다', async () => {
    const res = await createRollout();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ modelCode: 'SN-100', version: '2.0.0', status: 'RUNNING', currentStage: 0, createdBy: 'han' });
    expect(res.body.stageStats[0]).toEqual({ stage: 0, percent: 10, targets: 2, offered: 2, succeeded: 0, failed: 0, timedOut: 0 });
    const picked = rolloutOrder(serials).slice(0, 2); // 운영 중 20대의 10% = 2대, RECEIVED 단말기는 빠진다
    expect(await targetsOf(res.body.id)).toEqual(picked);
    const offer = JSON.stringify({ rolloutId: res.body.id, version: '2.0.0' });
    expect(await offers()).toEqual(Object.fromEntries(picked.map((s) => [s, offer])));
  });

  it('하트비트 응답: 제안이 있는 단말기의 행에만 update', async () => {
    const { body: rollout } = await createRollout();
    const [target] = rolloutOrder(serials);
    const other = serials.find((s) => !rolloutOrder(serials).slice(0, 2).includes(s))!;
    const res = await beat([target, other]);
    expect(res.body.results).toEqual([
      { serialNo: target, result: 'OK', update: { rolloutId: rollout.id, version: '2.0.0' } },
      { serialNo: other, result: 'OK' },
    ]);
  });

  it('모델마다 진행 중 배포는 하나: 동시에 두 번 만들어도 하나만 201, 나머지 409 ROLLOUT_ALREADY_ACTIVE', async () => {
    const results = await Promise.all([createRollout().then((r) => r), createRollout().then((r) => r)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('ROLLOUT_ALREADY_ACTIVE');
    expect(await em().count(FirmwareRollout, { status: RolloutStatus.RUNNING })).toBe(1);
  });

  it('멈춤 → 제안 내림, 재개 → 다시 검, 중단 → 제안 내리고 ABORTED·Outbox 알림, 끝난 배포는 422', async () => {
    const { body: rollout } = await createRollout();
    const picked = rolloutOrder(serials).slice(0, 2);

    const paused = await t.http().post(`/firmware-rollouts/${rollout.id}/pause`).set(OP);
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('PAUSED');
    expect(await offers()).toEqual({});
    expect((await beat([picked[0]])).body.results[0].update).toBeUndefined();
    expect((await t.http().post(`/firmware-rollouts/${rollout.id}/pause`).set(OP)).body.code).toBe('ROLLOUT_NOT_RUNNING');

    const resumed = await t.http().post(`/firmware-rollouts/${rollout.id}/resume`).set(OP);
    expect(resumed.body.status).toBe('RUNNING');
    expect(Object.keys(await offers()).sort()).toEqual([...picked].sort());

    const aborted = await t.http().post(`/firmware-rollouts/${rollout.id}/abort`).set(OP);
    expect(aborted.body).toMatchObject({ status: 'ABORTED', endReason: '운영자 중단: han' });
    expect(aborted.body.finishedAt).toEqual(expect.any(String));
    expect(await offers()).toEqual({});
    const events = await em().find(OutboxEvent, { type: 'firmware.rollout_aborted' });
    expect(events.at(-1)?.payload).toMatchObject({ rolloutId: rollout.id, version: '2.0.0', reason: '운영자 중단: han' });
    const again = await t.http().post(`/firmware-rollouts/${rollout.id}/resume`).set(OP);
    expect([again.status, again.body.code]).toEqual([422, 'ROLLOUT_NOT_PAUSED']);
    expect((await t.http().post(`/firmware-rollouts/${rollout.id}/abort`).set(OP)).body.code).toBe('ROLLOUT_FINISHED');
  });

  it('중단된 배포의 제안 내리기는 다른 배포의 제안을 지우지 않는다', async () => {
    const store = t.app.get(OfferStore);
    await store.publish(['FW-0001'], { rolloutId: 999, version: '9.9.9' });
    expect(await store.withdraw(1, ['FW-0001'])).toBe(0);
    expect(await store.lookup(['FW-0001'])).toEqual([{ rolloutId: 999, version: '9.9.9' }]);
    expect(await store.withdraw(999, ['FW-0001'])).toBe(1);
  });

  it('입력 검사: 단계가 커지지 않거나 마지막이 100이 아니면 400 INVALID_STAGES, 등록 안 된 펌웨어 404, 없는 배포 404', async () => {
    expect((await createRollout({ stages: [50, 10, 100] })).body.code).toBe('INVALID_STAGES');
    expect((await createRollout({ stages: [10, 50] })).body.code).toBe('INVALID_STAGES');
    expect((await createRollout({ failureThreshold: 2 })).status).toBe(400);
    // 제한 시간은 하루까지(int 열 범위 안, Task 6 리뷰)
    expect((await createRollout({ stageTimeoutMs: 24 * 60 * 60_000 + 1 })).status).toBe(400);
    expect((await createRollout({ version: '3.0.0' })).status).toBe(404);
    expect((await t.http().get('/firmware-rollouts/99999')).status).toBe(404);
  });
});
