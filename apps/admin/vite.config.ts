import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 개발 서버는 /api를 Nest api로 넘긴다(앞의 /api는 떼고). 브라우저는 같은 출처(5173)만 부르므로 api에 CORS를 열지 않는다(decisions/0041).
 * ADMIN_API_URL로 api 주소를 바꾼다(기본 http://localhost:3000). 운영 배포(정적 파일 + 역프록시)는 범위 밖이다.
 */
const apiProxy = {
  '/api': {
    target: process.env.ADMIN_API_URL ?? 'http://localhost:3000',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true, proxy: apiProxy },
  preview: { port: 4173, strictPort: true, proxy: apiProxy },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
