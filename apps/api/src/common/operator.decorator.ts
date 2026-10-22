import { BadRequestException, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export const OPERATOR_HEADER = 'x-operator';
const MESSAGE = 'X-Operator 헤더(작업자 이름, 50자 이하)가 필요합니다. 한글은 URL 인코딩해서 보내세요.';

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return '';
  }
}

/** 요청한 작업자 이름. 인증 대신 헤더로 받는다(decisions/0001). `system:`은 시스템 작업 전용이라 거절한다. */
export const Operator = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const raw = ctx.switchToHttp().getRequest<Request>().header(OPERATOR_HEADER);
  const name = raw ? decode(raw) : '';
  if (!name || name.length > 50 || name.startsWith('system:')) throw new BadRequestException(MESSAGE);
  return name;
});
