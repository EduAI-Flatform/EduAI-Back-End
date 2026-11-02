import { GdsCommerceCaptureInput, prepareGdsCommerceCapture } from './gds-commerce-capture.domain';

const buyerId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const walletId = '33333333-3333-4333-8333-333333333333';
const input = (): GdsCommerceCaptureInput => ({
  buyerId,
  order: { id: orderId, buyerId, status: 'pending_payment', payableAmountMinor: 100_000n,
    confirmedSettlementId: null, currency: 'VND' },
  wallet: { id: walletId, buyerId, status: 'ACTIVE', heldMinor: 100_000n },
  hold: { walletId, orderRef: orderId, amountMinor: 100_000n, status: 'RESERVED' },
  existingPaymentAttemptCount: 0, existingSettlementCount: 0, existingCaptureCount: 0,
});

describe('PAYW-04C source-only GDS-to-Commerce capture boundary', () => {
  it('plans one exact balanced journal capture and a distinct wallet settlement reference', () => {
    const output = prepareGdsCommerceCapture(input());
    expect(output.journal).toEqual({
      walletId, eventKey: `gds:capture:${orderId}`, kind: 'CAPTURE', amountMinor: 100_000n,
      availableDeltaMinor: 0n, heldDeltaMinor: -100_000n, clearingDeltaMinor: 100_000n,
      orderRef: orderId,
    });
    expect(output.settlement).toEqual({
      kind: 'wallet_capture', disposition: 'internal', provider: 'gds',
      reference: `gds:order:${orderId}`, amountMinor: 100_000n, currency: 'VND',
    });
    expect(output.journal.availableDeltaMinor + output.journal.heldDeltaMinor + output.journal.clearingDeltaMinor).toBe(0n);
  });

  it.each(['confirmed', 'cancelled', 'expired'] as const)('refuses a %s order', (status) => {
    const i = input(); i.order.status = status;
    expect(() => prepareGdsCommerceCapture(i)).toThrow('GDS_CAPTURE_ORDER_NOT_PAYABLE');
  });

  it.each([
    ['different buyer', (i: GdsCommerceCaptureInput) => { i.order.buyerId = walletId; }, 'GDS_CAPTURE_OWNER_MISMATCH'],
    ['different wallet owner', (i: GdsCommerceCaptureInput) => { i.wallet.buyerId = orderId; }, 'GDS_CAPTURE_OWNER_MISMATCH'],
    ['wrong currency', (i: GdsCommerceCaptureInput) => { i.order.currency = 'USD'; }, 'GDS_CAPTURE_ORDER_NOT_PAYABLE'],
    ['zero payable', (i: GdsCommerceCaptureInput) => { i.order.payableAmountMinor = 0n; }, 'GDS_CAPTURE_ORDER_NOT_PAYABLE'],
    ['already settled', (i: GdsCommerceCaptureInput) => { i.order.confirmedSettlementId = orderId; }, 'GDS_CAPTURE_ORDER_NOT_PAYABLE'],
    ['suspended wallet', (i: GdsCommerceCaptureInput) => { i.wallet.status = 'SUSPENDED'; }, 'GDS_CAPTURE_HOLD_NOT_VERIFIED'],
    ['insufficient held', (i: GdsCommerceCaptureInput) => { i.wallet.heldMinor = 99_999n; }, 'GDS_CAPTURE_HOLD_NOT_VERIFIED'],
    ['wrong hold owner', (i: GdsCommerceCaptureInput) => { i.hold.walletId = orderId; }, 'GDS_CAPTURE_HOLD_NOT_VERIFIED'],
    ['wrong order reference', (i: GdsCommerceCaptureInput) => { i.hold.orderRef = walletId; }, 'GDS_CAPTURE_HOLD_NOT_VERIFIED'],
    ['partial hold', (i: GdsCommerceCaptureInput) => { i.hold.amountMinor = 50_000n; }, 'GDS_CAPTURE_HOLD_NOT_VERIFIED'],
    ['already captured', (i: GdsCommerceCaptureInput) => { i.hold.status = 'CAPTURED'; }, 'GDS_CAPTURE_HOLD_NOT_VERIFIED'],
    ['released hold', (i: GdsCommerceCaptureInput) => { i.hold.status = 'RELEASED'; }, 'GDS_CAPTURE_HOLD_NOT_VERIFIED'],
    ['PayOS attempt', (i: GdsCommerceCaptureInput) => { i.existingPaymentAttemptCount = 1; }, 'GDS_CAPTURE_INSTRUMENT_OR_REPLAY_CONFLICT'],
    ['prior settlement', (i: GdsCommerceCaptureInput) => { i.existingSettlementCount = 1; }, 'GDS_CAPTURE_INSTRUMENT_OR_REPLAY_CONFLICT'],
    ['replay capture', (i: GdsCommerceCaptureInput) => { i.existingCaptureCount = 1; }, 'GDS_CAPTURE_INSTRUMENT_OR_REPLAY_CONFLICT'],
  ] as const)('rejects %s', (_name, change, message) => {
    const i = input(); change(i);
    expect(() => prepareGdsCommerceCapture(i)).toThrow(message);
  });
});
