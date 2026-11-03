import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PAYMENT_PROVIDER_REGISTRY, PaymentRequestStatus } from '../payments/payment-provider';
import { PaymentProviderRegistry } from '../payments/payment-provider.registry';
import { isPayosLinkIdentity } from '../payments/payos-link.validation';

@Injectable()
export class GdsTopupCancellationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    @Inject(PAYMENT_PROVIDER_REGISTRY) private readonly providers: PaymentProviderRegistry,
  ) {}

  async cancel(buyerId: string, topupId: string) {
    const { app, gdsWallet, payos } = this.config;
    if (!gdsWallet.sandboxEnabled || !gdsWallet.qrPreviewEnabled ||
        app.nodeEnv === 'production' || app.deploymentClass !== 'uat') {
      throw new ForbiddenException('GDS PayOS cancellation is not available');
    }
    if (payos.environment !== 'production' || !/^https:\/\//.test(app.publicAppUrl ?? '') ||
        !this.config.commerce.idempotencySecret) {
      throw new ServiceUnavailableException('GDS QR configuration is incomplete');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(topupId)) {
      throw new BadRequestException('Invalid topup ID');
    }
    const topup = await this.prisma.gdsInternalTopup.findFirst({
      where: { id: topupId, buyerId },
      select: {
        id: true, status: true, paymentLinkId: true, payosOrderCode: true, amountMinor: true, currency: true,
        collectionReference: true, signatureVerifiedAt: true, providerReconciledAt: true, creditedAt: true,
        settlementReceivingAccountHash: true, journal: { select: { id: true } },
        reconciliation: { select: { id: true } }, payosInbox: { select: { id: true } },
      },
    });
    if (!topup) throw new NotFoundException('GDS topup not found');
    const result = { topupId, status: 'CANCELLED' as const, gdsCredited: false as const };
    if (topup.collectionReference || topup.signatureVerifiedAt || topup.providerReconciledAt ||
        topup.creditedAt || topup.settlementReceivingAccountHash || topup.journal ||
        topup.reconciliation || topup.payosInbox.length) {
      throw new ConflictException('GDS_TOPUP_CANCELLATION_CONFLICT');
    }
    if (topup.status === 'CANCELLED') return result;
    if (topup.status !== 'PENDING_PAYOS' || topup.currency !== 'VND' ||
        !isPayosLinkIdentity(topup.paymentLinkId) || topup.amountMinor <= 0n ||
        topup.payosOrderCode <= 0n || topup.payosOrderCode > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ConflictException('GDS_TOPUP_CANCELLATION_CONFLICT');
    }
    // Remote calls deliberately run without holding database locks. A signed
    // event or journal arriving meanwhile must win the conditional local write.
    let cancelled: PaymentRequestStatus;
    try {
      const provider = this.providers.requireEnabled('payos');
      const before = await provider.retrievePaymentRequest(topup.paymentLinkId);
      this.requireUnpaid(before, topup, ['PENDING', 'CANCELLED']);
      // Recover a prior successful remote cancellation after a lost local write.
      cancelled = before.status === 'CANCELLED' ? before
        : await provider.cancelPaymentRequest(topup.paymentLinkId, 'Cancelled by learner');
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException('GDS_TOPUP_CANCELLATION_UNAVAILABLE');
    }
    this.requireUnpaid(cancelled, topup, ['CANCELLED']);
    const updated = await this.prisma.$transaction((tx) => tx.gdsInternalTopup.updateMany({
      where: {
        id: topupId, buyerId, status: 'PENDING_PAYOS', paymentLinkId: topup.paymentLinkId,
        payosOrderCode: topup.payosOrderCode, amountMinor: topup.amountMinor, currency: 'VND',
        collectionReference: null, signatureVerifiedAt: null, providerReconciledAt: null,
        creditedAt: null, settlementReceivingAccountHash: null,
        journal: { is: null }, reconciliation: { is: null }, payosInbox: { none: {} },
      },
      data: { status: 'CANCELLED' },
    }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (updated.count !== 1) throw new ConflictException('GDS_TOPUP_CANCELLATION_CONFLICT');
    return result;
  }

  private requireUnpaid(
    fact: PaymentRequestStatus,
    topup: { paymentLinkId: string | null; payosOrderCode: bigint; amountMinor: bigint },
    statuses: string[],
  ): void {
    if (!fact || !statuses.includes(fact.status) || fact.providerPaymentIdentity !== topup.paymentLinkId ||
        fact.localOrderReference !== Number(topup.payosOrderCode) || fact.amountMinor !== topup.amountMinor ||
        fact.amountPaidMinor !== 0n || fact.amountRemainingMinor !== topup.amountMinor ||
        !Array.isArray(fact.transactions) || fact.transactions.length !== 0) {
      throw new ConflictException('GDS_TOPUP_CANCELLATION_CONFLICT');
    }
  }
}
