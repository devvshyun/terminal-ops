import { Migration } from '@mikro-orm/migrations';

export class Migration20261028004119 extends Migration {

  override name = 'Migration20261028004119';

  override up(): void | Promise<void> {
    this.addSql(`create table \`partner_api_key\` (\`id\` int unsigned not null auto_increment primary key, \`name\` varchar(50) not null, \`prefix\` varchar(16) not null, \`key_hash\` varchar(64) not null, \`scopes\` json not null, \`expires_at\` datetime null, \`revoked_at\` datetime null, \`last_used_at\` datetime null, \`created_by\` varchar(50) not null, \`created_at\` datetime not null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`partner_api_key\` add unique \`partner_api_key_prefix_unique\` (\`prefix\`);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`partner_api_key\`;`);
  }

}
