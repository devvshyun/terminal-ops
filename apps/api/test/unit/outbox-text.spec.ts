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

  it('펌웨어 배포는 배포 번호·버전과 단계 시작(1부터 센 단계, 누적 비율)·완료·중단 사유', () => {
    expect(textOf({ type: 'firmware.stage_advanced', payload: { rolloutId: 3, version: '2.0.0', stage: 1, percent: 50 } })).toBe(
      '[단말온] 펌웨어 배포 #3 2.0.0: 2단계(50%) 시작',
    );
    expect(textOf({ type: 'firmware.rollout_completed', payload: { rolloutId: 3, version: '2.0.0' } })).toBe('[단말온] 펌웨어 배포 #3 2.0.0: 완료');
    expect(textOf({ type: 'firmware.rollout_aborted', payload: { rolloutId: 3, version: '2.0.0', reason: '운영자 중단: han' } })).toBe(
      '[단말온] 펌웨어 배포 #3 2.0.0: 중단 (운영자 중단: han)',
    );
  });

  it('VAN 대조 요약은 실행 번호, 종류별 어긋남(없는 종류는 0), 재검증으로 풀린 수, VAN 등록 수 (decisions/0033)', () => {
    const payload = { runId: 7, fetched: 50000, candidates: 1003, confirmed: 1000, resolved: 3, counts: { NOT_REGISTERED: 400, MERCHANT_MISMATCH: 600 } };
    expect(textOf({ type: 'van.reconciliation_completed', payload })).toBe(
      '[단말온] VAN 등록 대조 #7: 어긋남 1000건(미등록 400, 운영 아님 0, 가맹점 다름 600, 정지 0), 재검증으로 풀림 3건, VAN 등록 50000건',
    );
    // 확인 불가(재검증 VAN 조회가 영구 오류)는 있을 때만 적는다
    expect(textOf({ type: 'van.reconciliation_completed', payload: { ...payload, resolved: 1, unverifiable: 2 } })).toBe(
      '[단말온] VAN 등록 대조 #7: 어긋남 1000건(미등록 400, 운영 아님 0, 가맹점 다름 600, 정지 0), 재검증으로 풀림 1건, 확인 불가 2건, VAN 등록 50000건',
    );
  });
});
