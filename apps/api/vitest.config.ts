import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';
import { TEST_PARTNERS_URL } from './test/partners-url.js';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // e2e 테스트가 같은 테스트 DB·같은 partners 서버를 쓰므로 파일 단위 병렬 실행을 끈다.
    fileParallelism: false,
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
