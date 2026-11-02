import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';

export type GdsWalletSummary = {
  available: boolean;
  mode: 'disabled' | 'sandbox';
  state: 'UNAVAILABLE' | 'NOT_INITIALIZED' | 'SUSPENDED' | 'READY_SANDBOX' | 'RECONCILIATION_REQUIRED';
  /** VND as decimal strings to avoid JS BigInt serialization/precision errors. */
  balance: null | { settledMinor: string; reservedMinor: string; availableMinor: string; currency: 'VND' };
  paymentEnabled: false; // Canonical Commerce settlement integration is NOT present.
  topupEnabled: boolean; // QR preview only; never means wallet crediting.
  /** Read-only, newest-first journal entries; never a substitute for provider proof. */
  recentTransactions: Array<{
    id: string;
    type: 'TOPUP_CREDIT' | 'RESERVE' | 'CAPTURE' | 'RELEASE';
    amountMinor: string;
    occurredAt: string;
  }>;
};

@Injectable()
export class GdsWalletService {
  constructor(private readonly prisma: PrismaService, private readonly config: AppConfigService) {}

  async summary(buyerId: string): Promise<GdsWalletSummary> {
    const disabled: GdsWalletSummary = {
      available: false, mode: 'disabled', state: 'UNAVAILABLE', balance: null,
      paymentEnabled: false, topupEnabled: false, recentTransactions: [],
    };
    // A feature flag can NEVER make this wallet accessible on production.
    if (!this.config.gdsWallet.sandboxEnabled ||
        this.config.app.nodeEnv === 'production' || this.config.app.deploymentClass === 'production') {
      return disabled;
    }
    // PAYW-04I changes the preferred model: this reads the isolated internal
    // prepaid journal projection, never the earlier partner-wallet mirror.
    const wallet = await this.prisma.gdsInternalWallet.findUnique({ where: { buyerId } });
    const basis = {
      ...disabled, mode: 'sandbox' as const,
      topupEnabled: this.config.gdsWallet.qrPreviewEnabled &&
        this.config.app.deploymentClass === 'uat' &&
        /^\d{6,32}$/.test(this.config.gdsWallet.receivingAccount ?? ''),
    };
    if (!wallet) return { ...basis, state: 'NOT_INITIALIZED' };
    if (wallet.status !== 'ACTIVE') return { ...basis, state: 'SUSPENDED' };
    if (typeof wallet.availableMinor !== 'bigint' || typeof wallet.heldMinor !== 'bigint' ||
        wallet.availableMinor < 0n || wallet.heldMinor < 0n) {
      return { ...basis, state: 'RECONCILIATION_REQUIRED' };
    }
    const journal = await this.prisma.gdsInternalJournal.findMany({
      where: { walletId: wallet.id },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 20,
      select: { id: true, kind: true, amountMinor: true, occurredAt: true },
    });
    const allowed = new Set(['TOPUP_CREDIT', 'RESERVE', 'CAPTURE', 'RELEASE']);
    if (journal.some((entry) => !allowed.has(entry.kind) || entry.amountMinor <= 0n ||
        !Number.isFinite(entry.occurredAt.getTime()))) {
      return { ...basis, state: 'RECONCILIATION_REQUIRED' };
    }
    return {
      ...basis, available: true, state: 'READY_SANDBOX',
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
      })),
    };
  }
}
