import { Migration } from '@mikro-orm/migrations';
import { assertEnumNarrowable } from '../db/migration-guards.js';

export class Migration20261022053251 extends Migration {

  override name = 'Migration20261022053251';

  override up(): void | Promise<void> {
    this.addSql(`alter table \`terminal_status_history\` modify \`source\` enum('MANUAL','INSPECTION','BATCH') not null;`);
  }

  // 주의: source가 BATCH인 이력이 있으면 strict 모드에서 이 down()은 실패한다(enum에 없는 값). 되돌리기 전에 그 행을 처리해야 한다(Day 2 리뷰 Minor 7).
  // 최종 리뷰 Minor 3(troubleshooting/0025): 그런 행이 있으면 ALTER를 보내기 전에 이유를 담아 던진다.
  override async down(): Promise<void> {
    await assertEnumNarrowable(this, this.name, [{ table: 'terminal_status_history', column: 'source', keep: ['MANUAL', 'INSPECTION'] }]);
    this.addSql(`alter table \`terminal_status_history\` modify \`source\` enum('MANUAL','INSPECTION') not null;`);
  }

}
