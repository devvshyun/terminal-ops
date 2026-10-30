import { useSyncExternalStore } from 'react';

/**
 * 자동 재생 순서(보강 11 후속, decisions/0095). 녹화 재생본을 열면 소개 → 이 순서대로 22단계를 스스로 진행한다 → 끝나면 직접 눌러 본다.
 * 진행은 화면의 실행 단추와 같은 함수를 부른다(단추 등록부 — components/Step.tsx). 영상이 아니라 진짜 화면이 움직인다.
 * - run: 그 단계의 실행 단추 글자(없으면 그 단계 단추 하나). 생략하면 보기만 하는 단계
 * - waitClock: 실행 뒤 녹화 시계가 다음 실행 앞까지 흐르기를 기다린다(배송 완료·오프라인 판정처럼 시간이 걸리는 장면)
 * - caption: 지금 무슨 일이 일어나는지 — 업무 용어를 모르는 사람도 읽게
 */
export interface TourStep {
  act: number;
  step: string;
  caption: string;
  run?: string | true;
  waitClock?: boolean;
  /** 자막을 읽을 시간(ms). 기본 4500 */
  dwell?: number;
}

export const TOUR: TourStep[] = [
  { act: 1, step: '1-dashboard', caption: '운영자가 아침에 여는 첫 화면입니다. 운영 중인 단말기와 온라인·오프라인 수, 처리할 이상이 한눈에 보입니다.' },
  { act: 1, step: '1-anomalies', caption: '밤마다 도는 작업이 "며칠째 꺼진 단말기"와 "배송됐는데 설치 안 된 단말기"를 골라 둡니다.' },
  { act: 2, step: '2-note', run: '납품 명세 불러오기', caption: '공장(가상 업체 세움전자)이 보낸 납품 명세를 불러옵니다. 10대를 주문했는데 명세에는 8대뿐입니다.' },
  { act: 2, step: '2-scan', caption: '창고 작업자가 휴대폰으로 상자 8개를 스캔했습니다(오른쪽 사진). 스캔하는 대로 입고 수가 올라갑니다.' },
  { act: 2, step: '2-close', run: '발주 마감', caption: '주문 10 · 명세 8 · 입고 8 — 공장이 2대를 덜 보낸 것을 대조로 잡아내고 발주를 마감합니다.' },
  { act: 3, step: '3-ship', run: '재고 한 대를 강남김밥으로 출고', caption: '재고 한 대를 가맹점 강남김밥에 배정하고 택배(가상 업체 번개택배)로 보냅니다. 운송장은 택배사 API가 발급합니다.' },
  { act: 3, step: '3-track', waitClock: true, dwell: 6500, caption: '사람이 손대지 않아도, 백그라운드 작업이 15초마다 택배사에 배송 상태를 물어 "배송 완료"로 바꿉니다(실제 50초 → 빨리 감기).' },
  { act: 3, step: '3-merchant', caption: '가맹점주도 자기 화면에서 단말기가 도착한 것을 봅니다.' },
  { act: 4, step: '4-open', caption: '점주가 매장 화면에서 단말기 고장을 접수했습니다.' },
  { act: 4, step: '4-replace', run: true, caption: '운영자가 원격 점검을 해 보고, 안 되면 교체품을 보냅니다. 교체품 출고와 고장 단말기 회수 요청이 한 번에(하나의 트랜잭션으로) 처리됩니다.' },
  { act: 4, step: '4-install', waitClock: true, dwell: 6500, caption: '교체품이 도착하자 점주가 "설치 확인"을 누르고 접수가 끝납니다.' },
  { act: 5, step: '5-normal', caption: '여기서부터는 일부러 장애를 냅니다. 먼저 평소 상태 — 택배 수집 작업이 정상(OK)으로 돕니다.' },
  { act: 5, step: '5-on', run: true, caption: '장애를 켭니다: 택배사 API가 요청의 50%를 "너무 많은 요청(429)"으로 거절하게 합니다.' },
  { act: 5, step: '5-ship', run: true, waitClock: true, dwell: 7000, caption: '택배를 하나 보내면, 수집 작업이 429를 받아 ERROR로 남긴 뒤 택배사가 알려 준 시간만큼 기다렸다가 다시 시도해(2번째) 결국 받아 옵니다.' },
  { act: 5, step: '5-off', run: true, caption: '장애를 끕니다.' },
  { act: 6, step: '6-ok', run: true, waitClock: true, dwell: 5500, caption: '새 펌웨어를 단말기 10% → 50% → 100% 순서로 나눠 배포합니다. 모두 성공해 "완료"가 됩니다.' },
  { act: 6, step: '6-fail-on', run: true, caption: '장애를 켭니다: 단말기가 펌웨어 업데이트를 60% 확률로 실패하게 합니다.' },
  { act: 6, step: '6-abort', run: true, waitClock: true, dwell: 7000, caption: '다시 배포하면, 실패율이 기준(20%)을 넘은 단계에서 스스로 멈춥니다 — 나머지 단말기로 번지지 않습니다. "자동 중단" 줄을 보세요.' },
  { act: 6, step: '6-fail-off', run: true, caption: '장애를 끕니다.' },
  { act: 7, step: '7-off', run: true, caption: '가맹점 단말기 하나의 전원을 끕니다(시뮬레이터가 하트비트를 멈춤).' },
  { act: 7, step: '7-wait', waitClock: true, dwell: 7000, caption: '하트비트가 90초 끊기자 시스템이 "오프라인"으로 판정하고 메신저(가상 업체 톡톡)로 알립니다(실제 94초 → 빨리 감기).' },
  { act: 7, step: '7-on', run: true, caption: '단말기를 다시 켭니다. 다음 하트비트에 온라인으로 돌아옵니다.' },
];

export type TourStatus = 'idle' | 'playing' | 'paused' | 'done';
interface TourState {
  status: TourStatus;
  index: number;
}

let state: TourState = { status: 'idle', index: 0 };
const listeners = new Set<() => void>();
const set = (next: Partial<TourState>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};

export const tour = {
  get: () => state,
  start: () => set({ status: 'playing', index: 0 }),
  pause: () => set({ status: 'paused' }),
  resume: () => set({ status: 'playing' }),
  /** 다음 단계로(지금 단계를 건너뛰어도 된다). 마지막 뒤면 끝 */
  next: () => (state.index + 1 >= TOUR.length ? set({ status: 'done', index: TOUR.length - 1 }) : set({ index: state.index + 1, status: state.status === 'paused' ? 'paused' : 'playing' })),
  stop: () => set({ status: 'idle', index: 0 }),
};

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useTour(): TourState {
  return useSyncExternalStore(subscribe, tour.get);
}

/** 지금 자동 재생이 비추는 단계 key(멈춤 포함, 안 돌면 null) */
export function useTourStep(): string | null {
  const s = useTour();
  return s.status === 'playing' || s.status === 'paused' ? (TOUR[s.index]?.step ?? null) : null;
}
