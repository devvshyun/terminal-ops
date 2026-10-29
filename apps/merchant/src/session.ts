import { useSyncExternalStore } from 'react';
import type { MeView } from '@terminal-ops/contracts';

// 현장 앱 `apps/field/src/session.ts`·관제 앱 `apps/console/src/session.ts`에 사본이 있다 — 같이 고친다(decisions/0062·0075, 두 앱의 `src/copies.test.ts`가 코드 차이를 본다)
/**
 * 지금 로그인한 사람(GET /auth/me 결과만, 어드민 session.ts와 같은 규칙 — decisions/0058). 세션 자체는 서버의 httpOnly 쿠키다.
 * - undefined: 아직 모름(AuthGate가 /auth/me를 부른다)
 * - null: 로그인 안 함(또는 세션이 끝남 — api()가 401을 받으면 null로 바꾼다)
 * 저장소(localStorage)에 남기지 않는다 — 새로 열면 서버에 다시 묻는다.
 */
export type MeState = MeView | null | undefined;

let current: MeState = undefined;
const listeners = new Set<() => void>();

export function getMe(): MeState {
  return current;
}

/** 로그인한 사람이 바뀔 때 부르는 정리 함수(쿼리 캐시 비우기 — SessionCacheSync가 등록) */
let onUserChange: (() => void) | null = null;

export function registerUserChangeHandler(handler: (() => void) | null): void {
  onUserChange = handler;
}

/** 일부러 로그아웃했나(true면 AuthGate가 돌아올 주소를 남기지 않는다). 401로 끝난 것과 구분 */
let endedByLogout = false;

export function wasLoggedOutOnPurpose(): boolean {
  return endedByLogout;
}

export function setLoggedOut(): void {
  setMe(null);
  endedByLogout = true;
}

/** 아이디가 달라지면(null 포함) 구독자에게 알리기 전에 캐시부터 비운다 — 앞사람의 매장 데이터가 다음 사람에게 보이지 않게 */
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

/** 테스트용: 모르는 상태로 되돌린다 */
export function resetSessionForTest(): void {
  current = undefined;
  endedByLogout = false;
  onUserChange = null;
  listeners.forEach((listener) => listener());
}
