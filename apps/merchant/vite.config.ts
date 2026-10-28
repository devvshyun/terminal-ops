import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 점주 화면(보강 3, decisions/0057). 어드민과 같은 방식으로 개발 서버가 /api를 Nest api로 넘긴다(앞의 /api는 떼고) — 같은 출처라
 * api에 CORS를 열지 않고 세션 쿠키(sid, SameSite=Strict)가 그대로 붙는다(api decisions/0041·0050).
 * MERCHANT_API_URL로 api 주소를 바꾼다(기본 http://localhost:3000). 포트는 어드민(5173·4173) 옆 5174·4174.
 */
const apiProxy = {
  '/api': {
    target: process.env.MERCHANT_API_URL ?? 'http://localhost:3000',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true, proxy: apiProxy },
  preview: { port: 4174, strictPort: true, proxy: apiProxy },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
