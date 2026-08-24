import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma/client';
import { CommerceOrderService } from './commerce-order.service';

const course = {
  id: '11111111-1111-4111-8111-111111111111',
  instructorId: 'instructor-id',
  title: 'Authoritative Pricing',
  slug: 'authoritative-pricing',
  thumbnailUrl: null,
  categorySlug: 'commerce',
  priceAmountMinor: 300000,
  priceCurrency: 'VND',
  status: 'published',
  visibility: 'public',
  moderationStatus: 'clear',
  deletedAt: null,
};

const product = {
  id: 'product-id',
  type: 'course',
  courseId: course.id,
  sellerId: course.instructorId,
  status: 'active',
  course,
};

const cart = {
  id: 'cart-id',
  buyerId: 'student-id',
  status: 'active',
  currency: 'VND',
  lines: [{ id: 'cart-line-id', productId: product.id, product }],
};

const orderRecord = {
  id: 'order-id',
  orderNumber: 'EDU-ORDER-1',
  status: 'pending_payment',
  fulfillmentStatus: 'not_started',
  subtotalAmountMinor: 300000n,
  discountAmountMinor: 50000n,
  payableAmountMinor: 250000n,
  currency: 'VND',
  pricingPolicyVersion: 'course-v1-single-promotion',
  lines: [
    {
      id: 'order-line-id',
      productReferenceId: course.id,
      displayTitle: course.title,
      unitListPriceAmountMinor: 300000n,
      finalAmountMinor: 250000n,
      benefits: [
        {
          sourceId: 'voucher-id',
          allocatedDiscountAmountMinor: 50000n,
          createdAt: new Date(),
        },
      ],
      createdAt: new Date(),
    },
  ],
};

