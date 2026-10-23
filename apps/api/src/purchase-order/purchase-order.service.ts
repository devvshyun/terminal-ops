import { randomUUID } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, LockMode } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { TerminalModel } from '../terminal/terminal-model.entity.js';
import type { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto.js';
import { PurchaseOrder, PurchaseOrderStatus } from './purchase-order.entity.js';
import { SeumClient } from './seum.client.js';

@Injectable()
export class PurchaseOrderService {
  private readonly logger = new Logger(PurchaseOrderService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly seum: SeumClient,
  ) {}

  /**
   * 발주: ① 모델 확인 ② 트랜잭션 밖에서 세움전자에 발주(HTTP) ③ 받은 발주번호로 저장.
   * ③이 실패하면 공장 쪽에 발주가 남는다(운송장과 같은 한계, decisions/0012). 추적할 수 있도록 발주번호와 reference(공장에 함께 보낸 값)를 로그에 남기고 다시 던진다.
   * 확인할 수 있는 실패(없는 모델)는 ①에서 거른다.
   */
  async create(dto: CreatePurchaseOrderDto, actor: string): Promise<PurchaseOrder> {
    const model = await this.em.findOne(TerminalModel, { code: dto.modelCode });
    if (!model) throw new NotFoundException(`단말기 모델 ${dto.modelCode}이(가) 없습니다.`);

    const reference = randomUUID();
    const poNo = await this.seum.createPurchaseOrder({ modelCode: model.code, quantity: dto.quantity, reference });

    const po = this.em.create(PurchaseOrder, { poNo, model, quantity: dto.quantity, orderedBy: actor });
    try {
      await this.em.flush();
    } catch (error) {
      this.logger.error(`공장 발주 후 저장 실패(고아 발주): poNo=${poNo} reference=${reference} modelCode=${model.code} quantity=${dto.quantity} actor=${actor}`, error instanceof Error ? error.stack : String(error));
      throw error;
    }
    return po;
  }

  /**
   * 납품 명세를 돌려준다. 아직 안 받았으면 트랜잭션 밖에서 세움전자에 물어 저장한다(처음 한 번).
   * 동시에 두 요청이 받아 와도 내용이 같고, delivery_note가 null일 때만 쓰므로 덮어쓰지 않는다.
   */
  async ensureDeliveryNote(po: PurchaseOrder): Promise<string[]> {
    if (po.deliveryNote) return po.deliveryNote;
    const { serials } = await this.seum.getDeliveryNote(po.poNo);
    await this.em.fork().nativeUpdate(PurchaseOrder, { id: po.id, deliveryNote: null }, { deliveryNote: serials });
    po.deliveryNote = serials;
    return serials;
  }

  /**
   * 발주 대비 입고 대조(F10). 숫자와 목록은 DB에서 구한다(단말기를 앱으로 가져와 세지 않는다).
   * - noted: 납품 명세의 시리얼 수, shortfall = 발주 수량 - noted
   * - received: 이 발주로 입고 스캔돼 등록된 단말기 수
   * - missing: 명세에 있는데 아직 이 발주로 입고되지 않은 시리얼(명세 순서) — JSON_TABLE로 명세를 행으로 펼쳐 단말기와 LEFT JOIN
   * - unexpected: 입고 스캔에서 명세에 없다고 거절된 시리얼(scan_batch.results의 NOT_IN_DELIVERY_NOTE)
   * JSON_TABLE 열은 연결의 collation(mysql2 기본 utf8mb4_unicode_ci)을 따른다. 테이블 열(utf8mb4_0900_ai_ci)과 비교하면
   * ERROR 1267(Illegal mix of collations)이 나므로 열 정의에 collate를 적는다(troubleshooting/0008). 그러면 serial_no unique 인덱스도 쓴다.
   * 주의: 테스트에서는 resetDatabase(schema.refresh)가 보낸 `set names utf8mb4`로 그 연결만 utf8mb4_0900_ai_ci가 되어, 그 연결로 나간 쿼리는
   * collate가 없어도 통과한다. 새로 연 풀 연결(동시 요청)에서만 오류가 났다(troubleshooting/0008).
   */
  async reconcile(poNo: string) {
    const po = await this.get(poNo);
    const note = await this.ensureDeliveryNote(po);
    const conn = this.em.getConnection();
    const [received] = await conn.execute<{ n: number | string }[]>(
      'select count(*) as n from terminal where purchase_order_id = ?',
      [po.id],
    );
    const missing = await conn.execute<{ serial_no: string }[]>(
      `select n.serial_no
         from purchase_order p
         join json_table(p.delivery_note, '$[*]' columns (ord for ordinality, serial_no varchar(32) collate utf8mb4_0900_ai_ci path '$')) n
         left join terminal t on t.serial_no = n.serial_no and t.purchase_order_id = p.id
        where p.id = ? and t.id is null
        order by n.ord`,
      [po.id],
    );
    const unexpected = await conn.execute<{ serial_no: string }[]>(
      `select distinct r.serial_no
         from scan_batch b
         join json_table(b.results, '$[*]' columns (serial_no varchar(64) collate utf8mb4_0900_ai_ci path '$.serialNo', result varchar(30) collate utf8mb4_0900_ai_ci path '$.result')) r
        where b.po_no = ? and r.result = 'NOT_IN_DELIVERY_NOTE'
        order by r.serial_no`,
      [po.poNo],
    );
    return {
      poNo: po.poNo,
      modelCode: po.model.code,
      status: po.status,
      ordered: po.quantity,
      noted: note.length,
      received: Number(received.n),
      shortfall: po.quantity - note.length,
      missing: missing.map((r) => r.serial_no),
      unexpected: unexpected.map((r) => r.serial_no),
    };
  }

  /**
   * 발주 마감. 입고 스캔과 같은 발주 행 잠금(FOR UPDATE)을 잡으므로, 진행 중인 입고 스캔이 있으면 그것이 커밋된 뒤에 마감된다.
   * 마감 뒤의 입고 스캔은 같은 잠금 아래에서 CLOSED를 보고 422로 거절된다.
   */
  async close(poNo: string, actor: string) {
    const { id } = await this.get(poNo);
    await this.em.fork().transactional(async (tx) => {
      const po = await tx.findOneOrFail(PurchaseOrder, id, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (po.status === PurchaseOrderStatus.CLOSED) {
        throw new BusinessError(422, 'PO_ALREADY_CLOSED', `발주 ${po.poNo}은(는) 이미 마감됐습니다.`);
      }
      po.status = PurchaseOrderStatus.CLOSED;
      po.closedAt = new Date();
      po.closedBy = actor;
    });
    const closed = await this.em.fork().findOneOrFail(PurchaseOrder, id);
    return { ...(await this.reconcile(poNo)), status: closed.status, closedAt: closed.closedAt?.toISOString() ?? null, closedBy: closed.closedBy };
  }

  async get(poNo: string): Promise<PurchaseOrder> {
    const po = await this.em.findOne(PurchaseOrder, { poNo }, { populate: ['model'] });
    if (!po) throw new NotFoundException(`발주 ${poNo}이(가) 없습니다.`);
    return po;
  }
}
