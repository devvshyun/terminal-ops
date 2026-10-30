/**
 * 막 안에서 앞 단계가 만든 값(방금 출고한 시리얼 등)을 뒤 단계가 읽게 기억한다 — 새로고침해도 남게 sessionStorage에(이 탭만).
 * 막히면(사생활 보호 창) 이 화면을 여는 동안만 기억한다.
 */
import { useSyncExternalStore } from 'react';

const memory = new Map<string, string>();
const listeners = new Set<() => void>();
const PREFIX = 'terminal-ops:demo-home:';

export function remember(key: string, value: string): void {
  memory.set(key, value);
  try {
    globalThis.sessionStorage?.setItem(PREFIX + key, value);
  } catch {
    // 저장이 막혀도 화면 안에서는 기억한다
  }
  listeners.forEach((l) => l());
}

export function recall(key: string): string | null {
  if (memory.has(key)) return memory.get(key)!;
  try {
    return globalThis.sessionStorage?.getItem(PREFIX + key) ?? null;
  } catch {
    return null;
  }
}

export function useRecall(key: string): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => recall(key),
  );
}

export function forgetAll(): void {
  memory.clear();
  try {
    for (const k of Object.keys(globalThis.sessionStorage ?? {})) if (k.startsWith(PREFIX)) globalThis.sessionStorage.removeItem(k);
  } catch {
    // 무시
  }
  listeners.forEach((l) => l());
}
