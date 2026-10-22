import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/mysql';
import config from '../mikro-orm.config.js';
import { seedReference } from './seed-reference.js';

const orm = await MikroORM.init(config);
try {
  await seedReference(orm.em.fork());
  console.log('기준 데이터 시드 완료');
} finally {
  await orm.close(true);
}
