import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kstDayOf } from '../src/common/kst.js';
import { Inspection } from '../src/inspection/inspection.entities.js';
import { ScanBatch, ScanKind } from '../src/scan/scan-batch.entity.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { createAccount, login, withCookie } from './helpers/auth.js';
import { partners } from './helpers/partners.js';
import { orderPurchase, prepareInService, transitionTo } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const SN100 = ['POWER', 'NETWORK', 'CARD_READER', 'PRINTER'];
const allPass = SN100.map((itemCode) => ({ itemCode, passed: true }));
const oneFail = SN100.map((itemCode) => ({ itemCode, passed: itemCode !== 'PRINTER', ...(itemCode === 'PRINTER' ? { note: '용지 걸림' } : {}) }));

/**
 * 현장 작업자 화면용 API(보강 4, decisions/0063). 스캔·검수는 현장 작업자가 실제 로그인(쿠키)으로 기존 API를 부르고,
 * GET /field/today가 그 사람의 오늘(KST) 일만 세는지 본다. 날짜 경계는 단위 테스트(kst-day.spec.ts)가 본다 —
 * 여기서는 "지금"이 속한 날을 쓰므로 KST 자정에 걸쳐 돌면 어긋날 수 있다(드묾).
 */
describe('현장 작업자 오늘 내 작업 /field/today (보강 4)', () => {
  let t: TestApp;
  let field: string;
  let receive: { poNo: string; serials: string[] };

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await partners.reset();
    await createAccount(t, 'field-kim', 'FIELD');
    await createAccount(t, 'owner-gangnam', 'MERCHANT', 'GANGNAM-KIMBAP');
    field = await login(t, 'field-kim');
    receive = await orderPurchase(t, 3);
    // 회수 입고할 단말기: 운영 중 → 회수 요청 → 회수 중
    await prepareInService(t, 'FLD-RET-1');
    await transitionTo(t, 'FLD-RET-1', 'RETURN_REQUESTED', '회수 요청');
    await transitionTo(t, 'FLD-RET-1', 'RETURNING', '회수 출발');
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('아무것도 안 했으면 오늘 날짜와 0', async () => {
    const res = await withCookie(t, field).get('/field/today');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      date: kstDayOf(new Date()).date,
      scans: { boxes: 0, received: 0, returned: 0, rejected: 0 },
      inspections: { total: 0, passed: 0, failed: 0 },
    });
  });

  it('내가 오늘 처리한 박스·단말기·검수를 센다 — 같은 scanId 다시 보내기는 한 번, 남의 일·어제 일은 빠진다', async () => {
    const [a, b] = receive.serials;
    const box = { scanId: 'BOX-FIELD-0001', kind: 'RECEIVE', poNo: receive.poNo, serials: [a, b, 'bad'] };
    expect((await withCookie(t, field).post('/scans').send(box)).status).toBe(201);
    const again = await withCookie(t, field).post('/scans').send(box);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, actor: 'field-kim' });
    expect((await withCookie(t, field).post('/scans').send({ scanId: 'BOX-FIELD-0002', kind: 'RETURN_IN', serials: ['FLD-RET-1'] })).body.summary).toEqual({
      RETURNED: 1,
    });
    expect((await withCookie(t, field).post(`/terminals/${a}/inspections`).send({ results: allPass })).body).toMatchObject({ passed: true });
    expect((await withCookie(t, field).post(`/terminals/${b}/inspections`).send({ results: oneFail })).body).toMatchObject({
      passed: false,
      failedItems: ['PRINTER'],
    });

    // 남의 일: 운영자(테스트 헤더 tester)가 같은 발주의 나머지를 입고하고 검수
    const other = receive.serials[2];
    expect((await t.http().post('/scans').send({ scanId: 'BOX-OPER-0001', kind: 'RECEIVE', poNo: receive.poNo, serials: [other] })).status).toBe(201);
    expect((await t.http().post(`/terminals/${other}/inspections`).send({ results: allPass })).status).toBe(201);

    // 어제 일: 오늘 0시보다 1분 전(datetime 열이 초 단위로 반올림하므로 1ms 전은 오늘로 올라갈 수 있다 — troubleshooting/0031)
    const yesterday = new Date(kstDayOf(new Date()).from.getTime() - 60_000);
    const em = t.orm.em.fork();
    em.create(ScanBatch, {
      scanId: 'BOX-FIELD-OLD1',
      kind: ScanKind.RETURN_IN,
      requestHash: '0'.repeat(64),
      actor: 'field-kim',
      results: [{ serialNo: 'OLD-1', result: 'RETURNED' }],
      createdAt: yesterday,
    });
    em.create(Inspection, { terminal: await em.findOneOrFail(Terminal, { serialNo: a }), passed: true, actor: 'field-kim', inspectedAt: yesterday });
    await em.flush();

    const res = await withCookie(t, field).get('/field/today');
    expect(res.body).toEqual({
      date: kstDayOf(new Date()).date,
      scans: { boxes: 2, received: 2, returned: 1, rejected: 1 },
      inspections: { total: 2, passed: 1, failed: 1 },
    });
  });

  it('현장 작업자만 부른다 — 운영자·가맹점주 403, 로그인 없음 401', async () => {
    expect((await t.http().get('/field/today')).status).toBe(403);
    const owner = await login(t, 'owner-gangnam');
    expect((await withCookie(t, owner).get('/field/today')).status).toBe(403);
    expect((await t.http(null).get('/field/today')).status).toBe(401);
  });

  it('현장 작업자는 검수 대기 목록·단말기 조회·발주 목록을 읽을 수 있다(현장 화면이 쓰는 기존 API, STAFF)', async () => {
    const queue = await withCookie(t, field).get('/terminals').query({ status: 'RECEIVED', size: 100 });
    expect(queue.status).toBe(200);
    expect(queue.body.items.map((i: { serialNo: string }) => i.serialNo)).toEqual([]); // 셋 다 검수돼 대기 없음
    const returned = await withCookie(t, field).get('/terminals').query({ status: 'RETURNED', size: 100 });
    expect(returned.body.items.map((i: { serialNo: string }) => i.serialNo)).toEqual(['FLD-RET-1']);
    expect((await withCookie(t, field).get('/terminals/FLD-RET-1')).body).toMatchObject({ status: 'RETURNED', actions: { inspect: true } });
    expect((await withCookie(t, field).get('/purchase-orders').query({ status: 'RECEIVING', limit: 100 })).status).toBe(200);
  });
});
