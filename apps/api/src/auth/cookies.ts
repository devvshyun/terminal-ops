/** 세션 쿠키 이름(decisions/0050) */
export const SESSION_COOKIE = 'sid';

/**
 * Cookie 헤더에서 이름 하나의 값을 꺼낸다(cookie-parser 의존성 없이). 값은 우리가 만든 base64url이라 디코드하지 않는다.
 * 같은 이름이 여러 번 오면 처음 것.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}
