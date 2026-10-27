import { IsInt, IsString, Min, MinLength } from 'class-validator';
import type { AllocateRequest } from '@terminal-ops/contracts';

export class AllocateDto implements AllocateRequest {
  @IsString()
  @MinLength(1)
  merchantCode!: string;

  /** 화면에서 본 version (decisions/0004) */
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
