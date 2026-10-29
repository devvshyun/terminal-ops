import { NavLink, Outlet } from 'react-router';
import { NAV, type NavGroup } from '../nav';
import { hasRole, useMe } from '../session';
import { AppLinks } from './AppLinks';
import { UserBar } from './UserBar';

const GROUPS: NavGroup[] = ['업무', '점검·리포트', '관리'];

/**
 * 공통 틀(decisions/0079): 왼쪽 잉크 사이드바 — 위에 앱 이름, 묶음별 메뉴(역할에 맞는 것만), 다른 화면 바로가기(보강 5), 맨 아래 로그인한 사람.
 * 오른쪽은 화면. 메뉴가 하나도 없는 묶음은 제목도 그리지 않는다.
 */
export function Layout() {
  const me = useMe();
  const visible = NAV.filter((item) => hasRole(me, item.roles));
  return (
    <div className="app">
      <aside className="side">
        <h1 className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>
            단말온 운영 <small>어드민</small>
          </span>
        </h1>
        <nav className="menu" aria-label="메뉴">
          {GROUPS.map((group) => {
            const items = visible.filter((item) => item.group === group);
            if (items.length === 0) return null;
            return (
              <div className="menu-group" key={group}>
                <span className="menu-title">{group}</span>
                {items.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.to === '/'}>
                    {item.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <AppLinks />
        <UserBar />
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
