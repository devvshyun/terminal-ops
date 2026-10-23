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

  it('기록한 응답 시간으로 p50·p95·max를 낸다(구간 히스토그램이라 근삿값, 오차 2% 안)', () => {
    const s = new SimStats();
    for (const ms of [30, 10, 20, 40]) s.recordLatency(ms, true);
    const l = s.view().latency;
    expect(l.count).toBe(4);
    expect(l.p50).toBeGreaterThanOrEqual(20);
    expect(l.p50).toBeLessThanOrEqual(20 * 1.02);
    expect(l.p95).toBeGreaterThanOrEqual(40);
    expect(l.p95).toBeLessThanOrEqual(40 * 1.02);
    expect(l.max).toBe(40);
    expect(l.approx).toBe(true);
  });

  it('성공·실패 응답 시간을 따로도 보여 주고, latency는 둘을 합친 것이다', () => {
    const s = new SimStats();
    for (let i = 0; i < 90; i++) s.recordLatency(10, true);
    for (let i = 0; i < 10; i++) s.recordLatency(5000, false); // 시간 초과
    const v = s.view();
    expect(v.latency.count).toBe(100);
    expect(v.latencyOk.count).toBe(90);
    expect(v.latencyFailed.count).toBe(10);
    expect(v.latencyOk.p95).toBeLessThan(11);
    expect(v.latencyFailed.p50).toBeGreaterThan(4900);
    expect(v.latency.p95).toBeGreaterThan(4900); // 실패를 빼면 p95가 10ms로 보인다(생존자 편향)
  });

  it('값이 100만 개여도 메모리는 일정하고, 나중 값도 반영된다(앞 표본만 남기지 않는다)', () => {
    const s = new SimStats();
    const buckets = s.bucketCount();
    for (let i = 0; i < 600_000; i++) s.recordLatency(1 + (i % 10), true); // 1~10ms
    for (let i = 0; i < 400_000; i++) s.recordLatency(1000 + (i % 1000), true); // 1000~1999ms
    expect(s.bucketCount()).toBe(buckets);
    const l = s.view().latency;
    expect(l.count).toBe(1_000_000);
    expect(l.p50).toBeLessThanOrEqual(10 * 1.02); // 60%가 10ms 이하
    expect(l.p95).toBeGreaterThan(1800 * 0.98);
    expect(l.p95).toBeLessThan(1900 * 1.02);
    expect(l.max).toBe(1999);
  });

  it('범위 밖 값(0·아주 큰 값)도 세고 max는 정확하다', () => {
    const s = new SimStats();
    s.recordLatency(0, true);
    s.recordLatency(1e9, true);
    const l = s.view().latency;
    expect(l.count).toBe(2);
    expect(l.max).toBe(1e9);
  });
});
