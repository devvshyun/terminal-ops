import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 녹화 재생본 빌드(보강 11, decisions/0093) — GitHub Pages용 정적 파일. 서버도 프록시도 없다(fetch를 재생 엔진이 받는다).
 *   npm run build:replay  → dist-replay/ (replay.html을 index.html로 바꿔 올린다 — .github/workflows/pages.yml)
 * base './': Pages 주소(https://<사용자>.github.io/terminal-ops/)의 하위 경로에서도, 로컬 vite preview에서도 같은 파일이 열린다.
 * publicDir: 녹화기가 찍은 다른 화면 사진(public-replay/shots).
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  publicDir: 'public-replay',
  build: {
    outDir: 'dist-replay',
    // 시작점이 녹화본을 받아 온 뒤 그린다(최상위 await)
    target: 'es2022',
    rollupOptions: { input: 'replay.html' },
  },
  preview: { port: 4181, strictPort: true },
});
