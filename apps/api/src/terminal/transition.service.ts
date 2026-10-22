import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { InvalidTransitionError } from '../common/domain-errors.js';
import { OUTBOX_TYPE, OutboxEvent } from '../outbox/outbox-event.entity.js';
import { Terminal } from './terminal.entity.js';
import { TerminalStatusHistory } from './terminal-status-history.entity.js';
import { TerminalStatus, TransitionSource } from './terminal-status.js';
import { checkTransition } from './transition-rules.js';

export interface TransitionCommand {
  serialNo: string;
  to: TerminalStatus;
  reason: string;
  actor: string;
  source: TransitionSource;
  /** 사람이 화면을 보고 바꿀 때는 필수. 시스템 작업은 생략할 수 있다(flush 시 version 검사는 그래도 일어난다). */
  expectedVersion?: number;
  /**
   * 상태와 함께 바꿀 단말기 필드(예: 배정 가맹점). 규칙 확인 뒤, UPDATE 전에 적용해 상태 변경과 같은 UPDATE 한 번에 나간다
   * (decisions/0011). 상태(status)는 여기서 바꾸지 않는다.
   */
  mutate?: (terminal: Terminal) => void;
}

/** 단말기 상태를 바꾸는 유일한 경로. 규칙 확인, 상태 변경, 이력 기록을 한 트랜잭션으로 묶는다. */
@Injectable()
export class TransitionService {
  constructor(private readonly em: EntityManager) {}

  /**
   * @param em 이미 열린 트랜잭션에 합류할 때 넘긴다(예: 검수 저장과 같은 트랜잭션).
   */
  async transition(cmd: TransitionCommand, em: EntityManager = this.em): Promise<Terminal> {
    return em.transactional(async (tx) => {
      const terminal = await tx.findOne(Terminal, { serialNo: cmd.serialNo }, { populate: ['model', 'merchant'] });
      if (!terminal) throw new NotFoundException(`단말기 ${cmd.serialNo}이(가) 없습니다.`);

      // 규칙보다 version을 먼저 본다. 낡은 화면에서 온 요청은 "규칙 위반"이 아니라 "충돌"로 알려야 한다.
      if (cmd.expectedVersion !== undefined) {
        await tx.lock(terminal, LockMode.OPTIMISTIC, cmd.expectedVersion);
      }

      const check = checkTransition(terminal.status, cmd.to, cmd.source, {
        requiresReinspection: terminal.model.requiresReinspection,
      });
      if (!check.ok) throw new InvalidTransitionError(check.reason);

      const from = terminal.status;
      terminal.status = cmd.to;
      cmd.mutate?.(terminal);
      // version 검사 UPDATE를 이력 INSERT보다 먼저 보낸다. INSERT가 먼저면 FK 검사의 공유 락끼리 엉켜 데드락이 난다(troubleshooting/0004).
      await tx.flush();
      tx.create(TerminalStatusHistory, {
        terminal,
        fromStatus: from,
        toStatus: cmd.to,
        source: cmd.source,
        actor: cmd.actor,
        reason: cmd.reason,
      });
      this.recordOutbox(tx, terminal, from, cmd);
      return terminal;
    });
  }

  /**
   * 새로 만든 단말기의 첫 이력(null → 현재 상태)을 남긴다. 등록 트랜잭션 안에서 부른다(decisions/0008).
   * 단말기 INSERT와 이력 INSERT가 같은 트랜잭션이고 부모 행은 이 트랜잭션이 막 만든 행이라 S→X 승격이 생기지 않는다.
   */
  recordRegistration(terminal: Terminal, actor: string, source: TransitionSource, em: EntityManager): TerminalStatusHistory {
    const reason = '신규 등록';
    const history = em.create(TerminalStatusHistory, {
      terminal,
      fromStatus: null,
      toStatus: terminal.status,
      source,
      actor,
      reason,
    });
    this.recordOutbox(em, terminal, null, { to: terminal.status, source, actor, reason });
    return history;
  }

  /**
   * 상태 변경 알림을 같은 트랜잭션에 기록한다(Outbox, decisions/0016). 커밋되면 알림도 반드시 남고, 롤백되면 같이 사라진다.
   * outbox_event에는 외래키가 없어 단말기 행에 락을 걸지 않는다(UPDATE 먼저 규칙과 충돌하지 않는다).
   */
  private recordOutbox(
    em: EntityManager,
    terminal: Terminal,
    from: TerminalStatus | null,
    change: { to: TerminalStatus; source: TransitionSource; actor: string; reason: string },
  ): void {
    em.create(OutboxEvent, {
      type: OUTBOX_TYPE.TERMINAL_STATUS_CHANGED,
      payload: {
        serialNo: terminal.serialNo,
        fromStatus: from,
        toStatus: change.to,
        source: change.source,
        actor: change.actor,
        reason: change.reason,
        occurredAt: new Date().toISOString(),
      },
    });
  }
}
