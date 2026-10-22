/** 외부 업체(택배사·메신저) 호출 실패. 종류에 따라 재시도 여부가 갈린다(decisions/0010). */
export class PartnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 429. 기다렸다가 다시 하면 된다. */
export class PartnerRateLimitedError extends PartnerError {
  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

/** 5xx, 타임아웃, 연결 실패. 다시 하면 될 수도 있다. */
export class PartnerTransientError extends PartnerError {}

/** 4xx(429 제외), 응답 형식 오류. 다시 해도 같다. */
export class PartnerPermanentError extends PartnerError {}
