import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { OPERATOR_KEY, getOperator, reloadOperatorForTest } from '../operator';
import { mockApi, renderPage } from '../test/render';
import { WriteButton } from './WriteButton';

describe('틀과 작업자 이름 (decisions/0041)', () => {
  it('처음 화면은 api 연결(GET /health)을 보여 준다', async () => {
    mockApi({ 'GET /health': () => ({ body: { status: 'ok' } }) });
    renderPage(<App />, { path: '/*' });
    expect(await screen.findByText('ok')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: '메뉴' })).toBeInTheDocument();
  });

  it('api가 없으면 연결 실패와 오류를 보여 준다', async () => {
    mockApi({ 'GET /health': () => ({ status: 502, body: { statusCode: 502, code: 'PARTNER_ERROR', message: '연결 실패' } }) });
    renderPage(<App />, { path: '/*' });
    expect(await screen.findByRole('alert')).toHaveTextContent('PARTNER_ERROR');
  });

  it('작업자 이름을 저장하면 localStorage에 남고, 쓰기 버튼이 켜진다. 규칙에 어긋나면 저장하지 않는다', async () => {
    mockApi({ 'GET /health': () => ({ body: { status: 'ok' } }) });
    renderPage(
      <>
        <App />
        <WriteButton>바꾸기</WriteButton>
      </>,
      { path: '/*' },
    );
    expect(screen.getByRole('button', { name: '바꾸기' })).toBeDisabled();
    const input = screen.getByLabelText('작업자 이름');
    await userEvent.type(input, 'system:batch');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(screen.getByText(/시스템 작업 전용/)).toBeInTheDocument();
    expect(getOperator()).toBe('');

    await userEvent.clear(input);
    await userEvent.type(input, ' 박운영 ');
    await userEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(screen.getByText('지금: 박운영')).toBeInTheDocument();
    expect(window.localStorage.getItem(OPERATOR_KEY)).toBe('박운영');
    expect(screen.getByRole('button', { name: '바꾸기' })).toBeEnabled();
  });

  it('새로 열어도 저장한 작업자 이름을 다시 읽는다', () => {
    window.localStorage.setItem(OPERATOR_KEY, '최운영');
    reloadOperatorForTest();
    expect(getOperator()).toBe('최운영');
  });
});
