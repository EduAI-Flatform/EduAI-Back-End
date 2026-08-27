import { createHmac, randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  AuditActorKind,
  CommerceActorKind,
  CommerceFulfillmentStatus,
  CommercePaymentStatus,
  CommerceReconciliationKind,
  CommerceReconciliationResolution,
  CommerceReconciliationStatus,
  Prisma,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { MonitoringService } from '../../common/monitoring/monitoring.service';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CommerceFulfillmentService } from './commerce-fulfillment.service';
import { ListPaymentReviewsDto, ResolvePaymentReviewDto, RunPaymentReconciliationDto } from './dto/payment-reconciliation.dto';
import { PAYMENT_PROVIDER, PaymentProvider, PaymentProviderError, PaymentRequestStatus, VerifiedPaymentWebhook } from './payment-provider';
import { PaymentWebhookService } from './payment-webhook.service';

const PROVIDER = 'payos';
const ELIGIBLE_STATUSES = [
  CommercePaymentStatus.created,
  CommercePaymentStatus.pending,
  CommercePaymentStatus.paid,
] as const;

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
          await this.openCase(attempt, CommerceReconciliationKind.provider_fact_mismatch, reason);
          reviewRequired += 1;
          continue;
        }
        await this.persistCheckedFacts(attempt, status);
        if (status.status === 'PAID') {
          const verified = this.toVerified(attempt, status);
          if (!verified) {
            await this.openCase(
              attempt,
              CommerceReconciliationKind.provider_fact_mismatch,
              'PROVIDER_PAID_FACTS_INCOMPLETE',
            );
            reviewRequired += 1;
            continue;
          }
          try {
            await this.webhook.ingestVerified(verified);
            recovered += 1;
          } catch {
            await this.openCase(
              attempt,
              CommerceReconciliationKind.paid_not_fulfilled,
              'PAID_ORDER_FULFILLMENT_RETRY_REQUIRED',
            );
            reviewRequired += 1;
          }
        } else if (status.status === 'UNDERPAID' || status.status === 'FAILED') {
          await this.openCase(
            attempt,
            CommerceReconciliationKind.provider_fact_mismatch,
            status.status === 'UNDERPAID' ? 'PROVIDER_AMOUNT_UNDERPAID' : 'PROVIDER_PAYMENT_FAILED',
          );
          reviewRequired += 1;
        }
      } catch (error) {
        const kind =
          error instanceof PaymentProviderError && error.code === 'malformed_response'
            ? CommerceReconciliationKind.unknown_provider_status
            : CommerceReconciliationKind.provider_outage;
        const reason =
          kind === CommerceReconciliationKind.unknown_provider_status
            ? 'PROVIDER_STATUS_MALFORMED'
            : 'PROVIDER_STATUS_UNAVAILABLE';
        await this.openCase(attempt, kind, reason);
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
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM commerce_reconciliation_cases WHERE id = ${caseId}::uuid FOR UPDATE`,
      );
      const current = await tx.commerceReconciliationCase.findUnique({
        where: { id: caseId },
        include: { order: { select: { fulfillmentStatus: true } } },
      });
      if (!current) throw new NotFoundException('Payment review case not found.');
      if (current.status !== CommerceReconciliationStatus.open) {
        throw new ConflictException('Payment review case is already resolved.');
      }
      if (current.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) {
        throw new ConflictException({
          error: 'RECONCILIATION_VERSION_CONFLICT',
          message: 'Payment review case changed. Reload before resolving.',
        });
      }
      if (input.resolution === 'retry_succeeded') {
        if (current.kind !== CommerceReconciliationKind.paid_not_fulfilled) {
          throw new ConflictException('Only failed fulfillment review can be retried.');
        }
        await this.fulfillment.fulfillConfirmedOrder(
          tx,
          current.orderId,
          CommerceActorKind.user,
          actorId,
        );
      } else if (
        current.kind === CommerceReconciliationKind.duplicate_collection ||
        current.kind === CommerceReconciliationKind.late_payment ||
        current.kind === CommerceReconciliationKind.paid_not_fulfilled
      ) {
        throw new ConflictException('Financial collection review requires its dedicated resolution workflow.');
      }
      const operationId = randomUUID();
      const updated = await tx.commerceReconciliationCase.update({
        where: { id: caseId },
        data: {
          status: CommerceReconciliationStatus.resolved,
          statusOperationId: operationId,
          resolution:
            input.resolution === 'retry_succeeded'
              ? CommerceReconciliationResolution.retry_succeeded
              : CommerceReconciliationResolution.acknowledged,
          resolvedById: actorId,
          resolvedAt: new Date(),
        },
      });
      await tx.commerceLifecycleEvent.create({
        data: {
          entityType: 'reconciliation',
          entityId: caseId,
          previousStatus: CommerceReconciliationStatus.open,
          nextStatus: CommerceReconciliationStatus.resolved,
          actorKind: CommerceActorKind.user,
          actorId,
          operationId,
          reasonCode:
            input.resolution === 'retry_succeeded'
              ? 'FULFILLMENT_RETRY_SUCCEEDED'
              : 'OPERATOR_ACKNOWLEDGED',
        },
      });
      await this.audit.record({
        actorId,
        action: AuditAction.PaymentReconciliationResolved,
        target: { type: 'commerce_reconciliation_case', id: caseId },
        metadata: {
          operationId,
          kind: current.kind.toUpperCase(),
          reasonCode: current.reasonCode,
          resolution: input.resolution.toUpperCase(),
        },
      }, tx);
      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (input.resolution === 'retry_succeeded') await this.fulfillment.dispatchPending();
    return { id: result.id, status: result.status.toUpperCase(), resolution: result.resolution?.toUpperCase(), resolvedAt: result.resolvedAt };
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
                providerReceivingAccountHash: this.receivingAccountHash(
                  status.receivingAccount,
                ),
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

  private async openCase(
    attempt: { id: string; orderId: string },
    kind: CommerceReconciliationKind,
    reasonCode: string,
  ) {
    const now = new Date();
    await this.prisma.commerceReconciliationCase.upsert({
      where: { sourceKey: `${attempt.id}:${kind}` },
      create: {
        orderId: attempt.orderId,
        paymentAttemptId: attempt.id,
        kind,
        reasonCode,
        sourceKey: `${attempt.id}:${kind}`,
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

  private toVerified(
    attempt: {
      providerPaymentIdentity: string | null;
      providerReceivingAccountHash: string | null;
      providerOrderCode: bigint | null;
      amountMinor: bigint;
    },
    status: PaymentRequestStatus,
  ): VerifiedPaymentWebhook | null {
    if (status.amountPaidMinor !== attempt.amountMinor || status.amountRemainingMinor !== 0n) return null;
    const transaction = status.transactions.find(
      (item) =>
        item.amountMinor === attempt.amountMinor &&
        this.receivingAccountHash(item.receivingAccount) ===
          (attempt.providerReceivingAccountHash ??
            this.receivingAccountHash(status.receivingAccount)),
    );
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

  private receivingAccountHash(value: string): string {
    return createHmac('sha256', this.config.commerce.idempotencySecret as string)
      .update(`payos-receiving-account:${value}`)
      .digest('hex');
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
