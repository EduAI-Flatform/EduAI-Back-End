import { CommerceOrderService } from './commerce-order.service';

const firstCourse = {
  id: '11111111-1111-4111-8111-111111111111',
  instructorId: 'instructor-1',
  title: 'Khóa học A',
  slug: 'khoa-hoc-a',
  categorySlug: 'commerce',
  priceAmountMinor: 10000,
  priceCurrency: 'VND',
  status: 'published',
  visibility: 'public',
  moderationStatus: 'clear',
  deletedAt: null,
};
const secondCourse = {
  ...firstCourse,
  id: '22222222-2222-4222-8222-222222222222',
  instructorId: 'instructor-2',
  title: 'Khóa học B',
  slug: 'khoa-hoc-b',
  priceAmountMinor: 20000,
};
const firstProduct = {
  id: 'product-1',
  courseId: firstCourse.id,
  sellerId: firstCourse.instructorId,
  status: 'active',
  course: firstCourse,
};
const secondProduct = {
  id: 'product-2',
  courseId: secondCourse.id,
  sellerId: secondCourse.instructorId,
  status: 'active',
  course: secondCourse,
};
const cart = {
  id: 'cart-id',
  buyerId: 'student-id',
  status: 'active',
  currency: 'VND',
  lines: [
    { id: 'line-1', productId: firstProduct.id, quantity: 1, product: firstProduct },
    { id: 'line-2', productId: secondProduct.id, quantity: 1, product: secondProduct },
  ],
};

function createHarness() {
  const orderRecord = {
    id: 'order-id',
    orderNumber: 'EDU-ORDER-1',
    status: 'pending_payment',
    fulfillmentStatus: 'not_started',
    subtotalAmountMinor: 10000n,
    discountAmountMinor: 0n,
    payableAmountMinor: 10000n,
    currency: 'VND',
    pricingPolicyVersion: 'course-v1-single-promotion',
    lines: [{
      id: 'order-line-1',
      productReferenceId: firstCourse.id,
      displayTitle: firstCourse.title,
      unitListPriceAmountMinor: 10000n,
      finalAmountMinor: 10000n,
      benefits: [],
      createdAt: new Date(),
    }],
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: cart.id }]),
    commerceIdempotencyRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'idem-id' }),
      update: jest.fn().mockResolvedValue({ id: 'idem-id' }),
    },
    commerceCart: {
      findFirst: jest.fn().mockResolvedValue(cart),
      create: jest.fn().mockResolvedValue({ id: 'remaining-cart-id' }),
      update: jest.fn().mockResolvedValue({ ...cart, status: 'converted' }),
    },
    commerceCartLine: {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    commerceOrder: {
      create: jest.fn().mockResolvedValue({ id: 'order-id', orderNumber: 'EDU-ORDER-1' }),
      findUnique: jest.fn().mockResolvedValue(orderRecord),
      update: jest.fn(),
    },
    commerceOrderLine: { create: jest.fn().mockResolvedValue({ id: 'order-line-1' }) },
    commercePromotionReservation: { create: jest.fn(), update: jest.fn() },
    commerceOrderLineBenefit: { create: jest.fn() },
    commerceSettlement: { create: jest.fn() },
    commerceLifecycleEvent: { create: jest.fn() },
    voucherRedemption: { create: jest.fn() },
    voucher: { update: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const service = new CommerceOrderService(
    prisma as never,
    { commerce: { idempotencySecret: 's'.repeat(32) } } as never,
    { evaluateForCommerce: jest.fn() } as never,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
    { decideWithClient: jest.fn().mockResolvedValue({ allowed: false }) } as never,
  );
  return { service, tx };
}

describe('CommerceOrderService selective checkout', () => {
  it('creates an order only for selected courses and preserves unselected items in a new active cart', async () => {
    const { service, tx } = createHarness();

    await expect(service.createOrder('student-id', 'selection-key-1', {
      courseIds: [firstCourse.id],
      voucherApplications: [],
    })).resolves.toMatchObject({
      subtotal: { amountMinor: '10000', currency: 'VND' },
      payable: { amountMinor: '10000', currency: 'VND' },
    });

    expect(tx.commerceOrderLine.create).toHaveBeenCalledTimes(1);
    expect(tx.commerceOrderLine.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ productReferenceId: firstCourse.id }),
    }));
    expect(tx.commerceCart.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        buyerId: 'student-id',
        status: 'active',
        lines: {
          create: [{ productId: secondProduct.id, quantity: 1 }],
        },
      }),
    });
    expect(tx.commerceCartLine.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['line-2'] } },
    });
    expect(tx.commerceCart.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: cart.id },
      data: expect.objectContaining({ status: 'converted' }),
    }));
  });

  it('fails closed when a selected course is not in the active cart', async () => {
    const { service, tx } = createHarness();

    await expect(service.createOrder('student-id', 'selection-key-2', {
      courseIds: ['33333333-3333-4333-8333-333333333333'],
      voucherApplications: [],
    })).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'CHECKOUT_TARGET_NOT_IN_CART' }),
    });
    expect(tx.commerceOrder.create).not.toHaveBeenCalled();
  });

  it('rejects vouchers for courses that are not part of the selected checkout', async () => {
    const { service, tx } = createHarness();

    await expect(service.createOrder('student-id', 'selection-key-3', {
      courseIds: [firstCourse.id],
      voucherApplications: [{ courseId: secondCourse.id, code: 'SAVE20' }],
    })).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'VOUCHER_TARGET_NOT_SELECTED' }),
    });
    expect(tx.commerceOrder.create).not.toHaveBeenCalled();
  });
});
