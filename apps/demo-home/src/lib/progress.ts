import { useSyncExternalStore } from 'react';
import { ALL_STEPS } from './acts';

/**
 * 끝낸 단계 표시(보강 10, decisions/0092). 이 브라우저의 localStorage에만 — 서버에 남기지 않는다.
 * 사생활 보호 창·저장소 막힘이면 읽기·쓰기가 던질 수 있어 모두 감싼다(그때는 이 화면을 여는 동안만 기억한다).
 */
const STORAGE_KEY = 'terminal-ops:demo-home:done';
let memory = new Set<string>(read());
const listeners = new Set<() => void>();

function read(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string' && ALL_STEPS.includes(k)) : [];
  } catch {
    return [];
  }
}

function write(): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...memory]));
  } catch {
    // 저장이 막혀도 화면 안에서는 기억한다
  }
  listeners.forEach((l) => l());
}

export function markDone(key: string, done = true): void {
  const next = new Set(memory);
  if (done) next.add(key);
  else next.delete(key);
  memory = next;
  write();
}

export function resetProgress(): void {
  memory = new Set();
  write();
}

export function useProgress(): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => memory,
  );
}

/** 테스트용: 저장소를 다시 읽는다 */
export function reloadProgressForTest(): void {
  memory = new Set(read());
  listeners.forEach((l) => l());
}
