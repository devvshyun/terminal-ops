import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LoadStrategy, LockMode } from '@mikro-orm/mysql';
import type { RuleViolationCode } from '@terminal-ops/contracts';
import { BusinessError } from '../common/domain-errors.js';
import { beforeIdWhere, keysetPage } from '../common/keyset.js';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus } from '../terminal/terminal-status.js';
import type { ListTicketsQuery, OpenTicketDto, RemoteCheckDto } from './dto/service-ticket.dto.js';
import { OPEN_TICKET_STATUSES, ServiceTicket, ServiceTicketStatus } from './service-ticket.entity.js';

export const TICKET_POPULATE = ['terminal', 'merchant', 'replacementTerminal', 'outboundShipment'] as const;

/** A/S 접수·원격 점검(F7). 교체 출고·설치 확인은 ReplacementService. */
@Injectable()
export class ServiceTicketService {
  constructor(private readonly em: EntityManager) {}

  /**
   * 접수. 단말기 행을 FOR UPDATE로 먼저 잠그고(같은 단말기 접수끼리 줄 세우기) 열린 접수가 없을 때만 만든다.
   * 접수 INSERT의 FK 검사(S 락)보다 단말기 X 락이 먼저라 S→X 데드락이 없다(troubleshooting/0004).
   * 단말기 상태는 바꾸지 않는다(운영 중 그대로).
   */
  async open(dto: OpenTicketDto, actor: string): Promise<ServiceTicket> {
    const id = await this.em.fork().transactional(async (tx) => {
      const terminal = await tx.findOne(Terminal, { serialNo: dto.serialNo }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (!terminal) throw new NotFoundException(`단말기 ${dto.serialNo}이(가) 없습니다.`);
      if (terminal.status !== TerminalStatus.IN_SERVICE || !terminal.merchant) {
        throw new BusinessError(422, 'TERMINAL_NOT_IN_SERVICE', `운영 중(IN_SERVICE)인 단말기만 A/S 접수할 수 있습니다(현재: ${terminal.status}).`);
      }
      const already = await tx.count(ServiceTicket, { terminal, status: { $in: OPEN_TICKET_STATUSES } });
      if (already > 0) throw new BusinessError(409, 'TICKET_ALREADY_OPEN', `단말기 ${dto.serialNo}에 이미 열린 A/S 접수가 있습니다.`);
      const ticket = tx.create(ServiceTicket, { terminal, merchant: terminal.merchant, symptom: dto.symptom, openedBy: actor });
      await tx.flush();
      return ticket.id;
    });
    return this.get(id);
  }

  /** 원격 점검 결과. 해결이면 종결(RESOLVED_REMOTELY), 아니면 메모만 남기고 OPEN 그대로. */
  async remoteCheck(id: number, dto: RemoteCheckDto): Promise<ServiceTicket> {
    await this.em.fork().transactional(async (tx) => {
      const ticket = await this.lockOpen(tx, id, [ServiceTicketStatus.OPEN]);
      ticket.remoteNote = dto.note;
      if (dto.resolved) {
        ticket.status = ServiceTicketStatus.RESOLVED_REMOTELY;
        ticket.closedAt = new Date();
      }
    });
    return this.get(id);
  }

  /** 접수 목록(최근 것부터, id 키셋 — decisions/0039) */
  async list(q: ListTicketsQuery) {
    const rows = await this.em.fork().find(
      ServiceTicket,
      {
        ...beforeIdWhere(q.beforeId),
        ...(q.status ? { status: q.status } : {}),
        ...(q.serialNo ? { terminal: { serialNo: q.serialNo } } : {}),
      },
      { populate: TICKET_POPULATE, strategy: LoadStrategy.SELECT_IN, orderBy: { id: 'desc' }, limit: q.limit + 1 },
    );
    return keysetPage(rows, q.limit);
  }

  async get(id: number): Promise<ServiceTicket> {
    const ticket = await this.em.fork().findOne(ServiceTicket, id, { populate: TICKET_POPULATE });
    if (!ticket) throw new NotFoundException(`A/S 접수 ${id}이(가) 없습니다.`);
    return ticket;
  }

  /**
   * 접수 행을 FOR UPDATE로 잠그고, 상태가 expected 중 하나인지 확인한다.
   * @param code 상태가 다를 때의 오류 코드. 설치 확인은 TICKET_NOT_REPLACING(Day 3 리뷰 Minor 4)
   */
  async lockOpen(tx: EntityManager, id: number, expected: ServiceTicketStatus[], code: RuleViolationCode = 'TICKET_NOT_OPEN'): Promise<ServiceTicket> {
    const ticket = await tx.findOne(ServiceTicket, id, { lockMode: LockMode.PESSIMISTIC_WRITE });
    if (!ticket) throw new NotFoundException(`A/S 접수 ${id}이(가) 없습니다.`);
    if (!expected.includes(ticket.status)) {
      throw new BusinessError(422, code, `A/S 접수 ${id}은(는) ${ticket.status} 상태라 이 작업을 할 수 없습니다(필요: ${expected.join(', ')}).`);
    }
    return ticket;
  }
}
