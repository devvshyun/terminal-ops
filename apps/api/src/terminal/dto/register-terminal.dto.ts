import { IsString, Matches } from 'class-validator';
import { SERIAL_NO_MESSAGE, SERIAL_NO_PATTERN } from '../bulk-rows.js';

export class RegisterTerminalDto {
  @Matches(SERIAL_NO_PATTERN, { message: SERIAL_NO_MESSAGE })
  serialNo!: string;

  @IsString()
  modelCode!: string;
}
