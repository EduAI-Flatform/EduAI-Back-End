import { createHmac } from 'node:crypto';
import { prepareGdsInternalTopupCredit } from './gds-internal-topup.domain';
import { GdsPayosTopupIntent } from './gds-payos-topup.domain';
import { GdsSandboxEventAuth, verifyGdsSyntheticCollectionEvent } from './gds-sandbox-event.domain';

const fixtureKey = 'synthetic-hmac-key-for-gds-sandbox-only-00001';
const auth: GdsSandboxEventAuth = {
  nodeEnv: 'test', deploymentClass: 'uat', sandboxEnabled: true,
  fixtureKey, verifiedAt: new Date('2026-11-02T12:00:00Z'),
};
const fact = {
  source: 'EDUAI_GDS_SYNTHETIC_V1', intentId: 'sandbox-topup',
  orderCode: '900000123456', paymentLinkId: 'sandbox-payment-link',
  amountMinor: '100000', amountRemainingMinor: '0', currency: 'VND',
  receivingAccountHash: 'a'.repeat(64), collectionReference: 'sandbox-transfer-001',
  providerStatus: 'PAID', reconciledAt: '2026-11-02T12:01:00Z',
};
const intent: GdsPayosTopupIntent = {
  id: fact.intentId, buyerId: 'sandbox-buyer', amountMinor: 100_000n,
  currency: 'VND', payosOrderCode: 900_000_123_456n,
  receivingAccountHash: fact.receivingAccountHash,
  expiresAt: new Date('2026-11-02T14:00:00Z'),
  status: 'PAYOS_VERIFIED', paymentLinkId: fact.paymentLinkId,
  collectionReference: fact.collectionReference, partnerCreditEventId: null,
};
const signed = (value: object) => {
  const body = Buffer.from(JSON.stringify(value));
  return { body, signature: createHmac('sha256', fixtureKey).update(body).digest('hex') };
};

describe('PAYW-04B synthetic HMAC collection simulator (never real PayOS)', () => {
  it('maps an authenticated reconciled synthetic fact to exact 1:1 credit candidate', () => {
    const { body, signature } = signed(fact);
    const result = verifyGdsSyntheticCollectionEvent(body, signature, auth);
    expect(result.intentId).toBe(intent.id);
    expect(prepareGdsInternalTopupCredit(intent, result.settlement)).toMatchObject({
      buyerId: 'sandbox-buyer', amountMinor: 100_000n,
      collectionReference: fact.collectionReference,
    });
  });

  it('refuses production or disabled mode without parsing or crediting', () => {
    const { body, signature } = signed(fact);
    for (const config of [
      { nodeEnv: 'production' as const },
      { deploymentClass: 'production' as const },
      { sandboxEnabled: false },
    ]) {
      expect(() => verifyGdsSyntheticCollectionEvent(body, signature, { ...auth, ...config }))
        .toThrow('GDS_SYNTHETIC_EVENT_REJECTED');
    }
  });

  it('rejects altered body/signature, missing key and non-fixture source', () => {
    const { body, signature } = signed(fact);
    expect(() => verifyGdsSyntheticCollectionEvent(Buffer.concat([body, Buffer.from(' ')]), signature, auth))
      .toThrow('GDS_SYNTHETIC_EVENT_REJECTED');
    expect(() => verifyGdsSyntheticCollectionEvent(body, 'f'.repeat(64), auth))
      .toThrow('GDS_SYNTHETIC_EVENT_REJECTED');
    expect(() => verifyGdsSyntheticCollectionEvent(body, signature, { ...auth, fixtureKey: '' }))
      .toThrow('GDS_SYNTHETIC_EVENT_REJECTED');
    const invalid = signed({ ...fact, source: 'payos' });
    expect(() => verifyGdsSyntheticCollectionEvent(invalid.body, invalid.signature, auth))
      .toThrow('GDS_SYNTHETIC_EVENT_REJECTED');
  });

  it('rejects underpaid, unreconciled, unsafe integer, invalid account and out-of-order events', () => {
    for (const changed of [
      { amountRemainingMinor: '1' }, { amountMinor: '9007199254740992' },
      { currency: 'USD' }, { receivingAccountHash: 'not-a-hash' },
      { reconciledAt: '2026-11-02T11:59:00Z' },
      { providerStatus: 'PENDING' },
    ]) {
      const { body, signature } = signed({ ...fact, ...changed });
      expect(() => verifyGdsSyntheticCollectionEvent(body, signature, auth))
        .toThrow('GDS_SYNTHETIC_EVENT_REJECTED');
    }
  });

  it('never treats a correctly signed but mismatched buyer order/amount/link as a credit', () => {
    const { body, signature } = signed({ ...fact, orderCode: '900000123457' });
    const verified = verifyGdsSyntheticCollectionEvent(body, signature, auth);
    expect(() => prepareGdsInternalTopupCredit(intent, verified.settlement))
      .toThrow('GDS_INTERNAL_TOPUP_PAYMENT_MISMATCH');
  });
});
