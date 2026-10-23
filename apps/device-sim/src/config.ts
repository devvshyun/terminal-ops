/** 시뮬레이터 설정. 관리 API(POST /__admin/config)로 일부만 바꿀 수 있다(나머지는 그대로). */
export interface SimConfig {
  /** 하트비트를 보낼 API 주소(예: http://127.0.0.1:3000) */
  targetUrl: string;
  /** 단말기 시리얼 목록. 비어 있으면 serialPrefix·serialStart·count로 만든다(`HB-0001` …) */
  serials: string[];
  serialPrefix: string;
  serialStart: number;
  count: number;
  /** 하트비트 주기(ms). 한 주기에 온라인 단말기가 모두 한 번씩 보낸다 */
  intervalMs: number;
  /** 한 요청에 담는 하트비트 수. 1이면 단말기마다 요청 하나 */
  batchSize: number;
  /** 동시에 보내는 요청 수 상한. keep-alive 소켓 수 상한과 같다(Windows 임시 포트 고갈 방지) */
  concurrency: number;
  /** 하트비트를 보내지 않는 단말기 */
  offlineSerials: string[];
  /** 이 비율만큼 단말기를 시드 난수로 골라 오프라인으로 둔다(0~1). offlineSerials와 합쳐진다 */
  offlineRate: number;
  /** 단말기의 처음 펌웨어 버전 */
  firmwareVersion: string;
  /** 업데이트 지시를 받았을 때 실패로 보고할 확률(0~1, 시드 난수) */
  firmwareFailRate: number;
  /** 업데이트(가짜 다운로드·설치)에 걸리는 시간(ms). 지나면 결과를 보고한다 */
  updateDelayMs: number;
  /** 업데이트 시간에 더하는 무작위 시간의 상한(ms, 시드 난수). 0이면 모두 같은 시간에 끝난다 */
  updateJitterMs: number;
  /** 요청 하나의 제한 시간(ms) */
  requestTimeoutMs: number;
  seed: number;
}

/** 단말기 대수의 상한(시리얼 목록·count 모두) */
export const MAX_DEVICES = 20_000;

export type SimConfigPatch = Partial<SimConfig>;

export function defaultConfig(): SimConfig {
  return {
    targetUrl: 'http://127.0.0.1:3000',
    serials: [],
    serialPrefix: 'HB',
    serialStart: 1,
    count: 10,
    intervalMs: 30_000,
    batchSize: 100,
    concurrency: 8,
    offlineSerials: [],
    offlineRate: 0,
    firmwareVersion: '1.0.0',
    firmwareFailRate: 0,
    updateDelayMs: 1000,
    updateJitterMs: 0,
    requestTimeoutMs: 5000,
    seed: 42,
  };
}

/** 단말기 시리얼 목록 */
export function serialsOf(config: SimConfig): string[] {
  if (config.serials.length > 0) return [...config.serials];
  return Array.from({ length: config.count }, (_, i) => `${config.serialPrefix}-${String(config.serialStart + i).padStart(4, '0')}`);
}

type Rule =
  | { type: 'string'; nonEmpty?: boolean }
  | { type: 'url' }
  | { type: 'strings'; max: number }
  | { type: 'int'; min: number; max: number }
  | { type: 'number'; min: number; max: number };

/** 설정 키마다 형식·범위. 새 설정 키는 여기에 한 줄을 더해야 관리 API가 받는다(알 수 없는 키는 400) */
export const CONFIG_RULES: Record<keyof SimConfig, Rule> = {
  targetUrl: { type: 'url' },
  serials: { type: 'strings', max: MAX_DEVICES },
  serialPrefix: { type: 'string', nonEmpty: true },
  serialStart: { type: 'int', min: 0, max: 1_000_000_000 },
  count: { type: 'int', min: 0, max: MAX_DEVICES },
  intervalMs: { type: 'int', min: 1, max: 86_400_000 },
  batchSize: { type: 'int', min: 1, max: 500 }, // API가 한 요청에 500개까지 받는다
  concurrency: { type: 'int', min: 1, max: 1000 },
  offlineSerials: { type: 'strings', max: MAX_DEVICES },
  offlineRate: { type: 'number', min: 0, max: 1 },
  firmwareVersion: { type: 'string', nonEmpty: true },
  firmwareFailRate: { type: 'number', min: 0, max: 1 },
  updateDelayMs: { type: 'int', min: 0, max: 3_600_000 }, // 한 시간
  updateJitterMs: { type: 'int', min: 0, max: 3_600_000 },
  requestTimeoutMs: { type: 'int', min: 1, max: 600_000 },
  seed: { type: 'int', min: 0, max: 4_294_967_295 },
};

function checkValue(key: string, value: unknown, rule: Rule): string | null {
  switch (rule.type) {
    case 'string':
      if (typeof value !== 'string' || (rule.nonEmpty && value === '')) return `${key}는 ${rule.nonEmpty ? '비어 있지 않은 ' : ''}문자열이어야 합니다.`;
      return null;
    case 'url': {
      if (typeof value !== 'string') return `${key}는 http(s) 주소 문자열이어야 합니다.`;
      try {
        const u = new URL(value);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${key}는 http 또는 https 주소여야 합니다.`;
      } catch {
        return `${key}가 올바른 주소가 아닙니다.`;
      }
      return null;
    }
    case 'strings':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v === '')) return `${key}는 비어 있지 않은 문자열의 배열이어야 합니다.`;
      if (value.length > rule.max) return `${key}는 ${rule.max}개 이하여야 합니다.`;
      if (new Set(value).size !== value.length) return `${key}에 중복이 있습니다.`;
      return null;
    case 'int':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (rule.type === 'int' && !Number.isInteger(value))) {
        return `${key}는 유한한 ${rule.type === 'int' ? '정수' : '숫자'}여야 합니다.`;
      }
      if (value < rule.min || value > rule.max) return `${key}는 ${rule.min}~${rule.max}이어야 합니다.`;
      return null;
  }
}

/** 관리 API로 받은 설정 일부의 검사. 알 수 없는 키·형식·범위가 틀리면 이유 문장, 맞으면 null */
export function invalidPatchReason(patch: Record<string, unknown>): string | null {
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(CONFIG_RULES, key)) return `알 수 없는 설정 키입니다: ${key}`;
    const reason = checkValue(key, patch[key], CONFIG_RULES[key as keyof SimConfig]);
    if (reason) return reason;
  }
  return null;
}

/** 합친 설정 전체의 검사(키마다의 검사 + 서로 관련된 값) */
export function invalidReason(config: SimConfig): string | null {
  return invalidPatchReason(config as unknown as Record<string, unknown>);
}
