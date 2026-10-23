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
  /** 요청 하나의 제한 시간(ms) */
  requestTimeoutMs: number;
  seed: number;
}

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
    requestTimeoutMs: 5000,
    seed: 42,
  };
}

/** 단말기 시리얼 목록 */
export function serialsOf(config: SimConfig): string[] {
  if (config.serials.length > 0) return [...config.serials];
  return Array.from({ length: config.count }, (_, i) => `${config.serialPrefix}-${String(config.serialStart + i).padStart(4, '0')}`);
}

/** 숫자 설정의 범위 검사. 틀리면 이유 문장, 맞으면 null */
export function invalidReason(config: SimConfig): string | null {
  const positive: (keyof SimConfig)[] = ['intervalMs', 'batchSize', 'concurrency', 'requestTimeoutMs'];
  for (const key of positive) {
    const v = config[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return `${key}는 1 이상의 정수여야 합니다.`;
  }
  for (const key of ['offlineRate'] as const) {
    if (!(config[key] >= 0 && config[key] <= 1)) return `${key}는 0~1이어야 합니다.`;
  }
  if (!Number.isInteger(config.count) || config.count < 0) return 'count는 0 이상의 정수여야 합니다.';
  return null;
}
