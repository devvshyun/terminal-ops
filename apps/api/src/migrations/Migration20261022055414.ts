import { Migration } from '@mikro-orm/migrations';

export class Migration20261022055414 extends Migration {

  override name = 'Migration20261022055414';

  override up(): void | Promise<void> {
    this.addSql(`create table \`shipment\` (\`id\` int unsigned not null auto_increment primary key, \`terminal_id\` int unsigned not null, \`carrier\` enum('BUNGAE','NEURIMBO') not null, \`tracking_no\` varchar(30) not null, \`status\` enum('IN_TRANSIT','DELIVERED') not null default 'IN_TRANSIT', \`last_synced_at\` datetime null, \`delivered_at\` datetime null, \`created_at\` datetime not null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`shipment\` add index \`shipment_terminal_id_index\` (\`terminal_id\`);`);
    this.addSql(`alter table \`shipment\` add unique \`shipment_tracking_no_unique\` (\`tracking_no\`);`);
    this.addSql(`alter table \`shipment\` add index \`shipment_status_index\` (\`status\`);`);

    this.addSql(`create table \`sync_run\` (\`id\` int unsigned not null auto_increment primary key, \`job\` varchar(50) not null, \`shipment_id\` int unsigned null, \`attempt\` int not null, \`worker\` varchar(50) not null, \`outcome\` varchar(20) not null, \`started_at\` datetime not null, \`finished_at\` datetime null, \`fetched\` int not null default 0, \`inserted\` int not null default 0, \`duplicated\` int not null default 0, \`detail\` varchar(500) null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`sync_run\` add index \`sync_run_shipment_id_index\` (\`shipment_id\`);`);

    this.addSql(`create table \`carrier_event\` (\`id\` int unsigned not null auto_increment primary key, \`shipment_id\` int unsigned not null, \`event_key\` varchar(50) not null, \`code\` enum('PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED') not null, \`occurred_at\` datetime not null, \`raw\` json not null, \`received_at\` datetime not null) default character set utf8mb4 engine = InnoDB;`);
    this.addSql(`alter table \`carrier_event\` add index \`carrier_event_shipment_id_index\` (\`shipment_id\`);`);
    this.addSql(`alter table \`carrier_event\` add unique \`carrier_event_shipment_id_event_key_unique\` (\`shipment_id\`, \`event_key\`);`);

    this.addSql(`alter table \`shipment\` add constraint \`shipment_terminal_id_foreign\` foreign key (\`terminal_id\`) references \`terminal\` (\`id\`);`);

    this.addSql(`alter table \`sync_run\` add constraint \`sync_run_shipment_id_foreign\` foreign key (\`shipment_id\`) references \`shipment\` (\`id\`) on delete set null;`);

    this.addSql(`alter table \`carrier_event\` add constraint \`carrier_event_shipment_id_foreign\` foreign key (\`shipment_id\`) references \`shipment\` (\`id\`);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table \`sync_run\` drop foreign key \`sync_run_shipment_id_foreign\`;`);
    this.addSql(`alter table \`carrier_event\` drop foreign key \`carrier_event_shipment_id_foreign\`;`);

    this.addSql(`drop table if exists \`shipment\`;`);
    this.addSql(`drop table if exists \`sync_run\`;`);
    this.addSql(`drop table if exists \`carrier_event\`;`);
  }

}
