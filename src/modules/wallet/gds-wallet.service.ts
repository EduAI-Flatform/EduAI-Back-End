import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  GdsReservationStatus, GdsWalletEventKind, GdsWalletInvariantError, projectGdsWallet,
} from './gds-wallet.domain';

export type GdsWalletSummary = {
  available: boolean;
  mode: 'disabled' | 'sandbox';
  state: 'UNAVAILABLE' | 'NOT_LINKED' | 'SUSPENDED' | 'READY_SANDBOX' | 'RECONCILIATION_REQUIRED';
  /** VND as decimal strings to avoid JS BigInt serialization/precision errors. */
  balance: null | { settledMinor: string; reservedMinor: string; availableMinor: string; currency: 'VND' };
  paymentEnabled: false; // Integration with canonical settlement is NOT present.
  topupEnabled: false; // Partner funding confirmation is NOT present.
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
    const link = await this.prisma.buyerWalletLink.findUnique({
      where: { buyerId }, include: { verifiedEvents: true, reservations: true },
    });
    const basis = { ...disabled, mode: 'sandbox' as const };
    if (!link) return { ...basis, state: 'NOT_LINKED' };
    if (link.status !== 'linked') return { ...basis, state: 'SUSPENDED' };
    try {
      const balance = projectGdsWallet(
        link.verifiedEvents.map((event) => ({
          providerEventId: event.providerEventId,
          providerTransactionId: event.providerTransactionId,
          kind: event.kind as GdsWalletEventKind,
          amountMinor: event.amountMinor,
          currency: event.currency as 'VND',
          orderId: event.orderId ?? undefined,
        })),
        link.reservations.map((reservation) => ({
          orderId: reservation.orderId,
          providerReservationId: reservation.providerReservationId,
          amountMinor: reservation.amountMinor,
          status: reservation.status as GdsReservationStatus,
        })),
      );
      return {
        ...basis, available: true, state: 'READY_SANDBOX',
        balance: {
          settledMinor: balance.settledMinor.toString(),
          reservedMinor: balance.reservedMinor.toString(),
          availableMinor: balance.availableMinor.toString(),
          currency: 'VND',
        },
      };
    } catch (error) {
      if (!(error instanceof GdsWalletInvariantError)) throw error;
      // Never display spendable funds if the mirror needs reconciliation.
      return { ...basis, state: 'RECONCILIATION_REQUIRED' };
    }
  }
}
