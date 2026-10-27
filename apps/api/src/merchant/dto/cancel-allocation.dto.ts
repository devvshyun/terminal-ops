import { IsInt, IsString, Length, Matches, Min } from 'class-validator';
import type { CancelAllocationRequest } from '@terminal-ops/contracts';

export class CancelAllocationDto implements CancelAllocationRequest {
  @IsString()
  @Length(1, 200)
  @Matches(/\S/, { message: 'reason은 공백만으로 쓸 수 없습니다.' })
  reason!: string;

  /** 화면에서 본 version (decisions/0004) */
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
