import { Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { HomePage } from './pages/HomePage';
import { ScanPage } from './pages/ScanPage';
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
        <Route path="*" element={<p>없는 화면입니다.</p>} />
      </Route>
    </Routes>
  );
}
