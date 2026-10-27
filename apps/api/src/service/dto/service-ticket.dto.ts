import { IsBoolean, IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';
import type { OpenTicketRequest, RemoteCheckRequest, ReplaceRequest } from '@terminal-ops/contracts';
import { Carrier } from '../../carrier/carrier.types.js';
import { BeforeIdQuery } from '../../common/keyset.js';
import { SERIAL_NO_MESSAGE, SERIAL_NO_PATTERN } from '../../terminal/bulk-rows.js';
import { ServiceTicketStatus } from '../service-ticket.entity.js';

export class OpenTicketDto implements OpenTicketRequest {
  @Matches(SERIAL_NO_PATTERN, { message: SERIAL_NO_MESSAGE })
  serialNo!: string;

  @IsString()
  @Length(1, 200)
  @Matches(/\S/, { message: 'symptom은 공백만으로 쓸 수 없습니다.' })
  symptom!: string;
}

export class RemoteCheckDto implements RemoteCheckRequest {
  /** 원격 점검으로 해결됐는지 */
  @IsBoolean()
  resolved!: boolean;

  @IsString()
  @Length(1, 500)
  @Matches(/\S/, { message: 'note는 공백만으로 쓸 수 없습니다.' })
  note!: string;
}

export class ReplaceDto implements ReplaceRequest {
  @Matches(SERIAL_NO_PATTERN, { message: SERIAL_NO_MESSAGE })
  replacementSerialNo!: string;

  @IsEnum(Carrier)
  carrier!: Carrier;
}

/** GET /service-tickets 조건(최근 접수부터, decisions/0039) */
export class ListTicketsQuery extends BeforeIdQuery {
  @IsOptional()
  @IsEnum(ServiceTicketStatus)
  status?: ServiceTicketStatus;

  /** 고장 접수된 단말기 시리얼(정확히 같은 것) */
  @IsOptional()
  @IsString()
  serialNo?: string;
}
