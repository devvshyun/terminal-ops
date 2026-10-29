import { NavLink, Outlet } from 'react-router';

/** 시연 도구 틀: 위 막대(앱 이름·메뉴·안내)와 가운데 화면 */
export function Shell() {
  return (
    <>
      <header className="top">
        <strong className="app-name">
          <span className="brand-mark" aria-hidden="true" />
          단말온 시연 도구
        </strong>
        <nav className="menu" aria-label="메뉴">
          <NavLink to="/partners">가상 업체</NavLink>
          <NavLink to="/devices">단말기 시뮬레이터</NavLink>
        </nav>
        <small className="note">시연용 가짜 서버를 조작합니다 — 운영 시스템이 아닙니다</small>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </>
  );
}
