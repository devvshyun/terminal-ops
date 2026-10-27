import { useSyncExternalStore } from 'react';
import type { MeView, Role } from '@terminal-ops/contracts';

/**
 * 지금 로그인한 사람(보강 2, api decisions/0050). 세션 자체는 서버의 httpOnly 쿠키라 화면 JS는 읽지 못하고, 여기에는 GET /auth/me의 결과만 둔다.
 * - undefined: 아직 모름(처음 화면을 열면 AuthGate가 /auth/me를 부른다)
 * - null: 로그인 안 함(또는 세션이 끝남 — api()가 401을 받으면 null로 바꾼다)
 * 저장소(localStorage)에 남기지 않는다 — 새로 열면 서버에 다시 묻는다(서버가 진실).
 */
export type MeState = MeView | null | undefined;

let current: MeState = undefined;
const listeners = new Set<() => void>();

export function getMe(): MeState {
  return current;
}

export function setMe(me: MeView | null): void {
  current = me;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMe(): MeState {
  return useSyncExternalStore(subscribe, getMe);
}

/** 이 사람이 이 역할 중 하나인가. 화면에서 메뉴·버튼을 숨길 때만 쓴다 — 최종 판단은 서버(403) */
export function hasRole(me: MeState, roles: readonly Role[]): boolean {
  return !!me && roles.includes(me.role);
}

/** 화면 쪽 역할 묶음(api auth/access.ts의 STAFF·OFFICE와 같은 뜻, api decisions/0052) */
export const STAFF: readonly Role[] = ['ADMIN', 'OPERATOR', 'MONITOR', 'FIELD'];
export const OFFICE: readonly Role[] = ['ADMIN', 'OPERATOR', 'MONITOR'];

/** 테스트용: 모르는 상태로 되돌린다 */
export function resetSessionForTest(): void {
  setMe(null);
  current = undefined;
}
