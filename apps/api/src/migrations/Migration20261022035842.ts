import { Migration } from '@mikro-orm/migrations';

export class Migration20261022035842 extends Migration {

  override name = 'Migration20261022035842';

  override up(): void | Promise<void> {
    this.addSql(`create table \`terminal_model\` (\`id\` int unsigned not null auto_increment primary key, \`code\` varchar(20) not null, \`name\` varchar(50) not null, \`requires_reinspection\` tinyint(1) not null default false) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`terminal_model\` add unique \`terminal_model_code_unique\` (\`code\`);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`terminal_model\`;`);
  }

}
