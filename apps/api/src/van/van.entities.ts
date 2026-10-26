import { OptionalProps, PrimaryKeyProp, type Rel } from '@mikro-orm/core';
import { Entity, Enum, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/** 브릿지VAN(가상) 등록 상태 */
export enum VanStatus {
  ACTIVE = 'ACTIVE', // 결제 가능
  SUSPENDED = 'SUSPENDED', // VAN이 일시 정지
  CANCELLED = 'CANCELLED', // 해지
}

/** 어긋남 종류(decisions/0033) */
export enum VanMismatchKind {
  /** 우리는 운영 중(IN_SERVICE)인데 VAN에 없거나 해지(CANCELLED) — 결제가 안 된다 */
  NOT_REGISTERED = 'NOT_REGISTERED',
  /** VAN은 ACTIVE인데 우리는 운영 중이 아님(회수·폐기 등) — 해지 요청이 빠졌다 */
  REGISTERED_BUT_NOT_IN_SERVICE = 'REGISTERED_BUT_NOT_IN_SERVICE',
  /** 둘 다 활성인데 가맹점이 다르다(우리 가맹점이 없는 경우 포함) — 정산이 엉뚱한 가맹점으로 간다 */
  MERCHANT_MISMATCH = 'MERCHANT_MISMATCH',
  /** VAN이 정지(SUSPENDED)했는데 우리는 운영 중 */
  SUSPENDED_WHILE_IN_SERVICE = 'SUSPENDED_WHILE_IN_SERVICE',
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

  /**
   * 살아 있다는 신호: 시작할 때와 수집 페이지마다(재검증이 있으면 블록마다) 갱신한다(조건 status=RUNNING).
   * 멈춘 실행은 시작 시각이 아니라 이 값으로 판정한다 — 오래 걸리는 정상 실행을 죽은 것으로 보지 않게(decisions/0033).
   */
  @Property({ type: 'datetime', length: 3 })
  heartbeatAt!: Date;

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

/**
 * 대조 결과 한 줄. 집합 비교가 찾은 후보마다 하나 — 재검증 뒤에도 어긋나면 verified=true(그때의 종류·값),
 * 재검증에서 풀렸으면 verified=false(비교 때의 종류·값, 스캔 도중 변경 등으로 생긴 거짓 양성).
 * 목록은 (run_id, id) 순서로 넘긴다 — run_id 인덱스의 항목에 PK(id)가 붙어 있어 따로 복합 인덱스가 필요 없다.
 */
@Entity({ tableName: 'van_reconciliation_item' })
export class VanReconciliationItem {
  @PrimaryKey()
  id!: number;

  @ManyToOne(() => VanReconciliationRun)
  run!: Rel<VanReconciliationRun>;

  @Property({ length: 32 })
  serialNo!: string;

  @Enum({ items: () => VanMismatchKind })
  kind!: VanMismatchKind;

  /** 우리 쪽 값(예: `IN_SERVICE / GANGNAM-KIMBAP`) */
  @Property({ length: 100 })
  ourValue!: string;

  /** VAN 쪽 값(예: `SUSPENDED / GANGNAM-KIMBAP`, `VAN에 없음`) */
  @Property({ length: 100 })
  vanValue!: string;

  @Property()
  verified!: boolean;
}
