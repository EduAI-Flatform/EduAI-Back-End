import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
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
import { RedisConfigService } from '../../config/redis-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CommerceFulfillmentService } from './commerce-fulfillment.service';
import { ListPaymentReviewsDto, ResolvePaymentReviewDto, RunPaymentReconciliationDto } from './dto/payment-reconciliation.dto';
import {
  PAYMENT_PROVIDER,
  PAYMENT_PROVIDER_REGISTRY,
  PaymentProvider,
  PaymentProviderError,
  PaymentProviderName,
  PaymentRequestStatus,
  isPaymentProviderName,
} from './payment-provider';
import {
  PaymentProviderRegistry,
} from './payment-provider.registry';
import { PaymentWebhookService } from './payment-webhook.service';
import {
  toVerifiedPaymentWebhook,
  toVerifiedVnPayQueryDrWebhook,
} from './payment-verified-webhook';
import { PaymentRecoveryError } from './payment-recovery-error';
import {
  VnPayPaymentProvider,
  VnPayQueryDrAttempt,
  VnPayQueryDrError,
  VnPayQueryDrObservation,
} from './vnpay-payment.provider';

const PAID_ORDER_FULFILLMENT_RETRY_REQUIRED = 'PAID_ORDER_FULFILLMENT_RETRY_REQUIRED';
const RECONCILIATION_CURSOR_VERSION = 1;
const RECONCILIATION_CURSOR_CONTEXT = 'payment-reconciliation-cursor';
const RECONCILIATION_CURSOR_SEPARATOR = '.';
const RECONCILIATION_RUN_TIMEOUT_MS = 60_000;
const RECONCILIATION_LOCK_TTL_MS = RECONCILIATION_RUN_TIMEOUT_MS + 5_000;
const RECONCILIATION_LOCK_KEY = 'eduai:commerce:payment-reconciliation:run';
const VNPAY_QUERYDR_REQUEST_IP = '127.0.0.1';
const RELEASE_RECONCILIATION_LOCK_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
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
      confirmedSettlement: {
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
              providerEventIdentity: true,
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
          providerEventIdentity: true,
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

type ReconciliationAttempt = {
  id: string;
  orderId: string;
  provider: string;
  providerPaymentIdentity: string | null;
  providerReceivingAccountHash: string | null;
  providerOrderCode: bigint | null;
  amountMinor: bigint;
  currency: string;
  status: CommercePaymentStatus;
  createdAt: Date;
  order: {
    status: CommerceOrderStatus;
    fulfillmentStatus: CommerceFulfillmentStatus;
    confirmedSettlementId: string | null;
  };
};

export type VnPayLifecycleAttempt = Pick<
  ReconciliationAttempt,
  | 'id'
  | 'orderId'
  | 'provider'
  | 'providerPaymentIdentity'
  | 'providerOrderCode'
  | 'amountMinor'
  | 'currency'
  | 'status'
  | 'createdAt'
>;

export type VnPayLifecycleOutcome =
  | 'paid'
  | 'pending'
  | 'not_found'
  | 'failed'
  | 'expired'
  | 'special'
  | 'unknown_status'
  | 'provider_error'
  | 'invalid_provider_response';

export type VnPayLifecycleRecovery = {
  outcome: VnPayLifecycleOutcome;
  observation?: VnPayQueryDrObservation;
};

type ReconciliationCounts = {
  recovered: number;
  reviewRequired: number;
};

class ReconciliationRunTimeoutError extends Error {
  readonly name = 'ReconciliationRunTimeoutError';
}

@Injectable()
export class PaymentReconciliationService {
  private localRunLock = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly webhook: PaymentWebhookService,
    private readonly fulfillment: CommerceFulfillmentService,
    private readonly monitoring: MonitoringService,
    @Optional() private readonly redisConfig?: RedisConfigService,
    @Optional()
    @Inject(PAYMENT_PROVIDER_REGISTRY)
    private readonly providerRegistry?: PaymentProviderRegistry,
  ) {}

  async run(actorId: string, input: RunPaymentReconciliationDto) {
    const cursorId = this.decodeCursor(input.cursor);
    const releaseRunLock = await this.acquireRunLock();
    try {
      return await this.runLocked(actorId, input, cursorId);
    } finally {
      await releaseRunLock();
    }
  }

  async recoverVnPayAttemptForLifecycle(
    attempt: VnPayLifecycleAttempt,
  ): Promise<VnPayLifecycleRecovery> {
    if (attempt.provider !== 'vnpay') {
      await this.flagAttempt(
        attempt,
        CommerceReconciliationKind.unknown_provider_status,
        'PROVIDER_UNSUPPORTED',
      );
      return { outcome: 'provider_error' };
    }

    try {
      const observation = await this.queryVnPayWithDeadline(
        attempt,
        Date.now() + this.providerTimeoutMs('vnpay'),
      );
      await this.processVnPayObservation(attempt, observation);
      return {
        outcome: this.lifecycleOutcome(observation),
        observation,
      };
    } catch (error) {
      const classification = this.classifyProviderError(error);
      await this.flagAttempt(attempt, classification.kind, classification.reasonCode);
      return {
        outcome: this.lifecycleErrorOutcome(error),
      };
    }
  }

  async probeRunLock() {
    let redis;
    try {
      redis = this.redisConfig?.getClient();
    } catch {
      throw new ServiceUnavailableException('Payment reconciliation lock is unavailable.');
    }
    if (!redis) {
      throw new ServiceUnavailableException('Payment reconciliation lock is unavailable.');
    }

    const releaseRunLock = await this.acquireRunLock();
    let observedTtlMs: number;
    try {
      try {
        observedTtlMs = await redis.pttl(RECONCILIATION_LOCK_KEY);
      } catch {
        throw new ServiceUnavailableException('Payment reconciliation lock is unavailable.');
      }
      if (
        !Number.isInteger(observedTtlMs) ||
        observedTtlMs <= 0 ||
        observedTtlMs > RECONCILIATION_LOCK_TTL_MS
      ) {
        throw new ServiceUnavailableException('Payment reconciliation lock TTL is invalid.');
      }

      let competingRelease: (() => Promise<void>) | undefined;
      try {
        competingRelease = await this.acquireRunLock();
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
      }
      if (competingRelease) {
        await competingRelease();
        throw new ServiceUnavailableException('Payment reconciliation lease competition was not rejected.');
      }
    } finally {
      await releaseRunLock();
    }

    let remainingTtlMs: number;
    try {
      remainingTtlMs = await redis.pttl(RECONCILIATION_LOCK_KEY);
    } catch {
      throw new ServiceUnavailableException('Payment reconciliation lock cleanup could not be verified.');
    }
    if (remainingTtlMs !== -2) {
      throw new ServiceUnavailableException('Payment reconciliation lock cleanup could not be verified.');
    }

    return {
      mechanism: 'redis' as const,
      acquisition: 'passed' as const,
      competingAcquisition: 'rejected' as const,
      observedTtlMs,
      release: 'verified' as const,
      remainingTtlMs,
      persistentTestLock: false as const,
    };
  }

  private async runLocked(
    actorId: string,
    input: RunPaymentReconciliationDto,
    cursorId?: string,
  ) {
    const deadline = Date.now() + RECONCILIATION_RUN_TIMEOUT_MS;
    const attempts = await this.prisma.commercePaymentAttempt.findMany({
      where: {
        id: cursorId ? { gt: cursorId } : undefined,
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
        provider: true,
        providerPaymentIdentity: true,
        providerReceivingAccountHash: true,
        providerOrderCode: true,
        amountMinor: true,
        currency: true,
        status: true,
        createdAt: true,
        order: {
          select: {
            status: true,
            fulfillmentStatus: true,
            confirmedSettlementId: true,
          },
        },
      },
      orderBy: { id: 'asc' },
      take: input.limit + 1,
    });
    const page = attempts.slice(0, input.limit);
    let recovered = 0;
    let reviewRequired = 0;
    let checkedCount = 0;
    let lastCheckedAttemptId: string | undefined;
    let timedOut = false;
    for (const attempt of page) {
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      checkedCount += 1;
      lastCheckedAttemptId = attempt.id;
      try {
        if (!isPaymentProviderName(attempt.provider)) {
          throw new PaymentProviderError('unsupported', false);
        }

        if (this.hasCanonicalPaidSettlement(attempt)) {
          const fulfillmentResult = await this.retryCanonicalFulfillment(attempt);
          recovered += fulfillmentResult.recovered;
          reviewRequired += fulfillmentResult.reviewRequired;
          continue;
        }

        if (attempt.provider === 'vnpay') {
          const observation = await this.queryVnPayWithDeadline(attempt, deadline);
          const result = await this.processVnPayObservation(attempt, observation);
          recovered += result.recovered;
          reviewRequired += result.reviewRequired;
          continue;
        }

        const provider = this.resolveProvider('payos');
        const status = await this.reconcileWithDeadline(
          provider,
          attempt.providerPaymentIdentity ?? String(attempt.providerOrderCode),
          deadline,
          this.providerTimeoutMs('payos'),
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
            const result = await this.webhook.ingestVerified(verified);
            if (result.result === 'CONFIRMED') {
              recovered += 1;
            } else {
              if (
                result.result !== 'DUPLICATE' &&
                result.result !== 'LATE_PAYMENT_REVIEW'
              ) {
                await this.flagAttempt(
                  attempt,
                  CommerceReconciliationKind.provider_fact_mismatch,
                  'PAYMENT_RECOVERY_NOT_CONFIRMED',
                );
              }
              reviewRequired += 1;
            }
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
        } else if (
          status.status === 'UNDERPAID' ||
          status.status === 'FAILED' ||
          status.status === 'CANCELLED' ||
          status.status === 'EXPIRED'
        ) {
          await this.flagAttempt(
            attempt,
            CommerceReconciliationKind.provider_fact_mismatch,
            status.status === 'UNDERPAID'
              ? 'PROVIDER_AMOUNT_UNDERPAID'
              : status.status === 'FAILED'
                ? 'PROVIDER_PAYMENT_FAILED'
                : status.status === 'CANCELLED'
                  ? 'PROVIDER_PAYMENT_CANCELLED'
                  : 'PROVIDER_PAYMENT_EXPIRED',
          );
          reviewRequired += 1;
        }
      } catch (error) {
        if (error instanceof ReconciliationRunTimeoutError) {
          await this.flagAttempt(
            attempt,
            CommerceReconciliationKind.provider_outage,
            'PROVIDER_STATUS_TIMEOUT',
          );
          reviewRequired += 1;
          timedOut = true;
          break;
        }
        const classification = this.classifyProviderError(error);
        await this.flagAttempt(attempt, classification.kind, classification.reasonCode);
        reviewRequired += 1;
      }
    }
    const hasMore = attempts.length > input.limit || page.length > checkedCount;
    await this.audit.record({
      actorId,
      action: AuditAction.PaymentReconciliationChecked,
      target: { type: 'commerce_reconciliation_run', id: randomUUID() },
      metadata: {
        operationId: randomUUID(),
        checkedCount,
        recoveredCount: recovered,
        reviewRequiredCount: reviewRequired,
        hasMore,
        timedOut,
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
      checkedCount,
      recoveredCount: recovered,
      reviewRequiredCount: reviewRequired,
      hasMore,
      nextCursor: hasMore
        ? this.encodeCursor(lastCheckedAttemptId) ?? input.cursor ?? null
        : null,
    };
  }

  private resolveProvider(providerName: PaymentProviderName): PaymentProvider {
    if (this.providerRegistry) {
      return this.providerRegistry.requireEnabled(providerName);
    }
    if (providerName === 'payos') return this.provider;
    throw new PaymentProviderError('disabled', false);
  }

  private hasCanonicalPaidSettlement(attempt: ReconciliationAttempt): boolean {
    return (
      attempt.status === CommercePaymentStatus.paid &&
      attempt.order.status === CommerceOrderStatus.confirmed &&
      !!attempt.order.confirmedSettlementId &&
      attempt.order.fulfillmentStatus !== CommerceFulfillmentStatus.fulfilled
    );
  }

  private async retryCanonicalFulfillment(
    attempt: ReconciliationAttempt,
  ): Promise<ReconciliationCounts> {
    const settlementId = attempt.order.confirmedSettlementId as string;
    try {
      await this.fulfillment.fulfillConfirmedPayment(
        attempt.orderId,
        settlementId,
        CommerceActorKind.system,
        null,
      );
      return { recovered: 1, reviewRequired: 0 };
    } catch (error) {
      const classification =
        error instanceof PaymentRecoveryError && error.phase !== 'fulfillment'
          ? this.classifyRecoveryError(error)
          : {
              kind: CommerceReconciliationKind.paid_not_fulfilled,
              reasonCode: PAID_ORDER_FULFILLMENT_RETRY_REQUIRED,
              financiallyCommitted: true,
              settlementId,
            };
      await this.flagAttempt(
        attempt,
        classification.kind,
        classification.reasonCode,
        classification.settlementId ?? settlementId,
      );
      return {
        recovered: classification.financiallyCommitted ? 1 : 0,
        reviewRequired: 1,
      };
    }
  }

  private async queryVnPayWithDeadline(
    attempt: VnPayLifecycleAttempt,
    deadline: number,
  ): Promise<VnPayQueryDrObservation> {
    const provider = this.resolveProvider('vnpay') as PaymentProvider &
      Pick<VnPayPaymentProvider, 'queryTransaction'>;
    if (typeof provider.queryTransaction !== 'function') {
      throw new PaymentProviderError('unsupported', false);
    }
    if (
      attempt.providerOrderCode === null ||
      !(attempt.createdAt instanceof Date) ||
      !Number.isFinite(attempt.createdAt.getTime())
    ) {
      throw new PaymentProviderError('invalid_request', false);
    }

    const queryAttempt: VnPayQueryDrAttempt = {
      provider: 'vnpay',
      providerOrderCode: attempt.providerOrderCode,
      amountMinor: attempt.amountMinor,
      currency: 'VND',
      transactionCreatedAt: attempt.createdAt,
      requestIpAddress: VNPAY_QUERYDR_REQUEST_IP,
    };
    return this.withReconciliationDeadline(
      (signal, timeoutMs) =>
        provider.queryTransaction(queryAttempt, { signal, timeoutMs }),
      deadline,
      this.providerTimeoutMs('vnpay'),
    );
  }

  private async processVnPayObservation(
    attempt: VnPayLifecycleAttempt,
    observation: VnPayQueryDrObservation,
  ): Promise<ReconciliationCounts> {
    if (observation.trusted !== true) {
      await this.flagAttempt(
        attempt,
        CommerceReconciliationKind.unknown_provider_status,
        'PROVIDER_STATUS_UNTRUSTED',
      );
      return { recovered: 0, reviewRequired: 1 };
    }

    const mismatch = this.vnpayFactMismatch(attempt, observation);
    if (mismatch) {
      await this.flagAttempt(
        attempt,
        CommerceReconciliationKind.provider_fact_mismatch,
        mismatch,
      );
      return { recovered: 0, reviewRequired: 1 };
    }

    const checkedAttempt = await this.persistVnPayCheckedFacts(attempt, observation);
    if (observation.queryRequestStatus !== 'success') {
      const classification = this.classifyVnPayQueryStatus(observation);
      await this.flagAttempt(
        attempt,
        classification.kind,
        classification.reasonCode,
      );
      return { recovered: 0, reviewRequired: 1 };
    }

    if (observation.transactionStatus === 'pending') {
      return { recovered: 0, reviewRequired: 0 };
    }

    if (observation.transactionStatus !== 'paid') {
      const classification = this.classifyVnPayTransactionStatus(observation);
      await this.flagAttempt(
        attempt,
        classification.kind,
        classification.reasonCode,
      );
      return { recovered: 0, reviewRequired: 1 };
    }

    const verified = toVerifiedVnPayQueryDrWebhook(checkedAttempt, observation);
    if (!verified) {
      await this.flagAttempt(
        attempt,
        CommerceReconciliationKind.provider_fact_mismatch,
        'PROVIDER_PAID_FACTS_INCOMPLETE',
      );
      return { recovered: 0, reviewRequired: 1 };
    }

    try {
      const result = await this.webhook.ingestVerified(verified);
      if (result.result === 'CONFIRMED') {
        return { recovered: 1, reviewRequired: 0 };
      }
      if (
        result.result !== 'DUPLICATE' &&
        result.result !== 'LATE_PAYMENT_REVIEW'
      ) {
        await this.flagAttempt(
          attempt,
          CommerceReconciliationKind.provider_fact_mismatch,
          'PAYMENT_RECOVERY_NOT_CONFIRMED',
        );
      }
      return { recovered: 0, reviewRequired: 1 };
    } catch (error) {
      const classification = this.classifyRecoveryError(error);
      if (classification.financiallyCommitted) {
        await this.flagAttempt(
          attempt,
          classification.kind,
          classification.reasonCode,
          classification.settlementId,
        );
        return { recovered: 1, reviewRequired: 1 };
      }
      await this.flagAttempt(
        attempt,
        classification.kind,
        classification.reasonCode,
        classification.settlementId,
      );
      return { recovered: 0, reviewRequired: 1 };
    }
  }

  private vnpayFactMismatch(
    attempt: VnPayLifecycleAttempt,
    observation: VnPayQueryDrObservation,
  ): string | null {
    if (
      observation.provider !== 'vnpay' ||
      !/^[1-9]\d{0,15}$/.test(observation.providerOrderReference) ||
      attempt.providerOrderCode === null ||
      attempt.providerOrderCode !== BigInt(observation.providerOrderReference)
    ) {
      return 'PROVIDER_ORDER_REFERENCE_MISMATCH';
    }
    if (
      attempt.providerPaymentIdentity &&
      attempt.providerPaymentIdentity !== observation.providerOrderReference
    ) {
      return 'PROVIDER_PAYMENT_IDENTITY_MISMATCH';
    }
    if (observation.queryRequestStatus === 'success') {
      if (
        observation.currency !== 'VND' ||
        attempt.currency !== 'VND' ||
        observation.amountMinor === undefined ||
        observation.amountMinor !== attempt.amountMinor
      ) {
        return 'PROVIDER_AMOUNT_MISMATCH';
      }
    }
    return null;
  }

  private async persistVnPayCheckedFacts(
    attempt: VnPayLifecycleAttempt,
    observation: VnPayQueryDrObservation,
  ): Promise<VnPayLifecycleAttempt & { providerPaymentIdentity: string }> {
    const providerPaymentIdentity = observation.providerOrderReference;
    let effectiveStatus = attempt.status;
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM commerce_payment_attempts WHERE id = ${attempt.id}::uuid FOR UPDATE`,
      );
      const current = await tx.commercePaymentAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
      });
      if (
        current.provider !== 'vnpay' ||
        (current.providerPaymentIdentity !== null &&
          current.providerPaymentIdentity !== providerPaymentIdentity)
      ) {
        throw new PaymentProviderError('invalid_request', false);
      }
      const recoverableCreate =
        current.status === CommercePaymentStatus.created &&
        observation.queryRequestStatus === 'success' &&
        (observation.transactionStatus === 'pending' ||
          observation.transactionStatus === 'paid');
      effectiveStatus = recoverableCreate
        ? CommercePaymentStatus.pending
        : current.status;
      const operationId = recoverableCreate ? randomUUID() : null;
      await tx.commercePaymentAttempt.update({
        where: { id: attempt.id },
        data: {
          providerStatusCheckedAt: new Date(),
          ...(!current.providerPaymentIdentity
            ? { providerPaymentIdentity }
            : {}),
          ...(recoverableCreate
            ? {
                status: CommercePaymentStatus.pending,
                statusOperationId: operationId,
              }
            : {}),
        },
      });
      if (recoverableCreate) {
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
    return {
      ...attempt,
      providerPaymentIdentity,
      status: effectiveStatus,
    };
  }

  private classifyVnPayQueryStatus(observation: VnPayQueryDrObservation): {
    kind: CommerceReconciliationKind;
    reasonCode: string;
  } {
    switch (observation.queryRequestStatus) {
      case 'not_found':
        return {
          kind: CommerceReconciliationKind.unknown_provider_status,
          reasonCode: 'PROVIDER_TRANSACTION_NOT_FOUND',
        };
      case 'duplicate_request':
        return {
          kind: CommerceReconciliationKind.provider_outage,
          reasonCode: 'PROVIDER_STATUS_DUPLICATE_REQUEST',
        };
      default:
        return {
          kind: CommerceReconciliationKind.provider_outage,
          reasonCode: 'PROVIDER_STATUS_PROVIDER_ERROR',
        };
    }
  }

  private classifyVnPayTransactionStatus(observation: VnPayQueryDrObservation): {
    kind: CommerceReconciliationKind;
    reasonCode: string;
  } {
    switch (observation.transactionStatus) {
      case 'failed':
        return {
          kind: CommerceReconciliationKind.provider_fact_mismatch,
          reasonCode: 'PROVIDER_PAYMENT_FAILED',
        };
      case 'expired':
        return {
          kind: CommerceReconciliationKind.provider_fact_mismatch,
          reasonCode: 'PROVIDER_PAYMENT_EXPIRED',
        };
      case 'reversed':
        return {
          kind: CommerceReconciliationKind.unknown_provider_status,
          reasonCode: 'PROVIDER_PAYMENT_REVERSED',
        };
      case 'fraud_suspected':
        return {
          kind: CommerceReconciliationKind.unknown_provider_status,
          reasonCode: 'PROVIDER_FRAUD_SUSPECTED',
        };
      case 'refund_processing':
        return {
          kind: CommerceReconciliationKind.unknown_provider_status,
          reasonCode: 'PROVIDER_REFUND_PROCESSING',
        };
      case 'refund_sent':
        return {
          kind: CommerceReconciliationKind.unknown_provider_status,
          reasonCode: 'PROVIDER_REFUND_SENT',
        };
      case 'refund_rejected':
        return {
          kind: CommerceReconciliationKind.unknown_provider_status,
          reasonCode: 'PROVIDER_REFUND_REJECTED',
        };
      default:
        return {
          kind: CommerceReconciliationKind.unknown_provider_status,
          reasonCode: 'UNKNOWN_PROVIDER_STATUS',
        };
    }
  }

  private lifecycleOutcome(
    observation: VnPayQueryDrObservation,
  ): VnPayLifecycleOutcome {
    if (observation.queryRequestStatus === 'not_found') return 'not_found';
    if (observation.queryRequestStatus !== 'success') return 'provider_error';

    switch (observation.transactionStatus) {
      case 'paid':
        return 'paid';
      case 'pending':
        return 'pending';
      case 'failed':
        return 'failed';
      case 'expired':
        return 'expired';
      case 'unknown':
        return 'unknown_status';
      default:
        return 'special';
    }
  }

  private lifecycleErrorOutcome(error: unknown): VnPayLifecycleOutcome {
    if (error instanceof VnPayQueryDrError) {
      return [
        'invalid_response_signature',
        'malformed_response',
        'provider_fact_mismatch',
      ].includes(error.code)
        ? 'invalid_provider_response'
        : 'provider_error';
    }
    if (error instanceof PaymentProviderError) {
      return [
        'invalid_signature',
        'malformed_response',
        'rejected',
        'invalid_request',
      ].includes(error.code)
        ? 'invalid_provider_response'
        : 'provider_error';
    }
    return 'provider_error';
  }

  private async withReconciliationDeadline<T>(
    operation: (signal: AbortSignal, timeoutMs: number) => Promise<T>,
    deadline: number,
    providerTimeoutMs: number,
  ): Promise<T> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new ReconciliationRunTimeoutError();

    const controller = new AbortController();
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new ReconciliationRunTimeoutError());
      }, remainingMs);
    });

    try {
      return await Promise.race([
        operation(
          controller.signal,
          Math.min(Math.max(1, providerTimeoutMs), remainingMs),
        ),
        timeoutPromise,
      ]);
    } catch (error) {
      if (timedOut || error instanceof ReconciliationRunTimeoutError) {
        throw new ReconciliationRunTimeoutError();
      }
      throw error;
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }

  private async reconcileWithDeadline(
    provider: PaymentProvider,
    providerPaymentIdentity: string,
    deadline: number,
    timeoutMs: number,
  ): Promise<PaymentRequestStatus> {
    return this.withReconciliationDeadline(
      (signal, boundedTimeoutMs) =>
        provider.reconcilePaymentRequest(providerPaymentIdentity, {
          signal,
          timeoutMs: boundedTimeoutMs,
        }),
      deadline,
      timeoutMs,
    );
  }

  private providerTimeoutMs(provider: PaymentProviderName): number {
    const timeoutMs =
      provider === 'vnpay'
        ? this.config.vnpay?.timeoutMs
        : this.config.payos?.timeoutMs;
    return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : 10_000;
  }

  private async acquireRunLock(): Promise<() => Promise<void>> {
    const token = randomUUID();
    let redis;
    try {
      redis = this.redisConfig?.getClient();
    } catch {
      throw new ServiceUnavailableException('Payment reconciliation lock is unavailable.');
    }

    if (redis) {
      let result: string | null;
      try {
        result = await redis.set(
          RECONCILIATION_LOCK_KEY,
          token,
          'PX',
          RECONCILIATION_LOCK_TTL_MS,
          'NX',
        );
      } catch {
        throw new ServiceUnavailableException('Payment reconciliation lock is unavailable.');
      }
      if (result !== 'OK') {
        throw new ConflictException('A payment reconciliation run is already in progress.');
      }
      return async () => {
        try {
          await redis.eval(
            RELEASE_RECONCILIATION_LOCK_SCRIPT,
            1,
            RECONCILIATION_LOCK_KEY,
            token,
          );
        } catch {
          this.monitoring.capture({
            code: 'PAYMENT_RECONCILIATION_LOCK_RELEASE_FAILED',
            path: '/admin/commerce/reconciliation/runs',
            statusCode: 503,
          });
        }
      };
    }

    if (this.config.app?.nodeEnv === 'production') {
      throw new ServiceUnavailableException('Payment reconciliation lock is unavailable.');
    }
    if (this.localRunLock) {
      throw new ConflictException('A payment reconciliation run is already in progress.');
    }
    this.localRunLock = true;
    return async () => {
      this.localRunLock = false;
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
        if (current.order.fulfillmentStatus === CommerceFulfillmentStatus.fulfilled) {
          throw new ConflictException({
            error: 'FULFILLMENT_ALREADY_RECORDED',
            message: 'Canonical fulfillment is already recorded; a fulfillment retry is not permitted.',
          });
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

    throw new ConflictException(
      'Financial reconciliation cases require dedicated canonical resolution workflow.',
    );
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
      !isPaymentProviderName(settlement.provider) ||
      !settlement.providerSettlementReference ||
      !settlement.paymentEventId ||
      !paymentAttempt ||
      paymentAttempt.orderId !== current.orderId ||
      paymentAttempt.provider !== settlement.provider ||
      !paymentAttempt.providerPaymentIdentity ||
      paymentAttempt.providerOrderCode === null ||
      paymentAttempt.status !== CommercePaymentStatus.paid ||
      !paymentEvent ||
      paymentEvent.id !== settlement.paymentEventId ||
      paymentEvent.paymentAttemptId !== paymentAttempt.id ||
      paymentEvent.provider !== settlement.provider ||
      !paymentEvent.providerEventIdentity ||
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
      const recovered =
        current.status === CommercePaymentStatus.created &&
        !['CANCELLED', 'EXPIRED', 'FAILED'].includes(status.status);
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
    const sourceKeyBase = [
      attempt.id,
      kind,
      ...(linkedSettlementId ? [linkedSettlementId] : []),
    ].join(':');
    const existing = await this.prisma.commerceReconciliationCase.findUnique({
      where: { sourceKey: sourceKeyBase },
      select: { reasonCode: true },
    });
    const sourceKey =
      existing && existing.reasonCode !== safeReasonCode
        ? [
            sourceKeyBase,
            createHash('sha256').update(safeReasonCode).digest('hex').slice(0, 16),
          ].join(':')
        : sourceKeyBase;
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

  private encodeCursor(id: string | undefined): string | null {
    if (!id) return null;
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      createHash('sha256')
        .update(this.config.commerce.idempotencySecret as string)
        .digest(),
      iv,
    );
    cipher.setAAD(Buffer.from(RECONCILIATION_CURSOR_CONTEXT));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ version: RECONCILIATION_CURSOR_VERSION, id }), 'utf8'),
      cipher.final(),
    ]);
    return [
      iv.toString('base64url'),
      ciphertext.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join(RECONCILIATION_CURSOR_SEPARATOR);
  }

  private decodeCursor(cursor?: string): string | undefined {
    if (!cursor) return undefined;
    try {
      const parts = cursor.split(RECONCILIATION_CURSOR_SEPARATOR);
      if (parts.length !== 3) throw new Error('invalid cursor parts');
      const [iv, ciphertext, authTag] = parts.map((part) => Buffer.from(part, 'base64url'));
      const decipher = createDecipheriv(
        'aes-256-gcm',
        createHash('sha256')
          .update(this.config.commerce.idempotencySecret as string)
          .digest(),
        iv,
      );
      decipher.setAAD(Buffer.from(RECONCILIATION_CURSOR_CONTEXT));
      decipher.setAuthTag(authTag);
      const payload = JSON.parse(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'),
      ) as { version?: unknown; id?: unknown };
      if (
        payload.version !== RECONCILIATION_CURSOR_VERSION ||
        typeof payload.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.id)
      ) {
        throw new Error('invalid cursor payload');
      }
      return payload.id;
    } catch {
      throw new BadRequestException('Invalid payment reconciliation cursor.');
    }
  }

  private classifyProviderError(error: unknown): {
    kind: CommerceReconciliationKind;
    reasonCode: string;
  } {
    if (error instanceof VnPayQueryDrError) {
      switch (error.code) {
        case 'network_timeout':
          return {
            kind: CommerceReconciliationKind.provider_outage,
            reasonCode: 'PROVIDER_STATUS_TIMEOUT',
          };
        case 'provider_unavailable':
          return {
            kind: CommerceReconciliationKind.provider_outage,
            reasonCode: 'PROVIDER_STATUS_UNAVAILABLE',
          };
        case 'provider_fact_mismatch':
          return {
            kind: CommerceReconciliationKind.provider_fact_mismatch,
            reasonCode: 'PROVIDER_FACT_MISMATCH',
          };
        case 'invalid_response_signature':
          return {
            kind: CommerceReconciliationKind.unknown_provider_status,
            reasonCode: 'PROVIDER_STATUS_INVALID_SIGNATURE',
          };
        case 'malformed_response':
          return {
            kind: CommerceReconciliationKind.unknown_provider_status,
            reasonCode: 'PROVIDER_STATUS_MALFORMED',
          };
        default:
          return {
            kind: CommerceReconciliationKind.unknown_provider_status,
            reasonCode: 'PROVIDER_STATUS_INVALID_REQUEST',
          };
      }
    }
    if (error instanceof PaymentProviderError) {
      switch (error.code) {
        case 'disabled':
          return {
            kind: CommerceReconciliationKind.unknown_provider_status,
            reasonCode: 'PROVIDER_DISABLED',
          };
        case 'invalid_request':
          return {
            kind: CommerceReconciliationKind.unknown_provider_status,
            reasonCode: 'PROVIDER_STATUS_INVALID_REQUEST',
          };
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
        case 'unsupported':
          return {
            kind: CommerceReconciliationKind.unknown_provider_status,
            reasonCode: 'PROVIDER_UNSUPPORTED',
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
