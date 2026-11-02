import {
  GdsInternalPayosSettlement, prepareGdsInternalTopupCredit,
  projectGdsInternalTopupCredits,
} from './gds-internal-topup.domain';
import { GdsPayosTopupIntent } from './gds-payos-topup.domain';
import { GdsWalletInvariantError } from './gds-wallet.domain';

const intent: GdsPayosTopupIntent = {
  id: 'one', buyerId: 'buyer-one', amountMinor: 100_000n, currency: 'VND',
  payosOrderCode: 900_000_012_345n, receivingAccountHash: 'a'.repeat(64),
  expiresAt: new Date('2026-11-02T15:00:00Z'), status: 'PAYOS_VERIFIED',
  paymentLinkId: 'link-123', collectionReference: 'transfer-123', partnerCreditEventId: null,
};
const settlement: GdsInternalPayosSettlement = {
  orderCode: intent.payosOrderCode, paymentLinkId: 'link-123',
  amountMinor: 100_000n, amountRemainingMinor: 0n, currency: 'VND',
  receivingAccountHash: intent.receivingAccountHash, collectionReference: 'transfer-123',
  status: 'PAID', signatureVerifiedAt: new Date('2026-11-02T12:00:00Z'),
  providerReconciledAt: new Date('2026-11-02T12:01:00Z'),
};

describe('PAYW-04 internal GDS service-prepayment sandbox contract', () => {
  it('creates exactly 100000 service credits for 100000 verified VND without fee deduction', () => {
    const credit = prepareGdsInternalTopupCredit(intent, settlement);
    expect(credit).toEqual({
      eventId: 'payos-gds-topup:900000012345', buyerId: 'buyer-one',
      collectionReference: 'transfer-123', amountMinor: 100_000n,
      currency: 'VND', source: 'PAYOS_MERCHANT_COLLECTION',
    });
    expect(projectGdsInternalTopupCredits([credit])).toBe(100_000n);
    expect(projectGdsInternalTopupCredits([credit, { ...credit }])).toBe(100_000n);
  });

  it('cannot turn a created QR, browser return, cancelled or review topup into credit', () => {
    for (const status of ['CREATED', 'PENDING_PAYOS', 'REVIEW', 'CANCELLED', 'PENDING_PARTNER'] as const) {
      expect(() => prepareGdsInternalTopupCredit({ ...intent, status }, settlement))
        .toThrow(new GdsWalletInvariantError('GDS_INTERNAL_TOPUP_NOT_ELIGIBLE'));
    }
  });

  it('rejects underpayment, fake paid status, and mismatched account/order/reference/amount', () => {
    for (const wrong of [
      { amountRemainingMinor: 1n }, { amountMinor: 99_000n },
      { status: 'PENDING' as 'PAID' }, { paymentLinkId: 'other' },
      { orderCode: 900_000_000_001n }, { receivingAccountHash: 'b'.repeat(64) },
      { collectionReference: 'other-ref' },
    ]) {
      expect(() => prepareGdsInternalTopupCredit(intent, { ...settlement, ...wrong }))
        .toThrow(new GdsWalletInvariantError('GDS_INTERNAL_TOPUP_PAYMENT_MISMATCH'));
    }
  });

  it('requires both server signature verification and later provider reconciliation', () => {
    const unknown = new Date(Number.NaN);
    expect(() => prepareGdsInternalTopupCredit(intent, { ...settlement, signatureVerifiedAt: unknown }))
      .toThrow(new GdsWalletInvariantError('GDS_INTERNAL_TOPUP_NOT_RECONCILED'));
    expect(() => prepareGdsInternalTopupCredit(intent, { ...settlement, providerReconciledAt: unknown }))
      .toThrow(new GdsWalletInvariantError('GDS_INTERNAL_TOPUP_NOT_RECONCILED'));
    expect(() => prepareGdsInternalTopupCredit(intent, {
      ...settlement, providerReconciledAt: new Date('2026-11-02T11:59:59Z'),
    })).toThrow(new GdsWalletInvariantError('GDS_INTERNAL_TOPUP_NOT_RECONCILED'));
  });

  it('rejects replayed collections between buyers or different event IDs', () => {
    const credit = prepareGdsInternalTopupCredit(intent, settlement);
    expect(() => projectGdsInternalTopupCredits([credit, { ...credit, buyerId: 'buyer-two' }]))
      .toThrow(new GdsWalletInvariantError('GDS_INTERNAL_TOPUP_EVENT_COLLISION'));
    expect(() => projectGdsInternalTopupCredits([credit, { ...credit, eventId: 'payos-gds-topup:other' }]))
      .toThrow(new GdsWalletInvariantError('GDS_INTERNAL_TOPUP_COLLECTION_REPLAY'));
  });
});
