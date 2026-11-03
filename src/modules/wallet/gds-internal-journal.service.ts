import { gdsWalletCapabilities } from './gds-wallet-capabilities';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  GdsInternalPayosSettlement, prepareGdsInternalTopupCredit,
} from './gds-internal-topup.domain';
import { GdsPayosTopupIntent } from './gds-payos-topup.domain';
import { GdsWalletInvariantError } from './gds-wallet.domain';

export type GdsInternalBalance = {
  availableMinor: string;
  heldMinor: string;
  currency: 'VND';
};

/**
 * Internal service-prepayment ledger integration; the signed-inbox worker
 * calls it only after independently querying PayOS. No browser, screenshot
 * or QR result is an authorized caller. Admission switches do not interrupt recovery.
 */
@Injectable()
export class GdsInternalJournalService {
  constructor(private readonly prisma: PrismaService, private readonly config: AppConfigService) {}

  private requireProcessing(): void {
    if (!gdsWalletCapabilities(this.config).processingEnabled) {
      throw new ForbiddenException('GDS internal prepayment is unavailable');
    }
  }

  /**
   * Once the signed PayOS inbox reconciler reaches PAYOS_VERIFIED, insert one
   * balanced journal posting and update the wallet
   * projection atomically. No fee is subtracted from credited VND.
   */
  async creditVerifiedTopup(intent: GdsPayosTopupIntent, settlement: GdsInternalPayosSettlement): Promise<GdsInternalBalance> {
    this.requireProcessing();
    // Reject synthetic/invalid evidence before even starting a DB transaction.
    prepareGdsInternalTopupCredit(intent, settlement);
    const execute = () => this.prisma.$transaction(async (tx) =>
      this.creditVerifiedTopupInTransaction(tx, intent, settlement),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000 });

    // PostgreSQL serializable retries and the event-key uniqueness index make
    // concurrent duplicate callbacks safe. Conflicting facts fail closed.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await execute(); }
      catch (error) {
        if (isPrismaCode(error, 'P2034') && attempt < 2) continue;
        if (isPrismaCode(error, 'P2002')) {
          if (attempt < 2) continue;
          throw new GdsWalletInvariantError('GDS_INTERNAL_TOPUP_UNIQUE_COLLISION');
        }
        throw error;
      }
    }
    throw new GdsWalletInvariantError('GDS_INTERNAL_TOPUP_RETRY_EXHAUSTED');
  }

  /** Caller owns the Serializable transaction, including the inbox outcome. */
  async creditVerifiedTopupInTransaction(
    tx: Prisma.TransactionClient, intent: GdsPayosTopupIntent,
    settlement: GdsInternalPayosSettlement,
  ): Promise<GdsInternalBalance> {
      this.requireProcessing();
      const credit = prepareGdsInternalTopupCredit(intent, settlement);
      const topup = await tx.gdsInternalTopup.findUnique({ where: { id: intent.id } });
      if (!topup || topup.buyerId !== credit.buyerId || topup.walletId === '' ||
          topup.amountMinor !== credit.amountMinor || topup.currency !== credit.currency ||
          topup.payosOrderCode !== intent.payosOrderCode ||
          topup.receivingAccountHash !== intent.receivingAccountHash ||
          (intent.settlementReceivingAccountHash != null &&
            topup.settlementReceivingAccountHash !== intent.settlementReceivingAccountHash) ||
          topup.paymentLinkId !== intent.paymentLinkId ||
          topup.collectionReference !== credit.collectionReference ||
          !topup.signatureVerifiedAt || !topup.providerReconciledAt ||
          topup.signatureVerifiedAt.getTime() !== settlement.signatureVerifiedAt.getTime() ||
          topup.providerReconciledAt.getTime() !== settlement.providerReconciledAt.getTime() ||
          topup.providerReconciledAt < topup.signatureVerifiedAt ||
          (topup.status !== 'PAYOS_VERIFIED' && topup.status !== 'CREDITED')) {
        throw new GdsWalletInvariantError('GDS_INTERNAL_TOPUP_DB_MISMATCH');
      }

      // The old partner-mirror topup model and Commerce's payment ledger have
      // separate unique indexes. Check historical claims across *all* of them
      // before a GDS journal insert. These reads do NOT solve concurrent
      // allocations: a future shared namespace/lock across Commerce and GDS
      // remains mandatory before any live credit or payment-link API.
      const commerceAttempt = await tx.commercePaymentAttempt.findFirst({
        where: { provider: 'payos', OR: [
          { providerOrderCode: topup.payosOrderCode },
          { providerPaymentIdentity: topup.paymentLinkId },
        ] },
        select: { id: true },
      });
      const commerceEvent = await tx.commercePaymentEvent.findFirst({
        where: { provider: 'payos', OR: [
          { providerEventIdentity: credit.collectionReference },
          { providerSettlementReference: credit.collectionReference },
        ] },
        select: { id: true },
      });
      const commerceSettlement = await tx.commerceSettlement.findFirst({
        where: { provider: 'payos', providerSettlementReference: credit.collectionReference },
        select: { id: true },
      });
      const legacyWalletTopup = await tx.buyerWalletPayosTopup.findFirst({
        where: { OR: [
          { payosOrderCode: topup.payosOrderCode },
          { payosPaymentLinkId: topup.paymentLinkId },
          { collectionReference: credit.collectionReference },
        ] },
        select: { id: true },
      });
      if (commerceAttempt || commerceEvent || commerceSettlement || legacyWalletTopup) {
        throw new GdsWalletInvariantError('GDS_INTERNAL_TOPUP_CROSS_LEDGER_COLLISION');
      }

      const wallet = await tx.gdsInternalWallet.findUnique({ where: { id: topup.walletId } });
      if (!wallet || wallet.buyerId !== credit.buyerId || wallet.status !== 'ACTIVE') {
        throw new GdsWalletInvariantError('GDS_INTERNAL_TOPUP_DB_MISMATCH');
      }
      const existing = await tx.gdsInternalJournal.findUnique({ where: { eventKey: credit.eventId } });
      if (existing) {
        if (existing.kind !== 'TOPUP_CREDIT' || existing.walletId !== wallet.id ||
            existing.topupId !== topup.id || existing.amountMinor !== credit.amountMinor ||
            existing.collectionReference !== credit.collectionReference || topup.status !== 'CREDITED') {
          throw new GdsWalletInvariantError('GDS_INTERNAL_TOPUP_EVENT_COLLISION');
        }
      } else {
        if (topup.status !== 'PAYOS_VERIFIED') {
          throw new GdsWalletInvariantError('GDS_INTERNAL_TOPUP_DB_MISMATCH');
        }
        await tx.gdsInternalJournal.create({
          data: {
            walletId: wallet.id, eventKey: credit.eventId, kind: 'TOPUP_CREDIT',
            amountMinor: credit.amountMinor, availableDeltaMinor: credit.amountMinor,
            heldDeltaMinor: 0n, clearingDeltaMinor: -credit.amountMinor,
            topupId: topup.id, collectionReference: credit.collectionReference,
          },
        });
      }
      const current = await tx.gdsInternalWallet.findUniqueOrThrow({ where: { id: wallet.id } });
      return {
        availableMinor: current.availableMinor.toString(),
        heldMinor: current.heldMinor.toString(), currency: 'VND' as const,
      };
  }
}

function isPrismaCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}
