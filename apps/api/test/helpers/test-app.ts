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

export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  const orm: MikroORM = app.get(MikroORM);
  return { app, orm, http: () => request(app.getHttpServer()) };
}

/** 테스트 DB 스키마를 엔티티 기준으로 다시 만들고 기준 데이터를 넣는다. */
export async function resetDatabase(orm: MikroORM): Promise<void> {
  await orm.schema.refresh();
  await seedReference(orm.em.fork());
}
