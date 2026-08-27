import { createHmac } from 'node:crypto';
import {
  APIError,
  ConnectionTimeoutError,
  InvalidSignatureError,
  PayOS,
} from '@payos/node';
import { PayosPaymentProvider } from './payos-payment.provider';

describe('PayosPaymentProvider', () => {
  const validCreated = {
    accountNumber: 'receiving-account',
    amount: 125000,
    checkoutUrl: 'https://pay.payos.vn/web/example',
    currency: 'VND',
    description: 'EDUAI 123',
    expiredAt: 1790000000,
    orderCode: 123,
    paymentLinkId: 'payment-link-id',
    qrCode: '000201010212',
    status: 'PENDING',
  };
  const validStatus = {
    amount: 125000,
    amountPaid: 0,
    amountRemaining: 125000,
    cancellationReason: null,
    canceledAt: null,
    createdAt: '2026-08-26T10:00:00Z',
    id: 'payment-link-id',
    orderCode: 123,
    status: 'PENDING',
    transactions: [],
  };

  function setup() {
    const client = {
      paymentRequests: {
        cancel: jest.fn(),
        create: jest.fn(),
        get: jest.fn(),
      },
      webhooks: { verify: jest.fn() },
    };
    return { client, provider: new PayosPaymentProvider(client) };
  }

  it('normalizes create, retrieve, cancel, and reconcile responses without PayOS types', async () => {
    const { client, provider } = setup();
    client.paymentRequests.create.mockResolvedValue(validCreated);
    client.paymentRequests.get.mockResolvedValue(validStatus);
    client.paymentRequests.cancel.mockResolvedValue({
      ...validStatus,
      status: 'CANCELLED',
      cancellationReason: 'expired locally',
      canceledAt: '2026-08-26T10:05:00Z',
    });

    await expect(
      provider.createPaymentRequest({
        amountMinor: 125000n,
        currency: 'VND',
        description: 'EDUAI 123',
        expiresAt: new Date('2026-09-22T01:46:40Z'),
        localOrderReference: 123,
        paymentAttemptIdentity: 'attempt-id',
        returnUrls: {
          cancel: 'https://app.example/cancel',
          success: 'https://app.example/return',
        },
      }),
    ).resolves.toMatchObject({
      amountMinor: 125000n,
      currency: 'VND',
      providerPaymentIdentity: 'payment-link-id',
      receivingAccount: 'receiving-account',
      status: 'PENDING',
    });
    await expect(provider.retrievePaymentRequest('payment-link-id')).resolves.toMatchObject({
      amountMinor: 125000n,
      amountPaidMinor: 0n,
      providerPaymentIdentity: 'payment-link-id',
      status: 'PENDING',
    });
    await expect(
      provider.cancelPaymentRequest('payment-link-id', 'expired locally'),
    ).resolves.toMatchObject({ status: 'CANCELLED' });
    await expect(provider.reconcilePaymentRequest('payment-link-id')).resolves.toMatchObject({
      providerPaymentIdentity: 'payment-link-id',
      status: 'PENDING',
      transactions: [],
    });

    expect(client.paymentRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 125000, orderCode: 123 }),
      { maxRetries: 0 },
    );
  });

  it('normalizes bounded settlement facts used for missed-webhook recovery', async () => {
    const { client, provider } = setup();
    client.paymentRequests.get.mockResolvedValue({
      ...validStatus,
      amountPaid: 125000,
      amountRemaining: 0,
      status: 'PAID',
      transactions: [{
        accountNumber: 'receiving-account',
        amount: 125000,
        reference: 'settlement-reference',
        transactionDateTime: '2026-08-26 17:00:00',
      }],
    });

    await expect(provider.reconcilePaymentRequest('payment-link-id')).resolves.toMatchObject({
      status: 'PAID',
      transactions: [{
        amountMinor: 125000n,
        occurredAt: new Date('2026-08-26T17:00:00+07:00'),
        receivingAccount: 'receiving-account',
        reference: 'settlement-reference',
      }],
    });
  });

  it('rejects malformed provider responses before returning them', async () => {
    const { client, provider } = setup();
    client.paymentRequests.create.mockResolvedValue({
      ...validCreated,
      checkoutUrl: 'javascript:alert(1)',
    });

    await expect(
      provider.createPaymentRequest({
        amountMinor: 125000n,
        currency: 'VND',
        description: 'EDUAI 123',
        localOrderReference: 123,
        paymentAttemptIdentity: 'attempt-id',
        returnUrls: {
          cancel: 'https://app.example/cancel',
          success: 'https://app.example/return',
        },
      }),
    ).rejects.toMatchObject({ code: 'malformed_response', retryable: false });

    client.paymentRequests.create.mockResolvedValue({
      ...validCreated,
      amount: 124999,
    });
    await expect(
      provider.createPaymentRequest({
        amountMinor: 125000n,
        currency: 'VND',
        description: 'EDUAI 123',
        localOrderReference: 123,
        paymentAttemptIdentity: 'attempt-id',
        returnUrls: {
          cancel: 'https://app.example/cancel',
          success: 'https://app.example/return',
        },
      }),
    ).rejects.toMatchObject({ code: 'malformed_response', retryable: false });
  });

  it('verifies and normalizes webhook data without retaining the raw envelope', async () => {
    const { client, provider } = setup();
    client.webhooks.verify.mockResolvedValue({
      accountNumber: 'receiving-account',
      amount: 125000,
      code: '00',
      currency: 'VND',
      orderCode: 123,
      paymentLinkId: 'payment-link-id',
      reference: 'settlement-reference',
      transactionDateTime: '2026-08-26 17:00:00',
    });

    await expect(
      provider.verifyWebhook({
        body: { data: {}, signature: 'bounded-signature' },
        headers: { 'content-type': 'application/json' },
      }),
    ).resolves.toEqual({
      amountMinor: 125000n,
      currency: 'VND',
      localOrderReference: 123,
      occurredAt: new Date('2026-08-26T17:00:00+07:00'),
      providerCode: '00',
      providerEventIdentity: 'settlement-reference',
      providerPaymentIdentity: 'payment-link-id',
      providerSettlementReference: 'settlement-reference',
      receivingAccount: 'receiving-account',
    });
  });

  it('uses the official SDK verifier for a canonical signature and altered field', async () => {
    const checksumKey = 'test-checksum-key-not-a-production-secret';
    const data = {
      accountNumber: 'receiving-account',
      amount: 125000,
      code: '00',
      currency: 'VND',
      orderCode: 123,
      paymentLinkId: 'payment-link-id',
      reference: 'settlement-reference',
      transactionDateTime: '2026-08-26 17:00:00',
    };
    const canonical = Object.keys(data)
      .sort()
      .map((key) => `${key}=${data[key as keyof typeof data]}`)
      .join('&');
    const signature = createHmac('sha256', checksumKey)
      .update(canonical)
      .digest('hex');
    const client = new PayOS({
      apiKey: 'test-api-key',
      checksumKey,
      clientId: 'test-client-id',
      logger: null,
      logLevel: 'off',
      maxRetries: 0,
    });
    const provider = new PayosPaymentProvider(client);

    await expect(
      provider.verifyWebhook({ body: { data, signature }, headers: {} }),
    ).resolves.toMatchObject({
      amountMinor: 125000n,
      providerSettlementReference: 'settlement-reference',
    });
    await expect(
      provider.verifyWebhook({
        body: { data: { ...data, amount: 125001 }, signature },
        headers: {},
      }),
    ).rejects.toMatchObject({ code: 'invalid_signature', retryable: false });
  });

  it('maps timeouts, provider rejection, and invalid signatures to sanitized errors', async () => {
    const { client, provider } = setup();
    client.paymentRequests.get.mockRejectedValueOnce(
      new ConnectionTimeoutError('contains-sensitive-provider-details'),
    );
    await expect(provider.retrievePaymentRequest('payment-link-id')).rejects.toEqual(
      expect.objectContaining({ code: 'timeout', retryable: true }),
    );

    client.paymentRequests.get.mockRejectedValueOnce(
      new APIError(400, {}, 'contains-provider-body', new Headers()),
    );
    await expect(provider.retrievePaymentRequest('payment-link-id')).rejects.toEqual(
      expect.objectContaining({ code: 'rejected', retryable: false }),
    );

    client.webhooks.verify.mockRejectedValueOnce(
      new InvalidSignatureError('contains-signature'),
    );
    await expect(
      provider.verifyWebhook({
        body: { data: {}, signature: 'invalid-signature' },
        headers: {},
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'invalid_signature', retryable: false }),
    );
  });

  it('does not log credentials, raw provider errors, or webhook input', async () => {
    const { client, provider } = setup();
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    client.paymentRequests.get.mockRejectedValue(
      new Error('client-secret raw-provider-response signature'),
    );

    await expect(provider.retrievePaymentRequest('payment-link-id')).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(consoleSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