function createHarness(
  discountAmountMinor = 50000,
  idempotencySecret: string | undefined = 's'.repeat(32),
) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: cart.id }]),
    commerceIdempotencyRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'idempotency-id' }),
      update: jest.fn().mockResolvedValue({ id: 'idempotency-id' }),
    },
    commerceCart: {
      findFirst: jest.fn().mockResolvedValue(cart),
      update: jest.fn().mockResolvedValue({ ...cart, status: 'converted' }),
    },
    enrollment: { findMany: jest.fn().mockResolvedValue([]) },
    commerceOrder: {
      create: jest.fn().mockResolvedValue({ id: 'order-id', orderNumber: 'EDU-ORDER-1' }),
      findUnique: jest.fn().mockResolvedValue(orderRecord),
      update: jest.fn().mockResolvedValue({ ...orderRecord, status: 'confirmed' }),
    },
    commerceOrderLine: { create: jest.fn().mockResolvedValue({ id: 'order-line-id' }) },
    commercePromotionReservation: {
      create: jest.fn().mockResolvedValue({ id: 'reservation-id' }),
      update: jest.fn().mockResolvedValue({ id: 'reservation-id' }),
    },
    commerceOrderLineBenefit: { create: jest.fn().mockResolvedValue({ id: 'benefit-id' }) },
    commerceSettlement: { create: jest.fn().mockResolvedValue({ id: 'settlement-id' }) },
    commerceLifecycleEvent: { create: jest.fn().mockResolvedValue({ id: 'event-id' }) },
    voucherRedemption: { create: jest.fn().mockResolvedValue({ id: 'redemption-id' }) },
    voucher: { update: jest.fn().mockResolvedValue({ id: 'voucher-id' }) },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const config = { commerce: { idempotencySecret } };
  const vouchers = {
    evaluateForCommerce: jest.fn().mockResolvedValue({
      voucherId: 'voucher-id',
      discountAmountMinor,
      sourceVersion: '2026-08-24T00:00:00.000Z',
    }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const courseAccess = { decideWithClient: jest.fn().mockResolvedValue({ allowed: false }) };
  return {
    service: new CommerceOrderService(
      prisma as never,
      config as never,
      vouchers as never,
      audit as never,
      courseAccess as never,
    ),
    tx,
    prisma,
    vouchers,
    audit,
    courseAccess,
  };
}

describe('CommerceOrderService', () => {
  it('fails closed when the idempotency secret is unavailable', () => {
    const { service } = createHarness(50000, '');

    expect(() =>
      service.createOrder('buyer-id', 'checkout-key', {
        voucherApplications: [],
      }),
    ).toThrow(ServiceUnavailableException);

    try {
      service.createOrder('buyer-id', 'checkout-key', {
        voucherApplications: [],
      });
    } catch (error) {
      expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
        error: 'COMMERCE_CONFIGURATION_INVALID',
      });
    }
  });

  const input = { voucherApplications: [{ courseId: course.id, code: ' save50 ' }] };

  it('requires a bounded idempotency key', async () => {
    const { service, prisma } = createHarness();

    expect(() => service.createOrder('student-id', 'short', {})).toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('re-prices from the live course and creates immutable snapshots and a reservation', async () => {
    const { service, tx, vouchers, audit } = createHarness();

    await expect(service.createOrder('student-id', 'request-key-1', input)).resolves.toMatchObject({
      subtotal: { amountMinor: '300000', currency: 'VND' },
      discount: { amountMinor: '50000', currency: 'VND' },
      payable: { amountMinor: '250000', currency: 'VND' },
    });

    expect(vouchers.evaluateForCommerce).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ priceAmountMinor: 300000, currency: 'VND', code: 'SAVE50' }),
    );
    expect(tx.commerceOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subtotalAmountMinor: 300000n,
          discountAmountMinor: 50000n,
          payableAmountMinor: 250000n,
        }),
      }),
    );
    expect(tx.commercePromotionReservation.create).toHaveBeenCalled();
    expect(tx.commerceCart.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'converted' }) }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({ idempotencyKey: expect.anything() }),
      }),
      tx,
    );
  });

  it('returns the original order for the same canonical request', async () => {
    const { service, tx } = createHarness();
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ voucherApplications: [{ courseId: course.id, code: 'SAVE50' }] }))
      .digest('hex');
    tx.commerceIdempotencyRecord.findUnique.mockResolvedValueOnce({
      status: 'completed',
      requestHash,
      resourceId: 'order-id',
    });

    await expect(service.createOrder('student-id', 'request-key-1', input)).resolves.toMatchObject({
      id: 'order-id',
    });
    expect(tx.commerceOrder.create).not.toHaveBeenCalled();
  });

  it('rejects idempotency-key reuse with different input', async () => {
    const { service, tx } = createHarness();
    tx.commerceIdempotencyRecord.findUnique.mockResolvedValueOnce({
      status: 'completed',
      requestHash: 'different',
      resourceId: 'order-id',
    });

    await expect(service.createOrder('student-id', 'request-key-1', input)).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'IDEMPOTENCY_KEY_REUSED' }),
    });
  });

  it('rejects ownership acquired after the item entered the cart', async () => {
    const { service, tx, courseAccess } = createHarness();
    courseAccess.decideWithClient.mockResolvedValueOnce({ allowed: true });

    await expect(service.createOrder('student-id', 'request-key-1', {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.commerceOrder.create).not.toHaveBeenCalled();
  });

  it('rejects a stale course before persisting an order', async () => {
    const { service, tx } = createHarness();
    tx.commerceCart.findFirst.mockResolvedValueOnce({
      ...cart,
      lines: [{ ...cart.lines[0], product: { ...product, course: { ...course, status: 'archived' } } }],
    });

    await expect(service.createOrder('student-id', 'request-key-1', {})).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'STALE_CART' }),
    });
    expect(tx.commerceOrder.create).not.toHaveBeenCalled();
  });

  it('records an internal settlement instead of creating a provider attempt for zero payable', async () => {
    const { service, tx } = createHarness(300000);

    await service.createOrder('student-id', 'request-key-1', input);

    expect(tx.commerceSettlement.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amountMinor: 0n }) }),
    );
    expect(tx.commerceSettlement.create.mock.calls[0][0].data).not.toHaveProperty('provider');
    expect(tx.commerceOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'confirmed' }) }),
    );
    expect(tx.voucherRedemption.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          originalAmountMinor: 300000,
          discountAmountMinor: 300000,
          finalAmountMinor: 0,
        }),
      }),
    );
    expect(tx.voucher.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { redeemedCount: { increment: 1 } } }),
    );
  });

  it('retries a serialization conflict without changing request identity', async () => {
    const { service, prisma } = createHarness();
    const serialization = new Prisma.PrismaClientKnownRequestError('retry', {
      code: 'P2034',
      clientVersion: 'test',
    });
    const implementation = prisma.$transaction.getMockImplementation();
    prisma.$transaction.mockRejectedValueOnce(serialization).mockImplementation(implementation!);

    await expect(service.createOrder('student-id', 'request-key-1', {})).resolves.toMatchObject({
      id: 'order-id',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('converges concurrent duplicate checkout requests on one order and one audit', async () => {
    const { service, prisma, tx, audit } = createHarness();
    let claimed = false;
    let completed = false;
    let releaseCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { releaseCompletion = resolve; });

    tx.commerceIdempotencyRecord.findUnique.mockImplementation(async () =>
      claimed
        ? {
            status: completed ? 'completed' : 'in_progress',
            requestHash: createHash('sha256')
              .update(JSON.stringify({ voucherApplications: [] }))
              .digest('hex'),
            resourceId: completed ? 'order-id' : null,
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
      service.createOrder('student-id', 'same-request-key', {}),
      service.createOrder('student-id', 'same-request-key', {}),
    ]);

    expect(first.id).toBe('order-id');
    expect(replay.id).toBe('order-id');
    expect(tx.commerceOrder.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });
});
