import { Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { BatchHistoryPage } from './pages/BatchHistoryPage';
import { AnomaliesPage } from './pages/reports/AnomaliesPage';
import { PurchaseOrdersPage } from './pages/reports/PurchaseOrdersPage';
import { VanRunDetailPage } from './pages/reports/VanRunDetailPage';
import { VanRunsPage } from './pages/reports/VanRunsPage';
import { WeeklyReportsPage } from './pages/reports/WeeklyReportsPage';
import { HomePage } from './pages/HomePage';
import { RolloutsPage } from './pages/RolloutsPage';
import { ScanPage } from './pages/ScanPage';
import { ServiceTicketDetailPage } from './pages/ServiceTicketDetailPage';
import { ServiceTicketsPage } from './pages/ServiceTicketsPage';
import { TerminalDetailPage } from './pages/TerminalDetailPage';
import { TerminalListPage } from './pages/TerminalListPage';

/** 화면 경로. 메뉴(nav.ts)와 함께 고친다 */
export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="terminals" element={<TerminalListPage />} />
        <Route path="terminals/:serialNo" element={<TerminalDetailPage />} />
        <Route path="scans" element={<ScanPage />} />
        <Route path="service-tickets" element={<ServiceTicketsPage />} />
        <Route path="service-tickets/:id" element={<ServiceTicketDetailPage />} />
        <Route path="firmware-rollouts" element={<RolloutsPage />} />
        <Route path="reports/anomalies" element={<AnomaliesPage />} />
        <Route path="reports/van" element={<VanRunsPage />} />
        <Route path="reports/van/:id" element={<VanRunDetailPage />} />
        <Route path="reports/purchase-orders" element={<PurchaseOrdersPage />} />
        <Route path="reports/weekly" element={<WeeklyReportsPage />} />
        <Route path="batch-runs" element={<BatchHistoryPage />} />
        <Route path="*"element={<p>없는 화면입니다.</p>} />
      </Route>
    </Routes>
  );
}
