import { IsBoolean, IsOptional } from 'class-validator';

/** POST /van-reconciliations 본문(없어도 된다) */
export class StartVanReconciliationDto {
  /**
   * 수집 급감을 운영자가 확인했다: 이 실행만 수집 급감 검사(마지막 완료 대비 VAN_FETCH_MIN_PCT, VAN 0건인데 운영 중 단말기 있음)를 건너뛴다.
   * 실행 행과 요약 알림에 남는다(decisions/0033). 후보 수 상한은 그대로 검사한다.
   */
  @IsOptional()
  @IsBoolean()
  acknowledgeDrop?: boolean;
}
