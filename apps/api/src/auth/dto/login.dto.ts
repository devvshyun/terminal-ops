import { IsString, Length, Matches } from 'class-validator';
import type { LoginRequest } from '@terminal-ops/contracts';

/**
 * 로그인 아이디는 ASCII 영문·숫자·`.`·`-`·`_` 3~50자(계정 만들기 규칙과 같은 글자, 대소문자는 받아 소문자로 접는다 — AuthService.normalizeLoginId).
 * 악센트·전각 글자를 막는 이유: 테이블 collation이 `óp1`·`ｏｐ１`을 `op1`과 같은 계정으로 찾아 아이디별 실패 제한을 우회할 수 있었다(Task 2 리뷰)
 */
export const LOGIN_ID_INPUT = /^[A-Za-z0-9._-]{3,50}$/;

export class LoginDto implements LoginRequest {
  @IsString()
  @Matches(LOGIN_ID_INPUT, { message: 'loginId는 영문·숫자·`.`·`-`·`_` 3~50자입니다.' })
  loginId!: string;

  @IsString()
  @Length(1, 200)
  password!: string;
}
