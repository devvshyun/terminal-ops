import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { resetSessionForTest } from '../session';

// 현장 앱 `apps/field/src/test/setup.ts`에 사본이 있다 — 같이 고친다(decisions/0062, 현장 `src/copies.test.ts`가 코드 차이를 본다)
// globals를 켜지 않아 Testing Library가 자동으로 정리하지 않는다. 테스트마다 화면·fetch 가짜·로그인 정보를 비운다(어드민과 같다)
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetSessionForTest();
});
