import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/mysql';
import config from '../mikro-orm.config.js';
import { seedDemoAccounts, seedDemoPartnerKey } from './seed-accounts.js';
import { seedReference } from './seed-reference.js';

const orm = await MikroORM.init(config);
try {
  await seedReference(orm.em.fork());
  console.log('기준 데이터 시드 완료');
  const accounts = await seedDemoAccounts(orm.em.fork());
  console.log(`시연 계정 시드 완료(새로 ${accounts}개, 비밀번호는 src/db/seed-accounts.ts — 로컬 시연 전용 값)`);
  const key = await seedDemoPartnerKey(orm.em.fork());
  console.log(`시연 외부 업체 키 ${key ? '넣음' : '이미 있음'}(원문은 src/db/seed-accounts.ts DEMO_PARTNER_KEY — 로컬 시연 전용 값)`);
} finally {
  await orm.close(true);
}
