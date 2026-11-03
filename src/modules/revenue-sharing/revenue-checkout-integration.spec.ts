import { ConflictException } from '@nestjs/common';
import { MembershipCheckoutService } from '../memberships/membership-checkout.service';
import { RevenueFinanceService } from './revenue-finance.service';
import { RevenueMembershipService } from './revenue-membership.service';

function harness() {
  const trace: string[] = [];
  const version = { id: 'version-1', planId: 'plan-1', versionNumber: 1, displayName: 'Gold', status: 'published', publishedById: 'admin-1', revenuePolicyId: 'policy-1', baseMonthlyPriceAmountMinor: 300000n, currency: 'VND', salesStartAt: null, salesEndAt: null,
    plan: { id: 'plan-1', code: 'GOLD', status: 'active' }, durationOptions: [{ id: 'duration-1', months: 1, priceAmountMinor: 300000n, discountPercent: null }],
    includedCourses: [{ courseId: 'course-1', revenueWeight: 1, course: { id: 'course-1', title: 'Coding', slug: 'coding', instructorId: 'seller-1', status: 'published', moderationStatus: 'clear', deletedAt: null } }] };
  const lines: unknown[] = [];
  let order: unknown;
  let intent: unknown;
  const tx = {
    $queryRaw: jest.fn().mockImplementation((query: { strings?: string[] }) => { trace.push(query.strings?.join('') ?? 'lock'); return []; }),
    revenuePlanPolicy: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue({ id: 'policy-1', planId: 'plan-1', platformFeeBps: 4000 }) },
    revenueParticipation: { findMany: jest.fn().mockResolvedValue([{ courseId: 'course-1', sellerId: 'seller-1', leftAt: null }]) },
    revenueRetailPolicy: { findMany: jest.fn().mockResolvedValue([]) },
    revenueOrderSnapshot: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockImplementation(({ data }) => { trace.push('snapshot'); return data; }) },
    commerceIdempotencyRecord: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'idem-1' }), update: jest.fn() },
    membershipPlanVersion: { findFirst: jest.fn().mockImplementation(() => { trace.push('read-version'); return version; }), findUnique: jest.fn().mockResolvedValue(version) },
    membershipSubscription: { findFirst: jest.fn().mockResolvedValue(null) },
    commerceOrder: { create: jest.fn().mockImplementation(({ data }) => { order = { ...data, status: 'pending_payment' }; return order; }) },
    commerceOrderLine: { create: jest.fn().mockImplementation(({ data }) => { const line = { ...data, id: 'line-1' }; lines.push(line); return line; }), findMany: jest.fn().mockImplementation(() => lines) },
    membershipCheckoutIntent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockImplementation(({ data }) => { intent = { ...data, id: 'intent-1' }; return intent; }), findUnique: jest.fn().mockImplementation(() => ({ ...(intent as object), order, version, durationOption: version.durationOptions[0], removedCourses: [] })) },
  };
  const prisma = { $transaction: jest.fn((operation: (client: typeof tx) => unknown) => operation(tx)), membershipPlanVersion: { findMany: jest.fn().mockResolvedValue([]) }, membershipSubscription: { findFirst: jest.fn().mockResolvedValue(null) }, revenuePlanPolicy: { findUnique: jest.fn().mockResolvedValue({ platformFeeBps: 4000 }) } };
  const finance = new RevenueFinanceService(prisma as never);
  const membership = new RevenueMembershipService(prisma as never);
  const service = new MembershipCheckoutService(prisma as never, { record: jest.fn() } as never, { ensureActiveMembershipProduct: jest.fn().mockResolvedValue({ id: 'product-1', sellerId: 'admin-1' }) } as never, { resolveRemovedCourses: jest.fn().mockResolvedValue([]), persistSnapshots: jest.fn() } as never, finance, membership);
  return { service, tx, trace, membership, version, prisma };
}

describe('membership checkout revenue integration', () => {
  it('synchronizes policies before version locks and captures the real course owner, not publishing admin', async () => {
    const { service, tx, trace } = harness();
    const result = await service.createCheckout('learner-1', 'checkout-key-1', { versionId: 'version-1', durationOptionId: 'duration-1', changedBenefitsConfirmed: true });
    expect(result.order.payable.amountMinor).toBe('300000');
    expect(trace[0]).toContain('pg_advisory_xact_lock');
    expect(trace.findIndex(item => item.includes('pg_advisory_xact_lock'))).toBeLessThan(trace.indexOf('read-version'));
    const snapshot = tx.revenueOrderSnapshot.create.mock.calls[0][0].data;
    expect(snapshot.platformAmountMinor).toBe(120000n);
    expect(snapshot.sellerAmountMinor).toBe(180000n);
    expect(snapshot.participants).toEqual([{ courseId: 'course-1', sellerId: 'seller-1', weight: 1, amountMinor: '180000' }]);
    expect(trace.indexOf('snapshot')).toBeGreaterThan(trace.indexOf('read-version'));
  });

  it('hides an empty latest managed catalogue without falling back to its populated previous version', async () => {
    const { service, prisma, version } = harness();
    prisma.membershipPlanVersion.findMany.mockResolvedValue([{ ...version, versionNumber: 2, includedCourses: [], serviceEntitlements: [] }, { ...version, id: 'older-version', revenuePolicyId: null, serviceEntitlements: [] }]);
    await expect(service.catalog('learner-1')).resolves.toEqual({ items: [] });
    expect(prisma.revenuePlanPolicy.findUnique).toHaveBeenCalledWith({ where: { id: 'policy-1' }, select: { platformFeeBps: true } });
  });

  it('allows an empty services-only catalogue when the platform receives the full membership price', async () => {
    const { service, prisma, version } = harness();
    prisma.membershipPlanVersion.findMany.mockResolvedValue([{ ...version, includedCourses: [], serviceEntitlements: [] }]);
    prisma.revenuePlanPolicy.findUnique.mockResolvedValue({ platformFeeBps: 10000 });
    const result = await service.catalog('learner-1');
    expect(result.items).toHaveLength(1);
  });
  it('fails closed rather than snapshotting a nonconsenting new course owner', async () => {
    const { service, tx, version } = harness();
    version.includedCourses[0].course.instructorId = 'new-owner';
    await expect(service.createCheckout('learner-1', 'checkout-key-owner', { versionId: 'version-1', durationOptionId: 'duration-1', changedBenefitsConfirmed: true })).rejects.toThrow('MEMBERSHIP_CATALOG_REFRESH_REQUIRED');
    expect(tx.revenueOrderSnapshot.create).not.toHaveBeenCalled();
  });
  it('does not sell a stale version if policy synchronization publishes a newer version', async () => {
    const { service, membership, tx, version } = harness();
    jest.spyOn(membership, 'synchronizeCheckout').mockImplementation(async () => {
      tx.membershipPlanVersion.findFirst.mockResolvedValueOnce(version).mockResolvedValueOnce({ ...version, id: 'version-2', versionNumber: 2 });
    });
    await expect(service.createCheckout('learner-1', 'checkout-key-2', { versionId: 'version-1', durationOptionId: 'duration-1', changedBenefitsConfirmed: true })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.revenueOrderSnapshot.create).not.toHaveBeenCalled();
    expect(tx.commerceOrder.create).not.toHaveBeenCalled();
  });
});
