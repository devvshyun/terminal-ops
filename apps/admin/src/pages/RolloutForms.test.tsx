import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FirmwareView, RolloutView } from '@terminal-ops/contracts';
import { loginAs, mockApi, renderPage, type Call } from '../test/render';
import { parseStages } from './RolloutForms';
import { RolloutsPage } from './RolloutsPage';

const MODELS = {
  'GET /terminal-models': () => ({
    body: [
      { code: 'SN-100', name: '유선 카운터형', requiresReinspection: false },
      { code: 'SN-300', name: '테이블오더 태블릿형', requiresReinspection: false },
    ],
  }),
};
const fw = (id: number, modelCode: string, version: string): FirmwareView => ({ id, modelCode, version, createdBy: 'kim', createdAt: '2026-10-29T01:00:00.000Z' });
const FIRMWARE = {
  'GET /firmware': (c: Call) => ({
    body: { items: c.query.get('modelCode') === 'SN-100' ? [fw(3, 'SN-100', '2.1.0'), fw(1, 'SN-100', '2.0.0')] : [], nextBeforeId: null },
  }),
};
const created = (over: Partial<RolloutView> = {}): RolloutView => ({
  id: 9,
  modelCode: 'SN-100',
  version: '2.1.0',
  status: 'RUNNING',
  stages: [10, 50, 100],
  currentStage: 0,
  failureThreshold: 0.3,
  minSamples: 3,
  stageTimeoutMs: 900_000,
  stageStartedAt: '2026-10-29T01:00:00.000Z',
  createdBy: 'kim',
  createdAt: '2026-10-29T01:00:00.000Z',
  finishedAt: null,
  endReason: null,
  stageStats: [
    { stage: 0, percent: 10, targets: 2, offered: 2, succeeded: 0, failed: 0, timedOut: 0 },
    { stage: 1, percent: 50, targets: 0, offered: 0, succeeded: 0, failed: 0, timedOut: 0 },
    { stage: 2, percent: 100, targets: 0, offered: 0, succeeded: 0, failed: 0, timedOut: 0 },
  ],
  ...over,
});
const EMPTY_LIST = { 'GET /firmware-rollouts': () => ({ body: { items: [], nextBeforeId: null } }) };

describe('단계 비율 읽기 parseStages (보강 5)', () => {
  it('쉼표·공백으로 나눈 누적 비율. 서버 규칙(1~10개, 1~100 정수, 커지는 순서, 마지막 100)을 미리 본다', () => {
    expect(parseStages('10, 50, 100')).toEqual({ stages: [10, 50, 100] });
    expect(parseStages(' 100 ')).toEqual({ stages: [100] });
    expect(parseStages('')).toEqual({ error: '단계 비율을 쉼표로 적으세요(예 10, 50, 100).' });
    expect(parseStages('50, 10, 100')).toEqual({ error: '단계 비율은 커지는 순서여야 합니다(누적 비율).' });
    expect(parseStages('10, 50')).toEqual({ error: '마지막 단계는 100이어야 합니다.' });
    expect(parseStages('0, 100')).toEqual({ error: '단계 비율은 1~100 사이 정수입니다.' });
    expect(parseStages('10.5, 100')).toEqual({ error: '단계 비율은 1~100 사이 정수입니다.' });
    expect(parseStages('1,2,3,4,5,6,7,8,9,10,100')).toEqual({ error: '단계는 10개까지입니다.' });
  });
});

