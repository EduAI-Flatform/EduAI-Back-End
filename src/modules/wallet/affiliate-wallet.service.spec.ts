import { AffiliateWalletService } from './affiliate-wallet.service';

function setup() {
  const settledAt = new Date(Date.now() - 86400000);
  const policy = { enabled: true, currency: 'VND', commissionBase: 'net_paid_after_recorded_refunds', attributionModel: 'first_touch',
    commissionBps: 1000, attributionDays: 30, holdDays: 0, subAffiliateEnabled: false,
    fundingSource: 'platform_fee', allocationPrecedence: 'seller_entitlements_first' };
  const accruals: any[] = [], effects: any[] = [], refunds: any[] = [], allocations: any[] = [];
  const wallet = { id: 'wallet', buyerId: 'owner', availableMinor: 0n, debtMinor: 0n, heldMinor: 0n };
  const record = { id: 'attribution', orderId: 'order', policyRevisionId: 'policy', createdAt: new Date(settledAt.getTime() - 1000),
    policy: { group: 'affiliate', content: policy }, accruals,
    order: { id: 'order', currency: 'VND', status: 'confirmed', fulfillmentStatus: 'fulfilled', payableAmountMinor: 1000n,
      confirmedSettlementId: 'settlement', confirmedSettlement: { id: 'settlement', orderId: 'order', amountMinor: 1000n,
        currency: 'VND', settledAt, kind: 'provider_collection', disposition: 'matched' }, refunds } };
  const snapshot = { id: 'line', basisAmountMinor: 1000n, platformAmountMinor: 200n, sellerAmountMinor: 800n };
  const settings = { processingEnabled: true };
  const tx = {
    $queryRaw: jest.fn(), gdsWithdrawalSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
    affiliateAttribution: { findMany: jest.fn().mockResolvedValue([record]) },
    affiliateAccrual: { create: jest.fn(async ({ data }) => { const row = { ...data, id: 'accrual' + accruals.length }; accruals.push(row); return row; }) },
    affiliateWalletEffect: { count: jest.fn(async () => effects.length), aggregate: jest.fn(async () => ({ _sum: { deltaMinor: effects.reduce((sum, row) => sum + row.deltaMinor, 0n) } })),
      create: jest.fn(async ({ data }) => { if (effects.some(row => row.accrualId === data.accrualId)) throw new Error('duplicate receipt');
        effects.push(data); wallet.availableMinor += data.availableDeltaMinor; wallet.debtMinor += data.debtDeltaMinor; return data; }) },
    revenueOrderSnapshot: { findMany: jest.fn().mockResolvedValue([snapshot]) },
    commerceRefundAllocation: { findMany: jest.fn().mockResolvedValue(allocations) },
    gdsInternalWallet: { createMany: jest.fn(), findUniqueOrThrow: jest.fn().mockResolvedValue(wallet) },
  };
  const finance = { verifyAffiliateOrder: jest.fn().mockResolvedValue(true) };
  const service = new AffiliateWalletService(finance as any);
  function refund(amount: bigint) {
    refunds.push({ id: 'refund' + refunds.length, settlementId: 'settlement', currency: 'VND', status: 'recorded', amountMinor: amount, recordedAt: new Date(Date.now() - 1000) });
    allocations.push({ orderLineId: 'line', amountMinor: amount });
  }
  return { service, tx, finance, policy, wallet, record, effects, snapshot, settings, refund };
}
describe('affiliate adapter into the existing GDS wallet', () => {
  it('credits once per immutable accrual and preserves seller amounts on replay', async () => {
    const s = setup(); const sellerBefore = s.snapshot.sellerAmountMinor;
    await s.service.syncOwner(s.tx as any, 'owner'); await s.service.syncOwner(s.tx as any, 'owner');
    expect(s.wallet.availableMinor).toBe(100n); expect(s.effects).toHaveLength(1);
    expect(s.snapshot.sellerAmountMinor).toBe(sellerBefore);
  });
  it('refreshes recorded refunds before cash-out and creates recovery debt without touching held funds', async () => {
    const s = setup(); await s.service.syncOwner(s.tx as any, 'owner');
    s.wallet.availableMinor = 0n; s.wallet.heldMinor = 100n; s.refund(1000n);
    await s.service.syncOwner(s.tx as any, 'owner'); await s.service.syncOwner(s.tx as any, 'owner');
    expect(s.wallet).toMatchObject({ availableMinor: 0n, debtMinor: 100n, heldMinor: 100n });
    expect(s.effects).toHaveLength(2);
  });
  it('runs refund recovery before spending even when credit processing is paused and never issues new value', async () => {
    const s = setup();
    await s.service.syncOwner(s.tx as any, 'owner', true);
    expect(s.effects).toHaveLength(0);
    await s.service.syncOwner(s.tx as any, 'owner');
    s.wallet.availableMinor = 0n; s.wallet.heldMinor = 100n; s.refund(1000n); s.settings.processingEnabled = false;
    await s.service.syncOwner(s.tx as any, 'owner', true);
    expect(s.wallet).toMatchObject({ availableMinor: 0n, heldMinor: 100n, debtMinor: 100n });
  });
  it('repays existing debt before new commission becomes available', async () => {
    const s = setup(); s.wallet.debtMinor = 80n; await s.service.syncOwner(s.tx as any, 'owner');
    expect(s.wallet).toMatchObject({ availableMinor: 20n, debtMinor: 0n });
  });
  it('refuses unfunded commission instead of reducing the signed seller share', async () => {
    const s = setup(); s.policy.commissionBps = 3000;
    expect(await s.service.syncOwner(s.tx as any, 'owner')).toMatchObject([{ status: 'AFFILIATE_PLATFORM_FEE_INSUFFICIENT' }]);
    expect(s.effects).toHaveLength(0); expect(s.snapshot.sellerAmountMinor).toBe(800n);
  });
  it('honors the frozen funding policy, hold and processing switch', async () => {
    const s = setup(); s.policy.fundingSource = 'unconfigured';
    expect(await s.service.syncOwner(s.tx as any, 'owner')).toMatchObject([{ status: 'FUNDING_NOT_CONFIGURED' }]);
    s.policy.fundingSource = 'platform_fee'; s.policy.holdDays = 7;
    expect(await s.service.syncOwner(s.tx as any, 'owner')).toMatchObject([{ status: 'HELD' }]);
    s.settings.processingEnabled = false; expect(await s.service.syncOwner(s.tx as any, 'owner')).toEqual([]);
    expect(s.effects).toHaveLength(0);
  });
  it('requires canonical seller-grade payment proof before issuing value', async () => {
    const s = setup(); s.finance.verifyAffiliateOrder.mockResolvedValue(false);
    expect(await s.service.syncOwner(s.tx as any, 'owner')).toMatchObject([{ status: 'AFFILIATE_UNVERIFIED_SETTLEMENT' }]);
    expect(s.effects).toHaveLength(0);
  });
  it('retains unfunded business accrual when a legacy order has no revenue snapshot, but blocks cash-out if funded proof disappears', async () => {
    const s = setup(); s.tx.revenueOrderSnapshot.findMany.mockResolvedValue([]);
    expect(await s.service.syncOwner(s.tx as any, 'owner')).toMatchObject([{ status: 'AFFILIATE_REVENUE_SNAPSHOT_INCOMPLETE' }]);
    expect(s.record.accruals).toHaveLength(1); expect(s.effects).toHaveLength(0);
    s.tx.revenueOrderSnapshot.findMany.mockResolvedValue([s.snapshot]);
    await s.service.syncOwner(s.tx as any, 'owner');
    s.finance.verifyAffiliateOrder.mockResolvedValue(false);
    await expect(s.service.syncOwner(s.tx as any, 'owner')).rejects.toThrow('AFFILIATE_UNVERIFIED_SETTLEMENT');
  });
});
