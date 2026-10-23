import { ArrayMaxSize, ArrayMinSize, IsArray, IsObject } from 'class-validator';

/** 한 요청에 담을 수 있는 하트비트 수 */
export const MAX_HEARTBEATS_PER_REQUEST = 500;

/**
 * 하트비트 묶음. 항목 하나가 틀려도 묶음 전체를 400으로 버리지 않도록, 항목 안의 필드는 서비스가 행마다 검사한다
 * (행별 결과 INVALID_FORMAT). 여기서는 묶음 모양(배열, 1~500개, 객체)만 본다.
 */
export class HeartbeatBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_HEARTBEATS_PER_REQUEST)
  @IsObject({ each: true })
  items!: Record<string, unknown>[];
}
