import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cronFromEnv, nextCronRun } from '../../src/config/env-cron.js';

describe('cronFromEnv — cron 환경변수 검증 (fix, decisions/0035)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('없거나 빈 글자(공백)면 기본값, 다섯 칸 식이면 그 값(앞뒤 공백은 무시)', () => {
    expect(cronFromEnv('X', '0 2 * * *', {})).toBe('0 2 * * *');
    expect(cronFromEnv('X', '0 2 * * *', { X: '' })).toBe('0 2 * * *');
    expect(cronFromEnv('X', '0 2 * * *', { X: '   ' })).toBe('0 2 * * *');
    expect(cronFromEnv('X', '0 2 * * *', { X: ' 30 4 * * 1-5 ' })).toBe('30 4 * * 1-5');
    expect(cronFromEnv('X', '0 2 * * *', { X: '*/15 0-6 1,15 * MON' })).toBe('*/15 0-6 1,15 * MON');
  });

  it.each([
    ['네 칸', '0 2 * *'],
    ['여섯 칸(초)', '0 0 2 * * *'],
    ['@ 별칭', '@daily'],
    ['없는 시', '0 25 * * *'],
    ['글자', 'every day'],
  ])('%s 식 %s는 이름과 값을 담아 던진다', (_what, raw) => {
    expect(() => cronFromEnv('ANOMALY_SCAN_CRON', '0 2 * * *', { ANOMALY_SCAN_CRON: raw })).toThrow(/환경변수 ANOMALY_SCAN_CRON=.*cron/);
  });

  it('nextCronRun은 Asia/Seoul로 해석한다(기본 식: 02:00 KST = 전날 17:00 UTC, 03:00 KST = 18:00 UTC)', () => {
    const from = new Date('2026-10-26T01:22:00.000Z'); // 월 10:22 KST
    expect(nextCronRun('0 2 * * *', from).toISOString()).toBe('2026-10-26T17:00:00.000Z');
    expect(nextCronRun('0 3 * * *', from).toISOString()).toBe('2026-10-26T18:00:00.000Z');
    expect(nextCronRun('0 9 * * 1', from).toISOString()).toBe('2026-11-02T00:00:00.000Z'); // 주간 리포트: 다음 월 09:00 KST = 월 00:00 UTC
  });

  it.each(['ANOMALY_SCAN_CRON', 'VAN_RECONCILE_CRON', 'WEEKLY_REPORT_CRON'])('env 모듈은 %s가 잘못된 식이면 불러올 때 던진다(서버·워커가 뜨지 않는다)', async (name) => {
    vi.stubEnv(name, '@daily');
    vi.resetModules();
    await expect(import('../../src/config/env.js')).rejects.toThrow(new RegExp(name));
  });

  it('env 모듈: 빈 cron env는 기본값', async () => {
    vi.stubEnv('ANOMALY_SCAN_CRON', ' ');
    vi.stubEnv('VAN_RECONCILE_CRON', '');
    vi.stubEnv('WEEKLY_REPORT_CRON', '  ');
    vi.resetModules();
    const { env } = await import('../../src/config/env.js');
    expect([env.anomalyScanCron, env.vanReconcileCron, env.weeklyReportCron]).toEqual(['0 2 * * *', '0 3 * * *', '0 9 * * 1']);
  });
});

describe('cron-parser 판 고정 검사 (리뷰 반영, decisions/0035)', () => {
  const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

  it('package.json의 cron-parser는 bullmq가 고정한 판과 같다(다르면 cronFromEnv 검사는 통과해도 BullMQ가 다르게 읽을 수 있다)', () => {
    const ours = readJson('../../package.json').dependencies['cron-parser'];
    const bullmqs = readJson('../../node_modules/bullmq/package.json').dependencies['cron-parser'];
    expect(ours).toMatch(/^\d+\.\d+\.\d+$/); // 범위(^·~)가 아닌 정확한 판
    expect(ours).toBe(bullmqs);
  });
});
