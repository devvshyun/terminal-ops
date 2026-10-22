import { Migration } from '@mikro-orm/migrations';

export class Migration20261022041908 extends Migration {

  override name = 'Migration20261022041908';

  override up(): void | Promise<void> {
    this.addSql(`create table \`inspection\` (\`id\` int unsigned not null auto_increment primary key, \`terminal_id\` int unsigned not null, \`passed\` tinyint(1) not null, \`actor\` varchar(50) not null, \`inspected_at\` datetime not null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`inspection\` add index \`inspection_terminal_id_index\` (\`terminal_id\`);`);

    this.addSql(`create table \`inspection_result\` (\`id\` int unsigned not null auto_increment primary key, \`inspection_id\` int unsigned not null, \`item_code\` varchar(30) not null, \`passed\` tinyint(1) not null, \`note\` varchar(200) null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`inspection_result\` add index \`inspection_result_inspection_id_index\` (\`inspection_id\`);`);

    this.addSql(`create table \`inspection_item\` (\`id\` int unsigned not null auto_increment primary key, \`model_id\` int unsigned not null, \`code\` varchar(30) not null, \`label\` varchar(50) not null, \`sort_order\` int not null default 0) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`inspection_item\` add index \`inspection_item_model_id_index\` (\`model_id\`);`);
    this.addSql(`alter table \`inspection_item\` add unique \`inspection_item_model_id_code_unique\` (\`model_id\`, \`code\`);`);

    this.addSql(`alter table \`inspection\` add constraint \`inspection_terminal_id_foreign\` foreign key (\`terminal_id\`) references \`terminal\` (\`id\`);`);

    this.addSql(`alter table \`inspection_result\` add constraint \`inspection_result_inspection_id_foreign\` foreign key (\`inspection_id\`) references \`inspection\` (\`id\`);`);

    this.addSql(`alter table \`inspection_item\` add constraint \`inspection_item_model_id_foreign\` foreign key (\`model_id\`) references \`terminal_model\` (\`id\`);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table \`inspection_result\` drop foreign key \`inspection_result_inspection_id_foreign\`;`);

    this.addSql(`drop table if exists \`inspection\`;`);
    this.addSql(`drop table if exists \`inspection_result\`;`);
    this.addSql(`drop table if exists \`inspection_item\`;`);
  }

}
