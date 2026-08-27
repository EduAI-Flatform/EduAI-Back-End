import {
  BadGatewayException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentProviderError } from './payment-provider';
import { PaymentRequestService } from './payment-request.service';

const now = new Date();
const attemptId = '22222222-2222-4222-8222-222222222222';
const orderId = '11111111-1111-4111-8111-111111111111';

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: orderId,
    orderNumber: 'EDU-ORDER-PAYOS-1',
    buyerId: 'student-id',
    status: 'pending_payment',
    fulfillmentStatus: 'not_started',
    payableAmountMinor: 125000n,
    currency: 'VND',
    membershipCheckoutIntent: null,
    reservations: [{ expiresAt: new Date(now.getTime() + 10 * 60_000) }],
    paymentAttempts: [],
    ...overrides,
  };
}

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    id: attemptId,
    orderId,
    provider: 'payos',
    localRequestIdentity: '33333333-3333-4333-8333-333333333333',
    providerPaymentIdentity: null,
    providerOrderCode: 9001n,
    providerExpiresAt: new Date(now.getTime() + 10 * 60_000),
    providerRequestStartedAt: now,
    status: 'created',
    statusOperationId: null,
    amountMinor: 125000n,
    currency: 'VND',
    createdAt: now,
    updatedAt: now,
    paidAt: null,
    closedAt: null,
    providerStatusCheckedAt: null,
    providerCancellationRequestedAt: null,
    ...overrides,
  };
}

