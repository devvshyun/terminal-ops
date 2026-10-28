import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router';
import type { MerchantView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { useMe } from '../session';
import { LogoutButton } from './LogoutButton';

/**
 * 휴대폰 화면 틀: 위에 내 매장 이름과 로그아웃, 가운데 화면, 아래에 탭 두 개(홈·A/S). 넓은 화면에서도 가운데 한 줄(최대 560px)로 둔다.
 * 매장 이름은 GET /me/merchant(로그인한 가맹점, 바뀌는 일이 드물어 staleTime 무한 — 사람이 바뀌면 캐시가 비워진다).
 */
export function Shell() {
  const me = useMe();
  const merchant = useQuery({ queryKey: keys.merchant, queryFn: () => api<MerchantView>('/me/merchant'), staleTime: Infinity });
  return (
    <div className="shell">
      <header className="top">
        <div>
          <strong className="store">{merchant.data?.name ?? me?.merchantCode ?? '내 매장'}</strong>
          <small>{me?.displayName}</small>
        </div>
        <LogoutButton />
      </header>
      <main className="page">
        <Outlet />
      </main>
      <nav className="tabs" aria-label="메뉴">
        <NavLink to="/" end>
          홈
        </NavLink>
        <NavLink to="/service-tickets">A/S</NavLink>
      </nav>
    </div>
  );
}
