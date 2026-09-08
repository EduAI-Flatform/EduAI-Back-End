import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import {
  AuditActorKind,
  CommerceActorKind,
  CommerceFulfillmentStatus,
  CommerceLifecycleEntityType,
  CommercePaymentStatus,
  CommerceNotificationOutboxStatus,
  CommerceOrderStatus,
  CommerceProductType,
  CommerceReconciliationKind,
  CommerceSettlementDisposition,
  CommerceSettlementKind,
  CourseAccessSourceType,
  EmailPurpose,
  MembershipSubscriptionStatus,
  NotificationCategory,
  Prisma,
} from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CourseAccessService } from '../access/course-access.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentRecoveryError, PaymentRecoveryReasonCode } from './payment-recovery-error';

const orderInclude = {
  lines: { orderBy: { id: 'asc' } },
  membershipCheckoutIntent: {
    include: {
      version: {
        include: {
          includedCourses: { orderBy: { courseId: 'asc' } },
          serviceEntitlements: { orderBy: { definitionId: 'asc' } },
        },
      },
      removedCourses: { orderBy: { courseId: 'asc' } },
    },
  },
} satisfies Prisma.CommerceOrderInclude;

type FulfillmentOrder = Prisma.CommerceOrderGetPayload<{ include: typeof orderInclude }>;

const canonicalOrderInclude = {
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
} satisfies Prisma.CommerceOrderInclude;

type CanonicalOrder = Prisma.CommerceOrderGetPayload<{
  include: typeof canonicalOrderInclude;
}>;

type CanonicalPayment = {
  order: CanonicalOrder;
  settlement: NonNullable<CanonicalOrder['confirmedSettlement']>;
  paymentAttempt: NonNullable<NonNullable<CanonicalOrder['confirmedSettlement']>['paymentAttempt']>;
};

const PROVIDER = 'payos';
const PAID_ORDER_FULFILLMENT_RETRY_REQUIRED = 'PAID_ORDER_FULFILLMENT_RETRY_REQUIRED';

