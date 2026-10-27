/** 왼쪽 메뉴. 화면을 더할 때 여기와 App.tsx의 Route를 함께 고친다 */
export const NAV: { to: string; label: string }[] = [
  { to: '/', label: '처음' },
  { to: '/terminals', label: '단말기' },
  { to: '/scans', label: '박스 스캔' },
  { to: '/service-tickets', label: 'A/S' },
  { to: '/firmware-rollouts', label: '펌웨어 배포' },
  { to: '/reports/anomalies', label: '이상 단말기' },
  { to: '/reports/van', label: 'VAN 대조' },
  { to: '/reports/purchase-orders', label: '발주 입고 대조' },
  { to: '/reports/weekly', label: '주간 리포트' },
];
