import { HttpException, Inject, Injectable, Logger, type OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { ApiErrorBody } from '@terminal-ops/contracts';
import type { Redis } from 'ioredis';
import { authTestHeadersWarning } from '../config/auth-test-headers.js';
import { env } from '../config/env.js';
import { execOrThrow } from '../redis/redis-exec.js';
import { REDIS } from '../redis/redis.provider.js';
import { dummyPasswordHash, verifyPassword } from './password.js';
import { Role } from './role.js';
import { SessionStore, type SessionPrincipal } from './session.store.js';
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
    // 테스트 전용 헤더 길이 켜져 있으면 시작 로그에 경고 한 줄(Task 2 리뷰) — NODE_ENV=test로 서버를 띄워 실수로 켠 것을 알아보게
    const warning = authTestHeadersWarning(env.authTestHeaders);
    if (warning) new Logger(AuthService.name).warn(warning);
    await dummyPasswordHash();
  }

  /**
   * 아이디별 실패 카운터 키. 테이블 collation(utf8mb4_0900_ai_ci)은 대소문자·악센트·전각을 같게 본다 — `op1`·`óp1`·`ｏｐ１`이 같은 계정이다.
   * 그래서 LoginDto가 ASCII(`[A-Za-z0-9._-]`)만 받고(악센트·전각은 400), 여기서 NFKC + 소문자로 한 번 더 접는다(서비스를 DTO 없이 부를 때도).
   * ASCII에서 이 collation이 같게 보는 것은 대소문자뿐이라(NO PAD — 끝 공백도 다르다, 공백은 DTO가 막는다) 접은 값 하나 = 계정 하나다.
   */
  static normalizeLoginId(loginId: string): string {
    return loginId.normalize('NFKC').toLowerCase();
  }

  private failKey(normalizedLoginId: string) {
    return `${env.queuePrefix}:login-fail:${normalizedLoginId}`;
  }

  /**
   * 맞으면 세션 토큰과 사람 정보. 틀리면 401 LOGIN_FAILED(아이디가 없는지·비밀번호가 틀린지·사용 중지인지 말하지 않는다).
   * 시도를 **먼저 예약**한다(INCR + 첫 시도에만 PEXPIRE NX, MULTI 하나) — 예약한 번호가 LOGIN_MAX_FAILURES를 넘으면 비밀번호를 보지 않고 429 LOGIN_LOCKED.
   * 동시에 몰려 와도 비밀번호 검증까지 가는 시도는 창(LOGIN_LOCK_MS)마다 한도까지다. 성공하면 카운터를 지운다(진행 중인 다른 예약도 함께 — 맞는 비밀번호를 아는 사람이다).
   * @param previousToken 요청에 이미 있던 세션 쿠키 — 로그인에 성공하면 그 세션을 지운다
   */
  async login(loginId: string, password: string, previousToken: string | null = null): Promise<{ token: string; session: SessionPrincipal }> {
    const normalized = AuthService.normalizeLoginId(loginId);
    const failKey = this.failKey(normalized);
    const [attempt] = (await execOrThrow(this.redis.multi().incr(failKey).pexpire(failKey, env.loginLockMs, 'NX'))) as number[];
    if (attempt > env.loginMaxFailures) {
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
    // 세대값을 계정 행보다 먼저 읽는다(decisions/0050) — 계정 API가 행을 바꾼 뒤 세션을 끊으면(세대값 INCR) 그 전에 읽은 옛 역할의 세션은 무효가 된다.
    // 계정 id를 알아야 세대값 키를 만들 수 있어 id만 먼저 읽고, 세대값을 읽은 뒤 행 전체를 새 EntityManager로 다시 읽는다
    const found = await this.em.fork().findOne(UserAccount, { loginId: normalized }, { fields: ['id'] });
    const gen = found ? await this.sessions.generation(found.id) : 0;
    const em = this.em.fork();
    const account = found ? await em.findOne(UserAccount, found.id, { populate: ['merchant'] }) : null;
    // 없는 아이디도 해시 하나만큼 시간을 쓴다(응답 시간으로 아이디가 있는지 알아내지 못하게)
    const ok = await verifyPassword(password, account?.passwordHash ?? (await dummyPasswordHash()));
    // 가맹점이 없는 MERCHANT(가맹점 삭제로 merchant_id가 SET NULL)는 범위를 정할 수 없어 로그인시키지 않는다(Task 1 리뷰)
    const orphanMerchant = account?.role === Role.MERCHANT && !account.merchant;
    if (!account || !ok || account.disabledAt || orphanMerchant) {
      // 예약한 시도가 그대로 실패 한 번이 된다
      throw new UnauthorizedException(LOGIN_FAILED);
    }
    await this.redis.del(failKey);
    account.lastLoginAt = new Date();
    await em.flush();
    const principal: SessionPrincipal = {
      accountId: account.id,
      loginId: account.loginId,
      displayName: account.displayName,
      role: account.role,
      merchantId: account.merchant?.id ?? null,
      merchantCode: account.merchant?.code ?? null,
    };
    const token = await this.sessions.create(principal, gen);
    // 이미 있던 세션은 지운다(같은 브라우저에 세션 두 개를 남기지 않는다, Task 2 리뷰)
    if (previousToken) await this.sessions.destroy(previousToken);
    return { token, session: principal };
  }

  async logout(token: string | null): Promise<void> {
    if (token) await this.sessions.destroy(token);
  }
}
