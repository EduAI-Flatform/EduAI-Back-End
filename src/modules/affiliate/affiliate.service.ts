import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../config/app-config.service';
import * as QRCode from 'qrcode';
import { PlatformSettingsService } from '../platform/platform-settings.service';
import { affiliatePolicyReady, evaluateAffiliateAccrual, type AffiliatePolicy } from './affiliate-domain';
import type { AffiliateListQuery } from './affiliate.dto';
import { affiliateOrderSelect } from './affiliate-source';
import { AffiliateWalletService } from '../wallet/affiliate-wallet.service';
import { lockGdsFinance } from '../wallet/gds-revenue-wallet.service';
import { GdsWithdrawalService } from '../wallet/gds-withdrawal.service';
import { gdsWalletCapabilities } from '../wallet/gds-wallet-capabilities';
import { isRetryableGdsTransaction } from '../wallet/gds-transaction-retry';

function tokenHash(value: string) { return createHash('sha256').update(value).digest('hex'); }

@Injectable()
export class AffiliateService {
  constructor(private readonly prisma: PrismaService, private readonly settings: PlatformSettingsService, private readonly config: AppConfigService,
    @Optional() private readonly walletAdapter?: AffiliateWalletService, @Optional() private readonly withdrawals?: GdsWithdrawalService) {}

  async state(ownerId: string) {
    const effective = await this.settings.current();
    const policy = effective.settings.affiliate as AffiliatePolicy;
    const [identities, referralCount, sums] = await Promise.all([
      this.prisma.affiliateIdentity.findMany({ where: { ownerId }, orderBy: { kind: 'asc' }, select: { id: true, code: true, kind: true, status: true } }),
      this.prisma.affiliateAttribution.count({ where: { identity: { ownerId } } }),
      this.prisma.affiliateAccrual.aggregate({ where: { attribution: { identity: { ownerId } } }, _sum: { deltaMinor: true } }),
    ]);
    const wallet = this.walletAdapter ? await this.prisma.gdsInternalWallet.findUnique({ where: { buyerId: ownerId } }) : null;
    const withdrawalSettings = this.withdrawals ? await this.withdrawals.settings() : null;
    const readEnabled = this.walletAdapter ? gdsWalletCapabilities(this.config).readEnabled : false;
    const walletReady = !!this.walletAdapter && policy.fundingSource === 'platform_fee' && policy.allocationPrecedence === 'seller_entitlements_first';
    return {
      enabled: policy.enabled && affiliatePolicyReady(policy), policyRevisionId: effective.versions.affiliate ?? null,
      identities: await Promise.all(identities.map(async identity => {
        const base = this.config.app.publicAppUrl;
        const referralUrl = base ? new URL('/?ref=' + identity.code, base).toString() : null;
        return { ...identity, referralUrl, qrCodeDataUrl: referralUrl ? await QRCode.toDataURL(referralUrl, { width: 180, margin: 2 }) : null };
      })), totalReferrals: referralCount, accruedAmountMinor: (sums._sum.deltaMinor ?? 0n).toString(),
      currency: 'VND', availableBalanceMinor: readEnabled ? (wallet?.availableMinor ?? 0n).toString() : null,
      heldBalanceMinor: readEnabled ? (wallet?.heldMinor ?? 0n).toString() : null,
      debtMinor: readEnabled ? (wallet?.debtMinor ?? 0n).toString() : null,
      withdrawalEnabled: !!withdrawalSettings?.admissionEnabled && !!withdrawalSettings.processingEnabled
        && wallet?.status === 'ACTIVE' && wallet.debtMinor === 0n,
      withdrawalMinimumMinor: withdrawalSettings?.minimumMinor ?? null,
      walletCreditStatus: walletReady ? (withdrawalSettings?.processingEnabled ? 'READY' : 'PROCESSING_DISABLED') : 'FUNDING_NOT_CONFIGURED',
      balanceScope: 'GDS_WALLET', subAffiliateEnabled: false,
    };
  }

  async identity(ownerId: string, kind: 'general' | 'instructor', roles: string[]) {
    await this.activePolicy();
    if (kind === 'instructor' && !roles.includes('instructor')) throw new ForbiddenException('INSTRUCTOR_REFERRAL_NOT_ALLOWED');
    return this.prisma.affiliateIdentity.upsert({
      where: { ownerId_kind: { ownerId, kind } },
      create: { ownerId, kind, code: randomBytes(15).toString('hex') },
      update: {}, select: { id: true, kind: true, code: true, status: true },
    });
  }

