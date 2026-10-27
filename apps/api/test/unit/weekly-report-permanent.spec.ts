import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import type { AnomalyService } from '../../src/anomaly/anomaly.service.js';
import { BusinessError } from '../../src/common/domain-errors.js';
import { PartnerPermanentError, PartnerTransientError } from '../../src/common/partner-errors.js';
import { ReportProcessor } from '../../src/report/report.processor.js';
import { WeeklyReportService, type SendResult } from '../../src/report/weekly-report.service.js';
import type { VanReconciliationService } from '../../src/van/van-reconciliation.service.js';

/**
 * Task 8·9 리뷰 반영: 다시 해도 같은 오류(파일 한도 초과 422, 톡톡 4xx·413 = PartnerPermanentError)는 BullMQ가 5번 다시 하지 않는다.
 * - 이어 보내는 앞선 주의 영구 오류는 warn만 남기고 job 오류로 올리지 않는다.
 * - 지난주의 영구 오류는 처리기가 UnrecoverableError로 감싼다(재시도 없이 실패).
 * - 일시 오류(5xx·타임아웃 등)는 어느 주든 그대로 던져 재시도한다 — 영구 오류 뒤에 가려지지 않는다.
 */
const tooLarge = () => new BusinessError(422, 'WEEKLY_REPORT_TOO_LARGE', '파일이 한도를 넘습니다.');
const permanent = () => new PartnerPermanentError('톡톡메신저 파일 응답 413: {"code":"FILE_TOO_LARGE"}');
const transient = () => new PartnerTransientError('톡톡메신저 응답 500');
const ok = (weekStart: string): SendResult => ({ report: { weekStart, status: 'SENT' } as SendResult['report'], alreadySent: false });

