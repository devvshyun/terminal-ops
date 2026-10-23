import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/mysql';
import { CarrierAdapters } from '../carrier/carrier.adapters.js';
import { Carrier, CarrierEventCode, type NormalizedEvent } from '../carrier/carrier.types.js';
import { env } from '../config/env.js';
import { QUEUE } from '../queue/queue-names.js';
import { CarrierEvent, Shipment, ShipmentStatus, SyncRun } from '../shipment/shipment.entities.js';
import { TerminalStatus, TransitionSource } from '../terminal/terminal-status.js';
import { TransitionService } from '../terminal/transition.service.js';
import { TRACK_JOB_OPTIONS } from './retry-policy.js';

export interface TrackJobData {
  shipmentId: number;
}

export type TrackOutcome = 'OK' | 'DELIVERED' | 'NOOP' | 'SKIPPED' | 'ERROR';

interface RunCounts {
  fetched: number;
  inserted: number;
  duplicated: number;
}

/** 시스템 작업 actor는 `system:<작업명>` (decisions/0001) */
export const SYNC_ACTOR = 'system:carrier-sync';

/**
 * 택배 추적 자동 수집(F3).
 * - sweep: 배송 중인 운송장마다 추적 job을 넣는다(주기 실행).
 * - track: 한 운송장을 조회해 새 이벤트만 저장하고, 배송 완료면 단말기를 DELIVERED로 바꾼다.
 * 워커에는 요청 컨텍스트가 없으므로 작업마다 em.fork()를 쓴다.
 */
@Injectable()
export class CarrierSyncService {
  private readonly logger = new Logger(CarrierSyncService.name);

  constructor(
    private readonly em: EntityManager,
    private readonly adapters: CarrierAdapters,
    private readonly transitions: TransitionService,
    @InjectQueue(QUEUE.TRACK_BUNGAE) private readonly bungaeQueue: Queue<TrackJobData>,
    @InjectQueue(QUEUE.TRACK_NEURIMBO) private readonly neurimboQueue: Queue<TrackJobData>,
  ) {}

  /** 배송 중인 운송장마다 추적 job을 넣는다. 같은 운송장의 job이 아직 대기·처리·재시도 중이면 jobId가 같아 무시된다. */
  async sweep(): Promise<{ shipments: number }> {
    const shipments = await this.em.fork().find(Shipment, { status: ShipmentStatus.IN_TRANSIT }, { orderBy: { id: 'asc' } });
    for (const s of shipments) {
      const queue = s.carrier === Carrier.BUNGAE ? this.bungaeQueue : this.neurimboQueue;
      // BullMQ 커스텀 jobId에는 ':'를 쓸 수 없다(쓰면 add가 에러).
      await queue.add('track', { shipmentId: s.id }, { ...TRACK_JOB_OPTIONS, jobId: `track-${s.id}` });
    }
    return { shipments: shipments.length };
  }

  /** 운송장 하나를 조회해 반영한다. 실행마다 SyncRun을 한 줄 남긴다. */
  async track(shipmentId: number, ctx: { queue: string; attempt: number }): Promise<TrackOutcome> {
    const em = this.em.fork();
    const counts: RunCounts = { fetched: 0, inserted: 0, duplicated: 0 };
    const startedAt = new Date();
    let outcome: TrackOutcome = 'OK';
    let detail: string | null = null;
    let shipmentFound = false;
    try {
      const shipment = await em.findOne(Shipment, shipmentId);
      shipmentFound = !!shipment;
      if (!shipment || shipment.status !== ShipmentStatus.IN_TRANSIT) {
        detail = shipment ? `이미 ${shipment.status}` : '운송장 없음';
        return (outcome = 'SKIPPED');
      }

      const events = await this.adapters.get(shipment.carrier).track(shipment.trackingNo);
      counts.fetched = events.length;
      await this.storeEvents(em, shipment, events, counts);

      const delivered = events.find((e) => e.code === CarrierEventCode.DELIVERED);
      if (delivered) {
        const result = await this.applyDelivered(shipmentId, delivered.occurredAt);
        outcome = result.outcome;
        detail = result.detail;
      } else {
        shipment.lastSyncedAt = new Date();
        await em.flush();
      }
      return outcome;
    } catch (error) {
      outcome = 'ERROR';
      detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw error;
    } finally {
      await this.recordRun({ ...counts, job: ctx.queue, attempt: ctx.attempt, shipmentId: shipmentFound ? shipmentId : null, startedAt, outcome, detail });
    }
  }

