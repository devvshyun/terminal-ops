import { Migration } from '@mikro-orm/migrations';

export class Migration20261029040404 extends Migration {

  override name = 'Migration20261029040404';

  override up(): void | Promise<void> {
    this.addSql(`create table \`ops_action_log\` (\`id\` int unsigned not null auto_increment primary key, \`action\` varchar(20) not null, \`actor\` varchar(50) not null, \`actor_role\` varchar(20) not null, \`queue\` varchar(30) null, \`job_id\` varchar(200) null, \`job_name\` varchar(50) null, \`detail\` json null, \`created_at\` datetime(3) not null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`ops_action_log\`;`);
  }

}
