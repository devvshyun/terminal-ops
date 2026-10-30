// 시연 데이터 넣기(보강 9, decisions/0089). 시연 compose의 demo-seed 서비스가 api가 뜬 뒤 한 번 돌린다. 손으로: npm run build && node dist/db/seed-scenario.js
import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/mysql';
import { deviceKeys } from '../device/device-keys.js';
import config from '../mikro-orm.config.js';
import { createAppRedis } from '../redis/redis.provider.js';
import type { PastWriter } from './scenario-past.js';
import { demoSeedAllowed } from './seed-accounts.js';
import { runScenario, waitForApi } from './scenario.js';

const apiUrl = process.env.SCENARIO_API_URL ?? 'http://127.0.0.1:3000';
if (!demoSeedAllowed()) {
  // 시연 계정 비밀번호로 로그인하는 스크립트다 — 운영에서는 시연 계정이 없다(decisions/0054)
  console.log('시연 데이터는 넣지 않음(NODE_ENV=production 또는 SEED_DEMO=0)');
} else {
  await waitForApi(apiUrl);
  // 지난 일(decisions/0091)만 MySQL·Redis에 직접 쓴다 — 시연 단말기 두 대의 시각. 나머지는 모두 HTTP API
  const orm = await MikroORM.init(config);
  const redis = createAppRedis();
  const past: PastWriter = {
    execute: (sql, params) => orm.em.getConnection().execute(sql, params, 'run'),
    markOffline: async (serials) => {
      if (serials.length > 0) await redis.sadd(deviceKeys().offline, ...serials);
    },
  };
  try {
    const result = await runScenario({
      apiUrl,
      partnersUrl: process.env.PARTNERS_URL ?? 'http://127.0.0.1:4010',
      simUrl: process.env.SCENARIO_SIM_URL,
      simTargetUrl: process.env.SCENARIO_SIM_TARGET_URL,
      past,
    });
    if (!result.skipped) console.log(`시연 데이터 완료: ${JSON.stringify(result.summary)}`);
  } finally {
    await orm.close(true);
    redis.disconnect();
  }
}
