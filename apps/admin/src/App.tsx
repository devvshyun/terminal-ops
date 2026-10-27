import { Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { HomePage } from './pages/HomePage';

/** 화면 경로. 메뉴(nav.ts)와 함께 고친다 */
export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="*" element={<p>없는 화면입니다.</p>} />
      </Route>
    </Routes>
  );
}
