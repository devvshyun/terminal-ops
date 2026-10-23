import { expect } from 'vitest';
import { partners } from './partners.js';
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

/** 배정된 단말기를 출고한다. */
export async function shipWith(t: TestApp, serialNo: string, carrier: 'BUNGAE' | 'NEURIMBO') {
  const version = (await t.http().get(`/terminals/${serialNo}`)).body.version;
  const res = await t.http().post('/shipments').set(SCENARIO_OP).send({ serialNo, carrier, expectedVersion: version });
  expect(res.status).toBe(201);
  return { shipmentId: res.body.id as number, trackingNo: res.body.trackingNo as string };
}

/** 발주를 내고 공장의 납품 명세(시리얼 목록)를 함께 돌려준다. partners 설정(shortfall 등)은 미리 해 둔다. */
export async function orderPurchase(t: TestApp, quantity: number, modelCode = 'SN-100') {
  const res = await t.http().post('/purchase-orders').set(SCENARIO_OP).send({ modelCode, quantity });
  expect(res.status).toBe(201);
  const poNo = res.body.poNo as string;
  return { poNo, serials: (await partners.deliveryNote(poNo)).serials };
}

/** 등록부터 출고까지 한 번에. 수집 테스트·실험 준비용 */
export async function prepareShipped(t: TestApp, serialNo: string, carrier: 'BUNGAE' | 'NEURIMBO') {
  await registerInStock(t, serialNo);
  await allocateTo(t, serialNo);
  return shipWith(t, serialNo, carrier);
}

/** 일반 전이 API(MANUAL)로 한 단계 바꾼다. 현재 version을 돌려준다. */
export async function transitionTo(t: TestApp, serialNo: string, to: string, reason: string): Promise<number> {
  const version = (await t.http().get(`/terminals/${serialNo}`)).body.version;
  const res = await t.http().post(`/terminals/${serialNo}/transitions`).set(SCENARIO_OP).send({ to, reason, expectedVersion: version });
  expect(res.status).toBe(200);
  return res.body.version;
}

/** 가맹점에서 운영 중(IN_SERVICE)인 단말기를 만든다: 재고 → 배정 → 출고 → 배송 완료(수동) → 설치 확인(수동) */
export async function prepareInService(t: TestApp, serialNo: string, merchantCode = 'GANGNAM-KIMBAP'): Promise<number> {
  await registerInStock(t, serialNo);
  await allocateTo(t, serialNo, merchantCode);
  await shipWith(t, serialNo, 'BUNGAE');
  await transitionTo(t, serialNo, 'DELIVERED', 'delivered');
  return transitionTo(t, serialNo, 'IN_SERVICE', 'installed');
}
