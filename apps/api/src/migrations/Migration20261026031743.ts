import { Migration } from '@mikro-orm/migrations';

export class Migration20261026031743 extends Migration {

  override name = 'Migration20261026031743';

  override up(): void | Promise<void> {
    this.addSql(`create table \`van_reconciliation_item\` (\`id\` int unsigned not null auto_increment primary key, \`run_id\` int unsigned not null, \`serial_no\` varchar(32) not null, \`kind\` enum('NOT_REGISTERED','REGISTERED_BUT_NOT_IN_SERVICE','MERCHANT_MISMATCH','SUSPENDED_WHILE_IN_SERVICE') not null, \`our_value\` varchar(100) not null, \`van_value\` varchar(100) not null, \`verified\` tinyint(1) not null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`van_reconciliation_item\` add index \`van_reconciliation_item_run_id_index\` (\`run_id\`);`);

    this.addSql(`alter table \`van_reconciliation_item\` add constraint \`van_reconciliation_item_run_id_foreign\` foreign key (\`run_id\`) references \`van_reconciliation_run\` (\`id\`);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`van_reconciliation_item\`;`);
  }

}
