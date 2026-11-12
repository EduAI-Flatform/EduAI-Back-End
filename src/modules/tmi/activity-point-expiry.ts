export interface PointExpiryEntry {
  id: string;
  kind: string;
  amount: number;
  adjustmentDirection: 'credit' | 'debit' | null;
  sourceType: string;
  sourceId: string;
  occurredAt: Date;
  expiresAt: Date | null;
  postingSequence?: bigint;
  refundOfEntryId?: string;
  refundOfDebitId?: string;
}
export interface PointSpendAllocation { creditEntryId: string; amount: number; expiresAt: Date | null; }
interface PointLot { id: string; remaining: bigint; occurredAt: Date; expiresAt: Date | null; }
const validDate = (value: Date | null): value is Date => value instanceof Date && Number.isFinite(value.getTime());
function fail(code: string): never { throw new Error(code); }

/**
 * Derives unspent due amounts without mutating history. Only new activity earns
 * expire; legacy credit expiry fields retain their existing non-expiring meaning.
 * Spend allocation is deterministic: nearest expiry, then oldest credit and ID.
 * Callers must serialize postings per user and persist each expiry once.
 */
function replayActivityPoints(entries: PointExpiryEntry[], at: Date) {
  if (!validDate(at)) fail('POINT_EVALUATION_DATE_INVALID');
  const allocations = new Map<string, PointSpendAllocation[]>();
  if (!entries.some(entry => ['platform_activity', 'platform_activity_refund', 'platform_activity_expiry'].includes(entry.sourceType)))
    return { settlements: [], allocations };
  const ids = new Set<string>(), expiredIds = new Set<string>();
  const refunded = new Map<string, number>();
  const lots = new Map<string, PointLot>();
  const rows = entries.filter(entry => {
    if (!entry.id || ids.has(entry.id)) fail('POINT_LEDGER_DUPLICATE');
    ids.add(entry.id);
    if (!validDate(entry.occurredAt)) fail('POINT_LEDGER_DATE_INVALID');
    return entry.occurredAt <= at;
  }).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()
    || (a.postingSequence !== undefined && b.postingSequence !== undefined && a.postingSequence !== b.postingSequence
      ? (a.postingSequence < b.postingSequence ? -1 : 1) : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));

  for (const entry of rows) {
    if ((entry.sourceType === 'platform_activity' && entry.kind !== 'earn')
      || (entry.sourceType === 'platform_activity_refund' && entry.kind !== 'refund')
      || (entry.sourceType === 'platform_activity_expiry' && entry.kind !== 'expiry')) fail('POINT_ACTIVITY_KIND_INVALID');
    const activityEarn = entry.sourceType === 'platform_activity' && entry.kind === 'earn';
    const activityRefund = entry.sourceType === 'platform_activity_refund';
    if (!Number.isSafeInteger(entry.amount) || entry.amount <= 0) {
      if (activityEarn || activityRefund || entry.sourceType === 'platform_activity_expiry') fail('POINT_ACTIVITY_AMOUNT_INVALID');
      continue; // Preserve the existing wallet treatment of non-positive legacy rows.
    }
    const amount = BigInt(entry.amount);
    if (entry.kind === 'earn' || entry.kind === 'refund' || (entry.kind === 'adjustment' && entry.adjustmentDirection === 'credit')) {
      if (activityEarn && (!validDate(entry.expiresAt) || entry.expiresAt <= entry.occurredAt)) fail('POINT_ACTIVITY_EXPIRY_INVALID');
      if (activityRefund) {
        const original = allocations.get(entry.refundOfDebitId ?? '')?.find(part => part.creditEntryId === entry.refundOfEntryId);
        const key = `${entry.refundOfDebitId}:${entry.refundOfEntryId}`;
        const total = (refunded.get(key) ?? 0) + entry.amount;
        if (!original?.expiresAt || !validDate(entry.expiresAt) || entry.expiresAt.getTime() !== original.expiresAt.getTime()
          || total > original.amount) fail('POINT_ACTIVITY_REFUND_MISMATCH');
        refunded.set(key, total);
      }
      lots.set(entry.id, { id: entry.id, remaining: amount, occurredAt: entry.occurredAt, expiresAt: activityEarn || activityRefund ? entry.expiresAt : null });
      continue;
    }
    if (entry.kind === 'expiry' && entry.sourceType === 'platform_activity_expiry') {
      const lot = lots.get(entry.sourceId);
      if (!lot?.expiresAt || lot.expiresAt > entry.occurredAt || expiredIds.has(lot.id) || lot.remaining !== amount)
        fail('POINT_ACTIVITY_EXPIRY_MISMATCH');
      lot.remaining = 0n;
      expiredIds.add(lot.id);
      continue;
    }
    if (entry.kind !== 'redeem' && entry.kind !== 'expiry' && !(entry.kind === 'adjustment' && entry.adjustmentDirection === 'debit'))
      fail('POINT_LEDGER_KIND_INVALID');
    const spendable = [...lots.values()].filter(lot => lot.remaining > 0n && (!lot.expiresAt || lot.expiresAt > entry.occurredAt))
      .sort((a, b) => (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity)
        || a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let remaining = amount;
    const consumedLots: PointSpendAllocation[] = [];
    for (const lot of spendable) {
      const consumed = lot.remaining < remaining ? lot.remaining : remaining;
      consumedLots.push({ creditEntryId: lot.id, amount: Number(consumed), expiresAt: lot.expiresAt });
      lot.remaining -= consumed;
      remaining -= consumed;
      if (remaining === 0n) break;
    }
    if (remaining > 0n) fail('POINT_LEDGER_UNFUNDED_DEBIT');
    allocations.set(entry.id, consumedLots);
  }
  const settlements = [...lots.values()].filter((lot): lot is PointLot & { expiresAt: Date } =>
    !expiredIds.has(lot.id) && lot.expiresAt !== null && lot.expiresAt <= at)
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || (a.id < b.id ? -1 : 1))
    .map(lot => ({ entryId: lot.id, amount: Number(lot.remaining), expiresAt: lot.expiresAt }));
  return { settlements, allocations };
}

export function pendingActivityPointExpiries(entries: PointExpiryEntry[], at: Date) {
  return replayActivityPoints(entries, at).settlements.filter(lot => lot.amount > 0);
}

export function activityPointExpirySettlements(entries: PointExpiryEntry[], at: Date) {
  return replayActivityPoints(entries, at).settlements;
}

export function activityPointSpendAllocations(entries: PointExpiryEntry[], debitId: string, at: Date) {
  return replayActivityPoints(entries, at).allocations.get(debitId) ?? [];
}
