import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Carrier } from '../../src/carrier/carrier.types.js';
import { BusinessError, InvalidTransitionError } from '../../src/common/domain-errors.js';
import { ReplacementService, type LockOrder } from '../../src/service/replacement.service.js';
import { ServiceTicket, ServiceTicketStatus } from '../../src/service/service-ticket.entity.js';
import { Shipment } from '../../src/shipment/shipment.entities.js';
import { TerminalStatusHistory } from '../../src/terminal/terminal-status-history.entity.js';
import { TerminalStatus } from '../../src/terminal/terminal-status.js';
import { partners } from '../helpers/partners.js';
import { prepareInService, registerInStock } from '../helpers/scenario.js';
import { createTestApp, resetDatabase, type TestApp } from '../helpers/test-app.js';

// experiments/0007. 실행: EXPERIMENTS=1 npx vitest run test/experiments/replacement-race.spec.ts --silent=false
const N = Number(process.env.EXP_N ?? 10);
const ROUNDS = Number(process.env.EXP_ROUNDS ?? 3);
const ORDERS: LockOrder[] = ['id-asc', 'faulty-first'];
const OP = { 'X-Operator': 'exp7' };

/** 실패 사유를 짧은 이름으로 */
function reasonOf(error: unknown): string {
  if (error instanceof BusinessError) return error.code;
  if (error instanceof InvalidTransitionError) return 'INVALID_TRANSITION';
  return error instanceof Error ? error.name : String(error);
}

describe(`실험 0007: 교체 출고 동시 요청 — 접수 ${N}건 (${ROUNDS}회)`, () => {
  let t: TestApp;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.orm);
    await partners.reset();
  });
  afterAll(async () => {
    await t.app.close();
  });

  /** 운영 중 단말기 n대와 각 단말기의 열린 접수를 만든다. */
  async function openTickets(tag: string, n: number): Promise<number[]> {
    const ids: number[] = [];
    for (let i = 1; i <= n; i++) {
      const serialNo = `${tag}-F${String(i).padStart(3, '0')}`;
      await prepareInService(t, serialNo);
      const res = await t.http().post('/service-tickets').set(OP).send({ serialNo, symptom: '고장' });
      expect(res.status).toBe(201);
      ids.push(res.body.id);
    }
    return ids;
  }

  async function countAfter(tag: string, ticketIds: number[], replSerialLike: string) {
    const em = t.orm.em.fork();
    return {
      shipments: await em.count(Shipment, { terminal: { serialNo: { $like: replSerialLike } } }),
      waybills: (await partners.stats()).calls['bungae.waybill'] ?? 0,
      replacing: await em.count(ServiceTicket, { id: { $in: ticketIds }, status: ServiceTicketStatus.REPLACING }),
      returnRequested: await em.count(TerminalStatusHistory, {
        terminal: { serialNo: { $like: `${tag}-F%` } },
        toStatus: TerminalStatus.RETURN_REQUESTED,
      }),
    };
  }

  for (const order of ORDERS) {
    it(`같은 교체 단말기, 잠금 순서 ${order}: 정확히 1건 성공, 나머지 422/409, 500·데드락 0`, async () => {
      const replacements = t.app.get(ReplacementService);
      for (let round = 1; round <= ROUNDS; round++) {
        seq += 1;
        const tag = `R7${String(seq).padStart(2, '0')}`;
        // 교체 단말기를 먼저 만들어 id가 고장 단말기들보다 작게 한다 → 'faulty-first'는 id 오름차순과 반대 순서로 잠근다.
        await registerInStock(t, `${tag}-REPL`);
        const ticketIds = await openTickets(tag, N);
        await partners.reset();

        const started = performance.now();
        const settled = await Promise.allSettled(
          ticketIds.map((id) => replacements.replace(id, { replacementSerialNo: `${tag}-REPL`, carrier: Carrier.BUNGAE }, 'exp7', { lockOrder: order })),
        );
        const elapsed = Math.round(performance.now() - started);

        const ok = settled.filter((s) => s.status === 'fulfilled').length;
        const reasons: Record<string, number> = {};
        for (const s of settled) if (s.status === 'rejected') reasons[reasonOf(s.reason)] = (reasons[reasonOf(s.reason)] ?? 0) + 1;
        const c = await countAfter(tag, ticketIds, `${tag}-REPL`);
        console.log(
          `[실험 0007/same/${order} #${round}] N=${N} 성공=${ok} 실패=${JSON.stringify(reasons)} 운송장발급=${c.waybills} 저장=${c.shipments} ` +
            `고아=${c.waybills - c.shipments} REPLACING=${c.replacing} 회수요청이력=${c.returnRequested} 소요=${elapsed}ms`,
        );

        expect(ok).toBe(1);
        expect(Object.keys(reasons).every((k) => ['INVALID_TRANSITION', 'REPLACEMENT_NOT_IN_STOCK', 'OptimisticLockError'].includes(k))).toBe(true);
        expect(c.shipments).toBe(1);
        expect(c.replacing).toBe(1);
        expect(c.returnRequested).toBe(1); // 진 쪽의 고장 단말기는 회수 요청으로 바뀌지 않았다(전부 롤백)
      }
    }, 300_000);
  }

  // troubleshooting/0014의 회귀 모양: 서로 다른 교체 단말기(운송장이 없고 id가 가장 큰 새 단말기)로 동시에 교체 출고.
  // 단말기 행은 겹치지 않는다. 예전 recordShipment(terminal_id 조건 UPDATE)는 여기서 gap 락 데드락 → 500이 났다.
  it(`서로 다른 교체 단말기 ${N}대(HTTP, 운영 순서 id-asc): 모두 201, 500·데드락 0`, async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      seq += 1;
      const tag = `R7${String(seq).padStart(2, '0')}`;
      const ticketIds = await openTickets(tag, N);
      // 고장 단말기들 뒤에 만들어 교체 단말기 id가 가장 크다 → shipment.terminal_id 인덱스의 끝(supremum) 쪽.
      const repls = Array.from({ length: N }, (_, i) => `${tag}-S${String(i + 1).padStart(3, '0')}`);
      for (const s of repls) await registerInStock(t, s);
      await partners.reset();

      const started = performance.now();
      const results = await Promise.all(
        ticketIds.map((id, i) =>
          t.http().post(`/service-tickets/${id}/replacements`).set(OP).send({ replacementSerialNo: repls[i], carrier: 'BUNGAE' }).then((r) => r),
        ),
      );
      const elapsed = Math.round(performance.now() - started);

      const statuses: Record<string, number> = {};
      for (const r of results) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      const codes = results.filter((r) => r.status !== 201).map((r) => r.body.code ?? r.body.message ?? null);
      const c = await countAfter(tag, ticketIds, `${tag}-S%`);
      console.log(
        `[실험 0007/distinct/id-asc #${round}] N=${N} 응답=${JSON.stringify(statuses)} 실패코드=${JSON.stringify(codes)} 운송장발급=${c.waybills} ` +
          `저장=${c.shipments} 고아=${c.waybills - c.shipments} REPLACING=${c.replacing} 회수요청이력=${c.returnRequested} 소요=${elapsed}ms`,
      );

      expect(statuses).toEqual({ 201: N });
      expect(c.shipments).toBe(N);
      expect(c.waybills - c.shipments).toBe(0);
      expect(c.replacing).toBe(N);
      expect(c.returnRequested).toBe(N);
    }
  }, 300_000);
});
