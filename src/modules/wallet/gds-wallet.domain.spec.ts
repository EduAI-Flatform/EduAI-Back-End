import {
  GdsWalletInvariantError, GdsWalletReservation, GdsWalletVerifiedEvent,
  projectGdsWallet, reserveGdsWallet, resolveGdsReservation,
} from './gds-wallet.domain';

const credit: GdsWalletVerifiedEvent = {
  providerEventId: 'event-1', providerTransactionId: 'tx-1', kind: 'FUNDS_CREDITED', amountMinor: 100_000n, currency: 'VND',
};
const hold: GdsWalletReservation = {
  orderId: 'order-1', providerReservationId: 'reserve-1', amountMinor: 70_000n, status: 'RESERVED',
};

describe('GDS partner-projected sandbox wallet', () => {
  it('deduplicates exactly repeated partner events, never doubles funds', () => {
    expect(projectGdsWallet([credit, { ...credit }], []).availableMinor).toBe(100_000n);
    expect(() => projectGdsWallet([credit, { ...credit, amountMinor: 200_000n }], []))
      .toThrow(new GdsWalletInvariantError('WALLET_EVENT_COLLISION'));
    expect(() => projectGdsWallet([credit, { ...credit, providerEventId: 'other-event' }], []))
      .toThrow(new GdsWalletInvariantError('WALLET_TRANSACTION_REPLAY'));
  });

  it('holds funds through UNKNOWN timeouts and rejects overdraw', () => {
    const reserved = reserveGdsWallet([], [credit], hold);
    expect(projectGdsWallet([credit], reserved)).toEqual({
      settledMinor: 100_000n, reservedMinor: 70_000n, availableMinor: 30_000n, currency: 'VND',
    });
    expect(projectGdsWallet([credit], [resolveGdsReservation(hold, 'UNKNOWN')]).availableMinor).toBe(30_000n);
    expect(() => reserveGdsWallet(reserved, [credit], { ...hold, orderId: 'order-2', providerReservationId: 'reserve-2', amountMinor: 31_000n }))
      .toThrow(new GdsWalletInvariantError('WALLET_INSUFFICIENT_FUNDS'));
  });

  it('allows stable idempotent retries without resurrecting a terminal hold', () => {
    expect(reserveGdsWallet([hold], [credit], { ...hold })).toEqual([hold]);
    expect(() => reserveGdsWallet([hold], [credit], { ...hold, amountMinor: 50_000n }))
      .toThrow(new GdsWalletInvariantError('WALLET_IDEMPOTENCY_CONFLICT'));
    const released = resolveGdsReservation(hold, 'RELEASED');
    expect(reserveGdsWallet([released], [credit], hold)[0].status).toBe('RELEASED');
    expect(() => resolveGdsReservation(released, 'CAPTURED')).toThrow(new GdsWalletInvariantError('WALLET_TERMINAL_CONFLICT'));
  });

  it('counts partner captures once, releases holds and disallows incomplete money history', () => {
    const captured = resolveGdsReservation(hold, 'CAPTURED');
    const debit: GdsWalletVerifiedEvent = {
      providerEventId: 'event-2', providerTransactionId: 'tx-2', kind: 'PAYMENT_CAPTURED',
      amountMinor: 70_000n, currency: 'VND', orderId: 'order-1',
    };
    expect(projectGdsWallet([credit, debit], [captured]).availableMinor).toBe(30_000n);
    const refund: GdsWalletVerifiedEvent = {
      providerEventId: 'event-3', providerTransactionId: 'tx-3', kind: 'REFUND_CREDITED',
      amountMinor: 70_000n, currency: 'VND', orderId: 'order-1',
    };
    expect(projectGdsWallet([credit, debit, refund], [captured]).availableMinor).toBe(100_000n);
    expect(() => projectGdsWallet([credit], [captured])).toThrow(new GdsWalletInvariantError('WALLET_CAPTURE_RECONCILIATION_REQUIRED'));
    expect(() => projectGdsWallet([credit, debit], [hold])).toThrow(new GdsWalletInvariantError('WALLET_CAPTURE_RECONCILIATION_REQUIRED'));
    expect(() => projectGdsWallet([credit, debit, { ...debit, providerEventId: 'event-duplicate', providerTransactionId: 'tx-duplicate' }], [captured]))
      .toThrow(new GdsWalletInvariantError('WALLET_CAPTURE_RECONCILIATION_REQUIRED'));
    expect(() => projectGdsWallet([debit], [])).toThrow(new GdsWalletInvariantError('WALLET_CAPTURE_RECONCILIATION_REQUIRED'));
    expect(() => projectGdsWallet([credit], [hold, hold])).toThrow(new GdsWalletInvariantError('WALLET_DUPLICATE_RESERVATION'));
  });

  it('rejects zero, negative and non-VND inputs', () => {
    expect(() => projectGdsWallet([{ ...credit, amountMinor: 0n }], [])).toThrow(new GdsWalletInvariantError('WALLET_INVALID_AMOUNT'));
    expect(() => reserveGdsWallet([], [credit], { ...hold, amountMinor: -1n })).toThrow(new GdsWalletInvariantError('WALLET_INVALID_AMOUNT'));
    expect(() => projectGdsWallet([{ ...credit, currency: 'USD' as 'VND' }], [])).toThrow(new GdsWalletInvariantError('WALLET_INVALID_PARTNER_FACT'));
  });
});
