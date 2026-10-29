import { Migration } from '@mikro-orm/migrations';

export class Migration20261029062554 extends Migration {

  override name = 'Migration20261029062554';

  override up(): void | Promise<void> {
    this.addSql(`create table \`partner_api_call\` (\`id\` int unsigned not null auto_increment primary key, \`partner_id\` int unsigned not null, \`key_id\` int unsigned not null, \`method\` varchar(10) not null, \`path\` varchar(200) not null, \`status\` smallint unsigned not null, \`duration_ms\` int unsigned not null, \`created_at\` datetime(3) not null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`partner_api_call\` add index \`partner_api_call_key_id_id_index\` (\`key_id\`, \`id\`);`);
    this.addSql(`alter table \`partner_api_call\` add index \`partner_api_call_partner_id_id_index\` (\`partner_id\`, \`id\`);`);

    this.addSql(`alter table \`partner_api_call\` add constraint \`partner_api_call_partner_id_foreign\` foreign key (\`partner_id\`) references \`partner\` (\`id\`);`);
    this.addSql(`alter table \`partner_api_call\` add constraint \`partner_api_call_key_id_foreign\` foreign key (\`key_id\`) references \`partner_api_key\` (\`id\`);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`partner_api_call\`;`);
  }

}
