import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as QRCode from 'qrcode';
import {
  CommerceActorKind,
  CommerceIdempotencyStatus,
  CommerceLifecycleEntityType,
  CommerceOrderStatus,
  CommercePaymentStatus,
  CommerceReservationStatus,
  CommerceSettlementDisposition,
  CommerceSettlementKind,
  Prisma,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentRequestResponseDto } from './dto/payment-request-response.dto';
import {
  PAYMENT_PROVIDER,
  CreatedPaymentRequest,
  PaymentProvider,
  PaymentProviderError,
} from './payment-provider';
import { CommerceFulfillmentService } from './commerce-fulfillment.service';

const CURRENCY = 'VND';
const IDEMPOTENCY_OPERATION = 'payment.create-request';
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const PROVIDER = 'payos';
const REQUEST_LIFETIME_MS = 15 * 60_000;

const orderInclude = {
  membershipCheckoutIntent: { select: { id: true } },
  reservations: {
    where: { status: CommerceReservationStatus.reserved },
    select: { expiresAt: true },
  },
  paymentAttempts: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
  },
} satisfies Prisma.CommerceOrderInclude;

type OrderRecord = Prisma.CommerceOrderGetPayload<{ include: typeof orderInclude }>;
type AttemptRecord = OrderRecord['paymentAttempts'][number];

interface PreparedRequest {
  order: OrderRecord;
  attempt: AttemptRecord | null;
  shouldCallProvider: boolean;
}

