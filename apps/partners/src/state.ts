import { createRng } from './rng.js';

export interface BungaeConfig {
  /** 조회 1번에 진행하는 단계 수. 1이면 4번째 조회에 DELIVERED */
  advancePerPoll: number;
  /** 이벤트마다 같은 사본을 하나 더 섞을 확률(0~1) */
  duplicateRate: number;
  /** 추적 조회의 초당 허용 횟수. 넘으면 429 */
  rateLimitPerSec: number;
  /** 한도와 상관없이 429를 낼 확률(0~1) */
  force429Rate: number;
  /** 429 응답의 Retry-After(초) */
  retryAfterSec: number;
  /** 추적 조회 응답 지연(ms) */
  delayMs: number;
}

export interface NeurimboConfig {
  advancePerPoll: number;
  delayMs: number;
  /** 503을 낼 확률(0~1) */
  error5xxRate: number;
  /** 이벤트 순서를 뒤섞을지 */
  shuffle: boolean;
}

export interface ToktokConfig {
  /** 500을 낼 확률(0~1). 실패한 요청은 저장하지 않는다(웹훅·파일 올리기 모두). */
  failRate: number;
  /** 올릴 수 있는 파일 크기 상한(바이트, base64를 푼 크기) */
  maxFileBytes: number;
}

export interface SeumConfig {
  /** 발주보다 덜 보내는 대수 */
  shortfall: number;
  /** 명세에 섞을 다른 발주의 시리얼 수 */
  foreignSerials: number;
  /** 발주·납품 명세 API가 503을 낼 확률(0~1) */
  error5xxRate: number;
}

export interface BridgevanConfig {
  /** 목록 한 페이지에 줄 수 있는 최대 건수(limit 상한) */
  maxLimit: number;
  /** 목록·단건 응답 지연(ms) */
  delayMs: number;
  /** 503을 낼 확률(0~1) */
  error5xxRate: number;
  /** 429를 낼 확률(0~1) */
  force429Rate: number;
  /** 429 응답의 Retry-After(초) */
  retryAfterSec: number;
  /**
   * 스캔 도중 변경: 커서를 받은 목록 요청(둘째 페이지부터)마다, 이미 지나간(커서 앞) 등록 n건을 바꾼다.
   * healTo가 있는 등록은 그 값으로 고쳐지고(어긋남이 풀림), 없으면 ACTIVE↔SUSPENDED가 뒤집힌다.
   */
  mutateDuringScan: number;
}

export interface PartnersConfig {
  seed: number;
  bungae: BungaeConfig;
  neurimbo: NeurimboConfig;
  toktok: ToktokConfig;
  seum: SeumConfig;
  bridgevan: BridgevanConfig;
}

export interface ConfigPatch {
  seed?: number;
  bungae?: Partial<BungaeConfig>;
  neurimbo?: Partial<NeurimboConfig>;
  toktok?: Partial<ToktokConfig>;
  seum?: Partial<SeumConfig>;
  bridgevan?: Partial<BridgevanConfig>;
}

export function defaultConfig(): PartnersConfig {
  return {
    seed: 42,
    bungae: { advancePerPoll: 1, duplicateRate: 0, rateLimitPerSec: 20, force429Rate: 0, retryAfterSec: 1, delayMs: 0 },
    neurimbo: { advancePerPoll: 1, delayMs: 0, error5xxRate: 0, shuffle: false },
    toktok: { failRate: 0, maxFileBytes: 5 * 1024 * 1024 },
    seum: { shortfall: 0, foreignSerials: 0, error5xxRate: 0 },
    bridgevan: { maxLimit: 1000, delayMs: 0, error5xxRate: 0, force429Rate: 0, retryAfterSec: 1, mutateDuringScan: 0 },
  };
}

/** 택배 한 건. polls는 성공한 조회 수(429·5xx는 세지 않는다). */
export interface Parcel {
  createdAt: number;
  polls: number;
}

/** 세움전자 발주 한 건과 납품 명세 */
export interface SeumPurchaseOrder {
  poNo: string;
  modelCode: string;
  quantity: number;
  reference: string;
  serials: string[];
}

export const VAN_STATUSES = ['ACTIVE', 'SUSPENDED', 'CANCELLED'] as const;
export type VanStatus = (typeof VAN_STATUSES)[number];

/** 브릿지VAN에 등록된 단말기 한 대(가상). tid는 VAN이 붙인 단말기 번호 */
export interface VanRegistration {
  tid: string;
  serialNo: string;
  merchantCode: string;
  status: VanStatus;
  registeredAt: string;
  updatedAt: string;
  /** 스캔 도중 변경(mutateDuringScan)이 이 등록을 고를 때 바꿀 값. 테스트·실험이 "곧 풀릴 어긋남"을 심을 때 쓴다 */
  healTo?: { status?: VanStatus; merchantCode?: string };
}

/** 톡톡메신저에 올린 파일(메시지 첨부용) */
export interface ToktokFile {
  fileId: string;
  fileName: string;
  contentType: string;
  size: number;
  content: Buffer;
  uploadedAt: string;
}

export interface ToktokMessage {
  channel: string;
  idempotencyKey: string;
  text: string;
  receivedAt: string;
  /** 첨부 파일(올린 파일의 id·이름·크기) */
  attachments: { fileId: string; fileName: string; size: number }[];
}

