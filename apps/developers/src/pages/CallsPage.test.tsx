import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { call, callPage, partner, partnersApi } from '../test/fixtures';
import { loginAs, mockApi, renderApp } from '../test/render';

describe('호출 로그 화면 (보강 7, decisions/0082)', () => {
  it('최근부터 시각·업체·키·메서드·경로·상태·걸린 시간. 상태는 2xx·4xx·5xx로 색이 다르다', async () => {
    mockApi({
      ...partnersApi(),
      'GET /admin/partner-calls': () => ({ body: callPage([call(), call({ id: 99, status: 403 }), call({ id: 98, status: 500, durationMs: 1203 })]) }),
    });
    loginAs();
    renderApp('/calls');
    const table = await screen.findByRole('table', { name: '호출 로그' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('HANOL-POS');
    expect(rows[0]).toHaveTextContent('pk_a1b2c3d4');
    expect(rows[0]).toHaveTextContent('/partner/v1/terminals/SN100-2610-00401');
    expect(within(rows[0]).getByText('200')).toHaveClass('code-2xx');
    expect(within(rows[1]).getByText('403')).toHaveClass('code-4xx');
    expect(within(rows[2]).getByText('500')).toHaveClass('code-5xx');
    expect(rows[2]).toHaveTextContent('1203ms');
    expect(screen.getByText(/401\(키 없음·틀림·폐기\)은 남지 않습니다/)).toBeInTheDocument();
  });

  it('업체를 고르면 ?partnerId=, 더 보기는 ?beforeId=', async () => {
    const { calls } = mockApi({
      ...partnersApi([partner(), partner({ id: 2, code: 'DEMO', name: '데모' })]),
      'GET /admin/partner-calls': (c) => ({ body: c.query.get('beforeId') ? callPage([call({ id: 50 })]) : callPage([call({ id: 100 })], 100) }),
    });
    loginAs();
    renderApp('/calls');
    await screen.findByRole('table', { name: '호출 로그' });
    await userEvent.click(screen.getByRole('button', { name: '더 보기' }));
    await screen.findAllByText('HANOL-POS');
    expect(calls.filter((c) => c.path === '/admin/partner-calls').map((c) => c.query.get('beforeId'))).toEqual([null, '100']);
    await userEvent.selectOptions(screen.getByLabelText('업체'), 'DEMO');
    await screen.findByRole('table', { name: '호출 로그' });
    expect(calls.filter((c) => c.path === '/admin/partner-calls').at(-1)?.query.get('partnerId')).toBe('2');
  });

  it('호출이 없으면 안내', async () => {
    mockApi({ ...partnersApi(), 'GET /admin/partner-calls': () => ({ body: callPage([]) }) });
    loginAs();
    renderApp('/calls');
    expect(await screen.findByText('아직 남은 호출이 없습니다.')).toBeInTheDocument();
  });
});
