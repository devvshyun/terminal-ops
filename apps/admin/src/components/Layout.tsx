import { NavLink, Outlet } from 'react-router';
import { NAV } from '../nav';
import { hasRole, useMe } from '../session';
import { UserBar } from './UserBar';

/** 공통 틀: 위쪽 제목·로그인한 사람, 왼쪽 메뉴(역할에 맞는 것만), 오른쪽 화면 */
export function Layout() {
  const me = useMe();
  return (
    <div className="app">
      <header className="top">
        <h1>단말온 운영 어드민</h1>
        <UserBar />
      </header>
      <nav className="side" aria-label="메뉴">
        {NAV.filter((item) => hasRole(me, item.roles)).map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === '/'}>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
