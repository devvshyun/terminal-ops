import { describe, expect, it } from 'vitest';
import { NOT_RECORDED, Replay, type Recording } from './engine';

/** 실행 둘(출고 t=1000, 끄기 t=60000) 사이에 배송 상태가 바뀌는 작은 녹화 */
const REC: Recording = {
  version: 1,
  recordedAt: '2026-10-30T03:00:00.000Z',
  commit: 'test',
  durationMs: 90000,
  runs: [
    { step: '3-ship', label: '출고', t: 1000, end: 2500 },
    { step: '7-off', label: '끄기', t: 60000, end: 61000 },
  ],
  responses: [
    { t: 100, method: 'GET', url: '/api/terminals/DM-1', status: 200, body: { status: 'IN_STOCK' } },
    { t: 1050, method: 'GET', url: '/api/stock', status: 200, body: ['DM-1'] },
    { t: 1100, method: 'POST', url: '/api/shipments', status: 201, body: { trackingNo: 'T1' } },
    { t: 1200, method: 'GET', url: '/api/terminals/DM-1', status: 200, body: { status: 'SHIPPED' } },
    { t: 1300, method: 'GET', url: '/api/stock', status: 200, body: [] },
    { t: 53000, method: 'GET', url: '/api/terminals/DM-1', status: 200, body: { status: 'DELIVERED' } },
    { t: 60100, method: 'POST', url: '/api/sim/config', status: 200, body: { ok: true } },
  ],
  shots: [
    { key: 'admin:/', file: 'a.png', title: '처음', t: 0 },
    { key: 'admin:/', file: 'b.png', title: '나중', t: 55000 },
  ],
};

function setup(speed = 10) {
  let real = 0;
  const replay = new Replay(REC, () => real, speed);
  return { replay, advance: (ms: number) => (real += ms) };
}

describe('녹화 재생 엔진(decisions/0094)', () => {
  it('처음에는 첫 실행 시각에서 멈춰 기다린다 — 실행 전 상태만 보인다', () => {
    const { replay, advance } = setup();
    advance(60_000);
    expect(replay.time()).toBe(1000);
    expect(replay.waiting()).toBe(true);
    expect(replay.reply('GET', '/api/terminals/DM-1').body).toEqual({ status: 'IN_STOCK' });
  });

  it('실행하면 POST는 녹화된 응답을 내고, 시계가 배속으로 흘러 기다리는 단계가 빨리 감긴다', () => {
    const { replay, advance } = setup(10);
    expect(replay.startRun('3-ship', '출고')).toBe(true);
    // 실행 안: 출고 전에 읽은 재고는 출고 전 값, 출고 뒤에는 실행 끝(2500)의 값
    expect(replay.reply('GET', '/api/stock').body).toEqual(['DM-1']);
    expect(replay.reply('POST', '/api/shipments')).toEqual({ status: 201, body: { trackingNo: 'T1' } });
    expect(replay.reply('GET', '/api/stock').body).toEqual([]);
    replay.endRun();
    expect(replay.reply('GET', '/api/terminals/DM-1').body).toEqual({ status: 'SHIPPED' });
    advance(5_100); // 52초 × 1/10
    expect(replay.reply('GET', '/api/terminals/DM-1').body).toEqual({ status: 'DELIVERED' });
    advance(10_000);
    expect(replay.time()).toBe(60000); // 다음 실행(끄기) 앞에서 멈춘다
  });

  it('같은 실행을 녹화한 횟수보다 많이 누르면 false, 처음 상태로 하면 다시 된다', () => {
    const { replay } = setup();
    expect(replay.startRun('3-ship', '출고')).toBe(true);
    expect(replay.startRun('3-ship', '출고')).toBe(false);
    expect(replay.startRun('없는', '단계')).toBe(false);
    replay.reset();
    expect(replay.time()).toBe(0);
    expect(replay.startRun('3-ship', '출고')).toBe(true);
  });

  it('POST 응답은 한 번만 쓴다 — 두 번째·실행 밖의 POST는 녹화에 없음', () => {
    const { replay } = setup();
    expect(replay.reply('POST', '/api/shipments').status).toBe(NOT_RECORDED);
    replay.startRun('3-ship', '출고');
    replay.reply('POST', '/api/shipments');
    expect(replay.reply('POST', '/api/shipments').status).toBe(NOT_RECORDED);
  });

  it('녹화에 없는 GET은 599와 안내 글', () => {
    const { replay } = setup();
    const r = replay.reply('GET', '/api/nope');
    expect(r.status).toBe(NOT_RECORDED);
    expect((r.body as { message: string }).message).toContain('녹화본에 없는 요청');
  });

  it('뒤 막을 먼저 실행해도 된다 — 시계가 그 시각으로 건너뛴다', () => {
    const { replay } = setup();
    expect(replay.startRun('7-off', '끄기')).toBe(true);
    expect(replay.reply('GET', '/api/terminals/DM-1').body).toEqual({ status: 'DELIVERED' });
    expect(replay.waiting()).toBe(false);
    expect(replay.reply('POST', '/api/sim/config').status).toBe(200);
  });

  it('화면 사진은 지금 시각 이전의 마지막 것', () => {
    const { replay, advance } = setup(10);
    expect(replay.shot('admin:/')?.file).toBe('a.png');
    replay.startRun('3-ship', '출고');
    replay.endRun();
    advance(6_000);
    expect(replay.shot('admin:/')?.file).toBe('b.png');
    expect(replay.shot('merchant:/')).toBeNull();
  });
});
