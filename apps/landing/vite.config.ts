import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { countRecords, fillCounts } from './src/counts.node';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const here = dirname(fileURLToPath(import.meta.url));

// 시연 주소(보강 11, decisions/0096). GitHub Pages는 같은 사이트의 ./demo/(녹화 재생본), 시연 묶음은 web 이미지가 http://demo.localhost:8080을 넣는다
process.env.VITE_DEMO_URL ??= './demo/';
process.env.VITE_VIDEO_URL ??= './video.html';

/**
 * 소개 페이지(decisions/0078). api 없이 뜨는 정적 페이지 — 프록시가 없다. 포트는 관제 앱(5176·4176) 옆 5177·4177.
 * 상대 경로(base './')로 빌드해 어느 폴더(GitHub Pages 하위 경로 등)에 올려도 뜬다.
 */
export default defineConfig({
  base: './',
  // 기록 수를 HTML에 채운다(스크립트 없이도 맞는 수 — counts.node.ts)
  plugins: [{ name: 'record-counts', transformIndexHtml: (html) => fillCounts(html, countRecords(repoRoot)) }],
  // 시연 영상 페이지(video.html)도 함께 빌드한다
  build: { rollupOptions: { input: { main: resolve(here, 'index.html'), video: resolve(here, 'video.html') } } },
  server: { port: 5177, strictPort: true },
  preview: { port: 4177, strictPort: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
