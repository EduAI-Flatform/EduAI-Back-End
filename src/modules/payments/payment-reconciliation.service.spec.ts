import { createHmac } from 'node:crypto';
import {
  CommerceFulfillmentStatus,
  CommerceReconciliationKind,
  CommerceReconciliationStatus,
} from '../../../generated/prisma/client';
import { PaymentProviderError } from './payment-provider';
import { PaymentRecoveryError } from './payment-recovery-error';
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
    commercePaymentAttempt: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(attempt),
      update: jest.fn().mockResolvedValue(attempt),
    },
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
      findMany: jest.fn().mockResolvedValue([]),
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
      receivingAccount: 'receiving-account',
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
    fulfillConfirmedPayment: jest.fn().mockResolvedValue(undefined),
    fulfillConfirmedOrder: jest.fn().mockResolvedValue(undefined),
    dispatchPending: jest.fn().mockResolvedValue(undefined),
  };
  const monitoring = { capture: jest.fn() };
  const service = new PaymentReconciliationService(
    prisma as never,
    audit as never,
    { commerce: { idempotencySecret: 'test-secret' } } as never,
    provider as never,
    webhook as never,
    fulfillment as never,
    monitoring as never,
  );
  return { service, prisma, provider, audit, webhook, fulfillment, monitoring, tx, review };
}

