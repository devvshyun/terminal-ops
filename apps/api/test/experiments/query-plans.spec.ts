import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import type { QueryResult } from '@mikro-orm/mysql';
import { AnomalyService } from '../../src/anomaly/anomaly.service.js';
import { InspectionService } from '../../src/inspection/inspection.service.js';
import { Merchant } from '../../src/merchant/merchant.entity.js';
import { REDIS } from '../../src/redis/redis.provider.js';
import { TerminalModel } from '../../src/terminal/terminal-model.entity.js';
import { deleteTestKeys } from '../helpers/redis-keys.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

/**
 * 실험 0011: 데이터를 늘렸을 때의 실행계획(단말기 10만·이력 약 100만).
 * ① F4 "그 상태가 된 시각": (a) 이력 상관 서브쿼리 / (a') 이력 윈도 함수 vs (b) terminal.status_changed_at + (status, status_changed_at) 인덱스(decisions/0034)
 *    + OFFLINE_TOO_LONG 규칙의 greatest(coalesce(…)) 식과, 같은 뜻을 인덱스 범위로 쓴 식
 * ② 주간 리포트 이력 기간 집계(weekly-report.queries.ts의 전이·입출고 쿼리): 인덱스 없음 vs 후보 인덱스 4개(decisions/0035)
 * ③ terminal_status_history INSERT 비용: 인덱스 없음(지금) vs 중복 인덱스(terminal_id 단독) vs 리포트 후보 인덱스 — 대량(INSERT…SELECT)·한 건씩
 * ④ 브리프의 다른 중복 인덱스 후보 두 개(firmware_rollout_target.rollout_id, inspection_item.model_id) 있을 때 vs 없을 때(decisions/0032)
 * ⑤ 대조·집계 쿼리의 실행계획: Day 1 검수 통계, VAN 집합 비교 두 문장, 열린 이상 목록
 * 재현: EXPERIMENTS=1 npx vitest run test/experiments/query-plans.spec.ts --silent=false
 * 규모 바꾸기: EXP_TERMINALS=100000(기본), 이력은 단말기마다 1~19행(평균 약 10). EXP_RUNS=5, EXP_INSERT_ROWS=100000, EXP_SINGLE_ROWS=1000
 * 끝나면 테스트 DB를 resetDatabase로 다시 만든다(큰 표를 남기지 않는다).
 */
const N = Number(process.env.EXP_TERMINALS ?? 100_000);
const RUNS = Number(process.env.EXP_RUNS ?? 5);
const INSERT_ROWS = Number(process.env.EXP_INSERT_ROWS ?? 100_000);
const SINGLE_ROWS = Number(process.env.EXP_SINGLE_ROWS ?? 1_000);
const ROUNDS = 3;
/** 고정 기준 시각(초 단위로 맞춘다 — 이력 occurred_at은 datetime(0)이라 밀리초가 반올림된다) */
const BASE = new Date('2026-10-26T00:00:00.000Z');
const DAY = 86_400_000;
const LONG = 1_800_000;

/** 단말기 한 대가 거치는 상태(19단계). 단말기 n은 앞에서부터 1 + n % 19단계까지 거쳤고, 마지막 단계가 지금 상태다 */
const PATH = [
  'RECEIVED', 'INSPECTED', 'IN_STOCK', 'ALLOCATED', 'SHIPPED', 'DELIVERED', 'IN_SERVICE', 'RETURN_REQUESTED', 'RETURNING', 'RETURNED',
  'INSPECTED', 'IN_STOCK', 'ALLOCATED', 'SHIPPED', 'DELIVERED', 'IN_SERVICE', 'RETURN_REQUESTED', 'RETURNING', 'RETURNED',
];
const PATH_SQL = PATH.map((s) => `'${s}'`).join(', ');
/** 0~99999 숫자 표(10의 다섯 거듭제곱 교차 조인) */
const DIGITS = '(select 0 d union all select 1 union all select 2 union all select 3 union all select 4 union all select 5 union all select 6 union all select 7 union all select 8 union all select 9)';
const NUMBERS = `(select a.d + b.d * 10 + c.d * 100 + e.d * 1000 + f.d * 10000 as n from ${DIGITS} a cross join ${DIGITS} b cross join ${DIGITS} c cross join ${DIGITS} e cross join ${DIGITS} f)`;

