import { Migration } from '@mikro-orm/migrations';

export class Migration20261023021402 extends Migration {

  override name = 'Migration20261023021402';

  override up(): void | Promise<void> {
    this.addSql(`create table \`purchase_order\` (\`id\` int unsigned not null auto_increment primary key, \`po_no\` varchar(30) not null, \`model_id\` int unsigned not null, \`quantity\` int not null, \`status\` enum('ORDERED','RECEIVING','CLOSED') not null default 'ORDERED', \`delivery_note\` json null, \`ordered_by\` varchar(50) not null, \`created_at\` datetime not null, \`closed_at\` datetime null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`purchase_order\` add unique \`purchase_order_po_no_unique\` (\`po_no\`);`);
    this.addSql(`alter table \`purchase_order\` add index \`purchase_order_model_id_index\` (\`model_id\`);`);

    this.addSql(`alter table \`purchase_order\` add constraint \`purchase_order_model_id_foreign\` foreign key (\`model_id\`) references \`terminal_model\` (\`id\`);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`purchase_order\`;`);
  }

}