  async visit(code: string) {
    const effective = await this.activePolicy();
    const identity = await this.prisma.affiliateIdentity.findUnique({
      where: { code }, select: { id: true, status: true, owner: { select: { status: true, deletedAt: true } } },
    });
    if (!identity || identity.status !== 'active' || identity.owner.status !== 'active' || identity.owner.deletedAt) throw new NotFoundException('REFERRAL_CODE_NOT_FOUND');
    const token = randomBytes(32).toString('hex');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + effective.policy.attributionDays * 86400000);
    await this.prisma.affiliateVisit.create({ data: {
      tokenHash: tokenHash(token), identityId: identity.id, policyRevisionId: effective.revisionId, createdAt: now, expiresAt,
    } });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async attribute(buyerId: string, orderId: string, visitToken: string) {
    await this.activePolicy();
    return this.transaction(async tx => {
      const order = await tx.commerceOrder.findFirst({ where: { id: orderId, buyerId },
        select: { id: true, buyerId: true, status: true, createdAt: true, confirmedSettlementId: true } });
      if (!order) throw new NotFoundException('ORDER_NOT_FOUND');
      const visit = await tx.affiliateVisit.findUnique({ where: { tokenHash: tokenHash(visitToken) },
        include: { identity: { include: { owner: { select: { status: true, deletedAt: true } } } }, policy: true } });
      if (!visit || visit.expiresAt <= new Date() || visit.createdAt > order.createdAt) throw new BadRequestException('REFERRAL_VISIT_INVALID_OR_EXPIRED');
      if (visit.identity.ownerId === buyerId) throw new ForbiddenException('SELF_REFERRAL_NOT_ALLOWED');
      if (visit.identity.status !== 'active') throw new ForbiddenException('REFERRAL_SUSPENDED');
      if (visit.identity.owner.status !== 'active' || visit.identity.owner.deletedAt) throw new ForbiddenException('REFERRAL_OWNER_UNAVAILABLE');
      const existing = await tx.affiliateAttribution.findUnique({ where: { orderId } });
      if (existing) {
        if (existing.visitId === visit.id && existing.buyerId === buyerId) return { attributed: true, id: existing.id };
        throw new ConflictException('ORDER_REFERRAL_ALREADY_ATTRIBUTED');
      }
      if (order.status !== 'pending_payment' || order.confirmedSettlementId) throw new ConflictException('REFERRAL_ORDER_ALREADY_FINALIZED');
      const policy = visit.policy.content as unknown as AffiliatePolicy;
      if (visit.policy.group !== 'affiliate' || visit.policy.status !== 'scheduled'
        || !visit.policy.effectiveAt || visit.policy.effectiveAt > visit.createdAt
        || !policy.enabled || !affiliatePolicyReady(policy)) throw new ForbiddenException('REFERRAL_POLICY_INVALID');
      const attributed = await tx.affiliateAttribution.create({ data: {
        buyerId, orderId, visitId: visit.id, identityId: visit.identityId, policyRevisionId: visit.policyRevisionId,
      } });
      await tx.auditLog.create({ data: { actorId: buyerId, action: 'AFFILIATE_ORDER_ATTRIBUTED', targetType: 'affiliate_attribution',
        targetId: attributed.id, metadataJson: { policyRevisionId: visit.policyRevisionId } } });
      return { attributed: true, id: attributed.id };
    });
  }

  /** Appends immutable business accruals, then projects eligible funded amounts into the GDS journal. */
  async reconcile(ownerId: string, after?: string) {
    return this.transaction(async tx => {
      if (this.walletAdapter) await lockGdsFinance(tx);
      const records = await tx.affiliateAttribution.findMany({
        where: { identity: { ownerId }, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: 'asc' }, take: 51,
        include: { order: { select: affiliateOrderSelect }, policy: true, accruals: true },
      });
      const results = [];
      for (const record of records.slice(0, 50)) {
        const policy = record.policy.content as unknown as AffiliatePolicy;
        if (record.policy.group !== 'affiliate' || !affiliatePolicyReady(policy)) {
          results.push({ id: record.id, status: 'unavailable', reason: 'POLICY_NOT_SUPPORTED' }); continue;
        }
        const result = evaluateAffiliateAccrual(policy, record.policyRevisionId, record.order, record.createdAt);
        if (result.status !== 'evaluated') {
          results.push({ id: record.id, status: result.status, reason: result.reason }); continue;
        }
        const existing = record.accruals.find(row => row.sourceDigest === result.sourceDigest);
        if (!existing) {
          const prior = record.accruals.reduce((sum, row) => sum + row.deltaMinor, 0n);
          const accrual = await tx.affiliateAccrual.create({ data: {
            attributionId: record.id, sourceDigest: result.sourceDigest, deltaMinor: result.targetMinor - prior,
            qualifyingAmountMinor: result.qualifyingAmountMinor, commissionBps: policy.commissionBps,
            currency: policy.currency, holdUntil: result.holdUntil,
          } });
          await tx.auditLog.create({ data: { actorId: ownerId, action: 'AFFILIATE_ACCRUAL_RECONCILED', targetType: 'affiliate_accrual',
            targetId: accrual.id, metadataJson: { policyRevisionId: record.policyRevisionId, attributionId: record.id } } });
        }
        results.push({ id: record.id, status: 'accrued' });
      }
      const walletResults = this.walletAdapter ? await this.walletAdapter.syncOwner(tx, ownerId) : [];
      return { items: results.map(row => ({ ...row,
        walletCreditStatus: walletResults.find(result => result.id === row.id)?.status ?? 'PROCESSING_DISABLED',
      })), nextCursor: records.length > 50 ? records[49].id : null };
    });
  }

