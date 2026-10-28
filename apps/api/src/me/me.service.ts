import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { MerchantShipmentView, MerchantTerminalDetail, MerchantTerminalPage, MerchantTerminalView, MerchantView } from '@terminal-ops/contracts';
import { ConnectivityService } from '../device/connectivity.service.js';
import type { MerchantScope } from '../merchant/merchant-scope.js';
import { Merchant } from '../merchant/merchant.entity.js';
import { ServiceTicket } from '../service/service-ticket.entity.js';
import { CarrierEvent, Shipment } from '../shipment/shipment.entities.js';
import type { Terminal } from '../terminal/terminal.entity.js';
import { TerminalStatusHistory } from '../terminal/terminal-status-history.entity.js';
import { TerminalStatus } from '../terminal/terminal-status.js';
import { TerminalService } from '../terminal/terminal.service.js';
import type { MeTerminalsQuery } from './me.dto.js';
import { merchantEvents, toMerchantShipmentView, toMerchantTerminalView } from './me.views.js';

/**
 * 가맹점주 화면의 단말기 묶음(보강 3, decisions/0059). 범위(어느 단말기가 보이나)는 TerminalService가 scope로 정하고(0053·0059),
 * 여기서는 그 단말기들에 접속 요약(운영 중만)과 이번 배정의 운송장(배송 중·배송 완료만)을 붙인다.
 * 쿼리 수는 쪽 크기와 상관없다: 목록 2(단말기·count) + 접속 Redis 파이프라인 1·스냅샷 0~1 + 운송장 0~3(운송장·이벤트·교체 접수).
 */
@Injectable()
export class MeService {
  constructor(
    private readonly em: EntityManager,
    private readonly terminals: TerminalService,
    private readonly connectivity: ConnectivityService,
  ) {}

  /** 로그인한 가맹점(화면 위쪽 매장 이름). 계정의 가맹점은 있어야 한다(merchantScopeOf가 확인) */
  async merchant(scope: MerchantScope): Promise<MerchantView> {
    const m = await this.em.fork().findOneOrFail(Merchant, scope.merchantId);
    return { code: m.code, name: m.name, address: m.address };
  }

  async terminalPage(query: MeTerminalsQuery, scope: MerchantScope): Promise<MerchantTerminalPage> {
    const page = await this.terminals.list(query, undefined, scope);
    return { ...page, items: await this.views(page.items) };
  }

  async terminalDetail(serialNo: string, scope: MerchantScope): Promise<MerchantTerminalDetail> {
    const terminal = await this.terminals.getBySerial(serialNo, scope);
    const [view] = await this.views([terminal]);
    const history = await this.em.fork().find(TerminalStatusHistory, { terminal: terminal.id }, { orderBy: { id: 'asc' } });
    return { ...view, events: merchantEvents(history) };
  }

  private async views(terminals: Terminal[]): Promise<MerchantTerminalView[]> {
    const live = terminals.filter((t) => t.status === TerminalStatus.IN_SERVICE);
    const moving = terminals.filter((t) => t.status === TerminalStatus.SHIPPED || t.status === TerminalStatus.DELIVERED);
    const connectivity = await this.connectivity.getMany(live);
    const shipments = await this.latestShipments(moving);
    return terminals.map((t) => toMerchantTerminalView(t, connectivity.get(t.id) ?? null, shipments.get(t.id) ?? null));
  }

  /**
   * 단말기마다 가장 최근 운송장(id가 가장 큰 것) — 배정 → 출고 순서라 배송 중·배송 완료인 단말기의 최근 운송장은 이번 배정의 것이다
   * (다시 출고하면 앞 운송장은 SUPERSEDED, decisions/0018). 교체 출고면 그 운송장을 가리키는 A/S 접수의 번호를 붙인다.
   */
  private async latestShipments(terminals: Terminal[]): Promise<Map<number, MerchantShipmentView>> {
    const out = new Map<number, MerchantShipmentView>();
    if (terminals.length === 0) return out;
    const em = this.em.fork();
    const all = await em.find(Shipment, { terminal: { $in: terminals.map((t) => t.id) } }, { orderBy: { id: 'desc' } });
    const latest = new Map<number, Shipment>();
    for (const s of all) if (!latest.has(s.terminal.id)) latest.set(s.terminal.id, s);
    const ids = [...latest.values()].map((s) => s.id);
    const events = await em.find(CarrierEvent, { shipment: { $in: ids } }, { orderBy: { occurredAt: 'asc', id: 'asc' } });
    const tickets = await em.find(ServiceTicket, { outboundShipment: { $in: ids } });
    for (const [terminalId, s] of latest) {
      const ticket = tickets.find((t) => t.outboundShipment?.id === s.id);
      out.set(terminalId, toMerchantShipmentView(s, events.filter((e) => e.shipment.id === s.id), ticket?.id ?? null));
    }
    return out;
  }
}
