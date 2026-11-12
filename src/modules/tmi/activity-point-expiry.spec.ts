import { activityPointSpendAllocations, activityPointExpirySettlements, pendingActivityPointExpiries, type PointExpiryEntry } from './activity-point-expiry';

const now = new Date('2026-11-12T10:00:00Z');
const past = new Date('2026-11-10T10:00:00Z');
const due = new Date('2026-11-12T09:00:00Z');
const future = new Date('2026-12-12T10:00:00Z');
function credit(id: string, amount: number, expiresAt: Date | null = due): PointExpiryEntry {
  return { id, kind: 'earn', amount, adjustmentDirection: null, sourceType: 'platform_activity', sourceId: `event-${id}`, occurredAt: past, expiresAt };
}
function debit(id: string, amount: number): PointExpiryEntry {
  return { id, kind: 'redeem', amount, adjustmentDirection: null, sourceType: 'tmi_redemption', sourceId: id,
    occurredAt: new Date('2026-11-11T10:00:00Z'), expiresAt: null };
}
describe('activity point expiry allocation', () => {
  it('expires only the unspent part of due activity points, consuming soonest-expiring points first', () => {
    const early = credit('early', 100), late = credit('late', 100, future);
    expect(pendingActivityPointExpiries([late, debit('spend', 130), early], now)).toEqual([]);
    expect(pendingActivityPointExpiries([late, debit('spend', 60), early], now))
      .toEqual([{ entryId: 'early', amount: 40, expiresAt: due }]);
  });
  it('preserves legacy points even if older records have an ignored expiry date', () => {
    const legacy = { ...credit('legacy', 500, due), sourceType: 'legacy_import' };
    expect(pendingActivityPointExpiries([legacy], now)).toEqual([]);
    expect(pendingActivityPointExpiries([legacy, credit('new', 100), debit('spend', 50)], now))
      .toEqual([{ entryId: 'new', amount: 50, expiresAt: due }]);
  });
  it('does not expire the same amount twice after an append-only expiry posting', () => {
    const posting = { ...debit('expired', 40), kind: 'expiry', sourceType: 'platform_activity_expiry', sourceId: 'earned', occurredAt: due };
    expect(pendingActivityPointExpiries([credit('earned', 100), debit('spent', 60), posting], now)).toEqual([]);
  });
  it('handles audited debit/credit adjustments and refunds without changing their history', () => {
    const adjustedDebit = { ...debit('adjusted', 40), kind: 'adjustment', adjustmentDirection: 'debit' as const };
    const refund = { ...credit('refund', 10, null), kind: 'refund', sourceType: 'tmi_redemption' };
    expect(pendingActivityPointExpiries([credit('activity', 100), adjustedDebit, refund], now))
      .toEqual([{ entryId: 'activity', amount: 60, expiresAt: due }]);
  });
  it('counts the expiry boundary inclusively and ignores future postings', () => {
    const source = credit('boundary', 100, now);
    const futureDebit = { ...debit('future', 100), occurredAt: future };
    expect(pendingActivityPointExpiries([source, futureDebit], now)).toEqual([{ entryId: 'boundary', amount: 100, expiresAt: now }]);
  });
  it('fails closed on invalid activity expiry, duplicate source rows and over-expiry', () => {
    expect(() => pendingActivityPointExpiries([credit('bad', 100, null)], now)).toThrow('POINT_ACTIVITY_EXPIRY_INVALID');
    expect(() => pendingActivityPointExpiries([credit('same', 100), credit('same', 100)], now)).toThrow('POINT_LEDGER_DUPLICATE');
    const posting = { ...debit('expired', 101), kind: 'expiry', sourceType: 'platform_activity_expiry', sourceId: 'earned', occurredAt: due };
    expect(() => pendingActivityPointExpiries([credit('earned', 100), posting], now)).toThrow('POINT_ACTIVITY_EXPIRY_MISMATCH');
  });
  it('rejects consuming expired points before a missing expiry posting and malformed reserved source kinds', () => {
    const expiredSpend = { ...debit('late-spend', 100), occurredAt: new Date('2026-11-12T09:30:00Z') };
    expect(() => pendingActivityPointExpiries([credit('expired', 100), expiredSpend], now)).toThrow('POINT_LEDGER_UNFUNDED_DEBIT');
    expect(() => pendingActivityPointExpiries([{ ...credit('invalid-kind', 100), kind: 'refund' }], now)).toThrow('POINT_ACTIVITY_KIND_INVALID');
  });
  it('uses database posting order for entries sharing a timestamp', () => {
    const earned = { ...credit('z-credit', 100), postingSequence: 1n };
    const spend = { ...debit('a-spend', 40), occurredAt: past, postingSequence: 2n };
    expect(pendingActivityPointExpiries([spend, earned], now)).toEqual([{ entryId: earned.id, amount: 60, expiresAt: due }]);
  });
  it('captures the exact native and legacy lots consumed by a redemption', () => {
    const legacy = { ...credit('legacy', 100, null), sourceType: 'legacy_import' };
    expect(activityPointSpendAllocations([legacy, credit('native', 50), debit('spend', 80)], 'spend', now)).toEqual([
      { creditEntryId: 'native', amount: 50, expiresAt: due },
      { creditEntryId: 'legacy', amount: 30, expiresAt: null },
    ]);
  });
  it('retains original expiry on native refunds even when refunded after expiry', () => {
    const refund = { ...credit('returned', 40, due), kind: 'refund', sourceType: 'platform_activity_refund',
      occurredAt: now, refundOfEntryId: 'native', refundOfDebitId: 'spend' };
    expect(pendingActivityPointExpiries([credit('native', 100), debit('spend', 40), refund], now)).toEqual([
      { entryId: 'native', amount: 60, expiresAt: due }, { entryId: 'returned', amount: 40, expiresAt: due },
    ]);
  });
  it('rejects extending the original validity or refunding more than the consumed lot', () => {
    const refund = { ...credit('returned', 40, future), kind: 'refund', sourceType: 'platform_activity_refund',
      occurredAt: now, refundOfEntryId: 'native', refundOfDebitId: 'spend' };
    expect(() => pendingActivityPointExpiries([credit('native', 100), debit('spend', 40), refund], now)).toThrow('POINT_ACTIVITY_REFUND_MISMATCH');
    expect(() => pendingActivityPointExpiries([credit('native', 100), debit('spend', 40), { ...refund, amount: 41, expiresAt: due }], now))
      .toThrow('POINT_ACTIVITY_REFUND_MISMATCH');
  });
  it('returns zero settlements for fully spent grants so workers can advance', () => {
    expect(activityPointExpirySettlements([credit('spent', 100), debit('spend', 100)], now))
      .toEqual([{ entryId: 'spent', amount: 0, expiresAt: due }]);
  });
});
