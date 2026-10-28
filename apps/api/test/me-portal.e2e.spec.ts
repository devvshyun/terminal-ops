import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeviceConnectivity } from '../src/device/device-connectivity.entity.js';
import { deviceKeys } from '../src/device/device-keys.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { CarrierEventCode } from '../src/carrier/carrier.types.js';
import { CarrierEvent, Shipment } from '../src/shipment/shipment.entities.js';
import { Terminal } from '../src/terminal/terminal.entity.js';
import { TerminalStatusHistory } from '../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus } from '../src/terminal/terminal-status.js';
import { createAccount, login, withCookie } from './helpers/auth.js';
import { partners } from './helpers/partners.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { allocateTo, prepareInService, registerInStock, SCENARIO_OP, shipWith, transitionTo } from './helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const SN100_PASS = ['POWER', 'NETWORK', 'CARD_READER', 'PRINTER'].map((itemCode) => ({ itemCode, passed: true }));

describe('점주 화면용 /me 보강 — 단말기 요약·접속·배송·이력, 접수 상세 (보강 3, decisions/0059)', () => {
  let t: TestApp;
  let redis: Redis;
  let gangnam: string;
  let yeoksam: string;
  const em = () => t.orm.em.fork();

  beforeAll(async () => {
    t = await createTestApp();
    redis = t.app.get<Redis>(REDIS);
    await resetDatabase(t.orm);
    await partners.reset();
    await deleteTestKeys(redis, 'hb:');
    await prepareInService(t, 'MP-0001', 'GANGNAM-KIMBAP'); // 운영 중, Redis 하트비트
    await prepareInService(t, 'MP-0002', 'GANGNAM-KIMBAP'); // 운영 중, MySQL 스냅샷만
    await prepareInService(t, 'MP-0003', 'GANGNAM-KIMBAP'); // 운영 중, 접속 기록 없음 → 고장 접수·교체
    await registerInStock(t, 'MP-0101'); // 교체 단말기
    await registerInStock(t, 'MP-0004');
    await allocateTo(t, 'MP-0004', 'GANGNAM-KIMBAP');
    await shipWith(t, 'MP-0004', 'BUNGAE'); // 새로 배송 중
    await createAccount(t, 'owner-gangnam', 'MERCHANT', 'GANGNAM-KIMBAP');
    await createAccount(t, 'owner-yeoksam', 'MERCHANT', 'YEOKSAM-CAFE');
    gangnam = await login(t, 'owner-gangnam');
    yeoksam = await login(t, 'owner-yeoksam');
  });
  afterAll(async () => {
    await deleteTestKeys(redis);
    await t.app.close();
  });

  const terminalsOf = async (cookie: string) => (await withCookie(t, cookie).get('/me/terminals')).body.items as Record<string, unknown>[];
  const itemOf = async (cookie: string, serialNo: string) => (await terminalsOf(cookie)).find((i) => i.serialNo === serialNo);

  it('내 매장 정보는 로그인한 가맹점의 것(화면 위쪽 매장 이름). 직원 역할은 403', async () => {
    const res = await withCookie(t, gangnam).get('/me/merchant');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['address', 'code', 'name']);
    expect(res.body.code).toBe('GANGNAM-KIMBAP');
    expect((await withCookie(t, yeoksam).get('/me/merchant')).body.code).toBe('YEOKSAM-CAFE');
    expect((await t.http().get('/me/merchant')).status).toBe(403);
  });

  it('목록 한 줄은 점주용 모양 — version·가맹점 코드 없이 모델 이름·접속·배송', async () => {
    const item = await itemOf(gangnam, 'MP-0001');
    expect(Object.keys(item!).sort()).toEqual(['connectivity', 'modelCode', 'modelName', 'serialNo', 'shipment', 'status', 'statusChangedAt']);
    expect(item).toMatchObject({ modelCode: 'SN-100', status: 'IN_SERVICE', shipment: null });
    expect(typeof item!.modelName).toBe('string');
  });

  it('운영 중 단말기의 접속: Redis 최신값(기준 안이면 online), 없으면 MySQL 스냅샷, 둘 다 없으면 기록 없음. 운영 중이 아니면 null', async () => {
    const k = deviceKeys();
    const now = Date.now();
    await redis.zadd(k.lastSeen, now, 'MP-0001'); // 배정 이력(초 단위 반올림)보다 뒤여야 이번 주기의 값이다
    await redis.hset(k.firmware, { 'MP-0001': '1.2.0' });
    const mp2 = await em().findOneOrFail(Terminal, { serialNo: 'MP-0002' });
    const seen = new Date(now - 3_600_000);
    // 이번 배정이 그보다 앞서도록 배정 이력 시각을 2시간 전으로 돌린다(실제로는 배정 뒤에 받은 오래된 접속을 흉내)
    await em().nativeUpdate(TerminalStatusHistory, { terminal: mp2.id, toStatus: TerminalStatus.ALLOCATED }, { occurredAt: new Date(now - 7_200_000) });
    await em().insert(DeviceConnectivity, { terminalId: mp2.id, online: true, lastSeenAt: seen, firmwareVersion: '1.1.0', changedAt: seen });

    expect((await itemOf(gangnam, 'MP-0001'))!.connectivity).toEqual({ online: true, lastSeenAt: new Date(now).toISOString(), firmwareVersion: '1.2.0' });
    // 스냅샷은 online=true로 남아 있어도 lastSeen이 기준(90초)보다 오래되면 오프라인(GET /terminals/:serialNo/connectivity와 같은 규칙)
    expect((await itemOf(gangnam, 'MP-0002'))!.connectivity).toEqual({ online: false, lastSeenAt: seen.toISOString(), firmwareVersion: '1.1.0' });
    expect((await itemOf(gangnam, 'MP-0003'))!.connectivity).toEqual({ online: false, lastSeenAt: null, firmwareVersion: null });
    expect((await itemOf(gangnam, 'MP-0004'))!.connectivity).toBeNull();
  });

  it('배송 중 단말기는 운송장과 택배 이벤트(오래된 것부터). 새 배정이면 ticketId null', async () => {
    const shipment = await em().findOneOrFail(Shipment, { terminal: { serialNo: 'MP-0004' } });
    const at = (m: number) => new Date(Date.UTC(2026, 9, 28, 1, m));
    const fork = em(); // 수집 job 대신 이벤트 행을 바로 넣는다(넣는 순서와 상관없이 시각 순으로 나와야 한다)
    fork.create(CarrierEvent, { shipment: shipment.id, eventKey: 'e2', code: CarrierEventCode.IN_TRANSIT, occurredAt: at(30), raw: {} });
    fork.create(CarrierEvent, { shipment: shipment.id, eventKey: 'e1', code: CarrierEventCode.PICKED_UP, occurredAt: at(0), raw: {} });
    await fork.flush();

    const item = await itemOf(gangnam, 'MP-0004');
    expect(item).toMatchObject({ status: 'SHIPPED', connectivity: null });
    expect(item!.shipment).toEqual({
      carrier: 'BUNGAE',
      trackingNo: shipment.trackingNo,
      status: 'IN_TRANSIT',
      createdAt: shipment.createdAt.toISOString(),
      deliveredAt: null,
      ticketId: null,
      events: [
        { code: CarrierEventCode.PICKED_UP, occurredAt: at(0).toISOString() },
        { code: CarrierEventCode.IN_TRANSIT, occurredAt: at(30).toISOString() },
      ],
    });
  });

  it('A/S 교체: 교체 단말기의 배송에 접수 번호, 접수 응답에 원격 점검 여부와 교체 단말기 상태. 접수 상세는 내 것만(남의 것 404)', async () => {
    const opened = await withCookie(t, gangnam).post('/me/service-tickets').send({ serialNo: 'MP-0003', symptom: '카드 인식 불가: 오전부터' });
    expect(opened.status).toBe(201);
    expect(opened.body).toMatchObject({ remoteChecked: false, replacementStatus: null });
    const id = opened.body.id as number;

    expect((await t.http().post(`/service-tickets/${id}/remote-checks`).send({ resolved: false, note: '내부 메모' })).status).toBeLessThan(300);
    expect((await withCookie(t, gangnam).get(`/me/service-tickets/${id}`)).body).toMatchObject({ id, status: 'OPEN', remoteChecked: true, replacementStatus: null });

    expect((await t.http().post(`/service-tickets/${id}/replacements`).send({ replacementSerialNo: 'MP-0101', carrier: 'NEURIMBO' })).status).toBe(201);
    const detail = await withCookie(t, gangnam).get(`/me/service-tickets/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ status: 'REPLACING', replacementSerialNo: 'MP-0101', replacementStatus: 'SHIPPED', openedByMe: true });
    expect(detail.body).not.toHaveProperty('remoteNote');
    expect((await itemOf(gangnam, 'MP-0101'))!.shipment).toMatchObject({ carrier: 'NEURIMBO', ticketId: id, events: [] });
    expect((await itemOf(gangnam, 'MP-0003'))!.status).toBe('RETURN_REQUESTED');

    const other = await withCookie(t, yeoksam).get(`/me/service-tickets/${id}`);
    expect(other.status).toBe(404);
    expect(other.body.message).toBe(`A/S 접수 ${id}이(가) 없습니다.`);
    expect((await withCookie(t, gangnam).get('/me/service-tickets/999999')).status).toBe(404);
  });

  it('접수 목록은 단말기 시리얼로 거를 수 있다(내 가맹점 안에서만)', async () => {
    const mine = await withCookie(t, gangnam).get('/me/service-tickets').query({ serialNo: 'MP-0003' });
    expect(mine.body.items.map((i: { serialNo: string }) => i.serialNo)).toEqual(['MP-0003']);
    expect((await withCookie(t, gangnam).get('/me/service-tickets').query({ serialNo: 'MP-0001' })).body.items).toEqual([]);
    expect((await withCookie(t, yeoksam).get('/me/service-tickets').query({ serialNo: 'MP-0003' })).body.items).toEqual([]);
  });

  it('상세의 이력은 이번 배정부터, 상태와 시각만(actor·reason 없음)', async () => {
    const res = await withCookie(t, gangnam).get('/me/terminals/MP-0001');
    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { status: string }) => e.status)).toEqual(['ALLOCATED', 'SHIPPED', 'DELIVERED', 'IN_SERVICE']);
    for (const e of res.body.events) expect(Object.keys(e).sort()).toEqual(['occurredAt', 'status']);
    expect(res.body.connectivity).toMatchObject({ online: true });
  });

  it('회수가 끝나 본사로 돌아간(검수·재고) 단말기는 옛 가맹점에 보이지 않는다. 다른 가맹점에 다시 배정되면 그 가맹점은 새 배정부터만 본다', async () => {
    await prepareInService(t, 'MP-0201', 'YEOKSAM-CAFE');
    await transitionTo(t, 'MP-0201', 'RETURN_REQUESTED', '회수 요청');
    await transitionTo(t, 'MP-0201', 'RETURNING', '회수 중');
    await transitionTo(t, 'MP-0201', 'RETURNED', '회수 입고');
    expect((await itemOf(yeoksam, 'MP-0201'))!.status).toBe('RETURNED'); // 회수 완료까지는 보인다

    const inspected = await t.http().post('/terminals/MP-0201/inspections').set(SCENARIO_OP).send({ results: SN100_PASS });
    expect(inspected.status).toBe(201);
    await transitionTo(t, 'MP-0201', 'IN_STOCK', '재고 편입');
    expect((await em().findOneOrFail(Terminal, { serialNo: 'MP-0201' }, { populate: ['merchant'] })).merchant?.code).toBe('YEOKSAM-CAFE'); // 가맹점은 그대로 남아 있다
    expect(await itemOf(yeoksam, 'MP-0201')).toBeUndefined();
    expect((await withCookie(t, yeoksam).get('/me/terminals/MP-0201')).status).toBe(404);

    await allocateTo(t, 'MP-0201', 'GANGNAM-KIMBAP');
    const detail = await withCookie(t, gangnam).get('/me/terminals/MP-0201');
    expect(detail.body.events.map((e: { status: string }) => e.status)).toEqual(['ALLOCATED']);
  });

  it('점주에게 보이지 않는 상태로 거르면 400', async () => {
    expect((await withCookie(t, gangnam).get('/me/terminals').query({ status: 'IN_STOCK' })).status).toBe(400);
    const shipped = await withCookie(t, gangnam).get('/me/terminals').query({ status: 'SHIPPED' });
    expect(shipped.body.items.map((i: { serialNo: string }) => i.serialNo).sort()).toEqual(['MP-0004', 'MP-0101']);
  });
  it('회수가 끝나 재고로 돌아간 단말기에 옛 가맹점이 A/S 접수하면 없는 단말기와 같은 404(현재 상태를 알려 주는 422가 아니다)', async () => {
    await prepareInService(t, 'MP-0301', 'YEOKSAM-CAFE');
    await transitionTo(t, 'MP-0301', 'RETURN_REQUESTED', '회수 요청');
    await transitionTo(t, 'MP-0301', 'RETURNING', '회수 중');
    await transitionTo(t, 'MP-0301', 'RETURNED', '회수 입고');
    expect((await t.http().post('/terminals/MP-0301/inspections').set(SCENARIO_OP).send({ results: SN100_PASS })).status).toBe(201);
    await transitionTo(t, 'MP-0301', 'IN_STOCK', '재고 편입');

    const stale = await withCookie(t, yeoksam).post('/me/service-tickets').send({ serialNo: 'MP-0301', symptom: '카드 인식 불가' });
    const missing = await withCookie(t, yeoksam).post('/me/service-tickets').send({ serialNo: 'MP-9999', symptom: '카드 인식 불가' });
    expect(stale.status).toBe(404);
    expect(stale.body.message).toBe('단말기 MP-0301이(가) 없습니다.');
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe('단말기 MP-9999이(가) 없습니다.');
  });

  it('교체 단말기 상태(replacementStatus)는 교체 중(REPLACING)일 때만, 설치 확인으로 종결되면 null', async () => {
    await prepareInService(t, 'MP-0501', 'GANGNAM-KIMBAP');
    await registerInStock(t, 'MP-0502');
    const id = (await withCookie(t, gangnam).post('/me/service-tickets').send({ serialNo: 'MP-0501', symptom: '화면 꺼짐' })).body.id as number;
    expect((await t.http().post(`/service-tickets/${id}/replacements`).send({ replacementSerialNo: 'MP-0502', carrier: 'NEURIMBO' })).status).toBe(201);
    expect((await withCookie(t, gangnam).get(`/me/service-tickets/${id}`)).body).toMatchObject({ status: 'REPLACING', replacementStatus: 'SHIPPED' });

    await transitionTo(t, 'MP-0502', 'DELIVERED', 'delivered');
    const done = await withCookie(t, gangnam).post(`/me/service-tickets/${id}/installations`);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'CLOSED', replacementSerialNo: 'MP-0502', replacementStatus: null });
    const listed = (await withCookie(t, gangnam).get('/me/service-tickets').query({ serialNo: 'MP-0501' })).body.items;
    expect(listed[0]).toMatchObject({ id, status: 'CLOSED', replacementStatus: null });
  });

  it('A → B → A로 다시 배정된 단말기: 이력은 이번 주기만, 접속은 이번 배정 전의 값(Redis 하트비트)이면 null', async () => {
    await prepareInService(t, 'MP-0401', 'GANGNAM-KIMBAP'); // 주기 1 (gangnam)
    const k = deviceKeys();
    await new Promise((r) => setTimeout(r, 1_100)); // 배정 이력 시각은 초 단위라, 배정 직후(1초 안) 하트비트는 앞 것으로 보일 수 있다
    await redis.zadd(k.lastSeen, Date.now(), 'MP-0401'); // 주기 1 동안 받은 하트비트(뒤의 두 배정보다 앞)
    await redis.hset(k.firmware, { 'MP-0401': '1.0.0' });
    expect((await itemOf(gangnam, 'MP-0401'))!.connectivity).toMatchObject({ firmwareVersion: '1.0.0' }); // 주기 1에서는 보인다

    const giveBack = async () => {
      await transitionTo(t, 'MP-0401', 'RETURN_REQUESTED', '회수 요청');
      await transitionTo(t, 'MP-0401', 'RETURNING', '회수 중');
      await transitionTo(t, 'MP-0401', 'RETURNED', '회수 입고');
      expect((await t.http().post('/terminals/MP-0401/inspections').set(SCENARIO_OP).send({ results: SN100_PASS })).status).toBe(201);
      await transitionTo(t, 'MP-0401', 'IN_STOCK', '재고 편입');
    };
    const install = async (merchantCode: string) => {
      await allocateTo(t, 'MP-0401', merchantCode);
      await shipWith(t, 'MP-0401', 'BUNGAE');
      await transitionTo(t, 'MP-0401', 'DELIVERED', 'delivered');
      await transitionTo(t, 'MP-0401', 'IN_SERVICE', 'installed');
    };
    await new Promise((r) => setTimeout(r, 1_100));
    await giveBack();
    await install('YEOKSAM-CAFE'); // 주기 2 (yeoksam)
    await giveBack();
    await install('GANGNAM-KIMBAP'); // 주기 3 (gangnam 다시)

    const detail = await withCookie(t, gangnam).get('/me/terminals/MP-0401');
    expect(detail.status).toBe(200);
    expect(detail.body.events.map((e: { status: string }) => e.status)).toEqual(['ALLOCATED', 'SHIPPED', 'DELIVERED', 'IN_SERVICE']);
    // 주기 1의 마지막 접속·펌웨어는 이번 설치와 상관없다
    expect(detail.body.connectivity).toEqual({ online: false, lastSeenAt: null, firmwareVersion: null });
    expect((await itemOf(gangnam, 'MP-0401'))!.connectivity).toEqual({ online: false, lastSeenAt: null, firmwareVersion: null });
    expect((await itemOf(yeoksam, 'MP-0401'))).toBeUndefined(); // 옛 가맹점(주기 2)에는 보이지 않는다

    // 이번 배정 뒤에 받은 하트비트는 그대로 보인다
    await new Promise((r) => setTimeout(r, 1_100));
    const fresh = Date.now() - 100;
    await redis.zadd(k.lastSeen, fresh, 'MP-0401');
    await redis.hset(k.firmware, { 'MP-0401': '1.3.0' });
    expect((await itemOf(gangnam, 'MP-0401'))!.connectivity).toEqual({ online: true, lastSeenAt: new Date(fresh).toISOString(), firmwareVersion: '1.3.0' });
  });
});
