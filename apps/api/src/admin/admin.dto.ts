import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsEnum, IsIn, IsOptional, IsString, Length, Matches, ValidateIf } from 'class-validator';
import type { CreateAccountRequest, CreatePartnerKeyRequest, PartnerScope, UpdateAccountRequest } from '@terminal-ops/contracts';
import { LOGIN_ID_INPUT } from '../auth/dto/login.dto.js';
import { PARTNER_SCOPES } from '../auth/partner-key.entity.js';
import { Role } from '../auth/role.js';

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

export class CreatePartnerKeyDto implements CreatePartnerKeyRequest {
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
  @IsDateString()
  expiresAt?: string | null;
}
