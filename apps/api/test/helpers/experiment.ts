import { Shipment, ShipmentStatus, SyncRun } from '../../src/shipment/shipment.entities.js';
import { prepareShipped } from './scenario.js';
import type { TestApp } from './test-app.js';

/** 실험용 출고 N건을 만든다(시리얼: <prefix>-0001 …). */
export async function prepareMany(t: TestApp, prefix: string, n: number, carrier: 'BUNGAE' | 'NEURIMBO') {
  const shipments = [];
  for (let i = 1; i <= n; i++) shipments.push(await prepareShipped(t, `${prefix}-${String(i).padStart(4, '0')}`, carrier));
  return shipments;
}

export function countInTransit(t: TestApp): Promise<number> {
  return t.orm.em.fork().count(Shipment, { status: ShipmentStatus.IN_TRANSIT });
}

/** 단말기 하나에 DELIVERED 이력이 가장 많이 붙은 수. 1이어야 중복 반영이 없는 것이다. */
export async function maxDeliveredPerTerminal(t: TestApp): Promise<number> {
  const rows: { m: number | string | null }[] = await t.orm.em
    .fork()
    .execute(
      "select max(c) as m from (select count(*) as c from terminal_status_history where to_status = 'DELIVERED' group by terminal_id) x",
    );
  return Number(rows[0]?.m ?? 0);
}

/** SyncRun 합계(실험 기록용) */
export async function syncRunTotals(t: TestApp) {
  const runs = await t.orm.em.fork().find(SyncRun, {});
  const sum = (f: (r: SyncRun) => number) => runs.reduce((acc, r) => acc + f(r), 0);
  const byOutcome: Record<string, number> = {};
  const byWorker: Record<string, number> = {};
  for (const r of runs) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    byWorker[r.worker] = (byWorker[r.worker] ?? 0) + 1;
  }
  return {
    runs: runs.length,
    fetched: sum((r) => r.fetched),
    inserted: sum((r) => r.inserted),
    duplicated: sum((r) => r.duplicated),
    maxAttempt: runs.reduce((m, r) => Math.max(m, r.attempt), 0),
    exhausted: runs.filter((r) => r.outcome === 'ERROR' && r.attempt >= 5).length,
    byOutcome,
    byWorker,
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
