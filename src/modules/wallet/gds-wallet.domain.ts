/**
 * PAYW-04: provider-confirmed wallet projection for SANDBOX development.
 *
 * This module never creates money, accepts user-provided funding evidence, or
 * updates canonical Commerce payment/entitlement state. Only an authenticated
 * partner adapter may persist verified events in a future integration.
 */
export type GdsWalletEventKind =
  | 'FUNDS_CREDITED'
  | 'PAYMENT_CAPTURED'
  | 'REFUND_CREDITED'
  | 'FUNDS_REVERSED';

export interface GdsWalletVerifiedEvent {
  /** Globally unique, authenticated event ID from the wallet partner. */
  providerEventId: string;
  kind: GdsWalletEventKind;
  amountMinor: bigint;
  currency: 'VND';
  /** Partner's immutable reference, never a frontend receipt or return URL. */
  providerTransactionId: string;
  orderId?: string;
}

export type GdsReservationStatus = 'RESERVED' | 'UNKNOWN' | 'CAPTURED' | 'RELEASED';

export interface GdsWalletReservation {
  orderId: string;
  amountMinor: bigint;
  providerReservationId: string;
  status: GdsReservationStatus;
}

export interface GdsWalletBalance {
  /** Cleared partner balance before outstanding holds. */
  settledMinor: bigint;
  reservedMinor: bigint;
  availableMinor: bigint;
  currency: 'VND';
}

export class GdsWalletInvariantError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'GdsWalletInvariantError';
  }
}

const credits = new Set<GdsWalletEventKind>(['FUNDS_CREDITED', 'REFUND_CREDITED']);

function positiveVnd(amount: bigint): void {
  if (typeof amount !== 'bigint' || amount <= 0n) {
    throw new GdsWalletInvariantError('WALLET_INVALID_AMOUNT');
  }
}

/**
 * Replay a verified event stream. Duplicate delivery with the same identity
 * and facts is idempotent; conflicting facts are quarantined, never applied.
 * An incomplete/out-of-order stream fails closed until partner reconciliation.
 */
