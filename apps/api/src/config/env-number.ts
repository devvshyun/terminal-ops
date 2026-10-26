export interface IntRange {
  /** 허용하는 가장 작은 값(포함) */
  min: number;
  /** 허용하는 가장 큰 값(포함) */
  max: number;
}

/** 하루(ms). 주기·TTL 상한으로 쓴다 */
export const DAY_MS = 86_400_000;

/**
 * 정수 환경변수를 읽는다. 없거나 빈 글자면 기본값, 정수 글자가 아니거나 범위를 벗어나면 던진다(서버·워커가 뜨지 않게).
 * `Number(process.env.X ?? 기본값)`은 'abc'·'10s'를 NaN으로, '1.5'를 1.5로 그대로 넘겼다(Day 4 리뷰 Minor "새 env 주기값 NaN 검사 없음").
 * NaN·소수 주기가 BullMQ job scheduler·setTimeout에 들어가면 조용히 이상하게 돈다. 시작할 때 이름과 값을 담아 실패하게 한다(decisions/0032).
 * @param source 테스트에서 process.env 대신 넘긴다
 */
export function intFromEnv(name: string, fallback: number, range: IntRange, source: NodeJS.ProcessEnv = process.env): number {
  const text = (source[name] ?? '').trim();
  if (text === '') return fallback;
  // '1e3', '0x10', '1.5', '10s'를 거절한다(Number()는 앞의 둘을 숫자로 읽는다)
  if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error(`환경변수 ${name}=${JSON.stringify(source[name])}는 정수가 아닙니다. 저장소 루트 .env를 확인하세요.`);
  }
  const value = Number(text);
  if (value < range.min || value > range.max) {
    throw new Error(`환경변수 ${name}=${value}가 범위 ${range.min}~${range.max} 밖입니다. 저장소 루트 .env를 확인하세요.`);
  }
  return value;
}
