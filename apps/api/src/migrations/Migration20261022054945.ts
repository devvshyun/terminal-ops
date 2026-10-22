import { Migration } from '@mikro-orm/migrations';

export class Migration20261022054945 extends Migration {

  override name = 'Migration20261022054945';

  override up(): void | Promise<void> {
    this.addSql(`create table \`merchant\` (\`id\` int unsigned not null auto_increment primary key, \`code\` varchar(20) not null, \`name\` varchar(50) not null, \`address\` varchar(200) not null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`merchant\` add unique \`merchant_code_unique\` (\`code\`);`);

    this.addSql(`alter table \`terminal\` add \`merchant_id\` int unsigned null;`);
    this.addSql(`alter table \`terminal\` add constraint \`terminal_merchant_id_foreign\` foreign key (\`merchant_id\`) references \`merchant\` (\`id\`) on delete set null;`);
    this.addSql(`alter table \`terminal\` add index \`terminal_merchant_id_index\` (\`merchant_id\`);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table \`terminal\` drop foreign key \`terminal_merchant_id_foreign\`;`);

    this.addSql(`drop table if exists \`merchant\`;`);

    this.addSql(`alter table \`terminal\` drop index \`terminal_merchant_id_index\`;`);
    this.addSql(`alter table \`terminal\` drop column \`merchant_id\`;`);
  }

}
