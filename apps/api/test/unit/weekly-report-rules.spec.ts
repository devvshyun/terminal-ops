import { describe, expect, it } from 'vitest';
import { attachmentDisposition } from '../../src/common/content-disposition.js';
import { MAX_RETRY_AFTER_MS } from '../../src/common/partner-http.js';
import { JOB_SCHEDULERS, WEEKLY_REPORT_JOB_OPTS } from '../../src/scheduler/job-schedulers.js';
import { weeklyReportLockTtlMs } from '../../src/report/weekly-report.service.js';

describe('Task 8 리뷰: 주간 리포트 보내기 규칙 (decisions/0035)', () => {
  it('잠금 TTL = 톡톡 단계 4개(올리기·메시지, UNKNOWN_FILE이면 한 번 더) × (3번 × 타임아웃 + 대기 2번 × Retry-After 상한) + 집계 여유 2분', () => {
    expect(weeklyReportLockTtlMs(3000)).toBe(4 * (3 * 3000 + 2 * MAX_RETRY_AFTER_MS) + 120_000);
    expect(weeklyReportLockTtlMs(10_000)).toBeGreaterThan(weeklyReportLockTtlMs(3000));
  });

  it('weekly-report 주기 job은 BullMQ 재시도 5번(지수 백오프). 재시도 간격의 합이 기본 잠금 TTL보다 길다 — 죽은 프로세스의 잠금이 풀린 뒤에도 재시도가 남는다', () => {
    const weekly = JOB_SCHEDULERS.find((s) => s.id === 'weekly-report')!;
    expect('jobOpts' in weekly && weekly.jobOpts).toEqual(WEEKLY_REPORT_JOB_OPTS);
    expect(WEEKLY_REPORT_JOB_OPTS).toMatchObject({ attempts: 5, backoff: { type: 'exponential' } });
    const { attempts, backoff } = WEEKLY_REPORT_JOB_OPTS;
    const waits = Array.from({ length: attempts - 1 }, (_, k) => backoff.delay * 2 ** k).reduce((a, b) => a + b, 0);
    expect(waits).toBeGreaterThan(weeklyReportLockTtlMs(3000));
    // 다른 주기 job은 재시도 옵션이 없다(그대로)
    expect(JOB_SCHEDULERS.filter((s) => 'jobOpts' in s).map((s) => s.id)).toEqual(['weekly-report']);
  });

  it("Content-Disposition: filename*는 encodeURIComponent가 남기는 ' ( ) * 도 퍼센트 인코딩한다(RFC 5987 attr-char)", () => {
    expect(attachmentDisposition("리포트 (최종)'*.xlsx", 'report.xlsx')).toBe(
      `attachment; filename="report.xlsx"; filename*=UTF-8''%EB%A6%AC%ED%8F%AC%ED%8A%B8%20%28%EC%B5%9C%EC%A2%85%29%27%2A.xlsx`,
    );
    expect(attachmentDisposition('단말온-주간리포트-2026-10-19.xlsx', 'weekly-report-2026-10-19.xlsx')).toBe(
      `attachment; filename="weekly-report-2026-10-19.xlsx"; filename*=UTF-8''${encodeURIComponent('단말온-주간리포트-2026-10-19.xlsx')}`,
    );
  });
});
