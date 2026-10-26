import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/mysql';
import config from '../mikro-orm.config.js';

const command = process.argv[2];
const orm = await MikroORM.init(config);
try {
  if (command === 'create') {
    const result = await orm.migrator.create();
    console.log(result.fileName ? `생성: ${result.fileName}` : '변경 없음: 마이그레이션을 만들지 않았습니다.');
  } else if (command === 'up') {
    const done = await orm.migrator.up();
    console.log(`적용: ${done.map((m) => m.name).join(', ') || '없음'}`);
  } else if (command === 'down') {
    // 되돌리기는 테스트 DB에서만(최종 리뷰 Minor 3의 down 체인 확인용). 개발·운영 DB를 실수로 비우지 않게 막는다.
    // 사용: MYSQL_DATABASE=<테스트 DB> node dist/db/migrate.js down <0|마이그레이션 이름>  (0 = 전부, 이름 = 그 마이그레이션까지 남김)
    const dbName = orm.config.get('dbName');
    const target = process.argv[3];
    if (!process.env.MYSQL_TEST_DATABASE || dbName !== process.env.MYSQL_TEST_DATABASE) {
      console.error(`down은 테스트 DB(MYSQL_TEST_DATABASE)에서만 실행합니다(현재: ${dbName}).`);
      process.exitCode = 1;
    } else if (!target) {
      console.error('사용법: node dist/db/migrate.js down <0|마이그레이션 이름>');
      process.exitCode = 1;
    } else {
      const done = await orm.migrator.down({ to: target === '0' ? 0 : target });
      console.log(`되돌림: ${done.map((m) => m.name).join(', ') || '없음'}`);
    }
  } else if (command === 'check') {
    const needed = await orm.migrator.checkSchema();
    console.log(needed ? '엔티티와 마이그레이션이 다릅니다. db:migration:create가 필요합니다.' : '최신 상태');
    if (needed) process.exitCode = 1;
  } else {
    console.error('사용법: node dist/db/migrate.js <create|up|down|check>');
    process.exitCode = 1;
  }
} finally {
  await orm.close(true);
}
