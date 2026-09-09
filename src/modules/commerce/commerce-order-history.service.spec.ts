import { NotFoundException } from '@nestjs/common';
import { CommerceOrderHistoryService } from './commerce-order-history.service';

const createdAt = new Date('2026-09-09T04:00:00.000Z');

function order() {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    orderNumber: 'EDU-M-ORDER-1',
    buyerId: 'student-id',
    status: 'pending_payment',
    fulfillmentStatus: 'not_started',
    subtotalAmountMinor: 20000n,
    discountAmountMinor: 0n,
    payableAmountMinor: 20000n,
    currency: 'VND',
    pricingPolicyVersion: 'membership-v1',
    createdAt,
    updatedAt: createdAt,
    confirmedAt: null,
    cancelledAt: null,
    expiredAt: null,
    archivedAt: null,
    lines: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        orderId: '11111111-1111-4111-8111-111111111111',
        productId: '33333333-3333-4333-8333-333333333333',
        productType: 'membership',
        productReferenceId: '44444444-4444-4444-8444-444444444444',
        sellerId: '55555555-5555-4555-8555-555555555555',
        displayTitle: 'EduAI Membership',
        quantity: 1,
        unitListPriceAmountMinor: 20000n,
        subtotalAmountMinor: 20000n,
        discountAmountMinor: 0n,
        finalAmountMinor: 20000n,
        currency: 'VND',
        createdAt,
      },
    ],
    paymentAttempts: [
      {
        id: '66666666-6666-4666-8666-666666666666',
        orderId: '11111111-1111-4111-8111-111111111111',
        provider: 'payos',
        localRequestIdentity: '77777777-7777-4777-8777-777777777777',
        providerPaymentIdentity: 'payos-payment-id',
        providerReceivingAccountHash: null,
        providerOrderCode: 1234n,
        providerExpiresAt: new Date('2026-09-09T04:15:00.000Z'),
        providerRequestStartedAt: createdAt,
        status: 'pending',
        statusOperationId: null,
        amountMinor: 20000n,
        currency: 'VND',
        providerStatusCheckedAt: null,
        providerCancellationRequestedAt: null,
        createdAt,
        updatedAt: createdAt,
        paidAt: null,
        closedAt: null,
      },
    ],
  };
}

function harness() {
  const prisma = {
    commerceOrder: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([order()]),
      findFirst: jest.fn().mockResolvedValue(order()),
    },
  };
  return {
    service: new CommerceOrderHistoryService(prisma as never),
    prisma,
  };
}

describe('CommerceOrderHistoryService', () => {
  it('lists only learner-owned non-archived orders and projects the latest payment', async () => {
    const { service, prisma } = harness();

    await expect(service.list('student-id', { page: 1, pageSize: 20 })).resolves.toEqual({
      items: [expect.objectContaining({
        id: '11111111-1111-4111-8111-111111111111',
        orderNumber: 'EDU-M-ORDER-1',
        status: 'PENDING_PAYMENT',
        fulfillmentStatus: 'NOT_STARTED',
        payable: { amountMinor: '20000', currency: 'VND' },
        paymentRequired: true,
        lines: [expect.objectContaining({
          productType: 'MEMBERSHIP',
          title: 'EduAI Membership',
          finalPrice: { amountMinor: '20000', currency: 'VND' },
        })],
        payment: expect.objectContaining({
          id: '66666666-6666-4666-8666-666666666666',
          status: 'PENDING',
          amount: { amountMinor: '20000', currency: 'VND' },
        }),
      })],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
    });

    expect(prisma.commerceOrder.count).toHaveBeenCalledWith({
      where: { buyerId: 'student-id', archivedAt: null },
    });
    expect(prisma.commerceOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { buyerId: 'student-id', archivedAt: null },
        skip: 0,
        take: 20,
      }),
    );
  });

  it('binds order detail lookup to learner ownership', async () => {
    const { service, prisma } = harness();

    await service.get('student-id', '11111111-1111-4111-8111-111111111111');

    expect(prisma.commerceOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: '11111111-1111-4111-8111-111111111111',
          buyerId: 'student-id',
          archivedAt: null,
        },
      }),
    );
  });

  it('does not reveal an order outside learner ownership', async () => {
    const { service, prisma } = harness();
    prisma.commerceOrder.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.get('other-student', '11111111-1111-4111-8111-111111111111'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
