import { RevenueFinanceService } from './revenue-finance.service';

function harness() {
  const version = { id: 'version-1', planId: 'plan-1', versionNumber: 1, displayName: 'Gold', status: 'published', publishedById: 'admin-1', revenuePolicyId: 'policy-1', baseMonthlyPriceAmountMinor: 300000n, currency: 'VND', salesStartAt: null, salesEndAt: null,
    plan: { id: 'plan-1', code: 'GOLD', status: 'active' }, durationOptions: [{ id: 'duration-1', months: 1, priceAmountMinor: 300000n, discountPercent: null }],
    includedCourses: [{ courseId: 'course-1', revenueWeight: 1, course: { id: 'course-1', title: 'Coding', slug: 'coding', instructorId: 'seller-1', status: 'published', moderationStatus: 'clear', deletedAt: null } }] };
  // An already-created historical membership order line; capture must retain its immutable price.
  const line = { id: 'line-1', orderId: 'order-1', productType: 'membership', productReferenceId: version.id,
    sellerId: 'admin-1', finalAmountMinor: 300000n };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    revenueRetailPolicy: { findMany: jest.fn().mockResolvedValue([]) },
    revenuePlanPolicy: { findUnique: jest.fn().mockResolvedValue({ id: 'policy-1', planId: 'plan-1', platformFeeBps: 4000 }) },
    revenueParticipation: { findMany: jest.fn().mockResolvedValue([{ courseId: 'course-1', sellerId: 'seller-1', leftAt: null }]) },
    revenueOrderSnapshot: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
    membershipPlanVersion: { findUnique: jest.fn().mockResolvedValue(version) },
    commerceOrderLine: { findMany: jest.fn().mockResolvedValue([line]) },
  };
  return { finance: new RevenueFinanceService({} as never), tx, version, line };
}

describe('historical membership order revenue capture', () => {
  it('captures the original line price and real course owner rather than the publishing admin', async () => {
    const { finance, tx, version } = harness();
    version.baseMonthlyPriceAmountMinor = 900000n;
    await finance.captureOrder(tx as never, 'order-1');
    expect(tx.commerceOrderLine.findMany).toHaveBeenCalledWith({ where: { orderId: 'order-1' } });
    expect(tx.revenueOrderSnapshot.create).toHaveBeenCalledWith({ data: {
      id: 'line-1', orderId: 'order-1', productType: 'membership', policyId: 'policy-1', platformFeeBps: 4000,
      basisAmountMinor: 300000n, platformAmountMinor: 120000n, sellerAmountMinor: 180000n,
      participants: [{ courseId: 'course-1', sellerId: 'seller-1', weight: 1, amountMinor: '180000' }],
    } });
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.commerceOrderLine.findMany.mock.invocationCallOrder[0]);
  });

  it('fails closed instead of snapshotting a nonconsenting replacement course owner', async () => {
    const { finance, tx, version } = harness();
    version.includedCourses[0].course.instructorId = 'new-owner';
    await expect(finance.captureOrder(tx as never, 'order-1')).rejects.toThrow('MEMBERSHIP_CATALOG_REFRESH_REQUIRED');
    expect(tx.revenueOrderSnapshot.create).not.toHaveBeenCalled();
  });

  it('preserves an existing historical snapshot without reading changed policies or ownership', async () => {
    const { finance, tx } = harness();
    tx.revenueOrderSnapshot.findUnique.mockResolvedValue({ id: 'line-1' } as never);
    await finance.captureOrder(tx as never, 'order-1');
    expect(tx.membershipPlanVersion.findUnique).not.toHaveBeenCalled();
    expect(tx.revenueOrderSnapshot.create).not.toHaveBeenCalled();
  });
});
