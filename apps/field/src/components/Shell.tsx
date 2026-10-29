import { NavLink, Outlet } from 'react-router';
import { adminScanUrl } from '../lib/admin-link';
import { useMe } from '../session';
import { HomeIcon, InspectIcon, ScanIcon } from './icons';
import { LogoutButton } from './LogoutButton';

/**
 * 휴대폰·PDA 화면 틀: 위에 내 이름과 로그아웃, 가운데 화면, 아래에 탭 셋(홈·박스 스캔·검수 — 엄지가 닿는 곳).
 * 넓은 화면에서도 가운데 한 줄(최대 560px). 아주 넓으면(1180px 이상) 왼쪽 빈 곳에 "휴대폰·PDA용 — 어드민 박스 스캔" 안내(decisions/0077).
 */
export function Shell() {
  const me = useMe();
  return (
    <>
      {/* 휴대폰 폭에서는 CSS로 숨긴다(display: none — 스크린 리더에도 없다) */}
      <aside className="wide-note" aria-label="이 화면 안내">
        <strong>휴대폰·PDA용 화면</strong>
        <p>창고에서 바코드 스캐너로 쓰는 화면입니다. 사무실 PC에서는 어드민의 박스 스캔이 더 편합니다.</p>
        <a href={adminScanUrl()} target="_blank" rel="noreferrer">
          어드민 박스 스캔 열기
        </a>
      </aside>
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
    </>
  );
}
