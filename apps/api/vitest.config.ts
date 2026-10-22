import swc from 'unplugin-swc';
import { configDefaults, defineConfig } from 'vitest/config';
import { TEST_PARTNERS_URL } from './test/partners-url.js';

// 실험(test/experiments)은 오래 걸리므로 EXPERIMENTS=1일 때만, 그때는 실험만 돈다.
const experiments = process.env.EXPERIMENTS === '1';

export default defineConfig({
  test: {
    include: experiments ? ['test/experiments/**/*.spec.ts'] : ['test/**/*.spec.ts'],
    exclude: experiments ? configDefaults.exclude : [...configDefaults.exclude, 'test/experiments/**'],
    // e2e 테스트가 같은 테스트 DB·같은 partners 서버를 쓰므로 파일 단위 병렬 실행을 끈다.
    fileParallelism: false,
    // 큐 테스트의 waitFor 기본 대기(15초)가 vitest 기본 5초보다 길다. 테스트·훅 제한을 그보다 넉넉히 둔다.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 가상 업체 서버를 빌드해 띄운다(테스트 포트 4011, 개발용 4010과 겹치지 않게).
    globalSetup: ['test/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      PARTNERS_URL: TEST_PARTNERS_URL,
      RUN_SCHEDULERS: '0',
    },
  },
  // swc가 데코레이터 메타데이터를 만들어야 Nest DI가 동작한다.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
