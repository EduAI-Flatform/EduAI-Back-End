import { gdsWalletCapabilities } from './gds-wallet-capabilities';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { CommerceOrderStatus, Prisma } from '../../../generated/prisma/client';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GdsInternalBalance } from './gds-internal-journal.service';
import { GdsWalletInvariantError } from './gds-wallet.domain';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * PAYW-04B internal-only hold preparation. These methods do not create a
 * Commerce settlement, capture value, grant entitlements, or expose HTTP APIs.
 * CAPTURE must later be integrated atomically with Commerce's canonical
 * settlement/fulfillment outbox in 04C, never called after a browser return.
 */
@Injectable()
export class GdsInternalSpendingService {
  constructor(private readonly prisma: PrismaService, private readonly config: AppConfigService) {}

  private assertSpendingAndIdentity(buyerId: string, orderId: string, recovery = false): void {
    const capabilities = gdsWalletCapabilities(this.config);
    const allowed = capabilities.mode === 'production'
      ? recovery ? capabilities.processingEnabled : capabilities.checkoutEnabled
      : capabilities.readEnabled;
    if (!allowed) {
      throw new ForbiddenException('GDS internal spending is unavailable');
    }
    if (!UUID.test(buyerId) || !UUID.test(orderId)) {
      throw new GdsWalletInvariantError('GDS_HOLD_INVALID_IDENTITY');
    }
  }

  async reserveForUnpaidCommerceOrder(buyerId: string, orderId: string): Promise<GdsInternalBalance> {
    this.assertSpendingAndIdentity(buyerId, orderId);
    return this.retrySerializable(async (tx) => {
      // Serialize all decisions on this order with other Commerce transitions.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM commerce_orders WHERE id = ${orderId}::uuid FOR UPDATE`);
      const order = await tx.commerceOrder.findUnique({ where: { id: orderId },
        select: { buyerId: true, status: true, payableAmountMinor: true, currency: true },
      });
      if (!order || order.buyerId !== buyerId ||
          order.status !== CommerceOrderStatus.pending_payment ||
          order.currency !== 'VND' || order.payableAmountMinor <= 0n) {
        throw new GdsWalletInvariantError('GDS_HOLD_ORDER_NOT_PAYABLE');
      }
      // One instrument per order: any historical PayOS/MB/VNPay attempt or
      // settlement must be resolved by Commerce, not swept into GDS.
      const existingPayment = await tx.commercePaymentAttempt.findFirst({
        where: { orderId }, select: { id: true },
      });
      const existingSettlement = await tx.commerceSettlement.findFirst({
        where: { orderId }, select: { id: true },
      });
      if (existingPayment || existingSettlement) {
        throw new GdsWalletInvariantError('GDS_HOLD_PAYMENT_METHOD_CONFLICT');
      }

      const wallet = await tx.gdsInternalWallet.findUnique({ where: { buyerId } });
      if (!wallet || wallet.status !== 'ACTIVE') {
        throw new GdsWalletInvariantError('GDS_HOLD_WALLET_UNAVAILABLE');
      }
      const existingHold = await tx.gdsInternalHold.findUnique({ where: { orderRef: orderId } });
      if (existingHold) {
        if (existingHold.walletId !== wallet.id || existingHold.amountMinor !== order.payableAmountMinor ||
            existingHold.status !== 'RESERVED') {
          throw new GdsWalletInvariantError('GDS_HOLD_TERMINAL_OR_MISMATCH');
        }
      } else {
        if (wallet.availableMinor < order.payableAmountMinor) {
          throw new GdsWalletInvariantError('GDS_HOLD_INSUFFICIENT_FUNDS');
        }
        // The SQL journal trigger creates the hold and applies the balanced
        // (-available, +held) posting in the SAME transaction. Its CHECK
        // constraint is the final concurrent-overspend barrier.
        await tx.gdsInternalJournal.create({ data: {
          walletId: wallet.id, eventKey: `gds:reserve:${orderId}`, kind: 'RESERVE',
          amountMinor: order.payableAmountMinor,
          availableDeltaMinor: -order.payableAmountMinor,
          heldDeltaMinor: order.payableAmountMinor, clearingDeltaMinor: 0n,
          orderRef: orderId,
        } });
      }
      return this.balance(tx, wallet.id);
    });
  }

  /**
   * Release only after Commerce definitively cancels/expires an order that
   * has NEVER had an external payment attempt or settlement. A timeout,
   * unknown provider status, or buyer cancellation click is NOT proof.
   */
  async releaseForFinalUnpaidOrder(buyerId: string, orderId: string): Promise<GdsInternalBalance> {
    this.assertSpendingAndIdentity(buyerId, orderId, true);
    return this.retrySerializable(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM commerce_orders WHERE id = ${orderId}::uuid FOR UPDATE`);
      const order = await tx.commerceOrder.findUnique({ where: { id: orderId },
        select: { buyerId: true, status: true, payableAmountMinor: true, currency: true },
      });
      if (!order || order.buyerId !== buyerId || order.currency !== 'VND' ||
          (order.status !== CommerceOrderStatus.cancelled && order.status !== CommerceOrderStatus.expired)) {
        throw new GdsWalletInvariantError('GDS_HOLD_ORDER_NOT_FINAL_UNPAID');
      }
      const payment = await tx.commercePaymentAttempt.findFirst({ where: { orderId }, select: { id: true } });
      const settlement = await tx.commerceSettlement.findFirst({ where: { orderId }, select: { id: true } });
      if (payment || settlement) {
        throw new GdsWalletInvariantError('GDS_HOLD_PAYMENT_STATUS_AMBIGUOUS');
      }
      const wallet = await tx.gdsInternalWallet.findUnique({ where: { buyerId } });
      const hold = await tx.gdsInternalHold.findUnique({ where: { orderRef: orderId } });
      if (!wallet || wallet.status !== 'ACTIVE' || !hold ||
          hold.walletId !== wallet.id || hold.amountMinor !== order.payableAmountMinor) {
        throw new GdsWalletInvariantError('GDS_HOLD_MISMATCH');
      }
      if (hold.status === 'RESERVED') {
        await tx.gdsInternalJournal.create({ data: {
          walletId: wallet.id, eventKey: `gds:release:${orderId}`, kind: 'RELEASE',
          amountMinor: hold.amountMinor, availableDeltaMinor: hold.amountMinor,
          heldDeltaMinor: -hold.amountMinor, clearingDeltaMinor: 0n,
          orderRef: orderId,
        } });
      } else if (hold.status !== 'RELEASED') {
        throw new GdsWalletInvariantError('GDS_HOLD_TERMINAL_OR_MISMATCH');
      }
      return this.balance(tx, wallet.id);
    });
  }

  private async balance(tx: Prisma.TransactionClient, walletId: string): Promise<GdsInternalBalance> {
    const wallet = await tx.gdsInternalWallet.findUniqueOrThrow({ where: { id: walletId } });
    return { availableMinor: wallet.availableMinor.toString(),
      heldMinor: wallet.heldMinor.toString(), currency: 'VND' };
  }

  private async retrySerializable<T>(action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(action, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 10_000,
        });
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error &&
            (error.code === 'P2034' || error.code === 'P2002') && attempt < 2) continue;
        throw error;
      }
    }
    throw new GdsWalletInvariantError('GDS_HOLD_RETRY_EXHAUSTED');
  }
}