function harness(options: {
  environment?: 'disabled' | 'production';
  payableAmountMinor?: bigint;
  existingAttempt?: ReturnType<typeof attempt> | null;
} = {}) {
  const payableAmountMinor = options.payableAmountMinor ?? 125000n;
  const initialOrder = order({
    payableAmountMinor,
    membershipCheckoutIntent: payableAmountMinor === 0n ? { id: 'intent-id' } : null,
    reservations: payableAmountMinor === 0n ? [] : order().reservations,
  });
  const createdAttempt = attempt({ amountMinor: payableAmountMinor || 125000n });
  const pendingAttempt = attempt({
    amountMinor: payableAmountMinor || 125000n,
    providerPaymentIdentity: 'provider-payment-id',
    status: 'pending',
  });
  const events: string[] = [];
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: orderId }]),
    commerceIdempotencyRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'idempotency-id' }),
    },
    commerceOrder: {
      findFirst: jest
        .fn()
        .mockResolvedValueOnce(initialOrder)
        .mockResolvedValue(order({
          ...initialOrder,
          paymentAttempts: [pendingAttempt],
          status: payableAmountMinor === 0n ? 'confirmed' : 'pending_payment',
        })),
      update: jest.fn().mockResolvedValue({}),
    },
    commercePaymentAttempt: {
      findFirst: jest.fn().mockResolvedValue(options.existingAttempt ?? null),
      findUnique: jest.fn().mockResolvedValue(createdAttempt),
      create: jest.fn().mockResolvedValue(createdAttempt),
      update: jest.fn().mockResolvedValue(pendingAttempt),
    },
    commerceLifecycleEvent: { create: jest.fn().mockResolvedValue({}) },
    commerceSettlement: { create: jest.fn().mockResolvedValue({ id: 'settlement-id' }) },
  };
  const prisma = {
    commerceOrder: {
      findFirst: jest.fn().mockResolvedValue({ payableAmountMinor }),
    },
    $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      events.push('transaction:start');
      const result = await callback(tx);
      events.push('transaction:end');
      return result;
    }),
  };
  const provider = {
    createPaymentRequest: jest.fn(async () => {
      events.push('provider');
      return {
        providerPaymentIdentity: 'provider-payment-id',
        localOrderReference: 9001,
        amountMinor: 125000n,
        currency: 'VND' as const,
        status: 'PENDING' as const,
        checkoutUrl: 'https://pay.payos.vn/web/example',
        qrPayload: '00020101021238570010A000000727012700069704220113TESTPAYMENT',
        receivingAccount: 'receiving-account',
        expiresAt: new Date(now.getTime() + 10 * 60_000),
      };
    }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const fulfillment = {
    fulfillConfirmedOrder: jest.fn().mockResolvedValue(undefined),
    dispatchPending: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    commerce: { idempotencySecret: 's'.repeat(32) },
    payos: {
      environment: options.environment ?? 'production',
      returnUrl: 'https://app.example/payments/return',
      cancelUrl: 'https://app.example/payments/cancel',
    },
  };
  return {
    service: new PaymentRequestService(
      prisma as never,
      config as never,
      audit as never,
      provider as never,
      fulfillment as never,
    ),
    prisma,
    tx,
    provider,
    audit,
    fulfillment,
    events,
    initialOrder,
    createdAttempt,
    pendingAttempt,
  };
}

describe('PaymentRequestService', () => {
  it('commits the local attempt before calling PayOS and returns a short-lived QR response', async () => {
    const { service, provider, tx, events, audit } = harness();

    await expect(service.create('student-id', orderId, 'payment-key-1')).resolves.toMatchObject({
      orderId,
      orderStatus: 'PENDING_PAYMENT',
      paymentRequired: true,
      payment: {
        id: attemptId,
        status: 'PENDING',
        amount: { amountMinor: '125000', currency: 'VND' },
        checkoutUrl: 'https://pay.payos.vn/web/example',
        qrCodeDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
      },
    });

    expect(events).toEqual([
      'transaction:start',
      'transaction:end',
      'provider',
      'transaction:start',
      'transaction:end',
    ]);
    expect(provider.createPaymentRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        amountMinor: 125000n,
        currency: 'VND',
        returnUrls: {
          success: 'https://app.example/payments/return',
          cancel: 'https://app.example/payments/cancel',
        },
      }),
    );
    expect(tx.commercePaymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'pending' }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({
          checkoutUrl: expect.anything(),
          qrPayload: expect.anything(),
        }),
      }),
      tx,
    );
  });

  it('reuses an open local attempt without making a second provider call', async () => {
    const open = attempt({ status: 'pending', providerPaymentIdentity: 'provider-payment-id' });
    const { service, provider, tx } = harness({ existingAttempt: open });

    await expect(service.create('student-id', orderId, 'payment-key-2')).resolves.toMatchObject({
      payment: { id: attemptId, status: 'PENDING' },
    });
    expect(provider.createPaymentRequest).not.toHaveBeenCalled();
    expect(tx.commercePaymentAttempt.create).not.toHaveBeenCalled();
  });

  it('keeps an ambiguous timeout in created state for reconciliation', async () => {
    const { service, provider, tx } = harness();
    provider.createPaymentRequest.mockRejectedValueOnce(
      new PaymentProviderError('timeout', true),
    );

    await expect(service.create('student-id', orderId, 'payment-key-3')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(tx.commercePaymentAttempt.update).not.toHaveBeenCalled();
  });

  it('keeps a malformed success response in created state for reconciliation', async () => {
    const { service, provider, tx } = harness();
    provider.createPaymentRequest.mockRejectedValueOnce(
      new PaymentProviderError('malformed_response', false),
    );

    await expect(service.create('student-id', orderId, 'payment-key-malformed')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(tx.commercePaymentAttempt.update).not.toHaveBeenCalled();
  });

  it('closes a deterministically rejected attempt with safe lifecycle evidence', async () => {
    const { service, provider, tx, audit } = harness();
    provider.createPaymentRequest.mockRejectedValueOnce(
      new PaymentProviderError('rejected', false),
    );

    await expect(service.create('student-id', orderId, 'payment-key-4')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(tx.commercePaymentAttempt.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ reasonCode: 'rejected' }) }),
      tx,
    );
  });

  it('confirms a zero-payable membership without requiring or calling PayOS', async () => {
    const { fulfillment, service, provider, tx } = harness({
      environment: 'disabled',
      payableAmountMinor: 0n,
    });

    await expect(service.create('student-id', orderId, 'payment-key-5')).resolves.toMatchObject({
      orderStatus: 'CONFIRMED',
      paymentRequired: false,
      payment: null,
    });
    expect(provider.createPaymentRequest).not.toHaveBeenCalled();
    expect(tx.commerceSettlement.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amountMinor: 0n }) }),
    );
    expect(fulfillment.fulfillConfirmedOrder).toHaveBeenCalledWith(
      tx,
      orderId,
      'user',
      'student-id',
    );
  });

  it('fails closed before mutation when a positive order has no active provider', async () => {
    const { service, prisma, provider } = harness({ environment: 'disabled' });

    await expect(service.create('student-id', orderId, 'payment-key-6')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(provider.createPaymentRequest).not.toHaveBeenCalled();
  });

  it('returns not found for an order outside learner ownership', async () => {
    const { service, prisma } = harness();
    prisma.commerceOrder.findFirst.mockResolvedValueOnce(null);

    await expect(service.create('other-student', orderId, 'payment-key-7')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
