import { describe, expect, it } from 'vitest';
import { demoSeedAllowed } from '../../src/db/seed-accounts.js';

/** 시연 계정·시연 외부 업체 키(공개된 고정 값)는 운영(NODE_ENV=production)에서 넣지 않는다(decisions/0054) */
describe('demoSeedAllowed', () => {
  it('개발·테스트(NODE_ENV 없음·development·test)에서는 넣는다', () => {
    expect(demoSeedAllowed({})).toBe(true);
    expect(demoSeedAllowed({ NODE_ENV: 'development' })).toBe(true);
    expect(demoSeedAllowed({ NODE_ENV: 'test' })).toBe(true);
  });

  it('NODE_ENV=production이면 넣지 않는다 — 켜는 플래그도 없다', () => {
    expect(demoSeedAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(demoSeedAllowed({ NODE_ENV: 'production', SEED_DEMO: '1' })).toBe(false);
  });

  it('SEED_DEMO=0이면 개발에서도 넣지 않는다(기준 데이터만)', () => {
    expect(demoSeedAllowed({ SEED_DEMO: '0' })).toBe(false);
  });
});
