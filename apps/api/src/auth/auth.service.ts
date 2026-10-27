import { HttpException, Inject, Injectable, type OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { ApiErrorBody } from '@terminal-ops/contracts';
import type { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { execOrThrow } from '../redis/redis-exec.js';
import { REDIS } from '../redis/redis.provider.js';
import { dummyPasswordHash, verifyPassword } from './password.js';
import { Role } from './role.js';
import { SessionStore, type SessionData } from './session.store.js';
import { UserAccount } from './user-account.entity.js';

const LOGIN_FAILED: ApiErrorBody = { statusCode: 401, code: 'LOGIN_FAILED', message: '아이디 또는 비밀번호가 맞지 않습니다.' };

/** 로그인·로그아웃(decisions/0050). 세션은 SessionStore, 실패 횟수는 Redis 카운터 */
@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    private readonly em: EntityManager,
    private readonly sessions: SessionStore,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** 없는 아이디용 가짜 해시를 앱이 뜰 때 만들어 둔다(약 140ms) — 첫 "없는 아이디" 로그인만 느려 아이디 유무가 보이지 않게(Task 1 리뷰) */
  async onModuleInit(): Promise<void> {
    await dummyPasswordHash();
  }

  /** 아이디별 실패 카운터. 대소문자를 가리지 않는 아이디(collation)라 소문자로 묶는다 */
  private failKey(loginId: string) {
    return `${env.queuePrefix}:login-fail:${loginId.toLowerCase()}`;
  }

  /**
   * 맞으면 세션 토큰과 사람 정보. 틀리면 401 LOGIN_FAILED(아이디가 없는지·비밀번호가 틀린지·사용 중지인지 말하지 않는다).
   * 같은 아이디로 실패가 LOGIN_MAX_FAILURES번 쌓이면 첫 실패부터 LOGIN_LOCK_MS 동안 429 LOGIN_LOCKED — 맞는 비밀번호여도.
   */
  async login(loginId: string, password: string): Promise<{ token: string; session: SessionData }> {
    const failKey = this.failKey(loginId);
    const failures = Number((await this.redis.get(failKey)) ?? 0);
    if (failures >= env.loginMaxFailures) {
      const ttl = await this.redis.pttl(failKey);
      throw new HttpException(
        {
          statusCode: 429,
          code: 'LOGIN_LOCKED',
          message: `로그인 실패가 ${env.loginMaxFailures}번 넘어 잠시 막았습니다. 약 ${Math.max(1, Math.ceil(ttl / 60_000))}분 뒤 다시 시도하세요.`,
        } satisfies ApiErrorBody,
        429,
      );
    }
    const em = this.em.fork();
    const account = await em.findOne(UserAccount, { loginId }, { populate: ['merchant'] });
    // 없는 아이디도 해시 하나만큼 시간을 쓴다(응답 시간으로 아이디가 있는지 알아내지 못하게)
    const ok = await verifyPassword(password, account?.passwordHash ?? (await dummyPasswordHash()));
    // 가맹점이 없는 MERCHANT(가맹점 삭제로 merchant_id가 SET NULL)는 범위를 정할 수 없어 로그인시키지 않는다(Task 1 리뷰)
    const orphanMerchant = account?.role === Role.MERCHANT && !account.merchant;
    if (!account || !ok || account.disabledAt || orphanMerchant) {
      // 첫 실패에만 만료를 건다(NX) — 실패가 이어져도 창이 밀리지 않는다
      await execOrThrow(this.redis.multi().incr(failKey).pexpire(failKey, env.loginLockMs, 'NX'));
      throw new UnauthorizedException(LOGIN_FAILED);
    }
    await this.redis.del(failKey);
    account.lastLoginAt = new Date();
    await em.flush();
    const session: SessionData = {
      accountId: account.id,
      loginId: account.loginId,
      displayName: account.displayName,
      role: account.role,
      merchantId: account.merchant?.id ?? null,
      merchantCode: account.merchant?.code ?? null,
    };
    return { token: await this.sessions.create(session), session };
  }

  async logout(token: string | null): Promise<void> {
    if (token) await this.sessions.destroy(token);
  }
}
