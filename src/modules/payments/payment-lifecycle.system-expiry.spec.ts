import { createHmac } from 'node:crypto';
import {
  AuditActorKind,
  CommerceActorKind,
  CommerceOrderStatus,
  CommercePaymentStatus,
} from '../../../generated/prisma/client';
import { PaymentLifecycleService } from './payment-lifecycle.service';

const secret = 's'.repeat(32);
const receivingAccount = 'safe-account';
const receivingAccountHash = createHmac('sha256', secret)
  .update(`payos-receiving-account:${receivingAccount}`)
  .digest('hex');

const attempt = {
  id: 'attempt-id',
  orderId: 'order-id',
  providerPaymentIdentity: 'provider-id',
  providerReceivingAccountHash: receivingAccountHash,
  providerOrderCode: 42n,
  amountMinor: 100000n,
  currency: 'VND',
  status: CommercePaymentStatus.pending,
};

const providerStatus = {
  providerPaymentIdentity: 'provider-id',
  receivingAccount,
  localOrderReference: 42,
  amountMinor: 100000n,
  amountPaidMinor: 0n,
  amountRemainingMinor: 100000n,
  status: 'EXPIRED' as const,
  createdAt: new Date('2026-09-09T08:00:00Z'),
  transactions: [],
};

describe('PaymentLifecycleService scheduled expiry actor', () => {
  it('records scheduled expiry lifecycle and audit evidence as SYSTEM with no user id', async () => {
    const pendingOrder = {
      id: 'order-id',
      buyerId: 'learner-id',
      status: CommerceOrderStatus.pending_payment,
      paymentAttempts: [attempt],
      reservations: [],
    };
    const expiredOrder = {
      ...pendingOrder,
      status: CommerceOrderStatus.expired,
      paymentAttempts: [{ ...attempt, status: CommercePaymentStatus.expired }],
    };
    const tx: any = {
      $queryRaw: jest.fn(),
      commercePaymentAttempt: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(attempt),
        update: jest.fn(),
      },
      commerceOrder: {
        findUniqueOrThrow: jest.fn()
          .mockResolvedValueOnce(pendingOrder)
          .mockResolvedValueOnce(expiredOrder),
        update: jest.fn(),
      },
      commercePromotionReservation: { update: jest.fn() },
      commerceLifecycleEvent: { create: jest.fn() },
    };
    const prisma: any = {
      commercePaymentAttempt: { findMany: jest.fn().mockResolvedValue([attempt]) },
      $transaction: jest.fn((operation: any) => operation(tx)),
    };
    const audit: any = { record: jest.fn() };
    const provider: any = { cancelPaymentRequest: jest.fn().mockResolvedValue(providerStatus) };
    const reconciliation: any = { flagAttempt: jest.fn() };
    const webhook: any = { ingestVerified: jest.fn() };
    const service = new PaymentLifecycleService(
      prisma,
      { commerce: { idempotencySecret: secret } } as never,
      audit,
      provider,
      reconciliation,
      webhook,
    );

    await service.runExpiry(null, { limit: 20 });

    expect(tx.commerceLifecycleEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        actorKind: CommerceActorKind.system,
        actorId: null,
      }),
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      actorKind: AuditActorKind.SYSTEM,
    }));
    expect(audit.record).toHaveBeenCalledWith(expect.not.objectContaining({
      actorId: expect.anything(),
    }));
    expect(provider.cancelPaymentRequest).toHaveBeenCalledWith('provider-id', 'payment window expired');
    expect(reconciliation.flagAttempt).not.toHaveBeenCalled();
  });
});