  /**
   * 새 이벤트만 저장한다. ① 응답 안의 같은 eventKey를 하나로 ② 이미 저장된 키를 한 번에 조회해 제외 ③ 나머지 INSERT.
   * ③에서 unique 위반이 나면(다른 워커가 먼저 넣은 경쟁 상황) 중복으로 센다 — unique 제약이 마지막 안전망이다.
   */
  private async storeEvents(em: EntityManager, shipment: Shipment, events: NormalizedEvent[], counts: RunCounts): Promise<void> {
    const byKey = new Map<string, NormalizedEvent>();
    for (const e of events) if (!byKey.has(e.eventKey)) byKey.set(e.eventKey, e);
    counts.duplicated += events.length - byKey.size;

    const existing = await em.find(CarrierEvent, { shipment, eventKey: { $in: [...byKey.keys()] } });
    const known = new Set(existing.map((e) => e.eventKey));

    for (const e of byKey.values()) {
      if (known.has(e.eventKey)) {
        counts.duplicated += 1;
        continue;
      }
      try {
        // em.insert는 Unit of Work를 거치지 않는 단건 INSERT(자동 커밋)라 unique 위반이 나도 em이 망가지지 않는다.
        await em.insert(CarrierEvent, {
          shipment: shipment.id,
          eventKey: e.eventKey,
          code: e.code,
          occurredAt: e.occurredAt,
          raw: e.raw,
          receivedAt: new Date(),
        });
        counts.inserted += 1;
      } catch (error) {
        if (!(error instanceof UniqueConstraintViolationException)) throw error;
        counts.duplicated += 1;
      }
    }
  }

  /**
   * 배송 완료 반영: 한 트랜잭션에서 단말기 전이(SHIPPED → DELIVERED, BATCH)를 먼저 하고 운송장을 완료로 바꾼다.
   * 운송장이 IN_TRANSIT가 아니면(완료·SUPERSEDED) no-op이다.
   * 단말기가 이미 SHIPPED가 아니면(운영자가 먼저 수동으로 바꾼 경우 등) 단말기는 건드리지 않고 운송장만 완료한다(no-op, decisions/0014).
   * 운송장 완료는 `status = IN_TRANSIT` 조건부 UPDATE로 한다. 위의 읽기는 잠그지 않는 스냅샷 읽기라, 읽은 뒤 재출고가 옛 운송장을
   * SUPERSEDED로 바꿨어도 여기서는 IN_TRANSIT로 보인다. 조건 없이 덮어쓰면 그 SUPERSEDED가 사라진다(troubleshooting/0010).
   */
  private async applyDelivered(shipmentId: number, deliveredAt: Date): Promise<{ outcome: TrackOutcome; detail: string | null }> {
    return this.em.fork().transactional(async (tx) => {
      const shipment = await tx.findOneOrFail(Shipment, shipmentId, { populate: ['terminal'] });
      // 배송 중(IN_TRANSIT)인 운송장만 단말기를 바꾼다. 이미 완료됐거나, 그사이 같은 단말기가 다시 출고돼
      // SUPERSEDED가 된 옛 운송장이면 아무것도 하지 않는다(decisions/0018).
      if (shipment.status !== ShipmentStatus.IN_TRANSIT) return { outcome: 'NOOP', detail: `운송장이 이미 ${shipment.status}` };

      let result: { outcome: TrackOutcome; detail: string | null } = {
        outcome: 'NOOP',
        detail: `단말기 상태가 ${shipment.terminal.status}라 전이하지 않음`,
      };
      if (shipment.terminal.status === TerminalStatus.SHIPPED) {
        await this.transitions.transition(
          {
            serialNo: shipment.terminal.serialNo,
            to: TerminalStatus.DELIVERED,
            reason: `배송 완료: ${shipment.carrier} ${shipment.trackingNo}`,
            actor: SYNC_ACTOR,
            source: TransitionSource.BATCH,
          },
          tx,
        );
        result = { outcome: 'DELIVERED', detail: null };
      }
      // 잠금 순서는 단말기 UPDATE(전이 안에서 flush) → 운송장 UPDATE로, 재출고(recordShipment)와 같다.
      // 관리 중인 shipment 엔티티는 고치지 않는다. 고치면 커밋 때 조건 없는 UPDATE가 한 번 더 나간다.
      const updated = await tx.nativeUpdate(
        Shipment,
        { id: shipmentId, status: ShipmentStatus.IN_TRANSIT },
        { status: ShipmentStatus.DELIVERED, deliveredAt, lastSyncedAt: new Date() },
      );
      if (updated === 0) {
        // 단말기를 이미 바꿨다면 트랜잭션 전체를 되돌린다. job이 재시도되면 처음 조회에서 IN_TRANSIT가 아닌 것을 보고 건너뛴다.
        if (result.outcome === 'DELIVERED') {
          throw new Error(`운송장 ${shipmentId}이(가) 반영 중에 IN_TRANSIT가 아니게 되어 단말기 전이를 되돌림`);
        }
        return { outcome: 'NOOP', detail: '운송장이 반영 중에 IN_TRANSIT가 아니게 됨(재출고 등)' };
      }
      return result;
    });
  }

  private async recordRun(run: RunCounts & {
    job: string;
    attempt: number;
    shipmentId: number | null;
    startedAt: Date;
    outcome: TrackOutcome;
    detail: string | null;
  }): Promise<void> {
    try {
      const em = this.em.fork();
      em.create(SyncRun, {
        job: run.job,
        shipment: run.shipmentId,
        attempt: run.attempt,
        worker: env.workerName,
        outcome: run.outcome,
        startedAt: run.startedAt,
        finishedAt: new Date(),
        fetched: run.fetched,
        inserted: run.inserted,
        duplicated: run.duplicated,
        detail: run.detail?.slice(0, 500) ?? null,
      });
      await em.flush();
    } catch (error) {
      // 기록 실패가 수집 결과를 바꾸지 않게 한다.
      this.logger.error(`SyncRun 기록 실패: ${String(error)}`);
    }
  }
}
