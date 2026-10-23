/** 시드로 재현할 수 있는 난수(mulberry32). 같은 시드, 같은 호출 순서면 같은 값이 나온다. 0 이상 1 미만. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 시드와 글자 조각들로 정해지는 0 이상 1 미만의 값(호출 순서와 상관없다). 조각을 FNV-1a(32비트)로 섞은 값을
 * mulberry32의 시드로 한 번 돌린다. 같은 (시드, 조각들)이면 언제 어떤 순서로 불러도 같은 값이다.
 */
export function hashUniform(seed: number, ...parts: (string | number)[]): number {
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (const ch of `${parts.join('\u0000')}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return createRng(h)();
}
