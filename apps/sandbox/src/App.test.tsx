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
});
