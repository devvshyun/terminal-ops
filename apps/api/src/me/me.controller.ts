import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import type { BeforeIdPage, MerchantTerminalDetail, MerchantTerminalPage, MerchantTicketView, MerchantView } from '@terminal-ops/contracts';
import { Roles } from '../auth/access.js';
import { CurrentPrincipal, type Principal } from '../auth/principal.js';
import { Role } from '../auth/role.js';
import { merchantScopeOf } from '../merchant/merchant-scope.js';
import { OpenTicketDto } from '../service/dto/service-ticket.dto.js';
import { ReplacementService } from '../service/replacement.service.js';
import { ServiceTicketService } from '../service/service-ticket.service.js';
import { toMerchantTicketView } from '../service/service-ticket.views.js';
import { MeTerminalsQuery, MeTicketsQuery } from './me.dto.js';
import { MeService } from './me.service.js';

/**
 * 가맹점주(MERCHANT) 전용 API(decisions/0053). 일반 엔드포인트에 가맹점 조건을 끼워 넣지 않고 `/me/...`를 따로 둔다 —
 * 가맹점주는 이 컨트롤러 밖의 업무 API를 하나도 부를 수 없고(표 decisions/0052), 여기서는 모든 호출이 로그인한 가맹점의 범위를 서비스에 넘긴다.
 * 단말기는 점주용 모양 MerchantTerminalView(접속 요약·이번 배정의 운송장, 상세는 이번 배정부터의 상태 변화 — 보강 3 decisions/0059).
 */
@Controller('me')
export class MeController {
  constructor(
    private readonly me: MeService,
    private readonly tickets: ServiceTicketService,
    private readonly replacements: ReplacementService,
  ) {}

  /** 내 매장(이름·주소) — 점주 화면 위쪽(보강 3) */
  @Get('merchant')
  @Roles(Role.MERCHANT)
  async merchant(@CurrentPrincipal() p: Principal): Promise<MerchantView> {
    return this.me.merchant(merchantScopeOf(p));
  }

  @Get('terminals')
  @Roles(Role.MERCHANT)
  async terminalList(@CurrentPrincipal() p: Principal, @Query() query: MeTerminalsQuery): Promise<MerchantTerminalPage> {
    return this.me.terminalPage(query, merchantScopeOf(p));
  }

  @Get('terminals/:serialNo')
  @Roles(Role.MERCHANT)
  async terminal(@CurrentPrincipal() p: Principal, @Param('serialNo') serialNo: string): Promise<MerchantTerminalDetail> {
    return this.me.terminalDetail(serialNo, merchantScopeOf(p));
  }

  @Get('service-tickets')
  @Roles(Role.MERCHANT)
  async ticketList(@CurrentPrincipal() p: Principal, @Query() query: MeTicketsQuery): Promise<BeforeIdPage<MerchantTicketView>> {
    const { items, nextBeforeId } = await this.tickets.list(query, merchantScopeOf(p));
    return { items: items.map((i) => toMerchantTicketView(i, p.loginId)), nextBeforeId };
  }

  /** 접수 한 건(내 가맹점 접수만 — 남의 것은 없는 것과 같은 404). 진행 단계 화면용(보강 3) */
  @Get('service-tickets/:id')
  @Roles(Role.MERCHANT)
  async ticket(@CurrentPrincipal() p: Principal, @Param('id', ParseIntPipe) id: number): Promise<MerchantTicketView> {
    return toMerchantTicketView(await this.tickets.get(id, merchantScopeOf(p)), p.loginId);
  }

  /** A/S 접수(내 가맹점의 운영 중 단말기만). 저장되는 openedBy = 가맹점주 로그인 아이디, 응답은 openedByMe(MerchantTicketView) */
  @Post('service-tickets')
  @Roles(Role.MERCHANT)
  async openTicket(@CurrentPrincipal() p: Principal, @Body() dto: OpenTicketDto): Promise<MerchantTicketView> {
    return toMerchantTicketView(await this.tickets.open(dto, p.loginId, merchantScopeOf(p)), p.loginId);
  }

  /** 교체 단말기 설치 확인(내 가맹점 접수만). 이력 actor = 가맹점주 로그인 아이디 */
  @Post('service-tickets/:id/installations')
  @Roles(Role.MERCHANT)
  @HttpCode(200)
  async install(@CurrentPrincipal() p: Principal, @Param('id', ParseIntPipe) id: number): Promise<MerchantTicketView> {
    return toMerchantTicketView(await this.replacements.install(id, p.loginId, merchantScopeOf(p)), p.loginId);
  }
}
