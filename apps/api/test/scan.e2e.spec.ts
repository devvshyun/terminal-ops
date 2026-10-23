import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { PurchaseOrder, PurchaseOrderStatus } from '../src/purchase-order/purchase-order.entity.js';
import { ScanBatch } from '../src/scan/scan-batch.entity.js';
import { ScanLock } from '../src/scan/scan-lock.js';
import { BulkRegistrationService } from '../src/terminal/bulk-registration.service.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { partners } from './helpers/partners.js';
import { orderPurchase, SCENARIO_OP } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'choi' };

describe('박스 일괄 스캔 (F6)', () => {
  let t: TestApp;
  const em = () => t.orm.em.fork();
  const scan = (body: Record<string, unknown>) => t.http().post('/scans').set(OP).send(body);
  const noteCalls = async () => (await partners.stats()).calls['seum.deliveryNote'] ?? 0;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  describe('입고(RECEIVE)', () => {
    it('명세에 있는 시리얼만 SCAN 출처로 등록하고 행별 결과를 준다. 발주는 RECEIVING', async () => {
      const { poNo, serials } = await orderPurchase(t, 5);
      const before = await noteCalls();
      const res = await scan({
        scanId: 'BOX-RCV-0001',
        kind: 'RECEIVE',
        poNo,
        serials: [serials[0], serials[1], 'SE0-9999', serials[0], 'bad', serials[2]],
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ scanId: 'BOX-RCV-0001', kind: 'RECEIVE', poNo, actor: 'choi', replayed: false });
      expect(res.body.results.map((r: { result: string }) => r.result)).toEqual([
        'CREATED',
        'CREATED',
        'NOT_IN_DELIVERY_NOTE',
        'DUPLICATE_IN_REQUEST',
        'INVALID_FORMAT',
        'CREATED',
      ]);
      expect(res.body.summary).toEqual({ CREATED: 3, NOT_IN_DELIVERY_NOTE: 1, DUPLICATE_IN_REQUEST: 1, INVALID_FORMAT: 1 });
      expect(await noteCalls()).toBe(before + 1); // 명세는 처음 한 번 받아 저장한다

      const created = await em().find(Terminal, { purchaseOrder: { poNo } }, { orderBy: { serialNo: 'asc' } });
      expect(created.map((c) => c.serialNo)).toEqual([serials[0], serials[1], serials[2]].sort());
      expect(created.every((c) => c.status === TerminalStatus.RECEIVED)).toBe(true);
      const [history] = await em().find(TerminalStatusHistory, { terminal: { serialNo: serials[0] } });
      expect(history).toMatchObject({ source: 'SCAN', actor: 'choi', reason: `박스 입고: 발주 ${poNo}` });
      const po = await em().findOneOrFail(PurchaseOrder, { poNo });
      expect(po.status).toBe(PurchaseOrderStatus.RECEIVING);
      expect(po.deliveryNote).toEqual(serials);
    });

    it('다음 박스: 이미 입고된 시리얼은 ALREADY_EXISTS, 명세는 다시 받지 않는다', async () => {
      const { poNo, serials } = await orderPurchase(t, 3);
      await scan({ scanId: 'BOX-RCV-0002', kind: 'RECEIVE', poNo, serials: [serials[0]] });
      const before = await noteCalls();
      const res = await scan({ scanId: 'BOX-RCV-0003', kind: 'RECEIVE', poNo, serials: [serials[0], serials[1]] });
      expect(res.body.results.map((r: { result: string }) => r.result)).toEqual(['ALREADY_EXISTS', 'CREATED']);
      expect(await noteCalls()).toBe(before);
    });

    it('앞뒤 공백·\\r이 붙은 시리얼도 다듬은 값으로 명세를 검사한다(명세 밖이면 NOT_IN_DELIVERY_NOTE)', async () => {
      const { poNo, serials } = await orderPurchase(t, 2);
      const body = { scanId: 'BOX-RCV-0020', kind: 'RECEIVE', poNo, serials: ['SE0-9998 ', 'SE0-9997\r', ` ${serials[0]}\r`] };
      const res = await scan(body);
      expect(res.status).toBe(201);
      expect(res.body.results.map((r: { serialNo: string; result: string }) => [r.serialNo, r.result])).toEqual([
        ['SE0-9998', 'NOT_IN_DELIVERY_NOTE'],
        ['SE0-9997', 'NOT_IN_DELIVERY_NOTE'],
        [serials[0], 'CREATED'],
      ]);
      expect(await em().count(Terminal, { serialNo: { $in: ['SE0-9998', 'SE0-9997'] } })).toBe(0);
      // 요청 해시도 다듬은 값으로 만든다: 공백 없이 같은 박스를 다시 보내면 같은 요청이다.
      const again = await scan({ ...body, serials: ['SE0-9998', 'SE0-9997', serials[0]] });
      expect(again.status).toBe(200);
      expect(again.body.replayed).toBe(true);
    });

    it('poNo가 없으면 400, 없는 발주는 404, 마감된 발주는 422 PO_CLOSED, 501개 이상은 400', async () => {
      expect((await scan({ scanId: 'BOX-RCV-0010', kind: 'RECEIVE', serials: ['A-0001'] })).status).toBe(400);
      expect((await scan({ scanId: 'BOX-RCV-0011', kind: 'RECEIVE', poNo: 'SE0', serials: ['A-0001'] })).status).toBe(404);
      const { poNo, serials } = await orderPurchase(t, 1);
      await em().nativeUpdate(PurchaseOrder, { poNo }, { status: PurchaseOrderStatus.CLOSED });
      const closed = await scan({ scanId: 'BOX-RCV-0012', kind: 'RECEIVE', poNo, serials });
      expect(closed.status).toBe(422);
      expect(closed.body.code).toBe('PO_CLOSED');
      const many = Array.from({ length: 501 }, (_, i) => `MANY-${String(i).padStart(4, '0')}`);
      expect((await scan({ scanId: 'BOX-RCV-0013', kind: 'RECEIVE', poNo, serials: many })).status).toBe(400);
    });
  });

  describe('멱등(같은 scanId)', () => {
    it('같은 scanId를 다시 보내면 처리하지 않고 저장된 결과를 200으로 준다', async () => {
      const { poNo, serials } = await orderPurchase(t, 2);
      const body = { scanId: 'BOX-IDEM-0001', kind: 'RECEIVE', poNo, serials };
      const first = await scan(body);
      const historyBefore = await em().count(TerminalStatusHistory);
      const second = await scan(body);
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.replayed).toBe(true);
      expect(second.body.results).toEqual(first.body.results);
      expect(await em().count(TerminalStatusHistory)).toBe(historyBefore);
      expect(await em().count(ScanBatch, { scanId: 'BOX-IDEM-0001' })).toBe(1);
      expect((await t.http().get('/scans/BOX-IDEM-0001')).body.results).toEqual(first.body.results);
    });

    it('같은 scanId로 다른 내용을 보내면 422 SCAN_ID_REUSED', async () => {
      const { poNo, serials } = await orderPurchase(t, 2);
      await scan({ scanId: 'BOX-IDEM-0002', kind: 'RECEIVE', poNo, serials: [serials[0]] });
      const res = await scan({ scanId: 'BOX-IDEM-0002', kind: 'RECEIVE', poNo, serials: [serials[1]] });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('SCAN_ID_REUSED');
    });

    it('처리 중에 같은 scanId가 또 오면 409 SCAN_IN_PROGRESS, 끝난 뒤에는 저장된 결과', async () => {
      const { poNo, serials } = await orderPurchase(t, 2);
      const body = { scanId: 'BOX-IDEM-0003', kind: 'RECEIVE', poNo, serials };
      // 첫 요청이 등록 엔진 안에서 멈추게 한다(Redis 잠금을 쥔 채, 트랜잭션 열린 채).
      const bulk = t.app.get(BulkRegistrationService);
      const original = bulk.registerMany.bind(bulk);
      let release!: () => void;
      let markEntered!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const entered = new Promise<void>((r) => (markEntered = r));
      const spy = vi.spyOn(bulk, 'registerMany').mockImplementationOnce(async (...args) => {
        markEntered();
        await released;
        return original(...args);
      });
      try {
        const first = scan(body).then((r) => r);
        await entered;
        const second = await scan(body);
        expect(second.status).toBe(409);
        expect(second.body.code).toBe('SCAN_IN_PROGRESS');
        release();
        expect((await first).status).toBe(201);
      } finally {
        release();
        spy.mockRestore();
      }
      const third = await scan(body);
      expect(third.status).toBe(200);
      expect(third.body.replayed).toBe(true);
      // 잠금은 끝나면 풀린다
      expect(await t.app.get(ScanLock).acquire('BOX-IDEM-0003', 1000)).not.toBeNull();
    });
  });

  describe('회수 입고(RETURN_IN)', () => {
    async function registerWithStatus(serialNo: string, status: TerminalStatus) {
      await t.http().post('/terminals').set(SCENARIO_OP).send({ serialNo, modelCode: 'SN-100' });
      const e = em();
      const terminal = await e.findOneOrFail(Terminal, { serialNo });
      terminal.status = status;
      await e.flush();
      return terminal.version;
    }

    it('RETURNING만 RETURNED(SCAN)로 바꾸고, 상태가 다르면 INVALID_STATE, 없으면 NOT_FOUND', async () => {
      const v1 = await registerWithStatus('RT-0001', TerminalStatus.RETURNING);
      await registerWithStatus('RT-0002', TerminalStatus.RETURNING);
      await registerWithStatus('RT-0003', TerminalStatus.IN_STOCK);
      const res = await scan({ scanId: 'BOX-RET-0001', kind: 'RETURN_IN', serials: ['RT-0002', 'RT-0003', 'RT-9999', 'RT-0001'] });
      expect(res.status).toBe(201);
      expect(res.body.results.map((r: { serialNo: string; result: string }) => [r.serialNo, r.result])).toEqual([
        ['RT-0002', 'RETURNED'],
        ['RT-0003', 'INVALID_STATE'],
        ['RT-9999', 'NOT_FOUND'],
        ['RT-0001', 'RETURNED'],
      ]);
      expect(res.body.results[1].message).toContain('IN_STOCK → RETURNED');

      const t1 = await em().findOneOrFail(Terminal, { serialNo: 'RT-0001' });
      expect(t1).toMatchObject({ status: TerminalStatus.RETURNED, version: v1 + 1 });
      expect((await em().findOneOrFail(Terminal, { serialNo: 'RT-0003' })).status).toBe(TerminalStatus.IN_STOCK);
      const history = await t.http().get('/terminals/RT-0001/history');
      expect(history.body.at(-1)).toMatchObject({ fromStatus: 'RETURNING', toStatus: 'RETURNED', source: 'SCAN', actor: 'choi', reason: '박스 회수 입고' });
    });

    it('앞뒤 공백이 붙은 시리얼도 다듬은 값으로 처리한다', async () => {
      await registerWithStatus('RT-0011', TerminalStatus.RETURNING);
      const res = await scan({ scanId: 'BOX-RET-0002', kind: 'RETURN_IN', serials: ['RT-0011 ', 'RT-0011\r'] });
      expect(res.status).toBe(201);
      expect(res.body.results.map((r: { serialNo: string; result: string }) => [r.serialNo, r.result])).toEqual([
        ['RT-0011', 'RETURNED'],
        ['RT-0011', 'DUPLICATE_IN_REQUEST'],
      ]);
      expect((await em().findOneOrFail(Terminal, { serialNo: 'RT-0011' })).status).toBe(TerminalStatus.RETURNED);
    });

    it('회수 입고에 poNo를 보내면 400(쓰지 않는 값이 요청 해시에 섞이지 않게)', async () => {
      const res = await scan({ scanId: 'BOX-RET-0003', kind: 'RETURN_IN', poNo: 'SE0', serials: ['RT-0001'] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PO_NOT_ALLOWED');
      expect(await em().count(ScanBatch, { scanId: 'BOX-RET-0003' })).toBe(0);
    });
  });

  describe('잠금 해제 실패', () => {
    it('반영이 커밋된 뒤 잠금 해제가 실패해도 201과 결과를 준다(잠금은 TTL로 풀린다)', async () => {
      const { poNo, serials } = await orderPurchase(t, 1);
      const spy = vi.spyOn(t.app.get(ScanLock), 'release').mockRejectedValueOnce(new Error('Connection is closed.'));
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        const res = await scan({ scanId: 'BOX-LOCK-0001', kind: 'RECEIVE', poNo, serials });
        expect(res.status).toBe(201);
        expect(res.body.results).toEqual([{ serialNo: serials[0], result: 'CREATED' }]);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('BOX-LOCK-0001'));
      } finally {
        spy.mockRestore();
        warn.mockRestore();
      }
    });
  });
});
