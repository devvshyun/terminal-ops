import { randomUUID } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityManager, IsolationLevel, LoadStrategy, LockMode } from '@mikro-orm/mysql';
import { BusinessError } from '../common/domain-errors.js';
import { beforeIdWhere, keysetPage } from '../common/keyset.js';
import { TerminalModel } from '../terminal/terminal-model.entity.js';
import type { CreatePurchaseOrderDto } from './dto/create-purchase-order.dto.js';
import type { ListPurchaseOrdersQuery } from './dto/list-purchase-orders.query.js';
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
   * - noted: 납품 명세의 서로 다른 시리얼 수
   * - shortfall = ordered(발주 수량) - noted. 음수일 수 있고 0으로 자르지 않는다(공장이 더 보냈다는 뜻이 그대로 보이게).
   * - received: 이 발주로 입고 스캔돼 등록된 단말기 수
   * - missing: 명세에 있는데 아직 이 발주로 입고되지 않은 시리얼(명세 순서). shortfall과 다르다: shortfall은 "명세가 발주보다 적은 수",
   *   missing은 "명세에는 있는데 이 발주로 안 들어온 시리얼"이다. JSON_TABLE로 명세를 행으로 펼쳐 단말기와 LEFT JOIN.
   *   공장이 명세에 같은 시리얼을 두 번 넣지는 않는다고 보지만, 들어와도 한 번만 세도록 serial_no로 묶는다(GROUP BY, 처음 나온 자리 순서).
   * - unexpected: 입고 스캔에서 명세에 없다고 거절된 시리얼(scan_batch.results의 NOT_IN_DELIVERY_NOTE)
   * 세 쿼리는 한 트랜잭션(REPEATABLE READ)에서 돌려 같은 시점의 스냅숏을 본다. 따로 돌리면 사이에 입고 스캔이 커밋돼
   * received와 missing이 서로 맞지 않을 수 있다(예: received는 그 박스 전, missing은 그 박스 후).
   * JSON_TABLE 열은 연결의 collation을 따른다. 연결 collation은 설정(mikro-orm.config.ts의 driverOptions.charset)으로 테이블과 같은
   * utf8mb4_0900_ai_ci로 맞췄지만(decisions/0025), 쿼리가 연결 설정에 기대지 않도록 열 정의에도 collate를 적는다(troubleshooting/0008).
   * 그러면 serial_no unique 인덱스(eq_ref)도 쓴다.
   */
  async reconcile(poNo: string) {
    const po = await this.get(poNo);
    const note = await this.ensureDeliveryNote(po);
    const { received, missing, unexpected } = await this.em.fork().transactional(
      async (tx) => {
        const [received] = await tx.execute<{ n: number | string }[]>(
          'select count(*) as n from terminal where purchase_order_id = ?',
          [po.id],
        );
        const missing = await tx.execute<{ serial_no: string }[]>(
          `select n.serial_no
             from purchase_order p
             join json_table(p.delivery_note, '$[*]' columns (ord for ordinality, serial_no varchar(32) collate utf8mb4_0900_ai_ci path '$')) n
             left join terminal t on t.serial_no = n.serial_no and t.purchase_order_id = p.id
            where p.id = ? and t.id is null
            group by n.serial_no
            order by min(n.ord)`,
          [po.id],
        );
        const unexpected = await tx.execute<{ serial_no: string }[]>(
          `select distinct r.serial_no
             from scan_batch b
             join json_table(b.results, '$[*]' columns (serial_no varchar(64) collate utf8mb4_0900_ai_ci path '$.serialNo', result varchar(30) collate utf8mb4_0900_ai_ci path '$.result')) r
            where b.po_no = ? and r.result = 'NOT_IN_DELIVERY_NOTE'
            order by r.serial_no`,
          [po.poNo],
        );
        return { received, missing, unexpected };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
    const noted = new Set(note).size;
    return {
      poNo: po.poNo,
      modelCode: po.model.code,
      status: po.status,
      ordered: po.quantity,
      noted,
      received: Number(received.n),
      shortfall: po.quantity - noted,
      missing: missing.map((r) => r.serial_no),
      unexpected: unexpected.map((r) => r.serial_no),
    };
  }

  /**
   * 발주 마감. 입고 스캔과 같은 발주 행 잠금(FOR UPDATE)을 잡으므로, 진행 중인 입고 스캔이 있으면 그것이 커밋된 뒤에 마감된다.
   * 마감 뒤의 입고 스캔은 같은 잠금 아래에서 CLOSED를 보고 422로 거절된다.
   * 명세는 마감 트랜잭션 전에(밖에서) 받는다. 응답의 대조 결과에 명세가 필요한데, 마감을 커밋한 뒤 공장 호출이 실패하면
   * "마감은 됐는데 요청은 502"가 되기 때문이다. 먼저 받아 두면 공장이 실패할 때 마감하지 않고 502로 끝난다(HTTP를 트랜잭션 안에 두지 않는 것은 decisions/0012와 같음).
   */
  async close(poNo: string, actor: string) {
    const found = await this.get(poNo);
    if (found.status !== PurchaseOrderStatus.CLOSED) await this.ensureDeliveryNote(found);
    await this.em.fork().transactional(async (tx) => {
      const po = await tx.findOneOrFail(PurchaseOrder, found.id, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (po.status === PurchaseOrderStatus.CLOSED) {
        throw new BusinessError(422, 'PO_ALREADY_CLOSED', `발주 ${po.poNo}은(는) 이미 마감됐습니다.`);
      }
      po.status = PurchaseOrderStatus.CLOSED;
      po.closedAt = new Date();
      po.closedBy = actor;
    });
    const closed = await this.em.fork().findOneOrFail(PurchaseOrder, found.id);
    return { ...(await this.reconcile(poNo)), status: closed.status, closedAt: closed.closedAt?.toISOString() ?? null, closedBy: closed.closedBy };
  }

  /** 발주 목록(최근 것부터, id 키셋 — decisions/0039). 화면의 입고 스캔 발주 선택과 입고 대조 목록 */
  async list(q: ListPurchaseOrdersQuery) {
    const rows = await this.em.fork().find(
      PurchaseOrder,
      { ...beforeIdWhere(q.beforeId), ...(q.status ? { status: q.status } : {}) },
      { populate: ['model'], strategy: LoadStrategy.SELECT_IN, orderBy: { id: 'desc' }, limit: q.limit + 1 },
    );
    return keysetPage(rows, q.limit);
  }

  async get(poNo: string): Promise<PurchaseOrder> {
    const po = await this.em.findOne(PurchaseOrder, { poNo }, { populate: ['model'] });
    if (!po) throw new NotFoundException(`발주 ${poNo}이(가) 없습니다.`);
    return po;
  }
}
