import { OptionalProps } from '@mikro-orm/core';
import { Entity, Enum, Index, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import type { RowResult } from '../terminal/bulk-rows.js';

export enum ScanKind {
  RECEIVE = 'RECEIVE', // 발주분 신규 입고
  RETURN_IN = 'RETURN_IN', // 회수 단말기 입고(RETURNING → RETURNED)
}

/**
 * 처리를 마친 박스 스캔 한 건. 같은 scanId가 다시 오면 처리하지 않고 이 결과를 그대로 돌려준다(멱등, decisions/0020).
 * 외래키를 두지 않는다(poNo는 문자열) — 단말기 INSERT와 같은 트랜잭션에서 부모 행에 S 락을 더 걸지 않게.
 */
@Entity({ tableName: 'scan_batch' })
@Index({ properties: ['poNo'] })
export class ScanBatch {
  [OptionalProps]?: 'createdAt';

  @PrimaryKey()
  id!: number;

  /** 스캐너가 박스마다 만드는 키 */
  @Property({ unique: true, length: 64 })
  scanId!: string;

  @Enum({ items: () => ScanKind })
  kind!: ScanKind;

  @Property({ length: 30, nullable: true })
  poNo?: string | null;

  /** 요청 내용(kind, poNo, serials)의 SHA-256. 같은 scanId로 다른 내용을 보내면 거절한다. */
  @Property({ length: 64 })
  requestHash!: string;

  @Property({ length: 50 })
  actor!: string;

  /** 행별 결과(입력 순서) */
  @Property({ type: 'json' })
  results!: RowResult[];

  @Property()
  createdAt: Date = new Date();
}
