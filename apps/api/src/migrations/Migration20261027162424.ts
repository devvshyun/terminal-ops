import { Migration } from '@mikro-orm/migrations';

export class Migration20261027162424 extends Migration {

  override name = 'Migration20261027162424';

  override up(): void | Promise<void> {
    this.addSql(`create table \`user_account\` (\`id\` int unsigned not null auto_increment primary key, \`login_id\` varchar(50) not null, \`display_name\` varchar(50) not null, \`password_hash\` varchar(200) not null, \`role\` enum('ADMIN','OPERATOR','MONITOR','FIELD','MERCHANT') not null, \`merchant_id\` int unsigned null, \`disabled_at\` datetime null, \`last_login_at\` datetime null, \`created_at\` datetime not null, \`updated_at\` datetime not null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`user_account\` add unique \`user_account_login_id_unique\` (\`login_id\`);`);
    this.addSql(`alter table \`user_account\` add index \`user_account_merchant_id_index\` (\`merchant_id\`);`);

    this.addSql(`alter table \`user_account\` add constraint \`user_account_merchant_id_foreign\` foreign key (\`merchant_id\`) references \`merchant\` (\`id\`) on delete set null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`user_account\`;`);
  }

}
