import { createHmac } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { CommerceOrderStatus, CommercePaymentStatus, CommerceReservationStatus } from '../../../generated/prisma/client';
import { PaymentLifecycleService } from './payment-lifecycle.service';

const secret = 's'.repeat(32);
const account = 'safe-account';
const accountHash = createHmac('sha256', secret).update(`payos-receiving-account:${account}`).digest('hex');
const attempt = {
  id: 'attempt-id', orderId: 'order-id', providerPaymentIdentity: 'provider-id',
  providerReceivingAccountHash: accountHash, providerOrderCode: 42n,
  amountMinor: 100000n, currency: 'VND', status: CommercePaymentStatus.pending,
};
const order = (overrides: Record<string, unknown> = {}) => ({
  id: 'order-id', buyerId: 'learner-id', status: CommerceOrderStatus.pending_payment,
  paymentAttempts: [attempt], reservations: [{ id: 'reservation-id' }], ...overrides,
});
const providerStatus = (status: 'CANCELLED' | 'PAID' = 'CANCELLED') => ({
  providerPaymentIdentity: 'provider-id', receivingAccount: account, localOrderReference: 42,
  amountMinor: 100000n, amountPaidMinor: status === 'PAID' ? 100000n : 0n,
  amountRemainingMinor: status === 'PAID' ? 0n : 100000n, status,
  createdAt: new Date('2026-08-27T08:00:00Z'),
  transactions: status === 'PAID' ? [{
    reference: 'settlement-ref', amountMinor: 100000n, receivingAccount: account,
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
    commerceIdempotencyRecord: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
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
  };
  const provider: any = { cancelPaymentRequest: jest.fn().mockResolvedValue(providerStatus()) };
  const audit: any = { record: jest.fn() };
  const reconciliation: any = { flagAttempt: jest.fn() };
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

  it('routes a paid cancellation race through verified settlement instead of cancelling', async () => {
    const { service, provider, prisma, webhook, tx } = setup();
    provider.cancelPaymentRequest.mockResolvedValue(providerStatus('PAID'));
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
});
