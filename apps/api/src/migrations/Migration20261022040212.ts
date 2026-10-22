import { Migration } from '@mikro-orm/migrations';

export class Migration20261022040212 extends Migration {

  override name = 'Migration20261022040212';

  override up(): void | Promise<void> {
    this.addSql(`create table \`terminal\` (\`id\` int unsigned not null auto_increment primary key, \`serial_no\` varchar(32) not null, \`model_id\` int unsigned not null, \`status\` enum('RECEIVED','INSPECTED','DEFECTIVE','IN_STOCK','ALLOCATED','SHIPPED','DELIVERED','IN_SERVICE','RETURN_REQUESTED','RETURNING','RETURNED','DISPOSED') not null default 'RECEIVED', \`version\` int not null default 1, \`created_at\` datetime not null, \`updated_at\` datetime not null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`terminal\` add unique \`terminal_serial_no_unique\` (\`serial_no\`);`);
    this.addSql(`alter table \`terminal\` add index \`terminal_model_id_index\` (\`model_id\`);`);
    this.addSql(`alter table \`terminal\` add index \`terminal_status_index\` (\`status\`);`);

    this.addSql(`create table \`terminal_status_history\` (\`id\` int unsigned not null auto_increment primary key, \`terminal_id\` int unsigned not null, \`from_status\` enum('RECEIVED','INSPECTED','DEFECTIVE','IN_STOCK','ALLOCATED','SHIPPED','DELIVERED','IN_SERVICE','RETURN_REQUESTED','RETURNING','RETURNED','DISPOSED') null, \`to_status\` enum('RECEIVED','INSPECTED','DEFECTIVE','IN_STOCK','ALLOCATED','SHIPPED','DELIVERED','IN_SERVICE','RETURN_REQUESTED','RETURNING','RETURNED','DISPOSED') not null, \`source\` enum('MANUAL','INSPECTION') not null, \`actor\` varchar(50) not null, \`reason\` varchar(200) not null, \`occurred_at\` datetime not null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`terminal_status_history\` add index \`terminal_status_history_terminal_id_index\` (\`terminal_id\`);`);
    this.addSql(`alter table \`terminal_status_history\` add index \`terminal_status_history_terminal_id_occurred_at_index\` (\`terminal_id\`, \`occurred_at\`);`);

    this.addSql(`alter table \`terminal\` add constraint \`terminal_model_id_foreign\` foreign key (\`model_id\`) references \`terminal_model\` (\`id\`);`);

    this.addSql(`alter table \`terminal_status_history\` add constraint \`terminal_status_history_terminal_id_foreign\` foreign key (\`terminal_id\`) references \`terminal\` (\`id\`);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table \`terminal_status_history\` drop foreign key \`terminal_status_history_terminal_id_foreign\`;`);

    this.addSql(`drop table if exists \`terminal\`;`);
    this.addSql(`drop table if exists \`terminal_status_history\`;`);
  }

}
