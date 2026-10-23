import { Migration } from '@mikro-orm/migrations';

export class Migration20261023105647 extends Migration {

  override name = 'Migration20261023105647';

  override up(): void | Promise<void> {
    this.addSql(`create table \`firmware\` (\`id\` int unsigned not null auto_increment primary key, \`model_id\` int unsigned not null, \`version\` varchar(20) not null, \`created_by\` varchar(50) not null, \`created_at\` datetime not null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`firmware\` add index \`firmware_model_id_index\` (\`model_id\`);`);
    this.addSql(`alter table \`firmware\` add unique \`firmware_model_id_version_unique\` (\`model_id\`, \`version\`);`);

    this.addSql(`create table \`firmware_rollout\` (\`id\` int unsigned not null auto_increment primary key, \`firmware_id\` int unsigned not null, \`stages\` json not null, \`current_stage\` int not null default 0, \`status\` enum('RUNNING','PAUSED','COMPLETED','ABORTED') not null default 'RUNNING', \`failure_threshold\` double not null, \`min_samples\` int not null, \`stage_timeout_ms\` int not null, \`stage_started_at\` datetime(3) not null, \`created_by\` varchar(50) not null, \`created_at\` datetime not null, \`finished_at\` datetime null, \`end_reason\` varchar(200) null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`firmware_rollout\` add index \`firmware_rollout_firmware_id_index\` (\`firmware_id\`);`);
    this.addSql(`alter table \`firmware_rollout\` add index \`firmware_rollout_status_index\` (\`status\`);`);

    this.addSql(`create table \`firmware_rollout_target\` (\`id\` int unsigned not null auto_increment primary key, \`rollout_id\` int unsigned not null, \`terminal_id\` int unsigned not null, \`stage\` int not null, \`status\` enum('OFFERED','SUCCEEDED','FAILED','TIMED_OUT') not null default 'OFFERED', \`offered_at\` datetime(3) not null, \`reported_at\` datetime(3) null, \`reported_version\` varchar(20) null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`firmware_rollout_target\` add index \`firmware_rollout_target_rollout_id_index\` (\`rollout_id\`);`);
    this.addSql(`alter table \`firmware_rollout_target\` add index \`firmware_rollout_target_terminal_id_index\` (\`terminal_id\`);`);
    this.addSql(`alter table \`firmware_rollout_target\` add index \`firmware_rollout_target_rollout_id_stage_status_index\` (\`rollout_id\`, \`stage\`, \`status\`);`);
    this.addSql(`alter table \`firmware_rollout_target\` add unique \`firmware_rollout_target_rollout_id_terminal_id_unique\` (\`rollout_id\`, \`terminal_id\`);`);

    this.addSql(`alter table \`firmware\` add constraint \`firmware_model_id_foreign\` foreign key (\`model_id\`) references \`terminal_model\` (\`id\`);`);

    this.addSql(`alter table \`firmware_rollout\` add constraint \`firmware_rollout_firmware_id_foreign\` foreign key (\`firmware_id\`) references \`firmware\` (\`id\`);`);

    this.addSql(`alter table \`firmware_rollout_target\` add constraint \`firmware_rollout_target_rollout_id_foreign\` foreign key (\`rollout_id\`) references \`firmware_rollout\` (\`id\`);`);
    this.addSql(`alter table \`firmware_rollout_target\` add constraint \`firmware_rollout_target_terminal_id_foreign\` foreign key (\`terminal_id\`) references \`terminal\` (\`id\`);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table \`firmware_rollout\` drop foreign key \`firmware_rollout_firmware_id_foreign\`;`);
    this.addSql(`alter table \`firmware_rollout_target\` drop foreign key \`firmware_rollout_target_rollout_id_foreign\`;`);

    this.addSql(`drop table if exists \`firmware\`;`);
    this.addSql(`drop table if exists \`firmware_rollout\`;`);
    this.addSql(`drop table if exists \`firmware_rollout_target\`;`);
  }

}
