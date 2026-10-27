import { NavLink, Outlet } from 'react-router';
import { NAV } from '../nav';
import { OperatorBar } from './OperatorBar';

/** 공통 틀: 위쪽 제목·작업자, 왼쪽 메뉴, 오른쪽 화면 */
export function Layout() {
  return (
    <div className="app">
      <header className="top">
        <h1>단말온 운영 어드민</h1>
        <OperatorBar />
      </header>
      <nav className="side" aria-label="메뉴">
        {NAV.map((item) => (
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
