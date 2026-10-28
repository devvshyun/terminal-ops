import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServiceTicket } from '../src/service/service-ticket.entity.js';
import { createAccount, login, withCookie } from './helpers/auth.js';
import { partners } from './helpers/partners.js';
import { prepareInService, registerInStock, transitionTo } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

describe('가맹점주 범위 /me (보강 2, decisions/0053)', () => {
  let t: TestApp;
  let gangnam: string;
  let yeoksam: string;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await partners.reset();
    await prepareInService(t, 'ME-0001', 'GANGNAM-KIMBAP');
    await prepareInService(t, 'ME-0002', 'GANGNAM-KIMBAP');
    await prepareInService(t, 'ME-0003', 'YEOKSAM-CAFE');
    await registerInStock(t, 'ME-0101');
    await createAccount(t, 'owner-gangnam', 'MERCHANT', 'GANGNAM-KIMBAP');
    await createAccount(t, 'owner-yeoksam', 'MERCHANT', 'YEOKSAM-CAFE');
    gangnam = await login(t, 'owner-gangnam');
    yeoksam = await login(t, 'owner-yeoksam');
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('로그인하면 내 정보에 가맹점 코드가 있다', async () => {
    expect((await withCookie(t, gangnam).get('/auth/me')).body).toMatchObject({ role: 'MERCHANT', merchantCode: 'GANGNAM-KIMBAP' });
  });

  it('단말기 목록은 내 가맹점 것만. 가맹점 조건을 보내면 400(바꿀 수 없다)', async () => {
    const res = await withCookie(t, gangnam).get('/me/terminals');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { serialNo: string }) => i.serialNo).sort()).toEqual(['ME-0001', 'ME-0002']);
    expect(res.body.total).toBe(2);
    expect((await withCookie(t, gangnam).get('/me/terminals').query({ merchantCode: 'YEOKSAM-CAFE' })).status).toBe(400);
    expect((await withCookie(t, yeoksam).get('/me/terminals')).body.items.map((i: { serialNo: string }) => i.serialNo)).toEqual(['ME-0003']);
  });

  it('남의 단말기·재고 단말기 상세는 404(있는지도 알려 주지 않는다)', async () => {
    expect((await withCookie(t, gangnam).get('/me/terminals/ME-0001')).body).toMatchObject({ serialNo: 'ME-0001', merchantCode: 'GANGNAM-KIMBAP' });
    const other = await withCookie(t, gangnam).get('/me/terminals/ME-0003');
    expect(other.status).toBe(404);
    expect(other.body.message).toBe('단말기 ME-0003이(가) 없습니다.');
    expect((await withCookie(t, gangnam).get('/me/terminals/ME-0101')).status).toBe(404);
    expect((await withCookie(t, gangnam).get('/me/terminals/NOPE-1')).body.message).toBe('단말기 NOPE-1이(가) 없습니다.');
  });

  it('가맹점주는 일반 업무 API를 부를 수 없다(403)', async () => {
    for (const path of ['/terminals', '/terminals/ME-0001', '/service-tickets', '/dashboard/summary', '/merchants']) {
      expect((await withCookie(t, gangnam).get(path)).status, path).toBe(403);
    }
    expect((await withCookie(t, gangnam).post('/service-tickets').send({ serialNo: 'ME-0001', symptom: 'x' })).status).toBe(403);
  });

  it('운영자 등 다른 역할은 /me를 부를 수 없다(403)', async () => {
    expect((await t.http().get('/me/terminals')).status).toBe(403);
  });

  it('A/S 접수는 내 단말기만 — 남의 단말기는 404이고 접수가 생기지 않는다. 저장된 openedBy는 가맹점주 아이디, 응답은 openedByMe', async () => {
    const mine = await withCookie(t, gangnam).post('/me/service-tickets').send({ serialNo: 'ME-0001', symptom: '카드 인식 불가' });
    expect(mine.status).toBe(201);
    expect(mine.body).toMatchObject({ serialNo: 'ME-0001', merchantCode: 'GANGNAM-KIMBAP', status: 'OPEN', openedByMe: true });
    expect((await t.http().get(`/service-tickets/${mine.body.id}`)).body.openedBy).toBe('owner-gangnam');
    const other = await withCookie(t, gangnam).post('/me/service-tickets').send({ serialNo: 'ME-0003', symptom: '남의 것' });
    expect(other.status).toBe(404);
    expect(await t.orm.em.fork().count(ServiceTicket, { terminal: { serialNo: 'ME-0003' } })).toBe(0);
  });

  it('접수 목록은 내 가맹점 것만', async () => {
    await withCookie(t, yeoksam).post('/me/service-tickets').send({ serialNo: 'ME-0003', symptom: '화면 꺼짐' });
    const g = await withCookie(t, gangnam).get('/me/service-tickets');
    const y = await withCookie(t, yeoksam).get('/me/service-tickets');
    expect(g.body.items.map((i: { serialNo: string }) => i.serialNo)).toEqual(['ME-0001']);
    expect(y.body.items.map((i: { serialNo: string }) => i.serialNo)).toEqual(['ME-0003']);
  });

  it('설치 확인은 내 가맹점 접수만 — 남의 접수는 404, 내 것은 CLOSED이고 이력 actor가 가맹점주 아이디', async () => {
    const id = (await withCookie(t, gangnam).get('/me/service-tickets')).body.items[0].id as number;
    const replaced = await t.http().post(`/service-tickets/${id}/replacements`).send({ replacementSerialNo: 'ME-0101', carrier: 'BUNGAE' });
    expect(replaced.status).toBe(201);
    await transitionTo(t, 'ME-0101', 'DELIVERED', '배송 완료(수동)');

    expect((await withCookie(t, yeoksam).post(`/me/service-tickets/${id}/installations`)).status).toBe(404);
    expect((await t.http().get(`/service-tickets/${id}`)).body.status).toBe('REPLACING');

    const done = await withCookie(t, gangnam).post(`/me/service-tickets/${id}/installations`);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('CLOSED');
    const history = (await t.http().get('/terminals/ME-0101/history')).body;
    expect(history.at(-1)).toMatchObject({ toStatus: 'IN_SERVICE', actor: 'owner-gangnam', source: 'SERVICE' });
  });

  it('/me 접수 응답은 직원 로그인 아이디(openedBy)와 내부 원격 점검 메모(remoteNote)를 주지 않는다(decisions/0053)', async () => {
    const staff = await t.http().post('/service-tickets').set({ 'X-Operator': 'staff-kim' }).send({ serialNo: 'ME-0002', symptom: '본사 접수' });
    expect(staff.status).toBe(201);
    const note = await t.http().post(`/service-tickets/${staff.body.id}/remote-checks`).send({ resolved: false, note: '내부 메모: 기사 배정 보류' });
    expect(note.status).toBeLessThan(300);
    const list = await withCookie(t, gangnam).get('/me/service-tickets');
    const item = list.body.items.find((i: { id: number }) => i.id === staff.body.id);
    expect(item).toMatchObject({ serialNo: 'ME-0002', openedByMe: false });
    for (const body of [item, ...list.body.items]) {
      expect(body).not.toHaveProperty('openedBy');
      expect(body).not.toHaveProperty('remoteNote');
    }
    expect(JSON.stringify(list.body)).not.toContain('staff-kim');
    expect(JSON.stringify(list.body)).not.toContain('내부 메모');
  });
});
