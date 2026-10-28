import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LoadStrategy } from '@mikro-orm/mysql';
import type { RegisterTerminalDto } from './dto/register-terminal.dto.js';
import type { ListTerminalsQuery } from './dto/list-terminals.query.js';
import { outOfScope, type MerchantScope } from '../merchant/merchant-scope.js';
import { TerminalModel } from './terminal-model.entity.js';
import { Terminal } from './terminal.entity.js';
import { TerminalStatusHistory } from './terminal-status-history.entity.js';
import { TransitionSource } from './terminal-status.js';
import { TransitionService } from './transition.service.js';

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class TerminalService {
  constructor(
    private readonly em: EntityManager,
    private readonly transitions: TransitionService,
  ) {}

  /** 단말기와 첫 이력(RECEIVED)을 한 트랜잭션으로 만든다. 이력은 전이 서비스가 남긴다(decisions/0008). */
  async register(dto: RegisterTerminalDto, actor: string): Promise<Terminal> {
    return this.em.transactional(async (tx) => {
      const model = await tx.findOne(TerminalModel, { code: dto.modelCode });
      if (!model) throw new NotFoundException(`단말기 모델 ${dto.modelCode}이(가) 없습니다.`);
      const terminal = tx.create(Terminal, { serialNo: dto.serialNo, model });
      this.transitions.recordRegistration(terminal, actor, TransitionSource.MANUAL, tx);
      return terminal;
    });
  }

  /**
   * 목록(offset 페이지 + 전체 수, decisions/0039). 모델·가맹점은 select-in으로 따로 읽는다(실험 0013):
   * 기본(joined)이면 목록 SQL이 terminal 전체를 모델·가맹점과 해시 조인한 뒤 id로 정렬해 20행을 자르고(10만 대 약 100ms),
   * count도 같은 조인을 탄다. select-in이면 목록은 PK를 거꾸로 읽어 바로 멈추고, 모델·가맹점은 그 20행의 id로 한 번씩 읽는다.
   * 모델·가맹점 코드로 거를 때는 MikroORM이 거르기용 조인만 붙인다.
   * @param strategy 실험 0013이 joined와 비교하려고만 바꾼다(운영 코드는 기본값)
   * @param scope 가맹점주(`/me`)면 그 가맹점 단말기만 — 가맹점 코드 조건보다 앞선다(decisions/0053)
   */
  async list(query: ListTerminalsQuery, strategy: LoadStrategy = LoadStrategy.SELECT_IN, scope?: MerchantScope) {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.modelCode ? { model: { code: query.modelCode } } : {}),
      ...(scope ? { merchant: scope.merchantId } : query.merchantCode ? { merchant: { code: query.merchantCode } } : {}),
      ...(query.q ? { serialNo: { $like: `${escapeLike(query.q)}%` } } : {}),
    };
    const [items, total] = await this.em.findAndCount(Terminal, where, {
      populate: ['model', 'merchant'],
      strategy,
      orderBy: { id: 'desc' },
      limit: query.size,
      offset: (query.page - 1) * query.size,
    });
    return { items, total, page: query.page, size: query.size };
  }

  /** 모델 목록(코드 순). 화면의 필터·등록 선택지 */
  async models(): Promise<TerminalModel[]> {
    return this.em.find(TerminalModel, {}, { orderBy: { code: 'asc' } });
  }

  /** @param scope 가맹점주(`/me`)면 그 가맹점 단말기만 — 아니면 없는 것과 같은 404(decisions/0053) */
  async getBySerial(serialNo: string, scope?: MerchantScope): Promise<Terminal> {
    const terminal = await this.em.findOne(Terminal, { serialNo }, { populate: ['model', 'merchant'] });
    if (!terminal || (scope && terminal.merchant?.id !== scope.merchantId)) throw outOfScope(`단말기 ${serialNo}`);
    return terminal;
  }

  async history(serialNo: string): Promise<TerminalStatusHistory[]> {
    const terminal = await this.getBySerial(serialNo);
    return this.em.find(TerminalStatusHistory, { terminal }, { orderBy: { id: 'asc' } });
  }
}
