import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import type { CreateAccountRequest, CreatePartnerKeyRequest, CreatePartnerRequest, PartnerScope, UpdateAccountRequest } from '@terminal-ops/contracts';
import { LOGIN_ID_INPUT } from '../auth/dto/login.dto.js';
import { PARTNER_SCOPES } from '../auth/partner-key.entity.js';
import { Role } from '../auth/role.js';
import { BeforeIdQuery } from '../common/keyset.js';
import { PARTNER_CODE } from '../partner/partner.entity.js';

const NOT_BLANK = /\S/;

export class CreateAccountDto implements CreateAccountRequest {
  /** 로그인과 같은 글자(영문 대소문자·숫자·`.`·`-`·`_` 3~50자). 대문자는 받아 소문자로 저장한다 */
  @Matches(LOGIN_ID_INPUT, { message: 'loginId는 영문·숫자·`.`·`-`·`_` 3~50자입니다(대문자는 소문자로 저장됩니다).' })
  loginId!: string;

  @IsString()
  @Length(1, 50)
  @Matches(NOT_BLANK, { message: 'displayName은 공백만으로 쓸 수 없습니다.' })
  displayName!: string;

  @IsString()
  @Length(10, 200)
  password!: string;

  @IsEnum(Role)
  role!: Role;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  merchantCode?: string | null;
}

export class UpdateAccountDto implements UpdateAccountRequest {
  @IsOptional()
  @IsString()
  @Length(1, 50)
  @Matches(NOT_BLANK, { message: 'displayName은 공백만으로 쓸 수 없습니다.' })
  displayName?: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  merchantCode?: string | null;

  @IsOptional()
  @IsString()
  @Length(10, 200)
  password?: string;

  @IsOptional()
  @IsBoolean()
  disabled?: boolean;
}

export class CreatePartnerDto implements CreatePartnerRequest {
  @Matches(PARTNER_CODE, { message: 'code는 대문자·숫자·`-` 2~20자입니다.' })
  code!: string;

  @IsString()
  @Length(1, 50)
  @Matches(NOT_BLANK, { message: 'name은 공백만으로 쓸 수 없습니다.' })
  name!: string;

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(200)
  memo?: string | null;
}

export class PartnerKeysQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  partnerId?: number;
}

/** GET /admin/partner-calls — 최근부터 beforeId 키셋(기본 50개, decisions/0082) */
export class PartnerCallsQuery extends BeforeIdQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  partnerId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  keyId?: number;

  override limit: number = 50;
}

export class CreatePartnerKeyDto implements CreatePartnerKeyRequest {
  /** JSON 본문이라 숫자로 바꾸지 않는다(@Type 없음) — 글자 "1"·true는 400(최종 검토) */
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  partnerId!: number;

  @IsString()
  @Length(1, 50)
  @Matches(NOT_BLANK, { message: 'name은 공백만으로 쓸 수 없습니다.' })
  name!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(PARTNER_SCOPES.length)
  @IsIn(PARTNER_SCOPES, { each: true })
  scopes!: PartnerScope[];

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString({ strict: true })
  expiresAt?: string | null;
}
