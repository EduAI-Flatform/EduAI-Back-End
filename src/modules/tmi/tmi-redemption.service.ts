import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TmiAdjustmentDirection,
  TmiEntitlementStatus,
  TmiLedgerKind,
  TmiRewardStatus,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AdjustTmiBalanceDto } from './dto/adjust-tmi-balance.dto';
import { RedeemTmiRewardDto } from './dto/redeem-tmi-reward.dto';
import { RefundTmiRedemptionDto } from './dto/refund-tmi-redemption.dto';

const rewardRuntimeSelect = {
  id: true,
  title: true,
  kind: true,
  cost: true,
  status: true,
  quota: true,
  redeemedCount: true,
  startsAt: true,
  endsAt: true,
  inventoryMetadata: true,
} satisfies Prisma.TmiRewardSelect;

const redemptionSelect = {
  id: true,
  userId: true,
  rewardId: true,
  idempotencyKey: true,
  cost: true,
  createdAt: true,
} satisfies Prisma.TmiRedemptionSelect;

type RewardRuntime = Prisma.TmiRewardGetPayload<{ select: typeof rewardRuntimeSelect }>;
type RedemptionRecord = Prisma.TmiRedemptionGetPayload<{ select: typeof redemptionSelect }>;

export interface TmiRedemptionResponse extends RedemptionRecord {
  idempotent: boolean;
}

export interface TmiRefundResponse {
  redemptionId: string;
  amount: number;
  idempotent: boolean;
}

export interface TmiBalanceAdjustmentResponse {
  userId: string;
  amount: number;
  direction: TmiAdjustmentDirection;
  balance: number;
  idempotent: boolean;
}

type LedgerBalanceEntry = Pick<Prisma.TmiLedgerEntryGetPayload<{
  select: { kind: true; amount: true; adjustmentDirection: true };
}>, 'kind' | 'amount' | 'adjustmentDirection'>;

