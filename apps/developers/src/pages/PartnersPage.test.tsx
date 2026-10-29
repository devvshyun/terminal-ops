import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { partner, partnersApi, partnerKey, callPage } from '../test/fixtures';
import { loginAs, mockApi, renderApp } from '../test/render';

describe('외부 업체 화면 (보강 7)', () => {
  it('업체마다 코드·이름·살아 있는 키/전체·마지막 사용, 이름은 업체 화면으로 가는 링크', async () => {
    mockApi(partnersApi([partner(), partner({ id: 2, code: 'DEMO', name: '데모 연동 업체(시연)', memo: null, activeKeys: 0, totalKeys: 0, lastUsedAt: null })]));
    loginAs();
    renderApp('/');
    const table = await screen.findByRole('table', { name: '외부 업체 목록' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(['HANOL-POS', 'DEMO']);
    expect(within(rows[0]).getByRole('link', { name: '한올POS' })).toHaveAttribute('href', '/partners/1');
    expect(rows[0]).toHaveTextContent('1 / 2');
    expect(rows[0]).toHaveTextContent('5분 전');
    expect(rows[1]).toHaveTextContent('쓴 적 없음');
  });

  it('업체가 없으면 안내', async () => {
    mockApi(partnersApi([]));
    loginAs();
    renderApp('/');
    expect(await screen.findByText(/아직 등록한 업체가 없습니다/)).toBeInTheDocument();
  });

  it('등록하면 POST /admin/partners(코드는 대문자로) 뒤 그 업체 화면으로 간다', async () => {
    const created = partner({ id: 7, code: 'NEW-POS', name: '새 업체', memo: null, activeKeys: 0, totalKeys: 0, lastUsedAt: null });
    const list: ReturnType<typeof partner>[] = [];
    const { calls } = mockApi({
      'GET /admin/partners': () => ({ body: list }),
      'POST /admin/partners': () => {
        list.push(created);
        return { status: 201, body: created };
      },
      'GET /admin/partner-keys': () => ({ body: [] }),
      'GET /admin/partner-calls': () => ({ body: callPage([]) }),
    });
    loginAs();
    renderApp('/');
    await userEvent.type(await screen.findByLabelText('업체 코드'), 'new-pos');
    await userEvent.type(screen.getByLabelText('업체 이름'), '  새 업체 ');
    await userEvent.click(screen.getByRole('button', { name: '업체 등록' }));
    // 업체 화면: 목록을 다시 읽어 새 업체를 찾는다
    expect(await screen.findByRole('heading', { name: '새 업체' })).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ code: 'NEW-POS', name: '새 업체', memo: null });
  });

  it('코드 모양이 틀리면 단추가 꺼지고 규칙을 보인다. 같은 코드는 409 안내', async () => {
    mockApi({
      ...partnersApi([]),
      'POST /admin/partners': () => ({ status: 409, body: { statusCode: 409, code: 'DUPLICATE', message: '이미 존재하는 값입니다.' } }),
    });
    loginAs();
    renderApp('/');
    await userEvent.type(await screen.findByLabelText('업체 코드'), 'A');
    await userEvent.type(screen.getByLabelText('업체 이름'), '이름');
    expect(screen.getByRole('button', { name: '업체 등록' })).toBeDisabled();
    expect(screen.getByText('대문자·숫자·- 2~20자')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('업체 코드'), 'B');
    await userEvent.click(screen.getByRole('button', { name: '업체 등록' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('같은 코드의 업체가 이미 있습니다.');
  });

  it('키 목록 조회 예시는 쓰지 않는다(업체 화면에서만) — 처음 화면은 /admin/partners만 부른다', async () => {
    const { calls } = mockApi({ ...partnersApi(), 'GET /admin/partner-keys': () => ({ body: [partnerKey()] }) });
    loginAs();
    renderApp('/');
    await screen.findByRole('table', { name: '외부 업체 목록' });
    expect(calls.filter((c) => c.path.startsWith('/admin')).map((c) => c.path)).toEqual(['/admin/partners']);
  });
});
