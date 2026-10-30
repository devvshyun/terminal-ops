import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoSerial, IN_SERVICE_COUNT, runScenario } from '../src/db/scenario.js';
import { createAccount, login, TEST_PASSWORD, withCookie } from './helpers/auth.js';
import { partners } from './helpers/partners.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';
import { TEST_PARTNERS_URL } from './partners-url.js';

/**
 * 시연 데이터(보강 9, decisions/0089)가 실제 HTTP API로 끝까지 돌고, 두 번째 실행은 건너뛴다.
 * 테스트 앱을 포트로 띄워 스크립트가 진짜 HTTP로 부르게 한다(supertest가 아니라 fetch). 시뮬레이터는 넘긴다(simUrl 없음).
 */
describe('시연 데이터 시나리오', () => {
  let t: TestApp;
  let base: string;
  const logins = { admin: { loginId: 'scn-admin', password: TEST_PASSWORD }, operator: { loginId: 'scn-op', password: TEST_PASSWORD } };

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await partners.reset();
    await createAccount(t, 'scn-admin', 'ADMIN');
    await createAccount(t, 'scn-op', 'OPERATOR');
    await t.app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('처음 실행: 운영 중 12대·재고·입고·배정·배송 중·A/S·발주·펌웨어·VAN·외부 업체가 생긴다', async () => {
    const lines: string[] = [];
    const result = await runScenario({ apiUrl: base, partnersUrl: TEST_PARTNERS_URL, logins, log: (l) => lines.push(l) });
    expect(result.skipped).toBe(false);
    if (result.skipped) return;
    expect(result.inService).toHaveLength(IN_SERVICE_COUNT);

    const op = await login(t, 'scn-op');
    const status = async (n: number) => (await withCookie(t, op).get(`/terminals/${demoSerial(n)}`)).body.status as string;
    expect(await status(1)).toBe('IN_SERVICE');
    expect(await status(12)).toBe('IN_SERVICE');
    expect(await status(13)).toBe('SHIPPED'); // 재고 첫 대 → A/S 교체품으로 출고
    expect([await status(14), await status(15)]).toEqual(['IN_STOCK', 'IN_STOCK']);
    expect([await status(16), await status(17)]).toEqual(['RECEIVED', 'RECEIVED']);
    expect(await status(18)).toBe('ALLOCATED');
    expect([await status(19), await status(20)]).toEqual(['SHIPPED', 'SHIPPED']);
    // 진행 줄과 마지막 요약이 실제 상태와 같다 — 교체품(DM-0013)은 재고가 아니라 배송 중(2026-10-30 리허설: 진행 줄 "재고 3 · 배송 중 2", 요약 shipping 2)
    expect(result.summary).toMatchObject({ inService: 12, inStock: 2, received: 2, allocated: 1, shipping: 3 });
    expect(lines).toContain('재고 2 · 입고 2 · 배정 1 · 배송 중 3(교체품 포함)');

    const tickets = (await withCookie(t, op).get('/service-tickets')).body.items as { status: string }[];
    expect(tickets.map((x) => x.status).sort()).toEqual(['OPEN', 'REPLACING']);
    const pos = (await withCookie(t, op).get('/purchase-orders')).body.items as { quantity: number }[];
    expect(pos.map((p) => p.quantity)).toEqual([10]);
    const admin = await login(t, 'scn-admin');
    expect(((await withCookie(t, admin).get('/admin/partners')).body as { code: string }[]).map((p) => p.code)).toContain('HANOL-POS');
    // 세움전자 덜 보내기는 발주 뒤 되돌린다(다른 시연 단계에 남지 않게)
    expect((await partners.config()).seum.shortfall).toBe(0);
    expect(lines.join('\n')).not.toMatch(/pk_[a-z0-9]{8}_/); // 키 원문을 출력하지 않는다
  }, 120_000);

  it('두 번째 실행은 건너뛰되, 메모리에만 있는 가상 업체 상태(브릿지VAN 등록)는 다시 맞춘다 — 묶음을 down/up하면 업체 서버가 비어 있다(최종 검토)', async () => {
    await partners.reset();
    expect(await runScenario({ apiUrl: base, partnersUrl: TEST_PARTNERS_URL, logins, log: () => undefined })).toEqual({ skipped: true });
    const van = (await (await fetch(`${TEST_PARTNERS_URL}/bridgevan/v1/terminals?limit=100`)).json()) as { items: unknown[] };
    expect(van.items).toHaveLength(10);
  });

  it('외부 업체는 있는데 키가 없으면(마지막 단계에서 멈춤) 건너뛰지 않고 멈춘다', async () => {
    const admin = await login(t, 'scn-admin');
    const keys = (await withCookie(t, admin).get('/admin/partner-keys')).body as { id: number; partnerCode: string }[];
    for (const k of keys.filter((x) => x.partnerCode === 'HANOL-POS')) await t.orm.em.fork().getConnection().execute('delete from partner_api_key where id = ?', [k.id]);
    await expect(runScenario({ apiUrl: base, partnersUrl: TEST_PARTNERS_URL, logins, log: () => undefined })).rejects.toThrow(/도중에 멈춘/);
  });
});
