import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetProgress } from '../lib/progress';

const loadDone = () => JSON.parse(localStorage.getItem('terminal-ops:demo-home:done') ?? '[]') as string[];
import { resetSessionForTest } from '../session';
import { OPERATOR, renderApp } from '../test/render';
import { Replay, type Recording } from './engine';
import { ALL_STEPS } from '../lib/acts';
import { replayFetch, setReplay } from './runtime';
import { TOUR, tour } from './tour';

/** 6막 "장애 켜기: 실패율 60%" 하나를 녹화한 작은 녹화본 */
const REC: Recording = {
  version: 1,
  recordedAt: '2026-10-30T03:20:00.000Z',
  commit: 'test',
  durationMs: 5000,
  runs: [{ step: '6-fail-on', label: '펌웨어 실패율 60%', t: 1000, end: 1500 }],
  responses: [
    { t: 0, method: 'GET', url: '/api/auth/me', status: 200, body: OPERATOR },
    { t: 0, method: 'GET', url: '/api/firmware-rollouts?limit=10', status: 200, body: { items: [], nextBeforeId: null } },
    { t: 0, method: 'GET', url: '/api/sim/__admin/config', status: 200, body: { offlineSerials: [], firmwareFailRate: 0 } },
    { t: 1100, method: 'POST', url: '/api/sim/__admin/config', status: 200, body: { offlineSerials: [], firmwareFailRate: 0.6 } },
    { t: 1200, method: 'GET', url: '/api/sim/__admin/config', status: 200, body: { offlineSerials: [], firmwareFailRate: 0.6 } },
  ],
  shots: [{ key: 'admin:/firmware-rollouts', file: '09-admin.jpg', title: '어드민 펌웨어 배포', t: 0 }],
};

function startReplay() {
  const replay = new Replay(REC, () => Date.now());
  setReplay(replay);
  vi.stubGlobal('fetch', replayFetch(replay, () => Promise.reject(new Error('네트워크 없음'))));
  return replay;
}

afterEach(() => {
  tour.stop();
  setReplay(null);
  resetSessionForTest();
  resetProgress();
});

describe('녹화 재생본 화면(보강 11)', () => {
  it('로그인 대신 녹화 시계와 녹화본 안내, 실행하면 녹화된 응답이 바로 옆에 — 같은 실행을 또 누르면 안내', async () => {
    startReplay();
    renderApp('/act/6');
    expect(await screen.findByRole('note')).toHaveTextContent('녹화 재생본');
    expect(screen.getByLabelText('녹화 시계')).toBeInTheDocument();
    expect(screen.queryByLabelText('비밀번호')).not.toBeInTheDocument();

    // 로그인 칸이 없어도 녹화본의 /auth/me로 운영자가 된다 — 운영자만 누르는 단추가 켜져야 한다(재생본 리허설에서 찾음: 처음에는 아무도 /auth/me를 부르지 않아 꺼져 있었다)
    // 로그인 정보가 채워지면 가운데가 새로 그려진다(Shell의 key) — 요소를 붙잡지 않고 매번 찾는다
    await waitFor(() => expect(within(screen.getByRole('region', { name: '정상 배포' })).getByRole('button', { name: '실행: SN-100 새 버전 배포' })).toBeEnabled());
    const failOn = await screen.findByRole('region', { name: '장애 켜기: 실패율 60%' });
    const button = await within(failOn).findByRole('button', { name: '실행: 펌웨어 실패율 60%' });
    const off = await screen.findByRole('region', { name: '되돌리기: 0%' });
    expect(await within(off).findByText('지금 펌웨어 실패율: 0%')).toBeInTheDocument();
    await userEvent.click(button);
    expect(await within(off).findByText('지금 펌웨어 실패율: 60%')).toBeInTheDocument();

    await userEvent.click(button);
    expect(await within(failOn).findByText(/이미 썼습니다/)).toBeInTheDocument();
  });

  it('화면 열기는 녹화 사진을 카드 안에 바로 보인다(누르면 크게). 왼쪽 "다른 화면"은 링크, 사진이 없는 화면은 그렇다고 적는다', async () => {
    startReplay();
    renderApp('/act/6');
    const ok = await screen.findByRole('region', { name: '정상 배포' });
    expect(within(ok).getByRole('img', { name: '어드민 펌웨어 배포' })).toHaveAttribute('src', '/shots/09-admin.jpg');
    expect(within(ok).getByRole('link', { name: '펌웨어 배포 열기 (녹화 사진 크게 보기)' })).toHaveAttribute('href', '/shots/09-admin.jpg');
    expect(screen.getByText(/운영 관제\(monitor\): 녹화본에 이 화면 사진은 없습니다/)).toBeInTheDocument();
  });

  it('첫 화면은 바로 1막(소개는 소개 페이지가 맡는다), #/tour는 자동 진행 막대와 1막 첫 자막으로 시작한다', async () => {
    startReplay();
    renderApp('/');
    expect(await screen.findByRole('heading', { name: '한눈에' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '자동 재생' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '▶ 자동 진행' }));
    const bar = await screen.findByRole('region', { name: '자동 재생' });
    expect(bar).toHaveTextContent(`1막 · 1/${TOUR.length}`);
    expect(bar).toHaveTextContent(TOUR[0]!.caption);
    await userEvent.click(within(bar).getByRole('button', { name: '일시정지' }));
    expect(within(bar).getByRole('button', { name: '계속' })).toBeInTheDocument();
  });

  it('자동 재생은 그 단계의 실행 단추를 스스로 누른다 — 사람이 누른 것과 같은 결과', async () => {
    startReplay();
    tour.start();
    while (TOUR[tour.get().index]!.step !== '6-fail-on') tour.next();
    renderApp('/act/6');
    // 로그인 정보가 채워지면 가운데가 새로 그려진다(Shell의 key) — 요소를 붙잡아 두지 않고 매번 찾는다
    await waitFor(() => expect(within(screen.getByRole('region', { name: '되돌리기: 0%' })).getByText('지금 펌웨어 실패율: 60%')).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByRole('region', { name: '장애 켜기: 실패율 60%' })).toHaveClass('tour-current');
  });

  it('보기만 하는 단계도 자막을 읽을 시간이 지나면 끝냄으로 표시하고 다음 단계로 — 다 보면 22/22', { timeout: 15000 }, async () => {
    startReplay();
    tour.start();
    while (TOUR[tour.get().index]!.step !== '5-normal') tour.next();
    renderApp('/act/5');
    await waitFor(() => expect(TOUR[tour.get().index]!.step).toBe('5-on'), { timeout: 8000 });
    expect(loadDone()).toContain('5-normal');
  });

  it('자동 재생 순서는 22단계를 막 순서대로 모두 지난다', () => {
    expect(TOUR.map((s) => s.step)).toEqual(ALL_STEPS);
  });
});
