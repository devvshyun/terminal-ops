import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { partners } from './helpers/partners.js';
import { prepareInService, registerInStock } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'ahn' };

describe('A/S 접수·원격 점검 (F7)', () => {
  let t: TestApp;
  let firstTicketId: number;
  const open = (serialNo: string, symptom = '카드 인식 불가') => t.http().post('/service-tickets').set(OP).send({ serialNo, symptom });
  const remoteCheck = (id: number, resolved: boolean, note: string) =>
    t.http().post(`/service-tickets/${id}/remote-checks`).set(OP).send({ resolved, note });

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await partners.reset();
    await prepareInService(t, 'AS-0001', 'YEOKSAM-CAFE');
    await prepareInService(t, 'AS-0002');
    await prepareInService(t, 'AS-0003');
    await registerInStock(t, 'AS-0009');
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('운영 중인 단말기만 접수한다. 가맹점은 단말기의 가맹점, 단말기 상태는 그대로', async () => {
    const res = await open('AS-0001');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      serialNo: 'AS-0001',
      merchantCode: 'YEOKSAM-CAFE',
      symptom: '카드 인식 불가',
      status: 'OPEN',
      remoteNote: null,
      replacementSerialNo: null,
      outboundTrackingNo: null,
      openedBy: 'ahn',
      closedAt: null,
    });
    expect((await t.http().get('/terminals/AS-0001')).body.status).toBe('IN_SERVICE');
    firstTicketId = res.body.id;
    expect((await t.http().get(`/service-tickets/${res.body.id}`)).body).toMatchObject({ id: res.body.id, status: 'OPEN' });
  });

  it('운영 중이 아니면 422 TERMINAL_NOT_IN_SERVICE, 없으면 404, 증상이 없으면 400', async () => {
    const notInService = await open('AS-0009');
    expect(notInService.status).toBe(422);
    expect(notInService.body.code).toBe('TERMINAL_NOT_IN_SERVICE');
    expect((await open('AS-9999')).status).toBe(404);
    expect((await open('AS-0002', '   ')).status).toBe(400);
  });

  it('같은 단말기에 열린 접수가 있으면 409 TICKET_ALREADY_OPEN — 동시에 2건이 와도 1건만 접수', async () => {
    const [a, b] = await Promise.all([open('AS-0002', '화면 꺼짐'), open('AS-0002', '화면 꺼짐')]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.code).toBe('TICKET_ALREADY_OPEN');
  });

  it('원격 점검으로 해결되면 RESOLVED_REMOTELY로 종결, 다시 점검하면 422, 같은 단말기를 새로 접수할 수 있다', async () => {
    const ticket = (await open('AS-0003', '영수증 안 나옴')).body;
    const res = await remoteCheck(ticket.id, true, '프린터 설정 초기화로 해결');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'RESOLVED_REMOTELY', remoteNote: '프린터 설정 초기화로 해결' });
    expect(res.body.closedAt).toEqual(expect.any(String));

    const again = await remoteCheck(ticket.id, true, '또');
    expect(again.status).toBe(422);
    expect(again.body.code).toBe('TICKET_NOT_OPEN');
    expect((await open('AS-0003', '다시 고장')).status).toBe(201);
  });

  it('원격 점검으로 안 되면 OPEN 그대로, 메모만 남는다', async () => {
    const res = await remoteCheck(firstTicketId, false, '원격 재부팅해도 카드 인식 불가');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'OPEN', remoteNote: '원격 재부팅해도 카드 인식 불가', closedAt: null });
  });

  it('없는 접수는 404, id가 숫자가 아니면 400', async () => {
    expect((await t.http().get('/service-tickets/9999')).status).toBe(404);
    expect((await t.http().get('/service-tickets/abc')).status).toBe(400);
  });
});
