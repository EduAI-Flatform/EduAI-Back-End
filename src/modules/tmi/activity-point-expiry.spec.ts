import { pendingActivityPointExpiries, type PointExpiryEntry } from './activity-point-expiry';

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
});
