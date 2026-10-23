import { IsBoolean, IsString, Length, Matches } from 'class-validator';
import { SERIAL_NO_MESSAGE, SERIAL_NO_PATTERN } from '../../terminal/bulk-rows.js';

export class OpenTicketDto {
  @Matches(SERIAL_NO_PATTERN, { message: SERIAL_NO_MESSAGE })
  serialNo!: string;

  @IsString()
  @Length(1, 200)
  @Matches(/\S/, { message: 'symptom은 공백만으로 쓸 수 없습니다.' })
  symptom!: string;
}

export class RemoteCheckDto {
  /** 원격 점검으로 해결됐는지 */
  @IsBoolean()
  resolved!: boolean;

  @IsString()
  @Length(1, 500)
  @Matches(/\S/, { message: 'note는 공백만으로 쓸 수 없습니다.' })
  note!: string;
}
