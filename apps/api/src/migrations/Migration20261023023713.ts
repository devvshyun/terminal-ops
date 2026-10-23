import { Migration } from '@mikro-orm/migrations';

export class Migration20261023023713 extends Migration {

  override name = 'Migration20261023023713';

  override up(): void | Promise<void> {
    this.addSql(`create table \`scan_batch\` (\`id\` int unsigned not null auto_increment primary key, \`scan_id\` varchar(64) not null, \`kind\` enum('RECEIVE','RETURN_IN') not null, \`po_no\` varchar(30) null, \`request_hash\` varchar(64) not null, \`actor\` varchar(50) not null, \`results\` json not null, \`created_at\` datetime not null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`scan_batch\` add unique \`scan_batch_scan_id_unique\` (\`scan_id\`);`);
    this.addSql(`alter table \`scan_batch\` add index \`scan_batch_po_no_index\` (\`po_no\`);`);

    this.addSql(`alter table \`terminal\` add \`purchase_order_id\` int unsigned null;`);
    this.addSql(`alter table \`terminal\` add constraint \`terminal_purchase_order_id_foreign\` foreign key (\`purchase_order_id\`) references \`purchase_order\` (\`id\`) on delete set null;`);
    this.addSql(`alter table \`terminal\` add index \`terminal_purchase_order_id_index\` (\`purchase_order_id\`);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`scan_batch\`;`);

    this.addSql(`alter table \`terminal\` drop foreign key \`terminal_purchase_order_id_foreign\`;`);

    this.addSql(`alter table \`terminal\` drop index \`terminal_purchase_order_id_index\`;`);
    this.addSql(`alter table \`terminal\` drop column \`purchase_order_id\`;`);
  }

}
