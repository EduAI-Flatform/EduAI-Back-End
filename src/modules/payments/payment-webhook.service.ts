import { createHmac, randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AuditActorKind,
  CommerceActorKind,
  CommerceLifecycleEntityType,
  CommerceOrderStatus,
  CommercePaymentStatus,
  CommerceReconciliationKind,
  CommerceReservationStatus,
  CommerceSettlementDisposition,
  CommerceSettlementKind,
  Prisma,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfigService } from '../../config/app-config.service';
import { PaymentWebhookResponseDto } from './dto/payment-webhook-response.dto';
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
  PaymentProviderError,
  VerifiedPaymentWebhook,
} from './payment-provider';

const PROVIDER = 'payos';

const attemptInclude = {
  order: {
    include: {
      reservations: {
        where: { status: CommerceReservationStatus.reserved },
        include: {
          benefitSnapshot: { select: { allocatedDiscountAmountMinor: true } },
          orderLine: {
            select: {
              productReferenceId: true,
              unitListPriceAmountMinor: true,
              finalAmountMinor: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.CommercePaymentAttemptInclude;

type AttemptRecord = Prisma.CommercePaymentAttemptGetPayload<{ include: typeof attemptInclude }>;

@Injectable()
export class PaymentWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async ingest(body: unknown): Promise<PaymentWebhookResponseDto> {
    let verified: VerifiedPaymentWebhook;
    try {
      verified = await this.provider.verifyWebhook({ body, headers: {} });
    } catch (error) {
      throw this.toHttpError(error);
    }
    if (verified.providerCode !== '00') {
      throw new BadRequestException({
        error: 'WEBHOOK_NOT_SETTLED',
        message: 'Webhook does not describe an eligible settlement.',
      });
    }
    return this.runSerializable((tx) => this.applyVerified(tx, verified));
  }

  private async applyVerified(
    tx: Prisma.TransactionClient,
    verified: VerifiedPaymentWebhook,
  ): Promise<PaymentWebhookResponseDto> {
    const priorEvent = await tx.commercePaymentEvent.findUnique({
      where: {
        provider_providerEventIdentity: {
          provider: PROVIDER,
          providerEventIdentity: verified.providerEventIdentity,
        },
      },
      include: { settlement: true },
    });
    if (priorEvent?.settlement) return this.resultFor(priorEvent.settlement.disposition);

    const attempt = await tx.commercePaymentAttempt.findUnique({
      where: {
        provider_providerOrderCode: {
          provider: PROVIDER,
          providerOrderCode: BigInt(verified.localOrderReference),
        },
      },
      include: attemptInclude,
    });
    if (!attempt) {
      throw new NotFoundException({
        error: 'PAYMENT_ATTEMPT_NOT_FOUND',
        message: 'Payment attempt was not found.',
      });
    }
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM commerce_payment_attempts WHERE id = ${attempt.id}::uuid FOR UPDATE`,
    );
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM commerce_orders WHERE id = ${attempt.orderId}::uuid FOR UPDATE`,
    );
    const locked = await tx.commercePaymentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
      include: attemptInclude,
    });
    this.assertMatches(locked, verified);

    const existingSettlement = await tx.commerceSettlement.findUnique({
      where: {
        provider_providerSettlementReference: {
          provider: PROVIDER,
          providerSettlementReference: verified.providerSettlementReference,
        },
      },
    });
    if (existingSettlement) return this.resultFor(existingSettlement.disposition);

    if (
      locked.status === CommercePaymentStatus.pending &&
      locked.order.status === CommerceOrderStatus.pending_payment
    ) {
      return this.confirm(tx, locked, verified);
    }
    if (
      locked.status === CommercePaymentStatus.paid ||
      locked.order.status === CommerceOrderStatus.confirmed
    ) {
      return this.recordDuplicate(tx, locked, verified);
    }
    if (
      (locked.status === CommercePaymentStatus.cancelled ||
        locked.status === CommercePaymentStatus.expired) &&
      (locked.order.status === CommerceOrderStatus.cancelled ||
        locked.order.status === CommerceOrderStatus.expired)
    ) {
      return this.recordLate(tx, locked, verified);
    }
    throw new ConflictException({
      error: 'PAYMENT_STATE_MISMATCH',
      message: 'Payment attempt is not eligible for this settlement transition.',
    });
  }

  private assertMatches(attempt: AttemptRecord, verified: VerifiedPaymentWebhook): void {
    if (
      !attempt.providerPaymentIdentity ||
      attempt.providerPaymentIdentity !== verified.providerPaymentIdentity ||
      attempt.amountMinor !== verified.amountMinor ||
      attempt.currency !== verified.currency
      || !attempt.providerReceivingAccountHash
      || attempt.providerReceivingAccountHash !== this.receivingAccountHash(verified.receivingAccount)
    ) {
      throw new ConflictException({
        error: 'PAYMENT_FACT_MISMATCH',
        message: 'Verified settlement does not match authoritative payment facts.',
      });
    }
  }

  private receivingAccountHash(value: string): string {
    return createHmac(
      'sha256',
      this.config.commerce.idempotencySecret as string,
    ).update(`payos-receiving-account:${value}`).digest('hex');
  }

  private async confirm(
    tx: Prisma.TransactionClient,
    attempt: AttemptRecord,
    verified: VerifiedPaymentWebhook,
  ): Promise<PaymentWebhookResponseDto> {
    const now = new Date();
    const operationId = randomUUID();
    const event = await this.createEvent(tx, attempt, verified, CommercePaymentStatus.paid);
    const settlement = await this.createSettlement(
      tx,
      attempt,
      verified,
      event.id,
      CommerceSettlementDisposition.matched,
    );
    await tx.commercePaymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: CommercePaymentStatus.paid,
        statusOperationId: operationId,
        paidAt: verified.occurredAt,
      },
    });
    await this.lifecycle(
      tx,
      CommerceLifecycleEntityType.payment,
      attempt.id,
      CommercePaymentStatus.pending,
      CommercePaymentStatus.paid,
      operationId,
      'VERIFIED_PROVIDER_SETTLEMENT',
    );
    await tx.commerceOrder.update({
      where: { id: attempt.orderId },
      data: {
        status: CommerceOrderStatus.confirmed,
        statusOperationId: operationId,
        confirmedSettlementId: settlement.id,
        confirmedAt: now,
      },
    });
    await this.lifecycle(
      tx,
      CommerceLifecycleEntityType.order,
      attempt.orderId,
      CommerceOrderStatus.pending_payment,
      CommerceOrderStatus.confirmed,
      operationId,
      'VERIFIED_PROVIDER_SETTLEMENT',
    );
    await this.consumeReservations(tx, attempt, now);
    await this.audit.record({
      actorKind: AuditActorKind.PROVIDER,
      action: AuditAction.PaymentWebhookSettled,
      target: { type: 'commerce_order', id: attempt.orderId },
      metadata: {
        operationId,
        previousStatus: 'PENDING_PAYMENT',
        nextStatus: 'CONFIRMED',
        amountMinor: verified.amountMinor.toString(),
        currency: verified.currency,
        provider: PROVIDER,
      },
    }, tx);
    return { accepted: true, result: 'CONFIRMED' };
  }

  private async recordDuplicate(
    tx: Prisma.TransactionClient,
    attempt: AttemptRecord,
    verified: VerifiedPaymentWebhook,
  ): Promise<PaymentWebhookResponseDto> {
    const event = await this.createEvent(tx, attempt, verified, CommercePaymentStatus.paid);
    const settlement = await this.createSettlement(
      tx,
      attempt,
      verified,
      event.id,
      CommerceSettlementDisposition.duplicate_collection,
    );
    await tx.commerceReconciliationCase.create({
      data: {
        orderId: attempt.orderId,
        settlementId: settlement.id,
        kind: CommerceReconciliationKind.duplicate_collection,
      },
    });
    await this.recordReconciliationAudit(tx, attempt.orderId, 'DUPLICATE_COLLECTION');
    return { accepted: true, result: 'DUPLICATE' };
  }

  private async recordLate(
    tx: Prisma.TransactionClient,
    attempt: AttemptRecord,
    verified: VerifiedPaymentWebhook,
  ): Promise<PaymentWebhookResponseDto> {
    const operationId = randomUUID();
    const event = await this.createEvent(tx, attempt, verified, CommercePaymentStatus.late_paid);
    const settlement = await this.createSettlement(
      tx,
      attempt,
      verified,
      event.id,
      CommerceSettlementDisposition.late_collection,
    );
    await tx.commercePaymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: CommercePaymentStatus.late_paid,
        statusOperationId: operationId,
        paidAt: verified.occurredAt,
      },
    });
    await this.lifecycle(
      tx,
      CommerceLifecycleEntityType.payment,
      attempt.id,
      attempt.status,
      CommercePaymentStatus.late_paid,
      operationId,
      'LATE_PROVIDER_SETTLEMENT',
    );
    await tx.commerceOrder.update({
      where: { id: attempt.orderId },
      data: {
        status: CommerceOrderStatus.late_payment_review,
        statusOperationId: operationId,
      },
    });
    await this.lifecycle(
      tx,
      CommerceLifecycleEntityType.order,
      attempt.orderId,
      attempt.order.status,
      CommerceOrderStatus.late_payment_review,
      operationId,
      'LATE_PROVIDER_SETTLEMENT',
    );
    await tx.commerceReconciliationCase.create({
      data: {
        orderId: attempt.orderId,
        settlementId: settlement.id,
        kind: CommerceReconciliationKind.late_payment,
      },
    });
    await this.recordReconciliationAudit(tx, attempt.orderId, 'LATE_PAYMENT');
    return { accepted: true, result: 'LATE_PAYMENT_REVIEW' };
  }

  private createEvent(
    tx: Prisma.TransactionClient,
    attempt: AttemptRecord,
    verified: VerifiedPaymentWebhook,
    nextStatus: CommercePaymentStatus,
  ) {
    return tx.commercePaymentEvent.create({
      data: {
        paymentAttemptId: attempt.id,
        provider: PROVIDER,
        providerEventIdentity: verified.providerEventIdentity,
        providerPaymentIdentity: verified.providerPaymentIdentity,
        providerSettlementReference: verified.providerSettlementReference,
        amountMinor: verified.amountMinor,
        currency: verified.currency,
        nextStatus,
        providerOccurredAt: verified.occurredAt,
      },
    });
  }

  private createSettlement(
    tx: Prisma.TransactionClient,
    attempt: AttemptRecord,
    verified: VerifiedPaymentWebhook,
    paymentEventId: string,
    disposition: CommerceSettlementDisposition,
  ) {
    return tx.commerceSettlement.create({
      data: {
        orderId: attempt.orderId,
        paymentAttemptId: attempt.id,
        paymentEventId,
        kind: CommerceSettlementKind.provider_collection,
        disposition,
        provider: PROVIDER,
        providerSettlementReference: verified.providerSettlementReference,
        amountMinor: verified.amountMinor,
        currency: verified.currency,
        settledAt: verified.occurredAt,
      },
    });
  }

  private lifecycle(
    tx: Prisma.TransactionClient,
    entityType: CommerceLifecycleEntityType,
    entityId: string,
    previousStatus: string,
    nextStatus: string,
    operationId: string,
    reasonCode: string,
  ) {
    return tx.commerceLifecycleEvent.create({
      data: {
        entityType,
        entityId,
        previousStatus,
        nextStatus,
        actorKind: CommerceActorKind.provider,
        actorId: null,
        operationId,
        reasonCode,
      },
    });
  }

  private async consumeReservations(
    tx: Prisma.TransactionClient,
    attempt: AttemptRecord,
    now: Date,
  ): Promise<void> {
    for (const reservation of attempt.order.reservations) {
      const operationId = randomUUID();
      await tx.commercePromotionReservation.update({
        where: { id: reservation.id },
        data: {
          status: CommerceReservationStatus.consumed,
          statusOperationId: operationId,
          consumedAt: now,
        },
      });
      await this.lifecycle(
        tx,
        CommerceLifecycleEntityType.reservation,
        reservation.id,
        CommerceReservationStatus.reserved,
        CommerceReservationStatus.consumed,
        operationId,
        'ORDER_CONFIRMED',
      );
      if (reservation.voucherId) {
        await tx.voucherRedemption.create({
          data: {
            voucherId: reservation.voucherId,
            userId: reservation.buyerId,
            courseId: reservation.orderLine.productReferenceId,
            redemptionKey: operationId,
            originalAmountMinor: Number(reservation.orderLine.unitListPriceAmountMinor),
            discountAmountMinor: Number(
              reservation.benefitSnapshot?.allocatedDiscountAmountMinor ?? 0n,
            ),
            finalAmountMinor: Number(reservation.orderLine.finalAmountMinor),
            currency: attempt.currency,
          },
        });
        await tx.voucher.update({
          where: { id: reservation.voucherId },
          data: { redeemedCount: { increment: 1 } },
        });
      }
    }
  }

  private async recordReconciliationAudit(
    tx: Prisma.TransactionClient,
    orderId: string,
    reasonCode: string,
  ): Promise<void> {
    await this.audit.record({
      actorKind: AuditActorKind.PROVIDER,
      action: AuditAction.PaymentWebhookReconciliationRequired,
      target: { type: 'commerce_order', id: orderId },
      metadata: { operationId: randomUUID(), reasonCode, provider: PROVIDER },
    }, tx);
  }

  private resultFor(
    disposition: CommerceSettlementDisposition,
  ): PaymentWebhookResponseDto {
    if (disposition === CommerceSettlementDisposition.matched) {
      return { accepted: true, result: 'CONFIRMED' };
    }
    if (disposition === CommerceSettlementDisposition.late_collection) {
      return { accepted: true, result: 'LATE_PAYMENT_REVIEW' };
    }
    return { accepted: true, result: 'DUPLICATE' };
  }

  private toHttpError(error: unknown): Error {
    if (error instanceof PaymentProviderError) {
      if (error.code === 'invalid_signature') {
        return new UnauthorizedException({
          error: 'WEBHOOK_SIGNATURE_INVALID',
          message: 'Webhook signature is invalid.',
        });
      }
      if (error.code === 'malformed_response') {
        return new BadRequestException({
          error: 'WEBHOOK_MALFORMED',
          message: 'Webhook body is malformed.',
        });
      }
      if (error.code === 'disabled') {
        return new ServiceUnavailableException({
          error: 'PAYMENT_PROVIDER_DISABLED',
          message: 'Payment provider is not available.',
        });
      }
    }
    return new BadGatewayException({
      error: 'PAYMENT_PROVIDER_UNAVAILABLE',
      message: 'Payment provider verification is unavailable.',
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
