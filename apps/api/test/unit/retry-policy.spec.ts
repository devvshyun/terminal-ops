import { NotFoundException } from '@nestjs/common';
import { NotFoundError } from '@mikro-orm/core';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { toJobError } from '../../src/carrier-sync/retry-policy.js';
import { PartnerTransientError } from '../../src/common/partner-errors.js';

describe('toJobError', () => {
  it('findOneOrFail의 NotFoundError는 재시도하지 않는다(UnrecoverableError)', () => {
    const error = NotFoundError.findOneFailed('Shipment', { id: 1 });
    const mapped = toJobError(error);
    expect(mapped).toBeInstanceOf(UnrecoverableError);
    expect((mapped as Error).message).toContain('NotFoundError');
  });

  it('Nest NotFoundException도 재시도하지 않고, 일시 오류는 그대로 던진다', () => {
    expect(toJobError(new NotFoundException('없음'))).toBeInstanceOf(UnrecoverableError);
    const transient = new PartnerTransientError('번개택배 HTTP 503');
    expect(toJobError(transient)).toBe(transient);
  });
});
