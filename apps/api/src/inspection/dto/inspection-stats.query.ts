import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class InspectionStatsQuery {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  modelCode?: string;
}
