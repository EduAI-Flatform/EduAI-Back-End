import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import {
  CommerceIdempotencyStatus,
  CommerceOrderStatus,
  MembershipCheckoutAction,
  MembershipPlanStatus,
  MembershipPlanVersionStatus,
  MembershipSubscriptionStatus,
  Prisma,
} from '../../../generated/prisma/client';
import { MembershipCheckoutService } from './membership-checkout.service';

const now = new Date('2028-02-29T10:15:00.000Z');
const learnerId = '10000000-0000-4000-8000-000000000001';
const versionId = '20000000-0000-4000-8000-000000000001';
const durationId = '30000000-0000-4000-8000-000000000001';

function version(planId = '40000000-0000-4000-8000-000000000001') {
  return {
    id: versionId,
    planId,
    versionNumber: 2,
    displayName: 'EduAI Gold',
    description: 'Quyền lợi học tập nâng cao',
    baseMonthlyPriceAmountMinor: 100_000n,
    currency: 'VND',
    salesStartAt: null,
    salesEndAt: null,
    status: MembershipPlanVersionStatus.published,
    publishedById: '50000000-0000-4000-8000-000000000001',
    plan: { id: planId, code: 'GOLD', status: MembershipPlanStatus.active },
    durationOptions: [{
      id: durationId,
      versionId,
      months: 3,
      priceAmountMinor: null,
      discountPercent: 25,
      displayOrder: 0,
    }],
    serviceEntitlements: [],
    includedCourses: [],
  };
}