export interface Stats {
  /** 엔드포인트별 호출 수(429·5xx 포함) */
  calls: Record<string, number>;
  /** 운송장별 추적 조회 수(429·5xx 포함) */
  perTracking: Record<string, number>;
  /** 429 전체 = status429Limit + status429Forced */
  status429: number;
  /** 초당 한도(rateLimitPerSec)를 넘어서 낸 429 */
  status429Limit: number;
  /** force429Rate 난수로 낸 429 */
  status429Forced: number;
  status5xx: number;
  /** 같은 운송장 조회가 처리 중일 때 또 들어온 횟수 */
  overlaps: number;
  /** 같은 운송장 동시 처리 수의 최댓값 */
  maxInFlight: number;
  /** 지금 처리 중인 번개 추적 조회 수(운송장 구분 없이 전체) */
  inFlightTotal: number;
  /** 운송장 구분 없이 동시에 처리한 번개 추적 조회 수의 최댓값. 1보다 크면 실제로 겹쳐 돌았다는 뜻 */
  maxInFlightTotal: number;
  /** 스캔 도중 변경으로 바뀐 브릿지VAN 등록 수(healed 포함) */
  vanMutated: number;
  /** 그중 healTo로 고쳐진 수 */
  vanHealed: number;
}

function emptyStats(): Stats {
  return { calls: {}, perTracking: {}, status429: 0, status429Limit: 0, status429Forced: 0, status5xx: 0, overlaps: 0, maxInFlight: 0, inFlightTotal: 0, maxInFlightTotal: 0, vanMutated: 0, vanHealed: 0 };
}

/** 가상 업체 서버의 메모리 상태. 재시작하거나 reset하면 모두 사라진다. */
export class PartnersState {
  config: PartnersConfig = defaultConfig();
  rng = createRng(this.config.seed);
  /** 번호 앞부분. 서버를 다시 띄워도 이전 번호와 겹치지 않게 시작 시각을 쓴다. */
  epoch = Date.now();
  seq = 0;
  bungae = new Map<string, Parcel>();
  neurimbo = new Map<string, Parcel>();
  seum = new Map<string, SeumPurchaseOrder>();
  /** 번개 추적 조회가 받아들여진 시각(최근 1초) */
  bungaeWindow: number[] = [];
  messages: ToktokMessage[] = [];
  /** 톡톡메신저에 올린 파일(fileId → 파일) */
  files = new Map<string, ToktokFile>();
  /** 브릿지VAN 등록(tid → 등록), tid 오름차순 목록(커서 페이지용), 시리얼 → tid */
  van = new Map<string, VanRegistration>();
  vanTids: string[] = [];
  vanBySerial = new Map<string, string>();
  stats: Stats = emptyStats();
  private inFlight = new Map<string, number>();

  reset(): void {
    this.config = defaultConfig();
    this.rng = createRng(this.config.seed);
    this.epoch = Date.now();
    this.seq = 0;
    this.bungae.clear();
    this.neurimbo.clear();
    this.seum.clear();
    this.bungaeWindow = [];
    this.messages = [];
    this.files.clear();
    this.van.clear();
    this.vanTids = [];
    this.vanBySerial.clear();
    this.stats = emptyStats();
    this.inFlight.clear();
  }

  /** 부분 병합. seed를 주면 난수를 그 시드로 다시 시작한다. */
  configure(patch: ConfigPatch): PartnersConfig {
    this.config = {
      seed: patch.seed ?? this.config.seed,
      bungae: { ...this.config.bungae, ...patch.bungae },
      neurimbo: { ...this.config.neurimbo, ...patch.neurimbo },
      toktok: { ...this.config.toktok, ...patch.toktok },
      seum: { ...this.config.seum, ...patch.seum },
      bridgevan: { ...this.config.bridgevan, ...patch.bridgevan },
    };
    if (patch.seed !== undefined) this.rng = createRng(patch.seed);
    return this.config;
  }

  /** 확률 p로 true. p가 0이면 난수를 쓰지 않는다(다른 설정의 난수 순서를 흔들지 않게). */
  chance(p: number): boolean {
    return p > 0 && this.rng() < p;
  }

  nextNumber(): string {
    this.seq += 1;
    return `${this.epoch}${String(this.seq).padStart(4, '0')}`;
  }

  count(endpoint: string, trackingNo?: string): void {
    this.stats.calls[endpoint] = (this.stats.calls[endpoint] ?? 0) + 1;
    if (trackingNo) this.stats.perTracking[trackingNo] = (this.stats.perTracking[trackingNo] ?? 0) + 1;
  }

  begin(trackingNo: string): void {
    const n = (this.inFlight.get(trackingNo) ?? 0) + 1;
    if (n > 1) this.stats.overlaps += 1;
    this.stats.maxInFlight = Math.max(this.stats.maxInFlight, n);
    this.inFlight.set(trackingNo, n);
    this.stats.inFlightTotal += 1;
    this.stats.maxInFlightTotal = Math.max(this.stats.maxInFlightTotal, this.stats.inFlightTotal);
  }

  end(trackingNo: string): void {
    const n = (this.inFlight.get(trackingNo) ?? 1) - 1;
    if (n <= 0) this.inFlight.delete(trackingNo);
    else this.inFlight.set(trackingNo, n);
    this.stats.inFlightTotal = Math.max(0, this.stats.inFlightTotal - 1);
  }
}
