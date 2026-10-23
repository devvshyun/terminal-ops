import { describe, expect, it } from 'vitest';
import { percentile, SimStats } from '../src/stats.js';

describe('응답 시간 통계', () => {
  it('백분위는 가장 가까운 순위 값이다', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBe(0);
  });

  it('기록한 응답 시간으로 p50·p95·max를 낸다', () => {
    const s = new SimStats();
    for (const ms of [30, 10, 20, 40]) s.recordLatency(ms);
    expect(s.view().latency).toEqual({ count: 4, p50: 20, p95: 40, max: 40 });
  });
});