export function projectGdsWallet(
  events: readonly GdsWalletVerifiedEvent[],
  reservations: readonly GdsWalletReservation[],
): GdsWalletBalance {
  let settledMinor = 0n;
  let reservedMinor = 0n;
  const seenEvents = new Map<string, string>();
  const seenTransactions = new Map<string, string>();
  const seenOrders = new Set<string>();
  const seenPartnerHolds = new Set<string>();
  const capturedByOrder = new Map<string, bigint>();

  for (const event of events) {
    positiveVnd(event.amountMinor);
    if (!credits.has(event.kind) && event.kind !== 'PAYMENT_CAPTURED' && event.kind !== 'FUNDS_REVERSED') {
      throw new GdsWalletInvariantError('WALLET_INVALID_PARTNER_FACT');
    }
    if (event.currency !== 'VND' || !event.providerEventId || !event.providerTransactionId) {
      throw new GdsWalletInvariantError('WALLET_INVALID_PARTNER_FACT');
    }
    const fingerprint = `${event.kind}:${event.amountMinor}:${event.currency}:${event.providerTransactionId}:${event.orderId ?? ''}`;
    const oldEvent = seenEvents.get(event.providerEventId);
    if (oldEvent) {
      if (oldEvent !== fingerprint) throw new GdsWalletInvariantError('WALLET_EVENT_COLLISION');
      continue;
    }
    const oldTransaction = seenTransactions.get(event.providerTransactionId);
    if (oldTransaction && oldTransaction !== event.providerEventId) {
      throw new GdsWalletInvariantError('WALLET_TRANSACTION_REPLAY');
    }
    seenEvents.set(event.providerEventId, fingerprint);
    seenTransactions.set(event.providerTransactionId, event.providerEventId);
    if (event.kind === 'PAYMENT_CAPTURED') {
      if (!event.orderId || capturedByOrder.has(event.orderId)) {
        throw new GdsWalletInvariantError('WALLET_CAPTURE_RECONCILIATION_REQUIRED');
      }
      capturedByOrder.set(event.orderId, event.amountMinor);
    }
    settledMinor += credits.has(event.kind) ? event.amountMinor : -event.amountMinor;
  }

  for (const reservation of reservations) {
    positiveVnd(reservation.amountMinor);
    if (!reservation.orderId || !reservation.providerReservationId) {
      throw new GdsWalletInvariantError('WALLET_INVALID_RESERVATION');
    }
    if (seenOrders.has(reservation.orderId) || seenPartnerHolds.has(reservation.providerReservationId)) {
      throw new GdsWalletInvariantError('WALLET_DUPLICATE_RESERVATION');
    }
    if (!new Set<string>(['RESERVED', 'UNKNOWN', 'CAPTURED', 'RELEASED']).has(reservation.status)) {
      throw new GdsWalletInvariantError('WALLET_INVALID_RESERVATION');
    }
    seenOrders.add(reservation.orderId);
    seenPartnerHolds.add(reservation.providerReservationId);
    // UNKNOWN remains held: a timeout is NOT proof that money was released.
    if (reservation.status === 'RESERVED' || reservation.status === 'UNKNOWN') {
      if (capturedByOrder.has(reservation.orderId)) {
        throw new GdsWalletInvariantError('WALLET_CAPTURE_RECONCILIATION_REQUIRED');
      }
      reservedMinor += reservation.amountMinor;
    } else if (reservation.status === 'CAPTURED') {
      if (capturedByOrder.get(reservation.orderId) !== reservation.amountMinor) {
        throw new GdsWalletInvariantError('WALLET_CAPTURE_RECONCILIATION_REQUIRED');
      }
    }
  }

  for (const capturedOrder of capturedByOrder.keys()) {
    if (!reservations.some((reservation) => reservation.orderId === capturedOrder && reservation.status === 'CAPTURED')) {
      throw new GdsWalletInvariantError('WALLET_CAPTURE_RECONCILIATION_REQUIRED');
    }
  }

  const availableMinor = settledMinor - reservedMinor;
  if (settledMinor < 0n || availableMinor < 0n) {
    throw new GdsWalletInvariantError('WALLET_RECONCILIATION_REQUIRED');
  }
  return { settledMinor, reservedMinor, availableMinor, currency: 'VND' };
}

/**
 * Pure validation; callers must enforce this inside a SERIALIZABLE DB
 * transaction with a per-wallet lock before persisting a hold.
 */
export function reserveGdsWallet(
  current: readonly GdsWalletReservation[],
  events: readonly GdsWalletVerifiedEvent[],
  next: GdsWalletReservation,
): GdsWalletReservation[] {
  positiveVnd(next.amountMinor);
  if (next.status !== 'RESERVED' || !next.orderId || !next.providerReservationId) {
    throw new GdsWalletInvariantError('WALLET_INVALID_RESERVATION');
  }
  const existing = current.find((item) => item.orderId === next.orderId);
  if (existing) {
    if (existing.amountMinor !== next.amountMinor || existing.providerReservationId !== next.providerReservationId) {
      throw new GdsWalletInvariantError('WALLET_IDEMPOTENCY_CONFLICT');
    }
    return [...current]; // Existing terminal state remains terminal.
  }
  if (projectGdsWallet(events, current).availableMinor < next.amountMinor) {
    throw new GdsWalletInvariantError('WALLET_INSUFFICIENT_FUNDS');
  }
  const updated = [...current, next];
  projectGdsWallet(events, updated);
  return updated;
}

/**
 * Only call after the trusted adapter has independently confirmed the result.
 * There is intentionally no action that turns UNKNOWN into a new reservation.
 */
export function resolveGdsReservation(
  current: GdsWalletReservation,
  result: 'CAPTURED' | 'RELEASED' | 'UNKNOWN',
): GdsWalletReservation {
  if (current.status === result) return current;
  if (current.status === 'CAPTURED' || current.status === 'RELEASED') {
    throw new GdsWalletInvariantError('WALLET_TERMINAL_CONFLICT');
  }
  if (result === 'UNKNOWN') return { ...current, status: 'UNKNOWN' };
  return { ...current, status: result };
}
