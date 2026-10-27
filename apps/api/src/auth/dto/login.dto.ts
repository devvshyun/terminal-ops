import { IsString, Length } from 'class-validator';
import type { LoginRequest } from '@terminal-ops/contracts';

export class LoginDto implements LoginRequest {
  @IsString()
  @Length(1, 50)
  loginId!: string;

  @IsString()
  @Length(1, 200)
  password!: string;
}
