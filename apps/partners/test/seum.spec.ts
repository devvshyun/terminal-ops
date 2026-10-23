import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPartners, type Partners } from './helpers.js';

describe('세움전자(공장)', () => {
  let p: Partners;

  async function order(body: Record<string, unknown> = { modelCode: 'SN-100', quantity: 5, reference: 'PO-REF-1' }) {
    return fetch(`${p.base}/seum/v1/purchase-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  async function note(poNo: string) {
    return fetch(`${p.base}/seum/v1/purchase-orders/${encodeURIComponent(poNo)}/delivery-note`);
  }
  async function orderAndNote(quantity = 5) {
    const { poNo } = await (await order({ modelCode: 'SN-100', quantity, reference: `REF-${quantity}` })).json();
    return (await (await note(poNo)).json()) as { poNo: string; modelCode: string; quantity: number; serials: string[] };
  }

  beforeAll(async () => {
    p = await startPartners();
  });
  beforeEach(async () => {
    await p.reset();
  });
  afterAll(() => p.close());

  it('발주하면 SE 발주번호를 주고, 납품 명세는 발주 수량만큼의 서로 다른 시리얼이다', async () => {
    const res = await order();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ modelCode: 'SN-100', quantity: 5 });
    expect(body.poNo).toMatch(/^SE\d+$/);

    const dn = await note(body.poNo);
    expect(dn.status).toBe(200);
    const { serials, ...rest } = await dn.json();
    expect(rest).toEqual({ poNo: body.poNo, modelCode: 'SN-100', quantity: 5 });
    expect(serials).toHaveLength(5);
    expect(new Set(serials).size).toBe(5);
    for (const s of serials) expect(s).toMatch(new RegExp(`^${body.poNo}-\\d{4}$`));
    // 우리 API의 시리얼 형식(대문자·숫자·하이픈 4~32자)에 맞는다.
    for (const s of serials) expect(s).toMatch(/^[A-Z0-9-]{4,32}$/);
  });

  it('명세는 몇 번을 조회해도 같다', async () => {
    const { poNo } = await (await order()).json();
    const a = await (await note(poNo)).json();
    const b = await (await note(poNo)).json();
    expect(b).toEqual(a);
  });

  it('골칫거리 shortfall: 발주보다 n대 적게 납품한다', async () => {
    await p.configure({ seum: { shortfall: 2 } });
    const dn = await orderAndNote(5);
    expect(dn.quantity).toBe(5);
    expect(dn.serials).toHaveLength(3);
  });

  it('골칫거리 foreignSerials: 다른 발주의 시리얼이 섞이고, 같은 시드면 같은 자리에 섞인다', async () => {
    const positions = async () => {
      await p.reset();
      await p.configure({ seed: 7, seum: { foreignSerials: 3 } });
      const dn = await orderAndNote(10);
      expect(dn.serials).toHaveLength(13);
      const foreign = dn.serials.flatMap((s, i) => (s.startsWith(`${dn.poNo}-`) ? [] : [i]));
      expect(foreign).toHaveLength(3);
      for (const i of foreign) expect(dn.serials[i]).toMatch(/^SE\d+-\d{4}$/);
      return foreign;
    };
    expect(await positions()).toEqual(await positions());
  });

  it('호출 수를 센다', async () => {
    const { poNo } = await (await order()).json();
    await note(poNo);
    await note(poNo);
    const stats = await p.stats();
    expect(stats.calls['seum.purchaseOrder']).toBe(1);
    expect(stats.calls['seum.deliveryNote']).toBe(2);
  });

  it('없는 발주의 명세는 404, 본문이 틀리면 400', async () => {
    expect((await note('SE0')).status).toBe(404);
    expect((await order({ modelCode: 'SN-100', quantity: 0, reference: 'x' })).status).toBe(400);
    expect((await order({ modelCode: '', quantity: 1, reference: 'x' })).status).toBe(400);
    expect((await order({ modelCode: 'SN-100', quantity: 1 })).status).toBe(400);
  });

  it('error5xxRate=1이면 발주가 503', async () => {
    await p.configure({ seum: { error5xxRate: 1 } });
    expect((await order()).status).toBe(503);
  });
});
