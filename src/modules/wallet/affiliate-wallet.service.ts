import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { RevenueFinanceService } from '../revenue-sharing/revenue-finance.service';
import { AffiliatePolicy, evaluateAffiliateAccrual } from '../affiliate/affiliate-domain';
import { affiliateOrderSelect } from '../affiliate/affiliate-source';
import { affiliatePlatformCapacity, affiliateWalletPosting } from './affiliate-wallet.rules';

/** Caller holds finance advisory lock before wallet locks. Uses the existing GDS journal. */
@Injectable()
export class AffiliateWalletService {
  constructor(private readonly finance: RevenueFinanceService) {}
  async syncOwner(tx: Prisma.TransactionClient, ownerId: string, recoveryOnly = false) {
    const settings = await tx.gdsWithdrawalSettings.findUnique({ where: { id: 'global' } });
    if (!settings?.processingEnabled && !recoveryOnly) return [];
    const records = await tx.affiliateAttribution.findMany({ where: { identity: { ownerId } }, orderBy: { id: 'asc' },
      include: { policy: true, order: { select: affiliateOrderSelect }, accruals: true } });
    const results: Array<{ id: string; status: string }> = [];
    for (const record of records) {
      const policy = record.policy.content as unknown as AffiliatePolicy;
      if (record.policy.group !== 'affiliate' || policy.fundingSource !== 'platform_fee'
        || policy.allocationPrecedence !== 'seller_entitlements_first') {
        results.push({ id: record.id, status: 'FUNDING_NOT_CONFIGURED' }); continue;
      }
      const applied = (await tx.affiliateWalletEffect.aggregate({ where: { accrual: { attributionId: record.id } }, _sum: { deltaMinor: true } }))._sum.deltaMinor ?? 0n;
      if (recoveryOnly && applied === 0n) continue;
      const now = new Date();
      const evaluated = evaluateAffiliateAccrual(policy, record.policyRevisionId, record.order, record.createdAt, now);
      if (evaluated.status !== 'evaluated') {
        if (applied > 0n) {
          throw new ConflictException('AFFILIATE_FUNDED_SOURCE_UNAVAILABLE');
        }
        results.push({ id: record.id, status: evaluated.reason ?? 'SOURCE_PENDING' }); continue;
      }
      if (!await this.finance.verifyAffiliateOrder(tx, record.orderId)) {
        if (applied > 0n) throw new ConflictException('AFFILIATE_UNVERIFIED_SETTLEMENT');
        results.push({ id: record.id, status: 'AFFILIATE_UNVERIFIED_SETTLEMENT' }); continue;
      }
      let accrual = record.accruals.find(row => row.sourceDigest === evaluated.sourceDigest);
      if (!accrual) accrual = await tx.affiliateAccrual.create({ data: {
        attributionId: record.id, sourceDigest: evaluated.sourceDigest,
        deltaMinor: evaluated.targetMinor - record.accruals.reduce((sum, row) => sum + row.deltaMinor, 0n),
        qualifyingAmountMinor: evaluated.qualifyingAmountMinor, commissionBps: policy.commissionBps,
        currency: policy.currency, holdUntil: evaluated.holdUntil,
      } });
      if (evaluated.holdUntil > now) { results.push({ id: record.id, status: 'HELD' }); continue; }
      const snapshots = await tx.revenueOrderSnapshot.findMany({ where: { orderId: record.orderId } });
      const allocations = await tx.commerceRefundAllocation.findMany({ where: {
        orderLineId: { in: snapshots.map(row => row.id) }, refund: { status: 'recorded', settlementId: record.order.confirmedSettlementId!, recordedAt: { lte: now } },
      } });
      let capacity: bigint;
      try {
        capacity = affiliatePlatformCapacity(snapshots.map(row => ({ ...row,
          refundedMinor: allocations.filter(a => a.orderLineId === row.id).reduce((sum, a) => sum + a.amountMinor, 0n),
        })), record.order.payableAmountMinor, evaluated.qualifyingAmountMinor);
      } catch (error) {
        if (applied > 0n || !(error instanceof ConflictException)) throw error;
        results.push({ id: record.id, status: error.message }); continue;
      }
      const target = evaluated.targetMinor < capacity ? evaluated.targetMinor : capacity;
      if (evaluated.targetMinor > capacity && target >= applied) {
        results.push({ id: record.id, status: 'AFFILIATE_PLATFORM_FEE_INSUFFICIENT' }); continue;
      }
      const delta = target - applied;
      if (recoveryOnly && delta >= 0n) continue;
      if (delta !== 0n) {
        await tx.gdsInternalWallet.createMany({ data: [{ buyerId: ownerId }], skipDuplicates: true });
        await tx.$queryRaw(Prisma.sql`SELECT id FROM gds_internal_wallets WHERE buyer_id=${ownerId}::uuid FOR UPDATE`);
        const wallet = await tx.gdsInternalWallet.findUniqueOrThrow({ where: { buyerId: ownerId } });
        await tx.affiliateWalletEffect.create({ data: { accrualId: accrual.id, walletId: wallet.id, deltaMinor: delta,
          ...affiliateWalletPosting(delta, wallet.availableMinor, wallet.debtMinor) } });
      }
      results.push({ id: record.id, status: evaluated.targetMinor > capacity ? 'AFFILIATE_PLATFORM_FEE_INSUFFICIENT' : 'SYNCED' });
    }
    return results;
  }
}
