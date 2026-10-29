import type { PartnerKey } from './types';

/**
 * 업체마다 화면에 내놓는 손잡이(보강 8). 서버 설정의 키 이름 그대로(apps/partners/src/state.ts).
 * kind: rate = 0~1 확률(화면은 0~100%), ms = 밀리초, int = 정수, bool = 켜고 끄기.
 * fault: 0이 아니면(또는 켜져 있으면) "장애가 켜졌다"로 본다 — 카드 머리에 표시. 정상 동작을 바꾸는 손잡이(진행 속도 등)는 fault가 아니다.
 */
export interface Knob {
  key: string;
  label: string;
  kind: 'rate' | 'ms' | 'int' | 'bool';
  fault: boolean;
  max?: number;
}

export interface PartnerDef {
  key: PartnerKey;
  name: string;
  role: string;
  knobs: Knob[];
}

export const PARTNERS: PartnerDef[] = [
  {
    key: 'bungae',
    name: '번개택배',
    role: '택배(JSON) — 운송장 발급·추적',
    knobs: [
      { key: 'force429Rate', label: '429 확률', kind: 'rate', fault: true },
      { key: 'rateLimitPerSec', label: '초당 허용 조회', kind: 'int', fault: false, max: 10_000 },
      { key: 'duplicateRate', label: '중복 이벤트 확률', kind: 'rate', fault: true },
      { key: 'delayMs', label: '추적 응답 지연', kind: 'ms', fault: true, max: 60_000 },
      { key: 'advancePerPoll', label: '조회마다 진행 단계', kind: 'int', fault: false, max: 10 },
    ],
  },
  {
    key: 'neurimbo',
    name: '느림보물류',
    role: '택배(XML) — 송장 발급·추적',
    knobs: [
      { key: 'error5xxRate', label: '503 확률', kind: 'rate', fault: true },
      { key: 'delayMs', label: '응답 지연', kind: 'ms', fault: true, max: 60_000 },
      { key: 'shuffle', label: '이벤트 순서 섞기', kind: 'bool', fault: true },
      { key: 'advancePerPoll', label: '조회마다 진행 단계', kind: 'int', fault: false, max: 10 },
    ],
  },
  {
    key: 'seum',
    name: '세움전자',
    role: '공장 — 발주·납품 명세',
    knobs: [
      { key: 'error5xxRate', label: '503 확률', kind: 'rate', fault: true },
      { key: 'shortfall', label: '덜 보내는 대수', kind: 'int', fault: true, max: 10_000 },
      { key: 'foreignSerials', label: '다른 발주 시리얼 섞기', kind: 'int', fault: true, max: 10_000 },
    ],
  },
  {
    key: 'bridgevan',
    name: '브릿지VAN',
    role: 'VAN — 등록 단말기 목록',
    knobs: [
      { key: 'error5xxRate', label: '503 확률', kind: 'rate', fault: true },
      { key: 'force429Rate', label: '429 확률', kind: 'rate', fault: true },
      { key: 'delayMs', label: '응답 지연', kind: 'ms', fault: true, max: 60_000 },
      { key: 'mutateDuringScan', label: '스캔 도중 바꾸는 등록 수', kind: 'int', fault: true, max: 1000 },
    ],
  },
  {
    key: 'toktok',
    name: '톡톡메신저',
    role: '메신저 — 알림 웹훅·파일',
    knobs: [
      { key: 'failRate', label: '500 확률(전부)', kind: 'rate', fault: true },
      { key: 'hookFailRate', label: '500 확률(메시지만)', kind: 'rate', fault: true },
      { key: 'delayMs', label: '저장 뒤 응답 지연', kind: 'ms', fault: true, max: 60_000 },
    ],
  },
];

/** 이 업체에 켜진 장애 손잡이 이름들 */
export function faultsOn(def: PartnerDef, values: Record<string, number | boolean> | undefined): string[] {
  if (!values) return [];
  return def.knobs.filter((k) => k.fault && (k.kind === 'bool' ? values[k.key] === true : Number(values[k.key] ?? 0) > 0)).map((k) => k.label);
}

/** 화면 입력(rate는 %) → 서버 값. 범위를 벗어나면 null(보내지 않는다 — 서버는 값을 검사하지 않는다, decisions/0085) */
export function toServerValue(knob: Knob, input: string | boolean): number | boolean | null {
  if (knob.kind === 'bool') return input === true;
  if (typeof input !== 'string' || input.trim() === '') return null;
  const n = Number(input);
  if (!Number.isFinite(n) || n < 0) return null;
  if (knob.kind === 'rate') return n > 100 ? null : Math.round(n * 100) / 10_000;
  if (!Number.isInteger(n) || (knob.max !== undefined && n > knob.max)) return null;
  return n;
}

/** 서버 값 → 화면 입력 */
export function toInput(knob: Knob, value: number | boolean | undefined): string | boolean {
  if (knob.kind === 'bool') return value === true;
  if (value === undefined) return '';
  return knob.kind === 'rate' ? String(Math.round(Number(value) * 10_000) / 100) : String(value);
}

/** 상태 코드 묶음(색) */
export const codeClass = (status: number) => (status >= 500 ? 'code-5xx' : status >= 400 ? 'code-4xx' : 'code-2xx');
