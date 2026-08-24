import { ConflictException } from '@nestjs/common';
import { CommerceAdminService } from './commerce-admin.service';

const now = new Date('2026-08-24T00:00:00.000Z');
const course = {
  id: 'course-id',
  instructorId: 'instructor-id',
  title: 'Commerce Admin',
  slug: 'commerce-admin',
  priceAmountMinor: 250000,
  priceCurrency: 'VND',
  status: 'published',
  visibility: 'public',
  moderationStatus: 'clear',
  deletedAt: null,
  updatedAt: now,
  instructor: { id: 'instructor-id', fullName: 'Instructor' },
  commerceProduct: null,
};

const order = {
  id: 'order-id',
  orderNumber: 'EDU-ORDER-1',
  status: 'pending_payment',
  fulfillmentStatus: 'not_started',
  subtotalAmountMinor: 250000n,
  discountAmountMinor: 0n,
  payableAmountMinor: 250000n,
  currency: 'VND',
  pricingPolicyVersion: 'course-v1-single-promotion',
  createdAt: now,
  confirmedAt: null,
  buyer: { id: 'buyer-id', email: 'buyer@example.test', fullName: 'Buyer' },
  paymentAttempts: [],
  _count: { lines: 1 },
};

function createHarness() {
  const product = {
    id: 'product-id',
    courseId: course.id,
    sellerId: course.instructorId,
    status: 'active',
    archivedAt: null,
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: course.id }]),
    course: { findUnique: jest.fn().mockResolvedValue(course) },
    commerceProduct: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ ...product, status: 'draft' }),
      update: jest.fn().mockResolvedValue(product),
    },
  };
  const prisma = {
    $transaction: jest.fn((value: unknown) =>
      typeof value === 'function'
        ? (value as (client: typeof tx) => unknown)(tx)
        : Promise.all(value as Promise<unknown>[]),
    ),
    commerceOrder: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([order]),
      findUnique: jest.fn().mockResolvedValue({
        ...order,
        lines: [
          {
            id: 'line-id',
            productType: 'course',
            productReferenceId: course.id,
            sellerId: course.instructorId,
            displayTitle: course.title,
            quantity: 1,
            unitListPriceAmountMinor: 250000n,
            subtotalAmountMinor: 250000n,
            discountAmountMinor: 0n,
            finalAmountMinor: 250000n,
            currency: 'VND',
            benefits: [],
          },
        ],
        paymentAttempts: [
          {
            id: 'attempt-id',
            status: 'pending',
            amountMinor: 250000n,
            currency: 'VND',
            providerStatusCheckedAt: null,
            createdAt: now,
            paidAt: null,
            closedAt: null,
            providerPaymentIdentity: 'must-not-project',
          },
        ],
        settlements: [],
      }),
    },
    commerceLifecycleEvent: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const courses = {
    listCommerceCatalog: jest.fn().mockResolvedValue({
      items: [course],
      page: 1,
      pageSize: 25,
      total: 1,
      totalPages: 1,
    }),
    updateCommercePrice: jest.fn().mockResolvedValue(course),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new CommerceAdminService(prisma as never, courses as never, audit as never),
    prisma,
    courses,
    audit,
    tx,
  };
}

describe('CommerceAdminService', () => {
  it('updates current Course authority and activates a new product without touching orders', async () => {
    const { service, courses, tx, audit } = createHarness();

    await expect(
      service.updateCatalog('admin-id', course.id, {
        priceAmountMinor: 250000,
        priceCurrency: 'VND',
        sellable: true,
        expectedCourseUpdatedAt: now.toISOString(),
      }),
    ).resolves.toMatchObject({ product: { status: 'ACTIVE' } });

    expect(courses.updateCommercePrice).toHaveBeenCalledWith(
      tx,
      'admin-id',
      course.id,
      { priceAmountMinor: 250000, priceCurrency: 'VND' },
    );
    expect(tx.commerceProduct.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'draft' }) }),
    );
    expect(tx.commerceProduct.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'active' } }),
    );
    expect(audit.record).toHaveBeenCalled();
  });

  it('rejects a lost concurrent catalog update', async () => {
    const { service, courses } = createHarness();

    await expect(
      service.updateCatalog('admin-id', course.id, {
        priceAmountMinor: 300000,
        priceCurrency: 'VND',
        sellable: true,
        expectedCourseUpdatedAt: '2026-08-23T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(courses.updateCommercePrice).not.toHaveBeenCalled();
  });

  it('rejects archived product reactivation before attempting a price update', async () => {
    const { service, courses, tx } = createHarness();
    tx.commerceProduct.findUnique.mockResolvedValue({
      id: 'product-id',
      courseId: course.id,
      sellerId: course.instructorId,
      status: 'archived',
      archivedAt: now,
    });

    await expect(
      service.updateCatalog('admin-id', course.id, {
        priceAmountMinor: 300000,
        priceCurrency: 'VND',
        sellable: true,
        expectedCourseUpdatedAt: now.toISOString(),
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'PRODUCT_ARCHIVED' }),
    });
    expect(courses.updateCommercePrice).not.toHaveBeenCalled();
  });

  it('paginates and string-serializes financial order totals', async () => {
    const { service, prisma } = createHarness();

    await expect(
      service.listOrders({ page: 1, pageSize: 25, search: 'Buyer' }),
    ).resolves.toMatchObject({
      total: 1,
      items: [
        {
          orderNumber: order.orderNumber,
          payableAmountMinor: '250000',
          paymentStatus: 'NOT_CREATED',
        },
      ],
    });
    expect(prisma.commerceOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 25 }),
    );
  });

  it('projects safe order detail without provider payment identities', async () => {
    const { service } = createHarness();

    const detail = await service.getOrder('order-id');

    expect(detail.paymentAttempts[0]).toMatchObject({
      status: 'PENDING',
      amountMinor: '250000',
    });
    expect(detail.paymentAttempts[0]).not.toHaveProperty('providerPaymentIdentity');
    expect(JSON.stringify(detail)).not.toContain('must-not-project');
  });
});
