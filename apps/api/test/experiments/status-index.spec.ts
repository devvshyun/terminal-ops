import { afterAll, beforeAll, describe, it } from 'vitest';
import { LoadStrategy, RequestContext, type QueryResult } from '@mikro-orm/mysql';
import type { ListTerminalsQuery } from '../../src/terminal/dto/list-terminals.query.js';
import { TerminalStatus } from '../../src/terminal/terminal-status.js';
import { TerminalService } from '../../src/terminal/terminal.service.js';
import { seedFleet } from '../helpers/fleet-seed.js';
import { captureQueries } from '../helpers/query-log.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

/**
 * 실험 0016: 상태 조건 단말기 목록의 (status, id) 인덱스(decisions/0039 다시 볼 조건, Day 6 이월).
 * 지금 목록(`GET /terminals?status=`)은 `where status = ? order by id desc limit 20`을 PK 역순으로 읽으며 거른다(실험 0013).
 * 드문 상태면 20행을 채울 때까지 많이 읽는다. (status, id) 인덱스가 있으면 그 상태의 끝에서 20행만 읽는다.
 * ① 상태 4가지(흔함 IN_SERVICE 약 1만·RECEIVED 약 5천, 드묾 DEFECTIVE 약 500·DISPOSED 약 50) × 인덱스 없음/있음: 서비스 list() p50·p95, 목록 SQL의 EXPLAIN ANALYZE
 * ② 쓰기 비용: 상태 바꾸기 UPDATE 한 건씩 1,000번, 단말기 INSERT 한 건씩 1,000번 — 인덱스 없음/있음을 회차마다 번갈아 3회. 보조 인덱스 크기
 * 재현: EXPERIMENTS=1 npx vitest run test/experiments/status-index.spec.ts --silent=false
 * 바꾸기: EXP_TERMINALS=100000, EXP_RUNS=20, EXP_WRITES=1000. 끝나면 테스트 DB를 resetDatabase로 다시 만든다.
 */
const N = Number(process.env.EXP_TERMINALS ?? 100_000);
const RUNS = Number(process.env.EXP_RUNS ?? 20);
const WRITES = Number(process.env.EXP_WRITES ?? 1_000);
const INDEX = 'exp16_status_id';

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))];
const round = (x: number) => Math.round(x * 100) / 100;

