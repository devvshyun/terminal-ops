import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { OptimisticLockError, UniqueConstraintViolationException } from '@mikro-orm/mysql';
import type { Response } from 'express';
import { InvalidTransitionError } from './domain-errors.js';

/** ORM·도메인 오류를 HTTP 응답으로 바꾼다. 응답의 code로 클라이언트가 원인을 구분한다. */
@Catch(OptimisticLockError, UniqueConstraintViolationException, InvalidTransitionError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(error: Error, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (error instanceof OptimisticLockError) {
      return res.status(409).json({
        statusCode: 409,
        code: 'VERSION_CONFLICT',
        message: '다른 작업이 먼저 이 단말기를 변경했습니다. 다시 조회한 뒤 시도하세요.',
      });
    }
    if (error instanceof UniqueConstraintViolationException) {
      return res.status(409).json({ statusCode: 409, code: 'DUPLICATE', message: '이미 존재하는 값입니다.' });
    }
    return res.status(422).json({ statusCode: 422, code: 'INVALID_TRANSITION', message: error.message });
  }
}
