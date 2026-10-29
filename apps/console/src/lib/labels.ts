import type { OpsActionKind, OpsErrorSource, OpsSchedulerView } from '@terminal-ops/contracts';

/** 최근 오류 출처(GET /ops/errors, decisions/0070) */
export const ERROR_SOURCE_LABEL: Record<OpsErrorSource, string> = {
  SYNC_RUN: '택배 수집',
  VAN_RUN: 'VAN 대조',
  WEEKLY_REPORT: '주간 리포트',
  OUTBOX: '알림(Outbox)',
};

/** 관제 작업 종류(GET /ops/actions, decisions/0073) */
export const ACTION_LABEL: Record<OpsActionKind, string> = {
  RETRY_JOB: '다시 시도',
  REMOVE_JOB: '지우기',
  REQUEUE_OUTBOX: 'Outbox 복구 sweep',
};

/** 주기: 간격은 가장 큰 딱 떨어지는 단위로('30초마다', '1분마다'), cron은 식과 시간대 그대로 */
export function scheduleText(s: Pick<OpsSchedulerView, 'every' | 'pattern' | 'tz'>): string {
  if (s.every !== null) {
    const units: [number, string][] = [
      [3_600_000, '시간'],
      [60_000, '분'],
      [1_000, '초'],
    ];
    const unit = units.find(([ms]) => s.every! % ms === 0);
    return unit ? `${s.every / unit[0]}${unit[1]}마다` : `${s.every}ms마다`;
  }
  return `cron ${s.pattern ?? '?'} (${s.tz ?? '서버 시간대'})`;
}
