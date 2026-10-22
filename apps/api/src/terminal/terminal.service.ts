import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { RegisterTerminalDto } from './dto/register-terminal.dto.js';
import type { ListTerminalsQuery } from './dto/list-terminals.query.js';
import { TerminalModel } from './terminal-model.entity.js';
import { Terminal } from './terminal.entity.js';
import { TerminalStatusHistory } from './terminal-status-history.entity.js';
import { TerminalStatus, TransitionSource } from './terminal-status.js';

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class TerminalService {
  constructor(private readonly em: EntityManager) {}

  /** 단말기와 첫 이력(RECEIVED)을 한 트랜잭션으로 만든다. */
  async register(dto: RegisterTerminalDto, actor: string): Promise<Terminal> {
    return this.em.transactional(async (tx) => {
      const model = await tx.findOne(TerminalModel, { code: dto.modelCode });
      if (!model) throw new NotFoundException(`단말기 모델 ${dto.modelCode}이(가) 없습니다.`);
      const terminal = tx.create(Terminal, { serialNo: dto.serialNo, model });
      tx.create(TerminalStatusHistory, {
        terminal,
        fromStatus: null,
        toStatus: TerminalStatus.RECEIVED,
        source: TransitionSource.MANUAL,
        actor,
        reason: '신규 등록',
      });
      return terminal;
    });
  }

  async list(query: ListTerminalsQuery) {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.modelCode ? { model: { code: query.modelCode } } : {}),
      ...(query.q ? { serialNo: { $like: `${escapeLike(query.q)}%` } } : {}),
    };
    const [items, total] = await this.em.findAndCount(Terminal, where, {
      populate: ['model'],
      orderBy: { id: 'desc' },
      limit: query.size,
      offset: (query.page - 1) * query.size,
    });
    return { items, total, page: query.page, size: query.size };
  }

  async getBySerial(serialNo: string): Promise<Terminal> {
    const terminal = await this.em.findOne(Terminal, { serialNo }, { populate: ['model'] });
    if (!terminal) throw new NotFoundException(`단말기 ${serialNo}이(가) 없습니다.`);
    return terminal;
  }

  async history(serialNo: string): Promise<TerminalStatusHistory[]> {
    const terminal = await this.getBySerial(serialNo);
    return this.em.find(TerminalStatusHistory, { terminal }, { orderBy: { id: 'asc' } });
  }
}
