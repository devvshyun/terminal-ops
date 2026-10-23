import { Migration } from '@mikro-orm/migrations';

export class Migration20261023030532 extends Migration {

  override name = 'Migration20261023030532';

  override up(): void | Promise<void> {
    this.addSql(`alter table \`purchase_order\` add \`closed_by\` varchar(50) null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table \`purchase_order\` drop column \`closed_by\`;`);
  }

}
