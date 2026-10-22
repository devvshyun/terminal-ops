import { XMLParser } from 'fast-xml-parser';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toKstCompact } from '../src/neurimbo.js';
import { startPartners, type Partners } from './helpers.js';

const parser = new XMLParser({ parseTagValue: false, ignoreDeclaration: true, isArray: (name) => name === 'item' });

describe('느림보물류', () => {
  let p: Partners;

  async function invoice(): Promise<string> {
    const res = await fetch(`${p.base}/neurimbo/api/invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml' },
      body: '<invoice><receiver>역삼카페</receiver><address>서울 강남구 가상로 2</address><reference>SHIP-2</reference></invoice>',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    return parser.parse(await res.text()).invoice.invoiceNo;
  }
  async function track(no: string) {
    const res = await fetch(`${p.base}/neurimbo/api/track?invoiceNo=${no}`);
    return { status: res.status, body: parser.parse(await res.text()) };
  }

  beforeAll(async () => {
    p = await startPartners();
  });
  beforeEach(async () => {
    await p.reset();
  });
  afterAll(() => p.close());

  it('KST 시각 형식 yyyyMMddHHmmss', () => {
    expect(toKstCompact(Date.UTC(2026, 9, 22, 15, 30, 5))).toBe('20261023003005');
  });

  it('송장 번호는 NR로 시작한다', async () => {
    expect(await invoice()).toMatch(/^NR\d+$/);
  });

  it('reference가 없으면 400', async () => {
    const res = await fetch(`${p.base}/neurimbo/api/invoice`, { method: 'POST', body: '<invoice></invoice>' });
    expect(res.status).toBe(400);
  });

  it('조회할 때마다 한 단계씩, 4번째에 40(배송 완료)', async () => {
    const no = await invoice();
    let last;
    for (let i = 0; i < 4; i++) last = await track(no);
    expect(last!.status).toBe(200);
    expect(last!.body.trace.invoiceNo).toBe(no);
    expect(last!.body.trace.item.map((i: { statusCd: string }) => i.statusCd)).toEqual(['10', '20', '30', '40']);
    expect(last!.body.trace.item[0]).toEqual({ seq: '1', statusCd: '10', statusTime: expect.stringMatching(/^\d{14}$/) });
  });

  it('error5xxRate=1이면 송장 발급도 503', async () => {
    await p.configure({ neurimbo: { error5xxRate: 1 } });
    const res = await fetch(`${p.base}/neurimbo/api/invoice`, { method: 'POST', body: '<invoice><reference>R</reference></invoice>' });
    expect(res.status).toBe(503);
  });

  it('error5xxRate=1이면 503, 진행하지 않는다', async () => {
    const no = await invoice();
    await p.configure({ neurimbo: { error5xxRate: 1 } });
    expect((await track(no)).status).toBe(503);
    await p.configure({ neurimbo: { error5xxRate: 0 } });
    expect((await track(no)).body.trace.item).toHaveLength(1);
    expect((await p.stats()).status5xx).toBe(1);
  });

  it('delayMs만큼 늦게 응답한다', async () => {
    await p.configure({ neurimbo: { delayMs: 200 } });
    const no = await invoice();
    const started = performance.now();
    await track(no);
    expect(performance.now() - started).toBeGreaterThanOrEqual(190);
  });

  it('shuffle이면 순서가 섞여 오지만 seq 집합은 같다', async () => {
    await p.configure({ neurimbo: { shuffle: true, advancePerPoll: 4 } });
    const no = await invoice();
    const orders: string[] = [];
    for (let i = 0; i < 10; i++) {
      const items = (await track(no)).body.trace.item as { seq: string }[];
      expect(items.map((x) => x.seq).sort()).toEqual(['1', '2', '3', '4']);
      orders.push(items.map((x) => x.seq).join(''));
    }
    expect(orders.some((o) => o !== '1234')).toBe(true);
  });

  it('없는 송장은 404', async () => {
    expect((await track('NR000')).status).toBe(404);
  });
});
