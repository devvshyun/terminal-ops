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

  it('입력 정규화: 숫자 시리얼과 같은 문자열 시리얼은 중복, 모델 코드가 없으면 UNKNOWN_MODEL, 중복은 첫 행이 결정', async () => {
    const raw = [
      { serialNo: 12345678, modelCode: 'SN-100' },
      { serialNo: '12345678', modelCode: 'SN-100' },
      { serialNo: ' NM-0001 ', modelCode: undefined },
      { serialNo: 'NM-0002', modelCode: ' SN-100 ' },
      { serialNo: 'NM-0001', modelCode: 'SN-100' }, // 첫 행(UNKNOWN_MODEL)이 결정한다
    ] as unknown as BulkRegisterRow[];
    const results = await bulk.register(raw, ctx);
    expect(results.map((r) => [r.serialNo, r.result])).toEqual([
      ['12345678', 'CREATED'],
      ['12345678', 'DUPLICATE_IN_REQUEST'],
      ['NM-0001', 'UNKNOWN_MODEL'],
      ['NM-0002', 'CREATED'],
      ['NM-0001', 'DUPLICATE_IN_REQUEST'],
    ]);
    expect(await em().count(Terminal, { serialNo: { $in: ['12345678', 'NM-0001', 'NM-0002'] } })).toBe(2);
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
    try {
      await bulk.register(rowsOf('NQ-A', 10), ctx);
    } finally {
      small.stop();
    }
    const large = captureQueries(t.orm);
    try {
      await bulk.register(rowsOf('NQ-B', 200), ctx);
    } finally {
      large.stop();
    }
    console.log(`[일괄 등록 쿼리] 10행: 전체 ${small.queries.length} select ${small.selects()} / 200행: 전체 ${large.queries.length} select ${large.selects()}`);
    expect(large.selects()).toBe(small.selects());
    expect(large.queries.length).toBeLessThan(30);
    expect(await em().count(Terminal, { serialNo: { $like: 'NQ-B-%' } })).toBe(200);
  });

  it('같은 시리얼이 겹친 두 요청이 동시에 와도 각 시리얼은 한 번만 만들어진다(unique 위반이면 다시 한다)', async () => {
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

  it('겹친 두 요청이 반대 순서로 와도(A 오름차순, B 내림차순) 각 시리얼은 한 번만 만들어진다', async () => {
    const a = rowsOf('RV', 60).slice(0, 40); // RV-0001 ~ RV-0040
    const b = rowsOf('RV', 60).slice(20).reverse(); // RV-0060 ~ RV-0021
    const [ra, rb] = await Promise.all([bulk.register(a, ctx), bulk.register(b, ctx)]);
    const created = [...ra, ...rb].filter((r) => r.result === 'CREATED').map((r) => r.serialNo);
    console.log(`[반대 순서 동시 등록] A 생성 ${ra.filter((r) => r.result === 'CREATED').length}, B 생성 ${rb.filter((r) => r.result === 'CREATED').length}`);
    expect(created).toHaveLength(60);
    expect(new Set(created).size).toBe(60);
    expect(await em().count(Terminal, { serialNo: { $like: 'RV-%' } })).toBe(60);
  });

  it('겹친 세 요청(A, B, C)이 동시에 와도 각 시리얼은 한 번만 만들어지고 Outbox도 한 번만 남는다', async () => {
    const all = rowsOf('TR3', 60);
    const a = all.slice(0, 40); // TR3-0001 ~ 0040
    const b = all.slice(20).reverse(); // TR3-0060 ~ 0021
    const c = all.slice(10, 50); // TR3-0011 ~ 0050
    const [ra, rb, rc] = await Promise.all([bulk.register(a, ctx), bulk.register(b, ctx), bulk.register(c, ctx)]);
    const created = [...ra, ...rb, ...rc].filter((r) => r.result === 'CREATED').map((r) => r.serialNo);
    const others = [...ra, ...rb, ...rc].filter((r) => r.result !== 'CREATED').map((r) => r.result);
    const count = (rs: typeof ra) => rs.filter((r) => r.result === 'CREATED').length;
    console.log(`[세 요청 동시 등록] A 생성 ${count(ra)}, B 생성 ${count(rb)}, C 생성 ${count(rc)}`);
    expect(created).toHaveLength(60);
    expect(new Set(created).size).toBe(60);
    expect(others).toHaveLength(40 + 40 + 40 - 60);
    expect(others.every((r) => r === 'ALREADY_EXISTS')).toBe(true);
    expect(await em().count(Terminal, { serialNo: { $like: 'TR3-%' } })).toBe(60);
    const outbox = (await em().find(OutboxEvent, {})).map((o) => (o.payload as { serialNo: string }).serialNo).filter((s) => s.startsWith('TR3-'));
    expect(outbox).toHaveLength(60);
    expect(new Set(outbox).size).toBe(60);
  });
});
