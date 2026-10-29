import { Route, Routes } from 'react-router';
import { AuthGate } from './components/AuthGate';
import { SessionCacheSync } from './components/SessionCacheSync';
import { Shell } from './components/Shell';
import { CallsPage } from './pages/CallsPage';
import { DocsPage } from './pages/DocsPage';
import { LoginPage } from './pages/LoginPage';
import { PartnerDetailPage } from './pages/PartnerDetailPage';
import { PartnersPage } from './pages/PartnersPage';

/** 화면 경로. /login 말고는 모두 ADMIN 계정으로 로그인해야 보인다(AuthGate, decisions/0080) */
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
          <Route index element={<PartnersPage />} />
          <Route path="partners/:id" element={<PartnerDetailPage />} />
          <Route path="calls" element={<CallsPage />} />
          <Route path="docs" element={<DocsPage />} />
          <Route path="*" element={<p>없는 화면입니다.</p>} />
        </Route>
      </Routes>
    </>
  );
}
