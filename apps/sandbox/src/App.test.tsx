import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { partnersApi } from './test/fixtures';
import { mockServers, renderApp } from './test/render';

describe('시연 도구 틀 (보강 8, decisions/0084)', () => {
  it('처음 주소는 가상 업체 화면, 위에 메뉴 둘과 "시연용 가짜 서버" 안내', async () => {
    mockServers(partnersApi());
    renderApp('/');
    expect(await screen.findByRole('heading', { name: '가상 업체' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: '메뉴' });
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['가상 업체', '단말기 시뮬레이터']);
    expect(screen.getByText(/시연용 가짜 서버/)).toBeInTheDocument();
  });

  it('두 서버는 /api/partners·/api/sim 아래로 부른다 — 화면 경로(/partners·/devices)와 프록시 앞마디가 겹치지 않게(최종 검토)', async () => {
    const { calls } = mockServers(partnersApi());
    renderApp('/partners');
    await screen.findByRole('heading', { name: '가상 업체' });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.url.startsWith('/api/partners/'))).toBe(true);
    // 프록시 앞마디가 화면 경로로 시작하거나 화면 경로가 프록시 앞마디로 시작하면, 그 화면을 새로 열 때 서버로 넘어간다
    const config = (await import('../vite.config')).default as { server: { proxy: Record<string, unknown> } };
    for (const prefix of Object.keys(config.server.proxy)) {
      for (const route of ['/partners', '/devices']) expect(route.startsWith(prefix) || prefix.startsWith(route), `${prefix} ↔ ${route}`).toBe(false);
    }
  });
});
