import { Merchant } from '../../src/merchant/merchant.entity.js';
import { TerminalModel } from '../../src/terminal/terminal-model.entity.js';
import type { TestApp } from './test-app.js';

/** 단말기 한 대가 거치는 상태(19단계). 단말기 n은 앞에서부터 1 + n % 19단계까지 거쳤고, 마지막 단계가 지금 상태다(실험 0011과 같다) */
const PATH = [
  'RECEIVED', 'INSPECTED', 'IN_STOCK', 'ALLOCATED', 'SHIPPED', 'DELIVERED', 'IN_SERVICE', 'RETURN_REQUESTED', 'RETURNING', 'RETURNED',
  'INSPECTED', 'IN_STOCK', 'ALLOCATED', 'SHIPPED', 'DELIVERED', 'IN_SERVICE', 'RETURN_REQUESTED', 'RETURNING', 'RETURNED',
];
const PATH_SQL = PATH.map((s) => `'${s}'`).join(', ');
/** 0~9 숫자 표 */
export const DIGITS = '(select 0 d union all select 1 union all select 2 union all select 3 union all select 4 union all select 5 union all select 6 union all select 7 union all select 8 union all select 9)';
/** 0~99999 숫자 표(10의 다섯 거듭제곱 교차 조인) */
export const NUMBERS = `(select a.d + b.d * 10 + c.d * 100 + e.d * 1000 + f.d * 10000 as n from ${DIGITS} a cross join ${DIGITS} b cross join ${DIGITS} c cross join ${DIGITS} e cross join ${DIGITS} f)`;
const RULES = ['DELIVERED_NOT_INSTALLED', 'RETURN_STALLED', 'SHIPPED_TOO_LONG', 'ALLOCATED_NO_SHIPMENT', 'IN_SERVICE_NO_MERCHANT', 'OFFLINE_TOO_LONG'];

/**
 * 큰 시드(실험 0015·0016): 실험 0011의 단말기·이력·접속 상태 식을 그대로 옮기고(실험 0011 파일은 그대로 둔다 — 다시 돌리지 않은 실험 코드를 바꾸지 않는다),
 * 열린 이상을 더한다. 기준 시각 base를 받는다 — 0011은 고정 시각, 대시보드는 "이번 주"를 세므로 지금에 가까운 시각을 준다.
 * - 단말기 n = 1..terminals(최대 100,000), 상태 = PATH[n % 19], status_changed_at = base − (1 + n % 23)일, 가맹점은 배정~회수 중 상태만(97대에 1대 없음)
 * - 이력: 단말기마다 거친 단계 수만큼 하루 간격(마지막 = status_changed_at). 1만 대씩 나눠 넣는다
 * - 접속 상태: 운영 중 단말기(11대에 1대는 행 없음), 7대에 1대 offline, 마지막 하트비트 0~4일 전
 * - 열린 이상: 20대에 1대, 규칙은 id % 6
 * 테스트 DB에서만 쓴다(호출 전 resetDatabase — 빈 표와 id 1부터를 가정한다). 넣은 뒤 analyze table.
 */
export async function seedFleet(
  t: TestApp,
  opts: { terminals: number; base: Date },
): Promise<{ ms: number; terminals: number; history: number; connectivity: number; anomalies: number }> {
  const em = () => t.orm.em.fork();
  const exec = <T = Record<string, unknown>[]>(sql: string, params: unknown[] = []) => em().execute(sql, params) as Promise<T>;
  const started = performance.now();
  const models = (await em().find(TerminalModel, {}, { orderBy: { id: 'asc' } })).map((m) => m.id);
  const merchants = (await em().find(Merchant, {}, { orderBy: { id: 'asc' } })).map((m) => m.id);
  const base = opts.base;
  await exec(
    `insert into terminal (serial_no, model_id, merchant_id, status, status_changed_at, version, created_at, updated_at)
     select concat('QP-', lpad(n, 6, '0')), elt(1 + n % 3, ?, ?, ?),
            if(st in ('ALLOCATED', 'SHIPPED', 'DELIVERED', 'IN_SERVICE', 'RETURN_REQUESTED', 'RETURNING') and n % 97 <> 0, elt(1 + n % 3, ?, ?, ?), null),
            st, date_sub(?, interval (1 + n % 23) day), 1, ?, ?
       from (select n, elt(1 + n % 19, ${PATH_SQL}) as st from (select n + 1 as n from ${NUMBERS} z) x where n <= ?) y`,
    [...models.slice(0, 3), ...merchants.slice(0, 3), base, base, base, opts.terminals],
  );
  for (let from = 1; from <= opts.terminals; from += 10_000) {
    await exec(
      `insert into terminal_status_history (terminal_id, from_status, to_status, source, actor, reason, occurred_at)
       select t.id, if(s.i = 0, null, elt(s.i, ${PATH_SQL})), elt(s.i + 1, ${PATH_SQL}), elt(1 + (t.id + s.i) % 4, 'MANUAL', 'INSPECTION', 'SHIPMENT', 'SCAN'), 'seed', 'seed',
              date_sub(t.status_changed_at, interval (t.k - 1 - s.i) day)
         from (select id, status_changed_at, 1 + cast(substring(serial_no, 4) as unsigned) % 19 as k from terminal
                where id between ? and ?) t
         join (select a.d + b.d * 10 as i from ${DIGITS} a cross join ${DIGITS} b) s on s.i < t.k`,
      [from, from + 9_999],
    );
  }
  await exec(
    `insert into device_connectivity (terminal_id, online, last_seen_at, firmware_version, changed_at)
     select id, id % 7 <> 0, date_sub(?, interval id % 5 day), '1.0.0', ? from terminal where status = 'IN_SERVICE' and id % 11 <> 0`,
    [base, base],
  );
  await exec(
    `insert into anomaly (terminal_id, rule, detected_at, last_seen_at, resolved_at, detail)
     select id, elt(1 + id % 6, ${RULES.map((r) => `'${r}'`).join(', ')}), ?, ?, null, '{}' from terminal where id % 20 = 0`,
    [base, base],
  );
  await exec('analyze table terminal, terminal_status_history, device_connectivity, anomaly');
  const [c] = await exec<{ terminals: unknown; history: unknown; conn: unknown; anomalies: unknown }[]>(
    `select (select count(*) from terminal) as terminals, (select count(*) from terminal_status_history) as history,
            (select count(*) from device_connectivity) as conn, (select count(*) from anomaly) as anomalies`,
  );
  return {
    ms: Math.round(performance.now() - started),
    terminals: Number(c.terminals),
    history: Number(c.history),
    connectivity: Number(c.conn),
    anomalies: Number(c.anomalies),
  };
}
