import { Migration } from '@mikro-orm/migrations';

export class Migration20261023032255 extends Migration {

  override name = 'Migration20261023032255';

  override up(): void | Promise<void> {
    this.addSql(`create table \`service_ticket\` (\`id\` int unsigned not null auto_increment primary key, \`terminal_id\` int unsigned not null, \`merchant_id\` int unsigned not null, \`symptom\` varchar(200) not null, \`status\` enum('OPEN','RESOLVED_REMOTELY','REPLACING','CLOSED') not null default 'OPEN', \`remote_note\` varchar(500) null, \`replacement_terminal_id\` int unsigned null, \`outbound_shipment_id\` int unsigned null, \`opened_by\` varchar(50) not null, \`created_at\` datetime not null, \`closed_at\` datetime null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`service_ticket\` add index \`service_ticket_terminal_id_index\` (\`terminal_id\`);`);
    this.addSql(`alter table \`service_ticket\` add index \`service_ticket_merchant_id_index\` (\`merchant_id\`);`);
    this.addSql(`alter table \`service_ticket\` add index \`service_ticket_replacement_terminal_id_index\` (\`replacement_terminal_id\`);`);
    this.addSql(`alter table \`service_ticket\` add index \`service_ticket_outbound_shipment_id_index\` (\`outbound_shipment_id\`);`);
    this.addSql(`alter table \`service_ticket\` add index \`service_ticket_terminal_id_status_index\` (\`terminal_id\`, \`status\`);`);

    this.addSql(`alter table \`service_ticket\` add constraint \`service_ticket_terminal_id_foreign\` foreign key (\`terminal_id\`) references \`terminal\` (\`id\`);`);
    this.addSql(`alter table \`service_ticket\` add constraint \`service_ticket_merchant_id_foreign\` foreign key (\`merchant_id\`) references \`merchant\` (\`id\`);`);
    this.addSql(`alter table \`service_ticket\` add constraint \`service_ticket_replacement_terminal_id_foreign\` foreign key (\`replacement_terminal_id\`) references \`terminal\` (\`id\`) on delete set null;`);
    this.addSql(`alter table \`service_ticket\` add constraint \`service_ticket_outbound_shipment_id_foreign\` foreign key (\`outbound_shipment_id\`) references \`shipment\` (\`id\`) on delete set null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`service_ticket\`;`);
  }

}
