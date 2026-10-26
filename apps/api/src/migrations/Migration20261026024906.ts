import { Migration } from '@mikro-orm/migrations';

export class Migration20261026024906 extends Migration {

  override name = 'Migration20261026024906';

  override up(): void | Promise<void> {
    this.addSql(`alter table \`carrier_event\` drop index \`carrier_event_shipment_id_index\`;`);

    this.addSql(`alter table \`service_ticket\` drop index \`service_ticket_terminal_id_index\`;`);

    this.addSql(`alter table \`inspection_item\` drop index \`inspection_item_model_id_index\`;`);

    this.addSql(`alter table \`firmware\` drop index \`firmware_model_id_index\`;`);

    this.addSql(`alter table \`firmware_rollout_target\` drop index \`firmware_rollout_target_rollout_id_index\`;`);

    this.addSql(`alter table \`terminal_status_history\` drop index \`terminal_status_history_terminal_id_index\`;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table \`carrier_event\` add index \`carrier_event_shipment_id_index\` (\`shipment_id\`);`);

    this.addSql(`alter table \`firmware\` add index \`firmware_model_id_index\` (\`model_id\`);`);

    this.addSql(`alter table \`firmware_rollout_target\` add index \`firmware_rollout_target_rollout_id_index\` (\`rollout_id\`);`);

    this.addSql(`alter table \`inspection_item\` add index \`inspection_item_model_id_index\` (\`model_id\`);`);

    this.addSql(`alter table \`service_ticket\` add index \`service_ticket_terminal_id_index\` (\`terminal_id\`);`);

    this.addSql(`alter table \`terminal_status_history\` add index \`terminal_status_history_terminal_id_index\` (\`terminal_id\`);`);
  }

}
