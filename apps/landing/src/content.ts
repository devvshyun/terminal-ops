/**
 * 소개 페이지에 나오는 숫자·기록 제목·상태(decisions/0078). 숫자는 실험 기록에 실제로 적힌 값만 쓴다 —
 * 항목마다 출처 파일(`source`)과 그 파일에 그대로 있어야 하는 글(`quote`)을 두고, `content.test.ts`가 파일을 열어 확인한다.
 * 실험을 다시 재서 값이 바뀌면 여기와 출처를 같이 고친다(테스트가 어긋남을 알려 준다).
 */

/** 저장소 기준 경로(docs/…). 화면 링크는 GitHub 주소에 이 경로를 붙인다 */
export const REPO_URL = 'https://github.com/devvshyun/terminal-ops';
export const blobUrl = (path: string) => `${REPO_URL}/blob/master/${path.split('/').map(encodeURIComponent).join('/')}`;

export interface Stat {
  /** 크게 보이는 값 */
  value: string;
  /** 값 옆 작은 단위·설명 */
  unit: string;
  /** 무엇을 쟀나(한 줄) */
  title: string;
  /** 한두 문장 — 왜 이 숫자인가 */
  body: string;
  source: string;
  /** source 파일에 그대로 있어야 하는 글(값의 근거) */
  quote: string[];
}

export const STATS: Stat[] = [
  {
    value: '30,000',
    unit: '/ 30,000건',
    title: '하트비트 5,000대 · 초당 1,000건',
    body: '단말기 접속 신호는 상태 전이가 아니라서 MySQL이 아닌 Redis에 받는다. 30초 동안 보낸 신호를 오류 없이 모두 받았고, MySQL 쓰기는 스냅샷 30문장뿐이었다.',
    source: 'docs/experiments/0008-하트비트-5000대.md',
    quote: ['30,000/30,000, 오류 0', 'MySQL 쓰기는 하트비트 수가 아니라 스냅샷 횟수에 비례'],
  },
  {
    value: '0',
    unit: '건',
    title: '택배 이벤트 30% 중복 — 두 번 반영된 것',
    body: '가상 택배사가 같은 배송 이벤트를 일부러 30% 중복해 보낸다. 응답 안 중복 제거, 이벤트 키 유니크, 상태 조건 UPDATE 세 단으로 막았다.',
    source: 'docs/experiments/0003-번개택배-중복-이벤트.md',
    quote: ['중복 반영 0건'],
  },
  {
    value: '17.5',
    unit: '배',
    title: '단말기 목록 API 10만 대 — 91.2ms → 5.2ms',
    body: '조인 한 번(joined)이 LIMIT 20에도 10만 행을 조인·정렬했다. 연관을 따로 읽는 select-in으로 바꿔 목록이 20행에서 멈추게 했다.',
    source: 'docs/experiments/0013-단말기-목록-API-10만-대.md',
    quote: ['joined 91.2ms → select-in 5.2ms(약 17.5배)'],
  },
  {
    value: '0.4',
    unit: 'ms',
    title: '운영 현황 대시보드 — 캐시 적중',
    body: '집계 쿼리 일곱 개에 약 170ms가 든다. Redis 캐시가 적중하면 0.4ms. 캐시가 빈 순간 동시 요청이 몰리는 문제는 따로 쟀다.',
    source: 'docs/experiments/0015-대시보드-캐시-전후.md',
    quote: ['캐시 없음 약 170ms 대 적중 0.4ms(서비스)'],
  },
];

export interface RecordTitle {
  kind: '결정' | '트러블슈팅' | '실험';
  source: string;
  /** 파일 첫 줄(`# NNNN. 제목`)의 제목 부분 */
  title: string;
}

