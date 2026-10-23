import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { OptimisticLockError, UniqueConstraintViolationException } from '@mikro-orm/mysql';
import type { Response } from 'express';
import { BusinessError, InvalidTransitionError } from './domain-errors.js';
import { PartnerError } from './partner-errors.js';

/** ORM·도메인·외부 업체 오류를 HTTP 응답으로 바꾼다. 응답의 code로 클라이언트가 원인을 구분한다. */
@Catch(OptimisticLockError, UniqueConstraintViolationException, InvalidTransitionError, PartnerError, BusinessError)
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
    if (error instanceof BusinessError) {
      return res.status(error.status).json({ statusCode: error.status, code: error.code, message: error.message });
    }
    if (error instanceof PartnerError) {
      // 우리 잘못이 아니라 외부 업체(택배사) 쪽 실패. 원인 분류(error.name)를 함께 준다.
      return res.status(502).json({ statusCode: 502, code: 'PARTNER_ERROR', reason: error.name, message: error.message });
    }
    return res.status(422).json({ statusCode: 422, code: 'INVALID_TRANSITION', message: error.message });
  }
}
