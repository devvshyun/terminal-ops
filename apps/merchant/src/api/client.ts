import type { ApiErrorBody, ErrorCode } from '@terminal-ops/contracts';
import { setMe } from '../session';

/**
 * api 호출 한 곳. 어드민 `apps/admin/src/api/client.ts`를 옮겨 온 것이다(공유 패키지로 빼지 않은 이유: decisions/0058) —
 * 오류 모양·401 처리 규칙이 같아야 하므로 고칠 때는 두 파일을 같이 본다. 어드민에만 있던 것(파일 내려받기 주소, version 충돌 판정)은 뺐다.
 */

/** 개발 서버 프록시가 Nest api로 넘기는 경로 앞부분(vite.config.ts) */
export const API_BASE = '/api';

/** api 오류 응답. 서버는 { statusCode, code?, message } 모양(contracts ApiErrorBody)으로 준다 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** 서버가 준 원인 코드(TICKET_ALREADY_OPEN …). 검증 오류(400)·404에는 없다 */
    readonly code: ErrorCode | null,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
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

/** 로그인 요청 자체의 401(LOGIN_FAILED)은 세션이 끝난 것이 아니다 */
const LOGIN_PATH = '/auth/login';

/**
 * 로그인은 서버 세션 쿠키(httpOnly, 같은 출처라 브라우저가 붙인다 — api decisions/0050)라 여기서 붙이는 인증 헤더는 없다.
 * 2xx가 아니면 ApiError를 던진다. 401이면 로그인 정보를 비워 AuthGate가 로그인 화면으로 보낸다.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
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
    if (res.status === 401 && path !== LOGIN_PATH) setMe(null);
    const code = (body as Partial<ApiErrorBody> | null)?.code;
    throw new ApiError(res.status, typeof code === 'string' ? code : null, messageOf(res.status, body), body);
  }
  return body as T;
}
