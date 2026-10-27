import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsString, Length, ValidateNested } from 'class-validator';
import type { InspectionResultInput, InspectRequest } from '@terminal-ops/contracts';

export class InspectionResultDto implements InspectionResultInput {
  @IsString()
  itemCode!: string;

  @IsBoolean()
  passed!: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  note?: string;
}

export class InspectDto implements InspectRequest {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => InspectionResultDto)
  results!: InspectionResultDto[];
}
