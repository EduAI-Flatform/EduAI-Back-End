import { PaymentProviderError } from '../payments/payment-provider';
import { GdsPayosQrPreviewService } from './gds-payos-qr-preview.service';

const buyerId = '11111111-1111-4111-8111-111111111111';
const topupId = '22222222-2222-4222-8222-222222222222';
const account = '1234567890';
const config = {
  app: { nodeEnv: 'test', deploymentClass: 'uat', publicAppUrl: 'https://uat.example.org' },
  gdsWallet: { sandboxEnabled: true, qrPreviewEnabled: true },
  payos: { environment: 'production' },
  commerce: { idempotencySecret: 'test-idempotency-secret' },
};
const prep = { prepare: jest.fn() };
const links = { attachCreatedLink: jest.fn() };
const payos = { createPaymentRequest: jest.fn(), retrievePaymentRequest: jest.fn() };
const providers = { requireEnabled: jest.fn(() => payos) };
const service = new GdsPayosQrPreviewService(config as never, prep as never, links as never, providers as never);

beforeEach(() => {
  jest.clearAllMocks();
  config.app.nodeEnv = 'test'; config.app.deploymentClass = 'uat';
  config.gdsWallet.sandboxEnabled = true; config.gdsWallet.qrPreviewEnabled = true;
  config.payos.environment = 'production';
  prep.prepare.mockResolvedValue({
    intent: { id: topupId, status: 'CREATED' },
    payosRequest: {
      orderCode: 123456, amount: 250000, description: 'G00002N9C',
      returnUrl: 'https://uat.example.org/wallet/gds',
      cancelUrl: 'https://uat.example.org/wallet/gds',
      expiredAt: 1793614500,
    },
  });
  payos.createPaymentRequest.mockResolvedValue({
    providerPaymentIdentity: 'provider_link', providerOrderReference: '123456',
    localOrderReference: 123456, amountMinor: 250000n, currency: 'VND', status: 'PENDING',
    receivingAccount: account, qrPayload: '00020101021238',
    checkoutUrl: 'https://pay.payos.vn/web/provider_link',
  });
  links.attachCreatedLink.mockResolvedValue({
    qrPayload: '00020101021238', checkoutUrl: 'https://pay.payos.vn/web/provider_link', paymentLinkId: 'provider_link',
  });
});

