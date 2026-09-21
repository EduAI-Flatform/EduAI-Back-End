import { createHmac } from 'node:crypto';
import {
  canonicalizeVnPayIpnParams,
} from './vnpay-payment.provider';
import {
  isWellFormedVnPayQueryEncoding,
  normalizeVnPayIpn,
  parseVnPayIpnQuery,
  VnPayIpnService,
} from './vnpay-ipn.service';
import { PaymentWebhookService } from './payment-webhook.service';
import { AppConfigService } from '../../config/app-config.service';

const SECRET = 'test-vnpay-hmac-secret';
const TMN_CODE = 'TESTTMNC';
const BASE_PARAMS = {
  vnp_Version: '2.1.0',
  vnp_Command: 'pay',
  vnp_TmnCode: TMN_CODE,
  vnp_Amount: '10000000',
  vnp_CurrCode: 'VND',
  vnp_BankCode: 'NCB',
  vnp_OrderInfo: 'Thanh toan don hang 1001',
  vnp_PayDate: '20260826170000',
  vnp_ResponseCode: '00',
  vnp_TxnRef: '1001',
  vnp_TransactionNo: '12996460',
  vnp_TransactionStatus: '00',
};

function signedParams(overrides: Record<string, string> = {}) {
  const params = { ...BASE_PARAMS, ...overrides };
  const signature = createHmac('sha512', SECRET)
    .update(canonicalizeVnPayIpnParams(params), 'utf8')
    .digest('hex');
  return { ...params, vnp_SecureHash: signature };
}

function serviceHarness() {
  const webhook = {
    processVerified: jest.fn().mockResolvedValue({
      accepted: true,
      result: 'CONFIRMED',
    }),
    classifyVerified: jest.fn().mockResolvedValue('KNOWN'),
  };
  const config = {
    vnpay: {
      environment: 'sandbox',
      tmnCode: TMN_CODE,
      hashSecret: SECRET,
      version: '2.1.0',
    },
  };
  return {
    service: new VnPayIpnService(
      config as unknown as AppConfigService,
      webhook as unknown as PaymentWebhookService,
    ),
    webhook,
  };
}

