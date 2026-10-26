import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import type { Redis } from 'ioredis';
import { env } from '../src/config/env.js';
import { RedisLock } from '../src/redis/redis-lock.js';
import { kstWeekOf, parseKstWeekStart } from '../src/report/kst-week.js';
import { REDIS } from '../src/redis/redis.provider.js';
import { WeeklyReport, WeeklyReportStatus } from '../src/report/weekly-report.entity.js';
import { WeeklyReportQueries } from '../src/report/weekly-report.queries.js';
import { WeeklyReportService } from '../src/report/weekly-report.service.js';
import { SHEET_NAMES } from '../src/report/weekly-report.xlsx.js';
import { TerminalStatus as S } from '../src/terminal/terminal-status.js';
import { partners } from './helpers/partners.js';
import { deleteTestKeys } from './helpers/redis-keys.js';
import { insertTerminals } from './helpers/terminals.js';
import { createTestApp, resetDatabase, type TestApp } from './helpers/test-app.js';

const OP = { 'X-Operator': 'park' };

async function readXlsx(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  return wb;
}

describe('주간 운영 리포트 — xlsx, 톡톡 첨부, 멱등, 내려받기 (F11, decisions/0035)', () => {
  let t: TestApp;
  const em = () => t.orm.em.fork();
  const row = (weekStart: string) => em().findOneOrFail(WeeklyReport, { weekStart });
  const send = (weekStart?: string) => t.http().post('/reports/weekly').set(OP).send(weekStart ? { weekStart } : {});

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await insertTerminals(t, [
      { serialNo: 'WK-01', status: S.IN_SERVICE, merchantCode: 'GANGNAM-KIMBAP' },
      { serialNo: 'WK-02', status: S.IN_STOCK, modelCode: 'SN-200' },
    ]);
  });
  beforeEach(async () => {
    await partners.reset();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await deleteTestKeys(t.app.get<Redis>(REDIS));
    await t.app.close();
  });

  it('보내면 xlsx를 만들어 저장하고, 톡톡에 파일을 올려 메시지에 첨부한다(이름·크기가 같다)', async () => {
    const res = await send('2026-10-19');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      weekStart: '2026-10-19',
      status: 'SENT',
      fileName: '단말온-주간리포트-2026-10-19.xlsx',
      attempts: 1,
      lastError: null,
      alreadySent: false,
    });
    expect(res.body.fileSize).toBeGreaterThan(1000);
    const toktok = await partners.toktok();
    expect(toktok.total).toBe(1);
    expect(toktok.messages[0]).toMatchObject({ idempotencyKey: 'weekly-report-2026-10-19' });
    expect(toktok.messages[0].attachments).toEqual([{ fileId: expect.any(String), fileName: res.body.fileName, size: res.body.fileSize }]);
    expect((await row('2026-10-19')).toktokFileId).toBe(toktok.messages[0].attachments[0].fileId);

    // 메신저가 받은 첨부를 그대로 열어 본다
    const wb = await readXlsx(await partners.toktokFile(toktok.messages[0].attachments[0].fileId));
    expect(wb.worksheets.map((w) => w.name)).toEqual([...SHEET_NAMES]);
    const summary = wb.getWorksheet('요약')!;
    expect(summary.getRow(2).values).toEqual([undefined, '주', '2026-10-19 ~ 2026-10-25 (KST)']);
    expect(summary.getRow(4).values).toEqual([undefined, '단말기 총수', 2]);
    expect(summary.lastRow!.values).toEqual([undefined, '기준', expect.stringMatching(/^현황\(상태·이상·접속\)은 만든 시각, 전이·입출고·배포는 그 주/)]);
    // 리뷰 반영: 현황 시트는 첫 줄에 "생성 시점 기준", 배포 시트는 "누적"을 적고 머리글은 2행(decisions/0035)
    for (const name of ['상태·모델', '이상 단말기', '접속 상태']) {
      expect(String(wb.getWorksheet(name)!.getCell('A1').value)).toMatch(/^생성 시점\(2026-\d\d-\d\d \d\d:\d\d KST\) 기준 현황/);
    }
    const rollout = wb.getWorksheet('펌웨어 배포')!;
    expect(String(rollout.getCell('A1').value)).toMatch(/대상·성공·실패·시간 초과 수는 배포마다 누적/);
    expect(rollout.getRow(2).values).toEqual(expect.arrayContaining(['대상(누적)', '성공(누적)', '실패(누적)', '시간 초과(누적)']));
    const status = wb.getWorksheet('상태·모델')!;
    expect(status.getRow(2).values).toEqual([undefined, '모델', '상태', '대수']);
    expect(status.getRow(3).values).toEqual([undefined, 'SN-100', 'IN_SERVICE', 1]);
  });

  it('같은 주를 다시 보내면 아무것도 하지 않는다(alreadySent, 올리기·메시지 0번)', async () => {
    // 리뷰 반영: 앞 테스트에 기대지 않고 이 테스트가 보낸 주로 본다
    expect((await send('2026-09-28')).body).toMatchObject({ status: 'SENT', alreadySent: false });
    await partners.reset();
    const res = await send('2026-09-28');
    expect(res.body).toMatchObject({ status: 'SENT', alreadySent: true, attempts: 1 });
    expect(await partners.toktok()).toMatchObject({ total: 0, files: 0 });
  });

  it('리뷰 반영: 메시지 단계만 실패하면 올린 fileId를 바로 저장하고, 다시 보낼 때 올리지 않고 그 파일로 보낸다', async () => {
    await partners.configure({ toktok: { hookFailRate: 1 } });
    expect((await send('2026-09-21')).status).toBe(502);
    const r1 = await row('2026-09-21');
    expect(r1).toMatchObject({ status: WeeklyReportStatus.GENERATED, attempts: 1 });
    expect(r1.toktokFileId).toMatch(/^TF\d+$/);
    expect(r1.lastError).toMatch(/톡톡메신저 응답 500/);
    expect((await partners.stats()).calls).toMatchObject({ 'toktok.file': 1, 'toktok.hook': 3 });

    await partners.configure({ toktok: { hookFailRate: 0 } });
    const ok = await send('2026-09-21');
    expect(ok.body).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
    expect((await partners.stats()).calls).toMatchObject({ 'toktok.file': 1, 'toktok.hook': 4 }); // 다시 올리지 않았다
    const toktok = await partners.toktok();
    expect(toktok).toMatchObject({ total: 1, files: 1 });
    expect(toktok.messages[0].attachments[0].fileId).toBe(r1.toktokFileId);
    expect((await row('2026-09-21')).toktokFileId).toBe(r1.toktokFileId);
  }, 20_000);

  it('리뷰 반영: 저장한 fileId를 메신저가 모르면(UNKNOWN_FILE 400) 한 번 다시 올려 보낸다', async () => {
    await partners.configure({ toktok: { hookFailRate: 1 } });
    expect((await send('2026-09-14')).status).toBe(502);
    const old = (await row('2026-09-14')).toktokFileId;
    await partners.reset(); // 메신저가 올린 파일을 잊었다
    const ok = await send('2026-09-14');
    expect(ok.body).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
    expect((await partners.stats()).calls).toMatchObject({ 'toktok.file': 1, 'toktok.hook': 2 }); // 400 한 번 → 올리기 → 메시지
    const toktok = await partners.toktok();
    expect(toktok.total).toBe(1);
    const fileId = toktok.messages[0].attachments[0].fileId;
    expect(fileId).not.toBe(old);
    expect((await row('2026-09-14')).toktokFileId).toBe(fileId);
  }, 20_000);

  it('리뷰 반영: 메신저가 파일이 크다고 하면(413) 다시 하지 않고 502, 행은 GENERATED·lastError', async () => {
    await partners.configure({ toktok: { maxFileBytes: 100 } });
    const res = await send('2026-08-31');
    expect(res.status).toBe(502);
    expect(res.body.reason).toBe('PartnerPermanentError');
    expect((await partners.stats()).calls['toktok.file']).toBe(1);
    const r = await row('2026-08-31');
    expect(r).toMatchObject({ status: WeeklyReportStatus.GENERATED, attempts: 1, toktokFileId: null });
    expect(r.lastError).toMatch(/톡톡메신저 파일 응답 413/);
  });

  it('리뷰 반영: 만든 파일이 톡톡 한도(TOKTOK_MAX_FILE_BYTES)를 넘으면 올리기 전에 422, 저장하지 않고 lastError·attempts를 남긴다', async () => {
    const saved = env.toktokMaxFileBytes;
    env.toktokMaxFileBytes = 1000;
    try {
      const res = await send('2026-08-24');
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('WEEKLY_REPORT_TOO_LARGE');
    } finally {
      env.toktokMaxFileBytes = saved;
    }
    expect((await partners.stats()).calls['toktok.file']).toBeUndefined();
    const r = await row('2026-08-24');
    expect(r).toMatchObject({ status: WeeklyReportStatus.PENDING, attempts: 1, fileSize: null });
    expect(r.lastError).toMatch(/WEEKLY_REPORT_TOO_LARGE|바이트/);
  });

  it('리뷰 반영: 집계가 실패해도 lastError·attempts를 남기고, 다시 보내면 만든다', async () => {
    vi.spyOn(t.app.get(WeeklyReportQueries), 'collect').mockRejectedValueOnce(new Error('집계 실패(테스트)'));
    expect((await send('2026-08-17')).status).toBe(500);
    expect(await row('2026-08-17')).toMatchObject({ status: WeeklyReportStatus.PENDING, attempts: 1, lastError: 'Error: 집계 실패(테스트)' });
    expect((await send('2026-08-17')).body).toMatchObject({ status: 'SENT', attempts: 2, lastError: null });
  });

  it('리뷰 반영: 같은 주를 동시에 두 번 보내면 하나는 409(또는 이미 보냄)이고 메시지는 한 번', async () => {
    const [a, b] = await Promise.all([send('2026-08-10'), send('2026-08-10')]);
    const statuses = [a.status, b.status].sort();
    expect([[200, 409], [200, 200]]).toContainEqual(statuses);
    if (statuses[1] === 200) expect([a.body.alreadySent, b.body.alreadySent].sort()).toEqual([false, true]);
    expect((await partners.toktok()).total).toBe(1);
    expect((await row('2026-08-10')).attempts).toBe(1);
  });

  it('톡톡이 계속 실패하면 502이고 행은 GENERATED(파일 저장, lastError). 다시 보내면 같은 파일로 보낸다', async () => {
    await partners.configure({ toktok: { failRate: 1 } });
    const failed = await send('2026-10-12');
    expect(failed.status).toBe(502);
    expect(failed.body.code).toBe('PARTNER_ERROR');
    const r1 = await row('2026-10-12');
    expect(r1).toMatchObject({ status: WeeklyReportStatus.GENERATED, attempts: 1 });
    expect(r1.lastError).toMatch(/톡톡메신저 파일 응답 500/);
    expect((await partners.stats()).calls['toktok.file']).toBe(3); // 3번까지 다시 불렀다

    await partners.configure({ toktok: { failRate: 0 } });
    const ok = await send('2026-10-12');
    expect(ok.body).toMatchObject({ status: 'SENT', attempts: 2, lastError: null, fileSize: r1.fileSize });
    expect(ok.body.generatedAt).toBe(r1.generatedAt!.toISOString()); // 다시 만들지 않았다
  }, 20_000);

  it('GET 상태와 xlsx 내려받기(한글 파일 이름은 filename*), 주 형식이 틀리면 400, 없으면 404', async () => {
    const meta = await t.http().get('/reports/weekly/2026-10-19');
    expect(meta.body).toMatchObject({ weekStart: '2026-10-19', status: 'SENT' });
    const file = await t.http().get('/reports/weekly/2026-10-19/file').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(file.headers['cache-control']).toBe('no-store'); // 리뷰 반영: 운영 수치 파일을 중간 캐시가 들고 있지 않게
    expect(file.headers['content-disposition']).toBe(
      `attachment; filename="weekly-report-2026-10-19.xlsx"; filename*=UTF-8''${encodeURIComponent('단말온-주간리포트-2026-10-19.xlsx')}`,
    );
    expect((file.body as Buffer).length).toBe(meta.body.fileSize);
    expect((await readXlsx(file.body as Buffer)).worksheets).toHaveLength(SHEET_NAMES.length);

    expect((await t.http().get('/reports/weekly/2026-10-20')).body.code).toBe('INVALID_WEEK_START'); // 화요일
    expect((await send('2026-10-20')).status).toBe(400);
    expect((await t.http().get('/reports/weekly/2026-09-07')).status).toBe(404);
    expect((await t.http().get('/reports/weekly/2026-09-07/file')).status).toBe(404);
  });

  it('최종 리뷰 반영: 끝나지 않은 주(이번 주·미래 주)는 422 WEEK_NOT_ENDED로 거절하고 행을 만들지 않는다', async () => {
    const thisWeek = kstWeekOf(new Date());
    const nextWeek = kstWeekOf(new Date(thisWeek.to.getTime()));
    for (const week of [thisWeek, nextWeek]) {
      const res = await send(week.weekStart);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('WEEK_NOT_ENDED');
      expect(await em().findOne(WeeklyReport, { weekStart: week.weekStart })).toBeNull();
    }
    expect(await partners.toktok()).toMatchObject({ total: 0, files: 0 });
    // 서비스 경로도 같다(주기 job은 늘 지난주라 걸리지 않는다). 주가 끝나는 순간(to)부터 보낼 수 있다
    const service = t.app.get(WeeklyReportService);
    const week = parseKstWeekStart('2026-07-06')!;
    await expect(service.send(week, new Date(week.to.getTime() - 1))).rejects.toMatchObject({ code: 'WEEK_NOT_ENDED' });
    expect(await em().findOne(WeeklyReport, { weekStart: '2026-07-06' })).toBeNull();
    expect((await service.send(week, week.to)).report.status).toBe(WeeklyReportStatus.SENT);
  });

  it('같은 주를 다른 요청이 보내는 중이면 409 WEEKLY_REPORT_IN_PROGRESS', async () => {
    const lock = t.app.get(RedisLock);
    const key = lock.keyOf('report-lock', 'weekly-2026-10-05');
    const token = await lock.acquire(key, 10_000);
    try {
      const busy = await send('2026-10-05');
      expect(busy.status).toBe(409);
      expect(busy.body.code).toBe('WEEKLY_REPORT_IN_PROGRESS');
    } finally {
      await lock.release(key, token!);
    }
  });

  it('주기 job은 지난주를 보낸다(월요일 09:00 KST에 돌면 그 앞 주)', async () => {
    const { report, alreadySent } = await t.app.get(WeeklyReportService).sendScheduled(new Date('2026-11-02T00:00:00.000Z'));
    expect([report.weekStart, report.status, alreadySent]).toEqual(['2026-10-26', WeeklyReportStatus.SENT, false]);
  });

  it('리뷰 반영: 주기 job은 지난주를 먼저 보내고, 직전 4주 중 못 보낸 주(PENDING·GENERATED)를 최근 주부터 이어 보낸다', async () => {
    // 2027-03-08(월) 09:00 KST → 지난주 2027-03-01. 4주 안: 02-15(GENERATED), 02-01(PENDING). 5주 전 01-25(GENERATED)는 두고 간다
    // 최종 리뷰 반영: 미래 주는 HTTP로 보낼 수 없어(422 WEEK_NOT_ENDED) 서비스를 그 주가 끝난 시각(now)으로 부른다
    const at = new Date('2027-03-08T00:00:00.000Z');
    const service = t.app.get(WeeklyReportService);
    const sendAt = (weekStart: string) => service.send(parseKstWeekStart(weekStart)!, at);
    await partners.configure({ toktok: { hookFailRate: 1 } });
    await expect(sendAt('2027-02-15')).rejects.toMatchObject({ name: 'PartnerTransientError' });
    await expect(sendAt('2027-01-25')).rejects.toMatchObject({ name: 'PartnerTransientError' });
    await partners.configure({ toktok: { hookFailRate: 0 } });
    vi.spyOn(t.app.get(WeeklyReportQueries), 'collect').mockRejectedValueOnce(new Error('집계 실패(테스트)'));
    await expect(sendAt('2027-02-01')).rejects.toThrow('집계 실패(테스트)');

    const result = await service.sendScheduled(at);
    expect([result.report.weekStart, result.report.status, result.alreadySent]).toEqual(['2027-03-01', WeeklyReportStatus.SENT, false]);
    expect(result.carriedOver).toEqual([
      { weekStart: '2027-02-15', status: WeeklyReportStatus.SENT },
      { weekStart: '2027-02-01', status: WeeklyReportStatus.SENT },
    ]);
    expect((await partners.toktok()).messages.map((m) => m.idempotencyKey)).toEqual([
      'weekly-report-2027-03-01',
      'weekly-report-2027-02-15',
      'weekly-report-2027-02-01',
    ]);
    expect((await row('2027-01-25')).status).toBe(WeeklyReportStatus.GENERATED);
  }, 30_000);
});
