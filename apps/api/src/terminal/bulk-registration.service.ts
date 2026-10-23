import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { retryOnUniqueViolation } from '../common/retry-on-unique.js';
import { normalizeRows, precheckSerials, type RowResult } from './bulk-rows.js';
import { TerminalModel } from './terminal-model.entity.js';
import { Terminal } from './terminal.entity.js';
import { TransitionSource } from './terminal-status.js';
import { TransitionService } from './transition.service.js';

/** 엑셀·JSON에서 온 값은 숫자·공백이 섞일 수 있다. 엔진 입구(normalizeRows)에서 문자열로 맞춘다. */
export interface BulkRegisterRow {
  serialNo: string;
  modelCode: string;
}

export interface BulkRegisterContext {
  actor: string;
  source: TransitionSource;
  /** 이력에 남길 사유. 기본 '신규 등록' */
  reason?: string;
  /** 새 단말기에 함께 넣을 필드(예: 입고된 발주). 상태는 바꾸지 않는다. */
  assign?: (terminal: Terminal) => void;
}

/**
 * 일괄 등록 엔진(F1·F6 공통, decisions/0019).
 * 조회는 행 수와 상관없이 두 번(모델, 기존 시리얼)이고, 유효한 행만 한 트랜잭션에서 만든다. 단말기·이력·Outbox INSERT는
 * flush 때 MikroORM이 테이블별 다중 행 INSERT로 묶는다(batchSize 300).
 */
@Injectable()
export class BulkRegistrationService {
  constructor(
    private readonly em: EntityManager,
    private readonly transitions: TransitionService,
  ) {}

  /** 자기 트랜잭션을 열어 등록한다. 다른 요청과 같은 시리얼이 겹쳐 unique 위반·데드락이 나면 새 fork·새 트랜잭션으로 다시 한다(3번까지). */
  async register(rows: BulkRegisterRow[], ctx: BulkRegisterContext): Promise<RowResult[]> {
    return retryOnUniqueViolation(() => this.em.fork().transactional((tx) => this.registerMany(tx, rows, ctx)));
  }

  /**
   * 열린 트랜잭션(tx) 안에서 행별 결과를 정하고 유효한 행의 엔티티를 만든다(INSERT는 호출자 트랜잭션의 flush·커밋 때).
   * 결과는 입력과 같은 순서다. 같은 시리얼이 두 번 나오면 첫 행이 결정한다(첫 행이 UNKNOWN_MODEL이어도 뒤 행은 DUPLICATE_IN_REQUEST).
   */
  async registerMany(tx: EntityManager, input: BulkRegisterRow[], ctx: BulkRegisterContext): Promise<RowResult[]> {
    // 엑셀·JSON에서 숫자나 공백 섞인 값이 올 수 있다. 문자열로 맞춘 값으로 중복 판단·조회·저장을 모두 한다.
    const rows = normalizeRows(input);
    const results = precheckSerials(rows.map((r) => r.serialNo));
    const pending = () => rows.flatMap((row, i) => (results[i] ? [] : [{ row, i }]));

    // 조회 1: 모델(서로 다른 코드만)
    const codes = [...new Set(pending().map(({ row }) => row.modelCode))].filter((c) => c !== '');
    const models = codes.length ? await tx.find(TerminalModel, { code: { $in: codes } }) : [];
    const modelByCode = new Map(models.map((m) => [m.code, m]));
    for (const { row, i } of pending()) {
      if (!modelByCode.has(row.modelCode)) {
        const message = row.modelCode ? `단말기 모델 ${row.modelCode}이(가) 없습니다.` : '모델 코드가 비어 있습니다.';
        results[i] = { serialNo: row.serialNo, result: 'UNKNOWN_MODEL', message };
      }
    }

    // 조회 2: 이미 있는 시리얼(행마다 findOne 하지 않는다 — N+1 금지)
    const serials = pending().map(({ row }) => row.serialNo);
    const existing = serials.length
      ? await tx.createQueryBuilder(Terminal, 't').select('t.serialNo').where({ serialNo: { $in: serials } }).execute<{ serialNo: string }[]>()
      : [];
    const known = new Set(existing.map((e) => e.serialNo));
    for (const { row, i } of pending()) {
      if (known.has(row.serialNo)) results[i] = { serialNo: row.serialNo, result: 'ALREADY_EXISTS', message: '이미 등록된 시리얼입니다.' };
    }

    // 만들기: 시리얼 순서로 만든다. 같은 시리얼을 넣는 트랜잭션들이 늘 같은 순서로 unique 키를 잡아 서로 엇갈려 기다리지 않게 한다.
    const toCreate = pending().sort((a, b) => (a.row.serialNo < b.row.serialNo ? -1 : 1));
    for (const { row, i } of toCreate) {
      const terminal = tx.create(Terminal, { serialNo: row.serialNo, model: modelByCode.get(row.modelCode)! });
      ctx.assign?.(terminal);
      this.transitions.recordRegistration(terminal, ctx.actor, ctx.source, tx, ctx.reason);
      results[i] = { serialNo: row.serialNo, result: 'CREATED' };
    }
    return results as RowResult[];
  }
}
