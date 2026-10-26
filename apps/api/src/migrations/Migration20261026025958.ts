import { Migration } from '@mikro-orm/migrations';

export class Migration20261026025958 extends Migration {

  override name = 'Migration20261026025958';

  override up(): void | Promise<void> {
    this.addSql(`create table \`van_reconciliation_run\` (\`id\` int unsigned not null auto_increment primary key, \`status\` enum('RUNNING','COMPLETED','FAILED') not null default 'RUNNING', \`running_key\` tinyint generated always as (case when \`status\` = 'RUNNING' then 1 end) virtual null, \`trigger\` enum('MANUAL','SCHEDULED') not null, \`requested_by\` varchar(50) not null, \`started_at\` datetime(3) not null, \`finished_at\` datetime(3) null, \`pages\` int not null default 0, \`fetched\` int not null default 0, \`retries\` int not null default 0, \`candidates\` int not null default 0, \`confirmed\` int not null default 0, \`resolved\` int not null default 0, \`counts\` json null, \`phase_ms\` json null, \`error\` varchar(500) null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`van_reconciliation_run\` add unique \`van_reconciliation_run_running_unique\` (\`running_key\`);`);

    this.addSql(`create table \`van_registration_snapshot\` (\`run_id\` int unsigned not null, \`serial_no\` varchar(32) not null, \`tid\` varchar(32) not null, \`merchant_code\` varchar(40) not null, \`status\` enum('ACTIVE','SUSPENDED','CANCELLED') not null, \`van_updated_at\` datetime(3) not null, primary key (\`run_id\`, \`serial_no\`)) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`van_reconciliation_run\`;`);
    this.addSql(`drop table if exists \`van_registration_snapshot\`;`);
  }

}