function harness() {
  const checkoutResult = {
    orderId: '60000000-0000-4000-8000-000000000001',
    userId: learnerId,
    versionId,
    durationOptionId: durationId,
    action: MembershipCheckoutAction.renew,
    startsAt: now,
    endsAt: new Date('2028-05-29T10:15:00.000Z'),
    activatesImmediately: true,
    order: {
      id: '60000000-0000-4000-8000-000000000001',
      orderNumber: 'EDU-M-TEST',
      status: CommerceOrderStatus.pending_payment,
      payableAmountMinor: 225_000n,
      currency: 'VND',
    },
    version: { ...version(), plan: { id: version().planId, code: 'GOLD' } },
    durationOption: version().durationOptions[0],
    removedCourses: [],
  };
  const tx = {
    $queryRaw: jest.fn(),
    commerceIdempotencyRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'idempotency-id' }),
      update: jest.fn(),
    },
    membershipPlanVersion: { findFirst: jest.fn().mockResolvedValue(version()) },
    membershipSubscription: { findFirst: jest.fn().mockResolvedValue(null) },
    commerceOrder: {
      create: jest.fn().mockResolvedValue({
        id: checkoutResult.order.id,
        orderNumber: checkoutResult.order.orderNumber,
      }),
    },
    commerceOrderLine: { create: jest.fn() },
    membershipCheckoutIntent: {
      create: jest.fn().mockResolvedValue({ id: 'checkout-intent-id' }),
      findUnique: jest.fn().mockResolvedValue(checkoutResult),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const prisma = {
    $transaction: jest.fn((operation) => operation(tx)),
    membershipPlanVersion: { findMany: jest.fn().mockResolvedValue([]) },
    membershipSubscription: { findFirst: jest.fn().mockResolvedValue(null) },
    membershipCheckoutIntent: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const audit = { record: jest.fn() };
  const commerceProducts = {
    ensureActiveMembershipProduct: jest.fn().mockResolvedValue({
      id: 'product-id',
      sellerId: '50000000-0000-4000-8000-000000000001',
    }),
  };
  const continuity = {
    resolveRemovedCourses: jest.fn().mockResolvedValue([]),
    persistSnapshots: jest.fn().mockResolvedValue({ count: 0 }),
    listExpiringGrace: jest.fn().mockResolvedValue([]),
  };
  return {
    service: new MembershipCheckoutService(
      prisma as never,
      audit as never,
      commerceProducts as never,
      continuity as never,
    ),
    prisma,
    tx,
    audit,
    commerceProducts,
    continuity,
  };
}

const input = {
  versionId,
  durationOptionId: durationId,
  changedBenefitsConfirmed: true,
};

describe('MembershipCheckoutService', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it('returns the latest membership with derived expiry and a pending plan change', async () => {
    const { service, prisma } = harness();
    prisma.membershipSubscription.findFirst.mockResolvedValue({
      id: 'subscription-id',
      status: MembershipSubscriptionStatus.active,
      versionId,
      startsAt: new Date('2027-02-28T10:15:00.000Z'),
      expiresAt: new Date('2028-02-28T10:15:00.000Z'),
      version: { displayName: 'EduAI Gold', plan: { id: 'plan-id', code: 'GOLD' } },
    });
    prisma.membershipCheckoutIntent.findFirst.mockResolvedValue({
      action: MembershipCheckoutAction.downgrade,
      startsAt: new Date('2028-02-28T10:15:00.000Z'),
      endsAt: new Date('2028-05-28T10:15:00.000Z'),
      activatesImmediately: false,
      version: { id: 'next-version', displayName: 'EduAI Basic', plan: { id: 'basic-plan', code: 'BASIC' } },
      order: { id: 'pending-order', orderNumber: 'EDU-M-PENDING', status: CommerceOrderStatus.pending_payment },
    });

    await expect(service.current(learnerId)).resolves.toMatchObject({
      membership: { id: 'subscription-id', status: 'EXPIRED' },
      pendingChange: { action: 'DOWNGRADE', order: { status: 'PENDING_PAYMENT' } },
    });
  });

  it('lists only the latest published version per plan with learner-specific removed-course disclosure', async () => {
    const { service, prisma, continuity } = harness();
    const latest = version();
    const superseded = { ...version(), id: '20000000-0000-4000-8000-000000000002', versionNumber: 1 };
    prisma.membershipPlanVersion.findMany.mockResolvedValue([latest, superseded]);
    prisma.membershipSubscription.findFirst.mockResolvedValue({
      expiresAt: new Date('2028-03-29T10:15:00.000Z'),
      version: superseded,
    });
    continuity.resolveRemovedCourses.mockResolvedValue([{
      courseId: '70000000-0000-4000-8000-000000000001',
      title: 'Removed course',
      slug: 'removed-course',
      startedBeforeRemoval: true,
      graceDays: 7,
      graceStartsAt: new Date('2028-03-29T10:15:00.000Z'),
      graceEndsAt: new Date('2028-04-05T10:15:00.000Z'),
    }]);

    await expect(service.catalog(learnerId)).resolves.toMatchObject({
      items: [{
        id: versionId,
        removedCourses: [{ id: '70000000-0000-4000-8000-000000000001', startedBeforeRemoval: true }],
      }],
    });
    expect(continuity.resolveRemovedCourses).toHaveBeenCalledWith(
      prisma,
      learnerId,
      superseded,
      latest,
      new Date('2028-03-29T10:15:00.000Z'),
      now,
    );
  });

  it('rejects a superseded membership version before creating an order', async () => {
    const { service, tx } = harness();
    tx.membershipPlanVersion.findFirst
      .mockResolvedValueOnce(version())
      .mockResolvedValueOnce({ id: '20000000-0000-4000-8000-000000000099' });

    await expect(service.createCheckout(learnerId, 'membership-key-old-version', input))
      .rejects.toMatchObject({ response: expect.objectContaining({ error: 'MEMBERSHIP_VERSION_SUPERSEDED' }) });
    expect(tx.commerceOrder.create).not.toHaveBeenCalled();
  });

  it('treats an expired same-plan checkout as renewal from payment time', async () => {
    const { service, tx } = harness();
    tx.membershipSubscription.findFirst.mockResolvedValue({
      status: MembershipSubscriptionStatus.active,
      expiresAt: new Date('2028-02-28T10:15:00.000Z'),
      version: { planId: version().planId },
    });

    await service.createCheckout(learnerId, 'membership-key-1', input);

    expect(tx.membershipSubscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: learnerId,
          status: MembershipSubscriptionStatus.active,
          startsAt: { lte: now },
        }),
      }),
    );
    expect(tx.membershipCheckoutIntent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: MembershipCheckoutAction.renew,
        startsAt: now,
        endsAt: new Date('2028-05-29T10:15:00.000Z'),
        activatesImmediately: true,
      }),
    });
  });

  it('snapshots base price, discount, and final price on the order and line', async () => {
    const { service, tx, commerceProducts, continuity } = harness();

    await service.createCheckout(learnerId, 'membership-key-2', input);

    expect(tx.commerceOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subtotalAmountMinor: 300_000n,
        discountAmountMinor: 75_000n,
        payableAmountMinor: 225_000n,
      }),
    });
    expect(tx.commerceOrderLine.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        unitListPriceAmountMinor: 300_000n,
        subtotalAmountMinor: 300_000n,
        discountAmountMinor: 75_000n,
        finalAmountMinor: 225_000n,
      }),
    });
    expect(commerceProducts.ensureActiveMembershipProduct).toHaveBeenCalledWith(
      tx,
      versionId,
      '50000000-0000-4000-8000-000000000001',
    );
    expect(tx.membershipCheckoutIntent.create.mock.invocationCallOrder[0]).toBeLessThan(
      tx.commerceOrderLine.create.mock.invocationCallOrder[0],
    );
    expect(continuity.persistSnapshots).toHaveBeenCalledWith(
      tx,
      'checkout-intent-id',
      learnerId,
      [],
    );
  });

  it('replays a completed checkout only within the authenticated learner idempotency scope', async () => {
    const { service, tx } = harness();
    tx.commerceIdempotencyRecord.findUnique.mockResolvedValue({
      requestHash: expect.anything(),
      status: CommerceIdempotencyStatus.completed,
      resourceId: '60000000-0000-4000-8000-000000000001',
    });
    const first = service.createCheckout(learnerId, 'membership-key-3', input);
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    tx.commerceIdempotencyRecord.findUnique.mockResolvedValue({
      requestHash,
      status: CommerceIdempotencyStatus.completed,
      resourceId: '60000000-0000-4000-8000-000000000001',
    });

    await expect(first).rejects.toBeInstanceOf(ConflictException);
    await expect(service.createCheckout(learnerId, 'membership-key-3', input)).resolves.toMatchObject({
      order: { id: '60000000-0000-4000-8000-000000000001' },
    });
    expect(tx.commerceIdempotencyRecord.findUnique).toHaveBeenLastCalledWith({
      where: {
        actorId_operation_keyHashVersion_keyHash: expect.objectContaining({ actorId: learnerId }),
      },
    });
    expect(tx.commerceOrder.create).not.toHaveBeenCalled();
  });

  it('converges concurrent duplicate checkout requests on one order and one audit', async () => {
    const { service, prisma, tx, audit } = harness();
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    let claimed = false;
    let completed = false;
    let releaseCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { releaseCompletion = resolve; });

    tx.commerceIdempotencyRecord.findUnique.mockImplementation(async () =>
      claimed
        ? {
            status: completed ? CommerceIdempotencyStatus.completed : CommerceIdempotencyStatus.in_progress,
            requestHash,
            resourceId: completed ? '60000000-0000-4000-8000-000000000001' : null,
          }
        : null,
    );
    tx.commerceIdempotencyRecord.create.mockImplementation(async () => {
      if (!claimed) {
        claimed = true;
        return { id: 'idempotency-id' };
      }
      await completion;
      throw new Prisma.PrismaClientKnownRequestError('duplicate request', {
        code: 'P2002',
        clientVersion: 'test',
      });
    });
    tx.commerceIdempotencyRecord.update.mockImplementation(async () => {
      completed = true;
      releaseCompletion();
      return { id: 'idempotency-id' };
    });

    const [first, replay] = await Promise.all([
      service.createCheckout(learnerId, 'same-membership-key', input),
      service.createCheckout(learnerId, 'same-membership-key', input),
    ]);

    expect(first.order.id).toBe('60000000-0000-4000-8000-000000000001');
    expect(replay.order.id).toBe(first.order.id);
    expect(tx.commerceOrder.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('rejects a second pending membership checkout under the learner lock', async () => {
    const { service, tx } = harness();
    tx.membershipCheckoutIntent.findFirst.mockResolvedValue({ id: 'pending-intent' });

    await expect(
      service.createCheckout(learnerId, 'membership-key-pending', input),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'MEMBERSHIP_CHANGE_PENDING' }),
    });

    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.commerceOrder.create).not.toHaveBeenCalled();
  });
});