describe('펌웨어 등록·배포 만들기 (F8, 보강 5)', () => {
  it('운영자가 아니면(관제) 등록·만들기 버튼이 없고 모델·펌웨어 목록을 부르지 않는다', async () => {
    const { calls } = mockApi(EMPTY_LIST);
    loginAs('m', 'MONITOR');
    renderPage(<RolloutsPage />);
    await waitFor(() => expect(calls.some((c) => c.path === '/firmware-rollouts')).toBe(true));
    expect(screen.queryByRole('button', { name: '펌웨어 등록' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '새 배포 만들기' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/terminal-models' || c.path === '/firmware')).toBe(false);
  });

  it('펌웨어 등록: 버전 형식이 틀리면 꺼지고, 맞으면 POST /firmware로 보낸다. 같은 버전은 409 DUPLICATE 안내', async () => {
    let dup = false;
    const { calls } = mockApi({
      ...EMPTY_LIST,
      ...MODELS,
      'POST /firmware': (c) => (dup ? { status: 409, body: { statusCode: 409, code: 'DUPLICATE', message: '이미 있는 값입니다.' } } : { status: 201, body: fw(5, 'SN-100', (c.body as { version: string }).version) }),
    });
    loginAs();
    renderPage(<RolloutsPage />);
    await userEvent.click(screen.getByRole('button', { name: '펌웨어 등록' }));
    const form = screen.getByRole('form', { name: '펌웨어 등록' });
    await within(form).findByRole('option', { name: 'SN-100 유선 카운터형' });
    await userEvent.selectOptions(within(form).getByLabelText('펌웨어 모델'), 'SN-100');
    await userEvent.type(within(form).getByLabelText('버전'), '2.2.0_beta');
    expect(within(form).getByText('버전은 영문·숫자·점·하이픈 1~20자입니다.')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: '등록' })).toBeDisabled();

    await userEvent.clear(within(form).getByLabelText('버전'));
    await userEvent.type(within(form).getByLabelText('버전'), '2.2.0');
    await userEvent.click(within(form).getByRole('button', { name: '등록' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('SN-100 2.2.0 등록됨');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ modelCode: 'SN-100', version: '2.2.0' });

    dup = true;
    await userEvent.type(within(form).getByLabelText('버전'), '2.2.0');
    await userEvent.click(within(form).getByRole('button', { name: '등록' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('이미 있는 값입니다');
  });

  it('배포 만들기: 모델을 고르면 그 모델의 등록 버전만 선택지. 확인을 받고 POST, 단계·임계치(%)·최소 표본·시간 제한(분)을 서버 단위로 바꿔 보낸다', async () => {
    const { calls } = mockApi({ ...EMPTY_LIST, ...MODELS, ...FIRMWARE, 'POST /firmware-rollouts': () => ({ status: 201, body: created() }) });
    loginAs();
    renderPage(<RolloutsPage />);
    await userEvent.click(screen.getByRole('button', { name: '새 배포 만들기' }));
    const form = screen.getByRole('form', { name: '배포 만들기' });
    expect(within(form).getByLabelText('배포 버전')).toBeDisabled();
    await within(form).findByRole('option', { name: 'SN-100 유선 카운터형' });
    await userEvent.selectOptions(within(form).getByLabelText('배포 모델'), 'SN-100');
    await within(form).findByRole('option', { name: '2.1.0' });
    expect(within(within(form).getByLabelText('배포 버전')).getAllByRole('option').map((o) => o.textContent)).toEqual(['버전 선택', '2.1.0', '2.0.0']);
    const asked = calls.find((c) => c.path === '/firmware')!;
    expect([asked.query.get('modelCode'), asked.query.get('limit')]).toEqual(['SN-100', '100']);
    await userEvent.selectOptions(within(form).getByLabelText('배포 버전'), '2.1.0');

    await userEvent.clear(within(form).getByLabelText('단계 비율'));
    await userEvent.type(within(form).getByLabelText('단계 비율'), '50, 10, 100');
    expect(within(form).getByText('단계 비율은 커지는 순서여야 합니다(누적 비율).')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: '배포 시작' })).toBeDisabled();
    await userEvent.clear(within(form).getByLabelText('단계 비율'));
    await userEvent.type(within(form).getByLabelText('단계 비율'), '10, 50, 100');
    await userEvent.clear(within(form).getByLabelText('실패 임계치'));
    await userEvent.type(within(form).getByLabelText('실패 임계치'), '30');
    await userEvent.clear(within(form).getByLabelText('최소 표본'));
    await userEvent.type(within(form).getByLabelText('최소 표본'), '3');
    await userEvent.clear(within(form).getByLabelText('단계 시간 제한'));
    await userEvent.type(within(form).getByLabelText('단계 시간 제한'), '15');

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await userEvent.click(within(form).getByRole('button', { name: '배포 시작' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false); // 취소하면 보내지 않는다
    expect(confirm.mock.calls[0][0]).toContain('1단계(10%) 대상 단말기에 바로 업데이트 제안이 나갑니다');
    const listReads = calls.filter((c) => c.path === '/firmware-rollouts').length;
    await userEvent.click(within(form).getByRole('button', { name: '배포 시작' }));
    expect(await within(form).findByRole('status')).toHaveTextContent('배포 #9 SN-100 2.1.0 시작 · 1단계 대상 2대');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      modelCode: 'SN-100',
      version: '2.1.0',
      stages: [10, 50, 100],
      failureThreshold: 0.3,
      minSamples: 3,
      stageTimeoutMs: 900_000,
    });
    await waitFor(() => expect(calls.filter((c) => c.path === '/firmware-rollouts' && c.method === 'GET').length).toBeGreaterThan(listReads));
  });

  it('등록된 펌웨어가 없는 모델은 안내하고 버전 선택이 꺼진다. 진행 중 배포가 있으면(409 ROLLOUT_ALREADY_ACTIVE) 안내', async () => {
    mockApi({
      ...EMPTY_LIST,
      ...MODELS,
      ...FIRMWARE,
      'POST /firmware-rollouts': () => ({ status: 409, body: { statusCode: 409, code: 'ROLLOUT_ALREADY_ACTIVE', message: '모델 SN-100에 진행 중인 펌웨어 배포가 있습니다.' } }),
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    loginAs();
    renderPage(<RolloutsPage />);
    await userEvent.click(screen.getByRole('button', { name: '새 배포 만들기' }));
    const form = screen.getByRole('form', { name: '배포 만들기' });
    await within(form).findByRole('option', { name: 'SN-300 테이블오더 태블릿형' });
    await userEvent.selectOptions(within(form).getByLabelText('배포 모델'), 'SN-300');
    expect(await within(form).findByText('이 모델에 등록된 펌웨어가 없습니다. 먼저 펌웨어를 등록하세요.')).toBeInTheDocument();
    expect(within(form).getByLabelText('배포 버전')).toBeDisabled();

    await userEvent.selectOptions(within(form).getByLabelText('배포 모델'), 'SN-100');
    await within(form).findByRole('option', { name: '2.1.0' });
    await userEvent.selectOptions(within(form).getByLabelText('배포 버전'), '2.1.0');
    await userEvent.click(within(form).getByRole('button', { name: '배포 시작' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('이 모델에 진행 중이거나 멈춘 배포가 있습니다');
  });
});
