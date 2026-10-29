/** 업체가 받은 요청 한 줄(시연 도구의 "최근 요청" 표, 보강 8 — decisions/0085) */
export interface RequestRecord {
  id: number;
  at: string;
  /** 경로 첫 마디(bungae·neurimbo·seum·bridgevan·toktok, 없는 경로면 그 마디 그대로) */
  partner: string;
  method: string;
  /** 쿼리 포함 경로(느림보 추적은 쿼리에 운송장 번호가 있다) */
  path: string;
  status: number;
  ms: number;
}

/** 남기는 최대 수. 넘으면 오래된 것부터 버린다(메모리만 — 재시작·reset이면 사라진다) */
export const MAX_REQUESTS = 200;

/** 최근 요청 고리. 관리 API(`/__admin`)는 넣지 않는다 — 시연 도구가 5초마다 읽는 요청으로 기록이 채워지지 않게 */
export class RequestLog {
  private rows: RequestRecord[] = [];
  private nextId = 1;
  /** 지금까지 받은 업체 요청 수(버린 것 포함) */
  total = 0;

  add(row: Omit<RequestRecord, 'id'>): void {
    this.total += 1;
    this.rows.push({ id: this.nextId++, ...row });
    if (this.rows.length > MAX_REQUESTS) this.rows.shift();
  }

  /** 최근부터 limit개 */
  recent(limit: number): RequestRecord[] {
    return this.rows.slice(-limit).reverse();
  }

  clear(): void {
    this.rows = [];
    this.nextId = 1;
    this.total = 0;
  }
}
