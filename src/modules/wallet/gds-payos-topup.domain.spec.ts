import {
  acceptGdsPartnerCredit, acceptGdsPayosCollection, attachGdsPayosLink,
  buildGdsPayosTopupRequest, cancelGdsTopup, GdsPayosTopupIntent, GdsPayosVerifiedCollection,
  markGdsTopupAwaitingPartner, toGdsWalletFundingEvent,
} from './gds-payos-topup.domain';
import { GdsWalletInvariantError, projectGdsWallet } from './gds-wallet.domain';

const future = new Date('2099-01-01T00:00:00.000Z');
const receivingAccountHash = 'a'.repeat(64);
function intent(): GdsPayosTopupIntent {
  return {
    id: 'topup-id', buyerId: 'buyer-id', amountMinor: 100_000n, currency: 'VND',
    payosOrderCode: 900_000_012_345n, receivingAccountHash, expiresAt: future,
    status: 'CREATED', paymentLinkId: null, collectionReference: null, partnerCreditEventId: null,
  };
}
const link = {
  orderCode: 900_000_012_345n, amountMinor: 100_000n, currency: 'VND' as const,
  paymentLinkId: 'payos-link-123', checkoutUrl: 'https://pay.payos.vn/web/payos-link-123', receivingAccountHash,
};
function collection(): GdsPayosVerifiedCollection {
  return {
    orderCode: link.orderCode, amountMinor: link.amountMinor, currency: 'VND',
    paymentLinkId: link.paymentLinkId, collectionReference: 'payos-bank-transfer-1',
    receivingAccountHash, occurredAt: new Date('2026-11-02T12:00:00.000Z'), providerCode: '00',
  };
}

