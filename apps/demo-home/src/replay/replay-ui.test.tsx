import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetProgress } from '../lib/progress';
import { resetSessionForTest } from '../session';
import { OPERATOR, renderApp } from '../test/render';
import { Replay, type Recording } from './engine';
import { replayFetch, setReplay } from './runtime';

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

    const failOn = await screen.findByRole('region', { name: '장애 켜기: 실패율 60%' });
    // 로그인 칸이 없어도 녹화본의 /auth/me로 운영자가 된다 — 운영자만 누르는 단추가 켜져야 한다(재생본 리허설에서 찾음: 처음에는 아무도 /auth/me를 부르지 않아 꺼져 있었다)
    const closeLike = await screen.findByRole('region', { name: '정상 배포' });
    await waitFor(() => expect(within(closeLike).getByRole('button', { name: '실행: SN-100 새 버전 배포' })).toBeEnabled());
    const button = await within(failOn).findByRole('button', { name: '실행: 펌웨어 실패율 60%' });
    const off = await screen.findByRole('region', { name: '되돌리기: 0%' });
    expect(await within(off).findByText('지금 펌웨어 실패율: 0%')).toBeInTheDocument();
    await userEvent.click(button);
    expect(await within(off).findByText('지금 펌웨어 실패율: 60%')).toBeInTheDocument();

    await userEvent.click(button);
    expect(await within(failOn).findByText(/이미 썼습니다/)).toBeInTheDocument();
  });

  it('화면 열기는 녹화 때 찍은 사진으로, 사진이 없는 화면은 그렇다고 적는다', async () => {
    startReplay();
    renderApp('/act/6');
    const ok = await screen.findByRole('region', { name: '정상 배포' });
    expect(within(ok).getByRole('link', { name: '펌웨어 배포 열기 (녹화 사진) ↗' })).toHaveAttribute('href', '/shots/09-admin.jpg');
    expect(screen.getByText(/운영 관제\(monitor\) — 녹화본에는 이 화면 사진이 없습니다/)).toBeInTheDocument();
  });
});
