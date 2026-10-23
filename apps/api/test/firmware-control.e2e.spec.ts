import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LockMode } from '@mikro-orm/mysql';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../src/device/active-set.service.js';
import { deviceKeys } from '../src/device/device-keys.js';
import { OfferStore } from '../src/device/offer-store.js';
import { FirmwareRollout, FirmwareRolloutTarget, RolloutStatus, TargetStatus } from '../src/firmware/firmware.entities.js';
import { RolloutService } from '../src/firmware/rollout.service.js';
import { OutboxEvent } from '../src/outbox/outbox-event.entity.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { rolloutOrder, seedInService } from './helpers/device-fleet.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'han' };

describe('펌웨어 결과 보고와 배포 판단 — 단계 넘기기·자동 중단·시간 초과 (F8, decisions/0031)', () => {
  let t: TestApp;
  let redis: Redis;
  let rollouts: RolloutService;
  let serials: string[];
  let version = 0;
  const em = () => t.orm.em.fork();
  const offers = () => redis.hgetall(deviceKeys().offers);
  const report = (serialNo: string, rolloutId: number, success: boolean, v = 'x') =>
    t.http().post('/devices/firmware-reports').send({ serialNo, rolloutId, success, version: v });
  /** 새 버전을 등록하고 배포를 시작한다 */
  async function start(body: Record<string, unknown>) {
    version += 1;
    const v = `3.0.${version}`;
    await t.http().post('/firmware').set(OP).send({ modelCode: 'SN-100', version: v });
    const res = await t.http().post('/firmware-rollouts').set(OP).send({ modelCode: 'SN-100', version: v, failureThreshold: 0.2, minSamples: 3, ...body });
    expect(res.status).toBe(201);
    return { id: res.body.id as number, version: v };
  }
  /** 지금 제안이 걸린 단말기들이 보고한다. fail(시리얼)이 참이면 실패 */
  async function reportOffered(rolloutId: number, v: string, fail: (serialNo: string) => boolean = () => false) {
    const offered = Object.keys(await offers());
    for (const s of offered) expect((await report(s, rolloutId, !fail(s), v)).status).toBe(200);
    return offered;
  }

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    rollouts = t.app.get(RolloutService);
    await resetDatabase(t.orm);
    serials = await seedInService(t, 'FC', 20);
    await deleteTestKeys(redis, 'hb:');
    await t.app.get(ActiveSetService).rebuild();
  });
  beforeEach(async () => {
    await em().nativeUpdate(FirmwareRollout, { status: { $in: [RolloutStatus.RUNNING, RolloutStatus.PAUSED] } }, { status: RolloutStatus.ABORTED });
    await redis.del(deviceKeys().offers, deviceKeys().firmware);
  });
  afterAll(async () => {
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('보고: 대상 행만 SUCCEEDED로, 제안을 내리고 Redis 펌웨어를 바꾼다. 다시 보고해도 그대로(멱등). 대상이 아니면 404', async () => {
    const { id, version: v } = await start({ stages: [10, 100] });
    const [first] = rolloutOrder(serials);
    const ok = await report(first, id, true, v);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ serialNo: first, rolloutId: id, status: 'SUCCEEDED', alreadyReported: false });
    expect((await offers())[first]).toBeUndefined();
    expect(await redis.hget(deviceKeys().firmware, first)).toBe(v);
    const target = await em().findOneOrFail(FirmwareRolloutTarget, { rollout: id, terminal: { serialNo: first } });
    expect(target).toMatchObject({ status: TargetStatus.SUCCEEDED, reportedVersion: v });
    expect(target.reportedAt).toBeInstanceOf(Date);

    const again = await report(first, id, false, v);
    expect(again.body).toEqual({ serialNo: first, rolloutId: id, status: 'SUCCEEDED', alreadyReported: true });
    const notTarget = rolloutOrder(serials).at(-1)!;
    expect((await report(notTarget, id, true, v)).status).toBe(404);
    expect((await t.http().post('/devices/firmware-reports').send({ serialNo: first, rolloutId: id, success: 'yes', version: v })).status).toBe(400);
  });

  it('모두 성공하면 단계를 넘기고(누적 비율만큼 대상 추가·알림), 마지막 단계가 끝나면 COMPLETED', async () => {
    const { id, version: v } = await start({ stages: [10, 50, 100] });
    expect((await rollouts.control(id)).action).toBe('WAITING'); // 아직 보고 없음
    expect(await reportOffered(id, v)).toHaveLength(2);

    expect(await rollouts.control(id)).toEqual({ rolloutId: id, action: 'ADVANCED', stage: 1, timedOut: 0 });
    expect(Object.keys(await offers())).toHaveLength(8); // 50% = 10대, 이미 2대
    expect(Object.keys(await offers()).sort()).toEqual(rolloutOrder(serials).slice(2, 10).sort());
    await reportOffered(id, v);
    expect((await rollouts.control(id)).action).toBe('ADVANCED');
    await reportOffered(id, v);
    expect((await rollouts.control(id)).action).toBe('COMPLETED');

    const view = (await t.http().get(`/firmware-rollouts/${id}`)).body;
    expect(view).toMatchObject({ status: 'COMPLETED', currentStage: 2, endReason: '마지막 단계 완료' });
    expect(view.stageStats.map((s: { targets: number; succeeded: number }) => [s.targets, s.succeeded])).toEqual([
      [2, 2],
      [8, 8],
      [10, 10],
    ]);
    expect(await offers()).toEqual({});
    const types = (await em().find(OutboxEvent, { type: { $like: 'firmware.%' }, payload: { rolloutId: id } }, { orderBy: { id: 'asc' } })).map((e) => e.type);
    expect(types).toEqual(['firmware.stage_advanced', 'firmware.stage_advanced', 'firmware.rollout_completed']);
    expect((await rollouts.control(id)).action).toBe('NONE');
  });

  it('실패율이 기준을 넘고 결과가 minSamples 이상이면 자동 중단: 남은 제안을 모두 내린다', async () => {
    const { id, version: v } = await start({ stages: [50, 100], failureThreshold: 0.2, minSamples: 3 });
    const offered = Object.keys(await offers());
    expect(offered).toHaveLength(10);
    // 2건 실패: 결과 2 < minSamples 3이라 아직 기다린다
    await report(offered[0], id, false, v);
    await report(offered[1], id, false, v);
    expect((await rollouts.control(id)).action).toBe('WAITING');
    await report(offered[2], id, true, v);
    const r = await rollouts.control(id);
    expect(r.action).toBe('ABORTED');

    const rollout = await em().findOneOrFail(FirmwareRollout, id);
    expect(rollout.status).toBe(RolloutStatus.ABORTED);
    expect(rollout.endReason).toBe('자동 중단: 1단계 실패율 66.7% (2/3) > 기준 20%');
    expect(await offers()).toEqual({}); // 보고하지 않은 7대의 제안도 내림
    const beat = await t.http().post('/devices/heartbeats').send({ items: [{ serialNo: offered[5], firmwareVersion: '1.0.0' }] });
    expect(beat.body.results[0].update).toBeUndefined();
    expect((await em().find(OutboxEvent, { type: 'firmware.rollout_aborted', payload: { rolloutId: id } })).length).toBe(1);
  });

  it('제한 시간 안에 보고가 없으면 TIMED_OUT(실패로 셈)으로 바꾸고 그 제안을 내린다', async () => {
    const { id } = await start({ stages: [10, 100], failureThreshold: 1, stageTimeoutMs: 1_000 });
    const offered = Object.keys(await offers());
    expect((await rollouts.control(id, new Date(Date.now() + 500))).action).toBe('WAITING');
    const r = await rollouts.control(id, new Date(Date.now() + 2_000));
    expect(r).toEqual({ rolloutId: id, action: 'ADVANCED', stage: 1, timedOut: 2 }); // 기준 100%라 중단하지 않고 넘어간다
    const timedOut = await em().find(FirmwareRolloutTarget, { rollout: id, status: TargetStatus.TIMED_OUT }, { populate: ['terminal'] });
    expect(timedOut.map((x) => x.terminal.serialNo).sort()).toEqual([...offered].sort());
    const now = Object.keys(await offers());
    expect(now).toHaveLength(18);
    expect(now.some((s) => offered.includes(s))).toBe(false);
  });

  it('보고는 배포 행을 잠그지 않는다: 배포 행 FOR UPDATE를 쥔 트랜잭션이 있어도 바로 끝난다', async () => {
    const { id, version: v } = await start({ stages: [10, 100] });
    const [first] = Object.keys(await offers());
    const holder = t.orm.em.fork();
    await holder.begin();
    try {
      await holder.findOneOrFail(FirmwareRollout, id, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const started = Date.now();
      const res = await report(first, id, true, v);
      const ms = Date.now() - started;
      console.log(`[보고 중 배포 행 잠금] ${res.status} ${ms}ms`);
      expect(res.status).toBe(200);
      expect(ms).toBeLessThan(1_000);
    } finally {
      await holder.rollback();
    }
  });

  it('멈춘 배포는 판단하지 않는다(NONE), controlAll은 RUNNING만 돈다', async () => {
    const { id } = await start({ stages: [10, 100] });
    await t.http().post(`/firmware-rollouts/${id}/pause`).set(OP);
    expect((await rollouts.control(id)).action).toBe('NONE');
    expect((await rollouts.controlAll()).map((r) => r.rolloutId)).not.toContain(id);
  });

  describe('제안 맞추기(Task 6 리뷰): 판단 job이 Redis 제안을 MySQL(OFFERED)에 다시 맞춘다', () => {
    it('진행 중 배포: Redis에서 사라진 제안(커밋 뒤 걸기 전에 죽음 등)을 다음 판단이 다시 건다', async () => {
      const { id, version: v } = await start({ stages: [10, 100] });
      const [lost, kept] = Object.keys(await offers());
      await redis.hdel(deviceKeys().offers, lost);
      expect((await rollouts.controlAll()).find((r) => r.rolloutId === id)?.action).toBe('WAITING');
      const now = await offers();
      expect(JSON.parse(now[lost])).toEqual({ rolloutId: id, version: v });
      expect(JSON.parse(now[kept])).toEqual({ rolloutId: id, version: v });
    });

    it('끝났거나 멈춘 배포·없는 배포의 제안이 남아 있으면 판단 job이 내린다(배포 id 비교)', async () => {
      const aborted = await start({ stages: [10, 100] });
      const pausedOne = Object.keys(await offers())[0];
      expect((await t.http().post(`/firmware-rollouts/${aborted.id}/abort`).set(OP)).status).toBe(200);
      const running = await start({ stages: [10, 100] });
      await t.http().post(`/firmware-rollouts/${running.id}/pause`).set(OP);
      const order = rolloutOrder(serials);
      // 커밋 뒤 Redis 작업이 늦게 도착해 남은 제안을 흉내 낸다
      await redis.hset(deviceKeys().offers, {
        [order[15]]: JSON.stringify({ rolloutId: aborted.id, version: aborted.version }),
        [order[16]]: JSON.stringify({ rolloutId: running.id, version: running.version }),
        [order[17]]: JSON.stringify({ rolloutId: 99_999, version: '9.9.9' }),
        [pausedOne]: JSON.stringify({ rolloutId: running.id, version: running.version }),
      });
      await rollouts.controlAll();
      expect(await offers()).toEqual({});
    });
  });

  it('운영에서 빠진 단말기(IN_SERVICE 아님)는 시간 초과·실패율에서 뺀다: OFFERED로 남기고 제안만 내린다', async () => {
    const { id, version: v } = await start({ stages: [10, 100], failureThreshold: 0.2, minSamples: 1, stageTimeoutMs: 1_000 });
    const [ok, gone] = Object.keys(await offers());
    expect((await report(ok, id, true, v)).status).toBe(200);
    await em().nativeUpdate(Terminal, { serialNo: gone }, { status: TerminalStatus.RETURN_REQUESTED });
    try {
      // 빼지 않으면 gone이 TIMED_OUT → 실패율 1/2 = 50% > 20%, 결과 2 ≥ minSamples 1 → ABORTED
      expect(await rollouts.control(id, new Date(Date.now() + 2_000))).toEqual({ rolloutId: id, action: 'ADVANCED', stage: 1, timedOut: 0 });
      const target = await em().findOneOrFail(FirmwareRolloutTarget, { rollout: id, terminal: { serialNo: gone } });
      expect(target.status).toBe(TargetStatus.OFFERED);
      const now = Object.keys(await offers());
      expect(now).not.toContain(gone);
      expect(now).toHaveLength(18);
    } finally {
      await em().nativeUpdate(Terminal, { serialNo: gone }, { status: TerminalStatus.IN_SERVICE });
    }
  });

  describe('판단과 보고의 경합(Task 7 리뷰 fix, troubleshooting/0019)', () => {
    /** em.nativeUpdate를 가로챈다(모든 fork가 같은 prototype을 쓴다). before가 참을 돌려주면 원래 UPDATE 전에 race를 한 번 끼운다 */
    function interceptNativeUpdate(when: (data: Record<string, unknown>) => boolean, race: () => Promise<void>) {
      const proto = Object.getPrototypeOf(t.orm.em) as { nativeUpdate: (...args: unknown[]) => Promise<number> };
      const original = proto.nativeUpdate;
      let done = false;
      return vi.spyOn(proto, 'nativeUpdate').mockImplementation(async function (this: unknown, ...args: unknown[]) {
        if (!done && when(args[2] as Record<string, unknown>)) {
          done = true;
          await race();
        }
        return original.apply(this, args);
      });
    }

    it('스냅숏 뒤·TIMED_OUT 갱신 전에 커밋된 FAILED 보고를 놓치지 않는다: 이번 주기는 WAITING, 다음 주기가 센다', async () => {
      const { id, version: v } = await start({ stages: [15, 100], failureThreshold: 0.2, minSamples: 3, stageTimeoutMs: 1_000 });
      const [a, b, c] = Object.keys(await offers());
      expect(Object.keys(await offers())).toHaveLength(3);
      await report(a, id, true, v);
      await report(b, id, true, v);
      // c는 제한 시간이 지났다. 판단이 c를 OFFERED로 읽은 뒤(스냅숏), TIMED_OUT으로 바꾸기 직전에 c의 실패 보고가 커밋된다
      const spy = interceptNativeUpdate(
        (data) => data.status === TargetStatus.TIMED_OUT,
        async () => {
          expect((await report(c, id, false, v)).status).toBe(200);
        },
      );
      let first;
      try {
        first = await rollouts.control(id, new Date(Date.now() + 2_000));
      } finally {
        spy.mockRestore();
      }
      // 고치기 전: TIMED_OUT 갱신은 0행(이미 FAILED), 통계(스냅숏)는 c를 OFFERED로 봐 실패 0/2 → 남은 대상 없음 → ADVANCED
      expect(first).toEqual({ rolloutId: id, action: 'WAITING', stage: 0, timedOut: 0 });
      const target = await em().findOneOrFail(FirmwareRolloutTarget, { rollout: id, terminal: { serialNo: c } });
      expect(target.status).toBe(TargetStatus.FAILED);
      expect((await rollouts.control(id, new Date(Date.now() + 2_000))).action).toBe('ABORTED');
      expect((await em().findOneOrFail(FirmwareRollout, id)).endReason).toBe('자동 중단: 1단계 실패율 33.3% (1/3) > 기준 20%');
    });

    it('스냅숏 뒤에 보고가 커밋되고 제안을 내려도, 판단의 다시 걸기 뒤 확인이 그 제안을 다시 내린다(실패한 버전을 다시 권하지 않음)', async () => {
      const { id, version: v } = await start({ stages: [10, 100] });
      const [x, y] = Object.keys(await offers());
      const store = t.app.get(OfferStore);
      const original = store.publish.bind(store);
      // 판단이 커밋한 뒤, 다시 걸기(publish)가 Redis에 닿기 전에 x의 실패 보고가 커밋하고 제안을 내린다
      const spy = vi.spyOn(store, 'publish').mockImplementationOnce(async (serials, offer) => {
        expect((await report(x, id, false, v)).status).toBe(200);
        return original(serials, offer);
      });
      try {
        expect((await rollouts.control(id)).action).toBe('WAITING');
      } finally {
        spy.mockRestore();
      }
      const now = await offers();
      expect(now[x]).toBeUndefined(); // 고치기 전: 다시 걸려 FAILED 단말기가 같은 버전을 또 받는다
      expect(JSON.parse(now[y])).toEqual({ rolloutId: id, version: v });
    });

    it('보고의 UPDATE가 0행이면 지금 상태를 다시 읽어 돌려준다(OFFERED + alreadyReported 조합을 내지 않음)', async () => {
      const { id, version: v } = await start({ stages: [10, 100] });
      const [x] = Object.keys(await offers());
      // 첫 보고가 대상을 OFFERED로 읽은 뒤, UPDATE 직전에 같은 단말기의 다른 보고(재전송)가 먼저 커밋된다
      const spy = interceptNativeUpdate(
        (data) => data.status === TargetStatus.FAILED,
        async () => {
          expect((await report(x, id, true, v)).body.status).toBe('SUCCEEDED');
        },
      );
      let res;
      try {
        res = await report(x, id, false, v);
      } finally {
        spy.mockRestore();
      }
      expect(res.body).toEqual({ serialNo: x, rolloutId: id, status: 'SUCCEEDED', alreadyReported: true });
    });

    it('하트비트가 이미 제안 버전이면 update를 싣지 않는다', async () => {
      const { version: v } = await start({ stages: [10, 100] });
      const [x, y] = Object.keys(await offers());
      const res = await t
        .http()
        .post('/devices/heartbeats')
        .send({ items: [{ serialNo: x, firmwareVersion: v }, { serialNo: y, firmwareVersion: '1.0.0' }] });
      expect(res.body.results[0].update).toBeUndefined();
      expect(res.body.results[1].update).toMatchObject({ version: v });
    });

    it('controlAll: 한 배포의 판단이 실패해도 결과 ERROR로 남기고 다음 일(제안 맞추기)을 한다', async () => {
      const { id } = await start({ stages: [10, 100] });
      const stray = rolloutOrder(serials)[19];
      await redis.hset(deviceKeys().offers, stray, JSON.stringify({ rolloutId: 99_999, version: '9.9.9' }));
      const spy = vi.spyOn(rollouts, 'control').mockRejectedValueOnce(new Error('일부러 낸 오류'));
      let results;
      try {
        results = await rollouts.controlAll();
      } finally {
        spy.mockRestore();
      }
      expect(results.find((r) => r.rolloutId === id)).toEqual({ rolloutId: id, action: 'ERROR', stage: -1, timedOut: 0, error: '일부러 낸 오류' });
      expect((await offers())[stray]).toBeUndefined();
    });

    it('controlAll: 제안 맞추기(finally)가 실패해도 판단 결과를 돌려주고 오류는 로그로만 남긴다', async () => {
      const { id } = await start({ stages: [10, 100] });
      const withdraw = vi.spyOn(rollouts, 'withdrawStaleOffers').mockRejectedValueOnce(new Error('맞추기 오류'));
      const logged = vi.spyOn((rollouts as unknown as { logger: { error: (...a: unknown[]) => void } }).logger, 'error').mockImplementation(() => undefined);
      let results;
      let messages: string[] = [];
      try {
        results = await rollouts.controlAll();
        messages = logged.mock.calls.map((c) => String(c[0]));
      } finally {
        withdraw.mockRestore();
        logged.mockRestore();
      }
      expect(results.find((r) => r.rolloutId === id)?.action).toBe('WAITING');
      expect(messages.join(' | ')).toContain('맞추기 오류');
    });

    it('Redis 제안 값이 깨져 있으면 byRollout은 그 값을 건너뛴다(맞추기 전체가 멈추지 않음)', async () => {
      const { id } = await start({ stages: [10, 100] });
      const stray = rolloutOrder(serials)[19];
      await redis.hset(deviceKeys().offers, stray, '{oops');
      const map = await t.app.get(OfferStore).byRollout();
      expect([...map.keys()]).toEqual([id]);
      expect(map.get(id)).toHaveLength(2);
      await redis.hdel(deviceKeys().offers, stray);
    });
  });

  describe('최종 리뷰 fix(troubleshooting/0021): 이미 목표 버전인 대상, 제안 내리기의 깨진 값, 끝난 시각', () => {
    it('하트비트로 이미 목표 버전을 보낸 대상은 제한 시간이 지나면 관측으로 SUCCEEDED(시간 초과·실패로 세지 않음)', async () => {
      const { id, version: v } = await start({ stages: [10, 100], failureThreshold: 0.2, minSamples: 1, stageTimeoutMs: 1_000 });
      const [same, other] = Object.keys(await offers());
      // same은 이미 v를 돌리고 있다(같은 버전 재배포, 설치 뒤 보고 유실 등): 하트비트 응답에 update가 없고 단말기는 보고하지 않는다
      const beat = await t.http().post('/devices/heartbeats').send({ items: [{ serialNo: same, firmwareVersion: v }] });
      expect(beat.body.results[0].update).toBeUndefined();
      expect((await report(other, id, true, v)).status).toBe(200);
      const now = new Date(Date.now() + 2_000);
      // 고치기 전: same이 TIMED_OUT → 실패율 1/2 = 50% > 20%, 결과 2 ≥ minSamples 1 → ABORTED
      expect(await rollouts.control(id, now)).toEqual({ rolloutId: id, action: 'ADVANCED', stage: 1, timedOut: 0 });
      const target = await em().findOneOrFail(FirmwareRolloutTarget, { rollout: id, terminal: { serialNo: same } });
      expect(target).toMatchObject({ status: TargetStatus.SUCCEEDED, reportedVersion: v });
      expect(target.reportedAt?.getTime()).toBe(now.getTime());
      expect((await offers())[same]).toBeUndefined();
      const stats = (await t.http().get(`/firmware-rollouts/${id}`)).body.stageStats[0];
      expect(stats).toMatchObject({ targets: 2, succeeded: 2, failed: 0, timedOut: 0 });
    });

    it('목표 버전이 아닌 하트비트를 보낸 대상은 그대로 TIMED_OUT', async () => {
      const { id, version: v } = await start({ stages: [10, 100], failureThreshold: 1, stageTimeoutMs: 1_000 });
      const [old, ok] = Object.keys(await offers());
      await t.http().post('/devices/heartbeats').send({ items: [{ serialNo: old, firmwareVersion: '1.0.0' }] });
      expect((await report(ok, id, true, v)).status).toBe(200);
      expect(await rollouts.control(id, new Date(Date.now() + 2_000))).toEqual({ rolloutId: id, action: 'ADVANCED', stage: 1, timedOut: 1 });
      const target = await em().findOneOrFail(FirmwareRolloutTarget, { rollout: id, terminal: { serialNo: old } });
      expect(target.status).toBe(TargetStatus.TIMED_OUT);
    });

    it('제안 내리기(Lua)는 깨진 값을 건너뛰고 나머지를 내린다(byRollout과 같은 규칙)', async () => {
      const { id } = await start({ stages: [10, 100] });
      const [x] = Object.keys(await offers());
      const stray = rolloutOrder(serials)[19];
      await redis.hset(deviceKeys().offers, stray, '{oops');
      try {
        expect(await t.app.get(OfferStore).withdraw(id, [stray, x])).toBe(1);
        const now = await offers();
        expect(now[x]).toBeUndefined();
        expect(now[stray]).toBe('{oops');
      } finally {
        await redis.hdel(deviceKeys().offers, stray);
      }
    });

    it('판단이 배포를 끝내면 finishedAt은 control(id, now)의 now다', async () => {
      const { id } = await start({ stages: [10, 100], failureThreshold: 0.2, minSamples: 1, stageTimeoutMs: 1_000 });
      const now = new Date(Math.ceil(Date.now() / 1000) * 1000 + 3_600_000); // finishedAt은 초 단위
      expect((await rollouts.control(id, now)).action).toBe('ABORTED');
      expect((await em().findOneOrFail(FirmwareRollout, id)).finishedAt?.getTime()).toBe(now.getTime());
    });
  });
});
