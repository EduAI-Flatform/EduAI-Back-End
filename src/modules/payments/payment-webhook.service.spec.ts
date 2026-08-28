import { createHmac } from 'node:crypto';
import {
  AuditActorKind,
  CommerceOrderStatus,
  CommercePaymentStatus,
  CommerceSettlementDisposition,
  Prisma,
} from '../../../generated/prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PaymentProvider, PaymentProviderError, VerifiedPaymentWebhook } from './payment-provider';
import { PaymentWebhookService } from './payment-webhook.service';

const verified: VerifiedPaymentWebhook = {
  providerEventIdentity: 'provider-event',
  providerPaymentIdentity: 'provider-payment',
  providerSettlementReference: 'provider-settlement',
  localOrderReference: 1001,
  amountMinor: 100000n,
  currency: 'VND',
  occurredAt: new Date('2026-08-26T10:00:00.000Z'),
  providerCode: '00',
  receivingAccount: 'receiving-account',
};

const TEST_SECRET = 'test-commerce-idempotency-secret-32-characters';
const receivingAccountHash = createHmac('sha256', TEST_SECRET)
  .update('payos-receiving-account:receiving-account')
  .digest('hex');

function webhookFingerprint(kind: 'event' | 'order' | 'payment', value: string | number) {
  return createHmac('sha256', TEST_SECRET)
    .update(`payos-webhook-${kind}:${value}`)
    .digest('hex');
}

function attempt(overrides: Record<string, unknown> = {}) {
  const orderOverrides = (overrides.order ?? {}) as Record<string, unknown>;
  return {
    id: 'attempt-id',
    orderId: 'order-id',
    provider: 'payos',
    providerPaymentIdentity: 'provider-payment',
    providerReceivingAccountHash: receivingAccountHash,
    providerOrderCode: 1001n,
    amountMinor: 100000n,
    currency: 'VND',
    status: CommercePaymentStatus.pending,
    ...overrides,
    order: {
      id: 'order-id',
      buyerId: 'buyer-id',
      status: CommerceOrderStatus.pending_payment,
      confirmedSettlementId: null as string | null,
      payableAmountMinor: 100000n,
      currency: 'VND',
      reservations: [],
      ...orderOverrides,
    },
  };
}

function priorEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-id',
    paymentAttemptId: 'attempt-id',
    provider: 'payos',
    providerEventIdentity: 'provider-event',
    providerPaymentIdentity: 'provider-payment',
    providerSettlementReference: 'provider-settlement',
    amountMinor: 100000n,
    currency: 'VND',
    providerOccurredAt: new Date('2026-08-26T10:00:00.000Z'),
    paymentAttempt: attempt({
      status: CommercePaymentStatus.paid,
      order: {
        status: CommerceOrderStatus.confirmed,
        confirmedSettlementId: 'settlement-id',
      },
    }),
    settlement: {
      id: 'settlement-id',
      orderId: 'order-id',
      paymentAttemptId: 'attempt-id',
      paymentEventId: 'event-id',
      kind: 'provider_collection',
      provider: 'payos',
      providerSettlementReference: 'provider-settlement',
      amountMinor: 100000n,
      currency: 'VND',
      settledAt: new Date('2026-08-26T10:00:00.000Z'),
      disposition: CommerceSettlementDisposition.matched,
    },
    ...overrides,
  };
}

function harness() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    commercePaymentEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'event-id' }),
    },
    commercePaymentAttempt: {
      findUnique: jest.fn().mockResolvedValue(attempt()),
      findUniqueOrThrow: jest.fn().mockResolvedValue(attempt()),
      update: jest.fn().mockResolvedValue({}),
    },
    commerceSettlement: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'settlement-id' }),
    },
    commerceOrder: { update: jest.fn().mockResolvedValue({}) },
    commerceLifecycleEvent: { create: jest.fn().mockResolvedValue({}) },
    commerceReconciliationCase: {
      create: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
    },
    commercePromotionReservation: { update: jest.fn().mockResolvedValue({}) },
    voucherRedemption: { create: jest.fn().mockResolvedValue({}) },
    voucher: { update: jest.fn().mockResolvedValue({}) },
  };
  tx.commercePaymentEvent.findUniqueOrThrow.mockImplementation(async (args: unknown) => {
    const event = await tx.commercePaymentEvent.findUnique(args);
    if (!event) throw new Error('Payment event was not found.');
    return event;
  });
  const prisma = {
    $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
      operation(tx),
    ),
  };
  const provider = {
    verifyWebhook: jest.fn().mockResolvedValue(verified),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const fulfillment = {
    fulfillConfirmedOrder: jest.fn().mockResolvedValue(undefined),
    dispatchPending: jest.fn().mockResolvedValue(undefined),
  };
  const service = new PaymentWebhookService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    { commerce: { idempotencySecret: TEST_SECRET } } as never,
    provider as unknown as PaymentProvider,
    fulfillment as never,
  );
  return { audit, fulfillment, prisma, provider, service, tx };
}

