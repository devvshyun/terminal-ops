import { describe, expect, it } from 'vitest';
import { appUrl } from './apps';

describe('다른 화면 주소', () => {
  it('env가 없으면 로컬 개발 서버, 있으면 그 주소 뒤에 경로', () => {
    expect(appUrl('admin', '/reports/anomalies', {})).toBe('http://localhost:5173/reports/anomalies');
    expect(appUrl('field', '/scan', { VITE_FIELD_APP_URL: 'http://field.localhost:8080' })).toBe('http://field.localhost:8080/scan');
    expect(appUrl('merchant', '/', { VITE_MERCHANT_APP_URL: 'javascript:alert(1)' })).toBe('http://localhost:5174/');
  });
});
