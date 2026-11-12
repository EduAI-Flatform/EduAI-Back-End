import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { AffiliateWalletService } from './affiliate-wallet.service';
import { Prisma } from '../../../generated/prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { gdsWalletCapabilities } from './gds-wallet-capabilities';
import { GdsRevenueReviewDto, GdsWithdrawalPageDto } from './dto/gds-withdrawal.dto';
import { RevenueFinanceService } from '../revenue-sharing/revenue-finance.service';
import { isRetryableGdsTransaction } from './gds-transaction-retry';

// Same lock as authoritative revenue recognition, always before wallet row locks.
export const lockGdsFinance = (tx: Prisma.TransactionClient) =>
  tx.$queryRaw(Prisma.sql`SELECT 1::integer AS acquired FROM pg_advisory_xact_lock(73410201)`);

@Injectable()
export class GdsRevenueWalletService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(GdsRevenueWalletService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private cursor?: string;
  private affiliateCursor?: string;
  constructor(private readonly prisma: PrismaService, private readonly config: AppConfigService, private readonly finance: RevenueFinanceService,
    private readonly affiliate: AffiliateWalletService) {}
  onApplicationBootstrap() {
    void this.runBatch();
    this.timer = setInterval(() => void this.runBatch(), 60000);
    this.timer.unref?.();
  }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  async runBatch() {
    if (this.running || !gdsWalletCapabilities(this.config).processingEnabled) return;
    this.running = true;
    try {
      const settings = await this.prisma.gdsWithdrawalSettings.findUnique({ where: { id: 'global' } });
      if (!settings?.processingEnabled) return;
      const periods = await this.prisma.revenueEarningPeriod.findMany({
        where: { ...(this.cursor ? { id: { gt: this.cursor } } : {}), entries: { some: { kind: 'recognized' } } },
        orderBy: { id: 'asc' }, take: 100, select: { id: true },
      });
      for (const period of periods) {
        try {
          await this.transaction(async tx => { await lockGdsFinance(tx); await this.syncPeriod(tx, period.id); });
        } catch { this.logger.warn('GDS revenue projection requires retry; no financial source was changed.'); }
      }
      this.cursor = periods.length === 100 ? periods[periods.length - 1].id : undefined;
      const identities = await this.prisma.affiliateIdentity.findMany({
        where: this.affiliateCursor ? { id: { gt: this.affiliateCursor } } : {}, orderBy: { id: 'asc' }, take: 50, select: { id: true, ownerId: true },
      });
      for (const identity of identities) {
        try { await this.transaction(async tx => { await lockGdsFinance(tx); await this.affiliate.syncOwner(tx, identity.ownerId); }); }
        catch { this.logger.warn('Affiliate wallet projection requires retry; source facts preserved.'); }
      }
      this.affiliateCursor = identities.length === 50 ? identities[49].id : undefined;
    } catch { this.logger.warn('GDS revenue worker requires retry.'); }
    finally { this.running = false; }
  }

  /** Caller holds finance lock before any wallet lock. Reconcile refunds before cash-out decisions. */
  async syncBeforeSpend(tx: Prisma.TransactionClient, ownerId: string) {
    return this.affiliate.syncOwner(tx, ownerId, true);
  }

  async syncOwner(tx: Prisma.TransactionClient, ownerId: string) {
    const settings = await tx.gdsWithdrawalSettings.findUniqueOrThrow({ where: { id: 'global' } });
    if (!settings.processingEnabled) return;
    await this.affiliate.syncOwner(tx, ownerId);
    const periods = await tx.revenueEarningPeriod.findMany({
      where: { sellerId: ownerId, entries: { some: { kind: 'recognized' } } }, orderBy: { id: 'asc' }, select: { id: true, snapshotId: true },
    });
    const reconciled = new Set<string>();
    for (const period of periods) {
      await this.syncPeriod(tx, period.id, !reconciled.has(period.snapshotId));
      reconciled.add(period.snapshotId);
    }
  }

  private async syncPeriod(tx: Prisma.TransactionClient, periodId: string, reconcile = true) {
    if (reconcile && !await this.finance.reconcileWalletPeriod(tx, periodId)) throw new ConflictException('GDS_REVENUE_UNVERIFIED_SOURCE');
    const period = await tx.revenueEarningPeriod.findUniqueOrThrow({ where: { id: periodId }, include: { entries: true } });
    const recognized = period.entries.find(e => e.kind === 'recognized');
    if (!recognized) return;
    const settings = await tx.gdsWithdrawalSettings.findUniqueOrThrow({ where: { id: 'global' } });
    if (!settings.processingEnabled) return;
    await tx.gdsInternalWallet.createMany({ data: [{ buyerId: period.sellerId }], skipDuplicates: true });
    const wallet = await tx.gdsInternalWallet.findUniqueOrThrow({ where: { buyerId: period.sellerId } });
    let projection = await tx.gdsRevenueProjection.findUnique({ where: { periodId } });
    if (!projection) projection = await tx.gdsRevenueProjection.create({ data: {
      periodId, walletId: wallet.id, reviewRequired: recognized.createdAt <= settings.revenueCutoffAt,
    } });
    if (projection.reviewRequired) return;
    const net = period.entries.filter(e => ['recognized', 'refund_recognized'].includes(e.kind)).reduce((sum, e) => sum + e.amountMinor, 0n);
    if (net < 0n) throw new ConflictException('GDS_REVENUE_NEGATIVE_SOURCE');
    const delta = net - projection.historicalPaidMinor - projection.appliedNetMinor;
    if (delta === 0n) return;
    await tx.$queryRaw(Prisma.sql`SELECT id FROM gds_internal_wallets WHERE id=${wallet.id}::uuid FOR UPDATE`);
    const fresh = await tx.gdsInternalWallet.findUniqueOrThrow({ where: { id: wallet.id } });
    const debtDelta = delta > 0n ? -min(delta, fresh.debtMinor) : -delta - min(-delta, fresh.availableMinor);
    await tx.gdsRevenueEffect.create({ data: {
      projectionId: projection.id, revision: projection.revision + 1, deltaMinor: delta,
      availableDeltaMinor: delta + debtDelta, debtDeltaMinor: debtDelta,
    } });
  }

  async reviews(query: GdsWithdrawalPageDto) {
    const where = { reviewRequired: true };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.gdsRevenueProjection.count({ where }),
      this.prisma.gdsRevenueProjection.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ]);
    const items = await Promise.all(rows.map(async row => {
      const period = await this.prisma.revenueEarningPeriod.findUniqueOrThrow({ where: { id: row.periodId }, include: { entries: true } });
      return { ...row, ownerId: period.sellerId, appliedNetMinor: row.appliedNetMinor.toString(), historicalPaidMinor: row.historicalPaidMinor.toString(),
        recognizedMinor: period.entries.filter(e => e.kind === 'recognized').reduce((sum,e) => sum+e.amountMinor,0n).toString(),
        netMinor: period.entries.filter(e => ['recognized','refund_recognized'].includes(e.kind)).reduce((sum,e) => sum+e.amountMinor,0n).toString() };
    }));
    return { items, total, page: query.page, pageSize: query.pageSize, totalPages: Math.ceil(total / query.pageSize) };
  }

  async approveReview(actorId: string, id: string, input: GdsRevenueReviewDto) {
    return this.transaction(async tx => {
      await lockGdsFinance(tx);
      const projection = await tx.gdsRevenueProjection.findUnique({ where: { id } });
      if (!projection) throw new NotFoundException('GDS_REVENUE_REVIEW_NOT_FOUND');
      if (!projection.reviewRequired) throw new ConflictException('GDS_REVENUE_ALREADY_REVIEWED');
      const wallet = await tx.gdsInternalWallet.findUniqueOrThrow({ where: { id: projection.walletId } });
      if (wallet.buyerId === actorId) throw new ForbiddenException('GDS_SELF_REVIEW_FORBIDDEN');
      const period = await tx.revenueEarningPeriod.findUniqueOrThrow({ where: { id: projection.periodId }, include: { entries: true } });
      const recognized = period.entries.filter(e => e.kind === 'recognized').reduce((sum,e) => sum+e.amountMinor,0n);
      if (BigInt(input.paidMinor) > recognized) throw new ConflictException('GDS_REVENUE_REVIEW_EXCEEDS_RECOGNIZED');
      await tx.gdsRevenueProjection.update({ where: { id }, data: {
        reviewRequired: false, historicalPaidMinor: BigInt(input.paidMinor), reviewedById: actorId, reviewedAt: new Date(), reviewReason: input.reason,
      } });
      await tx.auditLog.create({ data: { actorId, action: 'gds.revenue.reviewed', targetType: 'gds_revenue_projection', targetId: id,
        metadataJson: { historicalPaidMinor: input.paidMinor, reason: input.reason } } });
      return { id, reviewRequired: false };
    });
  }

  async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.prisma.$transaction(work, { isolationLevel: 'Serializable', timeout: 30000 }); }
      catch (error) {
        if (isRetryableGdsTransaction(error) && attempt < 3) continue;
        throw error;
      }
    }
  }
}
const min = (a: bigint, b: bigint) => a < b ? a : b;