describe('주간 리포트 주기 job: 영구 오류는 재시도하지 않는다 (decisions/0035)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** send를 주마다 정한 결과로 바꾼 서비스. 지난주(2026-10-19) 앞 못 보낸 주는 2026-10-12, 2026-10-05 */
  const service = (results: Record<string, () => SendResult | Error>) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const s = new WeeklyReportService({} as never, {} as never, {} as never, {} as never, {} as never);
    vi.spyOn(s as unknown as { unsentWeeksBefore: () => Promise<string[]> }, 'unsentWeeksBefore').mockResolvedValue(['2026-10-12', '2026-10-05']);
    vi.spyOn(s, 'send').mockImplementation(async (week) => {
      const r = results[week.weekStart]!();
      if (r instanceof Error) throw r;
      return r;
    });
    return { s, warn };
  };
  const NOW = new Date('2026-10-26T00:00:00.000Z'); // 월요일 09:00 KST → 지난주 2026-10-19

  it('앞선 주의 영구 오류(422·413)는 warn만 남기고 지난주 결과로 끝난다(재시도하지 않음)', async () => {
    const { s, warn } = service({ '2026-10-19': () => ok('2026-10-19'), '2026-10-12': tooLarge, '2026-10-05': permanent });
    const result = await s.sendScheduled(NOW);
    expect(result.report.weekStart).toBe('2026-10-19');
    expect(result.carriedOver).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]![0])).toMatch(/2026-10-12.*영구 오류/);
  });

  it('앞선 주의 일시 오류는 그대로 던진다(재시도)', async () => {
    const { s } = service({ '2026-10-19': () => ok('2026-10-19'), '2026-10-12': permanent, '2026-10-05': transient });
    await expect(s.sendScheduled(NOW)).rejects.toBeInstanceOf(PartnerTransientError);
  });

  it('지난주가 영구 오류여도 다른 주의 일시 오류가 있으면 일시 오류를 던진다(영구 오류 뒤에 가려지지 않게)', async () => {
    const { s } = service({ '2026-10-19': tooLarge, '2026-10-12': transient, '2026-10-05': () => ok('2026-10-05') });
    await expect(s.sendScheduled(NOW)).rejects.toBeInstanceOf(PartnerTransientError);
  });

  it('지난주만 영구 오류면 그 오류를 던진다(처리기가 UnrecoverableError로 감싼다)', async () => {
    const { s } = service({ '2026-10-19': permanent, '2026-10-12': () => ok('2026-10-12'), '2026-10-05': () => ok('2026-10-05') });
    await expect(s.sendScheduled(NOW)).rejects.toBeInstanceOf(PartnerPermanentError);
  });

  describe('처리기(weekly-report job)', () => {
    const processor = (error: Error) => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const reports = { sendScheduled: vi.fn().mockRejectedValue(error) } as Partial<WeeklyReportService>;
      return new ReportProcessor({} as VanReconciliationService, {} as AnomalyService, reports as WeeklyReportService);
    };
    const job = { name: 'weekly-report', data: {} } as Job;

    it('422 WEEKLY_REPORT_TOO_LARGE → UnrecoverableError(메시지에 원래 오류)', async () => {
      const error = await processor(tooLarge()).process(job).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnrecoverableError);
      expect((error as Error).message).toMatch(/WEEKLY_REPORT_TOO_LARGE/);
    });

    it('톡톡 영구 오류(413 등 PartnerPermanentError) → UnrecoverableError', async () => {
      const error = await processor(permanent()).process(job).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnrecoverableError);
      expect((error as Error).message).toMatch(/413/);
    });

    it('일시 오류·잠금 409·그 밖의 오류는 그대로(BullMQ가 다시 한다)', async () => {
      for (const e of [transient(), new BusinessError(409, 'WEEKLY_REPORT_IN_PROGRESS', 'x'), new Error('집계 실패')]) {
        const error = await processor(e).process(job).catch((x: unknown) => x);
        expect(error).toBe(e);
        expect(error).not.toBeInstanceOf(UnrecoverableError);
      }
    });
  });

  describe('처리기(weekly-report-send job, 수동 보내기 — decisions/0038)', () => {
    const processor = (send: () => Promise<unknown>) => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const reports = { send: vi.fn().mockImplementation(send) } as Partial<WeeklyReportService>;
      return { p: new ReportProcessor({} as VanReconciliationService, {} as AnomalyService, reports as WeeklyReportService), reports };
    };
    const job = (data: unknown) => ({ name: 'weekly-report-send', data }) as Job;

    it('그 주를 send로 보내고 결과를 돌려준다. weekStart가 월요일이 아니면 UnrecoverableError(보내지 않음)', async () => {
      const { p, reports } = processor(async () => ok('2026-10-19'));
      expect(await p.process(job({ weekStart: '2026-10-19' }))).toEqual({ weekStart: '2026-10-19', status: 'SENT', alreadySent: false });
      expect(vi.mocked(reports.send!).mock.calls[0]![0].weekStart).toBe('2026-10-19');
      await expect(p.process(job({ weekStart: '2026-10-20' }))).rejects.toBeInstanceOf(UnrecoverableError);
      await expect(p.process(job({}))).rejects.toBeInstanceOf(UnrecoverableError);
      expect(reports.send).toHaveBeenCalledTimes(1);
    });

    it('같은 주를 주기 job이 보내는 중(409 WEEKLY_REPORT_IN_PROGRESS)이면 건너뛴다(그쪽이 끝낸다)', async () => {
      const { p } = processor(async () => {
        throw new BusinessError(409, 'WEEKLY_REPORT_IN_PROGRESS', 'x');
      });
      expect(await p.process(job({ weekStart: '2026-10-19' }))).toEqual({ weekStart: '2026-10-19', skipped: true });
    });

    it('영구 오류는 UnrecoverableError, 일시 오류는 그대로 던진다(재시도 옵션이 없어 job은 실패로 끝나고 행에 lastError가 남는다)', async () => {
      const perm = await processor(async () => {
        throw permanent();
      })
        .p.process(job({ weekStart: '2026-10-19' }))
        .catch((e: unknown) => e);
      expect(perm).toBeInstanceOf(UnrecoverableError);
      const e = transient();
      const temp = await processor(async () => {
        throw e;
      })
        .p.process(job({ weekStart: '2026-10-19' }))
        .catch((x: unknown) => x);
      expect(temp).toBe(e);
    });
  });
});
