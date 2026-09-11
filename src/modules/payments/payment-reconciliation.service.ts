import { createHmac, randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  AuditActorKind,
  CommerceActorKind,
  CommerceFulfillmentStatus,
  CommerceOrderStatus,
  CommercePaymentStatus,
  CommerceReconciliationKind,
  CommerceReconciliationResolution,
  CommerceReconciliationStatus,
  CommerceSettlementDisposition,
  CommerceSettlementKind,
  Prisma,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { MonitoringService } from '../../common/monitoring/monitoring.service';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CommerceFulfillmentService } from './commerce-fulfillment.service';
import { ListPaymentReviewsDto, ResolvePaymentReviewDto, RunPaymentReconciliationDto } from './dto/payment-reconciliation.dto';
import { PAYMENT_PROVIDER, PaymentProvider, PaymentProviderError, PaymentRequestStatus } from './payment-provider';
import { PaymentWebhookService } from './payment-webhook.service';
import { toVerifiedPaymentWebhook } from './payment-verified-webhook';
import { PaymentRecoveryError } from './payment-recovery-error';

const PROVIDER = 'payos';
const PAID_ORDER_FULFILLMENT_RETRY_REQUIRED = 'PAID_ORDER_FULFILLMENT_RETRY_REQUIRED';
const ELIGIBLE_STATUSES = [
  CommercePaymentStatus.created,
  CommercePaymentStatus.pending,
  CommercePaymentStatus.paid,
] as const;

const retryCaseInclude = {
  order: {
    select: {
      status: true,
      fulfillmentStatus: true,
      confirmedSettlementId: true,
      payableAmountMinor: true,
      currency: true,
    },
  },
  settlement: {
    include: {
      paymentAttempt: {
        select: {
          id: true,
          orderId: true,
          provider: true,
          providerPaymentIdentity: true,
          providerOrderCode: true,
          status: true,
          amountMinor: true,
          currency: true,
        },
      },
      paymentEvent: {
        select: {
          id: true,
          paymentAttemptId: true,
          provider: true,
          providerPaymentIdentity: true,
          providerSettlementReference: true,
          amountMinor: true,
          currency: true,
          nextStatus: true,
          providerOccurredAt: true,
        },
      },
    },
  },
  paymentAttempt: { select: { id: true, orderId: true, status: true } },
} satisfies Prisma.CommerceReconciliationCaseInclude;

type RetryCase = Prisma.CommerceReconciliationCaseGetPayload<{
  include: typeof retryCaseInclude;
}>;

