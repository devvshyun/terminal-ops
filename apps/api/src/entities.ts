import { TerminalModel } from './terminal/terminal-model.entity.js';
import { Terminal } from './terminal/terminal.entity.js';
import { TerminalStatusHistory } from './terminal/terminal-status-history.entity.js';
import { InspectionItem } from './inspection/inspection-item.entity.js';
import { Inspection, InspectionResult } from './inspection/inspection.entities.js';
import { Merchant } from './merchant/merchant.entity.js';
import { CarrierEvent, Shipment, SyncRun } from './shipment/shipment.entities.js';
import { OutboxEvent } from './outbox/outbox-event.entity.js';
import { PurchaseOrder } from './purchase-order/purchase-order.entity.js';
import { ScanBatch } from './scan/scan-batch.entity.js';

/** 앱·마이그레이션·시드가 함께 쓰는 엔티티 목록. 엔티티를 추가하면 여기에도 추가한다. */
export const ENTITIES = [TerminalModel, Terminal, TerminalStatusHistory, InspectionItem, Inspection, InspectionResult, Merchant, Shipment, CarrierEvent, SyncRun, OutboxEvent, PurchaseOrder, ScanBatch];
