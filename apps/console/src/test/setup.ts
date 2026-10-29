import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { resetSessionForTest } from '../session';

// globals를 켜지 않아 Testing Library가 자동으로 정리하지 않는다. 테스트마다 화면·fetch 가짜·로그인 정보를 비운다.
// 점주 앱 `apps/merchant/src/test/setup.ts`의 사본(decisions/0062) — 주석을 뺀 코드가 같아야 한다(`src/copies.test.ts`가 본다). 고칠 때는 두 앱을 같이 고친다
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetSessionForTest();
});
