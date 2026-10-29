import { describe, expect, it } from 'vitest';
import { adminScanUrl } from './admin-link';

describe('어드민 박스 스캔 주소(넓은 화면 안내, decisions/0077)', () => {
  it('env가 없으면 로컬 어드민 개발 서버', () => {
    expect(adminScanUrl({})).toBe('http://localhost:5173/scans');
  });

  it('env 주소를 쓰고 끝 슬래시는 하나로', () => {
    expect(adminScanUrl({ VITE_ADMIN_APP_URL: ' https://admin.demo:8080/ ' })).toBe('https://admin.demo:8080/scans');
  });

  it('쿼리가 있어도 경로 끝에 붙이고, 하위 경로에 올린 어드민은 그 경로 아래로', () => {
    expect(adminScanUrl({ VITE_ADMIN_APP_URL: 'https://admin.demo/?x=1' })).toBe('https://admin.demo/scans?x=1');
    expect(adminScanUrl({ VITE_ADMIN_APP_URL: 'https://demo.test/admin/' })).toBe('https://demo.test/admin/scans');
  });

  it('http·https가 아닌 값은 쓰지 않는다(링크로 쓰인다)', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'admin.demo', '   ', 3]) {
      expect(adminScanUrl({ VITE_ADMIN_APP_URL: bad })).toBe('http://localhost:5173/scans');
    }
  });
});
