import { afterEach, describe, expect, it } from 'vitest';
import { markDone, reloadProgressForTest, resetProgress } from './progress';

afterEach(() => resetProgress());

describe('끝낸 단계 표시(localStorage)', () => {
  it('끝내면 저장되고, 모르는 단계·깨진 값은 버리고 읽는다', () => {
    markDone('3-ship');
    expect(JSON.parse(localStorage.getItem('terminal-ops:demo-home:done')!)).toEqual(['3-ship']);
    localStorage.setItem('terminal-ops:demo-home:done', JSON.stringify(['3-ship', 'nope', 7]));
    reloadProgressForTest();
    markDone('1-dashboard');
    expect(JSON.parse(localStorage.getItem('terminal-ops:demo-home:done')!).sort()).toEqual(['1-dashboard', '3-ship']);
    localStorage.setItem('terminal-ops:demo-home:done', '{깨짐');
    reloadProgressForTest();
    markDone('7-on');
    expect(JSON.parse(localStorage.getItem('terminal-ops:demo-home:done')!)).toEqual(['7-on']);
  });
});
