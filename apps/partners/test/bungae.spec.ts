import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRng } from '../src/rng.js';
import { startPartners, type Partners } from './helpers.js';

describe('난수', () => {
  it('같은 시드면 같은 값이 나온다', () => {
    const a = createRng(7);
    const b = createRng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('관리 API', () => {
  let p: Partners;
  beforeAll(async () => {
    p = await startPartners();
  });
  afterAll(() => p.close());

  it('health', async () => {
    expect(await (await fetch(`${p.base}/__admin/health`)).json()).toEqual({ status: 'ok' });
  });

  it('config는 부분 병합하고 reset은 기본값으로 돌린다', async () => {
    const merged = await (await p.configure({ bungae: { duplicateRate: 0.5 } })).json();
    expect(merged.bungae).toMatchObject({ duplicateRate: 0.5, advancePerPoll: 1, rateLimitPerSec: 20 });
    const reset = await (await p.reset()).json();
    expect(reset.bungae.duplicateRate).toBe(0);
  });

  it('모르는 경로는 404', async () => {
    expect((await fetch(`${p.base}/nope`)).status).toBe(404);
  });
});

describe('번개택배', () => {
  let p: Partners;

  async function waybill(reference = 'SHIP-1'): Promise<string> {
    const res = await fetch(`${p.base}/bungae/v1/waybills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiverName: '강남김밥', address: '서울 강남구 가상로 1', reference }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).trackingNo;
  }
  const track = (no: string) => fetch(`${p.base}/bungae/v1/trackings/${no}`);

  beforeAll(async () => {
    p = await startPartners();
  });
  beforeEach(async () => {
    await p.reset();
  });
  afterAll(() => p.close());

  it('운송장 번호는 BG로 시작하고 매번 다르다', async () => {
    const a = await waybill();
    const b = await waybill();
    expect(a).toMatch(/^BG\d+$/);
    expect(a).not.toBe(b);
  });

  it('reference가 없으면 400', async () => {
    const res = await fetch(`${p.base}/bungae/v1/waybills`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(400);
  });

  it('조회할 때마다 한 단계씩 진행해 4번째에 DELIVERED', async () => {
    const no = await waybill();
    const codes: string[][] = [];
    for (let i = 0; i < 5; i++) {
      const body = await (await track(no)).json();
      codes.push(body.events.map((e: { code: string }) => e.code));
    }
    expect(codes[0]).toEqual(['PICKED_UP']);
    expect(codes[3]).toEqual(['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED']);
    expect(codes[4]).toEqual(codes[3]);
  });

  it('이벤트에는 eventId와 ISO 시각이 있다', async () => {
    const no = await waybill();
    const body = await (await track(no)).json();
    expect(body.trackingNo).toBe(no);
    expect(body.events[0]).toEqual({ eventId: `${no}-1`, code: 'PICKED_UP', occurredAt: expect.stringMatching(/Z$/) });
  });

  it('advancePerPoll=4면 첫 조회에 DELIVERED', async () => {
    await p.configure({ bungae: { advancePerPoll: 4 } });
    const no = await waybill();
    const body = await (await track(no)).json();
    expect(body.events.at(-1).code).toBe('DELIVERED');
  });

  it('duplicateRate=1이면 모든 이벤트가 두 번씩 온다', async () => {
    await p.configure({ bungae: { duplicateRate: 1, advancePerPoll: 4 } });
    const no = await waybill();
    const body = await (await track(no)).json();
    expect(body.events).toHaveLength(8);
    expect(new Set(body.events.map((e: { eventId: string }) => e.eventId)).size).toBe(4);
  });

  it('없는 운송장은 404', async () => {
    expect((await track('BG000')).status).toBe(404);
  });

  it('초당 한도를 넘으면 429 + Retry-After, 그 조회는 진행하지 않는다', async () => {
    await p.configure({ bungae: { rateLimitPerSec: 2 } });
    const no = await waybill();
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await track(no)).status);
    expect(statuses).toEqual([200, 200, 429]);
    const limited = await track(no);
    expect(limited.headers.get('retry-after')).toBe('1');

    await new Promise((r) => setTimeout(r, 1100));
    const body = await (await track(no)).json();
    expect(body.events).toHaveLength(3); // 성공한 조회 3번째
    const stats = await p.stats();
    expect(stats.status429).toBe(2);
    expect(stats.status429Limit).toBe(2);
    expect(stats.status429Forced).toBe(0);
    expect(stats.calls['bungae.track']).toBe(5);
    expect(stats.perTracking[no]).toBe(5);
  });

  it('force429Rate=1이면 항상 429', async () => {
    await p.configure({ bungae: { force429Rate: 1, retryAfterSec: 2 } });
    const no = await waybill();
    const res = await track(no);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('2');
    const stats = await p.stats();
    expect(stats.status429).toBe(1);
    expect(stats.status429Forced).toBe(1);
    expect(stats.status429Limit).toBe(0);
  });

  it('같은 운송장을 동시에 조회하면 overlaps로 센다', async () => {
    await p.configure({ bungae: { delayMs: 50 } });
    const no = await waybill();
    await Promise.all([track(no), track(no)]);
    const stats = await p.stats();
    expect(stats.overlaps).toBe(1);
    expect(stats.maxInFlight).toBe(2);
  });
});
