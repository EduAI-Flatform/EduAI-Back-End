import { gdsWalletCapabilities } from './gds-wallet-capabilities';
import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GdsWithdrawalService } from './gds-withdrawal.service';

export type GdsWalletSummary = {
  available: boolean;
  mode: 'disabled' | 'sandbox' | 'production';
  state: 'UNAVAILABLE' | 'NOT_INITIALIZED' | 'SUSPENDED' | 'READY_SANDBOX' | 'READY_PRODUCTION' | 'RECONCILIATION_REQUIRED';
  /** VND as decimal strings to avoid JS BigInt serialization/precision errors. */
  balance: null | { settledMinor: string; reservedMinor: string; availableMinor: string; currency: 'VND' };
  paymentEnabled: boolean; // Separately gated from topups and recovery.
  topupEnabled: boolean; // Creating a QR is never evidence of wallet credit.
  withdrawalEnabled?: boolean;
  withdrawalMinimumMinor?: string;
  withdrawalMaximumMinor?: string;
  debtMinor?: string;
  activeTopup: null | {
    topupId: string;
    amountMinor: string;
    currency: 'VND';
    status: 'AWAITING_TRANSFER' | 'RECONCILING' | 'CREDITED' | 'REVIEW' | 'EXPIRED' | 'CANCELLED';
    gdsCredited: boolean;
    creditedAt: string | null;
  };
  /** Read-only, newest-first journal entries; never a substitute for provider proof. */
  recentTransactions: Array<{
    id: string;
    type: 'TOPUP_CREDIT' | 'RESERVE' | 'CAPTURE' | 'RELEASE' | 'WITHDRAWAL_RESERVE' | 'WITHDRAWAL_RELEASE' | 'WITHDRAWAL_PAID' | 'REVENUE_CREDIT' | 'REVENUE_REVERSAL';
    amountMinor: string;
    occurredAt: string;
    /** Owner-scoped request link; lets clients group withdrawal lifecycle postings. */
    withdrawalId?: string;
  }>;
};

@Injectable()
export class GdsWalletService {
  constructor(private readonly prisma: PrismaService, private readonly config: AppConfigService,
    @Optional() private readonly withdrawals?: GdsWithdrawalService) {}

