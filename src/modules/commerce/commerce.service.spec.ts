import { ServiceUnavailableException } from '@nestjs/common';
import { CommerceService } from './commerce.service';

const course = {
  id: 'course-id',
  instructorId: 'instructor-id',
  title: 'Safe Commerce',
  slug: 'safe-commerce',
  thumbnailUrl: null,
  priceAmountMinor: 250000,
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
  archivedAt: null,
  course,
};

const cartRecord = {
  id: 'cart-id',
  buyerId: 'student-id',
  status: 'active',
  currency: 'VND',
  createdAt: new Date('2026-08-24T00:00:00.000Z'),
  updatedAt: new Date('2026-08-24T00:00:00.000Z'),
  lines: [{ id: 'line-id', productId: product.id, quantity: 1, product }],
};

function createHarness(enabled = true) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: course.id }]),
    commerceCart: {
      create: jest.fn().mockResolvedValue(cartRecord),
      findFirst: jest.fn().mockResolvedValue(cartRecord),
    },
    commerceCartLine: {
      delete: jest.fn().mockResolvedValue({ id: 'line-id' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue({ id: 'line-id' }),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'line-id' }),
    },
    commerceProduct: {
      create: jest.fn().mockResolvedValue({ ...product, status: 'draft' }),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(product),
    },
    course: { findFirst: jest.fn().mockResolvedValue(course) },
    enrollment: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    commerceCart: tx.commerceCart,
    enrollment: tx.enrollment,
  };
  const config = { commerce: { enabled } };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return {
    service: new CommerceService(prisma as never, config as never, audit as never),
    tx,
    audit,
  };
}

describe('CommerceService cart', () => {
  it('fails closed while the Commerce feature flag is disabled', async () => {
    const { service } = createHarness(false);

    await expect(service.getCart('student-id')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('materializes an eligible course product and adds it once', async () => {
    const { service, tx, audit } = createHarness();

    await expect(service.addCourse('student-id', course.id)).resolves.toMatchObject({
      id: cartRecord.id,
      currency: 'VND',
      items: [
        {
          course: { id: course.id, title: course.title },
          unitPrice: { amountMinor: '250000', currency: 'VND' },
          availability: 'AVAILABLE',
          warnings: [],
        },
      ],
      summary: {
        subtotalAmountMinor: '250000',
        itemCount: 1,
        canCheckout: true,
      },
    });

    expect(tx.commerceProduct.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'draft' }) }),
    );
    expect(tx.commerceProduct.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'active' }) }),
    );
    expect(tx.commerceCartLine.upsert).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.not.objectContaining({ priceAmountMinor: expect.anything() }) }),
      tx,
    );
  });

  it('rejects a course already owned through a qualifying legacy enrollment', async () => {
    const { service, tx } = createHarness();
    tx.enrollment.findFirst.mockResolvedValueOnce({ id: 'enrollment-id' });

    await expect(service.addCourse('student-id', course.id)).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'ALREADY_OWNED' }),
    });
    expect(tx.commerceCartLine.upsert).not.toHaveBeenCalled();
  });

  it('marks stale items unavailable without trusting stored or client totals', async () => {
    const { service, tx } = createHarness();
    tx.commerceCart.findFirst.mockResolvedValueOnce({
      ...cartRecord,
      lines: [
        {
          ...cartRecord.lines[0],
          product: { ...product, course: { ...course, status: 'archived' } },
        },
      ],
    });

    const result = await service.getCart('student-id');

    expect(result.items[0].availability).toBe('COURSE_UNAVAILABLE');
    expect(result.summary.canCheckout).toBe(false);
  });

  it('does not duplicate or re-audit an existing cart line', async () => {
    const { service, tx, audit } = createHarness();
    tx.commerceProduct.findUnique.mockResolvedValueOnce(product);
    tx.commerceCartLine.findUnique.mockResolvedValueOnce({ id: 'line-id' });

    await service.addCourse('student-id', course.id);

    expect(tx.commerceCartLine.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { quantity: 1 } }),
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('removes a course and records only safe local identities', async () => {
    const { service, tx, audit } = createHarness();

    await service.removeCourse('student-id', course.id);

    expect(tx.commerceCartLine.delete).toHaveBeenCalledWith({ where: { id: 'line-id' } });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ courseId: course.id, productId: product.id }),
      }),
      tx,
    );
  });

  it('clears every line from the active cart', async () => {
    const { service, tx } = createHarness();

    await service.clearCart('student-id');

    expect(tx.commerceCartLine.deleteMany).toHaveBeenCalledWith({
      where: { cartId: cartRecord.id },
    });
  });
});
