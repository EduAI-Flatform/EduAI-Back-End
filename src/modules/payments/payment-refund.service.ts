import { createHash, createHmac, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  CommerceActorKind, CommerceIdempotencyStatus, CommerceLifecycleEntityType,
  CommerceOrderStatus, CommerceProductType, CommerceReconciliationResolution,
  CommerceReconciliationStatus, CommerceRefundStatus, CourseAccessSourceType,
  MembershipSubscriptionStatus, Prisma, ServiceEntitlementGrantStatus,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { AppConfigService } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CourseAccessService } from '../access/course-access.service';
import { CreateRefundDto, ListRefundsDto, RecordRefundDto, RejectRefundDto } from './dto/payment-refund.dto';

const OPERATION = 'payment.refund-request';
const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const refundInclude = {
  allocations: { include: { orderLine: true } },
  order: { select: { buyerId: true, orderNumber: true, status: true, fulfillmentStatus: true, confirmedSettlementId: true } },
  settlement: { select: { provider: true, amountMinor: true, currency: true, settledAt: true } },
  requestedBy: { select: { id: true, email: true, fullName: true } },
  recordedBy: { select: { id: true, email: true, fullName: true } },
  reconciliationCase: { select: { id: true, status: true } },
} satisfies Prisma.CommerceRefundInclude;
type Refund = Prisma.CommerceRefundGetPayload<{ include: typeof refundInclude }>;

