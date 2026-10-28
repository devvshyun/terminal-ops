import type { ButtonHTMLAttributes } from 'react';
import type { Role } from '@terminal-ops/contracts';
import { hasRole, useMe } from '../session';

/**
 * 쓰기 버튼. roles(기본 운영자)가 아닌 사람에게는 보이지 않는다 — 서버도 403으로 막는다(api decisions/0052).
 * 로그인 정보를 아직 모르면(또는 없으면) 꺼진 채로 보인다.
 */
export function WriteButton({ disabled, title, roles = ['OPERATOR'], ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { roles?: readonly Role[] }) {
  const me = useMe();
  if (me && !hasRole(me, roles)) return null;
  return <button type="button" {...rest} disabled={!me || disabled} title={!me ? '로그인이 필요합니다' : title} />;
}
