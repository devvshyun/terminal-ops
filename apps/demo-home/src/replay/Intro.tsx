import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { getReplay } from './runtime';
import { startTour } from './TourBar';
import { tour } from './tour';

const REPO = 'https://github.com/devvshyun/terminal-ops';

const SCENES: [string, string][] = [
  ['공장에서 창고로', '공장이 주문보다 2대 덜 보낸 것을 납품 명세·스캔과 대조해 잡아낸다'],
  ['가맹점까지', '택배사 API를 주기적으로 조회해 사람 손 없이 "배송 완료"로 바꾼다'],
  ['고장과 교체', '고장 접수 → 원격 점검 → 교체품 출고와 회수 요청을 한 트랜잭션으로'],
  ['택배사가 429를 낸다', '외부 API가 거절하면 기다렸다가 다시 시도해 결국 받아 온다'],
  ['펌웨어 배포와 자동 중단', '실패가 기준을 넘으면 그 단계에서 스스로 멈춰 나머지로 번지지 않는다'],
  ['단말기가 끊긴다', '하트비트가 90초 끊기면 오프라인으로 판정하고 메신저로 알린다'],
];

/** 녹화 재생본의 첫 화면: 무엇인지 → 자동 재생 시작 / 바로 직접 눌러 보기 */
export function Intro() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const replay = getReplay();
  const at = replay ? new Date(replay.recording.recordedAt).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }) : '';
  return (
    <main className="intro">
      <p className="eyebrow">terminal-ops · 학습 프로젝트</p>
      <h1>결제단말기 운영 시스템, 실제로 돌려 본 장면</h1>
      <p className="lead">
        가상의 결제단말기 회사 <strong>단말온</strong>이 단말기 한 대를 공장에서 가맹점까지 보내고, 고장 나면 바꾸고, 장애가 나면 견디는 사내 시스템입니다. Nest.js · MySQL · Redis(BullMQ) 백엔드와 화면 7개로 만들었습니다. 등장하는 회사는 모두 가상입니다.
      </p>
      <p>
        이 페이지는 그 시스템을 <strong>실제로 돌리며 받은 응답을 녹화</strong>({at})해 다시 보여 줍니다. 서버 없이 브라우저만으로 돌지만, 화면에 나오는 숫자와 글은 모두 진짜 백엔드가 낸 것입니다.
      </p>
      <h2>여기서 볼 수 있는 백엔드 동작</h2>
      <ol className="scenes">
        {SCENES.map(([title, what]) => (
          <li key={title}>
            <strong>{title}</strong>
            <span>{what}</span>
          </li>
        ))}
      </ol>
      <div className="intro-actions">
        <button
          type="button"
          className="primary big-button"
          onClick={() => {
            startTour();
            void client.invalidateQueries();
            navigate('/act/1');
          }}
        >
          ▶ 시연 보기 (약 3분, 자동 진행)
        </button>
        <Link
          to="/act/1"
          className="link-button"
          onClick={() => {
            tour.stop();
          }}
        >
          바로 직접 눌러 보기
        </Link>
      </div>
      <p className="muted small">
        자동 진행 중에도 언제든 멈추고 직접 눌러 볼 수 있습니다. 코드와 기록:{' '}
        <a href={REPO} target="_blank" rel="noreferrer">
          GitHub
        </a>
        . 직접 띄우려면 저장소의 <code>docker compose -f docker-compose.demo.yml up</code>.
      </p>
    </main>
  );
}