@Injectable()
export class PaymentRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly fulfillment: CommerceFulfillmentService,
  ) {}

  async create(
    learnerId: string,
    orderId: string,
    idempotencyKey: string | undefined,
  ): Promise<PaymentRequestResponseDto> {
    this.assertIdempotencyKey(idempotencyKey);
    const paymentRequirement = await this.prisma.commerceOrder.findFirst({
      where: { id: orderId, buyerId: learnerId },
      select: { payableAmountMinor: true },
    });
    if (!paymentRequirement) {
      throw new NotFoundException('Payment request was not found.');
    }
    if (paymentRequirement.payableAmountMinor > 0n) {
      this.assertProviderEnabled();
    }
    const keyHash = createHmac(
      'sha256',
      this.config.commerce.idempotencySecret as string,
    )
      .update(idempotencyKey)
      .digest('hex');
    const requestHash = createHash('sha256').update(orderId).digest('hex');
    const prepared = await this.runSerializable((tx) =>
      this.prepare(tx, learnerId, orderId, keyHash, requestHash),
    );
    await this.fulfillment.dispatchPending();

    if (!prepared.attempt || !prepared.shouldCallProvider) {
      return this.toResponse(prepared.order, prepared.attempt);
    }

    let created: CreatedPaymentRequest;
    try {
      created = await this.provider.createPaymentRequest({
        paymentAttemptIdentity: prepared.attempt.localRequestIdentity,
        localOrderReference: Number(prepared.attempt.providerOrderCode),
        amountMinor: prepared.attempt.amountMinor,
        currency: CURRENCY,
        description: this.description(prepared.order.orderNumber),
        returnUrls: {
          success: this.withOrderIdentity(this.config.payos.returnUrl as string, orderId),
          cancel: this.withOrderIdentity(this.config.payos.cancelUrl as string, orderId),
        },
        expiresAt: prepared.attempt.providerExpiresAt as Date,
      });
      if (created.status !== 'PENDING') {
        throw new PaymentProviderError('malformed_response', false);
      }
    } catch (error) {
      await this.recordProviderFailure(prepared.attempt.id, learnerId, error);
      throw this.toHttpError(error);
    }

    const qrCodeDataUrl = await QRCode.toDataURL(created.qrPayload, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
    });
    const completed = await this.runSerializable((tx) =>
      this.completeProviderRequest(
        tx,
        prepared.order.id,
        prepared.attempt as AttemptRecord,
        learnerId,
        created,
      ),
    );
    return this.toResponse(completed.order, completed.attempt, {
      checkoutUrl: created.checkoutUrl,
      qrCodeDataUrl,
    });
  }

  private withOrderIdentity(callbackUrl: string, orderId: string): string {
    const url = new URL(callbackUrl);
    url.searchParams.set('orderId', orderId);
    return url.toString();
  }

  async status(learnerId: string, orderId: string): Promise<PaymentRequestResponseDto> {
    const order = await this.prisma.commerceOrder.findFirst({
      where: { id: orderId, buyerId: learnerId },
      include: orderInclude,
    });
    if (!order) throw new NotFoundException('Payment request was not found.');
    const attempt = order.paymentAttempts[0] ?? null;
    if (!attempt && order.payableAmountMinor > 0n) {
      throw new NotFoundException({
        error: 'PAYMENT_REQUEST_NOT_CREATED',
        message: 'Payment request was not created.',
      });
    }
    return this.toResponse(order, attempt);
  }

  private async prepare(
    tx: Prisma.TransactionClient,
    learnerId: string,
    orderId: string,
    keyHash: string,
    requestHash: string,
  ): Promise<PreparedRequest> {
    const existing = await tx.commerceIdempotencyRecord.findUnique({
      where: {
        actorId_operation_keyHashVersion_keyHash: {
          actorId: learnerId,
          operation: IDEMPOTENCY_OPERATION,
          keyHashVersion: 1,
          keyHash,
        },
      },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictException({
          error: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Idempotency key was reused with another order.',
        });
      }
      if (existing.status !== CommerceIdempotencyStatus.completed) {
        throw new ConflictException({
          error: 'REQUEST_IN_PROGRESS',
          message: 'Payment request is still processing.',
        });
      }
      const order = await this.requireOwnedOrder(tx, learnerId, orderId);
      const attempt = existing.resourceType === 'payment_attempt' && existing.resourceId
        ? await tx.commercePaymentAttempt.findUnique({ where: { id: existing.resourceId } })
        : null;
      return { order, attempt, shouldCallProvider: false };
    }

    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM commerce_orders WHERE id = ${orderId}::uuid FOR UPDATE`,
    );
    const order = await this.requireOwnedOrder(tx, learnerId, orderId);
    const now = new Date();

    if (order.payableAmountMinor === 0n) {
      const confirmed = await this.confirmNoPaymentRequired(tx, order, learnerId, now);
      await this.completeIdempotency(tx, learnerId, keyHash, requestHash, 'commerce_order', order.id, now);
      return { order: confirmed, attempt: null, shouldCallProvider: false };
    }
    if (
      order.status !== CommerceOrderStatus.pending_payment ||
      order.currency !== CURRENCY ||
      order.payableAmountMinor < 0n
    ) {
      throw new ConflictException({
        error: 'ORDER_NOT_PAYABLE',
        message: 'Order is not eligible for a payment request.',
      });
    }

    const openAttempt = await tx.commercePaymentAttempt.findFirst({
      where: {
        orderId,
        status: { in: [CommercePaymentStatus.created, CommercePaymentStatus.pending] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (openAttempt) {
      await this.completeIdempotency(tx, learnerId, keyHash, requestHash, 'payment_attempt', openAttempt.id, now);
      return { order, attempt: openAttempt, shouldCallProvider: false };
    }

    const localRequestIdentity = randomUUID();
    const providerExpiresAt = this.paymentExpiry(order, now);
    const attempt = await tx.commercePaymentAttempt.create({
      data: {
        orderId,
        provider: PROVIDER,
        localRequestIdentity,
        providerOrderCode: this.orderCode(localRequestIdentity),
        providerExpiresAt,
        providerRequestStartedAt: now,
        amountMinor: order.payableAmountMinor,
        currency: CURRENCY,
      },
    });
    await this.completeIdempotency(tx, learnerId, keyHash, requestHash, 'payment_attempt', attempt.id, now);
    return { order, attempt, shouldCallProvider: true };
  }

  private async completeProviderRequest(
    tx: Prisma.TransactionClient,
    orderId: string,
    attempt: AttemptRecord,
    learnerId: string,
    created: CreatedPaymentRequest,
  ): Promise<{ order: OrderRecord; attempt: AttemptRecord }> {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM commerce_payment_attempts WHERE id = ${attempt.id}::uuid FOR UPDATE`,
    );
    const operationId = randomUUID();
    const updated = await tx.commercePaymentAttempt.update({
      where: { id: attempt.id },
      data: {
        providerPaymentIdentity: created.providerPaymentIdentity,
        providerReceivingAccountHash: this.receivingAccountHash(created.receivingAccount),
        status: CommercePaymentStatus.pending,
        statusOperationId: operationId,
      },
    });
    await tx.commerceLifecycleEvent.create({
      data: {
        entityType: CommerceLifecycleEntityType.payment,
        entityId: attempt.id,
        previousStatus: CommercePaymentStatus.created,
        nextStatus: CommercePaymentStatus.pending,
        actorKind: CommerceActorKind.user,
        actorId: learnerId,
        operationId,
        reasonCode: 'PROVIDER_REQUEST_CREATED',
      },
    });
    await this.audit.record(
      {
        actorId: learnerId,
        action: AuditAction.PaymentRequestCreated,
        target: { type: 'commerce_payment_attempt', id: attempt.id },
        metadata: {
          operationId,
          orderId,
          previousStatus: 'CREATED',
          nextStatus: 'PENDING',
          amountMinor: attempt.amountMinor.toString(),
          currency: attempt.currency,
          provider: PROVIDER,
        },
      },
      tx,
    );
    const order = await this.requireOwnedOrder(tx, learnerId, orderId);
    return { order, attempt: updated };
  }

  private async recordProviderFailure(
    attemptId: string,
    learnerId: string,
    error: unknown,
  ): Promise<void> {
    if (!(error instanceof PaymentProviderError) || error.code !== 'rejected') return;
    await this.runSerializable(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM commerce_payment_attempts WHERE id = ${attemptId}::uuid FOR UPDATE`,
      );
      const attempt = await tx.commercePaymentAttempt.findUnique({ where: { id: attemptId } });
      if (!attempt || attempt.status !== CommercePaymentStatus.created) return;
      const operationId = randomUUID();
      await tx.commercePaymentAttempt.update({
        where: { id: attemptId },
        data: {
          status: CommercePaymentStatus.failed,
          statusOperationId: operationId,
          closedAt: new Date(),
        },
      });
      await tx.commerceLifecycleEvent.create({
        data: {
          entityType: CommerceLifecycleEntityType.payment,
          entityId: attemptId,
          previousStatus: CommercePaymentStatus.created,
          nextStatus: CommercePaymentStatus.failed,
          actorKind: CommerceActorKind.user,
          actorId: learnerId,
          operationId,
          reasonCode: 'PROVIDER_REQUEST_REJECTED',
        },
      });
      await this.audit.record(
        {
          actorId: learnerId,
          action: AuditAction.PaymentRequestFailed,
          target: { type: 'commerce_payment_attempt', id: attemptId },
          metadata: {
            operationId,
            previousStatus: 'CREATED',
            nextStatus: 'FAILED',
            reasonCode: error.code,
          },
        },
        tx,
      );
    });
  }

  private async confirmNoPaymentRequired(
    tx: Prisma.TransactionClient,
    order: OrderRecord,
    learnerId: string,
    now: Date,
  ): Promise<OrderRecord> {
    if (order.status === CommerceOrderStatus.confirmed) return order;
    if (
      order.status !== CommerceOrderStatus.pending_payment ||
      !order.membershipCheckoutIntent ||
      order.reservations.length > 0
    ) {
      throw new ConflictException({
        error: 'ORDER_NOT_PAYABLE',
        message: 'Order is not eligible for the no-payment path.',
      });
    }
    const operationId = randomUUID();
    const settlement = await tx.commerceSettlement.create({
      data: {
        orderId: order.id,
        kind: CommerceSettlementKind.no_payment_required,
        disposition: CommerceSettlementDisposition.internal,
        amountMinor: 0n,
        currency: CURRENCY,
        settledAt: now,
      },
    });
    await tx.commerceOrder.update({
      where: { id: order.id },
      data: {
        status: CommerceOrderStatus.confirmed,
        statusOperationId: operationId,
        confirmedSettlementId: settlement.id,
        confirmedAt: now,
      },
    });
    await tx.commerceLifecycleEvent.create({
      data: {
        entityType: CommerceLifecycleEntityType.order,
        entityId: order.id,
        previousStatus: CommerceOrderStatus.pending_payment,
        nextStatus: CommerceOrderStatus.confirmed,
        actorKind: CommerceActorKind.user,
        actorId: learnerId,
        operationId,
        reasonCode: 'NO_PAYMENT_REQUIRED',
      },
    });
    await this.audit.record(
      {
        actorId: learnerId,
        action: AuditAction.PaymentNotRequiredConfirmed,
        target: { type: 'commerce_order', id: order.id },
        metadata: { operationId, amountMinor: '0', currency: CURRENCY },
      },
      tx,
    );
    await this.fulfillment.fulfillConfirmedOrder(
      tx,
      order.id,
      CommerceActorKind.user,
      learnerId,
    );
    return this.requireOwnedOrder(tx, learnerId, order.id);
  }

  private async completeIdempotency(
    tx: Prisma.TransactionClient,
    actorId: string,
    keyHash: string,
    requestHash: string,
    resourceType: string,
    resourceId: string,
    now: Date,
  ): Promise<void> {
    const idempotency = await tx.commerceIdempotencyRecord.create({
      data: {
        actorId,
        operation: IDEMPOTENCY_OPERATION,
        keyHash,
        keyHashVersion: 1,
        requestHash,
        requestCanonicalizationVersion: 1,
        status: CommerceIdempotencyStatus.in_progress,
        lockedUntil: now,
      },
    });
    await tx.commerceIdempotencyRecord.update({
      where: { id: idempotency.id },
      data: {
        status: CommerceIdempotencyStatus.completed,
        resourceType,
        resourceId,
        lockedUntil: now,
        completedAt: now,
      },
    });
  }

  private async requireOwnedOrder(
    tx: Prisma.TransactionClient,
    learnerId: string,
    orderId: string,
  ): Promise<OrderRecord> {
    const order = await tx.commerceOrder.findFirst({
      where: { id: orderId, buyerId: learnerId },
      include: orderInclude,
    });
    if (!order) throw new NotFoundException('Payment request was not found.');
    return order;
  }

  private paymentExpiry(order: OrderRecord, now: Date): Date {
    const localExpiry = new Date(now.getTime() + REQUEST_LIFETIME_MS);
    const expiry = order.reservations.reduce(
      (earliest, item) => item.expiresAt < earliest ? item.expiresAt : earliest,
      localExpiry,
    );
    if (expiry.getTime() <= now.getTime() + 30_000) {
      throw new ConflictException({
        error: 'ORDER_PAYMENT_WINDOW_EXPIRED',
        message: 'Order payment window has expired.',
      });
    }
    return expiry;
  }

  private toResponse(
    order: OrderRecord,
    attempt: AttemptRecord | null,
    checkout?: { checkoutUrl: string; qrCodeDataUrl: string },
  ): PaymentRequestResponseDto {
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderStatus: order.status.toUpperCase(),
      paymentRequired: order.payableAmountMinor > 0n,
      payment: attempt ? {
        id: attempt.id,
        status: attempt.status.toUpperCase(),
        amount: { amountMinor: attempt.amountMinor.toString(), currency: CURRENCY },
        expiresAt: attempt.providerExpiresAt as Date,
        ...checkout,
      } : null,
    };
  }

  private assertProviderEnabled(): void {
    if (this.config.payos.environment !== 'production') {
      throw new ServiceUnavailableException({
        error: 'PAYMENT_PROVIDER_DISABLED',
        message: 'Payment provider is not available.',
      });
    }
  }

  private assertIdempotencyKey(value: string | undefined): asserts value is string {
    if (!value || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
      throw new BadRequestException({
        error: 'INVALID_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key must be 8-128 bounded characters.',
      });
    }
    if (!this.config.commerce.idempotencySecret) {
      throw new ServiceUnavailableException({
        error: 'PAYMENT_CONFIGURATION_INVALID',
        message: 'Payment configuration is unavailable.',
      });
    }
  }

  private orderCode(localRequestIdentity: string): bigint {
    const value = BigInt(`0x${localRequestIdentity.replace(/-/g, '').slice(0, 13)}`);
    return value === 0n ? 1n : value;
  }

  private description(orderNumber: string): string {
    return `EDUAI ${orderNumber.slice(-19)}`;
  }

  private receivingAccountHash(value: string): string {
    return createHmac(
      'sha256',
      this.config.commerce.idempotencySecret as string,
    ).update(`payos-receiving-account:${value}`).digest('hex');
  }

  private toHttpError(error: unknown): Error {
    if (error instanceof PaymentProviderError) {
      if (error.code === 'disabled') {
        return new ServiceUnavailableException({
          error: 'PAYMENT_PROVIDER_DISABLED',
          message: 'Payment provider is not available.',
        });
      }
      if (error.retryable) {
        return new ServiceUnavailableException({
          error: 'PAYMENT_PROVIDER_UNAVAILABLE',
          message: 'Payment provider is temporarily unavailable. Reconciliation is required before retrying.',
        });
      }
      return new BadGatewayException({
        error: 'PAYMENT_PROVIDER_REJECTED',
        message: 'Payment provider rejected the request.',
      });
    }
    return new ServiceUnavailableException({
      error: 'PAYMENT_PROVIDER_UNAVAILABLE',
      message: 'Payment provider is temporarily unavailable.',
    });
  }

  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          (error.code !== 'P2034' && error.code !== 'P2002') ||
          attempt === 2
        ) {
          throw error;
        }
      }
    }
    throw new Error('Unreachable transaction retry state.');
  }
}
