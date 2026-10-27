import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OperatorBar } from './components/OperatorBar';
import { OPERATOR_KEY, getOperator, reloadOperatorForTest, setOperator, useOperator } from './operator';

function Now() {
  return <p>이름:{useOperator()}</p>;
}

describe('작업자 이름 저장소 (decisions/0041)', () => {
  it('localStorage가 던져도(사생활 모드 등) 메모리에는 기억한다', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    reloadOperatorForTest();
    expect(getOperator()).toBe('');
    expect(setOperator('박운영')).toBeNull();
    expect(getOperator()).toBe('박운영');
    expect(setOperator('')).toBeNull();
    expect(getOperator()).toBe('');
  });

  it('입력칸은 서버 규칙(50자)과 같은 maxLength', () => {
    render(<OperatorBar />);
    expect(screen.getByLabelText('작업자 이름')).toHaveAttribute('maxlength', '50');
  });

  it('다른 탭이 이름을 바꾸면(storage 이벤트) 이 탭도 따라간다. 지우거나 규칙에 어긋난 값이면 비운다', () => {
    render(<Now />);
    expect(screen.getByText('이름:')).toBeInTheDocument();
    act(() => {
      window.localStorage.setItem(OPERATOR_KEY, '최운영');
      window.dispatchEvent(new StorageEvent('storage', { key: OPERATOR_KEY, newValue: '최운영' }));
    });
    expect(getOperator()).toBe('최운영');
    expect(screen.getByText('이름:최운영')).toBeInTheDocument();

    act(() => {
      window.localStorage.setItem(OPERATOR_KEY, 'system:batch');
      window.dispatchEvent(new StorageEvent('storage', { key: OPERATOR_KEY, newValue: 'system:batch' }));
    });
    expect(getOperator()).toBe('');

    act(() => {
      window.localStorage.setItem(OPERATOR_KEY, '정운영');
      window.dispatchEvent(new StorageEvent('storage', { key: OPERATOR_KEY, newValue: '정운영' }));
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(getOperator()).toBe('');
  });

  it('입력칸은 고치는 중이 아니면 다른 탭의 이름 변경을 따라간다 — 옛 이름으로 다시 저장되지 않게(최종 리뷰 Minor 8)', () => {
    setOperator('김운영');
    render(<OperatorBar />);
    const input = screen.getByLabelText('작업자 이름');
    expect(input).toHaveValue('김운영');
    act(() => {
      window.localStorage.setItem(OPERATOR_KEY, '최운영');
      window.dispatchEvent(new StorageEvent('storage', { key: OPERATOR_KEY, newValue: '최운영' }));
    });
    expect(screen.getByText('지금: 최운영')).toBeInTheDocument();
    expect(input).toHaveValue('최운영');
    act(() => {
      window.localStorage.removeItem(OPERATOR_KEY);
      window.dispatchEvent(new StorageEvent('storage', { key: OPERATOR_KEY, newValue: null }));
    });
    expect(input).toHaveValue('');
  });

  it('(회귀 방지) 고치는 중(저장하지 않은 입력)이면 다른 탭의 변경이 입력을 덮어쓰지 않는다. 표시(지금:)는 따라간다', () => {
    setOperator('김운영');
    render(<OperatorBar />);
    const input = screen.getByLabelText('작업자 이름');
    fireEvent.change(input, { target: { value: '이운영' } });
    act(() => {
      window.localStorage.setItem(OPERATOR_KEY, '최운영');
      window.dispatchEvent(new StorageEvent('storage', { key: OPERATOR_KEY, newValue: '최운영' }));
    });
    expect(screen.getByText('지금: 최운영')).toBeInTheDocument();
    expect(input).toHaveValue('이운영');
  });

  it('상관없는 키의 storage 이벤트는 무시한다', () => {
    setOperator('박운영');
    act(() => {
      window.localStorage.clear(); // 저장소만 비우고 다른 키 이벤트
      window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'x' }));
    });
    expect(getOperator()).toBe('박운영');
  });
});
