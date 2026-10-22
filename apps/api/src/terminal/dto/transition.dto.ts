import { IsEnum, IsInt, IsString, Length, Min } from 'class-validator';
import { TerminalStatus } from '../terminal-status.js';

export class TransitionDto {
  @IsEnum(TerminalStatus)
  to!: TerminalStatus;

  @IsString()
  @Length(1, 200)
  reason!: string;

  /** 화면에서 본 version. 그 사이 다른 변경이 있었으면 409 (decisions/0004) */
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
