import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { keys } from '../api/query-keys';
import type { TerminalImportView } from '@terminal-ops/contracts';
import { App } from '../App';
import { loginAs, mockApi, renderPage, type Call } from '../test/render';
import { fileProblem, RegistrationPage } from './RegistrationPage';

const MODELS = { 'GET /terminal-models': () => ({ body: [{ code: 'SN-100', name: '유선 카운터형', requiresReinspection: false }] }) };

const importBody: TerminalImportView = {
  fileName: '입고-1028.xlsx',
  total: 3,
  summary: { CREATED: 1, ALREADY_EXISTS: 1, INVALID_FORMAT: 1 },
  results: [
    { row: 2, serialNo: 'XL-0001', result: 'CREATED' },
    { row: 3, serialNo: 'XL-0002', result: 'ALREADY_EXISTS', message: '이미 등록된 시리얼입니다.' },
    { row: 4, serialNo: 'bad', result: 'INVALID_FORMAT', message: 'serialNo는 대문자·숫자·하이픈 4~32자입니다.' },
  ],
};

const xlsx = (name = '입고-1028.xlsx', size = 10) => new File([new Uint8Array(size)], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

describe('단말기 등록 — 한 대 (F1, 보강 5)', () => {
  it('시리얼 형식이 틀리면 안내하고 등록 버튼이 꺼진다. 맞으면 POST /terminals로 보내고 등록된 단말기 링크를 보인다', async () => {
    const { calls } = mockApi({
      ...MODELS,
      'POST /terminals': (c: Call) => ({
        status: 201,
        body: { ...(c.body as object), modelName: '유선 카운터형', merchantCode: null, merchantName: null, status: 'RECEIVED', statusChangedAt: '2026-10-29T01:00:00.000Z', version: 1, createdAt: '2026-10-29T01:00:00.000Z', updatedAt: '2026-10-29T01:00:00.000Z' },
      }),
    });
    loginAs();
    renderPage(<RegistrationPage />);
    const form = screen.getByRole('form', { name: '한 대 등록' });
    await within(form).findByRole('option', { name: 'SN-100 유선 카운터형' }); // 모델 목록이 온 뒤에 고른다
    await userEvent.selectOptions(within(form).getByLabelText('모델'), 'SN-100');
    await userEvent.type(within(form).getByLabelText('시리얼'), 'sn-1');
    expect(within(form).getByText('시리얼은 대문자·숫자·하이픈 4~32자입니다.')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: '등록' })).toBeDisabled();

    await userEvent.clear(within(form).getByLabelText('시리얼'));
    await userEvent.type(within(form).getByLabelText('시리얼'), 'NEW-0001');
    await userEvent.click(within(form).getByRole('button', { name: '등록' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('NEW-0001 등록됨 · 입고');
    expect(within(form).getByRole('link', { name: 'NEW-0001' })).toHaveAttribute('href', '/terminals/NEW-0001');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ serialNo: 'NEW-0001', modelCode: 'SN-100' });
    expect(within(form).getByLabelText('시리얼')).toHaveValue('');
  });

  it('이미 있는 시리얼(409 DUPLICATE)은 서버 메시지와 안내를 보인다', async () => {
    mockApi({ ...MODELS, 'POST /terminals': () => ({ status: 409, body: { statusCode: 409, code: 'DUPLICATE', message: '이미 있는 값입니다(serial_no).' } }) });
    loginAs();
    renderPage(<RegistrationPage />);
    const form = screen.getByRole('form', { name: '한 대 등록' });
    await within(form).findByRole('option', { name: 'SN-100 유선 카운터형' }); // 모델 목록이 온 뒤에 고른다
    await userEvent.selectOptions(within(form).getByLabelText('모델'), 'SN-100');
    await userEvent.type(within(form).getByLabelText('시리얼'), 'DUP-0001');
    await userEvent.click(within(form).getByRole('button', { name: '등록' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('DUPLICATE');
  });
});

describe('단말기 등록 — 리뷰 보강 (F1, 보강 5)', () => {
  it('한 대 등록이 성공하면 운영 현황(dashboard)도 다시 읽게 하고, 새 시리얼을 치기 시작하면 앞의 성공 문구를 지운다', async () => {
    mockApi({
      ...MODELS,
      'POST /terminals': (c: Call) => ({
        status: 201,
        body: { ...(c.body as object), modelName: '유선 카운터형', merchantCode: null, merchantName: null, status: 'RECEIVED', statusChangedAt: '2026-10-29T01:00:00.000Z', version: 1, createdAt: '2026-10-29T01:00:00.000Z', updatedAt: '2026-10-29T01:00:00.000Z' },
      }),
    });
    loginAs();
    const { client } = renderPage(<RegistrationPage />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const form = screen.getByRole('form', { name: '한 대 등록' });
    await within(form).findByRole('option', { name: 'SN-100 유선 카운터형' });
    await userEvent.selectOptions(within(form).getByLabelText('모델'), 'SN-100');
    await userEvent.type(within(form).getByLabelText('시리얼'), 'NEW-0001');
    await userEvent.click(within(form).getByRole('button', { name: '등록' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('NEW-0001 등록됨');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.dashboard });
    await userEvent.type(within(form).getByLabelText('시리얼'), 'N');
    expect(within(form).queryByRole('status')).not.toBeInTheDocument();
  });

  it('엑셀 일괄 등록이 성공하면 운영 현황(dashboard)도 다시 읽게 한다', async () => {
    mockApi({ ...MODELS, 'POST /terminals/imports': () => ({ status: 201, body: importBody }) });
    loginAs();
    const { client } = renderPage(<RegistrationPage />);
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await userEvent.upload(screen.getByLabelText('엑셀 파일'), xlsx());
    await userEvent.click(screen.getByRole('button', { name: '올리기' }));
    await screen.findByLabelText('등록 결과');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.dashboard });
  });

  it.each([
    ['FILE_TOO_LARGE', 413, '2MB'],
    ['INVALID_FILE', 400, '.xlsx'],
    ['MISSING_COLUMNS', 400, 'serialNo'],
    ['TOO_MANY_ROWS', 400, '5,000'],
  ])('파일째 거절 %s는 운영자가 할 일을 안내한다', async (code, status, hint) => {
    mockApi({ ...MODELS, 'POST /terminals/imports': () => ({ status, body: { statusCode: status, code, message: '서버 메시지' } }) });
    loginAs();
    renderPage(<RegistrationPage />);
    await userEvent.upload(screen.getByLabelText('엑셀 파일'), xlsx());
    await userEvent.click(screen.getByRole('button', { name: '올리기' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(code);
    expect(alert.querySelector('strong')?.textContent).toContain(hint);
  });
});

describe('단말기 등록 — 엑셀 일괄 (F1, 보강 5)', () => {
  it('파일 문제: .xlsx가 아니거나 2MB를 넘으면 올리기 전에 알린다', () => {
    expect(fileProblem(null)).toBeNull();
    expect(fileProblem(xlsx())).toBeNull();
    expect(fileProblem(xlsx('목록.csv'))).toBe('.xlsx 파일만 올릴 수 있습니다.');
    expect(fileProblem(xlsx('큰.XLSX', 2 * 1024 * 1024 + 1))).toBe('파일이 2MB를 넘습니다. 나눠서 올리세요.');
  });

  it('.xlsx가 아니면 올리기가 꺼지고 요청하지 않는다', async () => {
    const { calls } = mockApi(MODELS);
    loginAs();
    renderPage(<RegistrationPage />);
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(screen.getByLabelText('엑셀 파일'), xlsx('목록.csv'));
    expect(screen.getByText('.xlsx 파일만 올릴 수 있습니다.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '올리기' })).toBeDisabled();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('올리면 파일을 multipart file 필드로 보내고, 행별 결과·요약·실패한 행만·CSV 내려받기를 보인다', async () => {
    const { calls } = mockApi({ ...MODELS, 'POST /terminals/imports': () => ({ status: 201, body: importBody }) });
    loginAs();
    renderPage(<RegistrationPage />);
    const file = xlsx();
    await userEvent.upload(screen.getByLabelText('엑셀 파일'), file);
    await userEvent.click(screen.getByRole('button', { name: '올리기' }));

    const result = await screen.findByLabelText('등록 결과');
    expect(result).toHaveTextContent('입고-1028.xlsx · 3행 · 등록됨 1, 이미 등록됨 1, 형식 오류 1');
    const sent = calls.find((c) => c.path === '/terminals/imports')!;
    expect(sent.body).toBeInstanceOf(FormData);
    expect((sent.body as FormData).get('file')).toBe(file);
    expect(within(result).getAllByRole('row')).toHaveLength(4); // 머리글 + 3행

    await userEvent.click(within(result).getByLabelText('실패한 행만'));
    const rows = within(result).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      '3XL-0002이미 등록됨이미 등록된 시리얼입니다.',
      '4bad형식 오류serialNo는 대문자·숫자·하이픈 4~32자입니다.',
    ]);

    const link = within(result).getByRole('link', { name: '결과 내려받기(CSV)' });
    expect(link).toHaveAttribute('download', '입고-1028-결과.csv');
    const csv = decodeURIComponent(link.getAttribute('href')!.replace('data:text/csv;charset=utf-8,', ''));
    expect(csv.split('\r\n')).toEqual([
      '﻿row,serialNo,result,결과,이유',
      '2,XL-0001,CREATED,등록됨,',
      '3,XL-0002,ALREADY_EXISTS,이미 등록됨,이미 등록된 시리얼입니다.',
      '4,bad,INVALID_FORMAT,형식 오류,serialNo는 대문자·숫자·하이픈 4~32자입니다.',
    ]);
  });

  it('파일째 거절(400 MISSING_COLUMNS)이면 서버 메시지를 보이고 결과 표는 없다', async () => {
    mockApi({
      ...MODELS,
      'POST /terminals/imports': () => ({ status: 400, body: { statusCode: 400, code: 'MISSING_COLUMNS', message: '1행 머리글에 serialNo, modelCode 열이 있어야 합니다.' } }),
    });
    loginAs();
    renderPage(<RegistrationPage />);
    await userEvent.upload(screen.getByLabelText('엑셀 파일'), xlsx());
    await userEvent.click(screen.getByRole('button', { name: '올리기' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('1행 머리글에 serialNo, modelCode 열이 있어야 합니다.');
    expect(screen.queryByLabelText('등록 결과')).not.toBeInTheDocument();
  });
});

describe('단말기 등록 화면 — 역할 (보강 5)', () => {
  it('운영자 메뉴에 "단말기 등록"이 있고, 관제가 주소로 열면 권한 안내만(모델 목록도 부르지 않는다)', async () => {
    const { calls } = mockApi({ ...MODELS, 'GET /terminals': () => ({ body: { items: [], total: 0, page: 1, size: 20 } }) });
    loginAs('u', 'OPERATOR');
    const op = renderPage(<App />, { path: '/*', route: '/terminals' });
    expect(await within(screen.getByRole('navigation', { name: '메뉴' })).findByRole('link', { name: '단말기 등록' })).toHaveAttribute('href', '/registrations');
    op.unmount();

    loginAs('m', 'MONITOR');
    const before = calls.length;
    renderPage(<App />, { path: '/*', route: '/registrations' });
    expect(await screen.findByRole('alert')).toHaveTextContent('이 화면을 볼 권한이 없습니다');
    expect(within(screen.getByRole('navigation', { name: '메뉴' })).queryByRole('link', { name: '단말기 등록' })).not.toBeInTheDocument();
    await waitFor(() => expect(calls.slice(before).some((c) => c.path === '/terminal-models')).toBe(false));
  });
});
