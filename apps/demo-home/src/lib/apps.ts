/**
 * 다른 화면 주소(어드민 `src/apps.ts`와 같은 규칙, decisions/0067). Vite env로 바꾸고, 없거나 http·https가 아니면 로컬 개발 서버.
 * 시연 묶음은 web 이미지가 `*.localhost:8080` 주소를 넣어 빌드한다(decisions/0088).
 */
type Env = Record<string, unknown>;
export type AppKey = 'admin' | 'merchant' | 'field' | 'console' | 'developers' | 'sandbox';

const DEFAULTS: Record<AppKey, [string, string]> = {
  admin: ['VITE_ADMIN_APP_URL', 'http://localhost:5173'],
  merchant: ['VITE_MERCHANT_APP_URL', 'http://localhost:5174'],
  field: ['VITE_FIELD_APP_URL', 'http://localhost:5175'],
  console: ['VITE_OPS_APP_URL', 'http://localhost:5176'],
  developers: ['VITE_DEVELOPERS_APP_URL', 'http://localhost:5178'],
  sandbox: ['VITE_SANDBOX_APP_URL', 'http://localhost:5179'],
};

/** 그 앱의 경로 주소. path는 '/'로 시작 */
export function appUrl(app: AppKey, path = '/', env: Env = import.meta.env): string {
  const [name, fallback] = DEFAULTS[app];
  const value = env[name];
  const text = typeof value === 'string' ? value.trim() : '';
  const url = new URL(/^https?:\/\//i.test(text) ? text : fallback);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  return url.toString();
}
