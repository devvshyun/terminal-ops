import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * 외부 연동 개발자센터(보강 7, decisions/0080). 다른 화면 앱과 같은 방식으로 개발 서버가 /api를 Nest api로 넘긴다(앞의 /api는 떼고) —
 * 같은 출처라 api에 CORS를 열지 않고 세션 쿠키(sid, SameSite=Strict)가 그대로 붙는다(api decisions/0041·0050).
 * DEVELOPERS_API_URL로 api 주소를 바꾼다(기본 http://localhost:3000). 포트는 소개 페이지(5177·4177) 옆 5178·4178.
 * 주의: 쿠키는 포트를 가리지 않아 localhost:5173~5178 앱이 같은 sid를 쓴다(decisions/0074 — 보강 9 Docker에서 호스트 이름을 나누면 갈라진다).
 */
const apiProxy = {
  '/api': {
    target: process.env.DEVELOPERS_API_URL ?? 'http://localhost:3000',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5178, strictPort: true, proxy: apiProxy },
  preview: { port: 4178, strictPort: true, proxy: apiProxy },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
