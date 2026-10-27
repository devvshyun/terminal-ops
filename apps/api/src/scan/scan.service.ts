import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode, UniqueConstraintViolationException } from '@mikro-orm/mysql';
import type { ApiErrorBody } from '@terminal-ops/contracts';
import { BusinessError } from '../common/domain-errors.js';
import { retryOnUniqueViolation } from '../common/retry-on-unique.js';
import { PurchaseOrder, PurchaseOrderStatus } from '../purchase-order/purchase-order.entity.js';
import { PurchaseOrderService } from '../purchase-order/purchase-order.service.js';
import { BulkRegistrationService } from '../terminal/bulk-registration.service.js';
import { normalizeValue, precheckSerials, SERIAL_NO_PATTERN, type RowResult } from '../terminal/bulk-rows.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import { TransitionService } from '../terminal/transition.service.js';
import type { CreateScanDto } from './dto/create-scan.dto.js';
import { ScanBatch, ScanKind } from './scan-batch.entity.js';
import { ScanLock } from './scan-lock.js';

/** 요청 해시. serials는 다듬은 값을 입력 순서 그대로 넣는다(같은 박스라도 순서가 다르면 다른 요청, decisions/0020). */
export function requestHashOf(dto: Pick<CreateScanDto, 'kind' | 'poNo' | 'serials'>): string {
  return createHash('sha256')
    .update(JSON.stringify([dto.kind, dto.poNo ?? null, dto.serials]))
    .digest('hex');
}

/**
 * 박스 일괄 스캔(F6). 박스 하나 = 요청 하나 = 트랜잭션 하나. 행별 결과를 돌려주고 유효한 행만 반영한다(decisions/0019).
 * 같은 scanId는 한 번만 처리한다: 처리 중이면 Redis 잠금으로 409, 끝났으면 ScanBatch에 저장한 결과를 그대로 준다(decisions/0020).
 */
@Injectable()
export class ScanService {
  private readonly logger = new Logger(ScanService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly lock: ScanLock,
    private readonly orders: PurchaseOrderService,
    private readonly bulk: BulkRegistrationService,
    private readonly transitions: TransitionService,
  ) {}

