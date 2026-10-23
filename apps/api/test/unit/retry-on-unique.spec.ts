import { DeadlockException, ForeignKeyConstraintViolationException, UniqueConstraintViolationException } from '@mikro-orm/mysql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retryOnUniqueViolation } from '../../src/common/retry-on-unique.js';

const unique = (n: number) => new UniqueConstraintViolationException(new Error(`Duplicate entry 'U-${n}'`));
const deadlock = (n: number) => new DeadlockException(new Error(`Deadlock ${n}`));

/** 시도 사이 대기(20~80ms)는 가짜 타이머로 넘긴다. */
async function run<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const r = await settled;
  if (r.ok) return r.value;
  throw r.error;
}

describe('retryOnUniqueViolation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks(); // Math.random 등 spy가 실패한 테스트에서도 다음 테스트로 새지 않게
  });

  it('unique 위반·데드락이면 다시 하고, 성공하면 그 값을 준다', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(unique(1)).mockRejectedValueOnce(deadlock(2)).mockResolvedValue('ok');
    await expect(run(retryOnUniqueViolation(fn))).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('세 번 모두 실패하면 마지막 오류를 그대로 던진다(네 번째는 없다)', async () => {
    const last = deadlock(3);
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(unique(1)).mockRejectedValueOnce(unique(2)).mockRejectedValueOnce(last);
    await expect(run(retryOnUniqueViolation(fn))).rejects.toBe(last);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('다른 오류는 다시 하지 않는다', async () => {
    const fk = new ForeignKeyConstraintViolationException(new Error('fk'));
    const plain = new Error('boom');
    const fkFn = vi.fn<() => Promise<string>>().mockRejectedValue(fk);
    const plainFn = vi.fn<() => Promise<string>>().mockRejectedValue(plain);
    await expect(run(retryOnUniqueViolation(fkFn))).rejects.toBe(fk);
    await expect(run(retryOnUniqueViolation(plainFn))).rejects.toBe(plain);
    expect(fkFn).toHaveBeenCalledTimes(1);
    expect(plainFn).toHaveBeenCalledTimes(1);
  });

  it('시도 사이에 20~80ms 기다린다', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 20 + 0.5 * 60 = 50ms
    const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(unique(1)).mockResolvedValue('ok');
    const done = retryOnUniqueViolation(fn);
    await vi.advanceTimersByTimeAsync(49);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);
    await expect(done).resolves.toBe('ok');
  });
});
