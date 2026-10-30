// 시연 영상 녹화기(보강 11, decisions/0096). 녹화 재생본의 자동 진행(#/tour)을 Playwright로 화면 녹화해 mp4로 만든다.
// 시연 묶음은 필요 없다 — 녹화본(public-replay/recording.json)만으로 돈다.
//
// 사용(저장소 루트):
//   (cd apps/demo-home && npm run build:replay && npm run preview:replay)   # 다른 터미널, :4181
//   node apps/demo-home/scripts/record-video.cjs
//   → apps/landing/public/media/demo-tour.mp4·demo-tour-poster.jpg (ffmpeg 필요)
// Playwright 영상은 webm(VP8, 화질 낮음)이다 — 아이폰 Safari까지 열리게 H.264 mp4로 바꾼다.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const OUT_DIR = path.join(ROOT, 'apps/landing/public/media');
const BASE = process.env.REPLAY_URL ?? 'http://127.0.0.1:4181/replay.html';
const SIZE = { width: 1280, height: 800 };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-video-'));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: tmp, size: SIZE }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now();
  await p.goto(`${BASE}#/tour`);
  const bar = p.getByRole('region', { name: '자동 재생' });
  await bar.waitFor();
  await bar.getByText('시연 끝').waitFor({ timeout: 420000 });
  await p.waitForTimeout(2500); // 끝 안내를 잠깐 보인다
  const seconds = Math.round((Date.now() - t0) / 1000);
  const progress = await p.locator('.progress').innerText();
  const video = p.video();
  await ctx.close();
  await browser.close();
  const webm = await video.path();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mp4 = path.join(OUT_DIR, 'demo-tour.mp4');
  // 첫 1초(빈 화면에서 1막이 그려지는 동안)는 잘라 낸다. 화면 녹화라 움직임이 적어 crf 30이면 충분히 선명하다
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '1', '-i', webm, '-c:v', 'libx264', '-preset', 'slow', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '6', '-i', mp4, '-frames:v', '1', '-q:v', '4', path.join(OUT_DIR, 'demo-tour-poster.jpg')]);
  fs.rmSync(tmp, { recursive: true, force: true });
  const mb = (fs.statSync(mp4).size / 1024 / 1024).toFixed(1);
  console.log(`끝: ${seconds}초, ${progress.replace(/\n/g, ' ')}, mp4 ${mb}MB, pageerror ${errors.length}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
