import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AnomalyRule } from '../anomaly.entity.js';

/** GET /anomalies 조건. 페이지는 afterId(키셋, decisions/0033과 같은 이유) */
export class ListAnomaliesQuery {
  @IsOptional()
  @IsEnum(AnomalyRule)
  rule?: AnomalyRule;

  /** true: 열린 이상만, false: 닫힌 이상만, 없으면 둘 다 */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  open?: boolean;

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
