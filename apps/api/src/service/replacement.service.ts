import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { CarrierAdapters } from '../carrier/carrier.adapters.js';
import type { Carrier } from '../carrier/carrier.types.js';
import { BusinessError } from '../common/domain-errors.js';
import { Merchant } from '../merchant/merchant.entity.js';
import { ShipmentService } from '../shipment/shipment.service.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import { TransitionService } from '../terminal/transition.service.js';
import { ServiceTicket, ServiceTicketStatus } from './service-ticket.entity.js';
import { ServiceTicketService } from './service-ticket.service.js';

/**
 * 두 단말기를 잠그는 순서. 운영 코드는 항상 'id-asc'(decisions/0023).
 * 'faulty-first'(고장 단말기 → 교체 단말기)는 실험 0007에서 순서를 바꿨을 때를 재 보려고만 둔다.
 */
export type LockOrder = 'id-asc' | 'faulty-first';

export interface ReplaceCommand {
  replacementSerialNo: string;
  carrier: Carrier;
}

/** A/S 교체 출고와 설치 확인(F7). "새 단말기 출고 + 고장 단말기 회수 요청"을 한 트랜잭션으로 처리한다. */
@Injectable()
export class ReplacementService {
  constructor(
    private readonly em: EntityManager,
    private readonly tickets: ServiceTicketService,
    private readonly transitions: TransitionService,
    private readonly shipments: ShipmentService,
    private readonly adapters: CarrierAdapters,
  ) {}

  /**
   * ① 트랜잭션 밖 사전 확인: 접수 OPEN, 교체 단말기 IN_STOCK·같은 모델. 실패하면 택배사를 부르지 않는다.
   * ② 트랜잭션 밖 운송장 발급(decisions/0012).
   * ③ 한 트랜잭션: 두 단말기를 id 오름차순으로 잠금(FOR UPDATE) → 접수 행 잠금(OPEN 재확인) → 교체 단말기 IN_STOCK → ALLOCATED(가맹점)
   *    → SHIPPED, 고장 단말기 IN_SERVICE → RETURN_REQUESTED, 운송장 저장, 접수 REPLACING.
   *    하나라도 실패하면 전부 롤백된다. ②의 운송장은 고아로 남는다(알려진 한계).
   */
  async replace(id: number, cmd: ReplaceCommand, actor: string, opts: { lockOrder?: LockOrder } = {}): Promise<ServiceTicket> {
    const ticket = await this.tickets.get(id);
    if (ticket.status !== ServiceTicketStatus.OPEN) {
      throw new BusinessError(422, 'TICKET_NOT_OPEN', `A/S 접수 ${id}은(는) ${ticket.status} 상태라 교체 출고할 수 없습니다.`);
    }
    const replacement = await this.em.fork().findOne(Terminal, { serialNo: cmd.replacementSerialNo });
    if (!replacement) throw new NotFoundException(`단말기 ${cmd.replacementSerialNo}이(가) 없습니다.`);
    if (replacement.status !== TerminalStatus.IN_STOCK) {
      throw new BusinessError(422, 'REPLACEMENT_NOT_IN_STOCK', `교체 단말기는 재고(IN_STOCK)여야 합니다(현재: ${replacement.status}).`);
    }
    if (replacement.model.id !== ticket.terminal.model.id) {
      throw new BusinessError(422, 'MODEL_MISMATCH', '교체 단말기는 고장 단말기와 같은 모델이어야 합니다.');
    }

    const merchant = ticket.merchant;
    const trackingNo = await this.adapters.get(cmd.carrier).createWaybill({
      reference: `AS-${id}-${replacement.serialNo}`,
      receiverName: merchant.name,
      address: merchant.address,
    });

    const faultyId = ticket.terminal.id;
    await this.em.fork().transactional(async (tx) => {
      // 잠금 순서: 단말기 행 먼저, 접수 행은 그다음(decisions/0023). 접수 생성(open)이 단말기 행을 먼저 잠그므로 같은 순서를 지킨다.
      await this.lockTerminals(tx, faultyId, replacement.id, opts.lockOrder ?? 'id-asc');
      const locked = await this.tickets.lockOpen(tx, id, [ServiceTicketStatus.OPEN]);

      const assigned = tx.getReference(Merchant, merchant.id);
      await this.transitions.transition(
        {
          serialNo: replacement.serialNo,
          to: TerminalStatus.ALLOCATED,
          reason: `A/S 교체 배정: 접수 #${id}`,
          actor,
          source: TransitionSource.ALLOCATION,
          mutate: (t) => {
            t.merchant = assigned;
          },
        },
        tx,
      );
      const shipped = await this.transitions.transition(
        {
          serialNo: replacement.serialNo,
          to: TerminalStatus.SHIPPED,
          reason: `A/S 교체 출고: ${cmd.carrier} ${trackingNo}`,
          actor,
          source: TransitionSource.SHIPMENT,
        },
        tx,
      );
      await this.transitions.transition(
        {
          serialNo: ticket.terminal.serialNo,
          to: TerminalStatus.RETURN_REQUESTED,
          reason: `A/S 교체로 회수 요청: 접수 #${id}`,
          actor,
          source: TransitionSource.SERVICE,
        },
        tx,
      );
      const shipment = await this.shipments.recordShipment(tx, shipped, cmd.carrier, trackingNo);
      locked.status = ServiceTicketStatus.REPLACING;
      locked.replacementTerminal = shipped;
      locked.outboundShipment = shipment;
    });
    return this.tickets.get(id);
  }

