import { Migration } from '@mikro-orm/migrations';

export class Migration20261026033754 extends Migration {

  override name = 'Migration20261026033754';

  override up(): void | Promise<void> {
    this.addSql(`alter table \`van_reconciliation_run\` add \`unverifiable\` int not null default 0;`);

    this.addSql(`alter table \`van_reconciliation_item\` add \`reason\` varchar(200) null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table \`van_reconciliation_item\` drop column \`reason\`;`);

    this.addSql(`alter table \`van_reconciliation_run\` drop column \`unverifiable\`;`);
  }

}