/** 주간 리포트 이력 집계 후보 인덱스(실험 중에만 만들고 지운다) */
const HISTORY_INDEXES: { name: string; label: string; cols: string }[] = [
  { name: 'exp11_occ', label: '(occurred_at)', cols: 'occurred_at' },
  { name: 'exp11_cov_a', label: '(occurred_at, source, to_status)', cols: 'occurred_at, source, to_status' },
  { name: 'exp11_cov_b', label: '(occurred_at, to_status, from_status, terminal_id)', cols: 'occurred_at, to_status, from_status, terminal_id' },
  { name: 'exp11_cov_all', label: '(occurred_at, to_status, source, from_status, terminal_id)', cols: 'occurred_at, to_status, source, from_status, terminal_id' },
];
const DUP_HISTORY = { name: 'terminal_status_history_terminal_id_index', label: '중복 (terminal_id)', cols: 'terminal_id' };

/** weekly-report.queries.ts의 쿼리 2(전이)·3(입출고) 그대로. {hint}에 인덱스 힌트를 넣는다 */
const WEEKLY_Q2 = `select source, to_status, count(*) as c from terminal_status_history {hint}
            where occurred_at >= ? and occurred_at < ?
            group by source, to_status order by source, to_status`;
const WEEKLY_Q3 = `select m.code as model_code,
                  sum(h.to_status = 'RECEIVED' and h.from_status is null) as received,
                  sum(h.to_status = 'SHIPPED') as shipped,
                  sum(h.to_status = 'RETURNED') as returned
             from terminal_status_history h {hint}
             join terminal t on t.id = h.terminal_id
             join terminal_model m on m.id = t.model_id
            where h.occurred_at >= ? and h.occurred_at < ? and h.to_status in ('RECEIVED', 'SHIPPED', 'RETURNED')
            group by m.code order by m.code`;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x: number) => Math.round(x * 10) / 10;

