import { Migration } from '@mikro-orm/migrations';

export class Migration20261022061018 extends Migration {

  override name = 'Migration20261022061018';

  override up(): void | Promise<void> {
    this.addSql(`create table \`outbox_event\` (\`id\` int unsigned not null auto_increment primary key, \`type\` varchar(50) not null, \`payload\` json not null, \`status\` enum('PENDING','QUEUED','SENT','FAILED') not null default 'PENDING', \`attempts\` int not null default 0, \`last_error\` varchar(500) null, \`created_at\` datetime not null, \`sent_at\` datetime null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`outbox_event\` add index \`outbox_event_status_id_index\` (\`status\`, \`id\`);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`outbox_event\`;`);
  }

}
