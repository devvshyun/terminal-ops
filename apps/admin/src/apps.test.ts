import { describe, expect, it } from 'vitest';
import { otherApps } from './apps';

const urls = (env: Record<string, unknown>) => Object.fromEntries(otherApps(env).map((a) => [a.key, a.url]));

describe('다른 화면 주소 — 한 곳(apps.ts)과 env (보강 5, decisions/0067)', () => {
  it('env가 없으면 로컬 개발 서버 주소(보강 8로 여섯 화면 모두 있다)', () => {
    expect(urls({})).toEqual({
      merchant: 'http://localhost:5174',
      field: 'http://localhost:5175',
      ops: 'http://localhost:5176',
      developers: 'http://localhost:5178',
      partners: 'http://localhost:5179/partners',
      simulator: 'http://localhost:5179/devices',
    });
  });

  it('VITE_*_URL이 있으면 그 주소(앞뒤 공백은 지운다), 빈 값은 없는 것과 같다', () => {
    expect(
      urls({
        VITE_MERCHANT_APP_URL: ' http://merchant.demo:8081 ',
        VITE_FIELD_APP_URL: '',
        VITE_DEVELOPERS_APP_URL: 'http://developers.demo:8083',
      }),
    ).toMatchObject({ merchant: 'http://merchant.demo:8081', field: 'http://localhost:5175', developers: 'http://developers.demo:8083', ops: 'http://localhost:5176' });
  });

  it('http·https가 아닌 주소(javascript: 등)나 스킴 없는 값, 공백만 있는 값은 쓰지 않고 기본값', () => {
    expect(
      urls({
        VITE_MERCHANT_APP_URL: 'javascript:alert(1)',
        VITE_FIELD_APP_URL: 'merchant.demo:8081',
        VITE_OPS_APP_URL: '   ',
        VITE_DEVELOPERS_APP_URL: 'data:text/html,x',
        VITE_SIMULATOR_APP_URL: 'HTTPS://sim.demo',
      }),
    ).toMatchObject({ merchant: 'http://localhost:5174', field: 'http://localhost:5175', ops: 'http://localhost:5176', developers: 'http://localhost:5178', simulator: 'HTTPS://sim.demo' });
  });

  it('테스트 실행(vitest)의 import.meta.env를 기본으로 읽는다 — VITE_ 주소를 주지 않았으면 기본 주소', () => {
    expect(otherApps().find((a) => a.key === 'merchant')?.url).toBe('http://localhost:5174');
  });
});
