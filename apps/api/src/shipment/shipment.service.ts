import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { CarrierAdapters } from '../carrier/carrier.adapters.js';
import { InvalidTransitionError } from '../common/domain-errors.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import { TransitionService } from '../terminal/transition.service.js';
import type { CreateShipmentDto } from './dto/create-shipment.dto.js';
import { CarrierEvent, Shipment } from './shipment.entities.js';

@Injectable()
export class ShipmentService {
  constructor(
    private readonly em: EntityManager,
    private readonly transitions: TransitionService,
    private readonly adapters: CarrierAdapters,
  ) {}

  /**
   * 출고: ① 트랜잭션 밖에서 택배사에 운송장을 발급받고 ② 트랜잭션에서 단말기 전이(ALLOCATED → SHIPPED)를 먼저 한 뒤
   * 운송장(Shipment)을 저장한다. 외부 HTTP를 DB 트랜잭션 안에서 기다리지 않기 위해서다.
   * ②가 실패하면 ①의 운송장은 택배사 쪽에 고아로 남는다(알려진 한계, decisions/0012).
   */
  async create(dto: CreateShipmentDto, actor: string): Promise<{ shipment: Shipment; terminal: Terminal }> {
    // 운송장을 발급받기 전에 확인할 수 있는 실패는 먼저 걸러 고아 운송장을 줄인다.
    const terminal = await this.em.findOne(Terminal, { serialNo: dto.serialNo }, { populate: ['model', 'merchant'] });
    if (!terminal) throw new NotFoundException(`단말기 ${dto.serialNo}이(가) 없습니다.`);
    await this.em.lock(terminal, LockMode.OPTIMISTIC, dto.expectedVersion);
    const merchant = terminal.merchant;
    if (terminal.status !== TerminalStatus.ALLOCATED || !merchant) {
      throw new InvalidTransitionError(`가맹점에 배정된(ALLOCATED) 단말기만 출고할 수 있습니다(현재: ${terminal.status}).`);
    }

    const trackingNo = await this.adapters.get(dto.carrier).createWaybill({
      reference: `${dto.serialNo}-${Date.now()}`,
      receiverName: merchant.name,
      address: merchant.address,
    });

    return this.em.transactional(async (tx) => {
      // 전이(단말기 UPDATE)를 운송장 INSERT보다 먼저 한다. 운송장 INSERT의 FK 검사가 단말기 행에 S 락을 먼저 잡으면
      // 동시 요청끼리 S→X 데드락이 난다(troubleshooting/0004, decisions/0006).
      const updated = await this.transitions.transition(
        {
          serialNo: dto.serialNo,
          to: TerminalStatus.SHIPPED,
          reason: `출고: ${dto.carrier} ${trackingNo}`,
          actor,
          source: TransitionSource.MANUAL,
          expectedVersion: dto.expectedVersion,
        },
        tx,
      );
      const shipment = tx.create(Shipment, { terminal: updated, carrier: dto.carrier, trackingNo });
      return { shipment, terminal: updated };
    });
  }

  async get(id: number): Promise<{ shipment: Shipment; events: CarrierEvent[] }> {
    const shipment = await this.em.findOne(Shipment, id, { populate: ['terminal'] });
    if (!shipment) throw new NotFoundException(`출고 ${id}이(가) 없습니다.`);
    const events = await this.em.find(CarrierEvent, { shipment }, { orderBy: { occurredAt: 'asc', id: 'asc' } });
    return { shipment, events };
  }
}
