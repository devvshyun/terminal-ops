import { IsEnum, IsInt, IsString, Length, Matches, Min } from 'class-validator';
import type { TransitionRequest } from '@terminal-ops/contracts';
import { TerminalStatus } from '../terminal-status.js';

export class TransitionDto implements TransitionRequest {
  @IsEnum(TerminalStatus)
  to!: TerminalStatus;

  @IsString()
  @Length(1, 200)
  @Matches(/\S/, { message: 'reason은 공백만으로 쓸 수 없습니다.' })
  reason!: string;

  /** 화면에서 본 version. 그 사이 다른 변경이 있었으면 409 (decisions/0004) */
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
