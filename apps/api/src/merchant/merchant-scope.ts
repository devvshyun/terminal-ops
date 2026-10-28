import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ApiErrorBody } from '@terminal-ops/contracts';
import type { Principal } from '../auth/principal.js';
import { Role } from '../auth/role.js';

/**
 * 가맹점주가 볼 수 있는 범위(decisions/0053). `/me/...` 컨트롤러가 로그인한 사람에서 만들어 서비스에 넘기고,
 * 서비스는 이 값이 있으면 조회 조건·트랜잭션 안 검사에 merchant_id를 넣는다. 범위 밖이면 403이 아니라 404 — 남의 단말기가 있는지도 알려 주지 않는다.
 */
export interface MerchantScope {
  merchantId: number;
}

export function merchantScopeOf(principal: Principal): MerchantScope {
  if (principal.role !== Role.MERCHANT || principal.merchantId === null) {
    throw new ForbiddenException({ statusCode: 403, code: 'FORBIDDEN', message: '가맹점 계정만 쓸 수 있습니다.' } satisfies ApiErrorBody);
  }
  return { merchantId: principal.merchantId };
}

/** 범위 밖일 때 던지는 404(없는 것과 같은 응답) */
export function outOfScope(what: string): NotFoundException {
  return new NotFoundException(`${what}이(가) 없습니다.`);
}