describe(`실험 0016 — 상태 조건 목록의 (status, id) 인덱스 (단말기 ${N}대)`, () => {
  let t: TestApp;
  let terminals: TerminalService;
  const exec = <T extends QueryResult | Record<string, unknown>[] = Record<string, unknown>[]>(sql: string, params: unknown[] = []) =>
    t.orm.em.fork().execute<T>(sql, params);
  const list = (status: TerminalStatus) =>
    RequestContext.create(t.orm.em, () => terminals.list({ status, page: 1, size: 20 } as ListTerminalsQuery, LoadStrategy.SELECT_IN));
  const addIndex = () => exec(`alter table terminal add index ${INDEX} (status, id)`);
  const dropIndex = () => exec(`alter table terminal drop index ${INDEX}`);
  const indexMb = async () => {
    await exec('analyze table terminal');
    const [s] = await exec<{ Index_length: number }[]>("show table status like 'terminal'");
    return round(Number(s.Index_length) / 1024 / 1024);
  };

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    terminals = t.app.get(TerminalService);
    const seeded = await seedFleet(t, { terminals: N, base: new Date('2026-10-26T00:00:00.000Z') });
    // 드문 상태: 200대에 1대 DEFECTIVE(약 500대, 0.5%), 2,000대에 1대 DISPOSED(약 50대) — id 전체에 고르게 흩어 둔다
    await exec("update terminal set status = 'DEFECTIVE' where id % 200 = 0");
    await exec("update terminal set status = 'DISPOSED' where id % 2000 = 0");
    await exec('analyze table terminal');
    const counts = await exec<{ status: string; c: number }[]>('select status, count(*) as c from terminal group by status order by c desc');
    console.log(`[실험 0016] 시드 ${JSON.stringify(seeded)} 상태별 ${counts.map((r) => `${r.status} ${r.c}`).join(', ')}`);
  }, 600_000);
  afterAll(async () => {
    // 실험 인덱스가 남았으면 떨어뜨린다(resetDatabase도 표를 다시 만들지만 명시적으로)
    try {
      await dropIndex();
    } catch {
      /* 이미 없음 */
    }
    await resetDatabase(t.orm);
    await t.app.close();
  }, 120_000);

  it('① 상태별 목록 1쪽: 인덱스 없음/있음 시간과 실행계획', async () => {
    const statuses = [TerminalStatus.IN_SERVICE, TerminalStatus.RECEIVED, TerminalStatus.DEFECTIVE, TerminalStatus.DISPOSED];
    const lines: string[] = [];
    let added = false; // 중간에 실패해도 실험 인덱스를 남기지 않는다(②의 '없음' 변형이 인덱스를 안고 돌지 않게)
    try {
      for (const withIndex of [false, true]) {
        if (withIndex) {
          await addIndex();
          added = true;
        }
        for (const status of statuses) {
          await list(status); // 데우기
          const times: number[] = [];
          for (let i = 0; i < RUNS; i++) {
            const start = performance.now();
            await list(status);
            times.push(performance.now() - start);
          }
          const log = captureQueries(t.orm);
          try {
            await list(status);
          } finally {
            log.stop();
          }
          const listSql = log.formatted.find((q) => /^select .* from `terminal` as `t0`.* order by/i.test(q))!;
          const countSql = log.formatted.find((q) => /^select count/i.test(q))!;
          const [plan] = await exec<{ EXPLAIN: string }[]>(`explain analyze ${listSql}`);
          const [countPlan] = await exec<{ EXPLAIN: string }[]>(`explain analyze ${countSql}`);
          lines.push(
            `${withIndex ? '인덱스 있음' : '인덱스 없음'} ${status}: p50 ${round(pct(times, 50))}ms p95 ${round(pct(times, 95))}ms\n` +
              `    목록: ${plan.EXPLAIN.replace(/\s+/g, ' ').slice(0, 400)}\n    count: ${countPlan.EXPLAIN.replace(/\s+/g, ' ').slice(0, 250)}`,
          );
        }
      }
    } finally {
      if (added) await dropIndex();
    }
    console.log(`[실험 0016 ①]\n  ${lines.join('\n  ')}`);
  }, 600_000);

  it('② 쓰기 비용: 상태 UPDATE·INSERT 한 건씩, 보조 인덱스 크기', async () => {
    const [{ maxId }] = await exec<{ maxId: number }[]>('select max(id) as maxId from terminal');
    const [model] = await exec<{ id: number }[]>('select min(id) as id from terminal_model');
    const results: Record<string, { update: number[]; insert: number[] }> = { 없음: { update: [], insert: [] }, 있음: { update: [], insert: [] } };
    const sizes: Record<string, number> = { 없음: await indexMb() };
    let serial = 0;
    let pass = 0; // 회차·변형마다 상태를 뒤집는다 — 같은 값으로 UPDATE하면 바뀐 행이 없어(no-op) 비교가 안 된다
    for (let r = 0; r < 3; r++) {
      for (const variant of r % 2 === 0 ? ['없음', '있음'] : ['있음', '없음']) {
        if (variant === '있음') await addIndex();
        // 상태 UPDATE: 흩어진 단말기 WRITES대를 IN_STOCK ↔ ALLOCATED로(인덱스 있으면 (status, id) 항목이 옮겨 간다)
        const toStatus = pass++ % 2 === 0 ? 'ALLOCATED' : 'IN_STOCK';
        let start = performance.now();
        for (let i = 1; i <= WRITES; i++) await exec('update terminal set status = ? where id = ?', [toStatus, (i * 97) % maxId || 1]);
        results[variant].update.push(performance.now() - start);
        start = performance.now();
        for (let i = 0; i < WRITES; i++) {
          serial += 1;
          await exec(
            "insert into terminal (serial_no, model_id, status, status_changed_at, version, created_at, updated_at) values (?, ?, 'RECEIVED', now(), 1, now(), now())",
            [`X16-${String(serial).padStart(7, '0')}`, model.id],
          );
        }
        results[variant].insert.push(performance.now() - start);
        if (variant === '있음') {
          sizes['있음'] = await indexMb();
          await dropIndex();
        }
        await exec("delete from terminal where serial_no like 'X16-%'");
      }
    }
    const fmt = (xs: number[]) => xs.map((x) => Math.round(x)).join('/');
    console.log(
      `[실험 0016 ②] ${WRITES}건씩 3회(ms): UPDATE 없음 ${fmt(results['없음'].update)} 있음 ${fmt(results['있음'].update)} / ` +
        `INSERT 없음 ${fmt(results['없음'].insert)} 있음 ${fmt(results['있음'].insert)} / 보조 인덱스 terminal 없음 ${sizes['없음']}MB 있음 ${sizes['있음']}MB`,
    );
  }, 900_000);
});