describe('GDS UAT PayOS QR creation, without funding', () => {
  it('creates a real SDK request using the reserved exact VND, memo and PayOS-provided recipient account', async () => {
    const output = await service.create(buyerId, '250000', 'idempotency-unit-123');
    expect(prep.prepare).toHaveBeenCalledWith(expect.objectContaining({
      buyerId, amountMinor: 250000n, idempotencyKey: 'idempotency-unit-123',
      urls: { returnUrl: 'https://uat.example.org/wallet/gds', cancelUrl: 'https://uat.example.org/wallet/gds' },
    }));
    expect(providers.requireEnabled).toHaveBeenCalledWith('payos');
    expect(payos.createPaymentRequest).toHaveBeenCalledWith(expect.objectContaining({
      amountMinor: 250000n, description: 'G00002N9C',
      providerOrderReference: '123456', localOrderReference: 123456,
      currency: 'VND', paymentAttemptIdentity: topupId,
    }));
    expect(links.attachCreatedLink).toHaveBeenCalledWith(topupId, expect.objectContaining({
      amountMinor: 250000n, receivingAccount: account,
    }));
    expect(output).toMatchObject({
      amountMinor: '250000', transferMemo: 'G00002N9C', receivingAccount: account,
      status: 'AWAITING_TRANSFER', gdsCredited: false,
    });
    expect(output.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(output).not.toHaveProperty('balance');
  });

  it.each([
    ['feature off', 'test', 'uat', true, false],
    ['disabled wallet', 'test', 'uat', false, true],
    ['production runtime', 'production', 'uat', true, true],
    ['production deployment', 'test', 'production', true, true],
  ])('refuses %s without reserving money or calling PayOS', async (_label, nodeEnv, deploymentClass, sandboxEnabled, qrPreviewEnabled) => {
    config.app.nodeEnv = nodeEnv; config.app.deploymentClass = deploymentClass;
    config.gdsWallet.sandboxEnabled = sandboxEnabled; config.gdsWallet.qrPreviewEnabled = qrPreviewEnabled;
    await expect(service.create(buyerId, '250000', 'idempotency-unit-123')).rejects.toThrow();
    expect(prep.prepare).not.toHaveBeenCalled();
    expect(payos.createPaymentRequest).not.toHaveBeenCalled();
  });

  it.each(['0', '1000', '10000001', '100.5', '01', 'not-money'])('rejects invalid amount %s before touching data', async (amount) => {
    await expect(service.create(buyerId, amount, 'idempotency-unit-123')).rejects.toThrow();
    expect(prep.prepare).not.toHaveBeenCalled();
  });

  it('does not require a separately configured merchant account number', async () => {
    const result = await service.create(buyerId, '250000', 'idempotency-unit-123');
    expect(result.receivingAccount).toBe(account);
    expect(prep.prepare.mock.calls[0][0]).not.toHaveProperty('receivingAccountHash');
  });

  it('does not call PayOS again for an already-created intent', async () => {
    prep.prepare.mockResolvedValue({ intent: { id: topupId, status: 'PENDING_PAYOS' }, payosRequest: null });
    await expect(service.create(buyerId, '250000', 'idempotency-unit-123')).rejects.toThrow();
    expect(payos.createPaymentRequest).not.toHaveBeenCalled();
  });

  it('never returns a payment QR without an SDK QR payload', async () => {
    links.attachCreatedLink.mockResolvedValue({ qrPayload: null, checkoutUrl: 'https://pay.payos.vn/web/provider_link' });
    await expect(service.create(buyerId, '250000', 'idempotency-unit-123')).rejects.toThrow();
  });

  it('requires an idempotency key on every request', async () => {
    await expect(service.create(buyerId, '250000', undefined)).rejects.toThrow();
    expect(prep.prepare).not.toHaveBeenCalled();
  });
});

it('queries the existing order after PayOS succeeds but persistence fails; never creates twice', async () => {
  links.attachCreatedLink.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(service.create(buyerId, '250000', 'idempotency-unit-123')).rejects.toThrow();
  const first = prep.prepare.mock.results[0];
  const prepared = await first.value;
  prep.prepare.mockResolvedValue({ ...prepared, reused: true });
  payos.retrievePaymentRequest.mockResolvedValue({
    providerPaymentIdentity: 'provider_link', localOrderReference: 123456,
    amountMinor: 250000n, amountPaidMinor: 0n, amountRemainingMinor: 250000n,
    status: 'PENDING', receivingAccount: null, transactions: [],
  });
  await expect(service.create(buyerId, '250000', 'idempotency-unit-123'))
    .rejects.toThrow('GDS_TOPUP_RECOVERY_REQUIRES_PAYOS_QR');
  expect(payos.retrievePaymentRequest).toHaveBeenCalledWith('123456');
  expect(payos.createPaymentRequest).toHaveBeenCalledTimes(1);
  expect(links.attachCreatedLink).toHaveBeenCalledTimes(1);
});

it.each(['timeout', 'invalid_signature', 'malformed_response', 'rejected'] as const)(
  'does not treat a recovery %s as permission to create another link', async (code) => {
    const prepared = await prep.prepare();
    prep.prepare.mockResolvedValue({ ...prepared, reused: true });
    payos.retrievePaymentRequest.mockRejectedValue(new PaymentProviderError(code, false));
    await expect(service.create(buyerId, '250000', 'idempotency-unit-123')).rejects.toThrow();
    expect(payos.createPaymentRequest).not.toHaveBeenCalled();
    expect(links.attachCreatedLink).not.toHaveBeenCalled();
  },
);

it.each([
  { localOrderReference: 654321 }, { amountMinor: 1n },
  { status: 'PAID' }, { status: 'UNDERPAID' }, { status: 'EXPIRED' },
  { amountPaidMinor: 1n }, { amountRemainingMinor: 249999n },
])('rejects mismatched or non-pending recovered facts without mutation', async (patch) => {
  const prepared = await prep.prepare();
  prep.prepare.mockResolvedValue({ ...prepared, reused: true });
  payos.retrievePaymentRequest.mockResolvedValue({
    providerPaymentIdentity: 'provider_link', localOrderReference: 123456,
    amountMinor: 250000n, amountPaidMinor: 0n, amountRemainingMinor: 250000n,
    status: 'PENDING', transactions: [], ...patch,
  });
  await expect(service.create(buyerId, '250000', 'idempotency-unit-123'))
    .rejects.toThrow('GDS_TOPUP_PAYOS_RECOVERY_MISMATCH');
  expect(payos.createPaymentRequest).not.toHaveBeenCalled();
  expect(links.attachCreatedLink).not.toHaveBeenCalled();
});

it('does not persist a pending link when the authenticated QR cannot be encoded', async () => {
  const created = await payos.createPaymentRequest();
  payos.createPaymentRequest.mockResolvedValue({ ...created, qrPayload: 'x'.repeat(8192) });
  links.attachCreatedLink.mockResolvedValue({
    paymentLinkId: 'provider_link', checkoutUrl: created.checkoutUrl, qrPayload: 'x'.repeat(8192),
  });
  await expect(service.create(buyerId, '250000', 'idempotency-unit-123'))
    .rejects.toThrow('GDS_TOPUP_PAYOS_QR_ENCODING_FAILED');
  expect(links.attachCreatedLink).not.toHaveBeenCalled();
});
