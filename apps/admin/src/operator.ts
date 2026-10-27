import { useSyncExternalStore } from 'react';

/**
 * 작업자 이름(X-Operator). 화면 위쪽에서 입력하면 localStorage에 두고 모든 요청 헤더에 붙인다(decisions/0001 연장, decisions/0041).
 * 인증이 아니다 — 누가 바꿨는지 이력에 남기는 이름이다. localStorage를 못 쓰는 브라우저(사생활 모드 등)에서는 탭이 열려 있는 동안만 기억한다.
 */
export const OPERATOR_KEY = 'terminal-ops.operator';

/** 서버 규칙과 같다: 앞뒤 공백 뺀 1~50자, `system:`으로 시작하면 안 된다(common/operator.decorator.ts) */
export function operatorProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return '작업자 이름을 입력하세요.';
  if (trimmed.length > 50) return '작업자 이름은 50자 이하입니다.';
  if (trimmed.startsWith('system:')) return '`system:`으로 시작하는 이름은 시스템 작업 전용입니다.';
  return null;
}

function load(): string {
  try {
    const saved = window.localStorage.getItem(OPERATOR_KEY) ?? '';
    return operatorProblem(saved) ? '' : saved.trim();
  } catch {
    return '';
  }
}

let current = load();
const listeners = new Set<() => void>();

export function getOperator(): string {
  return current;
}

/** 이름을 바꾼다. 규칙에 맞지 않으면 바꾸지 않고 이유를 돌려준다(빈 이름은 지우기) */
export function setOperator(name: string): string | null {
  const trimmed = name.trim();
  const problem = trimmed ? operatorProblem(trimmed) : null;
  if (problem) return problem;
  current = trimmed;
  try {
    if (trimmed) window.localStorage.setItem(OPERATOR_KEY, trimmed);
    else window.localStorage.removeItem(OPERATOR_KEY);
  } catch {
    // 저장소를 못 쓰면 메모리에만 둔다
  }
  listeners.forEach((listener) => listener());
  return null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 지금 작업자 이름(없으면 ''). 바뀌면 다시 그린다 */
export function useOperator(): string {
  return useSyncExternalStore(subscribe, getOperator);
}

/** 테스트용: 저장소에서 다시 읽는다 */
export function reloadOperatorForTest(): void {
  current = load();
  listeners.forEach((listener) => listener());
}
