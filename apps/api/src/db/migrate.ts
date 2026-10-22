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
  } else if (command === 'check') {
    const needed = await orm.migrator.checkSchema();
    console.log(needed ? '엔티티와 마이그레이션이 다릅니다. db:migration:create가 필요합니다.' : '최신 상태');
    if (needed) process.exitCode = 1;
  } else {
    console.error('사용법: node dist/db/migrate.js <create|up|check>');
    process.exitCode = 1;
  }
} finally {
  await orm.close(true);
}
