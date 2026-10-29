import { Navigate, Route, Routes } from 'react-router';
import { Shell } from './components/Shell';
import { DevicesPage } from './pages/DevicesPage';
import { PartnersPage } from './pages/PartnersPage';

/** 화면 경로. 로그인 없음(decisions/0084) — 어드민 "다른 화면"이 /partners·/devices로 바로 연다 */
export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/partners" replace />} />
        <Route path="partners" element={<PartnersPage />} />
        <Route path="devices" element={<DevicesPage />} />
        <Route path="*" element={<p>없는 화면입니다.</p>} />
      </Route>
    </Routes>
  );
}
