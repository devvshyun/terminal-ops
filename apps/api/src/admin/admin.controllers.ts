import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import type { AccountView, CreatedPartnerKeyView, PartnerKeyView } from '@terminal-ops/contracts';
import { Roles } from '../auth/access.js';
import { AccountService } from '../auth/account.service.js';
import { PartnerKeyService } from '../auth/partner-key.service.js';
import { Role } from '../auth/role.js';
import { Operator } from '../common/operator.decorator.js';
import { CreateAccountDto, CreatePartnerKeyDto, UpdateAccountDto } from './admin.dto.js';

/** 계정·역할 관리(ADMIN만, decisions/0052). 화면은 Bundle 7 이후 — 지금은 API와 테스트까지 */
@Controller('admin/accounts')
export class AdminAccountsController {
  constructor(private readonly accounts: AccountService) {}

  @Get()
  @Roles(Role.ADMIN)
  list(): Promise<AccountView[]> {
    return this.accounts.list();
  }

  @Post()
  @Roles(Role.ADMIN)
  create(@Body() dto: CreateAccountDto): Promise<AccountView> {
    return this.accounts.create(dto);
  }

  /** 역할·가맹점·비밀번호·사용 중지를 바꾸면 그 계정의 세션을 모두 끊는다(다시 로그인해야 새 권한). 마지막 활성 ADMIN은 409 LAST_ADMIN */
  @Patch(':id')
  @Roles(Role.ADMIN)
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateAccountDto): Promise<AccountView> {
    return (await this.accounts.update(id, dto)).account;
  }
}

/** 외부 업체 키 발급·폐기(ADMIN만, decisions/0054). 개발자센터 화면은 Bundle 7 */
@Controller('admin/partner-keys')
export class AdminPartnerKeysController {
  constructor(private readonly keys: PartnerKeyService) {}

  @Get()
  @Roles(Role.ADMIN)
  list(): Promise<PartnerKeyView[]> {
    return this.keys.list();
  }

  /** 응답의 key(원문)는 이번 한 번만 — 저장하지 않는다 */
  @Post()
  @Roles(Role.ADMIN)
  create(@Body() dto: CreatePartnerKeyDto, @Operator() actor: string): Promise<CreatedPartnerKeyView> {
    return this.keys.create({ name: dto.name, scopes: dto.scopes, expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null }, actor);
  }

  @Post(':id/revoke')
  @Roles(Role.ADMIN)
  @HttpCode(200)
  revoke(@Param('id', ParseIntPipe) id: number): Promise<PartnerKeyView> {
    return this.keys.revoke(id);
  }
}
