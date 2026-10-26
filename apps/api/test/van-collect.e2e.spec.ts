import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BusinessError } from '../src/common/domain-errors.js';
import { VanReconciliationRun, VanRegistrationSnapshot, VanRunStatus, VanRunTrigger, VanStatus } from '../src/van/van.entities.js';
import { VanReconciliationService } from '../src/van/van-reconciliation.service.js';
import { partners, type VanSeed } from './helpers/partners.js';
import { resetQueues, waitFor } from './helpers/queues.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'kim' };

/**
 * VAN 등록 n건(tid VT-…, 시리얼 VC-00001…). 우리 DB에는 이 단말기들이 없으므로 해지(CANCELLED)로 심는다 —
 * 그래야 어긋남이 아니라서 다음 Task의 비교·재검증(후보마다 VAN 단건 조회)이 이 파일의 호출 수·시간에 끼어들지 않는다.
 */
function vanRows(n: number): VanSeed[] {
  return Array.from({ length: n }, (_, i) => {
    const no = String(i + 1).padStart(5, '0');
    return { tid: `VT-${no}`, serialNo: `VC-${no}`, merchantCode: i % 2 ? 'YEOKSAM-CAFE' : 'GANGNAM-KIMBAP', status: 'CANCELLED' };
  });
}

describe('VAN 등록 대조 — 실행·커서 수집·스테이징 (F9)', () => {
  let t: TestApp;
  let svc: VanReconciliationService;
  const em = () => t.orm.em.fork();
  const snapshotCount = (runId: number) => em().count(VanRegistrationSnapshot, { runId });

  beforeAll(async () => {
    // 워커를 띄운다: POST가 넣은 job을 report 큐 프로세서가 처리하는지까지 본다. 다른 테스트는 서비스를 직접 부른다.
    t = await createTestApp({ workers: true });
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    svc = t.app.get(VanReconciliationService);
  });
  beforeEach(async () => {
    await partners.reset();
    // 이전 테스트가 남긴 RUNNING을 정리(한 번에 하나 규칙 때문에)
    await em().nativeUpdate(VanReconciliationRun, { status: VanRunStatus.RUNNING }, { status: VanRunStatus.FAILED });
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it('커서로 모든 페이지를 받아 페이지마다 스테이징에 넣고, 실행 행에 페이지·건수·걸린 시간을 남긴다', async () => {
    await partners.seedVan(vanRows(1234));
    const run = await svc.start(VanRunTrigger.MANUAL, 'kim');
    expect(run.status).toBe(VanRunStatus.RUNNING);
    const done = await svc.execute(run.id);
    expect(done).toMatchObject({ status: VanRunStatus.COMPLETED, pages: 3, fetched: 1234, retries: 0, error: null });
    expect(done.phaseMs?.collect).toEqual(expect.any(Number));
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect(await snapshotCount(run.id)).toBe(1234);
    const one = await em().findOneOrFail(VanRegistrationSnapshot, { runId: run.id, serialNo: 'VC-00002' });
    expect(one).toMatchObject({ tid: 'VT-00002', merchantCode: 'YEOKSAM-CAFE', status: 'CANCELLED' });
    expect(one.vanUpdatedAt).toBeInstanceOf(Date);
    expect((await partners.stats()).calls['bridgevan.list']).toBe(3); // 페이지 500 × 3(마지막 234)
  });

  it('429는 그 페이지만 Retry-After 뒤에 다시 부르고 끝까지 모은다(실행 행 retries = 429 수)', async () => {
    await partners.seedVan(vanRows(1100));
    // 시드 3이면 첫 페이지·둘째 페이지에서 한 번씩 429(시드 난수, 재현 가능). Retry-After 0초 → 기본 간격 500ms
    await partners.configure({ seed: 3, bridgevan: { force429Rate: 0.4, retryAfterSec: 0 } });
    const run = await svc.start(VanRunTrigger.MANUAL, 'kim');
    const done = await svc.execute(run.id);
    const stats = await partners.stats();
    console.log(`[VAN 429] pages=${done.pages} retries=${done.retries} 429=${stats.status429} calls=${stats.calls['bridgevan.list']}`);
    expect(done).toMatchObject({ status: VanRunStatus.COMPLETED, pages: 3, fetched: 1100 });
    expect(done.retries).toBe(2);
    expect(stats.status429).toBe(2);
    expect(stats.calls['bridgevan.list']).toBe(5);
    expect(await snapshotCount(run.id)).toBe(1100);
  });

  it('5xx가 계속되면 페이지마다 5번까지만 부르고 실행을 FAILED(이유)로 남긴다(던지지 않는다)', async () => {
    await partners.seedVan(vanRows(10));
    await partners.configure({ bridgevan: { error5xxRate: 1 } });
    const run = await svc.start(VanRunTrigger.MANUAL, 'kim');
    const failed = await svc.execute(run.id);
    expect(failed.status).toBe(VanRunStatus.FAILED);
    expect(failed.error).toMatch(/PartnerTransientError: 브릿지VAN 목록 응답 503/);
    expect((await partners.stats()).calls['bridgevan.list']).toBe(5);
  }, 20_000);

  it('같은 실행을 다시 돌리면(멈춘 job 재시도) 스테이징을 지우고 처음부터 모은다', async () => {
    await partners.seedVan(vanRows(30));
    const run = await svc.start(VanRunTrigger.MANUAL, 'kim');
    await svc.execute(run.id);
    await em().insert(VanRegistrationSnapshot, { runId: run.id, serialNo: 'LEFTOVER', tid: 'X', merchantCode: 'X', status: VanStatus.CANCELLED, vanUpdatedAt: new Date() });
    expect(await snapshotCount(run.id)).toBe(31);
    expect(await svc.collect(run.id)).toEqual({ pages: 1, fetched: 30, retries: 0 });
    expect(await snapshotCount(run.id)).toBe(30);
    expect(await svc.deleteSnapshot(run.id)).toBe(30);
  });

  it('진행 중인 실행은 하나만: 두 번째 시작은 409 VAN_RECONCILIATION_RUNNING, 끝나면 다시 시작할 수 있다', async () => {
    const first = await svc.start(VanRunTrigger.MANUAL, 'kim');
    await expect(svc.start(VanRunTrigger.SCHEDULED, 'system:van-reconcile')).rejects.toMatchObject({ status: 409, code: 'VAN_RECONCILIATION_RUNNING' });
    await expect(svc.start(VanRunTrigger.MANUAL, 'kim')).rejects.toBeInstanceOf(BusinessError);
    await partners.seedVan(vanRows(3));
    await svc.execute(first.id);
    const second = await svc.start(VanRunTrigger.MANUAL, 'kim');
    expect(second.id).toBeGreaterThan(first.id);
    await svc.execute(second.id);
  });

  it('너무 오래 RUNNING인 실행(프로세스가 죽음)은 다음 시작이 FAILED로 바꾸고 새로 시작한다', async () => {
    const old = await svc.start(VanRunTrigger.MANUAL, 'kim', new Date(Date.now() - 2 * 3_600_000));
    const fresh = await svc.start(VanRunTrigger.MANUAL, 'kim');
    const stale = await em().findOneOrFail(VanReconciliationRun, old.id);
    expect(stale.status).toBe(VanRunStatus.FAILED);
    expect(stale.error).toMatch(/멈춘 실행/);
    expect(fresh.status).toBe(VanRunStatus.RUNNING);
    await partners.seedVan(vanRows(1));
    await svc.execute(fresh.id);
  });

  it('POST /van-reconciliations는 202로 실행 행을 주고 report 큐 워커가 끝낸다. 진행 중에 다시 POST하면 409', async () => {
    await partners.seedVan(vanRows(1200));
    await partners.configure({ bridgevan: { delayMs: 300 } }); // 페이지 3개 × 0.3초: 두 번째 POST가 진행 중에 들어간다
    const res = await t.http().post('/van-reconciliations').set(OP);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'RUNNING', trigger: 'MANUAL', requestedBy: 'kim', pages: 0 });
    const again = await t.http().post('/van-reconciliations').set(OP);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('VAN_RECONCILIATION_RUNNING');
    const done = await waitFor(async () => {
      const r = await t.http().get(`/van-reconciliations/${res.body.id}`);
      return r.body.status === 'COMPLETED' ? r.body : null;
    });
    expect(done).toMatchObject({ pages: 3, fetched: 1200, error: null });
    expect((await t.http().get('/van-reconciliations/999999')).status).toBe(404);
    expect((await t.http().post('/van-reconciliations')).status).toBe(400); // 작업자 헤더 없음
  });
});
