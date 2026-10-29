/// <reference types="vite/client" />

/** 다른 화면 바로가기 주소(src/apps.ts, decisions/0067). 없으면 기본 주소 */
interface ImportMetaEnv {
  readonly VITE_MERCHANT_APP_URL?: string;
  readonly VITE_FIELD_APP_URL?: string;
  readonly VITE_OPS_APP_URL?: string;
  readonly VITE_DEVELOPERS_APP_URL?: string;
  readonly VITE_PARTNERS_CONSOLE_URL?: string;
  readonly VITE_SIMULATOR_APP_URL?: string;
}
