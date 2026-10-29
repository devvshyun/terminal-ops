import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { AuthGate } from './components/AuthGate';
import { Layout } from './components/Layout';
import { RequireRole } from './components/RequireRole';
import { SessionCacheSync } from './components/SessionCacheSync';
import { LoginPage } from './pages/LoginPage';
import { useMe } from './session';
import { AccountsPage } from './pages/AccountsPage';
import { BatchHistoryPage } from './pages/BatchHistoryPage';
import { AnomaliesPage } from './pages/reports/AnomaliesPage';
import { PurchaseOrdersPage } from './pages/reports/PurchaseOrdersPage';
import { VanRunDetailPage } from './pages/reports/VanRunDetailPage';
import { VanRunsPage } from './pages/reports/VanRunsPage';
import { WeeklyReportsPage } from './pages/reports/WeeklyReportsPage';
import { HomePage } from './pages/HomePage';
import { RegistrationPage } from './pages/RegistrationPage';
import { RolloutsPage } from './pages/RolloutsPage';
import { ScanPage } from './pages/ScanPage';
import { ServiceTicketDetailPage } from './pages/ServiceTicketDetailPage';
import { ServiceTicketsPage } from './pages/ServiceTicketsPage';
import { TerminalDetailPage } from './pages/TerminalDetailPage';
import { TerminalListPage } from './pages/TerminalListPage';

/** 화면에 메뉴(nav.ts)와 같은 역할 검사를 건다 — 주소로 직접 열어도 권한이 없으면 안내(RequireRole). 상세 화면은 목록 메뉴의 경로를 넘긴다 */
const guard = (nav: string, page: ReactElement) => <RequireRole nav={nav}>{page}</RequireRole>;

/** 처음 화면(운영 현황)은 사무실 역할용. 현장 작업자는 박스 스캔이 처음 화면이다 */
function Home() {
  return useMe()?.role === 'FIELD' ? <Navigate to="/scans" replace /> : guard('/', <HomePage />);
}

/** 화면 경로. 메뉴(nav.ts)와 함께 고친다. /login 말고는 모두 로그인해야 보인다(AuthGate) */
export function App() {
  return (
    <>
      <SessionCacheSync />
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route
          element={
            <AuthGate>
              <Layout />
            </AuthGate>
          }
        >
          <Route index element={<Home />} />
          <Route path="terminals" element={guard('/terminals', <TerminalListPage />)} />
          <Route path="terminals/:serialNo" element={guard('/terminals', <TerminalDetailPage />)} />
          <Route path="registrations" element={guard('/registrations', <RegistrationPage />)} />
          <Route path="scans" element={guard('/scans', <ScanPage />)} />
          <Route path="service-tickets" element={guard('/service-tickets', <ServiceTicketsPage />)} />
          <Route path="service-tickets/:id" element={guard('/service-tickets', <ServiceTicketDetailPage />)} />
          <Route path="firmware-rollouts" element={guard('/firmware-rollouts', <RolloutsPage />)} />
          <Route path="reports/anomalies" element={guard('/reports/anomalies', <AnomaliesPage />)} />
          <Route path="reports/van" element={guard('/reports/van', <VanRunsPage />)} />
          <Route path="reports/van/:id" element={guard('/reports/van', <VanRunDetailPage />)} />
          <Route path="reports/purchase-orders" element={guard('/reports/purchase-orders', <PurchaseOrdersPage />)} />
          <Route path="reports/weekly" element={guard('/reports/weekly', <WeeklyReportsPage />)} />
          <Route path="batch-runs" element={guard('/batch-runs', <BatchHistoryPage />)} />
          <Route path="admin/accounts" element={guard('/admin/accounts', <AccountsPage />)} />
          <Route path="*" element={<p>없는 화면입니다.</p>} />
        </Route>
      </Routes>
    </>
  );
}
