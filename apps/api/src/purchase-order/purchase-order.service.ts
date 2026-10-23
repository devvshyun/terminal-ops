import { randomUUID } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { TerminalModel } from '../terminal/terminal-model.entity.js';
import type { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto.js';
import { PurchaseOrder } from './purchase-order.entity.js';
import { SeumClient } from './seum.client.js';

@Injectable()
export class PurchaseOrderService {
  private readonly logger = new Logger(PurchaseOrderService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly seum: SeumClient,
  ) {}

  /**
   * 발주: ① 모델 확인 ② 트랜잭션 밖에서 세움전자에 발주(HTTP) ③ 받은 발주번호로 저장.
   * ③이 실패하면 공장 쪽에 발주가 남는다(운송장과 같은 한계, decisions/0012). 추적할 수 있도록 발주번호와 reference(공장에 함께 보낸 값)를 로그에 남기고 다시 던진다.
   * 확인할 수 있는 실패(없는 모델)는 ①에서 거른다.
   */
  async create(dto: CreatePurchaseOrderDto, actor: string): Promise<PurchaseOrder> {
    const model = await this.em.findOne(TerminalModel, { code: dto.modelCode });
    if (!model) throw new NotFoundException(`단말기 모델 ${dto.modelCode}이(가) 없습니다.`);

    const reference = randomUUID();
    const poNo = await this.seum.createPurchaseOrder({ modelCode: model.code, quantity: dto.quantity, reference });

    const po = this.em.create(PurchaseOrder, { poNo, model, quantity: dto.quantity, orderedBy: actor });
    try {
      await this.em.flush();
    } catch (error) {
      this.logger.error(`공장 발주 후 저장 실패(고아 발주): poNo=${poNo} reference=${reference} modelCode=${model.code} quantity=${dto.quantity} actor=${actor}`, error instanceof Error ? error.stack : String(error));
      throw error;
    }
    return po;
  }

  /**
   * 납품 명세를 돌려준다. 아직 안 받았으면 트랜잭션 밖에서 세움전자에 물어 저장한다(처음 한 번).
   * 동시에 두 요청이 받아 와도 내용이 같고, delivery_note가 null일 때만 쓰므로 덮어쓰지 않는다.
   */
  async ensureDeliveryNote(po: PurchaseOrder): Promise<string[]> {
    if (po.deliveryNote) return po.deliveryNote;
    const { serials } = await this.seum.getDeliveryNote(po.poNo);
    await this.em.fork().nativeUpdate(PurchaseOrder, { id: po.id, deliveryNote: null }, { deliveryNote: serials });
    po.deliveryNote = serials;
    return serials;
  }

  async get(poNo: string): Promise<PurchaseOrder> {
    const po = await this.em.findOne(PurchaseOrder, { poNo }, { populate: ['model'] });
    if (!po) throw new NotFoundException(`발주 ${poNo}이(가) 없습니다.`);
    return po;
  }
}
