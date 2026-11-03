import { createHash, createHmac } from 'node:crypto';
import { PayOS } from '@payos/node';
import { PaymentProviderError } from '../payments/payment-provider';
import { PayosPaymentProvider } from '../payments/payos-payment.provider';
import { GdsPayosTopupIntent } from './gds-payos-topup.domain';
import {
  verifyAndReconcileGdsPayosTopup,
  GdsPayosReconciliationPort,
} from './gds-payos-reconciliation';

const account = '123456789012';
const receivingAccountHash = createHash('sha256').update(account).digest('hex');
const collectedAt = new Date('2026-11-02T12:00:00Z');
const expiry = new Date('2026-11-02T12:10:00Z');
const confirmedAt = new Date('2026-11-02T12:02:00Z');
const orderCode = 900_000_123_456n;

const intent: GdsPayosTopupIntent = {
  id: 'sandbox-topup', buyerId: 'sandbox-buyer', amountMinor: 100_000n,
  currency: 'VND', payosOrderCode: orderCode, receivingAccountHash,
  expiresAt: expiry, status: 'PENDING_PAYOS', paymentLinkId: 'payos-link-1',
  collectionReference: null, partnerCreditEventId: null,
};

function signedEvent() {
  return {
    provider: 'payos' as const,
    providerOrderReference: orderCode.toString(),
    providerEventIdentity: 'payos-transfer-1',
    providerPaymentIdentity: 'payos-link-1',
    providerSettlementReference: 'payos-transfer-1',
    localOrderReference: Number(orderCode), amountMinor: 100_000n,
    currency: 'VND' as const, occurredAt: collectedAt,
    providerCode: '00', receivingAccount: account,
  };
}

function payosStatus() {
  return {
    providerPaymentIdentity: 'payos-link-1', receivingAccount: account,
    localOrderReference: Number(orderCode), amountMinor: 100_000n,
    amountPaidMinor: 100_000n, amountRemainingMinor: 0n,
    status: 'PAID' as const, createdAt: new Date('2026-11-02T11:58:00Z'),
    transactions: [{
      reference: 'payos-transfer-1', amountMinor: 100_000n,
      receivingAccount: account, occurredAt: collectedAt,
    }],
  };
}

