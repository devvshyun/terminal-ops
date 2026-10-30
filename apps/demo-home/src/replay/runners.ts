/**
 * 실행 단추 등록부(보강 11 후속). 화면에 떠 있는 실행 단추(Run)가 자기를 단계 key·글자로 등록하고, 자동 재생(TourBar)이 찾아 누른다 —
 * 사람이 누르는 것과 같은 함수(useMutation)를 지나 진행 표시·결과 패널 다시 읽기까지 똑같이 일어난다.
 */
export interface Runner {
  label: string;
  /** 지금 누를 수 있나(로그인·실행 중) */
  enabled(): boolean;
  run(): Promise<unknown>;
}

const byStep = new Map<string, Set<Runner>>();

export function registerRunner(step: string, runner: Runner): () => void {
  const set = byStep.get(step) ?? new Set<Runner>();
  set.add(runner);
  byStep.set(step, set);
  return () => set.delete(runner);
}

/** 그 단계의 단추. label이 true면 그 단계 단추 아무거나(하나뿐일 때) */
export function findRunner(step: string, label: string | true): Runner | null {
  const list = [...(byStep.get(step) ?? [])];
  if (label === true) return list[0] ?? null;
  return list.find((r) => r.label === label) ?? null;
}
