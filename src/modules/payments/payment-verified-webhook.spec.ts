import {
  toVerifiedVnPayQueryDrWebhook,
} from './payment-verified-webhook';

const attempt = {
  providerPaymentIdentity: '9001',
  providerOrderCode: 9001n,
  amountMinor: 125000n,
  currency: 'VND',
  createdAt: new Date('2026-08-27T00:00:00.000Z'),
};

const observation = {
  provider: 'vnpay' as const,
  queryRequestStatus: 'success' as const,
  transactionStatus: 'paid' as const,
  providerOrderReference: '9001',
  providerTransactionIdentity: '777001',
  amountMinor: 125000n,
  currency: 'VND' as const,
  paidAt: new Date('2026-08-27T00:01:00.000Z'),
  responseCode: '00',
  transactionStatusCode: '00',
  trusted: true as const,
};

describe('toVerifiedVnPayQueryDrWebhook', () => {
  it('normalizes trusted paid facts with a stable provider-scoped event identity', () => {
    const first = toVerifiedVnPayQueryDrWebhook(attempt, observation);
    const second = toVerifiedVnPayQueryDrWebhook(attempt, { ...observation });

    expect(first).toMatchObject({
      provider: 'vnpay',
      providerOrderReference: '9001',
      providerPaymentIdentity: '9001',
      providerSettlementReference: '777001',
      amountMinor: 125000n,
      currency: 'VND',
      providerCode: '00',
      transactionStatus: '00',
    });
    expect(first?.providerEventIdentity).toBe(second?.providerEventIdentity);
    expect(first?.providerEventIdentity).toMatch(/^vnpay:[0-9a-f]{64}$/);
  });

  it.each([
    ['not_found', { queryRequestStatus: 'not_found' }],
    ['pending', { transactionStatus: 'pending' }],
    ['wrong amount', { amountMinor: 125001n }],
    ['wrong TxnRef', { providerOrderReference: '9002' }],
  ])('rejects a %s observation from canonical settlement ingestion', (_label, patch) => {
    expect(
      toVerifiedVnPayQueryDrWebhook(attempt, { ...observation, ...patch } as never),
    ).toBeNull();
  });
});
