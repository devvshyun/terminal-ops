import type { ReactNode } from 'react';
import { NAV } from '../nav';
import { hasRole, useMe } from '../session';

/**
 * 화면 경로의 역할 검사. 메뉴(nav.ts)에서 숨긴 화면을 주소로 직접 열어도 서버가 부르는 api마다 403을 주지만,
 * 그 전에 빈 폼이 반쯤 열리지 않게 안내를 보인다. 역할은 메뉴 항목(to)과 같은 값을 쓴다 — 상세 화면은 목록 메뉴의 to를 넘긴다.
 */
export function RequireRole({ nav, children }: { nav: string; children: ReactNode }) {
  const me = useMe();
  const roles = NAV.find((item) => item.to === nav)?.roles ?? [];
  if (hasRole(me, roles)) return <>{children}</>;
  return (
    <div className="error" role="alert">
      <strong>이 화면을 볼 권한이 없습니다.</strong>
      <div className="error-detail">지금 역할({me?.role ?? '-'})로는 열 수 없는 화면입니다. 왼쪽 메뉴에서 열 수 있는 화면을 고르세요.</div>
    </div>
  );
}
