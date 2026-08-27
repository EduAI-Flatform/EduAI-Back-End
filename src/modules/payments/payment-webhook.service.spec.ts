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

function attempt(overrides: Record<string, unknown> = {}) {
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
    order: {
      id: 'order-id',
      status: CommerceOrderStatus.pending_payment,
      reservations: [],
    },
    ...overrides,
  };
}

function harness() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    commercePaymentEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
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
    commerceReconciliationCase: { create: jest.fn().mockResolvedValue({}) },
    commercePromotionReservation: { update: jest.fn().mockResolvedValue({}) },
    voucherRedemption: { create: jest.fn().mockResolvedValue({}) },
    voucher: { update: jest.fn().mockResolvedValue({}) },
  };
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
          voucherId: null,
          expiresAt: new Date('2026-08-26T09:00:00.000Z'),
          benefitSnapshot: { allocatedDiscountAmountMinor: 1000n },
          orderLine: {
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
    tx.commercePaymentEvent.findUnique.mockResolvedValue({
      settlement: {
        orderId: 'order-id',
        disposition: CommerceSettlementDisposition.matched,
      },
    });

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
        tx.commercePaymentEvent.findUnique.mockResolvedValueOnce({
          settlement: { disposition: CommerceSettlementDisposition.matched },
        });
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
