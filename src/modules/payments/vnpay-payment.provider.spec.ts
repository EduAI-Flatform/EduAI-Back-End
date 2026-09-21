import { VnPayPaymentProvider, canonicalizeVnPayParams } from './vnpay-payment.provider';

const config = {
  environment: 'sandbox' as const,
  tmnCode: 'TESTTMNC',
  hashSecret: 'test-secret',
  paymentUrl: 'https://sandbox.vnpayment.vn/paymentv2/vpcpay.html',
  returnUrl: 'https://app.example/payments/return',
  ipnUrl: 'https://api.example/payments/ipn',
  version: '2.1.0',
  timeoutMs: 10000,
};

const now = new Date('2026-09-22T01:46:40.000Z');
const expiresAt = new Date('2026-09-22T02:01:40.000Z');

function input(overrides: Record<string, unknown> = {}) {
  return {
    paymentAttemptIdentity: '33333333-3333-4333-8333-333333333333',
    providerOrderReference: '9001',
    localOrderReference: 9001,
    amountMinor: 125000n,
    currency: 'VND' as const,
    description: 'EDUAI ORDER 1',
    returnUrls: {
      success: 'https://app.example/payments/return?orderId=order-1',
      cancel: 'https://app.example/payments/cancel?orderId=order-1',
    },
    clientIpAddress: '127.0.0.1',
    expiresAt,
    ...overrides,
  };
}

describe('VnPayPaymentProvider', () => {
  it('canonicalizes sorted form parameters and encodes spaces deterministically', () => {
    expect(
      canonicalizeVnPayParams({
        vnp_OrderInfo: 'EDUAI ORDER 1',
        vnp_Amount: '12500000',
        vnp_Empty: '',
      }),
    ).toBe('vnp_Amount=12500000&vnp_OrderInfo=EDUAI+ORDER+1');
  });

  it('creates a deterministic signed URL from canonical server-side payment data', async () => {
    const provider = new VnPayPaymentProvider(config, () => now);

    const created = await provider.createPaymentRequest(input());
    const url = new URL(created.checkoutUrl);

    expect(created).toMatchObject({
      providerPaymentIdentity: '9001',
      providerOrderReference: '9001',
      localOrderReference: 9001,
      amountMinor: 125000n,
      currency: 'VND',
      status: 'PENDING',
      expiresAt,
    });
    expect(created.qrPayload).toBeUndefined();
    expect(created.receivingAccount).toBeUndefined();
    expect(url.searchParams.get('vnp_Version')).toBe('2.1.0');
    expect(url.searchParams.get('vnp_Command')).toBe('pay');
    expect(url.searchParams.get('vnp_TmnCode')).toBe('TESTTMNC');
    expect(url.searchParams.get('vnp_Amount')).toBe('12500000');
    expect(url.searchParams.get('vnp_CurrCode')).toBe('VND');
    expect(url.searchParams.get('vnp_TxnRef')).toBe('9001');
    expect(url.searchParams.get('vnp_OrderInfo')).toBe('EDUAI ORDER 1');
    expect(url.searchParams.get('vnp_OrderType')).toBe('other');
    expect(url.searchParams.get('vnp_Locale')).toBe('vn');
    expect(url.searchParams.get('vnp_ReturnUrl')).toBe(
      'https://app.example/payments/return?orderId=order-1',
    );
    expect(url.searchParams.get('vnp_IpAddr')).toBe('127.0.0.1');
    expect(url.searchParams.get('vnp_CreateDate')).toBe('20260922084640');
    expect(url.searchParams.get('vnp_ExpireDate')).toBe('20260922090140');
    expect(url.searchParams.get('vnp_SecureHashType')).toBeNull();
    expect(url.searchParams.get('vnp_SecureHash')).toBe(
      '3f9d3cffeb58591bd22d228ad684aa226e8640628d6f6837ef33c0fbceef32821071f81e8c691818b3e6157e9210aa988afdc85835899d1819dc14f19d25b056',
    );
    expect(created.checkoutUrl).not.toContain(config.hashSecret);
    expect(created.checkoutUrl).not.toContain('vnp_IpNUrl');
  });

  it('keeps the provider reference and signed URL stable for the same attempt', async () => {
    const provider = new VnPayPaymentProvider(config, () => now);

    const first = await provider.createPaymentRequest(input());
    const second = await provider.createPaymentRequest(input());

    expect(second.providerOrderReference).toBe(first.providerOrderReference);
    expect(second.checkoutUrl).toBe(first.checkoutUrl);
  });

  it('omits optional empty presentation fields without inventing VNPay parameters', async () => {
    const provider = new VnPayPaymentProvider(config, () => now);

    const created = await provider.createPaymentRequest(
      input({ returnUrls: { success: 'https://app.example/return', cancel: '' } }),
    );
    const url = new URL(created.checkoutUrl);

    expect(url.searchParams.get('vnp_ReturnUrl')).toBe('https://app.example/return');
    expect(url.searchParams.get('vnp_CancelUrl')).toBeNull();
    expect(url.searchParams.get('vnp_IpNUrl')).toBeNull();
  });

  it.each([
    ['zero amount', { amountMinor: 0n }],
    ['negative amount', { amountMinor: -1n }],
    ['unsupported currency', { currency: 'USD' }],
    ['amount overflow', { amountMinor: 10000000000n }],
    ['non-numeric provider reference', { providerOrderReference: 'user-9001' }],
    ['missing client IP', { clientIpAddress: undefined }],
  ])('rejects %s before constructing a payment URL', async (_name, overrides) => {
    const provider = new VnPayPaymentProvider(config, () => now);

    await expect(provider.createPaymentRequest(input(overrides))).rejects.toMatchObject({
      code: 'invalid_request',
      retryable: false,
    });
  });

  it('fails closed when disabled and does not implement settlement operations yet', async () => {
    const disabled = new VnPayPaymentProvider(
      { ...config, environment: 'disabled' },
      () => now,
    );

    await expect(disabled.createPaymentRequest(input())).rejects.toMatchObject({
      code: 'disabled',
      retryable: false,
    });
    await expect(disabled.retrievePaymentRequest('9001')).rejects.toMatchObject({
      code: 'unsupported',
      retryable: false,
    });
    await expect(disabled.verifyWebhook({ body: {}, headers: {} })).rejects.toMatchObject({
      code: 'unsupported',
      retryable: false,
    });
  });
});
