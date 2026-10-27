/**
 * AUTH_TEST_HEADERS=1이면 AuthGuard가 세션 쿠키가 없는 요청을 `X-Operator`(로그인 아이디)·`X-Test-Role`(역할) 헤더로 받아 준다(decisions/0056).
 * 기존 api 테스트 453개가 로그인 없이 그대로 돌게 하는 **테스트 전용** 길이다. 누구나 헤더로 운영자가 될 수 있으므로
 * NODE_ENV=test가 아니면 켤 수 없다 — 켜려고 하면 env를 읽는 순간(서버 시작) 던진다.
 */
export function resolveAuthTestHeaders(raw: string | undefined, nodeEnv: string | undefined): boolean {
  if (raw !== '1' && raw !== 'true') return false;
  if (nodeEnv !== 'test') {
    throw new Error('AUTH_TEST_HEADERS는 테스트(NODE_ENV=test)에서만 켤 수 있습니다. 헤더만으로 누구나 로그인한 것처럼 됩니다(decisions/0056).');
  }
  return true;
}