describe('GDS source-only verified PayOS reconciliation', () => {
  const provider = {
    verifyWebhook: jest.fn(),
    reconcilePaymentRequest: jest.fn(),
  };
  let port: GdsPayosReconciliationPort;

  beforeEach(() => {
    jest.clearAllMocks();
    provider.verifyWebhook.mockResolvedValue(signedEvent());
    provider.reconcilePaymentRequest.mockResolvedValue(payosStatus());
    port = {
      provider, sandboxEnabled: true, nodeEnv: 'test',
      deploymentClass: 'uat', now: () => confirmedAt,
    };
  });

  it('requires signature verification AND an independent paid payment-link query before preparing exact 1:1 credit', async () => {
    const body = { signed: 'opaque raw PayOS body' };
    const result = await verifyAndReconcileGdsPayosTopup(intent, body, port);
    expect(provider.verifyWebhook).toHaveBeenCalledWith({ body, headers: {} });
    expect(provider.reconcilePaymentRequest).toHaveBeenCalledWith('payos-link-1');
    expect(result.intent).toMatchObject({ status: 'PAYOS_VERIFIED', collectionReference: 'payos-transfer-1' });
    expect(result.settlement).toMatchObject({
      orderCode, amountMinor: 100_000n, amountRemainingMinor: 0n,
      collectionReference: 'payos-transfer-1', receivingAccountHash,
      status: 'PAID', signatureVerifiedAt: confirmedAt, providerReconciledAt: confirmedAt,
    });
    expect(intent.status).toBe('PENDING_PAYOS'); // no DB or input mutation
  });

  it('binds the physical settlement recipient from two agreeing authenticated sources without replacing the QR account', async () => {
    const virtualHash = createHash('sha256').update('VIRTUAL-GDS-ORDER-1').digest('hex');
    const virtualIntent = { ...intent, receivingAccountHash: virtualHash };
    provider.reconcilePaymentRequest.mockResolvedValue({ ...payosStatus(), receivingAccount: null });

    const result = await verifyAndReconcileGdsPayosTopup(virtualIntent, {}, port);

    expect(provider.verifyWebhook).toHaveBeenCalledTimes(1);
    expect(provider.reconcilePaymentRequest).toHaveBeenCalledWith(intent.paymentLinkId);
    expect(result.intent).toMatchObject({
      status: 'PAYOS_VERIFIED', receivingAccountHash: virtualHash,
      settlementReceivingAccountHash: receivingAccountHash,
    });
    expect(result.settlement).toMatchObject({
      receivingAccountHash: virtualHash, settlementReceivingAccountHash: receivingAccountHash,
      collectionReference: signedEvent().providerSettlementReference,
    });
    expect(virtualIntent.receivingAccountHash).toBe(virtualHash);
    expect(virtualIntent).not.toHaveProperty('settlementReceivingAccountHash');
  });

  it('rejects a changed physical recipient after the first settlement binding even if both provider facts agree', async () => {
    const boundIntent = { ...intent, settlementReceivingAccountHash: receivingAccountHash };
    const changedAccount = '999999999999';
    provider.verifyWebhook.mockResolvedValue({ ...signedEvent(), receivingAccount: changedAccount });
    provider.reconcilePaymentRequest.mockResolvedValue({
      ...payosStatus(), receivingAccount: null,
      transactions: [{ ...payosStatus().transactions[0], receivingAccount: changedAccount }],
    });

    await expect(verifyAndReconcileGdsPayosTopup(boundIntent, {}, port)).rejects.toThrow();
    expect(boundIntent.settlementReceivingAccountHash).toBe(receivingAccountHash);
    expect(boundIntent.receivingAccountHash).toBe(receivingAccountHash);
  });

  it('requires the signed webhook physical recipient to match the independently queried transfer', async () => {
    provider.verifyWebhook.mockResolvedValue({ ...signedEvent(), receivingAccount: '3333333333' });
    provider.reconcilePaymentRequest.mockResolvedValue({ ...payosStatus(), receivingAccount: null });

    await expect(verifyAndReconcileGdsPayosTopup(intent, {}, port))
      .rejects.toThrow('GDS_PAYOS_RECONCILIATION_MISMATCH');
    expect(provider.reconcilePaymentRequest).toHaveBeenCalledTimes(1);
  });

  it.each(['webhook', 'query'] as const)('never ignores a contradictory virtual recipient supplied by the %s', async (source) => {
    const otherVirtual = 'VIRTUAL-OTHER-ORDER';
    if (source === 'webhook') {
      provider.verifyWebhook.mockResolvedValue({ ...signedEvent(), virtualReceivingAccount: otherVirtual });
    } else {
      provider.reconcilePaymentRequest.mockResolvedValue({
        ...payosStatus(), transactions: [{ ...payosStatus().transactions[0], virtualReceivingAccount: otherVirtual }],
      });
    }

    await expect(verifyAndReconcileGdsPayosTopup(intent, {}, port)).rejects.toThrow();
  });

  it('accepts matching virtual recipient evidence while retaining both distinct immutable recipient hashes', async () => {
    const virtualAccount = 'VIRTUAL-GDS-ORDER-1';
    const virtualHash = createHash('sha256').update(virtualAccount).digest('hex');
    const virtualIntent = { ...intent, receivingAccountHash: virtualHash };
    provider.verifyWebhook.mockResolvedValue({ ...signedEvent(), virtualReceivingAccount: virtualAccount });
    provider.reconcilePaymentRequest.mockResolvedValue({
      ...payosStatus(), receivingAccount: null,
      transactions: [{ ...payosStatus().transactions[0], virtualReceivingAccount: virtualAccount }],
    });

    const result = await verifyAndReconcileGdsPayosTopup(virtualIntent, {}, port);
    expect(result.settlement).toMatchObject({
      receivingAccountHash: virtualHash, settlementReceivingAccountHash: receivingAccountHash,
    });
  });

  it.each([
    ['sandbox disabled', { sandboxEnabled: false, nodeEnv: 'test', deploymentClass: 'uat' }],
    ['production NODE_ENV', { sandboxEnabled: true, nodeEnv: 'production', deploymentClass: 'uat' }],
    ['production deployment', { sandboxEnabled: true, nodeEnv: 'test', deploymentClass: 'production' }],
  ])('refuses %s before contacting the provider', async (_label, values) => {
    await expect(verifyAndReconcileGdsPayosTopup(intent, {}, { ...port, ...values }))
      .rejects.toThrow('GDS_PAYOS_RECONCILIATION_DISABLED');
    expect(provider.verifyWebhook).not.toHaveBeenCalled();
    expect(provider.reconcilePaymentRequest).not.toHaveBeenCalled();
  });

  it('fails closed on an unknown deployment classification or invalid intent before SDK calls', async () => {
    await expect(verifyAndReconcileGdsPayosTopup(intent, {}, {
      ...port, deploymentClass: 'unknown',
    })).rejects.toThrow('GDS_PAYOS_RECONCILIATION_DISABLED');
    await expect(verifyAndReconcileGdsPayosTopup({
      ...intent, expiresAt: new Date(NaN),
    }, {}, port)).rejects.toThrow('GDS_PAYOS_RECONCILIATION_INVALID_INTENT');
    expect(provider.verifyWebhook).not.toHaveBeenCalled();
  });

  it('never queries a provider status when the SDK rejects an invalid signature', async () => {
    provider.verifyWebhook.mockRejectedValueOnce(new PaymentProviderError('invalid_signature', false));
    await expect(verifyAndReconcileGdsPayosTopup(intent, {}, port))
      .rejects.toMatchObject({ code: 'invalid_signature' });
    expect(provider.reconcilePaymentRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong order code', { localOrderReference: 555 }],
    ['wrong link', { providerPaymentIdentity: 'another-link' }],
    ['wrong paid amount', { amountMinor: 99_999n }],
    ['wrong payment result', { providerCode: '01' }],
    ['wrong settlement identity', { providerEventIdentity: 'different-transfer' }],
  ])('rejects signed webhook with %s before the second query', async (_label, changed) => {
    provider.verifyWebhook.mockResolvedValueOnce({ ...signedEvent(), ...changed });
    await expect(verifyAndReconcileGdsPayosTopup(intent, {}, port))
      .rejects.toThrow('GDS_PAYOS_WEBHOOK_MISMATCH');
    expect(provider.reconcilePaymentRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['pending', { status: 'PENDING' }],
    ['underpaid', { amountPaidMinor: 99_999n, amountRemainingMinor: 1n }],
    ['overpaid', { amountPaidMinor: 100_001n }],
    ['wrong payment link', { providerPaymentIdentity: 'another-link' }],
    ['wrong transfer bank', { transactions: [{ ...payosStatus().transactions[0], receivingAccount: '3333333333' }] }],
    ['split settlement', { transactions: [payosStatus().transactions[0], payosStatus().transactions[0]] }],
    ['mismatched transaction', { transactions: [{ ...payosStatus().transactions[0], reference: 'different-transfer' }] }],
    ['transfer predates created link', { createdAt: new Date('2026-11-02T12:01:00Z') }],
  ])('refuses %s even after an otherwise valid PayOS signature', async (_label, changed) => {
    provider.reconcilePaymentRequest.mockResolvedValueOnce({ ...payosStatus(), ...changed });
    await expect(verifyAndReconcileGdsPayosTopup(intent, {}, port))
      .rejects.toThrow('GDS_PAYOS_RECONCILIATION_MISMATCH');
  });

  it('leaves payment pending on an unavailable provider query or invalid wall clock', async () => {
    provider.reconcilePaymentRequest.mockRejectedValueOnce(new PaymentProviderError('timeout', true));
    await expect(verifyAndReconcileGdsPayosTopup(intent, {}, port))
      .rejects.toMatchObject({ code: 'timeout' });
    await expect(verifyAndReconcileGdsPayosTopup(intent, {}, { ...port, now: () => new Date(NaN) }))
      .rejects.toThrow('GDS_PAYOS_RECONCILIATION_CLOCK');
  });

  it('sends late/cancelled and old events to review, never a credit candidate', async () => {
    provider.verifyWebhook.mockResolvedValueOnce({ ...signedEvent(), occurredAt: new Date('2026-11-02T12:11:00Z') });
    await expect(verifyAndReconcileGdsPayosTopup(intent, {}, port))
      .rejects.toThrow('GDS_PAYOS_RECONCILIATION_REVIEW');
    await expect(verifyAndReconcileGdsPayosTopup({ ...intent, status: 'CANCELLED' }, {}, port))
      .rejects.toThrow('GDS_PAYOS_RECONCILIATION_INVALID_INTENT');
  });

  it('is idempotent for the same already-verified collection, but rejects a different signed transfer', async () => {
    const verified = { ...intent, status: 'PAYOS_VERIFIED' as const, collectionReference: 'payos-transfer-1' };
    const result = await verifyAndReconcileGdsPayosTopup(verified, {}, port);
    expect(result.intent).toMatchObject(verified);
    provider.verifyWebhook.mockResolvedValueOnce({
      ...signedEvent(), providerSettlementReference: 'payos-transfer-2', providerEventIdentity: 'payos-transfer-2',
    });
    await expect(verifyAndReconcileGdsPayosTopup(verified, {}, port))
      .rejects.toThrow('GDS_PAYOS_RECONCILIATION_MISMATCH');
  });

  it('verifies a signed PayOS-format fixture with the real SDK before a mocked independent lookup', async () => {
    // Only local cryptographic verification is real in this test. No PayOS
    // merchant API call, bank transfer, persisted credit or webhook occurs.
    const checksumKey = 'sandbox-test-checksum-key-123456789';
    const sdk = new PayOS({
      clientId: 'sandbox-client', apiKey: 'sandbox-api', checksumKey,
    });
    const data = {
      orderCode: Number(orderCode), paymentLinkId: 'payos-link-1',
      reference: 'payos-transfer-1', accountNumber: account,
      code: '00', amount: 100_000, currency: 'VND',
      transactionDateTime: '2026-11-02 19:00:00',
    };
    const signedPayload = Object.keys(data).sort().map((key) => `${key}=${data[key as keyof typeof data]}`).join('&');
    const signature = createHmac('sha256', checksumKey).update(signedPayload).digest('hex');
    const client = {
      webhooks: sdk.webhooks,
      paymentRequests: {
        get: jest.fn().mockResolvedValue({
          id: 'payos-link-1', orderCode: Number(orderCode), accountNumber: account,
          amount: 100_000, amountPaid: 100_000, amountRemaining: 0, status: 'PAID',
          createdAt: '2026-11-02T11:58:00Z',
          transactions: [{ reference: 'payos-transfer-1', amount: 100_000,
            accountNumber: account, transactionDateTime: '2026-11-02 19:00:00' }],
        }),
        create: jest.fn(), cancel: jest.fn(),
      },
    };
    const sdkProvider = new PayosPaymentProvider(client);
    const result = await verifyAndReconcileGdsPayosTopup(intent, {
      code: '00', desc: 'success', success: true, data, signature,
    }, { ...port, provider: sdkProvider });
    expect(result.intent.status).toBe('PAYOS_VERIFIED');
    expect(client.paymentRequests.get).toHaveBeenCalledWith('payos-link-1', { maxRetries: 0 });

    client.paymentRequests.get.mockClear();
    await expect(verifyAndReconcileGdsPayosTopup(intent, {
      code: '00', desc: 'success', success: true,
      data: { ...data, amount: 99_999 }, signature,
    }, { ...port, provider: sdkProvider })).rejects.toMatchObject({ code: 'invalid_signature' });
    expect(client.paymentRequests.get).not.toHaveBeenCalled();
  });
});
