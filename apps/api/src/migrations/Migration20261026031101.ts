import { Migration } from '@mikro-orm/migrations';

export class Migration20261026031101 extends Migration {

  override name = 'Migration20261026031101';

  override up(): void | Promise<void> {
    // 생성된 문장은 `add heartbeat_at datetime(3) not null` 한 줄이었다. 행이 있으면 strict 모드에서 '0000-00-00'으로 실패하므로(ERROR 1292)
    // ① null 허용으로 추가 ② 백필: 끝난 실행은 끝난 시각, 진행 중이면 시작 시각 ③ not null로 바꾼다(decisions/0033).
    this.addSql(`alter table \`van_reconciliation_run\` add \`heartbeat_at\` datetime(3) null after \`started_at\`;`);
    this.addSql(`update \`van_reconciliation_run\` set \`heartbeat_at\` = coalesce(\`finished_at\`, \`started_at\`);`);
    this.addSql(`alter table \`van_reconciliation_run\` modify \`heartbeat_at\` datetime(3) not null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table \`van_reconciliation_run\` drop column \`heartbeat_at\`;`);
  }

}
