import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TerminalStatus as S } from '../src/terminal/terminal-status.js';
import { insertTerminals } from './helpers/terminals.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'kim' };

describe('어드민용 단말기 조회 — 상세의 가능한 전이·작업, 가맹점 필터, 검수 기록, 모델 목록 (F1·F2·F13, decisions/0040)', () => {
  let t: TestApp;
  const detail = (serialNo: string) => t.http().get(`/terminals/${serialNo}`);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await insertTerminals(t, [
      { serialNo: 'DT-STOCK', status: S.IN_STOCK },
      { serialNo: 'DT-ALLOC', status: S.ALLOCATED, merchantCode: 'GANGNAM-KIMBAP' },
      { serialNo: 'DT-SHIP', status: S.SHIPPED, merchantCode: 'GANGNAM-KIMBAP' },
      { serialNo: 'DT-RET-100', status: S.RETURNED },
      { serialNo: 'DT-RET-200', status: S.RETURNED, modelCode: 'SN-200' },
      { serialNo: 'DT-SVC', status: S.IN_SERVICE, merchantCode: 'YEOKSAM-CAFE' },
    ]);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('상세는 모델 이름·가맹점 이름·상태가 된 시각과 함께, MANUAL 전이와 전용 작업(배정·출고·검수)을 준다', async () => {
    const res = await detail('DT-ALLOC');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      serialNo: 'DT-ALLOC',
      modelCode: 'SN-100',
      modelName: '유선 카운터형',
      merchantCode: 'GANGNAM-KIMBAP',
      merchantName: '강남김밥',
      status: 'ALLOCATED',
      version: 1,
      allowedTransitions: [],
      actions: { allocate: false, cancelAllocation: true, ship: true, inspect: false },
    });
    expect(Date.parse(res.body.statusChangedAt)).not.toBeNaN();
    expect((await detail('DT-STOCK')).body).toMatchObject({ allowedTransitions: [], actions: { allocate: true, cancelAllocation: false, ship: false } });
    expect((await detail('DT-SVC')).body.allowedTransitions).toEqual([{ to: 'RETURN_REQUESTED', blockedReason: null }]);
  });

  it('모델 정책에 막힌 전이는 blockedReason과 함께 오고, 그 전이를 실제로 보내면 422(같은 규칙 표)', async () => {
    expect((await detail('DT-RET-100')).body).toMatchObject({
      allowedTransitions: [{ to: 'IN_STOCK', blockedReason: null }],
      actions: { inspect: true },
    });
    const strict = (await detail('DT-RET-200')).body;
    expect(strict.allowedTransitions).toEqual([{ to: 'IN_STOCK', blockedReason: expect.stringContaining('재검수') }]);
    const res = await t.http().post('/terminals/DT-RET-200/transitions').set(OP).send({ to: 'IN_STOCK', reason: '재고로', expectedVersion: strict.version });
    expect([res.status, res.body.code]).toEqual([422, 'INVALID_TRANSITION']);
  });

  it('상세가 허용한다고 한 전이는 실제로 된다(배송 완료 수동 처리)', async () => {
    const before = (await detail('DT-SHIP')).body;
    expect(before.allowedTransitions).toEqual([{ to: 'DELIVERED', blockedReason: null }]);
    const res = await t.http().post('/terminals/DT-SHIP/transitions').set(OP).send({ to: 'DELIVERED', reason: '현장 확인', expectedVersion: before.version });
    expect(res.status).toBe(200);
    expect((await detail('DT-SHIP')).body).toMatchObject({
      status: 'DELIVERED',
      version: before.version + 1,
      allowedTransitions: [{ to: 'IN_SERVICE', blockedReason: null }],
    });
  });

  it('목록: 가맹점으로 거르고, 행마다 statusChangedAt이 있다', async () => {
    const res = await t.http().get('/terminals').query({ merchantCode: 'GANGNAM-KIMBAP' });
    expect(res.body.total).toBe(2);
    expect(res.body.items.map((i: { serialNo: string }) => i.serialNo).sort()).toEqual(['DT-ALLOC', 'DT-SHIP']);
    expect(Date.parse(res.body.items[0].statusChangedAt)).not.toBeNaN();
    expect((await t.http().get('/terminals').query({ merchantCode: 'NOPE' })).body.total).toBe(0);
  });

  it('검수 기록: 최근 것부터, 항목은 체크리스트 순서와 이름으로. 없는 단말기는 404', async () => {
    await t.http().post('/terminals').set(OP).send({ serialNo: 'DT-NEW', modelCode: 'SN-300' });
    const items = [
      { itemCode: 'TOUCHSCREEN', passed: true },
      { itemCode: 'POWER', passed: true },
      { itemCode: 'NETWORK', passed: false, note: '신호 약함' },
    ];
    expect((await t.http().post('/terminals/DT-NEW/inspections').set(OP).send({ results: items })).body.passed).toBe(false);
    const res = await t.http().get('/terminals/DT-NEW/inspections');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: expect.any(Number),
        passed: false,
        actor: 'kim',
        inspectedAt: expect.any(String),
        results: [
          { itemCode: 'POWER', label: '전원', passed: true, note: null },
          { itemCode: 'NETWORK', label: '무선 통신', passed: false, note: '신호 약함' },
          { itemCode: 'TOUCHSCREEN', label: '터치스크린', passed: true, note: null },
        ],
      },
    ]);
    expect((await t.http().get('/terminals/DT-STOCK/inspections')).body).toEqual([]);
    expect((await t.http().get('/terminals/NOPE-1/inspections')).status).toBe(404);
  });

  it('모델 목록(코드 순)', async () => {
    expect((await t.http().get('/terminal-models')).body).toEqual([
      { code: 'SN-100', name: '유선 카운터형', requiresReinspection: false },
      { code: 'SN-200', name: '무선 LTE형', requiresReinspection: true },
      { code: 'SN-300', name: '테이블오더 태블릿형', requiresReinspection: false },
    ]);
  });
});
