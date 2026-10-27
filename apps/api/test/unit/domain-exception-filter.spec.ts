import 'reflect-metadata';
import type { ArgumentsHost } from '@nestjs/common';
import { DeadlockException, OptimisticLockError } from '@mikro-orm/mysql';
import { describe, expect, it } from 'vitest';
import { DomainExceptionFilter } from '../../src/common/domain-exception.filter.js';

/** 필터가 쓴 응답(상태 코드, 본문)을 잡는 가짜 ArgumentsHost */
function fakeHost() {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: unknown) {
      sent.body = body;
      return this;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  return { host, sent };
}

describe('DomainExceptionFilter — 데드락(1213)은 409 DEADLOCK (Day 4 이월, decisions/0043)', () => {
  it('DeadlockException은 500이 아니라 409 DEADLOCK과 다시 시도 안내', () => {
    // @Catch 목록에 없으면 Nest가 이 필터를 부르지 않아 500이 된다
    expect(Reflect.getMetadata('__filterCatchExceptions__', DomainExceptionFilter)).toContain(DeadlockException);
    const { host, sent } = fakeHost();
    const error = new DeadlockException(Object.assign(new Error('Deadlock found when trying to get lock; try restarting transaction'), { code: 'ER_LOCK_DEADLOCK', errno: 1213, sqlState: '40001' }));
    new DomainExceptionFilter().catch(error, host);
    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ statusCode: 409, code: 'DEADLOCK' });
    expect((sent.body as { message: string }).message).toContain('다시 시도');
  });

  it('(회귀 방지) 낙관적 락 충돌은 그대로 409 VERSION_CONFLICT', () => {
    const { host, sent } = fakeHost();
    new DomainExceptionFilter().catch(OptimisticLockError.lockFailed('Terminal'), host);
    expect(sent).toMatchObject({ status: 409, body: { code: 'VERSION_CONFLICT' } });
  });
});
