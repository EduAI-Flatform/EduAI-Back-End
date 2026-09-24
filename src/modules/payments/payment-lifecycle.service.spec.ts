import { createHmac } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { CommerceIdempotencyStatus, CommerceOrderStatus, CommercePaymentStatus, CommerceReservationStatus } from '../../../generated/prisma/client';
import { PaymentLifecycleService } from './payment-lifecycle.service';

const secret = 's'.repeat(32);
const account = 'safe-account';
const accountHash = createHmac('sha256', secret).update(`payos-receiving-account:${account}`).digest('hex');
const attempt = {
  id: 'attempt-id', orderId: 'order-id', provider: 'payos', providerPaymentIdentity: 'provider-id',
  providerReceivingAccountHash: accountHash, providerOrderCode: 42n,
  amountMinor: 100000n, currency: 'VND', status: CommercePaymentStatus.pending,
  createdAt: new Date('2026-08-27T08:00:00Z'),
  providerExpiresAt: new Date('2026-08-27T09:00:00Z'),
};
const order = (overrides: Record<string, unknown> = {}) => ({
  id: 'order-id', buyerId: 'learner-id', status: CommerceOrderStatus.pending_payment,
  paymentAttempts: [attempt], reservations: [{ id: 'reservation-id' }], ...overrides,
});
const providerStatus = (
  status: 'CANCELLED' | 'PAID' = 'CANCELLED',
  receivingAccount = account,
) => ({
  providerPaymentIdentity: 'provider-id', receivingAccount, localOrderReference: 42,
  amountMinor: 100000n, amountPaidMinor: status === 'PAID' ? 100000n : 0n,
  amountRemainingMinor: status === 'PAID' ? 0n : 100000n, status,
  createdAt: new Date('2026-08-27T08:00:00Z'),
  transactions: status === 'PAID' ? [{
    reference: 'settlement-ref', amountMinor: 100000n, receivingAccount,
    occurredAt: new Date('2026-08-27T08:01:00Z'),
  }] : [],
});

function setup(initial = order()) {
  const terminal = order({
    status: CommerceOrderStatus.cancelled,
    paymentAttempts: [{ ...attempt, status: CommercePaymentStatus.cancelled }],
    reservations: [],
  });
  const tx: any = {
    $queryRaw: jest.fn(),
    commerceIdempotencyRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'idempotency-id' }),
      update: jest.fn().mockResolvedValue({ id: 'idempotency-id' }),
    },
    commerceOrder: {
      findFirst: jest.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(initial),
      update: jest.fn(), findUniqueOrThrow: jest.fn().mockResolvedValue(terminal),
    },
    commercePaymentAttempt: { findUniqueOrThrow: jest.fn().mockResolvedValue(attempt), update: jest.fn() },
    commercePromotionReservation: { update: jest.fn() },
    commerceLifecycleEvent: { create: jest.fn() },
  };
  const prisma: any = {
    $transaction: jest.fn((fn: any) => fn(tx)),
    commerceOrder: { findFirst: jest.fn() },
    commercePaymentAttempt: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const provider: any = { cancelPaymentRequest: jest.fn().mockResolvedValue(providerStatus()) };
  const audit: any = { record: jest.fn() };
  const reconciliation: any = {
    flagAttempt: jest.fn(),
    recoverVnPayAttemptForLifecycle: jest.fn(),
  };
  const webhook: any = { ingestVerified: jest.fn() };
  const service = new PaymentLifecycleService(
    prisma, { commerce: { idempotencySecret: secret } } as never,
    audit, provider, reconciliation, webhook,
  );
  return { service, tx, prisma, provider, audit, reconciliation, webhook };
}

