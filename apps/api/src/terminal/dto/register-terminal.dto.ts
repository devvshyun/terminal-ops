import { IsString, Matches } from 'class-validator';

export class RegisterTerminalDto {
  @Matches(/^[A-Z0-9-]{4,32}$/, { message: 'serialNo는 대문자·숫자·하이픈 4~32자입니다.' })
  serialNo!: string;

  @IsString()
  modelCode!: string;
}