@Injectable()
export class PaymentReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly webhook: PaymentWebhookService,
    private readonly fulfillment: CommerceFulfillmentService,
    private readonly monitoring: MonitoringService,
  ) {}

  async run(actorId: string, input: RunPaymentReconciliationDto) {
    const attempts = await this.prisma.commercePaymentAttempt.findMany({
      where: {
        id: input.cursor ? { gt: input.cursor } : undefined,
        provider: PROVIDER,
        providerOrderCode: { not: null },
        status: { in: [...ELIGIBLE_STATUSES] },
        OR: [
          { status: { in: [CommercePaymentStatus.created, CommercePaymentStatus.pending] } },
          {
            status: CommercePaymentStatus.paid,
            order: { fulfillmentStatus: { not: CommerceFulfillmentStatus.fulfilled } },
          },
        ],
      },
      select: {
        id: true,
        orderId: true,
        providerPaymentIdentity: true,
        providerReceivingAccountHash: true,
        providerOrderCode: true,
        amountMinor: true,
        currency: true,
        status: true,
        order: { select: { fulfillmentStatus: true } },
      },
      orderBy: { id: 'asc' },
      take: input.limit + 1,
    });
    const page = attempts.slice(0, input.limit);
    let recovered = 0;
    let reviewRequired = 0;
    for (const attempt of page) {
      try {
        const status = await this.provider.reconcilePaymentRequest(
          attempt.providerPaymentIdentity ?? String(attempt.providerOrderCode),
        );
        const reason = this.factMismatch(attempt, status);
        if (reason) {
          await this.flagAttempt(attempt, CommerceReconciliationKind.provider_fact_mismatch, reason);
          reviewRequired += 1;
          continue;
        }
        await this.persistCheckedFacts(attempt, status);
        if (status.status === 'PAID') {
          const verified = toVerifiedPaymentWebhook(attempt, status);
          if (!verified) {
            await this.flagAttempt(
              attempt,
              CommerceReconciliationKind.provider_fact_mismatch,
              this.verifiedFailureReason(attempt, status),
            );
            reviewRequired += 1;
            continue;
          }
          try {
            await this.webhook.ingestVerified(verified);
            recovered += 1;
          } catch (error) {
            const classification = this.classifyRecoveryError(error);
            if (classification.financiallyCommitted) recovered += 1;
            await this.flagAttempt(
              attempt,
              classification.kind,
              classification.reasonCode,
              classification.settlementId,
            );
            reviewRequired += 1;
          }
        } else if (status.status === 'UNDERPAID' || status.status === 'FAILED') {
          await this.flagAttempt(
            attempt,
            CommerceReconciliationKind.provider_fact_mismatch,
            status.status === 'UNDERPAID' ? 'PROVIDER_AMOUNT_UNDERPAID' : 'PROVIDER_PAYMENT_FAILED',
          );
          reviewRequired += 1;
        }
      } catch (error) {
        const classification = this.classifyProviderError(error);
        await this.flagAttempt(attempt, classification.kind, classification.reasonCode);
        reviewRequired += 1;
      }
    }
    const staleFulfillmentReviews = await this.prisma.commerceReconciliationCase.findMany({
      where: {
        status: CommerceReconciliationStatus.open,
        kind: CommerceReconciliationKind.paid_not_fulfilled,
        order: {
          status: CommerceOrderStatus.confirmed,
          fulfillmentStatus: CommerceFulfillmentStatus.fulfilled,
        },
      },
      select: { id: true, updatedAt: true },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: input.limit,
    });
    let staleFulfillmentReviewResolved = 0;
    for (const review of staleFulfillmentReviews) {
      try {
        await this.resolve(actorId, review.id, {
          resolution: 'retry_succeeded',
          expectedUpdatedAt: review.updatedAt.toISOString(),
        });
        staleFulfillmentReviewResolved += 1;
      } catch {
        reviewRequired += 1;
      }
    }
    await this.audit.record({
      actorId,
      action: AuditAction.PaymentReconciliationChecked,
      target: { type: 'commerce_reconciliation_run', id: randomUUID() },
      metadata: {
        operationId: randomUUID(),
        checkedCount: page.length,
        recoveredCount: recovered,
        reviewRequiredCount: reviewRequired,
        staleFulfillmentReviewResolvedCount: staleFulfillmentReviewResolved,
        hasMore: attempts.length > input.limit,
      },
    });
    if (reviewRequired > 0) {
      this.monitoring.capture({
        code: 'PAYMENT_RECONCILIATION_REQUIRED',
        path: '/admin/commerce/reconciliation/runs',
        statusCode: 409,
      });
    }
    return {
      checkedCount: page.length,
      recoveredCount: recovered,
      reviewRequiredCount: reviewRequired,
      hasMore: attempts.length > input.limit,
      nextCursor: attempts.length > input.limit ? page.at(-1)?.id ?? null : null,
    };
  }

  async list(query: ListPaymentReviewsDto) {
    const where: Prisma.CommerceReconciliationCaseWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.commerceReconciliationCase.count({ where }),
      this.prisma.commerceReconciliationCase.findMany({
        where,
        select: this.reviewSelect(),
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: items.map((item) => this.project(item)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async get(caseId: string) {
    const item = await this.prisma.commerceReconciliationCase.findUnique({
      where: { id: caseId },
      select: this.reviewSelect(),
    });
    if (!item) throw new NotFoundException('Payment review case not found.');
    return this.project(item);
  }

  async resolve(actorId: string, caseId: string, input: ResolvePaymentReviewDto) {
    if (input.resolution === 'retry_succeeded') {
      const retry = await this.prisma.$transaction(async (tx) => {
        const current = await this.loadOpenCase(tx, caseId, input.expectedUpdatedAt);
        if (current.kind !== CommerceReconciliationKind.paid_not_fulfilled) {
          throw new ConflictException('Only failed fulfillment review can be retried.');
        }
        return this.assertRetryInvariant(current);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      try {
        await this.fulfillment.fulfillConfirmedPayment(
          retry.orderId,
          retry.settlementId,
          CommerceActorKind.user,
          actorId,
        );
      } catch (error) {
        if (error instanceof PaymentRecoveryError && error.phase === 'identity') {
          throw new ConflictException({
            error: error.reasonCode,
            message: 'Verified payment references conflict with canonical local records.',
          });
        }
        throw error;
      }
      const result = await this.prisma.$transaction(async (tx) => {
        const current = await this.loadOpenCase(tx, caseId, input.expectedUpdatedAt);
        if (current.kind !== CommerceReconciliationKind.paid_not_fulfilled) {
          throw new ConflictException('Only failed fulfillment review can be retried.');
        }
        this.assertRetryInvariant(current, true);
        return this.finalizeResolution(
          tx,
          current,
          actorId,
          CommerceReconciliationResolution.retry_succeeded,
        );
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      await this.fulfillment.dispatchPending().catch(() => undefined);
      return {
        id: result.id,
        status: result.status.toUpperCase(),
        resolution: result.resolution?.toUpperCase(),
        resolvedAt: result.resolvedAt,
      };
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const current = await this.loadOpenCase(tx, caseId, input.expectedUpdatedAt);
      if (
        current.kind === CommerceReconciliationKind.duplicate_collection ||
        current.kind === CommerceReconciliationKind.late_payment ||
        current.kind === CommerceReconciliationKind.paid_not_fulfilled
      ) {
        throw new ConflictException('Financial collection review requires its dedicated resolution workflow.');
      }
      return this.finalizeResolution(
        tx,
        current,
        actorId,
        CommerceReconciliationResolution.acknowledged,
      );
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { id: result.id, status: result.status.toUpperCase(), resolution: result.resolution?.toUpperCase(), resolvedAt: result.resolvedAt };
  }

  private async loadOpenCase(
    tx: Prisma.TransactionClient,
    caseId: string,
    expectedUpdatedAt: string,
  ): Promise<RetryCase> {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM commerce_reconciliation_cases WHERE id = ${caseId}::uuid FOR UPDATE`,
    );
    const current = await tx.commerceReconciliationCase.findUnique({
      where: { id: caseId },
      include: retryCaseInclude,
    });
    if (!current) throw new NotFoundException('Payment review case not found.');
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM commerce_orders WHERE id = ${current.orderId}::uuid FOR UPDATE`,
    );
    const lockedCurrent = await tx.commerceReconciliationCase.findUnique({
      where: { id: caseId },
      include: retryCaseInclude,
    });
    if (!lockedCurrent) throw new NotFoundException('Payment review case not found.');
    if (lockedCurrent.status !== CommerceReconciliationStatus.open) {
      throw new ConflictException('Payment review case is already resolved.');
    }
    if (lockedCurrent.updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()) {
      throw new ConflictException({
        error: 'RECONCILIATION_VERSION_CONFLICT',
        message: 'Payment review case changed. Reload before resolving.',
      });
    }
    return lockedCurrent;
  }

  private assertRetryInvariant(
    current: RetryCase,
    requireFulfilled = false,
  ): { orderId: string; settlementId: string } {
    const settlement = current.settlement;
    const paymentAttempt = settlement?.paymentAttempt;
    const paymentEvent = settlement?.paymentEvent;
    if (
      current.kind !== CommerceReconciliationKind.paid_not_fulfilled ||
      !current.settlementId ||
      !settlement ||
      settlement.id !== current.settlementId ||
      settlement.orderId !== current.orderId ||
      current.paymentAttemptId !== paymentAttempt?.id ||
      settlement.paymentAttemptId !== paymentAttempt?.id ||
      settlement.kind !== CommerceSettlementKind.provider_collection ||
      settlement.disposition !== CommerceSettlementDisposition.matched ||
      settlement.provider !== PROVIDER ||
      !settlement.providerSettlementReference ||
      !settlement.paymentEventId ||
      !paymentAttempt ||
      paymentAttempt.orderId !== current.orderId ||
      paymentAttempt.provider !== PROVIDER ||
      !paymentAttempt.providerPaymentIdentity ||
      paymentAttempt.providerOrderCode === null ||
      paymentAttempt.status !== CommercePaymentStatus.paid ||
      !paymentEvent ||
      paymentEvent.id !== settlement.paymentEventId ||
      paymentEvent.paymentAttemptId !== paymentAttempt.id ||
      paymentEvent.provider !== PROVIDER ||
      paymentEvent.providerPaymentIdentity !== paymentAttempt.providerPaymentIdentity ||
      paymentEvent.providerSettlementReference !== settlement.providerSettlementReference ||
      paymentEvent.amountMinor !== settlement.amountMinor ||
      paymentEvent.currency !== settlement.currency ||
      paymentEvent.nextStatus !== CommercePaymentStatus.paid ||
      paymentEvent.providerOccurredAt?.getTime() !== settlement.settledAt.getTime() ||
      paymentAttempt.amountMinor !== settlement.amountMinor ||
      paymentAttempt.currency !== settlement.currency ||
      settlement.amountMinor !== current.order.payableAmountMinor ||
      settlement.currency !== current.order.currency ||
      current.order.status !== CommerceOrderStatus.confirmed ||
      current.order.confirmedSettlementId !== settlement.id ||
      (requireFulfilled &&
        current.order.fulfillmentStatus !== CommerceFulfillmentStatus.fulfilled)
    ) {
      throw new ConflictException({
        error: 'PAYMENT_SETTLEMENT_CONFLICT',
        message: 'Verified payment references conflict with canonical local records.',
      });
    }
    return { orderId: current.orderId, settlementId: settlement.id };
  }

  private finalizeResolution(
    tx: Prisma.TransactionClient,
    current: RetryCase,
    actorId: string,
    resolution: CommerceReconciliationResolution,
  ) {
    const operationId = randomUUID();
    return (async () => {
      const updated = await tx.commerceReconciliationCase.update({
        where: { id: current.id },
        data: {
          status: CommerceReconciliationStatus.resolved,
          statusOperationId: operationId,
          resolution,
          resolvedById: actorId,
          resolvedAt: new Date(),
        },
      });
      await tx.commerceLifecycleEvent.create({
        data: {
          entityType: 'reconciliation',
          entityId: current.id,
          previousStatus: CommerceReconciliationStatus.open,
          nextStatus: CommerceReconciliationStatus.resolved,
          actorKind: CommerceActorKind.user,
          actorId,
          operationId,
          reasonCode:
            resolution === CommerceReconciliationResolution.retry_succeeded
              ? 'FULFILLMENT_RETRY_SUCCEEDED'
              : 'OPERATOR_ACKNOWLEDGED',
        },
      });
      await this.audit.record({
        actorId,
        action: AuditAction.PaymentReconciliationResolved,
        target: { type: 'commerce_reconciliation_case', id: current.id },
        metadata: {
          operationId,
          kind: current.kind.toUpperCase(),
          reasonCode: current.reasonCode,
          resolution: resolution.toUpperCase(),
        },
      }, tx);
      return updated;
    })();
  }

  private async persistCheckedFacts(
    attempt: {
      id: string;
      status: CommercePaymentStatus;
      providerPaymentIdentity: string | null;
    },
    status: PaymentRequestStatus,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM commerce_payment_attempts WHERE id = ${attempt.id}::uuid FOR UPDATE`,
      );
      const current = await tx.commercePaymentAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
      });
      const recovered = current.status === CommercePaymentStatus.created;
      const operationId = recovered ? randomUUID() : null;
      await tx.commercePaymentAttempt.update({
        where: { id: attempt.id },
        data: {
          providerStatusCheckedAt: new Date(),
          ...(!current.providerPaymentIdentity
            ? {
                providerPaymentIdentity: status.providerPaymentIdentity,
                ...(status.receivingAccount
                  ? {
                      providerReceivingAccountHash: this.receivingAccountHash(
                        status.receivingAccount,
                      ),
                    }
                  : {}),
              }
            : {}),
          ...(recovered
            ? {
                status: CommercePaymentStatus.pending,
                statusOperationId: operationId,
              }
            : {}),
        },
      });
      if (recovered) {
        await tx.commerceLifecycleEvent.create({
          data: {
            entityType: 'payment',
            entityId: attempt.id,
            previousStatus: CommercePaymentStatus.created,
            nextStatus: CommercePaymentStatus.pending,
            actorKind: CommerceActorKind.system,
            actorId: null,
            operationId: operationId as string,
            reasonCode: 'PROVIDER_REQUEST_RECOVERED',
          },
        });
      }
    });
  }

  async flagAttempt(
    attempt: { id: string; orderId: string },
    kind: CommerceReconciliationKind,
    reasonCode: string,
    settlementId?: string,
  ) {
    const now = new Date();
    const linkedSettlementId =
      kind === CommerceReconciliationKind.paid_not_fulfilled ? settlementId : undefined;
    const safeReasonCode =
      kind === CommerceReconciliationKind.paid_not_fulfilled
        ? PAID_ORDER_FULFILLMENT_RETRY_REQUIRED
        : reasonCode;
    const sourceKey = [
      attempt.id,
      kind,
      ...(linkedSettlementId ? [linkedSettlementId] : []),
    ].join(':');
    await this.prisma.commerceReconciliationCase.upsert({
      where: { sourceKey },
      create: {
        orderId: attempt.orderId,
        ...(linkedSettlementId ? { settlementId: linkedSettlementId } : {}),
        paymentAttemptId: attempt.id,
        kind,
        reasonCode: safeReasonCode,
        sourceKey,
        lastCheckedAt: now,
      },
      update: {
        reasonCode: safeReasonCode,
        lastCheckedAt: now,
        checkCount: { increment: 1 },
      },
    });
  }

  private factMismatch(
    attempt: {
      providerPaymentIdentity: string | null;
      providerOrderCode: bigint | null;
      amountMinor: bigint;
      currency: string;
    },
    status: PaymentRequestStatus,
  ): string | null {
    if (
      attempt.providerPaymentIdentity &&
      attempt.providerPaymentIdentity !== status.providerPaymentIdentity
    ) return 'PROVIDER_PAYMENT_IDENTITY_MISMATCH';
    if (attempt.providerOrderCode !== BigInt(status.localOrderReference)) return 'PROVIDER_ORDER_REFERENCE_MISMATCH';
    if (attempt.amountMinor !== status.amountMinor || attempt.currency !== 'VND') return 'PROVIDER_AMOUNT_MISMATCH';
    return null;
  }

  verifiedFailureReason(
    attempt: {
      providerOrderCode: bigint | null;
      amountMinor: bigint;
    },
    status: PaymentRequestStatus,
  ): string {
    if (
      status.amountPaidMinor !== attempt.amountMinor ||
      status.amountRemainingMinor !== 0n
    ) return 'PROVIDER_PAID_AMOUNT_FACTS_INCOMPLETE';
    const expectedAmountTransactions = status.transactions.filter(
      (item) => item.amountMinor === attempt.amountMinor,
    );
    if (expectedAmountTransactions.length === 0) {
      return 'PROVIDER_PAID_TRANSACTION_AMOUNT_MISSING';
    }
    if (attempt.providerOrderCode === null) {
      return 'PROVIDER_PAID_ORDER_REFERENCE_MISSING';
    }
    return 'PROVIDER_PAID_FACTS_INCOMPLETE';
  }

  private classifyRecoveryError(error: unknown): {
    kind: CommerceReconciliationKind;
    reasonCode: string;
    financiallyCommitted: boolean;
    settlementId?: string;
  } {
    if (error instanceof PaymentRecoveryError) {
      if (error.phase === 'fulfillment') {
        return {
          kind: CommerceReconciliationKind.paid_not_fulfilled,
          reasonCode: PAID_ORDER_FULFILLMENT_RETRY_REQUIRED,
          financiallyCommitted: error.financiallyCommitted,
          settlementId: error.settlementId,
        };
      }
      return {
        kind: CommerceReconciliationKind.provider_fact_mismatch,
        reasonCode: error.reasonCode,
        financiallyCommitted: false,
      };
    }
    if (error instanceof ConflictException) {
      return {
        kind: CommerceReconciliationKind.provider_fact_mismatch,
        reasonCode: 'PAYMENT_SETTLEMENT_CONFLICT',
        financiallyCommitted: false,
      };
    }
    return {
      kind: CommerceReconciliationKind.provider_fact_mismatch,
      reasonCode: 'PAYMENT_RECOVERY_INTERNAL_ERROR',
      financiallyCommitted: false,
    };
  }

  private receivingAccountHash(value: string): string {
    return createHmac('sha256', this.config.commerce.idempotencySecret as string)
      .update(`payos-receiving-account:${value}`)
      .digest('hex');
  }

  private classifyProviderError(error: unknown): {
    kind: CommerceReconciliationKind;
    reasonCode: string;
  } {
    if (error instanceof PaymentProviderError) {
      switch (error.code) {
        case 'malformed_response':
          return {
            kind: CommerceReconciliationKind.unknown_provider_status,
            reasonCode: 'PROVIDER_STATUS_MALFORMED',
          };
        case 'invalid_signature':
          return {
            kind: CommerceReconciliationKind.unknown_provider_status,
            reasonCode: 'PROVIDER_STATUS_INVALID_SIGNATURE',
          };
        case 'rejected':
          return {
            kind: CommerceReconciliationKind.unknown_provider_status,
            reasonCode: 'PROVIDER_STATUS_REJECTED',
          };
        case 'timeout':
          return {
            kind: CommerceReconciliationKind.provider_outage,
            reasonCode: 'PROVIDER_STATUS_TIMEOUT',
          };
        case 'unavailable':
          return {
            kind: CommerceReconciliationKind.provider_outage,
            reasonCode: 'PROVIDER_STATUS_UNAVAILABLE',
          };
        default:
          break;
      }
    }
    return {
      kind: CommerceReconciliationKind.provider_outage,
      reasonCode: 'PROVIDER_STATUS_UNAVAILABLE',
    };
  }

  private reviewSelect() {
    return {
      id: true,
      kind: true,
      reasonCode: true,
      status: true,
      resolution: true,
      openedAt: true,
      updatedAt: true,
      lastCheckedAt: true,
      checkCount: true,
      resolvedAt: true,
      order: {
        select: {
          orderNumber: true,
          status: true,
          fulfillmentStatus: true,
          payableAmountMinor: true,
          currency: true,
        },
      },
      paymentAttempt: { select: { status: true, providerStatusCheckedAt: true } },
      settlement: { select: { disposition: true, amountMinor: true, currency: true, settledAt: true } },
      resolvedBy: { select: { id: true, email: true, fullName: true } },
    } satisfies Prisma.CommerceReconciliationCaseSelect;
  }

  private project(item: any) {
    return {
      ...item,
      kind: item.kind.toUpperCase(),
      status: item.status.toUpperCase(),
      resolution: item.resolution?.toUpperCase() ?? null,
      order: {
        ...item.order,
        status: item.order.status.toUpperCase(),
        fulfillmentStatus: item.order.fulfillmentStatus.toUpperCase(),
        payableAmountMinor: item.order.payableAmountMinor.toString(),
      },
      paymentAttempt: item.paymentAttempt
        ? { status: item.paymentAttempt.status.toUpperCase(), providerStatusCheckedAt: item.paymentAttempt.providerStatusCheckedAt }
        : null,
      settlement: item.settlement
        ? { ...item.settlement, disposition: item.settlement.disposition.toUpperCase(), amountMinor: item.settlement.amountMinor.toString() }
        : null,
    };
  }
}
