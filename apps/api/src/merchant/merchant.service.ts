import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import { TransitionService } from '../terminal/transition.service.js';
import type { AllocateDto } from './dto/allocate.dto.js';
import type { CancelAllocationDto } from './dto/cancel-allocation.dto.js';
import { Merchant } from './merchant.entity.js';

@Injectable()
export class MerchantService {
  constructor(
    private readonly em: EntityManager,
    private readonly transitions: TransitionService,
  ) {}

  async list(): Promise<Merchant[]> {
    return this.em.find(Merchant, {}, { orderBy: { code: 'asc' } });
  }

  /** 재고 단말기를 가맹점에 배정한다. 상태(IN_STOCK → ALLOCATED)와 가맹점을 UPDATE 한 번으로 바꾼다. */
  async allocate(serialNo: string, dto: AllocateDto, actor: string): Promise<Terminal> {
    const merchant = await this.em.findOne(Merchant, { code: dto.merchantCode });
    if (!merchant) throw new NotFoundException(`가맹점 ${dto.merchantCode}이(가) 없습니다.`);
    return this.transitions.transition({
      serialNo,
      to: TerminalStatus.ALLOCATED,
      reason: `가맹점 배정: ${merchant.name}(${merchant.code})`,
      actor,
      source: TransitionSource.ALLOCATION,
      expectedVersion: dto.expectedVersion,
      mutate: (terminal) => {
        terminal.merchant = merchant;
      },
    });
  }

  /** 배정 취소: ALLOCATED → IN_STOCK과 가맹점 비우기를 UPDATE 한 번으로(decisions/0011, 0017). */
  async cancelAllocation(serialNo: string, dto: CancelAllocationDto, actor: string): Promise<Terminal> {
    return this.transitions.transition({
      serialNo,
      to: TerminalStatus.IN_STOCK,
      reason: `배정 취소: ${dto.reason}`,
      actor,
      source: TransitionSource.ALLOCATION,
      expectedVersion: dto.expectedVersion,
      mutate: (terminal) => {
        terminal.merchant = null;
      },
    });
  }
}
