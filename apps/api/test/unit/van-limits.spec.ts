import { describe, expect, it } from 'vitest';
import { checkVanHeartbeatTiming, vanWorstCallMs } from '../../src/van/van-limits.js';

describe('VAN 실행 하트비트 시간 검사 (decisions/0033)', () => {
  it('호출 하나의 최악 시간 = 시도 수 × 제한 시간 + 백오프 합(500ms·1s·2s·4s, Retry-After 제외)', () => {
    expect(vanWorstCallMs(3000)).toBe(5 * 3000 + 500 + 1000 + 2000 + 4000);
    expect(vanWorstCallMs(1000, 2)).toBe(2 * 1000 + 500);
  });

  it('멈춤 기준은 하트비트 간격 + 호출 하나의 최악 시간 이상이어야 한다(아니면 시작 실패)', () => {
    expect(() => checkVanHeartbeatTiming({ staleMs: 300_000, intervalMs: 30_000, timeoutMs: 3000 })).not.toThrow();
    // 간격이 기준 이상이면 살아 있는 실행도 멈춘 것으로 보인다
    expect(() => checkVanHeartbeatTiming({ staleMs: 30_000, intervalMs: 30_000, timeoutMs: 3000 })).toThrow(/VAN_HEARTBEAT_INTERVAL_MS/);
    // 최종 리뷰 반영(Minor 1): 확인 지점(재시도 대기 앞)에서 간격이 아직 안 지났으면 하트비트 없이 Retry-After 상한(60s)까지 잔다
    // → 30s + 22.5s + 60s = 112.5s. 전에는 Retry-After를 빼고 52.5s로 셌다
    expect(() => checkVanHeartbeatTiming({ staleMs: 100_000, intervalMs: 30_000, timeoutMs: 3000 })).toThrow(
      /VAN_RUN_HEARTBEAT_STALE_MS=100000.*112500.*Retry-After 상한 60000/,
    );
    expect(() => checkVanHeartbeatTiming({ staleMs: 112_499, intervalMs: 30_000, timeoutMs: 3000 })).toThrow(/112500/);
    expect(() => checkVanHeartbeatTiming({ staleMs: 112_500, intervalMs: 30_000, timeoutMs: 3000 })).not.toThrow();
  });
});
