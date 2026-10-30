/**
 * 시연 홈의 7막(보강 10, docs/specs/2026-10-30-demo-home.md). 이야기 순서 = 단말기 한 대의 길(공장 → 창고 → 가맹점 → 고장)과
 * 장애 묶음(정상 → 켜기 → 반응 → 되돌리기). 단계 key는 진행 표시(localStorage)의 이름이라 바꾸면 끝냄 표시가 풀린다.
 */
export interface StepDef {
  key: string;
  title: string;
}
export interface ActDef {
  n: number;
  title: string;
  /** 한 줄 이야기 */
  story: string;
  /** 나오는 사람(역할) */
  who: string;
  steps: StepDef[];
}

export const ACTS: ActDef[] = [
  {
    n: 1,
    title: '한눈에',
    story: '운영자가 아침에 처음 화면을 연다. 시연 데이터에는 며칠 전부터 꺼진 단말기와 배송 뒤 설치되지 않은 단말기가 있다.',
    who: '운영자',
    steps: [
      { key: '1-dashboard', title: '처음 화면 숫자' },
      { key: '1-anomalies', title: '이상 단말기 두 대' },
    ],
  },
  {
    n: 2,
    title: '공장에서 창고로',
    story: '세움전자(가상 공장)가 발주보다 2대 덜 보냈다. 현장 작업자가 상자를 스캔하고, 운영자가 대조해 마감한다.',
    who: '현장 작업자 · 운영자',
    steps: [
      { key: '2-note', title: '공장 납품 명세' },
      { key: '2-scan', title: '현장 박스 스캔' },
      { key: '2-close', title: '입고 대조와 마감' },
    ],
  },
  {
    n: 3,
    title: '가맹점까지',
    story: '재고 한 대를 강남김밥에 배정해 번개택배로 보낸다. 워커가 택배사 추적을 주기마다 조회해 배송 완료로 바꾼다.',
    who: '운영자 · 시스템 · 가맹점주',
    steps: [
      { key: '3-ship', title: '배정하고 출고' },
      { key: '3-track', title: '배송 완료 기다리기' },
      { key: '3-merchant', title: '점주가 본다' },
    ],
  },
  {
    n: 4,
    title: '고장과 교체',
    story: '점주가 고장을 접수하면 운영자가 원격으로 점검하고, 안 되면 교체품을 보낸다. 점주가 설치를 확인하면 끝난다.',
    who: '가맹점주 · 운영자',
    steps: [
      { key: '4-open', title: '점주가 고장 접수' },
      { key: '4-replace', title: '원격 점검 → 교체 출고' },
      { key: '4-install', title: '점주가 설치 확인' },
    ],
  },
  {
    n: 5,
    title: '택배사가 429를 낸다',
    story: '번개택배가 요청이 많다며 429(너무 많은 요청)를 낸다. 수집 작업은 기다렸다가 다시 시도해 결국 받아 온다.',
    who: '시연자 · 시스템',
    steps: [
      { key: '5-normal', title: '정상: 최근 택배 수집' },
      { key: '5-on', title: '장애 켜기: 429 50%' },
      { key: '5-ship', title: '출고 하나 → 반응' },
      { key: '5-off', title: '되돌리기: 0%' },
    ],
  },
  {
    n: 6,
    title: '펌웨어 배포와 자동 중단',
    story: '새 펌웨어를 10% → 50% → 100%로 나눠 배포한다. 단말기가 실패를 많이 보고하면 그 단계에서 스스로 멈춰 다음 단계로 번지지 않는다.',
    who: '운영자 · 단말기',
    steps: [
      { key: '6-ok', title: '정상 배포' },
      { key: '6-fail-on', title: '장애 켜기: 실패율 60%' },
      { key: '6-abort', title: '다시 배포 → 자동 중단' },
      { key: '6-fail-off', title: '되돌리기: 0%' },
    ],
  },
  {
    n: 7,
    title: '단말기가 끊긴다',
    story: '가맹점 단말기 하나가 꺼진다. 하트비트가 90초 끊기면 오프라인으로 판정하고 메신저로 알린다.',
    who: '시연자 · 시스템',
    steps: [
      { key: '7-off', title: '단말기 끄기' },
      { key: '7-wait', title: '오프라인 판정과 알림' },
      { key: '7-on', title: '되돌리기: 켜기' },
    ],
  },
];

export const ALL_STEPS = ACTS.flatMap((a) => a.steps.map((s) => s.key));
