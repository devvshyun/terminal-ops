import { describe, expect, it } from 'vitest';
import { canConfirmInstall, shipmentSteps, ticketSteps, type Step } from './steps';

/** 'done·current·todo'를 한 줄로: 지난 칸 ✓, 지금 ▶, 아직 · */
const line = (steps: Step[]) => steps.map((s) => `${s.state === 'done' ? '✓' : s.state === 'current' ? '▶' : '·'}${s.label}`).join(' ');

describe('A/S 진행 단계 (decisions/0060)', () => {
  it('접수만 됐으면 원격 점검을 기다린다, 원격 점검 뒤에는 교체 출고를 기다린다', () => {
    expect(line(ticketSteps({ status: 'OPEN', remoteChecked: false, replacementStatus: null }))).toBe('✓접수 ▶원격 점검 ·교체 출고 ·배송 중 ·설치 확인 ·완료');
    expect(line(ticketSteps({ status: 'OPEN', remoteChecked: true, replacementStatus: null }))).toBe('✓접수 ✓원격 점검 ▶교체 출고 ·배송 중 ·설치 확인 ·완료');
  });

  it('교체 단말기가 배송 중이면 배송 중, 도착하면 설치 확인 차례', () => {
    expect(line(ticketSteps({ status: 'REPLACING', remoteChecked: true, replacementStatus: 'SHIPPED' }))).toBe('✓접수 ✓원격 점검 ✓교체 출고 ▶배송 중 ·설치 확인 ·완료');
    expect(line(ticketSteps({ status: 'REPLACING', remoteChecked: false, replacementStatus: 'DELIVERED' }))).toBe('✓접수 ✓원격 점검 ✓교체 출고 ✓배송 중 ▶설치 확인 ·완료');
  });

  it('교체 중인데 교체 단말기 상태가 없거나(null, api는 교체 중에만 값을 준다) 아직 배정 단계면 교체 출고 차례', () => {
    expect(line(ticketSteps({ status: 'REPLACING', remoteChecked: true, replacementStatus: null }))).toBe('✓접수 ✓원격 점검 ▶교체 출고 ·배송 중 ·설치 확인 ·완료');
    expect(line(ticketSteps({ status: 'REPLACING', remoteChecked: true, replacementStatus: 'ALLOCATED' }))).toBe('✓접수 ✓원격 점검 ▶교체 출고 ·배송 중 ·설치 확인 ·완료');
  });

  it('완료와 원격 해결은 모두 지남', () => {
    expect(line(ticketSteps({ status: 'CLOSED', remoteChecked: true, replacementStatus: 'IN_SERVICE' }))).toBe('✓접수 ✓원격 점검 ✓교체 출고 ✓배송 중 ✓설치 확인 ✓완료');
    expect(line(ticketSteps({ status: 'RESOLVED_REMOTELY', remoteChecked: true, replacementStatus: null }))).toBe('✓접수 ✓원격 점검 ✓원격으로 해결');
  });

  it('설치 확인은 교체 진행 중 + 교체 단말기 도착일 때만', () => {
    expect(canConfirmInstall({ status: 'REPLACING', replacementStatus: 'DELIVERED' })).toBe(true);
    expect(canConfirmInstall({ status: 'REPLACING', replacementStatus: 'SHIPPED' })).toBe(false);
    expect(canConfirmInstall({ status: 'CLOSED', replacementStatus: 'IN_SERVICE' })).toBe(false);
    expect(canConfirmInstall({ status: 'OPEN', replacementStatus: null })).toBe(false);
  });
});

describe('택배 단계', () => {
  const at = '2026-10-28T01:00:00.000Z';
  it('이벤트가 없으면 출고 다음(택배사 인수)을 기다린다', () => {
    expect(line(shipmentSteps({ status: 'IN_TRANSIT', events: [] }))).toBe('✓출고 ▶택배사 인수 ·이동 중 ·배송 출발 ·배송 완료');
  });

  it('가장 멀리 간 이벤트까지 지남(순서 없이 와도)', () => {
    const events = [
      { code: 'OUT_FOR_DELIVERY' as const, occurredAt: at },
      { code: 'PICKED_UP' as const, occurredAt: at },
    ];
    expect(line(shipmentSteps({ status: 'IN_TRANSIT', events }))).toBe('✓출고 ✓택배사 인수 ✓이동 중 ✓배송 출발 ▶배송 완료');
  });

  it('운송장이 배송 완료면 이벤트가 없어도 모두 지남(손으로 넣은 배송 완료)', () => {
    expect(line(shipmentSteps({ status: 'DELIVERED', events: [] }))).toBe('✓출고 ✓택배사 인수 ✓이동 중 ✓배송 출발 ✓배송 완료');
  });
});
