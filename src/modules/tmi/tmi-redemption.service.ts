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
import type { TmiRewardResponse } from './tmi-reward.service';

const rewardRuntimeSelect = {
  id: true,
  title: true,
  description: true,
  kind: true,
  cost: true,
  status: true,
  quota: true,
  redeemedCount: true,
  startsAt: true,
  endsAt: true,
  inventoryMetadata: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TmiRewardSelect;

const learnerRewardSelect = rewardRuntimeSelect;

const redemptionSelect = {
  id: true,
  userId: true,
  rewardId: true,
  idempotencyKey: true,
  cost: true,
  createdAt: true,
} satisfies Prisma.TmiRedemptionSelect;

const adminRedemptionSelect = {
  id: true,
  userId: true,
  rewardId: true,
  cost: true,
  createdAt: true,
  reward: { select: { title: true, kind: true } },
} satisfies Prisma.TmiRedemptionSelect;

const adminLedgerSelect = {
  id: true,
  userId: true,
  kind: true,
  amount: true,
  adjustmentDirection: true,
  sourceType: true,
  occurredAt: true,
} satisfies Prisma.TmiLedgerEntrySelect;

type RewardRuntime = Prisma.TmiRewardGetPayload<{ select: typeof rewardRuntimeSelect }>;
type RedemptionRecord = Prisma.TmiRedemptionGetPayload<{ select: typeof redemptionSelect }>;
type AdminRedemptionRecord = Prisma.TmiRedemptionGetPayload<{ select: typeof adminRedemptionSelect }>;
type AdminLedgerRecord = Prisma.TmiLedgerEntryGetPayload<{ select: typeof adminLedgerSelect }>;

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

export interface TmiWalletResponse {
  current: number;
  earned: number;
  spent: number;
  expired: number;
}

export interface TmiLedgerHistoryItem {
  id: string;
  kind: TmiLedgerKind;
  amount: number;
  adjustmentDirection: TmiAdjustmentDirection | null;
  sourceType: string;
  occurredAt: Date;
}

export interface TmiAdminRedemptionItem extends AdminRedemptionRecord {}
export interface TmiAdminLedgerItem extends AdminLedgerRecord {}
export interface TmiAdminRedemptionPage {
  items: TmiAdminRedemptionItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export interface TmiAdminLedgerPage {
  items: TmiAdminLedgerItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
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

  async listAvailableRewards(query: { page: number; pageSize: number }): Promise<{ items: Omit<TmiRewardResponse, 'createdById'>[]; page: number; pageSize: number; total: number; totalPages: number }> {
    const now = new Date();
    const items = await this.prisma.tmiReward.findMany({ where: { status: TmiRewardStatus.active, startsAt: { lte: now }, endsAt: { gt: now } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: learnerRewardSelect });
    const available = items.filter((item) => item.quota === null || item.redeemedCount < item.quota);
    const total = available.length;
    const offset = (query.page - 1) * query.pageSize;
    return { items: available.slice(offset, offset + query.pageSize).map((item) => this.toLearnerResponse(item)), page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) };
  }

  async wallet(userId: string): Promise<TmiWalletResponse> {
    await this.assertUserExists(this.prisma, userId);
    const entries = await this.prisma.tmiLedgerEntry.findMany({ where: { userId }, select: { kind: true, amount: true, adjustmentDirection: true } });
    return this.summarizeWallet(entries);
  }

  async history(userId: string): Promise<TmiLedgerHistoryItem[]> {
    await this.assertUserExists(this.prisma, userId);
    return this.prisma.tmiLedgerEntry.findMany({ where: { userId }, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 100, select: { id: true, kind: true, amount: true, adjustmentDirection: true, sourceType: true, occurredAt: true } });
  }

  async listAdminRedemptions(query: { page: number; pageSize: number; userId?: string; rewardId?: string }): Promise<TmiAdminRedemptionPage> {
    const where: Prisma.TmiRedemptionWhereInput = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.rewardId ? { rewardId: query.rewardId } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.tmiRedemption.count({ where }),
      this.prisma.tmiRedemption.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize, select: adminRedemptionSelect }),
    ]);
    return { items, page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) };
  }

  async listAdminLedger(query: { page: number; pageSize: number; userId?: string }): Promise<TmiAdminLedgerPage> {
    const where: Prisma.TmiLedgerEntryWhereInput = query.userId ? { userId: query.userId } : {};
    const [total, items] = await Promise.all([
      this.prisma.tmiLedgerEntry.count({ where }),
      this.prisma.tmiLedgerEntry.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize, select: adminLedgerSelect }),
    ]);
    return { items, page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) };
  }

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

  private async assertUserExists(client: PrismaService, userId: string): Promise<void> {
    const user = await client.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException('TMI user not found');
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
    return this.summarizeWallet(entries).current;
  }

  private summarizeWallet(entries: LedgerBalanceEntry[]): TmiWalletResponse {
    let earned = 0; let spent = 0; let expired = 0;
    for (const entry of entries) {
      if (!Number.isInteger(entry.amount) || entry.amount <= 0) continue;
      if (entry.kind === TmiLedgerKind.earn || entry.kind === TmiLedgerKind.refund || (entry.kind === TmiLedgerKind.adjustment && entry.adjustmentDirection === TmiAdjustmentDirection.credit)) earned += entry.amount;
      if (entry.kind === TmiLedgerKind.redeem || (entry.kind === TmiLedgerKind.adjustment && entry.adjustmentDirection === TmiAdjustmentDirection.debit)) spent += entry.amount;
      if (entry.kind === TmiLedgerKind.expiry) { spent += entry.amount; expired += entry.amount; }
    }
    return { current: Math.max(0, earned - spent), earned, spent, expired };
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

  private toLearnerResponse(record: RewardRuntime): Omit<TmiRewardResponse, 'createdById'> {
    return {
      id: record.id,
      title: record.title,
      description: record.description,
      kind: record.kind,
      cost: record.cost,
      status: record.status,
      quota: record.quota,
      redeemedCount: record.redeemedCount,
      startsAt: record.startsAt,
      endsAt: record.endsAt,
      inventoryMetadata: record.inventoryMetadata as Record<string, unknown> | null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private toJsonInput(value: Prisma.JsonValue | null): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    return value === null ? Prisma.JsonNull : value as Prisma.InputJsonValue;
  }
}
