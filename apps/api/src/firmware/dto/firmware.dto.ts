import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import type { CreateRolloutRequest, RegisterFirmwareRequest } from '@terminal-ops/contracts';
import { BeforeIdQuery } from '../../common/keyset.js';
import { FIRMWARE_VERSION_PATTERN } from '../../device/heartbeat.service.js';
import { SERIAL_NO_MESSAGE, SERIAL_NO_PATTERN } from '../../terminal/bulk-rows.js';
import { RolloutStatus } from '../firmware.entities.js';

const VERSION_MESSAGE = 'version은 영문·숫자·점·하이픈 1~20자입니다.';

/** 단계 제한 시간 상한(하루). firmware_rollout.stage_timeout_ms는 int(최대 2,147,483,647ms ≈ 24.8일) */
export const MAX_STAGE_TIMEOUT_MS = 24 * 60 * 60_000;

export class RegisterFirmwareDto implements RegisterFirmwareRequest {
  @IsString()
  modelCode!: string;

  @Matches(FIRMWARE_VERSION_PATTERN, { message: VERSION_MESSAGE })
  version!: string;
}

/** GET /firmware 조건(최근 등록부터, decisions/0039). 모델로 거른다 — 배포 만들기 화면의 버전 선택지(decisions/0066) */
export class ListFirmwareQuery extends BeforeIdQuery {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  modelCode?: string;
}

export class CreateRolloutDto implements CreateRolloutRequest {
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

  /** 단계 안에서 보고를 기다리는 시간(ms). 기본 10분, 최대 하루(열은 int라 약 24.8일까지 담기지만 그 전에 끊는다) */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_STAGE_TIMEOUT_MS)
  stageTimeoutMs?: number;
}

/** 단말기의 업데이트 결과 보고 */
export class FirmwareReportDto {
  @Matches(SERIAL_NO_PATTERN, { message: SERIAL_NO_MESSAGE })
  serialNo!: string;

  @IsInt()
  @Min(1)
  rolloutId!: number;

  @IsBoolean()
  success!: boolean;

  @Matches(FIRMWARE_VERSION_PATTERN, { message: VERSION_MESSAGE })
  version!: string;
}

/** GET /firmware-rollouts 조건(최근 배포부터, decisions/0039) */
export class ListRolloutsQuery extends BeforeIdQuery {
  @IsOptional()
  @IsEnum(RolloutStatus)
  status?: RolloutStatus;
}
