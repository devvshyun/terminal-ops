/** 왼쪽 메뉴. 화면을 더할 때 여기와 App.tsx의 Route를 함께 고친다 */
export const NAV: { to: string; label: string }[] = [
  { to: '/', label: '처음' },
  { to: '/terminals', label: '단말기' },
  { to: '/scans', label: '박스 스캔' },
];
