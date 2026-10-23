import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { FIRMWARE_VERSION_PATTERN } from '../../device/heartbeat.service.js';

const VERSION_MESSAGE = 'version은 영문·숫자·점·하이픈 1~20자입니다.';

export class RegisterFirmwareDto {
  @IsString()
  modelCode!: string;

  @Matches(FIRMWARE_VERSION_PATTERN, { message: VERSION_MESSAGE })
  version!: string;
}

export class CreateRolloutDto {
  @IsString()
  modelCode!: string;

  @Matches(FIRMWARE_VERSION_PATTERN, { message: VERSION_MESSAGE })
  version!: string;

  /** 단계별 누적 비율(%). 커지는 순서, 마지막은 100 (서비스가 확인) */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(100, { each: true })
  stages!: number[];

  @IsNumber()
  @Min(0)
  @Max(1)
  failureThreshold!: number;

  @IsInt()
  @Min(1)
  minSamples!: number;

  /** 단계 안에서 보고를 기다리는 시간(ms). 기본 10분 */
  @IsOptional()
  @IsInt()
  @Min(1)
  stageTimeoutMs?: number;
}
