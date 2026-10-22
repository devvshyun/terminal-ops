import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// vitest는 apps/api에서 실행한다. 가상 업체 서버(apps/partners)를 빌드해 자식 프로세스로 띄우고, 끝나면 끈다.
const partnersDir = resolve(process.cwd(), '../partners');
const PARTNERS_URL = new URL(process.env.PARTNERS_URL ?? 'http://127.0.0.1:4011');

async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(new URL('/__admin/health', PARTNERS_URL), { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

export default async function setup() {
  if (await isUp()) {
    throw new Error(`${PARTNERS_URL.origin}에 이미 서버가 떠 있습니다. 테스트용 partners 포트를 비우고 다시 실행하세요.`);
  }

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
  };
}
