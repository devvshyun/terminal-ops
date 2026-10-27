import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LoadStrategy, RequestContext, type QueryResult } from '@mikro-orm/mysql';
import type { ListTerminalsQuery } from '../../src/terminal/dto/list-terminals.query.js';
import { TerminalService } from '../../src/terminal/terminal.service.js';
import { captureQueries } from '../helpers/query-log.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

/**
 * 실험 0013: 어드민 단말기 목록(GET /terminals)을 단말기 10만 대에서 — 실행계획과 응답 시간(decisions/0039).
 * 목록은 offset 페이지 + 전체 수(total)다. 조건마다
 * ① 서비스 list()를 모델·가맹점 읽기 방식 joined(MikroORM 기본)와 select-in(지금 코드)으로 RUNS번씩 불러 p50·p95를 재고,
 *    각 방식이 보내는 SELECT를 잡아 EXPLAIN ANALYZE한다.
 * ② HTTP(supertest, 같은 프로세스, 지금 코드) 응답 시간 p50·p95.
 * 재현: EXPERIMENTS=1 npx vitest run test/experiments/terminal-list.spec.ts --silent=false
 * 규모 바꾸기: EXP_TERMINALS=100000(기본), EXP_RUNS=20
 * 끝나면 테스트 DB를 resetDatabase로 다시 만든다(큰 표를 남기지 않는다).
 */
const N = Number(process.env.EXP_TERMINALS ?? 100_000);
const RUNS = Number(process.env.EXP_RUNS ?? 20);
/** 실험 0011과 같은 0~99999 숫자 표 */
const DIGITS = '(select 0 d union all select 1 union all select 2 union all select 3 union all select 4 union all select 5 union all select 6 union all select 7 union all select 8 union all select 9)';
const NUMBERS = `(select a.d + b.d * 10 + c.d * 100 + e.d * 1000 + f.d * 10000 as n from ${DIGITS} a cross join ${DIGITS} b cross join ${DIGITS} c cross join ${DIGITS} e cross join ${DIGITS} f)`;
/** 상태 12개를 고르게(단말기 n의 상태 = STATUSES[n % 12]). 모델은 (n div 12) % 3, 가맹점은 (n div 36) % 3 — 상태와 엇갈리게 */
const STATUSES = ['RECEIVED', 'INSPECTED', 'DEFECTIVE', 'IN_STOCK', 'ALLOCATED', 'SHIPPED', 'DELIVERED', 'IN_SERVICE', 'RETURN_REQUESTED', 'RETURNING', 'RETURNED', 'DISPOSED'];
/** 가맹점이 있는 상태(배정 ~ 운영 중) */
const WITH_MERCHANT = ['ALLOCATED', 'SHIPPED', 'DELIVERED', 'IN_SERVICE'];
const quoted = (xs: string[]) => xs.map((s) => `'${s}'`).join(', ');

const CASES: { name: string; query: Record<string, string | number> }[] = [
  { name: '조건 없음 1쪽', query: {} },
  { name: '조건 없음 2000쪽(offset 39,980)', query: { page: 2000 } },
  { name: '상태 IN_SERVICE', query: { status: 'IN_SERVICE' } },
  { name: '상태 IN_SERVICE 400쪽(끝)', query: { status: 'IN_SERVICE', page: 400 } },
  { name: '모델 SN-200', query: { modelCode: 'SN-200' } },
  { name: '가맹점 GANGNAM-KIMBAP', query: { merchantCode: 'GANGNAM-KIMBAP' } },
  { name: '상태 + 모델', query: { status: 'IN_SERVICE', modelCode: 'SN-200' } },
  { name: '시리얼 앞부분 EXP-0001', query: { q: 'EXP-0001' } },
];

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length * p) / 100))];
const round = (x: number) => Math.round(x * 10) / 10;

