import { IsEnum, IsInt, Matches, Min } from 'class-validator';
import type { CreateShipmentRequest } from '@terminal-ops/contracts';
import { Carrier } from '../../carrier/carrier.types.js';

export class CreateShipmentDto implements CreateShipmentRequest {
  @Matches(/^[A-Z0-9-]{4,32}$/, { message: 'serialNo는 대문자·숫자·하이픈 4~32자입니다.' })
  serialNo!: string;

  @IsEnum(Carrier)
  carrier!: Carrier;

  /** 화면에서 본 version (decisions/0004) */
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