describe('PaymentReconciliationService', () => {
  it('closes a stale paid-not-fulfilled review after the order is fulfilled', async () => {
    const { service, prisma } = harness();
    const staleReview = {
      id: '44444444-4444-4444-8444-444444444444',
      updatedAt: now,
    };
    prisma.commerceReconciliationCase.findMany.mockResolvedValue([staleReview]);
    const resolve = jest.spyOn(service, 'resolve').mockResolvedValue({
      id: staleReview.id,
      status: 'resolved',
      resolution: 'retry_succeeded',
      resolvedAt: now,
    } as never);

    await service.run('admin-id', { limit: 20 });

    expect(prisma.commerceReconciliationCase.findMany).toHaveBeenCalledWith({
      where: {
        status: CommerceReconciliationStatus.open,
        kind: CommerceReconciliationKind.paid_not_fulfilled,
        order: {
          status: 'confirmed',
          fulfillmentStatus: CommerceFulfillmentStatus.fulfilled,
        },
      },
      select: { id: true, updatedAt: true },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: 20,
    });
    expect(resolve).toHaveBeenCalledWith('admin-id', staleReview.id, {
      resolution: 'retry_succeeded',
      expectedUpdatedAt: now.toISOString(),
    });
  });

  it('recovers a missed webhook through the existing verified settlement path', async () => {
    const { service, webhook, tx } = harness();
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
    expect(tx.commercePaymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { providerStatusCheckedAt: expect.any(Date) } }),
    );
  });

  it('recovers a PAID payment when the provider receiver varies', async () => {
    const { service, provider, webhook, prisma } = harness();
    provider.reconcilePaymentRequest.mockResolvedValue({
      ...(await provider.reconcilePaymentRequest('seed')),
      receivingAccount: 'different-receiving-account',
      transactions: [{
        reference: 'settlement-reference',
        amountMinor: 125000n,
        receivingAccount: 'different-receiving-account',
        occurredAt: now,
      }],
    });

    await expect(service.run('admin-id', { limit: 20 })).resolves.toMatchObject({
      recoveredCount: 1,
      reviewRequiredCount: 0,
    });
    expect(webhook.ingestVerified).toHaveBeenCalledWith(
      expect.objectContaining({
        providerPaymentIdentity: 'payment-link',
        providerSettlementReference: 'settlement-reference',
        receivingAccount: 'different-receiving-account',
      }),
    );
    expect(JSON.stringify(prisma.commerceReconciliationCase.upsert.mock.calls)).not.toContain(
      'different-receiving-account',
    );
  });

  it('recovers a PAID payment when the stored receiver fingerprint is missing', async () => {
    const { service, prisma, webhook } = harness();
    const missingReceiverFingerprint = { ...attempt, providerReceivingAccountHash: null };
    prisma.commercePaymentAttempt.findMany.mockResolvedValue([missingReceiverFingerprint]);

    await expect(service.run('admin-id', { limit: 20 })).resolves.toMatchObject({
      recoveredCount: 1,
      reviewRequiredCount: 0,
    });
    expect(webhook.ingestVerified).toHaveBeenCalledWith(
      expect.objectContaining({ providerSettlementReference: 'settlement-reference' }),
    );
  });

  it('recovers an ambiguous create by stable provider order code before settlement', async () => {
    const { service, prisma, provider, tx, webhook } = harness();
    const ambiguous = {
      ...attempt,
      status: 'created',
      providerPaymentIdentity: null,
      providerReceivingAccountHash: null,
    };
    prisma.commercePaymentAttempt.findMany.mockResolvedValue([ambiguous]);
    tx.commercePaymentAttempt.findUniqueOrThrow.mockResolvedValue(ambiguous);
    provider.reconcilePaymentRequest.mockResolvedValue({
      providerPaymentIdentity: 'payment-link',
      receivingAccount: null,
      localOrderReference: 9001,
      amountMinor: 125000n,
      amountPaidMinor: 0n,
      amountRemainingMinor: 125000n,
      status: 'PENDING',
      createdAt: now,
      transactions: [],
    });

    await expect(service.run('admin-id', { limit: 20 })).resolves.toMatchObject({
      recoveredCount: 0,
      reviewRequiredCount: 0,
    });

    expect(provider.reconcilePaymentRequest).toHaveBeenCalledWith('9001');
    expect(tx.commercePaymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          providerPaymentIdentity: 'payment-link',
          status: 'pending',
        }),
      }),
    );
    expect(tx.commerceLifecycleEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reasonCode: 'PROVIDER_REQUEST_RECOVERED' }),
      }),
    );
    expect(webhook.ingestVerified).not.toHaveBeenCalled();
  });

  it('opens an idempotent safe review when provider facts mismatch', async () => {
    const { service, provider, prisma, webhook, monitoring } = harness();
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
    expect(monitoring.capture).toHaveBeenCalledWith({
      code: 'PAYMENT_RECONCILIATION_REQUIRED',
      path: '/admin/commerce/reconciliation/runs',
      statusCode: 409,
    });
    expect(JSON.stringify(monitoring.capture.mock.calls)).not.toMatch(
      /payment-link|settlement-reference|receiving-account/,
    );
  });

  it.each([
    [
      'payment link identity',
      { providerPaymentIdentity: 'different-payment-link' },
      'PROVIDER_PAYMENT_IDENTITY_MISMATCH',
    ],
    [
      'order code',
      { localOrderReference: 9002 },
      'PROVIDER_ORDER_REFERENCE_MISMATCH',
    ],
  ])('does not recover a PAID payment with mismatched %s', async (_label, statusPatch, reasonCode) => {
    const { service, provider, prisma, webhook } = harness();
    provider.reconcilePaymentRequest.mockResolvedValue({
      ...(await provider.reconcilePaymentRequest('seed')),
      ...statusPatch,
    });

    await expect(service.run('admin-id', { limit: 20 })).resolves.toMatchObject({
      recoveredCount: 0,
      reviewRequiredCount: 1,
    });
    expect(prisma.commerceReconciliationCase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: CommerceReconciliationKind.provider_fact_mismatch,
          reasonCode,
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
          reasonCode: 'PROVIDER_STATUS_TIMEOUT',
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

  it('classifies an invalid provider response signature without recovery', async () => {
    const { service, provider, prisma, webhook } = harness();
    provider.reconcilePaymentRequest.mockRejectedValue(
      new PaymentProviderError('invalid_signature', false),
    );

    await expect(service.run('admin-id', { limit: 20 })).resolves.toMatchObject({
      recoveredCount: 0,
      reviewRequiredCount: 1,
    });
    expect(prisma.commerceReconciliationCase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: CommerceReconciliationKind.unknown_provider_status,
          reasonCode: 'PROVIDER_STATUS_INVALID_SIGNATURE',
        }),
      }),
    );
    expect(webhook.ingestVerified).not.toHaveBeenCalled();
  });

  it('classifies a provider API rejection without recovery', async () => {
    const { service, provider, prisma, webhook } = harness();
    provider.reconcilePaymentRequest.mockRejectedValue(
      new PaymentProviderError('rejected', false),
    );

    await expect(service.run('admin-id', { limit: 20 })).resolves.toMatchObject({
      recoveredCount: 0,
      reviewRequiredCount: 1,
    });
    expect(prisma.commerceReconciliationCase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: CommerceReconciliationKind.unknown_provider_status,
          reasonCode: 'PROVIDER_STATUS_REJECTED',
        }),
      }),
    );
    expect(webhook.ingestVerified).not.toHaveBeenCalled();
  });

  it('keeps an externally paid but locally unfulfilled order in explicit review', async () => {
    const { service, webhook, prisma } = harness();
    webhook.ingestVerified.mockRejectedValue(
      new PaymentRecoveryError(
        'fulfillment',
        'PAYMENT_FULFILLMENT_FAILED',
        true,
        true,
        'settlement-id',
      ),
    );

    await expect(service.run('admin-id', { limit: 20 })).resolves.toMatchObject({
      recoveredCount: 1,
      reviewRequiredCount: 1,
    });
    expect(prisma.commerceReconciliationCase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: CommerceReconciliationKind.paid_not_fulfilled,
          reasonCode: 'PAID_ORDER_FULFILLMENT_RETRY_REQUIRED',
          settlementId: 'settlement-id',
        }),
      }),
    );
  });

  it('classifies financial settlement persistence failure without opening a paid-not-fulfilled case', async () => {
    const { service, webhook, prisma } = harness();
    webhook.ingestVerified.mockRejectedValue(
      new PaymentRecoveryError(
        'financial',
        'PAYMENT_SETTLEMENT_PERSISTENCE_FAILED',
        false,
        false,
      ),
    );

    await expect(service.run('admin-id', { limit: 20 })).resolves.toMatchObject({
      recoveredCount: 0,
      reviewRequiredCount: 1,
    });
    expect(prisma.commerceReconciliationCase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: CommerceReconciliationKind.provider_fact_mismatch,
          reasonCode: 'PAYMENT_SETTLEMENT_PERSISTENCE_FAILED',
        }),
      }),
    );
    expect(JSON.stringify(prisma.commerceReconciliationCase.upsert.mock.calls)).not.toContain(
      'PAID_ORDER_FULFILLMENT_RETRY_REQUIRED',
    );
  });

  it.each([
    ['paid amount facts', {}, { amountPaidMinor: 124999n }, 'PROVIDER_PAID_AMOUNT_FACTS_INCOMPLETE'],
    ['remaining amount', {}, { amountRemainingMinor: 1n }, 'PROVIDER_PAID_AMOUNT_FACTS_INCOMPLETE'],
    ['transaction amount', {}, { transactions: [] }, 'PROVIDER_PAID_TRANSACTION_AMOUNT_MISSING'],
  ])('records the exact sanitized verified-payment failure: %s', async (_label, attemptPatch, statusPatch, reasonCode) => {
    const { service, provider, prisma } = harness();
    prisma.commercePaymentAttempt.findMany.mockResolvedValue([{ ...attempt, ...attemptPatch }]);
    provider.reconcilePaymentRequest.mockResolvedValue({
      ...(await provider.reconcilePaymentRequest('seed')),
      ...statusPatch,
    });

    await expect(service.run('admin-id', { limit: 20 })).resolves.toMatchObject({
      recoveredCount: 0,
      reviewRequiredCount: 1,
    });
    expect(prisma.commerceReconciliationCase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ reasonCode }),
      }),
    );
  });

  it('refreshes a reconciliation reason when an existing case is checked again', async () => {
    const { service, prisma } = harness();

    await service.flagAttempt(
      attempt,
      CommerceReconciliationKind.provider_fact_mismatch,
      'PROVIDER_PAID_TRANSACTION_AMOUNT_MISSING',
    );

    expect(prisma.commerceReconciliationCase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          reasonCode: 'PROVIDER_PAID_TRANSACTION_AMOUNT_MISSING',
        }),
      }),
    );
  });

  it('paginates and sanitizes administrator review projections', async () => {
    const { service, prisma, review } = harness();
    prisma.commerceReconciliationCase.findMany.mockResolvedValue([review]);
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

  it('resolves a legacy fulfillment review from canonical fulfilled order evidence', async () => {
    const { service, tx, fulfillment, review } = harness();
    const canonicalSettlement = {
      id: 'canonical-settlement-id',
      orderId: attempt.orderId,
      paymentAttemptId: attempt.id,
      paymentEventId: 'canonical-event-id',
      kind: 'provider_collection',
      disposition: 'matched',
      provider: 'payos',
      providerSettlementReference: 'canonical-settlement-reference',
      amountMinor: 125000n,
      currency: 'VND',
      settledAt: now,
      paymentAttempt: {
        id: attempt.id,
        orderId: attempt.orderId,
        provider: 'payos',
        providerPaymentIdentity: 'payment-link',
        providerOrderCode: 9001n,
        status: 'paid',
        amountMinor: 125000n,
        currency: 'VND',
      },
      paymentEvent: {
        id: 'canonical-event-id',
        paymentAttemptId: attempt.id,
        provider: 'payos',
        providerPaymentIdentity: 'payment-link',
        providerSettlementReference: 'canonical-settlement-reference',
        amountMinor: 125000n,
        currency: 'VND',
        nextStatus: 'paid',
        providerOccurredAt: now,
      },
    };
    const legacyReview = {
      ...review,
      orderId: attempt.orderId,
      kind: CommerceReconciliationKind.paid_not_fulfilled,
      settlementId: null,
      paymentAttemptId: attempt.id,
      order: {
        ...review.order,
        status: 'confirmed',
        fulfillmentStatus: CommerceFulfillmentStatus.fulfilled,
        confirmedSettlementId: canonicalSettlement.id,
        confirmedSettlement: canonicalSettlement,
      },
    };
    tx.commerceReconciliationCase.findUnique.mockReset().mockResolvedValue(legacyReview);
    tx.commerceReconciliationCase.update.mockResolvedValue({
      ...legacyReview,
      status: 'resolved',
      resolution: 'retry_succeeded',
      resolvedAt: now,
    });

    await expect(service.resolve('admin-id', reviewId(), {
      resolution: 'retry_succeeded',
      expectedUpdatedAt: now.toISOString(),
    })).resolves.toMatchObject({
      status: 'RESOLVED',
      resolution: 'RETRY_SUCCEEDED',
    });

    expect(fulfillment.fulfillConfirmedPayment).not.toHaveBeenCalled();
    expect(fulfillment.dispatchPending).not.toHaveBeenCalled();
  });

  it('retries fulfillment outside case resolution and closes only after canonical fulfillment', async () => {
    const { service, tx, fulfillment, prisma, review } = harness();
    const canonicalReview = {
      ...review,
      orderId: attempt.orderId,
      kind: CommerceReconciliationKind.paid_not_fulfilled,
      settlementId: 'settlement-id',
      paymentAttemptId: attempt.id,
      order: {
        ...review.order,
        status: 'confirmed',
        confirmedSettlementId: 'settlement-id',
        fulfillmentStatus: 'failed',
      },
      settlement: {
        id: 'settlement-id',
        orderId: attempt.orderId,
        paymentAttemptId: attempt.id,
        paymentEventId: 'event-id',
        kind: 'provider_collection',
        disposition: 'matched',
        provider: 'payos',
        providerSettlementReference: 'settlement-reference',
        amountMinor: 125000n,
        currency: 'VND',
        settledAt: now,
        paymentAttempt: {
          id: attempt.id,
          orderId: attempt.orderId,
          provider: 'payos',
          providerPaymentIdentity: 'payment-link',
          providerOrderCode: 9001n,
          status: 'paid',
          amountMinor: 125000n,
          currency: 'VND',
        },
        paymentEvent: {
          id: 'event-id',
          paymentAttemptId: attempt.id,
          provider: 'payos',
          providerPaymentIdentity: 'payment-link',
          providerSettlementReference: 'settlement-reference',
          amountMinor: 125000n,
          currency: 'VND',
          nextStatus: 'paid',
          providerOccurredAt: now,
        },
      },
    };
    tx.commerceReconciliationCase.findUnique
      .mockReset()
      .mockResolvedValueOnce(canonicalReview)
      .mockResolvedValueOnce(canonicalReview)
      .mockResolvedValueOnce({
        ...canonicalReview,
        order: {
          ...canonicalReview.order,
          fulfillmentStatus: 'fulfilled',
        },
      })
      .mockResolvedValueOnce({
        ...canonicalReview,
        order: {
          ...canonicalReview.order,
          fulfillmentStatus: 'fulfilled',
        },
      });
    tx.commerceReconciliationCase.update.mockResolvedValue({
      ...canonicalReview,
      status: 'resolved',
      resolution: 'retry_succeeded',
      resolvedAt: now,
    });

    await expect(service.resolve('admin-id', reviewId(), {
      resolution: 'retry_succeeded',
      expectedUpdatedAt: now.toISOString(),
    })).resolves.toMatchObject({
      status: 'RESOLVED',
      resolution: 'RETRY_SUCCEEDED',
    });

    expect(fulfillment.fulfillConfirmedPayment).toHaveBeenCalledWith(
      attempt.orderId,
      'settlement-id',
      'user',
      'admin-id',
    );
    expect(fulfillment.fulfillConfirmedOrder).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('does not grant access for a legacy paid-not-fulfilled case without canonical settlement evidence', async () => {
    const { service, tx, fulfillment, review } = harness();
    tx.commerceReconciliationCase.findUnique.mockResolvedValue({
      ...review,
      kind: CommerceReconciliationKind.paid_not_fulfilled,
      paymentAttemptId: attempt.id,
      settlementId: null,
      order: {
        ...review.order,
        status: 'pending_payment',
      },
    });

    await expect(service.resolve('admin-id', reviewId(), {
      resolution: 'retry_succeeded',
      expectedUpdatedAt: now.toISOString(),
    })).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'PAYMENT_SETTLEMENT_CONFLICT' }),
    });
    expect(fulfillment.fulfillConfirmedPayment).not.toHaveBeenCalled();
  });
});

function reviewId() {
  return '33333333-3333-4333-8333-333333333333';
}
