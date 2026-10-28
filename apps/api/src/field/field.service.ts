import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { FieldTodayView } from '@terminal-ops/contracts';
import { kstDayOf } from '../common/kst.js';
import { Inspection } from '../inspection/inspection.entities.js';
import { ScanBatch } from '../scan/scan-batch.entity.js';

/**
 * 현장 작업자 화면의 "오늘 내 작업"(보강 4, decisions/0063). 이 사람(actor = 로그인 아이디, decisions/0056)이 오늘(KST) 처리한 박스와 검수를 센다.
 * 박스는 scan_batch 한 행 = 한 번 처리한 박스라 같은 scanId로 다시 보낸 것(replayed)은 저절로 한 번만 센다(decisions/0020).
 * 행 결과는 JSON 열이라 SQL로 펼치지 않고 그 사람의 오늘 박스만 읽어 여기서 더한다(하루 수십 박스, 박스당 500행 이하).
 */
@Injectable()
export class FieldService {
  constructor(private readonly em: EntityManager) {}

  async today(actor: string, now = new Date()): Promise<FieldTodayView> {
    const em = this.em.fork();
    const day = kstDayOf(now);
    const batches = await em.find(ScanBatch, { actor, createdAt: { $gte: day.from, $lt: day.to } }, { fields: ['results'] });
    const scans = { boxes: batches.length, received: 0, returned: 0, rejected: 0 };
    for (const row of batches.flatMap((b) => b.results)) {
      if (row.result === 'CREATED') scans.received += 1;
      else if (row.result === 'RETURNED') scans.returned += 1;
      else scans.rejected += 1;
    }
    const inspectedToday = { actor, inspectedAt: { $gte: day.from, $lt: day.to } };
    const [total, passed] = await Promise.all([em.count(Inspection, inspectedToday), em.count(Inspection, { ...inspectedToday, passed: true })]);
    return { date: day.date, scans, inspections: { total, passed, failed: total - passed } };
  }
}
