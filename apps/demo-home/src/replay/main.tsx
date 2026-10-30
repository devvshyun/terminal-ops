// 녹화 재생본의 시작점(보강 11, decisions/0093). 보통 시작점 `src/main.tsx`(점주 앱 사본)와 다른 점:
// - 녹화본(public-replay/recording.json — 빌드에 묶지 않고 시작할 때 받아 온다)으로 재생 엔진을 만들고 fetch를 엔진으로 바꾼다 — 서버 없이 GitHub Pages에서 돈다
// - 주소는 HashRouter(#/act/3) — Pages는 모르는 경로를 index.html로 돌려주지 않는다
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { HashRouter } from 'react-router';
import { App } from '../App';
import { createQueryClient } from '../query-client';
import { Replay, type Recording } from './engine';
import { replayFetch, setReplay } from './runtime';
import '../styles.css';

const original = window.fetch.bind(window);
const recording = (await (await original(`${import.meta.env.BASE_URL}recording.json`)).json()) as Recording;
const replay = new Replay(recording, () => Date.now());
setReplay(replay);
window.fetch = replayFetch(replay, original);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <HashRouter>
        <App />
      </HashRouter>
    </QueryClientProvider>
  </StrictMode>,
);
