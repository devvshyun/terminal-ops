import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import { TransitionService } from '../terminal/transition.service.js';
import type { InspectDto } from './dto/inspect.dto.js';
import { InspectionItem } from './inspection-item.entity.js';
import { Inspection, InspectionResult } from './inspection.entities.js';

@Injectable()
export class InspectionService {
  constructor(
    private readonly em: EntityManager,
    private readonly transitions: TransitionService,
  ) {}

  async itemsForModel(modelCode: string): Promise<InspectionItem[]> {
    return this.em.find(InspectionItem, { model: { code: modelCode } }, { orderBy: { sortOrder: 'asc' } });
  }

  /** 검수 기록과 상태 전이를 한 트랜잭션으로 저장한다. 전이가 거절되면 검수 기록도 남지 않는다. */
  async inspect(serialNo: string, dto: InspectDto, actor: string) {
    return this.em.transactional(async (tx) => {
      const terminal = await tx.findOne(Terminal, { serialNo }, { populate: ['model'] });
      if (!terminal) throw new NotFoundException(`단말기 ${serialNo}이(가) 없습니다.`);

      const items = await tx.find(InspectionItem, { model: terminal.model });
      const expected = new Set(items.map((i) => i.code));
      const given = dto.results.map((r) => r.itemCode);
      const missing = [...expected].filter((code) => !given.includes(code));
      const unknown = given.filter((code) => !expected.has(code));
      const duplicated = [...new Set(given.filter((code, i) => given.indexOf(code) !== i))];
      if (missing.length || unknown.length || duplicated.length) {
        throw new BadRequestException({
          statusCode: 400,
          message: '검수 결과가 모델 체크리스트와 맞지 않습니다.',
          missing,
          unknown,
          duplicated,
        });
      }

      const failedItems = dto.results.filter((r) => !r.passed).map((r) => r.itemCode);
      const passed = failedItems.length === 0;

      // 전이(단말기 UPDATE)를 검수 기록 INSERT보다 먼저 한다. 검수 INSERT가 먼저 나가면 FK 검사가 단말기 행에
      // 공유 락(S)을 잡고, 같은 단말기를 동시에 검수하는 트랜잭션끼리 S→X 승격 데드락이 난다
      // (troubleshooting/0004, decisions/0006, experiments/0002). 전이가 거절되면 검수 기록은 만들지도 않는다.
      const updated = await this.transitions.transition(
        {
          serialNo,
          to: passed ? TerminalStatus.INSPECTED : TerminalStatus.DEFECTIVE,
          reason: passed ? '검수 합격' : `검수 불합격: ${failedItems.join(', ')}`,
          actor,
          source: TransitionSource.INSPECTION,
        },
        tx,
      );

      const inspection = tx.create(Inspection, { terminal: updated, passed, actor });
      for (const r of dto.results) {
        tx.create(InspectionResult, { inspection, itemCode: r.itemCode, passed: r.passed, note: r.note ?? null });
      }
      return { inspection, passed, failedItems, terminal: updated };
    });
  }

  /** 모델·항목별 불합격 통계. 집계는 DB에서 한 번에 한다(행을 앱으로 가져와 세지 않는다). */
  async failureStats(modelCode?: string) {
    const params: string[] = [];
    let where = '';
    if (modelCode) {
      where = 'where m.code = ?';
      params.push(modelCode);
    }
    const rows: { model_code: string; item_code: string; total: number | string; failed: number | string }[] =
      await this.em.execute(
        `select m.code as model_code, r.item_code, count(*) as total,
                sum(case when r.passed then 0 else 1 end) as failed
           from inspection_result r
           join inspection i on i.id = r.inspection_id
           join terminal t on t.id = i.terminal_id
           join terminal_model m on m.id = t.model_id
           ${where}
          group by m.code, r.item_code
          order by failed desc, m.code, r.item_code`,
        params,
      );
    return rows.map((row) => {
      // COUNT는 숫자, SUM은 DECIMAL이라 mysql2가 문자열로 줄 수 있다.
      const total = Number(row.total);
      const failed = Number(row.failed);
      return {
        modelCode: row.model_code,
        itemCode: row.item_code,
        total,
        failed,
        failRate: total ? Math.round((failed / total) * 1000) / 1000 : 0,
      };
    });
  }
}
