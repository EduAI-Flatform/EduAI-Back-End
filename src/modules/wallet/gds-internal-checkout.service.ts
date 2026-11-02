import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import {
  CommerceActorKind, CommerceFulfillmentStatus, CommerceLifecycleEntityType, CommerceOrderStatus,
  CommerceSettlementDisposition, CommerceSettlementKind, Prisma,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CommerceFulfillmentService } from '../payments/commerce-fulfillment.service';
import { prepareGdsCommerceCapture } from './gds-commerce-capture.domain';
import { GdsWalletInvariantError } from './gds-wallet.domain';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * PAYW-04C source-only transactional checkout. Not exposed through HTTP.
 * Never call on production: merchant/legal release, durable recovery, final
 * UAT and financial authority must be confirmed first. The transaction is
 * all-or-nothing: reserved GDS, capture, canonical Commerce settlement,
 * order confirmation and course/membership fulfillment commit together.
 */
@Injectable()
export class GdsInternalCheckoutService {
  private readonly logger = new Logger(GdsInternalCheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly fulfillment: CommerceFulfillmentService,
    private readonly audit: AuditService,
  ) {}

  async payOrder(buyerId: string, orderId: string): Promise<{
    orderId: string; status: 'CONFIRMED'; amountMinor: string; currency: 'VND';
  }> {
    if (!this.config.gdsWallet.sandboxEnabled || !this.config.gdsWallet.checkoutEnabled ||
        this.config.app.nodeEnv === 'production' ||
        this.config.app.deploymentClass === 'production') {
      throw new ForbiddenException('GDS checkout is unavailable');
    }
    if (!UUID.test(buyerId) || !UUID.test(orderId)) {
      throw new GdsWalletInvariantError('GDS_CAPTURE_OWNER_MISMATCH');
    }

    const action = () => this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM commerce_orders WHERE id = ${orderId}::uuid FOR UPDATE`);
      const order = await tx.commerceOrder.findUnique({ where: { id: orderId },
        select: { id: true, buyerId: true, status: true, fulfillmentStatus: true,
          currency: true, payableAmountMinor: true, confirmedSettlementId: true },
      });
      if (!order || order.buyerId !== buyerId) throw new GdsWalletInvariantError('GDS_CAPTURE_OWNER_MISMATCH');

      // An ambiguous existing or already-confirmed settlement is never
      // treated as a fresh payment. Permit only proven exact replay.
      if (order.status === CommerceOrderStatus.confirmed) {
        const settlement = order.confirmedSettlementId ? await tx.commerceSettlement.findUnique({
          where: { id: order.confirmedSettlementId },
        }) : null;
        const hold = await tx.gdsInternalHold.findUnique({ where: { orderRef: orderId } });
        const journal = await tx.gdsInternalJournal.findUnique({ where: { eventKey: `gds:capture:${orderId}` } });
        const owningWallet = hold ? await tx.gdsInternalWallet.findUnique({ where: { id: hold.walletId } }) : null;
        if (!settlement || settlement.kind !== CommerceSettlementKind.wallet_capture ||
            settlement.orderId !== orderId || settlement.provider !== 'gds' ||
            settlement.disposition !== CommerceSettlementDisposition.internal ||
            settlement.currency !== 'VND' || settlement.paymentAttemptId !== null ||
            settlement.paymentEventId !== null ||
            order.fulfillmentStatus !== CommerceFulfillmentStatus.fulfilled ||
            settlement.amountMinor !== order.payableAmountMinor ||
            settlement.providerSettlementReference !== `gds:order:${orderId}` ||
            !hold || hold.status !== 'CAPTURED' || hold.amountMinor !== order.payableAmountMinor ||
            !owningWallet || owningWallet.buyerId !== buyerId ||
            !journal || journal.kind !== 'CAPTURE' || journal.walletId !== hold.walletId ||
            journal.amountMinor !== order.payableAmountMinor) {
          throw new GdsWalletInvariantError('GDS_CAPTURE_REPLAY_UNVERIFIED');
        }
        return { orderId, status: 'CONFIRMED' as const, amountMinor: order.payableAmountMinor.toString(), currency: 'VND' as const };
      }
      if (order.status !== CommerceOrderStatus.pending_payment || order.confirmedSettlementId ||
          order.currency !== 'VND' || order.payableAmountMinor <= 0n) {
        throw new GdsWalletInvariantError('GDS_CAPTURE_ORDER_NOT_PAYABLE');
      }

      // Order lock serializes provider requests and all GDS captures. Do not
      // allow switching an existing external payment attempt to wallet GDS.
      const [paymentCount, settlementCount, captureCount] = await Promise.all([
        tx.commercePaymentAttempt.count({ where: { orderId } }),
        tx.commerceSettlement.count({ where: { orderId } }),
        tx.gdsInternalJournal.count({ where: { orderRef: orderId, kind: 'CAPTURE' } }),
      ]);
      const wallet = await tx.gdsInternalWallet.findUnique({ where: { buyerId } });
      if (!wallet || wallet.status !== 'ACTIVE') throw new GdsWalletInvariantError('GDS_CAPTURE_HOLD_NOT_VERIFIED');
      let hold = await tx.gdsInternalHold.findUnique({ where: { orderRef: orderId } });
      if (!hold) {
        if (wallet.availableMinor < order.payableAmountMinor) {
          throw new GdsWalletInvariantError('GDS_CAPTURE_INSUFFICIENT_FUNDS');
        }
        await tx.gdsInternalJournal.create({ data: {
          walletId: wallet.id, eventKey: `gds:reserve:${orderId}`, kind: 'RESERVE',
          amountMinor: order.payableAmountMinor, availableDeltaMinor: -order.payableAmountMinor,
          heldDeltaMinor: order.payableAmountMinor, clearingDeltaMinor: 0n, orderRef: orderId,
        } });
        hold = await tx.gdsInternalHold.findUnique({ where: { orderRef: orderId } });
      }
      const current = await tx.gdsInternalWallet.findUniqueOrThrow({ where: { id: wallet.id } });
      if (!hold) throw new GdsWalletInvariantError('GDS_CAPTURE_HOLD_NOT_VERIFIED');
      const plan = prepareGdsCommerceCapture({ buyerId,
        order: { id: order.id, buyerId: order.buyerId, status: order.status,
          confirmedSettlementId: order.confirmedSettlementId, currency: order.currency,
          payableAmountMinor: order.payableAmountMinor },
        wallet: { id: current.id, buyerId: current.buyerId, status: current.status,
          heldMinor: current.heldMinor },
        hold: { walletId: hold.walletId, orderRef: hold.orderRef,
          amountMinor: hold.amountMinor, status: hold.status },
        existingPaymentAttemptCount: paymentCount,
        existingSettlementCount: settlementCount,
        existingCaptureCount: captureCount,
      });
      await tx.gdsInternalJournal.create({ data: plan.journal });
      const now = new Date();
      const settlement = await tx.commerceSettlement.create({ data: {
        orderId, kind: CommerceSettlementKind.wallet_capture,
        disposition: CommerceSettlementDisposition.internal,
        provider: 'gds', providerSettlementReference: plan.settlement.reference,
        amountMinor: plan.settlement.amountMinor, currency: 'VND', settledAt: now,
      } });
      const operationId = randomUUID();
      await tx.commerceOrder.update({ where: { id: orderId }, data: {
        status: CommerceOrderStatus.confirmed, confirmedSettlementId: settlement.id,
        confirmedAt: now, statusOperationId: operationId,
      } });
      await tx.commerceLifecycleEvent.create({ data: {
        entityType: CommerceLifecycleEntityType.order, entityId: orderId,
        previousStatus: CommerceOrderStatus.pending_payment,
        nextStatus: CommerceOrderStatus.confirmed,
        actorKind: CommerceActorKind.user, actorId: buyerId,
        operationId, reasonCode: 'GDS_WALLET_CAPTURED',
      } });
      await this.audit.record({ actorId: buyerId, action: AuditAction.GdsWalletCaptured,
        target: { type: 'commerce_order', id: orderId },
        metadata: { settlementId: settlement.id, amountMinor: order.payableAmountMinor.toString(), currency: 'VND' },
      }, tx);
      await this.fulfillment.fulfillConfirmedOrder(tx, orderId, CommerceActorKind.user, buyerId);
      return { orderId, status: 'CONFIRMED' as const,
        amountMinor: order.payableAmountMinor.toString(), currency: 'VND' as const };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 20_000 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await action();
        // The transaction has ALREADY committed. A notification delivery
        // outage cannot turn a successful payment into a false failure.
        // The durable outbox remains queued for its worker.
        try {
          await this.fulfillment.dispatchPending();
        } catch {
          this.logger.warn(`GDS checkout confirmed; outbox dispatch deferred for order ${orderId}`);
        }
        return result;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error &&
            (error.code === 'P2034' || error.code === 'P2002') && attempt < 2) continue;
        if (error instanceof GdsWalletInvariantError) {
          throw new ConflictException({
            error: error.code,
            message: error.code,
          });
        }
        throw error;
      }
    }
    throw new GdsWalletInvariantError('GDS_CAPTURE_RETRY_EXHAUSTED');
  }
}
