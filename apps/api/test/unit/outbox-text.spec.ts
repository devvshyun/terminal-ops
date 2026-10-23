import { describe, expect, it } from 'vitest';
import { textOf } from '../../src/outbox/outbox.service.js';

describe('알림 문구(textOf)', () => {
  it('상태 변경은 이전 → 다음 (작업자) 사유', () => {
    const text = textOf({
      type: 'terminal.status_changed',
      payload: { serialNo: 'A-0001', fromStatus: null, toStatus: 'RECEIVED', actor: 'kim', reason: '신규 등록' },
    });
    expect(text).toBe('[단말온] A-0001: 신규 → RECEIVED (kim) 신규 등록');
  });

  it('접속 상태는 오프라인·온라인 복귀와 마지막 하트비트 시각', () => {
    expect(textOf({ type: 'device.offline', payload: { serialNo: 'A-0001', lastSeenAt: '2026-10-23T00:00:00.000Z' } })).toBe(
      '[단말온] A-0001: 오프라인 (마지막 하트비트 2026-10-23T00:00:00.000Z)',
    );
    expect(textOf({ type: 'device.online', payload: { serialNo: 'A-0001', lastSeenAt: '2026-10-23T00:05:00.000Z' } })).toBe(
      '[단말온] A-0001: 온라인 복귀 (하트비트 2026-10-23T00:05:00.000Z)',
    );
  });

  it('묶음 알림은 대수와 앞 5대, 나머지는 "외 N대"', () => {
    const serials = Array.from({ length: 100 }, (_, i) => `A-${String(i + 1).padStart(4, '0')}`);
    expect(
      textOf({ type: 'device.offline_bulk', payload: { count: 120, serials, truncated: true, detectedAt: '2026-10-23T00:00:00.000Z' } }),
    ).toBe('[단말온] 단말기 120대 오프라인 (A-0001, A-0002, A-0003, A-0004, A-0005 외 115대, 판정 2026-10-23T00:00:00.000Z)');
    expect(textOf({ type: 'device.online_bulk', payload: { count: 3, serials: ['A-1', 'A-2', 'A-3'], truncated: false, detectedAt: 'T' } })).toBe(
      '[단말온] 단말기 3대 온라인 복귀 (A-1, A-2, A-3, 판정 T)',
    );
  });
});
