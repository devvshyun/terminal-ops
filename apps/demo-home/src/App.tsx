import { Navigate, Route, Routes, useParams } from 'react-router';
import { Act1 } from './acts/Act1';
import { Act2 } from './acts/Act2';
import { Act3 } from './acts/Act3';
import { Act4 } from './acts/Act4';
import { Act5 } from './acts/Act5';
import { Act6 } from './acts/Act6';
import { Act7 } from './acts/Act7';
import { SessionCacheSync } from './components/SessionCacheSync';
import { Shell } from './components/Shell';
import { ACTS } from './lib/acts';
import { StartTour } from './replay/TourBar';

const PAGES = [Act1, Act2, Act3, Act4, Act5, Act6, Act7];

function ActPage() {
  const n = Number(useParams().n);
  const act = ACTS.find((a) => a.n === n);
  const Page = PAGES[n - 1];
  if (!act || !Page) return <p>없는 막입니다.</p>;
  return (
    <>
      <p className="eyebrow">
        {act.n}막 · {act.who}
      </p>
      <h1>{act.title}</h1>
      <p className="lead">{act.story}</p>
      <Page />
    </>
  );
}

/** 화면 경로: /act/1~7. 로그인 없이도 열린다 — 실행 단추만 운영자 로그인이 필요하다(decisions/0092) */
export function App() {
  return (
    <>
      <SessionCacheSync />
      <Routes>
        {/* 소개는 소개 페이지(apps/landing)가 맡는다 — 시연 홈은 바로 1막(decisions/0096). #/tour는 자동 진행으로 시작(시연 영상 녹화용) */}
        <Route index element={<Navigate to="/act/1" replace />} />
        <Route path="tour" element={<StartTour />} />
        <Route element={<Shell />}>
          <Route path="act/:n" element={<ActPage />} />
          <Route path="*" element={<p>없는 화면입니다.</p>} />
        </Route>
      </Routes>
    </>
  );
}
