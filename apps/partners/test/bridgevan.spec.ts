import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPartners, type Partners } from './helpers.js';

interface Item {
  tid: string;
  serialNo: string;
  merchantCode: string;
  status: string;
  registeredAt: string;
  updatedAt: string;
}

/** tid VT-0001…, 시리얼 SN-0001… */
function regs(n: number, extra: (i: number) => Record<string, unknown> = () => ({})) {
  return Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    const pad = String(i).padStart(4, '0');
    return { tid: `VT-${pad}`, serialNo: `SN-${pad}`, merchantCode: 'GANGNAM-KIMBAP', status: 'ACTIVE', ...extra(i) };
  });
}

describe('브릿지VAN — 등록 단말기 목록(커서 페이지)·단건·스캔 도중 변경', () => {
  let p: Partners;
  const seed = (registrations: unknown[], replace?: boolean) =>
    fetch(`${p.base}/__admin/bridgevan/registrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ registrations, ...(replace === undefined ? {} : { replace }) }),
    });
  const list = (q: string) => fetch(`${p.base}/bridgevan/v1/terminals${q}`);
  const page = async (q: string) => (await (await list(q)).json()) as { items: Item[]; nextCursor: string | null };

  /** 처음부터 끝까지 커서로 넘긴다 */
  async function scanAll(limit: number) {
    const seen: Item[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body = await page(`?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...body.items);
      cursor = body.nextCursor;
      pages++;
    } while (cursor);
    return { seen, pages };
  }

  beforeAll(async () => {
    p = await startPartners();
  });
  beforeEach(async () => {
    await p.reset();
  });
  afterAll(() => p.close());

  it('커서로 끝까지 넘기면 tid 순서로 모든 등록을 한 번씩 받고, 마지막 페이지의 nextCursor는 null', async () => {
    expect(await (await seed(regs(25))).json()).toEqual({ count: 25 });
    const { seen, pages } = await scanAll(10);
    expect(pages).toBe(3);
    expect(seen.map((r) => r.tid)).toEqual(regs(25).map((r) => r.tid));
    expect(seen[0]).toMatchObject({ tid: 'VT-0001', serialNo: 'SN-0001', merchantCode: 'GANGNAM-KIMBAP', status: 'ACTIVE' });
    expect(seen[0].registeredAt).toEqual(expect.any(String));
    // 딱 나누어떨어지면 마지막 페이지가 꽉 차도 nextCursor는 null(빈 페이지를 한 번 더 부르지 않는다)
    await seed(regs(20));
    expect((await scanAll(10)).pages).toBe(2);
  });

  it('페이지를 넘기는 사이 앞쪽에 등록이 생기거나 지워져도 다음 페이지는 중복·누락 없이 커서 뒤부터(offset이 아님)', async () => {
    await seed(regs(20));
    const first = await page('?limit=10');
    // 지나간 자리(VT-0005 앞)에 새 등록, 아직 안 지나간 자리(VT-0015 뒤)에 새 등록
    await seed([{ tid: 'VT-0004A', serialNo: 'SN-NEW-1', merchantCode: 'YEOKSAM-CAFE', status: 'ACTIVE' }], false);
    await seed([{ tid: 'VT-0015A', serialNo: 'SN-NEW-2', merchantCode: 'YEOKSAM-CAFE', status: 'ACTIVE' }], false);
    const second = await page(`?limit=10&cursor=${first.nextCursor}`);
    const tids = [...first.items, ...second.items].map((r) => r.tid);
    expect(new Set(tids).size).toBe(tids.length); // 중복 없음
    expect(second.items[0].tid).toBe('VT-0011'); // 앞에 하나 생겨도 밀리지 않는다(offset 10이면 VT-0010이 다시 나온다)
    expect(tids).toContain('VT-0015A');
    expect(tids).not.toContain('VT-0004A'); // 이미 지나간 자리에 생긴 것은 이번 스캔에 없다(다음 스캔에서 본다)
  });

  it('시리얼 조회(재검증용)와 tid 단건, 없으면 빈 목록·404', async () => {
    await seed(regs(3));
    expect(await page('?serialNo=SN-0002')).toMatchObject({ items: [{ tid: 'VT-0002', serialNo: 'SN-0002' }], nextCursor: null });
    expect(await page('?serialNo=SN-9999')).toEqual({ items: [], nextCursor: null });
    const one = await fetch(`${p.base}/bridgevan/v1/terminals/VT-0003`);
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ tid: 'VT-0003', serialNo: 'SN-0003', status: 'ACTIVE' });
    expect((await fetch(`${p.base}/bridgevan/v1/terminals/VT-9999`)).status).toBe(404);
    expect((await p.stats()).calls).toMatchObject({ 'bridgevan.list': 2, 'bridgevan.get': 2 });
  });

  it('limit이 범위 밖이거나 커서가 깨졌으면 400', async () => {
    await seed(regs(3));
    expect((await list('?limit=0')).status).toBe(400);
    expect((await list('?limit=1001')).status).toBe(400);
    expect((await list('?limit=abc')).status).toBe(400);
    const bad = await list('?cursor=%%%');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'INVALID_CURSOR' });
  });

  it('스캔 도중 변경: 둘째 페이지부터 요청마다 이미 지나간 등록 n건이 바뀐다(healTo가 있으면 그 값으로, 없으면 ACTIVE↔SUSPENDED). 시드가 같으면 같다', async () => {
    // 홀수 번호는 SUSPENDED로 심고 healTo ACTIVE(곧 풀릴 어긋남)
    const registeredAt = '2026-01-01T00:00:00.000Z';
    const seeded = regs(20, (i) => ({ registeredAt, ...(i % 2 === 1 ? { status: 'SUSPENDED', healTo: { status: 'ACTIVE' } } : {}) }));
    const run = async () => {
      await p.reset();
      await p.configure({ seed: 7, bridgevan: { mutateDuringScan: 3 } });
      await seed(seeded);
      const first = await page('?limit=10');
      await page(`?limit=10&cursor=${first.nextCursor}`);
      // 바뀐 등록만 골라 본다(updatedAt이 registeredAt과 다름)
      const after = (await scanAllNoMutate()).filter((r) => r.updatedAt !== r.registeredAt);
      return { first, after, stats: await p.stats() };
    };
    const scanAllNoMutate = async () => {
      const out: Item[] = [];
      for (const r of seeded) out.push(...(await page(`?serialNo=${r.serialNo}`)).items);
      return out;
    };
    const a = await run();
    expect(a.stats.vanMutated).toBe(3);
    expect(a.after.length).toBeGreaterThan(0);
    // 바뀐 것은 모두 첫 페이지(이미 지나간 자리)에 있던 등록이다
    const firstTids = new Set(a.first.items.map((r) => r.tid));
    for (const r of a.after) expect(firstTids.has(r.tid)).toBe(true);
    // healTo가 있던(홀수) 등록은 ACTIVE로 고쳐졌다
    for (const r of a.after.filter((r) => Number(r.tid.slice(3)) % 2 === 1)) expect(r.status).toBe('ACTIVE');
    expect(a.stats.vanHealed).toBe(a.after.filter((r) => Number(r.tid.slice(3)) % 2 === 1).length);
    // 같은 시드면 같은 등록이 같은 값으로 바뀐다
    const b = await run();
    expect(b.after.map((r) => [r.tid, r.status])).toEqual(a.after.map((r) => [r.tid, r.status]));
  });

  it('429(Retry-After)·503 골칫거리', async () => {
    await seed(regs(3));
    await p.configure({ bridgevan: { force429Rate: 1, retryAfterSec: 2 } });
    const limited = await list('?limit=10');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('2');
    await p.configure({ bridgevan: { force429Rate: 0, error5xxRate: 1 } });
    expect((await list('?limit=10')).status).toBe(503);
    expect((await fetch(`${p.base}/bridgevan/v1/terminals/VT-0001`)).status).toBe(503);
  });

  it('심기: 필드가 틀렸거나 tid·시리얼이 겹치면 400이고 기존 등록은 그대로', async () => {
    await seed(regs(2));
    expect((await seed([{ tid: 'X', serialNo: 'Y', merchantCode: 'Z', status: 'WRONG' }])).status).toBe(400);
    const dup = await seed([...regs(1), { tid: 'VT-0009', serialNo: 'SN-0001', merchantCode: 'Z', status: 'ACTIVE' }]);
    expect(dup.status).toBe(400);
    expect((await dup.json()).error).toBe('DUPLICATE');
    expect((await scanAll(10)).seen.map((r) => r.tid)).toEqual(['VT-0001', 'VT-0002']);
  });

  it('심기: 객체가 아닌 항목, healTo가 null·객체 아님, merchantCode·healTo.merchantCode가 글자 아님, registeredAt이 날짜 아님이면 400', async () => {
    await seed(regs(2));
    const ok = { tid: 'VT-0100', serialNo: 'SN-0100', merchantCode: 'YEOKSAM-CAFE', status: 'ACTIVE' };
    const bad: unknown[] = [
      null,
      'VT-0100',
      42,
      [ok],
      { ...ok, healTo: null },
      { ...ok, healTo: 'ACTIVE' },
      { ...ok, healTo: ['ACTIVE'] },
      { ...ok, healTo: { merchantCode: 7 } },
      { ...ok, merchantCode: 7 },
      { ...ok, registeredAt: 'not-a-date' },
      { ...ok, registeredAt: 1234 },
    ];
    for (const entry of bad) {
      const res = await seed([entry]);
      expect(res.status, JSON.stringify(entry)).toBe(400);
      expect((await res.json()).error).toBe('BAD_REQUEST');
    }
    expect((await scanAll(10)).seen.map((r) => r.tid)).toEqual(['VT-0001', 'VT-0002']);
    // 맞는 registeredAt·healTo는 그대로 받는다
    expect((await seed([{ ...ok, registeredAt: '2026-10-01T00:00:00.000Z', healTo: { merchantCode: 'GANGNAM-KIMBAP' } }])).status).toBe(200);
  });
});