  /**
   * 설치 확인: 교체 단말기 DELIVERED → IN_SERVICE(SERVICE), 접수 CLOSED. 배송 완료 전이면 422.
   * 잠금 순서는 교체 출고와 같다(단말기 → 접수, decisions/0023). 그래서 접수를 잠그지 않고 먼저 읽어 교체 단말기 id만 알아낸다.
   * REPLACING이 된 뒤에는 교체 단말기가 바뀌지 않으므로, 접수 잠금 뒤 상태만 다시 본다.
   */
  async install(id: number, actor: string): Promise<ServiceTicket> {
    const current = await this.tickets.get(id);
    if (current.status !== ServiceTicketStatus.REPLACING || !current.replacementTerminal) {
      throw new BusinessError(
        422,
        'TICKET_NOT_OPEN',
        `A/S 접수 ${id}은(는) ${current.status} 상태라 이 작업을 할 수 없습니다(필요: ${ServiceTicketStatus.REPLACING}).`,
      );
    }
    const replacementId = current.replacementTerminal.id;
    await this.em.fork().transactional(async (tx) => {
      const replacement = await tx.findOneOrFail(Terminal, replacementId, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const ticket = await this.tickets.lockOpen(tx, id, [ServiceTicketStatus.REPLACING]);
      await this.transitions.transition(
        {
          serialNo: replacement.serialNo,
          to: TerminalStatus.IN_SERVICE,
          reason: `A/S 교체 설치 확인: 접수 #${id}`,
          actor,
          source: TransitionSource.SERVICE,
        },
        tx,
      );
      ticket.status = ServiceTicketStatus.CLOSED;
      ticket.closedAt = new Date();
    });
    return this.tickets.get(id);
  }

  /**
   * 두 단말기 행을 FOR UPDATE로 한 행씩 잠근다. 여러 행을 잠그는 트랜잭션들이 늘 같은 순서(id 오름차순)로 잠가야
   * 서로 상대가 쥔 행을 기다리는 순환(데드락)이 생기지 않는다(decisions/0023, experiments/0007).
   */
  private async lockTerminals(tx: EntityManager, faultyId: number, replacementId: number, order: LockOrder): Promise<void> {
    const ids = order === 'id-asc' ? [faultyId, replacementId].sort((a, b) => a - b) : [faultyId, replacementId];
    for (const terminalId of ids) await tx.findOneOrFail(Terminal, terminalId, { lockMode: LockMode.PESSIMISTIC_WRITE });
  }
}
