import { connect } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startPartners, type Partners } from './helpers.js';

interface RequestRow {
  id: number;
  at: string;
  partner: string;
  method: string;
  path: string;
  status: number;
  ms: number;
}

/** 시연 도구가 보는 관리 API(보강 8, decisions/0085): 지금 설정 읽기, 업체가 받은 최근 요청 */
describe('관리 API — 설정 읽기와 최근 요청 기록', () => {
  let p: Partners;
  const requests = async (query = '') => (await fetch(`${p.base}/__admin/requests${query}`)).json() as Promise<{ total: number; items: RequestRow[] }>;

  beforeAll(async () => {
    p = await startPartners();
  });
  beforeEach(async () => {
    await p.reset();
  });
  afterAll(() => p.close());

  it('GET /__admin/config는 지금 설정(POST와 같은 모양)', async () => {
    await p.configure({ bungae: { force429Rate: 0.3 } });
    const res = await fetch(`${p.base}/__admin/config`);
    expect(res.status).toBe(200);
    const config = await res.json();
    expect(config.bungae.force429Rate).toBe(0.3);
    expect(Object.keys(config).sort()).toEqual(['bridgevan', 'bungae', 'neurimbo', 'seed', 'seum', 'toktok']);
  });

  it('업체 요청은 최근부터 남고(업체·메서드·쿼리 포함 경로·상태·시간), 관리 API는 남지 않는다', async () => {
    await fetch(`${p.base}/bungae/v1/trackings/NOPE-1`);
    await fetch(`${p.base}/neurimbo/api/track?invoiceNo=X1`);
    await fetch(`${p.base}/nowhere`);
    await fetch(`${p.base}/__admin/stats`);
    const page = await requests();
    expect(page.total).toBe(3);
    expect(page.items.map((r) => [r.partner, r.method, r.path])).toEqual([
      ['nowhere', 'GET', '/nowhere'],
      ['neurimbo', 'GET', '/neurimbo/api/track?invoiceNo=X1'],
      ['bungae', 'GET', '/bungae/v1/trackings/NOPE-1'],
    ]);
    expect(page.items[2].status).toBe(404);
    expect(page.items[0].id).toBeGreaterThan(page.items[1].id);
    expect(page.items.every((r) => r.ms >= 0 && !Number.isNaN(Date.parse(r.at)))).toBe(true);
  });

  it('장애 손잡이로 낸 429도 그대로 남는다', async () => {
    await p.configure({ bungae: { force429Rate: 1 } });
    await fetch(`${p.base}/bungae/v1/trackings/ANY`);
    expect((await requests()).items[0].status).toBe(429);
  });

  it('limit: 기본 50·최대 200, 틀리면 400. 고리는 200개만 남긴다(total은 받은 수 전부)', async () => {
    for (let i = 0; i < 205; i += 1) await fetch(`${p.base}/nowhere/${i}`);
    expect((await requests()).items).toHaveLength(50);
    const all = await requests('?limit=200');
    expect(all.total).toBe(205);
    expect(all.items).toHaveLength(200);
    expect(all.items[0].path).toBe('/nowhere/204');
    expect(all.items.at(-1)!.path).toBe('/nowhere/5');
    for (const bad of ['0', '201', 'x', '1.5']) expect((await fetch(`${p.base}/__admin/requests?limit=${bad}`)).status, bad).toBe(400);
  });

  it('?partner=로 서버에서 거른다(최근 limit개를 자른 뒤가 아니라 거른 뒤에 자른다 — 최종 검토)', async () => {
    await fetch(`${p.base}/seum/v1/purchase-orders/NOPE/delivery-note`);
    for (let i = 0; i < 5; i += 1) await fetch(`${p.base}/bungae/v1/trackings/T${i}`);
    const seum = await requests('?partner=seum&limit=3');
    expect(seum.items.map((r) => r.partner)).toEqual(['seum']);
    expect(seum.total).toBe(6);
  });

  it('응답 전에 끊긴 요청도 남는다(상태 0) — 지연 손잡이를 켠 장면(최종 검토)', async () => {
    await p.configure({ toktok: { delayMs: 300 } });
    const controller = new AbortController();
    const body = JSON.stringify({ idempotencyKey: 'slow-1', text: '늦은 응답' });
    const pending = fetch(`${p.base}/toktok/hooks/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal }).catch(() => 'aborted');
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    expect(await pending).toBe('aborted');
    await new Promise((r) => setTimeout(r, 400));
    expect((await requests()).items[0]).toMatchObject({ partner: 'toktok', path: '/toktok/hooks/ops', status: 0 });
  });

  it('주소가 깨진 요청에도 서버가 죽지 않는다(기록은 업체 이름 없이)', async () => {
    await new Promise<void>((resolve, reject) => {
      const port = Number(new URL(p.base).port);
      const socket = connect(port, '127.0.0.1', () => socket.write('GET http://[bad HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
      socket.on('data', () => undefined);
      socket.on('close', () => resolve());
      socket.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect((await fetch(`${p.base}/__admin/health`)).status).toBe(200);
    expect((await requests()).items[0]).toMatchObject({ partner: '', path: 'http://[bad' });
  });

  it('reset은 기록도 비운다', async () => {
    await fetch(`${p.base}/nowhere`);
    await p.reset();
    expect(await requests()).toEqual({ total: 0, items: [] });
  });
});
