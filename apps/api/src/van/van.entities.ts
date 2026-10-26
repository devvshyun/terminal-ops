import { OptionalProps, PrimaryKeyProp } from '@mikro-orm/core';
import { Entity, Enum, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** 브릿지VAN(가상) 등록 상태 */
export enum VanStatus {
  ACTIVE = 'ACTIVE', // 결제 가능
  SUSPENDED = 'SUSPENDED', // VAN이 일시 정지
  CANCELLED = 'CANCELLED', // 해지
}

export enum VanRunStatus {
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum VanRunTrigger {
  MANUAL = 'MANUAL', // POST /van-reconciliations
  SCHEDULED = 'SCHEDULED', // 주기 작업(일 1회)
}

/** 단계별 걸린 시간(ms) */
export interface VanPhaseMs {
  collect?: number;
  compare?: number;
  reverify?: number;
}

/**
 * VAN 등록 대조 실행 한 번(F9). 진행 중(RUNNING)인 실행은 하나만 있을 수 있다 — MySQL에는 부분 unique가 없어
 * 생성 열 running_key(진행 중이면 1, 아니면 NULL)에 unique를 건다(decisions/0033).
 */
@Entity({ tableName: 'van_reconciliation_run' })
export class VanReconciliationRun {
  [OptionalProps]?: 'status' | 'finishedAt' | 'pages' | 'fetched' | 'retries' | 'candidates' | 'confirmed' | 'resolved' | 'counts' | 'phaseMs' | 'error';

  @PrimaryKey()
  id!: number;

  @Enum({ items: () => VanRunStatus })
  status: VanRunStatus = VanRunStatus.RUNNING;

  /**
   * 진행 중이면 1, 아니면 NULL인 생성 열 + unique: RUNNING 행은 하나만(NULL은 unique에서 서로 다르다, decisions/0033).
   * MikroORM의 부분 unique(where)는 이 열에서는 쓰지 않는다 — `status = 'RUNNING'` 같은 글자 상수가 든 함수 인덱스는 MySQL이
   * `(case when (`status` = _utf8mb4'RUNNING') …)`로 바꿔 저장해 db:migration:check가 늘 다르다고 했다(사전 검증). 앱은 이 열을 읽기만 한다(MikroORM은 생성 열을 INSERT·UPDATE에 넣지 않는다).
   */
  @Property({
    type: 'tinyint',
    nullable: true,
    generated: "(case when `status` = 'RUNNING' then 1 end) virtual",
    unique: 'van_reconciliation_run_running_unique',
  })
  runningKey?: number | null;

  @Enum({ items: () => VanRunTrigger })
  trigger!: VanRunTrigger;

  /** 작업자(수동) 또는 `system:van-reconcile`(주기) */
  @Property({ length: 50 })
  requestedBy!: string;

  @Property({ type: 'datetime', length: 3 })
  startedAt!: Date;

  @Property({ type: 'datetime', length: 3, nullable: true })
  finishedAt: Date | null = null;

  /** 받은 페이지 수와 등록 수 */
  @Property()
  pages: number = 0;

  @Property()
  fetched: number = 0;

  /** 429·5xx로 다시 부른 횟수(목록·재검증 합) */
  @Property()
  retries: number = 0;

  /** 집합 비교가 찾은 후보 수, 재검증 뒤에도 어긋난 수, 재검증에서 풀린 수 */
  @Property()
  candidates: number = 0;

  @Property()
  confirmed: number = 0;

  @Property()
  resolved: number = 0;

  /** 확정된 어긋남의 종류별 수 */
  @Property({ type: 'json', nullable: true })
  counts: Record<string, number> | null = null;

  @Property({ type: 'json', nullable: true })
  phaseMs: VanPhaseMs | null = null;

  @Property({ type: 'varchar', length: 500, nullable: true })
  error: string | null = null;
}

/**
 * VAN에서 받은 등록 목록의 스테이징(실행마다 한 벌). 우리 테이블과 SQL 집합 비교를 하려고 MySQL에 둔다(decisions/0033).
 * PK가 (run_id, serial_no)라 한 실행의 행이 클러스터 인덱스에 모여 있고, 정리는 `where run_id = ? limit n`(PK 범위)으로 한다.
 * 외래키를 두지 않는다 — 수만 행 INSERT가 실행 행에 FK 검사 S 락을 걸지 않게(Outbox·device_connectivity와 같은 이유).
 */
@Entity({ tableName: 'van_registration_snapshot' })
export class VanRegistrationSnapshot {
  [PrimaryKeyProp]?: ['runId', 'serialNo'];

  @PrimaryKey({ autoincrement: false })
  runId!: number;

  @PrimaryKey({ length: 32 })
  serialNo!: string;

  /** VAN 단말기 번호(참고값, 대조 키가 아님) */
  @Property({ length: 32 })
  tid!: string;

  @Property({ length: 40 })
  merchantCode!: string;

  @Enum({ items: () => VanStatus })
  status!: VanStatus;

  @Property({ type: 'datetime', length: 3 })
  vanUpdatedAt!: Date;
}
