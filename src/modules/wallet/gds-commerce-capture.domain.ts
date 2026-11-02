import { GdsWalletInvariantError } from './gds-wallet.domain';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type GdsCommerceCaptureInput = {
  buyerId: string;
  order: {
    id: string;
    buyerId: string;
    status: 'pending_payment' | 'confirmed' | 'cancelled' | 'expired';
    currency: string;
    payableAmountMinor: bigint;
    confirmedSettlementId: string | null;
  };
  wallet: {
    id: string;
    buyerId: string;
    status: string;
    heldMinor: bigint;
  };
  hold: {
    walletId: string;
    orderRef: string;
    amountMinor: bigint;
    status: string;
  };
  existingPaymentAttemptCount: number;
  existingSettlementCount: number;
  existingCaptureCount: number;
};

export type PreparedGdsCommerceCapture = {
  /** Both writes must be committed inside ONE serializable transaction. */
  journal: {
    walletId: string;
    eventKey: string;
    kind: 'CAPTURE';
    amountMinor: bigint;
    availableDeltaMinor: 0n;
    heldDeltaMinor: bigint;
    clearingDeltaMinor: bigint;
    orderRef: string;
  };
  /** Requires a NEW canonical Commerce settlement kind and verified recovery. */
  settlement: {
    kind: 'wallet_capture';
    disposition: 'internal';
    provider: 'gds';
    reference: string;
    amountMinor: bigint;
    currency: 'VND';
  };
};

/**
 * PAYW-04C source-only contract. A reserve alone is NOT a payment, and this
 * pure plan MUST NOT be published as a checkout endpoint or treated as paid.
 * The future caller must lock the Commerce order, hold and wallet inside the
 * same serializable transaction, insert CAPTURE+canonical settlement, confirm
 * the order and invoke fulfillment in that transaction. The existing
 * SQL proof migrations are source-only; production and standalone financial
 * recovery remain gated.
 */
export function prepareGdsCommerceCapture(input: GdsCommerceCaptureInput): PreparedGdsCommerceCapture {
  const { buyerId, order, wallet, hold } = input;
  if (!UUID.test(buyerId) || !UUID.test(order.id) || !UUID.test(wallet.id) ||
      order.buyerId !== buyerId || wallet.buyerId !== buyerId) {
    throw new GdsWalletInvariantError('GDS_CAPTURE_OWNER_MISMATCH');
  }
  if (order.status !== 'pending_payment' || order.confirmedSettlementId !== null ||
      order.currency !== 'VND' || order.payableAmountMinor <= 0n ||
      order.payableAmountMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new GdsWalletInvariantError('GDS_CAPTURE_ORDER_NOT_PAYABLE');
  }
  if (wallet.status !== 'ACTIVE' || wallet.heldMinor < order.payableAmountMinor ||
      hold.walletId !== wallet.id || hold.orderRef !== order.id ||
      hold.amountMinor !== order.payableAmountMinor || hold.status !== 'RESERVED') {
    throw new GdsWalletInvariantError('GDS_CAPTURE_HOLD_NOT_VERIFIED');
  }
  if (!Number.isSafeInteger(input.existingPaymentAttemptCount) ||
      !Number.isSafeInteger(input.existingSettlementCount) ||
      !Number.isSafeInteger(input.existingCaptureCount) ||
      input.existingPaymentAttemptCount !== 0 ||
      input.existingSettlementCount !== 0 || input.existingCaptureCount !== 0) {
    throw new GdsWalletInvariantError('GDS_CAPTURE_INSTRUMENT_OR_REPLAY_CONFLICT');
  }
  return {
    journal: {
      walletId: wallet.id,
      eventKey: `gds:capture:${order.id}`,
      kind: 'CAPTURE', amountMinor: order.payableAmountMinor,
      availableDeltaMinor: 0n,
      heldDeltaMinor: -order.payableAmountMinor,
      clearingDeltaMinor: order.payableAmountMinor,
      orderRef: order.id,
    },
    settlement: {
      kind: 'wallet_capture', disposition: 'internal', provider: 'gds',
      reference: `gds:order:${order.id}`, amountMinor: order.payableAmountMinor,
      currency: 'VND',
    },
  };
}