  async summary(buyerId: string, topupId?: string): Promise<GdsWalletSummary> {
    const disabled: GdsWalletSummary = {
      available: false, mode: 'disabled', state: 'UNAVAILABLE', balance: null,
      paymentEnabled: false, topupEnabled: false, recentTransactions: [], activeTopup: null,
    };
    const capabilities = gdsWalletCapabilities(this.config);
    if (!capabilities.readEnabled) {
      return disabled;
    }
    const withdrawalSettings = this.withdrawals ? await this.withdrawals.settings() : null;
    if (topupId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(topupId)) {
      throw new BadRequestException('Invalid topup ID');
    }
    // Read completion before the balance. A completed intent must never be
    // returned alongside a balance read before its atomic journal posting.
    const activeTopup = topupId ? await this.topupStatus(buyerId, topupId) : null;
    // PAYW-04I changes the preferred model: this reads the isolated internal
    // prepaid journal projection, never the earlier partner-wallet mirror.
    let wallet = await this.prisma.gdsInternalWallet.findUnique({ where: { buyerId } });
    if (!wallet) {
      // Atomic conflict-ignore initialization never rewrites an existing balance or status.
      await this.prisma.gdsInternalWallet.createMany({ data: [{ buyerId }], skipDuplicates: true });
      wallet = await this.prisma.gdsInternalWallet.findUniqueOrThrow({ where: { buyerId } });
    }
    const basis = {
      ...disabled, mode: capabilities.mode, activeTopup,
      withdrawalEnabled: false,
      withdrawalMinimumMinor: withdrawalSettings?.minimumMinor ?? '50000',
      withdrawalMaximumMinor: withdrawalSettings?.maximumMinor ?? '10000000',
      debtMinor: (wallet.debtMinor ?? 0n).toString(),
      topupEnabled: capabilities.topupEnabled &&
        this.config.payos.environment === 'production' &&
        /^https:\/\//.test(this.config.app.publicAppUrl ?? '') &&
        Boolean(this.config.commerce.idempotencySecret),
    };
    if (wallet.status !== 'ACTIVE') return { ...basis, state: 'SUSPENDED', topupEnabled: false };
    if (typeof wallet.availableMinor !== 'bigint' || typeof wallet.heldMinor !== 'bigint' ||
        wallet.availableMinor < 0n || wallet.heldMinor < 0n) {
      return { ...basis, state: 'RECONCILIATION_REQUIRED', topupEnabled: false };
    }
    const journal = await this.prisma.gdsInternalJournal.findMany({
      where: { walletId: wallet.id },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 20,
      select: { id: true, kind: true, amountMinor: true, occurredAt: true, orderRef: true },
    });
    const allowed = new Set(['TOPUP_CREDIT', 'RESERVE', 'CAPTURE', 'RELEASE', 'WITHDRAWAL_RESERVE', 'WITHDRAWAL_RELEASE', 'WITHDRAWAL_PAID', 'REVENUE_CREDIT', 'REVENUE_REVERSAL']);
    if (journal.some((entry) => !allowed.has(entry.kind) || entry.amountMinor <= 0n ||
        !Number.isFinite(entry.occurredAt.getTime()))) {
      return { ...basis, state: 'RECONCILIATION_REQUIRED' };
    }
    return {
      ...basis, available: true, state: capabilities.mode === 'production' ? 'READY_PRODUCTION' : 'READY_SANDBOX',
      paymentEnabled: capabilities.checkoutEnabled,
      withdrawalEnabled: withdrawalSettings?.admissionEnabled === true && withdrawalSettings.processingEnabled && (wallet.debtMinor ?? 0n) === 0n,
      balance: {
        settledMinor: (wallet.availableMinor + wallet.heldMinor).toString(),
        reservedMinor: wallet.heldMinor.toString(),
        availableMinor: wallet.availableMinor.toString(), currency: 'VND',
      },
      recentTransactions: journal.map((entry) => ({
        id: entry.id,
        type: entry.kind as GdsWalletSummary['recentTransactions'][number]['type'],
        amountMinor: entry.amountMinor.toString(),
        occurredAt: entry.occurredAt.toISOString(),
        ...(['WITHDRAWAL_RESERVE', 'WITHDRAWAL_RELEASE', 'WITHDRAWAL_PAID'].includes(entry.kind) && entry.orderRef &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.orderRef)
          ? { withdrawalId: entry.orderRef } : {}),
      })),
    };
  }

  private async topupStatus(buyerId: string, topupId: string): Promise<GdsWalletSummary['activeTopup']> {
    const topup = await this.prisma.gdsInternalTopup.findFirst({
      where: { id: topupId, buyerId },
      select: {
        id: true, amountMinor: true, currency: true, status: true, expiresAt: true,
        creditedAt: true, collectionReference: true, signatureVerifiedAt: true, providerReconciledAt: true,
        journal: { select: { kind: true, amountMinor: true, collectionReference: true } },
        payosInbox: { select: { status: true } },
      },
    });
    if (!topup || topup.currency !== 'VND' || typeof topup.amountMinor !== 'bigint' || topup.amountMinor <= 0n) return null;
    const result = {
      topupId: topup.id, amountMinor: topup.amountMinor.toString(), currency: 'VND' as const,
      gdsCredited: false, creditedAt: null,
    };
    if (topup.status === 'CREDITED') {
      const hasCreditEvidence = validDate(topup.creditedAt) &&
        validDate(topup.signatureVerifiedAt) && validDate(topup.providerReconciledAt) &&
        topup.providerReconciledAt >= topup.signatureVerifiedAt &&
        Boolean(topup.collectionReference) && topup.journal?.kind === 'TOPUP_CREDIT' &&
        topup.journal.amountMinor === topup.amountMinor &&
        topup.journal.collectionReference === topup.collectionReference;
      return hasCreditEvidence
        ? { ...result, status: 'CREDITED', gdsCredited: true, creditedAt: topup.creditedAt!.toISOString() }
        : { ...result, status: 'REVIEW' };
    }
    if (topup.status === 'CANCELLED') return { ...result, status: 'CANCELLED' };
    if (topup.status === 'REVIEW' || topup.payosInbox.some((entry) => entry.status === 'REVIEW')) {
      return { ...result, status: 'REVIEW' };
    }
    if (topup.status === 'PAYOS_VERIFIED' || topup.payosInbox.some((entry) => entry.status === 'RECEIVED')) {
      return { ...result, status: 'RECONCILING' };
    }
    if (!validDate(topup.expiresAt)) return { ...result, status: 'REVIEW' };
    if (topup.expiresAt <= new Date()) return { ...result, status: 'EXPIRED' };
    return { ...result, status: topup.status === 'CREATED' || topup.status === 'PENDING_PAYOS'
      ? 'AWAITING_TRANSFER' : 'REVIEW' };
  }
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}
