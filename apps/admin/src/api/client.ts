import type { ApiErrorBody, ErrorCode } from '@terminal-ops/contracts';
import { getOperator } from '../operator';

/** 개발 서버 프록시가 Nest api로 넘기는 경로 앞부분(vite.config.ts, decisions/0041) */
export const API_BASE = '/api';

/** api 오류 응답. 서버는 { statusCode, code?, message } 모양(contracts ApiErrorBody)으로 준다(DomainExceptionFilter, ValidationPipe) */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** 서버가 준 원인 코드(VERSION_CONFLICT, PO_CLOSED …). 검증 오류(400)·404에는 없다 */
    readonly code: ErrorCode | null,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** 낙관적 락 충돌: 화면에서 본 version이 낡았다(decisions/0004) */
  get isVersionConflict(): boolean {
    return this.status === 409 && this.code === 'VERSION_CONFLICT';
  }
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  query?: Query;
}

/** 빈 값(undefined·null·'')은 빼고 쿼리 문자열을 만든다 */
export function toQueryString(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function messageOf(status: number, body: unknown): string {
  const raw = (body as { message?: unknown } | null)?.message;
  if (Array.isArray(raw)) return raw.join(', '); // ValidationPipe는 항목별 메시지 배열을 준다
  if (typeof raw === 'string' && raw) return raw;
  return `HTTP ${status}`;
}

/**
 * api 호출 한 곳. 작업자 이름이 있으면 모든 요청에 X-Operator(URL 인코딩, decisions/0001·0041)를 붙인다.
 * 2xx가 아니면 ApiError를 던진다 — 화면은 ErrorBox로 code·message를 보여 준다.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const operator = getOperator();
  if (operator) headers['X-Operator'] = encodeURIComponent(operator);
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}${toQueryString(options.query)}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }
  if (!res.ok) {
    // 서버가 contracts 밖의 코드를 주지 않는다는 전제(api는 ErrorCode 유니온 밖의 코드를 컴파일하지 못한다, decisions/0048)
    const code = (body as Partial<ApiErrorBody> | null)?.code;
    throw new ApiError(res.status, typeof code === 'string' ? code : null, messageOf(res.status, body), body);
  }
  return body as T;
}

/** 파일 내려받기 주소(브라우저가 직접 연다 — 헤더가 필요 없는 GET만) */
export const downloadUrl = (path: string) => `${API_BASE}${path}`;
