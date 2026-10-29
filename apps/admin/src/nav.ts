import type { Role } from '@terminal-ops/contracts';
import { OFFICE, STAFF } from './session';

/**
 * 왼쪽 메뉴. 화면을 더할 때 여기와 App.tsx의 Route를 함께 고친다.
 * roles: 이 메뉴를 보이는 역할 — 그 화면이 부르는 api의 역할(api decisions/0052)과 맞춘다. 숨겨도 주소로 들어오면 서버가 403으로 막는다.
 */
export const NAV: { to: string; label: string; roles: readonly Role[] }[] = [
  { to: '/', label: '처음', roles: OFFICE },
  { to: '/terminals', label: '단말기', roles: STAFF },
  { to: '/registrations', label: '단말기 등록', roles: ['OPERATOR'] },
  { to: '/scans', label: '박스 스캔', roles: ['OPERATOR', 'FIELD'] },
  { to: '/service-tickets', label: 'A/S', roles: OFFICE },
  { to: '/firmware-rollouts', label: '펌웨어 배포', roles: OFFICE },
  { to: '/reports/anomalies', label: '이상 단말기', roles: OFFICE },
  { to: '/reports/van', label: 'VAN 대조', roles: OFFICE },
  { to: '/reports/purchase-orders', label: '발주 입고 대조', roles: OFFICE },
  { to: '/reports/weekly', label: '주간 리포트', roles: OFFICE },
  { to: '/batch-runs', label: '배치 실행 이력', roles: OFFICE },
  { to: '/admin/accounts', label: '계정', roles: ['ADMIN'] },
];
