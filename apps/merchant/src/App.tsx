import { Route, Routes } from 'react-router';
import { AuthGate } from './components/AuthGate';
import { SessionCacheSync } from './components/SessionCacheSync';
import { Shell } from './components/Shell';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { NewTicketPage } from './pages/NewTicketPage';
import { ServiceTicketDetailPage } from './pages/ServiceTicketDetailPage';
import { ServiceTicketsPage } from './pages/ServiceTicketsPage';
import { TerminalDetailPage } from './pages/TerminalDetailPage';

/** 화면 경로. /login 말고는 모두 가맹점 계정으로 로그인해야 보인다(AuthGate) */
export function App() {
  return (
    <>
      <SessionCacheSync />
      <Routes>
        <Route path="login" element={<LoginPage />} />
        <Route
          element={
            <AuthGate>
              <Shell />
            </AuthGate>
          }
        >
          <Route index element={<HomePage />} />
          <Route path="terminals/:serialNo" element={<TerminalDetailPage />} />
          <Route path="service-tickets" element={<ServiceTicketsPage />} />
          <Route path="service-tickets/new" element={<NewTicketPage />} />
          <Route path="service-tickets/:id" element={<ServiceTicketDetailPage />} />
          <Route path="*" element={<p>없는 화면입니다.</p>} />
        </Route>
      </Routes>
    </>
  );
}
