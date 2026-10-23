import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxEvent } from '../src/outbox/outbox-event.entity.js';
import { BulkRegistrationService, type BulkRegisterRow } from '../src/terminal/bulk-registration.service.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { TransitionSource } from '../src/terminal/terminal-status.js';
import { captureQueries } from './helpers/query-log.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const ctx = { actor: 'bulk-tester', source: TransitionSource.IMPORT };
const rowsOf = (prefix: string, n: number, modelCode = 'SN-100'): BulkRegisterRow[] =>
  Array.from({ length: n }, (_, i) => ({ serialNo: `${prefix}-${String(i + 1).padStart(4, '0')}`, modelCode }));

describe('일괄 등록 엔진 (F1·F6, decisions/0019)', () => {
  let t: TestApp;
  let bulk: BulkRegistrationService;
  const em = () => t.orm.em.fork();

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    bulk = t.app.get(BulkRegistrationService);
    await t.http().post('/terminals').set({ 'X-Operator': 'kim' }).send({ serialNo: 'BK-EXIST', modelCode: 'SN-100' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('행별 결과: 유효한 행만 만들고 나머지는 이유를 준다(입력 순서 그대로)', async () => {
    const results = await bulk.register(
      [
        { serialNo: 'BK-0001', modelCode: 'SN-100' },
        { serialNo: 'bk-bad', modelCode: 'SN-100' },
        { serialNo: 'BK-EXIST', modelCode: 'SN-100' },
        { serialNo: 'BK-0002', modelCode: 'SN-999' },
        { serialNo: 'BK-0001', modelCode: 'SN-100' },
        { serialNo: 'BK-0003', modelCode: 'SN-200' },
      ],
      ctx,
    );
    expect(results.map((r) => [r.serialNo, r.result])).toEqual([
      ['BK-0001', 'CREATED'],
      ['bk-bad', 'INVALID_FORMAT'],
      ['BK-EXIST', 'ALREADY_EXISTS'],
      ['BK-0002', 'UNKNOWN_MODEL'],
      ['BK-0001', 'DUPLICATE_IN_REQUEST'],
      ['BK-0003', 'CREATED'],
    ]);
    const created = await em().find(Terminal, { serialNo: { $in: ['BK-0001', 'BK-0003'] } }, { populate: ['model'] });
    expect(created.map((c) => [c.serialNo, c.model.code, c.status]).sort()).toEqual([
      ['BK-0001', 'SN-100', 'RECEIVED'],
      ['BK-0003', 'SN-200', 'RECEIVED'],
    ]);
  });

  it('만든 단말기마다 등록 이력과 알림(Outbox)이 같은 트랜잭션에 남는다', async () => {
    const history = await em().find(TerminalStatusHistory, { terminal: { serialNo: 'BK-0003' } });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ fromStatus: null, toStatus: 'RECEIVED', source: 'IMPORT', actor: 'bulk-tester', reason: '신규 등록' });
    const outbox = await em().find(OutboxEvent, {});
    expect(outbox.filter((o) => (o.payload as { serialNo: string }).serialNo === 'BK-0003')).toHaveLength(1);
  });

  it('조회 수는 행 수와 상관없다(N+1 없음): 10행과 200행의 select 수가 같다', async () => {
    const small = captureQueries(t.orm);
    await bulk.register(rowsOf('NQ-A', 10), ctx);
    small.stop();
    const large = captureQueries(t.orm);
    await bulk.register(rowsOf('NQ-B', 200), ctx);
    large.stop();
    console.log(`[일괄 등록 쿼리] 10행: 전체 ${small.queries.length} select ${small.selects()} / 200행: 전체 ${large.queries.length} select ${large.selects()}`);
    expect(large.selects()).toBe(small.selects());
    expect(large.queries.length).toBeLessThan(30);
    expect(await em().count(Terminal, { serialNo: { $like: 'NQ-B-%' } })).toBe(200);
  });

  it('같은 시리얼이 겹친 두 요청이 동시에 와도 각 시리얼은 한 번만 만들어진다(unique 위반이면 한 번 다시)', async () => {
    const a = rowsOf('CO', 60).slice(0, 40); // CO-0001 ~ CO-0040
    const b = rowsOf('CO', 60).slice(20); // CO-0021 ~ CO-0060
    const [ra, rb] = await Promise.all([bulk.register(a, ctx), bulk.register(b, ctx)]);
    const createdBy = new Map<string, number>();
    for (const r of [...ra, ...rb]) if (r.result === 'CREATED') createdBy.set(r.serialNo, (createdBy.get(r.serialNo) ?? 0) + 1);
    const overlapResults = [...ra.slice(20), ...rb.slice(0, 20)].map((r) => r.result).sort();
    console.log(`[겹친 동시 등록] A 생성 ${ra.filter((r) => r.result === 'CREATED').length}, B 생성 ${rb.filter((r) => r.result === 'CREATED').length}`);
    expect(createdBy.size).toBe(60);
    expect([...createdBy.values()].every((n) => n === 1)).toBe(true);
    expect(overlapResults.filter((r) => r === 'ALREADY_EXISTS')).toHaveLength(20);
    expect(await em().count(Terminal, { serialNo: { $like: 'CO-%' } })).toBe(60);
  });
});
