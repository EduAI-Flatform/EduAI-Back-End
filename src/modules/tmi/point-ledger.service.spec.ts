import { PointLedgerService } from './point-ledger.service';

const at = new Date('2026-11-12T10:00:00Z');
const credit = { id: 'credit', userId: 'user', redemptionId: null, kind: 'earn', amount: 100,
  adjustmentDirection: null, sourceType: 'platform_activity', sourceId: 'event', postingSequence: 1n,
  occurredAt: new Date('2026-10-01T10:00:00Z'), expiresAt: new Date('2026-11-01T10:00:00Z'), metadata: null };
function harness(entries = [credit]) {
  const tx = {
    tmiLedgerEntry: { findMany: jest.fn().mockResolvedValue(entries), create: jest.fn().mockImplementation(async ({ data }) =>
      ({ ...data, id: 'expiry-posting', postingSequence: 3n, adjustmentDirection: null, expiresAt: null, metadata: null })) },
    pointExpirySettlement: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn().mockResolvedValue({ id: 'receipt' }) },
  };
  const audit = { record: jest.fn() };
  return { tx, audit, service: new PointLedgerService(audit as never) };
}

describe('point ledger expiry integration', () => {
  it('projects due unspent credit out of spendable balance without writing fake history', async () => {
    const { service, tx } = harness();
    const rows = await service.load(tx as never, 'user');
    expect(service.project(rows, at)).toEqual({ current: 0, earned: 100, spent: 100, expired: 100 });
    expect(tx.tmiLedgerEntry.create).not.toHaveBeenCalled();
    expect(tx.pointExpirySettlement.create).not.toHaveBeenCalled();
  });
  it('settles a positive expiry with linked ledger, receipt and audit in the caller transaction', async () => {
    const { service, tx, audit } = harness();
    const rows = await service.settle(tx as never, 'user', 'actor', at);
    expect(service.project(rows, at).current).toBe(0);
    expect(tx.tmiLedgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      amount: 100, kind: 'expiry', sourceType: 'platform_activity_expiry', sourceId: 'credit', occurredAt: at,
    }) }));
    expect(tx.pointExpirySettlement.create).toHaveBeenCalledWith({ data: { userId: 'user', creditEntryId: 'credit',
      amount: 100, settledAt: at, ledgerEntryId: 'expiry-posting' } });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'POINT_ACTIVITY_EXPIRED' }), tx);
  });
  it('records a zero settlement for fully spent credit without another debit', async () => {
    const spend = { ...credit, id: 'spend', kind: 'redeem', sourceType: 'tmi_redemption', amount: 100,
      sourceId: 'redemption', occurredAt: new Date('2026-10-02T10:00:00Z'), expiresAt: null, postingSequence: 2n };
    const { service, tx } = harness([credit, spend] as never);
    await service.settle(tx as never, 'user', 'actor', at);
    expect(tx.tmiLedgerEntry.create).not.toHaveBeenCalled();
    expect(tx.pointExpirySettlement.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 0, ledgerEntryId: null }) });
  });
  it('does not post a settlement that is already recorded', async () => {
    const spend = { ...credit, id: 'spend', kind: 'redeem', sourceType: 'tmi_redemption', amount: 100,
      sourceId: 'redemption', occurredAt: new Date('2026-10-02T10:00:00Z'), expiresAt: null, postingSequence: 2n };
    const { service, tx } = harness([credit, spend] as never);
    tx.pointExpirySettlement.findMany.mockResolvedValue([{ creditEntryId: credit.id, amount: 0 }] as never);
    await service.settle(tx as never, 'user', 'actor', at);
    expect(tx.tmiLedgerEntry.create).not.toHaveBeenCalled();
    expect(tx.pointExpirySettlement.create).not.toHaveBeenCalled();
  });
  it('fails closed if a prior zero settlement disagrees with the reconstructed unspent amount', async () => {
    const { service, tx } = harness();
    tx.pointExpirySettlement.findMany.mockResolvedValue([{ creditEntryId: credit.id, amount: 0 }] as never);
    await expect(service.settle(tx as never, 'user', 'actor', at)).rejects.toThrow('POINT_ACTIVITY_EXPIRY_RECEIPT_MISMATCH');
  });
});
