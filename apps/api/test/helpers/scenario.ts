import { expect } from 'vitest';
import type { TestApp } from './test-app.js';

/** 시나리오 준비용 작업자 */
export const SCENARIO_OP = { 'X-Operator': 'scenario' };
const SN100_PASS = ['POWER', 'NETWORK', 'CARD_READER', 'PRINTER'].map((itemCode) => ({ itemCode, passed: true }));

/** 실제 API로 등록 → 검수 합격 → 재고까지 만든다. 현재 version을 돌려준다. */
export async function registerInStock(t: TestApp, serialNo: string): Promise<number> {
  expect((await t.http().post('/terminals').set(SCENARIO_OP).send({ serialNo, modelCode: 'SN-100' })).status).toBe(201);
  const inspected = await t.http().post(`/terminals/${serialNo}/inspections`).set(SCENARIO_OP).send({ results: SN100_PASS });
  expect(inspected.status).toBe(201);
  const stocked = await t
    .http()
    .post(`/terminals/${serialNo}/transitions`)
    .set(SCENARIO_OP)
    .send({ to: 'IN_STOCK', reason: '재고 편입', expectedVersion: inspected.body.terminal.version });
  expect(stocked.status).toBe(200);
  return stocked.body.version;
}

/** 재고 단말기를 가맹점에 배정한다. 현재 version을 돌려준다. */
export async function allocateTo(t: TestApp, serialNo: string, merchantCode = 'GANGNAM-KIMBAP'): Promise<number> {
  const version = (await t.http().get(`/terminals/${serialNo}`)).body.version;
  const res = await t.http().post(`/terminals/${serialNo}/allocations`).set(SCENARIO_OP).send({ merchantCode, expectedVersion: version });
  expect(res.status).toBe(201);
  return res.body.version;
}
