import { Migration } from '@mikro-orm/migrations';

export class Migration20261026050214 extends Migration {

  override name = 'Migration20261026050214';

  override up(): void | Promise<void> {
    this.addSql(`create table \`weekly_report\` (\`id\` int unsigned not null auto_increment primary key, \`week_start\` date not null, \`status\` enum('PENDING','GENERATED','SENT') not null default 'PENDING', \`file_name\` varchar(100) null, \`file\` mediumblob null, \`file_size\` int null, \`generated_at\` datetime(3) null, \`sent_at\` datetime(3) null, \`toktok_file_id\` varchar(64) null, \`attempts\` int not null default 0, \`last_error\` varchar(500) null, \`created_at\` datetime(3) not null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`weekly_report\` add unique \`weekly_report_week_start_unique\` (\`week_start\`);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`weekly_report\`;`);
  }

}
