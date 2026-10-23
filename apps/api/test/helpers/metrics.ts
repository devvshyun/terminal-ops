import type { Redis } from 'ioredis';
import type { TestApp } from './test-app.js';

/** 실험에서 보는 MySQL 서버 전체 카운터. 앱 계정으로 읽을 수 있다(SHOW GLOBAL STATUS, PROCESS 권한 불필요) */
const MYSQL_COUNTERS = [
  'Com_insert',
  'Com_update',
  'Com_select',
  'Innodb_rows_inserted',
  'Innodb_rows_updated',
  'Innodb_row_lock_waits',
  'Innodb_os_log_written',
];

/** MySQL 서버 전체 카운터(다른 연결의 쿼리도 섞인다 — 실험 중에는 다른 작업을 돌리지 않는다) */
export async function mysqlCounters(t: TestApp): Promise<Record<string, number>> {
  const rows = await t.orm.em
    .fork()
    .execute<{ Variable_name: string; Value: string }[]>(
      `show global status where Variable_name in (${MYSQL_COUNTERS.map((c) => `'${c}'`).join(', ')})`,
    );
  return Object.fromEntries(rows.map((r) => [r.Variable_name, Number(r.Value)]));
}

/** Redis 명령별 누적 호출 수(INFO commandstats). 서버 전체 값이다 */
export async function redisCommandCalls(redis: Redis): Promise<Record<string, number>> {
  const text = await redis.info('commandstats');
  const out: Record<string, number> = {};
  for (const m of text.matchAll(/^cmdstat_([^:]+):calls=(\d+)/gm)) out[m[1]] = Number(m[2]);
  return out;
}

/** 두 카운터의 차이(0은 뺀다) */
export function delta(after: Record<string, number>, before: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(after)) {
    const d = v - (before[k] ?? 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}

export const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
