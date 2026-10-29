import { NavLink, Outlet } from 'react-router';
import { useMe } from '../session';
import { LogoutButton } from './LogoutButton';

/**
 * 개발자센터 틀: 위 막대(앱 이름·메뉴·내 이름·로그아웃)와 가운데 화면. 사무실 PC에서 쓰는 화면이라 데스크톱 우선(좁으면 막대가 두 줄).
 * 메뉴는 셋 — 외부 업체(업체마다 키·최근 호출), 호출 로그(전체), 연동 문서.
 */
export function Shell() {
  const me = useMe();
  return (
    <>
      <header className="top">
        <strong className="app-name">
          <span className="brand-mark" aria-hidden="true" />
          단말온 개발자센터
        </strong>
        <nav className="menu" aria-label="메뉴">
          <NavLink to="/" end>
            외부 업체
          </NavLink>
          <NavLink to="/calls">호출 로그</NavLink>
          <NavLink to="/docs">연동 문서</NavLink>
        </nav>
        <div className="who">
          <small>
            {me?.displayName} ({me?.role})
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
