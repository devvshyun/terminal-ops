import { NavLink, Outlet } from 'react-router';
import { useMe } from '../session';
import { HomeIcon, InspectIcon, ScanIcon } from './icons';
import { LogoutButton } from './LogoutButton';

/**
 * 휴대폰·PDA 화면 틀: 위에 내 이름과 로그아웃, 가운데 화면, 아래에 탭 셋(홈·박스 스캔·검수 — 엄지가 닿는 곳).
 * 넓은 화면에서도 가운데 한 줄(최대 560px).
 */
export function Shell() {
  const me = useMe();
  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <strong className="app-name">단말온 현장</strong>
            <small>{me?.displayName}</small>
          </div>
        </div>
        <LogoutButton />
      </header>
      <main className="page">
        <Outlet />
      </main>
      <nav className="tabs" aria-label="메뉴">
        <NavLink to="/" end>
          <HomeIcon />
          홈
        </NavLink>
        <NavLink to="/scan">
          <ScanIcon />
          박스 스캔
        </NavLink>
        <NavLink to="/inspections">
          <InspectIcon />
          검수
        </NavLink>
      </nav>
    </div>
  );
}
