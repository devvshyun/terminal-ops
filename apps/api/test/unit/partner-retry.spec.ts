import { describe, expect, it } from 'vitest';
import { carrierBackoff } from '../../src/carrier-sync/retry-policy.js';
import { PartnerPermanentError, PartnerRateLimitedError, PartnerTransientError } from '../../src/common/partner-errors.js';
import { partnerBackoffMs, withPartnerRetry } from '../../src/common/partner-retry.js';

describe('withPartnerRetry — 한 job 안의 외부 호출 재시도 (decisions/0033)', () => {
  it('429는 Retry-After(최소 500ms), 5xx는 500ms·1s·2s… 기다린 뒤 다시 하고, 성공하면 값을 돌려준다', async () => {
    const waits: number[] = [];
    const errors = [new PartnerRateLimitedError('429', 2000), new PartnerTransientError('503'), new PartnerTransientError('503'), new PartnerRateLimitedError('429', 0)];
    let calls = 0;
    const value = await withPartnerRetry(
      async () => {
        calls++;
        const e = errors.shift();
        if (e) throw e;
        return 'ok';
      },
      { attempts: 5, sleep: async (ms) => void waits.push(ms) },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(5);
    expect(waits).toEqual([2000, 1000, 2000, 500]);
  });

  it('영구 오류와 모르는 오류는 바로 던지고, 다시 할 수 있는 오류도 attempts를 다 쓰면 던진다', async () => {
    let calls = 0;
    const sleep = async () => undefined;
    await expect(withPartnerRetry(async () => (calls++, Promise.reject(new PartnerPermanentError('400'))), { attempts: 5, sleep })).rejects.toBeInstanceOf(PartnerPermanentError);
    expect(calls).toBe(1);
    await expect(withPartnerRetry(async () => Promise.reject(new TypeError('x')), { attempts: 5, sleep })).rejects.toBeInstanceOf(TypeError);
    calls = 0;
    const retried: number[] = [];
    await expect(
      withPartnerRetry(async () => (calls++, Promise.reject(new PartnerTransientError('503'))), { attempts: 3, sleep, onRetry: (_e, attempt) => retried.push(attempt) }),
    ).rejects.toBeInstanceOf(PartnerTransientError);
    expect(calls).toBe(3);
    expect(retried).toEqual([1, 2]);
  });

  it('택배 추적 job의 carrier 백오프와 같은 규칙이다', () => {
    const limited = new PartnerRateLimitedError('429', 3000);
    expect(carrierBackoff(1, 'carrier', limited)).toBe(partnerBackoffMs(1, limited));
    expect([1, 2, 3].map((n) => carrierBackoff(n, 'carrier', new PartnerTransientError('x')))).toEqual([500, 1000, 2000]);
  });
});
