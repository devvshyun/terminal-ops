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
});
