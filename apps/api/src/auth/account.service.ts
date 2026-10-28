import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/mysql';
import type { AccountView, ApiErrorBody, CreateAccountRequest, UpdateAccountRequest } from '@terminal-ops/contracts';
import { BusinessError } from '../common/domain-errors.js';
import { Merchant } from '../merchant/merchant.entity.js';
import { AuthService } from './auth.service.js';
import { hashPassword } from './password.js';
import { Role } from './role.js';
import { SessionStore } from './session.store.js';
import { UserAccount } from './user-account.entity.js';

export function toAccountView(a: UserAccount): AccountView {
  return {
    id: a.id,
    loginId: a.loginId,
    displayName: a.displayName,
    role: a.role,
    merchantCode: a.merchant?.code ?? null,
    disabled: a.disabledAt !== null,
    createdAt: a.createdAt.toISOString(),
    lastLoginAt: a.lastLoginAt?.toISOString() ?? null,
  };
}

const merchantRequired = (message: string) =>
  new BadRequestException({ statusCode: 400, code: 'MERCHANT_REQUIRED', message } satisfies ApiErrorBody);

/**
 * 계정 관리(ADMIN API, decisions/0051·0050). MERCHANT ⇔ 가맹점이 있음을 여기서 지킨다.
 * 로그인 아이디는 로그인 규칙(LoginDto)과 같은 글자만 받고 소문자로 저장한다 — 로그인이 아이디를 소문자로 접어 찾기 때문이다.
 * 역할·가맹점·비밀번호를 바꾸거나 사용 중지하면 그 계정의 세션을 모두 끊는다 — 세션에 역할을 넣어 두었으므로(요청마다 MySQL을 읽지 않음) 바뀐 권한은 다시 로그인해야 적용된다.
 * 세션 끊기(destroyAllFor)는 반드시 DB 트랜잭션이 커밋된 **뒤에** 부른다(decisions/0050).
 * 마지막 활성 ADMIN은 사용 중지도 강등도 못 한다(409 LAST_ADMIN, decisions/0054).
 */
@Injectable()
export class AccountService {
  constructor(
    private readonly em: EntityManager,
    private readonly sessions: SessionStore,
  ) {}

  async list(): Promise<AccountView[]> {
    return (await this.em.fork().find(UserAccount, {}, { populate: ['merchant'], orderBy: { id: 'asc' } })).map(toAccountView);
  }

  private async merchantFor(em: EntityManager, role: Role, merchantCode: string | null | undefined): Promise<Merchant | null> {
    if (role !== Role.MERCHANT) {
      if (merchantCode) throw merchantRequired('가맹점은 MERCHANT 계정에만 줄 수 있습니다.');
      return null;
    }
    if (!merchantCode) throw merchantRequired('MERCHANT 계정에는 가맹점(merchantCode)이 필요합니다.');
    const merchant = await em.findOne(Merchant, { code: merchantCode });
    if (!merchant) throw new NotFoundException(`가맹점 ${merchantCode}이(가) 없습니다.`);
    return merchant;
  }

  async create(dto: CreateAccountRequest): Promise<AccountView> {
    const em = this.em.fork();
    const role = dto.role as Role;
    const merchant = await this.merchantFor(em, role, dto.merchantCode);
    const loginId = AuthService.normalizeLoginId(dto.loginId);
    const account = em.create(UserAccount, { loginId, displayName: dto.displayName, role, merchant, passwordHash: await hashPassword(dto.password) });
    await em.flush();
    return toAccountView(account);
  }

  /** 준 것만 바꾼다. 끊은 세션 수를 함께 돌려준다 */
  async update(id: number, dto: UpdateAccountRequest): Promise<{ account: AccountView; revokedSessions: number }> {
    const passwordHash = dto.password !== undefined ? await hashPassword(dto.password) : undefined;
    const { account, accessChanged } = await this.em.fork().transactional(async (em) => {
      const current = await em.findOne(UserAccount, id);
      if (!current) throw new NotFoundException(`계정 ${id}이(가) 없습니다.`);
      // ADMIN 계정이면 활성 ADMIN 행을 id 순으로 잠근다(FOR UPDATE) — 둘이 서로를 동시에 내려도 한쪽은 잠금을 기다렸다 바뀐 수를 본다.
      // 잠근 뒤에 대상 행을 다시 읽어(refresh) 기다리는 동안 바뀐 상태로 판단한다
      const lockedAdmins =
        current.role === Role.ADMIN
          ? await em.find(UserAccount, { role: Role.ADMIN, disabledAt: null }, { orderBy: { id: 'asc' }, lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true })
          : [];
      const account = await em.findOneOrFail(UserAccount, id, { populate: ['merchant'], refresh: true });
      const role = (dto.role as Role | undefined) ?? account.role;
      const nextDisabled = dto.disabled ?? account.disabledAt !== null;
      // "지금 활성 ADMIN인가·다른 활성 ADMIN이 있나"는 잠근 목록(FOR UPDATE = 지금 커밋된 값)으로만 판단한다.
      // 일반 읽기(refresh 포함)는 REPEATABLE READ 스냅샷이라 처음 읽은 뒤 커밋된 변경을 못 본다 — 그 값으로 판단하면
      // 이미 중지된 대상을 "마지막 활성 ADMIN"으로 보고 빈 잠금 목록에서 409를 낼 수 있었다(Task 5 보안 리뷰, admin-last-admin.e2e)
      const wasActiveAdmin = lockedAdmins.some((a) => a.id === account.id);
      const otherActiveAdmins = lockedAdmins.filter((a) => a.id !== account.id).length;
      if (wasActiveAdmin && (role !== Role.ADMIN || nextDisabled) && otherActiveAdmins === 0) {
        throw new BusinessError(409, 'LAST_ADMIN', '마지막 활성 ADMIN은 사용 중지하거나 다른 역할로 바꿀 수 없습니다. 다른 ADMIN을 먼저 만드세요.');
      }
      const merchantCode = dto.merchantCode !== undefined ? dto.merchantCode : role === account.role ? account.merchant?.code : undefined;
      const merchant = await this.merchantFor(em, role, merchantCode);
      const accessChanged =
        role !== account.role || (merchant?.id ?? null) !== (account.merchant?.id ?? null) || dto.password !== undefined || nextDisabled !== (account.disabledAt !== null);
      if (dto.displayName !== undefined) account.displayName = dto.displayName;
      account.role = role;
      account.merchant = merchant;
      if (passwordHash !== undefined) account.passwordHash = passwordHash;
      if (dto.disabled !== undefined) account.disabledAt = dto.disabled ? (account.disabledAt ?? new Date()) : null;
      return { account, accessChanged };
    });
    // 트랜잭션이 커밋된 뒤에 세션을 끊는다 — 안에서 부르면 로그인이 새 세대값을 읽고도 아직 커밋 안 된 옛 행을 읽는 경합이 열린다(decisions/0050)
    const revokedSessions = accessChanged ? await this.sessions.destroyAllFor(account.id) : 0;
    return { account: toAccountView(account), revokedSessions };
  }
}
