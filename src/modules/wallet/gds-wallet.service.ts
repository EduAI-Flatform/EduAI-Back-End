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
  topupEnabled: false; // No public PayOS topup API or verified webhook adapter.
};

@Injectable()
export class GdsWalletService {
  constructor(private readonly prisma: PrismaService, private readonly config: AppConfigService) {}

  async summary(buyerId: string): Promise<GdsWalletSummary> {
    const disabled: GdsWalletSummary = {
      available: false, mode: 'disabled', state: 'UNAVAILABLE', balance: null,
      paymentEnabled: false, topupEnabled: false,
    };
    // A feature flag can NEVER make this wallet accessible on production.
    if (!this.config.gdsWallet.sandboxEnabled ||
        this.config.app.nodeEnv === 'production' || this.config.app.deploymentClass === 'production') {
      return disabled;
    }
    // PAYW-04I changes the preferred model: this reads the isolated internal
    // prepaid journal projection, never the earlier partner-wallet mirror.
    const wallet = await this.prisma.gdsInternalWallet.findUnique({ where: { buyerId } });
    const basis = { ...disabled, mode: 'sandbox' as const };
    if (!wallet) return { ...basis, state: 'NOT_INITIALIZED' };
    if (wallet.status !== 'ACTIVE') return { ...basis, state: 'SUSPENDED' };
    if (typeof wallet.availableMinor !== 'bigint' || typeof wallet.heldMinor !== 'bigint' ||
        wallet.availableMinor < 0n || wallet.heldMinor < 0n) {
      return { ...basis, state: 'RECONCILIATION_REQUIRED' };
    }
    return {
      ...basis, available: true, state: 'READY_SANDBOX',
      balance: {
        settledMinor: (wallet.availableMinor + wallet.heldMinor).toString(),
        reservedMinor: wallet.heldMinor.toString(),
        availableMinor: wallet.availableMinor.toString(), currency: 'VND',
      },
    };
  }
}