@Injectable()
export class TmiRedemptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async redeem(
    userId: string,
    rewardId: string,
    input: RedeemTmiRewardDto,
  ): Promise<TmiRedemptionResponse> {
    return this.runSerializable(async (tx) => {
      await this.lockUser(tx, userId);
      const existing = await tx.tmiRedemption.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey: input.idempotencyKey } },
        select: redemptionSelect,
      });
      if (existing) {
        if (existing.rewardId !== rewardId) {
          throw new ConflictException('Idempotency key was already used for another reward');
        }
        return this.toRedemptionResponse(existing, true);
      }

      const reward = await this.lockReward(tx, rewardId);
      this.assertRewardRedeemable(reward);
      const balance = await this.currentBalance(tx, userId);
      if (balance < reward.cost) throw new BadRequestException('Insufficient TMI balance');

      const redemption = await tx.tmiRedemption.create({
        data: { userId, rewardId, idempotencyKey: input.idempotencyKey, cost: reward.cost },
        select: redemptionSelect,
      });
      await tx.tmiEntitlement.create({
        data: {
          userId,
          redemptionId: redemption.id,
          kind: reward.kind,
          status: TmiEntitlementStatus.active,
          benefitMetadata: this.toJsonInput(reward.inventoryMetadata),
        },
        select: { id: true },
      });
      await tx.tmiLedgerEntry.create({
        data: {
          userId,
          redemptionId: redemption.id,
          kind: TmiLedgerKind.redeem,
          amount: reward.cost,
          sourceType: 'tmi_redemption',
          sourceId: redemption.id,
          actorId: userId,
          metadata: { rewardId, rewardKind: reward.kind },
        },
        select: { id: true },
      });
      await tx.tmiReward.update({ where: { id: rewardId }, data: { redeemedCount: { increment: 1 } }, select: { id: true } });
      await this.auditService.record({
        actorId: userId,
        action: AuditAction.TmiRewardRedeemed,
        target: { type: 'tmi_redemption', id: redemption.id },
        metadata: { rewardId, cost: reward.cost, idempotencyKey: input.idempotencyKey },
      }, tx);
      return this.toRedemptionResponse(redemption, false);
    });
  }

  async refund(
    actorId: string,
    redemptionId: string,
    input: RefundTmiRedemptionDto,
  ): Promise<TmiRefundResponse> {
    return this.runSerializable(async (tx) => {
      const redemption = await tx.tmiRedemption.findUnique({ where: { id: redemptionId }, select: redemptionSelect });
      if (!redemption) throw new NotFoundException('TMI redemption not found');
      await this.lockUser(tx, redemption.userId);
      const existing = await tx.tmiLedgerEntry.findFirst({
        where: { userId: redemption.userId, kind: TmiLedgerKind.refund, sourceType: 'tmi_redemption', sourceId: redemptionId },
        select: { id: true },
      });
      if (existing) return { redemptionId, amount: redemption.cost, idempotent: true };

      await tx.tmiLedgerEntry.create({
        data: {
          userId: redemption.userId,
          redemptionId,
          kind: TmiLedgerKind.refund,
          amount: redemption.cost,
          sourceType: 'tmi_redemption',
          sourceId: redemptionId,
          actorId,
          metadata: input.reason ? { reason: input.reason } : undefined,
        },
        select: { id: true },
      });
      await tx.tmiEntitlement.update({ where: { redemptionId }, data: { status: TmiEntitlementStatus.revoked, revokedAt: new Date() }, select: { id: true } });
      await this.auditService.record({
        actorId,
        action: AuditAction.TmiRewardRefunded,
        target: { type: 'tmi_redemption', id: redemptionId },
        metadata: { userId: redemption.userId, amount: redemption.cost, reason: input.reason ?? null },
      }, tx);
      return { redemptionId, amount: redemption.cost, idempotent: false };
    });
  }

  async adjustBalance(
    actorId: string,
    input: AdjustTmiBalanceDto,
  ): Promise<TmiBalanceAdjustmentResponse> {
    return this.runSerializable(async (tx) => {
      await this.lockUser(tx, input.userId);
      const existing = await tx.tmiLedgerEntry.findFirst({
        where: { userId: input.userId, kind: TmiLedgerKind.adjustment, sourceType: 'tmi_adjustment', sourceId: input.adjustmentKey },
        select: { id: true },
      });
      const balance = await this.currentBalance(tx, input.userId);
      if (existing) return { userId: input.userId, amount: input.amount, direction: input.direction, balance, idempotent: true };
      if (input.direction === TmiAdjustmentDirection.debit && balance < input.amount) {
        throw new BadRequestException('TMI adjustment cannot create a negative balance');
      }
      await tx.tmiLedgerEntry.create({
        data: {
          userId: input.userId,
          kind: TmiLedgerKind.adjustment,
          amount: input.amount,
          adjustmentDirection: input.direction,
          sourceType: 'tmi_adjustment',
          sourceId: input.adjustmentKey,
          actorId,
          metadata: { reason: input.reason },
        },
        select: { id: true },
      });
      await this.auditService.record({
        actorId,
        action: AuditAction.TmiBalanceAdjusted,
        target: { type: 'tmi_user_balance', id: input.userId },
        metadata: { amount: input.amount, direction: input.direction, adjustmentKey: input.adjustmentKey, reason: input.reason },
      }, tx);
      return {
        userId: input.userId,
        amount: input.amount,
        direction: input.direction,
        balance: input.direction === TmiAdjustmentDirection.credit ? balance + input.amount : balance - input.amount,
        idempotent: false,
      };
    });
  }

  private async lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "users" WHERE id = ${userId} AND deleted_at IS NULL FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundException('TMI user not found');
  }

  private async lockReward(tx: Prisma.TransactionClient, rewardId: string): Promise<RewardRuntime> {
    await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "tmi_rewards" WHERE id = ${rewardId} FOR UPDATE`;
    const reward = await tx.tmiReward.findUnique({ where: { id: rewardId }, select: rewardRuntimeSelect });
    if (!reward) throw new NotFoundException('TMI reward not found');
    return reward;
  }

  private assertRewardRedeemable(reward: RewardRuntime): void {
    const now = Date.now();
    if (reward.status !== TmiRewardStatus.active) throw new BadRequestException('TMI reward is not active');
    if (reward.startsAt.getTime() > now || reward.endsAt.getTime() <= now) throw new BadRequestException('TMI reward is outside its redemption window');
    if (reward.quota !== null && reward.redeemedCount >= reward.quota) throw new BadRequestException('TMI reward quota is exhausted');
  }

  private async currentBalance(tx: Prisma.TransactionClient, userId: string): Promise<number> {
    const entries = await tx.tmiLedgerEntry.findMany({
      where: { userId },
      select: { kind: true, amount: true, adjustmentDirection: true },
    });
    return entries.reduce((balance: number, entry: LedgerBalanceEntry) => {
      if (!Number.isInteger(entry.amount) || entry.amount <= 0) return balance;
      if (entry.kind === TmiLedgerKind.earn || entry.kind === TmiLedgerKind.refund || (entry.kind === TmiLedgerKind.adjustment && entry.adjustmentDirection === TmiAdjustmentDirection.credit)) return balance + entry.amount;
      return balance - entry.amount;
    }, 0);
  }

  private async runSerializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error: unknown) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034' || attempt === 2) throw error;
      }
    }
    throw new ConflictException('Concurrent TMI redemption conflict');
  }

  private toRedemptionResponse(record: RedemptionRecord, idempotent: boolean): TmiRedemptionResponse {
    return { ...record, idempotent };
  }

  private toJsonInput(value: Prisma.JsonValue | null): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    return value === null ? Prisma.JsonNull : value as Prisma.InputJsonValue;
  }
}
