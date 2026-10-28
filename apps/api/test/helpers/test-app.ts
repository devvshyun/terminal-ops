import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/mysql';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { env } from '../../src/config/env.js';
import { seedReference } from '../../src/db/seed-reference.js';

/**
 * 테스트 전용 인증 헤더(decisions/0056, vitest.config.ts의 AUTH_TEST_HEADERS=1). `X-Operator`가 로그인 아이디, `X-Test-Role`이 역할(없으면 OPERATOR).
 * 기존 테스트가 `.set({ 'X-Operator': 'kim' })`으로 덮어쓰면 그 이름의 운영자가 된다. MERCHANT는 이 길로 만들 수 없다(실제 로그인 — test/helpers/auth.ts).
 */
export type TestIdentity = { 'X-Operator': string; 'X-Test-Role'?: string };

/** 기본 사람: tester(OPERATOR) — 지금까지 모든 테스트가 쓰던 권한(어드민의 모든 쓰기) */
export const DEFAULT_IDENTITY: TestIdentity = { 'X-Operator': 'tester' };

export interface TestApp {
  app: INestApplication;
  orm: MikroORM;
  /**
   * supertest 에이전트. 기본으로 DEFAULT_IDENTITY 헤더와 단말기 키(X-Device-Key)를 붙인다. `http(null)`은 아무 헤더도 붙이지 않는다(로그인 안 한 요청, 쿠키 로그인).
   * 에이전트는 부를 때마다 새로 만든다 — 쿠키가 다음 요청으로 새지 않는다.
   */
  http: (identity?: TestIdentity | null) => ReturnType<typeof request>;
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
  const http = (identity: TestIdentity | null = DEFAULT_IDENTITY) => {
    const agent = request.agent(app.getHttpServer());
    // 사람 헤더와 함께 단말기 키도 붙인다(단말기 API를 부르는 기존 테스트가 그대로 돌게, decisions/0055). 사람 API는 이 헤더를 보지 않는다
    if (identity) agent.set({ ...identity, 'X-Device-Key': env.deviceApiKey });
    return agent;
  };
  return { app, orm, http };
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
