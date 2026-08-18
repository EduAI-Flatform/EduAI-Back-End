import { BadRequestException } from '@nestjs/common';
import { VoucherKind, VoucherStatus } from '../../../generated/prisma/client';
import { AuditAction } from '../../common/audit/audit.constants';
import { VouchersService } from './vouchers.service';

const voucher = {
  id: 'voucher-id',
  code: 'EDUAI20',
  status: VoucherStatus.active,
  kind: VoucherKind.percentage,
  value: 20,
  currency: 'VND',
  startsAt: new Date('2026-08-01T00:00:00.000Z'),
  endsAt: new Date('2026-09-01T00:00:00.000Z'),
  minimumCoursePriceMinor: 500000,
  maximumDiscountMinor: 200000,
  usageLimit: 2,
  redeemedCount: 0,
  perUserLimit: 1,
  createdById: 'admin-id',
  courseScopes: [],
  categoryScopes: [{ categorySlug: 'ai-foundations' }],
  eligibleUsers: [],
};

const course = {
  id: 'course-id',
  categorySlug: 'ai-foundations',
  priceAmountMinor: 1499000,
  priceCurrency: 'VND',
};

function createHarness() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: voucher.id }]),
    voucher: {
      findUnique: jest
        .fn()
        .mockResolvedValueOnce({ id: voucher.id })
        .mockResolvedValueOnce(voucher),
      update: jest.fn().mockResolvedValue(voucher),
    },
    course: { findFirst: jest.fn().mockResolvedValue(course) },
    voucherRedemption: {
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({
        id: 'redemption-id',
        voucherId: voucher.id,
        userId: 'student-id',
        courseId: course.id,
        redemptionKey: 'request-1',
        originalAmountMinor: 1499000,
        discountAmountMinor: 200000,
        finalAmountMinor: 1299000,
        currency: 'VND',
        createdAt: new Date('2026-08-18T00:00:00.000Z'),
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const auditService = { record: jest.fn().mockResolvedValue(undefined) };
  return { service: new VouchersService(prisma as never, auditService as never), tx, prisma, auditService };
}

describe('VouchersService.redeem', () => {
  it('uses the stored course price and atomically records one redemption', async () => {
    const { service, tx, auditService } = createHarness();

    await expect(
      service.redeem('student-id', 'course-id', {
        code: ' eduai20 ',
        redemptionKey: 'request-1',
      }),
    ).resolves.toMatchObject({
      id: 'redemption-id',
      discountAmountMinor: 200000,
      finalAmountMinor: 1299000,
      idempotent: false,
    });

    expect(tx.$queryRaw).toHaveBeenCalled();
    expect(tx.voucherRedemption.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          originalAmountMinor: 1499000,
          discountAmountMinor: 200000,
          finalAmountMinor: 1299000,
        }),
      }),
    );
    expect(tx.voucher.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { redeemedCount: { increment: 1 } } }),
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.VoucherRedeemed }),
      tx,
    );
  });

  it('returns the original redemption for the same idempotency key without mutating counters', async () => {
    const { service, tx } = createHarness();
    tx.voucherRedemption.findUnique.mockResolvedValueOnce({
      id: 'redemption-id',
      voucherId: voucher.id,
      userId: 'student-id',
      courseId: course.id,
      redemptionKey: 'request-1',
      originalAmountMinor: 1499000,
      discountAmountMinor: 200000,
      finalAmountMinor: 1299000,
      currency: 'VND',
      createdAt: new Date('2026-08-18T00:00:00.000Z'),
    });

    await expect(
      service.redeem('student-id', 'course-id', {
        code: 'EDUAI20',
        redemptionKey: 'request-1',
      }),
    ).resolves.toMatchObject({ idempotent: true, finalAmountMinor: 1299000 });

    expect(tx.voucherRedemption.create).not.toHaveBeenCalled();
    expect(tx.voucher.update).not.toHaveBeenCalled();
  });

  it('rejects a quota-exhausted voucher before writing a redemption', async () => {
    const { service, tx } = createHarness();
    tx.voucher.findUnique.mockReset();
    tx.voucher.findUnique
      .mockResolvedValueOnce({ id: voucher.id })
      .mockResolvedValueOnce({ ...voucher, redeemedCount: 2 });

    await expect(
      service.redeem('student-id', 'course-id', {
        code: 'EDUAI20',
        redemptionKey: 'request-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.voucherRedemption.create).not.toHaveBeenCalled();
    expect(tx.voucher.update).not.toHaveBeenCalled();
  });
});
