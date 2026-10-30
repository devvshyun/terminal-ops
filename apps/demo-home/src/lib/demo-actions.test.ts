import { describe, expect, it } from 'vitest';
import { mockApi } from '../test/render';
import { ensureStock, nextVersion, replaceForTicket, setBungae429, setDeviceOffline, setFirmwareFailRate, shipOne, startRollout } from './demo-actions';

const terminal = (serialNo: string, status: string, version = 3) => ({ serialNo, modelCode: 'SN-100', merchantCode: null, status, statusChangedAt: '2026-10-30T00:00:00.000Z', version, createdAt: '', updatedAt: '' });

describe('시연 실행 묶음 (보강 10)', () => {
  it('재고가 있으면 그 첫 대(DM 시리얼)를 쓴다', async () => {
    const { calls } = mockApi({ 'GET /terminals': () => ({ body: { items: [terminal('DM-0014', 'IN_STOCK')], total: 1, page: 1, size: 50 } }) });
    expect(await ensureStock()).toBe('DM-0014');
    expect(calls[0].query.get('status')).toBe('IN_STOCK');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('재고가 없으면 시연용 한 대를 실제 API로 만든다: 등록 → 검수 합격 → 재고(다음 빈 시리얼 DM-9001…)', async () => {
    const { calls } = mockApi({
      'GET /terminals': (c) => ({ body: c.query.get('status') ? { items: [], total: 0, page: 1, size: 50 } : { items: [terminal('DM-9001', 'IN_SERVICE')], total: 1, page: 1, size: 50 } }),
      'POST /terminals': () => ({ status: 201, body: terminal('DM-9002', 'RECEIVED', 1) }),
      'GET /inspection-items': () => ({ body: [{ code: 'POWER' }, { code: 'NETWORK' }] }),
      'POST /terminals/:s/inspections': () => ({ status: 201, body: { terminal: terminal('DM-9002', 'INSPECTED', 2) } }),
      'POST /terminals/:s/transitions': () => ({ body: terminal('DM-9002', 'IN_STOCK', 3) }),
    });
    expect(await ensureStock()).toBe('DM-9002');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.path)).toEqual(['/terminals', '/terminals/DM-9002/inspections', '/terminals/DM-9002/transitions']);
    expect(posts[0].body).toEqual({ serialNo: 'DM-9002', modelCode: 'SN-100' });
    expect(posts[1].body).toEqual({ results: [{ itemCode: 'POWER', passed: true }, { itemCode: 'NETWORK', passed: true }] });
    expect(posts[2].body).toEqual({ to: 'IN_STOCK', reason: '재고 편입(시연 홈)', expectedVersion: 2 });
  });

  it('출고 하나: 재고 → 가맹점 배정 → 번개택배 출고(버전은 그때그때 읽는다)', async () => {
    let version = 3;
    const { calls } = mockApi({
      'GET /terminals': () => ({ body: { items: [terminal('DM-0014', 'IN_STOCK')], total: 1, page: 1, size: 50 } }),
      'GET /terminals/:s': () => ({ body: terminal('DM-0014', 'IN_STOCK', version) }),
      'POST /terminals/:s/allocations': () => {
        version = 4;
        return { status: 201, body: terminal('DM-0014', 'ALLOCATED', 4) };
      },
      'POST /shipments': () => ({ status: 201, body: { id: 9, trackingNo: 'BG1' } }),
    });
    expect(await shipOne('GANGNAM-KIMBAP')).toEqual({ serialNo: 'DM-0014', trackingNo: 'BG1' });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => [c.path, c.body])).toEqual([
      ['/terminals/DM-0014/allocations', { merchantCode: 'GANGNAM-KIMBAP', expectedVersion: 3 }],
      ['/shipments', { serialNo: 'DM-0014', carrier: 'BUNGAE', expectedVersion: 4 }],
    ]);
  });

  it('교체품은 고장 단말기와 같은 모델의 재고로(다르면 api가 MODEL_MISMATCH — 최종 검토)', async () => {
    const { calls } = mockApi({
      'GET /service-tickets/:id': () => ({ body: { id: 4, serialNo: 'DM-0021', status: 'OPEN' } }),
      'GET /terminals/:s': () => ({ body: { ...terminal('DM-0021', 'IN_SERVICE'), modelCode: 'SN-200' } }),
      'POST /service-tickets/:id/remote-checks': () => ({ body: {} }),
      'GET /terminals': () => ({ body: { items: [{ ...terminal('DM-9003', 'IN_STOCK'), modelCode: 'SN-200' }], total: 1, page: 1, size: 50 } }),
      'POST /service-tickets/:id/replacements': () => ({ body: { id: 4, status: 'REPLACING' } }),
    });
    await replaceForTicket(4);
    expect(calls.find((c) => c.path === '/terminals' && c.query.get('status') === 'IN_STOCK')?.query.get('modelCode')).toBe('SN-200');
    expect(calls.find((c) => c.path === '/service-tickets/4/replacements')?.body).toEqual({ replacementSerialNo: 'DM-9003', carrier: 'BUNGAE' });
  });

  it('배포: 같은 모델에 진행 중(진행·멈춤) 배포가 있으면 새 버전을 등록하기 전에 멈춘다(버전이 헛되이 늘지 않게 — 최종 검토)', async () => {
    const { calls } = mockApi({
      'GET /firmware-rollouts': () => ({ body: { items: [{ id: 2, modelCode: 'SN-100', version: '1.2.0', status: 'RUNNING' }], nextBeforeId: null } }),
      'GET /firmware': () => ({ body: { items: [{ modelCode: 'SN-100', version: '1.2.0' }], nextBeforeId: null } }),
    });
    await expect(startRollout('SN-100')).rejects.toThrow(/진행 중인 배포.*1\.2\.0/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('다음 버전: 그 모델에 등록된 가장 큰 x.y.0 다음(1.1.0·1.2.0이 있으면 1.3.0), 없으면 1.1.0', async () => {
    mockApi({ 'GET /firmware': () => ({ body: { items: [{ modelCode: 'SN-100', version: '1.1.0' }, { modelCode: 'SN-100', version: '1.2.0' }, { modelCode: 'SN-200', version: '2.1.0' }], nextBeforeId: null } }) });
    expect(await nextVersion('SN-100')).toBe('1.3.0');
    mockApi({ 'GET /firmware': () => ({ body: { items: [], nextBeforeId: null } }) });
    expect(await nextVersion('SN-100')).toBe('1.1.0');
  });

  it('배포: 새 버전 등록 → 배포 시작(단계 10·50·100%, 기준 20%, 최소 5건 — 어드민 기본값)', async () => {
    const { calls } = mockApi({
      'GET /firmware-rollouts': () => ({ body: { items: [{ id: 2, modelCode: 'SN-200', version: '2.1.0', status: 'PAUSED' }, { id: 1, modelCode: 'SN-100', version: '1.1.0', status: 'COMPLETED' }], nextBeforeId: null } }),
      'GET /firmware': () => ({ body: { items: [{ modelCode: 'SN-100', version: '1.1.0' }], nextBeforeId: null } }),
      'POST /firmware': () => ({ status: 201, body: {} }),
      'POST /firmware-rollouts': () => ({ status: 201, body: { id: 5, version: '1.2.0', status: 'RUNNING' } }),
    });
    expect(await startRollout('SN-100')).toMatchObject({ id: 5, version: '1.2.0' });
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { modelCode: 'SN-100', version: '1.2.0' },
      { modelCode: 'SN-100', version: '1.2.0', stages: [10, 50, 100], failureThreshold: 0.2, minSamples: 5 },
    ]);
  });

  it('장애 손잡이: 번개택배 429 확률, 시뮬레이터 펌웨어 실패율 — 바꾸는 값만 보낸다', async () => {
    const { calls } = mockApi({ 'POST /partners/__admin/config': () => ({ body: {} }), 'POST /sim/__admin/config': () => ({ body: {} }) });
    await setBungae429(0.5);
    await setFirmwareFailRate(0.6);
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ['/partners/__admin/config', { bungae: { force429Rate: 0.5 } }],
      ['/sim/__admin/config', { firmwareFailRate: 0.6 }],
    ]);
  });

  it('단말기 끄기·켜기: 그때의 offlineSerials를 읽어 바꾼다(다른 꺼 둔 단말기를 덮지 않게)', async () => {
    const { calls } = mockApi({
      'GET /sim/__admin/config': () => ({ body: { offlineSerials: ['DM-0002', 'DM-0021'] } }),
      'POST /sim/__admin/config': () => ({ body: {} }),
    });
    await setDeviceOffline('DM-0005', true);
    await setDeviceOffline('DM-0021', false);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ offlineSerials: ['DM-0002', 'DM-0021', 'DM-0005'] }, { offlineSerials: ['DM-0002'] }]);
  });

  it('교체 출고: 원격 점검(해결 안 됨) → 재고 한 대로 교체(번개택배)', async () => {
    const { calls } = mockApi({
      'GET /service-tickets/:id': () => ({ body: { id: 3, serialNo: 'DM-0004', status: 'OPEN' } }),
      'GET /terminals/:s': () => ({ body: terminal('DM-0004', 'IN_SERVICE') }),
      'POST /service-tickets/:id/remote-checks': () => ({ body: { id: 3, status: 'OPEN' } }),
      'GET /terminals': () => ({ body: { items: [terminal('DM-0015', 'IN_STOCK')], total: 1, page: 1, size: 50 } }),
      'POST /service-tickets/:id/replacements': () => ({ body: { id: 3, status: 'REPLACING', replacementSerialNo: 'DM-0015' } }),
    });
    expect(await replaceForTicket(3)).toMatchObject({ status: 'REPLACING' });
    expect(calls.filter((c) => c.method === 'POST').map((c) => [c.path, c.body])).toEqual([
      ['/service-tickets/3/remote-checks', { resolved: false, note: '원격 점검(시연 홈): 해결 안 됨 — 교체' }],
      ['/service-tickets/3/replacements', { replacementSerialNo: 'DM-0015', carrier: 'BUNGAE' }],
    ]);
  });
});
