import { useQueryClient } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router';
import { ACTS, ALL_STEPS } from '../lib/acts';
import { forgetAll } from '../lib/memo';
import { resetProgress, useProgress } from '../lib/progress';
import { ReplayClock, ReplayNotice } from '../replay/ReplayBar';
import { getReplay } from '../replay/runtime';
import { useMe } from '../session';
import { Open } from './Step';
import { LoginBox } from './LoginBox';

/** 시연 홈 틀: 위 막대(이름·진행률·처음 상태로·로그인), 왼쪽 막 목록(막마다 끝낸 수), 가운데 막 */
export function Shell() {
  const done = useProgress();
  const me = useMe();
  const client = useQueryClient();
  const replay = getReplay();
  return (
    <>
      <header className="top">
        <strong className="app-name">
          <span className="brand-mark" aria-hidden="true" />
          단말온 시연 홈
        </strong>
        <div className="progress" aria-label="진행률">
          <span className="bar" aria-hidden="true">
            <span style={{ width: `${(done.size / ALL_STEPS.length) * 100}%` }} />
          </span>
          <span>
            {done.size} / {ALL_STEPS.length} 단계
          </span>
          <button
            type="button"
            className="link"
            onClick={() => {
              resetProgress();
              forgetAll();
              // 녹화 재생본: 녹화 시계도 처음으로 — 결과 패널이 처음 상태를 다시 읽는다
              if (replay) {
                replay.reset();
                void client.invalidateQueries();
              }
            }}
          >
            처음 상태로
          </button>
        </div>
        {replay ? <ReplayClock /> : <LoginBox />}
      </header>
      <ReplayNotice />
      <div className="layout">
        <aside className="side">
        <nav className="acts" aria-label="막">
          {ACTS.map((a) => {
            const d = a.steps.filter((s) => done.has(s.key)).length;
            return (
              <NavLink key={a.n} to={`/act/${a.n}`} className={d === a.steps.length ? 'complete' : undefined}>
                <span className="num">{a.n}</span>
                <span className="title">{a.title}</span>
                <small>
                  {d}/{a.steps.length}
                </small>
              </NavLink>
            );
          })}
        </nav>
          <div className="more" aria-label="다른 화면">
            <small className="muted">다른 화면</small>
            <Open app="console" label="운영 관제(monitor)" />
            <Open app="developers" label="개발자센터(admin)" />
            <Open app="sandbox" path="/partners" label="시연 도구" />
          </div>
        </aside>
        {/* 로그인한 사람이 바뀌면 가운데를 새로 그린다 — SessionCacheSync(사본)가 캐시를 비워, 떠 있던 결과 패널이 로그인 전 401을 그대로 들고 있었다(리허설에서 찾음) */}
        <main className="page" key={me?.loginId ?? 'anonymous'}>
          <Outlet />
        </main>
      </div>
    </>
  );
}
