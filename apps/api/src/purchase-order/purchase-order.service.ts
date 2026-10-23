import { randomUUID } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { TerminalModel } from '../terminal/terminal-model.entity.js';
import type { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto.js';
import { PurchaseOrder } from './purchase-order.entity.js';
import { SeumClient } from './seum.client.js';

@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly em: EntityManager,
    private readonly seum: SeumClient,
  ) {}

  /**
   * 발주: ① 모델 확인 ② 트랜잭션 밖에서 세움전자에 발주(HTTP) ③ 받은 발주번호로 저장.
   * ③이 실패하면 공장 쪽에 발주가 남는다(운송장과 같은 한계, decisions/0012). 확인할 수 있는 실패(없는 모델)는 ①에서 거른다.
   */
  async create(dto: CreatePurchaseOrderDto, actor: string): Promise<PurchaseOrder> {
    const model = await this.em.findOne(TerminalModel, { code: dto.modelCode });
    if (!model) throw new NotFoundException(`단말기 모델 ${dto.modelCode}이(가) 없습니다.`);

    const poNo = await this.seum.createPurchaseOrder({ modelCode: model.code, quantity: dto.quantity, reference: randomUUID() });

    const po = this.em.create(PurchaseOrder, { poNo, model, quantity: dto.quantity, orderedBy: actor });
    await this.em.flush();
    return po;
  }

  async get(poNo: string): Promise<PurchaseOrder> {
    const po = await this.em.findOne(PurchaseOrder, { poNo }, { populate: ['model'] });
    if (!po) throw new NotFoundException(`발주 ${poNo}이(가) 없습니다.`);
    return po;
  }
}
