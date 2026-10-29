import { OptionalProps } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** 관제 작업 종류(contracts OpsActionKind와 같다 — contract-assertions.ts) */
export const OPS_ACTIONS = ['RETRY_JOB', 'REMOVE_JOB', 'REQUEUE_OUTBOX'] as const;
export type OpsAction = (typeof OPS_ACTIONS)[number];

/**
 * 관제 작업 감사 기록(보강 6, decisions/0073): 누가(로그인 아이디·역할) 언제 무엇을(작업·큐·job) 했나.
 * 작업이 성공한 뒤 한 행을 넣는다 — 실패한 작업(404·409)은 남기지 않는다. 고치거나 지우는 API는 없다(쌓기만).
 * 외래키를 두지 않는다 — 계정을 지워도(사용 중지가 아니라 행 삭제) 기록은 남게. 이력의 actor(로그인 아이디 문자열)와 같은 방식.
 */
@Entity({ tableName: 'ops_action_log' })
export class OpsActionLog {
  [OptionalProps]?: 'queue' | 'jobId' | 'jobName' | 'detail' | 'createdAt';

  @PrimaryKey()
  id!: number;

  /** OPS_ACTIONS 중 하나. type을 적는 이유: 유니온 별칭은 swc가 design:type을 Object로 내보낸다(troubleshooting/0029) */
  @Property({ type: 'string', length: 20 })
  action!: OpsAction;

  /** 로그인 아이디 */
  @Property({ length: 50 })
  actor!: string;

  /** 그때의 역할(나중에 역할이 바뀌어도 기록은 그대로) */
  @Property({ length: 20 })
  actorRole!: string;

  /** job 작업이면 큐 이름, sweep이면 null */
  @Property({ type: 'varchar', length: 30, nullable: true })
  queue: string | null = null;

  /** BullMQ job id(주기 job은 `repeat:<id>:<시각>`처럼 길다) */
  @Property({ type: 'varchar', length: 200, nullable: true })
  jobId: string | null = null;

  @Property({ type: 'varchar', length: 50, nullable: true })
  jobName: string | null = null;

  /** 작업 때의 사정(다시 시도·지운 job의 실패 이유·시도 횟수, sweep의 결과 수). 화면에 그대로 보인다 — 비밀 값을 넣지 않는다 */
  @Property({ type: 'json', nullable: true })
  detail: Record<string, unknown> | null = null;

  @Property({ type: 'datetime', length: 3 })
  createdAt: Date = new Date();
}
