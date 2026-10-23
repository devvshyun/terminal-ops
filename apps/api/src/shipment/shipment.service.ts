import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { CarrierAdapters } from '../carrier/carrier.adapters.js';
import type { Carrier } from '../carrier/carrier.types.js';
import { InvalidTransitionError } from '../common/domain-errors.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import { TransitionService } from '../terminal/transition.service.js';
import type { CreateShipmentDto } from './dto/create-shipment.dto.js';
import { CarrierEvent, Shipment, ShipmentStatus } from './shipment.entities.js';

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
          source: TransitionSource.SHIPMENT,
          expectedVersion: dto.expectedVersion,
        },
        tx,
      );
      const shipment = await this.recordShipment(tx, updated, dto.carrier, trackingNo);
      return { shipment, terminal: updated };
    });
  }

  /**
   * 단말기의 새 운송장을 저장한다. 같은 단말기의 이전 배송 중 운송장은 SUPERSEDED로 바꿔, 옛 운송장의 배송 완료가
   * 새 출고를 완료 처리하지 못하게 한다(decisions/0018). 단말기 UPDATE(전이) 뒤에 부른다 — 단말기 X 락을 먼저 쥔 상태라
   * 같은 단말기의 출고끼리는 여기서 순서가 정해진다. 교체 출고(F7)도 이 함수를 쓴다.
   *
   * 이전 운송장은 잠그지 않는 읽기로 id를 찾고 PK로 갱신한다. `WHERE terminal_id=? AND status=...` UPDATE는 REPEATABLE READ에서
   * terminal_id 인덱스에 gap 락을 걸고, 운송장이 없는 단말기끼리는 같은 gap(대개 supremum)을 잡은 채 서로의 INSERT를
   * 막아 데드락이 났다(troubleshooting/0014). 잠그지 않는 읽기여도 맞는 이유: 운송장을 저장하는 모든 경로가 먼저 그 단말기
   * 행을 UPDATE(X 락, version 검사)하므로, 이 읽기 뒤에 같은 단말기의 운송장이 새로 커밋될 수 없다. 스냅숏보다 늦게 커밋된
   * 운송장이 있었다면 그 트랜잭션이 단말기 version을 올렸으므로 이 트랜잭션의 단말기 UPDATE가 먼저 실패한다.
   * 갱신에 status 조건을 남겨, 읽은 뒤 배송 완료가 커밋된 운송장(DELIVERED)은 덮어쓰지 않는다.
   */
  async recordShipment(tx: EntityManager, terminal: Terminal, carrier: Carrier, trackingNo: string): Promise<Shipment> {
    const previous: { id: number }[] = await tx
      .createQueryBuilder(Shipment)
      .select('id')
      .where({ terminal: terminal.id, status: ShipmentStatus.IN_TRANSIT })
      .execute('all');
    if (previous.length > 0) {
      await tx.nativeUpdate(
        Shipment,
        { id: { $in: previous.map((s) => s.id) }, status: ShipmentStatus.IN_TRANSIT },
        { status: ShipmentStatus.SUPERSEDED },
      );
    }
    return tx.create(Shipment, { terminal, carrier, trackingNo });
  }

  async get(id: number): Promise<{ shipment: Shipment; events: CarrierEvent[] }> {
    const shipment = await this.em.findOne(Shipment, id, { populate: ['terminal'] });
    if (!shipment) throw new NotFoundException(`출고 ${id}이(가) 없습니다.`);
    const events = await this.em.find(CarrierEvent, { shipment }, { orderBy: { occurredAt: 'asc', id: 'asc' } });
    return { shipment, events };
  }
}
