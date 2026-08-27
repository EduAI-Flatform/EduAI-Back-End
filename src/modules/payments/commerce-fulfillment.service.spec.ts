import {
  CommerceActorKind,
  CommerceFulfillmentStatus,
  CommerceNotificationOutboxStatus,
  CommerceOrderStatus,
  CommerceProductType,
  CourseAccessSourceType,
} from '../../../generated/prisma/client';
import { CommerceFulfillmentService } from './commerce-fulfillment.service';

describe('CommerceFulfillmentService', () => {
  const order = {
    id: 'order-id', buyerId: 'learner-id', status: CommerceOrderStatus.confirmed,
    fulfillmentStatus: CommerceFulfillmentStatus.not_started,
    lines: [{
      id: 'line-id', productType: CommerceProductType.course,
      productReferenceId: 'course-id',
    }],
    membershipCheckoutIntent: null,
  };
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    commerceOrder: { findUnique: jest.fn(), update: jest.fn() },
    commerceLifecycleEvent: { create: jest.fn() },
    commerceFulfillmentEffect: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    commerceNotificationOutbox: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    membershipSubscription: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
    serviceEntitlementGrant: {
      createMany: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({ id: 'service-grant-id' }),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'learner-id' }) },
  };
  const courseAccess = { ensureGrant: jest.fn().mockResolvedValue({ id: 'grant-id' }) };
  const audit = { record: jest.fn() };
  const prisma: any = {
    commerceNotificationOutbox: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const notifications = { createForUser: jest.fn() };
  const service = new CommerceFulfillmentService(prisma, courseAccess as any, audit as any, notifications as any);

  beforeEach(() => {
    jest.clearAllMocks();
    tx.commerceOrder.findUnique.mockResolvedValue(order);
  });

  it('creates a perpetual purchase grant and records fulfillment exactly once', async () => {
    await service.fulfillConfirmedOrder(tx, order.id, CommerceActorKind.provider, null);

    expect(courseAccess.ensureGrant).toHaveBeenCalledWith(expect.objectContaining({
      userId: order.buyerId,
      courseId: 'course-id',
      sourceType: CourseAccessSourceType.course_purchase,
      sourceId: 'line-id',
      endsAt: null,
    }), tx);
    expect(tx.commerceFulfillmentEffect.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(tx.commerceOrder.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ fulfillmentStatus: CommerceFulfillmentStatus.fulfilled }),
    }));
    expect(tx.commerceNotificationOutbox.createMany).toHaveBeenCalledTimes(1);
  });

  it('returns without duplicating grants, terms, effects, history, audit, or outbox', async () => {
    tx.commerceOrder.findUnique.mockResolvedValue({ ...order, fulfillmentStatus: CommerceFulfillmentStatus.fulfilled });

    await service.fulfillConfirmedOrder(tx, order.id, CommerceActorKind.provider, null);

    expect(courseAccess.ensureGrant).not.toHaveBeenCalled();
    expect(tx.commerceFulfillmentEffect.createMany).not.toHaveBeenCalled();
    expect(tx.commerceLifecycleEvent.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('uses the immutable membership window and version for term, course, and service access', async () => {
    const startsAt = new Date('2026-09-01T00:00:00.000Z');
    const endsAt = new Date('2026-12-01T00:00:00.000Z');
    tx.commerceOrder.findUnique.mockResolvedValue({
      ...order,
      lines: [{
        id: 'membership-line', productType: CommerceProductType.membership,
        productReferenceId: 'version-id',
      }],
      membershipCheckoutIntent: {
        versionId: 'version-id', startsAt, endsAt,
        version: {
          includedCourses: [{ courseId: 'included-course' }],
          serviceEntitlements: [{
            definitionId: 'definition-id', valueType: 'metered',
            resetPeriod: 'membership_term', booleanValue: null, quota: 25n,
          }],
        },
        removedCourses: [],
      },
    });
    tx.membershipSubscription.findUnique.mockResolvedValue(null);
    tx.membershipSubscription.findFirst.mockResolvedValue(null);
    tx.membershipSubscription.create.mockResolvedValue({ id: 'subscription-id' });

    await service.fulfillConfirmedOrder(tx, order.id, CommerceActorKind.provider, null);

    expect(tx.membershipSubscription.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sourceOrderLineId: 'membership-line',
        versionId: 'version-id',
        startsAt,
        expiresAt: endsAt,
      }),
    });
    expect(courseAccess.ensureGrant).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: CourseAccessSourceType.membership,
      sourceId: 'membership-line',
      startsAt,
      endsAt,
    }), tx);
    expect(tx.serviceEntitlementGrant.createMany).toHaveBeenCalledWith(expect.objectContaining({
      data: [expect.objectContaining({ sourceId: 'membership-line', startsAt, endsAt })],
      skipDuplicates: true,
    }));
  });

  it('does not enqueue or complete fulfillment when an access effect fails', async () => {
    courseAccess.ensureGrant.mockRejectedValueOnce(new Error('simulated grant failure'));

    await expect(
      service.fulfillConfirmedOrder(tx, order.id, CommerceActorKind.provider, null),
    ).rejects.toThrow('simulated grant failure');

    expect(tx.commerceNotificationOutbox.createMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(tx.commerceOrder.update).toHaveBeenCalledTimes(1);
  });

  it('retains a pending outbox event after notification failure and retries idempotently', async () => {
    prisma.commerceNotificationOutbox.findMany.mockResolvedValue([{
      id: 'outbox-id', userId: 'learner-id',
      eventKey: 'commerce-order-fulfilled:order-id',
      eventType: 'COMMERCE_ORDER_FULFILLED',
    }]);
    notifications.createForUser.mockRejectedValueOnce(new Error('temporary failure'));

    await service.dispatchPending();

    expect(prisma.commerceNotificationOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'outbox-id' }),
      data: expect.not.objectContaining({ status: CommerceNotificationOutboxStatus.dispatched }),
    }));
  });
});
