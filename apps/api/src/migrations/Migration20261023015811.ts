import { Migration } from '@mikro-orm/migrations';

export class Migration20261023015811 extends Migration {

  override name = 'Migration20261023015811';

  override up(): void | Promise<void> {
    this.addSql(`alter table \`shipment\` modify \`status\` enum('IN_TRANSIT','DELIVERED','SUPERSEDED') not null default 'IN_TRANSIT';`);

    this.addSql(`alter table \`terminal_status_history\` modify \`source\` enum('MANUAL','INSPECTION','BATCH','ALLOCATION','SHIPMENT','SCAN','IMPORT','SERVICE') not null;`);
  }

  // 생성된 down()은 enum이 소문자였다(troubleshooting/0005). 대문자로 고쳤다.
  // 주의: SUPERSEDED 운송장이나 새 출처(ALLOCATION 등)의 이력이 있으면 strict 모드에서 실패한다. 되돌리기 전에 그 행을 처리한다.
  override down(): void | Promise<void> {
    this.addSql(`alter table \`shipment\` modify \`status\` enum('IN_TRANSIT','DELIVERED') not null default 'IN_TRANSIT';`);

    this.addSql(`alter table \`terminal_status_history\` modify \`source\` enum('MANUAL','INSPECTION','BATCH') not null;`);
  }

}
