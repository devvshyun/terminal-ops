import { IsEnum, IsOptional } from 'class-validator';
import { BeforeIdQuery } from '../../common/keyset.js';
import { PurchaseOrderStatus } from '../purchase-order.entity.js';

/** GET /purchase-orders 조건(최근 발주부터, decisions/0039) */
export class ListPurchaseOrdersQuery extends BeforeIdQuery {
  @IsOptional()
  @IsEnum(PurchaseOrderStatus)
  status?: PurchaseOrderStatus;
}
