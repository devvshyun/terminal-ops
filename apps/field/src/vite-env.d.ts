/// <reference types="vite/client" />

/** 넓은 화면 안내의 어드민 주소(lib/admin-link.ts, decisions/0067과 같은 방식). 없으면 로컬 어드민 개발 서버 */
interface ImportMetaEnv {
  readonly VITE_ADMIN_APP_URL?: string;
}
