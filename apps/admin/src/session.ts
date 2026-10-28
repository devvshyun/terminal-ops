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

/** 로그인한 사람이 바뀔 때(로그인·로그아웃·세션 끝남) 부르는 정리 함수. 화면 데이터 캐시를 비우는 곳(SessionCacheSync)이 등록한다 */
let onUserChange: (() => void) | null = null;

export function registerUserChangeHandler(handler: (() => void) | null): void {
  onUserChange = handler;
}

/** 사용자가 일부러 로그아웃해서 로그인 안 한 상태가 됐나(true면 AuthGate가 "돌아올 주소"를 남기지 않는다). 401로 끝난 것과 구분 */
let endedByLogout = false;

export function wasLoggedOutOnPurpose(): boolean {
  return endedByLogout;
}

/** 사용자가 로그아웃했다 — 서버 세션을 끊은 뒤 화면 쪽 로그인 정보를 비운다 */
export function setLoggedOut(): void {
  setMe(null);
  endedByLogout = true;
}

/**
 * 내 정보를 바꾼다. 아이디가 달라지면(null = 로그인 안 함 포함) 구독자에게 알리기 *전에* 캐시부터 비운다 —
 * 앞사람의 응답(예: staleTime Infinity인 /merchants)이 다음 사람에게 보이지 않게. 모름(undefined) → 첫 확인은 비울 것이 없어 건너뛴다.
 */
export function setMe(me: MeView | null): void {
  if (current !== undefined && (current?.loginId ?? null) !== (me?.loginId ?? null)) onUserChange?.();
  if (me) endedByLogout = false;
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
  current = undefined;
  endedByLogout = false;
  onUserChange = null;
  listeners.forEach((listener) => listener());
}