describe('PaymentWebhookService', () => {
  it('verifies the signature before any database lookup', async () => {
    const { prisma, provider, service } = harness();
    provider.verifyWebhook.mockRejectedValue(
      new PaymentProviderError('invalid_signature', false),
    );

    await expect(service.ingest({ data: {}, signature: 'invalid' })).rejects.toMatchObject({
      status: 401,
    });
    expect(provider.verifyWebhook).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a malformed webhook before any database lookup', async () => {
    const { prisma, provider, service } = harness();
    provider.verifyWebhook.mockRejectedValue(
      new PaymentProviderError('malformed_response', false),
    );

    await expect(service.ingest({ data: null })).rejects.toMatchObject({
      status: 400,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('atomically records a matched settlement and confirms the order', async () => {
    const { audit, fulfillment, provider, service, tx } = harness();

    await expect(service.ingest({ data: {}, signature: 'signed' })).resolves.toEqual({
      accepted: true,
      result: 'CONFIRMED',
    });

    expect(provider.verifyWebhook).toHaveBeenCalledTimes(1);
    expect(tx.commercePaymentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        providerEventIdentity: 'provider-event',
        amountMinor: 100000n,
        nextStatus: CommercePaymentStatus.paid,
      }),
    });
    expect(tx.commercePaymentAttempt.update).toHaveBeenCalledWith({
      where: { id: 'attempt-id' },
      data: expect.objectContaining({ status: CommercePaymentStatus.paid }),
    });
    expect(tx.commerceOrder.update).toHaveBeenCalledWith({
      where: { id: 'order-id' },
      data: expect.objectContaining({
        status: CommerceOrderStatus.confirmed,
        confirmedSettlementId: 'settlement-id',
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorKind: AuditActorKind.PROVIDER }),
      tx,
    );
    expect(fulfillment.fulfillConfirmedOrder).toHaveBeenCalledWith(
      tx,
      'order-id',
      'provider',
      null,
    );
  });

  it('records settlement when a locked reservation remains reserved past its timestamp', async () => {
    const { service, tx } = harness();
    const reservedAttempt = attempt({
      order: {
        id: 'order-id',
        status: CommerceOrderStatus.pending_payment,
        reservations: [{
          id: 'reservation-id',
          buyerId: 'buyer-id',
          orderId: 'order-id',
          voucherId: null,
          expiresAt: new Date('2026-08-26T09:00:00.000Z'),
          benefitSnapshot: { allocatedDiscountAmountMinor: 1000n },
          orderLine: {
            orderId: 'order-id',
            productReferenceId: 'course-id',
            unitListPriceAmountMinor: 101000n,
            finalAmountMinor: 100000n,
          },
        }],
      },
    });
    tx.commercePaymentAttempt.findUnique.mockResolvedValue(reservedAttempt);
    tx.commercePaymentAttempt.findUniqueOrThrow.mockResolvedValue(reservedAttempt);

    await expect(service.ingest({ data: {}, signature: 'signed' })).resolves.toEqual({
      accepted: true,
      result: 'CONFIRMED',
    });
    expect(tx.commercePaymentEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.commercePromotionReservation.update).toHaveBeenCalledWith({
      where: { id: 'reservation-id' },
      data: expect.objectContaining({ status: 'consumed' }),
    });
  });

  it('returns the stable original result for a duplicate provider event', async () => {
    const { fulfillment, service, tx } = harness();
    tx.commercePaymentEvent.findUnique.mockResolvedValue(priorEvent());

    await expect(service.ingest({ data: {}, signature: 'signed' })).resolves.toEqual({
      accepted: true,
      result: 'CONFIRMED',
    });
    expect(tx.commercePaymentAttempt.findUnique).not.toHaveBeenCalled();
    expect(tx.commercePaymentEvent.create).not.toHaveBeenCalled();
    expect(fulfillment.fulfillConfirmedOrder).toHaveBeenCalledWith(
      tx,
      'order-id',
      'provider',
      null,
    );
  });

  it('acknowledges a valid signed webhook for an unknown local payment', async () => {
    const { audit, service, tx } = harness();
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    tx.commercePaymentAttempt.findUnique.mockResolvedValue(null);

    try {
      await expect(service.ingest({ data: {}, signature: 'signed' })).resolves.toEqual({
        accepted: true,
        result: 'UNKNOWN_PAYMENT_ACKNOWLEDGED',
      });
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
    expect(audit.record).toHaveBeenCalledWith(
      {
        actorKind: AuditActorKind.PROVIDER,
        action: 'PAYMENT_WEBHOOK_RECONCILIATION_REQUIRED',
        metadata: {
          amountMinor: '100000',
          currency: 'VND',
          orderCodeFingerprint: webhookFingerprint('order', 1001),
          provider: 'payos',
          providerPaymentIdentityFingerprint: webhookFingerprint(
            'payment',
            'provider-payment',
          ),
          reasonCode: 'PAYMENT_ATTEMPT_NOT_FOUND',
        },
        target: {
          id: webhookFingerprint('event', 'provider-event'),
          type: 'provider_payment_webhook',
        },
      },
      tx,
    );
    const auditEvidence = JSON.stringify(audit.record.mock.calls);
    expect(auditEvidence).not.toContain('provider-event');
    expect(auditEvidence).not.toContain('provider-payment');
    expect(auditEvidence).not.toContain('1001');
  });

  it('rejects an event-reference collision before fulfilling another order', async () => {
    const { fulfillment, provider, service, tx } = harness();
    provider.verifyWebhook.mockResolvedValue({
      ...verified,
      localOrderReference: 2002,
      providerPaymentIdentity: 'different-provider-payment',
    });
    tx.commercePaymentEvent.findUnique.mockResolvedValue(priorEvent());

    await expect(service.ingest({ data: {}, signature: 'signed' })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ error: 'PAYMENT_EVENT_IDENTITY_MISMATCH' }),
    });
    expect(tx.commerceReconciliationCase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ reasonCode: 'PAYMENT_EVENT_IDENTITY_MISMATCH' }),
      }),
    );
    expect(fulfillment.fulfillConfirmedOrder).not.toHaveBeenCalled();
    expect(fulfillment.dispatchPending).not.toHaveBeenCalled();
  });

  it('rejects a duplicate event whose attempt and settlement reference different orders', async () => {
    const { fulfillment, service, tx } = harness();
    const collision = priorEvent();
    collision.settlement.orderId = 'different-order-id';
    tx.commercePaymentEvent.findUnique.mockResolvedValue(collision);

    await expect(service.ingest({ data: {}, signature: 'signed' })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ error: 'PAYMENT_EVENT_IDENTITY_MISMATCH' }),
    });
    expect(tx.commerceReconciliationCase.upsert).toHaveBeenCalledTimes(1);
    expect(fulfillment.fulfillConfirmedOrder).not.toHaveBeenCalled();
    expect(fulfillment.dispatchPending).not.toHaveBeenCalled();
  });

  it('rejects an unknown order code that reuses a known provider payment identity', async () => {
    const { audit, service, tx } = harness();
    tx.commercePaymentAttempt.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'known-attempt-id', orderId: 'known-order-id' });

    await expect(service.ingest({ data: {}, signature: 'signed' })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ error: 'PAYMENT_REFERENCE_MISMATCH' }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PAYMENT_WEBHOOK_RECONCILIATION_REQUIRED',
        metadata: expect.objectContaining({ reasonCode: 'PAYMENT_REFERENCE_MISMATCH' }),
      }),
      tx,
    );
    expect(tx.commerceReconciliationCase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ reasonCode: 'PAYMENT_REFERENCE_MISMATCH' }),
      }),
    );
    expect(tx.commercePaymentEvent.create).not.toHaveBeenCalled();
    expect(tx.commerceSettlement.create).not.toHaveBeenCalled();
  });

  it('rejects a settlement-reference collision before fulfilling a different order', async () => {
    const { fulfillment, service, tx } = harness();
    tx.commerceSettlement.findUnique.mockResolvedValue({
      ...priorEvent().settlement,
      orderId: 'different-order-id',
      paymentEvent: {
        id: 'event-id',
        paymentAttemptId: 'attempt-id',
        provider: 'payos',
        providerEventIdentity: 'provider-event',
        providerPaymentIdentity: 'provider-payment',
        providerSettlementReference: 'provider-settlement',
        amountMinor: 100000n,
        currency: 'VND',
        providerOccurredAt: new Date('2026-08-26T10:00:00.000Z'),
      },
    });

    await expect(service.ingest({ data: {}, signature: 'signed' })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ error: 'PAYMENT_REFERENCE_MISMATCH' }),
    });
    expect(tx.commerceReconciliationCase.upsert).toHaveBeenCalledTimes(1);
    expect(fulfillment.fulfillConfirmedOrder).not.toHaveBeenCalled();
    expect(fulfillment.dispatchPending).not.toHaveBeenCalled();
  });

  it('rejects duplicate fulfillment from a non-canonical settlement', async () => {
    const { fulfillment, service, tx } = harness();
    const event = priorEvent();
    event.paymentAttempt.order.confirmedSettlementId = 'different-settlement-id';
    tx.commercePaymentEvent.findUnique.mockResolvedValue(event);

    await expect(service.ingest({ data: {}, signature: 'signed' })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ error: 'PAYMENT_EVENT_IDENTITY_MISMATCH' }),
    });
    expect(tx.commerceReconciliationCase.upsert).toHaveBeenCalledTimes(1);
    expect(fulfillment.fulfillConfirmedOrder).not.toHaveBeenCalled();
    expect(fulfillment.dispatchPending).not.toHaveBeenCalled();
  });

  it('rejects a reservation owned by someone other than the canonical order buyer', async () => {
    const { fulfillment, service, tx } = harness();
    const mismatched = attempt({
      order: {
        reservations: [{
          id: 'reservation-id',
          buyerId: 'different-buyer-id',
          orderId: 'order-id',
          voucherId: 'voucher-id',
          expiresAt: new Date('2026-08-26T11:00:00.000Z'),
          benefitSnapshot: { allocatedDiscountAmountMinor: 1000n },
          orderLine: {
            orderId: 'order-id',
            productReferenceId: 'course-id',
            unitListPriceAmountMinor: 101000n,
            finalAmountMinor: 100000n,
          },
        }],
      },
    });
    tx.commercePaymentAttempt.findUnique.mockResolvedValue(mismatched);
    tx.commercePaymentAttempt.findUniqueOrThrow.mockResolvedValue(mismatched);

    await expect(service.ingest({ data: {}, signature: 'signed' })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ error: 'PAYMENT_FACT_MISMATCH' }),
    });
    expect(tx.commercePaymentEvent.create).not.toHaveBeenCalled();
    expect(tx.commerceSettlement.create).not.toHaveBeenCalled();
    expect(tx.commercePromotionReservation.update).not.toHaveBeenCalled();
    expect(tx.voucherRedemption.create).not.toHaveBeenCalled();
    expect(fulfillment.fulfillConfirmedOrder).not.toHaveBeenCalled();
  });
  it('routes a PaymentAttempt and CommerceOrder identity mismatch to reconciliation', async () => {
    const { audit, fulfillment, service, tx } = harness();
    const mismatched = attempt({ order: { id: 'different-order-id' } });
    tx.commercePaymentAttempt.findUnique.mockResolvedValue(mismatched);
    tx.commercePaymentAttempt.findUniqueOrThrow.mockResolvedValue(mismatched);

    await expect(service.ingest({ data: {}, signature: 'signed' })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ error: 'PAYMENT_FACT_MISMATCH' }),
    });
    expect(tx.commerceReconciliationCase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          paymentAttemptId: 'attempt-id',
          orderId: 'order-id',
          reasonCode: 'PAYMENT_FACT_MISMATCH',
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reasonCode: 'PAYMENT_FACT_MISMATCH' }),
      }),
      tx,
    );
    expect(fulfillment.fulfillConfirmedOrder).not.toHaveBeenCalled();
  });

  it('routes a provider-payment identity collision to reconciliation without granting entitlement', async () => {
    const { audit, fulfillment, service, tx } = harness();
    const collision = attempt({ providerPaymentIdentity: 'payment-owned-by-another-attempt' });
    tx.commercePaymentAttempt.findUnique.mockResolvedValue(collision);
    tx.commercePaymentAttempt.findUniqueOrThrow.mockResolvedValue(collision);

    await expect(service.ingest({ data: {}, signature: 'signed' })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ error: 'PAYMENT_FACT_MISMATCH' }),
    });
    expect(tx.commerceReconciliationCase.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ reasonCode: 'PAYMENT_FACT_MISMATCH' }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reasonCode: 'PAYMENT_FACT_MISMATCH' }),
      }),
      tx,
    );
    expect(tx.commercePaymentEvent.create).not.toHaveBeenCalled();
    expect(tx.commerceSettlement.create).not.toHaveBeenCalled();
    expect(fulfillment.fulfillConfirmedOrder).not.toHaveBeenCalled();
  });

  it('does not mutate commerce or entitlement state for an unknown local payment', async () => {
    const { fulfillment, service, tx } = harness();
    tx.commercePaymentAttempt.findUnique.mockResolvedValue(null);

    await service.ingest({ data: {}, signature: 'signed' });

    expect(tx.commercePaymentEvent.create).not.toHaveBeenCalled();
    expect(tx.commerceSettlement.create).not.toHaveBeenCalled();
    expect(tx.commercePaymentAttempt.update).not.toHaveBeenCalled();
    expect(tx.commerceOrder.update).not.toHaveBeenCalled();
    expect(tx.commerceLifecycleEvent.create).not.toHaveBeenCalled();
    expect(tx.commerceReconciliationCase.create).not.toHaveBeenCalled();
    expect(tx.commercePromotionReservation.update).not.toHaveBeenCalled();
    expect(tx.voucherRedemption.create).not.toHaveBeenCalled();
    expect(tx.voucher.update).not.toHaveBeenCalled();
    expect(fulfillment.fulfillConfirmedOrder).not.toHaveBeenCalled();
    expect(fulfillment.dispatchPending).not.toHaveBeenCalled();
  });

  it('rejects altered authoritative payment facts without recording an event', async () => {
    const { service, tx } = harness();
    tx.commercePaymentAttempt.findUniqueOrThrow.mockResolvedValue(
      attempt({ amountMinor: 99999n }),
    );

    await expect(service.ingest({ data: {}, signature: 'signed' })).rejects.toMatchObject({
      status: 409,
    });
    expect(tx.commercePaymentEvent.create).not.toHaveBeenCalled();
  });

  it('rejects a verified receiving-account mismatch without retaining the raw account', async () => {
    const { provider, service, tx } = harness();
    provider.verifyWebhook.mockResolvedValue({
      ...verified,
      receivingAccount: 'different-receiving-account',
    });

    await expect(service.ingest({ data: {}, signature: 'signed' })).rejects.toMatchObject({
      status: 409,
    });
    expect(tx.commercePaymentEvent.create).not.toHaveBeenCalled();
  });

  it('records a second valid collection for reconciliation without fulfilling twice', async () => {
    const { service, tx } = harness();
    const paid = attempt({
      status: CommercePaymentStatus.paid,
      order: { id: 'order-id', status: CommerceOrderStatus.confirmed, reservations: [] },
    });
    tx.commercePaymentAttempt.findUnique.mockResolvedValue(paid);
    tx.commercePaymentAttempt.findUniqueOrThrow.mockResolvedValue(paid);

    await expect(service.ingest({ data: {}, signature: 'signed' })).resolves.toEqual({
      accepted: true,
      result: 'DUPLICATE',
    });
    expect(tx.commerceReconciliationCase.create).toHaveBeenCalledTimes(1);
    expect(tx.commerceOrder.update).not.toHaveBeenCalled();
  });

  it('moves a valid late settlement into review rather than ignoring it', async () => {
    const { service, tx } = harness();
    const expired = attempt({
      status: CommercePaymentStatus.expired,
      order: { id: 'order-id', status: CommerceOrderStatus.expired, reservations: [] },
    });
    tx.commercePaymentAttempt.findUnique.mockResolvedValue(expired);
    tx.commercePaymentAttempt.findUniqueOrThrow.mockResolvedValue(expired);

    await expect(service.ingest({ data: {}, signature: 'signed' })).resolves.toEqual({
      accepted: true,
      result: 'LATE_PAYMENT_REVIEW',
    });
    expect(tx.commercePaymentAttempt.update).toHaveBeenCalledWith({
      where: { id: 'attempt-id' },
      data: expect.objectContaining({ status: CommercePaymentStatus.late_paid }),
    });
    expect(tx.commerceOrder.update).toHaveBeenCalledWith({
      where: { id: 'order-id' },
      data: expect.objectContaining({ status: CommerceOrderStatus.late_payment_review }),
    });
  });

  it('retries a concurrent uniqueness conflict and returns the committed result', async () => {
    const { prisma, service, tx } = harness();
    const conflict = new Prisma.PrismaClientKnownRequestError('conflict', {
      code: 'P2002',
      clientVersion: 'test',
    });
    prisma.$transaction
      .mockRejectedValueOnce(conflict)
      .mockImplementationOnce(async (operation: (client: typeof tx) => Promise<unknown>) => {
        tx.commercePaymentEvent.findUnique.mockResolvedValue(priorEvent());
        return operation(tx);
      });

    await expect(service.ingest({ data: {}, signature: 'signed' })).resolves.toEqual({
      accepted: true,
      result: 'CONFIRMED',
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('rejects a signed non-settlement event before database access', async () => {
    const { prisma, provider, service } = harness();
    provider.verifyWebhook.mockResolvedValue({ ...verified, providerCode: '01' });

    await expect(service.ingest({ data: {}, signature: 'signed' })).rejects.toMatchObject({
      status: 400,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
