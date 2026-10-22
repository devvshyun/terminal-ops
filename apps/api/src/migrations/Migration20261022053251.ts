import { Migration } from '@mikro-orm/migrations';

export class Migration20261022053251 extends Migration {

  override name = 'Migration20261022053251';

  override up(): void | Promise<void> {
    this.addSql(`alter table \`terminal_status_history\` modify \`source\` enum('MANUAL','INSPECTION','BATCH') not null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table \`terminal_status_history\` modify \`source\` enum('MANUAL','INSPECTION') not null;`);
  }

}