/** 기록에서 몇 개만 — 어떤 일을 겪었는지 제목으로 보인다. title은 파일 첫 줄(`# NNNN. 제목`)의 제목 그대로(테스트가 본다) */
export const RECORD_TITLES: RecordTitle[] = [
  { kind: '트러블슈팅', source: 'docs/troubleshooting/0014-출고-이전-운송장-UPDATE의-gap-락으로-다른-단말기끼리-데드락.md', title: '출고 때 이전 운송장 UPDATE가 gap 락을 잡아 다른 단말기 출고끼리 데드락' },
  { kind: '결정', source: 'docs/decisions/0027-하트비트는-상태-전이가-아니다-Redis에만-쓴다.md', title: '하트비트는 상태 전이가 아니다, Redis에만 쓴다' },
  { kind: '트러블슈팅', source: 'docs/troubleshooting/0016-원시-SQL-datetime이-9시간-어긋나-모두-시간-초과.md', title: '원시 SQL로 읽은 datetime이 9시간 어긋나 모든 대상이 바로 시간 초과' },
  { kind: '결정', source: 'docs/decisions/0016-Outbox-최소-한-번과-멱등키.md', title: '알림은 Outbox로, 보장 수준은 최소 한 번 + 멱등키' },
  { kind: '트러블슈팅', source: 'docs/troubleshooting/0010-배송-완료-반영이-SUPERSEDED를-덮어씀.md', title: '배송 완료 반영이 재출고로 바뀐 SUPERSEDED를 DELIVERED로 덮어씀(lost update)' },
  { kind: '결정', source: 'docs/decisions/0004-동시-수정은-낙관적-락과-expectedVersion.md', title: '동시 수정은 낙관적 락과 expectedVersion으로 막는다' },
  { kind: '실험', source: 'docs/experiments/0011-실행계획-단말기-10만-이력-100만.md', title: '실행계획 — 단말기 10만·이력 약 100만' },
  { kind: '트러블슈팅', source: 'docs/troubleshooting/0019-배포-판단이-스냅숏-뒤-보고를-놓치고-제안을-되살림.md', title: '배포 판단이 스냅숏 뒤에 커밋된 보고를 놓치고, 보고한 단말기의 제안을 되살린다' },
];

/**
 * 기록 수 — 빌드 때 docs 폴더의 파일 이름을 센다(import.meta.glob, 내용은 읽지 않는다). 손으로 적으면 기록이 늘 때 틀린다.
 * 경로는 이 파일(apps/landing/src) 기준 저장소 루트의 docs.
 */
export function recordCounts(): { decisions: number; troubleshooting: number; experiments: number } {
  return {
    decisions: Object.keys(import.meta.glob('../../../docs/decisions/*.md')).length,
    troubleshooting: Object.keys(import.meta.glob('../../../docs/troubleshooting/*.md')).length,
    experiments: Object.keys(import.meta.glob('../../../docs/experiments/*.md')).length,
  };
}

/** 단말기 생애주기 — 상태 코드(api TerminalStatus)·운영자 화면 이름·누가 어느 화면에서 바꾸나. 전이 규칙은 api transition-rules.ts 한 곳 */
export interface LifeStage {
  code: string;
  name: string;
  who: string;
  how: string;
}

export const LIFECYCLE: LifeStage[] = [
  { code: 'RECEIVED', name: '입고', who: '현장 작업자', how: '세움전자 박스를 바코드로 찍는다. 납품 명세에 없는 시리얼은 줄째 거절' },
  { code: 'INSPECTED', name: '검수 합격', who: '현장 작업자', how: '모델별 체크리스트. 하나라도 불합격이면 불량으로' },
  { code: 'IN_STOCK', name: '재고', who: '운영자', how: '창고에 보관. 어드민 단말기 목록 10만 대에서도 5ms' },
  { code: 'ALLOCATED', name: '배정', who: '운영자', how: '가맹점에 한 대씩. 같은 단말기를 두 사람이 동시에 잡으면 한쪽만 이긴다' },
  { code: 'SHIPPED', name: '출고', who: '운영자 · 택배사', how: '번개택배·느림보물류에 운송장을 받는다. 트랜잭션 밖에서' },
  { code: 'DELIVERED', name: '배송 완료', who: '수집 워커', how: '택배 이벤트를 주기적으로 모은다. 중복·순서 뒤섞임·429를 견딘다' },
  { code: 'IN_SERVICE', name: '운영 중', who: '가맹점주 · 단말기', how: '설치 확인, 5초마다 하트비트, 펌웨어 단계 배포' },
  { code: 'RETURN_REQUESTED', name: '회수 요청', who: '가맹점주 · 운영자', how: '고장 접수 → 원격 점검 → 교체품 출고' },
  { code: 'RETURNED', name: '회수 입고', who: '현장 작업자', how: '돌아온 단말기를 찍고 다시 검수로. 재검수가 필요한 모델이 있다' },
];
