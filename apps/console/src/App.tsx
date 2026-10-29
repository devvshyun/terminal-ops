import { Route, Routes } from 'react-router';
import { AuthGate } from './components/AuthGate';
import { SessionCacheSync } from './components/SessionCacheSync';
import { Shell } from './components/Shell';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';

/** 화면 경로. /login 말고는 모두 관제·ADMIN 계정으로 로그인해야 보인다(AuthGate) */
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
          <Route index element={<DashboardPage />} />
          <Route path="*" element={<p>없는 화면입니다.</p>} />
        </Route>
      </Routes>
    </>
  );
}
