import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { VanMismatchKind } from '../van.entities.js';

/** GET /van-reconciliations/:id 의 결과 목록 조건. 페이지는 afterId(키셋) — offset이 아니다(decisions/0033) */
export class VanItemsQuery {
  @IsOptional()
  @IsEnum(VanMismatchKind)
  kind?: VanMismatchKind;

  /** true: 재검증 뒤에도 어긋난 것, false: 재검증에서 풀린 것, 없으면 둘 다 */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  verified?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;
}
