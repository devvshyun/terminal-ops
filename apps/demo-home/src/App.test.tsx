import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { resetProgress } from './lib/progress';
import { baseApi, dashboard } from './test/fixtures';
import { loginAs, MONITOR, mockApi, OPERATOR, renderApp } from './test/render';

afterEach(() => resetProgress());

describe('시연 홈 틀 (보강 10, decisions/0092)', () => {
  it('로그인 전: 7막 목록·진행률 0, 운영자 아이디가 채워진 로그인, 실행 단추는 꺼지고 안내', async () => {
    mockApi(baseApi());
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: '막' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent?.replace(/\d+\/\d+$/, '').trim())).toEqual([
      '1한눈에',
      '2공장에서 창고로',
      '3가맹점까지',
      '4고장과 교체',
      '5택배사가 429를 낸다',
      '6펌웨어 배포와 자동 중단',
      '7단말기가 끊긴다',
    ]);
    expect(screen.getByText('0 / 22 단계')).toBeInTheDocument();
    expect(screen.getByLabelText('아이디')).toHaveValue('operator');
    expect(await screen.findByRole('heading', { name: '한눈에' })).toBeInTheDocument();
  });

  it('운영자로 로그인하면 이름이 보이고 실행할 수 있다', async () => {
    const { calls } = mockApi({ ...baseApi(), 'POST /auth/login': () => ({ body: OPERATOR }) });
    renderApp('/act/3');
    expect(screen.getByRole('button', { name: '실행: 재고 한 대를 강남김밥으로 출고' })).toBeDisabled();
    expect(screen.getAllByText('운영자로 로그인하면 실행할 수 있습니다').length).toBeGreaterThan(0);
    await userEvent.type(screen.getByLabelText('비밀번호'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByText('운영자(시연)')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({ loginId: 'operator', password: 'pw' });
    expect(screen.getByRole('button', { name: '실행: 재고 한 대를 강남김밥으로 출고' })).toBeEnabled();
  });

  it('로그인 전에 401로 비어 있던 결과 패널이 로그인하면 다시 읽힌다(리허설에서 찾음)', async () => {
    let loggedIn = false;
    mockApi({
      ...baseApi(),
      'GET /dashboard/summary': () => (loggedIn ? { body: dashboard() } : { status: 401, body: { statusCode: 401, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' } }),
      'POST /auth/login': () => {
        loggedIn = true;
        return { body: OPERATOR };
      },
    });
    renderApp('/act/1');
    const card = await screen.findByRole('region', { name: '처음 화면 숫자' });
    expect(await within(card).findByRole('alert')).toHaveTextContent('로그인');
    await userEvent.type(screen.getByLabelText('비밀번호'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: '로그인' }));
    // 로그인하면 가운데를 새로 그린다 — 카드를 다시 찾는다
    const fresh = await screen.findByText('운영 중 12 · 온라인 11 · 오프라인 1');
    expect(within(screen.getByRole('region', { name: '처음 화면 숫자' })).queryByRole('alert')).not.toBeInTheDocument();
    expect(fresh).toBeInTheDocument();
  });

  it('운영자가 아니면(관제) 결과는 보이고 실행은 안내', async () => {
    mockApi({ ...baseApi(), 'GET /auth/me': () => ({ body: MONITOR }) });
    loginAs(MONITOR);
    renderApp('/act/3');
    expect(await screen.findByRole('button', { name: '실행: 재고 한 대를 강남김밥으로 출고' })).toBeDisabled();
    expect(screen.getAllByText('실행은 운영자(operator)만 — 지금은 관제(시연)').length).toBeGreaterThan(0);
  });

  it('"끝냄"을 누르면 진행률이 오르고, 처음 상태로 하면 0', async () => {
    mockApi({ ...baseApi(), 'GET /auth/me': () => ({ body: OPERATOR }) });
    loginAs();
    renderApp('/act/1');
    await userEvent.click((await screen.findAllByRole('checkbox', { name: '끝냄' }))[0]);
    expect(screen.getByText('1 / 22 단계')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: '막' })).getByRole('link', { name: /한눈에/ })).toHaveTextContent('1/2');
    await userEvent.click(screen.getByRole('button', { name: '처음 상태로' }));
    expect(screen.getByText('0 / 22 단계')).toBeInTheDocument();
  });
});
