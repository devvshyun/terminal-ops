import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/mysql';
import type { Redis } from 'ioredis';
import { deviceKeys } from '../device/device-keys.js';
import { OfferStore } from '../device/offer-store.js';
import { REDIS } from '../redis/redis.provider.js';
import type { FirmwareReportDto } from './dto/firmware.dto.js';
import { FirmwareRolloutTarget, TargetStatus } from './firmware.entities.js';

export interface ReportResult {
  serialNo: string;
  rolloutId: number;
  /** 보고 뒤 대상 상태 */
  status: TargetStatus;
  /** 이미 보고됐거나 시간 초과였던 대상이라 바꾸지 않았다 */
  alreadyReported: boolean;
}

/**
 * 단말기의 펌웨어 업데이트 결과 보고(F8). 대상 행 하나만 PK + 상태 조건(OFFERED)으로 갱신한다 — 배포 행은 잠그지 않는다
 * (배포 판단 job이 배포 행 → 대상 행 순서로 잠그므로, 보고가 배포 행을 기다리거나 순환 대기를 만들지 않는다, decisions/0031).
 * 이미 보고됐거나 TIMED_OUT이면 그대로 두고 지금 상태를 돌려준다(멱등, 단말기 재전송 안전).
 * 제안은 결과와 상관없이 내린다(실패한 단말기에 같은 버전을 다시 권하지 않는다). 성공이면 Redis 펌웨어 버전도 바로 바꾼다.
 */
@Injectable()
export class FirmwareReportService {
  constructor(
    private readonly em: EntityManager,
    private readonly offers: OfferStore,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async report(dto: FirmwareReportDto): Promise<ReportResult> {
    const em = this.em.fork();
    const [target] = await em.execute<{ id: number; status: TargetStatus }[]>(
      `select r.id, r.status from firmware_rollout_target r join terminal t on t.id = r.terminal_id
        where r.rollout_id = ? and t.serial_no = ?`,
      [dto.rolloutId, dto.serialNo],
    );
    if (!target) throw new NotFoundException(`배포 ${dto.rolloutId}에 단말기 ${dto.serialNo}이(가) 대상으로 없습니다.`);

    const status = dto.success ? TargetStatus.SUCCEEDED : TargetStatus.FAILED;
    const changed = await em.nativeUpdate(
      FirmwareRolloutTarget,
      { id: target.id, status: TargetStatus.OFFERED },
      { status, reportedAt: new Date(), reportedVersion: dto.version },
    );
    await this.offers.withdraw(dto.rolloutId, [dto.serialNo]);
    // 새로 성공한 보고만 Redis 펌웨어 버전을 바로 바꾼다. TIMED_OUT 뒤에 온 성공 보고(0행)는 바꾸지 않는다 —
    // 단말기가 다음 하트비트에 새 버전을 실어 보내므로 그때 맞춰진다(하트비트 주기만큼 늦을 뿐).
    if (changed > 0 && dto.success) await this.redis.hset(deviceKeys().firmware, dto.serialNo, dto.version);
    if (changed > 0) return { serialNo: dto.serialNo, rolloutId: dto.rolloutId, status, alreadyReported: false };
    // 0행: 처음 읽은 뒤 다른 보고·시간 초과가 먼저 바꿨을 수 있다. 처음 읽은 값(OFFERED일 수 있음) 대신 지금 상태를 돌려준다
    const [now] = await em.execute<{ status: TargetStatus }[]>('select status from firmware_rollout_target where id = ?', [target.id]);
    return { serialNo: dto.serialNo, rolloutId: dto.rolloutId, status: now?.status ?? target.status, alreadyReported: true };
  }
}
