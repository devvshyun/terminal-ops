import { Migration } from '@mikro-orm/migrations';
import { assertEnumNarrowable } from '../db/migration-guards.js';

export class Migration20261023015811 extends Migration {

  override name = 'Migration20261023015811';

  override up(): void | Promise<void> {
    this.addSql(`alter table \`shipment\` modify \`status\` enum('IN_TRANSIT','DELIVERED','SUPERSEDED') not null default 'IN_TRANSIT';`);

    this.addSql(`alter table \`terminal_status_history\` modify \`source\` enum('MANUAL','INSPECTION','BATCH','ALLOCATION','SHIPMENT','SCAN','IMPORT','SERVICE') not null;`);
  }

  // 생성된 down()은 enum이 소문자였다(troubleshooting/0005). 대문자로 고쳤다.
  // 주의: SUPERSEDED 운송장이나 새 출처(ALLOCATION 등)의 이력이 있으면 strict 모드에서 실패한다. 되돌리기 전에 그 행을 처리한다.
  // 최종 리뷰 Minor 3(troubleshooting/0025): 그런 행이 있으면 ALTER를 하나도 보내기 전에 던진다(DDL 암묵 커밋으로 반쪽만 되돌려지지 않게).
  override async down(): Promise<void> {
    await assertEnumNarrowable(this, this.name, [
      { table: 'shipment', column: 'status', keep: ['IN_TRANSIT', 'DELIVERED'] },
      { table: 'terminal_status_history', column: 'source', keep: ['MANUAL', 'INSPECTION', 'BATCH'] },
    ]);
    this.addSql(`alter table \`shipment\` modify \`status\` enum('IN_TRANSIT','DELIVERED') not null default 'IN_TRANSIT';`);

    this.addSql(`alter table \`terminal_status_history\` modify \`source\` enum('MANUAL','INSPECTION','BATCH') not null;`);
  }

}
