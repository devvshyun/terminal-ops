import { NavLink, Outlet } from 'react-router';
import { REFRESH_MS, setAutoRefresh, useAutoRefresh } from '../lib/refresh';
import { useMe } from '../session';
import { LogoutButton } from './LogoutButton';

const ROLE_LABEL: Record<string, string> = { MONITOR: '관제', ADMIN: 'ADMIN' };

/**
 * 관제 화면 틀: 위 막대(앱 이름·메뉴·자동 새로고침 단추·내 이름·로그아웃)와 가운데 화면. 넓은 모니터에 띄워 두는 화면이라 데스크톱 우선.
 * 메뉴는 다섯 — 대시보드(상태·큐·Outbox), 실패 job, 주기 작업, 최근 오류, 작업 기록.
 */
export function Shell() {
  const me = useMe();
  const auto = useAutoRefresh();
  return (
    <>
      <header className="top">
        <strong className="app-name">단말온 운영 관제</strong>
        <nav className="menu" aria-label="메뉴">
          <NavLink to="/" end>
            대시보드
          </NavLink>
          <NavLink to="/failed">실패 job</NavLink>
          <NavLink to="/schedulers">주기 작업</NavLink>
          <NavLink to="/errors">최근 오류</NavLink>
          <NavLink to="/actions">작업 기록</NavLink>
        </nav>
        <div className="who">
          <button type="button" className={auto ? 'toggle on' : 'toggle'} aria-pressed={auto} onClick={() => setAutoRefresh(!auto)}>
            자동 새로고침 {REFRESH_MS / 1000}초 · {auto ? '켜짐' : '꺼짐'}
          </button>
          <small>
            {me?.displayName} ({me ? (ROLE_LABEL[me.role] ?? me.role) : ''})
          </small>
          <LogoutButton />
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </>
  );
}