  async list(ownerId: string, query: AffiliateListQuery) {
    const where: Prisma.AffiliateAttributionWhereInput = {
      identity: { ownerId, ...(query.kind ? { kind: query.kind } : {}) },
      ...(query.search ? { buyer: { fullName: { contains: query.search, mode: 'insensitive' } } } : {}),
      ...((query.from || query.to) ? { createdAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.affiliateAttribution.count({ where }),
      this.prisma.affiliateAttribution.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize, take: query.pageSize,
        select: { id: true, createdAt: true, policyRevisionId: true, buyer: { select: { fullName: true } },
          identity: { select: { kind: true } }, order: { select: { orderNumber: true, status: true } },
          policy: { select: { content: true } },
          accruals: { select: { deltaMinor: true, currency: true, holdUntil: true, createdAt: true, walletEffect: { select: { deltaMinor: true } } }, orderBy: { createdAt: 'desc' } } },
      }),
    ]);
    return { items: rows.map(row => ({
      id: row.id, userName: row.buyer.fullName, kind: row.identity.kind, createdAt: row.createdAt,
      orderNumber: row.order.orderNumber, orderStatus: row.order.status, policyRevisionId: row.policyRevisionId,
      accruedAmountMinor: row.accruals.length ? row.accruals.reduce((sum, e) => sum + e.deltaMinor, 0n).toString() : null,
      holdUntil: row.accruals[0]?.holdUntil ?? null, currency: 'VND',
      fundedAmountMinor: row.accruals.reduce((sum, e) => sum + (e.walletEffect?.deltaMinor ?? 0n), 0n).toString(),
      walletCreditStatus: this.rowWalletStatus(row),
    })), total, page: query.page, pageSize: query.pageSize, totalPages: Math.ceil(total / query.pageSize) };
  }

  private rowWalletStatus(row: { policy: { content: unknown }; accruals: Array<{ deltaMinor: bigint; holdUntil: Date; walletEffect: { deltaMinor: bigint } | null }> }) {
    const policy = row.policy.content as AffiliatePolicy;
    if (policy.fundingSource !== 'platform_fee' || policy.allocationPrecedence !== 'seller_entitlements_first') return 'FUNDING_NOT_CONFIGURED';
    if (!row.accruals.length) return 'SOURCE_PENDING';
    if (row.accruals.some(a => a.holdUntil > new Date())) return 'HELD';
    const accrued = row.accruals.reduce((sum, a) => sum + a.deltaMinor, 0n);
    const funded = row.accruals.reduce((sum, a) => sum + (a.walletEffect?.deltaMinor ?? 0n), 0n);
    return accrued === funded ? 'SYNCED' : 'AWAITING_FUNDING_OR_PROCESSING';
  }

  private async activePolicy() {
    const effective = await this.settings.current();
    const policy = effective.settings.affiliate as AffiliatePolicy;
    const revisionId = effective.versions.affiliate;
    if (!revisionId || !policy.enabled || !affiliatePolicyReady(policy)) throw new ForbiddenException('AFFILIATE_PROGRAM_DISABLED');
    return { policy, revisionId };
  }

  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.prisma.$transaction(work, { isolationLevel: 'Serializable', timeout: 15000 }); }
      catch (error) {
        if (attempt < 2 && isRetryableGdsTransaction(error)) continue;
        throw error;
      }
    }
    throw new ConflictException('AFFILIATE_CONCURRENT_UPDATE');
  }
}
