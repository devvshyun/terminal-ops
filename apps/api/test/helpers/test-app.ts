import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/mysql';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { seedReference } from '../../src/db/seed-reference.js';

export interface TestApp {
  app: INestApplication;
  orm: MikroORM;
  http: () => ReturnType<typeof request>;
}

/**
 * @param options.workers true면 큐 프로세서까지 띄운다(수집·알림 테스트). 주기 작업(스케줄러)은 테스트에서 항상 끈다 —
 *   테스트가 sweep()·relay()를 직접 부른다.
 */
export async function createTestApp(options: { workers?: boolean } = {}): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ workers: options.workers ?? false, schedulers: false })],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  const orm: MikroORM = app.get(MikroORM);
  return { app, orm, http: () => request(app.getHttpServer()) };
}

/** 테스트 DB 스키마를 엔티티 기준으로 다시 만들고 기준 데이터를 넣는다. */
export async function resetDatabase(orm: MikroORM): Promise<void> {
  // 개발 DB를 실수로 지우지 않도록 테스트 DB에서만 실행한다.
  const dbName = orm.config.get('dbName');
  if (!process.env.MYSQL_TEST_DATABASE || dbName !== process.env.MYSQL_TEST_DATABASE) {
    throw new Error(`resetDatabase는 테스트 DB에서만 실행합니다(현재: ${dbName}).`);
  }
  await orm.schema.refresh();
  await seedReference(orm.em.fork());
}
