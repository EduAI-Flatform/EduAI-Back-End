import { createHash, createHmac, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  CommerceActorKind, CommerceIdempotencyStatus, CommerceLifecycleEntityType,
  CommerceOrderStatus, CommercePaymentStatus, CommerceReconciliationKind,
  CommerceReservationStatus, Prisma,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentLifecycleResponseDto } from './dto/payment-lifecycle.dto';
import { PAYMENT_PROVIDER, PaymentProvider, PaymentProviderError, PaymentRequestStatus, VerifiedPaymentWebhook } from './payment-provider';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentWebhookService } from './payment-webhook.service';

const OPERATION = 'payment.cancel-request';
const KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const include = {
  paymentAttempts: { orderBy: { createdAt: 'desc' as const }, take: 1 },
  reservations: { where: { status: CommerceReservationStatus.reserved }, select: { id: true } },
} satisfies Prisma.CommerceOrderInclude;
type Order = Prisma.CommerceOrderGetPayload<{ include: typeof include }>;
type Attempt = Order['paymentAttempts'][number];

@Injectable()
export class PaymentLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly reconciliation: PaymentReconciliationService,
    private readonly webhook: PaymentWebhookService,
  ) {}

  async cancel(learnerId: string, orderId: string, key: string | undefined): Promise<PaymentLifecycleResponseDto> {
    this.assertKey(key);
    const keyHash = createHmac('sha256', this.config.commerce.idempotencySecret as string).update(key).digest('hex');
    const requestHash = createHash('sha256').update(orderId).digest('hex');
    const prepared = await this.serializable((tx) => this.prepare(tx, learnerId, orderId, keyHash, requestHash));
    if (!prepared.attempt) return this.project(prepared.order);
    if (!prepared.shouldCallProvider) return this.project(prepared.order);

    let status: PaymentRequestStatus;
    try {
      status = await this.provider.cancelPaymentRequest(prepared.attempt.providerPaymentIdentity as string, 'cancelled by learner');
    } catch (error) {
      const code = error instanceof PaymentProviderError && error.code === 'disabled'
        ? 'PAYMENT_PROVIDER_DISABLED' : 'PAYMENT_PROVIDER_UNAVAILABLE';
      throw new ServiceUnavailableException({ error: code, message: 'Payment cancellation could not be verified.' });
    }
    const concern = this.factConcern(prepared.attempt, status);
    if (concern) {
      await this.reconciliation.flagAttempt(
        prepared.attempt,
        CommerceReconciliationKind.provider_fact_mismatch,
        concern,
      );
      throw new ConflictException({
        error: 'PAYMENT_RECONCILIATION_REQUIRED',
        message: 'Payment cancellation requires administrator review.',
      });
    }
    if (status.status === 'PAID') {
      const verified = this.toVerified(prepared.attempt, status);
      if (!verified) {
        await this.reconciliation.flagAttempt(
          prepared.attempt,
          CommerceReconciliationKind.provider_fact_mismatch,
          'PROVIDER_PAID_FACTS_INCOMPLETE',
        );
        throw new ConflictException({
          error: 'PAYMENT_RECONCILIATION_REQUIRED',
          message: 'Payment cancellation requires administrator review.',
        });
      }
      await this.webhook.ingestVerified(verified);
      const settled = await this.prisma.commerceOrder.findFirst({
        where: { id: orderId, buyerId: learnerId },
        include,
      });
      if (!settled) throw new NotFoundException('Payment request was not found.');
      return this.project(settled);
    }
    if (!['CANCELLED', 'EXPIRED', 'FAILED'].includes(status.status)) {
      await this.reconciliation.flagAttempt(
        prepared.attempt,
        CommerceReconciliationKind.unknown_provider_status,
        'PAYMENT_NOT_CLOSED_BY_PROVIDER',
      );
      throw new ConflictException({
        error: 'PAYMENT_RECONCILIATION_REQUIRED',
        message: 'Payment cancellation requires administrator review.',
      });
    }
    return this.project(await this.serializable((tx) => this.finish(tx, learnerId, prepared.attempt.id, status)));
  }

  private async prepare(tx: Prisma.TransactionClient, learnerId: string, orderId: string, keyHash: string, requestHash: string) {
    const existing = await tx.commerceIdempotencyRecord.findUnique({
      where: { actorId_operation_keyHashVersion_keyHash: {
        actorId: learnerId, operation: OPERATION, keyHashVersion: 1, keyHash,
      } },
    });
    if (existing && existing.requestHash !== requestHash) {
      throw new ConflictException({ error: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency key was reused with another order.' });
    }
    await tx.$queryRaw(Prisma.sql`SELECT id FROM commerce_orders WHERE id = ${orderId}::uuid FOR UPDATE`);
    let order = await tx.commerceOrder.findFirst({ where: { id: orderId, buyerId: learnerId }, include });
    if (!order) throw new NotFoundException('Payment request was not found.');
    const attempt = order.paymentAttempts[0] ?? null;
    if ([CommerceOrderStatus.cancelled, CommerceOrderStatus.expired].includes(order.status as never)) {
      return { order, attempt, shouldCallProvider: false };
    }
    if (order.status !== CommerceOrderStatus.pending_payment) {
      throw new ConflictException({ error: 'ORDER_NOT_CANCELLABLE', message: 'Order cannot be cancelled.' });
    }
    if (!attempt) order = await this.closeOrder(tx, order, learnerId, CommerceOrderStatus.cancelled, null);
    else if (attempt.status !== CommercePaymentStatus.pending || !attempt.providerPaymentIdentity) {
      throw new ConflictException({ error: 'PAYMENT_RECONCILIATION_REQUIRED', message: 'Payment cancellation requires administrator review.' });
    }
    if (!existing) {
      const now = new Date();
      await tx.commerceIdempotencyRecord.create({ data: {
        actorId: learnerId, operation: OPERATION, keyHash, keyHashVersion: 1, requestHash,
        requestCanonicalizationVersion: 1, status: CommerceIdempotencyStatus.completed,
        resourceType: attempt ? 'payment_attempt' : 'commerce_order',
        resourceId: attempt?.id ?? order.id, lockedUntil: now, completedAt: now,
      } });
    }
    return { order, attempt, shouldCallProvider: Boolean(attempt) };
  }

  private async finish(tx: Prisma.TransactionClient, learnerId: string, attemptId: string, status: PaymentRequestStatus): Promise<Order> {
    await tx.$queryRaw(Prisma.sql`SELECT id FROM commerce_payment_attempts WHERE id = ${attemptId}::uuid FOR UPDATE`);
    const attempt = await tx.commercePaymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    const order = await tx.commerceOrder.findFirst({ where: { id: attempt.orderId, buyerId: learnerId }, include });
    if (!order) throw new NotFoundException('Payment request was not found.');
    if ([CommerceOrderStatus.cancelled, CommerceOrderStatus.expired].includes(order.status as never)) return order;
    if (attempt.status !== CommercePaymentStatus.pending || order.status !== CommerceOrderStatus.pending_payment) {
      throw new ConflictException({ error: 'PAYMENT_RECONCILIATION_REQUIRED', message: 'Payment state changed during cancellation.' });
    }
    const now = new Date();
    const operationId = randomUUID();
    const nextPayment = status.status === 'FAILED' ? CommercePaymentStatus.failed
      : status.status === 'EXPIRED' ? CommercePaymentStatus.expired : CommercePaymentStatus.cancelled;
    await tx.commercePaymentAttempt.update({ where: { id: attempt.id }, data: {
      status: nextPayment, statusOperationId: operationId, providerStatusCheckedAt: now,
      providerCancellationRequestedAt: now, closedAt: now,
    } });
    await tx.commerceLifecycleEvent.create({ data: {
      entityType: CommerceLifecycleEntityType.payment, entityId: attempt.id,
      previousStatus: CommercePaymentStatus.pending, nextStatus: nextPayment,
      actorKind: CommerceActorKind.user, actorId: learnerId, operationId,
      reasonCode: 'LEARNER_CANCELLATION_PROVIDER_CONFIRMED',
    } });
    return this.closeOrder(tx, order, learnerId,
      status.status === 'EXPIRED' ? CommerceOrderStatus.expired : CommerceOrderStatus.cancelled,
      attempt.id);
  }

  private async closeOrder(tx: Prisma.TransactionClient, order: Order, learnerId: string,
    nextStatus: 'cancelled' | 'expired', attemptId: string | null): Promise<Order> {
    const now = new Date();
    for (const reservation of order.reservations) {
      const operationId = randomUUID();
      const next = nextStatus === CommerceOrderStatus.expired ? CommerceReservationStatus.expired : CommerceReservationStatus.released;
      await tx.commercePromotionReservation.update({ where: { id: reservation.id }, data: {
        status: next, statusOperationId: operationId,
        ...(next === CommerceReservationStatus.expired ? { expiredAt: now } : { releasedAt: now }),
      } });
      await tx.commerceLifecycleEvent.create({ data: {
        entityType: CommerceLifecycleEntityType.reservation, entityId: reservation.id,
        previousStatus: CommerceReservationStatus.reserved, nextStatus: next,
        actorKind: CommerceActorKind.user, actorId: learnerId, operationId,
        reasonCode: nextStatus === CommerceOrderStatus.expired ? 'ORDER_EXPIRED' : 'ORDER_CANCELLED',
      } });
    }
    const operationId = randomUUID();
    await tx.commerceOrder.update({ where: { id: order.id }, data: {
      status: nextStatus, statusOperationId: operationId,
      ...(nextStatus === CommerceOrderStatus.expired ? { expiredAt: now } : { cancelledAt: now }),
    } });
    await tx.commerceLifecycleEvent.create({ data: {
      entityType: CommerceLifecycleEntityType.order, entityId: order.id,
      previousStatus: CommerceOrderStatus.pending_payment, nextStatus,
      actorKind: CommerceActorKind.user, actorId: learnerId, operationId,
      reasonCode: nextStatus === CommerceOrderStatus.expired ? 'PAYMENT_WINDOW_EXPIRED' : 'LEARNER_CANCELLED',
    } });
    await this.audit.record({
      actorId: learnerId,
      action: nextStatus === CommerceOrderStatus.expired ? AuditAction.PaymentRequestExpired : AuditAction.PaymentRequestCancelled,
      target: { type: 'commerce_order', id: order.id },
      metadata: { operationId, previousStatus: 'PENDING_PAYMENT', nextStatus: nextStatus.toUpperCase(), paymentAttemptId: attemptId },
    }, tx);
    return tx.commerceOrder.findUniqueOrThrow({ where: { id: order.id }, include });
  }

  private factConcern(attempt: Attempt, status: PaymentRequestStatus): string | null {
    if (attempt.providerPaymentIdentity !== status.providerPaymentIdentity) return 'PROVIDER_PAYMENT_IDENTITY_MISMATCH';
    if (attempt.providerOrderCode !== BigInt(status.localOrderReference)) return 'PROVIDER_ORDER_REFERENCE_MISMATCH';
    if (attempt.amountMinor !== status.amountMinor || attempt.currency !== 'VND') return 'PROVIDER_AMOUNT_MISMATCH';
    return null;
  }
  private toVerified(attempt: Attempt, status: PaymentRequestStatus): VerifiedPaymentWebhook | null {
    if (status.amountPaidMinor !== attempt.amountMinor || status.amountRemainingMinor !== 0n) return null;
    const accountHash = createHmac('sha256', this.config.commerce.idempotencySecret as string)
      .update(`payos-receiving-account:${status.receivingAccount}`).digest('hex');
    if (attempt.providerReceivingAccountHash !== accountHash) return null;
    const transaction = status.transactions.find((item) =>
      item.amountMinor === attempt.amountMinor &&
      createHmac('sha256', this.config.commerce.idempotencySecret as string)
        .update(`payos-receiving-account:${item.receivingAccount}`).digest('hex') === accountHash);
    if (!transaction || attempt.providerOrderCode === null) return null;
    return {
      providerEventIdentity: transaction.reference,
      providerPaymentIdentity: status.providerPaymentIdentity,
      providerSettlementReference: transaction.reference,
      localOrderReference: Number(attempt.providerOrderCode),
      amountMinor: transaction.amountMinor,
      currency: 'VND',
      occurredAt: transaction.occurredAt,
      providerCode: '00',
      receivingAccount: transaction.receivingAccount,
    };
  }
  private project(order: Order): PaymentLifecycleResponseDto {
    return { orderId: order.id, orderStatus: order.status.toUpperCase(), paymentStatus: order.paymentAttempts[0]?.status.toUpperCase() ?? null };
  }
  private assertKey(value: string | undefined): asserts value is string {
    if (!value || !KEY_PATTERN.test(value)) throw new BadRequestException({
      error: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency-Key must be 8-128 bounded characters.',
    });
    if (!this.config.commerce.idempotencySecret) throw new ServiceUnavailableException({
      error: 'PAYMENT_CONFIGURATION_INVALID', message: 'Payment configuration is unavailable.',
    });
  }
  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) try {
      return await this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) ||
        (error.code !== 'P2034' && error.code !== 'P2002') || attempt === 2) throw error;
    }
    throw new Error('Serializable transaction retry exhausted');
  }
}