@Injectable()
export class PaymentRefundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly access: CourseAccessService,
  ) {}

  async list(query: ListRefundsDto) {
    const status = query.status?.toLowerCase();
    if (status && !Object.values(CommerceRefundStatus).includes(status as CommerceRefundStatus)) {
      throw new BadRequestException('Invalid refund status.');
    }
    const where = status ? { status: status as CommerceRefundStatus } : {};
    const [total, items] = await this.prisma.$transaction([
      this.prisma.commerceRefund.count({ where }),
      this.prisma.commerceRefund.findMany({
        where, include: refundInclude, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize, take: query.pageSize,
      }),
    ]);
    return { items: items.map((item) => this.project(item)), page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) };
  }

  async create(actorId: string, key: string | undefined, input: CreateRefundDto) {
    this.assertKey(key);
    const canonical = JSON.stringify({
      settlementId: input.settlementId, reconciliationCaseId: input.reconciliationCaseId ?? null,
      amountMinor: input.amountMinor, reasonCode: input.reasonCode,
      allocations: [...input.allocations].sort((a, b) => a.orderLineId.localeCompare(b.orderLineId)),
    });
    const keyHash = createHmac('sha256', this.config.commerce.idempotencySecret as string).update(key).digest('hex');
    const requestHash = createHash('sha256').update(canonical).digest('hex');
    return this.serializable(async (tx) => {
      const existing = await tx.commerceIdempotencyRecord.findUnique({ where: {
        actorId_operation_keyHashVersion_keyHash: { actorId, operation: OPERATION, keyHashVersion: 1, keyHash },
      } });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new ConflictException({ error: 'IDEMPOTENCY_KEY_REUSED', message: 'Idempotency key was reused with different refund input.' });
        const refund = existing.resourceId ? await tx.commerceRefund.findUnique({ where: { id: existing.resourceId }, include: refundInclude }) : null;
        if (!refund) throw new ConflictException('Refund request is still processing.');
        return this.project(refund);
      }
      await tx.$queryRaw(Prisma.sql`SELECT id FROM commerce_settlements WHERE id = ${input.settlementId}::uuid FOR UPDATE`);
      const settlement = await tx.commerceSettlement.findUnique({
        where: { id: input.settlementId },
        include: { order: { include: { lines: true } }, reconciliationCase: true },
      });
      if (!settlement || !settlement.provider || settlement.kind !== 'provider_collection') throw new NotFoundException('Refundable settlement was not found.');
      if (input.reconciliationCaseId && (
        settlement.reconciliationCase?.id !== input.reconciliationCaseId ||
        settlement.reconciliationCase.status !== CommerceReconciliationStatus.open
      )) throw new ConflictException('Refund reconciliation case is not open for this settlement.');
      const amount = BigInt(input.amountMinor);
      const ids = new Set<string>();
      let sum = 0n;
      const lines = new Map(settlement.order.lines.map((line) => [line.id, line]));
      for (const allocation of input.allocations) {
        if (ids.has(allocation.orderLineId)) throw new BadRequestException('Refund allocation lines must be unique.');
        ids.add(allocation.orderLineId);
        const line = lines.get(allocation.orderLineId);
        const value = BigInt(allocation.amountMinor);
        if (!line || value <= 0n || value > line.finalAmountMinor) throw new BadRequestException('Refund allocation is outside the settled line amount.');
        sum += value;
      }
      if (sum !== amount || amount > settlement.amountMinor) throw new BadRequestException('Refund allocations must equal a bounded refund amount.');
      const now = new Date();
      const refund = await tx.commerceRefund.create({ data: {
        orderId: settlement.orderId, settlementId: settlement.id,
        reconciliationCaseId: input.reconciliationCaseId, amountMinor: amount,
        currency: 'VND', provider: settlement.provider, requestedById: actorId,
        reasonCode: input.reasonCode,
        allocations: { create: input.allocations.map((item) => ({
          orderLineId: item.orderLineId, amountMinor: BigInt(item.amountMinor), currency: 'VND',
        })) },
      }, include: refundInclude });
      await tx.commerceIdempotencyRecord.create({ data: {
        actorId, operation: OPERATION, keyHash, keyHashVersion: 1, requestHash,
        requestCanonicalizationVersion: 1, status: CommerceIdempotencyStatus.completed,
        resourceType: 'commerce_refund', resourceId: refund.id, lockedUntil: now, completedAt: now,
      } });
      await this.audit.record({
        actorId, action: AuditAction.PaymentRefundRequested,
        target: { type: 'commerce_refund', id: refund.id },
        metadata: { operationId: randomUUID(), amountMinor: amount.toString(), currency: 'VND', reasonCode: input.reasonCode, allocationCount: input.allocations.length },
      }, tx);
      return this.project(refund);
    });
  }

  async record(actorId: string, refundId: string, input: RecordRefundDto) {
    if (input.confirmExternalAction !== true) {
      throw new BadRequestException('External refund action must be explicitly confirmed.');
    }
    return this.serializable(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM commerce_refunds WHERE id = ${refundId}::uuid FOR UPDATE`);
      let refund = await tx.commerceRefund.findUnique({ where: { id: refundId }, include: refundInclude });
      if (!refund) throw new NotFoundException('Refund request was not found.');
      if (refund.status === CommerceRefundStatus.recorded) {
        if (refund.externalReference !== input.externalReference) {
          throw new ConflictException({ error: 'REFUND_ALREADY_RECORDED', message: 'Refund already has another external reference.' });
        }
        return this.project(refund);
      }
      if (refund.status !== CommerceRefundStatus.requested) throw new ConflictException('Refund request is already rejected.');
      if (refund.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) throw new ConflictException({ error: 'REFUND_VERSION_CONFLICT', message: 'Refund changed. Reload before recording.' });
      const operationId = randomUUID();
      const now = new Date();
      await tx.commerceRefund.update({ where: { id: refund.id }, data: {
        status: CommerceRefundStatus.recorded, statusOperationId: operationId,
        externalReference: input.externalReference, recordedById: actorId, recordedAt: now,
      } });
      await tx.commerceLifecycleEvent.create({ data: {
        entityType: CommerceLifecycleEntityType.refund, entityId: refund.id,
        previousStatus: CommerceRefundStatus.requested, nextStatus: CommerceRefundStatus.recorded,
        actorKind: CommerceActorKind.user, actorId, operationId, reasonCode: refund.reasonCode,
      } });
      const consequences: string[] = [];
      for (const allocation of refund.allocations) {
        if (
          refund.order.confirmedSettlementId !== refund.settlementId ||
          refund.order.fulfillmentStatus !== 'fulfilled'
        ) {
          consequences.push('NON_FULFILLING_COLLECTION_ACCESS_UNCHANGED');
          continue;
        }
        const aggregate = await tx.commerceRefundAllocation.aggregate({
          where: { orderLineId: allocation.orderLineId, refund: { status: CommerceRefundStatus.recorded } },
          _sum: { amountMinor: true },
        });
        if ((aggregate._sum.amountMinor ?? 0n) < allocation.orderLine.finalAmountMinor) {
          consequences.push('PARTIAL_ACCESS_PRESERVED');
          continue;
        }
        if (allocation.orderLine.productType === CommerceProductType.course) {
          await this.access.revokeGrant({
            userId: refund.order.buyerId, courseId: allocation.orderLine.productReferenceId,
            sourceType: CourseAccessSourceType.course_purchase, sourceId: allocation.orderLineId,
          }, 'FULL_REFUND_RECORDED', tx);
          consequences.push('COURSE_PURCHASE_REVOKED');
        } else {
          await tx.membershipSubscription.updateMany({
            where: { sourceOrderLineId: allocation.orderLineId, status: MembershipSubscriptionStatus.active },
            data: { status: MembershipSubscriptionStatus.cancelled },
          });
          await tx.courseAccessGrant.updateMany({
            where: { userId: refund.order.buyerId, sourceType: { in: [CourseAccessSourceType.membership, CourseAccessSourceType.membership_grace] }, OR: [
              { sourceId: allocation.orderLineId }, { sourceId: { startsWith: `${allocation.orderLineId}:` } },
            ] },
            data: { status: 'revoked', revokedAt: now, revocationReason: 'FULL_REFUND_RECORDED' },
          });
          await tx.serviceEntitlementGrant.updateMany({
            where: { userId: refund.order.buyerId, sourceType: 'membership', sourceId: allocation.orderLineId, status: ServiceEntitlementGrantStatus.active },
            data: { status: ServiceEntitlementGrantStatus.revoked, revokedAt: now },
          });
          consequences.push('MEMBERSHIP_TERM_CANCELLED');
        }
      }
      if (refund.reconciliationCase) {
        const caseOperationId = randomUUID();
        await tx.commerceReconciliationCase.update({ where: { id: refund.reconciliationCase.id }, data: {
          status: CommerceReconciliationStatus.resolved, statusOperationId: caseOperationId,
          resolution: CommerceReconciliationResolution.refund, resolvedById: actorId, resolvedAt: now,
        } });
        await tx.commerceLifecycleEvent.create({ data: {
          entityType: CommerceLifecycleEntityType.reconciliation, entityId: refund.reconciliationCase.id,
          previousStatus: CommerceReconciliationStatus.open, nextStatus: CommerceReconciliationStatus.resolved,
          actorKind: CommerceActorKind.user, actorId, operationId: caseOperationId, reasonCode: 'EXTERNAL_REFUND_RECORDED',
        } });
        if (refund.order.status === CommerceOrderStatus.late_payment_review) {
          const orderOperationId = randomUUID();
          await tx.commerceOrder.update({ where: { id: refund.orderId }, data: {
            status: CommerceOrderStatus.late_payment_refunded, statusOperationId: orderOperationId,
          } });
          await tx.commerceLifecycleEvent.create({ data: {
            entityType: CommerceLifecycleEntityType.order, entityId: refund.orderId,
            previousStatus: CommerceOrderStatus.late_payment_review, nextStatus: CommerceOrderStatus.late_payment_refunded,
            actorKind: CommerceActorKind.user, actorId, operationId: orderOperationId, reasonCode: 'EXTERNAL_REFUND_RECORDED',
          } });
        }
      }
      await this.audit.record({
        actorId, action: AuditAction.PaymentRefundRecorded,
        target: { type: 'commerce_refund', id: refund.id },
        metadata: { operationId, amountMinor: refund.amountMinor.toString(), currency: refund.currency, reasonCode: refund.reasonCode, accessConsequences: consequences },
      }, tx);
      refund = await tx.commerceRefund.findUniqueOrThrow({ where: { id: refund.id }, include: refundInclude });
      return this.project(refund);
    }).catch((error) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ error: 'REFUND_REFERENCE_REUSED', message: 'External refund reference is already recorded.' });
      }
      throw error;
    });
  }

  async reject(actorId: string, refundId: string, input: RejectRefundDto) {
    return this.serializable(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM commerce_refunds WHERE id = ${refundId}::uuid FOR UPDATE`);
      let refund = await tx.commerceRefund.findUnique({ where: { id: refundId }, include: refundInclude });
      if (!refund) throw new NotFoundException('Refund request was not found.');
      if (refund.status === CommerceRefundStatus.rejected) {
        if (refund.rejectionReasonCode !== input.rejectionReasonCode) {
          throw new ConflictException({ error: 'REFUND_ALREADY_REJECTED', message: 'Refund already has another rejection reason.' });
        }
        return this.project(refund);
      }
      if (refund.status !== CommerceRefundStatus.requested) throw new ConflictException('Recorded refunds cannot be rejected.');
      if (refund.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) throw new ConflictException({ error: 'REFUND_VERSION_CONFLICT', message: 'Refund changed. Reload before rejecting.' });
      const operationId = randomUUID();
      await tx.commerceRefund.update({ where: { id: refund.id }, data: {
        status: CommerceRefundStatus.rejected, statusOperationId: operationId,
        rejectionReasonCode: input.rejectionReasonCode, rejectedAt: new Date(),
      } });
      await tx.commerceLifecycleEvent.create({ data: {
        entityType: CommerceLifecycleEntityType.refund, entityId: refund.id,
        previousStatus: CommerceRefundStatus.requested, nextStatus: CommerceRefundStatus.rejected,
        actorKind: CommerceActorKind.user, actorId, operationId, reasonCode: input.rejectionReasonCode,
      } });
      await this.audit.record({
        actorId, action: AuditAction.PaymentRefundRejected,
        target: { type: 'commerce_refund', id: refund.id },
        metadata: { operationId, reasonCode: input.rejectionReasonCode },
      }, tx);
      refund = await tx.commerceRefund.findUniqueOrThrow({ where: { id: refund.id }, include: refundInclude });
      return this.project(refund);
    });
  }

  private project(refund: Refund) {
    return {
      ...refund, status: refund.status.toUpperCase(), amountMinor: refund.amountMinor.toString(),
      allocations: refund.allocations.map((item) => ({ orderLineId: item.orderLineId, amountMinor: item.amountMinor.toString(), currency: item.currency, productType: item.orderLine.productType.toUpperCase(), displayTitle: item.orderLine.displayTitle })),
      order: { orderNumber: refund.order.orderNumber, status: refund.order.status.toUpperCase() },
      settlement: { ...refund.settlement, amountMinor: refund.settlement.amountMinor.toString() },
    };
  }
  private assertKey(value: string | undefined): asserts value is string {
    if (!value || !KEY.test(value)) throw new BadRequestException({ error: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency-Key must be 8-128 bounded characters.' });
    if (!this.config.commerce.idempotencySecret) throw new ServiceUnavailableException({ error: 'PAYMENT_CONFIGURATION_INVALID', message: 'Payment configuration is unavailable.' });
  }
  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) try {
      return await this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || (error.code !== 'P2034' && error.code !== 'P2002') || attempt === 2) throw error;
    }
    throw new Error('Serializable transaction retry exhausted');
  }
}
