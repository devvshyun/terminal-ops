import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { dashboardBody } from '../test/fixtures';
import { loginAs, mockApi, renderPage } from '../test/render';
import { WriteButton } from './WriteButton';

const HOME = { 'GET /health': () => ({ body: { status: 'ok' } }), 'GET /dashboard/summary': () => ({ body: dashboardBody() }) };

describe('틀 — 로그인한 사람과 역할별 메뉴 (decisions/0041, api decisions/0052)', () => {
  it('처음 화면은 api 연결(GET /health)을 보여 준다', async () => {
    mockApi(HOME);
    loginAs();
    renderPage(<App />, { path: '/*' });
    expect(await screen.findByText('ok')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '메뉴' })).toBeInTheDocument();
  });

  it('api가 없으면 연결 실패와 오류를 보여 준다', async () => {
    mockApi({
      'GET /health': () => ({ status: 502, body: { statusCode: 502, code: 'PARTNER_ERROR', message: '연결 실패' } }),
      'GET /dashboard/summary': () => ({ body: dashboardBody() }),
    });
    loginAs();
    renderPage(<App />, { path: '/*' });
    expect(await screen.findByRole('alert')).toHaveTextContent('PARTNER_ERROR');
  });

  it('위쪽에 표시 이름·아이디·역할, 작업자 이름 입력칸은 없다', async () => {
    mockApi(HOME);
    loginAs('박운영');
    renderPage(<App />, { path: '/*' });
    expect(await screen.findByText('박운영')).toBeInTheDocument();
    expect(screen.getByLabelText('역할')).toHaveTextContent('운영자');
    expect(screen.queryByLabelText('작업자 이름')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeInTheDocument();
  });

  it('메뉴는 역할에 맞는 것만 — 관제는 박스 스캔이 없고, 운영자는 모두', async () => {
    mockApi(HOME);
    loginAs('관제1', 'MONITOR');
    renderPage(<App />, { path: '/*' });
    const nav = await screen.findByRole('navigation', { name: '메뉴' });
    expect(within(nav).queryByRole('link', { name: '박스 스캔' })).not.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: '단말기' })).toBeInTheDocument();
    expect(within(nav).getAllByRole('link')).toHaveLength(9);
  });

  it('왼쪽 아래 "다른 화면": 매장·현장·관제·개발자센터는 새 탭 링크, 아직 없는 화면 둘은 준비 중(링크 아님). 메뉴 링크 수에는 들지 않는다(보강 5·6·7)', async () => {
    mockApi(HOME);
    loginAs('관제1', 'MONITOR');
    renderPage(<App />, { path: '/*' });
    const others = await screen.findByRole('navigation', { name: '다른 화면' });
    expect(within(others).getByRole('link', { name: '매장 화면' })).toHaveAttribute('href', 'http://localhost:5174');
    expect(within(others).getByRole('link', { name: '현장 화면' })).toHaveAttribute('target', '_blank');
    expect(within(others).getByRole('link', { name: '운영 관제' })).toHaveAttribute('href', 'http://localhost:5176');
    expect(within(others).getByRole('link', { name: '개발자센터' })).toHaveAttribute('href', 'http://localhost:5178');
    expect(within(others).getAllByRole('link')).toHaveLength(4);
    for (const name of ['가상 업체 콘솔', '단말기 시뮬레이터']) expect(within(others).getByText(`${name}(준비 중)`)).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: '메뉴' })).getAllByRole('link')).toHaveLength(9);
  });

  it('쓰기 버튼: 로그인 정보가 없으면 꺼지고, 운영자면 켜지고, 역할이 아니면 보이지 않는다', () => {
    const { unmount } = renderPage(<WriteButton>바꾸기</WriteButton>);
    expect(screen.getByRole('button', { name: '바꾸기' })).toBeDisabled();
    unmount();
    loginAs('운영1', 'OPERATOR');
    const op = renderPage(<WriteButton>바꾸기</WriteButton>);
    expect(screen.getByRole('button', { name: '바꾸기' })).toBeEnabled();
    op.unmount();
    loginAs('관제1', 'MONITOR');
    renderPage(
      <>
        <WriteButton>바꾸기</WriteButton>
        <WriteButton roles={['OPERATOR', 'MONITOR']}>찾기</WriteButton>
      </>,
    );
    expect(screen.queryByRole('button', { name: '바꾸기' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '찾기' })).toBeEnabled();
  });
});