describe('GDS PayOS topup design: gateway collection is not wallet issuance', () => {
  it('makes one exact-VND PayOS request and a unique nine-character transfer memo', () => {
    const topup = { ...intent(), expiresAt: new Date('2026-11-02T14:15:00.000Z') };
    const urls = {
      returnUrl: 'https://eduai.example.test/wallet/topup/return',
      cancelUrl: 'https://eduai.example.test/wallet/topup/cancel',
    };
    const request = buildGdsPayosTopupRequest(topup, urls);
    expect(request).toEqual({
      orderCode: Number(topup.payosOrderCode), amount: 100_000,
      description: `G${topup.payosOrderCode.toString(36).toUpperCase().padStart(8, '0')}`,
      returnUrl: urls.returnUrl, cancelUrl: urls.cancelUrl,
      expiredAt: Math.floor(topup.expiresAt.getTime() / 1000),
    });
    expect(request.description).toMatch(/^G[A-Z0-9]{8}$/);
    expect(buildGdsPayosTopupRequest({ ...topup, payosOrderCode: 900_000_012_346n }, urls).description)
      .not.toBe(request.description);
    expect(() => buildGdsPayosTopupRequest({ ...topup, amountMinor: 0n }, urls))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_INVALID_INTENT'));
    expect(() => buildGdsPayosTopupRequest({ ...topup, amountMinor: 99.5 as unknown as bigint }, urls))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_INVALID_INTENT'));
    expect(() => buildGdsPayosTopupRequest({ ...topup, amountMinor: BigInt(Number.MAX_SAFE_INTEGER) + 1n }, urls))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_INVALID_INTENT'));
    expect(() => buildGdsPayosTopupRequest({ ...topup, payosOrderCode: 3_000_000_000_000n }, urls))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_ORDER_CODE_TOO_LONG'));
    expect(() => buildGdsPayosTopupRequest(topup, { ...urls, returnUrl: 'http://eduai.example.test/return' }))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_UNTRUSTED_REDIRECT'));
    expect(() => buildGdsPayosTopupRequest(topup, { ...urls, cancelUrl: 'https://evil.example.test/cancel' }))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_UNTRUSTED_REDIRECT'));
  });

  it('allows only trusted embedded checkout links with exact amount/order/account', () => {
    const pending = attachGdsPayosLink(intent(), link);
    expect(pending).toMatchObject({ status: 'PENDING_PAYOS', collectionReference: null, partnerCreditEventId: null });
    expect(attachGdsPayosLink(pending, link)).toBe(pending);
    for (const checkoutUrl of ['http://pay.payos.vn/web/x', 'https://pay.payos.vn.attacker.test/web/x', 'https://evil.test/web/x']) {
      expect(() => attachGdsPayosLink(intent(), { ...link, checkoutUrl }))
        .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_UNTRUSTED_CHECKOUT'));
    }
    expect(() => attachGdsPayosLink(intent(), { ...link, amountMinor: 50_000n })).toThrow(new GdsWalletInvariantError('WALLET_TOPUP_PAYOS_MISMATCH'));
  });

  it('validates a PayOS collection but never credits the wallet directly', () => {
    const pending = attachGdsPayosLink(intent(), link);
    const paid = acceptGdsPayosCollection(pending, collection());
    expect(paid).toMatchObject({ status: 'PAYOS_VERIFIED', partnerCreditEventId: null });
    expect(acceptGdsPayosCollection(paid, collection())).toBe(paid);
    expect(() => acceptGdsPayosCollection(paid, { ...collection(), collectionReference: 'another-transfer' }))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_DUPLICATE_COLLECTION'));
  });

  it('rejects forged paid facts and amount, bank or payment-link mismatch', () => {
    const pending = attachGdsPayosLink(intent(), link);
    expect(() => acceptGdsPayosCollection(pending, { ...collection(), providerCode: '01' as '00' }))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_PAYOS_MISMATCH'));
    expect(() => acceptGdsPayosCollection(pending, { ...collection(), amountMinor: 1n }))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_PAYOS_MISMATCH'));
    expect(() => acceptGdsPayosCollection(pending, { ...collection(), receivingAccountHash: 'b'.repeat(64) }))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_PAYOS_MISMATCH'));
    expect(() => acceptGdsPayosCollection(pending, { ...collection(), paymentLinkId: 'other-link' }))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_PAYOS_MISMATCH'));
  });

  it('needs a separately verified partner event before wallet credit', () => {
    const paid = acceptGdsPayosCollection(attachGdsPayosLink(intent(), link), collection());
    const pendingPartner = markGdsTopupAwaitingPartner(paid);
    const partnerFact = { eventId: 'partner:event-1', partnerTransactionId: 'partner:tx-1', amountMinor: 100_000n, currency: 'VND' as const, sourceCollectionReference: collection().collectionReference };
    expect(acceptGdsPartnerCredit(pendingPartner, partnerFact)).toMatchObject({ status: 'CREDITED', partnerCreditEventId: 'partner:event-1' });
    expect(acceptGdsPartnerCredit(acceptGdsPartnerCredit(pendingPartner, partnerFact), partnerFact).status).toBe('CREDITED');
    expect(() => acceptGdsPartnerCredit(pendingPartner, { ...partnerFact, amountMinor: 200_000n }))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_PARTNER_MISMATCH'));
    expect(() => acceptGdsPartnerCredit(attachGdsPayosLink(intent(), link), partnerFact))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_PARTNER_MISMATCH'));
    expect(() => acceptGdsPartnerCredit(pendingPartner, { ...partnerFact, partnerTransactionId: '' }))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_PARTNER_MISMATCH'));
  });

  it('credits exactly the transferred VND once, only after separate partner confirmation', () => {
    const partnerFact = {
      eventId: 'licensed-partner:event-100', partnerTransactionId: 'licensed-partner:txn-100',
      amountMinor: 100_000n, currency: 'VND' as const,
      sourceCollectionReference: collection().collectionReference,
    };
    const pending = attachGdsPayosLink(intent(), link);
    expect(() => toGdsWalletFundingEvent(pending, partnerFact))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_NOT_CREDITED'));
    const collected = acceptGdsPayosCollection(pending, collection());
    expect(() => toGdsWalletFundingEvent(collected, partnerFact))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_NOT_CREDITED'));
    const credited = acceptGdsPartnerCredit(markGdsTopupAwaitingPartner(collected), partnerFact);
    const fundingEvent = toGdsWalletFundingEvent(credited, partnerFact);
    expect(fundingEvent).toMatchObject({ kind: 'FUNDS_CREDITED', amountMinor: 100_000n });
    expect(projectGdsWallet([fundingEvent], []).availableMinor).toBe(100_000n);
    // At-least-once provider delivery is replay-safe and cannot mint twice.
    expect(projectGdsWallet([fundingEvent, fundingEvent], []).availableMinor).toBe(100_000n);
    expect(() => toGdsWalletFundingEvent(credited, { ...partnerFact, amountMinor: 99_000n }))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_PARTNER_MISMATCH'));
    expect(() => toGdsWalletFundingEvent(credited, { ...partnerFact, eventId: 'other-event' }))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_NOT_CREDITED'));
  });

  it('never treats cancelled/late PayOS transfers as automatically funded', () => {
    const pending = attachGdsPayosLink(intent(), link);
    const cancelled = cancelGdsTopup(pending);
    expect(cancelGdsTopup(cancelled)).toBe(cancelled);
    expect(acceptGdsPayosCollection(cancelled, collection())).toMatchObject({ status: 'REVIEW', partnerCreditEventId: null });
    const expired = acceptGdsPayosCollection(pending, { ...collection(), occurredAt: new Date('2099-01-02T00:00:00.000Z') });
    expect(expired).toMatchObject({ status: 'REVIEW', partnerCreditEventId: null });
    expect(() => cancelGdsTopup(acceptGdsPayosCollection(pending, collection())))
      .toThrow(new GdsWalletInvariantError('WALLET_TOPUP_INVALID_TRANSITION'));
  });
});
