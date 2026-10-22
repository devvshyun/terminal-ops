import { NotFoundException } from '@nestjs/common';
import { NotFoundError } from '@mikro-orm/core';
import { UnrecoverableError, type JobsOptions } from 'bullmq';
import { InvalidTransitionError } from '../common/domain-errors.js';
import { PartnerPermanentError, PartnerRateLimitedError } from '../common/partner-errors.js';

/** 추적 job 기본 옵션. 완료·최종 실패한 job을 지워야 다음 sweep이 같은 jobId로 다시 넣을 수 있다(decisions/0013). */
export const TRACK_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'carrier', delay: 500 },
  removeOnComplete: true,
  removeOnFail: true,
};

const BASE_DELAY_MS = 500;

/**
 * 'carrier' 백오프: 429면 택배사가 알려 준 Retry-After만큼, 그 밖에는 500ms·1s·2s·4s… 지수 백오프(decisions/0014).
 * Worker 옵션 settings.backoffStrategy로 등록한다.
 */
export function carrierBackoff(attemptsMade: number, _type?: string, err?: Error): number {
  if (err instanceof PartnerRateLimitedError) return Math.max(err.retryAfterMs, BASE_DELAY_MS);
  return BASE_DELAY_MS * 2 ** (attemptsMade - 1);
}

/**
 * 다시 해도 같은 결과인 오류는 UnrecoverableError로 바꿔 재시도하지 않게 한다.
 * 행이 없음(Nest NotFoundException, MikroORM findOneOrFail의 NotFoundError)도 여기에 든다.
 * 429·5xx·타임아웃, 낙관적 락 충돌, 데드락은 그대로 던져 재시도한다.
 */
export function toJobError(error: unknown): unknown {
  if (
    error instanceof PartnerPermanentError ||
    error instanceof InvalidTransitionError ||
    error instanceof NotFoundException ||
    error instanceof NotFoundError
  ) {
    return new UnrecoverableError(`${error.name}: ${error.message}`);
  }
  return error;
}
