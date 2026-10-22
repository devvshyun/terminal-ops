import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Redis } from 'ioredis';
import { TEST_PARTNERS_URL } from './partners-url.js';

// vitest는 apps/api에서 실행한다. 가상 업체 서버(apps/partners)를 빌드해 자식 프로세스로 띄우고, 끝나면 끈다.
const partnersDir = resolve(process.cwd(), '../partners');
const PARTNERS_URL = new URL(TEST_PARTNERS_URL);

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(new URL('/__admin/health', PARTNERS_URL), { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 테스트가 만든 BullMQ 키(접두사 test-)를 지운다. 테스트 파일마다 접두사가 달라 파일 안에서 지우지 못한 키(큐 meta 등)가 쌓이기 때문이다.
 * 개발 서버는 접두사 terminal-ops를 쓰므로 건드리지 않는다.
 */
async function deleteTestQueueKeys(): Promise<number> {
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  try {
    await redis.connect();
  } catch (error) {
    throw new Error(`Redis에 연결할 수 없습니다. docker compose up -d redis 를 확인하세요. (${String(error)})`);
  }
  let deleted = 0;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'test-*', 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) deleted += await redis.unlink(...keys);
  } while (cursor !== '0');
  await redis.quit();
  return deleted;
}

export default async function setup() {
  // 포트 확인을 키 정리보다 먼저 한다. 다른 테스트 실행이 돌고 있으면 그 실행의 test-* 키를 지우기 전에 멈춘다.
  if (await isUp()) {
    throw new Error(`${PARTNERS_URL.origin}에 이미 서버가 떠 있습니다. 테스트용 partners 포트를 비우고 다시 실행하세요.`);
  }

  await deleteTestQueueKeys();

  // tsc는 partners 쪽 node_modules에서 찾는다(Windows에서 npm.cmd를 거치지 않으려고 node로 직접 실행).
  const tsc = createRequire(resolve(partnersDir, 'package.json')).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', resolve(partnersDir, 'tsconfig.build.json')], { stdio: 'inherit' });

  const child = spawn(process.execPath, [resolve(partnersDir, 'dist/main.js')], {
    env: { ...process.env, PARTNERS_PORT: PARTNERS_URL.port },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const deadline = Date.now() + 10_000;
  while (!(await isUp())) {
    if (child.exitCode !== null) throw new Error(`partners가 시작하자마자 종료됐습니다(exit ${child.exitCode}).`);
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('partners가 10초 안에 뜨지 않았습니다.');
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  return async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    await deleteTestQueueKeys();
  };
}
