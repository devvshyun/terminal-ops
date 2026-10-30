import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 시연 홈(보강 10, decisions/0092). 시나리오를 화면으로 — 단계마다 설명 + 실행 + 바로 옆 실제 결과.
 * 개발 서버가 /api → Nest api, /api/partners → 가상 업체 서버(:4010), /api/sim → 시뮬레이터(:4020)로 넘긴다(앞마디는 떼고).
 * 프록시는 더 긴 앞마디부터 맞춘다 — /api/partners·/api/sim을 /api보다 먼저 둔다. 같은 출처라 CORS를 열지 않는다.
 * DEMO_API_URL·DEMO_PARTNERS_URL·DEMO_SIM_URL로 주소를 바꾼다. 포트는 시연 도구(5179·4179) 옆 5180·4180.
 */
const proxy = {
  '/api/partners': {
    target: process.env.DEMO_PARTNERS_URL ?? 'http://127.0.0.1:4010',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/partners/, ''),
  },
  '/api/sim': {
    target: process.env.DEMO_SIM_URL ?? 'http://127.0.0.1:4020',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/sim/, ''),
  },
  '/api': {
    target: process.env.DEMO_API_URL ?? 'http://localhost:3000',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5180, strictPort: true, proxy },
  preview: { port: 4180, strictPort: true, proxy },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
