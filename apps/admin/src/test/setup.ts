import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { reloadOperatorForTest } from '../operator';

// globals를 켜지 않아 Testing Library가 자동으로 정리하지 않는다. 테스트마다 화면·fetch 가짜·작업자 이름을 비운다
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  reloadOperatorForTest();
});
