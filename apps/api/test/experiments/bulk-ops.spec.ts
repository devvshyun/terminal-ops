import ExcelJS from 'exceljs';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { FlushMode } from '@mikro-orm/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OUTBOX_TYPE, OutboxEvent, OutboxStatus } from '../../src/outbox/outbox-event.entity.js';
import { OutboxService } from '../../src/outbox/outbox.service.js';
import { QUEUE } from '../../src/queue/queue-names.js';
import { BulkRegistrationService } from '../../src/terminal/bulk-registration.service.js';
import { TerminalModel } from '../../src/terminal/terminal-model.entity.js';
import { Terminal } from '../../src/terminal/terminal.entity.js';
import { TransitionSource } from '../../src/terminal/terminal-status.js';
import { TransitionService } from '../../src/terminal/transition.service.js';
import { partners } from '../helpers/partners.js';
import { captureQueries } from '../helpers/query-log.js';
import { resetQueues } from '../helpers/queues.js';
import { orderPurchase } from '../helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

// experiments/0006. 실행: EXPERIMENTS=1 npx vitest run test/experiments/bulk-ops.spec.ts
const BOX = Number(process.env.EXP_BOX ?? 500);
const EXCEL_ROWS = Number(process.env.EXP_EXCEL ?? 1000);
const OUTBOX_ROWS = Number(process.env.EXP_OUTBOX ?? 1000);
// decisions/0022: 상한(5000행) 파일 하나를 받을 때 시간과 메모리(RSS)를 잰다.
const EXCEL_MAX_ROWS = Number(process.env.EXP_EXCEL_MAX ?? 5000);
const OP = { 'X-Operator': 'exp6' };
const serialsOf = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(5, '0')}`);

/** 엑셀 파일을 만든다(머리글 + 시리얼 n행). */
async function workbookOf(prefix: string, n: number): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('terminals');
  ws.addRow(['serialNo', 'modelCode']);
  for (const serialNo of serialsOf(prefix, n)) ws.addRow([serialNo, 'SN-100']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * 이 프로세스(테스트와 앱이 같은 프로세스)의 RSS를 10ms마다 표본으로 잰다. 최고값은 표본 사이를 놓칠 수 있는 근삿값이고,
 * 테스트 코드·vitest 자체의 메모리도 섞인다(추정의 한계).
 */
function sampleRss() {
  const mb = (n: number) => Math.round(n / 1024 / 1024);
  const before = process.memoryUsage().rss;
  let peak = before;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 10);
  return () => {
    clearInterval(timer);
    const after = process.memoryUsage().rss;
    peak = Math.max(peak, after);
    return { beforeMb: mb(before), peakMb: mb(peak), afterMb: mb(after), growthMb: mb(peak - before) };
  };
}

async function measure<T>(t: TestApp, fn: () => Promise<T>) {
  const cap = captureQueries(t.orm);
  const started = performance.now();
  try {
    const result = await fn();
    return { result, ms: Math.round(performance.now() - started), queries: cap.queries.length, selects: cap.selects(), inserts: cap.queries.filter((q) => /^insert /i.test(q)).length };
  } finally {
    cap.stop();
  }
}

describe(`실험 0006: 대량 처리 (박스 ${BOX}대, 엑셀 ${EXCEL_ROWS}행, outbox ${OUTBOX_ROWS}행)`, () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await resetQueues(t.app);
    await partners.reset();
  });
  afterAll(async () => {
    await resetQueues(t.app);
    await t.app.close();
  });

  it(`A. 신규 등록 ${BOX}건: N+1(행마다 flush) / 행마다 조회만(flush 1번) / 한 번에 조회(flush 1번) / 일괄 엔진`, async () => {
    const transitions = t.app.get(TransitionService);
    const bulk = t.app.get(BulkRegistrationService);
    // 변형마다 시리얼 접두사가 달라 서로 겹치지 않는다. 모두 한 트랜잭션, 이력·Outbox도 같이 쌓는다.
    // - naive: 행마다 findOne → create. FlushMode AUTO라 다음 findOne 전에 flush가 일어나 INSERT도 행마다 나간다.
    // - lookup: 행마다 findOne(flushMode COMMIT) → create, flush는 커밋 때 1번. "행마다 조회"만 남긴 것.
    // - preload: find($in) 1번으로 기존 시리얼을 읽고 행마다 create, flush 1번. 조회도 flush도 한 번.
    // - engine: BulkRegistrationService.register(source SCAN).
    type Variant = 'naive' | 'lookup' | 'preload' | 'engine';
    const run: Record<Variant, () => Promise<unknown>> = {
      naive: () =>
        t.orm.em.fork().transactional(async (tx) => {
          const model = await tx.findOneOrFail(TerminalModel, { code: 'SN-100' });
          for (const serialNo of serialsOf('EXN', BOX)) {
            if (await tx.findOne(Terminal, { serialNo })) continue;
            const terminal = tx.create(Terminal, { serialNo, model });
            transitions.recordRegistration(terminal, 'exp6', TransitionSource.SCAN, tx);
          }
        }),
      lookup: () =>
        t.orm.em.fork().transactional(async (tx) => {
          const model = await tx.findOneOrFail(TerminalModel, { code: 'SN-100' });
          for (const serialNo of serialsOf('EXL', BOX)) {
            if (await tx.findOne(Terminal, { serialNo }, { flushMode: FlushMode.COMMIT })) continue;
            const terminal = tx.create(Terminal, { serialNo, model });
            transitions.recordRegistration(terminal, 'exp6', TransitionSource.SCAN, tx);
          }
        }),
      preload: () =>
        t.orm.em.fork().transactional(async (tx) => {
          const model = await tx.findOneOrFail(TerminalModel, { code: 'SN-100' });
          const serials = serialsOf('EXP', BOX);
          const existing = new Set((await tx.find(Terminal, { serialNo: { $in: serials } })).map((x) => x.serialNo));
          for (const serialNo of serials) {
            if (existing.has(serialNo)) continue;
            const terminal = tx.create(Terminal, { serialNo, model });
            transitions.recordRegistration(terminal, 'exp6', TransitionSource.SCAN, tx);
          }
        }),
      engine: () =>
        bulk.register(serialsOf('EXB', BOX).map((serialNo) => ({ serialNo, modelCode: 'SN-100' })), { actor: 'exp6', source: TransitionSource.SCAN }),
    };
    // 처음 도는 변형이 준비 비용(연결·JIT 등)을 낼 수 있어 EXP_A_ORDER=reverse로 순서를 뒤집어 본다.
    const order: Variant[] = process.env.EXP_A_ORDER === 'reverse' ? ['engine', 'preload', 'lookup', 'naive'] : ['naive', 'lookup', 'preload', 'engine'];
    const result: Partial<Record<Variant, { ms: number; queries: number; select: number; insert: number }>> = {};
    for (const v of order) {
      const m = await measure(t, run[v]);
      result[v] = { ms: m.ms, queries: m.queries, select: m.selects, insert: m.inserts };
    }
    console.log(`[실험 0006/A] ${BOX}건 순서=${order.join('>')} ${JSON.stringify(result)}`);
    for (const prefix of ['EXN', 'EXL', 'EXP', 'EXB']) {
      expect(await t.orm.em.fork().count(Terminal, { serialNo: { $like: `${prefix}-%` } })).toBe(BOX);
    }
    expect(result.naive!.select).toBeGreaterThanOrEqual(BOX);
    expect(result.engine!.select).toBeLessThanOrEqual(5);
  }, 300_000);

  it(`B. 박스 스캔 API로 발주분 ${BOX}대 입고(HTTP, 명세 확인·발주 잠금 포함)`, async () => {
    const { poNo, serials } = await orderPurchase(t, BOX);
    const scan = await measure(t, () => t.http().post('/scans').set(OP).send({ scanId: `EXP6-BOX-${Date.now()}`, kind: 'RECEIVE', poNo, serials }));
    console.log(`[실험 0006/B] 스캔 ${BOX}대: HTTP ${scan.result.status} ${scan.ms}ms 쿼리 ${scan.queries}(select ${scan.selects}, insert ${scan.inserts}) 결과=${JSON.stringify(scan.result.body.summary)}`);
    expect(scan.result.status).toBe(201);
    expect(scan.result.body.summary).toEqual({ CREATED: BOX });
  }, 300_000);

  it(`C. 엑셀 ${EXCEL_ROWS}행 등록(HTTP, 파일 읽기 포함)`, async () => {
    const file = await workbookOf('EXX', EXCEL_ROWS);
    const rss = sampleRss();
    const res = await measure(t, () => t.http().post('/terminals/imports').set(OP).attach('file', file, 'exp6.xlsx'));
    const mem = rss();
    console.log(
      `[실험 0006/C] 엑셀 ${EXCEL_ROWS}행(${file.length}바이트): HTTP ${res.result.status} ${res.ms}ms 쿼리 ${res.queries}(select ${res.selects}, insert ${res.inserts}) RSS ${JSON.stringify(mem)}`,
    );
    expect(res.result.status).toBe(201);
    expect(res.result.body.summary).toEqual({ CREATED: EXCEL_ROWS });
  }, 300_000);

  it(`E. 엑셀 상한 ${EXCEL_MAX_ROWS}행 등록(HTTP): 시간·RSS (decisions/0022)`, async () => {
    const file = await workbookOf('EXM', EXCEL_MAX_ROWS);
    const rss = sampleRss();
    const res = await measure(t, () => t.http().post('/terminals/imports').set(OP).attach('file', file, 'exp6-max.xlsx'));
    const mem = rss();
    console.log(
      `[실험 0006/E] 엑셀 ${EXCEL_MAX_ROWS}행(${file.length}바이트): HTTP ${res.result.status} ${res.ms}ms 쿼리 ${res.queries}(select ${res.selects}, insert ${res.inserts}) RSS ${JSON.stringify(mem)}`,
    );
    expect(res.result.status).toBe(201);
    expect(res.result.body.summary).toEqual({ CREATED: EXCEL_MAX_ROWS });
  }, 300_000);

  it(`D. outbox ${OUTBOX_ROWS}행 relay: 행마다 add vs addBulk (limit 100)`, async () => {
    const outbox = t.app.get(OutboxService);
    const queue = t.app.get<Queue>(getQueueToken(QUEUE.OUTBOX));
    const rows = Array.from({ length: OUTBOX_ROWS }, (_, i) => ({
      type: OUTBOX_TYPE.TERMINAL_STATUS_CHANGED,
      payload: { serialNo: `EXO-${i}` },
      status: OutboxStatus.PENDING,
      attempts: 0,
      createdAt: new Date(),
    }));
    const result: Record<string, { totalMs: number; maxRelayMs: number; relays: number; jobs: number }> = {};
    // 순서 효과를 보려고 EXP_OUTBOX_ORDER=bulk-first로 순서를 바꿀 수 있다(기본 each → bulk).
    const modes = process.env.EXP_OUTBOX_ORDER === 'bulk-first' ? (['bulk', 'each'] as const) : (['each', 'bulk'] as const);
    for (const mode of modes) {
      // 이전 단계·이전 변형의 행과 job을 지우고 같은 조건에서 시작한다(워커가 없어 job은 처리되지 않고 쌓인다).
      await t.orm.em.fork().nativeDelete(OutboxEvent, {});
      await resetQueues(t.app);
      await t.orm.em.fork().insertMany(OutboxEvent, rows);
      const durations: number[] = [];
      const started = performance.now();
      for (;;) {
        const s = performance.now();
        const { queued } = await outbox.relay(100, { enqueue: mode });
        if (queued.length === 0) break;
        durations.push(performance.now() - s);
      }
      const totalMs = Math.round(performance.now() - started);
      const jobs = await queue.getJobCountByTypes('waiting');
      result[mode] = { totalMs, maxRelayMs: Math.round(Math.max(...durations)), relays: durations.length, jobs };
      expect(await t.orm.em.fork().count(OutboxEvent, { status: OutboxStatus.QUEUED })).toBe(OUTBOX_ROWS);
      expect(jobs).toBe(OUTBOX_ROWS);
    }
    console.log(`[실험 0006/D] outbox ${OUTBOX_ROWS}행 relay(limit 100): ${JSON.stringify(result)}`);
  }, 300_000);
});