  async scan(input: CreateScanDto, actor: string): Promise<{ batch: ScanBatch; replayed: boolean }> {
    // 회수 입고는 발주와 상관없다. 쓰지 않는 값이 요청 해시에 섞이지 않게 받지 않는다(decisions/0020).
    if (input.kind === ScanKind.RETURN_IN && input.poNo !== undefined && input.poNo !== null) {
      throw new BadRequestException({ statusCode: 400, code: 'PO_NOT_ALLOWED', message: '회수 입고(RETURN_IN)에는 poNo를 보내지 않습니다.' } satisfies ApiErrorBody);
    }
    // 시리얼은 입구에서 한 번 다듬고(앞뒤 공백·CR), 요청 해시·명세 검사·등록·회수 입고 모두 이 값을 쓴다(troubleshooting/0012).
    const dto: CreateScanDto = { ...input, serials: input.serials.map(normalizeValue) };
    const hash = requestHashOf(dto);
    const done = await this.findBatch(dto.scanId);
    if (done) return this.replay(done, hash);

    const token = await this.lock.acquire(dto.scanId);
    if (!token) throw new BusinessError(409, 'SCAN_IN_PROGRESS', `스캔 ${dto.scanId}을(를) 처리하는 중입니다. 잠시 뒤 같은 scanId로 다시 보내세요.`);
    try {
      // 잠금을 잡기 직전에 다른 요청이 끝냈을 수 있다.
      const again = await this.findBatch(dto.scanId);
      if (again) return this.replay(again, hash);
      const batch = dto.kind === ScanKind.RECEIVE ? await this.receive(dto, actor, hash) : await this.returnIn(dto, actor, hash);
      return { batch, replayed: false };
    } catch (error) {
      // 잠금 TTL이 지나 같은 scanId가 동시에 처리된 경우: scan_batch.scan_id unique가 막고, 먼저 끝난 결과를 준다.
      if (error instanceof UniqueConstraintViolationException) {
        const winner = await this.findBatch(dto.scanId);
        if (winner) return this.replay(winner, hash);
      }
      throw error;
    } finally {
      // 반영은 이미 커밋됐을 수 있다. 해제 실패로 결과를 500으로 바꾸지 않는다. 잠금은 TTL(SCAN_LOCK_TTL_MS)이 지나면 풀린다.
      try {
        await this.lock.release(dto.scanId, token);
      } catch (error) {
        this.logger.warn(`스캔 잠금 해제 실패(TTL이 지나면 풀린다) scanId=${dto.scanId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async get(scanId: string): Promise<ScanBatch> {
    const batch = await this.findBatch(scanId);
    if (!batch) throw new NotFoundException(`스캔 ${scanId}이(가) 없습니다.`);
    return batch;
  }

  private findBatch(scanId: string): Promise<ScanBatch | null> {
    return this.em.fork().findOne(ScanBatch, { scanId });
  }

  private replay(batch: ScanBatch, hash: string): { batch: ScanBatch; replayed: boolean } {
    if (batch.requestHash !== hash) {
      throw new BusinessError(422, 'SCAN_ID_REUSED', `scanId ${batch.scanId}은(는) 다른 내용으로 이미 처리됐습니다.`);
    }
    return { batch, replayed: true };
  }

  /**
   * 발주분 입고. 납품 명세는 트랜잭션 밖에서 받아 두고(외부 HTTP), 트랜잭션에서는
   * ① 발주 행을 FOR UPDATE로 먼저 잠근다 — 단말기 INSERT의 FK 검사(S 락)보다 X 락이 먼저여야 같은 발주를 동시에 스캔해도
   *    S→X 데드락이 없다(troubleshooting/0004). 같은 발주의 스캔은 여기서 한 줄로 선다. 마감(CLOSED)도 이 잠금 아래에서 본다.
   * ② 명세에 없는 시리얼은 NOT_IN_DELIVERY_NOTE로 거절(등록하지 않는다, decisions/0021)
   * ③ 나머지는 일괄 등록 엔진(source SCAN)
   */
  private async receive(dto: CreateScanDto, actor: string, hash: string): Promise<ScanBatch> {
    const po = await this.orders.get(dto.poNo!);
    if (po.status === PurchaseOrderStatus.CLOSED) throw this.closed(po.poNo);
    const note = new Set(await this.orders.ensureDeliveryNote(po));

    return retryOnUniqueViolation(() =>
      this.em.fork().transactional(async (tx) => {
        const locked = await tx.findOneOrFail(PurchaseOrder, po.id, { lockMode: LockMode.PESSIMISTIC_WRITE, populate: ['model'] });
        if (locked.status === PurchaseOrderStatus.CLOSED) throw this.closed(locked.poNo);
        locked.status = PurchaseOrderStatus.RECEIVING;

        const results: (RowResult | null)[] = dto.serials.map((serialNo) =>
          SERIAL_NO_PATTERN.test(serialNo) && !note.has(serialNo)
            ? { serialNo, result: 'NOT_IN_DELIVERY_NOTE', message: `발주 ${locked.poNo}의 납품 명세에 없는 시리얼입니다.` }
            : null,
        );
        const rest = dto.serials.flatMap((serialNo, i) => (results[i] ? [] : [{ serialNo, i }]));
        const registered = await this.bulk.registerMany(
          tx,
          rest.map(({ serialNo }) => ({ serialNo, modelCode: locked.model.code })),
          {
            actor,
            source: TransitionSource.SCAN,
            reason: `박스 입고: 발주 ${locked.poNo}`,
            assign: (terminal) => {
              terminal.purchaseOrder = locked;
            },
          },
        );
        rest.forEach(({ i }, k) => (results[i] = registered[k]));
        return tx.create(ScanBatch, {
          scanId: dto.scanId,
          kind: ScanKind.RECEIVE,
          poNo: locked.poNo,
          requestHash: hash,
          actor,
          results: results as RowResult[],
        });
      }),
    );
  }

  /**
   * 회수 입고: RETURNING → RETURNED(source SCAN)를 한 트랜잭션에서. 단말기는 한 번의 조회로 읽고(잠금 없는 SELECT라
   * orderBy는 잠금 순서와 상관없다), 상태가 다르면 그 행만 INVALID_STATE. 행 잠금은 transitionMany의 UPDATE 한 문장이
   * PK(id)로 잡는다. version이 그사이 바뀐 행이 있으면 박스 전체가 409로 롤백된다(같은 scanId로 다시 보내면 된다).
   */
  private async returnIn(dto: CreateScanDto, actor: string, hash: string): Promise<ScanBatch> {
    return this.em.fork().transactional(async (tx) => {
      const results = precheckSerials(dto.serials);
      const pending = dto.serials.flatMap((serialNo, i) => (results[i] ? [] : [{ serialNo, i }]));
      const terminals = pending.length
        ? await tx.find(Terminal, { serialNo: { $in: pending.map((p) => p.serialNo) } }, { populate: ['model'], orderBy: { id: 'asc' } })
        : [];
      const bySerial = new Map(terminals.map((t) => [t.serialNo, t]));
      const found = pending.filter((p) => {
        if (bySerial.has(p.serialNo)) return true;
        results[p.i] = { serialNo: p.serialNo, result: 'NOT_FOUND', message: '등록되지 않은 시리얼입니다.' };
        return false;
      });
      const checks = await this.transitions.transitionMany(
        tx,
        found.map((p) => ({ terminal: bySerial.get(p.serialNo)!, to: TerminalStatus.RETURNED, reason: '박스 회수 입고' })),
        { actor, source: TransitionSource.SCAN },
      );
      found.forEach((p, k) => {
        const check = checks[k];
        results[p.i] = check.ok
          ? { serialNo: p.serialNo, result: 'RETURNED' }
          : { serialNo: p.serialNo, result: 'INVALID_STATE', message: check.reason };
      });
      return tx.create(ScanBatch, { scanId: dto.scanId, kind: ScanKind.RETURN_IN, poNo: null, requestHash: hash, actor, results: results as RowResult[] });
    });
  }

  private closed(poNo: string): BusinessError {
    return new BusinessError(422, 'PO_CLOSED', `발주 ${poNo}은(는) 마감돼 입고 스캔을 받지 않습니다.`);
  }
}
