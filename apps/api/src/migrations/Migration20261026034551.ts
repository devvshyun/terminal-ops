import { Migration } from '@mikro-orm/migrations';

export class Migration20261026034551 extends Migration {

  override name = 'Migration20261026034551';

  override up(): void | Promise<void> {
    this.addSql(`create table \`anomaly\` (\`id\` int unsigned not null auto_increment primary key, \`terminal_id\` int unsigned not null, \`rule\` enum('DELIVERED_NOT_INSTALLED','RETURN_STALLED','SHIPPED_TOO_LONG','ALLOCATED_NO_SHIPMENT','IN_SERVICE_NO_MERCHANT','OFFLINE_TOO_LONG') not null, \`detected_at\` datetime(3) not null, \`last_seen_at\` datetime(3) not null, \`resolved_at\` datetime(3) null, \`detail\` json not null) default character set utf8mb4 collate utf8mb4_0900_ai_ci engine = InnoDB;`);
    this.addSql(`alter table \`anomaly\` add index \`anomaly_resolved_at_rule_index\` (\`resolved_at\`, \`rule\`);`);
    this.addSql(`alter table \`anomaly\` add unique \`anomaly_open_unique\` ((case when \`resolved_at\` is null then \`terminal_id\` end), (case when \`resolved_at\` is null then \`rule\` end));`);

    // 생성된 그대로(`add status_changed_at datetime(3) not null`)면 행이 있는 개발 DB에서
    // ERROR 1292 Incorrect datetime value: '0000-00-00 00:00:00'(strict 모드 NO_ZERO_DATE). 손으로 세 단계로 나눴다:
    // ① null 허용으로 추가 ② 백필: 지금 상태로 들어온 마지막 이력 시각, 이력이 없으면 updated_at ③ not null로 바꾼다(decisions/0034).
    this.addSql(`alter table \`terminal\` add \`status_changed_at\` datetime(3) null;`);
    this.addSql(`update \`terminal\` t set t.\`status_changed_at\` = coalesce((select max(h.\`occurred_at\`) from \`terminal_status_history\` h where h.\`terminal_id\` = t.\`id\` and h.\`to_status\` = t.\`status\`), t.\`updated_at\`);`);
    this.addSql(`alter table \`terminal\` modify \`status_changed_at\` datetime(3) not null;`);
    // 새 복합 인덱스를 먼저 만들고 status 단독 인덱스를 지운다(그 사이에도 status로 찾는 쿼리가 쓸 인덱스가 있게).
    // 생성된 순서는 drop이 먼저였다 — 그 사이에 실패하면 status 인덱스가 하나도 없는 채로 남는다.
    this.addSql(`alter table \`terminal\` add index \`terminal_status_status_changed_at_index\` (\`status\`, \`status_changed_at\`);`);
    this.addSql(`alter table \`terminal\` drop index \`terminal_status_index\`;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists \`anomaly\`;`);

    this.addSql(`alter table \`terminal\` drop index \`terminal_status_status_changed_at_index\`;`);
    this.addSql(`alter table \`terminal\` drop column \`status_changed_at\`;`);
    this.addSql(`alter table \`terminal\` add index \`terminal_status_index\` (\`status\`);`);
  }

}
