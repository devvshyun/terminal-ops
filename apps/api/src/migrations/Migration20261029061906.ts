import { Migration } from '@mikro-orm/migrations';

export class Migration20261029061906 extends Migration {

  override name = 'Migration20261029061906';

  override up(): void | Promise<void> {
    this.addSql(`create table \`partner\` (\`id\` int unsigned not null auto_increment primary key, \`code\` varchar(20) not null, \`name\` varchar(50) not null, \`memo\` varchar(200) null, \`created_by\` varchar(50) not null, \`created_at\` datetime not null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`partner\` add unique \`partner_code_unique\` (\`code\`);`);

    // 보강 7(decisions/0081): 키는 업체 하나에 속한다. 이미 있는 키는 키 이름(그때까지 업체 이름을 적던 칸)마다 업체를 하나 만들어 잇는다 —
    // 열을 null 허용으로 넣고, 채우고, not null로 바꾼다. 코드는 처음 발급 순서로 P-1, P-2 …(키 이름은 그대로 두어 이름표가 된다)
    this.addSql(`alter table \`partner_api_key\` add \`partner_id\` int unsigned null;`);
    this.addSql(`insert into \`partner\` (\`code\`, \`name\`, \`created_by\`, \`created_at\`) select concat('P-', row_number() over (order by min(\`id\`))), \`name\`, 'system:migration', now() from \`partner_api_key\` group by \`name\`;`);
    this.addSql(`update \`partner_api_key\` k join \`partner\` p on p.\`name\` = k.\`name\` and p.\`created_by\` = 'system:migration' set k.\`partner_id\` = p.\`id\`;`);
    this.addSql(`alter table \`partner_api_key\` modify \`partner_id\` int unsigned not null;`);
    this.addSql(`alter table \`partner_api_key\` add constraint \`partner_api_key_partner_id_foreign\` foreign key (\`partner_id\`) references \`partner\` (\`id\`);`);
    this.addSql(`alter table \`partner_api_key\` add index \`partner_api_key_partner_id_index\` (\`partner_id\`);`);
  }

  override down(): void | Promise<void> {
    // 업체 표와 키의 업체 연결을 지운다. 키 이름(보강 7 전에는 업체 이름)은 남는다
    this.addSql(`alter table \`partner_api_key\` drop foreign key \`partner_api_key_partner_id_foreign\`;`);
    this.addSql(`alter table \`partner_api_key\` drop index \`partner_api_key_partner_id_index\`;`);
    this.addSql(`alter table \`partner_api_key\` drop column \`partner_id\`;`);

    this.addSql(`drop table if exists \`partner\`;`);
  }

}
