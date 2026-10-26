import { Migration } from '@mikro-orm/migrations';

export class Migration20261026040250 extends Migration {

  override name = 'Migration20261026040250';

  override up(): void | Promise<void> {
    this.addSql(`alter table \`van_reconciliation_run\` add \`acknowledge_drop\` tinyint(1) not null default false;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table \`van_reconciliation_run\` drop column \`acknowledge_drop\`;`);
  }

}
