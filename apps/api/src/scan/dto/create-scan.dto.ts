import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsEnum, IsString, Matches, MinLength, ValidateIf } from 'class-validator';
import { ScanKind } from '../scan-batch.entity.js';

/** 박스 한 개의 스캔 결과. 시리얼 형식은 여기서 막지 않고 행별 결과(INVALID_FORMAT)로 돌려준다. */
export class CreateScanDto {
  /** 스캐너가 박스마다 만드는 멱등 키 */
  @Matches(/^[A-Za-z0-9_-]{8,64}$/, { message: 'scanId는 영문·숫자·_·- 8~64자입니다.' })
  scanId!: string;

  @IsEnum(ScanKind)
  kind!: ScanKind;

  /** RECEIVE일 때 필수 */
  @ValidateIf((o: CreateScanDto) => o.kind === ScanKind.RECEIVE)
  @IsString()
  @MinLength(1)
  poNo?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  serials!: string[];
}
