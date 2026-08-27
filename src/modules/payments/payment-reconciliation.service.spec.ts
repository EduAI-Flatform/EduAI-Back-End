import { createHmac } from 'node:crypto';
import {
  CommerceReconciliationKind,
  CommerceReconciliationStatus,
} from '../../../generated/prisma/client';
import { PaymentProviderError } from './payment-provider';
import { PaymentReconciliationService } from './payment-reconciliation.service';

const now = new Date('2026-08-27T00:00:00.000Z');
const attempt = {
  id: '11111111-1111-4111-8111-111111111111',
  orderId: '22222222-2222-4222-8222-222222222222',
  providerPaymentIdentity: 'payment-link',
  providerReceivingAccountHash: createHmac('sha256', 'test-secret')
    .update('payos-receiving-account:receiving-account')
    .digest('hex'),
  providerOrderCode: 9001n,
  amountMinor: 125000n,
  currency: 'VND',
  status: 'pending',
  order: { fulfillmentStatus: 'not_started' },
};

function harness() {
  const review = {
    id: '33333333-3333-4333-8333-333333333333',
    kind: 'provider_outage',
    reasonCode: 'PROVIDER_STATUS_UNAVAILABLE',
    status: 'open',
    resolution: null,
    openedAt: now,
    updatedAt: now,
    lastCheckedAt: now,
    checkCount: 1,
    resolvedAt: null,
    order: {
      orderNumber: 'EDU-9001',
      status: 'pending_payment',
      fulfillmentStatus: 'not_started',
      payableAmountMinor: 125000n,
      currency: 'VND',
    },
    paymentAttempt: { status: 'pending', providerStatusCheckedAt: now },
    settlement: null,
    resolvedBy: null,
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    commerceReconciliationCase: {
      findUnique: jest.fn().mockResolvedValue({
        ...review,
        orderId: attempt.orderId,
      }),
      update: jest.fn().mockResolvedValue({
        ...review,
        status: 'resolved',
        resolution: 'acknowledged',
        resolvedAt: now,
      }),
    },
    commerceLifecycleEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    commercePaymentAttempt: {
      findMany: jest.fn().mockResolvedValue([attempt]),
      update: jest.fn().mockResolvedValue({}),
    },
    commerceReconciliationCase: {
      upsert: jest.fn().mockResolvedValue(review),
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([review]),
      findUnique: jest.fn().mockResolvedValue(review),
    },
    $transaction: jest.fn((value: unknown) =>
      typeof value === 'function'
        ? (value as (client: typeof tx) => unknown)(tx)
        : Promise.all(value as Promise<unknown>[]),
    ),
  };
  const provider = {
    reconcilePaymentRequest: jest.fn().mockResolvedValue({
      providerPaymentIdentity: attempt.providerPaymentIdentity,
      localOrderReference: 9001,
      amountMinor: 125000n,
      amountPaidMinor: 125000n,
      amountRemainingMinor: 0n,
      status: 'PAID',
      createdAt: now,
      transactions: [{
        reference: 'settlement-reference',
        amountMinor: 125000n,
        receivingAccount: 'receiving-account',
        occurredAt: now,
      }],
    }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const webhook = { ingestVerified: jest.fn().mockResolvedValue({ accepted: true }) };
  const fulfillment = {
    fulfillConfirmedOrder: jest.fn().mockResolvedValue(undefined),
    dispatchPending: jest.fn().mockResolvedValue(undefined),
  };
  const service = new PaymentReconciliationService(
    prisma as never,
    audit as never,
    { commerce: { idempotencySecret: 'test-secret' } } as never,
    provider as never,
    webhook as never,
    fulfillment as never,
  );
  return { service, prisma, provider, audit, webhook, fulfillment, tx, review };
}

describe('PaymentReconciliationService', () => {
  it('recovers a missed webhook through the existing verified settlement path', async () => {
    const { service, prisma, webhook } = harness();
    await expect(service.run('admin-id', { limit: 20 })).resolves.toMatchObject({
      checkedCount: 1,
      recoveredCount: 1,
      reviewRequiredCount: 0,
      hasMore: false,
    });
    expect(webhook.ingestVerified).toHaveBeenCalledWith(
      expect.objectContaining({
        providerEventIdentity: 'settlement-reference',
        amountMinor: 125000n,
        providerCode: '00',
      }),
    );
    expect(prisma.commercePaymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { providerStatusCheckedAt: expect.any(Date) } }),
    );
  });

  it('opens an idempotent safe review when provider facts mismatch', async () => {
    const { service, provider, prisma, webhook } = harness();
    provider.reconcilePaymentRequest.mockResolvedValue({
      ...(await provider.reconcilePaymentRequest('seed')),
      amountMinor: 125001n,
    });
    provider.reconcilePaymentRequest.mockClear();

    await expect(service.run('admin-id', { limit: 20 })).resolves.toMatchObject({
      reviewRequiredCount: 1,
    });
    expect(prisma.commerceReconciliationCase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: CommerceReconciliationKind.provider_fact_mismatch,
          reasonCode: 'PROVIDER_AMOUNT_MISMATCH',
        }),
      }),
    );
    expect(webhook.ingestVerified).not.toHaveBeenCalled();
  });

  it('records only a sanitized outage reason and keeps a restart cursor', async () => {
    const { service, provider, prisma } = harness();
    prisma.commercePaymentAttempt.findMany.mockResolvedValue([
      attempt,
      { ...attempt, id: '44444444-4444-4444-8444-444444444444' },
    ]);
    provider.reconcilePaymentRequest.mockRejectedValue(
      new PaymentProviderError('timeout', true),
    );

    await expect(service.run('admin-id', { limit: 1 })).resolves.toMatchObject({
      checkedCount: 1,
      hasMore: true,
      nextCursor: attempt.id,
    });
    expect(prisma.commerceReconciliationCase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: CommerceReconciliationKind.provider_outage,
          reasonCode: 'PROVIDER_STATUS_UNAVAILABLE',
        }),
      }),
    );
    expect(JSON.stringify(prisma.commerceReconciliationCase.upsert.mock.calls)).not.toContain(
      'timeout',
    );
  });

  it('separates malformed provider status from transient provider outage', async () => {
    const { service, provider, prisma } = harness();
    provider.reconcilePaymentRequest.mockRejectedValue(
      new PaymentProviderError('malformed_response', false),
    );

    await service.run('admin-id', { limit: 20 });

    expect(prisma.commerceReconciliationCase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: CommerceReconciliationKind.unknown_provider_status,
          reasonCode: 'PROVIDER_STATUS_MALFORMED',
        }),
      }),
    );
  });

  it('keeps an externally paid but locally unfulfilled order in explicit review', async () => {
    const { service, webhook, prisma } = harness();
    webhook.ingestVerified.mockRejectedValue(new Error('sanitized fulfillment failure'));

    await expect(service.run('admin-id', { limit: 20 })).resolves.toMatchObject({
      recoveredCount: 0,
      reviewRequiredCount: 1,
    });
    expect(prisma.commerceReconciliationCase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: CommerceReconciliationKind.paid_not_fulfilled,
          reasonCode: 'PAID_ORDER_FULFILLMENT_RETRY_REQUIRED',
        }),
      }),
    );
  });

  it('paginates and sanitizes administrator review projections', async () => {
    const { service } = harness();
    await expect(
      service.list({ page: 1, pageSize: 25, status: CommerceReconciliationStatus.open }),
    ).resolves.toMatchObject({
      total: 1,
      items: [{
        kind: 'PROVIDER_OUTAGE',
        reasonCode: 'PROVIDER_STATUS_UNAVAILABLE',
        order: { payableAmountMinor: '125000' },
      }],
    });
  });

  it('atomically resolves an operational review with lifecycle and audit evidence', async () => {
    const { service, tx, audit } = harness();
    await expect(service.resolve('admin-id', reviewId(), {
      resolution: 'acknowledged',
      expectedUpdatedAt: now.toISOString(),
    })).resolves.toMatchObject({ status: 'RESOLVED', resolution: 'ACKNOWLEDGED' });
    expect(tx.commerceLifecycleEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reasonCode: 'OPERATOR_ACKNOWLEDGED' }) }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAYMENT_RECONCILIATION_RESOLVED' }),
      tx,
    );
  });
});

function reviewId() {
  return '33333333-3333-4333-8333-333333333333';
}
