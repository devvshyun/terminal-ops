/**
 * 다른 화면(앱) 바로가기 — 주소는 이 파일 한 곳에 둔다(보강 5, decisions/0067).
 * 주소는 Vite env(`VITE_*_URL`, 개발 서버·빌드가 읽는다)로 바꾸고, 없으면 로컬 개발 서버 주소를 쓴다.
 * Docker로 띄울 때(이후 보강) 주소가 바뀌면 env만 주면 된다. 아직 없는 화면은 기본 주소가 null — 링크 대신 "준비 중"으로 보인다.
 * 새 화면이 생기면 그 보강이 여기 기본 주소 한 줄을 채운다.
 */
export interface OtherApp {
  key: string;
  label: string;
  /** 누가 쓰는 화면인가 */
  who: string;
  /** null이면 아직 없는 화면 */
  url: string | null;
}

type Env = Record<string, unknown>;

export function otherApps(env: Env = import.meta.env): OtherApp[] {
  const pick = (name: string, fallback: string | null) => {
    const value = env[name];
    const text = typeof value === 'string' ? value.trim() : '';
    // 링크로 쓰이므로 http·https만 받는다(javascript:·data: 같은 값은 env 실수여도 쓰지 않고 기본값)
    return /^https?:\/\//i.test(text) ? text : fallback;
  };
  return [
    { key: 'merchant', label: '매장 화면', who: '가맹점주', url: pick('VITE_MERCHANT_APP_URL', 'http://localhost:5174') },
    { key: 'field', label: '현장 화면', who: '현장 작업자', url: pick('VITE_FIELD_APP_URL', 'http://localhost:5175') },
    // 보강 6: 운영 관제 화면 apps/console(:5176, decisions/0074)
    { key: 'ops', label: '운영 관제', who: '관제·개발자', url: pick('VITE_OPS_APP_URL', 'http://localhost:5176') },
    { key: 'developers', label: '개발자센터', who: '외부 업체 연동(키 발급·폐기)', url: pick('VITE_DEVELOPERS_APP_URL', null) },
    { key: 'partners', label: '가상 업체 콘솔', who: '세움전자·번개택배·느림보물류·브릿지VAN·톡톡메신저', url: pick('VITE_PARTNERS_CONSOLE_URL', null) },
    { key: 'simulator', label: '단말기 시뮬레이터', who: '하트비트·펌웨어 보고', url: pick('VITE_SIMULATOR_APP_URL', null) },
  ];
}
