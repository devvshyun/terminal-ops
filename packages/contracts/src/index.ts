/**
 * @terminal-ops/contracts — api와 어드민·매장·현장 화면이 함께 보는 HTTP 계약(응답·요청 모양, 상태 값, 오류 코드).
 * 타입만 있다(런타임 값 없음). 쓰는 쪽은 `import type`으로만 가져온다 — 빌드된 JS에 이 패키지 import가 남지 않는다(decisions/0047).
 * api는 응답을 만드는 함수의 반환 타입·DTO의 implements로 이 타입을 지키고(어긋나면 api tsc 실패), 어드민은 이 타입으로 응답을 읽는다(decisions/0048).
 */
export type * from './statuses.js';
export type * from './errors.js';
export type * from './common.js';
export type * from './terminal.js';
export type * from './operations.js';
export type * from './reports.js';
export type * from './requests.js';
export type * from './auth.js';
export type * from './merchant.js';
export type * from './field.js';