describe('VnPayIpnService', () => {
  it('normalizes a valid signed VND payment and settles through the canonical service', async () => {
    const { service, webhook } = serviceHarness();
    const query = signedParams();

    await expect(service.handle(query)).resolves.toEqual({
      RspCode: '00',
      Message: 'Confirm Success',
    });
    expect(webhook.processVerified).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'vnpay',
      providerOrderReference: '1001',
      providerPaymentIdentity: '1001',
      providerSettlementReference: '12996460',
      amountMinor: 100000n,
      currency: 'VND',
      providerCode: '00',
      responseCode: '00',
      transactionStatus: '00',
      occurredAt: new Date('2026-08-26T10:00:00.000Z'),
    }));
  });

  it('uses a stable provider-scoped event identity for the same signed facts', () => {
    const first = normalizeVnPayIpn(signedParams(), {
      tmnCode: TMN_CODE,
      version: '2.1.0',
    });
    const second = normalizeVnPayIpn(signedParams(), {
      tmnCode: TMN_CODE,
      version: '2.1.0',
    });

    expect(first.providerEventIdentity).toBe(second.providerEventIdentity);
    expect(first.providerEventIdentity).toMatch(/^vnpay:[0-9a-f]{64}$/);
    expect(first.providerEventIdentity).not.toContain(SECRET);
  });

  it('does not expose the secret or raw signed payload through response/log output', async () => {
    const { service } = serviceHarness();
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();

    try {
      const result = await service.handle(signedParams());
      expect(JSON.stringify(result)).not.toContain(SECRET);
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('returns 97 and performs no database-facing processing for a bad checksum', async () => {
    const { service, webhook } = serviceHarness();
    const query = signedParams({ vnp_Amount: '10000001' });

    await expect(service.handle({ ...query, vnp_Amount: '10000000' })).resolves.toEqual({
      RspCode: '97',
      Message: 'Invalid signature',
    });
    expect(webhook.processVerified).not.toHaveBeenCalled();
  });

  it('returns 97 for tampered signed transaction references before any lookup', async () => {
    const { service, webhook } = serviceHarness();
    const query = signedParams();

    await expect(service.handle({ ...query, vnp_TxnRef: '2002' })).resolves.toMatchObject({
      RspCode: '97',
    });
    expect(webhook.processVerified).not.toHaveBeenCalled();
  });

  it('rejects duplicate or ambiguous query parameters before checksum processing', async () => {
    const { service, webhook } = serviceHarness();

    await expect(service.handle({ ...signedParams(), vnp_TxnRef: ['1001', '1002'] })).resolves.toEqual({
      RspCode: '99',
      Message: 'Invalid request',
    });
    expect(webhook.processVerified).not.toHaveBeenCalled();
  });

  it('maps canonical lookup outcomes to VNPay response codes', async () => {
    const { service, webhook } = serviceHarness();

    webhook.processVerified.mockResolvedValueOnce({
      accepted: true,
      result: 'UNKNOWN_PAYMENT_ACKNOWLEDGED',
    });
    await expect(service.handle(signedParams())).resolves.toMatchObject({ RspCode: '01' });

    webhook.processVerified.mockResolvedValueOnce({
      rejected: true,
      error: 'PAYMENT_FACT_MISMATCH',
      message: 'mismatch',
    });
    await expect(service.handle(signedParams())).resolves.toMatchObject({ RspCode: '04' });

    webhook.processVerified.mockResolvedValueOnce({
      accepted: true,
      result: 'CONFIRMED',
      replayed: true,
    });
    await expect(service.handle(signedParams())).resolves.toMatchObject({ RspCode: '02' });
  });

  it('requires both provider success statuses before invoking settlement', async () => {
    const { service, webhook } = serviceHarness();

    await expect(
      service.handle(signedParams({ vnp_ResponseCode: '24' })),
    ).resolves.toEqual({ RspCode: '00', Message: 'Confirm Success' });
    await expect(
      service.handle(signedParams({ vnp_TransactionStatus: '24' })),
    ).resolves.toEqual({ RspCode: '00', Message: 'Confirm Success' });
    expect(webhook.processVerified).not.toHaveBeenCalled();
    expect(webhook.classifyVerified).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a signed non-success notification has an identity mismatch', async () => {
    const { service, webhook } = serviceHarness();
    webhook.classifyVerified.mockResolvedValueOnce('INVALID_IDENTITY');

    await expect(service.handle(signedParams({ vnp_ResponseCode: '24' }))).resolves.toEqual({
      RspCode: '99',
      Message: 'Invalid request',
    });
    expect(webhook.processVerified).not.toHaveBeenCalled();
  });

  it('fails closed for merchant, currency, amount, and disabled configuration errors', async () => {
    const { service, webhook } = serviceHarness();

    await expect(service.handle(signedParams({ vnp_TmnCode: 'OTHERMC' }))).resolves.toMatchObject({ RspCode: '99' });
    await expect(service.handle(signedParams({ vnp_CurrCode: 'USD' }))).resolves.toMatchObject({ RspCode: '04' });
    await expect(service.handle(signedParams({ vnp_Amount: '10000001' }))).resolves.toMatchObject({ RspCode: '04' });
    expect(webhook.processVerified).not.toHaveBeenCalled();

    const disabled = new VnPayIpnService(
      {
        vnpay: { environment: 'disabled', version: '2.1.0' },
      } as unknown as AppConfigService,
      webhook as unknown as PaymentWebhookService,
    );
    await expect(disabled.handle(signedParams())).resolves.toMatchObject({ RspCode: '99' });
  });

  it('bounds accepted query values and only accepts vnp_* contract fields', () => {
    expect(() => parseVnPayIpnQuery({ vnp_TxnRef: '1', unexpected: 'x' })).toThrow();
    expect(() => parseVnPayIpnQuery({ vnp_TxnRef: 'x'.repeat(2049) })).toThrow();
    expect(isWellFormedVnPayQueryEncoding('/api/v1/payments/webhooks/vnpay?vnp_OrderInfo=ok%20value')).toBe(true);
    expect(isWellFormedVnPayQueryEncoding('/api/v1/payments/webhooks/vnpay?vnp_OrderInfo=%')).toBe(false);
  });
});
