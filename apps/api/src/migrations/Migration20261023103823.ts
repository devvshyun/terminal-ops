import { Migration } from '@mikro-orm/migrations';

export class Migration20261023103823 extends Migration {

  override name = 'Migration20261023103823';

  override up(): void | Promise<void> {
    this.addSql(`create table \`device_connectivity\` (\`terminal_id\` int unsigned not null, \`online\` tinyint(1) not null, \`last_seen_at\` datetime(3) not null, \`firmware_version\` varchar(20) null, \`changed_at\` datetime(3) not null, primary key (\`terminal_id\`)) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`device_connectivity\`;`);
  }

}
