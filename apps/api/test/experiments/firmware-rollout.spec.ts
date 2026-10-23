import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../../src/device/active-set.service.js';
import { deviceKeys } from '../../src/device/device-keys.js';
import { OfferStore } from '../../src/device/offer-store.js';
import { FirmwareRollout, FirmwareRolloutTarget, TargetStatus } from '../../src/firmware/firmware.entities.js';
import { RolloutService, type ControlAction } from '../../src/firmware/rollout.service.js';
import { REDIS } from '../../src/redis/redis.provider.js';
import { seedInService, serialsOf } from '../helpers/device-fleet.js';
import { startDeviceSim, type DeviceSim } from '../helpers/device-sim.js';
import { deleteTestKeys } from '../helpers/redis-keys.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

// experiments/0009. 실행: EXPERIMENTS=1 npx vitest run test/experiments/firmware-rollout.spec.ts --silent=false
// 단말기별 결과는 (시드, 시리얼, 배포 id, 버전)의 결정적 함수다(decisions/0009). DB를 매번 새로 만들어 배포 id가 1, 2로 같으므로
// 같은 시드로 다시 돌리면 실패하는 단말기 집합이 같아야 한다(실패 시리얼 지문으로 확인).
const N = Number(process.env.EXP_N ?? 1000);
const INTERVAL = Number(process.env.EXP_INTERVAL_MS ?? 1000);
const UPDATE_DELAY = Number(process.env.EXP_UPDATE_DELAY_MS ?? 300);
const UPDATE_JITTER = Number(process.env.EXP_UPDATE_JITTER_MS ?? 2000);
const CONTROL_EVERY = Number(process.env.EXP_CONTROL_MS ?? 500);
const STAGES = (process.env.EXP_STAGES ?? '10,50,100').split(',').map(Number);
const THRESHOLD = Number(process.env.EXP_THRESHOLD ?? 0.2);
const MIN_SAMPLES = Number(process.env.EXP_MIN_SAMPLES ?? 20);
const STAGE_TIMEOUT = Number(process.env.EXP_STAGE_TIMEOUT_MS ?? 30_000);
const FAIL_RATES = (process.env.EXP_FAIL_RATES ?? '0,0.3').split(',').map(Number);
const OP = { 'X-Operator': 'exp9' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe(`실험 0009: 펌웨어 단계 배포 ${N}대 — 단계 ${STAGES.join('→')}%, 기준 실패율 ${THRESHOLD * 100}%`, () => {
  let t: TestApp;
  let redis: Redis;
  let sim: DeviceSim;
  let apiUrl: string;
  let rollouts: RolloutService;
  let round = 0;

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    rollouts = t.app.get(RolloutService);
    await resetDatabase(t.orm);
    await seedInService(t, 'RO', N);
    await deleteTestKeys(redis, 'hb:');
    await t.app.get(ActiveSetService).rebuild();
    await t.app.listen(0, '127.0.0.1');
    apiUrl = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
    sim = await startDeviceSim();
  }, 120_000);
  afterAll(async () => {
    await sim?.close();
    await deleteTestKeys(redis);
    await t.app.close();
  });

  for (const failRate of FAIL_RATES) {
    it(`실패율 ${failRate * 100}%`, async () => {
      round += 1;
      const version = `9.0.${round}`;
      await redis.del(deviceKeys().offers);
      await sim.reset();
      await sim.configure({
        targetUrl: apiUrl,
        serialPrefix: 'RO',
        count: N,
        intervalMs: INTERVAL,
        batchSize: 100,
        concurrency: 8,
        updateDelayMs: UPDATE_DELAY,
        updateJitterMs: UPDATE_JITTER,
        firmwareFailRate: failRate,
        seed: 42 + round,
      });
      await sim.start();
      await t.http().post('/firmware').set(OP).send({ modelCode: 'SN-100', version });

      const started = Date.now();
      const created = await t
        .http()
        .post('/firmware-rollouts')
        .set(OP)
        .send({ modelCode: 'SN-100', version, stages: STAGES, failureThreshold: THRESHOLD, minSamples: MIN_SAMPLES, stageTimeoutMs: STAGE_TIMEOUT });
      expect(created.status).toBe(201);
      const id = created.body.id as number;

      // 판단 job을 CONTROL_EVERY마다 돌리며 단계가 바뀐 시각을 적는다
      const timeline: { at: number; action: ControlAction; stage: number; timedOut: number }[] = [];
      // 판단마다 그 단계의 결과 수(실패/결과)를 적는다 — 기준을 넘은 판단이 몇 번째였는지 본다(판단 직후 읽은 값이라 판단 시점보다 조금 많을 수 있다)
      const trace: string[] = [];
      let final: ControlAction = 'WAITING';
      const deadline = started + STAGE_TIMEOUT * STAGES.length + 60_000;
      while (Date.now() < deadline) {
        await sleep(CONTROL_EVERY);
        const r = await rollouts.control(id);
        const st = (await t.http().get(`/firmware-rollouts/${id}`)).body.stageStats[r.stage] as { failed: number; succeeded: number; timedOut: number };
        trace.push(`${Date.now() - started}:${r.stage}:${st.failed + st.timedOut}/${st.succeeded + st.failed + st.timedOut}`);
        if (r.action !== 'WAITING') timeline.push({ at: Date.now() - started, action: r.action, stage: r.stage, timedOut: r.timedOut });
        if (r.action === 'COMPLETED' || r.action === 'ABORTED') {
          final = r.action;
          break;
        }
      }
      const endedAt = Date.now() - started;
      await sleep(100); // 끝나기 직전에 offers를 읽은 하트비트 응답이 도착할 틈
      const offersAtEnd = await t.app.get(OfferStore).count();
      const simAtEnd = await sim.stats();
      const endStats = (await t.http().get(`/firmware-rollouts/${id}`)).body.stageStats as { stage: number; targets: number; succeeded: number; failed: number }[];

      // 끝난 뒤 업데이트 중이던 단말기가 보고를 마칠 시간을 준다(영향 범위의 최종값). 그동안 새 지시가 생기면 안 된다.
      await sleep(UPDATE_DELAY + UPDATE_JITTER + INTERVAL * 2);
      const simAfter = await sim.stats();
      await sim.stop();
      const em = t.orm.em.fork();
      const rollout = await em.findOneOrFail(FirmwareRollout, id);
      const count = (status: TargetStatus) => em.count(FirmwareRolloutTarget, { rollout: id, status });
      const targets = await em.count(FirmwareRolloutTarget, { rollout: id });
      const [succeeded, failed, timedOut, offered] = await Promise.all([
        count(TargetStatus.SUCCEEDED),
        count(TargetStatus.FAILED),
        count(TargetStatus.TIMED_OUT),
        count(TargetStatus.OFFERED),
      ]);
      const stats = (await t.http().get(`/firmware-rollouts/${id}`)).body.stageStats;
      // 하트비트 응답이 정말 update를 싣지 않는지 직접 묻는다(처음 버전 1.0.0으로 모든 단말기)
      // (API는 한 요청에 500개까지 받는다)
      let probeUpdates = 0;
      const all = serialsOf('RO', N);
      for (let i = 0; i < all.length; i += 500) {
        const probe = await t
          .http()
          .post('/devices/heartbeats')
          .send({ items: all.slice(i, i + 500).map((serialNo) => ({ serialNo, firmwareVersion: '1.0.0' })) });
        expect(probe.status).toBeLessThan(300);
        probeUpdates += (probe.body.results as { update?: unknown }[]).filter((r) => r.update).length;
      }
      const failedSerials = (await em.find(FirmwareRolloutTarget, { rollout: id, status: TargetStatus.FAILED }, { populate: ['terminal'] }))
        .map((r) => r.terminal.serialNo)
        .sort();
      const fingerprint = createHash('sha1').update(failedSerials.join(',')).digest('hex').slice(0, 10);
      const pick = (s: { stage: number; targets: number; succeeded: number; failed: number }[]) => JSON.stringify(s.map((x) => [x.stage, x.targets, x.succeeded, x.failed]));

      console.log(
        `[실험 0009/fail${failRate * 100}] N=${N} 결과=${final} 끝난시각=${endedAt}ms 이유=${rollout.endReason} ` +
          `타임라인=${JSON.stringify(timeline)} 판단(ms:단계:실패/결과)=${trace.join(' ')}`,
      );
      console.log(
        `[실험 0009/fail${failRate * 100}] 대상=${targets} 성공=${succeeded} 실패=${failed} 시간초과=${timedOut} 보고없음=${offered} ` +
          `끝날때제안=${offersAtEnd} 지시받음(끝날때→뒤)=${simAtEnd.updateOffers}→${simAfter.updateOffers} ` +
          `보고(성공/실패)=${simAfter.reportsSucceeded}/${simAfter.reportsFailed} 보고오류=${simAfter.reportErrors} 하트비트오류=${simAfter.errors} ` +
          `단계별(끝날때→뒤)=${pick(endStats)}→${pick(stats)}`,
      );
      console.log(
        `[실험 0009/fail${failRate * 100}] 배포id=${id} 시드=${42 + round} 뒤직접하트비트update=${probeUpdates}/${N} 실패시리얼지문=${fingerprint}(${failedSerials.length}) ` +
          `끝날때시뮬(지시/성공/실패)=${simAtEnd.updateOffers}/${simAtEnd.reportsSucceeded}/${simAtEnd.reportsFailed}`,
      );

      expect(offersAtEnd).toBe(0);
      expect(probeUpdates).toBe(0);
      expect(simAfter.updateOffers).toBe(simAtEnd.updateOffers); // 끝난 뒤 새 지시 없음
      expect(simAfter.errors + simAfter.reportErrors).toBe(0);
      if (failRate === 0) {
        expect(final).toBe('COMPLETED');
        expect(succeeded).toBe(N);
      } else {
        expect(final).toBe('ABORTED');
        expect(targets).toBeLessThan(N);
      }
    }, STAGE_TIMEOUT * STAGES.length + 120_000);
  }
});