describe('PaymentLifecycleService cancellation', () => {
  it('closes only after provider confirmation and releases reservations with safe audit', async () => {
    const { service, tx, provider, audit } = setup();
    await expect(service.cancel('learner-id', 'order-id', 'cancel-key-123')).resolves.toEqual({
      orderId: 'order-id', orderStatus: 'CANCELLED', paymentStatus: 'CANCELLED',
    });
    expect(provider.cancelPaymentRequest).toHaveBeenCalledWith('provider-id', 'cancelled by learner');
    expect(tx.commercePaymentAttempt.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: CommercePaymentStatus.cancelled,
        providerStatusCheckedAt: expect.any(Date),
        providerCancellationRequestedAt: expect.any(Date),
      }),
    }));
    expect(tx.commercePromotionReservation.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: CommerceReservationStatus.released }),
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.not.objectContaining({ idempotencyKey: expect.anything() }),
    }), tx);
    expect(tx.commerceIdempotencyRecord.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: CommerceIdempotencyStatus.in_progress }),
    }));
    expect(tx.commerceIdempotencyRecord.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'idempotency-id' },
      data: expect.objectContaining({ status: CommerceIdempotencyStatus.completed }),
    }));
  });

  it('closes locally without provider activity when no attempt exists', async () => {
    const { service, provider, tx } = setup(order({ paymentAttempts: [] }));
    tx.commerceOrder.findUniqueOrThrow.mockResolvedValue(order({
      status: CommerceOrderStatus.cancelled, paymentAttempts: [], reservations: [],
    }));
    await service.cancel('learner-id', 'order-id', 'cancel-key-123');
    expect(provider.cancelPaymentRequest).not.toHaveBeenCalled();
    expect(tx.commerceOrder.update).toHaveBeenCalled();
  });

  it('routes a paid cancellation race through verified settlement despite receiver variance', async () => {
    const { service, provider, prisma, webhook, tx } = setup();
    provider.cancelPaymentRequest.mockResolvedValue(providerStatus('PAID', 'different-safe-account'));
    prisma.commerceOrder.findFirst.mockResolvedValue(order({
      status: CommerceOrderStatus.confirmed,
      paymentAttempts: [{ ...attempt, status: CommercePaymentStatus.paid }],
      reservations: [],
    }));
    await expect(service.cancel('learner-id', 'order-id', 'cancel-key-123')).resolves.toEqual({
      orderId: 'order-id', orderStatus: 'CONFIRMED', paymentStatus: 'PAID',
    });
    expect(webhook.ingestVerified).toHaveBeenCalledWith(expect.objectContaining({
      providerSettlementReference: 'settlement-ref',
    }));
    expect(tx.commerceOrder.update).not.toHaveBeenCalled();
  });

  it('rejects cross-order idempotency reuse before provider activity', async () => {
    const { service, provider, tx } = setup();
    tx.commerceIdempotencyRecord.findUnique.mockResolvedValue({ requestHash: 'different' });
    await expect(service.cancel('learner-id', 'order-id', 'cancel-key-123')).rejects.toBeInstanceOf(ConflictException);
    expect(provider.cancelPaymentRequest).not.toHaveBeenCalled();
  });

  it('expires a bounded page only after provider closure and returns a stable cursor', async () => {
    const { service, prisma, provider, tx, audit } = setup();
    prisma.commercePaymentAttempt.findMany.mockResolvedValue([attempt, { ...attempt, id: 'next-id' }]);
    tx.commerceOrder.findUniqueOrThrow.mockResolvedValue(order({
      status: CommerceOrderStatus.pending_payment,
    }));
    tx.commerceOrder.findUniqueOrThrow
      .mockResolvedValueOnce(order({ status: CommerceOrderStatus.pending_payment }))
      .mockResolvedValueOnce(order({
        status: CommerceOrderStatus.expired,
        paymentAttempts: [{ ...attempt, status: CommercePaymentStatus.cancelled }],
        reservations: [],
      }));
    await expect(service.runExpiry('admin-id', { limit: 1 })).resolves.toEqual({
      checkedCount: 1, expiredCount: 1, settledCount: 0,
      reviewRequiredCount: 0, hasMore: true, nextCursor: 'attempt-id',
    });
    expect(provider.cancelPaymentRequest).toHaveBeenCalledWith('provider-id', 'payment window expired');
    expect(tx.commerceOrder.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: CommerceOrderStatus.expired }),
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ checkedCount: 1, expiredCount: 1 }),
    }));
  });

  it('settles a paid expiry race and never expires the order', async () => {
    const { service, prisma, provider, webhook, tx } = setup();
    prisma.commercePaymentAttempt.findMany.mockResolvedValue([attempt]);
    provider.cancelPaymentRequest.mockResolvedValue(providerStatus('PAID', 'different-safe-account'));
    await expect(service.runExpiry('admin-id', { limit: 20 })).resolves.toEqual(expect.objectContaining({
      checkedCount: 1, expiredCount: 0, settledCount: 1, reviewRequiredCount: 0,
    }));
    expect(webhook.ingestVerified).toHaveBeenCalled();
    expect(tx.commerceOrder.update).not.toHaveBeenCalled();
  });

  it('uses the stored VNPay provider path before expiring a due attempt', async () => {
    const vnpayAttempt = {
      ...attempt,
      provider: 'vnpay',
      providerPaymentIdentity: '42',
    };
    const { service, prisma, provider, reconciliation, tx } = setup(order({
      paymentAttempts: [vnpayAttempt],
    }));
    prisma.commercePaymentAttempt.findMany.mockResolvedValue([vnpayAttempt]);
    reconciliation.recoverVnPayAttemptForLifecycle.mockResolvedValue({ outcome: 'paid' });

    await expect(service.runExpiry(null, { limit: 20 })).resolves.toMatchObject({
      checkedCount: 1,
      expiredCount: 0,
      settledCount: 1,
      reviewRequiredCount: 0,
    });
    expect(reconciliation.recoverVnPayAttemptForLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'vnpay', providerOrderCode: 42n }),
    );
    expect(provider.cancelPaymentRequest).not.toHaveBeenCalled();
    expect(tx.commerceOrder.update).not.toHaveBeenCalled();
  });

  it('locally expires a due VNPay attempt only after a trusted pending check', async () => {
    const vnpayAttempt = {
      ...attempt,
      provider: 'vnpay',
      providerPaymentIdentity: '42',
    };
    const { service, prisma, provider, reconciliation, tx } = setup(order({
      paymentAttempts: [vnpayAttempt],
    }));
    prisma.commercePaymentAttempt.findMany.mockResolvedValue([vnpayAttempt]);
    reconciliation.recoverVnPayAttemptForLifecycle.mockResolvedValue({ outcome: 'pending' });
    tx.commerceOrder.findUniqueOrThrow
      .mockResolvedValueOnce(order({ paymentAttempts: [vnpayAttempt] }))
      .mockResolvedValueOnce(order({
        status: CommerceOrderStatus.expired,
        paymentAttempts: [{ ...vnpayAttempt, status: CommercePaymentStatus.expired }],
        reservations: [],
      }));

    await expect(service.runExpiry(null, { limit: 20 })).resolves.toMatchObject({
      expiredCount: 1,
      settledCount: 0,
      reviewRequiredCount: 0,
    });
    expect(provider.cancelPaymentRequest).not.toHaveBeenCalled();
    expect(tx.commercePaymentAttempt.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: CommercePaymentStatus.expired }),
    }));
  });

  it('does not close VNPay when canonical payment wins after QueryDR returns pending', async () => {
    const vnpayAttempt = {
      ...attempt,
      provider: 'vnpay',
      providerPaymentIdentity: '42',
    };
    const { service, prisma, provider, reconciliation, tx } = setup(order({
      paymentAttempts: [vnpayAttempt],
    }));
    prisma.commercePaymentAttempt.findMany.mockResolvedValue([vnpayAttempt]);
    reconciliation.recoverVnPayAttemptForLifecycle.mockResolvedValue({ outcome: 'pending' });
    tx.commercePaymentAttempt.findUniqueOrThrow.mockResolvedValue({
      ...vnpayAttempt,
      status: CommercePaymentStatus.paid,
    });
    tx.commerceOrder.findUniqueOrThrow.mockResolvedValue(order({
      status: CommerceOrderStatus.confirmed,
      paymentAttempts: [{ ...vnpayAttempt, status: CommercePaymentStatus.paid }],
      reservations: [],
    }));

    await expect(service.runExpiry(null, { limit: 20 })).resolves.toMatchObject({
      expiredCount: 0,
      settledCount: 0,
      reviewRequiredCount: 1,
    });
    expect(provider.cancelPaymentRequest).not.toHaveBeenCalled();
    expect(tx.commercePaymentAttempt.update).not.toHaveBeenCalled();
  });

  it.each(['provider_error', 'invalid_provider_response', 'special', 'unknown_status'] as const)(
    'does not expire a VNPay attempt after an unsafe lifecycle result: %s',
    async (outcome) => {
      const vnpayAttempt = {
        ...attempt,
        provider: 'vnpay',
        providerPaymentIdentity: '42',
      };
      const { service, prisma, provider, reconciliation, tx } = setup(order({
        paymentAttempts: [vnpayAttempt],
      }));
      prisma.commercePaymentAttempt.findMany.mockResolvedValue([vnpayAttempt]);
      reconciliation.recoverVnPayAttemptForLifecycle.mockResolvedValue({ outcome });

      await expect(service.runExpiry(null, { limit: 20 })).resolves.toMatchObject({
        expiredCount: 0,
        settledCount: 0,
        reviewRequiredCount: 1,
      });
      expect(provider.cancelPaymentRequest).not.toHaveBeenCalled();
      expect(tx.commercePaymentAttempt.update).not.toHaveBeenCalled();
    },
  );

  it('does not expire a VNPay attempt when the local deadline moved forward during the check', async () => {
    const vnpayAttempt = {
      ...attempt,
      provider: 'vnpay',
      providerPaymentIdentity: '42',
      providerExpiresAt: new Date(Date.now() + 60_000),
    };
    const { service, prisma, provider, reconciliation, tx } = setup(order({
      paymentAttempts: [vnpayAttempt],
    }));
    prisma.commercePaymentAttempt.findMany.mockResolvedValue([vnpayAttempt]);
    reconciliation.recoverVnPayAttemptForLifecycle.mockResolvedValue({ outcome: 'not_found' });

    await expect(service.runExpiry(null, { limit: 20 })).resolves.toMatchObject({
      expiredCount: 0,
      settledCount: 0,
      reviewRequiredCount: 1,
    });
    expect(provider.cancelPaymentRequest).not.toHaveBeenCalled();
    expect(tx.commercePaymentAttempt.update).not.toHaveBeenCalled();
  });
});

