import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsBoolean, IsOptional, IsString, Length, ValidateNested } from 'class-validator';

export class InspectionResultDto {
  @IsString()
  itemCode!: string;

  @IsBoolean()
  passed!: boolean;

  @IsOptional()
  @IsString()
  @Length(0, 200)
  note?: string;
}

export class InspectDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => InspectionResultDto)
  results!: InspectionResultDto[];
}
