import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { TerminalStatus } from '../terminal-status.js';

export class ListTerminalsQuery {
  @IsOptional()
  @IsEnum(TerminalStatus)
  status?: TerminalStatus;

  @IsOptional()
  @IsString()
  modelCode?: string;

  /** 시리얼 앞부분 */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  size: number = 20;
}