describe('PaymentLifecycleService VNPay cancellation', () => {
  it('uses QueryDR as a pre-cancellation check instead of an unsupported remote cancel API', async () => {
    const vnpayAttempt = {
      ...attempt,
      provider: 'vnpay',
      providerPaymentIdentity: '42',
    };
    const vnpayOrder = order({ paymentAttempts: [vnpayAttempt] });
    const { service, provider, reconciliation, tx } = setup(vnpayOrder);
    tx.commercePaymentAttempt.findUniqueOrThrow.mockResolvedValue(vnpayAttempt);
    reconciliation.recoverVnPayAttemptForLifecycle.mockResolvedValue({ outcome: 'pending' });

    await expect(service.cancel('learner-id', 'order-id', 'cancel-key-123')).resolves.toEqual({
      orderId: 'order-id', orderStatus: 'CANCELLED', paymentStatus: 'CANCELLED',
    });
    expect(reconciliation.recoverVnPayAttemptForLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'vnpay' }),
    );
    expect(provider.cancelPaymentRequest).not.toHaveBeenCalled();
    expect(tx.commercePaymentAttempt.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ providerCancellationRequestedAt: expect.anything() }),
    }));
  });

  it('lets canonical VNPay payment recovery win a cancellation race', async () => {
    const vnpayAttempt = {
      ...attempt,
      provider: 'vnpay',
      providerPaymentIdentity: '42',
    };
    const { service, provider, prisma, reconciliation, tx } = setup(order({
      paymentAttempts: [vnpayAttempt],
    }));
    tx.commercePaymentAttempt.findUniqueOrThrow.mockResolvedValue(vnpayAttempt);
    reconciliation.recoverVnPayAttemptForLifecycle.mockResolvedValue({ outcome: 'paid' });
    prisma.commerceOrder.findFirst.mockResolvedValue(order({
      status: CommerceOrderStatus.confirmed,
      paymentAttempts: [{ ...vnpayAttempt, status: CommercePaymentStatus.paid }],
      reservations: [],
    }));

    await expect(service.cancel('learner-id', 'order-id', 'cancel-key-123')).resolves.toEqual({
      orderId: 'order-id', orderStatus: 'CONFIRMED', paymentStatus: 'PAID',
    });
    expect(provider.cancelPaymentRequest).not.toHaveBeenCalled();
    expect(tx.commerceOrder.update).not.toHaveBeenCalled();
  });

  it('does not cancel VNPay when canonical payment wins after the pre-cancel check', async () => {
    const vnpayAttempt = {
      ...attempt,
      provider: 'vnpay',
      providerPaymentIdentity: '42',
    };
    const pendingOrder = order({ paymentAttempts: [vnpayAttempt] });
    const confirmedOrder = order({
      status: CommerceOrderStatus.confirmed,
      paymentAttempts: [{ ...vnpayAttempt, status: CommercePaymentStatus.paid }],
      reservations: [],
    });
    const { service, provider, reconciliation, tx } = setup(pendingOrder);
    tx.commerceOrder.findFirst
      .mockReset()
      .mockResolvedValueOnce(pendingOrder)
      .mockResolvedValueOnce(confirmedOrder);
    tx.commercePaymentAttempt.findUniqueOrThrow.mockResolvedValue({
      ...vnpayAttempt,
      status: CommercePaymentStatus.paid,
    });
    reconciliation.recoverVnPayAttemptForLifecycle.mockResolvedValue({ outcome: 'pending' });

    await expect(service.cancel('learner-id', 'order-id', 'cancel-key-123'))
      .rejects.toBeInstanceOf(ConflictException);
    expect(provider.cancelPaymentRequest).not.toHaveBeenCalled();
    expect(tx.commercePaymentAttempt.update).not.toHaveBeenCalled();
  });
});
