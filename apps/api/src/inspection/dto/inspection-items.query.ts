import { IsNotEmpty, IsString } from 'class-validator';

export class InspectionItemsQuery {
  @IsString()
  @IsNotEmpty()
  modelCode!: string;
}
