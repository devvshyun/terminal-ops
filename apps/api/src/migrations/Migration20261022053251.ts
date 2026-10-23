import { Migration } from '@mikro-orm/migrations';

export class Migration20261022053251 extends Migration {

  override name = 'Migration20261022053251';

  override up(): void | Promise<void> {
    this.addSql(`alter table \`terminal_status_history\` modify \`source\` enum('MANUAL','INSPECTION','BATCH') not null;`);
  }

  // 주의: source가 BATCH인 이력이 있으면 strict 모드에서 이 down()은 실패한다(enum에 없는 값). 되돌리기 전에 그 행을 처리해야 한다(Day 2 리뷰 Minor 7).
  override down(): void | Promise<void> {
    this.addSql(`alter table \`terminal_status_history\` modify \`source\` enum('MANUAL','INSPECTION') not null;`);
  }

}
