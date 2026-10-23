import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { ActiveSetService } from '../../src/device/active-set.service.js';
import { ConnectivityService } from '../../src/device/connectivity.service.js';
import { DeviceConnectivity } from '../../src/device/device-connectivity.entity.js';
import { deviceKeys } from '../../src/device/device-keys.js';
import { OutboxEvent, OutboxStatus } from '../../src/outbox/outbox-event.entity.js';
import { OutboxService } from '../../src/outbox/outbox.service.js';
import { REDIS } from '../../src/redis/redis.provider.js';
import { TerminalModel } from '../../src/terminal/terminal-model.entity.js';
import { Terminal } from '../../src/terminal/terminal.entity.js';
import { TerminalStatus } from '../../src/terminal/terminal-status.js';
import { deleteTestKeys } from '../helpers/redis-keys.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

/**
 * 실험 0010: device 큐 job(detect-offline, snapshot)이 단말기 수천 대에서 얼마나 걸리나.
 * device 큐는 concurrency 1이라, 이 시간 동안 project job(active 갱신)이 줄을 선다(head-of-line).
 * 재현: EXPERIMENTS=1 N=5000 npx vitest run test/experiments/device-jobs-timing.spec.ts --silent=false
 */
const N = Number(process.env.N ?? 5000);
const AFTER = 90_000;
const ROUNDS = 3;
/** relay 한 번에 잡는 행 수와 주기(운영 기본값: scheduler outbox-relay limit 100, RELAY_INTERVAL_MS 2초) */
const RELAY_LIMIT = 100;
const RELAY_INTERVAL_MS = 2_000;

async function time<T>(fn: () => Promise<T>): Promise<{ ms: number; res: T }> {
  const start = performance.now();
  const res = await fn();
  return { ms: Math.round((performance.now() - start) * 10) / 10, res };
}

describe(`실험 0010 — device 큐 job 시간 (단말기 ${N}대)`, () => {
  let t: TestApp;
  let redis: Redis;
  let conn: ConnectivityService;
  let serials: string[];
  const k = () => deviceKeys();

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    conn = t.app.get(ConnectivityService);
    await resetDatabase(t.orm);
    await deleteTestKeys(redis, 'hb:');
    const em = t.orm.em.fork();
    const model = await em.findOneOrFail(TerminalModel, { code: 'SN-100' });
    serials = Array.from({ length: N }, (_, i) => `TM-${String(i + 1).padStart(5, '0')}`);
    for (let i = 0; i < N; i += 1000) {
      await em.insertMany(
        Terminal,
        serials.slice(i, i + 1000).map((serialNo) => ({ serialNo, model: model.id, status: TerminalStatus.IN_SERVICE, version: 1, createdAt: new Date(), updatedAt: new Date() })),
      );
    }
    await t.app.get(ActiveSetService).rebuild();
  }, 120_000);
  afterAll(async () => {
    await deleteTestKeys(redis);
    await t.app.close();
  });

  it('detect·snapshot·project(apply 1대) 시간', async () => {
    const rows: string[] = [];
    for (let round = 1; round <= ROUNDS; round++) {
      await redis.del(k().lastSeen, k().firmware, k().offline, k().snapshotAt);
      await t.orm.em.fork().nativeDelete(DeviceConnectivity, {});
      await t.orm.em.fork().nativeDelete(OutboxEvent, {});
      const now = Date.now();
      const zadd = (score: number) => serials.flatMap((s) => [score, s]);

      // ① 평소: 모두 최근 하트비트(바뀐 것 없음)
      await redis.zadd(k().lastSeen, ...zadd(now - 1_000));
      await redis.hset(k().firmware, Object.fromEntries(serials.map((s) => [s, '1.0.0'])));
      const fresh = await time(() => conn.detect(now, AFTER));
      // ② 스냅샷: N대 모두 바뀜(첫 스냅샷)
      const snap = await time(() => conn.snapshot());
      // ③ 대량 끊김: N대 모두 기준보다 오래됨 → UPSERT N행 + Outbox N행
      await redis.zadd(k().lastSeen, ...zadd(now - 120_000));
      const massOff = await time(() => conn.detect(now, AFTER));
      // ③' 대량 끊김이 남긴 Outbox 행 → relay 줄. 이 뒤에 들어온 행(예: terminal.status_changed)은 앞의 행을 다 relay할 때까지 기다린다.
      const pending = await t.orm.em.fork().count(OutboxEvent, { status: OutboxStatus.PENDING });
      const drain = await time(async () => {
        let calls = 0;
        while ((await t.app.get(OutboxService).relay(RELAY_LIMIT)).queued.length > 0) calls++;
        return calls;
      });
      // ④ 이미 모두 오프라인으로 기록된 뒤 다시 판정(바뀐 것 없음, SMEMBERS N개)
      const steady = await time(() => conn.detect(now + 1_000, AFTER));
      // ⑤ 대량 복귀: N대 모두 다시 하트비트
      await redis.zadd(k().lastSeen, ...zadd(now + 2_000));
      const massOn = await time(() => conn.detect(now + 3_000, AFTER));
      // 비교: project job 하나(apply 1대)
      const project = await time(() => t.app.get(ActiveSetService).apply([serials[0]]));

      expect(fresh.res).toEqual({ offline: [], online: [] });
      expect(snap.res).toEqual({ written: N });
      expect(massOff.res.offline).toHaveLength(N);
      expect(steady.res).toEqual({ offline: [], online: [] });
      expect(massOn.res.online).toHaveLength(N);
      rows.push(
        `| ${round} | ${fresh.ms} | ${snap.ms} | ${massOff.ms} | ${steady.ms} | ${massOn.ms} | ${project.ms} | ${pending} | ${drain.res} | ${drain.res * RELAY_INTERVAL_MS / 1000} | ${drain.ms} |`,
      );
    }
    console.log(
      [
        `[실험 0010] N=${N}`,
        '| 회차 | ① detect 평소(변화 0) | ② snapshot 전체 | ③ detect 대량 끊김 | ④ detect 이미 오프라인 | ⑤ detect 대량 복귀 | project 1대 | ③ Outbox 행 | relay 횟수(100행) | relay 줄 예상(초, ×2초) | relay 함수 시간 합 |',
        '|---|---|---|---|---|---|---|---|---|---|---|',
        ...rows,
      ].join('\n'),
    );
  }, 300_000);
});