describe(`실험 0011 — 실행계획 (단말기 ${N}대)`, () => {
  let t: TestApp;
  /** VAN 스테이징을 넣은 실행 id */
  let runId: number;
  let models: number[];
  const em = () => t.orm.em.fork();
  const exec = <T extends QueryResult | Record<string, unknown>[] = Record<string, unknown>[]>(sql: string, params: unknown[] = []) => em().execute<T>(sql, params);
  /** INSERT·UPDATE·DELETE: 'run'이어야 affectedRows가 온다(기본 'all'은 행 배열) */
  const run = (sql: string, params: unknown[] = []) => em().execute<QueryResult>(sql, params, 'run');

  async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; res: T }> {
    const start = performance.now();
    const res = await fn();
    return { ms: round(performance.now() - start), res };
  }

  /** RUNS번 돌려 중앙값·최소·최대와 마지막 결과 */
  async function repeat<T>(fn: () => Promise<T>, runs = RUNS) {
    const times: number[] = [];
    let res!: T;
    for (let i = 0; i < runs; i++) {
      const r = await timed(fn);
      times.push(r.ms);
      res = r.res;
    }
    return { med: median(times), min: Math.min(...times), max: Math.max(...times), times, res };
  }

  /** EXPLAIN ANALYZE의 트리(앞 2,500자) */
  async function explain(label: string, sql: string, params: unknown[] = []) {
    const [row] = await exec<{ EXPLAIN: string }[]>(`explain analyze ${sql}`, params);
    console.log(`\n[실험 0011 EXPLAIN] ${label}\n${row.EXPLAIN.slice(0, 2500)}`);
  }

  /** 지금 표의 보조 인덱스 크기 합(MB, analyze 직후 show table status의 Index_length) */
  async function indexMb(table: string) {
    await exec(`analyze table ${table}`);
    const [s] = await exec<{ Index_length: number; Data_length: number }[]>(`show table status like '${table}'`);
    return { index: round(Number(s.Index_length) / 1024 / 1024), data: round(Number(s.Data_length) / 1024 / 1024) };
  }

  /** 넣은 행만 PK 범위로 지운다(보조 인덱스 범위 DELETE를 쓰지 않는다) */
  async function deleteAbove(table: string, maxId: number) {
    for (;;) {
      const r = await run(`delete from ${table} where id > ? order by id limit 50000`, [maxId]);
      if (r.affectedRows === 0) break;
    }
  }

  async function indexCount(table: string, names: string[]) {
    const [{ c }] = await exec<{ c: number }[]>(
      `select count(distinct index_name) as c from information_schema.statistics where table_schema = database() and table_name = ? and index_name in (${names.map(() => '?').join(', ')})`,
      [table, ...names],
    );
    return Number(c);
  }

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    models = (await em().find(TerminalModel, {}, { orderBy: { id: 'asc' } })).map((m) => m.id);
    const merchants = (await em().find(Merchant, {}, { orderBy: { id: 'asc' } })).map((m) => m.id);
    const [env] = await exec<{ v: string; bp: number; mode: string }[]>('select version() as v, @@innodb_buffer_pool_size as bp, @@sql_mode as mode');
    console.log(`[실험 0011] MySQL ${env.v}, innodb_buffer_pool_size ${Math.round(Number(env.bp) / 1024 / 1024)}MB`);

    const steps: string[] = [];
    const seed = await timed(async () => {
      // 단말기: 상태 = PATH[n % 19], 그 상태가 된 시각 = BASE - (1 + n % 23)일, 가맹점은 배정~회수 중 상태에만(97대에 1대는 없음)
      const s = await timed(() =>
        exec(
          `insert into terminal (serial_no, model_id, merchant_id, status, status_changed_at, version, created_at, updated_at)
           select concat('QP-', lpad(n, 6, '0')), elt(1 + n % 3, ?, ?, ?),
                  if(st in ('ALLOCATED', 'SHIPPED', 'DELIVERED', 'IN_SERVICE', 'RETURN_REQUESTED', 'RETURNING') and n % 97 <> 0, elt(1 + n % 3, ?, ?, ?), null),
                  st, date_sub(?, interval (1 + n % 23) day), 1, ?, ?
             from (select n, elt(1 + n % 19, ${PATH_SQL}) as st from (select n + 1 as n from ${NUMBERS} z) x where n <= ?) y`,
          [...models, ...merchants, BASE, BASE, BASE, N],
        ),
      );
      steps.push(`단말기 ${s.ms}ms`);
      // 이력: 단말기마다 거친 단계 수(1 + n % 19)만큼, 하루 간격으로 마지막 단계가 status_changed_at. 1만 대씩 나눠 넣는다
      const h = await timed(async () => {
        for (let from = 1; from <= N; from += 10_000) {
          await exec(
            `insert into terminal_status_history (terminal_id, from_status, to_status, source, actor, reason, occurred_at)
             select t.id, if(s.i = 0, null, elt(s.i, ${PATH_SQL})), elt(s.i + 1, ${PATH_SQL}), elt(1 + (t.id + s.i) % 4, 'MANUAL', 'INSPECTION', 'SHIPMENT', 'SCAN'), 'exp11', 'seed',
                    date_sub(t.status_changed_at, interval (t.k - 1 - s.i) day)
               from (select id, status_changed_at, 1 + cast(substring(serial_no, 4) as unsigned) % 19 as k from terminal
                      where id between ? and ?) t
               join (select a.d + b.d * 10 as i from ${DIGITS} a cross join ${DIGITS} b) s on s.i < t.k`,
            [from, from + 9_999],
          );
        }
      });
      steps.push(`이력 ${h.ms}ms`);
      // 검수(Day 1 통계용): 5대에 1대, 항목 4개 중 7번째마다 불합격
      await exec(`insert into inspection (terminal_id, passed, actor, inspected_at) select id, 1, 'exp11', ? from terminal where id % 5 = 0`, [BASE]);
      await exec(
        `insert into inspection_result (inspection_id, item_code, passed, note)
         select i.id, elt(k.d + 1, 'POWER', 'NETWORK', 'CARD_READER', 'PRINTER'), (i.id + k.d) % 7 <> 0, null
           from inspection i cross join (select 0 d union all select 1 union all select 2 union all select 3) k`,
      );
      // 접속 상태: 운영 중 단말기(11대에 1대는 하트비트 행 없음), 7대에 1대 offline 플래그, 마지막 하트비트 0~4일 전
      await exec(
        `insert into device_connectivity (terminal_id, online, last_seen_at, firmware_version, changed_at)
         select id, id % 7 <> 0, date_sub(?, interval id % 5 day), '1.0.0', ? from terminal where status = 'IN_SERVICE' and id % 11 <> 0`,
        [BASE, BASE],
      );
    });
    // VAN 스테이징 한 벌: 운영 중 단말기 전부(50대에 1대는 정지) + 회수된 단말기 10대에 1대(해지가 빠져 ACTIVE로 남음)
    const ins = await run(
      `insert into van_reconciliation_run (status, \`trigger\`, requested_by, started_at, heartbeat_at, finished_at) values ('COMPLETED', 'MANUAL', 'exp11', ?, ?, ?)`,
      [BASE, BASE, BASE],
    );
    runId = Number(ins.insertId);
    await exec(
      `insert into van_registration_snapshot (run_id, serial_no, tid, merchant_code, status, van_updated_at)
       select ?, t.serial_no, concat('VT', t.id), coalesce(m.code, 'NONE'), if(t.id % 50 = 0, 'SUSPENDED', 'ACTIVE'), ?
         from terminal t left join merchant m on m.id = t.merchant_id where t.status = 'IN_SERVICE' or (t.status = 'RETURNED' and t.id % 10 = 0)`,
      [runId, BASE],
    );
    await exec('analyze table terminal, terminal_status_history, inspection, inspection_result, device_connectivity, van_registration_snapshot, anomaly');
    const [counts] = await exec<{ terminals: number; history: number; results: number; conn: number; van: number }[]>(
      `select (select count(*) from terminal) as terminals, (select count(*) from terminal_status_history) as history,
              (select count(*) from inspection_result) as results, (select count(*) from device_connectivity) as conn,
              (select count(*) from van_registration_snapshot) as van`,
    );
    const size = await indexMb('terminal_status_history');
    console.log(
      `[실험 0011] 시드 ${seed.ms}ms (${steps.join(', ')}): 단말기 ${counts.terminals}, 이력 ${counts.history}, 검수 결과 ${counts.results}, 접속 상태 ${counts.conn}, VAN 스테이징 ${counts.van} (run ${runId}). 이력 표 데이터 ${size.data}MB·보조 인덱스 ${size.index}MB`,
    );
  }, LONG);

  afterAll(async () => {
    if (!t) return; // beforeAll이 앱을 만들기 전에 실패하면 원래 오류를 가리지 않게
    await deleteTestKeys(t.app.get<Redis>(REDIS));
    // 큰 표를 남기지 않는다(다음 테스트가 어차피 resetDatabase를 하지만, 디스크·버퍼 풀을 비워 둔다)
    await resetDatabase(t.orm);
    await t.app.close();
  }, LONG);

  it('① F4 그 상태가 된 시각: (a) 이력 서브쿼리 / (a\') 윈도 vs (b) status_changed_at 인덱스, 오프라인 규칙 식', async () => {
    const rules = [
      { name: 'DELIVERED_NOT_INSTALLED(7일)', statuses: ['DELIVERED'], days: 7 },
      { name: 'RETURN_STALLED(14일)', statuses: ['RETURN_REQUESTED', 'RETURNING'], days: 14 },
    ];
    const table: string[] = [];
    for (const r of rules) {
      const cutoff = new Date(BASE.getTime() - r.days * DAY);
      const inList = r.statuses.map(() => '?').join(', ');
      const variants = [
        {
          name: '(a) 이력 상관 서브쿼리',
          sql: `select id, serial_no, since from (select t.id, t.serial_no, (select max(h.occurred_at) from terminal_status_history h where h.terminal_id = t.id and h.to_status = t.status) as since
                  from terminal t where t.status in (${inList})) x where since < ? order by id`,
        },
        {
          name: "(a') 이력 윈도 함수",
          sql: `select id, serial_no, since from (
                  select t.id, t.serial_no, h.occurred_at as since, row_number() over (partition by t.id order by h.occurred_at desc, h.id desc) as rn
                    from terminal t join terminal_status_history h on h.terminal_id = t.id and h.to_status = t.status
                   where t.status in (${inList})) x
                 where rn = 1 and since < ? order by id`,
        },
        // (b)는 findAnomalies와 같은 열을 읽는다(serial_no 때문에 커버링 인덱스가 아니다)
        { name: '(b) status_changed_at 인덱스', sql: `select id, serial_no, status_changed_at from terminal where status in (${inList}) and status_changed_at < ? order by id` },
        {
          name: '(b) 인덱스 없이(IGNORE INDEX)',
          sql: `select id, serial_no, status_changed_at from terminal ignore index (terminal_status_status_changed_at_index) where status in (${inList}) and status_changed_at < ? order by id`,
        },
      ];
      const results: number[][] = [];
      for (const v of variants) {
        const params = [...r.statuses, cutoff];
        const m = await repeat(() => exec<{ id: number }[]>(v.sql, params));
        const ids = m.res.map((x) => x.id);
        results.push(ids);
        table.push(`| ${r.name} | ${v.name} | ${ids.length} | ${m.med} | ${m.min}~${m.max} | ${m.times.join(', ')} |`);
        await explain(`${r.name} ${v.name}`, v.sql, params);
      }
      // (a)·(a')·(b)가 같은 단말기를 찾는다(시드가 이력과 status_changed_at을 맞춰 두었다)
      for (const res of results) expect(res).toEqual(results[2]);
      expect(results[2].length).toBeGreaterThan(0);
    }
    console.log(`\n[실험 0011] ① F4 규칙 쿼리 (ms, ${RUNS}번 중앙값 / 최소~최대 / 원값)`);
    console.log('| 규칙 | 방식 | 행 | 중앙값 | 최소~최대 | 원값 |');
    console.log('|---|---|---|---|---|---|');
    for (const row of table) console.log(row);

    // 오프라인 규칙: 지금 코드의 greatest(coalesce(…)) 식 vs 같은 뜻을 열 비교로 쓴 식(status_changed_at 범위를 인덱스로 탈 수 있다)
    const offCutoff = new Date(BASE.getTime() - 3 * DAY);
    const offline = [
      {
        name: '지금 코드: greatest(coalesce(last_seen, changed), changed) < ?',
        sql: `select t.id, t.serial_no, c.last_seen_at,
            greatest(coalesce(c.last_seen_at, t.status_changed_at), t.status_changed_at) as since
       from terminal t left join device_connectivity c on c.terminal_id = t.id
      where t.status = 'IN_SERVICE'
        and greatest(coalesce(c.last_seen_at, t.status_changed_at), t.status_changed_at) < ?`,
        params: [offCutoff],
      },
      {
        name: '같은 뜻 열 비교: changed < ? and (last_seen is null or last_seen < ?)',
        sql: `select t.id, t.serial_no, c.last_seen_at,
            greatest(coalesce(c.last_seen_at, t.status_changed_at), t.status_changed_at) as since
       from terminal t left join device_connectivity c on c.terminal_id = t.id
      where t.status = 'IN_SERVICE' and t.status_changed_at < ?
        and (c.last_seen_at is null or c.last_seen_at < ?)`,
        params: [offCutoff, offCutoff],
      },
    ];
    const offIds: number[][] = [];
    const offRows: string[] = [];
    for (const v of offline) {
      const m = await repeat(() => exec<{ id: number }[]>(v.sql, v.params));
      offIds.push(m.res.map((x) => x.id).sort((a, b) => a - b));
      offRows.push(`| ${v.name} | ${m.res.length} | ${m.med} | ${m.min}~${m.max} | ${m.times.join(', ')} |`);
      await explain(`OFFLINE_TOO_LONG ${v.name}`, v.sql, v.params);
    }
    expect(offIds[1]).toEqual(offIds[0]);
    const [{ inService }] = await exec<{ inService: number }[]>(`select count(*) as inService from terminal where status = 'IN_SERVICE'`);
    console.log(`\n[실험 0011] ① 오프라인 규칙(운영 중 ${inService}대, 기준 3일)`);
    console.log('| 식 | 행 | 중앙값 | 최소~최대 | 원값 |');
    console.log('|---|---|---|---|---|');
    for (const row of offRows) console.log(row);

    // 찾기 전체(규칙 6개 + 열린 이상 비교 + INSERT): 첫 실행(전부 새로)과 두 번째(전부 계속)
    const svc = t.app.get(AnomalyService);
    const first = await timed(() => svc.scan(BASE));
    const second = await timed(() => svc.scan(new Date(BASE.getTime() + 60_000)));
    console.log(`[실험 0011] 찾기 전체: 첫 실행 ${first.ms}ms (새로 ${first.res.detected}), 두 번째 ${second.ms}ms (계속 ${second.res.continuing}, 새로 ${second.res.detected})`);
    console.log(`[실험 0011] 열린 이상 규칙별: ${JSON.stringify(second.res.open)}`);
  }, LONG);

  it('② 주간 리포트 이력 기간 집계(쿼리 2·3): 인덱스 없음 vs 후보 인덱스', async () => {
    const weeks = [
      { label: '최근 주 [BASE-7d, BASE)', range: [new Date(BASE.getTime() - 7 * DAY), BASE] },
      { label: '5주 전 [BASE-35d, BASE-28d)', range: [new Date(BASE.getTime() - 35 * DAY), new Date(BASE.getTime() - 28 * DAY)] },
    ];
    const [{ total }] = await exec<{ total: number }[]>('select count(*) as total from terminal_status_history');
    for (const w of weeks) {
      const [{ c }] = await exec<{ c: number }[]>('select count(*) as c from terminal_status_history where occurred_at >= ? and occurred_at < ?', w.range);
      console.log(`[실험 0011] ② ${w.label}: 범위 안 이력 ${c} / ${total} (${round((Number(c) / Number(total)) * 100)}%)`);
    }
    const variants: { label: string; index?: (typeof HISTORY_INDEXES)[number]; hint: string }[] = [
      { label: '인덱스 없음(지금)', hint: '' },
      ...HISTORY_INDEXES.map((ix) => ({ label: ix.label, index: ix, hint: '' })),
      { label: '(occurred_at) FORCE INDEX', index: HISTORY_INDEXES[0], hint: `force index (${HISTORY_INDEXES[0].name})` },
    ];
    const rows: string[] = [];
    const answers = new Map<string, string>();
    for (const v of variants) {
      let build = '';
      if (v.index) {
        const b = await timed(() => exec(`alter table terminal_status_history add index ${v.index!.name} (${v.index!.cols})`));
        build = `${b.ms}`;
        await exec('analyze table terminal_status_history');
      }
      for (const w of weeks) {
        for (const [q, sql] of [['쿼리 2 전이', WEEKLY_Q2], ['쿼리 3 입출고', WEEKLY_Q3]] as const) {
          const text = sql.replace('{hint}', v.hint);
          const m = await repeat(() => exec(text, w.range));
          const key = `${w.label} ${q}`;
          const ans = JSON.stringify(m.res);
          if (!answers.has(key)) answers.set(key, ans);
          expect(ans).toBe(answers.get(key)); // 인덱스가 답을 바꾸지 않는다
          rows.push(`| ${v.label} | ${w.label} | ${q} | ${m.med} | ${m.min}~${m.max} | ${m.times.join(', ')} | ${build} |`);
          await explain(`주간 리포트 ${q} · ${w.label} · ${v.label}`, text, w.range);
        }
      }
      if (v.index && !v.hint) {
        const mb = await indexMb('terminal_status_history');
        console.log(`[실험 0011] ② ${v.label} 만든 뒤 이력 표 보조 인덱스 합 ${mb.index}MB`);
      }
      if (v.index) await exec(`alter table terminal_status_history drop index ${v.index.name}`);
    }
    console.log(`\n[실험 0011] ② 주간 리포트 이력 집계 (ms, ${RUNS}번 중앙값 / 최소~최대 / 원값 / 인덱스 만들기 ms)`);
    console.log('| 인덱스 | 주 | 쿼리 | 중앙값 | 최소~최대 | 원값 | 만들기 ms |');
    console.log('|---|---|---|---|---|---|---|');
    for (const r of rows) console.log(r);
    expect(await indexCount('terminal_status_history', HISTORY_INDEXES.map((x) => x.name))).toBe(0);
  }, LONG);

  it('③ terminal_status_history INSERT 비용: 없음 vs 중복 (terminal_id) vs 리포트 후보 인덱스 — 대량·한 건씩', async () => {
    const [{ maxId }] = await exec<{ maxId: number }[]>('select max(id) as maxId from terminal_status_history');
    const variants: { label: string; index?: { name: string; cols: string } }[] = [
      { label: '추가 없음(지금)' },
      { label: DUP_HISTORY.label, index: DUP_HISTORY },
      ...HISTORY_INDEXES.map((ix) => ({ label: ix.label, index: ix })),
    ];
    const bulk: string[] = [];
    const single: string[] = [];
    const bulkMs = new Map<string, number[]>();
    const singleMs = new Map<string, number[]>();
    for (let r = 1; r <= ROUNDS; r++) {
      for (const v of variants) {
        if (v.index) await exec(`alter table terminal_status_history add index ${v.index.name} (${v.index.cols})`);
        // 대량: 한 문장 INSERT…SELECT INSERT_ROWS행(occurred_at은 원본 그대로 — 기존 분포 안에 끼어든다)
        const b = await timed(() =>
          run(
            `insert into terminal_status_history (terminal_id, from_status, to_status, source, actor, reason, occurred_at)
             select terminal_id, from_status, to_status, source, 'exp11-ins', reason, occurred_at from terminal_status_history where id <= ?`,
            [INSERT_ROWS],
          ),
        );
        const mb = await indexMb('terminal_status_history');
        bulk.push(`| ${r} | ${v.label} | ${INSERT_ROWS} | ${b.ms} | ${mb.index} |`);
        bulkMs.set(v.label, [...(bulkMs.get(v.label) ?? []), b.ms]);
        await deleteAbove('terminal_status_history', maxId);
        // 한 건씩: 자동 커밋 INSERT SINGLE_ROWS번(운영의 전이 한 번 = 이력 한 행에 가깝다). occurred_at은 지금 시각 근처(오른쪽 끝에 붙는다)
        const s = await timed(async () => {
          const e = em();
          for (let i = 0; i < SINGLE_ROWS; i++) {
            await e.execute(
              `insert into terminal_status_history (terminal_id, from_status, to_status, source, actor, reason, occurred_at) values (?, 'IN_STOCK', 'ALLOCATED', 'ALLOCATION', 'exp11-one', 'exp', ?)`,
              [1 + ((i * 7919) % N), new Date(BASE.getTime() + i * 1000)],
              'run',
            );
          }
        });
        single.push(`| ${r} | ${v.label} | ${SINGLE_ROWS} | ${s.ms} | ${round((s.ms / SINGLE_ROWS) * 1000) / 1000} |`);
        singleMs.set(v.label, [...(singleMs.get(v.label) ?? []), s.ms]);
        await deleteAbove('terminal_status_history', maxId);
        if (v.index) await exec(`alter table terminal_status_history drop index ${v.index.name}`);
      }
    }
    console.log(`\n[실험 0011] ③ terminal_status_history 대량 INSERT…SELECT (회차마다 변형을 번갈아)`);
    console.log('| 회차 | 추가 인덱스 | 넣은 행 | ms | 보조 인덱스 합(MB, INSERT 직후) |');
    console.log('|---|---|---|---|---|');
    for (const r of bulk) console.log(r);
    console.log(`\n[실험 0011] ③ terminal_status_history 한 건씩 자동 커밋 INSERT`);
    console.log('| 회차 | 추가 인덱스 | 건수 | 총 ms | 건당 ms |');
    console.log('|---|---|---|---|---|');
    for (const r of single) console.log(r);
    console.log('\n[실험 0011] ③ 요약(중앙값)');
    console.log('| 추가 인덱스 | 대량 ms | 한 건씩 총 ms |');
    console.log('|---|---|---|');
    for (const v of variants) console.log(`| ${v.label} | ${median(bulkMs.get(v.label)!)} | ${median(singleMs.get(v.label)!)} |`);
    // 끝나면 엔티티대로(중복·후보 인덱스 없음)
    expect(await indexCount('terminal_status_history', [DUP_HISTORY.name, ...HISTORY_INDEXES.map((x) => x.name)])).toBe(0);
  }, LONG);

  it('④ 다른 중복 인덱스 후보: firmware_rollout_target.rollout_id, inspection_item.model_id 있을 때 vs 없을 때', async () => {
    // 펌웨어 배포 한 건(대상은 INSERT_ROWS대까지)
    const fw = await run(`insert into firmware (model_id, version, created_by, created_at) values (?, '9.9.9', 'exp11', ?)`, [models[0], BASE]);
    const ro = await run(
      `insert into firmware_rollout (firmware_id, stages, current_stage, status, failure_threshold, min_samples, stage_timeout_ms, stage_started_at, created_by, created_at)
       values (?, '[100]', 0, 'COMPLETED', 0.3, 10, 600000, ?, 'exp11', ?)`,
      [Number(fw.insertId), BASE, BASE],
    );
    const rolloutId = Number(ro.insertId);
    const targetRows = Math.min(INSERT_ROWS, N);
    const itemRows = 10_000;
    const cases = [
      {
        table: 'firmware_rollout_target',
        dup: { name: 'firmware_rollout_target_rollout_id_index', cols: 'rollout_id' },
        rows: targetRows,
        insert: () =>
          run(
            `insert into firmware_rollout_target (rollout_id, terminal_id, stage, status, offered_at)
             select ?, id, 0, 'OFFERED', ? from terminal where id <= ?`,
            [rolloutId, BASE, targetRows],
          ),
      },
      {
        table: 'inspection_item',
        dup: { name: 'inspection_item_model_id_index', cols: 'model_id' },
        rows: itemRows,
        insert: () =>
          run(
            `insert into inspection_item (model_id, code, label, sort_order)
             select elt(1 + n % 3, ?, ?, ?), concat('EXP-', n), 'exp11', n from (select n from ${NUMBERS} z where n < ?) x`,
            [...models, itemRows],
          ),
      },
    ];
    const rows: string[] = [];
    for (const c of cases) {
      const [{ maxId }] = await exec<{ maxId: number | null }[]>(`select max(id) as maxId from ${c.table}`);
      for (let r = 1; r <= ROUNDS; r++) {
        for (const withDup of [true, false]) {
          if (withDup) await exec(`alter table ${c.table} add index ${c.dup.name} (${c.dup.cols})`);
          const { ms } = await timed(c.insert);
          const mb = await indexMb(c.table);
          rows.push(`| ${c.table} | ${r} | ${withDup ? '있음' : '없음'} | ${c.rows} | ${ms} | ${mb.index} |`);
          await deleteAbove(c.table, Number(maxId ?? 0));
          if (withDup) await exec(`alter table ${c.table} drop index ${c.dup.name}`);
        }
      }
      expect(await indexCount(c.table, [c.dup.name])).toBe(0);
    }
    console.log('\n[실험 0011] ④ 다른 중복 인덱스 후보 INSERT…SELECT');
    console.log('| 표 | 회차 | 중복 인덱스 | 넣은 행 | ms | 보조 인덱스 합(MB, INSERT 직후) |');
    console.log('|---|---|---|---|---|---|');
    for (const r of rows) console.log(r);
  }, LONG);

  it('⑤ 대조·집계 쿼리의 실행계획(Day 1 검수 통계, VAN 집합 비교, 열린 이상)', async () => {
    const stats = await repeat(() => t.app.get(InspectionService).failureStats());
    console.log(`\n[실험 0011] ⑤ Day 1 검수 통계 중앙값 ${stats.med}ms (${stats.min}~${stats.max}, ${stats.res.length}행)`);
    await explain(
      'Day 1 검수 통계(failureStats)',
      `select m.code as model_code, r.item_code, count(*) as total, sum(case when r.passed then 0 else 1 end) as failed
         from inspection_result r join inspection i on i.id = r.inspection_id join terminal t on t.id = i.terminal_id join terminal_model m on m.id = t.model_id
        group by m.code, r.item_code order by failed desc, m.code, r.item_code`,
    );
    // van-reconciliation.service.ts compare()의 두 문장 그대로
    const vanQ1 = `select t.serial_no, s.serial_no as van_serial, t.status, m.code as our_merchant, s.status as van_status, s.merchant_code as van_merchant
             from terminal t
             left join merchant m on m.id = t.merchant_id
             left join van_registration_snapshot s on s.run_id = ? and s.serial_no = t.serial_no
            where t.status = 'IN_SERVICE'
              and (s.serial_no is null or s.status <> 'ACTIVE' or m.code is null or m.code <> s.merchant_code)`;
    const vanQ2 = `select coalesce(t.serial_no, s.serial_no) as serial_no, s.serial_no as van_serial, t.status, m.code as our_merchant, s.status as van_status, s.merchant_code as van_merchant
             from van_registration_snapshot s
             left join terminal t on t.serial_no = s.serial_no
             left join merchant m on m.id = t.merchant_id
            where s.run_id = ? and s.status = 'ACTIVE' and (t.id is null or t.status <> 'IN_SERVICE')`;
    for (const [label, sql] of [['VAN 비교 ① 운영 중 기준', vanQ1], ['VAN 비교 ② VAN ACTIVE 기준', vanQ2]] as const) {
      const r = await repeat(() => exec(sql, [runId]));
      console.log(`[실험 0011] ⑤ ${label}: 중앙값 ${r.med}ms (${r.min}~${r.max}), ${r.res.length}행`);
      await explain(label, sql, [runId]);
    }
    const open = `select t.serial_no, t.status, a.rule, a.detected_at, a.last_seen_at from anomaly a join terminal t on t.id = a.terminal_id
                   where a.resolved_at is null order by a.rule, a.detected_at, a.id limit 1000`;
    const r2 = await repeat(() => exec(open));
    console.log(`[실험 0011] ⑤ 열린 이상 목록(1,000행): 중앙값 ${r2.med}ms (${r2.min}~${r2.max})`);
    await explain('열린 이상 목록', open);
  }, LONG);
});
