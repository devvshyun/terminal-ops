import { OptionalProps } from '@mikro-orm/core';
import { Entity, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { PartnerApiKey } from '../auth/partner-key.entity.js';
import { Partner } from './partner.entity.js';

/**
 * 외부용 API(`/partner/v1`) 호출 한 번(보강 7, decisions/0082). 키를 알아본 호출만 — 401(키 없음·틀림·폐기·만료)은 어느 업체인지 몰라 남기지 않는다.
 * 응답이 끝난 뒤 한 줄 넣는다(AuthGuard). 고치거나 지우는 API는 없다. 목록은 최근부터 업체별·키별로 보므로 (업체, id)·(키, id) 인덱스.
 */
@Entity({ tableName: 'partner_api_call' })
@Index({ properties: ['partner', 'id'] })
@Index({ properties: ['key', 'id'] })
export class PartnerCall {
  [OptionalProps]?: 'createdAt';

  @PrimaryKey()
  id!: number;

  /** 외래키 열 하나짜리 인덱스는 두지 않는다 — 위 (업체, id)·(키, id) 인덱스의 앞부분이 그 일을 한다(외래키도 그 인덱스를 쓴다) */
  @ManyToOne(() => Partner, { index: false })
  partner!: Partner;

  @ManyToOne(() => PartnerApiKey, { index: false })
  key!: PartnerApiKey;

  @Property({ length: 10 })
  method!: string;

  /** 쿼리를 뺀 경로(200자에서 자른다) */
  @Property({ length: 200 })
  path!: string;

  @Property({ type: 'smallint', unsigned: true })
  status!: number;

  @Property({ type: 'int', unsigned: true })
  durationMs!: number;

  @Property({ type: 'datetime', length: 3 })
  createdAt: Date = new Date();
}
