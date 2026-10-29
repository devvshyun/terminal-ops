import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router';
import type { MerchantView } from '@terminal-ops/contracts';
import { api } from '../api/client';
import { keys } from '../api/query-keys';
import { useMe } from '../session';
import { HomeIcon, ServiceIcon } from './icons';
import { LogoutButton } from './LogoutButton';

/**
 * 화면 틀: 위에 내 매장 이름과 로그아웃, 가운데 화면, 탭 두 개(홈·A/S). 휴대폰에서는 탭이 화면 아래, 900px 이상에서는 위 띠 안 메뉴(decisions/0070).
 * 매장 이름은 GET /me/merchant(로그인한 가맹점, 바뀌는 일이 드물어 staleTime 무한 — 사람이 바뀌면 캐시가 비워진다).
 */
export function Shell() {
  const me = useMe();
  const merchant = useQuery({ queryKey: keys.merchant, queryFn: () => api<MerchantView>('/me/merchant'), staleTime: Infinity });
  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <strong className="store">{merchant.data?.name ?? me?.merchantCode ?? '내 매장'}</strong>
            <small>{me?.displayName}</small>
          </div>
        </div>
        {/* 메뉴는 위 띠 안에 둔다: 휴대폰에서는 화면 아래에 붙고(position: fixed), 넓은 화면에서는 위 띠 가운데 메뉴가 된다(decisions/0070) */}
        <nav className="tabs" aria-label="메뉴">
          <NavLink to="/" end>
            <HomeIcon />
            홈
          </NavLink>
          <NavLink to="/service-tickets">
            <ServiceIcon />
            A/S
          </NavLink>
        </nav>
        <LogoutButton />
      </header>
      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}
