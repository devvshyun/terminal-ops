import { PartnerPermanentError } from '../common/partner-errors.js';
import { partnerFetch } from '../common/partner-http.js';
import { betterRegistration, serialKey } from './van-compare.js';
import { VanStatus } from './van.entities.js';

export interface BridgevanOptions {
  baseUrl: string;
  timeoutMs: number;
}

/** 브릿지VAN이 주는 등록 한 건 */
export interface VanRegistrationDto {
  tid: string;
  serialNo: string;
  merchantCode: string;
  status: VanStatus;
  updatedAt: Date;
}

export interface VanPage {
  items: VanRegistrationDto[];
  nextCursor: string | null;
}

const STATUSES = new Set<string>(Object.values(VanStatus));

function parseItem(raw: unknown): VanRegistrationDto {
  const r = raw as Record<string, unknown> | null;
  const updatedAt = typeof r?.updatedAt === 'string' ? new Date(r.updatedAt) : null;
  if (
    !r ||
    typeof r.tid !== 'string' ||
    typeof r.serialNo !== 'string' ||
    typeof r.merchantCode !== 'string' ||
    typeof r.status !== 'string' ||
    !STATUSES.has(r.status) ||
    !updatedAt ||
    Number.isNaN(updatedAt.getTime())
  ) {
    throw new PartnerPermanentError(`브릿지VAN 등록 형식이 아닙니다: ${JSON.stringify(raw)?.slice(0, 200)}`);
  }
  return { tid: r.tid, serialNo: r.serialNo, merchantCode: r.merchantCode, status: r.status as VanStatus, updatedAt };
}

function parsePage(text: string): VanPage {
  let body: { items?: unknown; nextCursor?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    throw new PartnerPermanentError('브릿지VAN 응답이 JSON이 아닙니다.');
  }
  if (!Array.isArray(body.items) || (body.nextCursor !== null && typeof body.nextCursor !== 'string')) {
    throw new PartnerPermanentError('브릿지VAN 목록 응답 형식이 아닙니다(items, nextCursor).');
  }
  return { items: body.items.map(parseItem), nextCursor: body.nextCursor };
}

/**
 * 브릿지VAN(가상) 등록 단말기 API. 목록은 커서 페이지(offset이 아님, decisions/0033).
 * 실패는 partnerFetch가 429·5xx·4xx로 나눠 던진다(재시도는 부르는 쪽이 withPartnerRetry로).
 */
export class BridgevanClient {
  constructor(private readonly opts: BridgevanOptions) {}

  /** 한 페이지. cursor가 null이면 처음부터 */
  async list(cursor: string | null, limit: number): Promise<VanPage> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (cursor) q.set('cursor', cursor);
    return parsePage(await partnerFetch('브릿지VAN 목록', `${this.opts.baseUrl}/bridgevan/v1/terminals?${q}`, { method: 'GET' }, this.opts.timeoutMs));
  }

  /**
   * 시리얼로 등록 한 건(재검증용). 없으면 null. 같은 시리얼(serialKey)의 등록이 여럿 오면 수집과 같은 규칙(betterRegistration)으로 하나를 고른다
   * ("VAN에서 시리얼은 유일" 가정이 깨졌을 때, decisions/0033).
   */
  async findBySerial(serialNo: string): Promise<VanRegistrationDto | null> {
    const q = new URLSearchParams({ serialNo });
    const page = parsePage(await partnerFetch('브릿지VAN 시리얼 조회', `${this.opts.baseUrl}/bridgevan/v1/terminals?${q}`, { method: 'GET' }, this.opts.timeoutMs));
    const key = serialKey(serialNo);
    const same = page.items.filter((r) => serialKey(r.serialNo) === key);
    return same.length === 0 ? null : same.reduce((a, b) => betterRegistration(a, b));
  }
}