describe(`실험 0013 — 단말기 목록 API (단말기 ${N}대)`, () => {
  let t: TestApp;
  let terminals: TerminalService;
  const exec = <T extends QueryResult | Record<string, unknown>[] = Record<string, unknown>[]>(sql: string, params: unknown[] = []) =>
    t.orm.em.fork().execute<T>(sql, params);
  /** 컨트롤러의 ValidationPipe가 만드는 것과 같은 값(기본 page 1, size 20) */
  /** 서비스는 요청 컨텍스트의 EntityManager를 쓴다(HTTP 밖에서 부를 때는 요청마다 컨텍스트를 만든다 — 요청 하나와 같게) */
  const list = (query: Record<string, string | number>, strategy: LoadStrategy) =>
    RequestContext.create(t.orm.em, () => terminals.list(dto(query), strategy));
  const dto = (query: Record<string, string | number>) => ({ page: 1, size: 20, ...query }) as ListTerminalsQuery;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    terminals = t.app.get(TerminalService);
    const started = performance.now();
    await t.orm.em.fork().execute(
      `insert into terminal (serial_no, model_id, merchant_id, status, status_changed_at, version, created_at, updated_at)
       select concat('EXP-', lpad(n, 6, '0')),
              (select min(id) from terminal_model) + (n div 12) % 3,
              case when elt(1 + n % 12, ${quoted(STATUSES)}) in (${quoted(WITH_MERCHANT)}) then (select min(id) from merchant) + (n div 36) % 3 end,
              elt(1 + n % 12, ${quoted(STATUSES)}),
              timestamp('2026-01-01') + interval (n % 300) day,
              1, timestamp('2026-01-01'), timestamp('2026-01-01')
         from (select n from ${NUMBERS} z where n < ?) x`,
      [N],
      'run',
    );
    await exec('analyze table terminal');
    console.log(`[실험 0013] 단말기 ${N}대 넣기 ${round(performance.now() - started)}ms`);
  }, 600_000);
  afterAll(async () => {
    await resetDatabase(t.orm);
    await t.app.close();
  }, 120_000);

  it('조건별 joined vs select-in 실행계획·시간, HTTP 응답 시간', async () => {
    const rows: string[] = [];
    for (const c of CASES) {
      const cell: Record<string, string> = {};
      let total = 0;
      for (const strategy of [LoadStrategy.JOINED, LoadStrategy.SELECT_IN]) {
        // 1) 이 방식으로 보내는 SQL을 잡는다(서비스를 한 번 부른다)
        const log = captureQueries(t.orm);
        let first: Awaited<ReturnType<TerminalService['list']>>;
        try {
          first = await list(c.query, strategy);
        } finally {
          log.stop();
        }
        total = first.total;
        // 2) 서비스 시간
        const ms: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const s = performance.now();
          const r = await list(c.query, strategy);
          ms.push(performance.now() - s);
          expect(r.items.map((x) => x.serialNo)).toEqual(first.items.map((x) => x.serialNo));
        }
        cell[strategy] = `${round(pct(ms, 50))} / ${round(pct(ms, 95))}`;
        console.log(`\n[실험 0013] ${c.name} ${JSON.stringify(c.query)} ${strategy}: total ${first.total}, 행 ${first.items.length}, SELECT ${log.selects()}개, p50 ${round(pct(ms, 50))}ms, p95 ${round(pct(ms, 95))}ms`);
        // 3) 잡은 SELECT마다 EXPLAIN ANALYZE(트리 글자)
        for (const sql of log.formatted.filter((q) => /^select /i.test(q))) {
          const [plan] = await exec<{ EXPLAIN: string }[]>(`explain analyze ${sql}`);
          console.log(`SQL: ${sql}\n${plan.EXPLAIN}`);
        }
      }
      // 4) HTTP(지금 코드 = select-in): 한 번 데운 뒤 RUNS번
      await t.http().get('/terminals').query(c.query);
      const http: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const s = performance.now();
        const res = await t.http().get('/terminals').query(c.query);
        http.push(performance.now() - s);
        expect(res.body.total).toBe(total);
      }
      rows.push(`| ${c.name} | ${total} | ${cell[LoadStrategy.JOINED]} | ${cell[LoadStrategy.SELECT_IN]} | ${round(pct(http, 50))} / ${round(pct(http, 95))} |`);
    }
    console.log(`\n[실험 0013] 요약(ms, p50 / p95)\n| 조건 | total | 서비스 joined | 서비스 select-in | HTTP(select-in) |\n|---|---|---|---|---|\n${rows.join('\n')}`);
  }, 600_000);
});
