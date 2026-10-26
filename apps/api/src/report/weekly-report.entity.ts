import { OptionalProps } from '@mikro-orm/core';
import { Entity, Enum, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

export enum WeeklyReportStatus {
  PENDING = 'PENDING', // 행만 있음(파일 아직 없음)
  GENERATED = 'GENERATED', // 파일을 만들어 저장함, 아직 못 보냄
  SENT = 'SENT', // 톡톡메신저로 보냄. 같은 주는 다시 보내지 않는다
}

/**
 * 주간 운영 리포트 한 주(F11). week_start unique라 같은 주는 한 행 — 다시 시도하면 같은 행을 갱신하고, SENT면 보내지 않는다(멱등, decisions/0035).
 * 파일(xlsx)은 이 행의 mediumblob에 둔다(작고, 어느 프로세스든 같은 파일을 내려줄 수 있게). lazy라 목록·상태 조회는 파일을 읽지 않는다.
 */
@Entity({ tableName: 'weekly_report' })
export class WeeklyReport {
  [OptionalProps]?: 'status' | 'fileName' | 'file' | 'fileSize' | 'generatedAt' | 'sentAt' | 'toktokFileId' | 'attempts' | 'lastError' | 'createdAt';

  @PrimaryKey()
  id!: number;

  /** 그 주 월요일(KST) 날짜 */
  @Property({ type: 'date', unique: true })
  weekStart!: string;

  @Enum({ items: () => WeeklyReportStatus })
  status: WeeklyReportStatus = WeeklyReportStatus.PENDING;

  @Property({ type: 'varchar', length: 100, nullable: true })
  fileName: string | null = null;

  @Property({ type: 'blob', columnType: 'mediumblob', nullable: true, lazy: true })
  file: Buffer | null = null;

  @Property({ type: 'integer', nullable: true })
  fileSize: number | null = null;

  @Property({ type: 'datetime', length: 3, nullable: true })
  generatedAt: Date | null = null;

  @Property({ type: 'datetime', length: 3, nullable: true })
  sentAt: Date | null = null;

  /** 마지막으로 올린 첨부의 톡톡 fileId */
  @Property({ type: 'varchar', length: 64, nullable: true })
  toktokFileId: string | null = null;

  /** 보내기 시도 횟수 */
  @Property()
  attempts: number = 0;

  @Property({ type: 'varchar', length: 500, nullable: true })
  lastError: string | null = null;

  @Property({ type: 'datetime', length: 3 })
  createdAt: Date = new Date();
}
