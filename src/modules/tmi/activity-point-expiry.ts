export interface PointExpiryEntry {
  id: string;
  kind: string;
  amount: number;
  adjustmentDirection: 'credit' | 'debit' | null;
  sourceType: string;
  sourceId: string;
  occurredAt: Date;
  expiresAt: Date | null;
}
interface PointLot { id: string; remaining: bigint; occurredAt: Date; expiresAt: Date | null; }
const validDate = (value: Date | null): value is Date => value instanceof Date && Number.isFinite(value.getTime());
function fail(code: string): never { throw new Error(code); }

/**
 * Derives unspent due amounts without mutating history. Only new activity earns
 * expire; legacy credit expiry fields retain their existing non-expiring meaning.
 * Spend allocation is deterministic: nearest expiry, then oldest credit and ID.
 * Callers must serialize postings per user and persist each expiry once.
 */
export function pendingActivityPointExpiries(entries: PointExpiryEntry[], at: Date) {
  if (!validDate(at)) fail('POINT_EVALUATION_DATE_INVALID');
  if (!entries.some(entry => entry.sourceType === 'platform_activity' || entry.sourceType === 'platform_activity_expiry')) return [];
  const ids = new Set<string>(), expiredIds = new Set<string>();
  const lots = new Map<string, PointLot>();
  const rows = entries.filter(entry => {
    if (!entry.id || ids.has(entry.id)) fail('POINT_LEDGER_DUPLICATE');
    ids.add(entry.id);
    if (!validDate(entry.occurredAt)) fail('POINT_LEDGER_DATE_INVALID');
    return entry.occurredAt <= at;
  }).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const entry of rows) {
    if ((entry.sourceType === 'platform_activity' && entry.kind !== 'earn')
      || (entry.sourceType === 'platform_activity_expiry' && entry.kind !== 'expiry')) fail('POINT_ACTIVITY_KIND_INVALID');
    const activityEarn = entry.sourceType === 'platform_activity' && entry.kind === 'earn';
    if (!Number.isSafeInteger(entry.amount) || entry.amount <= 0) {
      if (activityEarn || entry.sourceType === 'platform_activity_expiry') fail('POINT_ACTIVITY_AMOUNT_INVALID');
      continue; // Preserve the existing wallet treatment of non-positive legacy rows.
    }
    const amount = BigInt(entry.amount);
    if (entry.kind === 'earn' || entry.kind === 'refund' || (entry.kind === 'adjustment' && entry.adjustmentDirection === 'credit')) {
      if (activityEarn && (!validDate(entry.expiresAt) || entry.expiresAt <= entry.occurredAt)) fail('POINT_ACTIVITY_EXPIRY_INVALID');
      lots.set(entry.id, { id: entry.id, remaining: amount, occurredAt: entry.occurredAt, expiresAt: activityEarn ? entry.expiresAt : null });
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
    for (const lot of spendable) {
      const consumed = lot.remaining < remaining ? lot.remaining : remaining;
      lot.remaining -= consumed;
      remaining -= consumed;
      if (remaining === 0n) break;
    }
    if (remaining > 0n) fail('POINT_LEDGER_UNFUNDED_DEBIT');
  }
  return [...lots.values()].filter((lot): lot is PointLot & { expiresAt: Date } =>
    lot.remaining > 0n && lot.expiresAt !== null && lot.expiresAt <= at)
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || (a.id < b.id ? -1 : 1))
    .map(lot => ({ entryId: lot.id, amount: Number(lot.remaining), expiresAt: lot.expiresAt }));
}
