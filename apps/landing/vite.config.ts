import { defineConfig } from 'vitest/config';

/**
 * 소개 페이지(decisions/0078). api 없이 뜨는 정적 페이지 — 프록시가 없다. 포트는 관제 앱(5176·4176) 옆 5177·4177.
 * 상대 경로(base './')로 빌드해 어느 폴더(GitHub Pages 하위 경로 등)에 올려도 뜬다.
 */
export default defineConfig({
  base: './',
  server: { port: 5177, strictPort: true },
  preview: { port: 4177, strictPort: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
