import { Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { InvalidTransitionError } from '../common/domain-errors.js';
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
      const terminal = await tx.findOne(Terminal, { serialNo: cmd.serialNo }, { populate: ['model'] });
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
      return terminal;
    });
  }

  /**
   * 새로 만든 단말기의 첫 이력(null → 현재 상태)을 남긴다. 등록 트랜잭션 안에서 부른다(decisions/0008).
   * 단말기 INSERT와 이력 INSERT가 같은 트랜잭션이고 부모 행은 이 트랜잭션이 막 만든 행이라 S→X 승격이 생기지 않는다.
   */
  recordRegistration(terminal: Terminal, actor: string, source: TransitionSource, em: EntityManager): TerminalStatusHistory {
    return em.create(TerminalStatusHistory, {
      terminal,
      fromStatus: null,
      toStatus: terminal.status,
      source,
      actor,
      reason: '신규 등록',
    });
  }
}
