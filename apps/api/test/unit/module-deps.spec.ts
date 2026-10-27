import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANOMALY_RULE_LABEL } from '../../src/anomaly/anomaly-labels.js';
import { AnomalyRule } from '../../src/anomaly/anomaly.entity.js';
import { KIND_LABEL } from '../../src/van/van-labels.js';
import { VanMismatchKind } from '../../src/van/van.entities.js';

/** import 문에서 가져오는 경로들 */
const importsOf = (file: string) => [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);

describe('의존 방향 — 알림·리포트는 도메인 로직을 불러오지 않는다 (Day 5 최종 리뷰 Minor 5, decisions/0037)', () => {
  it.each(['src/outbox/outbox.service.ts', 'src/report/weekly-report.xlsx.ts'])('%s는 anomaly-rules·van-compare 대신 레이블 파일을 쓴다', (file) => {
    const imports = importsOf(file);
    expect(imports).not.toContain('../anomaly/anomaly-rules.js');
    expect(imports).not.toContain('../van/van-compare.js');
    expect(imports).toEqual(expect.arrayContaining(['../anomaly/anomaly-labels.js', '../van/van-labels.js']));
  });

  it('레이블 파일은 enum만 불러오고, 규칙·종류마다 이름이 하나씩 있다', () => {
    expect(importsOf('src/anomaly/anomaly-labels.ts')).toEqual(['./anomaly.entity.js']);
    expect(importsOf('src/van/van-labels.ts')).toEqual(['./van.entities.js']);
    expect(Object.keys(ANOMALY_RULE_LABEL)).toEqual(Object.values(AnomalyRule));
    expect(Object.keys(KIND_LABEL)).toEqual(Object.values(VanMismatchKind));
  });
});
