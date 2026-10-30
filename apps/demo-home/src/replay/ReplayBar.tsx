import { useEffect, useState } from 'react';
import { useSessionCheck } from '../hooks/useSessionCheck';
import { getReplay } from './runtime';

const REPO = 'https://github.com/devvshyun/terminal-ops';

const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * 위 막대 오른쪽(로그인 자리): 녹화 시계와 지금 흐르는지·기다리는지. 1초마다 다시 그린다.
 * 로그인 칸(LoginBox)이 하던 /auth/me 확인도 여기서 한다 — 녹화본의 응답으로 운영자가 된다(빼먹으면 실행 단추가 모두 꺼진다, 재생본 리허설에서 찾음)
 */
export function ReplayClock() {
  useSessionCheck();
  const replay = getReplay();
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!replay) return null;
  return (
    <div className="who replay-clock" aria-label="녹화 시계">
      <span className="mono">{mmss(replay.time())}</span>
      <small className="muted">{replay.waiting() ? '다음 실행을 기다림' : `${replay.speed}배속으로 흐르는 중`}</small>
    </div>
  );
}

/** 위 막대 아래 띠: 이것이 녹화본이라는 것과 직접 돌리는 길 */
export function ReplayNotice() {
  const replay = getReplay();
  if (!replay) return null;
  const at = new Date(replay.recording.recordedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  return (
    <p className="replay-notice" role="note">
      <strong>녹화 재생본</strong>입니다. {at}에 시연 묶음(api·MySQL·Redis·가상 업체·시뮬레이터)을 실제로 돌려 받은 응답을 다시 보여 줍니다. 기다리는 단계는 {replay.speed}배로 빨리 감고, 다른 화면은 녹화할 때 찍은 사진으로 보여 줍니다. 직접 돌려 보려면{' '}
      <a href={`${REPO}#시연--명령-하나로보강-9`} target="_blank" rel="noreferrer">
        README
      </a>
      의 <code>docker compose -f docker-compose.demo.yml up</code>.
    </p>
  );
}
