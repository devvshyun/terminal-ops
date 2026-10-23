import { IsInt, IsString, Max, Min, MinLength } from 'class-validator';

export class CreatePurchaseOrderDto {
  @IsString()
  @MinLength(1)
  modelCode!: string;

  /** 세움전자가 한 번에 받는 상한(5000)과 같다 */
  @IsInt()
  @Min(1)
  @Max(5000)
  quantity!: number;
}
