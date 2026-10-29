import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 시연 도구(보강 8, decisions/0084): 가상 업체 서버와 단말기 시뮬레이터의 관리 API(`/__admin/*`)를 화면에서 부른다.
 * 개발 서버가 /api/partners → 가상 업체 서버(:4010), /api/sim → 시뮬레이터(:4020)로 넘긴다(앞마디는 떼고) — 같은 출처라 두 서버에 CORS를 열지 않는다.
 * 앞마디를 /api 아래에 두는 이유: 화면 경로(/partners·/devices)와 겹치면 그 화면을 새로 열 때(어드민 링크·새로고침) 페이지 대신 서버로 넘어간다(최종 검토, App.test가 본다).
 * SANDBOX_PARTNERS_URL·SANDBOX_SIM_URL로 주소를 바꾼다. 포트는 개발자센터(5178·4178) 옆 5179·4179.
 */
const proxy = {
  '/api/partners': {
    target: process.env.SANDBOX_PARTNERS_URL ?? 'http://127.0.0.1:4010',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/partners/, ''),
  },
  '/api/sim': {
    target: process.env.SANDBOX_SIM_URL ?? 'http://127.0.0.1:4020',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api\/sim/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5179, strictPort: true, proxy },
  preview: { port: 4179, strictPort: true, proxy },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