@Injectable()
export class CommerceFulfillmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courseAccess: CourseAccessService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async fulfillConfirmedPayment(
    orderId: string,
    settlementId: string,
    actorKind: CommerceActorKind,
    actorId: string | null,
  ): Promise<void> {
    try {
      await this.runSerializable(
        async (tx) => {
          await this.requireCanonicalPayment(tx, orderId, settlementId);
          await this.fulfillConfirmedOrder(tx, orderId, actorKind, actorId);
        },
        { phase: 'fulfillment', financiallyCommitted: true, settlementId },
      );
    } catch (error) {
      if (error instanceof PaymentRecoveryError && error.phase === 'identity') {
        throw error;
      }

      const failureReasonCode = this.fulfillmentFailureReasonCode(error);
      let recorded = false;
      try {
        recorded = await this.persistFailure(
          orderId,
          settlementId,
          actorKind,
          actorId,
          failureReasonCode,
        );
      } catch (persistenceError) {
        if (
          persistenceError instanceof PaymentRecoveryError &&
          persistenceError.phase === 'identity'
        ) {
          throw persistenceError;
        }
        throw new PaymentRecoveryError(
          'fulfillment',
          'PAYMENT_RECOVERY_INTERNAL_ERROR',
          true,
          true,
          settlementId,
          persistenceError,
        );
      }
      if (!recorded) return;

      if (
        error instanceof PaymentRecoveryError &&
        error.phase === 'fulfillment' &&
        error.reasonCode === failureReasonCode
      ) {
        throw error;
      }
      throw new PaymentRecoveryError(
        'fulfillment',
        failureReasonCode,
        true,
        true,
        settlementId,
        error,
      );
    }
  }

  async fulfillConfirmedOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
    actorKind: CommerceActorKind,
    actorId: string | null,
  ): Promise<void> {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM commerce_orders WHERE id = ${orderId}::uuid FOR UPDATE`,
    );
    const order = await tx.commerceOrder.findUnique({ where: { id: orderId }, include: orderInclude });
    if (!order) throw new ConflictException('Confirmed Commerce order was not found.');
    if (order.fulfillmentStatus === CommerceFulfillmentStatus.fulfilled) return;
    if (order.status !== CommerceOrderStatus.confirmed) {
      throw new ConflictException('Only a confirmed Commerce order can be fulfilled.');
    }

    if (
      order.fulfillmentStatus === CommerceFulfillmentStatus.not_started ||
      order.fulfillmentStatus === CommerceFulfillmentStatus.failed
    ) {
      await this.transition(
        tx,
        order,
        order.fulfillmentStatus,
        CommerceFulfillmentStatus.processing,
        actorKind,
        actorId,
        'FULFILLMENT_STARTED',
      );
    } else if (order.fulfillmentStatus !== CommerceFulfillmentStatus.processing) {
      throw new ConflictException('Commerce fulfillment state is not retryable.');
    }

    for (const line of order.lines) {
      if (line.productType === CommerceProductType.course) {
        await this.fulfillCourse(tx, order, line);
      } else {
        await this.fulfillMembership(tx, order, line);
      }
    }

    await tx.commerceNotificationOutbox.createMany({
      data: [{
        eventKey: `commerce-order-fulfilled:${order.id}`,
        orderId: order.id,
        userId: order.buyerId,
        eventType: 'COMMERCE_ORDER_FULFILLED',
      }],
      skipDuplicates: true,
    });
    const completedOperationId = randomUUID();
    await this.audit.record({
      actorKind: this.auditActorKind(actorKind),
      ...(actorId ? { actorId } : {}),
      action: AuditAction.CommerceOrderFulfilled,
      target: { type: 'commerce_order', id: order.id },
      metadata: {
        operationId: completedOperationId,
        lineCount: order.lines.length,
        source: actorKind.toUpperCase(),
      },
    }, tx);
    await this.transition(
      tx,
      order,
      CommerceFulfillmentStatus.processing,
      CommerceFulfillmentStatus.fulfilled,
      actorKind,
      actorId,
      'FULFILLMENT_COMPLETED',
      completedOperationId,
    );
  }

  async dispatchPending(limit = 20): Promise<void> {
    const pending = await this.prisma.commerceNotificationOutbox.findMany({
      where: { status: CommerceNotificationOutboxStatus.pending },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    for (const event of pending) {
      try {
        await this.notifications.createForUser({
          userId: event.userId,
          eventKey: event.eventKey,
          type: event.eventType,
          category: NotificationCategory.system,
          emailPurpose: EmailPurpose.transactional,
          title: 'Your order is ready',
          body: 'Your purchase has been fulfilled and access is available.',
        });
        await this.prisma.commerceNotificationOutbox.updateMany({
          where: { id: event.id, status: CommerceNotificationOutboxStatus.pending },
          data: {
            status: CommerceNotificationOutboxStatus.dispatched,
            attemptCount: { increment: 1 },
            lastAttemptAt: new Date(),
            dispatchedAt: new Date(),
          },
        });
      } catch {
        await this.prisma.commerceNotificationOutbox.updateMany({
          where: { id: event.id, status: CommerceNotificationOutboxStatus.pending },
          data: { attemptCount: { increment: 1 }, lastAttemptAt: new Date() },
        }).catch(() => undefined);
      }
    }
  }

  private async persistFailure(
    orderId: string,
    settlementId: string,
    actorKind: CommerceActorKind,
    actorId: string | null,
    failureReasonCode: PaymentRecoveryReasonCode,
  ): Promise<boolean> {
    return this.runSerializable(
      (tx) => this.recordFailure(
        tx,
        orderId,
        settlementId,
        actorKind,
        actorId,
        failureReasonCode,
      ),
      { phase: 'fulfillment', financiallyCommitted: true, settlementId },
    );
  }

  private async requireCanonicalPayment(
    tx: Prisma.TransactionClient,
    orderId: string,
    settlementId: string,
  ): Promise<CanonicalPayment> {
    let order: CanonicalOrder | null;
    try {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM commerce_orders WHERE id = ${orderId}::uuid FOR UPDATE`,
      );
      order = await tx.commerceOrder.findUnique({
        where: { id: orderId },
        include: canonicalOrderInclude,
      });
      const initialSettlement = order?.confirmedSettlement;
      if (initialSettlement) {
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM commerce_settlements WHERE id = ${initialSettlement.id}::uuid FOR UPDATE`,
        );
        if (initialSettlement.paymentAttemptId) {
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM commerce_payment_attempts WHERE id = ${initialSettlement.paymentAttemptId}::uuid FOR UPDATE`,
          );
        }
        if (initialSettlement.paymentEventId) {
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM commerce_payment_events WHERE id = ${initialSettlement.paymentEventId}::uuid FOR UPDATE`,
          );
        }
        order = await tx.commerceOrder.findUnique({
          where: { id: orderId },
          include: canonicalOrderInclude,
        });
      }
    } catch (error) {
      if (error instanceof PaymentRecoveryError) throw error;
      throw new PaymentRecoveryError(
        'identity',
        'PAYMENT_RECOVERY_INTERNAL_ERROR',
        false,
        true,
        settlementId,
        error,
      );
    }
    const settlement = order?.confirmedSettlement;
    const paymentAttempt = settlement?.paymentAttempt;
    const paymentEvent = settlement?.paymentEvent;
    if (
      !order ||
      order.status !== CommerceOrderStatus.confirmed ||
      order.confirmedSettlementId !== settlementId ||
      !settlement ||
      settlement.id !== settlementId ||
      settlement.orderId !== orderId ||
      settlement.kind !== CommerceSettlementKind.provider_collection ||
      settlement.disposition !== CommerceSettlementDisposition.matched ||
      settlement.provider !== PROVIDER ||
      !settlement.providerSettlementReference ||
      !settlement.paymentEventId ||
      !paymentAttempt ||
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
      settlement.paymentAttemptId !== paymentAttempt.id ||
      paymentAttempt.orderId !== orderId ||
      paymentAttempt.provider !== PROVIDER ||
      !paymentAttempt.providerPaymentIdentity ||
      paymentAttempt.providerOrderCode === null ||
      paymentAttempt.status !== CommercePaymentStatus.paid ||
      paymentAttempt.amountMinor !== settlement.amountMinor ||
      paymentAttempt.currency !== settlement.currency ||
      settlement.amountMinor !== order.payableAmountMinor ||
      settlement.currency !== order.currency
    ) {
      throw new PaymentRecoveryError(
        'identity',
        'PAYMENT_SETTLEMENT_CONFLICT',
        false,
        false,
        settlementId,
      );
    }
    return { order, settlement, paymentAttempt };
  }

  private async recordFailure(
    tx: Prisma.TransactionClient,
    orderId: string,
    settlementId: string,
    actorKind: CommerceActorKind,
    actorId: string | null,
    failureReasonCode: PaymentRecoveryReasonCode,
  ): Promise<boolean> {
    const payment = await this.requireCanonicalPayment(tx, orderId, settlementId);
    if (payment.order.fulfillmentStatus === CommerceFulfillmentStatus.fulfilled) return false;

    if (
      payment.order.fulfillmentStatus === CommerceFulfillmentStatus.not_started ||
      payment.order.fulfillmentStatus === CommerceFulfillmentStatus.failed
    ) {
      await this.transition(
        tx,
        payment.order,
        payment.order.fulfillmentStatus,
        CommerceFulfillmentStatus.processing,
        actorKind,
        actorId,
        'FULFILLMENT_STARTED',
      );
    }
    await this.transition(
      tx,
      payment.order,
      CommerceFulfillmentStatus.processing,
      CommerceFulfillmentStatus.failed,
      actorKind,
      actorId,
      'FULFILLMENT_FAILED',
    );

    const now = new Date();
    const existingCase = await tx.commerceReconciliationCase.findUnique({
      where: { settlementId },
    });
    if (existingCase) {
      if (
        existingCase.kind !== CommerceReconciliationKind.paid_not_fulfilled ||
        existingCase.orderId !== orderId ||
        existingCase.settlementId !== settlementId ||
        existingCase.paymentAttemptId !== payment.paymentAttempt.id
      ) {
        throw new PaymentRecoveryError(
          'identity',
          'PAYMENT_SETTLEMENT_CONFLICT',
          false,
          false,
          settlementId,
        );
      }
      if (existingCase.status === 'open') {
        await tx.commerceReconciliationCase.update({
          where: { id: existingCase.id },
          data: {
            reasonCode: PAID_ORDER_FULFILLMENT_RETRY_REQUIRED,
            lastCheckedAt: now,
            checkCount: { increment: 1 },
          },
        });
      }
    } else {
      await tx.commerceReconciliationCase.create({
        data: {
          orderId,
          settlementId,
          paymentAttemptId: payment.paymentAttempt.id,
          kind: CommerceReconciliationKind.paid_not_fulfilled,
          reasonCode: PAID_ORDER_FULFILLMENT_RETRY_REQUIRED,
          sourceKey: `${payment.paymentAttempt.id}:paid_not_fulfilled:${settlementId}`,
          lastCheckedAt: now,
        },
      });
    }
    await this.audit.record({
      actorKind: this.auditActorKind(actorKind),
      ...(actorId ? { actorId } : {}),
      action: AuditAction.PaymentWebhookReconciliationRequired,
      target: { type: 'commerce_order', id: orderId },
      metadata: {
        operationId: randomUUID(),
        reasonCode: PAID_ORDER_FULFILLMENT_RETRY_REQUIRED,
        failureReasonCode,
        failurePhase: 'FULFILLMENT',
        provider: PROVIDER,
        settlementId,
      },
    }, tx);
    return true;
  }

  private fulfillmentFailureReasonCode(error: unknown): PaymentRecoveryReasonCode {
    if (error instanceof PaymentRecoveryError && error.phase === 'fulfillment') {
      return error.reasonCode;
    }
    return 'PAYMENT_FULFILLMENT_FAILED';
  }

  private async fulfillCourse(
    tx: Prisma.TransactionClient,
    order: FulfillmentOrder,
    line: FulfillmentOrder['lines'][number],
  ): Promise<void> {
    const grant = await this.courseAccess.ensureGrant({
      userId: order.buyerId,
      courseId: line.productReferenceId,
      sourceType: CourseAccessSourceType.course_purchase,
      sourceId: line.id,
      startsAt: order.confirmedAt ?? new Date(),
      endsAt: null,
    }, tx);
    if (!grant) throw new ConflictException('Course purchase grant was not created.');
    await this.effect(tx, order.id, line.id, 'COURSE_ACCESS', line.productReferenceId, 'course_access_grant', grant.id);
  }

  private async fulfillMembership(
    tx: Prisma.TransactionClient,
    order: FulfillmentOrder,
    line: FulfillmentOrder['lines'][number],
  ): Promise<void> {
    const intent = order.membershipCheckoutIntent;
    if (!intent || intent.versionId !== line.productReferenceId) {
      throw new ConflictException('Membership order snapshot is incomplete.');
    }
    await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${order.buyerId}::uuid FOR UPDATE`);
    let subscription = await tx.membershipSubscription.findUnique({
      where: { sourceOrderLineId: line.id },
    });
    if (!subscription) {
      const overlap = await tx.membershipSubscription.findFirst({
        where: {
          userId: order.buyerId,
          status: MembershipSubscriptionStatus.active,
          startsAt: { lt: intent.endsAt },
          expiresAt: { gt: intent.startsAt },
        },
        select: { id: true },
      });
      if (overlap) throw new ConflictException('Membership term overlaps an existing term.');
      subscription = await tx.membershipSubscription.create({
        data: {
          userId: order.buyerId,
          versionId: intent.versionId,
          sourceOrderLineId: line.id,
          startsAt: intent.startsAt,
          expiresAt: intent.endsAt,
        },
      });
    }
    await this.effect(tx, order.id, line.id, 'MEMBERSHIP_TERM', intent.versionId, 'membership_subscription', subscription.id);

    for (const included of intent.version.includedCourses) {
      const grant = await this.courseAccess.ensureGrant({
        userId: order.buyerId,
        courseId: included.courseId,
        sourceType: CourseAccessSourceType.membership,
        sourceId: line.id,
        startsAt: intent.startsAt,
        endsAt: intent.endsAt,
      }, tx);
      if (!grant) throw new ConflictException('Membership course grant was not created.');
      await this.effect(tx, order.id, line.id, 'MEMBERSHIP_COURSE_ACCESS', included.courseId, 'course_access_grant', grant.id);
    }
    for (const removed of intent.removedCourses) {
      if (!removed.graceStartsAt || !removed.graceEndsAt) continue;
      const sourceId = `${line.id}:${removed.courseId}`;
      const grant = await this.courseAccess.ensureGrant({
        userId: order.buyerId,
        courseId: removed.courseId,
        sourceType: CourseAccessSourceType.membership_grace,
        sourceId,
        startsAt: removed.graceStartsAt,
        endsAt: removed.graceEndsAt,
      }, tx);
      if (!grant) throw new ConflictException('Membership grace grant was not created.');
      await this.effect(tx, order.id, line.id, 'MEMBERSHIP_GRACE_ACCESS', removed.courseId, 'course_access_grant', grant.id);
    }
    for (const entitlement of intent.version.serviceEntitlements) {
      await tx.serviceEntitlementGrant.createMany({
        data: [{
          userId: order.buyerId,
          definitionId: entitlement.definitionId,
          sourceType: 'membership',
          sourceId: line.id,
          valueType: entitlement.valueType,
          resetPeriod: entitlement.resetPeriod,
          booleanValue: entitlement.booleanValue,
          quota: entitlement.quota,
          startsAt: intent.startsAt,
          endsAt: intent.endsAt,
        }],
        skipDuplicates: true,
      });
      const grant = await tx.serviceEntitlementGrant.findUnique({
        where: {
          userId_definitionId_sourceType_sourceId: {
            userId: order.buyerId,
            definitionId: entitlement.definitionId,
            sourceType: 'membership',
            sourceId: line.id,
          },
        },
        select: { id: true },
      });
      if (!grant) throw new ConflictException('Membership service entitlement was not created.');
      await this.effect(tx, order.id, line.id, 'MEMBERSHIP_SERVICE_ACCESS', entitlement.definitionId, 'service_entitlement_grant', grant.id);
    }
  }

  private effect(
    tx: Prisma.TransactionClient,
    orderId: string,
    orderLineId: string,
    effectType: string,
    sourceId: string,
    resourceType: string,
    resourceId: string,
  ) {
    return tx.commerceFulfillmentEffect.createMany({
      data: [{ orderId, orderLineId, effectType, sourceId, resourceType, resourceId }],
      skipDuplicates: true,
    });
  }

  private async transition(
    tx: Prisma.TransactionClient,
    order: Pick<FulfillmentOrder, 'id'>,
    previousStatus: CommerceFulfillmentStatus,
    nextStatus: CommerceFulfillmentStatus,
    actorKind: CommerceActorKind,
    actorId: string | null,
    reasonCode: string,
    operationId = randomUUID(),
  ): Promise<void> {
    await tx.commerceOrder.update({
      where: { id: order.id },
      data: { fulfillmentStatus: nextStatus, fulfillmentOperationId: operationId },
    });
    await tx.commerceLifecycleEvent.create({
      data: {
        entityType: CommerceLifecycleEntityType.fulfillment,
        entityId: order.id,
        previousStatus,
        nextStatus,
        actorKind,
        actorId,
        operationId,
        reasonCode,
      },
    });
  }

  private auditActorKind(kind: CommerceActorKind): AuditActorKind {
    if (kind === CommerceActorKind.provider) return AuditActorKind.PROVIDER;
    if (kind === CommerceActorKind.system) return AuditActorKind.SYSTEM;
    return AuditActorKind.USER;
  }

  private async runSerializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: {
      phase: 'fulfillment';
      financiallyCommitted: boolean;
      settlementId?: string;
    },
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2034' || error.code === 'P2002');
        if (!retryable) throw error;
        if (attempt === 2) {
          throw new PaymentRecoveryError(
            options?.phase ?? 'fulfillment',
            'PAYMENT_TRANSACTION_RETRY_EXHAUSTED',
            options?.financiallyCommitted ?? true,
            true,
            options?.settlementId,
            error,
          );
        }
      }
    }
    throw new Error('Unreachable transaction retry state.');
  }
}
