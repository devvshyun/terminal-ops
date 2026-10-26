import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { AnomalyService } from '../../src/anomaly/anomaly.service.js';
import { BusinessError } from '../../src/common/domain-errors.js';
import { ReportProcessor } from '../../src/report/report.processor.js';
import type { VanReconciliationService } from '../../src/van/van-reconciliation.service.js';

const job = (name: string) => ({ name, data: {} }) as Job;

describe('fix 4: report 큐 주기 job 로그(건너뜀은 warn, 끝나면 한 줄 요약)', () => {
  afterEach(() => vi.restoreAllMocks());

  const setup = (anomalies: Partial<AnomalyService>, van: Partial<VanReconciliationService>) => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const p = new ReportProcessor(van as VanReconciliationService, anomalies as AnomalyService);
    return { p, log, warn };
  };

  it('anomaly-scan: 끝나면 새로·계속·풀림 수, 수동 찾기가 돌고 있으면 warn', async () => {
    const scan = vi.fn().mockResolvedValueOnce({ detected: 2, continuing: 5, resolved: 1, open: {}, newMatches: [] });
    const { p, log, warn } = setup({ scan }, {});
    await expect(p.process(job('anomaly-scan'))).resolves.toEqual({ detected: 2, continuing: 5, resolved: 1, open: {} });
    expect(log).toHaveBeenCalledWith('anomaly-scan 끝: 새로 2, 계속 5, 풀림 1');

    scan.mockRejectedValueOnce(new BusinessError(409, 'ANOMALY_SCAN_RUNNING', 'x'));
    await expect(p.process(job('anomaly-scan'))).resolves.toEqual({ skipped: true });
    expect(warn).toHaveBeenCalledWith('anomaly-scan 건너뜀: 다른 이상 찾기가 돌고 있음');
  });

  it('van-reconcile-scheduled: 끝나면 실행 번호와 상태, 진행 중인 실행이 있으면 warn', async () => {
    const runScheduled = vi.fn().mockResolvedValueOnce({ runId: 7, status: 'COMPLETED' }).mockResolvedValueOnce({ runId: null, skipped: true });
    const { p, log, warn } = setup({}, { runScheduled });
    await p.process(job('van-reconcile-scheduled'));
    expect(log).toHaveBeenCalledWith('van-reconcile-scheduled 끝: 실행 #7 COMPLETED');
    await expect(p.process(job('van-reconcile-scheduled'))).resolves.toEqual({ runId: null, skipped: true });
    expect(warn).toHaveBeenCalledWith('van-reconcile-scheduled 건너뜀: 진행 중인 VAN 대조가 있음');
  });

  it('리뷰 반영: 주기·수동 VAN 대조가 FAILED로 끝나면 log가 아니라 warn(밤에 사람 없이 돈 실패를 로그 수준으로 거를 수 있게)', async () => {
    const runScheduled = vi.fn().mockResolvedValueOnce({ runId: 8, status: 'FAILED' });
    const execute = vi.fn().mockResolvedValueOnce({ id: 9, status: 'FAILED', confirmed: 0, startedAt: new Date(), heartbeatAt: new Date(), finishedAt: new Date() });
    const { p, log, warn } = setup({}, { runScheduled, execute } as Partial<VanReconciliationService>);
    await p.process(job('van-reconcile-scheduled'));
    expect(warn).toHaveBeenCalledWith('van-reconcile-scheduled 끝: 실행 #8 FAILED');
    await p.process({ name: 'van-reconcile', data: { runId: 9 } } as Job);
    expect(warn).toHaveBeenCalledWith('van-reconcile 끝: 실행 #9 FAILED, 어긋남 0');
    expect(log).not.toHaveBeenCalled();
  });
});
