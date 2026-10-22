import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    // e2e 테스트가 같은 테스트 DB를 쓰므로 파일 단위 병렬 실행을 끈다.
    fileParallelism: false,
    env: { NODE_ENV: 'test' },
  },
  // swc가 데코레이터 메타데이터를 만들어야 Nest DI가 동작한다.
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
